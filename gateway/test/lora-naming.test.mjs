/**
 * gateway/test/lora-naming.test.mjs — LoRA 命名（P3，名字可自定义）
 *
 * 重点覆盖三件容易出事的地方：
 *   ① 名字里出现冒号/逗号会把 `<lora:名字:权重>` 语法撕开 → 必须清洗；
 *   ② 与目标目录已有产物同名 → 版本化而不是静默覆盖别人的 LoRA；
 *   ③ 两轨必须能分别控权（同名就是 bug）→ 直接拒。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeLoraName,
  versionedName,
  deriveDefaultName,
  resolveLoraNames,
  namesFromFiles,
  MAX_NAME_LEN,
} from '../lib/lora-naming.js'

test('normalizeLoraName：破坏 LoRA 语法的字符（冒号/逗号/尖括号）必须清洗掉', () => {
  const a = normalizeLoraName('aili:1.0')
  assert.equal(a.ok, true)
  assert.equal(a.name, 'aili_1.0')
  assert.ok(a.changed)
  assert.ok(a.removed.includes(':'))

  const b = normalizeLoraName('aili,test')
  assert.equal(b.name, 'aili_test')
  assert.ok(b.removed.includes(','))

  const c = normalizeLoraName('<aili>')
  assert.equal(c.name, 'aili')

  const d = normalizeLoraName('  my   lora  ')
  assert.equal(d.name, 'my_lora')
})

test('normalizeLoraName：路径非法字符清洗、超长截断、空名报错', () => {
  const a = normalizeLoraName('a/b\\c?d*e')
  assert.equal(a.name, 'a_b_c_d_e')

  const long = normalizeLoraName('x'.repeat(120))
  assert.equal(long.name.length, MAX_NAME_LEN)
  assert.ok(long.removed.some((r) => r.includes('超长')))

  assert.equal(normalizeLoraName('').ok, false)
  assert.equal(normalizeLoraName(null).ok, false)
  assert.equal(normalizeLoraName('  ').ok, false)
  assert.equal(normalizeLoraName('::,,').ok, false, '全是非法字符 → 净化后为空要如实报错')
})

test('versionedName：同名时版本化，绝不静默覆盖（除非显式 overwrite）', () => {
  assert.deepEqual(versionedName('aili_id', ['other']), { ok: true, name: 'aili_id', versioned: false })
  const v = versionedName('aili_id', ['aili_id'])
  assert.equal(v.ok, true)
  assert.equal(v.name, 'aili_id_v2')
  assert.equal(v.versioned, true)
  const v3 = versionedName('aili_id', ['aili_id', 'aili_id_v2'])
  assert.equal(v3.name, 'aili_id_v3')
  assert.equal(versionedName('aili_id', ['AILI_ID']).name, 'aili_id_v2', '冲突判断不区分大小写')

  assert.equal(versionedName('aili_id', ['aili_id'], { onConflict: 'overwrite' }).overwrite, true)
  const fail = versionedName('aili_id', ['aili_id'], { onConflict: 'fail' })
  assert.equal(fail.ok, false)
  assert.match(fail.error, /已存在/)

  const exhausted = versionedName('a', ['a', ...Array.from({ length: 19 }, (_, i) => `a_v${i + 2}`)], { maxVersion: 20 })
  assert.equal(exhausted.ok, false)
  assert.match(exhausted.error, /版本号已用尽/)
})

test('deriveDefaultName：从 URL / 路径推可读名，丢弃 images 这类无意义名', () => {
  assert.equal(deriveDefaultName({ sources: ['https://x.com/pics/aili.png'], profile: 'id' }), 'aili_id')
  assert.equal(deriveDefaultName({ sources: ['D:\\素材\\林月-侧脸.jpg'], profile: 'base' }), '林月-侧脸_base')
  assert.equal(deriveDefaultName({ sources: ['D:\\素材\\images'], profile: 'id' }), 'lora_id', '无意义目录名要退化为 lora_*')
  assert.equal(deriveDefaultName({ concept: 'aili', sources: ['D:\\x'], profile: 'base' }), 'aili_base')
})

test('resolveLoraNames：自定义公共名 → 两轨各自加后缀，语法模板可直接用', () => {
  const r = resolveLoraNames({ name: 'aili' })
  assert.equal(r.ok, true)
  assert.equal(r.id.name, 'aili_id')
  assert.equal(r.base.name, 'aili_base')
  assert.equal(r.id.fileName, 'aili_id.safetensors')
  assert.equal(r.id.outputName, 'aili_id')
  assert.equal(r.id.displayName, 'aili_id', 'A1111 参数表显示名 = 文件名去扩展名')
  assert.equal(r.id.callSyntax, '<lora:aili_id:WEIGHT>')
  assert.equal(r.id.callSyntaxExample, '<lora:aili_id:1.0>')
  assert.equal(r.base.callSyntaxExample, '<lora:aili_base:0.4>')
  // 必须能安全序列化（会随 API 返回给插件层）
  const round = JSON.parse(JSON.stringify(r))
  assert.equal(round.id.callSyntax, '<lora:aili_id:WEIGHT>')
})

test('resolveLoraNames：可单独指定某一轨名字（自定义优先于公共名）', () => {
  const r = resolveLoraNames({ name: 'aili', idName: 'MyFace', baseName: '水彩画风' })
  assert.equal(r.id.name, 'MyFace')
  assert.equal(r.base.name, '水彩画风', '中文名保留（A1111 支持，且不含语法破坏字符）')
  assert.equal(r.base.fileName, '水彩画风.safetensors')
})

test('resolveLoraNames：未给名字时按来源推导，并明确提示（不擅自装作用户指定过）', () => {
  const r = resolveLoraNames({ sources: ['https://x.com/pics/aili.png'] })
  assert.equal(r.id.name, 'aili_id')
  assert.equal(r.base.name, 'aili_base')
  assert.ok(r.notes.some((n) => n.includes('未指定名字')))
})

test('resolveLoraNames：与已有产物冲突 → 版本化并记账（不覆盖别人的 LoRA）', () => {
  const r = resolveLoraNames({ name: 'aili', existing: ['aili_id', 'aili_base'] })
  assert.equal(r.ok, true)
  assert.equal(r.id.name, 'aili_id_v2')
  assert.equal(r.base.name, 'aili_base_v2')
  assert.ok(r.notes.some((n) => n.includes('已存在')))
})

test('resolveLoraNames：两轨同名直接拒（否则推理时无法分别控权）', () => {
  const r = resolveLoraNames({ idName: 'same', baseName: 'same' })
  assert.equal(r.ok, false)
  assert.match(r.error, /两条轨道名字相同/)
})

test('resolveLoraNames：单轨模式（只炼 ID 或只炼 Base）不因另一轨冲突而误报', () => {
  const r = resolveLoraNames({ name: 'aili', existing: [] })
  assert.equal(r.ok, true)
  assert.notEqual(r.id.name, r.base.name)
})

test('namesFromFiles：只认模型文件（txt/md 这类附属文件不参与冲突检测）', () => {
  assert.deepEqual(namesFromFiles(['D:\\Lora\\aili_id.safetensors', 'aili_base.ckpt', 'readme.txt', 'notes.md']), ['aili_id', 'aili_base'])
})