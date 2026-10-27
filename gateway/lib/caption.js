/**
 * gateway/lib/caption.js — 自动标注（P3）
 *
 * 复用本机**已有的**视觉通道（Ollama，默认 `http://127.0.0.1:11434`，模型 `qwen3-vl:8b`），
 * 把每张图转成「只描述可变元素」的英文标签。
 *
 * 三条硬规则：
 *   1. 标注铁律进指令层：明确禁止角色名、人名、作品名、系列名、触发词、`<lora:>` 语法；
 *      模型输出后**再过一遍 sanitizeCaption**（不信任模型，双向兜底）。
 *   2. 视觉模型不可用时**不糊弄**：不会拿一份通用模板铺满所有图（那等于让模型学"所有图都一样"）。
 *      此时如实返回失败，由调用方改用用户提供的标注或侧车 txt。
 *   3. 并发受限：视觉模型与训练抢显存，标注阶段不需要把显存吃满。
 *
 * ── 本机 qwen3-vl:8b 的实测结论（2026-10-22，改了会踩坑）──
 *   ① 它是**推理型**模型：先产出 2000+ 字符 thinking，再给正文。
 *   ② `think:false` **无效**（实测仍出 1388 字符思考）—— 关不掉，只能给足 token 预算。
 *   ③ token 预算太小（120/300）时 token 全耗在 thinking 里 → 正文空串、done_reason=length，
 *      表现得像「模型看不了图」的假故障。实测 900 预算 → done_reason=stop、约 30 个标签、单张 136 秒。
 *   ④ 原生端点比 OpenAI 兼容端点稳（兼容端点在本机会返回空），所以原生优先、兼容兜底。
 *   ⑤ 指令要写「立即以标签开头 + 钉死允许的标签类型」：只说「List tags」时模型会先长篇分析，
 *      思考链能到 3580 字符、把预算吃光；改成强约束后单张 53 秒、851 token 正常出标签。
 *   ⑥ **并发是负优化**：串行单张 22–45 秒；并发 4 路争抢同一模型时 20 分钟跑不完 23 张。
 *      所以 DEFAULT_CONCURRENCY = 1。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { sanitizeCaption, CAPTION_MAX_TAGS } from './dataset.js'

export const DEFAULT_VLM_BASE = 'http://127.0.0.1:11434/v1'
export const DEFAULT_VLM_MODEL = 'qwen3-vl:8b'
/** 单张超时：推理型模型单张 53–136 秒，90 秒会把正常调用误判成超时 */
export const DEFAULT_TIMEOUT_MS = 240000
/** 输出预算：必须给足，否则 thinking 吃光 token、正文为空（见文件头实测结论 ③） */
export const DEFAULT_MAX_TOKENS = 1500
/**
 * 并发默认 **1（串行）** —— 这是实测出来的，不是保守：
 *   · 串行：单张 22–45 秒，23 张约 8–12 分钟；
 *   · 并发 4：同一张 8B 模型被 4 路争抢，实测 20 分钟仍未跑完 23 张（平均反而更慢，
 *     且大量请求撞 240 秒超时）—— 在 8GB 显卡上并发是**负优化**。
 * 显存更充裕的机器可显式传大（上限 8），但默认走串行。
 */
export const DEFAULT_CONCURRENCY = 1

/** 标注器系统指令（英文，直接决定模型只说不该说的话的边界） */
export const CAPTION_SYSTEM_PROMPT = [
  'You are a dataset captioner for Stable Diffusion LoRA training.',
  'Output ONLY a single line of comma-separated English tags.',
  'Describe variable elements only: setting/scene, clothing, composition (close-up | upper body | full body), lighting, pose, expression.',
  'NEVER include: character names, person names, artist names, franchise or series names, trigger words, identity tokens, or any <lora:...> syntax.',
  'NEVER explain, never use sentences, never number items, never add quotes.',
].join(' ')

/** 分轨侧重（ID 轨要脸的可变细节，Base 轨要服装与场景，两者都不许写身份） */
export const PROFILE_FOCUS = {
  id: 'Focus on face-region variability: hairstyle, hair color, eye color, expression, framing of the face, lighting on the face. Keep clothing words generic and few.',
  base: 'Focus on outfit, setting and framing. Prefer half-body, full-body and scene descriptions. Mention the face only when the composition demands it.',
}

/** 组装给模型的用户指令（纯函数，便于测试断言"铁律确实进了提示词"） */
export function buildCaptionPrompt({ profile = 'id', bannedTokens = [], extraTags = [] } = {}) {
  const parts = [
    // 关键实测（结论 ⑤）：要求「立即以标签开头 + 钉死允许的标签类型」，
    // 能把思考链从 3580 字符压到可控范围、单张 53 秒出结果；
    // 只说「List tags」时模型会先长篇分析，token 预算容易被吃光。
    'Output a single line of comma-separated English tags for this image. Start your reply with the tags immediately.',
    'Allowed tag types only: composition (closeup / upper body / full body), clothing items, hair color and style, eye color, scene, lighting.',
    'No thinking, no explanation, no sentences.',
  ]
  parts.push('Never output character names, person names, work titles, trigger words or <lora:> syntax.')
  parts.push(PROFILE_FOCUS[String(profile).toLowerCase()] || PROFILE_FOCUS.id)
  if (bannedTokens && bannedTokens.length) {
    parts.push(`Forbidden words (must not appear, in any form): ${bannedTokens.map((t) => String(t)).join(', ')}.`)
  }
  if (extraTags && extraTags.length) {
    parts.push(`Ground-truth tags the user wants represented where accurate: ${extraTags.map((t) => String(t)).join(', ')}.`)
  }
  parts.push('Tags only, one line.')
  return parts.join(' ')
}

export function mimeOf(file) {
  const ext = String(path.extname(String(file))).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  return 'application/octet-stream'
}

/** 视觉通道是否可用（只看端点是否应答，不拉模型） */
export async function checkVlmReachable({
  vlmBase = DEFAULT_VLM_BASE,
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = String(vlmBase).replace(/\/$/, '')
  const probe = base.replace(/\/v1$/, '')
  try {
    const res = await fetchImpl(`${probe}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res || !res.ok) return { ok: false, reason: `HTTP ${res ? res.status : 'no-response'}` }
    const j = await res.json().catch(() => null)
    const models = Array.isArray(j && j.models) ? j.models.map((m) => String(m.name || m.model || '')) : []
    return { ok: true, models, visionCandidates: models.filter((m) => /vl|vision|llava|minicpm-v/i.test(m)) }
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) }
  }
}

/**
 * 预热视觉模型（**必须**在批量标注前调用）。
 *
 * 本机实测（2026-10-22，Ollama + qwen3-vl:8b）：
 *   模型刚加载后的**第一次请求**会立刻返回 `done_reason=load` + 空内容（耗时 0.1–4.8 秒），
 *   之后同一模型的请求全部正常（23.7 秒、713 token、标签完整）。
 *   不预热就会把「第一次空返回」误判成「模型看不了图」，批量标注开头几张全部失败。
 *
 * 做法：发一次极短的纯文本请求把模型拉进推理态。失败也不阻断（只是没预热成功）。
 */
export async function warmupVlm({
  vlmBase = DEFAULT_VLM_BASE,
  vlmModel = DEFAULT_VLM_MODEL,
  timeoutMs = 180000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = String(vlmBase).replace(/\/$/, '').replace(/\/v1$/, '')
  try {
    const res = await fetchImpl(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: vlmModel, prompt: 'ok', stream: false, options: { num_predict: 8 } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res || !res.ok) return { ok: false, reason: `HTTP ${res ? res.status : 'n/a'}` }
    const j = await res.json().catch(() => null)
    return { ok: true, doneReason: (j && j.done_reason) || null }
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) }
  }
}

/**
 * 统一视觉调用：原生端点优先（本机实测最稳），OpenAI 兼容端点兜底。
 * 两个端点都失败时如实返回原因（含 done_reason，便于判断是不是 token 预算问题）。
 *
 * @returns {Promise<{ok:boolean, text?:string, endpoint?:string, ms?:number, error?:string}>}
 */
export async function callVision({
  imagePath,
  system = null,
  user = '',
  vlmBase = DEFAULT_VLM_BASE,
  vlmModel = DEFAULT_VLM_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  maxTokens = DEFAULT_MAX_TOKENS,
} = {}) {
  if (!imagePath || !fs.existsSync(imagePath)) return { ok: false, error: `图片不存在: ${imagePath}` }
  let buf
  try {
    buf = fs.readFileSync(imagePath)
  } catch (e) {
    return { ok: false, error: `读取失败: ${(e && e.message) || e}` }
  }
  const b64 = buf.toString('base64')
  const dataUri = `data:${mimeOf(imagePath)};base64,${b64}`
  const base = String(vlmBase).replace(/\/$/, '')
  const nativeBase = base.replace(/\/v1$/, '')
  const t0 = Date.now()
  const failures = []

  // ① Ollama 原生端点：vision 走 images 数组（base64 不带前缀）
  //    刻意不发 system role：本机 qwen3-vl 在「system 规则 + user 规则」双份叠加时会空返。
  //    预算自适应：thinking 长度会波动（实测 3580 字符→851 token 够用，个别图会超），
  //    命中 done_reason=length 就**自动加倍重试一次**，而不是直接判失败。
  const budget = [maxTokens, Math.round(maxTokens * 2)]
  for (let attempt = 0; attempt < budget.length; attempt++) {
    try {
      const merged = system ? `${system}\n\n${user}` : user
      const res = await fetchImpl(`${nativeBase}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: vlmModel,
          stream: false,
          messages: [{ role: 'user', content: merged, images: [b64] }],
          options: { temperature: 0.1, num_predict: budget[attempt] },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res && res.ok) {
        const j = await res.json()
        const text = String(j?.message?.content ?? j?.response ?? '').trim()
        if (text) return { ok: true, text, endpoint: 'ollama-native', ms: Date.now() - t0, attempts: attempt + 1 }
        const reason = j?.done_reason || 'unknown'
        // done_reason=load：模型刚加载完的边界返回（实测首次请求必现）。
        // 这不是失败，等它进入推理态后重试同一张即可。
        if (reason === 'load' && attempt < budget.length - 1) {
          failures.push('原生端点 done_reason=load（模型刚加载，重试）')
          continue
        }
        const last = attempt === budget.length - 1
        failures.push(
          `原生端点空内容(done_reason=${reason}${reason === 'length' && last ? `：预算 ${budget[attempt]} 仍被 thinking 吃光` : ''})`,
        )
        if (reason !== 'length') break // 不是预算问题，加倍也没用
      } else {
        failures.push(`原生端点 HTTP ${res ? res.status : 'n/a'}`)
        break
      }
    } catch (e) {
      failures.push(`原生端点异常: ${(e && e.message) || e}`)
      break
    }
  }

  // ② OpenAI 兼容端点兜底
  try {
    const messages = []
    if (system) messages.push({ role: 'system', content: system })
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: user },
        { type: 'image_url', image_url: { url: dataUri } },
      ],
    })
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: vlmModel, temperature: 0.1, max_tokens: maxTokens, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res && res.ok) {
      const j = await res.json()
      const text = String(j?.choices?.[0]?.message?.content ?? j?.message?.content ?? '').trim()
      if (text) return { ok: true, text, endpoint: 'openai-compat', ms: Date.now() - t0 }
      failures.push('兼容端点空内容')
    } else {
      failures.push(`兼容端点 HTTP ${res ? res.status : 'n/a'}`)
    }
  } catch (e) {
    failures.push(`兼容端点异常: ${(e && e.message) || e}`)
  }

  return { ok: false, error: failures.join('；') || '视觉模型调用失败', ms: Date.now() - t0 }
}

/**
 * 给单张图打标注。
 * @returns {Promise<{ok:boolean, text?:string, raw?:string, error?:string, removed?:string[], endpoint?:string, ms?:number}>}
 */
export async function captionImage({
  imagePath,
  profile = 'id',
  bannedTokens = [],
  extraTags = [],
  vlmBase = DEFAULT_VLM_BASE,
  vlmModel = DEFAULT_VLM_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  maxTokens = DEFAULT_MAX_TOKENS,
} = {}) {
  const r = await callVision({
    imagePath,
    system: null,
    user: buildCaptionPrompt({ profile, bannedTokens, extraTags }),
    vlmBase,
    vlmModel,
    timeoutMs,
    fetchImpl,
    maxTokens,
  })
  if (!r.ok) return { ok: false, error: r.error, ms: r.ms }
  const raw = r.text
  // 不信任模型输出：一律再净化一遍
  const s = sanitizeCaption(raw, { bannedTokens, maxTags: CAPTION_MAX_TAGS })
  if (!s.text) return { ok: false, error: `标注净化后为空（原始: ${raw.slice(0, 80)}）`, raw }
  return { ok: true, text: s.text, raw, removed: s.removed, warnings: s.warnings, endpoint: r.endpoint, ms: r.ms }
}

/**
 * 批量标注（受限并发）。任一张失败都会被记账，**不会**用兜底文本糊过去。
 * @returns {Promise<{ok:boolean, captions:Object, failed:Array, errors:string[], removed:Array}>}
 */
export async function captionBatch({
  images = [],
  concurrency = DEFAULT_CONCURRENCY,
  onProgress = null,
  /** 批量前先预热（本机首次请求必返 done_reason=load 空内容，不预热开头几张会白失败） */
  warmup = true,
  warmupFn = warmupVlm,
  ...rest
} = {}) {
  const captions = {}
  const failed = []
  const errors = []
  const removed = []
  let warmupResult = null
  if (warmup && images.length) {
    try {
      warmupResult = await warmupFn({ vlmBase: rest.vlmBase, vlmModel: rest.vlmModel, fetchImpl: rest.fetchImpl })
    } catch (e) {
      warmupResult = { ok: false, reason: (e && e.message) || String(e) }
    }
  }
  const limit = Math.max(1, Math.min(8, Number(concurrency) || DEFAULT_CONCURRENCY))
  let idx = 0
  let done = 0
  const workers = Array.from({ length: Math.min(limit, images.length) }, async () => {
    while (idx < images.length) {
      const i = idx++
      const img = images[i]
      const file = typeof img === 'string' ? img : img.path
      const r = await captionImage({ imagePath: file, ...rest })
      done++
      if (r.ok) {
        captions[file] = r.text
        if (r.removed && r.removed.length) removed.push({ file, removed: r.removed })
      } else {
        failed.push({ file, error: r.error })
        errors.push(`${file}: ${r.error}`)
      }
      if (onProgress) {
        try { onProgress({ done, total: images.length, file, ok: r.ok }) } catch { /* 进度回调不该反过来炸 */ }
      }
    }
  })
  await Promise.all(workers)
  return { ok: failed.length === 0 && images.length > 0, captions, failed, errors, removed, warmup: warmupResult }
}

/**
 * 侧车标注复用：图片同目录同名 `.txt` 直接可用（很多素材站/工具链都这么给）。
 * @returns {{file:string, text:string, source:'sidecar'}[]}
 */
export function readSidecarCaptions(images = []) {
  const out = []
  for (const img of images) {
    const file = typeof img === 'string' ? img : img.path
    const txt = String(file).replace(/\.[^.]+$/, '.txt')
    try {
      if (fs.existsSync(txt)) {
        const raw = fs.readFileSync(txt, 'utf8').trim()
        if (raw) out.push({ file, text: raw, source: 'sidecar' })
      }
    } catch { /* 读不到就当没有侧车标注 */ }
  }
  return out
}

/** 只在不指定自动标注时使用的**显式**占位（默认流程不会走到这里） */
export function placeholderCaption(profile = 'id') {
  return String(profile).toLowerCase() === 'base'
    ? 'woman, full body, dress, garden, sunlight'
    : 'woman, portrait, upper body, detailed face'
}

export default {
  DEFAULT_VLM_BASE,
  DEFAULT_VLM_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_CONCURRENCY,
  CAPTION_SYSTEM_PROMPT,
  PROFILE_FOCUS,
  buildCaptionPrompt,
  mimeOf,
  checkVlmReachable,
  warmupVlm,
  callVision,
  captionImage,
  captionBatch,
  readSidecarCaptions,
  placeholderCaption,
}
