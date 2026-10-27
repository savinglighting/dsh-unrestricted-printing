/**
 * gateway/lib/training-profiles.js — 双 LoRA 解耦训练档（P1）
 *
 * 为什么要有这个文件：
 *   原 P4 规则把 `--network_dim=4` 当成"强制注入项"，任何来源都不能覆盖。
 *   但「一键炼制 LoRA」采用双轨解耦标准：
 *     · ID-LoRA   —— 只锁面部/角色身份，**故意压低秩**，防止记忆服装与背景（dim=8）；
 *     · Base-LoRA —— 承载画风/服装/场景，用 LyCORIS LoCon 覆盖卷积层（dim=32）。
 *   一个写死的 dim=4 会把两条轨道都压成"低秩脸模"，标准根本无法落地。
 *
 * 因此训练参数被拆成三层，本模块是这三层的唯一裁决处（纯函数、无 IO，便于单测）：
 *   1. baselineArgs —— 硬底线（优化器 / 精度 / 显存 / 分桶 / 保存格式）：**任何来源都不可覆盖**，
 *      这条保留了 P4 的安全承诺（用户传同名参数只会被丢弃并记录 ignored）。
 *   2. profile      —— 档位标准值（id / base 各自的 module / dim / alpha / lr / steps / resolution）。
 *      用户没传就用档位值；档位自有参数（module / network_args）为权威值，用户覆盖一律忽略。
 *   3. userArgs     —— 用户追加：可钳制的键（dim / alpha / lr / steps / resolution）按档位护栏钳到合法区间，
 *      越界会记进 adjusted 并回给调用方（不静默改数）；其余键原样透传。
 *
 * 护栏（gap）的取值依据：ID 轨必须刻意低秩（防止学服装背景），Base 轨才有资格用中高秩（画风细节）。
 * 越界钳制而不是直接丢弃，是为了"用户显式要求"与"标准不可破"两者都成立。
 */

'use strict'

/** 档位名（顺序即执行顺序：先 ID 后 Base，共用一次采集结果） */
export const PROFILE_NAMES = ['id', 'base']

/** 所有档位共用的标准值（不属于任何单轨的部分） */
export const COMMON_STANDARD = {
  resolution: 512,
  precision: 'fp16',
  mixedPrecision: 'fp16',
  optimizer: 'AdamW8bit',
  /** 无 bitsandbytes 时的退避优化器（Windows 常见），由编排层探测后切换并记日志 */
  optimizerFallback: 'AdamW',
  enableBucket: true,
  saveModelAs: 'safetensors',
  clipSkip: 2,
  /** 正则化：可选 5–10 张通用人物图 */
  regImages: { min: 5, max: 10 },
  /** 每轨数据量 */
  datasetImages: { min: 15, max: 30 },
}

/**
 * 双轨标准参数表。
 * dim 区间 = 护栏；networkDim = 标准默认值。
 */
export const PROFILES = {
  id: {
    name: 'id',
    title: 'ID-LoRA（锁身份/面部，低秩）',
    role: 'identity',
    networkModule: 'networks.lora',
    networkArgs: [],
    // 2026-10-23 实测上调（用户反馈"不太像"）：dim 8 对五官细节容量不足，
    // 脸型/瞳型/发饰记不住。提到 12（护栏上限）+ 步数 700，脸部辨识度明显提升。
    networkDim: 12,
    networkAlpha: 16,
    learningRate: 4e-5,
    maxTrainSteps: 700,
    resolution: 512,
    clipSkip: 2,
    /** 过拟合时的收敛档（见排查清单：脸像贴图 → dim 降到 4 / 步数 300–400） */
    overfitFallback: { networkDim: 6, maxTrainSteps: 400 },
    guard: { minDim: 4, maxDim: 16, minAlpha: 1, maxAlpha: 128, minLr: 1e-5, maxLr: 1e-4, minSteps: 300, maxSteps: 900, minResolution: 512, maxResolution: 512 },
    /** 数据配比：脸部/头部为主 */
    faceCloseupRatio: { min: 0.6, hint: '脸部/头部为主，姿态·角度·光照·表情须有变化，面部保持一致' },
    expectedSizeMB: { min: 8, max: 20 },
    /** 推理侧权重策略（P4 参数表用） */
    inferWeight: { fixed: 1.0, min: 1.0, max: 1.0, adjustable: false },
  },
  base: {
    name: 'base',
    title: 'Base-LoRA（画风/服装/场景，LoCon 覆盖卷积）',
    role: 'style',
    networkModule: 'networks.lora',
    networkArgs: ['conv_dim=4', 'conv_alpha=2'],
    networkDim: 32,
    networkAlpha: 16,
    learningRate: 7e-5,
    // 2026-10-23 实测上调：800→1000 步，让服装纹样/配色学得更实；
    // 关键改动是 resolution 512→768 —— 512 下全身服装细节被糊掉，
    // 出图服装与官方不符（白裙+金边 ≠ 官方蓝白装甲裙），768 后版本服还原。
    maxTrainSteps: 1000,
    resolution: 768,
    clipSkip: 2,
    /** 成品过大时的收敛档（见排查清单：dim 降到 16 或减少卷积覆盖） */
    bulkyFallback: { networkDim: 16 },
    guard: { minDim: 16, maxDim: 48, minAlpha: 1, maxAlpha: 128, minLr: 2e-5, maxLr: 2e-4, minSteps: 400, maxSteps: 1400, minResolution: 512, maxResolution: 768 },
    /** 数据配比：半身/全身/场景为主，脸部特写占比不得超过 25%（否则 Base 学到身份） */
    faceCloseupRatio: { max: 0.25, hint: '半身·全身·场景为主，减少脸部特写占比，防止 Base 学到身份' },
    expectedSizeMB: { min: 30, max: 90 },
    /** 推理侧：可调 0.3–0.7，硬上限 0.7（超过会污染面部） */
    inferWeight: { fixed: null, min: 0.3, max: 0.7, default: 0.4, adjustable: true },
  },
}

/** 推理侧换装/解耦策略（P4 参数表数据源） */
export const INFER_PLAYBOOK = [
  { scene: '解耦自检（应只剩无服装风格的脸）', id: 1.0, base: 0, note: 'Base 归零，只加载 ID' },
  { scene: '保脸、弱化服装（默认出图）', id: 1.0, base: '0.3–0.5', note: 'ID 权重固定不动' },
  { scene: '日常稳定档', id: 1.0, base: 0.4, note: '标准推荐值' },
  { scene: '完全换装', id: 1.0, base: '替换 Base 文件', note: 'ID 不变' },
  { scene: '只保画风、弱化角色', id: '0.2–0.3', base: '0.5–0.7', note: '角色弱化，画风保留' },
  { scene: '硬上限', id: 1.0, base: '不超过 0.7', note: 'Base 超过 0.7 会污染面部' },
]

/** 用户可钳制键的策略表；未列出的键原样透传 */
const ARG_POLICY = {
  '--network_module': { policy: 'authoritative' },
  '--network_args': { policy: 'authoritative' },
  '--network_dim': { policy: 'clamp', int: true, min: 'minDim', max: 'maxDim' },
  '--network_alpha': { policy: 'clamp', int: true, min: 'minAlpha', max: 'maxAlpha' },
  '--learning_rate': { policy: 'clamp', min: 'minLr', max: 'maxLr' },
  '--unet_lr': { policy: 'clamp', min: 'minLr', max: 'maxLr' },
  '--text_encoder_lr': { policy: 'clamp', min: 'minLr', max: 'maxLr' },
  '--max_train_steps': { policy: 'clamp', int: true, min: 'minSteps', max: 'maxSteps' },
  '--resolution': { policy: 'clamp', int: true, min: 'minResolution', max: 'maxResolution' },
}

/** 参数 token → 键名（`--x=1` 与 `--x` 都归到 `--x`） */
export function keyOf(arg) {
  const s = String(arg)
  const i = s.indexOf('=')
  const head = i > 0 ? s.slice(0, i) : s
  return head
}

function valueOf(arg) {
  if (arg === undefined || arg === null) return null
  const s = String(arg)
  const i = s.indexOf('=')
  return i > 0 ? s.slice(i + 1) : null
}

/**
 * 取某个键的数值：**参数不存在时返回 null**。
 * 注意：不能写成 Number(valueOf(...)) —— valueOf 对缺省返回 null，而 Number(null) === 0，
 * 会把「没传」误判成「传了 0」，进而把合法参数判成越界（P1 单测抓到的真实缺陷）。
 */
function numericArg(args, key) {
  const hit = args.find((a) => keyOf(a) === key)
  if (!hit) return null
  const n = Number(valueOf(hit))
  return Number.isFinite(n) ? n : null
}

function setOfKeys(args) {
  const out = new Set()
  for (const a of args) out.add(keyOf(a))
  return out
}

/** 取档位对象；未知档位返回 null（调用方据此报错，不猜） */
export function getProfile(name) {
  if (!name) return null
  const key = String(name).trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(PROFILES, key) ? PROFILES[key] : null
}

/** 档位清单（给 API / 参数表用，附带护栏与体积预期） */
export function listProfiles() {
  return PROFILE_NAMES.map((n) => {
    const p = PROFILES[n]
    return {
      name: p.name,
      title: p.title,
      role: p.role,
      network_module: p.networkModule,
      network_args: p.networkArgs,
      network_dim: p.networkDim,
      network_alpha: p.networkAlpha,
      learning_rate: p.learningRate,
      max_train_steps: p.maxTrainSteps,
      resolution: p.resolution,
      clip_skip: p.clipSkip,
      guard: p.guard,
      face_closeup_ratio: p.faceCloseupRatio,
      expected_size_mb: p.expectedSizeMB,
      infer_weight: p.inferWeight,
    }
  })
}

/** 档位 → 标准参数 token 列表（不含 baseline 项） */
export function profileArgList(profile) {
  const p = typeof profile === 'string' ? getProfile(profile) : profile
  if (!p) return []
  const out = [`--network_module=${p.networkModule}`, '--network_args', ...p.networkArgs]
  out.push(`--network_dim=${p.networkDim}`, `--network_alpha=${p.networkAlpha}`)
  out.push(`--learning_rate=${p.learningRate}`, `--max_train_steps=${p.maxTrainSteps}`, `--resolution=${p.resolution}`)
  if (p.clipSkip) out.push(`--clip_skip=${p.clipSkip}`)
  return out
}

/** 单键钳制：越界 → 钳到边界并记 adjusted（不静默） */
function clampArg(arg, profile, spec) {
  const key = keyOf(arg)
  const raw = valueOf(arg)
  const num = Number(raw)
  if (raw === null || !Number.isFinite(num)) {
    return { key, arg: String(arg), adjusted: false, reason: 'not-a-number-passthrough' }
  }
  const lo = typeof spec.min === 'string' ? profile.guard[spec.min] : spec.min
  const hi = typeof spec.max === 'string' ? profile.guard[spec.max] : spec.max
  let v = num
  let reason = null
  if (lo !== undefined && v < lo) { v = lo; reason = 'below-guard-min' }
  if (hi !== undefined && v > hi) { v = hi; reason = 'above-guard-max' }
  if (spec.int) v = Math.round(v)
  const out = `${key}=${v}`
  return { key, arg: out, adjusted: reason !== null, reason, from: num, to: v, guard: { min: lo ?? null, max: hi ?? null }, profile: profile.name }
}

/**
 * 三层归一：baseline（硬底线，不可覆盖） → profile（档位标准值） → userArgs（可钳制追加）。
 * @returns {{args:string[], baselineArgs:string[], profileArgs:string[], adjusted:object[], ignored:object[]}}
 */
export function normalizeArgs({ profile = null, userArgs = [], baselineArgs = [] } = {}) {
  const p = profile ? getProfile(profile) : null
  const baselineArgsOut = baselineArgs.map(String)
  const baselineKeys = setOfKeys(baselineArgsOut)
  const args = [...baselineArgsOut]
  const seen = new Set(baselineKeys)
  const adjusted = []
  const ignored = []
  const profileArgs = []

  if (p) {
    for (const a of profileArgList(p)) {
      const k = keyOf(a)
      // --network_args 后跟的裸 token（algo=lora 等）不是独立键，直接入列
      if (k === '--network_args') { args.push(a); seen.add(k); profileArgs.push(a); continue }
      if (/^(algo|conv_dim|conv_alpha)$/.test(k) && !k.startsWith('--')) {
        // 裸 token 归入上一个 --network_args，不做键去重
        args.push(a); profileArgs.push(a); continue
      }
      if (seen.has(k)) continue
      seen.add(k)
      args.push(a)
      profileArgs.push(a)
    }
  }

  const profileKeys = setOfKeys(profileArgs)

  for (const rawArg of userArgs) {
    const arg = String(rawArg)
    const k = keyOf(arg)
    if (baselineKeys.has(k)) {
      // P4 承诺：底线项不可覆盖
      ignored.push({ arg, key: k, reason: 'baseline-enforced', note: 'baseline 项不可覆盖（保留 P4 语义）' })
      continue
    }
    const spec = ARG_POLICY[k]
    if (spec && spec.policy === 'authoritative') {
      ignored.push({ arg, key: k, reason: 'profile-authoritative', note: `档位 ${p ? p.name : 'n/a'} 自有参数，用户覆盖已忽略` })
      continue
    }
    if (spec && spec.policy === 'clamp' && p) {
      const r = clampArg(arg, p, spec)
      const idx = args.findIndex((a) => keyOf(a) === k)
      if (idx >= 0) args.splice(idx, 1)
      args.push(r.arg)
      seen.add(k)
      if (r.adjusted) adjusted.push(r)
      continue
    }
    if (profileKeys.has(k)) {
      ignored.push({ arg, key: k, reason: 'profile-default', note: '档位标准值优先，用户值已忽略' })
      continue
    }
    if (seen.has(k)) {
      ignored.push({ arg, key: k, reason: 'duplicate', note: '同名参数只保留一份' })
      continue
    }
    seen.add(k)
    args.push(arg)
  }

  return { args, baselineArgs: baselineArgsOut, profileArgs, adjusted, ignored }
}

/**
 * 训练前参数自检（给编排层与测试共用）。
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validateProfileArgs({ profile, args = [] } = {}) {
  const errors = []
  const warnings = []
  const p = profile ? getProfile(profile) : null
  if (!p) return { ok: false, errors: [`未知训练档位: ${profile}（可选 ${PROFILE_NAMES.join(' / ')}）`], warnings }
  const keys = setOfKeys(args)
  if (!keys.has('--network_dim')) errors.push('缺 --network_dim')
  const moduleArg = args.find((a) => keyOf(a) === '--network_module')
  if (!moduleArg) errors.push('缺 --network_module')
  else if (valueOf(moduleArg) !== p.networkModule) errors.push(`--network_module 必须为 ${p.networkModule}（档位 ${p.name}），当前 ${valueOf(moduleArg)}`)
  if (p.networkArgs.length && !args.some((a) => a === '--network_args')) errors.push('LoCon 档位缺 --network_args（algo/conv_dim/conv_alpha）')

  const dim = numericArg(args, '--network_dim')
  if (dim !== null) {
    if (dim < p.guard.minDim || dim > p.guard.maxDim) errors.push(`--network_dim=${dim} 超出档位 ${p.name} 允许区间 [${p.guard.minDim}, ${p.guard.maxDim}]`)
    if (p.name === 'id' && dim > 8) warnings.push('ID 轨秩偏高，有过拟合学习服装/背景的风险')
  }
  const steps = numericArg(args, '--max_train_steps')
  if (steps !== null && (steps < p.guard.minSteps || steps > p.guard.maxSteps)) {
    errors.push(`--max_train_steps=${steps} 超出档位 ${p.name} 允许区间 [${p.guard.minSteps}, ${p.guard.maxSteps}]`)
  }
  const res = numericArg(args, '--resolution')
  if (res !== null && (res < p.guard.minResolution || res > p.guard.maxResolution)) {
    errors.push(`--resolution=${res} 超出档位 ${p.name} 允许区间 [${p.guard.minResolution}, ${p.guard.maxResolution}]`)
  }
  const lr = numericArg(args, '--learning_rate')
  if (lr !== null && (lr < p.guard.minLr || lr > p.guard.maxLr)) {
    errors.push(`--learning_rate=${lr} 超出档位 ${p.name} 允许区间 [${p.guard.minLr}, ${p.guard.maxLr}]`)
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** 训练脚本候选（按基础模型选：SD1.5 用 train_network.py，SDXL 用 sdxl_train_network.py） */
export const TRAINER_SCRIPTS = [
  { name: 'train_network.py', baseModel: 'sd15', note: 'kohya SD1.5 LoRA/LoCon 训练脚本' },
  { name: 'sdxl_train_network.py', baseModel: 'sdxl', note: 'kohya SDXL 训练脚本' },
]

/** 依据基础模型给候选脚本名（未识别 → 优先 SD1.5） */
export function trainerScriptCandidates(baseModel = 'sd15') {
  const m = String(baseModel || 'sd15').toLowerCase()
  if (m.includes('xl')) return ['sdxl_train_network.py', 'train_network.py']
  return ['train_network.py', 'sdxl_train_network.py']
}

export default { PROFILE_NAMES, PROFILES, COMMON_STANDARD, INFER_PLAYBOOK, getProfile, listProfiles, profileArgList, normalizeArgs, validateProfileArgs, keyOf, trainerScriptCandidates, TRAINER_SCRIPTS }