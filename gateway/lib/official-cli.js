/**
 * gateway/lib/official-cli.js —— 「官方复刻」流水线的后台入口（低 token 消耗的关键）
 *
 * 为什么做成独立后台进程：
 *   训练要十几分钟。若在对话里同步等待，每轮进度都会刷进上下文（token 消耗大）。
 *   做成后台进程 + job 文件后，插件只返回 pid 与一句监控命令，训练期间零上下文开销。
 *
 * 用法：
 *   node gateway/lib/official-cli.js --src <素材目录> --name <角色名> \
 *        --work-root <工作目录> --lora-dir <LoRA目录> --job-file <状态文件> [--dim 32] [--compress]
 *   node gateway/lib/official-cli.js --help
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { runPipeline, OFFICIAL_RECIPE, INFERENCE_PRESET } from './official-pipeline.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const eq = k.indexOf('=')
    if (eq > 0) { out[k.slice(0, eq)] = k.slice(eq + 1); continue }
    const next = argv[i + 1]
    if (next === undefined || String(next).startsWith('--')) { out[k] = true; continue }
    out[k] = String(next)
    i++
  }
  return out
}

/** 原子写 job 文件（半截 JSON 会让插件读到假状态） */
function writeJob(file, payload) {
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    /* 状态写失败不影响训练 */
  }
}

const HELP = `官方复刻 LoRA 流水线（全自动 / 低占用 / 快速）

必填：
  --src <路径>          官方素材目录或单张图片
  --name <名字>         LoRA 名称（同时作为文件名）
可选：
  --work-root <目录>    工作目录（数据集/日志/预设落点）
  --lora-dir <目录>     成品投递目录（默认读配置）
  --res <数字>          训练分辨率，默认 ${OFFICIAL_RECIPE.resolution}
  --dim <数字>          网络维度，默认 ${OFFICIAL_RECIPE.networkDim}（16≈18MB / 32≈36MB）
  --compress            训练后做秩压缩（配合 --compress-dim，默认 16）
  --compress-dim <数字>
  --inference-prompt <s> 写进预设的角色特征词
  --job-file <文件>     状态文件（插件据此查询进度）
  --plan-only           只打印计划不训练
  --help
`

const args = parseArgs(process.argv.slice(2))
if (args.help || args.h) {
  process.stdout.write(HELP)
  process.exit(0)
}

const src = typeof args.src === 'string' ? args.src : ''
const name = typeof args.name === 'string' ? args.name : ''
if (!src || !name) {
  process.stderr.write('缺少 --src 或 --name\n')
  process.exit(2)
}

const resolution = Number(args.res) || OFFICIAL_RECIPE.resolution
const dim = Number(args.dim) || OFFICIAL_RECIPE.networkDim
const compress = args.compress === true || args.compress === 'true'
const compressDim = Number(args['compress-dim']) || 16
const workRoot = typeof args['work-root'] === 'string' ? args['work-root'] : path.join(process.cwd(), '.official', name)
const loraDir = typeof args['lora-dir'] === 'string' ? args['lora-dir'] : 'D:\\SD.4.8\\models\\Lora'
const jobFile = typeof args['job-file'] === 'string' ? args['job-file'] : null
const trigger = typeof args.trigger === 'string' ? args.trigger : ''
// 用 kohya 的 venv 跑数据集准备与秩压缩：那里有 cv2（脸部定位）与 torch（resize_lora）。
// 内置运行时的 python 只有 PIL/numpy，cv2 缺失会让裁切退回「中心兜底」，脸就定位不准。
const kohyaPython = 'D:\\kohya_ss\\venv\\Scripts\\python.exe'
const pythonPath = fs.existsSync(kohyaPython)
  ? kohyaPython
  : 'C:\\Users\\zhang\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'
const prepScript = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'prep_official.py')

if (args['plan-only']) {
  const out = {
    ok: true,
    plan: {
      name, src, resolution, dim,
      baseModel: OFFICIAL_RECIPE.baseModel,
      compress, compressDim,
      stepsRule: `clamp(素材张数 × ${OFFICIAL_RECIPE.stepsPerImage}, ${OFFICIAL_RECIPE.minSteps}, ${OFFICIAL_RECIPE.maxSteps})`,
      inferencePreset: INFERENCE_PRESET,
    },
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  process.exit(0)
}

const startedAt = new Date().toISOString()
writeJob(jobFile, { name, status: 'running', stage: 'start', startedAt, pid: process.pid })

const r = await runPipeline({
  name, src, workRoot, loraDir, pythonPath, prepScript,
  resolution, dim, compress, compressDim,
  trigger,
  inferencePrompt: typeof args['inference-prompt'] === 'string' ? args['inference-prompt'] : '',
  onStage: (e) => {
    writeJob(jobFile, { name, status: 'running', stage: e.stage, note: e.note, startedAt, pid: process.pid, updatedAt: new Date().toISOString() })
  },
  onMilestone: (m) => {
    writeJob(jobFile, { name, status: 'running', stage: 'train', milestone: m.pct, step: m.step, total: m.total, startedAt, pid: process.pid, updatedAt: new Date().toISOString() })
  },
})

writeJob(jobFile, {
  ...r,
  status: r.ok ? 'success' : 'failed',
  stage: r.ok ? 'done' : r.stage,
  startedAt,
  finishedAt: new Date().toISOString(),
  pid: process.pid,
})

process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
process.exit(r.ok ? 0 : 1)
