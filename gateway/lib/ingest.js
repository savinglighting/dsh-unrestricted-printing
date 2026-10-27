/**
 * gateway/lib/ingest.js — 三源采集归一（P2）
 *
 * 用户给的东西只有三种形态，本模块把它们统一成「一份可训练图片清单 + 来源留痕」：
 *   1. 本地路径（目录 / 单文件 / 多路径）
 *   2. 网址（单条 / 多条图片直链；不解析网页正文，只按图片响应处理）
 *   3. 参考图（本地文件路径或 https 直链，语义等同上面两种，只是来源标记不同）
 *
 * 归一后做什么：
 *   · 扩展名白名单 + 响应 content-type 复核（两边都要像图片，才收）
 *   · 精确去重（sha256 同一张图只留一份）
 *   · 尺寸解析（PNG/JPEG/WebP/GIF 头，不依赖图像库）→ 标出短边不达标、需要裁剪/放大的项
 *   · EXIF 与像素级处理交给 Python 侧（Pillow）—— 缺失时**降级不阻断**（只标记 skipped_process）
 *   · 来源留痕（sources.json：每条来源的类型、URL、字节数、哈希、时间）
 *
 * 明确不做的事：不猜路径、不把非图片当图片、不静默丢弃来源（丢弃必记账）。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { IMAGE_EXT, isLikelyImage, readImageSize } from './dataset.js'

/** 单张图下载上限（默认 20MB）：防止误贴一个巨大文件把训练目录撑爆 */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
/** 下载超时（ms） */
export const DEFAULT_TIMEOUT_MS = 20000
/** 允许的响应 content-type 前缀 */
const IMAGE_MIME_PREFIX = 'image/'

export function isUrlLike(v) {
  const s = String(v || '').trim()
  return /^https?:\/\//i.test(s)
}

/**
 * 归类来源（纯函数）：`local-dir` / `local-file` / `url` / `missing`。
 * @returns {{kind:string, value:string, exists?:boolean}}
 */
export function classifySource(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim()
  if (!raw) return { kind: 'missing', value: raw }
  if (isUrlLike(raw)) return { kind: 'url', value: raw }
  try {
    const st = fs.statSync(raw)
    if (st.isDirectory()) return { kind: 'local-dir', value: path.resolve(raw), exists: true }
    if (st.isFile()) return { kind: 'local-file', value: path.resolve(raw), exists: true }
    return { kind: 'missing', value: raw }
  } catch {
    return { kind: 'missing', value: raw, exists: false }
  }
}

/** 把一个「来源」展开成候选图片文件路径列表（目录递归，跳过隐藏目录） */
export function expandLocalDir(dir, { maxDepth = 4 } = {}) {
  const out = []
  const stack = [{ d: dir, depth: 0 }]
  while (stack.length) {
    const { d, depth } = stack.shift()
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth) stack.push({ d: full, depth: depth + 1 })
      } else if (e.isFile() && isLikelyImage(e.name)) {
        out.push(full)
      }
    }
  }
  return out.sort()
}

/** 从 URL 推扩展名（URL 里没有就看 content-type） */
export function extFromUrl(url, contentType = '') {
  try {
    const p = new URL(url).pathname
    const e = path.extname(p).toLowerCase()
    if (IMAGE_EXT.has(e)) return e
  } catch { /* 非法 URL：交给下游报错 */ }
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('png')) return '.png'
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg'
  if (ct.includes('webp')) return '.webp'
  if (ct.includes('bmp')) return '.bmp'
  return null
}

/** 从 URL/路径给一份去重后的稳定文件名 */
export function suggestName(url, sha256, ext) {
  let base = ''
  try {
    const p = new URL(url).pathname
    let raw = path.basename(p)
    try { raw = decodeURIComponent(raw) } catch { /* 非法百分号编码：按原样用 */ }
    base = raw.replace(/\.[^.]+$/, '')
  } catch { base = '' }
  if (!base || base.length < 3) base = 'ref'
  const safe = base.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
  return `${safe}_${String(sha256).slice(0, 12)}${ext}`
}

async function fetchImage(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow' })
    if (!res || !res.ok) return { ok: false, error: `HTTP ${res ? res.status : 'no-response'}` }
    const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || ''
    const len = Number((res.headers && res.headers.get && res.headers.get('content-length')) || 0)
    if (len && len > maxBytes) return { ok: false, error: `文件过大 ${len} > ${maxBytes}`, contentType: ct }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) return { ok: false, error: `文件过大 ${buf.length} > ${maxBytes}`, contentType: ct }
    return { ok: true, buf, contentType: ct }
  } catch (e) {
    return { ok: false, error: `下载失败: ${(e && e.message) || e}` }
  } finally {
    clearTimeout(timer)
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * 采集归一。
 * @param {object} o
 * @param {string[]} o.sources      本地路径 / URL 混排
 * @param {string} o.destDir        归一后的落盘目录（不存在则创建）
 * @param {string} [o.role]         来源标记：'user-path' | 'url' | 'reference-image'（只用于留痕）
 * @param {number} [o.minShortSide] 短边下限（低于它标记 needs_process，不直接丢）
 * @param {object} [o.fetchImpl]    便于测试注入
 * @returns {Promise<{ok:boolean, images:Array, errors:Array, skipped:Array, sources:Array, needsProcess:Array}>}
 */
export async function collect({
  sources = [],
  destDir,
  role = 'user-path',
  minShortSide = 512,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  keepOriginals = true,
} = {}) {
  const errors = []
  const skipped = []
  const images = []
  const sourceTrail = []
  const needsProcess = []
  const seenHash = new Map()

  if (!destDir) return { ok: false, images, errors: ['缺少 destDir（归一落盘目录）'], skipped, sources: [], needsProcess }
  fs.mkdirSync(destDir, { recursive: true })

  const list = (Array.isArray(sources) ? sources : [sources]).filter((s) => String(s || '').trim())

  for (const item of list) {
    const cls = classifySource(item)
    if (cls.kind === 'missing') {
      errors.push(`来源不存在或不可读: ${cls.value}`)
      sourceTrail.push({ input: cls.value, kind: 'missing', role, at: new Date().toISOString() })
      continue
    }

    if (cls.kind === 'local-dir') {
      const files = expandLocalDir(cls.value)
      if (!files.length) {
        errors.push(`目录里没有可用图片: ${cls.value}`)
        sourceTrail.push({ input: cls.value, kind: 'local-dir', role, files: 0, at: new Date().toISOString() })
        continue
      }
      sourceTrail.push({ input: cls.value, kind: 'local-dir', role, files: files.length, at: new Date().toISOString() })
      for (const f of files) ingestLocalFile(f, { destDir, role, images, skipped, errors, needsProcess, seenHash, minShortSide, keepOriginals })
      continue
    }

    if (cls.kind === 'local-file') {
      sourceTrail.push({ input: cls.value, kind: 'local-file', role, at: new Date().toISOString() })
      ingestLocalFile(cls.value, { destDir, role, images, skipped, errors, needsProcess, seenHash, minShortSide, keepOriginals })
      continue
    }

    // URL
    const got = await fetchImage(cls.value, { fetchImpl, timeoutMs, maxBytes })
    if (!got.ok) {
      errors.push(`${cls.value} → ${got.error}`)
      sourceTrail.push({ input: cls.value, kind: 'url', role, ok: false, error: got.error, at: new Date().toISOString() })
      continue
    }
    // 双向复核：content-type 与"能否解析出尺寸"都要像图片，才收（避免把 HTML 错误页当图）
    const ctOk = !got.contentType || String(got.contentType).toLowerCase().startsWith(IMAGE_MIME_PREFIX)
    const size = readImageSize(got.buf)
    const hash = sha256(got.buf)
    if (!ctOk || !size) {
      errors.push(`${cls.value} → 响应不像图片（content-type=${got.contentType || 'n/a'}, 尺寸解析=${size ? 'ok' : 'fail'}）`)
      sourceTrail.push({ input: cls.value, kind: 'url', role, ok: false, error: 'not-an-image', contentType: got.contentType, at: new Date().toISOString() })
      continue
    }
    if (seenHash.has(hash)) {
      skipped.push({ input: cls.value, reason: 'duplicate', duplicateOf: seenHash.get(hash), hash })
      sourceTrail.push({ input: cls.value, kind: 'url', role, ok: true, duplicateOf: seenHash.get(hash), at: new Date().toISOString() })
      continue
    }
    const ext = extFromUrl(cls.value, got.contentType) || '.png'
    const name = suggestName(cls.value, hash, ext)
    const file = path.join(destDir, name)
    fs.writeFileSync(file, got.buf)
    seenHash.set(hash, cls.value)
    const rec = { path: file, name, origin: cls.value, originKind: 'url', role, sha256: hash, bytes: got.buf.length, width: size.width, height: size.height, format: size.format, shortSide: Math.min(size.width, size.height) }
    if (rec.shortSide < minShortSide) {
      rec.needsProcess = 'resize'
      needsProcess.push(rec)
    }
    images.push(rec)
    sourceTrail.push({ input: cls.value, kind: 'url', role, ok: true, file: name, bytes: got.buf.length, hash, at: new Date().toISOString() })
  }

  const trailPath = path.join(destDir, 'sources.json')
  fs.writeFileSync(trailPath, JSON.stringify({ role, destDir, minShortSide, count: images.length, sources: sourceTrail }, null, 2), 'utf8')

  return { ok: errors.length === 0, images, errors, skipped, sources: sourceTrail, needsProcess, trailPath }
}

function ingestLocalFile(file, { destDir, role, images, skipped, errors, needsProcess, seenHash, minShortSide, keepOriginals }) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch (e) {
    errors.push(`读取失败 ${file}: ${(e && e.message) || e}`)
    return
  }
  const size = readImageSize(buf)
  if (!size) {
    errors.push(`不是可解析的图片: ${file}`)
    return
  }
  const hash = sha256(buf)
  if (seenHash.has(hash)) {
    skipped.push({ input: file, reason: 'duplicate', duplicateOf: seenHash.get(hash), hash })
    return
  }
  // 同目录就地使用（不复制），跨目录来源才拷进归一目录 —— 避免把用户的数据集目录复制膨胀
  let target = file
  const inDest = path.resolve(path.dirname(file)) === path.resolve(destDir)
  if (!inDest && keepOriginals) {
    target = path.join(destDir, `${path.basename(file, path.extname(file))}_${hash.slice(0, 12)}${path.extname(file)}`)
    try { fs.copyFileSync(file, target) } catch (e) {
      errors.push(`拷贝失败 ${file}: ${(e && e.message) || e}`)
      return
    }
  }
  seenHash.set(hash, file)
  const rec = {
    path: target,
    name: path.basename(target),
    origin: file,
    originKind: 'local-file',
    role,
    sha256: hash,
    bytes: buf.length,
    width: size.width,
    height: size.height,
    format: size.format,
    shortSide: Math.min(size.width, size.height),
  }
  if (rec.shortSide < minShortSide) {
    rec.needsProcess = 'resize'
    needsProcess.push(rec)
  }
  images.push(rec)
}

/**
 * 采集结果体检：给编排层一份"能不能开训"的判断依据。
 * @returns {{ok:boolean, errors:string[], warnings:string[], stats:object}}
 */
export function checkCollection(result, { minImages = 15, maxImages = 30, minShortSide = 512 } = {}) {
  const errors = []
  const warnings = []
  const images = (result && result.images) || []
  const stats = {
    images: images.length,
    dupes: ((result && result.skipped) || []).length,
    errors: ((result && result.errors) || []).length,
    needsProcess: ((result && result.needsProcess) || []).length,
    formats: {},
    origins: {},
  }
  for (const im of images) {
    stats.formats[im.format] = (stats.formats[im.format] || 0) + 1
    stats.origins[im.originKind || im.role || 'unknown'] = (stats.origins[im.originKind || im.role || 'unknown'] || 0) + 1
  }
  if (result && Array.isArray(result.errors) && result.errors.length) {
    for (const e of result.errors) errors.push(e)
  }
  if (stats.images < minImages) errors.push(`可用图片 ${stats.images} 张，少于下限 ${minImages}（标准 15–30 张）`)
  if (stats.images > maxImages) warnings.push(`可用图片 ${stats.images} 张，超过建议上限 ${maxImages}（增加过拟合风险）`)
  if (stats.needsProcess > 0) warnings.push(`${stats.needsProcess} 张短边不足 ${minShortSide}：需要先等比放大或裁剪（本轮只标记，不改像素）`)
  if (stats.dupes > 0) warnings.push(`去重命中 ${stats.dupes} 条重复来源（同一张图只留一份）`)
  return { ok: errors.length === 0, errors, warnings, stats }
}

export default { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, isUrlLike, classifySource, expandLocalDir, extFromUrl, suggestName, collect, checkCollection }