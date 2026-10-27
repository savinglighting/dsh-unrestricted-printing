/**
 * gateway/lib/lora-segment.js — 视觉拆解（P5，可选增强）
 *
 * 做一件事：把素材按「画面主体」分成四类，让拆双轨不再只靠标注里的关键词。
 *
 *   identity —— 脸/头肩主导 → 适合 ID 轨（锁身份）
 *   wardrobe —— 服装主导     → 适合 Base 轨（学服装）
 *   setting  —— 环境主导     → 适合 Base 轨（学场景）
 *   concept  —— 物件/特效主导 → 一般不参与双轨，或单独留作参考
 *
 * 为什么值得做：演练里 23 张同角色素材来自不同画师，构图差异极大。
 * 只靠标注文本里的 "close-up / full body" 拆轨很粗 —— 一张全身图可能脸占一半画面，
 * 标注却写的是 full body。视觉模型看的是**画面本身**，比文本关键词准。
 *
 * 硬约束（与项目一贯原则一致）：
 *   1. **失败绝不阻断训练**：分类失败 → 回退到关键词拆轨，并在警告里说明；
 *   2. 不信任模型输出：只接受合法 JSON + 白名单枚举，其余一律视为失败；
 *   3. 并发受限（默认 2）：视觉模型与训练抢显存，这一步不该把卡吃满。
 *
 * 掩码/抠图（RMBG、SAM 分割）不在此模块内做 —— 那要拉模型、吃显存，
 * 由 sd-auto-mask.py 那条既有链路负责；本模块只产出「该给谁做掩码」的判断。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_VLM_BASE, DEFAULT_VLM_MODEL, DEFAULT_TIMEOUT_MS, callVision } from './caption.js'

export const BUCKETS = ['identity', 'wardrobe', 'setting', 'concept']
export const COMPOSITIONS = ['closeup', 'half', 'full']

/** 要求模型只吐 JSON：字段与枚举都写死在提示里，解析侧再校验一遍 */
export const SEGMENT_SYSTEM_PROMPT = [
  'You are a dataset analyzer for Stable Diffusion LoRA training.',
  'Output ONLY a single JSON object, no prose, no markdown fence.',
  'Schema: {"composition":"closeup|half|full","face_visible":true|false,"face_prominence":0.0,"outfit_prominence":0.0,"scene_prominence":0.0,"bucket":"identity|wardrobe|setting|concept","tags":["short english tags"]}',
  'All prominence values are numbers between 0 and 1 and must roughly sum to 1.',
  'bucket=identity when the face/head dominates; wardrobe when clothing dominates; setting when environment dominates; concept when an object, symbol or effect dominates.',
].join(' ')

export const SEGMENT_USER_PROMPT = 'Analyze this image for dataset bucketing. JSON only.'

/** 从模型输出里抠出 JSON（容忍前后废话与 ```json 围栏） */
export function extractJson(text) {
  const s = String(text || '')
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : s
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

const clamp01 = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
}

/** 校验并规范化模型给的分类结果；不合规返回 null（宁可不分类，也不塞脏数据） */
export function normalizeClassification(raw) {
  if (!raw || typeof raw !== 'object') return null
  const composition = COMPOSITIONS.includes(String(raw.composition)) ? String(raw.composition) : null
  const bucket = BUCKETS.includes(String(raw.bucket)) ? String(raw.bucket) : null
  if (!composition || !bucket) return null
  const faceProminence = clamp01(raw.face_prominence)
  const outfitProminence = clamp01(raw.outfit_prominence)
  const sceneProminence = clamp01(raw.scene_prominence)
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12) : []
  return {
    composition,
    bucket,
    faceVisible: raw.face_visible === true,
    faceProminence,
    outfitProminence,
    sceneProminence,
    tags,
  }
}

/**
 * 单图分类。
 * @returns {Promise<{ok:boolean, file:string, classification?:object, error?:string}>}
 */
export async function classifyImage({
  imagePath,
  vlmBase = DEFAULT_VLM_BASE,
  vlmModel = DEFAULT_VLM_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  maxTokens = 180,
} = {}) {
  // 复用统一视觉调用：OpenAI 端点空内容会自动回退 Ollama 原生端点
  const r = await callVision({
    imagePath,
    system: SEGMENT_SYSTEM_PROMPT,
    user: SEGMENT_USER_PROMPT,
    vlmBase,
    vlmModel,
    timeoutMs,
    fetchImpl,
    maxTokens,
  })
  if (!r.ok) return { ok: false, file: imagePath, error: r.error }
  const parsed = extractJson(r.text)
  const classification = normalizeClassification(parsed)
  if (!classification) return { ok: false, file: imagePath, error: `模型输出不是合法分类 JSON（原始: ${String(r.text).slice(0, 100)}）` }
  return { ok: true, file: imagePath, classification, endpoint: r.endpoint, ms: r.ms }
}

/**
 * 批量分类（受限并发）。**永不抛**：任何一张失败都只是记账。
 * @returns {Promise<{ok:boolean, results:object, failed:Array, errors:string[]}>}
 */
export async function classifyBatch({ images = [], concurrency = 2, onProgress = null, ...rest } = {}) {
  const results = {}
  const failed = []
  const errors = []
  const limit = Math.max(1, Math.min(6, Number(concurrency) || 2))
  let idx = 0
  let done = 0
  const total = images.length
  const workers = Array.from({ length: Math.min(limit, total || 1) }, async () => {
    while (idx < total) {
      const i = idx++
      const raw = images[i]
      const file = typeof raw === 'string' ? raw : raw.path
      const r = await classifyImage({ imagePath: file, ...rest })
      done++
      if (r.ok) results[file] = r.classification
      else {
        failed.push({ file, error: r.error })
        errors.push(`${file}: ${r.error}`)
      }
      if (onProgress) {
        try { onProgress({ done, total, ok: r.ok }) } catch { /* 进度回调不该炸 */ }
      }
    }
  })
  await Promise.all(workers)
  return { ok: failed.length === 0 && total > 0, results, failed, errors, classified: Object.keys(results).length, total }
}

/**
 * 按视觉分类拆双轨。与关键词拆轨的区别：
 *   · 构图来自**画面**而不是标注文本；
 *   · identity 桶优先给 ID 轨，wardrobe/setting 优先给 Base 轨；
 *   · 数量不足时先用「次优」补齐（closeup→ID、full→Base），仍然不足才报错。
 *
 * @returns {{id:Array, base:Array, unclassified:Array, errors:string[], notes:string[]}}
 */
export function assignTracksFromVision({
  images = [],
  classification = {},
  minPerTrack = 15,
  faceProminenceId = 0.45,
  faceProminenceBaseMax = 0.35,
} = {}) {
  const id = []
  const base = []
  const unclassified = []
  const notes = []
  const softId = []
  const softBase = []

  for (const img of images) {
    const file = typeof img === 'string' ? img : img.path
    const c = classification[file]
    if (!c) { unclassified.push(img); continue }
    const face = c.faceProminence === null ? (c.composition === 'closeup' ? 0.8 : c.composition === 'half' ? 0.45 : 0.2) : c.faceProminence
    const bucketWantsBase = c.bucket === 'wardrobe' || c.bucket === 'setting'
    if (c.bucket === 'identity' || (face >= faceProminenceId && !bucketWantsBase)) id.push(img)
    else if (bucketWantsBase || face <= faceProminenceBaseMax) base.push(img)
    else if (c.composition === 'closeup') softId.push(img)
    else softBase.push(img)
  }

  // 判不清的按缺口补齐（与关键词拆轨同样的兜底思路）
  for (const img of softId) (id.length <= base.length ? id : base).push(img)
  for (const img of softBase) (base.length <= id.length ? base : id).push(img)

  if (unclassified.length) {
    notes.push(`${unclassified.length} 张图未被分类（视觉模型失败），回退由关键词拆轨处理这些图`)
  }

  const errors = []
  if (id.length < minPerTrack) errors.push(`ID 轨素材只有 ${id.length} 张（下限 ${minPerTrack}）：补脸部/头肩特写`)
  if (base.length < minPerTrack) errors.push(`Base 轨素材只有 ${base.length} 张（下限 ${minPerTrack}）：补半身/全身/场景`)
  return { id, base, unclassified, errors, notes }
}

/** 四类分桶（给"数据准备"用：把素材按身份/服装/场景/概念归档，便于人眼检查） */
export function groupByBucket({ images = [], classification = {} } = {}) {
  const groups = { identity: [], wardrobe: [], setting: [], concept: [], unknown: [] }
  for (const img of images) {
    const file = typeof img === 'string' ? img : img.path
    const c = classification[file]
    if (!c) { groups.unknown.push(img); continue }
    ;(groups[c.bucket] || groups.unknown).push(img)
  }
  return groups
}

/** 把分桶结果落成目录（只建目录 + 硬链接/拷贝清单，不改像素） */
export function materializeBuckets({ groups, outDir, copyFn = null } = {}) {
  if (!outDir) return { ok: false, error: '缺少 outDir' }
  const written = {}
  try {
    for (const [bucket, list] of Object.entries(groups || {})) {
      const dir = path.join(outDir, bucket)
      fs.mkdirSync(dir, { recursive: true })
      written[bucket] = []
      for (const img of list) {
        const file = typeof img === 'string' ? img : img.path
        const dst = path.join(dir, path.basename(file))
        if (copyFn) copyFn(file, dst)
        written[bucket].push(dst)
      }
    }
    return { ok: true, outDir, written }
  } catch (e) {
    return { ok: false, error: `分桶落盘失败: ${(e && e.message) || e}` }
  }
}

/** 该图是否值得做掩码（抠图/背景分离）：服装或场景主导、且脸不占主导的图最值得 */
export function maskCandidates({ images = [], classification = {} } = {}) {
  const out = []
  for (const img of images) {
    const file = typeof img === 'string' ? img : img.path
    const c = classification[file]
    if (!c) continue
    const face = c.faceProminence === null ? 0.5 : c.faceProminence
    if (c.bucket === 'wardrobe' || c.bucket === 'setting' || face < 0.35) {
      out.push({ file, bucket: c.bucket, reason: c.bucket === 'wardrobe' ? '服装主导：抠衣服做参考' : c.bucket === 'setting' ? '场景主导：分离背景做参考' : '脸不占主导：可安全抠图' })
    }
  }
  return out
}

export default {
  BUCKETS,
  COMPOSITIONS,
  SEGMENT_SYSTEM_PROMPT,
  extractJson,
  normalizeClassification,
  classifyImage,
  classifyBatch,
  assignTracksFromVision,
  groupByBucket,
  materializeBuckets,
  maskCandidates,
}