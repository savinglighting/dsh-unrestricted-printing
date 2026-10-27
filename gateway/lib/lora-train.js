/**
 * gateway/lib/lora-train.js — 一键炼制 LoRA 的双轨编排（P3）
 *
 * 一次任务做完整条链路，任何一步不通过就**在训练前**停下（绝不带着坏数据开训）：
 *
 *   ① 采集归一     ingest.collect（本地路径 / 网址 / 参考图，三源统一、精确去重、留痕）
 *   ② 自动标注     caption.captionBatch（本机视觉模型；模型不可用则如实要求用户提供标注）
 *   ③ 自动拆双轨   按构图标签把同一批素材分成 ID 组（锁身份）与 Base 组（画风服装场景）
 *   ④ 命名         lora-naming.resolveLoraNames（**名字可自定义**；冲突自动版本化）
 *   ⑤ 数据集落盘   dataset.planDataset / materializeDataset（kohya 目录 + reg）
 *   ⑥ 训练前硬校验 dataset.validateDataset（配对 / 标注 / 短边 / 特写占比 / 身份 token）
 *   ⑦ 串行两轨训练 id → base（共用同一份采集结果，各自参数档位，独立产物）
 *   ⑧ 产物收集     从输出目录捞出本轨 safetensors，按自定义名投递，回收训练日志与失败分类
 *
 * 本模块**不直接 spawn python**：训练执行通过注入的 `runner` 完成（server 注入真实
 * TrainingManager，测试注入假 runner），因此整条编排都能离线回归。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'

import { getProfile, PROFILE_NAMES } from './training-profiles.js'
import { planDataset, materializeDataset, validateDataset, datasetConfigBlock, sanitizeCaption } from './dataset.js'
import { resolveLoraNames, namesFromFiles } from './lora-naming.js'
import { collect, checkCollection } from './ingest.js'
import { numOr } from './num.js'
import { classifyBatch as defaultSegment, assignTracksFromVision } from './lora-segment.js'
import { releaseVlmVram as defaultReleaseVlmVram } from './vram-guard.js'
import { captionBatch, readSidecarCaptions, placeholderCaption, DEFAULT_VLM_BASE, DEFAULT_VLM_MODEL } from './caption.js'

/** 构图标签：用来把素材拆成两条轨道 */
const CLOSEUP_RE = /\b(close-?up|portrait|headshot|face ?shot|upper body)\b/i
const FULLBODY_RE = /\b(full[- ]?body|half[- ]?body|cowboy shot|three[- ]?quarter|standing|kneeling|sitting)\b/i

/** 单轨耗时估算（分钟）：512/fp16、12GB 级单卡的实测区间 */
export function estimateTrainMinutes(profile, steps = null) {
  const p = getProfile(profile)
  if (!p) return null
  // 走 numOr：不能直接 Number(steps) —— Number(null) === 0 会被当成"显式传了 0 步"
  const s = numOr(steps, p.maxTrainSteps)
  // ID 轨 500 步 ≈ 8–15 分钟；Base 轨 LoCon 800 步 ≈ 20–35 分钟
  const per100 = p.name === 'base' ? 2.6 : 1.7
  const low = Math.round((s / 100) * per100 * 0.85)
  const high = Math.round((s / 100) * per100 * 1.2)
  return { steps: s, minutes: [low, high] }
}

/**
 * 按构图标签把素材拆成 ID 组 / Base 组。
 * 规则：特写归 ID、半身/全身归 Base；判不清的按当前缺口交替补齐；
 * 某一组不足下限时明确报错（不悄悄凑数）。
 */
export function assignTracks({ images = [], captions = {}, minPerTrack = 15 } = {}) {
  const id = []
  const base = []
  const undecided = []
  for (const img of images) {
    const file = typeof img === 'string' ? img : img.path
    const cap = captions[file] || captions[path.basename(file)] || ''
    const isClose = CLOSEUP_RE.test(cap)
    const isFull = FULLBODY_RE.test(cap)
    if (isClose && !isFull) id.push(img)
    else if (isFull && !isClose) base.push(img)
    else undecided.push(img)
  }
  for (const img of undecided) {
    const file = typeof img === 'string' ? img : img.path
    const cap = captions[file] || captions[path.basename(file)] || ''
    const preferId = CLOSEUP_RE.test(cap) || id.length <= base.length
    if (preferId) id.push(img)
    else base.push(img)
  }
  const errors = []
  if (id.length < minPerTrack) errors.push(`ID 轨素材只有 ${id.length} 张（下限 ${minPerTrack}）：请补脸部/头肩特写，或显式指定 id_sources`)
  if (base.length < minPerTrack) errors.push(`Base 轨素材只有 ${base.length} 张（下限 ${minPerTrack}）：请补半身/全身/场景图，或显式指定 base_sources`)
  return { id, base, undecided: undecided.length, errors }
}

/**
 * 生成训练计划（不落盘、不训练）：把命名、数据集、参数、耗时估算一次算清。
 * @param {object} o
 * @param {string[]} o.sources              主来源（本地路径 / URL / 参考图混排）
 * @param {string[]} [o.idSources]          显式给 ID 轨的来源（覆盖自动分轨）
 * @param {string[]} [o.baseSources]        显式给 Base 轨的来源
 * @param {string} [o.name]                 自定义 LoRA 名字（两轨各自加 _id / _base）
 * @param {string} [o.idName]               单独指定 ID 轨名字
 * @param {string} [o.baseName]             单独指定 Base 轨名字
 * @param {string} [o.concept]              数据集概念名（默认按轨推）
 * @param {number} [o.repeat]               kohya 重复次数
 * @param {string[]} [o.regSources]         reg 通用人物图（可选，5–10 张）
 * @param {string} [o.datasetRoot]          数据集根目录（默认 config.trainer.datasetRoot）
 * @param {string[]} [o.existing]           目标 LoRA 目录已有名字（冲突版本化）
 * @param {string[]} [o.bannedTokens]       显式禁用词（来自用户的角色名/作品名）
 * @param {object} [o.argsByProfile]        各轨附加训练参数 { id:[...], base:[...] }
 * @param {'auto'|'sidecar'|'placeholder'} [o.captionMode]
 */
export function planTraining({
  sources = [],
  idSources = null,
  baseSources = null,
  name = null,
  idName = null,
  baseName = null,
  concept = null,
  repeat = 10,
  regSources = [],
  datasetRoot,
  /** kohya 必填的底模路径（--pretrained_model_name_or_path）；缺了训练必然失败，所以计划阶段就校验 */
  baseModelPath = null,
  existing = [],
  bannedTokens = [],
  argsByProfile = {},
  captionMode = 'auto',
  /** 视觉拆解（P5，可选）：用视觉模型按画面主体拆双轨，比标注关键词准；失败自动回退关键轨 */
  visionSplit = false,
  /** 每轨素材下限（标准 15；演练/非常规素材可放宽，但会反映在 warnings 里） */
  minPerTrack = 15,
  /** 放宽脸部特写占比硬拦（演练用；标准流程请保持关闭） */
  relaxRatio = false,
  tracks = PROFILE_NAMES,
} = {}) {
  const errors = []
  const warnings = []
  const wantTracks = (Array.isArray(tracks) && tracks.length ? tracks : PROFILE_NAMES).filter((t) => getProfile(t))
  if (!wantTracks.length) return { ok: false, error: `没有任何可用的训练档位（可选 ${PROFILE_NAMES.join(' / ')}）` }
  const mainSources = Array.isArray(sources) ? sources.filter(Boolean) : [sources].filter(Boolean)
  const splitExplicit = Array.isArray(idSources) && idSources.length && Array.isArray(baseSources) && baseSources.length
  if (!mainSources.length && !splitExplicit) errors.push('没有给任何来源：需要本地路径 / 网址 / 参考图 三者之一')

  const naming = resolveLoraNames({ name, idName, baseName, concept, sources: mainSources, existing, onConflict: 'version' })
  if (!naming.ok) return { ok: false, error: naming.error }
  const conceptBase = naming.concept
  const namesById = { id: naming.id, base: naming.base }
  const namingRest = naming
  // datasetRoot 只检查一次（不要在每轨里各报一遍同样的错）
  if (!datasetRoot) errors.push('缺少 datasetRoot（数据集落盘根目录）')
  // 底模缺失会让训练必然失败：在计划阶段就拦下，而不是烧掉几十分钟才发现
  if (!baseModelPath) {
    errors.push('缺少训练底模（--pretrained_model_name_or_path）：用 GW_BASE_MODEL_PATH 指定 .safetensors，或配置文件 baseModelPath')
  } else if (!fs.existsSync(baseModelPath)) {
    errors.push(`训练底模不存在: ${baseModelPath}`)
  }

  const planTracks = wantTracks.map((t) => {
    const p = getProfile(t)
    const n = namesById[t]
    const est = estimateTrainMinutes(t)
    const ds = datasetRoot
      ? (() => {
        // 概念名缺省跟随产物名：目录 `10_aili_id` 与文件 `aili_id.safetensors` 对得上，便于事后排查
        const conceptForTrack = conceptBase || n.name
        return planDataset({ profile: t, images: [], concept: conceptForTrack, repeat, regImages: [], root: path.join(datasetRoot, n.name) })
      })()
      : null
    if (ds && ds.ok === false) errors.push(`${t} 轨数据集规划失败: ${ds.error}`)
    return {
      profile: t,
      role: p.role,
      title: p.title,
      lora: n,
      standard: {
        network_module: p.networkModule,
        network_args: p.networkArgs,
        network_dim: p.networkDim,
        network_alpha: p.networkAlpha,
        learning_rate: p.learningRate,
        max_train_steps: p.maxTrainSteps,
        resolution: p.resolution,
        clip_skip: p.clipSkip,
      },
      guard: p.guard,
      dataset: ds && ds.ok !== false ? ds : null,
      estimate: est,
      extraArgs: Array.isArray(argsByProfile[t]) ? argsByProfile[t] : [],
      outputName: n.outputName,
      /**
       * 产物目录必须**在 train_data_dir 之外**：
       * kohya 会把 train_data_dir 下每个子目录都当数据集扫，output 放在里面会触发
       * "ignore directory without repeats"，严重时直接没有可用数据。
       * 所以产物落到 datasetRoot 的兄弟目录 _output/<名字>/。
       */
      outputDir: path.join(path.dirname(datasetRoot || '.'), '_output', n.name),
    }
  })

  if (namingRest.notes && namingRest.notes.length) warnings.push(...namingRest.notes)
  if (captionMode === 'placeholder') warnings.push('captionMode=placeholder：所有图将用同一份占位标注，训练结果不可用（仅用于管线连通性自测）')

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    naming: namingRest,
    concept: conceptBase,
    repeat: Number(repeat) || 10,
    tracks: planTracks,
    sources: { main: mainSources, id: idSources || null, base: baseSources || null, reg: regSources || [] },
    captionMode,
    visionSplit: !!visionSplit,
    minPerTrack: Number.isFinite(Number(minPerTrack)) && Number(minPerTrack) > 0 ? Math.round(Number(minPerTrack)) : 15,
    relaxRatio: !!relaxRatio,
    baseModelPath: baseModelPath ? path.resolve(baseModelPath) : null,
    bannedTokens,
    /** 总耗时估算（两轨串行） */
    estimate: {
      tracks: planTracks.map((t) => ({ profile: t.profile, ...t.estimate })),
      minutes: planTracks.reduce((acc, t) => [acc[0] + (t.estimate ? t.estimate.minutes[0] : 0), acc[1] + (t.estimate ? t.estimate.minutes[1] : 0)], [0, 0]),
    },
  }
}

/**
 * 准备数据集：采集 → 标注 → 拆轨 → 落盘 → 硬校验。
 * 所有外部动作（采集/标注）都可注入，便于离线测试。
 * @returns {Promise<{ok:boolean, errors:string[], warnings:string[], tracks:Array, collected:object}>}
 */
export async function prepareDatasets({
  plan,
  ingestFn = collect,
  captionFn = captionBatch,
  segmentFn = defaultSegment,
  minShortSide = 512,
  /** 缺省取计划里的值（计划优先，便于一次任务全程一致） */
  minPerTrack = undefined,
  relaxRatio = undefined,
  vlmBase = DEFAULT_VLM_BASE,
  vlmModel = DEFAULT_VLM_MODEL,
  /** 串行（1）：本机实测并发争抢同一 8B 视觉模型反而更慢，见 caption.js 结论 ⑥ */
  concurrency = 1,
  /** 标注前先让视觉模型释放显存（避免与出图抢卡） */
  releaseVramBeforeCaption = true,
  releaseVlmVram = defaultReleaseVlmVram,
  log = null,
  fetchImpl = globalThis.fetch,
  ingestOptions = {},
  onProgress = null,
} = {}) {
  const errors = []
  const warnings = []
  if (!plan || plan.ok === false) return { ok: false, errors: [...((plan && plan.errors) || ['计划无效'])], warnings, tracks: [], collected: null }

  // 显存互斥：标注/拆解要拉起 8B 视觉模型（本机实测占 5.1GB / 共 8GB），
  // 不先让 Ollama 卸掉常驻模型的话，用户此刻来一句「再画一张」必然出图超时。
  // 只做尽力而为：清理失败也照常继续标注（不能因为清理失败就停下整条流水线）。
  if (releaseVramBeforeCaption) {
    try {
      const rel = await releaseVlmVram({ vlmBase, fetchImpl, log })
      if (rel.freed && rel.freed.length) warnings.push(`已让视觉模型释放显存（${rel.freed.join(', ')}），把显存让给 SD 出图`)
    } catch (e) {
      warnings.push(`显存清理失败（不影响标注）: ${(e && e.message) || e}`)
    }
  }
  // 计划里存的值优先（一次任务全程一致）；显式传参可覆盖
  const trackMin = Number.isFinite(Number(minPerTrack)) && Number(minPerTrack) > 0
    ? Math.round(Number(minPerTrack))
    : (Number.isFinite(Number(plan.minPerTrack)) && Number(plan.minPerTrack) > 0 ? Math.round(Number(plan.minPerTrack)) : 15)
  const relax = relaxRatio === undefined ? !!plan.relaxRatio : !!relaxRatio
  if (trackMin !== 15 || relax) {
    warnings.push(`演练放宽档：每轨素材下限 ${trackMin}（标准 15）${relax ? '、已放宽脸部特写占比硬拦' : ''} —— 结果会低于标准流程质量，不要在正式交付里沿用`)
  }

  const datasetRoot = path.dirname(plan.tracks[0].dataset.root)
  const collectedRoot = path.join(datasetRoot, '_collected')
  const explicitSplit = !!(plan.sources.id && plan.sources.base)

  // ---- ① 采集：显式分轨时两组各自采集（避免两轨混用同一批图），否则只采主来源 ----
  const collectGroup = async (sources, tag, role) => {
    if (!Array.isArray(sources) || !sources.length) return null
    const r = await ingestFn({
      sources,
      destDir: path.join(collectedRoot, tag),
      role,
      minShortSide,
      fetchImpl,
      ...ingestOptions,
    })
    for (const e of r.errors || []) errors.push(`[${tag}] ${e}`)
    const h = checkCollection(r, { minImages: 1, maxImages: 999, minShortSide })
    for (const w of h.warnings) warnings.push(`[${tag}] ${w}`)
    return r
  }

  const idRes = explicitSplit ? await collectGroup(plan.sources.id, 'id', 'user-path') : null
  const baseRes = explicitSplit ? await collectGroup(plan.sources.base, 'base', 'user-path') : null
  const mainRes = explicitSplit
    ? (plan.sources.main.length ? await collectGroup(plan.sources.main, 'main', 'user-path') : null)
    : await collectGroup(plan.sources.main, 'main', 'user-path')
  if (explicitSplit && plan.sources.main.length) {
    warnings.push('已指定 id_sources / base_sources：主 sources 只作留痕，不参与分轨（避免两轨混用同一批图）')
  }
  const collected = mainRes || idRes || baseRes

  const allImages = explicitSplit
    ? [...(idRes ? idRes.images : []), ...(baseRes ? baseRes.images : [])]
    : ((mainRes && mainRes.images) || [])
  if (!allImages.length) {
    return { ok: false, errors: [...errors, '采集结果为 0 张可用图片，无法继续'], warnings, tracks: [], collected }
  }
  if (explicitSplit) {
    const hId = checkCollection(idRes || { images: [] }, { minImages: trackMin, maxImages: 60, minShortSide })
    const hBase = checkCollection(baseRes || { images: [] }, { minImages: trackMin, maxImages: 60, minShortSide })
    for (const e of hId.errors) if (!/少于下限/.test(e)) errors.push(`[id] ${e}`)
    for (const e of hBase.errors) if (!/少于下限/.test(e)) errors.push(`[base] ${e}`)
    for (const w of hId.warnings) warnings.push(`[id] ${w}`)
    for (const w of hBase.warnings) warnings.push(`[base] ${w}`)
  }

  // ---- ② 标注：优先复用侧车 txt；否则自动标注；自动标注不可用时如实要求用户提供（不糊通用模板） ----
  const sidecar = readSidecarCaptions(allImages)
  const sidecarMap = new Map(sidecar.map((s) => [s.file, s.text]))
  const captions = {}
  /** 标注拿不到的图：绝不带空标注进数据集（空标注=学成纯背景） */
  const failedCaption = new Set()
  for (const [file, text] of sidecarMap) {
    const s = sanitizeCaption(text, { bannedTokens: plan.bannedTokens })
    captions[file] = s.text
  }
  const needAuto = allImages.filter((im) => !sidecarMap.has(im.path))
  if (plan.captionMode === 'placeholder') {
    for (const im of needAuto) captions[im.path] = placeholderCaption('id')
    warnings.push(`placeholder 模式：${needAuto.length} 张图使用了占位标注`)
  } else if (needAuto.length) {
    const auto = await captionFn({
      images: needAuto.map((im) => ({ path: im.path, profile: 'id' })),
      concurrency,
      bannedTokens: plan.bannedTokens,
      vlmBase,
      vlmModel,
      fetchImpl,
      onProgress: onProgress ? (p) => onProgress({ stage: 'caption', ...p }) : null,
    })
    if (auto.ok === false) {
      // 部分失败也要把成功的那部分用上（22/23 成功不该整批作废），
      // 但**失败的那几张不能带空标注进数据集** —— 空标注会让模型把它们学成纯背景。
      for (const [file, text] of Object.entries(auto.captions || {})) captions[file] = text
      const failedFiles = new Set((auto.failed || []).map((f) => f.file))
      const skipped = allImages.filter((im) => failedFiles.has(im.path))
      if (skipped.length) {
        for (const im of skipped) failedCaption.add(im.path)
        warnings.push(`有 ${skipped.length} 张图标注失败，已从数据集剔除（不会带空标注进训练）`)
      }
      errors.push(
        `自动标注失败（${auto.errors.length} 张）：视觉模型不可用或看图失败。` +
        `请为素材补同名 .txt 标注，或改用 captionMode 提供标注后重试 —— 批量套用通用模板会让模型学成"所有图都一样"。`,
      )
      for (const e of auto.errors.slice(0, 5)) errors.push(`  · ${e}`)
    } else {
      for (const [file, text] of Object.entries(auto.captions)) captions[file] = text
      if (auto.removed && auto.removed.length) warnings.push(`${auto.removed.length} 张图的自动标注里剔除了身份类词（已净化）`)
    }
  }
  if (sidecarMap.size) warnings.push(`复用了 ${sidecarMap.size} 张图的侧车标注（图片同目录同名 .txt）`)

  // 标注失败的图在拆轨前就剔掉：它们既学不到东西，还会拉低脸部特写占比的统计
  const usableImages = failedCaption.size
    ? allImages.filter((im) => !failedCaption.has(typeof im === 'string' ? im : im.path))
    : allImages
  if (failedCaption.size) {
    warnings.push(`数据集只使用标注成功的 ${usableImages.length}/${allImages.length} 张图`)
  }

  // ---- ③ 拆轨：显式分轨 > 视觉拆解（可选） > 标注关键词 ----
  let idImgs
  let baseImgs
  if (explicitSplit) {
    idImgs = (idRes && idRes.images) || []
    baseImgs = (baseRes && baseRes.images) || []
    if (idImgs.length < trackMin) errors.push(`ID 轨素材只有 ${idImgs.length} 张（下限 ${trackMin}）：请补脸部/头肩特写`)
    if (baseImgs.length < trackMin) errors.push(`Base 轨素材只有 ${baseImgs.length} 张（下限 ${trackMin}）：请补半身/全身/场景图`)
  } else if (plan.visionSplit) {
    // 视觉拆解：看画面主体而不是标注文本。失败**不阻断**，整体回退到关键词拆轨。
    let seg = null
    try {
      if (onProgress) onProgress({ stage: 'segmenting', note: '视觉模型按画面主体拆轨' })
      seg = await segmentFn({ images: usableImages, concurrency, vlmBase, vlmModel, fetchImpl })
    } catch (e) {
      warnings.push(`视觉拆解异常（已回退关键词拆轨）: ${(e && e.message) || e}`)
    }
    if (seg && seg.classified > 0) {
      const byVision = assignTracksFromVision({ images: usableImages, classification: seg.results, trackMin })
      idImgs = byVision.id
      baseImgs = byVision.base
      for (const n of byVision.notes) warnings.push(n)
      if (seg.errors.length) warnings.push(`视觉拆解 ${seg.errors.length} 张失败（这些图已按缺口补齐，不阻断训练）`)
      // 未被分类的图用关键词法补进去
      if (byVision.unclassified.length) {
        const fallback = assignTracks({ images: byVision.unclassified, captions, minPerTrack: 1 })
        idImgs.push(...fallback.id)
        baseImgs.push(...fallback.base)
      }
      for (const e of byVision.errors) errors.push(e)
    } else {
      warnings.push('视觉拆解不可用（模型未返回合法分类），已回退标注关键词拆轨')
      const split = assignTracks({ images: usableImages, captions, minPerTrack: trackMin })
      for (const e of split.errors) errors.push(e)
      idImgs = split.id
      baseImgs = split.base
    }
  } else {
    const split = assignTracks({ images: usableImages, captions, minPerTrack: trackMin })
    for (const e of split.errors) errors.push(e)
    idImgs = split.id
    baseImgs = split.base
    if (split.undecided) warnings.push(`${split.undecided} 张图构图标签不明确，已按缺口交替分配（可用 id_sources/base_sources 手动指定，或开 visionSplit）`)
  }

  const tracks = []
  // 拆轨不均衡的额外提示：总量够但两轨差太多时，告诉用户具体怎么补，而不是只报"数量不足"
  if (idImgs && baseImgs && (idImgs.length + baseImgs.length) >= trackMin * 2) {
    const gap = Math.abs(idImgs.length - baseImgs.length)
    if (gap >= trackMin * 0.4) {
      warnings.push(
        `两轨素材不均衡（ID ${idImgs.length} / Base ${baseImgs.length}）：` +
        `这是素材构图分布决定的（同角色壁纸往往全是全身或半身）。补法二选一 —— ` +
        `① 给缺的那一轨补图（ID 要脸部/头肩特写，Base 要半身/全身/场景）；` +
        `② 用 id_sources / base_sources 显式分轨，把现有图按你的判断分给两轨。`,
      )
    }
  }
  for (const track of plan.tracks) {
    const imgs = track.profile === 'id' ? idImgs : baseImgs
    const imgsForTrack = (imgs || []).map((im) => (typeof im === 'string' ? im : im.path))
    const dsPlan = planDataset({
      profile: track.profile,
      images: imgsForTrack,
      concept: path.basename(track.dataset.mainDir).replace(/^\d+_/, ''),
      repeat: plan.repeat,
      regImages: [],
      root: track.dataset.root,
    })
    if (dsPlan.ok === false) {
      errors.push(`${track.profile} 轨数据集规划失败: ${dsPlan.error}`)
      continue
    }
    const trackCaptions = {}
    for (const f of imgsForTrack) {
      const byPath = captions[f]
      const byName = captions[path.basename(f)]
      trackCaptions[path.basename(f)] = byPath !== undefined ? byPath : (byName !== undefined ? byName : '')
    }
    const mat = materializeDataset({
      plan: dsPlan,
      captions: trackCaptions,
      manifest: {
        profile: track.profile,
        lora: track.lora.name,
        captionMode: plan.captionMode,
        bannedTokens: plan.bannedTokens,
        createdAt: new Date().toISOString(),
        sources: collected.sources,
      },
    })
    if (mat.ok === false) {
      errors.push(`${track.profile} 轨数据集落盘失败: ${mat.error}`)
      continue
    }
    // 把放宽档的下限与占比容忍一起传下去：否则校验器仍按标准 15 张判死，
    // 演练档（minPerTrack=10）会在最后一关被拦，白等十几分钟标注。
    const v = validateDataset({
      plan: dsPlan,
      profile: track.profile,
      bannedTokens: plan.bannedTokens,
      relaxRatio: relax,
      expected: { min: trackMin, max: 30 },
      closeupTolerance: relax ? 1 : 0.05,
    })
    for (const e of v.errors) errors.push(`${track.profile} 轨校验未通过: ${e}`)
    for (const w of v.warnings) warnings.push(`${track.profile} 轨: ${w}`)
    tracks.push({ ...track, dataset: dsPlan, datasetStats: v.stats, datasetConfig: datasetConfigBlock({ plan: dsPlan }), captions: trackCaptions, imageCount: imgsForTrack.length })
  }

  return { ok: errors.length === 0, errors, warnings, tracks, collected, captions }
}

/** kohya 日志尾部的进度解析（`steps: 30%|15/500` 形态） */
export function parseProgress(logText, totalSteps = null) {
  const t = String(logText || '')
  const m = [...t.matchAll(/steps:\s*(\d+)%\|?\s*(\d+)\/(\d+)/g)].pop()
  if (m) return { percent: Number(m[1]), step: Number(m[2]), total: Number(m[3]) }
  const m2 = [...t.matchAll(/(\d+)\s*\/\s*(\d+)\s*\[/g)].pop()
  if (m2) {
    const total = Number(m2[2]) || totalSteps
    return { percent: total ? Math.round((Number(m2[1]) / total) * 100) : null, step: Number(m2[1]), total }
  }
  return { percent: null, step: null, total: totalSteps }
}

/** 训练失败分类：给"下一步怎么修"而不是一个裸 exit code */
export function classifyTrainFailure({ exitCode = null, logTail = '' } = {}) {
  const t = String(logTail || '')
  if (/CUDA out of memory|OutOfMemoryError|显存不足/i.test(t)) {
    return { code: 'TRAIN_OOM', hint: '显存不足：确认 AdamW8bit + fp16 + enable_bucket + 512 分辨率；仍不够时降 batch_size 或改 --lowvram' }
  }
  // 参数缺失类：kohya 用 assert 报出来，比"缺依赖"更具体，必须单独识别
  if (/resolution is required/i.test(t)) {
    return { code: 'TRAIN_ARG_MISSING', hint: '缺 --resolution：训练命令行必须带分辨率（档位标准里的 resolution 要落进命令）' }
  }
  if (/ignore directory without repeats/i.test(t) && /AssertionError|no data|0 .*images/i.test(t)) {
    return { code: 'TRAIN_DATA_LAYOUT', hint: '数据集目录结构不对：kohya 要求 <train_data_dir>/<数字_名字>/ 且只放图片与同名 txt（output 等子目录不要放在里面）' }
  }
  if (/ConnectTimeout|WinError 10060|Max retries exceeded|huggingface\.co/i.test(t)) {
    return { code: 'TRAIN_HF_OFFLINE', hint: '训练时联网拉 tokenizer 失败：注入 HF_HOME + HF_HUB_OFFLINE=1 指向本机 SD 的 .cache/huggingface（网关已自动注入）' }
  }
  if (/No such file or directory.*\.py|can't open file/i.test(t)) {
    return { code: 'TRAIN_SCRIPT_MISSING', hint: '训练脚本不存在：用 GW_TRAIN_SCRIPT 指向 kohya 的 train_network.py' }
  }
  if (/ModuleNotFoundError|ImportError/i.test(t)) {
    return { code: 'TRAIN_DEPS_MISSING', hint: '缺 Python 依赖：kohya 训练环境未装全（bitsandbytes / lycoris 等）' }
  }
  if (/lycoris|network_args/i.test(t) && /not found|unknown/i.test(t)) {
    return { code: 'TRAIN_LYCON_UNAVAILABLE', hint: 'LoCon（lycoris.kohya）不可用：请安装 lycoris 或把 Base 轨临时降级为 networks.lora' }
  }
  if (/caption|\.txt|image_dir/i.test(t) && /error|not found/i.test(t)) {
    return { code: 'TRAIN_DATA_ERROR', hint: '数据集读取失败：核对 kohya 目录、图片与同名 txt 是否配对' }
  }
  if (exitCode === 0) return { code: null, hint: null }
  return { code: 'TRAIN_FAILED', hint: `训练进程异常退出（exit=${exitCode === null ? 'n/a' : exitCode}），看训练日志尾部定位` }
}

/** 从输出目录里捞出本轨产物（safetensors 优先；返回最新的一个） */
export function findArtifact({ outputDir, expectedName = null } = {}) {
  if (!outputDir || !fs.existsSync(outputDir)) return { ok: false, error: `输出目录不存在: ${outputDir}` }
  let files = []
  try {
    files = fs.readdirSync(outputDir).filter((f) => /\.(safetensors|ckpt|pt)$/i.test(f))
  } catch (e) {
    return { ok: false, error: `读取输出目录失败: ${(e && e.message) || e}` }
  }
  if (!files.length) return { ok: false, error: `输出目录里没有训练产物: ${outputDir}` }
  const pick = expectedName && files.find((f) => namesFromFiles([f])[0] === expectedName)
  const file = pick || files.sort((a, b) => fs.statSync(path.join(outputDir, b)).mtimeMs - fs.statSync(path.join(outputDir, a)).mtimeMs)[0]
  const full = path.join(outputDir, file)
  return { ok: true, file: full, name: namesFromFiles([file])[0], bytes: fs.statSync(full).size }
}

/**
 * 串行执行两轨训练（runner 由调用方注入：真实实现 = TrainingManager，测试 = 假 runner）。
 * @param {object} o
 * @param {Function} o.runner  async ({ profile, args, outputName, outputDir, logFile }) => { ok, exitCode, logTail, pid, taskId }
 * @returns {Promise<{ok:boolean, results:Array, errors:string[]}>}
 */
export async function runTracks({ plan, prepared, runner, onTrack = null } = {}) {
  const errors = []
  const results = []
  if (!runner) return { ok: false, results, errors: ['缺少 runner（训练执行器）'] }
  const tracks = (prepared && prepared.tracks) || plan.tracks
  for (const track of tracks) {
    const args = [
      ...(track.extraArgs || []),
      `--train_data_dir=${track.dataset.root}`,
      `--output_dir=${track.outputDir}`,
      `--output_name=${track.outputName}`,
      // kohya 必填：没有底模根本跑不起来（计划阶段已校验，这里只是落进命令行）
      ...(plan.baseModelPath ? [`--pretrained_model_name_or_path=${plan.baseModelPath}`] : []),
      // 档位标准必须落进命令行 —— 实测漏了 --resolution 时 kohya 直接 AssertionError：
      //   "resolution is required"（dreambooth_dataset.py 的 assert）。
      // 所以这里把档位标准里的必需项全部显式带上，不依赖 kohya 的默认值。
      ...(track.standard && track.standard.resolution ? [`--resolution=${track.standard.resolution}`] : []),
      ...(track.standard && track.standard.network_module ? [`--network_module=${track.standard.network_module}`] : []),
      ...(track.standard && track.standard.network_dim ? [`--network_dim=${track.standard.network_dim}`] : []),
      ...(track.standard && track.standard.network_alpha ? [`--network_alpha=${track.standard.network_alpha}`] : []),
      ...(track.standard && track.standard.learning_rate ? [`--learning_rate=${track.standard.learning_rate}`] : []),
      ...(track.standard && track.standard.max_train_steps ? [`--max_train_steps=${track.standard.max_train_steps}`] : []),
      ...(track.standard && track.standard.clip_skip ? [`--clip_skip=${track.standard.clip_skip}`] : []),
      // LoCon 档位要带 --network_args（algo / conv_dim / conv_alpha）
      ...(track.standard && Array.isArray(track.standard.network_args) && track.standard.network_args.length
        ? ['--network_args', ...track.standard.network_args]
        : []),
      // 加速与稳定性（不改训练语义）
      '--cache_latents',
      '--sdpa',
      '--seed=20261021',
    ]
    if (onTrack) {
      try { onTrack({ stage: 'start', profile: track.profile, name: track.lora.name, args }) } catch { /* 进度回调不许炸 */ }
    }
    let r
    try {
      r = await runner({
        profile: track.profile,
        args,
        outputName: track.outputName,
        /** 与上方 `--output_dir` 必须是同一个目录，否则产物会写到查不到的地方 */
        outputDir: track.outputDir,
        datasetConfig: track.datasetConfig,
        standard: track.standard,
        logFile: null,
      })
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) }
    }
    const cls = classifyTrainFailure({ exitCode: r && r.exitCode, logTail: (r && r.logTail) || '' })
    const rec = {
      profile: track.profile,
      name: track.lora.name,
      ok: !!(r && r.ok),
      exitCode: r ? r.exitCode : null,
      failure: r && r.ok ? null : cls,
      error: r && r.error ? r.error : null,
      logFile: r ? r.logFile || null : null,
      pid: r ? r.pid || null : null,
      /** 训练任务 id 与耗时透传（登记表要记"这个 LoRA 烧了多久"） */
      taskId: r ? r.taskId || null : null,
      durationMs: r ? numOr(r.durationMs) : null,
      timedOut: !!(r && r.timedOut),
    }
    results.push(rec)
    if (onTrack) {
      try { onTrack({ stage: 'end', ...rec }) } catch { /* 同上 */ }
    }
    if (!rec.ok) {
      errors.push(`${track.profile} 轨训练失败${cls.code ? ` [${cls.code}]` : ''}：${cls.hint || rec.error || '未知原因'}`)
      break // 前一轨没产物，后面那轨也没有意义（串行语义）
    }
  }
  return { ok: errors.length === 0, results, errors }
}

export default {
  estimateTrainMinutes,
  assignTracks,
  planTraining,
  prepareDatasets,
  parseProgress,
  classifyTrainFailure,
  findArtifact,
  runTracks,
}