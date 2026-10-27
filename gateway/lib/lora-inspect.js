/**
 * gateway/lib/lora-inspect.js —— LoRA 体检：判定架构/底模/强度，回答「这个 LoRA 能不能挂在当前底模上」。
 *
 * 为什么需要（2026-10-25 实测教训）：
 *   ① 中文名 LoRA 在本机 WebUI 里 `<lora:秧秧_官方1024:1.0>` **解析不到**（实测两张图与无 LoRA 逐像素相同），
 *      换成 ASCII 文件名后才能真正生效 —— 所以「文件名是否 ASCII 安全」必须能查。
 *   ② 训练配方写错（SD1.5 用 1024 训练、alpha 只有 dim 的一半）会让 delta_rms 掉到 3.6e-4，
 *      而能起作用的 LoRA 量级是 2e-3 —— 「强度够不够」必须能查，不能靠出图猜。
 *   ③ 跨架构（SD1.5 LoRA 挂 DiT/SDXL 档）根本加载不了，必须先判定 family。
 *
 * 只读文件头，不解码全量张量：解析 30 个 LoRA 在 2 秒内完成。
 */
import fs from 'node:fs'
import path from 'node:path'

const DTYPE_SIZE = { F64: 8, F32: 4, F16: 2, BF16: 2, I64: 8, I32: 4, I16: 2, I8: 1, U8: 1, BOOL: 1 }

/** 读 safetensors 头（8 字节长度 + JSON），不做全量读取 */
export function readHeader(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const lenBuf = Buffer.alloc(8)
    fs.readSync(fd, lenBuf, 0, 8, 0)
    const headerLen = Number(lenBuf.readBigUInt64LE(0))
    if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > 100 * 1024 * 1024) {
      throw new Error(`safetensors 头长度异常: ${headerLen}`)
    }
    const buf = Buffer.alloc(headerLen)
    fs.readSync(fd, buf, 0, headerLen, 8)
    const json = JSON.parse(buf.toString('utf8'))
    const meta = json.__metadata__ || {}
    delete json.__metadata__
    return { meta, tensors: json, dataOffset: 8 + headerLen }
  } finally {
    fs.closeSync(fd)
  }
}

/** fp16(位模式) → float32；否则会把 1.0 读成 15360 这种鬼数字 */
function halfToFloat(h) {
  const s = (h & 0x8000) >> 15
  const e = (h & 0x7c00) >> 10
  const f = h & 0x03ff
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024)
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity)
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024)
}

/** 读指定张量的前 n 个 float（fp16/fp32），用于估算强度，避免全量解码 */
function readFloats(file, info, dataOffset, n = 0) {
  const size = DTYPE_SIZE[info.dtype] || 2
  const total = info.shape.reduce((a, b) => a * b, 1)
  const count = n > 0 ? Math.min(n, total) : total
  const buf = Buffer.alloc(count * size)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buf, 0, buf.length, dataOffset + info.data_offsets[0])
  } finally {
    fs.closeSync(fd)
  }
  const out = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = info.dtype === 'F32' ? buf.readFloatLE(i * 4) : halfToFloat(buf.readUInt16LE(i * 2))
  }
  return out
}

/** 架构判定：看 cross-attention 的上下文维度 + UNet 键结构 */
export function detectFamily(tensors) {
  const keys = Object.keys(tensors)
  const hasDown = keys.some((k) => k.includes('down_blocks'))
  const ctxDims = new Set()
  for (const k of keys) {
    if (/(attn2_to_k|attn2_to_v|cross_attn_k|cross_attn_v)/.test(k) && k.endsWith('lora_down.weight')) {
      const sh = tensors[k].shape
      if (sh && sh.length === 2) ctxDims.add(sh[1])
    }
  }
  const dims = [...ctxDims].sort((a, b) => a - b)
  if (hasDown && dims.includes(768)) return { family: 'SD1.5', ctxDims: dims }
  if (hasDown && dims.includes(2048)) return { family: 'SDXL', ctxDims: dims }
  if (!hasDown && dims.some((d) => d >= 3072)) return { family: 'DiT(SD3/Flux/QwenImage)', ctxDims: dims }
  if (keys.some((k) => k.startsWith('lora_unet_double_blocks'))) return { family: 'Flux/SD3', ctxDims: dims }
  return { family: 'unknown', ctxDims: dims }
}

/** 从训练元数据里抠出标注用到的首个 token（= 触发词） */
function triggerFromMeta(meta) {
  try {
    const tf = JSON.parse(meta.ss_tag_frequency || '{}')
    const first = Object.values(tf)[0] || {}
    const tokens = Object.keys(first)
    return tokens.length ? tokens[0] : null
  } catch {
    return null
  }
}

/** 单个 LoRA 的完整体检 */
export function inspectLora(file) {
  const name = path.basename(file).replace(/\.safetensors$/i, '')
  const { meta, tensors, dataOffset } = readHeader(file)
  const { family, ctxDims } = detectFamily(tensors)

  const keys = Object.keys(tensors)
  // 优先挑 UNet 的 cross-attn 模块（实测最能代表「起不起作用」的位置），退而求其次用第一个成对模块
  const pref = `${'lora_unet_down_blocks_1_attentions_0_transformer_blocks_0_attn2_to_k'}.lora_down.weight`
  const firstPair =
    (tensors[pref] && keys.includes(pref) && keys.includes(pref.replace('lora_down', 'lora_up')) ? pref : null) ||
    keys.find((k) => k.endsWith('lora_down.weight') && tensors[k.replace('lora_down', 'lora_up')])
  let dim = null
  let alpha = null
  let scale = 1
  let deltaRms = null
  if (firstPair) {
    const base = firstPair.replace('.lora_down.weight', '')
    dim = tensors[firstPair].shape[0]
    const alphaKey = `${base}.alpha`
    alpha = dim
    if (alphaKey in tensors) {
      const a = readFloats(file, tensors[alphaKey], dataOffset, 1)
      alpha = a[0]
    }
    scale = alpha ? alpha / dim : 1
    // 强度估计：||up||_rms × ||down||_rms × sqrt(dim) × scale ≈ ||up·down||_F/sqrt(n) × scale
    // （与 python 侧 strength.py 的 delta_rms 同量级，误差 <20%，足够做分级）
    const down = readFloats(file, tensors[firstPair], dataOffset)
    const up = readFloats(file, tensors[firstPair.replace('lora_down', 'lora_up')], dataOffset)
    const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length) || 0
    deltaRms = rms(up) * rms(down) * Math.sqrt(dim) * scale
  }

  const sizeBytes = fs.statSync(file).size
  const asciiSafe = /^[\x20-\x7E]+$/.test(name)
  return {
    name,
    file,
    sizeMB: Math.round((sizeBytes / 1048576) * 10) / 10,
    asciiSafe,
    family,
    ctxDims,
    dim,
    alpha: alpha === null ? null : Number(alpha),
    scale: Number(scale.toFixed(3)),
    deltaRms: deltaRms === null ? null : Number(deltaRms.toExponential(2)),
    strengthLevel:
      deltaRms === null
        ? 'unknown'
        : deltaRms >= 1.2e-3
          ? 'strong'
          : deltaRms >= 6e-4
            ? 'normal'
            : deltaRms >= 3e-4
              ? 'weak'
              : 'too-weak',
    baseModel: meta.ss_sd_model_name || null,
    trainResolution: meta.ss_resolution || meta['modelspec.resolution'] || null,
    steps: meta.ss_steps ? Number(meta.ss_steps) : null,
    unetLr: meta.ss_unet_lr || null,
    netDim: meta.ss_network_dim ? Number(meta.ss_network_dim) : null,
    netAlpha: meta.ss_network_alpha ? Number(meta.ss_network_alpha) : null,
    trigger: triggerFromMeta(meta),
    trainedAt: meta['modelspec.date'] || null,
  }
}

/** 批量体检 */
export function inspectDir(dir, { filter } = {}) {
  if (!fs.existsSync(dir)) return []
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.safetensors$/i.test(f))
    .filter((f) => (filter ? filter.test(f) : true))
    .map((f) => path.join(dir, f))
  const out = []
  for (const f of files) {
    try {
      out.push(inspectLora(f))
    } catch (e) {
      out.push({ name: path.basename(f), file: f, error: e.message })
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

/** 兼容路由：当前底模能不能直接加载这个 LoRA */
export function checkCompat(lora, checkpointName) {
  const ckpt = String(checkpointName || '')
  const lower = ckpt.toLowerCase()
  const isSdxl = /sdxl|illustrious|pony|noobai/.test(lower)
  const isDit = /qwen|flux|sd3|krea/.test(lower)
  const ckptFamily = isDit ? 'DiT' : isSdxl ? 'SDXL' : 'SD1.5'
  const loraFamily = String(lora.family || 'unknown')
  const ok = ckptFamily === 'SD1.5' ? loraFamily === 'SD1.5' : loraFamily === ckptFamily
  const notes = []
  if (!lora.asciiSafe) notes.push('文件名含非 ASCII 字符：本机 WebUI 解析不到该 LoRA（实测完全不生效），需改名为 ASCII')
  if (lora.strengthLevel === 'too-weak' || lora.strengthLevel === 'weak') {
    notes.push(`强度偏弱（deltaRms=${lora.deltaRms}）：推理权重需要拉到 1.0 以上或重训`)
  }
  if (lora.baseModel && lora.baseModel.toLowerCase().replace(/\.safetensors$/, '') !== lower.replace(/\.safetensors$/, '')) {
    notes.push(`训练底模是 ${lora.baseModel}，当前底模是 ${ckpt}：画风会漂移，建议用训练底模出图`)
  }
  return { checkpoint: ckpt, checkpointFamily: ckptFamily, loraFamily, compatible: ok, notes }
}

export default { readHeader, detectFamily, inspectLora, inspectDir, checkCompat }
