/**
 * gateway/test/lora-cli.test.mjs — 一键炼制命令行入口（P4）
 *
 * 除了参数解析与状态文件原子写，这里还真的**起一次 CLI 子进程**跑 --plan-only：
 * 插件给用户的就是这样一条命令，它必须真的能跑出结果。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { parseArgs, writeJobFile, buildCliPlan } from '../lib/lora-cli.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'lib', 'lora-cli.js')

let seq = 0
function tmp(tag) {
  const dir = path.join(os.tmpdir(), 'lora-cli-test', `${tag}-${process.pid}-${++seq}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('parseArgs：支持 --k v / --k=v / 重复同名 / 独立开关', () => {
  const a = parseArgs(['--name', 'aili', '--sources=D:\\a', '--sources', 'D:\\b', '--plan-only', '--tracks', 'id,base'])
  assert.equal(a.name, 'aili')
  assert.deepEqual(a.sources, ['D:\\a', 'D:\\b'])
  assert.equal(a['plan-only'], true)
  assert.equal(a.tracks, 'id,base')

  const b = parseArgs(['--repeat=10', '--banned', 'Alice,Bob'])
  assert.equal(b.repeat, '10')
  assert.equal(b.banned, 'Alice,Bob')

  const c = parseArgs(['pos1', '--k'])
  assert.deepEqual(c._, ['pos1'])
  assert.equal(c.k, true, '后面没有值就当成开关')
})

test('writeJobFile：原子写 + 自动建目录 + 不留临时文件', () => {
  const dir = tmp('job')
  const file = path.join(dir, 'deep', 'nested', 'job.json')
  const r = writeJobFile(file, { status: 'running', stage: 'training' })
  assert.equal(r.ok, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { status: 'running', stage: 'training' })
  assert.equal(fs.existsSync(`${file}.tmp`), false)
  assert.equal(writeJobFile(null, {}).ok, false)
})

test('buildCliPlan：命令行参数 → 双轨计划（自定义命名 + 禁用词 + 显式分轨）', () => {
  const plan = buildCliPlan(parseArgs(['--name', 'aili', '--sources', 'D:\\raw', '--banned', 'Alice,Bob', '--repeat', '8']), { existing: [] })
  assert.equal(plan.ok, true)
  assert.equal(plan.naming.id.name, 'aili_id')
  assert.equal(plan.repeat, 8)
  assert.deepEqual(plan.bannedTokens, ['Alice', 'Bob'])

  const explicit = buildCliPlan(parseArgs(['--name', 'x', '--id-sources', 'D:\\faces', '--base-sources', 'D:\\outfits']), { existing: [] })
  assert.deepEqual(explicit.sources.id, ['D:\\faces'])
  assert.deepEqual(explicit.sources.base, ['D:\\outfits'])

  const onlyBase = buildCliPlan(parseArgs(['--name', 'x', '--sources', 'D:\\raw', '--tracks', 'base']), { existing: [] })
  assert.deepEqual(onlyBase.tracks.map((t) => t.profile), ['base'])
})

/** 跑 CLI 子进程时把运行时工作区隔离到临时目录，别在插件目录里留日志/数据集 */
function runCli(args, { cwd } = {}) {
  const trainRoot = cwd || tmp('cli-root')
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, GW_LORA_TRAIN_ROOT: trainRoot },
  })
}

test('CLI 真跑一次 --plan-only：输出可读计划且不落盘', () => {
  const out = runCli(['--plan-only', '--name', 'aili', '--sources', 'D:\\素材\\角色A'])
  const j = JSON.parse(out)
  assert.equal(j.ok, true)
  assert.equal(j.plan.naming.id.name, 'aili_id')
  assert.equal(j.plan.naming.base.name, 'aili_base')
  assert.equal(j.plan.tracks.length, 2)
  assert.equal(j.plan.tracks[0].standard.network_dim, 8)
  assert.equal(j.plan.tracks[1].standard.network_module, 'lycoris.kohya')
  assert.ok(j.loraDir, '计划里要能看到 LoRA 投递目录（产物会落到哪）')
  assert.ok(j.registryFile, '登记表路径也要可见')
  assert.ok(j.plan.estimate.minutes[0] > 0)
  assert.ok(j.plan.estimate.minutes[1] > j.plan.estimate.minutes[0])
})

test('CLI 计划失败：退出码 2，并把失败写进状态文件（插件据此显示原因）', () => {
  const dir = tmp('cli-fail')
  const jobFile = path.join(dir, 'job.json')
  let code = 0
  try {
    execFileSync(process.execPath, [CLI, '--job-file', jobFile, '--name', 'x'], {
      encoding: 'utf8',
      timeout: 90000,
      env: { ...process.env, GW_LORA_TRAIN_ROOT: dir },
    })
  } catch (e) {
    code = e.status
  }
  assert.equal(code, 2, '计划不通过要给出明确非零退出码')
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
  assert.equal(job.status, 'failed')
  assert.equal(job.stage, 'plan')
  assert.ok(job.errors.some((e) => e.includes('没有给任何来源')))
})

test('CLI --help：给出可复制的用法说明', () => {
  const out = runCli(['--help'])
  assert.match(out, /一键炼制 LoRA/)
  assert.match(out, /--sources/)
  assert.match(out, /--name/)
  assert.match(out, /--job-file/)
})