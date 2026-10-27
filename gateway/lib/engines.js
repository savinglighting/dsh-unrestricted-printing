/**
 * gateway/lib/engines.js — 双引擎客户端（P1）
 *   webui → A1111 /sdapi/v1/txt2img | img2img（SD_FP16 / Anima_INT8）
 *   comfy → ComfyUI /prompt + /history 轮询 + /view 下载（QwenImage_NVFP4 / Krea2_Q4）
 *
 * 约定：
 *   · 所有网络调用都带硬超时（AbortController），失败返回 { ok:false, error, errorType }，不抛；
 *   · 超时/连接类失败上报熔断器（P6 超时熔断）；
 *   · ComfyUI 工作流按 /object_info 的实际可用节点构建（缺节点时降级并明确记录）。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { isTimeoutOrConnError } from './breaker.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 错误分类：决定是否计入熔断、是否能走 OOM 阶梯、是否需要引擎自愈 */
export function classifyError(msg) {
  const s = String(msg || '')
  // HalfTensor/同设备报错长得像显存问题，实际是「模型设备错位」（unload 之后必崩）——
  // 单独分类，交给 reload-checkpoint 自愈，而不是走 OOM 阶梯（重启整台引擎）。
  if (/HalfTensor|should be the same device|Expected all tensors to be on the same device|device mismatch|同设备/i.test(s)) return 'device-mismatch'
  if (/CUDA out of memory|OutOfMemoryError|Not enough memory|Failed to allocate|cudaMalloc|out of memory|显存不足/i.test(s)) return 'oom'
  // A1111 的 500 常常只给一句 `ExceptionGroup`（真正的 RuntimeError 只在它自己的控制台里，
  // 实测 2026-10-18：设备错位/OOM 都以这个空壳形态返回）→ 当作「可疑状态」，走一次自愈重试。
  // 自愈只给一次机会，失败就把原始错误如实抛给调用方（不掩盖真实问题）。
  if (/ExceptionGroup/i.test(s)) return 'device-mismatch'
  if (isTimeoutOrConnError(s)) return 'timeout'
  if (/no-model|缺少模型|model not found|missing/i.test(s)) return 'model'
  return 'engine'
}

export class EngineClients {
  constructor({
    webuiUrl,
    comfyUrl,
    fetchImpl = globalThis.fetch,
    log = null,
    breaker = null,
    timeouts = {},
  } = {}) {
    this.webuiUrl = (webuiUrl || '').replace(/\/+$/, '')
    this.comfyUrl = (comfyUrl || '').replace(/\/+$/, '')
    this.fetch = fetchImpl
    this.log = log
    this.breaker = breaker
    this.timeouts = {
      short: timeouts.shortMs ?? 15000,
      generate: timeouts.generateMs ?? 1800000,
      poll: timeouts.pollMs ?? 10000,
      ready: timeouts.engineReadyMs ?? 240000,
    }
    /** object_info 缓存（构建工作流用） */
    this._objectInfo = null
    this._objectInfoAt = 0
  }

  // ---------------- 低层 HTTP ----------------

  async request(url, { method = 'GET', body = null, timeoutMs = this.timeouts.short, engine = null, raw = false, headers = {}, quiet = false } = {}) {
    if (engine && this.breaker && !this.breaker.allow(engine)) {
      const st = this.breaker.state(engine)
      return { ok: false, error: `circuit open（${engine} 连续失败 ${st.failures} 次，${Math.round(st.retryAfterMs / 1000)}s 后重试）`, errorType: 'circuit', status: 0 }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    try {
      res = await this.fetch(url, {
        method,
        body,
        headers: body ? { 'Content-Type': 'application/json; charset=utf-8', ...headers } : headers,
        signal: controller.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      const msg = e && e.name === 'AbortError' ? `请求超时 ${timeoutMs}ms: ${url}` : `请求失败: ${(e && e.message) || e}`
      const t = classifyError(msg)
      // 只把「超时/连接」类计入熔断（P6 超时熔断）；业务错误（400/404/模型缺失）不熔断
      if (this.breaker && t === 'timeout') this.breaker.recordFailure(engine || url, msg)
      this.log?.('warn', 'http.error', { url, method, timeoutMs, error: msg, errorType: t })
      return { ok: false, error: msg, errorType: t, status: 0 }
    }
    try {
      const text = await res.text()
      if (!res.ok) {
        const msg = `HTTP ${res.status} ${url} ${text.slice(0, 300)}`
        const t = classifyError(msg)
        if (this.breaker && t === 'timeout') this.breaker.recordFailure(engine || url, msg)
        // quiet：探测类请求（如 /models/{folder} 在老版本 ComfyUI 上是 404）不刷 warn
        this.log?.(quiet ? 'debug' : 'warn', 'http.bad_status', { url, status: res.status, body: text.slice(0, 300) })
        return { ok: false, error: msg, errorType: t, status: res.status, body: text }
      }
      if (this.breaker && engine) this.breaker.recordSuccess(engine)
      if (raw) return { ok: true, status: res.status, text, res }
      let json = null
      try { json = text ? JSON.parse(text) : null } catch (e) {
        this.log?.('warn', 'http.bad_json', { url, body: text.slice(0, 200), error: e })
        return { ok: false, error: `响应不是合法 JSON: ${text.slice(0, 200)}`, errorType: 'engine', status: res.status }
      }
      return { ok: true, status: res.status, json }
    } finally {
      clearTimeout(timer)
    }
  }

  async getJson(url, { timeoutMs, engine } = {}) {
    const r = await this.request(url, { timeoutMs, engine })
    return r.ok ? r.json : null
  }

  // ---------------- 引擎可用性 ----------------

  /** WebUI 是否就绪；返回 { online, checkpoint } */
  async probeWebui() {
    const r = await this.request(`${this.webuiUrl}/sdapi/v1/options`, { timeoutMs: Math.min(this.timeouts.short, 8000) })
    if (!r.ok) return { online: false, checkpoint: null, error: r.error }
    const opt = r.json || {}
    return { online: !!opt, checkpoint: opt.sd_model_checkpoint || null }
  }

  /** ComfyUI 是否就绪；返回 { online, queue } */
  async probeComfy() {
    const r = await this.request(`${this.comfyUrl}/queue`, { timeoutMs: Math.min(this.timeouts.short, 8000) })
    if (!r.ok) return { online: false, error: r.error }
    return { online: true, queue: r.json }
  }

  /** ComfyUI 释放显存：新版有 POST /free（卸载模型 + 清缓存）；老版退回 /free?unload_models=true。
   *  用于跨架构 bridge 的 Stage1（SD_FP16 走 WebUI）前，把 ComfyUI 常驻的 DiT 模型卸掉，
   *  避免 8G 卡上「ComfyUI 占显存 → WebUI 加载 checkpoint OOM」。
   *  任何失败都静默降级（不阻断出图，OOM 阶梯会兜底）。 */
  async comfyFreeVram() {
    for (const ep of ['/free', '/free?unload_models=true&free_memory=true']) {
      try {
        const r = await this.request(`${this.comfyUrl}${ep}`, { method: 'POST', body: '{}', timeoutMs: 15000, quiet: true })
        if (r.ok) {
          this.log?.('info', 'comfy.free_vram_ok', { ep })
          return { ok: true, ep }
        }
      } catch { /* 端点不存在/超时都静默，绝不阻断 */ }
    }
    this.log?.('warn', 'comfy.free_vram_unavailable', { note: 'ComfyUI 无 /free 端点或未响应；交给 OOM 阶梯兜底' })
    return { ok: false }
  }

  /** ComfyUI 模型文件清单（/models/{folder}，失败返回 null 交给 fs 兜底） */
  async comfyModelFiles(folders = ['unet', 'text_encoders', 'vae']) {
    const out = {}
    let anyOk = false
    for (const f of folders) {
      const r = await this.request(`${this.comfyUrl}/models/${encodeURIComponent(f)}`, { timeoutMs: 6000, quiet: true })
      if (r.ok && Array.isArray(r.json)) {
        out[f] = new Set(r.json.map((s) => String(s).toLowerCase()))
        anyOk = true
      } else if (r.ok && r.json && Array.isArray(r.json.items)) {
        out[f] = new Set(r.json.items.map((s) => String(s).toLowerCase()))
        anyOk = true
      }
    }
    if (!anyOk) this.log?.('debug', 'comfy.models_endpoint_unavailable', { note: '改用本地模型目录探测' })
    return anyOk ? out : null
  }

  /** 等到引擎 API 就绪（重启后用） */
  async waitReady(engine, timeoutMs = this.timeouts.ready) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ok = engine === 'webui' ? (await this.probeWebui()).online : (await this.probeComfy()).online
      if (ok) return true
      await sleep(2000)
    }
    return false
  }

  /** WebUI 自愈：设备错位（HalfTensor / 同设备报错）时重新加载 checkpoint。
   *  坑47（历史交接）：unload-checkpoint 会诱发 HalfTensor 必崩，reload-checkpoint 才能救回来；
   *  坑62（2026-10-18）：sd-inject 侧"释放显存"会调用 unload，之后网关再出图就 500
   *  → 网关必须自己会 reload 自愈，而不是把 500 直接甩给用户。 */
  async webuiReloadCheckpoint() {
    const r = await this.request(`${this.webuiUrl}/sdapi/v1/reload-checkpoint`, { method: 'POST', body: '{}', timeoutMs: 300000 })
    if (!r.ok) {
      this.log?.('warn', 'webui.reload_checkpoint_failed', { error: r.error })
      return { ok: false, error: r.error }
    }
    this.log?.('warn', 'webui.reload_checkpoint_ok', {})
    return { ok: true }
  }

  // ---------------- WebUI 出图 ----------------

  /**
   * @param {object} p
   * @returns {Promise<{ok:boolean, imagesB64?:string[], seed?:number, error?:string, errorType?:string}>}
   */
  async webuiGenerate({
    prompt, negative = '', initImage = '', mask = '',
    width = 512, height = 768, steps = 30, cfg = 7, denoise = 0,
    sampler = 'DPM++ 2M', seed = -1, checkpoint = null, adetailerFace = true,
    maskBlur = 4, inpaintFill = 0, inpaintFullRes = true, inpaintPadding = 32, extra = null,
  } = {}) {
    const engine = 'webui'
    const body = {
      prompt,
      negative_prompt: negative,
      width: Math.round(width),
      height: Math.round(height),
      steps: Math.round(steps),
      cfg_scale: cfg,
      seed: seed >= 0 ? Math.round(seed) : -1,
      sampler_name: sampler,
      denoising_strength: denoise > 0 ? denoise : 0.6,
    }
    // 2026-10-19：显式 restore_afterwards —— 画风/模型切换**只对本次请求生效**。
    // 以前只给 override_settings，A1111 在部分版本里会把 checkpoint 留在切换后的状态，
    // 下一次不带 checkpoint 的请求就继续用上次那个底模 → 用户看到的「画风改不回来、时好时坏」。
    if (checkpoint) {
      body.override_settings = { sd_model_checkpoint: checkpoint }
      body.override_settings_restore_afterwards = true
    }
    // 透传扩展参数（hires fix / restore_faces / 自定义 alwayson_scripts 等）：
    // 由调用方给出，网关只做「不覆盖核心字段」的合并，保证前端仍只跟网关说话。
    if (extra && typeof extra === 'object') {
      for (const [k, v] of Object.entries(extra)) {
        if (k in body) {
          this.log?.('debug', 'webui.extra_skipped', { key: k, note: '核心字段不接受透传覆盖' })
          continue
        }
        body[k] = v
      }
    }

    let url = `${this.webuiUrl}/sdapi/v1/txt2img`
    if (initImage && fs.existsSync(initImage)) {
      url = `${this.webuiUrl}/sdapi/v1/img2img`
      try {
        body.init_images = [fs.readFileSync(initImage).toString('base64')]
      } catch (e) {
        return { ok: false, error: `底图读取失败: ${initImage} → ${e && e.message}`, errorType: 'engine' }
      }
      if (mask && fs.existsSync(mask)) {
        try {
          body.mask = fs.readFileSync(mask).toString('base64')
        } catch (e) {
          return { ok: false, error: `蒙版读取失败: ${mask} → ${e && e.message}`, errorType: 'engine' }
        }
        body.mask_blur = Number.isFinite(Number(maskBlur)) ? Number(maskBlur) : 4
        body.inpainting_fill = Number.isFinite(Number(inpaintFill)) ? Number(inpaintFill) : 0
        body.inpaint_full_res = inpaintFullRes !== false
        body.inpaint_full_res_padding = Number.isFinite(Number(inpaintPadding)) ? Number(inpaintPadding) : 32
      }
    }
    // ADetailer 面部修复：**文生图与图生图都要加**（2026-10-19 修）
    // 原来这里是 `} else if (adetailerFace) {`，只有无底图（txt2img）时才注入 →
    // 图生图 / 蒙版重绘路径结构性没有面部修复，用户看到的「图生图脸更崩」就是它。
    // 现在无论走 txt2img 还是 img2img 都注入；调用方显式给 adetailerFace=false 才会关。
    if (adetailerFace && !body.alwayson_scripts) {
      body.alwayson_scripts = {
        ADetailer: {
          args: [{ ad_model: 'face_yolov8s.pt', ad_prompt: '', ad_negative_prompt: '' }],
        },
      }
    }

    const r = await this.request(url, {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: this.timeouts.generate,
      engine,
    })
    if (!r.ok) return { ok: false, error: r.error, errorType: r.errorType }
    const out = r.json || {}
    if (!out.images || !out.images.length) {
      return { ok: false, error: 'WebUI 未返回图片', errorType: 'engine', raw: JSON.stringify(out).slice(0, 300) }
    }
    return { ok: true, imagesB64: out.images, seed: out.seed, info: out.info }
  }

  // ---------------- ComfyUI 出图 ----------------

  /** 读取 /object_info（带缓存），用于按可用节点构建工作流 */
  async objectInfo(force = false) {
    const ttl = 60000
    if (!force && this._objectInfo && Date.now() - this._objectInfoAt < ttl) return this._objectInfo
    const r = await this.request(`${this.comfyUrl}/object_info`, { timeoutMs: 20000 })
    if (!r.ok) return this._objectInfo
    this._objectInfo = r.json
    this._objectInfoAt = Date.now()
    return this._objectInfo
  }

  /** 选 unet 加载节点：优先标准 GGUF 节点，退化到 qwen-adapter 的专用节点 */
  async pickUnetLoader() {
    const info = await this.objectInfo()
    const has = (k) => !!(info && info[k])
    if (has('UnetLoaderGGUF')) return 'UnetLoaderGGUF'
    if (has('UNETLoader')) return 'UNETLoader'
    if (has('QwenImageModelLoader')) return 'QwenImageModelLoader'
    return 'UnetLoaderGGUF'
  }

  async comfyUploadImage(filePath, remoteName) {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: `底图不存在: ${filePath}` }
    let buf
    try { buf = fs.readFileSync(filePath) } catch (e) {
      return { ok: false, error: `底图读取失败: ${e && e.message}` }
    }
    const fd = new FormData()
    fd.append('image', new Blob([buf]), remoteName || path.basename(filePath))
    fd.append('overwrite', 'true')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120000)
    try {
      const res = await this.fetch(`${this.comfyUrl}/upload/image`, { method: 'POST', body: fd, signal: controller.signal })
      const text = await res.text()
      if (!res.ok) return { ok: false, error: `上传失败 HTTP ${res.status}: ${text.slice(0, 200)}` }
      let json = {}
      try { json = JSON.parse(text) } catch { return { ok: false, error: `上传响应非 JSON: ${text.slice(0, 200)}` } }
      const name = json.name || json.image || null
      return name ? { ok: true, name } : { ok: false, error: `上传响应缺少文件名: ${text.slice(0, 200)}` }
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? '上传超时 120s' : `上传异常: ${(e && e.message) || e}`
      this.breaker?.recordFailure('comfy', msg)
      return { ok: false, error: msg, errorType: classifyError(msg) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 构建并提交 ComfyUI 工作流。
   * @param {object} p
   * @param {object} p.model MODELS[key]（含 art 描述）
   */
  async comfyGenerate({
    prompt, negative = '', initImage = '', mask = '',
    width = 1024, height = 1024, steps = 24, cfg = 7, denoise = 1.0,
    sampler = 'euler', scheduler = 'normal', seed = -1, name = 'gw', modelKey = null, model = null,
    /** 提交成功后立刻回调 prompt_id：进度接口靠它判断"我的任务排在 ComfyUI 队列第几位" */
    onSubmitted = null,
  } = {}) {
    const engine = 'comfy'
    const m = model || {}
    const art = m.art || {}

    // 1) 底图/蒙版上传
    let inputImage = null
    let maskImage = null
    if (initImage) {
      const up = await this.comfyUploadImage(initImage, `gw_input_${Date.now()}.png`)
      if (!up.ok) return { ok: false, error: up.error, errorType: up.errorType || 'engine' }
      inputImage = up.name
    }
    if (mask) {
      const up = await this.comfyUploadImage(mask, `gw_mask_${Date.now()}.png`)
      if (!up.ok) return { ok: false, error: `蒙版上传失败: ${up.error}`, errorType: up.errorType || 'engine' }
      maskImage = up.name
    }

    // 2) 组装工作流
    const info = await this.objectInfo()
    const hasNode = (k) => !!(info && info[k])
    const loader = await this.pickUnetLoader()
    const wf = {}
    // 2026-10-21：notes 提前声明 —— LoRA 处理段（在下面 loader 之后）就要往里写 note，
    //   原来它声明在 CLIPTextEncode 之后 → 会触发 TDZ「Cannot access 'notes' before initialization」。
    const notes = []
    let modelRef
    let clipRef
    let vaeRef
    if (loader === 'QwenImageModelLoader') {
      wf['1'] = { class_type: 'QwenImageModelLoader', inputs: {
        unet_path: `${art.unetDir}/${art.unet}`,
        clip_path: `${art.clipDir}/${art.clip}`,
        vae_path: `${art.vaeDir}/${art.vae}`,
      } }
      modelRef = ['1', 0]; clipRef = ['1', 1]; vaeRef = ['1', 2]
    } else if (loader === 'UNETLoader') {
      wf['1'] = { class_type: 'UNETLoader', inputs: { unet_name: art.unet, weight_dtype: 'default' } }
      wf['2'] = { class_type: 'CLIPLoader', inputs: { clip_name: art.clip, type: art.clipType || 'sd3' } }
      wf['3'] = { class_type: 'VAELoader', inputs: { vae_name: art.vae } }
      modelRef = ['1', 0]; clipRef = ['2', 0]; vaeRef = ['3', 0]
    } else {
      wf['1'] = { class_type: 'UnetLoaderGGUF', inputs: { unet_name: art.unet } }
      wf['2'] = { class_type: 'CLIPLoader', inputs: { clip_name: art.clip, type: art.clipType || 'sd3' } }
      wf['3'] = { class_type: 'VAELoader', inputs: { vae_name: art.vae } }
      modelRef = ['1', 0]; clipRef = ['2', 0]; vaeRef = ['3', 0]
    }

    // ---- LoRA（2026-10-21 用户要求：让 ComfyUI 也能读取并正常使用 LoRA）----
    //   提示词里的 <lora:名称:权重> 是 A1111 语法，ComfyUI 的文本节点**不解析**它。
    //   这里真把它翻译成 ComfyUI 的 LoRA 节点：
    //     · 名称按 ComfyUI 的 lora_name 列表（/object_info，含 sd_lora 目录里那 24 个）解析；
    //     · 解析不到 → 只记一条 note 并跳过（绝不让整张图因为一个 LoRA 名字失败）；
    //     · 打补丁后的 model/clip 引用会替换 KSampler / CLIPTextEncode 用的引用。
    //   架构差异：Qwen/Krea2 这类 DiT 只有 model 侧可打补丁 → 用 LoraLoaderModelOnly（避免 CLIP 键不匹配报错）；
    //   SD/SDXL 系（UNETLoader）用 LoraLoader，model+clip 一起打。
    const loraDefs = []
    const loraRe = /<\s*lora\s*:\s*([^:>]+?)\s*(?::\s*([0-9]*\.?[0-9]+)\s*)?>/gi
    let promptForClip = String(prompt || '')
    let loraMatch
    while ((loraMatch = loraRe.exec(promptForClip)) !== null) {
      loraDefs.push({
        name: String(loraMatch[1] || '').trim(),
        weight: loraMatch[2] != null ? Number(loraMatch[2]) : 1,
      })
    }
    if (loraDefs.length) {
      promptForClip = promptForClip.replace(loraRe, '').replace(/,\s*,/g, ', ').replace(/\s{2,}/g, ' ').trim()
      const loraKeys = (() => {
        try {
          const req = info && info.LoraLoader && info.LoraLoader.input && info.LoraLoader.input.required
          const arr = req && req.lora_name && req.lora_name[0]
          return Array.isArray(arr) ? arr : []
        } catch { return [] }
      })()
      const normL = (s) => String(s || '').replace(/\\/g, '/').toLowerCase().trim()
      const stemL = (s) => normL(s).split('/').pop().replace(/\.(safetensors|pt|ckpt|bin)$/i, '')
      const resolveLora = (name) => {
        if (!name) return null
        return loraKeys.find((k) => normL(k) === normL(name)) ||
          loraKeys.find((k) => stemL(k) === stemL(name)) ||
          loraKeys.find((k) => stemL(k).includes(stemL(name)) || stemL(name).includes(stemL(k))) ||
          null
      }
      const useClipLora = hasNode('LoraLoader') && loader !== 'QwenImageModelLoader'
      const modelOnlyOk = hasNode('LoraLoaderModelOnly')
      let loraNodeId = 30
      for (const d of loraDefs) {
        const key = resolveLora(d.name)
        if (!key) {
          notes.push(`LoRA「${d.name}」在本机 ComfyUI 的 LoRA 列表里找不到 → 本次跳过`)
          continue
        }
        if (!useClipLora && !modelOnlyOk) {
          notes.push(`本机 ComfyUI 没有 LoraLoaderModelOnly 节点 → LoRA「${d.name}」跳过`)
          continue
        }
        const id = String(loraNodeId++)
        if (useClipLora) {
          wf[id] = { class_type: 'LoraLoader', inputs: { model: modelRef, clip: clipRef, lora_name: key, strength_model: d.weight, strength_clip: d.weight } }
          modelRef = [id, 0]
          clipRef = [id, 1]
        } else {
          wf[id] = { class_type: 'LoraLoaderModelOnly', inputs: { model: modelRef, lora_name: key, strength_model: d.weight } }
          modelRef = [id, 0]
        }
        notes.push(`LoRA 已加载：${d.name} ${d.weight} → ${key}（${useClipLora ? 'model+clip' : '仅 model'}）`)
      }
    }

    wf['4'] = { class_type: 'CLIPTextEncode', inputs: { text: promptForClip, clip: clipRef } }
    wf['5'] = { class_type: 'CLIPTextEncode', inputs: { text: negative || '', clip: clipRef } }

    let latentRef
    if (inputImage) {
      wf['6'] = { class_type: 'LoadImage', inputs: { image: inputImage } }
      if (maskImage && hasNode('LoadImageMask') && hasNode('VAEEncodeForInpaint')) {
        // 蒙版重绘：VAEEncodeForInpaint（ComfyUI 标准节点）
        wf['7'] = { class_type: 'LoadImageMask', inputs: { image: maskImage, channel: 'red' } }
        wf['8'] = { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['6', 0], vae: vaeRef, mask: ['7', 0], grow_mask_by: 6 } }
        latentRef = ['8', 0]
      } else {
        if (maskImage) notes.push('缺少 LoadImageMask/VAEEncodeForInpaint 节点 → 本次退化为整图 img2img（未做蒙版合成）')
        wf['7'] = { class_type: 'VAEEncode', inputs: { pixels: ['6', 0], vae: vaeRef } }
        latentRef = ['7', 0]
      }
    } else {
      wf['6'] = { class_type: 'EmptyLatentImage', inputs: { width: Math.round(width), height: Math.round(height), batch_size: 1 } }
      latentRef = ['6', 0]
    }

    wf['9'] = { class_type: 'KSampler', inputs: {
      seed: seed >= 0 ? Math.round(seed) : Math.floor(Math.random() * 2147483647),
      steps: Math.round(steps),
      cfg,
      sampler_name: sampler,
      scheduler,
      denoise,
      model: modelRef,
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: latentRef,
    } }
    wf['10'] = { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: vaeRef } }
    wf['11'] = { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: name } }

    // 3) 提交 + 轮询
    const sub = await this.request(`${this.comfyUrl}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ prompt: wf, client_id: `gw-${Date.now()}` }),
      timeoutMs: 60000,
      engine,
    })
    if (!sub.ok) {
      // ComfyUI 的校验失败（HTTP 400）会把原因塞在 node_errors 里：
      // 直接甩原始 body 用户看不懂，这里翻译成「节点 9 KSampler.sampler_name: 值不在列表」这种可执行的话。
      let detail = sub.error
      try {
        const j = sub.body ? JSON.parse(sub.body) : null
        const ne = j && j.node_errors
        if (ne && typeof ne === 'object') {
          const parts = []
          for (const [nodeId, info] of Object.entries(ne)) {
            const errs = (info && info.errors) || []
            for (const e of errs) {
              const extra = e.extra_info && (e.extra_info.input_name || e.extra_info.received_value)
                ? `（${e.extra_info.input_name ?? ''}=${JSON.stringify(e.extra_info.received_value ?? '')}）` : ''
              parts.push(`节点 ${nodeId} ${(info && info.class_type) || ''}: ${e.message || e.type}${extra}`)
            }
          }
          if (parts.length) detail = `ComfyUI 工作流校验失败 → ${parts.join('；')}`
        } else if (j && j.error) {
          detail = `ComfyUI 提交失败: ${j.error.message || JSON.stringify(j.error)}`
        }
      } catch { /* body 不是 JSON 就用原错误 */ }
      this.log?.('warn', 'comfy.prompt_rejected', { detail })
      return { ok: false, error: detail, errorType: sub.errorType }
    }
    const promptId = sub.json && sub.json.prompt_id
    if (!promptId) {
      const nodeErrors = sub.json && sub.json.node_errors ? JSON.stringify(sub.json.node_errors) : ''
      return { ok: false, error: `ComfyUI 未返回 prompt_id ${nodeErrors}`.trim(), errorType: 'engine' }
    }
    try { if (typeof onSubmitted === 'function') onSubmitted(promptId) } catch (e) {
      this.log?.('debug', 'comfy.on_submitted_failed', { error: e })
    }

    const deadline = Date.now() + this.timeouts.generate
    let lastStatus = 'queued'
    while (Date.now() < deadline) {
      await sleep(4000)
      const hist = await this.request(`${this.comfyUrl}/history/${promptId}`, { timeoutMs: this.timeouts.poll })
      if (!hist.ok) {
        if (hist.errorType === 'circuit') return { ok: false, error: hist.error, errorType: 'circuit' }
        continue // 单次查询失败：继续轮询（不代表任务失败）
      }
      const entry = hist.json && hist.json[promptId]
      if (!entry) { lastStatus = 'running'; continue }
      if (entry.status && entry.status.status_str === 'error') {
        const msg = JSON.stringify(entry.status.messages || entry.status).slice(0, 600)
        const t = classifyError(msg)
        return { ok: false, error: `ComfyUI 执行错误: ${msg}`, errorType: t }
      }
      const outputs = entry.outputs || {}
      for (const nodeId of Object.keys(outputs)) {
        const images = outputs[nodeId] && outputs[nodeId].images
        if (images && images.length) {
          return {
            ok: true,
            promptId,
            images: images.map((i) => ({ filename: i.filename, subfolder: i.subfolder || '', type: i.type || 'output' })),
            notes,
          }
        }
      }
      if (Object.keys(outputs).length) return { ok: false, error: '任务完成但无图片输出', errorType: 'engine', notes }
    }
    return { ok: false, error: `ComfyUI 轮询超时（${Math.round(this.timeouts.generate / 1000)}s，最后状态 ${lastStatus}）`, errorType: 'timeout' }
  }

  /** 拉取 ComfyUI 产物落盘（二进制直取，绝不经文本解码） */
  async comfyFetchImage(imgMeta, outDir, name) {
    const url = `${this.comfyUrl}/view?filename=${encodeURIComponent(imgMeta.filename)}&subfolder=${encodeURIComponent(imgMeta.subfolder || '')}&type=${encodeURIComponent(imgMeta.type || 'output')}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 180000)
    try {
      const res = await this.fetch(url, { signal: controller.signal })
      if (!res.ok) throw new Error(`view 拉取失败 HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const dest = path.join(outDir, `${name}_${Date.now()}_${Math.floor(Math.random() * 1000)}.png`)
      fs.writeFileSync(dest, buf)
      return dest
    } finally {
      clearTimeout(timer)
    }
  }

  /** WebUI base64 数组落盘 */
  webuiSaveImages(imagesB64, outDir, name) {
    const paths = []
    for (let i = 0; i < imagesB64.length; i++) {
      const dest = path.join(outDir, `${name}_${String(i + 1).padStart(3, '0')}_${Date.now()}.png`)
      fs.writeFileSync(dest, Buffer.from(imagesB64[i], 'base64'))
      paths.push(dest)
    }
    return paths
  }
}

export { sleep }