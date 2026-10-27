/**
 * gateway/lib/config.js — 配置与路径解析
 *
 * 原则：**不硬编码任何绝对路径/密钥/Token**。
 * 优先级：环境变量 > gateway.config.json（插件根 / 工作区）> 文件系统自动探测。
 * 探测不到的项返回 null，由调用方给出明确错误（不猜、不静默）。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { PROFILES, PROFILE_NAMES, trainerScriptCandidates } from './training-profiles.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 插件根目录（gateway/ 的上一级） */
export const PLUGIN_ROOT = path.resolve(__dirname, '..', '..')

const warned = new Set()
function warnOnce(key, msg) {
  if (warned.has(key)) return
  warned.add(key)
  try { process.stderr.write(`[gateway][config] ${msg}\n`) } catch { /* stderr 不可用时无处可写，忽略 */ }
}

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw)
  } catch (e) {
    warnOnce(`cfg:${file}`, `配置文件解析失败（已忽略）：${file} → ${e && e.message}`)
    return {}
  }
}

/** 依次查找配置文件（第一个存在的生效，找到就不再读后面的） */
function loadFileConfig() {
  const cands = []
  if (process.env.GW_CONFIG) cands.push(process.env.GW_CONFIG)
  cands.push(path.join(PLUGIN_ROOT, 'gateway.config.json'))
  cands.push(path.join(process.cwd(), 'gateway.config.json'))
  cands.push(path.join(process.cwd(), '.gateway', 'config.json'))
  for (const f of cands) {
    try { if (fs.existsSync(f)) return { file: f, cfg: readJsonSafe(f) } } catch { /* 路径不可访问：继续试下一个 */ }
  }
  return { file: null, cfg: {} }
}

const FILE = loadFileConfig()

function pick(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    return v
  }
  return undefined
}

function num(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

// ---------------- 路径探测（只读文件系统，不做网络请求） ----------------

/** 目录是否像 A1111/Forge WebUI 根目录 */
export function looksLikeSdDir(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false
    const hasLaunch = fs.existsSync(path.join(dir, 'launch.py')) || fs.existsSync(path.join(dir, 'webui.py'))
    return hasLaunch
  } catch { return false }
}

/** 目录是否像 ComfyUI 根目录 */
export function looksLikeComfyDir(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false
    return fs.existsSync(path.join(dir, 'main.py')) && fs.existsSync(path.join(dir, 'comfy'))
  } catch { return false }
}

/** 列出本机可能放 AI 应用的顶层目录（浅扫，避免深递归拖慢启动） */
function shallowRoots() {
  const roots = []
  const drives = process.platform === 'win32' ? ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\'] : ['/opt', '/home', '/srv', '/']
  for (const d of drives) {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      roots.push(path.join(d, e.name))
    }
  }
  return roots
}

/** 找 WebUI 根目录：env → 配置文件 → 浅扫 */
export function discoverSdDir(cfg = {}) {
  const direct = pick(process.env.DSH_SD_DIR, process.env.SD_DIR, process.env.GW_SD_DIR, cfg.sdDir)
  if (direct && looksLikeSdDir(direct)) return path.resolve(direct)
  for (const r of shallowRoots()) {
    if (looksLikeSdDir(r)) return r
  }
  return null
}

/** 找 ComfyUI 根目录：env → 配置文件 → 浅扫 */
export function discoverComfyDir(cfg = {}) {
  const direct = pick(process.env.GW_COMFY_DIR, process.env.COMFY_DIR, cfg.comfyDir)
  if (direct && looksLikeComfyDir(direct)) return path.resolve(direct)
  for (const r of shallowRoots()) {
    if (looksLikeComfyDir(r)) return r
  }
  return null
}

/** 找 WebUI 的 python 解释器 */
export function findSdPython(sdDir) {
  if (!sdDir) return null
  const cands = [
    path.join(sdDir, 'python', 'python.exe'),
    path.join(sdDir, 'python', 'python'),
    path.join(sdDir, 'venv', 'Scripts', 'python.exe'),
    path.join(sdDir, '.venv', 'Scripts', 'python.exe'),
    path.join(sdDir, 'venv', 'bin', 'python'),
  ]
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch { /* 不可访问：继续 */ } }
  return null
}

/** 找 ComfyUI 的 python 解释器（独立 venv，与 SD 隔离） */
export function findComfyPython(comfyDir) {
  if (!comfyDir) return null
  const cands = [
    path.join(comfyDir, 'venv', 'Scripts', 'python.exe'),
    path.join(comfyDir, '.venv', 'Scripts', 'python.exe'),
    path.join(comfyDir, 'venv', 'bin', 'python'),
    path.join(comfyDir, 'python_embeded', 'python.exe'),
  ]
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch { /* 不可访问：继续 */ } }
  return null
}

/**
 * 找 kohya 训练脚本；找不到返回 null（训练接口会明确报错，不猜路径）。
 * 候选按基础模型排序：SD1.5 → train_network.py，SDXL → sdxl_train_network.py。
 * （旧实现只搜 sdxl_train_network.py，SD1.5 本机永远发现不到脚本。）
 */
export function discoverTrainer(cfg = {}, baseModel = 'sd15') {
  const direct = pick(process.env.GW_TRAIN_SCRIPT, cfg.trainScript)
  if (direct) { try { if (fs.existsSync(direct)) return path.resolve(direct) } catch { /* 不可访问：继续探测 */ } }
  const searchRoots = [PLUGIN_ROOT, process.cwd(), ...shallowRoots().filter((r) => /sd|kohya|lora|train/i.test(path.basename(r)))]
  for (const name of trainerScriptCandidates(baseModel)) {
    for (const root of searchRoots) {
      const hit = findFileShallow(root, name, 3)
      if (hit) return hit
    }
  }
  return null
}

/**
 * LoRA 落盘目录候选：A1111 用 models\Lora，ComfyUI 用 models\loras（大小写都试）。
 * 顺序：显式配置 > A1111 > ComfyUI。
 */
export function loraDirCandidates(cfg = {}, { sdDir = null, comfyDir = null } = {}) {
  const list = []
  const push = (v) => {
    if (!v) return
    const s = path.resolve(String(v))
    if (!list.includes(s)) list.push(s)
  }
  push(process.env.GW_LORA_DIR)
  push(process.env.DSH_LORA_DIR)
  push(cfg.loraDir)
  for (const base of [sdDir, comfyDir]) {
    if (!base) continue
    for (const name of ['Lora', 'LoRA', 'lora', 'loras']) push(path.join(base, 'models', name))
  }
  return list
}

/** 第一个已存在的 LoRA 目录；都不存在时返回首选候选（上层可创建并明确告知来源） */
export function discoverLoraDir(cfg = {}, opts = {}) {
  const cands = loraDirCandidates(cfg, opts)
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch { /* 不可访问：继续 */ } }
  return cands.length ? cands[0] : null
}

/**
 * 训练工作根：数据集、产物中转、训练日志都在它下面。
 * 不用 os.tmpdir() —— 数据集要能跨调用复用并被 kohya 稳定读到（系统临时目录会被清理）。
 */
export function discoverLoraTrainRoot(cfg = {}) {
  const direct = pick(process.env.GW_LORA_TRAIN_ROOT, cfg.loraTrainRoot)
  if (direct) return path.resolve(direct)
  return path.resolve(path.join(process.cwd(), '.lora-train'))
}

/**
 * 找训练用的底模（kohya 的 --pretrained_model_name_or_path，**必填**）。
 * 优先本机画质最好的 AWPainting（插件已验证的配方），否则取体积最大的 .safetensors。
 * 找不到返回 null —— 训练会明确报错，不猜路径。
 */
export function discoverBaseModel(sdDir, cfg = {}) {
  const direct = pick(process.env.GW_BASE_MODEL_PATH, cfg.baseModelPath)
  if (direct) { try { if (fs.existsSync(direct)) return path.resolve(direct) } catch { /* 不可访问：继续探测 */ } }
  if (!sdDir) return null
  const dir = path.join(sdDir, 'models', 'Stable-diffusion')
  const preferred = ['AWPainting', 'SemiRealMix', 'majicMIX', 'anything']
  try {
    if (!fs.existsSync(dir)) return null
    const files = fs.readdirSync(dir).filter((f) => /\.(safetensors|ckpt)$/i.test(f))
    if (!files.length) return null
    const withStat = files.map((f) => {
      const full = path.join(dir, f)
      let bytes = 0
      try { bytes = fs.statSync(full).size } catch { /* 读不到就当 0 */ }
      const prefer = preferred.findIndex((p) => f.toLowerCase().includes(p.toLowerCase()))
      return { full, bytes, prefer: prefer < 0 ? 999 : prefer }
    })
    // 先按偏好，再按体积（底模都很大，小的多半是残缺文件）
    withStat.sort((a, b) => (a.prefer - b.prefer) || (b.bytes - a.bytes))
    return path.resolve(withStat[0].full)
  } catch {
    return null
  }
}

function findFileShallow(root, name, depth) {
  try {
    const stack = [{ dir: root, d: 0 }]
    while (stack.length) {
      const { dir, d } = stack.shift()
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (e.isFile() && e.name === name) return path.join(dir, e.name)
        if (e.isDirectory() && d < depth && !/^(node_modules|\.git|__pycache__|venv|\.venv)$/i.test(e.name)) {
          stack.push({ dir: path.join(dir, e.name), d: d + 1 })
        }
      }
    }
  } catch { /* 权限等问题：返回 null */ }
  return null
}

// ---------------- 配置对象 ----------------

const cfg = FILE.cfg || {}

const outDirCandidate = pick(
  process.env.GW_OUT_DIR,
  cfg.outDir,
  path.join(process.cwd(), 'SD-Picture'),
  path.join(PLUGIN_ROOT, 'SD-Picture'),
)

const sdDir = discoverSdDir(cfg)
const comfyDir = discoverComfyDir(cfg)

/** 基础模型提示（决定用哪个 kohya 脚本）：本机默认 SD1.5 */
const baseModelHint = String(pick(process.env.GW_BASE_MODEL, cfg.baseModel, 'sd15'))

/**
 * 训练硬底线：不可被用户参数覆盖（保留 P4 语义）。
 * 只放「优化器 / 精度 / 显存 / 分桶 / 保存格式」这类踩错就炸的项；
 * **刻意不放 --network_dim** —— 双轨标准要求 ID=8、Base=32，写死一个 dim 会把两条轨道压平。
 */
const trainBaselineArgs = (() => {
  const custom = pick(cfg.trainBaselineArgs, cfg.trainForcedArgs)
  if (Array.isArray(custom) && custom.length) return custom.map(String)
  return ['--optimizer_type=AdamW8bit', '--mixed_precision=fp16', '--lowvram', '--enable_bucket', '--save_model_as=safetensors']
})()

const loraTrainRoot = discoverLoraTrainRoot(cfg)
const loraDir = discoverLoraDir(cfg, { sdDir, comfyDir })

/**
 * 训练子进程的 HF 离线环境。
 * 实测（2026-10-22）：kohya 训练时 transformers 会去 huggingface.co 拉 clip tokenizer，
 * 网络不通就 httpx.ConnectTimeout [WinError 10060] 卡 6 分钟后失败 —— 而 SD 目录里
 * 已经有完整缓存（models--openai--clip-vit-large-patch14）。指向缓存 + 置离线即可完全不联网。
 * 缓存目录不存在时不强设离线（否则会把「该联网补齐」的情况也堵死）。
 */
function buildTrainEnv({ sdDir: sd = null, fileCfg = {} } = {}) {
  const env = {}
  const hfHome = pick(process.env.GW_TRAIN_HF_HOME, fileCfg.trainHfHome, sd ? path.join(sd, '.cache', 'huggingface') : null)
  if (hfHome && fs.existsSync(hfHome)) {
    env.HF_HOME = hfHome
    env.HUGGINGFACE_HUB_CACHE = path.join(hfHome, 'hub')
    env.HF_HUB_OFFLINE = '1'
    env.TRANSFORMERS_OFFLINE = '1'
    env.HF_DATASETS_OFFLINE = '1'
  }
  env.HF_ENDPOINT = process.env.HF_ENDPOINT || 'https://hf-mirror.com'
  env.TRANSFORMERS_NO_ADVISORY_WARNINGS = '1'
  env.TOKENIZERS_PARALLELISM = 'false'
  // 中文 Windows 下 Python 默认按 GBK 写 stdout，日志按字节落盘后按 UTF-8 读会变成
  // 「锟斤拷」（tqdm 进度条最先中招，且不可逆）。强制 UTF-8 输出，日志才可读。
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUTF8 = '1'
  return env
}

const trainEnv = buildTrainEnv({ sdDir, fileCfg: cfg })

export const config = {
  /** 配置文件来源（排障用） */
  configFile: FILE.file,
  name: cfg.name || 'dsh-sd-gateway',
  host: String(pick(process.env.GW_HOST, cfg.host, '127.0.0.1')),
  port: num(pick(process.env.GW_PORT, cfg.port), 8799),

  /** 产物目录：前端可传 out_dir 覆盖 */
  outDir: path.resolve(outDirCandidate),

  /** 日志目录（默认落在产物目录同级的 .dsh-gateway\logs） */
  logDir: path.resolve(pick(process.env.GW_LOG_DIR, cfg.logDir, path.join(path.dirname(path.resolve(outDirCandidate)), '.dsh-gateway', 'logs'))),
  logLevel: String(pick(process.env.GW_LOG_LEVEL, cfg.logLevel, 'info')),

  webui: {
    url: String(pick(process.env.GW_WEBUI_URL, cfg.webuiUrl, 'http://127.0.0.1:' + num(pick(process.env.GW_WEBUI_PORT, cfg.webuiPort), 7860))),
    port: num(pick(process.env.GW_WEBUI_PORT, cfg.webuiPort), 7860),
    dir: sdDir,
    python: findSdPython(sdDir),
    /** 启动器：仓库自带 sd-direct.ps1（-StartOnly = 只拉起 API 不出图） */
    launcher: {
      script: String(pick(process.env.GW_SD_LAUNCHER, cfg.sdLauncher, path.join(PLUGIN_ROOT, 'sd-direct.ps1'))),
      shell: String(pick(process.env.GW_POWERSHELL, 'powershell')),
    },
    /** OOM 阶梯（P2）：每级最多重启一次 */
    vramLadder: Array.isArray(cfg.webuiVramLadder) && cfg.webuiVramLadder.length
      ? cfg.webuiVramLadder
      : ['--medvram', '--medvram-sdxl', '--lowvram'],
  },

  comfy: {
    url: String(pick(process.env.GW_COMFY_URL, cfg.comfyUrl, 'http://127.0.0.1:' + num(pick(process.env.GW_COMFY_PORT, cfg.comfyPort), 8188))),
    port: num(pick(process.env.GW_COMFY_PORT, cfg.comfyPort), 8188),
    dir: comfyDir,
    python: findComfyPython(comfyDir),
    launchArgs: Array.isArray(cfg.comfyLaunchArgs) ? cfg.comfyLaunchArgs : ['main.py'],
    /** ComfyUI main.py 只认 --lowvram/--normalvram/--novram；无对应项的档位不加旗标 */
    vramLadder: Array.isArray(cfg.comfyVramLadder) && cfg.comfyVramLadder.length
      ? cfg.comfyVramLadder
      : [null, null, '--lowvram'],
  },

  ros2: {
    enabled: pick(process.env.GW_ROS2_ENABLED, cfg.ros2Enabled, true) !== false,
    url: String(pick(process.env.GW_ROS2_URL, cfg.ros2Url, 'ws://localhost:9090')),
    /** rosbridge 订阅的话题：只收 JSON */
    topic: String(pick(process.env.GW_ROS2_TOPIC, cfg.ros2Topic, '/hardware_monitor')),
    /** 断连后 nvidia-smi 的轮询间隔 */
    nvidiaIntervalMs: num(pick(process.env.GW_NVIDIA_INTERVAL_MS, cfg.nvidiaIntervalMs), 5000),
  },

  monitor: {
    /** 允许开跑的最低剩余显存（GB）；低于它排队等待而不是硬失败 */
    vramMinFreeGb: num(pick(process.env.GW_VRAM_MIN_GB, cfg.vramMinFreeGb), 1.5),
    /** OOM 预警阈值（GB）：低于它给任务打 vram_warning */
    vramWarnFreeGb: num(pick(process.env.GW_VRAM_WARN_GB, cfg.vramWarnFreeGb), 3.0),
    /** 快照超过这个时间（ms）视为过期：过期时不做准入判断（不阻塞出图） */
    staleMs: num(pick(process.env.GW_MONITOR_STALE_MS, cfg.monitorStaleMs), 30000),
    /**
     * 严格准入：显存低于 vramMinFreeGb 时**排队等待**而不是照常开跑。
     * 默认 false —— 因为引擎（WebUI/ComfyUI）本身就常驻显存，剩余显存低不代表这一单跑不动，
     * 硬拦会把任务永久卡在队列里（实测 2026-10-18）。监控的正确定位是「预警 + 观测」。
     */
    strictAdmission: pick(process.env.GW_VRAM_STRICT, cfg.strictAdmission, false) === true,
  },

  timeouts: {
    /** 单引擎出图整体超时（ms） */
    generateMs: num(pick(process.env.GW_GENERATE_TIMEOUT_MS, cfg.generateTimeoutMs), 1800000),
    /** 提交/查询等短请求超时（ms） */
    shortMs: num(pick(process.env.GW_HTTP_TIMEOUT_MS, cfg.httpTimeoutMs), 15000),
    /** 引擎就绪等待（ms） */
    engineReadyMs: num(pick(process.env.GW_ENGINE_READY_MS, cfg.engineReadyMs), 240000),
  },

  breaker: {
    /** 连续失败（超时/连接错误）多少次后熔断 */
    threshold: num(pick(process.env.GW_BREAKER_THRESHOLD, cfg.breakerThreshold), 3),
    /** 熔断冷却（ms）后进入半开探测 */
    cooldownMs: num(pick(process.env.GW_BREAKER_COOLDOWN_MS, cfg.breakerCooldownMs), 60000),
  },

  trainer: {
    script: discoverTrainer(cfg, baseModelHint),
    /** 脚本候选（按基础模型排序），排障时可直接看到"在找什么、为什么没找到" */
    scriptCandidates: trainerScriptCandidates(baseModelHint),
    baseModel: baseModelHint,
    python: pick(process.env.GW_TRAIN_PYTHON, cfg.trainPython, findSdPython(sdDir)),
    /** 训练底模（kohya 必填）：优先 AWPainting，找不到就明确报错 */
    baseModelPath: discoverBaseModel(sdDir, cfg),
    /** 硬底线参数（不可被用户覆盖；P4 语义） */
    baselineArgs: trainBaselineArgs,
    /** 兼容旧字段名（老配置/老调用方仍读得到） */
    forcedArgs: trainBaselineArgs,
    /** 双轨档位标准（id / base）：单一来源 = training-profiles.js */
    profiles: PROFILE_NAMES.map((n) => PROFILES[n]),
    /** 默认档位（一键炼制会按 id → base 顺序串行跑，这里只是缺省值） */
    profileDefault: String(pick(process.env.GW_LORA_PROFILE, cfg.loraProfile, 'id')),
    /** 训练工作根：数据集 / 产物中转 / 日志 */
    trainRoot: loraTrainRoot,
    datasetRoot: path.join(loraTrainRoot, 'datasets'),
    outputRoot: path.join(loraTrainRoot, 'output'),
    workRoot: path.join(loraTrainRoot, 'work'),
    /** 训练日志目录：**不随临时目录清理消失**（失败分类要读日志尾部） */
    logDir: path.join(loraTrainRoot, 'logs'),
    /** 训练子进程环境（HF 离线 + 镜像）：避免 kohya 联网拉 tokenizer 卡死 */
    trainEnv,
    /** 一键炼制产物登记表（人可读：名字/档位/步数/体积/来源摘要/调用语法） */
    registryFile: path.join(loraTrainRoot, 'lora-registry.json'),
    /** 产物投递目标（SD 的 LoRA 扫描目录） */
    loraDir,
    loraDirCandidates: loraDirCandidates(cfg, { sdDir, comfyDir }),
    /** 训练临时目录根（结束时清理其下的 gateway-train-* 子目录） */
    tempRoot: String(pick(process.env.GW_TRAIN_TMP, cfg.trainTempRoot, path.join(os.tmpdir(), 'dsh-gateway'))),
  },

  /** 网关自身的状态文件（重启后据此释放残留锁、清理临时文件） */
  stateFile: String(pick(process.env.GW_STATE_FILE, cfg.stateFile, path.join(os.tmpdir(), 'dsh-gateway', 'state.json'))),

  /** 可用性探测缓存时长（ms） */
  modelProbeCacheMs: num(pick(process.env.GW_MODEL_PROBE_MS, cfg.modelProbeCacheMs), 15000),
}

/** 排障输出：把解析结果写一行（不含任何密钥） */
export function describeConfig() {
  return {
    configFile: config.configFile,
    host: config.host,
    port: config.port,
    outDir: config.outDir,
    logDir: config.logDir,
    webui: { url: config.webui.url, dir: config.webui.dir, python: config.webui.python, launcher: config.webui.launcher.script },
    comfy: { url: config.comfy.url, dir: config.comfy.dir, python: config.comfy.python },
    ros2: { url: config.ros2.url, topic: config.ros2.topic, enabled: config.ros2.enabled },
    trainer: {
      script: config.trainer.script,
      scriptCandidates: config.trainer.scriptCandidates,
      baseModel: config.trainer.baseModel,
      python: config.trainer.python,
      baselineArgs: config.trainer.baselineArgs,
      profiles: config.trainer.profiles.map((p) => p.name),
      profileDefault: config.trainer.profileDefault,
      trainRoot: config.trainer.trainRoot,
      datasetRoot: config.trainer.datasetRoot,
      loraDir: config.trainer.loraDir,
      logDir: config.trainer.logDir,
      registryFile: config.trainer.registryFile,
      tempRoot: config.trainer.tempRoot,
    },
  }
}