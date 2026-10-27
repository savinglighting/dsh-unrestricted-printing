/**
 * gateway/lib/lora-registry.js — 产物投递 / 登记表 / 刷新（P4）
 *
 * 闭环的最后三公里：
 *   ① 投递：把训练产物放进 SD（A1111）真正会扫描的 LoRA 目录 —— 名字就是参数表里的名字；
 *   ② 登记：写一份人可读的登记表（名字 / 归属轨 / 档位 / dim / 步数 / 体积 / 数据量 / 耗时 / 来源摘要 / 调用语法），
 *      下次谁问"这个 LoRA 哪来的、怎么调"都不用翻日志；
 *   ③ 刷新：让正在运行的 A1111 立刻重扫 LoRA 列表（否则用户要重启才能在下拉框里看到）。
 *
 * 一个关键取舍：**刷新失败不算投递失败**。
 * SD 没启动时 refresh 必然失败，但产物已经落进 LoRA 目录，SD 下次启动自然能扫到 ——
 * 所以 refresh 的结果如实回传（ok/false + 原因）并降级为警告，绝不因此把整次炼制判成失败。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { getProfile } from './training-profiles.js'
import { namesFromFiles } from './lora-naming.js'
import { numOr } from './num.js'

export const REGISTRY_VERSION = 1
export const DEFAULT_REGISTRY_NAME = 'lora-registry.json'

/** 调用语法模板（字符串，可安全序列化） */
export function callSyntaxOf(name, weight = null) {
  const n = String(name || '').trim()
  if (!n) return null
  return weight === null || weight === undefined ? `<lora:${n}:WEIGHT>` : `<lora:${n}:${weight}>`
}

/** 来源摘要：只留类型与计数 + 域名（不把一长串本地路径或带 token 的 URL 全写进登记表） */
export function summarizeSources(sources = []) {
  const list = Array.isArray(sources) ? sources : [sources]
  const kinds = {}
  const hosts = {}
  let files = 0
  for (const s of list) {
    const kind = (s && s.kind) || 'unknown'
    kinds[kind] = (kinds[kind] || 0) + 1
    if (s && s.kind === 'local-dir' && Number.isFinite(Number(s.files))) files += Number(s.files)
    const input = String((s && s.input) || '')
    if (/^https?:\/\//i.test(input)) {
      try {
        const h = new URL(input).host
        hosts[h] = (hosts[h] || 0) + 1
      } catch { /* 非法 URL：不计入域名统计 */ }
    }
  }
  return { count: list.length, kinds, hosts, localFiles: files }
}

/** 列出现有 LoRA 文件（名 / 字节 / 修改时间） */
export function listLoraFiles({ loraDir } = {}) {
  if (!loraDir) return { ok: false, error: '缺少 LoRA 目录', files: [] }
  if (!fs.existsSync(loraDir)) return { ok: false, error: `LoRA 目录不存在: ${loraDir}`, files: [] }
  let entries = []
  try {
    entries = fs.readdirSync(loraDir, { withFileTypes: true })
  } catch (e) {
    return { ok: false, error: `读取 LoRA 目录失败: ${(e && e.message) || e}`, files: [] }
  }
  const files = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const names = namesFromFiles([e.name])
    if (!names.length) continue
    const full = path.join(loraDir, e.name)
    let st = null
    try { st = fs.statSync(full) } catch { continue }
    files.push({ name: names[0], file: full, bytes: st.size, mtime: st.mtimeMs })
  }
  return { ok: true, files: files.sort((a, b) => b.mtime - a.mtime) }
}

/**
 * 投递产物到 LoRA 目录。
 * 同名冲突由命名层在训练前就解决过（版本化），这里只做最后一道防线：
 * 目标已存在且字节数相同 → 视为已投递；已存在但不同 → 拒绝覆盖（除非 overwrite）。
 */
export function deliverArtifact({ file, loraDir, name = null, overwrite = false, copyFn = fs.copyFileSync } = {}) {
  if (!file || !fs.existsSync(file)) return { ok: false, error: `产物不存在: ${file}` }
  if (!loraDir) return { ok: false, error: '缺少 LoRA 目录（打算投递到哪里？）' }
  const finalName = String(name || namesFromFiles([path.basename(file)])[0] || '').trim()
  if (!finalName) return { ok: false, error: `无法确定目标名字（源文件: ${file}）` }
  try {
    fs.mkdirSync(loraDir, { recursive: true })
  } catch (e) {
    return { ok: false, error: `LoRA 目录不可创建: ${(e && e.message) || e}` }
  }
  const ext = path.extname(file) || '.safetensors'
  const target = path.join(loraDir, `${finalName}${ext}`)
  try {
    const srcSize = fs.statSync(file).size
    if (fs.existsSync(target)) {
      const dstSize = fs.statSync(target).size
      if (dstSize === srcSize && !overwrite) {
        return { ok: true, target, name: finalName, bytes: srcSize, copied: false, note: '目标已存在且体积一致，视为已投递' }
      }
      if (!overwrite) {
        return { ok: false, error: `目标已存在且体积不同（${dstSize} vs ${srcSize}）：为避免覆盖已有 LoRA，请改名或显式 overwrite`, target }
      }
    }
    copyFn(file, target)
    return { ok: true, target, name: finalName, bytes: srcSize, copied: true }
  } catch (e) {
    return { ok: false, error: `投递失败: ${(e && e.message) || e}` }
  }
}

/** 读登记表（不存在/损坏都返回空表，不抛） */
export function readRegistry({ file } = {}) {
  const empty = { version: REGISTRY_VERSION, updatedAt: null, loras: [] }
  if (!file) return empty
  try {
    if (!fs.existsSync(file)) return empty
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { version: j.version || REGISTRY_VERSION, updatedAt: j.updatedAt || null, loras: Array.isArray(j.loras) ? j.loras : [] }
  } catch {
    return empty
  }
}

/** 写登记表（原子写：先写临时文件再改名，避免半截 JSON） */
export function writeRegistry({ file, registry } = {}) {
  if (!file) return { ok: false, error: '缺少登记表路径' }
  const payload = { version: REGISTRY_VERSION, updatedAt: new Date().toISOString(), loras: (registry && registry.loras) || [] }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, file, count: payload.loras.length, updatedAt: payload.updatedAt }
  } catch (e) {
    return { ok: false, error: `登记表写入失败: ${(e && e.message) || e}` }
  }
}

/**
 * 组装一条登记记录（不写盘，纯组装，便于测试与上层复用）。
 * @param {object} o
 */
export function buildRecord({
  track = null,
  name,
  file = null,
  bytes = null,
  profile = null,
  steps = null,
  learningRate = null,
  module: moduleName = null,
  networkArgs = [],
  images = null,
  regImages = null,
  durationMs = null,
  sources = [],
  taskId = null,
  exitCode = null,
  extra = {},
} = {}) {
  const p = getProfile(track || profile)
  const record = {
    name: String(name || '').trim(),
    file: file || null,
    bytes: numOr(bytes),
    track: track || null,
    role: p ? p.role : null,
    module: moduleName || (p ? p.networkModule : null),
    networkArgs: networkArgs && networkArgs.length ? networkArgs : (p ? p.networkArgs : []),
    networkDim: p ? p.networkDim : null,
    networkAlpha: p ? p.networkAlpha : null,
    steps: numOr(steps, p ? p.maxTrainSteps : null),
    learningRate: numOr(learningRate, p ? p.learningRate : null),
    resolution: p ? p.resolution : null,
    images: numOr(images),
    regImages: numOr(regImages),
    durationMs: numOr(durationMs),
    taskId: taskId || null,
    exitCode: numOr(exitCode),
    createdAt: new Date().toISOString(),
    sources: summarizeSources(sources),
    call: callSyntaxOf(name),
    inferWeight: p ? p.inferWeight : null,
  }
  return { ...record, ...extra }
}

/** upsert：同名的旧记录被新记录替换（重炼同一名字时不堆历史） */
export function upsertRecord({ registry, record } = {}) {
  const loras = Array.isArray(registry && registry.loras) ? [...registry.loras] : []
  const i = loras.findIndex((r) => r && String(r.name).toLowerCase() === String(record.name).toLowerCase())
  if (i >= 0) loras.splice(i, 1, { ...loras[i], ...record, updatedAt: new Date().toISOString() })
  else loras.push(record)
  return { version: REGISTRY_VERSION, updatedAt: new Date().toISOString(), loras }
}

/**
 * 触发 A1111 重扫 LoRA 列表。
 * 返回 ok:false 只代表"没刷新成功"（例如 SD 没在跑），调用方应降级为警告 —— 文件已经落盘了。
 */
export async function refreshWebui({
  url = 'http://127.0.0.1:7860',
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = String(url).replace(/\/$/, '')
  try {
    const res = await fetchImpl(`${base}/sdapi/v1/refresh-loras`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) })
    if (!res || !res.ok) {
      return { ok: false, reason: `HTTP ${res ? res.status : 'no-response'}`, hint: 'SD 未运行或端点不可用；产物已在 LoRA 目录，SD 下次启动会自然扫到' }
    }
    return { ok: true, endpoint: `${base}/sdapi/v1/refresh-loras` }
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e), hint: 'SD 未运行或端点不可用；产物已在 LoRA 目录，SD 下次启动会自然扫到' }
  }
}

/** 列表（登记表 + 磁盘实际文件）合并视图：谁在磁盘上、谁只在表里，一目了然 */
export function mergedListing({ registry = null, loraDir = null } = {}) {
  const disk = listLoraFiles({ loraDir })
  const diskMap = new Map((disk.files || []).map((f) => [f.name.toLowerCase(), f]))
  const rows = []
  const seen = new Set()
  for (const rec of (registry && registry.loras) || []) {
    const key = String(rec.name || '').toLowerCase()
    seen.add(key)
    const d = diskMap.get(key)
    rows.push({
      name: rec.name,
      track: rec.track,
      role: rec.role,
      networkDim: rec.networkDim,
      steps: rec.steps,
      bytes: d ? d.bytes : rec.bytes,
      onDisk: !!d,
      missing: !d,
      call: rec.call || callSyntaxOf(rec.name),
      inferWeight: rec.inferWeight,
      createdAt: rec.createdAt,
      sources: rec.sources,
    })
  }
  for (const f of disk.files || []) {
    if (seen.has(f.name.toLowerCase())) continue
    rows.push({
      name: f.name,
      track: null,
      role: null,
      bytes: f.bytes,
      onDisk: true,
      missing: false,
      untracked: true,
      call: callSyntaxOf(f.name),
      createdAt: new Date(f.mtime).toISOString(),
    })
  }
  return { ok: disk.ok || rows.length > 0, error: disk.ok ? null : disk.error, loraDir, count: rows.length, rows }
}

export default {
  REGISTRY_VERSION,
  DEFAULT_REGISTRY_NAME,
  callSyntaxOf,
  summarizeSources,
  listLoraFiles,
  deliverArtifact,
  readRegistry,
  writeRegistry,
  buildRecord,
  upsertRecord,
  refreshWebui,
  mergedListing,
}