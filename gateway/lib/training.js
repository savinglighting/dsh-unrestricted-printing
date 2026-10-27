/**
 * gateway/lib/training.js — 训练互斥与生命周期（P4 → P1 双轨改造）
 *
 * 规则：
 *   1. 训练启动 → isTraining=true 独占网关（生图请求直接 409）；闸门锁交给 'training'；
 *   2. 参数分三层注入（细节见 training-profiles.js）：
 *      · baselineArgs —— 硬底线（优化器/精度/显存/分桶/保存格式），**不可被用户覆盖**（保留 P4 语义）；
 *      · profile      —— 双轨档位标准（id: 标准 LoRA dim=8｜base: LyCORIS LoCon dim=32）；
 *      · userArgs     —— 可钳制键（dim/alpha/lr/steps/resolution）按档位护栏钳到合法区间，越界记账回传；
 *   3. 训练结束 / 异常退出 / 网关重启 → 必须释放锁 + 清理临时文件（临时目录绑定在 tempRoot 下，
 *      清理前校验绝对路径前缀，绝不误删外部目录）；
 *   4. 全程 try-catch，任何一步失败都写日志并把原因回给调用方。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { getProfile, normalizeArgs, PROFILE_NAMES } from './training-profiles.js'

export class TrainingManager {
  constructor({
    store,
    engineManager = null,
    log = null,
    tempRoot = null,
    /** 硬底线参数：不可被用户覆盖（旧字段名 forcedArgs 仍兼容） */
    baselineArgs = null,
    forcedArgs = null,
    /** 双轨档位标准（一般来自 config.trainer.profiles） */
    profiles = null,
    profileDefault = 'id',
    /**
     * 训练日志目录（可选）。给了就写到这里，**不随临时目录清理而消失** ——
     * 一键炼制需要拿日志尾部做失败分类（OOM / 缺依赖 / 缺脚本），
     * 日志若随 tempDir 一起被删，失败原因就永远读不到了。
     */
    logDir = null,
    /** 训练子进程的环境变量（HF 离线等）；由 config 注入 */
    trainEnv = null,
    script = null,
    python = null,
    spawnFn = spawn,
    now = () => Date.now(),
  } = {}) {
    this.store = store
    this.mgr = engineManager
    this.log = log
    this.tempRoot = tempRoot ? path.resolve(tempRoot) : null
    const base = Array.isArray(baselineArgs) && baselineArgs.length
      ? baselineArgs
      : (Array.isArray(forcedArgs) && forcedArgs.length
        ? forcedArgs
        : ['--optimizer_type=AdamW8bit', '--mixed_precision=fp16', '--lowvram', '--enable_bucket', '--save_model_as=safetensors'])
    this.baselineArgs = base.map(String)
    /** 兼容旧读取方（老代码仍会读 forcedArgs） */
    this.forcedArgs = this.baselineArgs
    this.profiles = Array.isArray(profiles) && profiles.length ? profiles : PROFILE_NAMES.map((n) => getProfile(n))
    this.profileDefault = String(profileDefault || 'id')
    this.trainEnv = trainEnv && typeof trainEnv === 'object' ? trainEnv : null
    this.trainLogDir = logDir ? path.resolve(logDir) : null
    if (this.trainLogDir) {
      try { fs.mkdirSync(this.trainLogDir, { recursive: true }) } catch (e) {
        this.log?.('warn', 'training.logdir_failed', { dir: this.trainLogDir, error: e })
        this.trainLogDir = null
      }
    }
    this.script = script
    this.python = python
    this.spawnFn = spawnFn
    this.now = now
    this.current = null // { taskId, pid, child, cmd, tempDir, logFile, startedAt, profile }
    this.createdDirs = []
  }

  /**
   * 三层归一：baseline（硬底线，不可覆盖） → profile（档位标准值） → userArgs（可钳制追加）。
   * 越界钳制与忽略项都会写日志并随返回值回传（不静默改数）。
   * @param {string[]} extraArgs 用户追加参数
   * @param {{profile?:string|null}} opts
   */
  buildArgs(extraArgs = [], { profile = undefined } = {}) {
    const want = profile === undefined ? this.profileDefault : profile
    const p = want === null ? null : getProfile(want)
    const r = normalizeArgs({
      profile: p ? p.name : null,
      userArgs: Array.isArray(extraArgs) ? extraArgs : [],
      baselineArgs: this.baselineArgs,
    })
    for (const it of r.ignored) this.log?.('warn', 'training.arg_ignored', it)
    for (const it of r.adjusted) this.log?.('warn', 'training.arg_adjusted', it)
    return { ...r, profile: p ? p.name : null }
  }

  /** 校验可执行路径（不存在 → 返回明确错误） */
  resolveLauncher({ cmd = null } = {}) {
    if (Array.isArray(cmd) && cmd.length) {
      const [file, ...args] = cmd.map(String)
      if (!file) return { ok: false, error: 'cmd[0] 为空' }
      return { ok: true, file, args, source: 'explicit-cmd' }
    }
    if (!this.script) {
      return {
        ok: false,
        error: '未找到 sdxl_train_network.py：设置环境变量 GW_TRAIN_SCRIPT 指向训练脚本，或在请求体里传 cmd:[...]',
      }
    }
    if (!fs.existsSync(this.script)) return { ok: false, error: `训练脚本不存在: ${this.script}` }
    const py = this.python || 'python'
    return { ok: true, file: py, args: [this.script], source: 'discovered-script' }
  }

  prepareTempDir(taskId) {
    if (!this.tempRoot) return null
    const dir = path.join(this.tempRoot, `gateway-train-${taskId}`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      this.createdDirs.push(dir)
      return dir
    } catch (e) {
      this.log?.('warn', 'training.tempdir_failed', { dir, error: e })
      return null
    }
  }

  /** 启动训练；返回 { ok, taskId, pid, cmd, profile, injected, profile_args, adjusted } 或 { ok:false, error, code } */
  start({ extraArgs = [], cmd = null, meta = {}, profile = undefined } = {}) {
    if (this.store.training) return { ok: false, code: 'TRAINING_ALREADY_ACTIVE', error: '已有训练在进行（训练为全局独占）' }
    if (this.current) return { ok: false, code: 'TRAINING_ALREADY_ACTIVE', error: '训练进程句柄仍然存在' }

    // 档位必须显式可识别：未知档位不猜、不静默退化成默认档
    const want = profile === undefined ? this.profileDefault : profile
    const prof = want === null ? null : getProfile(want)
    if (want !== null && !prof) {
      return { ok: false, code: 'TRAIN_PROFILE_UNKNOWN', error: `未知训练档位: ${want}（可选 ${PROFILE_NAMES.join(' / ')}）` }
    }

    const launch = this.resolveLauncher({ cmd })
    if (!launch.ok) return { ok: false, code: 'TRAIN_LAUNCHER_UNAVAILABLE', error: launch.error }

    const built = this.buildArgs(extraArgs, { profile: prof ? prof.name : null })
    const task = this.store.createTask({ kind: 'training', model: null, engine: 'trainer', payload: { extraArgs, meta, profile: built.profile } })
    const args = built.args
    const taskId = task.id
    const tempDir = this.prepareTempDir(taskId)
    // 日志优先落 logDir（不随临时目录清理消失）；没配 logDir 才退回临时目录
    const logFile = this.trainLogDir
      ? path.join(this.trainLogDir, `${taskId}.log`)
      : (tempDir ? path.join(tempDir, 'train.log') : null)

    const finalArgs = [...launch.args, ...args]
    let child = null
    try {
      const stdio = logFile ? ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')] : 'ignore'
      // HF 离线环境**必须**注入训练子进程：kohya 训练时 transformers 会去 huggingface.co
      // 拉 clip tokenizer，网络不通就 httpx.ConnectTimeout 卡 6 分钟后失败
      // （实测 2026-10-22，本机 SD 目录里已有完整缓存，指向它即可完全不联网）。
      // 与 sd-direct.ps1 用同一套变量名，保证「出图」和「训练」两条链路行为一致。
      //
      // 编码也必须一起管住：中文 Windows 下 Python 默认按 GBK 写 stdout，
      // 而日志是按字节流落盘的，之后按 UTF-8 读就会得到「锟斤拷」这类不可逆乱码
      // （tqdm 进度条最先中招）。PYTHONIOENCODING=utf-8 让它统一输出 UTF-8。
      const env = { ...process.env, ...(this.trainEnv || {}), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      child = this.spawnFn(launch.file, finalArgs, { detached: false, windowsHide: true, stdio, env })
    } catch (e) {
      const msg = `训练进程启动失败: ${(e && e.message) || e}`
      this.log?.('error', 'training.spawn_failed', { cmd: [launch.file, ...finalArgs].join(' '), error: e })
      this.store.fail(taskId, 'TRAIN_SPAWN_FAILED', msg)
      this.cleanupTemp(msg)
      return { ok: false, code: 'TRAIN_SPAWN_FAILED', error: msg }
    }

    // 独占锁 + 任务进 training 态
    this.store.beginTraining({
      taskId,
      cmd: [launch.file, ...finalArgs].join(' '),
      tempDir,
      baselineArgs: this.baselineArgs,
      profile: built.profile,
      adjusted: built.adjusted,
    })
    this.store.setStatus(taskId, 'training', { result: { tempDir, logFile, profile: built.profile } })

    this.current = { taskId, pid: child.pid, child, cmd: [launch.file, ...finalArgs], tempDir, logFile, startedAt: this.now(), profile: built.profile, adjusted: built.adjusted }
    this.mgr?.register('trainer', { pid: child.pid, args: finalArgs, cmdline: [launch.file, ...finalArgs].join(' '), source: 'training' })
    this.store.saveState()

    this.log?.('warn', 'training.started', {
      taskId,
      pid: child.pid,
      cmd: this.current.cmd,
      tempDir,
      profile: built.profile,
      baselineArgs: this.baselineArgs,
      profileArgs: built.profileArgs,
      adjusted: built.adjusted,
    })

    child.on('exit', (code, signal) => {
      this.finalize(taskId, code === 0 ? 'success' : 'failed', { exitCode: code, signal })
    })
    child.on('error', (e) => {
      this.log?.('error', 'training.child_error', { taskId, error: e })
      this.finalize(taskId, 'failed', { error: String((e && e.message) || e) })
    })

    return {
      ok: true,
      taskId,
      pid: child.pid,
      status: 'training',
      cmd: this.current.cmd,
      cmd_line: this.current.cmd.join(' '),
      /** 硬底线（不可覆盖项） */
      injected: built.baselineArgs,
      /** 本轨档位与其标准参数 */
      profile: built.profile,
      profile_args: built.profileArgs,
      /** 被护栏钳制的项（越界 → 钳到边界，已回传） */
      adjusted: built.adjusted,
      /** 被忽略的项（底线覆盖 / 档位权威 / 档位默认优先 / 重复） */
      ignored: built.ignored,
      args: built.args,
      tempDir,
      logFile,
    }
  }

  /** 主动结束（人工/网关关停）：强杀进程树后释放锁 */
  async stop({ reason = 'manual' } = {}) {
    const cur = this.current
    if (!cur) {
      // 没有进程句柄但仍处于训练态（异常残留）→ 直接释放
      const was = this.store.endTraining(reason)
      this.cleanupTemp(reason)
      this.store.clearState()
      return { ok: true, killed: false, released: was }
    }
    let killed = null
    if (this.mgr) killed = await this.mgr.killTree(cur.pid)
    else {
      try { process.kill(cur.pid, 'SIGKILL'); killed = { ok: true, method: 'sigkill' } } catch (e) {
        this.log?.('warn', 'training.kill_failed', { pid: cur.pid, error: e })
        killed = { ok: false, reason: String((e && e.message) || e) }
      }
    }
    this.finalize(cur.taskId, cur.child && cur.child.exitCode === 0 ? 'success' : 'failed', { killed, reason })
    return { ok: true, killed, taskId: cur.taskId, reason }
  }

  /** 统一收尾：停表状态 + 释放锁 + 清理临时文件（幂等） */
  finalize(taskId, outcome, extra = {}) {
    const cur = this.current
    try {
      if (cur && cur.taskId === taskId) {
        const dur = this.now() - cur.startedAt
        if (outcome === 'success') {
          this.store.setStatus(taskId, 'success', { result: { ...(this.store.getTask(taskId)?.result || {}), durationMs: dur }, ...extra })
        } else {
          const msg = extra.error || `训练进程异常退出（exit=${extra.exitCode ?? 'n/a'}${extra.reason ? ', reason=' + extra.reason : ''}）`
          this.store.fail(taskId, 'TRAIN_FAILED', msg, extra)
        }
        this.mgr?.unregister('trainer', 'training-ended', { exitCode: extra.exitCode })
        this.current = null
      } else if (!cur) {
        // 无句柄但状态还在：兜底补一个终态
        const t = this.store.getTask(taskId)
        if (t && t.status === 'training') {
          this.store.fail(taskId, 'TRAIN_LOST_HANDLE', extra.error || '训练进程句柄丢失，按异常退出处理', extra)
        }
      }
    } catch (e) {
      this.log?.('error', 'training.finalize_failed', { taskId, error: e })
    } finally {
      // 不管上面怎么炸，锁必须释放、临时文件必须清（P4 硬要求）
      try {
        const was = this.store.endTraining('finalized')
        this.log?.('info', 'training.lock_released', { taskId, wasTraining: was })
      } catch (e) {
        this.log?.('error', 'training.release_failed', { taskId, error: e })
      }
      this.cleanupTemp(`finalize:${taskId}`)
      this.store.clearState()
      this.store.saveState()
    }
  }

  /** 清理训练临时文件：只动 tempRoot 下的目录 */
  cleanupTemp(reason = 'cleanup') {
    const removed = []
    if (!this.tempRoot) return removed
    const rootAbs = path.resolve(this.tempRoot)
    for (const dir of [...this.createdDirs]) {
      const dirAbs = path.resolve(dir)
      if (!dirAbs.startsWith(rootAbs + path.sep)) {
        this.log?.('error', 'training.cleanup_refused', { dir: dirAbs, root: rootAbs, reason: '路径不在 tempRoot 内，拒绝删除' })
        continue
      }
      try {
        if (fs.existsSync(dirAbs)) {
          fs.rmSync(dirAbs, { recursive: true, force: true })
          removed.push(dirAbs)
        }
        this.createdDirs = this.createdDirs.filter((d) => d !== dir)
      } catch (e) {
        this.log?.('warn', 'training.cleanup_failed', { dir: dirAbs, error: e })
      }
    }
    if (removed.length) this.log?.('info', 'training.temp_cleaned', { reason, removed })
    return removed
  }

  /** 扫掉 tempRoot 下遗留的 gateway-train-* 目录（网关重启后的清理） */
  sweepOrphanTemp() {
    if (!this.tempRoot) return []
    const rootAbs = path.resolve(this.tempRoot)
    const removed = []
    try {
      if (!fs.existsSync(rootAbs)) return removed
      for (const name of fs.readdirSync(rootAbs)) {
        if (!/^gateway-train-/.test(name)) continue
        const dirAbs = path.join(rootAbs, name)
        if (!path.resolve(dirAbs).startsWith(rootAbs + path.sep)) continue
        try {
          fs.rmSync(dirAbs, { recursive: true, force: true })
          removed.push(dirAbs)
        } catch (e) {
          this.log?.('warn', 'training.sweep_failed', { dir: dirAbs, error: e })
        }
      }
      if (removed.length) this.log?.('warn', 'training.orphan_cleaned', { removed })
    } catch (e) {
      this.log?.('warn', 'training.sweep_error', { error: e })
    }
    return removed
  }

  /**
   * 网关启动时的崩溃恢复：上一次进程留下的训练锁/临时文件全部释放。
   * @returns {{recovered:boolean, released:boolean, cleaned:string[]}}
   */
  recover() {
    let released = false
    const prev = this.store.loadState()
    if (prev && prev.training) {
      this.log?.('warn', 'training.recovered_stale_lock', {
        prevPid: prev.pid,
        trainingStartedAt: prev.trainingStartedAt,
        meta: prev.trainingMeta,
        note: '上次网关进程退出时训练未正常收尾 → 本次启动强制释放锁',
      })
      released = this.store.endTraining('gateway-restart')
      // 顺手把上次记的 PID 也清掉（进程可能还活着，但那已经不属于本次网关）
      if (prev.trainingMeta && prev.trainingMeta.pid) {
        this.mgr?.unregister('trainer', 'gateway-restart')
      }
    } else {
      // 没记录也要清一次锁，保证启动后状态干净
      released = this.store.endTraining('gateway-start')
    }
    const cleaned = this.sweepOrphanTemp()
    this.store.clearState()
    this.store.saveState()
    return { recovered: !!(prev && prev.training), released, cleaned }
  }
}