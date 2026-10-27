/**
 * gateway/test/lora-segment.test.mjs — 视觉拆解（P5）
 *
 * 重点：模型输出不可信（可能带废话、带围栏、给非法枚举）→ 一律校验；
 * 分类失败**绝不阻断训练** → 必须能回退。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  BUCKETS,
  extractJson,
  normalizeClassification,
  classifyImage,
  classifyBatch,
  assignTracksFromVision,
  groupByBucket,
  materializeBuckets,
  maskCandidates,
} from '../lib/lora-segment.js'

let seq = 0
function tmp(tag) {
  const dir = path.join(os.tmpdir(), 'lora-segment-test', `${tag}-${process.pid}-${++seq}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function png(fill = 0x44) {
  const b = Buffer.alloc(33, fill)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(512, 16)
  b.writeUInt32BE(768, 20)
  return b
}

function mockVlm(content, { status = 200 } = {}) {
  return async () => ({
    ok: status === 200,
    status,
    json: async () => ({ choices: [{ message: { content: typeof content === 'function' ? content() : content } }] }),
  })
}

const GOOD = JSON.stringify({
  composition: 'closeup',
  face_visible: true,
  face_prominence: 0.8,
  outfit_prominence: 0.1,
  scene_prominence: 0.1,
  bucket: 'identity',
  tags: ['silver hair', 'purple eyes'],
})

test('extractJson：容忍前后废话与 ```json 围栏，坏 JSON 返回 null', () => {
  assert.deepEqual(extractJson('好的，结果如下：{"a":1} 希望有帮助'), { a: 1 })
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 })
  assert.deepEqual(extractJson('```\n{"a":3}\n```'), { a: 3 })
  assert.equal(extractJson('没有 json'), null)
  assert.equal(extractJson('{坏掉的'), null)
  assert.equal(extractJson(null), null)
})

test('normalizeClassification：非法枚举一律拒（宁可不分类也不塞脏数据）', () => {
  const ok = normalizeClassification({ composition: 'closeup', bucket: 'identity', face_prominence: 1.7, outfit_prominence: -1, scene_prominence: 0.2, tags: ['a', 'b'] })
  assert.equal(ok.composition, 'closeup')
  assert.equal(ok.faceProminence, 1, '越界数值被夹到 0..1')
  assert.equal(ok.outfitProminence, 0)
  assert.deepEqual(ok.tags, ['a', 'b'])

  assert.equal(normalizeClassification({ composition: 'ultra-wide', bucket: 'identity' }), null, '构图枚举非法 → 拒绝')
  assert.equal(normalizeClassification({ composition: 'full', bucket: 'face' }), null, '桶枚举非法 → 拒绝')
  assert.equal(normalizeClassification(null), null)
  assert.equal(normalizeClassification('x'), null)
  assert.deepEqual(BUCKETS, ['identity', 'wardrobe', 'setting', 'concept'])
})

test('classifyImage：正常返回分类；模型乱答 / HTTP 错误 / 图不存在 都如实失败', async () => {
  const dir = tmp('classify')
  const file = path.join(dir, 'a.png')
  fs.writeFileSync(file, png())

  const ok = await classifyImage({ imagePath: file, fetchImpl: mockVlm(GOOD) })
  assert.equal(ok.ok, true)
  assert.equal(ok.classification.bucket, 'identity')
  assert.equal(ok.classification.composition, 'closeup')

  const fenced = await classifyImage({ imagePath: file, fetchImpl: mockVlm('```json\n' + GOOD + '\n```') })
  assert.equal(fenced.ok, true, '带围栏也要能解析')

  const prose = await classifyImage({ imagePath: file, fetchImpl: mockVlm('这张图是一个人，穿裙子。') })
  assert.equal(prose.ok, false)
  assert.match(prose.error, /不是合法分类 JSON/)

  const http500 = await classifyImage({ imagePath: file, fetchImpl: mockVlm('', { status: 500 }) })
  assert.equal(http500.ok, false)
  assert.match(http500.error, /HTTP 500/)

  const missing = await classifyImage({ imagePath: path.join(dir, 'nope.png'), fetchImpl: mockVlm(GOOD) })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /不存在/)
})

test('classifyBatch：并发跑完，失败的记账但不抛', async () => {
  const dir = tmp('batch')
  // 每张图字节不同（png() 带不同填充），才能按请求内容区分是哪一张
  const files = ['a', 'b', 'c', 'd'].map((n, i) => {
    const f = path.join(dir, `${n}.png`)
    fs.writeFileSync(f, png(i + 1))
    return f
  })
  // 坏图标记：只给 b.png 追加一个唯一尾部字节串，用它在 base64 里定位「哪张图该失败」。
  // （不能用填充字节判定：PNG 头对每张图都一样，填充值也会出现在所有图的 base64 前缀里）
  const badFile = files[1]
  fs.appendFileSync(badFile, Buffer.from('BADIMAGE-MARKER-2'))
  const BAD_MARK = Buffer.from('BADIMAGE-MARKER-2').toString('base64')
  // callVision 会依次打「原生端点 → 兼容端点」，所以 mock 不能按调用次数判断，
  // 必须按**请求内容**（哪张图）来决定成败，否则双端点回退会让计数整体错位。
  let calls = 0
  const fetchImpl = async (url, init) => {
    calls++
    const body = String((init && init.body) || '')
    const isBadImage = body.includes(BAD_MARK)
    const content = isBadImage ? '不是 JSON' : GOOD
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }
  }
  const r = await classifyBatch({ images: files, concurrency: 2, fetchImpl })
  assert.equal(r.total, 4)
  assert.equal(r.classified, 3)
  assert.equal(r.failed.length, 1)
  assert.equal(r.ok, false, '有失败就不是全绿')
  assert.equal(Object.keys(r.results).length, 3)
  assert.ok(calls >= 4, '每张图至少一次调用（坏图会试两个端点）')

  const empty = await classifyBatch({ images: [], fetchImpl })
  assert.equal(empty.ok, false)
  assert.equal(empty.total, 0)
})

test('assignTracksFromVision：identity 桶进 ID、wardrobe/setting 进 Base，判不清按缺口补', () => {
  const images = [{ path: 'face.png' }, { path: 'dress.png' }, { path: 'scene.png' }, { path: 'mid.png' }]
  const classification = {
    'face.png': { bucket: 'identity', composition: 'closeup', faceProminence: 0.9, faceVisible: true },
    'dress.png': { bucket: 'wardrobe', composition: 'full', faceProminence: 0.2, faceVisible: true },
    'scene.png': { bucket: 'setting', composition: 'full', faceProminence: 0.1, faceVisible: false },
    'mid.png': { bucket: 'concept', composition: 'half', faceProminence: 0.5, faceVisible: true },
  }
  const r = assignTracksFromVision({ images, classification, minPerTrack: 1 })
  assert.deepEqual(r.id.map((x) => x.path), ['face.png', 'mid.png'])
  assert.deepEqual(r.base.map((x) => x.path), ['dress.png', 'scene.png'])
  assert.deepEqual(r.errors, [])

  const short = assignTracksFromVision({ images: [images[0]], classification, minPerTrack: 15 })
  assert.equal(short.errors.length, 2)
})

test('assignTracksFromVision：未分类的图单独列出（交给关键词法兜底，不静默丢弃）', () => {
  const images = [{ path: 'a.png' }, { path: 'b.png' }]
  const r = assignTracksFromVision({ images, classification: { 'a.png': { bucket: 'identity', composition: 'closeup', faceProminence: 0.9 } }, minPerTrack: 1 })
  assert.equal(r.unclassified.length, 1)
  assert.equal(r.unclassified[0].path, 'b.png')
  assert.ok(r.notes.some((n) => n.includes('未被分类')))
})

test('groupByBucket / materializeBuckets：四分类归档 + 未分类兜底', () => {
  const dir = tmp('buckets')
  const files = ['i.png', 'w.png', 's.png', 'c.png', 'u.png'].map((n) => {
    const f = path.join(dir, n)
    fs.writeFileSync(f, png())
    return f
  })
  const classification = {
    [files[0]]: { bucket: 'identity' },
    [files[1]]: { bucket: 'wardrobe' },
    [files[2]]: { bucket: 'setting' },
    [files[3]]: { bucket: 'concept' },
  }
  const groups = groupByBucket({ images: files, classification })
  assert.equal(groups.identity.length, 1)
  assert.equal(groups.unknown.length, 1, '未分类进 unknown，不丢')

  const out = tmp('buckets-out')
  const mat = materializeBuckets({ groups, outDir: out, copyFn: (a, b) => fs.copyFileSync(a, b) })
  assert.equal(mat.ok, true)
  assert.equal(fs.existsSync(path.join(out, 'identity', 'i.png')), true)
  assert.equal(fs.existsSync(path.join(out, 'unknown', 'u.png')), true)
  assert.equal(materializeBuckets({ groups, outDir: null }).ok, false)
})

test('maskCandidates：服装/场景主导或脸不占主导的图才是抠图候选', () => {
  const images = [{ path: 'f.png' }, { path: 'd.png' }, { path: 's.png' }, { path: 'x.png' }]
  const classification = {
    'f.png': { bucket: 'identity', faceProminence: 0.9 },
    'd.png': { bucket: 'wardrobe', faceProminence: 0.3 },
    's.png': { bucket: 'setting', faceProminence: 0.1 },
    'x.png': { bucket: 'concept', faceProminence: 0.2 },
  }
  const cands = maskCandidates({ images, classification })
  const names = cands.map((c) => path.basename(c.file))
  assert.deepEqual(names.sort(), ['d.png', 's.png', 'x.png'])
  assert.ok(!names.includes('f.png'), '脸部主导的图不该被抠')
  assert.ok(cands.every((c) => c.reason && c.bucket))
})