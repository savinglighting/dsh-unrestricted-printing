/**
 * gateway/lib/models.js — 模型枚举、双引擎路由、可用性探测（P1）
 *
 * 枚举与路由（用户指定语义，不可扩展）：
 *   SD_FP16        → WebUI (A1111) API
 *   Anima_INT8     → WebUI (A1111) API
 *   QwenImage_NVFP4→ ComfyUI /prompt
 *   Krea2_Q4       → ComfyUI /prompt
 *
 * 探测兜底：模型文件缺失 / 引擎离线 → 返回明确 status + detail，绝不抛错崩溃。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'

export const MODEL_KEYS = ['SD_FP16', 'Anima_INT8', 'QwenImage_NVFP4', 'Krea2_Q4']

export const MODELS = {
  SD_FP16: {
    key: 'SD_FP16',
    label: 'Stable Diffusion (FP16)',
    engine: 'webui',
    maxSide: 1536,
    stepsHint: 30,
    cfgHint: 7,
    samplerHint: 'DPM++ 2M',
    /** 出图耗时估算（秒）：只在拿不到引擎真实进度时，用来兜底算百分比 / ETA（进度条用） */
    expectedSec: 25,
    note: 'A1111 WebUI / FP16 精度，使用 WebUI 当前 checkpoint',
  },
  Anima_INT8: {
    key: 'Anima_INT8',
    label: 'Anima (INT8)',
    engine: 'webui',
    maxSide: 1536,
    stepsHint: 30,
    cfgHint: 7,
    samplerHint: 'DPM++ 2M',
    expectedSec: 25,
    note: 'A1111 WebUI / INT8 量化权重（Anima 为 SD 系，沿用 WebUI 当前 checkpoint）',
  },
  QwenImage_NVFP4: {
    key: 'QwenImage_NVFP4',
    label: 'Qwen-Image-2.1 (NVFP4)',
    engine: 'comfy',
    maxSide: 1536,
    stepsHint: 24,
    cfgHint: 1.0,   // 2026-10-19：ComfyUI 两档是 flow 蒸馏模型，cfg 必须 1（7 → 糊图+色斑，实测）
    samplerHint: 'euler',
    schedulerHint: 'normal',
    expectedSec: 90,
    // 本机已装的是同族 Q4_K_M GGUF（NVFP4 未下载时按可用性探测落到 GGUF）
    art: {
      format: 'gguf',
      unet: 'qwen-image-2.1-UC-Q4_K_M.gguf',
      unetDir: 'unet',
      clip: 'qwen3vl_8b_int8_convrot.safetensors',
      clipDir: 'text_encoders',
      clipType: 'sd3',
      vae: 'qwen_image_2.1_vae_bf16.safetensors',
      vaeDir: 'vae',
      altUnet: 'qwen-image-2.1-NVFP4.safetensors',
    },
    note: 'ComfyUI / GGUF 量化（Q4_K_M 已装；NVFP4 缺失时自动落到 GGUF）',
  },
  Krea2_Q4: {
    key: 'Krea2_Q4',
    label: 'Krea 2 (Q4)',
    engine: 'comfy',
    maxSide: 1024,
    stepsHint: 24,
    cfgHint: 1.0,   // 2026-10-19：ComfyUI 两档是 flow 蒸馏模型，cfg 必须 1（7 → 糊图+色斑，实测）
    samplerHint: 'euler',
    schedulerHint: 'normal',
    expectedSec: 60,
    // 2026-10-19 修正（权重已补齐 + 配对修正）：
    //  · unet 改为社区 GGUF（vantagewithai/Krea-2-Turbo-GGUF 的 Q4_K_M，本机已下载）
    //  · 编码器必须是 **Qwen3-VL-4B**（comfy/sd.py:1983 明确 `CLIPType.KREA2 and te_model == QWEN3VL_4B`），
    //    原来配的是 8B，尺寸对不上 → 加载必失败。
    //  · clipType 从 sd3 改为 krea2（错误的 sd3 会让它落到通用 qwen3vl 兜底，模板不对）
    art: {
      format: 'gguf',
      unet: 'krea2_turbo-Q4_K_M.gguf',
      unetDir: 'unet',
      clip: 'qwen3-vl-4b-heretic_int8.safetensors',
      clipDir: 'text_encoders',
      clipType: 'krea2',
      vae: 'krea2-vae.safetensors',     // 2026-10-19：VAE 必须用 Krea2 自己的（qwen VAE 是 16 通道，Krea2 要 64 → VAEDecode 报 64 vs 16）
      vaeDir: 'vae',
    },
    note: 'ComfyUI / GGUF Q4_K_M（Krea2 Turbo）+ Qwen3-VL-4B 编码器 + krea2-vae',
  },
}

/** 模型 key 校验（严格白名单，非法返回 null） */
export function normalizeModel(raw) {
  if (raw === undefined || raw === null) return null
  const key = String(raw).trim()
  return MODEL_KEYS.includes(key) ? key : null
}

/** 路由：模型 → 引擎（'webui' | 'comfy'） */
export function routeFor(modelKey) {
  const m = MODELS[modelKey]
  return m ? m.engine : null
}

/** 引擎 → 领域模型（同引擎的多个枚举共享实现） */
export function modelsForEngine(engine) {
  return MODEL_KEYS.filter((k) => MODELS[k].engine === engine)
}

/**
 * 尺寸校验：Krea2_Q4 宽或高 > 1024 直接拒绝（P5 表单与网关双保险）。
 * @returns {{ok:boolean, reason?:string, maxSide:number}}
 */
export function checkSize(modelKey, width, height) {
  const m = MODELS[modelKey]
  if (!m) return { ok: false, reason: `未知模型: ${modelKey}`, maxSide: 0 }
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, reason: `宽高必须为正整数（收到 ${width}x${height}）`, maxSide: m.maxSide }
  }
  if (w % 8 !== 0 || h % 8 !== 0) {
    return { ok: false, reason: `宽高必须是 8 的倍数（收到 ${w}x${h}）`, maxSide: m.maxSide }
  }
  if (modelKey === 'Krea2_Q4' && (w > 1024 || h > 1024)) {
    return { ok: false, reason: `Krea2_Q4 宽/高不得超过 1024（收到 ${w}x${h}）`, maxSide: 1024 }
  }
  if (Math.max(w, h) > m.maxSide) {
    return { ok: false, reason: `${modelKey} 长边不得超过 ${m.maxSide}（收到 ${w}x${h}）`, maxSide: m.maxSide }
  }
  return { ok: true, maxSide: m.maxSide }
}

/** 兼容旧调用名（sizeAllowed 语义：超限返回 false） */
export function sizeAllowed(modelKey, width, height) {
  return checkSize(modelKey, width, height).ok
}

// ---------------- 可用性探测 ----------------

/** 在 ComfyUI 模型目录里找文件（离线兜底，不依赖 HTTP） */
function findLocalModelFile(comfyDir, folder, name) {
  if (!comfyDir || !name) return null
  const dir = path.join(comfyDir, 'models', folder)
  try {
    if (!fs.existsSync(dir)) return null
    const stack = [dir]
    while (stack.length) {
      const d = stack.pop()
      let entries = []
      try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const full = path.join(d, e.name)
        if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full
        if (e.isDirectory()) stack.push(full)
      }
    }
  } catch { /* 权限问题：当作找不到 */ }
  return null
}

/**
 * 探测一个模型的可用性。
 * @param {string} key 模型 key
 * @param {object} deps { httpGetJson, comfyDir, comfyAvailable, webuiCheckpoint, comfyFiles }
 * @returns {{key, engine, status:'ok'|'offline'|'no-model', detail, missing:string[]}}
 */
export function probeModelSync(key, deps = {}) {
  const m = MODELS[key]
  if (!m) return { key, engine: null, status: 'unknown', detail: `未知模型: ${key}`, missing: [] }
  const missing = []

  if (m.engine === 'webui') {
    // WebUI：服务在线 + 有可用 checkpoint
    const online = deps.webuiOnline === true
    const ckpt = deps.webuiCheckpoint || null
    if (!online) return { key, engine: m.engine, status: 'offline', detail: `${m.note} / WebUI 服务未响应`, missing: [] }
    if (!ckpt) return { key, engine: m.engine, status: 'no-model', detail: `${m.note} / WebUI 未加载任何 checkpoint`, missing: ['checkpoint'] }
    return { key, engine: m.engine, status: 'ok', detail: `${m.note} / ${ckpt}`, missing: [] }
  }

  // ComfyUI：服务在线 + unet/clip/vae 三件套到位
  const online = deps.comfyOnline === true
  const a = m.art || {}
  const listed = deps.comfyFiles || null // { unet:Set, text_encoders:Set, vae:Set }（来自 /models/{folder}）
  const has = (folder, name) => {
    if (!name) return false
    if (listed && listed[folder] && listed[folder].has(name.toLowerCase())) return true
    return !!findLocalModelFile(deps.comfyDir, folder, name)
  }
  const unetOk = has(a.unetDir, a.unet) || (a.altUnet ? has(a.unetDir, a.altUnet) : false)
  if (!unetOk) missing.push(`${a.unetDir}/${a.unet}`)
  if (!has(a.clipDir, a.clip)) missing.push(`${a.clipDir}/${a.clip}`)
  if (!has(a.vaeDir, a.vae)) missing.push(`${a.vaeDir}/${a.vae}`)
  if (!online) return { key, engine: m.engine, status: 'offline', detail: `${m.note} / ComfyUI 服务未响应`, missing }
  if (missing.length) return { key, engine: m.engine, status: 'no-model', detail: `${m.note} / 缺少模型文件: ${missing.join(', ')}`, missing }
  return { key, engine: m.engine, status: 'ok', detail: m.note, missing: [] }
}

/** 探测全部 4 个枚举 */
export function probeAllSync(deps = {}) {
  return MODEL_KEYS.map((k) => probeModelSync(k, deps))
}

export { findLocalModelFile }
