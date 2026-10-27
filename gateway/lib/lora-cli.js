/**
 * gateway/lib/lora-cli.js — 一键炼制的命令行入口（P4 插件面）
 *
 * 为什么要有 CLI 而不是把训练塞进插件进程：
 *   训练要几十分钟。插件工具调用必须立刻返回，否则必然超时；而网关也不该被强制常驻。
 *   所以做成「CLI 后台进程跑训练 + 状态写进 job 文件 + 插件读状态」这条链路：
 *   一键提交、随时查进度、进程死了也能从 job 文件看出卡在哪一步。
 *
 * 用法（单行，可复制）：
 *   node gateway/lib/lora-cli.js --name aili --sources "D:\素材\角色A" --job-file "D:\...\job.json"
 *   node gateway/lib/lora-cli.js --plan-only --name aili --sources "..."      # 只出计划，不训练
 *   node gateway/lib/lora-cli.js --help
 *
 * 状态文件（job.json）由本进程原子写：
 *   status: queued|running|success|failed · stage · tracks · artifacts · errors · warnings · 时间戳 · pid
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { config } from './config.js'
import { Logger } from './logger.js'
import { TaskStore } from './store.js'
import { TrainingManager } from './training.js'
import { LoraTrainer } from './lora-runner.js'
import { planTraining } from './lora-train.js'
import { listLoraFiles } from './lora-registry.js'

/** 解析 `--k v` 形式参数（同名可重复 → 数组；`--flag` 单独出现 → true） */
export function parseArgs(argv = []) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.slice(2)
    const eq = key.indexOf('=')
    if (eq > 0) {
      pushValue(out, key.slice(0, eq), key.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || String(next).startsWith('--')) {
      pushValue(out, key, true)
      continue
    }
    pushValue(out, key, String(next))
    i++
  }
  return out
}

function pushValue(out, key, val) {
  if (out[key] === undefined) out[key] = val
  else if (Array.isArray(out[key])) out[key].push(val)
  else out[key] = [out[key], val]
}

function asList(v) {
  if (v === undefined || v === null || v === true || v === false) return []
  return Array.isArray(v) ? v.map(String) : [String(v)]
}

/** 原子写状态文件（半截 JSON 会让插件读到假状态） */
export function writeJobFile(file, payload) {
  if (!file) return { ok: false, error: '缺少 job 文件路径' }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, file }
  } catch (e) {
    return { ok: false, error: `状态文件写入失败: ${(e && e.message) || e}` }
  }
}

export function buildCliPlan(args, { existing = null } = {}) {
  const sources = asList(args.source).length ? asList(args.source) : asList(args.sources)
  const existingNames = existing || listLoraFiles({ loraDir: config.trainer.loraDir }).files.map((f) => f.name)
  return planTraining({
    sources,
    idSources: asList(args['id-sources']).length ? asList(args['id-sources']) : null,
    baseSources: asList(args['base-sources']).length ? asList(args['base-sources']) : null,
    name: typeof args.name === 'string' ? args.name : null,
    idName: typeof args['id-name'] === 'string' ? args['id-name'] : null,
    baseName: typeof args['base-name'] === 'string' ? args['base-name'] : null,
    concept: typeof args.concept === 'string' ? args.concept : null,
    repeat: args.repeat,
    regSources: asList(args.reg),
    datasetRoot: typeof args['dataset-root'] === 'string' ? args['dataset-root'] : config.trainer.datasetRoot,
    baseModelPath: typeof args['base-model'] === 'string' ? args['base-model'] : config.trainer.baseModelPath,
    existing: existingNames,
    bannedTokens: asList(args.banned).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean),
    captionMode: typeof args['caption-mode'] === 'string' ? args['caption-mode'] : 'auto',
    visionSplit: args['vision-split'] === true || args['vision-split'] === 'true',
    tracks: asList(args.tracks).length ? asList(args.tracks).flatMap((t) => t.split(',')) : undefined,
  })
}

const HELP = `一键炼制 LoRA — 命令行入口

必填：
  --sources <路径或URL>     素材来源（可重复；本地目录 / 图片直链 / 参考图）
选填：
  --name <名字>             自定义 LoRA 名字（两轨自动加 _id / _base）
  --id-name / --base-name   单独指定某一轨名字
  --concept <概念名>        数据集概念名（默认跟随产物名）
  --id-sources / --base-sources   显式分轨（给了就不自动拆轨）
  --reg <路径>              reg 通用人物图（5–10 张，可重复）
  --repeat <数字>           kohya 重复次数（默认 10）
  --tracks <id,base>        只炼某一轨
  --caption-mode <模式>     auto | sidecar | placeholder（默认 auto）
  --vision-split            用视觉模型按画面主体拆双轨（比标注关键词准；失败自动回退）
  --banned <词,词>          显式禁用词（角色名/作品名，会从标注中剔除）
  --dataset-root <目录>     数据集落盘根目录
  --job-file <文件>         状态文件（插件据此查进度）
  --plan-only               只输出计划，不训练
  --help                    显示本帮助
`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) {
    process.stdout.write(HELP)
    return 0
  }

  const plan = buildCliPlan(args)
  const jobFile = typeof args['job-file'] === 'string' ? path.resolve(args['job-file']) : null

  if (!plan.ok) {
    const payload = { status: 'failed', stage: 'plan', errors: plan.errors, warnings: plan.warnings || [], updatedAt: new Date().toISOString() }
    writeJobFile(jobFile, payload)
    process.stdout.write(`${JSON.stringify({ ok: false, ...payload, tracks: plan.tracks.map((t) => t.profile) }, null, 2)}\n`)
    return 2
  }

  if (args['plan-only']) {
    const preview = {
      ok: true,
      /** 顶层也给一份：插件要拿它显示"产物会落到哪" */
      loraDir: config.trainer.loraDir,
      registryFile: config.trainer.registryFile,
      plan: {
        naming: plan.naming,
        tracks: plan.tracks.map((t) => ({
          profile: t.profile,
          name: t.lora.name,
          standard: t.standard,
          dataset: t.dataset && t.dataset.mainDir,
        })),
        estimate: plan.estimate,
        warnings: plan.warnings,
        loraDir: config.trainer.loraDir,
      },
    }
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`)
    return 0
  }

  const logger = new Logger({ dir: config.trainer.logDir, level: config.logLevel, name: 'lora-cli' })
  const log = logger.child('lora')
  const store = new TaskStore({ stateFile: path.join(config.trainer.trainRoot, 'cli-state.json'), log })
  const training = new TrainingManager({
    store,
    log,
    tempRoot: config.trainer.tempRoot,
    logDir: config.trainer.logDir,
    baselineArgs: config.trainer.baseline_args || config.trainer.baselineArgs,
    profiles: config.trainer.profiles,
    profileDefault: config.trainer.profileDefault,
    script: config.trainer.script,
    python: config.trainer.python,
    // 关键：不传 trainEnv，kohya 会去 huggingface.co 拉 clip tokenizer，
    // 网络不通时每次训练卡 6 分钟后失败（TRAIN_HF_OFFLINE）。这里把离线环境注入进去。
    trainEnv: config.trainer.trainEnv,
  })
  const trainer = new LoraTrainer({
    training,
    store,
    log,
    loraDir: config.trainer.loraDir,
    registryFile: config.trainer.registryFile,
    webuiUrl: config.webui.url,
  })

  const startedAt = new Date().toISOString()
  const base = { name: plan.naming && plan.naming.id ? plan.naming.id.name : null, startedAt, pid: process.pid, loraDir: config.trainer.loraDir, registryFile: config.trainer.registryFile }
  writeJobFile(jobFile, { ...base, status: 'running', stage: 'starting', updatedAt: startedAt })
  log.info('lora_cli.start', { jobFile, name: base.name, tracks: plan.tracks.map((t) => t.profile) })

  const r = await trainer.run({
    plan,
    onProgress: (ev) => {
      writeJobFile(jobFile, { ...base, status: 'running', stage: ev.stage || 'running', detail: ev, updatedAt: new Date().toISOString() })
    },
  })

  const payload = {
    ...base,
    status: r.ok ? 'success' : 'failed',
    stage: r.ok ? 'done' : (r.stage || 'train'),
    updatedAt: new Date().toISOString(),
    artifacts: (r.artifacts || []).map((a) => ({ name: a.name, track: a.track, file: a.file, call: a.call, bytes: a.bytes, callSyntaxExample: a.callSyntaxExample })),
    registry: r.registry || null,
    refresh: r.refresh || null,
    errors: r.errors || [],
    warnings: r.warnings || [],
    estimate: plan.estimate || null,
    results: (r.results || []).map((x) => ({ profile: x.profile, ok: x.ok, exitCode: x.exitCode, failure: x.failure, durationMs: x.durationMs })),
  }
  writeJobFile(jobFile, payload)
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  return r.ok ? 0 : 1
}

// 直接执行才跑 main（被 import 时不跑，便于单测解析函数）
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('gateway/lib/lora-cli.js')
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`[lora-cli] 未捕获异常: ${(e && e.stack) || e}\n`)
      process.exit(3)
    })
}

export { main, HELP }