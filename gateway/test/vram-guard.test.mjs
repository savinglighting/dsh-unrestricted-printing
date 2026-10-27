/**
 * gateway/test/vram-guard.test.mjs — 显存互斥（P5）
 *
 * 背景：8GB 卡上 8B 视觉模型占 5.1GB，SD 只剩 3GB → 出图必然超时。
 * 这里钉住三件事：能释放、释放失败不阻断、用量可读。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'

import { releaseVlmVram, releaseSdVram, vlmVramUsage, withVramReleased } from '../lib/vram-guard.js'

const logs = []
const log = (lv, ev, data) => logs.push({ lv, ev, data })

function mockOllama({ models = ['qwen3-vl:8b'], psOk = true, unloadOk = true } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init && init.body })
    if (url.endsWith('/api/ps')) {
      if (!psOk) return { ok: false, status: 500 }
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: models.map((name) => ({ name, size_vram: 5.1 * 1024 ** 3 })) }),
      }
    }
    if (url.endsWith('/api/generate')) {
      return { ok: unloadOk, status: unloadOk ? 200 : 500 }
    }
    return { ok: false, status: 404 }
  }
  return { fetchImpl, calls }
}

test('releaseVlmVram：逐个卸载常驻模型（keep_alive:0）', async () => {
  const { fetchImpl, calls } = mockOllama({ models: ['qwen3-vl:8b', 'qwen3.5:latest'] })
  const r = await releaseVlmVram({ fetchImpl, log })
  assert.equal(r.ok, true)
  assert.deepEqual(r.freed, ['qwen3-vl:8b', 'qwen3.5:latest'])
  assert.deepEqual(r.failed, [])
  const unloads = calls.filter((c) => c.url.endsWith('/api/generate'))
  assert.equal(unloads.length, 2)
  assert.ok(unloads.every((c) => String(c.body).includes('"keep_alive":0')), '必须带 keep_alive:0 才会真的卸载')
})

test('releaseVlmVram：Ollama 不在 / 卸载失败 都如实返回，不抛', async () => {
  const down = await releaseVlmVram({ fetchImpl: async () => { throw new Error('ECONNREFUSED') }, log })
  assert.equal(down.ok, false)
  assert.match(String(down.reason), /ECONNREFUSED/)

  const { fetchImpl } = mockOllama({ unloadOk: false })
  const partial = await releaseVlmVram({ fetchImpl, log })
  assert.equal(partial.ok, true, '/api/ps 通就算通')
  assert.deepEqual(partial.freed, [])
  assert.deepEqual(partial.failed, ['qwen3-vl:8b'])
})

test('vlmVramUsage：汇总占用 GB，用于日志与判断', async () => {
  const { fetchImpl } = mockOllama({ models: ['a', 'b'] })
  const u = await vlmVramUsage({ fetchImpl })
  assert.equal(u.ok, true)
  assert.equal(u.models.length, 2)
  assert.ok(u.totalGb > 9 && u.totalGb < 11, `两张各 5.1GB → 约 10.2GB，实际 ${u.totalGb}`)

  const down = await vlmVramUsage({ fetchImpl: async () => ({ ok: false, status: 500 }) })
  assert.equal(down.ok, false)
  assert.equal(down.totalGb, null)
})

test('releaseSdVram：两个端点都试，任一成功即算释放', async () => {
  const hits = []
  const fetchImpl = async (url) => {
    hits.push(url)
    return { ok: url.includes('unload-checkpoint'), status: url.includes('unload-checkpoint') ? 200 : 404 }
  }
  const r = await releaseSdVram({ fetchImpl, log })
  assert.equal(r.ok, true)
  assert.deepEqual(r.done, ['sdapi/v1/unload-checkpoint'])
  assert.equal(hits.length, 2, '两个端点都要尝试（不同版本 A1111 支持的端点不同）')

  const dead = await releaseSdVram({ fetchImpl: async () => { throw new Error('refused') }, log })
  assert.equal(dead.ok, false, 'SD 没运行不算故障，但如实报 ok:false')
})

test('withVramReleased：清理失败不阻断 work（这是硬要求）', async () => {
  const r = await withVramReleased({
    release: 'vlm',
    fetchImpl: async () => { throw new Error('ollama down') },
    work: async () => 'WORK-DONE',
  })
  assert.equal(r.result, 'WORK-DONE', '清理失败也必须把活干完')
  assert.ok(Array.isArray(r.vram.released))
})

test('withVramReleased：先读用量再释放，两侧都覆盖', async () => {
  const { fetchImpl } = mockOllama({ models: ['qwen3-vl:8b'] })
  const r = await withVramReleased({
    release: 'both',
    fetchImpl,
    work: () => 42,
  })
  assert.equal(r.result, 42)
  assert.equal(r.vram.before.ok, true)
  assert.equal(r.vram.before.totalGb > 5, true)
  assert.deepEqual(r.vram.released.map((x) => x.side), ['vlm', 'sd'])
})