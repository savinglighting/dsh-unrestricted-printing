/**
 * gateway/test/caption.test.mjs — 自动标注（P3/P5）
 *
 * 钉住本机实测出来的四条坑（都是踩过的）：
 *   ① 推理型模型必须给足 token 预算，否则 thinking 吃光预算、正文为空；
 *   ② done_reason=load（模型刚加载）不是失败，要重试；
 *   ③ 批量前必须预热，否则开头几张必空返；
 *   ④ 模型输出不可信，一律再净化一遍。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildCaptionPrompt,
  mimeOf,
  callVision,
  captionImage,
  captionBatch,
  warmupVlm,
  readSidecarCaptions,
  placeholderCaption,
  DEFAULT_MAX_TOKENS,
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  PROFILE_FOCUS,
} from '../lib/caption.js'

let seq = 0
function tmp(tag) {
  const dir = path.join(os.tmpdir(), 'caption-test', `${tag}-${process.pid}-${++seq}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function png(fill = 0x55) {
  const b = Buffer.alloc(33, fill)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(512, 16)
  b.writeUInt32BE(768, 20)
  return b
}

/** 模拟 Ollama 原生端点 */
function nativeMock({ content = 'woman, dress, garden, sunlight', doneReason = 'stop', status = 200 } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init && init.body })
    if (!url.includes('/api/chat') && !url.includes('/api/generate')) return { ok: false, status: 404 }
    return {
      ok: status === 200,
      status,
      json: async () => ({ message: { role: 'assistant', content }, done_reason: doneReason }),
    }
  }
  return { fetchImpl, calls }
}

test('默认参数来自实测：预算给足、串行、超时够长', () => {
  assert.ok(DEFAULT_MAX_TOKENS >= 900, `token 预算必须给足（当前 ${DEFAULT_MAX_TOKENS}）；给小了 thinking 吃光预算、正文为空`)
  assert.equal(DEFAULT_CONCURRENCY, 1, '并发是负优化（实测 4 路 20 分钟跑不完 23 张）')
  assert.ok(DEFAULT_TIMEOUT_MS >= 180000, '推理型模型单张 53–136 秒，超时不能低于 3 分钟')
})

test('buildCaptionPrompt：铁律进指令 + 强约束（立即以标签开头）', () => {
  const p = buildCaptionPrompt({ profile: 'id', bannedTokens: ['Alice', 'SomeGame'], extraTags: ['silver hair'] })
  assert.ok(p.includes('Start your reply with the tags immediately'), '要强制立即输出，减少思考链长度')
  assert.ok(p.includes('No thinking'), '明确禁止思考')
  assert.ok(p.includes('Never output character names'), '禁角色名')
  assert.ok(p.includes('<lora:>'), '禁 lora 语法')
  assert.ok(p.includes('Alice') && p.includes('SomeGame'), '禁用词要写进提示')
  assert.ok(p.includes('silver hair'), '用户指定标签要写进提示')
  assert.ok(p.includes(PROFILE_FOCUS.id), 'ID 轨侧重必须在')

  const b = buildCaptionPrompt({ profile: 'base' })
  assert.ok(b.includes(PROFILE_FOCUS.base))
  assert.ok(b.includes('outfit'), 'Base 轨要侧重服装场景')
})

test('callVision：正常出内容；done_reason=load 会自动重试而不是判失败', async () => {
  const dir = tmp('cv')
  const file = path.join(dir, 'a.png')
  fs.writeFileSync(file, png())

  const ok = await callVision({ imagePath: file, user: 'tags', fetchImpl: nativeMock().fetchImpl })
  assert.equal(ok.ok, true)
  assert.equal(ok.endpoint, 'ollama-native')
  assert.equal(ok.text, 'woman, dress, garden, sunlight')

  // 第一次返回 done_reason=load（空内容），第二次正常 —— 必须能救回来
  let n = 0
  const loadThenOk = async (url, init) => {
    if (!String(url).includes('/api/chat')) return { ok: false, status: 404 }
    n++
    const first = n === 1
    return {
      ok: true,
      status: 200,
      json: async () => ({
        message: { content: first ? '' : 'woman, garden, sunlight' },
        done_reason: first ? 'load' : 'stop',
      }),
    }
  }
  const retried = await callVision({ imagePath: file, user: 'tags', fetchImpl: loadThenOk })
  assert.equal(retried.ok, true, 'done_reason=load 必须重试而不是直接失败')
  assert.equal(retried.text, 'woman, garden, sunlight')
  assert.equal(retried.attempts, 2)

  const missing = await callVision({ imagePath: path.join(dir, 'nope.png'), user: 'x', fetchImpl: nativeMock().fetchImpl })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /不存在/)
})

test('callVision：两个端点都失败时，错误信息要能定位（含 done_reason）', async () => {
  const dir = tmp('cv2')
  const file = path.join(dir, 'a.png')
  fs.writeFileSync(file, png())
  const alwaysEmpty = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ message: { content: '' }, done_reason: 'length', choices: [{ message: { content: '' } }] }),
  })
  const r = await callVision({ imagePath: file, user: 'tags', fetchImpl: alwaysEmpty })
  assert.equal(r.ok, false)
  assert.match(r.error, /done_reason=length/, '错误里必须带 done_reason，便于判断是不是预算问题')
  assert.match(r.error, /兼容端点/)
})

test('captionImage：出标注并净化掉身份类内容', async () => {
  const dir = tmp('ci')
  const file = path.join(dir, 'a.png')
  fs.writeFileSync(file, png())
  const r = await captionImage({
    imagePath: file,
    profile: 'id',
    bannedTokens: ['Alice'],
    fetchImpl: nativeMock({ content: 'Alice, woman, <lora:x:1>, dress, sunlight' }).fetchImpl,
  })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'woman, dress, sunlight', '角色名与 lora 语法必须被净化掉')
  assert.ok(r.removed.length >= 2)
})

test('captionBatch：批量前自动预热（否则开头几张必空返）', async () => {
  const dir = tmp('batch')
  const files = ['a', 'b'].map((n, i) => {
    const f = path.join(dir, `${n}.png`)
    fs.writeFileSync(f, png(i + 1))
    return f
  })
  const warmups = []
  const r = await captionBatch({
    images: files,
    concurrency: 1,
    warmupFn: async () => { warmups.push(1); return { ok: true, doneReason: 'length' } },
    fetchImpl: nativeMock().fetchImpl,
  })
  assert.equal(warmups.length, 1, '批量前必须预热一次')
  assert.equal(r.ok, true)
  assert.equal(Object.keys(r.captions).length, 2)
  assert.equal(r.warmup.ok, true)
})

test('captionBatch：失败的图记账、不糊兜底文本；空列表不算成功', async () => {
  const dir = tmp('batch2')
  const f = path.join(dir, 'a.png')
  fs.writeFileSync(f, png())
  const fail = async () => ({ ok: false, status: 500 })
  const r = await captionBatch({ images: [f], concurrency: 1, warmup: false, fetchImpl: fail })
  assert.equal(r.ok, false)
  assert.equal(r.failed.length, 1)
  assert.equal(Object.keys(r.captions).length, 0, '失败不得产出兜底标注')

  const empty = await captionBatch({ images: [], warmup: false, fetchImpl: fail })
  assert.equal(empty.ok, false)
})

test('warmupVlm：失败不抛（预热只是尽力而为）', async () => {
  const ok = await warmupVlm({ fetchImpl: nativeMock({ content: 'ok' }).fetchImpl })
  assert.equal(ok.ok, true)

  const down = await warmupVlm({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(down.ok, false)
  assert.match(String(down.reason), /ECONNREFUSED/)
})

test('侧车标注与占位标注', () => {
  const dir = tmp('sidecar')
  const img = path.join(dir, 'a.png')
  fs.writeFileSync(img, png())
  fs.writeFileSync(path.join(dir, 'a.txt'), 'woman, garden, sunlight\n', 'utf8')
  const side = readSidecarCaptions([img])
  assert.equal(side.length, 1)
  assert.equal(side[0].text, 'woman, garden, sunlight')
  assert.equal(side[0].source, 'sidecar')

  const noSide = path.join(dir, 'b.png')
  fs.writeFileSync(noSide, png())
  assert.deepEqual(readSidecarCaptions([noSide]), [])

  assert.match(placeholderCaption('id'), /portrait/)
  assert.match(placeholderCaption('base'), /full body/)
})

test('mimeOf：常见图片扩展名映射', () => {
  assert.equal(mimeOf('a.PNG'), 'image/png')
  assert.equal(mimeOf('a.jpeg'), 'image/jpeg')
  assert.equal(mimeOf('a.webp'), 'image/webp')
  assert.equal(mimeOf('a.unknown'), 'application/octet-stream')
})