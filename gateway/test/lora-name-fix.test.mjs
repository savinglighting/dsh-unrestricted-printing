/**
 * gateway/test/lora-name-fix.test.mjs — LoRA 名称修复（中文 Windows 的 A1111 乱码）
 *
 * 实测背景（2026-10-22）：A1111 在中文 Windows 上把 UTF-8 文件名按 latin-1 解码，
 * `/sdapi/v1/loras` 返回「å½é£ä±±æ°´_v1.0」，参数表下拉列表跟着乱码。
 * 而且这一步**有损**（中间字节会被替换），所以不能靠「反转编码」修 —— 只能以磁盘为准。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readDiskLoraNames, looksMojibake, resolveLoraNames, buildFixedLoraListing } from '../lib/lora-name-fix.js'

let seq = 0
function tmp(tag) {
  const dir = path.join(os.tmpdir(), 'lora-namefix-test', `${tag}-${process.pid}-${++seq}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function touch(dir, rel, bytes = 'x') {
  const full = path.join(dir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, bytes)
  return full
}

test('looksMojibake：能认出 latin-1 乱码，且不误判正常名', () => {
  assert.equal(looksMojibake('å½é£ä±±æ°´_v1.0'), true, '典型乱码')
  assert.equal(looksMojibake('èµåæå_v1.0'), true)
  assert.equal(looksMojibake('国风山水_v1.0'), false, '正常中文不是乱码')
  assert.equal(looksMojibake('add_detail'), false, '纯 ASCII 不是乱码')
  assert.equal(looksMojibake('semirealisticanime'), false)
  assert.equal(looksMojibake(''), false)
  assert.equal(looksMojibake(null), false)
})

test('readDiskLoraNames：递归收模型文件，排除图片/文本，名字不含扩展名', () => {
  const dir = tmp('disk')
  touch(dir, 'add_detail.safetensors')
  touch(dir, '国风山水_v1.0.safetensors')
  touch(dir, '国风山水_v1.0.jpg')
  touch(dir, '商业实战 lora/赛博朋克_v1.0.safetensors')
  touch(dir, '商业实战 lora/插画/细节制造_V1.safetensors')
  touch(dir, '商业实战 lora/新年电商提示词.txt')
  touch(dir, 'old.ckpt')

  const r = readDiskLoraNames({ loraDir: dir })
  assert.equal(r.ok, true)
  const names = r.names.map((n) => n.name).sort()
  assert.deepEqual(names, ['add_detail', 'old', '国风山水_v1.0', '细节制造_V1', '赛博朋克_v1.0'].sort())
  assert.ok(r.names.every((n) => n.file && n.rel))

  assert.equal(readDiskLoraNames({ loraDir: path.join(dir, 'nope') }).ok, false)
  assert.equal(readDiskLoraNames({}).ok, false)
})

test('resolveLoraNames：精确匹配优先，不做多余猜测', () => {
  const diskNames = ['add_detail', '国风山水_v1.0', '赛博朋克_v1.0']
  const r = resolveLoraNames({ sdNames: ['add_detail', '国风山水_v1.0'], diskNames })
  assert.equal(r.resolved.length, 2)
  assert.ok(r.resolved.every((x) => x.how === 'exact'))
  assert.equal(r.unmatched.length, 0)
})

test('resolveLoraNames：乱码名靠 ASCII 骨架（_v1.0）匹配回磁盘真名', () => {
  const diskNames = ['国风山水_v1.0', '赛博朋克_v1.0', 'add_detail']
  const r = resolveLoraNames({
    sdNames: ['å½é£ä±±æ°´_v1.0', 'èµåæå_v1.0', 'add_detail'],
    diskNames,
  })
  const m = r.mapping
  assert.equal(m['å½é£ä±±æ°´_v1.0'], '国风山水_v1.0', '必须修回中文真名')
  assert.equal(m['èµåæå_v1.0'], '赛博朋克_v1.0')
  assert.equal(m['add_detail'], 'add_detail')
  assert.equal(r.unmatched.length, 0)
  const fixedItem = r.resolved.find((x) => x.name === '国风山水_v1.0')
  assert.equal(fixedItem.mojibake, true, '要标记出这一项是修过的')
})

test('resolveLoraNames: no candidate -> honest unmatched (never force a wrong match)', () => {
  // Unicode escapes so this test file itself can't be corrupted by encoding issues
  const fakeMojibake = '\u00e5\u00ae\u008c\u00e5\u0085\u00a8\u00e4\u00b8\u008d\u00e5\u00ad\u0098\u00e5\u009c\u00a8\u00e7\u009a\u0084_v9.9'
  const r = resolveLoraNames({
    sdNames: [fakeMojibake],
    diskNames: ['国风山水_v1.0'],
  })
  assert.equal(r.resolved.length, 0, 'must not force-match when no candidate fits')
  assert.equal(r.unmatched.length, 1)
  assert.match(r.unmatched[0].reason, /mojibake/)
})

test('buildFixedLoraListing：端到端（真实目录结构 + 乱码 SD 名）', () => {
  const dir = tmp('e2e')
  touch(dir, 'add_detail.safetensors')
  touch(dir, '国风山水_v1.0.safetensors')
  touch(dir, '商业实战 lora/赛博朋克_v1.0.safetensors')
  touch(dir, 'shorekeeper-smoke_id.safetensors')

  const r = buildFixedLoraListing({
    loraDir: dir,
    sdNames: ['add_detail', 'å½é£ä±±æ°´_v1.0', 'èµåæå_v1.0', 'shorekeeper-smoke_id'],
  })
  assert.equal(r.ok, true)
  assert.equal(r.sdCount, 4)
  assert.equal(r.diskCount, 4)
  const names = r.items.map((x) => x.name)
  assert.ok(names.includes('国风山水_v1.0'), `中文名必须修回来，实际: ${names}`)
  assert.ok(names.includes('赛博朋克_v1.0'))
  assert.ok(names.includes('shorekeeper-smoke_id'))
  assert.ok(r.fixedCount >= 2, `至少修好 2 个中文名，实际 ${r.fixedCount}`)
  // 修好的名字必须是合法的 <lora:...> 片段（不含乱码字符）
  for (const it of r.items) {
    assert.ok(!/[\u00c0-\u00ff]{2,}/.test(it.name), `名字仍含乱码: ${it.name}`)
  }
})

test('resolveLoraNames：真实 21 项乱码全修复，且同名副本不互相抢占', () => {
  // 本机 SD 实际返回的 21 个名字（2026-10-22 抓取），中文部分全是 latin-1 乱码
  const sdNames = [
    '39_v1.0', 'add_detail', 'semirealisticanime', 'shorekeeper-smoke_id',
    'å½é£ä±±æ°´_v1.0', 'èªç¶ç¾å¦åºæ¯_v1.0', 'èµååæ_v1.0', 'èµååæåºæ¯_v1.0',
    'éå½©Â·éº»è¢è°è²ç_v1.0', '3Dæ¸²æÃå½æ½®iPé£æ ¼_V1.0', 'AIGCæåæºç²å­ä½_v1.0',
    'IP _ Qç _ 3D åäºçæ_v1', 'ä¸æ¹ç¾å¦åºæ¯_v1.0', 'å¤å ééÂ·æå½±_v1.0',
    'å½é£.å¤§æ¼_v1.0', 'æéç»ç_V2.0_v2.0', 'çµåäº§åæå½±_v1.0',
    'çµåæ°å¹´æµ·æ¥2024_v1.0', 'ç»ªå¿-æ¦çé£å¤©V2_V2', 'ãå¨ç½é¦åãNimoè¯¡å¥æè_v1.0', 'ç»èæå¶_V1',
  ]
  // 磁盘真名（含一份重复副本，模拟「根目录 + 子目录各一份」）
  const diskNames = [
    '39_v1.0', 'add_detail', 'semirealisticanime', 'shorekeeper-smoke_id',
    '国风山水_v1.0', '自然美妆场景_v1.0', '赛博朋克_v1.0', '赛博朋克场景_v1.0',
    '釉彩·麻袋调色盘_v1.0', '3D渲染×国潮iP风格_V1.0', 'AIGC朋克机甲字体_v1.0',
    'IP _ Q版 _ 3D 十二生肖_v1', '东方美学场景_v1.0', '凤冠霞帔·摄影_v1.0',
    '国风.大漆_v1.0', '描金画玉_V2.0_v2.0', '电商产品摄影_v1.0',
    '电商新年海报2024_v1.0', '绪儿-敦煌飞天V2_V2', '【全网首发】Nimo诡奇插画_v1.0', '细节制造_V1',
    '国风山水_v1.0', // 重复副本：不能让它把「国风.大漆」的候选抢掉
  ]
  const r = resolveLoraNames({ sdNames, diskNames })
  assert.equal(r.resolved.length, 21, `21 项都应解析成功，实际 ${r.resolved.length}`)
  assert.equal(r.unmatched.length, 0, `不应有未匹配项，实际: ${JSON.stringify(r.unmatched)}`)
  // 关键：两个「国风」类必须各归各位（这是最容易错配的一对）
  assert.equal(r.mapping['å½é£ä±±æ°´_v1.0'], '国风山水_v1.0')
  assert.equal(r.mapping['å½é£.å¤§æ¼_v1.0'], '国风.大漆_v1.0')
  // 全量校验：任何解析结果都不能残留乱码特征
  for (const x of r.resolved) {
    assert.ok(!/[\u00c0-\u00ff]{2,}/.test(x.name), `名字仍含乱码: ${x.name}`)
  }
})

test('resolveLoraNames：结构字符（句点/横线）是强证据，优先给结构最像的', () => {
  const r = resolveLoraNames({
    sdNames: ['å½é£.å¤§æ¼_v1.0', 'å½é£ä±±æ°´_v1.0'],
    diskNames: ['国风.大漆_v1.0', '国风山水_v1.0'],
  })
  assert.equal(r.mapping['å½é£.å¤§æ¼_v1.0'], '国风.大漆_v1.0', '带句点的乱码必须配到带句点的真名')
  assert.equal(r.mapping['å½é£ä±±æ°´_v1.0'], '国风山水_v1.0')
})
test('buildFixedLoraListing：目录不存在时如实报错，不返回假数据', () => {
  const r = buildFixedLoraListing({ loraDir: 'D:\\definitely-not-here', sdNames: ['a'] })
  assert.equal(r.ok, false)
  assert.match(r.error, /不存在/)
  assert.deepEqual(r.items, [])
})
