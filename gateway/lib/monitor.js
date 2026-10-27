/**
 * gateway/lib/monitor.js — 硬件监控（P3）
 *
 * 数据链：ROS2（ws://localhost:9090 订阅，只收 JSON）→ 断连或未就绪时降级 nvidia-smi。
 * 纪律：连接/订阅/解析全部 try-catch；监控**绝不阻塞** /api/generate——
 *       快照过期时不做准入判断（只能拿旧数据时宁可放行，也不能卡住出图）。
 */

'use strict'

import { execFile } from 'node:child_process'
import { Ros2WsClient } from './ros2.js'

export class Monitor {
  constructor({
    url = 'ws://localhost:9090',
    topic = '/hardware_monitor',
    enabled = true,
    nvidiaIntervalMs = 5000,
    vramMinFreeGb = 1.5,
    vramWarnFreeGb = 3.0,
    staleMs = 30000,
    log = null,
    wsFactory = null,
    exec = execFile,
    now = () => Date.now(),
  } = {}) {
    this.url = url
    this.topic = topic
    this.enabled = enabled
    this.nvidiaIntervalMs = nvidiaIntervalMs
    this.vramMinFreeGb = vramMinFreeGb
    this.vramWarnFreeGb = vramWarnFreeGb
    this.staleMs = staleMs
    this.log = log
    this.exec = exec
    this.now = now
    this.wsFactory = wsFactory || ((opts) => new Ros2WsClient(opts))

    this.snapshot = {
      source: 'none',
      vramFreeGb: null,
      vramTotalGb: null,
      gpuUtil: null,
      updatedAt: null,
      raw: null,
    }
    this.ws = null
    this.nvidiaTimer = null
    this.nvidiaFailures = 0
    this.lastNvidiaError = null
    this.rosMessages = 0
    this.started = false
  }

  // ---------------- 生命周期 ----------------

  start() {
    if (this.started) return this
    this.started = true
    // 先立刻拿一次 nvidia-smi 基准（异步，不阻塞启动）
    this.refreshNvidia()
    this.nvidiaTimer = setInterval(() => {
      // ROS2 在线时不再刷 nvidia-smi（省一次进程调用）；断连才需要
      if (!this.isRosConnected()) this.refreshNvidia()
    }, this.nvidiaIntervalMs)
    this.nvidiaTimer.unref?.()
    if (this.enabled) this.connectRos2()
    else this.log?.('info', 'monitor.ros2_disabled', {})
    return this
  }

  stop() {
    if (this.nvidiaTimer) { clearInterval(this.nvidiaTimer); this.nvidiaTimer = null }
    if (this.ws) {
      try { this.ws.stop() } catch (e) { this.log?.('debug', 'monitor.ws_stop_failed', { error: e }) }
      this.ws = null
    }
    this.started = false
    return this
  }

  /** 连接 ROS2（失败由客户端内部重连；这里只负责建链与事件绑定） */
  connectRos2() {
    try {
      const ws = this.wsFactory({
        url: this.url,
        topic: this.topic,
        log: this.log,
        onMessage: undefined,
      })
      this.ws = ws
      ws.on('open', () => {
        this.log?.('info', 'monitor.ros2_open', { url: this.url, topic: this.topic })
      })
      ws.on('message', (json) => {
        this.rosMessages += 1
        try { this.applyRosMessage(json) } catch (e) {
          this.log?.('debug', 'monitor.ros2_msg_ignored', { error: e })
        }
      })
      ws.on('close', (info) => {
        this.log?.('warn', 'monitor.ros2_down', { reason: info && info.reason, error: info && info.error })
        // 断连 → 立刻降级 nvidia-smi
        this.refreshNvidia()
      })
      ws.start()
    } catch (e) {
      this.log?.('warn', 'monitor.ros2_setup_failed', { error: e })
      this.refreshNvidia()
    }
  }

  isRosConnected() {
    try { return !!(this.ws && this.ws.connected) } catch { return false }
  }

  // ---------------- ROS2 JSON → 快照 ----------------

  /** 兼容 rosbridge publish 包裹与裸 JSON；字段名多种写法都认 */
  applyRosMessage(json) {
    if (!json || typeof json !== 'object') return false
    const body = json.msg && typeof json.msg === 'object' ? json.msg : json
    const pickNum = (...keys) => {
      for (const k of keys) {
        const v = body[k]
        if (typeof v === 'number' && Number.isFinite(v)) return v
        if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
      }
      return null
    }
    const vramFree = pickNum('vram_free_gb', 'free_gb', 'gpu_mem_free_gb', 'memory_free_gb', 'vram_free')
    const vramTotal = pickNum('vram_total_gb', 'total_gb', 'gpu_mem_total_gb', 'memory_total_gb', 'vram_total')
    const gpuUtil = pickNum('gpu_util', 'gpu_utilization', 'util', 'gpu_percent')
    if (vramFree === null && vramTotal === null && gpuUtil === null) {
      // 不是硬件监控报文：忽略（但计数保留，便于排障）
      return false
    }
    const norm = (v) => (v !== null && v > 200 ? v / 1024 : v) // 有些节点直接给 MB
    this.snapshot = {
      source: 'ros2',
      vramFreeGb: round2(norm(vramFree)),
      vramTotalGb: round2(norm(vramTotal)),
      gpuUtil,
      updatedAt: this.now(),
      raw: body,
    }
    return true
  }

  // ---------------- nvidia-smi 降级 ----------------

  refreshNvidia() {
    return new Promise((resolve) => {
      try {
        this.exec(
          'nvidia-smi',
          ['--query-gpu=memory.total,memory.free,utilization.gpu', '--format=csv,noheader,nounits'],
          { timeout: 8000, maxBuffer: 1024 * 1024 },
          (err, stdout) => {
            if (err) {
              this.nvidiaFailures += 1
              this.lastNvidiaError = String((err && err.message) || err)
              // 只在第一次失败时告警，避免刷屏
              if (this.nvidiaFailures === 1) this.log?.('warn', 'monitor.nvidia_unavailable', { error: this.lastNvidiaError })
              this.snapshot = { ...this.snapshot, source: this.isRosConnected() ? 'ros2' : 'none' }
              return resolve(false)
            }
            try {
              const line = String(stdout).trim().split(/[\r\n]+/)[0]
              const [total, free, util] = line.split(',').map((s) => Number(String(s).trim()))
              if (!Number.isFinite(total) || !Number.isFinite(free)) throw new Error(`无法解析输出: ${line}`)
              // 若 ROS2 已在线，别用 nvidia-smi 覆盖（ROS2 数据更全）
              if (!this.isRosConnected()) {
                this.snapshot = {
                  source: 'nvidia-smi',
                  vramTotalGb: round2(total / 1024),
                  vramFreeGb: round2(free / 1024),
                  gpuUtil: Number.isFinite(util) ? util : null,
                  updatedAt: this.now(),
                  raw: { line },
                }
              }
              resolve(true)
            } catch (e) {
              this.nvidiaFailures += 1
              this.lastNvidiaError = String((e && e.message) || e)
              this.log?.('warn', 'monitor.nvidia_parse_failed', { error: this.lastNvidiaError })
              resolve(false)
            }
          },
        )
      } catch (e) {
        this.nvidiaFailures += 1
        this.lastNvidiaError = String((e && e.message) || e)
        this.log?.('warn', 'monitor.nvidia_call_failed', { error: this.lastNvidiaError })
        resolve(false)
      }
    })
  }

  // ---------------- 对外读取（非阻塞） ----------------

  getSnapshot() {
    const ageMs = this.snapshot.updatedAt ? this.now() - this.snapshot.updatedAt : null
    return {
      ...this.snapshot,
      ageMs,
      stale: ageMs === null || ageMs > this.staleMs,
      ros2: this.ws && typeof this.ws.status === 'function'
        ? this.ws.status()
        : { url: this.url, topic: this.topic, connected: false, messages: this.rosMessages },
      degraded: !this.isRosConnected(),
      nvidiaFailures: this.nvidiaFailures,
      lastNvidiaError: this.lastNvidiaError,
    }
  }

  /**
   * 队列准入判断（**只读快照，不发网络请求，不阻塞出图**）。
   * @returns {{admit:boolean, level:'ok'|'warn'|'block'|'unknown', reason:string, vramFreeGb:number|null, waitMs:number}}
   */
  admission() {
    const snap = this.getSnapshot()
    if (snap.vramFreeGb === null || snap.stale) {
      return { admit: true, level: 'unknown', reason: '监控数据不可用/过期 → 放行（不阻塞出图）', vramFreeGb: snap.vramFreeGb, waitMs: 0 }
    }
    if (snap.vramFreeGb < this.vramMinFreeGb) {
      return {
        admit: false,
        level: 'block',
        reason: `剩余显存 ${snap.vramFreeGb}GB < 准入线 ${this.vramMinFreeGb}GB → 排队等待（不丢任务）`,
        vramFreeGb: snap.vramFreeGb,
        waitMs: 5000,
      }
    }
    if (snap.vramFreeGb < this.vramWarnFreeGb) {
      return { admit: true, level: 'warn', reason: `剩余显存 ${snap.vramFreeGb}GB 偏低（< ${this.vramWarnFreeGb}GB）→ OOM 风险偏高`, vramFreeGb: snap.vramFreeGb, waitMs: 0 }
    }
    return { admit: true, level: 'ok', reason: 'ok', vramFreeGb: snap.vramFreeGb, waitMs: 0 }
  }

  /** OOM 预警分级（写入任务记录的 vram_warning） */
  oomRisk() {
    const snap = this.getSnapshot()
    if (snap.vramFreeGb === null || snap.stale) return { risk: 'unknown', vramFreeGb: snap.vramFreeGb, reason: '监控数据不可用' }
    if (snap.vramFreeGb < this.vramMinFreeGb) return { risk: 'high', vramFreeGb: snap.vramFreeGb, reason: `剩余 ${snap.vramFreeGb}GB 低于 ${this.vramMinFreeGb}GB` }
    if (snap.vramFreeGb < this.vramWarnFreeGb) return { risk: 'medium', vramFreeGb: snap.vramFreeGb, reason: `剩余 ${snap.vramFreeGb}GB 低于预警线 ${this.vramWarnFreeGb}GB` }
    return { risk: 'low', vramFreeGb: snap.vramFreeGb, reason: 'ok' }
  }
}

function round2(v) {
  return v === null || v === undefined ? null : Math.round(v * 100) / 100
}