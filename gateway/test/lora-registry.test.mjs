/**
 * gateway/test/lora-registry.test.mjs — 产物投递 / 登记表 / 刷新（P4）
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  callSyntaxOf,
  summarizeSources,
  listLoraFiles,
  deliverArtifact,
  readRegistry,
  writeRegistry,
  buildRecord,
  upsertRecord,
  refreshWebui,
  mergedListing,
} from '../lib/lora-registry.js'

let seq = 0
function tmp(tag) {
  const dir = path.join(os.tmpdir(), 'lora-registry-test', `${tag}-${process.pid}-${++seq}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('callSyntaxOf：默认给 WEIGHT 占位，指定权重时直接给可用语法', () => {
  assert.equal(callSyntaxOf('aili_id'), '<lora:aili_id:WEIGHT>')
  assert.equal(callSyntaxOf('aili_id', 1.0), '<lora:aili_id:1>')
  assert.equal(callSyntaxOf('aili_base', 0.4), '<lora:aili_base:0.4>')
  assert.equal(callSyntaxOf(''), null)
  assert.equal(callSyntaxOf(null), null)
})

test('summarizeSources：只留类型/计数/域名，不把整串本地路径塞进登记表', () => {
  const s = summarizeSources([
    { input: 'D:\\私密素材\\角色A', kind: 'local-dir', files: 24 },
    { input: 'https://cdn.example.com/a.png', kind: 'url' },
    { input: 'https://cdn.example.com/b.png', kind: 'url' },
    { input: 'https://other.site/c.png?token=SECRET', kind: 'url' },
  ])
  assert.equal(s.count, 4)
  assert.deepEqual(s.kinds, { 'local-dir': 1, url: 3 })
  assert.equal(s.hosts['cdn.example.com'], 2)
  assert.equal(s.hosts['other.site'], 1)
  assert.equal(s.localFiles, 24)
  assert.equal(JSON.stringify(s).includes('角色A'), false, '不把原始路径写进登记表')
  assert.equal(JSON.stringify(s).includes('SECRET'), false, '不把带 token 的 URL 原样写入')
})

test('listLoraFiles：只列模型文件，按修改时间倒序；目录不存在如实报错', () => {
  const dir = tmp('list')
  fs.writeFileSync(path.join(dir, 'a.safetensors'), 'aa')
  fs.writeFileSync(path.join(dir, 'readme.md'), 'x')
  fs.writeFileSync(path.join(dir, 'b.ckpt'), 'bbb')
  const r = listLoraFiles({ loraDir: dir })
  assert.equal(r.ok, true)
  assert.deepEqual(r.files.map((f) => f.name).sort(), ['a', 'b'])
  assert.equal(r.files.find((f) => f.name === 'b').bytes, 3)
  assert.equal(listLoraFiles({ loraDir: path.join(dir, 'nope') }).ok, false)
  assert.equal(listLoraFiles({}).ok, false)
})

test('deliverArtifact：投递到 LoRA 目录；体积不同时拒绝覆盖别人的 LoRA', () => {
  const src = tmp('src')
  const loraDir = tmp('lora')
  const file = path.join(src, 'aili_id.safetensors')
  fs.writeFileSync(file, 'weights-v1')

  const first = deliverArtifact({ file, loraDir, name: 'aili_id' })
  assert.equal(first.ok, true)
  assert.equal(first.copied, true)
  assert.equal(first.target, path.join(loraDir, 'aili_id.safetensors'))
  assert.equal(fs.readFileSync(first.target, 'utf8'), 'weights-v1')

  // 同体积重复投递 → 视为已投递（不重复拷贝）
  const second = deliverArtifact({ file, loraDir, name: 'aili_id' })
  assert.equal(second.ok, true)
  assert.equal(second.copied, false)
  assert.match(second.note, /已投递/)

  // 目标已有同名但内容不同 → 拒绝覆盖
  fs.writeFileSync(path.join(loraDir, 'stale.safetensors'), 'someone-elses-lora-with-different-size')
  const conflict = deliverArtifact({ file, loraDir, name: 'stale' })
  assert.equal(conflict.ok, false)
  assert.match(conflict.error, /为避免覆盖已有 LoRA/)
  assert.equal(fs.readFileSync(path.join(loraDir, 'stale.safetensors'), 'utf8').startsWith('someone-elses'), true)
  // 显式 overwrite 才允许
  assert.equal(deliverArtifact({ file, loraDir, name: 'stale', overwrite: true }).ok, true)

  assert.equal(deliverArtifact({ file: path.join(src, 'nope.safetensors'), loraDir }).ok, false)
  assert.equal(deliverArtifact({ file, loraDir: null }).ok, false)
})

test('登记表：原子写 + 读取容错 + 同名 upsert 不堆历史', () => {
  const dir = tmp('reg')
  const file = path.join(dir, 'sub', 'lora-registry.json')
  assert.deepEqual(readRegistry({ file }).loras, [], '文件不存在 → 空表而不是抛错')

  let reg = readRegistry({ file })
  reg = upsertRecord({ registry: reg, record: buildRecord({ track: 'id', name: 'aili_id', bytes: 100 }) })
  reg = upsertRecord({ registry: reg, record: buildRecord({ track: 'base', name: 'aili_base', bytes: 200 }) })
  assert.equal(reg.loras.length, 2)

  const w = writeRegistry({ file, registry: reg })
  assert.equal(w.ok, true)
  assert.equal(w.count, 2)
  assert.equal(fs.existsSync(`${file}.tmp`), false, '原子写不留临时文件')

  // 重炼同名 → 替换而不是新增
  let again = readRegistry({ file })
  again = upsertRecord({ registry: again, record: buildRecord({ track: 'id', name: 'aili_id', bytes: 150 }) })
  assert.equal(again.loras.length, 2)
  assert.equal(again.loras.find((r) => r.name === 'aili_id').bytes, 150)

  fs.writeFileSync(file, '{ 这不是合法 JSON')
  assert.deepEqual(readRegistry({ file }).loras, [], '损坏的登记表 → 空表（不抛，不阻断炼制）')
})

test('buildRecord：档位标准随记录落表（dim/module/步数/lr/推理权重）', () => {
  const id = buildRecord({ track: 'id', name: 'aili_id', bytes: 1234, images: 20, sources: [{ input: 'D:\\x', kind: 'local-dir', files: 20 }] })
  assert.equal(id.role, 'identity')
  assert.equal(id.module, 'networks.lora')
  assert.equal(id.networkDim, 8)
  assert.equal(id.steps, 500)
  assert.equal(id.call, '<lora:aili_id:WEIGHT>')
  assert.deepEqual(id.inferWeight, { fixed: 1.0, min: 1.0, max: 1.0, adjustable: false })
  assert.equal(id.sources.kinds['local-dir'], 1)

  const base = buildRecord({ track: 'base', name: 'aili_base', bytes: 5678 })
  assert.equal(base.module, 'lycoris.kohya')
  assert.deepEqual(base.networkArgs, ['algo=lora', 'conv_dim=4', 'conv_alpha=2'])
  assert.equal(base.networkDim, 32)
  assert.equal(base.inferWeight.max, 0.7, 'Base 权重硬上限必须随记录可见')
})

test('refreshWebui：成功/失败都如实回传，失败时给出"产物已落盘"的说明', async () => {
  const okFetch = async () => ({ ok: true, status: 200 })
  const ok = await refreshWebui({ url: 'http://127.0.0.1:7860/', fetchImpl: okFetch })
  assert.equal(ok.ok, true)
  assert.equal(ok.endpoint, 'http://127.0.0.1:7860/sdapi/v1/refresh-loras')

  const bad = await refreshWebui({ url: 'http://127.0.0.1:7860', fetchImpl: async () => ({ ok: false, status: 404 }) })
  assert.equal(bad.ok, false)
  assert.match(bad.hint, /SD 下次启动会自然扫到/, '刷新失败要说明产物没丢')

  const boom = await refreshWebui({ url: 'http://127.0.0.1:7860', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(boom.ok, false)
  assert.match(boom.reason, /ECONNREFUSED/)
})

test('mergedListing：登记表与磁盘合并视图（谁丢了、谁没登记一眼看出）', () => {
  const loraDir = tmp('merged-lora')
  const dir = tmp('merged-reg')
  const file = path.join(dir, 'lora-registry.json')
  fs.writeFileSync(path.join(loraDir, 'aili_id.safetensors'), 'x')
  fs.writeFileSync(path.join(loraDir, 'untracked_thing.safetensors'), 'yy')

  let reg = readRegistry({ file })
  reg = upsertRecord({ registry: reg, record: buildRecord({ track: 'id', name: 'aili_id', bytes: 1 }) })
  reg = upsertRecord({ registry: reg, record: buildRecord({ track: 'base', name: 'gone_base', bytes: 9 }) })
  writeRegistry({ file, registry: reg })

  const m = mergedListing({ registry: readRegistry({ file }), loraDir })
  assert.equal(m.count, 3)
  const byName = Object.fromEntries(m.rows.map((r) => [r.name, r]))
  assert.equal(byName.aili_id.onDisk, true)
  assert.equal(byName.aili_id.missing, false)
  assert.equal(byName.gone_base.missing, true, '表里有、盘上没有 → 明确标记缺失')
  assert.equal(byName.untracked_thing.untracked, true, '盘上有、表里没有 → 明确标记未登记')
  assert.equal(byName.untracked_thing.call, '<lora:untracked_thing:WEIGHT>')
})