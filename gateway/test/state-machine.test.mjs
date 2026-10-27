/**
 * P1 任务表 + 状态机（含失败可查询、非法迁移不改状态、上限裁剪）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { TaskStore, STATUS } from '../lib/store.js'
import { makeTempDir } from './helpers/harness.mjs'

function newStore(opts = {}) {
  const logs = []
  const log = (lv, ev, data) => logs.push({ lv, ev, data })
  const store = new TaskStore({ log, stateFile: opts.stateFile || null })
  return { store, logs }
}

test('状态机：queued → running → success', () => {
  const { store } = newStore()
  const t = store.createTask({ kind: 'image', model: 'SD_FP16', engine: 'webui', payload: {} })
  assert.equal(t.status, STATUS.QUEUED)
  assert.equal(store.queueLength(), 1)
  assert.equal(store.setStatus(t.id, STATUS.RUNNING), true)
  assert.equal(store.getTask(t.id).startedAt > 0, true)
  assert.equal(store.setStatus(t.id, STATUS.SUCCESS, { result: { paths: ['a.png'] } }), true)
  const done = store.getTask(t.id)
  assert.equal(done.status, 'success')
  assert.equal(done.finishedAt > 0, true)
  assert.deepEqual(done.result.paths, ['a.png'])
})

test('状态机：非法迁移被拒且不改状态（并记 warn，不静默）', () => {
  const { store, logs } = newStore()
  const t = store.createTask({ kind: 'image', model: 'SD_FP16', engine: 'webui', payload: {} })
  assert.equal(store.setStatus(t.id, STATUS.SUCCESS), false, 'queued 不能直接 success')
  assert.equal(store.getTask(t.id).status, 'queued')
  assert.equal(logs.filter((l) => l.ev === 'task.illegal_transition').length, 1)
  store.setStatus(t.id, STATUS.RUNNING)
  store.setStatus(t.id, STATUS.SUCCESS)
  assert.equal(store.setStatus(t.id, STATUS.RUNNING), false, '终态不可复活')
  assert.equal(store.getTask(t.id).status, 'success')
})

test('状态机：training 状态在状态机里可见且可终结', () => {
  const { store } = newStore()
  const t = store.createTask({ kind: 'training', engine: 'trainer', payload: {} })
  assert.equal(store.setStatus(t.id, STATUS.TRAINING), true)
  assert.equal(store.getTask(t.id).status, 'training')
  assert.equal(store.setStatus(t.id, STATUS.SUCCESS), true)
})

test('失败可查询：fail() 同时写 error 与 error_code', () => {
  const { store } = newStore()
  const t = store.createTask({ kind: 'image', model: 'Krea2_Q4', engine: 'comfy', payload: {} })
  store.setStatus(t.id, STATUS.RUNNING)
  store.fail(t.id, 'SIZE_NOT_ALLOWED', 'Krea2_Q4 宽/高不得超过 1024（收到 1216x1024）')
  const got = store.getTask(t.id)
  assert.equal(got.status, 'failed')
  assert.equal(got.errorCode, 'SIZE_NOT_ALLOWED')
  assert.match(got.error, /1024/)
})

test('未知任务：setStatus 返回 false 并记 warn', () => {
  const { store, logs } = newStore()
  assert.equal(store.setStatus('nope', STATUS.RUNNING), false)
  assert.equal(logs.filter((l) => l.ev === 'task.not_found').length, 1)
})

test('单车道锁：抢不到不失败，可释放；release 校验 owner', () => {
  const { store } = newStore()
  const a = store.createTask({ kind: 'image', model: 'SD_FP16', engine: 'webui', payload: {} })
  const b = store.createTask({ kind: 'image', model: 'SD_FP16', engine: 'webui', payload: {} })
  assert.equal(store.tryAcquire(a.id), true)
  assert.equal(store.tryAcquire(b.id), false, '锁被占时第二次抢锁必须失败（排队）')
  assert.equal(store.release(b.id), false, 'B 不能释放 A 的锁')
  assert.equal(store.gateInfo().owner, a.id)
  assert.equal(store.release(a.id), true)
  assert.equal(store.tryAcquire(b.id), true)
})

test('训练互斥：beginTraining 独占闸门，endTraining 释放', () => {
  const { store } = newStore()
  const a = store.createTask({ kind: 'image', model: 'SD_FP16', engine: 'webui', payload: {} })
  assert.equal(store.beginTraining({ taskId: a.id }), true)
  assert.equal(store.training, true)
  assert.equal(store.gateInfo().owner, 'training')
  assert.equal(store.tryAcquire(a.id), false, '训练独占时生图抢不到锁')
  assert.equal(store.beginTraining({}), false, '重复开始训练被拒')
  assert.equal(store.endTraining('test'), true)
  assert.equal(store.training, false)
  assert.equal(store.gateInfo().locked, false)
  assert.equal(store.tryAcquire(a.id), true)
})

test('队列：FIFO 顺序 + 位置 + 移除', () => {
  const { store } = newStore()
  const ids = ['a', 'b', 'c'].map((n) => store.createTask({ kind: 'image', model: 'SD_FP16', payload: {}, id: `id-${n}` }).id)
  assert.equal(store.peek(), ids[0])
  assert.equal(store.queuePosition(ids[2]), 3)
  store.remove(ids[0])
  assert.equal(store.peek(), ids[1])
  assert.equal(store.queuePosition(ids[0]), 0)
})

test('历史裁剪：超过上限时先丢终态任务（排队中的任务绝不被裁掉）', () => {
  const { store } = newStore()
  store.historyLimit = 5
  const done = store.createTask({ kind: 'image', model: 'SD_FP16', payload: {} })
  store.setStatus(done.id, STATUS.RUNNING)
  store.setStatus(done.id, STATUS.SUCCESS)
  store.remove(done.id) // 真实流程里 worker 跑完会把它移出队列
  const live = []
  for (let i = 0; i < 8; i++) live.push(store.createTask({ kind: 'image', model: 'SD_FP16', payload: {} }).id)
  assert.equal(store.getTask(done.id), null, '终态任务应最先被裁掉')
  assert.equal(store.queueLength(), 8, '排队中的任务不得被裁掉（否则用户任务凭空消失）')
  for (const id of live) assert.ok(store.getTask(id), '排队中任务必须在表里')
})

test('状态落盘/读取：训练锁可被重启后的网关读到（崩溃恢复依据）', () => {
  const dir = makeTempDir('state')
  const stateFile = path.join(dir, 'state.json')
  const { store } = newStore({ stateFile })
  const t = store.createTask({ kind: 'training', engine: 'trainer', payload: {} })
  store.beginTraining({ taskId: t.id, pid: 999999, tempDir: path.join(dir, 'gateway-train-x') })
  assert.equal(store.saveState(), true)
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(raw.training, true)
  assert.equal(raw.trainingMeta.pid, 999999)

  const { store: store2 } = newStore({ stateFile })
  const loaded = store2.loadState()
  assert.equal(loaded.training, true)
  assert.equal(store2.clearState(), undefined)
  assert.equal(fs.existsSync(stateFile), false)
  fs.rmSync(dir, { recursive: true, force: true })
})