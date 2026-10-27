/**
 * gateway/test/dataset.test.mjs — 数据集规划 / 标注净化 / 训练前硬校验（P2）
 *
 * 用自造的 PNG 头（只含可解析的 IHDR）验证尺寸解析与端到端校验，不依赖任何图像库。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  readImageSize,
  sanitizeCaption,
  detectSharedTokens,
  planDataset,
  materializeDataset,
  validateDataset,
  datasetConfigBlock,
  COMMON_CAPTION_WORDS,
  IMAGE_EXT,
} from '../lib/dataset.js'

let seq = 0
function tmp(tag) {
  const dir = path.join(os.tmpdir(), 'lora-dataset-test', `${tag}-${process.pid}-${++seq}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 只保证 PNG 尺寸可解析（签名 + IHDR 宽高） */
function png(width, height) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

/** 造一份主数据集；captionFn 返回 null 表示"不写标注文件" */
function makeMain(root, { count, width = 512, height = 768, captionFn, notxt = [], dirName = '10_id_subject' }) {
  const dir = path.join(root, dirName)
  fs.mkdirSync(dir, { recursive: true })
  const files = []
  for (let i = 0; i < count; i++) {
    const name = `img${String(i).padStart(2, '0')}.png`
    const p = path.join(dir, name)
    fs.writeFileSync(p, png(width, height))
    if (!notxt.includes(i)) {
      const cap = captionFn ? captionFn(i) : 'woman, portrait, upper body, sunlight'
      fs.writeFileSync(p.replace(/\.png$/, '.txt'), cap === null ? '' : cap, 'utf8')
    }
    files.push(p)
  }
  return { dir, files }
}

const ID_CAP = (i) => (i < 14 ? 'woman, portrait, upper body, sunlight' : 'woman, full body, garden, standing')

test('readImageSize：PNG / GIF / JPEG 头可解析，垃圾数据返回 null（不猜）', () => {
  const s = readImageSize(png(640, 960))
  assert.deepEqual({ w: s.width, h: s.height, f: s.format }, { w: 640, h: 960, f: 'png' })

  const gif = Buffer.alloc(16)
  gif.write('GIF89a', 0, 'ascii')
  gif.writeUInt16LE(320, 6)
  gif.writeUInt16LE(240, 8)
  const g = readImageSize(gif)
  assert.deepEqual({ w: g.width, h: g.height, f: g.format }, { w: 320, h: 240, f: 'gif' })

  const jpg = Buffer.alloc(32)
  jpg[0] = 0xff; jpg[1] = 0xd8
  jpg[2] = 0xff; jpg[3] = 0xc0
  jpg.writeUInt16BE(17, 4)
  jpg[6] = 8
  jpg.writeUInt16BE(768, 7)
  jpg.writeUInt16BE(512, 9)
  const j = readImageSize(jpg)
  assert.deepEqual({ w: j.width, h: j.height, f: j.format }, { w: 512, h: 768, f: 'jpeg' })

  assert.equal(readImageSize(Buffer.from('not an image at all')), null)
  assert.equal(readImageSize(Buffer.alloc(4)), null)
  assert.equal(readImageSize(null), null)
})

test('sanitizeCaption：剔除身份 token / LoRA 内联语法 / 禁用词，并规范化去重', () => {
  const r = sanitizeCaption('SKS woman in garden, <lora:mychar:0.8>, Alice, green dress, WOMAN, sunlight', {
    bannedTokens: ['Alice'],
  })
  assert.equal(r.text, 'woman in garden, green dress, woman, sunlight')
  assert.ok(r.removed.some((x) => x.includes('trigger-sks')))
  assert.ok(r.removed.some((x) => x.includes('lora-inline-syntax')))
  assert.ok(r.removed.some((x) => x.includes('banned:Alice')))
  assert.deepEqual(r.warnings, [])

  const empty = sanitizeCaption('<lora:x:1> sks', {})
  assert.equal(empty.text, '')
  assert.ok(empty.warnings.some((w) => w.includes('为空')))

  const long = sanitizeCaption(Array.from({ length: 40 }, (_, i) => `tag${i}`).join(', '), { maxTags: 30 })
  assert.equal(long.text.split(', ').length, 30)
  assert.ok(long.warnings.some((w) => w.includes('超过上限')))
})

test('detectSharedTokens：只覆盖 ≥80% 标注的稀有词才判定（通用词被白名单豁免）', () => {
  const caps = [
    'woman, portrait, sunlight, garden, yukari',
    'woman, portrait, sunlight, garden, yukari',
    'woman, portrait, sunlight, garden, yukari',
    'woman, portrait, sunlight, garden, yukari',
    'woman, portrait, moonlight, garden',
  ]
  const hits = detectSharedTokens(caps)
  const tokens = hits.map((h) => h.token)
  assert.ok(tokens.includes('yukari'), '非白名单共享词必须命中')
  assert.ok(!tokens.includes('woman'), '白名单词不该命中')
  assert.ok(!tokens.includes('sunlight'), '4/5 达阈值但属通用词，不该命中')
  assert.equal(hits.find((h) => h.token === 'yukari').ratio, 0.8)
  assert.deepEqual(detectSharedTokens(['only one caption']), [], '样本太少不做判定')
  assert.deepEqual(detectSharedTokens(['woman'], { threshold: 0.8 }), [], '样本太少不做判定')
  assert.equal(COMMON_CAPTION_WORDS.has('yukari'), false)
})

test('planDataset：目录名 `重复次数_概念名`、reg 目录、未知档位报错', () => {
  const root = tmp('plan')
  const p = planDataset({ profile: 'id', images: ['a.png', 'b.png'], root })
  assert.equal(p.ok, true)
  assert.equal(p.concept, 'id_subject')
  assert.equal(p.repeat, 10)
  assert.equal(p.mainDir, path.join(root, '10_id_subject'))
  assert.equal(p.regDir, null, '没给 reg 图就不该凭空造 reg 目录')
  assert.equal(p.rules.datasetImages.min, 15)

  const withReg = planDataset({ profile: 'base', images: ['a.png'], regImages: ['r1.png', 'r2.png'], concept: 'style', root })
  assert.equal(withReg.mainDir, path.join(root, '10_style'))
  assert.equal(withReg.regDir, path.join(root, 'reg', '1_style_reg'))

  const bad = planDataset({ profile: 'xl', images: [], root })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /未知训练档位/)

  const noname = planDataset({ profile: 'id', images: [], root: null })
  assert.equal(noname.ok, false)
})

test('端到端：ID 轨 20 张（14 张特写 = 0.7）通过硬校验', () => {
  const root = tmp('ok-id')
  const { files } = makeMain(root, { count: 20, captionFn: ID_CAP })
  const plan = planDataset({ profile: 'id', images: files, root })
  const r = validateDataset({ plan, profile: 'id' })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.stats.images, 20)
  assert.equal(r.stats.withCaption, 20)
  assert.equal(r.stats.closeups, 14)
  assert.equal(r.stats.closeupRatio, 0.7)
  assert.equal(r.stats.minShortSide, 512)
  assert.ok(r.warnings.some((w) => w.includes('reg')), '没给 reg 图要提示（可选但建议）')
})

test('端到端：Base 轨脸部特写占比超 25% → 拦（这正是 Base 学到身份的主因）', () => {
  const root = tmp('base-ratio')
  const { files } = makeMain(root, {
    count: 20,
    dirName: '10_base_style',
    captionFn: (i) => (i < 10 ? 'woman, portrait, upper body, dress' : 'woman, full body, garden, standing'),
  })
  const badPlan = planDataset({ profile: 'base', images: files, root })
  const bad = validateDataset({ plan: badPlan, profile: 'base' })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((e) => e.includes('超过本档上限')), JSON.stringify(bad.errors))

  const okDir = tmp('base-ratio-ok')
  const okMain = makeMain(okDir, {
    count: 20,
    dirName: '10_base_style',
    captionFn: (i) => (i < 3 ? 'woman, portrait, upper body, dress' : 'woman, full body, garden, standing'),
  })
  const okPlan = planDataset({ profile: 'base', images: okMain.files, root: okDir })
  const ok = validateDataset({ plan: okPlan, profile: 'base' })
  assert.equal(ok.ok, true, JSON.stringify(ok.errors))
  assert.equal(ok.stats.closeupRatio, 0.15)
})

test('端到端：缺标注 / 空标注 / 短边不足 / 尺寸不可解析 都要如实报', () => {
  const root = tmp('bad-files')
  const { files } = makeMain(root, {
    count: 20,
    captionFn: (i) => (i === 3 ? '' : ID_CAP(i)),
    notxt: [5],
    width: 384,
    height: 512,
  })
  const plan = planDataset({ profile: 'id', images: files, root })
  const r = validateDataset({ plan, profile: 'id' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('缺同名标注文件')), JSON.stringify(r.errors))
  assert.ok(r.errors.some((e) => e.includes('标注为空')))
  assert.ok(r.errors.some((e) => e.includes('最短边')), JSON.stringify(r.errors))
})

test('端到端：每张标注都出现的非通用词 = 疑似身份 token → 直接拦（验收硬要求）', () => {
  const root = tmp('token')
  const { files } = makeMain(root, { count: 18, captionFn: () => 'yukari, woman, portrait, sunlight' })
  const plan = planDataset({ profile: 'id', images: files, root })
  const r = validateDataset({ plan, profile: 'id' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('yukari') && e.includes('标注铁律')), JSON.stringify(r.errors))
})

test('端到端：标注里的身份 token 被净化掉时，只在 warning 里点名（不静默通过）', () => {
  const root = tmp('sanitized')
  const { files } = makeMain(root, { count: 18, captionFn: (i) => `Alice, woman, ${i < 12 ? 'portrait' : 'full body'}, garden` })
  const plan = planDataset({ profile: 'id', images: files, root })
  const r = validateDataset({ plan, profile: 'id', bannedTokens: ['Alice'] })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.ok(r.warnings.some((w) => w.includes('身份 token')))
  assert.ok(r.stats.removedTokens.some((x) => x.token.includes('banned:Alice')))
})

test('materializeDataset：落盘可重复调用（同尺寸文件跳过，不重复覆盖）', () => {
  const src = tmp('mat-src')
  const { files } = makeMain(src, { count: 16, captionFn: ID_CAP })
  const dst = tmp('mat-dst')
  const plan = planDataset({ profile: 'id', images: files, concept: 'subject', root: dst })
  const caps = {}
  for (const f of files) caps[path.basename(f)] = 'woman, portrait, sunlight'

  const first = materializeDataset({ plan, captions: caps, manifest: { source: 'test' } })
  assert.equal(first.ok, true)
  assert.equal(first.written.images.length, 16)
  assert.equal(first.written.captions.length, 16)
  assert.ok(fs.existsSync(first.manifestPath))
  assert.equal(fs.readFileSync(path.join(plan.mainDir, 'img00.txt'), 'utf8'), 'woman, portrait, sunlight')

  const second = materializeDataset({ plan, captions: caps })
  assert.equal(second.ok, true)
  assert.equal(second.written.images.length, 0, '第二次不该重新拷贝')
  assert.equal(second.written.skipped.length, 16)

  // 落盘后立刻可校验（标注非空、尺寸来自源图）
  const v = validateDataset({ plan, profile: 'id' })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
})

test('datasetConfigBlock：kohya 训练配置块（主集 + 可选 reg 集）', () => {
  const root = tmp('cfg')
  const plan = planDataset({ profile: 'id', images: ['a.png'], regImages: ['r.png'], concept: 'subject', root })
  const cfg = datasetConfigBlock({ plan })
  assert.equal(cfg.general.enable_bucket, true)
  assert.equal(cfg.general.caption_extension, '.txt')
  assert.equal(cfg.datasets.length, 2)
  assert.equal(cfg.datasets[0].image_dir, plan.mainDir)
  assert.equal(cfg.datasets[1].is_reg, true)
  assert.equal(datasetConfigBlock({ plan: null }), null)

  const noReg = datasetConfigBlock({ plan: planDataset({ profile: 'id', images: ['a.png'], root }) })
  assert.equal(noReg.datasets.length, 1)
})

test('扩展名白名单：只认 kohya 支持的图片格式', () => {
  assert.ok(IMAGE_EXT.has('.png') && IMAGE_EXT.has('.webp'))
  assert.ok(!IMAGE_EXT.has('.txt') && !IMAGE_EXT.has('.gif'))
})