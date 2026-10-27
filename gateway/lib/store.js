/**
 * gateway/lib/store.js — 任务表 + 状态机 + 单车道排队锁 + 训练互斥（P1/P4）
 *
 * 状态机（GET /api/status/{id} 对外可见）：
 *   queued  → running → success | failed
 *   training（训练任务处于运行中时的状态）
 *   任一非终态 → failed（校验失败/被拦截）
 *
 * 单车道锁：**准备阶段（校验/探测/入队）不占锁**，只有正式出图前才 tryAcquire；
 * 抢不到不失败，留在队列里按 FIFO 等下一轮（排队而非拒单）。
 *
 * 训练互斥：isTraining=true 时网关拦截一切生图 → HTTP 409，并把闸门锁死；
 * 训练结束/异常退出/网关重启都必须释放锁（见 endTraining / recoverState）。
 */

'use strict'

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const STATUS = {
  QUEUED: 'queued',
  TRAINING: 'training',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

const TERMINAL = new Set([STATUS.SUCCESS, STATUS.FAILED, STATUS.CANCELLED])

/** 合法状态迁移表 */
const TRANSITIONS = {
  [STATUS.QUEUED]: [STATUS.RUNNING, STATUS.FAILED, STATUS.CANCELLED, STATUS.TRAINING],
  [STATUS.TRAINING]: [STATUS.SUCCESS, STATUS.FAILED, STATUS.CANCELLED],
  [STATUS.RUNNING]: [STATUS.SUCCESS, STATUS.FAILED, STATUS.CANCELLED],
  [STATUS.SUCCESS]: [],
  [STATUS.FAILED]: [],
  [STATUS.CANCELLED]: [],
}

export class TaskStore {
  constructor({ stateFile = null, log = null, now = () => Date.now() } = {}) {
    /** @type {Map<string, object>} task_id → 任务记录 */
    this.tasks = new Map()
    /** FIFO 队列（元素为 task_id） */
    this.queue = []
    /** 单车道闸门 */
    this.gateLocked = false
    this.gateOwner = null
    /** 训练独占 */
    this.training = false
    this.trainingMeta = null
    this.trainingStartedAt = null
    this.stateFile = stateFile
    this.log = log
    this.now = now
    this.historyLimit = 500
  }

  newTaskId() {
    return crypto.randomUUID()
  }

  // ---------------- 任务表 ----------------

  createTask({ kind = 'image', model = null, engine = null, payload = {}, id = null } = {}) {
    const taskId = id || this.newTaskId()
    const t = {
      id: taskId,
      kind,
      model,
      engine,
      status: kind === 'training' ? STATUS.QUEUED : STATUS.QUEUED,
      payload,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      errorCode: null,
      result: null,
      attempts: 0,
      oomLadder: [],
      admission: null,
      meta: {},
    }
    this.tasks.set(taskId, t)
    // 入队：image 与 bridge 都走单车道 pump（2026-10-27 修「bridge 任务卡 queued」——
    //   原来只有 kind==='image' 入队，bridge 任务创建后 pump 永远取不到，卡死在 queued）。
    //   training 有自己的独占调度路径，不入生图队列。
    if (kind === 'image' || kind === 'bridge') this.queue.push(taskId)
    this.trim()
    return t
  }

  getTask(id) {
    return this.tasks.get(id) || null
  }

  listTasks({ limit = 50, status = null } = {}) {
    let arr = [...this.tasks.values()]
    if (status) arr = arr.filter((t) => t.status === status)
    arr.sort((a, b) => b.createdAt - a.createdAt)
    return arr.slice(0, limit)
  }

  /**
   * 状态迁移（非法迁移不改状态并记 warn，绝不静默）
   * @returns {boolean} 是否迁移成功
   */
  setStatus(id, status, extra = {}) {
    const t = this.tasks.get(id)
    if (!t) {
      this.log?.('warn', 'task.not_found', { id, status })
      return false
    }
    if (t.status !== status) {
      const allowed = TRANSITIONS[t.status] || []
      if (!allowed.includes(status)) {
        this.log?.('warn', 'task.illegal_transition', { id, from: t.status, to: status })
        return false
      }
    }
    t.status = status
    Object.assign(t, extra)
    if (status === STATUS.RUNNING || status === STATUS.TRAINING) {
      if (!t.startedAt) t.startedAt = this.now()
    }
    if (TERMINAL.has(status)) t.finishedAt = this.now()
    return true
  }

  /** 失败快捷入口：写 error/errorCode（失败可查询） */
  fail(id, code, message, extra = {}) {
    return this.setStatus(id, STATUS.FAILED, {
      error: message,
      errorCode: code,
      ...extra,
    })
  }

  trim() {
    if (this.tasks.size <= this.historyLimit) return
    const done = [...this.tasks.values()]
      .filter((t) => TERMINAL.has(t.status))
      .sort((a, b) => (a.finishedAt || a.createdAt) - (b.finishedAt || b.createdAt))
    while (this.tasks.size > this.historyLimit && done.length) {
      const victim = done.shift()
      this.tasks.delete(victim.id)
    }
  }

  // ---------------- 队列 ----------------

  enqueue(taskId) {
    if (!this.queue.includes(taskId)) this.queue.push(taskId)
    return this.queue.length
  }

  peek() {
    return this.queue.length ? this.queue[0] : null
  }

  /** 从队列移除（出队/取消） */
  remove(taskId) {
    const i = this.queue.indexOf(taskId)
    if (i >= 0) this.queue.splice(i, 1)
    return i >= 0
  }

  queueLength() {
    return this.queue.length
  }

  /** 队首位置（1-based，0 = 不在队列） */
  queuePosition(taskId) {
    const i = this.queue.indexOf(taskId)
    return i < 0 ? 0 : i + 1
  }

  // ---------------- 单车道锁 ----------------

  tryAcquire(taskId) {
    if (this.gateLocked) return false
    this.gateLocked = true
    this.gateOwner = taskId
    this.gateAcquiredAt = this.now()
    return true
  }

  release(taskId = null) {
    if (taskId && this.gateOwner && this.gateOwner !== taskId) return false
    this.gateLocked = false
    this.gateOwner = null
    this.gateAcquiredAt = null
    return true
  }

  gateInfo() {
    return { locked: this.gateLocked, owner: this.gateOwner, acquiredAt: this.gateAcquiredAt || null }
  }

  // ---------------- 训练互斥 ----------------

  beginTraining(meta = {}) {
    if (this.training) return false
    this.training = true
    this.trainingMeta = meta
    this.trainingStartedAt = this.now()
    // 训练 = 全局独占：闸门锁给 'training'，任何生图都别想进来
    this.gateLocked = true
    this.gateOwner = 'training'
    return true
  }

  endTraining(reason = 'manual') {
    const was = this.training
    this.training = false
    this.trainingMeta = null
    this.trainingStartedAt = null
    if (this.gateOwner === 'training') {
      this.gateLocked = false
      this.gateOwner = null
    }
    return was
  }

  trainingInfo() {
    return {
      training: this.training,
      startedAt: this.trainingStartedAt,
      meta: this.trainingMeta,
    }
  }

  // ---------------- 汇总 / 崩溃恢复 ----------------

  summary() {
    const all = [...this.tasks.values()]
    return {
      training: this.training,
      gate: this.gateInfo(),
      queueLength: this.queue.length,
      queued: all.filter((t) => t.status === STATUS.QUEUED).length,
      running: all.filter((t) => t.status === STATUS.RUNNING || t.status === STATUS.TRAINING).length,
      success: all.filter((t) => t.status === STATUS.SUCCESS).length,
      failed: all.filter((t) => t.status === STATUS.FAILED).length,
      total: all.length,
    }
  }

  /** 落盘（供重启后释放残留锁 / 清理临时文件） */
  saveState() {
    if (!this.stateFile) return false
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
      const payload = {
        savedAt: this.now(),
        pid: process.pid,
        training: this.training,
        trainingMeta: this.trainingMeta,
        trainingStartedAt: this.trainingStartedAt,
        gate: this.gateInfo(),
        runningTasks: [...this.tasks.values()].filter((t) => !TERMINAL.has(t.status)).map((t) => ({ id: t.id, kind: t.kind, status: t.status, model: t.model })),
      }
      fs.writeFileSync(this.stateFile, JSON.stringify(payload, null, 2), 'utf8')
      return true
    } catch (e) {
      this.log?.('warn', 'state.save_failed', { file: this.stateFile, error: e })
      return false
    }
  }

  /** 读出上一次落盘的状态（不存在则返回 null） */
  loadState() {
    if (!this.stateFile) return null
    try {
      if (!fs.existsSync(this.stateFile)) return null
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
    } catch (e) {
      this.log?.('warn', 'state.load_failed', { file: this.stateFile, error: e })
      return null
    }
  }

  clearState() {
    if (!this.stateFile) return
    try { if (fs.existsSync(this.stateFile)) fs.unlinkSync(this.stateFile) } catch (e) {
      this.log?.('warn', 'state.clear_failed', { file: this.stateFile, error: e })
    }
  }
}

export { TERMINAL }