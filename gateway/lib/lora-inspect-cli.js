#!/usr/bin/env node
/**
 * gateway/lib/lora-inspect-cli.js —— LoRA 体检 CLI（M1 验收工具）
 *
 * 用法：
 *   node gateway/lib/lora-inspect-cli.js --all
 *   node gateway/lib/lora-inspect-cli.js --dir "D:\SD.4.8\models\Lora"
 *   node gateway/lib/lora-inspect-cli.js --checkpoint SemiRealMix.safetensors --all
 *   node gateway/lib/lora-inspect-cli.js --file "D:\SD.4.8\models\Lora\xxx.safetensors"
 *   node gateway/lib/lora-inspect-cli.js --all --json
 */
import path from 'node:path'
import process from 'node:process'

import { inspectDir, inspectLora, checkCompat } from './lora-inspect.js'

const LORA_DIR = 'D:\\SD.4.8\\models\\Lora'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || String(next).startsWith('--')) out[k] = true
    else { out[k] = next; i++ }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const dir = typeof args.dir === 'string' ? args.dir : LORA_DIR

let list = []
if (typeof args.file === 'string') list = [inspectLora(args.file)]
else if (args.all || args.dir) list = inspectDir(dir)
else {
  process.stdout.write('用法：--all | --dir <目录> | --file <文件> [--checkpoint <底模>] [--json]\n')
  process.exit(2)
}

const rows = list.map((l) => {
  if (l.error) return { name: l.name, error: l.error }
  const compat = args.checkpoint ? checkCompat(l, String(args.checkpoint)) : null
  return { ...l, compat }
})

if (args.json) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
} else {
  const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n)
  const padl = (s, n) => String(s ?? '').padStart(n)
  process.stdout.write(
    `${pad('名字', 26)}${pad('架构', 8)}${padl('dim', 5)}${padl('alpha', 7)}${padl('MB', 7)}${padl('强度', 10)}  ${pad('触发词', 14)}${pad('ASCII', 7)}底模\n`,
  )
  for (const r of rows) {
    if (r.error) { process.stdout.write(`${pad(r.name, 26)}读取失败: ${r.error}\n`); continue }
    process.stdout.write(
      `${pad(r.name, 26)}${pad(r.family, 8)}${padl(r.dim, 5)}${padl(r.alpha, 7)}${padl(r.sizeMB, 7)}${padl(r.strengthLevel, 10)}  ${pad(r.trigger, 14)}${pad(r.asciiSafe ? '✔' : '✘ 会挂不上', 7)}${path.basename(String(r.baseModel || '-'))}\n`,
    )
    if (r.compat && (!r.compat.compatible || r.compat.notes.length)) {
      process.stdout.write(`  └─ ${r.compat.compatible ? '可加载但有隐患' : '架构不兼容，无法加载'}：${r.compat.notes.join('；') || '无'}\n`)
    }
  }
  const unknown = rows.filter((r) => r.family === 'unknown').length
  process.stdout.write(`\n合计 ${rows.length} 个 LoRA，架构未判定 ${unknown} 个。\n`)
}
