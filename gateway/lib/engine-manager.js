/**
 * gateway/lib/engine-manager.js — 进程管家 + OOM 阶梯强杀/重启（P2）
 *
 * 职责：
 *   1. 记录每个引擎子进程的 PID / 启动参数 / 健康状态（含端口反查到的既有进程）；
 *   2. OOM 时用 `taskkill /PID {pid} /F /T` **强杀整棵进程树**；
 *   3. 按 --medvram → --medvram-sdxl → --lowvram 阶梯重启后重试，**每级最多 1 次**；
 *      阶梯用尽仍失败 → 返回 failed 并写日志（不抛、不静默）。
 * 所有 kill/restart/spawn 全部 try-catch；exec/spawn/probe 均可注入，便于 mock 测试。
 */

'use strict'

import { spawn, execFile } from 'node:child_process'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class EngineManager {
  constructor({
    webuiLadder = ['--medvram', '--medvram-sdxl', '--lowvram'],
    comfyLadder = [null, null, '--lowvram'],
    log = null,
    exec = execFile,
    spawnFn = spawn,
    now = () => Date.now(),
    /**
     * 引擎启动是否 detached。默认 **false**：
     * 实测（2026-10-18）在带文件沙箱的宿主里，detached 子进程会「退出码 0 但什么都写不出来」
     * —— 引擎看起来被拉起了（有 PID），实际根本没启动（DLL 加载/日志写入都被静默拒绝）。
     * 非 detached 的普通子进程一切正常。确实需要「网关退出后引擎继续跑」时，用 GW_ENGINE_DETACHED=1 打开。
     */
    spawnDetached = process.env.GW_ENGINE_DETACHED === '1',
  } = {}) {
    this.ladders = { webui: webuiLadder, comfy: comfyLadder }
    this.log = log
    this.exec = exec
    this.spawnFn = spawnFn
    this.now = now
    this.spawnDetached = spawnDetached
    /** @type {Map<string, object>} engine → 记录 */
    this.engines = new Map()
    /** 每级阶梯的使用次数（P2：每级最多 1 次） */
    this.levelUse = new Map()
  }

  // ---------------- 台账 ----------------

  register(engine, { pid, args = [], cmdline = '', source = 'spawned', port = null } = {}) {
    const prev = this.engines.get(engine)
    const rec = {
      engine,
      pid: pid || null,
      args,
      cmdline,
      source,
      port,
      startedAt: this.now(),
      healthy: true,
      restartCount: prev ? prev.restartCount : 0,
      level: prev ? prev.level : 0,
      lastOomAt: prev ? prev.lastOomAt || null : null,
      lastExit: null,
    }
    this.engines.set(engine, rec)
    this.log?.('info', 'engine.register', { engine, pid: rec.pid, source, port, args })
    return rec
  }

  unregister(engine, reason = 'manual', extra = {}) {
    const rec = this.engines.get(engine)
    this.engines.delete(engine)
    return rec ? { ...rec, exitReason: reason, ...extra } : null
  }

  get(engine) {
    return this.engines.get(engine) || null
  }

  /**
   * 该 pid 是否属于本管理器登记的引擎/训练进程。
   * 用于安全界定：**只对自家进程**做直接强杀（SIGKILL/TerminateProcess），
   * 避免 pid 复用或外部传入的裸 pid 恰好命中无关进程时被误杀。
   */
  ownsPid(pid) {
    const p = Number(pid)
    if (!Number.isInteger(p) || p <= 0) return false
    for (const rec of this.engines.values()) {
      if (rec && Number(rec.pid) === p) return true
    }
    return false
  }

  list() {
    return [...this.engines.values()].map((r) => ({
      engine: r.engine,
      pid: r.pid,
      port: r.port,
      cmdline: r.cmdline,
      args: r.args,
      startedAt: r.startedAt,
      uptimeMs: this.now() - r.startedAt,
      healthy: this.isAlive(r.engine),
      restartCount: r.restartCount,
      level: r.level,
      source: r.source,
      lastOomAt: r.lastOomAt,
    }))
  }

  /** 进程是否存活（跨平台：kill(pid, 0)） */
  isAlive(engine) {
    const rec = typeof engine === 'string' ? this.engines.get(engine) : engine
    if (!rec || !rec.pid) return false
    try {
      process.kill(rec.pid, 0)
      return true
    } catch (e) {
      if (e && e.code === 'EPERM') return true // 存在但无权限信号：算活着
      return false
    }
  }

  // ---------------- OOM 判定与强杀 ----------------

  /** OOM/显存类错误特征 */
  isOomError(msg) {
    if (!msg) return false
    const s = String(msg)
    return /CUDA out of memory|OutOfMemoryError|Not enough memory|Failed to allocate|cudaMalloc|out of memory|expected all tensors to be on the same device|HalfTensor|not enough GPU|显存不足/i.test(s)
  }

  /** 端口反查 PID（Windows: netstat -ano；其他平台: lsof）。失败返回 null，不抛。 */
  async findPidByPort(port) {
    if (!port) return null
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'netstat' : 'lsof'
    const args = isWin ? ['-ano', '-p', 'tcp'] : ['-tPi', `:${port}`, '-sTCP:LISTEN']
    try {
      const out = await new Promise((resolve, reject) => {
        this.exec(cmd, args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          if (err && !stdout) return reject(err)
          resolve(String(stdout || ''))
        })
      })
      if (isWin) {
        const re = new RegExp(`[:.]${port}\\s+.*LISTENING\\s+(\\d+)`, 'i')
        const m = out.match(re)
        return m ? Number(m[1]) : null
      }
      const m = out.match(/LISTEN\s+(\d+)/) || out.match(/\s(\d+)\s+.*LISTEN/)
      return m ? Number(m[1]) : null
    } catch (e) {
      this.log?.('debug', 'engine.port_scan_failed', { port, error: e })
      return null
    }
  }

  /** 把已经在跑的引擎纳入台账（网关不是它爹，也要能管它） */
  async adopt(engine, { port = null, args = [], cmdline = '' } = {}) {
    const pid = await this.findPidByPort(port)
    if (!pid) return null
    const rec = this.engines.get(engine)
    if (rec && rec.pid === pid) return rec
    return this.register(engine, { pid, port, args, cmdline, source: 'adopted' })
  }

  /** 强杀整棵进程树：taskkill /PID {pid} /F /T（try-catch，绝不抛） */
  async killTree(pid) {
    const p = Number(pid)
    if (!Number.isInteger(p) || p <= 0) {
      this.log?.('warn', 'engine.kill_invalid_pid', { pid })
      return { ok: false, reason: 'invalid-pid' }
    }
    // 安全闸：绝不杀自己 / 自己的父进程。
    // 现实里引擎是独立进程，但「端口反查 PID」在极端情况下可能指回网关自身或它的宿主
    // （测试里 mock 引擎与网关同进程；用户也可能把网关挂在别的进程下），
    // 一旦误杀就是把网关/宿主整棵树端掉 —— 这里明确拒绝并记 error。
    if (p === process.pid || p === process.ppid) {
      this.log?.('error', 'engine.kill_refused_self', { pid: p, self: process.pid, parent: process.ppid, note: '拒绝强杀网关自身/父进程' })
      return { ok: false, reason: 'refused-self-or-parent', pid: p }
    }
    if (process.platform !== 'win32') {
      try {
        process.kill(p, 'SIGKILL')
        return { ok: true, method: 'sigkill' }
      } catch (e) {
        this.log?.('warn', 'engine.kill_failed', { pid: p, error: e })
        return { ok: false, reason: String(e && e.message) }
      }
    }
    const cmdline = `taskkill /PID ${p} /F /T`
    // 先直接强杀目标进程：Windows 上 process.kill(pid,'SIGKILL') 走 TerminateProcess，立即生效，
    // 不受 taskkill /T 遍历整棵树耗时/超时的影响（实测本机 taskkill /T 会先报
    // "This operation returned because the timeout period expired" 并卡 ~15s，
    // 目标进程是否真被杀掉取决于树结构 —— 训练中止不能靠这种不确定性）。
    let direct = { ok: false, skipped: true }
    if (this.ownsPid(p)) {
      try {
        process.kill(p, 'SIGKILL')
        direct = { ok: true, method: 'sigkill' }
      } catch (e) {
        direct = { ok: false, reason: String((e && e.message) || e) }
      }
    }
    try {
      const out = await new Promise((resolve, reject) => {
        this.exec('taskkill', ['/PID', String(p), '/F', '/T'], { timeout: 8000 }, (err, stdout, stderr) => {
          if (err) return reject(Object.assign(err, { stdout: String(stdout || ''), stderr: String(stderr || '') }))
          resolve(String(stdout || ''))
        })
      })
      this.log?.('warn', 'engine.kill_tree', { pid: p, cmdline, out: out.trim(), direct })
      return { ok: true, method: 'taskkill', out: out.trim(), cmdline, direct }
    } catch (e) {
      // taskkill 可能因为"整棵树超时"报错，而目标进程已被上面的直接强杀干掉 —— 以那次强杀的结果为准：
      // 直接强杀成功就说明进程已终止，taskkill 只是清残留子树的"尽力而为"。
      if (direct.ok) {
        this.log?.('warn', 'engine.kill_tree_timeout_but_killed', { pid: p, cmdline, direct, error: e && e.message })
        return { ok: true, method: 'sigkill', note: 'taskkill 报错但目标进程已被直接强杀', direct, cmdline, error: String((e && e.message) || e) }
      }
      this.log?.('warn', 'engine.kill_tree_failed', { pid: p, cmdline, error: e && e.message, stderr: e && e.stderr, direct })
      return { ok: false, reason: String((e && e.message) || e), cmdline, direct }
    }
  }

  // ---------------- 阶梯重启 ----------------

  ladderFor(engine) {
    return this.ladders[engine] || this.ladders.webui || []
  }

  /** 该引擎的第 level 级旗标（越界返回 null） */
  flagFor(engine, level) {
    const l = this.ladderFor(engine)
    return level >= 0 && level < l.length ? l[level] : null
  }

  /** 某一级是否还有使用额度（每级最多 1 次） */
  levelAvailable(engine, level) {
    const used = this.levelUse.get(engine) || new Set()
    return !used.has(level)
  }

  markLevelUsed(engine, level) {
    if (!this.levelUse.has(engine)) this.levelUse.set(engine, new Set())
    this.levelUse.get(engine).add(level)
  }

  resetLadder(engine) {
    this.levelUse.delete(engine)
  }

  /** 下一代可用的阶梯档位（从 0 向上找未用过的） */
  nextLevel(engine) {
    const l = this.ladderFor(engine)
    for (let i = 0; i < l.length; i++) {
      if (this.levelAvailable(engine, i)) return i
    }
    return -1
  }

  /**
   * OOM 处理：强杀当前进程树 → 按阶梯重启 → 等待引擎就绪。
   * @param {object} p
   * @param {string} p.engine      'webui' | 'comfy'
   * @param {string} p.error       OOM 错误消息
   * @param {() => string[]} p.buildCmd 生成启动命令（不含阶梯旗标），返回 [file, ...args]
   * @param {(engine:string) => Promise<boolean>} p.waitReady 就绪探测
   * @returns {Promise<{restarted:boolean, level:number, flag:string|null, pid:number|null, reason?:string, killed?:object}>}
   */
  async handleOom({ engine, error, buildCmd = null, waitReady = null }) {
    const rec = this.get(engine)
    if (!this.isOomError(error)) return { restarted: false, reason: 'not-oom' }

    rec && (rec.lastOomAt = this.now())

    // 1) 强杀进程树（含没登记的情况：端口反查补一刀）
    let killed = null
    if (rec && rec.pid) {
      killed = await this.killTree(rec.pid)
      if (!killed.ok && rec.port) {
        const pid2 = await this.findPidByPort(rec.port)
        if (pid2 && pid2 !== rec.pid) {
          this.log?.('warn', 'engine.kill_retry_by_port', { engine, pid: pid2 })
          await this.killTree(pid2)
        }
      }
    } else if (rec && rec.port) {
      const pid2 = await this.findPidByPort(rec.port)
      if (pid2) killed = await this.killTree(pid2)
    }
    this.unregister(engine, 'oom-killed')

    // 2) 选阶梯档位（每级最多 1 次）
    const level = this.nextLevel(engine)
    if (level < 0) {
      this.log?.('error', 'engine.ladder_exhausted', { engine, ladder: this.ladderFor(engine) })
      return { restarted: false, reason: 'ladder-exhausted', level: -1, flag: null, pid: null, killed }
    }
    const flag = this.flagFor(engine, level)
    this.markLevelUsed(engine, level)

    // 3) 重启
    if (!buildCmd) {
      this.log?.('error', 'engine.no_launch_command', { engine, level, flag })
      return { restarted: false, reason: 'no-launch-command', level, flag, pid: null, killed }
    }
    let child = null
    let stdio = 'ignore'
    let cmd = []
    let cwd = undefined
    try {
      const built = buildCmd({ level, flag })
      if (Array.isArray(built)) {
        cmd = built
        if (flag) cmd = [...cmd, flag]
      } else if (built && Array.isArray(built.cmd)) {
        cmd = built.cmd
        cwd = built.cwd || undefined
        if (built.stdio) stdio = built.stdio
        // includeFlag=false：由 buildCmd 自己把旗标摆到正确位置（例如 webui 的 -VramFlag <flag>）
        if (built.includeFlag !== false && flag) cmd = [...cmd, flag]
      }
    } catch (e) {
      this.log?.('error', 'engine.build_cmd_failed', { engine, error: e })
      return { restarted: false, reason: 'build-cmd-failed', level, flag, pid: null, killed }
    }
    if (!cmd.length || !cmd[0]) {
      this.log?.('error', 'engine.empty_launch_command', { engine, level, flag })
      return { restarted: false, reason: 'empty-launch-command', level, flag, pid: null, killed }
    }

    let child2 = null
    try {
      child2 = this.spawnFn(cmd[0], cmd.slice(1), { detached: this.spawnDetached, stdio, windowsHide: true, cwd })
      child = child2
      child.unref?.()
    } catch (e) {
      this.log?.('error', 'engine.spawn_failed', { engine, level, flag, cmd: cmd.join(' '), error: e })
      return { restarted: false, reason: 'spawn-failed', level, flag, pid: null, killed, error: String((e && e.message) || e) }
    }

    const prevRestarts = rec ? rec.restartCount : 0
    const newRec = this.register(engine, {
      pid: child.pid,
      args: cmd.slice(1),
      cmdline: cmd.join(' '),
      source: 'ladder-restart',
      port: rec ? rec.port : null,
    })
    newRec.restartCount = prevRestarts + 1
    newRec.level = level

    this.log?.('warn', 'engine.ladder_restart', { engine, level, flag, pid: child.pid, cmd: cmd.join(' '), restartCount: newRec.restartCount })

    // 4) 等待就绪（超时不算致命：调用方重试时会再撞上真实错误）
    let ready = false
    if (waitReady) {
      try { ready = await waitReady(engine) } catch (e) {
        this.log?.('warn', 'engine.wait_ready_failed', { engine, error: e })
        ready = false
      }
    }
    return { restarted: true, ready, level, flag, pid: child.pid, cmdline: cmd.join(' '), killed }
  }

  /** 供 /api/health 用的快照 */
  snapshot() {
    return {
      engines: this.list(),
      ladders: this.ladders,
      levelUse: Object.fromEntries([...this.levelUse.entries()].map(([k, v]) => [k, [...v]])),
    }
  }
}

export { sleep }