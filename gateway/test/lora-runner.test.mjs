/**
 * gateway/test/lora-runner.test.mjs — 一键炼制任务控制器（P4）
 *
 * 控制器负责"训练之外"的全部收尾：投递 → 登记 → 刷新，以及超时回收独占锁。
 * 训练与数据准备都注入假实现，所以这里不需要 GPU、不需要 kohya、不需要 SD。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LoraTrainer, readTail, decodeLogBuffer, DEFAULT_TRAIN_TIMEOUT_MS } from '../lib/lora-runner.js'
import { planTraining } from '../lib/lora-train.js'
import { readRegistry } from '../lib/lora-registry.js'

/** 假底模：训练计划要求 --pretrained_model_name_or_path 指向真实存在的文件 */
const FAKE_BASE_MODEL = (() => {
  const dir = path.join(os.tmpdir(), 'lora-runner-test', 'base-model')
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'AWPainting_v1.2.safetensors')
  if (!fs.existsSync(f)) fs.writeFileSync(f, 'fake')
  return f
})()

let seq = 0
function tmp(tag) {
  const dir = path.join(os.tmpdir(), 'lora-runner-test', `${tag}-${process.pid}-${++seq}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 最小 store 替身：只实现控制器用到的四个方法 */
function fakeStore() {
  const tasks = new Map()
  let n = 0
  return {
    tasks,
    createTask({ kind = 'lora-train', model = null, engine = null, payload = {} } = {}) {
      const t = { id: `task-${++n}`, kind, model, engine, payload, status: 'queued', result: null, error: null, error_code: null }
      tasks.set(t.id, t)
      return t
    },
    getTask(id) { return tasks.get(id) || null },
    setStatus(id, status, extra = {}) {
      const t = tasks.get(id)
      if (!t) return false
      t.status = status
      t.result = { ...(t.result || {}), ...((extra && extra.result) || {}) }
      return true
    },
    fail(id, code, message, extra = {}) {
      const t = tasks.get(id)
      if (!t) return false
      t.status = 'failed'
      t.error_code = code
      t.error = message
      t.result = { ...(t.result || {}), ...(extra || {}) }
      return true
    },
  }
}

/** 假的数据准备：直接给出两轨（不真的采集/标注） */
function fakePrepare(plan) {
  return async () => ({
    ok: true,
    errors: [],
    warnings: ['假准备：跳过了采集与标注'],
    collected: { sources: [{ input: 'D:\\raw', kind: 'local-dir', files: 40 }] },
    tracks: plan.tracks.map((t) => ({ ...t, imageCount: 20, datasetStats: { images: 20 }, datasetConfig: {} })),
  })
}

function makeTrainer(extra = {}) {
  const store = fakeStore()
  const loraDir = tmp('lora')
  const registryFile = path.join(tmp('reg'), 'lora-registry.json')
  const trainer = new LoraTrainer({
    store,
    loraDir,
    registryFile,
    log: null,
    refreshAfterDeliver: true,
    fetchImpl: async () => ({ ok: true, status: 200 }),
    prepare: null, // 每个测试自己注入
    ...extra,
  })
  return { trainer, store, loraDir, registryFile }
}

test('整链成功：两轨产物投递 + 登记 + 刷新，任务终态 success', async () => {
  const root = tmp('ok')
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL,  sources: ['D:\\raw'], name: 'aili', datasetRoot: path.join(root, 'ds') })
  const { trainer, store, loraDir, registryFile } = makeTrainer({ prepare: fakePrepare(plan) })
  trainer.runnerImpl = async ({ outputDir, outputName }) => {
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(path.join(outputDir, `${outputName}.safetensors`), Buffer.from(`w-${outputName}`))
    return { ok: true, exitCode: 0, taskId: `inner-${outputName}`, durationMs: 600000 }
  }

  const task = store.createTask({ kind: 'lora-train' })
  const r = await trainer.run({ taskId: task.id, plan })

  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.artifacts.length, 2)
  assert.deepEqual(r.artifacts.map((a) => a.name), ['aili_id', 'aili_base'])
  assert.equal(r.artifacts[0].call, '<lora:aili_id:WEIGHT>')
  for (const a of r.artifacts) {
    assert.equal(fs.existsSync(path.join(loraDir, `${a.name}.safetensors`)), true, `产物必须进 LoRA 目录: ${a.name}`)
  }
  assert.equal(r.refresh.ok, true)

  const reg = readRegistry({ file: registryFile })
  assert.equal(reg.loras.length, 2)
  const idRec = reg.loras.find((x) => x.name === 'aili_id')
  assert.equal(idRec.networkDim, 8)
  assert.equal(idRec.module, 'networks.lora')
  assert.equal(idRec.images, 20)
  assert.equal(idRec.durationMs, 600000)
  assert.equal(reg.loras.find((x) => x.name === 'aili_base').networkDim, 32)

  assert.equal(store.getTask(task.id).status, 'success')
  assert.equal(store.getTask(task.id).result.artifacts.length, 2)
  assert.equal(store.getTask(task.id).result.registry.count, 2)
})

test('刷新失败不算炼制失败：产物已落盘，只降级成警告', async () => {
  const root = tmp('refresh-fail')
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL,  sources: ['D:\\raw'], name: 'aili', datasetRoot: path.join(root, 'ds') })
  const { trainer, store, loraDir } = makeTrainer({
    prepare: fakePrepare(plan),
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  trainer.runnerImpl = async ({ outputDir, outputName }) => {
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(path.join(outputDir, `${outputName}.safetensors`), 'w')
    return { ok: true, exitCode: 0 }
  }
  const task = store.createTask({ kind: 'lora-train' })
  const r = await trainer.run({ taskId: task.id, plan })
  assert.equal(r.ok, true)
  assert.equal(r.refresh.ok, false)
  assert.ok(r.warnings.some((w) => w.includes('刷新未成功')), JSON.stringify(r.warnings))
  assert.equal(store.getTask(task.id).status, 'success', '刷新失败不该把炼制判成失败')
  assert.equal(fs.existsSync(path.join(loraDir, 'aili_id.safetensors')), true)
})

test('投递冲突（同名不同体积）→ 如实报错并让任务 failed（绝不覆盖别人的 LoRA）', async () => {
  const root = tmp('conflict')
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL,  sources: ['D:\\raw'], name: 'aili', datasetRoot: path.join(root, 'ds') })
  const { trainer, store, loraDir } = makeTrainer({ prepare: fakePrepare(plan) })
  fs.writeFileSync(path.join(loraDir, 'aili_id.safetensors'), 'someones-longer-existing-lora')
  trainer.runnerImpl = async ({ outputDir, outputName }) => {
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(path.join(outputDir, `${outputName}.safetensors`), 'w')
    return { ok: true, exitCode: 0 }
  }
  const task = store.createTask({ kind: 'lora-train' })
  const r = await trainer.run({ taskId: task.id, plan })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('投递失败')), JSON.stringify(r.errors))
  assert.match(fs.readFileSync(path.join(loraDir, 'aili_id.safetensors'), 'utf8'), /^someones/, '已有文件不得被覆盖')
  assert.equal(store.getTask(task.id).status, 'failed')
})

test('数据准备失败 → 任务 failed，且不进入训练阶段', async () => {
  const root = tmp('prep-fail')
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL,  sources: ['D:\\raw'], name: 'aili', datasetRoot: path.join(root, 'ds') })
  const { trainer, store } = makeTrainer({
    prepare: async () => ({ ok: false, errors: ['ID 轨素材只有 3 张（下限 15）'], warnings: [], tracks: [] }),
  })
  let runnerCalled = false
  trainer.runnerImpl = async () => { runnerCalled = true; return { ok: true } }
  const task = store.createTask({ kind: 'lora-train' })
  const r = await trainer.run({ taskId: task.id, plan })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('素材只有')))
  assert.equal(runnerCalled, false, '数据集不通过就不能开训')
  assert.equal(store.getTask(task.id).status, 'failed')
  assert.equal(store.getTask(task.id).error_code, 'LORA_DATASET_INVALID')
})

test('训练失败（OOM）→ 任务 failed 且带上分类原因，不做投递', async () => {
  const root = tmp('track-fail')
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL,  sources: ['D:\\raw'], name: 'aili', datasetRoot: path.join(root, 'ds') })
  const { trainer, store, loraDir } = makeTrainer({ prepare: fakePrepare(plan) })
  trainer.runnerImpl = async () => ({ ok: false, exitCode: 1, logTail: 'RuntimeError: CUDA out of memory' })
  const task = store.createTask({ kind: 'lora-train' })
  const r = await trainer.run({ taskId: task.id, plan })
  assert.equal(r.ok, false)
  assert.equal(r.results[0].failure.code, 'TRAIN_OOM')
  assert.equal(r.artifacts.length, 0)
  assert.equal(fs.readdirSync(loraDir).length, 0, '训练失败不得投递半成品')
  assert.equal(store.getTask(task.id).status, 'failed')
})

test('单轨超时 → 强制中止并收回独占锁（否则后续生图一直被 409 拦住）', async () => {
  const stops = []
  const training = {
    start() { return { ok: true, taskId: 'inner-1', pid: 999, logFile: null } },
    async stop(opts) { stops.push(opts); return { ok: true, released: true } },
  }
  const store = fakeStore()
  const inner = store.createTask({ kind: 'training' })
  store.setStatus(inner.id, 'training')
  const nowValues = [0, 10, 20, 30, 40, 50]
  let i = 0
  const trainer = new LoraTrainer({
    training,
    store,
    log: null,
    trainTimeoutMs: 25,
    pollMs: 1,
    now: () => nowValues[Math.min(i++, nowValues.length - 1)],
    sleep: async () => {},
  })
  // 让 training.start 返回 store 里那条永远 training 态的任务
  training.start = () => ({ ok: true, taskId: inner.id, pid: 999, logFile: null })

  const r = await trainer.runTrack({ profile: 'id', args: [], outputName: 'aili_id', outputDir: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true)
  assert.equal(stops.length, 1, '超时必须调用 stop 释放锁')
  assert.match(r.error, /已强制中止并释放独占锁/)
  assert.match(String(stops[0].reason), /timeout/)
})

test('runTrack：训练器缺失 / 提交失败都如实回传（不返回假成功）', async () => {
  const trainer = new LoraTrainer({})
  const a = await trainer.runTrack({ profile: 'id', args: [] })
  assert.equal(a.ok, false)
  assert.match(a.error, /缺少训练执行器/)

  const store = fakeStore()
  const trainer2 = new LoraTrainer({ training: { start: () => ({ ok: false, error: '已有训练在进行', code: 'TRAINING_ALREADY_ACTIVE' }) }, store })
  const b = await trainer2.runTrack({ profile: 'id', args: [] })
  assert.equal(b.ok, false)
  assert.equal(b.code, 'TRAINING_ALREADY_ACTIVE')
})

test('run：计划无效 → 直接失败，不做任何准备动作', async () => {
  const { trainer, store } = makeTrainer({})
  let prepared = false
  trainer.prepare = async () => { prepared = true; return { ok: true, tracks: [] } }
  const r = await trainer.run({ plan: { ok: false, errors: ['没有给任何来源'] } })
  assert.equal(r.ok, false)
  assert.equal(prepared, false)
  assert.ok(r.errors.some((e) => e.includes('没有给任何来源')))
})

test('readTail：读日志尾部（失败原因几乎总在最后几行），坏路径不抛', () => {
  const dir = tmp('tail')
  const f = path.join(dir, 'train.log')
  fs.writeFileSync(f, `${'x'.repeat(20000)}\nRuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB\n`)
  const tail = readTail(f, 512)
  assert.ok(tail.includes('CUDA out of memory'))
  assert.ok(tail.length <= 512)
  assert.equal(readTail(path.join(dir, 'nope.log')), '')
  assert.equal(readTail(null), '')
  assert.equal(DEFAULT_TRAIN_TIMEOUT_MS, 2 * 60 * 60 * 1000)
})

test('decodeLogBuffer：GBK 日志不得变成「锟斤拷」（中文 Windows 的 kohya 输出）', () => {
  // UTF-8 正常解
  assert.equal(decodeLogBuffer(Buffer.from('steps: 50% 进度', 'utf8')), 'steps: 50% 进度')

  // 用已知的 GBK 字节序列构造（Node 的 Buffer 没有 GBK 编码器）：
  // '训练' = 0xD1 0xB5 0xC1 0xB7；按 UTF-8 解会得到替换字符，必须自动回退到 GBK
  const raw = Buffer.concat([Buffer.from('steps: 100% ', 'ascii'), Buffer.from([0xd1, 0xb5, 0xc1, 0xb7])])
  const decoded = decodeLogBuffer(raw)
  assert.equal(decoded, 'steps: 100% 训练', `GBK 必须能正确还原，实际得到: ${decoded}`)
  assert.ok(!decoded.includes('\uFFFD'), '不得出现替换字符（那意味着信息已不可逆丢失）')
  assert.ok(!decoded.includes('锟'), '不得出现「锟斤拷」乱码')

  assert.equal(decodeLogBuffer(Buffer.alloc(0)), '')
  assert.equal(decodeLogBuffer(null), '')
})

test('readTail：GBK 日志文件读出来是可读中文，不是乱码', () => {
  const dir = tmp('tail-gbk')
  const f = path.join(dir, 'kohya.log')
  // 模拟 kohya 在中文 Windows 下的输出：ASCII 部分 + GBK 中文
  const head = Buffer.from('epoch 1/1\nsteps: 100% ', 'ascii')
  const gbkCn = Buffer.from([0xd1, 0xb5, 0xc1, 0xb7]) // 训练
  const tailPart = Buffer.from(' 60/60 [00:32<00:00, 1.85it/s]\n', 'ascii')
  fs.writeFileSync(f, Buffer.concat([head, gbkCn, tailPart]))
  const text = readTail(f, 4096)
  assert.ok(text.includes('训练'), `应还原出中文，实际: ${text}`)
  assert.ok(!text.includes('锟'), '不得出现锟斤拷')
  assert.ok(text.includes('60/60'), 'ASCII 部分必须完好')
})