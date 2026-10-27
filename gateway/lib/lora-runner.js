/**
 * gateway/lib/lora-runner.js — 一键炼制的任务控制器（P4）
 *
 * 把 P1~P3 的零件接成一条真正能跑的链路，并负责"训练之外"的所有收尾：
 *   采集 → 标注 → 拆轨 → 命名 → 落盘 → 硬校验 → id/base 串行训练 → 产物投递 → 登记 → 刷新
 *
 * 三个刻意的设计：
 *   1. **训练日志不随临时目录消失**（TrainingManager 的 logDir），否则失败分类读不到原因；
 *   2. **超时要收回独占锁**：训练卡死时必须主动 stop，否则后续生图会一直被 409 拦住；
 *   3. **刷新失败不算炼制失败**：SD 没运行是常态，产物已落盘，SD 下次启动自然扫得到。
 *
 * 本模块不直接碰 spawn/python：训练通过 TrainingManager 执行，因此可注入假实现做离线回归。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'

import { prepareDatasets, runTracks, findArtifact, classifyTrainFailure, estimateTrainMinutes } from './lora-train.js'
import { buildRecord, upsertRecord, readRegistry, writeRegistry, deliverArtifact, refreshWebui, callSyntaxOf } from './lora-registry.js'

/** 单轨训练超时（默认 2 小时）：kohya 800 步 LoCon 在低端卡上也可能跑很久 */
export const DEFAULT_TRAIN_TIMEOUT_MS = 2 * 60 * 60 * 1000
export const DEFAULT_POLL_MS = 2000

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 把一段字节按「最可能是哪种编码」解码。
 *
 * 为什么需要：中文 Windows 上 Python 子进程默认按 GBK 写 stdout，日志是按字节落盘的。
 * 直接 buf.toString('utf8') 会得到「锟斤拷」（U+FFFD 替换字符，**不可逆**，原始信息已丢）。
 * 所以这里优先严格 UTF-8 解码，失败再按 GBK 解 —— 两边都试过才落到 lossy 的 UTF-8。
 * （网关已给训练进程注入 PYTHONIOENCODING=utf-8，新日志不会再走 GBK 分支，
 *  但历史日志和「用户自己跑 kohya」的场景仍然需要这个兜底。）
 */
export function decodeLogBuffer(buf) {
  if (!buf || !buf.length) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch { /* 不是合法 UTF-8，继续试 GBK */ }
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch { /* 运行时不支持 gbk（极少数构建）：退回 lossy UTF-8 */ }
  return buf.toString('utf8')
}

/** 读文件尾部（失败原因几乎总在最后几十行里） */
export function readTail(file, maxBytes = 8192) {
  try {
    if (!file || !fs.existsSync(file)) return ''
    const st = fs.statSync(file)
    const start = Math.max(0, st.size - maxBytes)
    const fd = fs.openSync(file, 'r')
    try {
      const len = st.size - start
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, start)
      return decodeLogBuffer(buf)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

export class LoraTrainer {
  constructor({
    training = null,
    store = null,
    log = null,
    loraDir = null,
    registryFile = null,
    webuiUrl = 'http://127.0.0.1:7860',
    trainTimeoutMs = DEFAULT_TRAIN_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    refreshAfterDeliver = true,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    sleep = sleepDefault,
    prepare = prepareDatasets,
    runnerImpl = null,
  } = {}) {
    this.training = training
    this.store = store
    this.log = log
    this.loraDir = loraDir
    this.registryFile = registryFile
    this.webuiUrl = webuiUrl
    this.trainTimeoutMs = trainTimeoutMs
    this.pollMs = pollMs
    this.refreshAfterDeliver = refreshAfterDeliver
    this.fetchImpl = fetchImpl
    this.now = now
    this.sleep = sleep
    this.prepare = prepare
    this.runnerImpl = runnerImpl
  }

  /** 单轨执行器：提交训练 → 轮询终态 → 回收日志尾部与退出码 */
  async runTrack({ profile, args, outputName, outputDir }) {
    if (this.runnerImpl) {
      const rec = await this.runnerImpl(...arguments)
      return rec
    }
    if (!this.training || !this.store) {
      return { ok: false, error: '缺少训练执行器（TrainingManager / store 未注入）', exitCode: null }
    }
    const started = this.now()
    const r = this.training.start({ extraArgs: args, profile, meta: { kind: 'lora-track', outputName, outputDir } })
    if (!r.ok) {
      return { ok: false, error: r.error, code: r.code || null, exitCode: null, durationMs: this.now() - started }
    }
    const deadline = started + this.trainTimeoutMs
    while (this.now() < deadline) {
      await this.sleep(this.pollMs)
      const t = this.store.getTask(r.taskId)
      if (!t) continue
      if (t.status === 'success') {
        return {
          ok: true,
          exitCode: 0,
          taskId: r.taskId,
          pid: r.pid,
          logFile: r.logFile,
          durationMs: this.now() - started,
          progress: { percent: 100 },
        }
      }
      if (t.status === 'failed') {
        return {
          ok: false,
          exitCode: t.result && t.result.exitCode !== undefined ? t.result.exitCode : null,
          taskId: r.taskId,
          pid: r.pid,
          logFile: r.logFile,
          logTail: readTail(r.logFile),
          error: t.error || null,
          durationMs: this.now() - started,
        }
      }
    }
    // 超时：**必须**收回独占锁，否则后续生图会一直被 409 拦住
    let released = null
    try {
      released = await this.training.stop({ reason: `lora-train-timeout:${profile}` })
    } catch (e) {
      this.log?.('error', 'lora.timeout_stop_failed', { profile, error: e })
    }
    return {
      ok: false,
      exitCode: null,
      taskId: r.taskId,
      logFile: r.logFile,
      logTail: readTail(r.logFile),
      error: `单轨训练超过 ${Math.round(this.trainTimeoutMs / 60000)} 分钟未结束（已强制中止并释放独占锁）`,
      timedOut: true,
      released,
      durationMs: this.now() - started,
    }
  }

  /**
   * 跑完一整次一键炼制。
   * @param {object} o
   * @param {string} [o.taskId]  网关层面的 LoRA 任务 id（用于进度查询；不给就只返回结果）
   * @param {object} o.plan      lora-train.planTraining 的产物
   */
  async run({ taskId = null, plan, onProgress = null } = {}) {
    const errors = []
    const warnings = []
    const setStage = (stage, extra = {}) => {
      try { if (taskId && this.store) this.store.setStatus(taskId, stage, { result: { stage, ...extra } }) } catch { /* 进度上报失败不该中断炼制 */ }
      if (onProgress) { try { onProgress({ stage, ...extra }) } catch { /* 同上 */ } }
    }

    if (!plan || plan.ok === false) {
      const e = [...((plan && plan.errors) || ['计划无效'])]
      if (taskId && this.store) this.store.fail(taskId, 'LORA_PLAN_INVALID', e.join('; '))
      return { ok: false, errors: e, warnings, tracks: [], artifacts: [], refresh: null }
    }

    // ---- 数据准备（采集 / 标注 / 拆轨 / 落盘 / 硬校验）----
    setStage('collecting', { note: '采集素材并归一去重' })
    let prep
    try {
      prep = await this.prepare({ plan, onProgress: (p) => setStage(p && p.stage === 'caption' ? 'captioning' : 'collecting', p) })
    } catch (e) {
      const msg = `数据准备异常: ${(e && e.message) || e}`
      if (taskId && this.store) this.store.fail(taskId, 'LORA_PREPARE_FAILED', msg)
      return { ok: false, errors: [msg], warnings, tracks: [], artifacts: [], refresh: null }
    }
    errors.push(...prep.errors)
    warnings.push(...prep.warnings)
    if (prep.ok === false) {
      if (taskId && this.store) this.store.fail(taskId, 'LORA_DATASET_INVALID', errors.join('; ') || '数据集未通过硬校验')
      return { ok: false, errors, warnings, tracks: prep.tracks || [], artifacts: [], refresh: null, stage: 'prepare' }
    }

    // ---- 串行训练 ----
    setStage('training', { note: 'id → base 串行训练（训练期间生图被独占锁拦截）' })
    const run = await runTracks({
      plan,
      prepared: prep,
      runner: (opts) => this.runTrack(opts),
      onTrack: (ev) => setStage(ev.stage === 'end' ? 'training-track-end' : 'training-track-start', ev),
    })
    errors.push(...run.errors)
    if (run.ok === false) {
      if (taskId && this.store) this.store.fail(taskId, 'LORA_TRAIN_FAILED', errors.join('; '))
      return { ok: false, errors, warnings, tracks: prep.tracks, artifacts: [], refresh: null, results: run.results, stage: 'train' }
    }

    // ---- 投递 + 登记 + 刷新 ----
    setStage('delivering', { note: '投递产物到 LoRA 目录并登记' })
    const registryFile = this.registryFile
    const artifacts = []
    for (const track of prep.tracks) {
      const art = findArtifact({ outputDir: track.outputDir, expectedName: track.lora.name })
      if (art.ok === false) {
        errors.push(`${track.profile} 轨产物缺失: ${art.error}`)
        continue
      }
      const del = deliverArtifact({ file: art.file, loraDir: this.loraDir, name: track.lora.name })
      if (del.ok === false) {
        errors.push(`${track.profile} 轨投递失败: ${del.error}`)
        continue
      }
      const trackResult = (run.results || []).find((r) => r.profile === track.profile) || {}
      const record = buildRecord({
        track: track.profile,
        name: track.lora.name,
        file: del.target,
        bytes: del.bytes,
        steps: track.standard.max_train_steps,
        learningRate: track.standard.learning_rate,
        module: track.standard.network_module,
        networkArgs: track.standard.network_args,
        images: track.imageCount,
        durationMs: trackResult.durationMs || null,
        sources: (prep.collected && prep.collected.sources) || [],
        taskId: trackResult.taskId || null,
        exitCode: 0,
        extra: { callSyntaxExample: callSyntaxOf(track.lora.name, track.profile === 'id' ? 1.0 : 0.4), inferredWeightRange: track.profile === 'base' ? [0.3, 0.7] : [1.0, 1.0] },
      })
      artifacts.push({ ...record, delivered: del.copied ? 'copied' : 'already-there', target: del.target })
    }

    let registry = { file: registryFile, count: 0 }
    if (registryFile) {
      try {
        let reg = readRegistry({ file: registryFile })
        for (const a of artifacts) reg = upsertRecord({ registry: reg, record: a })
        const w = writeRegistry({ file: registryFile, registry: reg })
        if (w.ok === false) errors.push(`登记表写入失败: ${w.error}`)
        registry = { file: registryFile, count: (reg.loras || []).length, updatedAt: w.updatedAt || null }
      } catch (e) {
        errors.push(`登记表更新异常: ${(e && e.message) || e}`)
      }
    }

    let refresh = null
    if (this.refreshAfterDeliver) {
      refresh = await refreshWebui({ url: this.webuiUrl, fetchImpl: this.fetchImpl })
      if (refresh.ok === false) warnings.push(`LoRA 列表刷新未成功（${refresh.reason}）：${refresh.hint}`)
    }

    const ok = errors.length === 0 && artifacts.length === prep.tracks.length
    if (taskId && this.store) {
      const payload = {
        artifacts: artifacts.map((a) => ({ name: a.name, track: a.track, file: a.file, call: a.call, bytes: a.bytes })),
        registry,
        refresh,
        warnings,
        plan: { name: plan.naming && plan.naming.id ? plan.naming.id.name.replace(/_(id|base)$/, '') : null, estimate: plan.estimate },
      }
      if (ok) this.store.setStatus(taskId, 'success', { result: payload })
      else this.store.fail(taskId, 'LORA_DELIVER_INCOMPLETE', errors.join('; ') || '产物不完整', payload)
    }
    return { ok, errors, warnings, tracks: prep.tracks, artifacts, refresh, registry, results: run.results, estimate: plan.estimate }
  }
}

export default { DEFAULT_TRAIN_TIMEOUT_MS, DEFAULT_POLL_MS, readTail, LoraTrainer, estimateTrainMinutes }