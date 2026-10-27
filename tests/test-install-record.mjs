// 安装记录（~/.dsh-sd-bridge.json）专项测试 —— 对应「12 个坑」的第 10 项（BOM 根因）。
// 跑法：node test-install-record.mjs   （不联网、不出图，毫秒级）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readInstallRecord, detectSdDir } from '../sd-bridge.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-record-'))
const sdDir = path.join(tmp, 'webui')
fs.mkdirSync(sdDir, { recursive: true })
fs.writeFileSync(path.join(sdDir, 'launch.py'), '# stub\n')
const record = path.join(tmp, '.dsh-sd-bridge.json')
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

// 1) PowerShell 5.1 `Set-Content -Encoding UTF8` 的产物：带 BOM 的 JSON
//    —— 旧实现裸 JSON.parse 直接抛错被吞掉 → sdDir 读成空 → 每次都指引重复安装
fs.writeFileSync(record, Buffer.concat([BOM, Buffer.from(JSON.stringify({ sdDir }, 'utf8'), 'utf8')]))
assert.equal(readInstallRecord(record), sdDir, '带 BOM 的记录必须能读出 sdDir')

// 2) 而且要就地自愈：重写后不得再带 BOM，任何裸 JSON.parse 都能读
const healed = fs.readFileSync(record)
assert.ok(
  !(healed[0] === 0xef && healed[1] === 0xbb && healed[2] === 0xbf),
  '自读后记录必须已自愈为无 BOM',
)
assert.doesNotThrow(() => JSON.parse(fs.readFileSync(record, 'utf8')), '自愈后必须是合法 JSON')
assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).sdDir, sdDir, '自愈不得丢字段')

// 3) 规范无 BOM 记录照常可用
fs.writeFileSync(record, JSON.stringify({ sdDir, pythonDir: path.join(tmp, 'py') }, null, 2), 'utf8')
assert.equal(readInstallRecord(record), sdDir)

// 4) 记录损坏 → 返回空串、不抛异常、不静默炸
fs.writeFileSync(record, Buffer.concat([BOM, Buffer.from('{broken json', 'utf8')]))
assert.equal(readInstallRecord(record), '', '损坏记录必须安静返回空串')

// 5) 指向非 SD 目录（缺 launch.py）→ 不采纳
fs.writeFileSync(record, JSON.stringify({ sdDir: tmp }), 'utf8')
assert.equal(readInstallRecord(record), '', '非 SD 目录不得被采纳')

// 6) 文件不存在 → 空串
assert.equal(readInstallRecord(path.join(tmp, 'missing.json')), '', '缺文件必须返回空串')

// 7) BOM 记录 + 尾部反斜杠归一化
fs.writeFileSync(record, Buffer.concat([BOM, Buffer.from(JSON.stringify({ sdDir: sdDir + '\\' }), 'utf8')]))
assert.equal(readInstallRecord(record), sdDir, '结尾分隔符必须被归一化')

// 8) 自动探测链路不回归
assert.equal(detectSdDir(''), detectSdDir(''), 'detectSdDir 必须稳定')
assert.ok(detectSdDir(sdDir) === sdDir, '显式 sdDir 指向有效目录时直接采用')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('INSTALL RECORD OK（含 BOM 读取 + 自愈）')
