// install-sd.ps1 清单与预检专项（0.7.0）：静态断言 + 临时目录干跑（不联网下载大文件）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// 测试已归档到 tests/：被断言的 install-sd.ps1 仍在插件根目录，取父目录
const rootDir = path.resolve(here, '..')
const ps1Path = path.join(rootDir, 'install-sd.ps1')
const src = fs.readFileSync(ps1Path, 'utf8')

// 1) UTF-8 BOM（坑13 / 坑19：PS5.1 无 BOM 按 GBK 读会语法错）
const raw = fs.readFileSync(ps1Path)
assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'install-sd.ps1 must be UTF-8 with BOM')

// 2) 三张清单：键、sha256（64 位十六进制）、HF 源
function extractCatalog(name) {
  const m = new RegExp(`${name.replace(/\$/g, '\\$')}\\s*=\\s*\\[ordered\\]@\\{([\\s\\S]*?)\\n\\}`, 'm').exec(src)
  assert.ok(m, `${name} catalog missing`)
  const entries = [...m[1].matchAll(/(\w+)\s*=\s*@\{([^}]*)\}/g)]
  const out = {}
  for (const [, key, body] of entries) {
    const sha = /Sha = '([0-9a-f]{64})'/.exec(body)
    const repo = /Repo = '([^']+)'/.exec(body)
    const file = /File = '([^']+)'/.exec(body)
    const name2 = /Name = '([^']+)'/.exec(body)
    out[key] = { sha: sha?.[1], repo: repo?.[1], file: file?.[1], name: name2?.[1] }
  }
  return out
}

const models = extractCatalog('$ModelCatalog')
assert.deepEqual(Object.keys(models), ['awpainting', 'revanimated', 'anythingv5', 'majicmix', 'semirealmix', 'darksushi'], 'model catalog keys')
assert.equal(models.awpainting.sha, '3d1b3c42ec704f3397d9e2968e3e544eda111741e10793afd78faa8148b36e12', 'AWPainting sha must match the verified local file')
assert.equal(models.semirealmix.sha, '385ea18efae6a93c19c1fc5e13447e19b5ed6f16d01b7be65f7f48252688e4b4', 'SemiRealMix sha must match (半写实/写实二次元)')

const vaes = extractCatalog('$VaeCatalog')
assert.deepEqual(Object.keys(vaes), ['mse', 'animevae'], 'vae catalog keys')
assert.equal(vaes.animevae.sha, 'f921fb3f29891d2a77a6571e56b8b5052420d2884129517a333c60b1b4816cdf', 'animevae sha must match the verified local file')

const loras = extractCatalog('$LoraCatalog')
assert.deepEqual(Object.keys(loras), ['add_detail', 'semireal', 'easynegative', 'badhandv4'], 'lora catalog keys')
assert.equal(loras.semireal.sha, 'ffce33239edde3afd8831beac2168cf60fc0a447e2f76d86dcc06460a2b9359a', 'semirealisticanime LoRA sha must match (半写实 LoRA)')
for (const [k, v] of Object.entries({ ...models, ...vaes, ...loras })) {
  assert.ok(v.sha, `${k}: sha256 missing`)
  assert.ok(v.repo && v.file, `${k}: HF repo/file missing`)
}

// 3) 默认值：模型拉 awpainting + semirealmix（半写实）、LoRA 拉四件套（含半写实 LoRA）
assert.ok(/\[string\]\$Models = 'awpainting,semirealmix'/.test(src), '-Models default must be awpainting,semirealmix')
assert.ok(/\[string\]\$Loras = 'add_detail,semireal,easynegative,badhandv4'/.test(src), '-Loras default must include the semi-real LoRA')

// 4) 环境预检段：磁盘 / 网络 / git / Python / VC++ 五个检查都在，失败单条退出
assert.ok(/function Test-Prereqs/.test(src), 'Test-Prereqs missing')
for (const key of ['磁盘空间不足', '探活失败', 'Install-MinGit', 'Install-Python310', 'vc_redist']) {
  assert.ok(src.includes(key), `preflight missing: ${key}`)
}
assert.ok(/\$fail\s*=\s*\{\s*param\(\$k, \$msg\)[\s\S]*?exit 1/.test(src), 'preflight must exit 1 on first hard failure')
assert.ok(/环境预检结果/.test(src), 'preflight summary missing')

// 坑21：安装记录写失败不得判安装失败——必须是 try/catch 包住 + 只报一条提示，且记录路径可覆盖
assert.ok(/\$StateFile/.test(src), '-StateFile parameter missing (install record path must be overridable)')
assert.ok(/\$env:DSH_SD_STATE_FILE/.test(src), 'install record path must honour DSH_SD_STATE_FILE')
assert.ok(/安装记录写入失败（不影响已装好的 SD）/.test(src), 'record write failure must be reported as non-fatal')
assert.ok(/try\s*\{[\s\S]*?WriteAllText\(\$stateFile[\s\S]*?\}\s*catch/.test(src), 'record write must be wrapped in try/catch')
assert.ok(!/\$recordWritten\s*=\s*\$true[\s\S]*?exit 1/.test(src), 'record failure must not exit 1')

// 5) 升级复验与失败不阻断
assert.ok(/\[switch\]\$Upgrade/.test(src), '-Upgrade switch missing')
assert.ok(/Supersedes/.test(src), 'Supersedes (old -> new) declaration missing')
assert.ok(/下载失败（.*跳过继续/.test(src), 'per-item download failure must not abort the run')

// 6) 干跑：临时目录 + 已有 launch.py + 全部跳过 → 预检打印、清单为空、记录无 BOM
//    坑21 回归：安装记录写失败（只读 HOME / 沙箱拦 / 企业策略）**不能**把已装好的 SD 判成失败。
//    所以干跑把记录改道到临时目录（-StateFile），断言 exit 0 与 BOM=False 都不再依赖
//    当前进程能不能写 ~/.dsh-sd-bridge.json——那条路径由第 6b) 节单独验。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-guard-home-'))
const tmpSd = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-guard-catalog-'))
fs.writeFileSync(path.join(tmpSd, 'launch.py'), '')
const tmpState = path.join(tmpHome, 'state.json')
const prevHome = process.env.USERPROFILE
process.env.USERPROFILE = tmpHome
const run = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, '-Target', tmpSd, '-SkipGit', '-SkipPython', '-SkipVC', '-SkipModel', '-SkipVae', '-Loras', 'none', '-NoConfig', '-StateFile', tmpState],
  { encoding: 'utf8', timeout: 120000 },
)
process.env.USERPROFILE = prevHome
const out = `${run.stdout || ''}${run.stderr || ''}`
assert.equal(run.status, 0, `dry run must exit 0, got ${run.status}\n${out}`)
assert.ok(out.includes('环境预检结果'), `preflight summary must print\n${out}`)
assert.ok(out.includes('清单里没有') === false, 'no invalid keys expected')
// 记录写到 -StateFile 指定位置，且必须无 BOM
assert.ok(fs.existsSync(tmpState), `install record must be written to -StateFile: ${tmpState}\n${out}`)
assert.equal(fs.readFileSync(tmpState)[0], 0x7b, 'install record must be BOM-free')
const record = JSON.parse(fs.readFileSync(tmpState, 'utf8'))
assert.ok(typeof record.sdDir === 'string' && record.sdDir.length > 0, 'record must carry sdDir')
assert.equal(fs.realpathSync(record.sdDir), fs.realpathSync(tmpSd), 'record.sdDir must point at -Target')

// 6b) 坑21 专项：记录目标**不可写**时，安装仍算成功（exit 0）+ 只报一条提示，不让未捕获异常把安装打成失败
const roDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-guard-ro-'))
const roState = path.join(roDir, 'sub', 'state.json')   // sub 目录不存在 → 写不进去
const roRun = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, '-Target', tmpSd, '-SkipGit', '-SkipPython', '-SkipVC', '-SkipModel', '-SkipVae', '-Loras', 'none', '-NoConfig', '-StateFile', roState],
  { encoding: 'utf8', timeout: 120000 },
)
const roOut = `${roRun.stdout || ''}${roRun.stderr || ''}`
assert.equal(roRun.status, 0, `unwritable install record must NOT fail a successful install, got ${roRun.status}\n${roOut}`)
assert.ok(roOut.includes('安装记录写入失败（不影响已装好的 SD）'), `must report the record failure as non-fatal\n${roOut}`)
assert.ok(!fs.existsSync(roState), 'unwritable record must not be created')
assert.ok(roOut.includes('== 完成 =='), 'install must still reach the completion banner')

// 7) 非法键 → exit 1 且列出可用键
process.env.USERPROFILE = tmpHome
const bad = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, '-Target', tmpSd, '-SkipGit', '-SkipPython', '-SkipVC', '-SkipModel', '-SkipVae', '-Loras', 'notakey', '-NoConfig'],
  { encoding: 'utf8', timeout: 120000 },
)
process.env.USERPROFILE = prevHome
const badOut = `${bad.stdout || ''}${bad.stderr || ''}`
assert.equal(bad.status, 1, 'invalid catalog key must exit 1')
assert.ok(badOut.includes('可用键'), 'must list available keys')

fs.rmSync(tmpHome, { recursive: true, force: true })
fs.rmSync(tmpSd, { recursive: true, force: true })

console.log('models:', Object.keys(models).join(', '))
console.log('loras:', Object.keys(loras).join(', '))
console.log('INSTALL CATALOG OK')
