/**
 * gateway/lib/dataset.js — kohya 数据集规划 / 标注净化 / 训练前硬校验（P2）
 *
 * 本模块只做「数据集这一层」的事，不下载、不训练、不改显存：
 *   1. plan()      —— 按档位生成 kohya 目录规划（`重复次数_概念名` + 可选 reg 目录）；
 *   2. materialize() —— 落盘（拷贝图片 + 写标注 + 生成清单），已存在的文件不重复覆盖；
 *   3. sanitizeCaption() —— 标注净化：去身份 token / LoRA 内联语法 / 规范化 tag；
 *   4. validate()  —— 训练前硬校验：配对、非空、禁用词、短边、体积、脸部特写占比、reg 数量。
 *
 * 标注铁律（本模块的核心约束）：
 *   只描述**场景与可变元素**，绝不写角色名、身份 token、触发词、系列名。
 *   正确：`woman in garden, sunlight, green dress, upper body`
 *   错误：`sks woman, <lora:xxx>, my OC Alice in garden`
 *
 * 所有函数都可离线单测：除 materialize/validate 会读盘外，其余是纯函数。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getProfile, PROFILE_NAMES, COMMON_STANDARD } from './training-profiles.js'

/** 允许的图片扩展名（kohya 只认这几种） */
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

/** 标注 tag 上限（过多 tag 会稀释每张图的学习信号） */
export const CAPTION_MAX_TAGS = 30

/** kohya 目录重复次数默认值（步数由 --max_train_steps 决定，repeat 只影响 epoch 划分） */
export const DEFAULT_REPEAT = 10

/** 内置身份类黑名单：LoRA 内联语法、训练触发词、OC 标记 —— 一律从标注里剔除 */
export const IDENTITY_BLACKLIST = [
  { re: /<lora:[^>]*>/gi, label: 'lora-inline-syntax' },
  { re: /\bsks\b/gi, label: 'trigger-sks' },
  { re: /\b(original character|my oc|oc character)\b/gi, label: 'oc-marker' },
  { re: /\b(trigger ?word|triggerword)\b/gi, label: 'trigger-word' },
  { re: /\b(class ?token|identity ?token)\b/gi, label: 'identity-token' },
]

/**
 * 标注常用词白名单：用于「疑似身份 token」检测时排除正常描述词。
 * 只收场景/人物/身体/衣物/光照/构图类高频词，够用即可（不必穷举）。
 */
export const COMMON_CAPTION_WORDS = new Set([
  'woman', 'man', 'girl', 'boy', 'person', 'people', 'lady', 'male', 'female', 'adult', 'young', 'solo',
  'upper', 'lower', 'full', 'body', 'half', 'closeup', 'close', 'portrait', 'headshot', 'face', 'head',
  'front', 'back', 'side', 'view', 'angle', 'looking', 'smiling', 'standing', 'sitting', 'kneeling', 'walking',
  'hair', 'eyes', 'mouth', 'lips', 'skin', 'hands', 'arms', 'legs', 'smile', 'expression', 'pose',
  'shirt', 'dress', 'skirt', 'jacket', 'coat', 'pants', 'jeans', 'uniform', 'suit', 'hat', 'glasses',
  'shoes', 'boots', 'socks', 'gloves', 'scarf', 'ribbon', 'armor', 'kimono', 'robe', 'cloak', 'wings',
  'garden', 'street', 'room', 'indoor', 'outdoor', 'forest', 'beach', 'city', 'night', 'day', 'sunset',
  'sunlight', 'moonlight', 'neon', 'light', 'lighting', 'shadow', 'rime', 'rain', 'snow', 'fog', 'clouds',
  'bloom', 'petals', 'window', 'sky', 'water', 'field', 'mountain', 'ruins', 'architecture', 'background',
  'close-up', 'closeup', 'upper-body', 'full-body', 'half-body', 'indoors', 'outdoors', 'standing', 'seated',
  'simple', 'detailed', 'soft', 'warm', 'cool', 'vibrant', 'muted', 'the', 'and', 'with', 'in', 'on', 'at',
  // 颜色词：视觉模型标注几乎每张都会带颜色，不豁免就会被误判成"身份 token"（实测 blue 命中 100%）
  'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'violet', 'pink', 'magenta', 'brown',
  'black', 'white', 'gray', 'grey', 'silver', 'gold', 'golden', 'blonde', 'brunette', 'auburn', 'navy',
  'teal', 'turquoise', 'beige', 'cream', 'ivory', 'maroon', 'crimson', 'scarlet', 'azure', 'amber', 'peach',
  // 材质 / 质感 / 常见属性
  'glossy', 'matte', 'metallic', 'silk', 'cotton', 'leather', 'denim', 'lace', 'velvet', 'satin', 'fur',
  'short', 'long', 'medium', 'small', 'large', 'tall', 'thin', 'thick', 'high', 'low', 'open', 'closed',
  'single', 'double', 'multiple', 'group', 'arrangement', 'composition', 'framing', 'angle', 'shot',
  'pattern', 'patterned', 'floral', 'striped', 'plaid', 'solid', 'gradient', 'texture', 'shading',
  'hair', 'braid', 'braided', 'ponytail', 'twintails', 'bun', 'bangs', 'fringe', 'curly', 'straight', 'wavy',
  'depth', 'blur', 'bokeh', 'focus', 'contrast', 'saturation', 'tone', 'tones', 'hue', 'palette',
])

/** 脸部特写类标注词：用来估计 ID/Base 数据配比是否跑偏 */
export const CLOSEUP_CAPTION_WORDS = ['closeup', 'close-up', 'portrait', 'headshot', 'face', 'upper body', 'upper_body']

function logSafe(v) {
  return String(v === undefined || v === null ? '' : v)
}

export function extensionOf(file) {
  return path.extname(String(file || '')).toLowerCase()
}

export function isLikelyImage(file) {
  return IMAGE_EXT.has(extensionOf(file))
}

/** 内容哈希（去重主键） */
export function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * 读图片像素尺寸（PNG / JPEG / WebP / GIF），不依赖任何第三方库。
 * 解析失败返回 null —— 由调用方按"无法确认短边"处理，不猜。
 */
export function readImageSize(buf) {
  if (!buf || buf.length < 16) return null
  // PNG: \x89PNG\r\n\x1a\n + IHDR
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' }
  }
  // GIF
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' }
  }
  // WebP（VP8X / VP8L / VP8 三种块）
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16)
    if (fmt === 'VP8X' && buf.length >= 30) {
      return { width: 1 + (buf.readUIntLE(24, 3) & 0xffffff), height: 1 + (buf.readUIntLE(27, 3) & 0xffffff), format: 'webp' }
    }
    if (fmt === 'VP8 ' && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' }
    }
    if (fmt === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' }
    }
    return null
  }
  // JPEG: 扫 SOF 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), format: 'jpeg' }
      if (len <= 0) break
      i += 2 + len
    }
  }
  return null
}

/**
 * 标注净化：剔除身份 token / LoRA 内联语法，规范化成逗号分隔 tag 串。
 * @returns {{text:string, removed:string[], warnings:string[]}}
 */
export function sanitizeCaption(input, { bannedTokens = [], maxTags = CAPTION_MAX_TAGS } = {}) {
  let text = logSafe(input).replace(/[\r\n]+/g, ' ').trim()
  const removed = []
  const warnings = []

  for (const { re, label } of IDENTITY_BLACKLIST) {
    const hits = text.match(re)
    if (hits) {
      removed.push(...hits.map((h) => `${label}:${h.trim()}`))
      text = text.replace(re, ' ')
    }
  }
  for (const token of bannedTokens) {
    const t = logSafe(token).trim()
    if (!t) continue
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    const hits = text.match(re)
    if (hits) {
      removed.push(...hits.map((h) => `banned:${h.trim()}`))
      text = text.replace(re, ' ')
    }
  }

  // 规范化：逗号切分 → 去空 → 去重（保序）→ 限长
  const tags = text
    .split(/[,;]+/)
    .map((t) => t.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean)
  const seen = new Set()
  const kept = []
  for (const t of tags) {
    if (seen.has(t)) continue
    seen.add(t)
    kept.push(t)
  }
  if (kept.length > maxTags) {
    warnings.push(`tag 数 ${kept.length} 超过上限 ${maxTags}，已截断（过多 tag 会稀释学习信号）`)
    kept.length = maxTags
  }
  if (!kept.length) warnings.push('净化后标注为空：该图将学不到任何场景信息')

  return { text: kept.join(', '), removed, warnings }
}

/**
 * 跨图共享 token 检测：出现在绝大多数标注里、且不在常用词白名单中的长词，
 * 极可能是身份 token / 触发词（标准明令禁止）。
 * @returns {Array<{token:string, files:number, ratio:number}>}
 */
export function detectSharedTokens(captions, { threshold = 0.8, minLen = 4, whitelist = COMMON_CAPTION_WORDS } = {}) {
  const list = (Array.isArray(captions) ? captions : []).map((c) => logSafe(c))
  const total = list.length
  if (total < 3) return []
  const count = new Map()
  for (const cap of list) {
    const seen = new Set()
    for (const tag of cap.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)) {
      for (const w of tag.split(/\s+/)) {
        if (w.length < minLen) continue
        if (whitelist.has(w)) continue
        if (/^\d+$/.test(w)) continue
        if (seen.has(w)) continue
        seen.add(w)
        count.set(w, (count.get(w) || 0) + 1)
      }
    }
  }
  const out = []
  for (const [token, n] of count) {
    const ratio = n / total
    if (ratio >= threshold) out.push({ token, files: n, ratio })
  }
  return out.sort((a, b) => b.ratio - a.ratio)
}

/** 标注里属于"脸部特写"的标记数（用于配比估计） */
export function isCloseupCaption(caption) {
  const s = logSafe(caption).toLowerCase()
  return CLOSEUP_CAPTION_WORDS.some((w) => s.includes(w))
}

/**
 * 按档位生成数据集目录规划（不落盘）。
 * @param {object} o
 * @param {string} o.profile      'id' | 'base'
 * @param {string[]} o.images     图片绝对路径（已通过采集筛查）
 * @param {string} [o.concept]    概念名（目录里 `重复次数_概念名` 的后半段）
 * @param {number} [o.repeat]     重复次数
 * @param {string[]} [o.regImages] reg 通用人物图（可选，减轻遗忘）
 * @param {string} o.root         数据集根目录
 */
export function planDataset({ profile, images = [], concept = null, repeat = DEFAULT_REPEAT, regImages = [], root }) {
  const p = getProfile(profile)
  if (!p) return { ok: false, error: `未知训练档位: ${profile}（可选 ${PROFILE_NAMES.join(' / ')}）` }
  if (!root) return { ok: false, error: '缺少数据集根目录 root' }
  const name = String(concept || (p.name === 'id' ? 'id_subject' : 'base_style')).replace(/[\\/:*?"<>|]/g, '_')
  const repeatNum = Math.max(1, Math.round(Number(repeat) || DEFAULT_REPEAT))
  const mainDir = path.join(root, `${repeatNum}_${name}`)
  const regCount = Array.isArray(regImages) ? regImages.length : 0
  return {
    ok: true,
    profile: p.name,
    role: p.role,
    root,
    concept: name,
    repeat: repeatNum,
    mainDir,
    regDir: regCount ? path.join(root, 'reg', `1_${name}_reg`) : null,
    images: images.map((f) => path.resolve(String(f))),
    regImages: (Array.isArray(regImages) ? regImages : []).map((f) => path.resolve(String(f))),
    rules: {
      /** 每轨数据量标准（来自 COMMON_STANDARD，单一来源） */
      datasetImages: COMMON_STANDARD.datasetImages,
      faceCloseupRatio: p.faceCloseupRatio,
      expectedSizeMB: p.expectedSizeMB,
    },
  }
}

/**
 * 把规划落盘：拷贝图片 + 写同名标注 + 生成清单。
 * 已存在且大小一致的文件跳过（可重复调用，不重复覆盖）。
 */
export function materializeDataset({ plan, captions = {}, manifest = null, copyFn = fs.copyFileSync }) {
  if (!plan || plan.ok === false) return { ok: false, error: (plan && plan.error) || 'plan 无效' }
  const written = { images: [], captions: [], skipped: [] }
  const dirs = [plan.mainDir, plan.regDir].filter(Boolean)
  for (const d of dirs) fs.mkdirSync(d, { recursive: true })

  const put = (src, dir, captionText) => {
    const base = path.basename(src)
    const stem = base.slice(0, base.length - path.extname(base).length)
    const dst = path.join(dir, base)
    try {
      const same = fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size
      if (same) written.skipped.push(dst)
      else { copyFn(src, dst); written.images.push(dst) }
    } catch (e) {
      return { ok: false, error: `拷贝失败 ${src}: ${(e && e.message) || e}` }
    }
    const txt = path.join(dir, `${stem}.txt`)
    const text = captionText === undefined || captionText === null ? '' : String(captionText)
    fs.writeFileSync(txt, text, 'utf8')
    written.captions.push(txt)
    return { ok: true }
  }

  for (const img of plan.images) {
    const r = put(img, plan.mainDir, captions[img] !== undefined ? captions[img] : captions[path.basename(img)])
    if (r.ok === false) return { ok: false, error: r.error, written }
  }
  for (const img of plan.regImages) {
    const r = put(img, plan.regDir, '')
    if (r.ok === false) return { ok: false, error: r.error, written }
  }

  const manifestPath = path.join(plan.root, `${plan.profile}-manifest.json`)
  if (manifest) {
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, plan: { ...plan, images: plan.images.length, regImages: plan.regImages.length } }, null, 2), 'utf8')
  }
  return { ok: true, mainDir: plan.mainDir, regDir: plan.regDir, manifestPath: manifest ? manifestPath : null, written }
}

/**
 * 训练前硬校验（读盘）：不通过就直接拒绝开训，不做"尽力而为"。
 * @returns {{ok:boolean, errors:string[], warnings:string[], stats:object}}
 */
export function validateDataset({
  plan,
  profile = null,
  bannedTokens = [],
  minShortSide = 512,
  expected = null,
  closeupTolerance = 0.05,
  /**
   * 放宽档：跳过「脸部特写占比」这条硬拦（**演练/非常规素材**用）。
   * 标准流程必须关闭 —— 那条校验正是 Base 学到身份、ID 学到服装的主防线。
   * 放宽时会升级成 warning，绝不静默。
   */
  relaxRatio = false,
} = {}) {
  const errors = []
  const warnings = []
  const p = getProfile(profile || (plan && plan.profile))
  if (!p) return { ok: false, errors: [`未知训练档位: ${profile || (plan && plan.profile)}`], warnings, stats: {} }
  if (!plan || !plan.mainDir) return { ok: false, errors: ['缺少数据集规划'], warnings, stats: {} }
  if (!fs.existsSync(plan.mainDir)) return { ok: false, errors: [`数据集目录不存在: ${plan.mainDir}`], warnings, stats: {} }

  const files = fs.readdirSync(plan.mainDir)
  const images = files.filter((f) => isLikelyImage(f))
  const stats = {
    dir: plan.mainDir,
    images: images.length,
    withCaption: 0,
    emptyCaption: 0,
    closeups: 0,
    closeupRatio: 0,
    regImages: 0,
    minShortSide: null,
    formats: {},
    removedTokens: [],
  }

  const want = expected || { min: 15, max: 30 }
  if (images.length < want.min) errors.push(`图片数 ${images.length} 少于下限 ${want.min}（标准 15–30 张）`)
  if (images.length > want.max) warnings.push(`图片数 ${images.length} 超过建议上限 ${want.max}（会增加过拟合风险）`)

  const captions = []
  let shortSideMin = Infinity
  for (const img of images) {
    const full = path.join(plan.mainDir, img)
    const stem = img.slice(0, img.length - path.extname(img).length)
    const txt = path.join(plan.mainDir, `${stem}.txt`)
    const ext = extensionOf(img)
    stats.formats[ext] = (stats.formats[ext] || 0) + 1
    if (!fs.existsSync(txt)) {
      errors.push(`缺同名标注文件: ${stem}.txt`)
      continue
    }
    const raw = fs.readFileSync(txt, 'utf8')
    const { text, removed, warnings: w } = sanitizeCaption(raw, { bannedTokens })
    if (!text) stats.emptyCaption++
    else stats.withCaption++
    for (const r of removed) stats.removedTokens.push({ file: stem, token: r })
    for (const x of w) warnings.push(`${stem}: ${x}`)
    captions.push(text)
    if (isCloseupCaption(text)) stats.closeups++
    if (raw.trim() !== text) warnings.push(`${stem}: 标注含身份 token 或格式不规范（净化后与前文不一致，请核对）`)

    try {
      const buf = fs.readFileSync(full)
      const size = readImageSize(buf)
      if (!size) { warnings.push(`${stem}: 无法解析图片尺寸（不猜，按未知处理）`); continue }
      const short = Math.min(size.width, size.height)
      if (short < shortSideMin) shortSideMin = short
    } catch (e) {
      errors.push(`图片不可读: ${stem} → ${(e && e.message) || e}`)
    }
  }
  stats.minShortSide = Number.isFinite(shortSideMin) ? shortSideMin : null
  if (stats.minShortSide !== null && stats.minShortSide < minShortSide) {
    errors.push(`最短边 ${stats.minShortSide} 小于 ${minShortSide}：请先等比放大/裁剪再训练`)
  }
  if (stats.emptyCaption > 0) errors.push(`有 ${stats.emptyCaption} 张图的标注为空（会学成纯背景）`)

  const ratio = images.length ? stats.closeups / images.length : 0
  stats.closeupRatio = Number(ratio.toFixed(3))
  const band = p.faceCloseupRatio || {}
  if (relaxRatio) {
    if (band.min !== undefined && ratio + closeupTolerance < band.min) {
      warnings.push(`脸部特写占比 ${stats.closeupRatio} 低于本档标准下限 ${band.min}：已按放宽模式放行（素材以全身/场景为主时结果会偏"整体形似"而非"脸部锁死"）`)
    }
    if (band.max !== undefined && ratio - closeupTolerance > band.max) {
      warnings.push(`脸部特写占比 ${stats.closeupRatio} 超过本档标准上限 ${band.max}：已按放宽模式放行（Base 有学到身份的风险）`)
    }
  } else {
    if (band.min !== undefined && ratio + closeupTolerance < band.min) {
      errors.push(`脸部特写占比 ${stats.closeupRatio} 低于本档下限 ${band.min}（${band.hint}）`)
    }
    if (band.max !== undefined && ratio - closeupTolerance > band.max) {
      errors.push(`脸部特写占比 ${stats.closeupRatio} 超过本档上限 ${band.max}（${band.hint}）`)
    }
  }

  const shared = detectSharedTokens(captions)
  stats.sharedTokens = shared
  for (const s of shared) {
    const pct = Math.round(s.ratio * 100)
    if (s.ratio >= 0.999) {
      // 出现在**每一张**标注里的非通用词，是身份 token / 触发词的典型特征 —— 铁律，直接拦
      errors.push(`疑似身份 token/触发词「${s.token}」出现在 ${pct}% 的标注里 —— 标注铁律禁止，请删除后重训`)
    } else {
      warnings.push(`「${s.token}」出现在 ${pct}% 的标注里（若为通用描述词可忽略，若为角色名/触发词必须删除）`)
    }
  }

  if (plan.regDir) {
    const regs = fs.existsSync(plan.regDir) ? fs.readdirSync(plan.regDir).filter((f) => isLikelyImage(f)) : []
    stats.regImages = regs.length
    const regBand = { min: 5, max: 10 }
    if (regs.length && (regs.length < regBand.min || regs.length > regBand.max)) {
      warnings.push(`reg 图 ${regs.length} 张不在建议区间 ${regBand.min}–${regBand.max}`)
    }
    if (regs.length) {
      for (const r of regs) {
        const txt = path.join(plan.regDir, `${r.slice(0, r.length - path.extname(r).length)}.txt`)
        if (!fs.existsSync(txt)) warnings.push(`reg 图缺标注: ${r}（kohya 会按空标注处理）`)
      }
    }
  } else {
    warnings.push('未提供 reg 通用人物图（可选，5–10 张可减轻遗忘）')
  }

  return { ok: errors.length === 0, errors, warnings, stats, shared }
}

/** 给 kohya 的 dataset 配置块（纯数据，落盘由编排层决定） */
export function datasetConfigBlock({ plan, batchSize = 2, numRepeats } = {}) {
  if (!plan || plan.ok === false) return null
  const blocks = [{ image_dir: plan.mainDir, num_repeats: numRepeats || plan.repeat, batch_size: batchSize }]
  if (plan.regDir) blocks.push({ image_dir: plan.regDir, num_repeats: 1, batch_size: batchSize, is_reg: true })
  return { general: { enable_bucket: true, bucket_no_upscale: true, caption_extension: '.txt' }, datasets: blocks }
}

export default {
  IMAGE_EXT,
  CAPTION_MAX_TAGS,
  DEFAULT_REPEAT,
  IDENTITY_BLACKLIST,
  COMMON_CAPTION_WORDS,
  CLOSEUP_CAPTION_WORDS,
  isLikelyImage,
  extensionOf,
  hashBuffer,
  readImageSize,
  sanitizeCaption,
  detectSharedTokens,
  isCloseupCaption,
  planDataset,
  materializeDataset,
  validateDataset,
  datasetConfigBlock,
}