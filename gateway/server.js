/**
 * gateway/server.js — 本地 AIGC 调度网关（P1/P2/P3/P4 收口）
 *
 * 唯一入口：前端（sd-inject.ps1 表单 / 插件工具）只跟本网关说话，**不直连 WebUI/ComfyUI**。
 *
 * 接口：
 *   POST /api/generate            → 200 {task_id, status:'queued'}（训练中 → 409）
 *   GET  /api/status/{task_id}    → {status: queued|training|running|success|failed, error, result, ...}
 *   GET  /api/tasks?limit=&status=
 *   GET  /api/queue
 *   POST /api/training/start      → 训练独占（强制注入 --network_dim=4 --optimizer_type=AdamW8bit --lowvram）
 *   POST /api/training/end        → 释放独占锁 + 清理临时文件
 *   GET  /api/training/status
 *   GET  /api/models              → 4 个枚举的可用性探测
 *   GET  /api/monitor             → ROS2/降级后的硬件快照 + 准入建议
 *   GET  /api/engines             → 进程管家台账（PID/参数/健康/阶梯）
 *   POST /api/engines/{engine}/restart → 手动强杀重启（走同一套 taskkill /F /T）
 *   POST /api/breaker/reset
 *   GET  /api/health | /api/logs | /api/config
 */

'use strict'

import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'

import { config as defaultConfig, describeConfig } from './lib/config.js'
import { Logger } from './lib/logger.js'
import { MODELS, MODEL_KEYS, normalizeModel, routeFor, checkSize, probeAllSync } from './lib/models.js'
import { TaskStore, STATUS } from './lib/store.js'
import { CircuitBreaker, isTimeoutOrConnError } from './lib/breaker.js'
import { EngineManager } from './lib/engine-manager.js'
import { EngineClients, classifyError } from './lib/engines.js'
import { Monitor } from './lib/monitor.js'
import { TrainingManager } from './lib/training.js'
import { listProfiles, INFER_PLAYBOOK } from './lib/training-profiles.js'
import { LoraTrainer } from './lib/lora-runner.js'
import { planTraining } from './lib/lora-train.js'
import { readRegistry, mergedListing, listLoraFiles, refreshWebui, callSyntaxOf } from './lib/lora-registry.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A1111 采样器名 → ComfyUI 采样器名（大小写/写法都不同，必须映射）。
 * 映射不到就回落 fallback（模型自己的 samplerHint）——绝不把非法名透传给 ComfyUI。
 */
const A1111_TO_COMFY_SAMPLER = {
  'euler': 'euler',
  'euler a': 'euler_ancestral',
  'euler ancestral': 'euler_ancestral',
  'heun': 'heun',
  'lms': 'lms',
  'ddim': 'ddim',
  'dpm++ 2m': 'dpmpp_2m',
  'dpm++ 2m karras': 'dpmpp_2m',
  'dpm++ 2m sde': 'dpmpp_2m_sde',
  'dpm++ 2m sde karras': 'dpmpp_2m_sde',
  'dpm++ sde': 'dpmpp_sde',
  'dpm++ sde karras': 'dpmpp_sde',
  'dpm2': 'dpm_2',
  'dpm2 a': 'dpm_2_ancestral',
  'unipc': 'uni_pc',
  'lcm': 'lcm',
  'restart': 'res_multistep',
}
/** ComfyUI 认识的采样器名（本地 /object_info 实测的 45 项里的常用子集 + 兜底判断） */
const COMFY_SAMPLER_NAMES = new Set([
  'euler', 'euler_ancestral', 'euler_ancestral_cfg_pp', 'euler_cfg_pp',
  'heun', 'heunpp2', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast', 'dpm_adaptive',
  'dpmpp_2s_ancestral', 'dpmpp_sde', 'dpmpp_sde_gpu', 'dpmpp_2m', 'dpmpp_2m_sde',
  'dpmpp_2m_sde_gpu', 'dpmpp_3m_sde', 'dpmpp_3m_sde_gpu', 'ddpm', 'lcm', 'ipndm',
  'ipndm_v', 'deis', 'res_multistep', 'res_multistep_cfg_pp', 'res_multistep_ancestral',
  'res_multistep_ancestral_cfg_pp', 'gradient_estimation', 'gradient_estimation_cfg_pp',
  'er_sde', 'seeds_2', 'seeds_3', 'ddim', 'uni_pc', 'uni_pc_bh2',
])

export function comfySamplerName(raw, fallback = 'euler') {
  const key = String(raw || '').trim().toLowerCase()
  if (!key) return fallback
  if (COMFY_SAMPLER_NAMES.has(key)) return key
  if (A1111_TO_COMFY_SAMPLER[key]) return A1111_TO_COMFY_SAMPLER[key]
  // 未知名字：不让 ComfyUI 去报 400，直接回落模型推荐值
  return fallback
}

/**
 * 组装一个网关实例（不监听端口，便于测试直接拿对象）。
 * @param {object} overrides 覆盖 config 的字段（测试用）
 */
export function createGateway(overrides = {}) {
  const cfg = mergeConfig(defaultConfig, overrides)
  const logger = overrides.logger || new Logger({ dir: cfg.logDir, level: cfg.logLevel, name: cfg.name })
  const log = logger.child('gw')

  const store = new TaskStore({ stateFile: cfg.stateFile, log, now: overrides.now })
  const breaker = new CircuitBreaker({ threshold: cfg.breaker.threshold, cooldownMs: cfg.breaker.cooldownMs, log })
  const mgr = new EngineManager({ webuiLadder: cfg.webui.vramLadder, comfyLadder: cfg.comfy.vramLadder, log })
  const clients = new EngineClients({
    webuiUrl: cfg.webui.url,
    comfyUrl: cfg.comfy.url,
    log,
    breaker,
    fetchImpl: overrides.fetchImpl || globalThis.fetch,
    timeouts: cfg.timeouts,
  })
  const monitor = new Monitor({
    url: cfg.ros2.url,
    topic: cfg.ros2.topic,
    enabled: cfg.ros2.enabled,
    nvidiaIntervalMs: cfg.ros2.nvidiaIntervalMs,
    vramMinFreeGb: cfg.monitor.vramMinFreeGb,
    vramWarnFreeGb: cfg.monitor.vramWarnFreeGb,
    staleMs: cfg.monitor.staleMs,
    log,
    wsFactory: overrides.wsFactory,
    exec: overrides.execFile,
  })
  const training = new TrainingManager({
    store,
    engineManager: mgr,
    log,
    tempRoot: cfg.trainer.tempRoot,
    /** 训练日志单独落盘：不随临时目录清理消失（失败分类要读日志尾部） */
    logDir: cfg.trainer.logDir,
    /** HF 离线环境：kohya 不联网拉 tokenizer（连不上 huggingface 会卡 6 分钟后失败） */
    trainEnv: cfg.trainer.trainEnv,
    /** 硬底线（不可覆盖）；双轨档位标准单独传，见 training-profiles.js */
    baselineArgs: cfg.trainer.baselineArgs || cfg.trainer.forcedArgs,
    profiles: cfg.trainer.profiles,
    profileDefault: cfg.trainer.profileDefault,
    script: cfg.trainer.script,
    python: cfg.trainer.python,
    spawnFn: overrides.spawnFn,
  })

  const loraTrainer = new LoraTrainer({
    training,
    store,
    log,
    loraDir: cfg.trainer.loraDir,
    registryFile: cfg.trainer.registryFile,
    webuiUrl: cfg.webui.url,
    trainTimeoutMs: cfg.trainer.loraTimeoutMs || undefined,
    pollMs: cfg.trainer.loraPollMs || undefined,
    refreshAfterDeliver: cfg.trainer.refreshAfterDeliver !== false,
    fetchImpl: overrides.fetchImpl || globalThis.fetch,
    now: overrides.now,
  })

  const state = {
    running: false,
    busy: false,
    nextPumpAt: 0,
    pumpTimer: null,
    lastPumpNote: null,
    generation: 0,
  }

  // ---------------- 出口目录 ----------------

  function resolveOutDir(payload = {}) {
    const raw = payload.out_dir || payload.outDir
    if (!raw) return cfg.outDir
    let dir = String(raw)
    if (!path.isAbsolute(dir)) dir = path.join(cfg.outDir, dir)
    const abs = path.resolve(dir)
    try { fs.mkdirSync(abs, { recursive: true }) } catch (e) {
      log.warn('outdir.create_failed', { dir: abs, error: e })
      return cfg.outDir
    }
    return abs
  }

  // ---------------- 模型可用性（带缓存） ----------------

  let probeCache = null
  let probeCacheAt = 0

  async function probeModels(force = false) {
    if (!force && probeCache && Date.now() - probeCacheAt < cfg.modelProbeCacheMs) return probeCache
    const webui = await clients.probeWebui()
    const comfy = await clients.probeComfy()
    const comfyFiles = comfy.online ? await clients.comfyModelFiles() : null
    const list = probeAllSync({
      webuiOnline: webui.online,
      webuiCheckpoint: webui.checkpoint,
      comfyOnline: comfy.online,
      comfyDir: cfg.comfy.dir,
      comfyFiles,
    })
    probeCache = { list, engines: { webui, comfy }, at: Date.now() }
    probeCacheAt = Date.now()
    return probeCache
  }

  function probeOne(modelKey) {
    const cached = probeCache && Date.now() - probeCacheAt < cfg.modelProbeCacheMs
      ? probeCache.list.find((m) => m.key === modelKey)
      : null
    return cached || null
  }

  // ---------------- 引擎启动命令与纳管 ----------------

  /** 引擎启动器的输出落盘：进程起来了但引擎没就绪时，这份日志是唯一证据（不静默吞错） */
  function launchStdio(engine) {
    try {
      fs.mkdirSync(cfg.logDir, { recursive: true })
      const file = path.join(cfg.logDir, `engine-${engine}.launch.log`)
      const fd = fs.openSync(file, 'a')
      return { stdio: ['ignore', fd, fd], file }
    } catch (e) {
      log.warn('engine.launch_log_unavailable', { engine, error: e })
      return { stdio: 'ignore', file: null }
    }
  }

  function buildLaunchCmd(engine, { flag = null, withLog = false } = {}) {
    if (engine === 'webui') {
      const script = cfg.webui.launcher.script
      if (!script || !fs.existsSync(script)) {
        log.error('engine.launcher_missing', { engine, script })
        return []
      }
      const cmd = [
        cfg.webui.launcher.shell || 'powershell',
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-StartOnly',
      ]
      // 显存阶梯旗标要以 -VramFlag 参数形式传给 sd-direct.ps1（白名单校验在脚本内），
      // 所以这里自己摆位置，告诉 engine-manager 不要再往末尾追加。
      if (flag) cmd.push('-VramFlag', flag)
      const out = { cmd, includeFlag: false }
      if (withLog) Object.assign(out, launchStdio(engine))
      return out
    }
    const py = cfg.comfy.python
    const dir = cfg.comfy.dir
    if (!py || !fs.existsSync(py)) {
      log.error('engine.launcher_missing', { engine, python: py })
      return []
    }
    const out = { cmd: [py, ...(cfg.comfy.launchArgs || ['main.py'])], cwd: dir }
    if (withLog) Object.assign(out, launchStdio(engine))
    return out
  }

  /** 出图前把引擎纳管（网关不是它爹，也要能 kill/restart 它） */
  async function ensureAdopted(engine) {
    const port = engine === 'webui' ? cfg.webui.port : cfg.comfy.port
    const rec = mgr.get(engine)
    const probe = engine === 'webui' ? await clients.probeWebui() : await clients.probeComfy()
    if (!probe.online) {
      if (rec) log.warn('engine.offline_but_registered', { engine, pid: rec.pid })
      return false
    }
    if (!rec || !mgr.isAlive(rec)) {
      const adopted = await mgr.adopt(engine, { port })
      if (!adopted) log.warn('engine.adopt_failed', { engine, port, note: '端口反查不到 PID：OOM 阶梯将只能重启不能强杀' })
    }
    return true
  }

  // ---------------- 出图 worker ----------------

  /** 确保某引擎在线（内部复用：bridge Stage1 需要 WebUI 时按需拉起，不等前端来调 ensure 接口）。
   *  返回 { online, started, pid?, error? }；任何失败只记日志，不抛。 */
  async function ensureEngineOnline(engine) {
    try {
      const probe = engine === 'webui' ? await clients.probeWebui() : await clients.probeComfy()
      if (probe.online) {
        await ensureAdopted(engine)
        return { online: true, started: false }
      }
      const built = buildLaunchCmd(engine, { withLog: true })
      const cmdArr = Array.isArray(built) ? built : built.cmd
      const cwd = Array.isArray(built) ? undefined : built.cwd
      const stdio = Array.isArray(built) ? 'ignore' : (built.stdio || 'ignore')
      const logFile = Array.isArray(built) ? null : (built.file || null)
      if (!cmdArr || !cmdArr.length) {
        log.error('internal.ensure_launcher_missing', { engine })
        return { online: false, started: false, error: `找不到 ${engine} 的启动命令` }
      }
      const { spawn } = await import('node:child_process')
      const child = spawn(cmdArr[0], cmdArr.slice(1), { detached: mgr.spawnDetached, stdio, windowsHide: true, cwd })
      child.unref()
      mgr.register(engine, { pid: child.pid, args: cmdArr.slice(1), cmdline: cmdArr.join(' '), source: 'ensure', port: engine === 'webui' ? cfg.webui.port : cfg.comfy.port })
      log.warn('internal.engine_ensure', { engine, pid: child.pid, cmd: cmdArr.join(' '), launchLog: logFile })
      const ready = await clients.waitReady(engine, cfg.timeouts.engineReadyMs)
      probeCache = null
      if (ready) await ensureAdopted(engine)
      if (!ready) log.error('internal.ensure_not_ready', { engine, pid: child.pid, launchLog: logFile })
      return { online: ready, started: true, pid: child.pid, error: ready ? null : `${engine} 未在超时内就绪` }
    } catch (e) {
      log.error('internal.ensure_failed', { engine, error: e })
      return { online: false, started: false, error: String((e && e.message) || e) }
    }
  }

  async function generateOnce(task, attempt) {
    const model = task.model
    const m = MODELS[model]
    const p = task.payload || {}
    const outDir = resolveOutDir(p)
    const name = String(p.name || task.id.slice(0, 8))
    const engine = routeFor(model)
    const seed = Number.isFinite(Number(p.seed)) ? Number(p.seed) : -1
    const width = Number(p.width) || (engine === 'comfy' ? 1024 : 512)
    const height = Number(p.height) || (engine === 'comfy' ? 1024 : 768)
    const steps = Number(p.steps) || m.stepsHint || 24
    const cfgScale = Number(p.cfg) || m.cfgHint || 7
    const denoise = Number(p.denoise) >= 0 ? Number(p.denoise) : 0
    // 采样器：前端（sd-inject / A 档脚本）默认给的是 **A1111 的采样器名**（如 `DPM++ 2M`），
    // 而 ComfyUI 只认自己的小写名（euler / dpmpp_2m …）——直接透传会导致 ComfyUI 400
    // `value_not_in_list: sampler_name`（用户实测：两次都没出图就是这个）。
    // 这里按引擎分流：WebUI 用原名；ComfyUI 走映射表，映射不到就回落该模型的 samplerHint。
    const rawSampler = p.sampler ? String(p.sampler).trim() : ''
    const sampler = engine === 'comfy'
      ? comfySamplerName(rawSampler, m.samplerHint || 'euler')
      : (rawSampler || m.samplerHint || 'DPM++ 2M')
    if (engine === 'comfy' && rawSampler && sampler !== rawSampler) {
      log.warn('sampler.mapped_for_comfy', { model, from: rawSampler, to: sampler })
    }

    if (engine === 'webui') {
      const r = await clients.webuiGenerate({
        prompt: p.prompt || '',
        negative: p.negative || '',
        initImage: p.init_image || p.initImage || '',
        mask: p.mask || '',
        width, height, steps, cfg: cfgScale,
        denoise: denoise > 0 ? denoise : 0.6,
        sampler,
        seed,
        checkpoint: p.checkpoint || null,
        adetailerFace: p.adetailer !== false,
        maskBlur: p.mask_blur,
        inpaintFill: p.inpaint_fill,
        inpaintFullRes: p.inpaint_full_res !== false,
        inpaintPadding: p.inpaint_full_res_padding,
        extra: p.extra && typeof p.extra === 'object' ? p.extra : null,
      })
      if (!r.ok) return r
      let paths = []
      try {
        paths = clients.webuiSaveImages(r.imagesB64, outDir, name)
      } catch (e) {
        return { ok: false, error: `图片落盘失败: ${(e && e.message) || e}`, errorType: 'engine' }
      }
      return { ok: true, paths, seed: r.seed, engine, attempt }
    }

    // comfy
    const r = await clients.comfyGenerate({
      prompt: p.prompt || '',
      negative: p.negative || '',
      initImage: p.init_image || p.initImage || '',
      mask: p.mask || '',
      width, height, steps, cfg: cfgScale,
      denoise: denoise > 0 ? denoise : 1.0,
      sampler, scheduler: m.schedulerHint || 'normal',
      seed, name, modelKey: model, model: m,
      // 提交后立刻把 prompt_id 记进任务（进度接口要用它判断 ComfyUI 队列位置）
      onSubmitted: (pid) => { task.result = { ...(task.result || {}), prompt_id: pid } },
    })
    if (!r.ok) return r
    const paths = []
    for (const img of r.images) {
      try {
        paths.push(await clients.comfyFetchImage(img, outDir, name))
      } catch (e) {
        return { ok: false, error: `图片下载失败: ${(e && e.message) || e}`, errorType: 'engine' }
      }
    }
    return { ok: true, paths, promptId: r.promptId, notes: r.notes, engine, attempt }
  }

  /**
   * 跑一个任务。返回 'done' | 'busy' | 'defer'
   *   busy : 拿不到单车道锁 → 留在队列等下一轮（排队而非拒单）
   *   defer: 显存准入不通过 → 稍后再来（不丢任务）
   */
  async function runTask(task) {
    const p = task.payload || {}
    const model = task.model
    const m = MODELS[model]
    const engine = routeFor(model)

    // ---- 跨架构 LoRA 搬运：两阶段管线 ----
    //   Stage 1: SD_FP16 + LoRA 出图（角色/画风正确）
    //   Stage 2: DiT 模型 img2img，用 Stage 1 的图做底图，低重绘迁移风格
    //   这样 DiT 档也能用 SD1.5 LoRA。
    if (task.kind === 'bridge') {
      // 先迁 RUNNING（迁移表不允许 queued→success，不先迁最后 setStatus(SUCCESS) 会被拒、任务永远卡 queued）
      store.setStatus(task.id, STATUS.RUNNING, { engine, startedAt: Date.now() })
      store.saveState()
      // 【2026-10-27 用户要求：优先适配 ComfyUI 下面的模型】
      //   原来的 0.25 只给 Stage1 的图「补一层皮」——Stage1 若出灰泥/糊图，0.25 原样保留底色，
      //   成品必然崩。改成 **0.55**：让 DiT（Qwen/Krea2）真正主导重绘，画质归 Comfy 模型，
      //   同时 Stage1 只负责给出正确的角色轮廓/构图（LoRA 的角色特征靠轮廓传递）。
      const bridgeDenoise = Number(p.bridge_denoise) > 0 ? Number(p.bridge_denoise) : 0.55
      // Stage1 底模：优先前端指定的 bridge_checkpoint（动漫底），其次表单选中的 checkpoint，最后 WebUI 当前
      const bridgeCkpt = p.bridge_checkpoint || (p.extra && p.extra.bridge_checkpoint) || p.checkpoint || null
      const bridgePrompt = String(p.prompt || '').replace(/<lora:[^>]*>/gi, '').replace(/,\s*,/g, ', ').trim()
      const bridgeNegative = String(p.negative || '')
      // Stage1（SD1.5）专用提示词：把权重括号拉平（(xxx:1.2) → xxx），并压掉连续逗号。
      //   SD1.5 底模对大量权重括号/修饰词很敏感，容易出灰泥糊图；Stage1 只要「角色轮廓 + 构图」。
      //   LoRA 片段**保留**（角色特征靠它），Stage2 才用完整提示词交给 DiT 发挥。
      const flattenWeights = (s) => String(s || '')
        .replace(/\(([^():]+?):[0-9.]+\)/g, '$1')
        .replace(/\[\s*|\s*\]/g, '')
        .replace(/(\s*,\s*)+/g, ', ')
        .trim()
      const stage1Prompt = flattenWeights(String(p.prompt || ''))

      // Stage 1: SD_FP16 + LoRA（SD1.5 基座在 1216x1536 上必崩解剖/OOM → 钳到 768x1024 内）
      let s1W = Number(p.width) || 640
      let s1H = Number(p.height) || 960
      if (s1W > 768 || s1H > 1024) {
        const r = Math.min(768 / s1W, 1024 / s1H)
        s1W = Math.max(64, Math.round((s1W * r) / 8) * 8)
        s1H = Math.max(64, Math.round((s1H * r) / 8) * 8)
      }
      // Stage1 走 WebUI：先确保 WebUI 在线（DiT 档场景前端可能根本没拉起过 WebUI），
      // 再让 ComfyUI 卸掉常驻的 DiT 模型（8G 卡上否则 WebUI 加载 checkpoint 会 OOM）
      const webuiReady = await ensureEngineOnline('webui')
      if (!webuiReady.online) log.warn('task.bridge_stage1_webui_offline', { id: task.id, error: webuiReady.error })
      await clients.comfyFreeVram()
      log.info('task.bridge_stage1', { id: task.id, model, width: s1W, height: s1H, denoise: bridgeDenoise, checkpoint: bridgeCkpt || '(webui当前)' })
      const s1 = store.createTask({
        kind: 'image', model: 'SD_FP16', engine: 'webui',
        payload: {
          ...p,
          prompt: stage1Prompt,
          negative: bridgeNegative,
          width: s1W, height: s1H,
          steps: Number(p.steps) || 30,
          cfg: Number(p.cfg) || 7,
          denoise: 0,
          sampler: p.sampler || 'DPM++ 2M',
          // 前端可指定 Stage1 的底模（动漫底优先，避免 anything-v5 的灰泥风）
          checkpoint: bridgeCkpt,
        },
      })
      const r1 = await runTask(s1)
      if (r1 !== 'done' || !s1.result || !s1.result.paths || s1.result.paths.length === 0) {
        log.warn('task.bridge_stage1_failed', { id: task.id, stage1_status: s1.status, stage1_error: s1.error })
        store.fail(task.id, 'BRIDGE_STAGE1_FAILED', `跨架构搬运 Stage 1 失败（SD_FP16+LoRA）：${s1.error || s1.status}`)
        store.remove(task.id)
        return 'done'
      }
      const stage1Path = s1.result.paths[0]
      log.info('task.bridge_stage1_done', { id: task.id, path: stage1Path })

      // Stage 2: DiT img2img —— DiT 主导重绘（denoise 0.55），画质归 ComfyUI 模型
      log.info('task.bridge_stage2', { id: task.id, model, denoise: bridgeDenoise, init: stage1Path })
      const s2 = store.createTask({
        kind: 'image', model, engine,
        payload: {
          ...p,
          prompt: bridgePrompt,
          negative: bridgeNegative,
          width: Number(p.width) || 1024,
          height: Number(p.height) || 1024,
          steps: Math.min(Number(p.steps) || 24, 30),
          cfg: Number(p.cfg) || 1.0,
          denoise: bridgeDenoise,
          init_image: stage1Path,
          sampler: p.sampler || 'euler',
        },
      })
      const r2 = await runTask(s2)
      if (r2 !== 'done' || !s2.result || !s2.result.paths || s2.result.paths.length === 0) {
        log.warn('task.bridge_stage2_failed', { id: task.id, stage2_status: s2.status, stage2_error: s2.error })
        store.fail(task.id, 'BRIDGE_STAGE2_FAILED', `跨架构搬运 Stage 2 失败（DiT img2img）：${s2.error || s2.status}`)
        store.remove(task.id)
        return 'done'
      }
      const stage2Paths = s2.result.paths
      log.info('task.bridge_done', { id: task.id, paths: stage2Paths.length })
      store.setStatus(task.id, STATUS.SUCCESS, {
        result: {
          paths: stage2Paths,
          seed: s2.result.seed ?? null,
          engine,
          notes: [`跨架构搬运：Stage1 SD_FP16+LoRA ${s1W}x${s1H} → Stage2 ${model} img2img denoise=${bridgeDenoise}`, ...(s2.result.notes || [])],
          bridge: { stage1: stage1Path, stage2: stage2Paths, denoise: bridgeDenoise, stage1_size: `${s1W}x${s1H}` },
        },
        output: stage2Paths,
        finishedAt: Date.now(),
      })
      store.remove(task.id)
      return 'done'
    }

    // ---- 普通出图 ----

    // ---- 准备阶段（不占锁）----
    const size = checkSize(model, Number(p.width) || (engine === 'comfy' ? 1024 : 512), Number(p.height) || (engine === 'comfy' ? 1024 : 768))
    if (!size.ok) {
      log.warn('task.rejected_size', { id: task.id, model, reason: size.reason })
      store.fail(task.id, 'SIZE_NOT_ALLOWED', size.reason)
      store.remove(task.id)
      return 'done'
    }
    let probe = probeOne(model)
    if (!probe || probe.status !== 'ok') {
      const fresh = await probeModels(true)
      probe = fresh.list.find((x) => x.key === model) || probe
    }
    if (!probe || probe.status !== 'ok') {
      const detail = probe ? probe.detail : `${model} 可用性未知`
      log.warn('task.rejected_model', { id: task.id, model, status: probe && probe.status, detail })
      store.fail(task.id, probe && probe.status === 'no-model' ? 'MODEL_UNAVAILABLE' : 'ENGINE_OFFLINE', detail)
      store.remove(task.id)
      return 'done'
    }

    // ---- 监控准入（OOM 预警 / 队列准入；不阻塞 /api/generate）----
    const adm = monitor.admission()
    const risk = monitor.oomRisk()
    task.admission = adm
    task.meta = { ...(task.meta || {}), vram_warning: risk.risk === 'low' ? null : risk }
    if (!adm.admit) {
      if (cfg.monitor.strictAdmission) {
        state.lastPumpNote = adm.reason
        log.warn('queue.defer_low_vram', { id: task.id, vramFreeGb: adm.vramFreeGb, waitMs: adm.waitMs, mode: 'strict' })
        return 'defer'
      }
      // 默认（非严格）模式：只预警不拦单 —— 引擎常驻显存，剩余低不代表这单跑不动；
      // 硬拦会让任务永久停在队列（监控的定位是预警，不是闸门）。
      log.warn('queue.low_vram_proceed', { id: task.id, vramFreeGb: adm.vramFreeGb, note: '非严格准入：照常出图（可用 GW_VRAM_STRICT=1 改为排队等待）' })
      state.lastPumpNote = `显存偏低 ${adm.vramFreeGb}GB：已预警但照常开跑`
    }
    if (adm.level === 'warn') log.warn('queue.vram_warn', { id: task.id, reason: adm.reason })

    // ---- 正式出图：抢单车道锁 ----
    if (!store.tryAcquire(task.id)) {
      state.lastPumpNote = `单车道被占用（owner=${store.gateOwner}）`
      return 'busy'
    }
    store.setStatus(task.id, STATUS.RUNNING, { engine, startedAt: Date.now() })
    store.saveState()
    log.info('task.running', { id: task.id, model, engine, width: p.width, height: p.height, attempt: 1 })

    try {
      await ensureAdopted(engine)
      for (let attempt = 1; attempt <= 4; attempt++) {
        task.attempts = attempt
        const res = await generateOnce(task, attempt)
        if (res.ok) {
          const paths = res.paths || []
          store.setStatus(task.id, STATUS.SUCCESS, {
            result: { paths, seed: res.seed ?? null, prompt_id: res.promptId || null, engine, notes: res.notes || [], attempts: attempt },
            output: paths,
            finishedAt: Date.now(),
          })
          log.info('task.success', { id: task.id, model, engine, attempts: attempt, files: paths.length })
          if (res.notes && res.notes.length) log.warn('task.notes', { id: task.id, notes: res.notes })
          return 'done'
        }

        const type = res.errorType || classifyError(res.error)
        log.warn('task.attempt_failed', { id: task.id, model, engine, attempt, errorType: type, error: res.error })
        // 熔断计数由引擎客户端负责（engines.js 只对「超时/连接」类记失败）。
        // 这里不再重复计数：否则「被熔断拦下」的结果会被再记一次，把冷却时间无限续期。
        if (type === 'circuit') log.warn('task.circuit_blocked', { id: task.id, engine, error: res.error })
        if (type === 'device-mismatch') {
          // 引擎设备错位（unload 之后必崩的 HalfTensor）：先 reload-checkpoint 自愈一次再重试，
          // 不做无限自愈（自愈只给一次机会，失败就明确 failed，让用户看到真实原因）。
          const healed = task.meta && task.meta.deviceHealed
          if (!healed && engine === 'webui') {
            task.meta = { ...(task.meta || {}), deviceHealed: true }
            log.warn('task.device_mismatch_heal', { id: task.id, attempt, error: res.error })
            const h = await clients.webuiReloadCheckpoint()
            if (h.ok) continue
            store.fail(task.id, 'ENGINE_DEVICE_MISMATCH', `设备错位且 reload-checkpoint 自愈失败：${res.error}`)
            return 'done'
          }
          store.fail(task.id, 'ENGINE_DEVICE_MISMATCH', `引擎设备错位（自愈已尝试）：${res.error}`)
          return 'done'
        }
        if (type === 'oom') {
          // P2：强杀进程树 → 按阶梯重启（每级最多 1 次）→ 重试
          const ladder = await mgr.handleOom({
            engine,
            error: res.error,
            // 把阶梯旗标交给 buildLaunchCmd 自己摆位（webui 需要 "-VramFlag <flag>" 这种两段式参数）
            buildCmd: ({ flag }) => buildLaunchCmd(engine, { flag }),
            waitReady: (e) => clients.waitReady(e, cfg.timeouts.engineReadyMs),
          })
          task.oomLadder = [...(task.oomLadder || []), { attempt, level: ladder.level, flag: ladder.flag, restarted: !!ladder.restarted, reason: ladder.reason || null, pid: ladder.pid || null }]
          log.warn('task.oom_ladder', { id: task.id, attempt, ...ladder })
          if (ladder.restarted) {
            await probeModels(true)
            continue
          }
          store.fail(task.id, 'OOM_LADDER_EXHAUSTED', `显存不足且阶梯重启失败/用尽：${res.error}（阶梯：${JSON.stringify(task.oomLadder)}）`, { oomLadder: task.oomLadder })
          return 'done'
        }
        // 非 OOM：直接 failed（把引擎侧原文带出来，失败可查询）
        store.fail(task.id, type === 'model' ? 'MODEL_UNAVAILABLE' : 'GENERATE_FAILED', res.error || '出图失败')
        return 'done'
      }
      store.fail(task.id, 'OOM_LADDER_EXHAUSTED', 'OOM 阶梯全部用尽仍未成功（每级最多重试 1 次）', { oomLadder: task.oomLadder })
      return 'done'
    } catch (e) {
      log.error('task.crashed', { id: task.id, error: e })
      store.fail(task.id, 'INTERNAL_ERROR', String((e && e.message) || e))
      return 'done'
    } finally {
      // 不管成功失败，锁与队列都必须清干净
      store.release(task.id)
      store.remove(task.id)
      store.saveState()
    }
  }

  // ---------------- 进度（进度条数据源） ----------------

  /**
   * 任务进度：**引擎特定探测 + 兜底估算**，前端只读这一个接口（不直连 WebUI/ComfyUI）。
   *   webui → 问 A1111 的 /sdapi/v1/progress（真实百分比 + ETA）
   *   comfy → /queue 看是否在跑；跑起来后按 elapsed/expectedSec 估算（ComfyUI 无稳定进度接口）
   * 任何探测失败都不抛：退化成"按时间估算"，进度条照样动。
   */
  async function progressFor(task) {
    const now = Date.now()
    const elapsedMs = task.startedAt ? now - task.startedAt : 0
    const m = MODELS[task.model] || {}
    const expected = Number(m.expectedSec) || 30
    const base = {
      task_id: task.id,
      status: task.status,
      model: task.model,
      engine: task.engine,
      elapsed_ms: elapsedMs,
      queue_position: store.queuePosition(task.id),
      eta_sec: null,
      percent: 0,
      stage: task.status,
      detail: '',
      estimated: false,
    }

    if (task.status === 'queued') {
      return { ...base, stage: 'queued', percent: 0, detail: '排队中（单车道，前面还有任务）' }
    }
    if (task.status === 'success') {
      return { ...base, stage: 'success', percent: 100, detail: '完成' }
    }
    if (task.status === 'failed') {
      return { ...base, stage: 'failed', percent: 100, detail: task.error || '失败' }
    }
    if (task.status === 'training') {
      return { ...base, stage: 'training', percent: 0, detail: '训练独占中' }
    }

    // running：按引擎取进度
    if (task.engine === 'webui') {
      const r = await clients.request(`${cfg.webui.url}/sdapi/v1/progress?skip_current_image=true`, { timeoutMs: 2500, quiet: true })
      if (r.ok && r.json && typeof r.json.progress === 'number' && r.json.progress > 0) {
        const pct = Math.max(1, Math.min(99, Math.round(r.json.progress * 100)))
        const st = r.json.state || {}
        return {
          ...base,
          stage: 'sampling',
          percent: pct,
          eta_sec: Number.isFinite(Number(r.json.eta_relative)) ? Math.round(Number(r.json.eta_relative)) : null,
          detail: st.sampling_step != null ? `采样 ${st.sampling_step}/${st.sampling_steps} 步` : '采样中',
          estimated: false,
        }
      }
      // 探测不到（引擎刚加载模型/没装 progress 接口）→ 时间估算
      const pct = Math.min(95, Math.round((elapsedMs / 1000 / expected) * 100))
      return {
        ...base,
        stage: elapsedMs < 3000 ? 'loading' : 'sampling',
        percent: Math.max(1, pct),
        eta_sec: Math.max(0, Math.round(expected - elapsedMs / 1000)),
        detail: elapsedMs < 3000 ? '模型加载/开始采样…' : '采样中（按时间估算）',
        estimated: true,
      }
    }

    // comfy
    const q = await clients.request(`${cfg.comfy.url}/queue`, { timeoutMs: 2500, quiet: true })
    let running = false
    if (q.ok && q.json) {
      const runIds = (q.json.queue_running || []).map((x) => x && x[1])
      const pendIds = (q.json.queue_pending || []).map((x) => x && x[1])
      running = !!task.result && !!task.result.prompt_id && runIds.includes(task.result.prompt_id)
      const pending = !!task.result && !!task.result.prompt_id && pendIds.includes(task.result.prompt_id)
      if (pending && !running) {
        return { ...base, stage: 'queued', percent: Math.max(2, base.percent), detail: 'ComfyUI 队列排队中' }
      }
    }
    const pct = Math.min(95, Math.round((elapsedMs / 1000 / expected) * 100))
    return {
      ...base,
      stage: elapsedMs < 8000 ? 'loading' : 'sampling',
      percent: Math.max(3, pct),
      eta_sec: Math.max(0, Math.round(expected - elapsedMs / 1000)),
      detail: elapsedMs < 8000 ? '加载模型/编码提示词…' : '采样中（ComfyUI 无进度接口，按时间估算）',
      estimated: true,
    }
  }

  // ---------------- 队列泵（单车道，500ms 心跳 + 主动唤醒） ----------------

  async function pump() {
    if (state.busy || !state.running) return
    if (store.training) {
      state.lastPumpNote = '训练独占中（isTraining=true）：队列暂停'
      return
    }
    if (Date.now() < state.nextPumpAt) return
    const id = store.peek()
    if (!id) return
    const task = store.getTask(id)
    if (!task) { store.remove(id); return }
    if (task.status !== STATUS.QUEUED) { store.remove(id); return }
    state.busy = true
    try {
      const r = await runTask(task)
      if (r === 'defer') {
        const adm = task.admission || { waitMs: 5000 }
        state.nextPumpAt = Date.now() + Math.max(1000, adm.waitMs || 5000)
      } else if (r === 'busy') {
        state.nextPumpAt = Date.now() + 1000
      } else {
        state.nextPumpAt = 0
      }
    } catch (e) {
      log.error('pump.error', { error: e })
      state.nextPumpAt = Date.now() + 2000
    } finally {
      state.busy = false
    }
  }

  function wake() {
    setTimeout(() => { pump().catch((e) => log.error('pump.wake_failed', { error: e })) }, 0)
  }

  // ---------------- HTTP ----------------

  function readBody(req, limit = 32 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (c) => {
        data += c
        if (data.length > limit) { req.destroy(); reject(new Error('请求体过大')) }
      })
      req.on('end', () => {
        if (!data) return resolve({})
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error(`JSON 解析失败: ${e && e.message}`)) }
      })
      req.on('error', reject)
    })
  }

  function send(res, code, obj) {
    let body
    try { body = JSON.stringify(obj) } catch (e) {
      log.error('http.serialize_failed', { error: e })
      body = JSON.stringify({ error: 'SERIALIZE_FAILED', message: String((e && e.message) || e) })
      code = 500
    }
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  function taskView(t) {
    return {
      task_id: t.id,
      status: t.status,
      kind: t.kind,
      model: t.model,
      engine: t.engine,
      error: t.error || null,
      error_code: t.errorCode || null,
      result: t.result || null,
      paths: (t.result && t.result.paths) || null,
      attempts: t.attempts || 0,
      oom_ladder: t.oomLadder || [],
      vram_warning: (t.meta && t.meta.vram_warning) || null,
      queue_position: store.queuePosition(t.id),
      created_at: t.createdAt,
      started_at: t.startedAt,
      finished_at: t.finishedAt,
    }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const p = u.pathname
    if (req.method === 'OPTIONS') return send(res, 204, {})
    try {
      // ---- 出图 ----
      if (req.method === 'POST' && p === '/api/generate') {
        const body = await readBody(req)
        if (store.training) {
          log.warn('api.generate_blocked_training', { model: body && body.model })
          return send(res, 409, { error: 'TRAINING_IN_PROGRESS', message: '训练进行中（isTraining=true），生图请求被独占锁拦截', training: store.trainingInfo() })
        }
        const model = normalizeModel(body.model)
        if (!model) { log.warn('api.generate_rejected_model', { received: body && body.model }); return send(res, 400, { error: 'UNKNOWN_MODEL', message: `model 必须是以下之一: ${MODEL_KEYS.join(', ')}`, received: body.model }) }
        if (!body.prompt || !String(body.prompt).trim()) {
          log.warn('api.generate_rejected_prompt', { promptType: typeof body.prompt, promptLen: body.prompt ? String(body.prompt).length : 0, keys: Object.keys(body || {}) })
          return send(res, 400, { error: 'EMPTY_PROMPT', message: 'prompt 不能为空' })
        }

        // ---- 跨架构 LoRA 搬运（2026-10-26 用户要求「所有模型都能用同一套 LoRA」）----
        //   本机 LoRA 全是 SD1.5 的；DiT 档（QwenImage_NVFP4 / Krea2_Q4）的 UNet 权重与 SD1.5 不兼容，
        //   直接挂上去**静默失败**（网关翻译成 ComfyUI LoraLoader 节点，但权重形状对不上）。
        //   两阶段管线：
        //     Stage 1: SD_FP16 + LoRA 出图（角色/画风正确）
        //     Stage 2: DiT 模型 img2img，用 Stage 1 的图做底图，低重绘（0.3-0.45）迁移风格
        //   这样 4 个模型档都能用同一套 SD1.5 LoRA。
        const loraRe = /<\s*lora\s*:\s*[^:>]+/gi
        const hasLora = typeof body.prompt === 'string' && loraRe.test(body.prompt)
        const isDiT = model === 'QwenImage_NVFP4' || model === 'Krea2_Q4'
        // 【2026-10-27】DiT 档 + LoRA → 走跨架构转译（bridge）：Stage1 SD1.5+LoRA 出角色
        //   → Stage2 DiT 高 denoise(0.55) 重绘，让 ComfyUI 模型主导画质。
        //   前端可用 use_bridge=false 显式关闭，退回 DiT 直出。
        const wantBridge = body.use_bridge !== false && !(body.extra && body.extra.use_bridge === false)
        const bridgeMode = hasLora && isDiT && wantBridge

        const engine = routeFor(model)
        const width = Number(body.width) || (engine === 'comfy' ? 1024 : 512)
        const height = Number(body.height) || (engine === 'comfy' ? 1024 : 768)
        const size = checkSize(model, width, height)
        if (!size.ok) {
          log.warn('api.generate_rejected_size', { model, width, height, reason: size.reason })
          return send(res, 400, { error: 'SIZE_NOT_ALLOWED', message: size.reason, max_side: size.maxSide })
        }
        const probe = (await probeModels()).list.find((m) => m.key === model)
        const task = store.createTask({
          kind: bridgeMode ? 'bridge' : 'image',
          model, engine,
          payload: { ...body, width, height, bridge: bridgeMode },
        })
        const adm = monitor.admission()
        log.info('api.generate', { task_id: task.id, model, engine, width, height, probe: probe && probe.status, admission: adm.level, bridge: bridgeMode })
        send(res, 200, {
          task_id: task.id,
          status: 'queued',
          model,
          engine,
          bridge: bridgeMode,
          queue_position: store.queuePosition(task.id),
          admission: adm,
          model_status: probe ? probe.status : 'unknown',
        })
        wake()
        return
      }

      // ---- 状态查询（失败可查询）----
      const st = p.match(/^\/api\/status\/([^/]+)$/)
      if (req.method === 'GET' && st) {
        const t = store.getTask(decodeURIComponent(st[1]))
        if (!t) return send(res, 404, { error: 'NOT_FOUND', message: '任务不存在（可能已被清理，历史上限 500）' })
        return send(res, 200, taskView(t))
      }

      if (req.method === 'GET' && p === '/api/tasks') {
        const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 200)
        const status = u.searchParams.get('status') || null
        return send(res, 200, { tasks: store.listTasks({ limit, status }).map(taskView) })
      }

      // ---- 进度（进度条数据源；只读、非阻塞；前端只读这个接口，不直连引擎）----
      const pg = p.match(/^\/api\/progress\/([^/]+)$/)
      if (req.method === 'GET' && pg) {
        const t = store.getTask(decodeURIComponent(pg[1]))
        if (!t) return send(res, 404, { error: 'NOT_FOUND', message: '任务不存在' })
        const info = await progressFor(t)
        return send(res, 200, info)
      }

      if (req.method === 'GET' && p === '/api/queue') {
        return send(res, 200, { queue: store.queue.map((id) => { const t = store.getTask(id); return t ? taskView(t) : { task_id: id, status: 'lost' } }), summary: store.summary(), last_note: state.lastPumpNote })
      }

      // ---- 训练 ----
      if (req.method === 'POST' && p === '/api/training/start') {
        const body = await readBody(req)
        const r = training.start({
          extraArgs: Array.isArray(body.args) ? body.args : [],
          cmd: Array.isArray(body.cmd) ? body.cmd : null,
          meta: body.meta || {},
          // profile 支持显式 'id' / 'base' / null（null = 只注入硬底线，不套档位）
          profile: Object.prototype.hasOwnProperty.call(body, 'profile') ? body.profile : undefined,
        })
        if (!r.ok) {
          const code = r.code === 'TRAINING_ALREADY_ACTIVE' ? 409
            : (r.code === 'TRAIN_PROFILE_UNKNOWN' ? 400 : 501)
          log.warn('api.training_start_failed', { code, error: r.error })
          return send(res, code, { error: r.code, message: r.error })
        }
        log.warn('api.training_start', { task_id: r.taskId, pid: r.pid, profile: r.profile, cmd: r.cmd_line })
        return send(res, 200, {
          task_id: r.taskId,
          status: 'training',
          pid: r.pid,
          cmd: r.cmd,
          cmd_line: r.cmd_line,
          injected: r.injected,
          profile: r.profile,
          profile_args: r.profile_args,
          adjusted: r.adjusted,
          ignored: r.ignored,
          temp_dir: r.tempDir,
          log_file: r.logFile,
        })
      }

      if (req.method === 'GET' && p === '/api/training/profiles') {
        return send(res, 200, {
          profiles: listProfiles(),
          default: cfg.trainer.profileDefault,
          infer_playbook: INFER_PLAYBOOK,
          baseline_args: cfg.trainer.baselineArgs || cfg.trainer.forcedArgs,
          base_model: cfg.trainer.baseModel,
          script: cfg.trainer.script,
          script_candidates: cfg.trainer.scriptCandidates,
          lora_dir: cfg.trainer.loraDir,
          lora_dir_candidates: cfg.trainer.loraDirCandidates,
          train_root: cfg.trainer.trainRoot,
          dataset_root: cfg.trainer.datasetRoot,
        })
      }

      if (req.method === 'POST' && p === '/api/training/end') {
        const r = await training.stop({ reason: 'api' })
        log.warn('api.training_end', r)
        return send(res, 200, { status: 'idle', killed: r.killed, released: r.released !== false, task_id: r.taskId || null })
      }

      if (req.method === 'GET' && p === '/api/training/status') {
        const info = store.trainingInfo()
        const task = info.meta && info.meta.taskId ? store.getTask(info.meta.taskId) : null
        return send(res, 200, { ...info, task: task ? taskView(task) : null, current: training.current ? { pid: training.current.pid, cmd: training.current.cmd, startedAt: training.current.startedAt } : null })
      }

      // ---- 一键炼制 LoRA（P4 闭环）----
      // 当前 LoRA 目录里已有的名字（用于命名冲突版本化，避免覆盖别人的 LoRA）
      const existingLoraNames = () => {
        const disk = listLoraFiles({ loraDir: cfg.trainer.loraDir })
        return (disk.files || []).map((f) => f.name)
      }
      const buildPlanFromBody = (body) => {
        const sources = Array.isArray(body.sources) ? body.sources : (body.sources ? [body.sources] : (body.source ? [].concat(body.source) : []))
        return planTraining({
          sources,
          idSources: Array.isArray(body.id_sources) ? body.id_sources : (Array.isArray(body.idSources) ? body.idSources : null),
          baseSources: Array.isArray(body.base_sources) ? body.base_sources : (Array.isArray(body.baseSources) ? body.baseSources : null),
          name: body.name || null,
          idName: body.idName || body.id_name || null,
          baseName: body.baseName || body.base_name || null,
          concept: body.concept || null,
          repeat: body.repeat,
          datasetRoot: body.datasetRoot || body.dataset_root || cfg.trainer.datasetRoot,
          baseModelPath: body.baseModelPath || body.base_model_path || cfg.trainer.baseModelPath,
          existing: Array.isArray(body.existing) ? body.existing : existingLoraNames(),
          bannedTokens: Array.isArray(body.bannedTokens) ? body.bannedTokens : (Array.isArray(body.banned_tokens) ? body.banned_tokens : []),
          argsByProfile: body.args_by_profile || {},
          captionMode: body.captionMode || body.caption_mode || 'auto',
          visionSplit: body.visionSplit === true || body.vision_split === true || body.visionSplit === 'true' || body.vision_split === 'true',
          tracks: Array.isArray(body.tracks) && body.tracks.length ? body.tracks : undefined,
        })
      }

      if (req.method === 'POST' && p === '/api/lora/plan') {
        const body = await readBody(req)
        let plan
        try {
          plan = buildPlanFromBody(body)
        } catch (e) {
          return send(res, 400, { error: 'LORA_PLAN_INVALID', message: `计划生成失败: ${(e && e.message) || e}` })
        }
        log.info('api.lora_plan', { ok: plan.ok, name: plan.naming && plan.naming.id ? plan.naming.id.name : null, tracks: (plan.tracks || []).map((t) => t.profile) })
        return send(res, plan.ok ? 200 : 400, {
          ...plan,
          lora_dir: cfg.trainer.loraDir,
          dataset_root: cfg.trainer.datasetRoot,
          note: '这是预览：不会下载、不会落盘、不会训练。确认后 POST /api/lora/train 用同样的 body 提交。',
        })
      }

      if (req.method === 'POST' && p === '/api/lora/train') {
        const body = await readBody(req)
        if (store.training) {
          return send(res, 409, { error: 'TRAINING_IN_PROGRESS', message: '已有训练在跑（训练为全局独占）', training: store.trainingInfo() })
        }
        let plan
        try {
          plan = buildPlanFromBody(body)
        } catch (e) {
          return send(res, 400, { error: 'LORA_PLAN_INVALID', message: `计划生成失败: ${(e && e.message) || e}` })
        }
        if (!plan.ok) return send(res, 400, { error: 'LORA_PLAN_INVALID', ...plan })
        if (!cfg.trainer.loraDir) {
          return send(res, 501, { error: 'LORA_DIR_UNAVAILABLE', message: '未解析到 SD 的 LoRA 目录：设置 GW_LORA_DIR 或配置文件 loraDir 后重试' })
        }
        const task = store.createTask({ kind: 'lora-train', model: null, engine: 'trainer', payload: { name: plan.naming && plan.naming.id ? plan.naming.id.name : null, tracks: plan.tracks.map((t) => t.profile), sources: plan.sources } })
        store.setStatus(task.id, 'queued', { result: { stage: 'queued' } })
        store.saveState()
        // 后台跑完整链路：采集 → 标注 → 拆轨 → 训练 → 投递 → 登记 → 刷新
        loraTrainer
          .run({ taskId: task.id, plan })
          .catch((e) => {
            log.error('api.lora_train_unhandled', { task_id: task.id, error: e })
            try { store.fail(task.id, 'LORA_TRAIN_UNHANDLED', `炼制流程未捕获异常: ${(e && e.message) || e}`) } catch { /* 状态已是终态 */ }
          })
        log.warn('api.lora_train_start', { task_id: task.id, name: plan.naming && plan.naming.id ? plan.naming.id.name : null, tracks: plan.tracks.map((t) => t.profile) })
        return send(res, 202, {
          task_id: task.id,
          status: 'queued',
          name: plan.naming && plan.naming.id ? plan.naming.id.name : null,
          naming: plan.naming,
          tracks: plan.tracks.map((t) => ({ profile: t.profile, name: t.lora.name, file: t.lora.fileName, call: t.lora.callSyntax, standard: t.standard })),
          estimate: plan.estimate,
          warnings: plan.warnings,
          lora_dir: cfg.trainer.loraDir,
          registry: cfg.trainer.registryFile,
          status_url: `/api/status/${task.id}`,
        })
      }

      const loraStop = p.match(/^\/api\/lora\/train\/([^/]+)\/stop$/)
      if (req.method === 'POST' && loraStop) {
        const id = decodeURIComponent(loraStop[1])
        const t = store.getTask(id)
        if (!t) return send(res, 404, { error: 'NOT_FOUND', message: '任务不存在' })
        const r = await training.stop({ reason: `lora-stop:${id}` })
        try { store.fail(id, 'LORA_STOPPED', '用户中止炼制', { stopped: r }) } catch { /* 已是终态 */ }
        return send(res, 200, { status: 'stopped', task_id: id, killed: r.killed })
      }

      const loraOne = p.match(/^\/api\/lora\/train\/([^/]+)$/)
      if (req.method === 'GET' && loraOne) {
        const t = store.getTask(decodeURIComponent(loraOne[1]))
        if (!t) return send(res, 404, { error: 'NOT_FOUND', message: '任务不存在' })
        const view = taskView(t)
        const progress = await progressFor(t)
        return send(res, 200, { ...progress, task: view, name: t.payload && t.payload.name ? t.payload.name : null })
      }

      if (req.method === 'GET' && p === '/api/lora/list') {
        const registry = readRegistry({ file: cfg.trainer.registryFile })
        const merged = mergedListing({ registry, loraDir: cfg.trainer.loraDir })
        return send(res, 200, {
          ...merged,
          registry_file: cfg.trainer.registryFile,
          registry_updated_at: registry.updatedAt,
          profile_weights: listProfiles().map((x) => ({ profile: x.name, infer_weight: x.infer_weight })),
        })
      }

      if (req.method === 'POST' && p === '/api/lora/refresh') {
        const r = await refreshWebui({ url: cfg.webui.url, fetchImpl: overrides.fetchImpl || globalThis.fetch })
        if (r.ok) log.warn('api.lora_refresh', { endpoint: r.endpoint })
        else log.warn('api.lora_refresh_failed', { reason: r.reason })
        return send(res, 200, { ...r, note: r.ok ? 'A1111 已重扫 LoRA 列表，参数表立即可见' : '刷新未成功不算失败：产物已在 LoRA 目录，SD 下次启动会自然扫到' })
      }

      if (req.method === 'GET' && p === '/api/lora/syntax') {
        const q = u.searchParams.get('name')
        const w = u.searchParams.get('weight')
        return send(res, 200, { name: q, call: callSyntaxOf(q, w === null ? null : Number(w)) })
      }

      // ---- 探测/监控/台账 ----
      if (req.method === 'GET' && p === '/api/models') {
        const fresh = await probeModels(u.searchParams.get('refresh') === '1')
        return send(res, 200, { models: fresh.list, engines: fresh.engines })
      }

      if (req.method === 'GET' && p === '/api/monitor') {
        return send(res, 200, { snapshot: monitor.getSnapshot(), admission: monitor.admission(), oom_risk: monitor.oomRisk() })
      }

      if (req.method === 'GET' && p === '/api/engines') {
        return send(res, 200, mgr.snapshot())
      }

      const restart = p.match(/^\/api\/engines\/(webui|comfy)\/restart$/)
      if (req.method === 'POST' && restart) {
        const engine = restart[1]
        const rec = mgr.get(engine) || (await mgr.adopt(engine, { port: engine === 'webui' ? cfg.webui.port : cfg.comfy.port }))
        let killed = null
        if (rec && rec.pid) killed = await mgr.killTree(rec.pid)
        mgr.unregister(engine, 'manual-restart')
        const built = buildLaunchCmd(engine, { withLog: true })
        const cmdArr = Array.isArray(built) ? built : built.cmd
        const cwd = Array.isArray(built) ? undefined : built.cwd
        const stdio = Array.isArray(built) ? 'ignore' : (built.stdio || 'ignore')
        const logFile = Array.isArray(built) ? null : (built.file || null)
        if (!cmdArr || !cmdArr.length) return send(res, 501, { error: 'LAUNCHER_UNAVAILABLE', message: `找不到 ${engine} 的启动命令（webui.launcher.script / comfy.python + dir）` })
        let child = null
        try {
          const { spawn } = await import('node:child_process')
          child = spawn(cmdArr[0], cmdArr.slice(1), { detached: mgr.spawnDetached, stdio, windowsHide: true, cwd })
          child.unref()
        } catch (e) {
          log.error('api.restart_spawn_failed', { engine, error: e })
          return send(res, 500, { error: 'SPAWN_FAILED', message: String((e && e.message) || e) })
        }
        mgr.register(engine, { pid: child.pid, args: cmdArr.slice(1), cmdline: cmdArr.join(' '), source: 'manual-restart', port: engine === 'webui' ? cfg.webui.port : cfg.comfy.port })
        probeCache = null
        log.warn('api.engine_restart', { engine, pid: child.pid, cmd: cmdArr.join(' '), launchLog: logFile })
        return send(res, 200, { engine, pid: child.pid, killed, cmd: cmdArr.join(' '), launch_log: logFile })
      }

      // 引擎按需拉起：前端只调这里，不再自己拼启动命令
      const ensure = p.match(/^\/api\/engines\/(webui|comfy)\/ensure$/)
      if (req.method === 'POST' && ensure) {
        const engine = ensure[1]
        const probe = engine === 'webui' ? await clients.probeWebui() : await clients.probeComfy()
        if (probe.online) {
          await ensureAdopted(engine)
          return send(res, 200, { engine, online: true, started: false })
        }
        const built = buildLaunchCmd(engine, { withLog: true })
        const cmdArr = Array.isArray(built) ? built : built.cmd
        const cwd = Array.isArray(built) ? undefined : built.cwd
        const stdio = Array.isArray(built) ? 'ignore' : (built.stdio || 'ignore')
        const logFile = Array.isArray(built) ? null : (built.file || null)
        if (!cmdArr || !cmdArr.length) {
          log.error('api.ensure_launcher_missing', { engine })
          return send(res, 501, { error: 'LAUNCHER_UNAVAILABLE', message: `找不到 ${engine} 的启动命令` })
        }
        let child = null
        try {
          const { spawn } = await import('node:child_process')
          child = spawn(cmdArr[0], cmdArr.slice(1), { detached: mgr.spawnDetached, stdio, windowsHide: true, cwd })
          child.unref()
        } catch (e) {
          log.error('api.ensure_spawn_failed', { engine, error: e })
          return send(res, 500, { error: 'SPAWN_FAILED', message: String((e && e.message) || e) })
        }
        mgr.register(engine, { pid: child.pid, args: cmdArr.slice(1), cmdline: cmdArr.join(' '), source: 'ensure', port: engine === 'webui' ? cfg.webui.port : cfg.comfy.port })
        log.warn('api.engine_ensure', { engine, pid: child.pid, cmd: cmdArr.join(' '), launchLog: logFile })
        const ready = await clients.waitReady(engine, cfg.timeouts.engineReadyMs)
        probeCache = null
        if (ready) await ensureAdopted(engine)
        if (!ready) log.error('api.ensure_not_ready', { engine, pid: child.pid, launchLog: logFile, note: '引擎未在超时内就绪，请看该启动日志' })
        return send(res, ready ? 200 : 504, { engine, online: ready, started: true, pid: child.pid, cmd: cmdArr.join(' '), launch_log: logFile })
      }

      if (req.method === 'POST' && p === '/api/breaker/reset') {
        const body = await readBody(req)
        const key = body && body.engine ? body.engine : undefined
        breaker.reset(key)
        return send(res, 200, { reset: true, breaker: key ? breaker.state(key) : null, breakers: breaker.all() })
      }

      if (req.method === 'GET' && p === '/api/breaker') return send(res, 200, { breakers: breaker.all() })

      if (req.method === 'GET' && p === '/api/health') {
        const probes = await probeModels()
        return send(res, 200, {
          gateway: 'ok',
          uptime_s: Math.round(process.uptime()),
          pid: process.pid,
          engines: {
            webui: probes.engines.webui.online ? 'ok' : 'offline',
            comfy: probes.engines.comfy.online ? 'ok' : 'offline',
          },
          engine_manager: mgr.snapshot(),
          store: store.summary(),
          monitor: { snapshot: monitor.getSnapshot(), admission: monitor.admission() },
          breakers: breaker.all(),
          config_file: cfg.configFile,
          out_dir: cfg.outDir,
        })
      }

      if (req.method === 'GET' && p === '/api/logs') {
        const n = Math.min(Number(u.searchParams.get('n')) || 80, 300)
        return send(res, 200, { logs: logger.recent(n), file: logger.file })
      }

      if (req.method === 'GET' && p === '/api/config') {
        return send(res, 200, { config: describeConfig(), runtime: cfg })
      }

      return send(res, 404, { error: 'NOT_FOUND', path: p })
    } catch (e) {
      log.error('http.handler_error', { path: p, method: req.method, error: e })
      return send(res, 500, { error: 'INTERNAL', message: String((e && e.message) || e) })
    }
  })

  const api = {
    cfg,
    log,
    logger,
    store,
    mgr,
    monitor,
    clients,
    training,
    breaker,
    server,
    state,
    probeModels,
    runTask,
    pump,
    taskView,
    buildLaunchCmd,
    async start() {
      if (state.running) return
      state.running = true
      // P4 崩溃恢复：释放上次残留的训练锁 + 清理遗留临时文件
      const rec = training.recover()
      if (rec.recovered || rec.cleaned.length) log.warn('startup.recovered', rec)
      monitor.start()
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(cfg.port, cfg.host, () => resolve())
      })
      state.pumpTimer = setInterval(() => { pump().catch((e) => log.error('pump.tick_failed', { error: e })) }, 500)
      state.pumpTimer.unref?.()
      const addr = server.address()
      if (addr && typeof addr === 'object') api.base = `http://${cfg.host}:${addr.port}`
      log.info('gateway.listen', { url: api.base || `http://${cfg.host}:${cfg.port}`, outDir: cfg.outDir, configFile: cfg.configFile })
      return api
    },
    async stop() {
      state.running = false
      if (state.pumpTimer) { clearInterval(state.pumpTimer); state.pumpTimer = null }
      monitor.stop()
      try { await training.stop({ reason: 'gateway-stop' }) } catch (e) { log.warn('stop.training_failed', { error: e }) }
      try { store.release() } catch (e) { log.warn('stop.release_failed', { error: e }) }
      store.clearState()
      await new Promise((resolve) => server.close(() => resolve()))
      log.info('gateway.stopped', {})
    },
  }

  return api
}

/** 浅合并覆盖（测试用）：只覆盖显式给出的分支字段 */
export function mergeConfig(base, over = {}) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...v }
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

export { STATUS, sleep }