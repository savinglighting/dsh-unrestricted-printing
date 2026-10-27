/**
 * gateway/test/lora-api.test.mjs — 一键炼制的网关 API 面（P4）
 *
 * 覆盖插件层真正会调的东西：计划预览、提交、进度、中止、LoRA 清单、刷新、语法查询。
 * 真正的 kohya 训练不在测试里跑（那要 GPU 与权重），但失败路径必须走通并留下可读原因。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { startTestGateway, post, get, rmrf } from './helpers/harness.mjs'

async function waitTask(base, id, { timeoutMs = 15000, want = null } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const r = await get(base, `/api/status/${id}`)
    last = r.json
    if (want ? want.includes(last.status) : ['success', 'failed'].includes(last.status)) return last
    await new Promise((r2) => setTimeout(r2, 200))
  }
  return last
}

test('计划预览：给出双轨标准参数、自定义命名、耗时估算，并明确"只是预览"', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })

  const r = await post(gw.base, '/api/lora/plan', { sources: ['D:\\素材\\角色A'], name: 'aili' })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.naming.id.name, 'aili_id')
  assert.equal(r.json.naming.base.name, 'aili_base')
  assert.equal(r.json.tracks.length, 2)
  const [id, base] = r.json.tracks
  assert.equal(id.standard.network_dim, 8)
  assert.equal(id.lora.callSyntax, '<lora:aili_id:WEIGHT>')
  assert.equal(base.standard.network_module, 'lycoris.kohya')
  assert.equal(base.standard.network_dim, 32)
  assert.equal(r.json.estimate.minutes[0] > 0, true)
  assert.ok(r.json.lora_dir, '必须回传 LoRA 投递目录')
  assert.match(r.json.note, /不会下载、不会落盘、不会训练/)
  // 预览不得落盘
  assert.equal(fs.existsSync(path.join(gw.tmpRoot, 'lora-train', 'datasets', 'aili_id')), false)
})

test('计划预览：已有同名产物 → 命名自动版本化（不覆盖别人的 LoRA）', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const loraDir = path.join(gw.tmpRoot, 'models', 'Lora')
  fs.mkdirSync(loraDir, { recursive: true })
  fs.writeFileSync(path.join(loraDir, 'aili_id.safetensors'), 'existing')

  const r = await post(gw.base, '/api/lora/plan', { sources: ['D:\\素材'], name: 'aili' })
  assert.equal(r.json.naming.id.name, 'aili_id_v2')
  assert.equal(r.json.naming.base.name, 'aili_base')
  assert.ok(r.json.warnings.some((w) => w.includes('已存在')))
})

test('计划预览：缺来源 / 未知档位 → 400 且带可执行原因', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const noSrc = await post(gw.base, '/api/lora/plan', { name: 'x' })
  assert.equal(noSrc.status, 400)
  assert.ok(noSrc.json.errors.some((e) => e.includes('没有给任何来源')))

  const badTracks = await post(gw.base, '/api/lora/plan', { sources: ['D:\\x'], tracks: ['nope'] })
  assert.equal(badTracks.status, 400)
})

test('提交炼制：来源不可用 → 任务如实落到 failed（不会假装成功）', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const sub = await post(gw.base, '/api/lora/train', { sources: [path.join(gw.tmpRoot, 'not-here')], name: 'aili' })
  assert.equal(sub.status, 202)
  assert.equal(sub.json.status, 'queued')
  assert.ok(sub.json.task_id)
  assert.equal(sub.json.tracks.length, 2)
  assert.equal(sub.json.tracks[0].profile, 'id')
  assert.equal(sub.json.tracks[0].file, 'aili_id.safetensors')

  const done = await waitTask(gw.base, sub.json.task_id)
  assert.equal(done.status, 'failed')
  assert.equal(done.error_code, 'LORA_DATASET_INVALID')
  assert.ok(String(done.error).length > 0, '失败必须带原因')
})

test('提交炼制：计划无效 → 400，不创建任务', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const r = await post(gw.base, '/api/lora/train', {})
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'LORA_PLAN_INVALID')
})

test('中止不存在的任务 → 404；查询不存在的任务 → 404', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const s = await post(gw.base, '/api/lora/train/nope/stop', {})
  assert.equal(s.status, 404)
  const q = await get(gw.base, '/api/lora/train/nope')
  assert.equal(q.status, 404)
})

test('LoRA 清单：登记表 + 磁盘合并（含未登记项与丢失项标记）', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const loraDir = path.join(gw.tmpRoot, 'models', 'Lora')
  fs.mkdirSync(loraDir, { recursive: true })
  fs.writeFileSync(path.join(loraDir, 'aili_id.safetensors'), 'w')
  fs.writeFileSync(path.join(loraDir, 'loose_lora.safetensors'), 'w2')
  const regFile = path.join(gw.tmpRoot, 'lora-train', 'lora-registry.json')
  fs.mkdirSync(path.dirname(regFile), { recursive: true })
  fs.writeFileSync(regFile, JSON.stringify({
    version: 1,
    loras: [
      { name: 'aili_id', track: 'id', role: 'identity', networkDim: 8, steps: 500, call: '<lora:aili_id:WEIGHT>' },
      { name: 'ghost_base', track: 'base', role: 'style', networkDim: 32, steps: 800 },
    ],
  }))

  const r = await get(gw.base, '/api/lora/list')
  assert.equal(r.status, 200)
  const byName = Object.fromEntries(r.json.rows.map((x) => [x.name, x]))
  assert.equal(byName.aili_id.onDisk, true)
  assert.equal(byName.ghost_base.missing, true, '登记表有、磁盘没有 → 标记丢失')
  assert.equal(byName.loose_lora.untracked, true, '磁盘有、登记表没有 → 标记未登记')
  assert.equal(byName.loose_lora.call, '<lora:loose_lora:WEIGHT>')
  assert.ok(r.json.profile_weights.some((p) => p.profile === 'base' && p.infer_weight.max === 0.7))
})

test('刷新接口：即便刷新不成功也返回可用信息（产物已落盘）', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const r = await post(gw.base, '/api/lora/refresh', {})
  assert.equal(r.status, 200)
  assert.equal(typeof r.json.ok, 'boolean')
  assert.ok(r.json.note, '必须说明刷新失败不等于产物丢失')
})

test('语法查询接口：按名字与权重给出可直接用的 <lora:...> 片段', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const a = await get(gw.base, '/api/lora/syntax?name=aili_id')
  assert.deepEqual(a.json, { name: 'aili_id', call: '<lora:aili_id:WEIGHT>' })
  const b = await get(gw.base, '/api/lora/syntax?name=aili_base&weight=0.4')
  assert.equal(b.json.call, '<lora:aili_base:0.4>')
})