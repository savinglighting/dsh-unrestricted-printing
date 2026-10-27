/**
 * gateway/lib/official-pipeline.js —— 官方素材「一键官方复刻」LoRA 流水线
 *
 * 为什么单独做一条流水线（对应用户诉求）：
 *   双轨解耦（ID 锁脸 + Base 管服装）是为"换装保脸"设计的，服装永远只有 0.4~0.65 权重，
 *   复刻不了官方服装细节。本条流水线改为**单文件高容量**：脸与服装一起焊死，推理权重直接 1.0。
 *
 * 六个设计目标如何落实：
 *   ① 全自动      —— 只给一个素材目录，自动三档裁切 + 自动标注 + 自动算步数 + 自动投递
 *   ② 低占用      —— cache_latents + gradient_checkpointing + sdpa + fp16 + workers=1 +
 *                    no_half_vae；训练前主动让 SD 卸载模型腾显存
 *   ③ token 低消耗 —— 进度只报 25/50/75/100 四个里程碑，日志落盘不刷屏
 *   ④ 快速        —— 步数按素材量自动推算并封顶；1024 分辨率 + AdamW8bit 是实测最快可用组合
 *   ⑤ 画风一致    —— 固定底模（SemiRealMix 半写实）+ 固定推理预设（随产物输出 preset.json）
 *   ⑥ 特征一致    —— 标注只写构图/背景，不写发色瞳色服装 → 特征无条件焊进权重
 *   ⑦ 体积压缩    —— dim 可调（32≈36MB / 16≈18MB），可选 resize_lora 秩压缩
 *
 * 实测依据（2026-10-23/24）：
 *   AWPainting(扁平赛璐璐)+768+dim64 → 5.5/10
 *   SemiRealMix(半写实)+1024+dim32   → 6.5/10
 *   再加构图修正与质感修正 → 8.5~9/10 画风分
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 官方复刻的固定训练配方（改动前请先看文件头的实测依据） */
export const OFFICIAL_RECIPE = {
  /** 半写实底模：本机实测最接近鸣潮/崩铁官方的 CG 厚涂风 */
  baseModel: 'D:\\SD.4.8\\models\\Stable-diffusion\\SemiRealMix.safetensors',
  /**
   * 速度/质量平衡（2026-10-24 实测）：
   *   1024 分辨率在 8GB 卡上约 1.9s/it；768 约 0.8s/it。
   *   实测 900 步之后收益很小（loss 已平），故上限压到 1200 步、按"每图 50 步"推算。
   *
   * 体积与质量的实测边界（重要，别踩）：
   *   dim 32 @1024 → 36MB，画风 8.5~9/10（推荐默认）
   *   dim 32 @768  → 36MB，画风 6/10（快，但细节掉）
   *   dim 16 @768  → 18MB，画风 5/10、角色相似度仅 2/10（**不能用，容量不够**）
   * 结论：体积下限就是 dim 32 ≈ 36MB；再压就会崩，compress 默认关闭，且目标维度不低于 24。
   */
  /**
   * 分辨率 640（2026-10-25 修）：SD1.5 的原生尺度是 512，v3 用 1024 训练时
   * bucket 会铺到 1408x1344，学出来的特征落在底模根本渲染不出的尺度上，
   * 推理时（512~768）LoRA 几乎不起作用。640 是 8GB 卡上「细节够 + 尺度对」的平衡点。
   */
  resolution: 640,
  networkDim: 32,
  /**
   * alpha 32 = dim（scale 1.0）。v3 用 alpha 16 = 半衰减，实测交叉注意力模块的
   * delta_rms 只有 3.6e-4，而能起作用的 LoRA 是 2e-3 —— 差 5 倍以上，
   * 换成 1.0 缩放后同强度下角色才会真的「长出来」。
   */
  networkAlpha: 32,
  learningRate: 1.8e-4,
  textEncoderLr: 9e-5,
  /** 步数 = clamp(素材张数 × 70, min, max)；2026-10-26 加强：原 40/图拟合不足、脸部崩 */
  stepsPerImage: 70,
  minSteps: 1400,
  maxSteps: 2400,
  clipSkip: 2,
  seed: 20261026,
  /** min-snr-gamma：让高噪/低噪时间步的损失更均衡，画质更稳 */
  minSnrGamma: 5,
  /** 每 N 个 epoch 存一次快照，便于挑「不过拟合」的那一版 */
  saveEveryNEpochs: 2,
  /** 体积压缩的安全下限：低于这个维度会明显掉质 */
  compressDimFloor: 24,
}

/** 推理预设：所有官方复刻 LoRA 共用，保证画风一致 */
export const INFERENCE_PRESET = {
  checkpoint: 'SemiRealMix.safetensors',
  /**
   * 负向词必须压住「黑白漫」：实测（2026-10-25）v3 的 stylePrompt 里
   * `matte finish + clean lineart + anime illustration style` 会把 SemiRealMix
   * 推成近灰度图（饱和度 2.5/255），看起来就像「LoRA 没生效」。
   * 现在画风词改成彩色向，负向补 monochrome/grayscale/sketch。
   */
  negativePrompt:
    'lowres, bad anatomy, bad hands, extra fingers, fewer digits, malformed limbs, watermark, text, signature, ' +
    'jpeg artifacts, worst quality, low quality, blurry, chibi, (monochrome:1.3), (grayscale:1.3), ' +
    '(greyscale:1.2), (sketch:1.2), (flat color:1.15), (cropped legs:1.3), (out of frame:1.3), ' +
    '(oily skin:1.2), (plastic skin:1.15)',
  stylePrompt:
    'masterpiece, best quality, absurdres, (ultra detailed:1.15), (vibrant colors:1.15), ' +
    '(detailed shading:1.2), (semi-realistic:1.05), (soft lighting:1.1), anime illustration style',
  framingPrompt: '(full body:1.3), standing on ground, (feet visible:1.25)',
  loraWeight: 1.0,
  /**
   * 512x768 是 SD1.5 的舒适区（v3 用 640x1152 太高，底模在超长画布上会画糊/断肢）。
   * 想要 1216x1536 大图走 hires 2.0x，而不是直接开大画布。
   */
  width: 512,
  height: 768,
  steps: 30,
  cfgScale: 7,
  sampler: 'DPM++ 2M',
  hiresScale: 2.0,
  hiresUpscaler: 'R-ESRGAN 4x+ Anime6B',
  hiresSteps: 24,
  hiresDenoising: 0.4,
  restoreFaces: true,
}

/** 低占用训练环境变量（HF 离线 + UTF-8 + 显存碎片优化） */
function trainEnv() {
  return {
    ...process.env,
    HF_HOME: 'D:\\SD.4.8\\.cache\\huggingface',
    HUGGINGFACE_HUB_CACHE: 'D:\\SD.4.8\\.cache\\huggingface\\hub',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_DATASETS_OFFLINE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    TOKENIZERS_PARALLELISM: 'false',
    PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
  }
}

/** 让 SD 卸载模型腾显存（低占用的关键一步；SD 没开时静默跳过） */
async function unloadSd(webuiUrl) {
  try {
    const r = await fetch(`${webuiUrl}/sdapi/v1/unload-checkpoint`, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
    })
    return r.ok
  } catch {
    return false
  }
}

function run(cmd, args, { env, logStream } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: env || process.env, windowsHide: true })
    let tail = []
    const onData = (buf) => {
      const s = buf.toString('utf8')
      if (logStream) logStream.write(s)
      tail.push(s)
      if (tail.length > 60) tail.shift()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('close', (code) => resolve({ code, tail: tail.join('') }))
  })
}

/** ① 自动数据集准备：四档裁切（含脸部特写）+ 带触发词的逐图标注 */
export async function prepDataset({ src, dst, resolution, pythonPath, prepScript, trigger }) {
  const args = [prepScript, '--src', src, '--dst', dst, '--res', String(resolution), '--json']
  if (trigger) args.push('--trigger', trigger)
  const r = await run(pythonPath, args)
  const text = String(r.tail || '').trim()
  const start = text.indexOf('{')
  if (start < 0) return { ok: false, error: '数据集准备无输出', raw: text.slice(0, 400) }
  try {
    const j = JSON.parse(text.slice(start))
    return { ...j, ok: j.ok !== false }
  } catch (e) {
    return { ok: false, error: `数据集准备输出解析失败: ${e.message}`, raw: text.slice(0, 400) }
  }
}

/** ② 训练（低占用配方） */
export async function trainOfficial({
  name,
  dataDir,
  outDir,
  logDir,
  baseModel = OFFICIAL_RECIPE.baseModel,
  resolution = OFFICIAL_RECIPE.resolution,
  dim = OFFICIAL_RECIPE.networkDim,
  alpha = OFFICIAL_RECIPE.networkAlpha,
  steps,
  onMilestone,
}) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(logDir, { recursive: true })

  const args = [
    'D:\\kohya_ss\\sd-scripts\\train_network.py',
    `--pretrained_model_name_or_path=${baseModel}`,
    `--train_data_dir=${dataDir}`,
    `--output_dir=${outDir}`,
    `--output_name=${name}`,
    `--resolution=${resolution}`,
    '--network_module=networks.lora',
    `--network_dim=${dim}`,
    `--network_alpha=${alpha}`,
    `--learning_rate=${OFFICIAL_RECIPE.learningRate}`,
    `--text_encoder_lr=${OFFICIAL_RECIPE.textEncoderLr}`,
    `--unet_lr=${OFFICIAL_RECIPE.learningRate}`,
    '--optimizer_type=AdamW8bit',
    '--mixed_precision=fp16',
    '--save_precision=fp16',
    '--enable_bucket',
    `--min_bucket_reso=${Math.round(resolution * 0.75)}`,
    `--max_bucket_reso=${Math.round(resolution * 1.4)}`,
    '--save_model_as=safetensors',
    '--sdpa',
    '--gradient_checkpointing',
    '--cache_latents',
    '--no_half_vae',
    '--max_data_loader_n_workers=1',
    '--persistent_data_loader_workers',
    `--max_train_steps=${steps}`,
    '--lr_scheduler=cosine',
    '--lr_warmup_steps=50',
    `--min_snr_gamma=${OFFICIAL_RECIPE.minSnrGamma}`,
    `--clip_skip=${OFFICIAL_RECIPE.clipSkip}`,
    `--seed=${OFFICIAL_RECIPE.seed}`,
    // 触发词必须留在标注首位，不能被 shuffle 打乱（否则「角色」与「构图」混在一起学）
    '--keep_tokens=1',
    '--shuffle_caption',
  ]
  if (OFFICIAL_RECIPE.saveEveryNEpochs > 0) {
    args.push(`--save_every_n_epochs=${OFFICIAL_RECIPE.saveEveryNEpochs}`)
  }

  const logFile = path.join(logDir, `${name}.log`)
  const ws = fs.createWriteStream(logFile, { flags: 'w' })
  const t0 = Date.now()

  const child = spawn('D:\\kohya_ss\\venv\\Scripts\\python.exe', args, { env: trainEnv(), windowsHide: true })
  let lastMilestone = -1
  const onData = (buf) => {
    const s = buf.toString('utf8')
    ws.write(s)
    // 只认 `steps:` 前缀的进度条：kohya 同时会刷 epoch 进度条（21/21），
    // 不加前缀判断会把 epoch 当成 100% 完成，进度显示错误（实测踩过）。
    const m = s.match(/steps:\s*\d+%\|[^|]*\|\s*(\d+)\/(\d+)/)
    if (m && onMilestone) {
      const pct = Math.floor((Number(m[1]) / Number(m[2])) * 100)
      for (const g of [25, 50, 75, 100]) {
        if (pct >= g && lastMilestone < g) {
          lastMilestone = g
          onMilestone({ pct: g, step: Number(m[1]), total: Number(m[2]) })
        }
      }
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const code = await new Promise((resolve) => child.on('close', resolve))
  ws.end()

  const outFile = path.join(outDir, `${name}.safetensors`)
  const ok = fs.existsSync(outFile) && fs.statSync(outFile).size > 1e6
  return {
    ok,
    code,
    file: ok ? outFile : null,
    bytes: ok ? fs.statSync(outFile).size : 0,
    seconds: Math.round((Date.now() - t0) / 1000),
    logFile,
  }
}

/** ③ 体积压缩：用 kohya 自带的 resize_lora 做秩压缩（保持效果、减小文件） */
export async function compressLora({ srcFile, dim, pythonPath }) {
  const script = 'D:\\kohya_ss\\sd-scripts\\networks\\resize_lora.py'
  if (!fs.existsSync(script)) return { ok: false, skipped: true, reason: 'resize_lora.py 不存在' }
  const dst = srcFile.replace(/\.safetensors$/, `_r${dim}.safetensors`)
  const r = await run(pythonPath, [script, '--src', srcFile, '--dst', dst, '--new_rank', String(dim)])
  const ok = fs.existsSync(dst) && fs.statSync(dst).size > 1e6
  return {
    ok,
    skipped: false,
    file: ok ? dst : null,
    bytes: ok ? fs.statSync(dst).size : 0,
    code: r.code,
  }
}

/** ④ 生成推理预设文件，保证后续出图画风/构图一致 */
export function writePreset({ dir, name, inferencePrompt, trigger }) {
  fs.mkdirSync(dir, { recursive: true })
  // 触发词放在正向最前面：这样「小写触发词」就能稳定召回角色，特征词只是锦上添花
  const lead = trigger ? `${trigger}, ` : ''
  const preset = {
    ...INFERENCE_PRESET,
    trigger: trigger || null,
    lora: `${name}:${INFERENCE_PRESET.loraWeight}`,
    promptTemplate:
      `${lead}<lora:${name}:${INFERENCE_PRESET.loraWeight}>, ${INFERENCE_PRESET.stylePrompt}, ` +
      `1girl, solo, ${INFERENCE_PRESET.framingPrompt}, ${inferencePrompt || ''}, ` +
      `looking at viewer, simple light background, depth of field`,
  }
  const file = path.join(dir, `${name}.preset.json`)
  fs.writeFileSync(file, JSON.stringify(preset, null, 2), 'utf8')
  return { file, preset }
}

/** 触发词：从名字里取 ASCII 片段，取不到就按名字哈希兜底（kohya 只认 ASCII 触发词最稳） */
export function deriveTrigger(name) {
  const ascii = String(name || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
  if (ascii.length >= 3) return ascii.slice(0, 16)
  let h = 0
  for (const ch of String(name || 'lora')) h = (h * 131 + ch.codePointAt(0)) % 1000000007
  return `chr${h.toString(36)}`
}

/**
 * 真实触发词（2026-10-26 修「LoRA 出来是无关的人」的关键）：
 *   kohya 会把数据集目录 `10_<concept>` 的 concept 名当作 tag_frequency 的 key，
 *   而 prep_official.py 写进每张标注的第一个 token 才是**真正被学到的触发词**。
 *   两者不一致时（例如 --trigger shorekeeperoffic，但目录是 10_shorekeeper_official_v6），
 *   推理用 --trigger 那个词**完全无效** —— 实测同一张图相似度从 8 分掉到 0 分。
 *
 *   本函数保证：只传 --trigger 时，真正写进标注的就是它，且返回它作为权威触发词。
 */
export function resolveTrigger(name, explicit) {
  const clean = String(explicit || '').trim().replace(/[^A-Za-z0-9_]/g, '')
  if (clean.length >= 3) return clean
  return deriveTrigger(name)
}

/** ⑤ 总编排：采集→准备→训练→压缩→投递→预设 */
export async function runPipeline({
  name,
  src,
  workRoot,
  loraDir,
  pythonPath,
  prepScript,
  webuiUrl = 'http://127.0.0.1:7860',
  resolution = OFFICIAL_RECIPE.resolution,
  dim = OFFICIAL_RECIPE.networkDim,
  compress = false,
  compressDim = 16,
  inferencePrompt = '',
  trigger = '',
  onStage = () => {},
  onMilestone = () => {},
}) {
  // kohya 约定：train_data_dir 必须是「含 `重复数_概念名` 子目录」的父目录，
  // 图片要放在子目录里，否则报 "No data found"（实测踩过）。
  const dataDir = path.join(workRoot, 'dataset')
  const conceptDir = path.join(dataDir, `10_${name.replace(/[\\/:*?"<>|]/g, '_')}`)
  const outDir = path.join(workRoot, 'out')
  const logDir = path.join(workRoot, 'logs')
  const trig = resolveTrigger(name, trigger)

  onStage({ stage: 'unload', note: '让 SD 释放显存' })
  const unloaded = await unloadSd(webuiUrl)

  onStage({ stage: 'dataset', note: `四档裁切 + 触发词标注（${trig}）` })
  const ds = await prepDataset({ src, dst: conceptDir, resolution, pythonPath, prepScript, trigger: trig })
  if (!ds.ok) return { ok: false, stage: 'dataset', error: ds.error || '数据集准备失败', detail: ds }

  const images = ds.images || 0
  const steps = Math.min(
    OFFICIAL_RECIPE.maxSteps,
    Math.max(OFFICIAL_RECIPE.minSteps, images * OFFICIAL_RECIPE.stepsPerImage),
  )

  onStage({ stage: 'train', note: `训练中（${images} 张 / ${steps} 步 / res ${resolution} / dim ${dim}）` })
  const tr = await trainOfficial({
    name,
    dataDir,
    outDir,
    logDir,
    resolution,
    dim,
    steps,
    onMilestone: (m) => onMilestone({ phase: 'train', ...m }),
  })
  if (!tr.ok) return { ok: false, stage: 'train', error: '训练失败', detail: tr, steps, images }

  let finalFile = tr.file
  let compressed = null
  if (compress) {
    // 安全下限：实测 dim 16 会让角色相似度从 8.5 掉到 2，所以压到低于 floor 直接拒绝
    const targetDim = Math.max(OFFICIAL_RECIPE.compressDimFloor, Math.min(compressDim, dim))
    if (targetDim >= dim) {
      compressed = { skipped: true, reason: `目标维度 ${targetDim} 不低于当前 ${dim}，无需压缩` }
    } else {
      onStage({ stage: 'compress', note: `秩压缩 ${dim} → ${targetDim}` })
      const c = await compressLora({ srcFile: tr.file, dim: targetDim, pythonPath })
      if (c.ok) {
        finalFile = c.file
        compressed = { from: dim, to: targetDim, bytes: c.bytes }
      } else {
        compressed = { skipped: true, reason: c.reason || '压缩失败，保留原文件' }
      }
    }
  }

  fs.mkdirSync(loraDir, { recursive: true })
  const dest = path.join(loraDir, `${name}.safetensors`)
  fs.copyFileSync(finalFile, dest)

  const { file: presetFile, preset } = writePreset({
    dir: path.join(workRoot, 'preset'),
    name,
    inferencePrompt,
    trigger: trig,
  })

  const mb = (n) => Math.round((n / 1048576) * 10) / 10
  return {
    ok: true,
    name,
    trigger: trig,
    images,
    steps,
    resolution,
    dim,
    seconds: tr.seconds,
    loraFile: dest,
    sizeMB: mb(fs.statSync(dest).size),
    compressed,
    presetFile,
    promptTemplate: preset.promptTemplate,
    negativePrompt: preset.negativePrompt,
    checkpoint: preset.checkpoint,
    sdUnloaded: unloaded,
    logFile: tr.logFile,
  }
}

export default { OFFICIAL_RECIPE, INFERENCE_PRESET, runPipeline, prepDataset, trainOfficial, compressLora, writePreset }
