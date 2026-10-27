/**
 * verify-integrity.mjs —— 插件文件完整性反向检测
 *
 * 做两件事：
 *   A. **本机 vs 随包清单**（离线也能跑）：逐文件比对 sha256，列出缺失 / 被改 / 多余。
 *   B. **本机 vs 仓库最新版**（联网，可选）：拉取 GitHub 上的 manifest.json，
 *      比对版本号与文件清单，列出「新版本多了什么、少了什么、哪些文件有变动」。
 *
 * 输出：终端彩色表格 + 可选 JSON / Markdown（给插件工具回传用）。
 *
 * 用法：
 *   node verify-integrity.mjs                  # A，终端表格
 *   node verify-integrity.mjs --remote         # A + B
 *   node verify-integrity.mjs --json           # A（JSON，供程序消费）
 *   node verify-integrity.mjs --remote --json  # A + B（JSON）
 *   node verify-integrity.mjs --md             # Markdown 表格（贴回复/issue 用）
 *
 * 退出码：0 = 无 runtime 缺失；2 = runtime 类文件缺失（插件一定跑不起来）；3 = 检测本身失败
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const MANIFEST = path.join(ROOT, 'manifest.json')
const ARGS = process.argv.slice(2)
const AS_JSON = ARGS.includes('--json')
const AS_MD = ARGS.includes('--md')
const REMOTE = ARGS.includes('--remote')
const RAW_BASE = 'https://raw.githubusercontent.com/savinglighting/dsh-unrestricted-printing'

const C = {
  reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m',
  blue: '\u001b[36m', gray: '\u001b[90m',
}
const useColor = !AS_JSON && !AS_MD && process.stdout.isTTY

function paint(color, text) {
  return useColor ? `${C[color]}${text}${C.reset}` : text
}

/** 分类 → 严重度：决定「缺失」是告警还是正常。 */
const SEVERITY = {
  runtime: { level: 3, label: '必需' },
  tool: { level: 2, label: '辅助' },
  doc: { level: 1, label: '文档' },
  dev: { level: 0, label: '开发' },
  ci: { level: 0, label: 'CI' },
  artifact: { level: 0, label: '产物' },
  other: { level: 1, label: '其他' },
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function walk(dir, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (rel.startsWith('node_modules/') || rel.startsWith('.git/') || rel.startsWith('Microsoft/')) continue
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/* ---------------------------- A. 本机 vs 随包清单 ---------------------------- */

function checkLocal() {
  if (!fs.existsSync(MANIFEST)) {
    return { ok: false, error: 'manifest.json 不存在（本包未附带基线清单）' }
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const expected = new Map(manifest.files.map((f) => [f.path, f]))
  const present = new Set(walk(ROOT).filter((p) => p !== 'manifest.json'))

  const missing = []
  const modified = []
  const intact = []
  const extra = []

  for (const [rel, meta] of expected) {
    const abs = path.join(ROOT, rel)
    if (!present.has(rel) || !fs.existsSync(abs)) {
      missing.push({ path: rel, category: meta.category, bytes: meta.bytes, shipped: meta.shipped })
      continue
    }
    const st = fs.statSync(abs)
    const hash = sha256(abs)
    if (hash !== meta.sha256) {
      modified.push({
        path: rel, category: meta.category,
        expectedBytes: meta.bytes, actualBytes: st.size,
        expected: meta.sha256.slice(0, 12), actual: hash.slice(0, 12),
      })
    } else {
      intact.push({ path: rel, category: meta.category })
    }
  }
  for (const rel of present) {
    if (!expected.has(rel) && rel !== 'manifest.json') {
      extra.push({ path: rel })
    }
  }

  return {
    ok: true,
    version: manifest.version,
    expectedCount: expected.size,
    missing, modified, extra,
    intactCount: intact.length,
  }
}

/* ---------------------------- B. 本机 vs 仓库最新版 ---------------------------- */

async function fetchRemoteManifest() {
  const urls = [`${RAW_BASE}/main/manifest.json`, `${RAW_BASE}/master/manifest.json`]
  for (const url of urls) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 12000)
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'cache-control': 'no-cache' } })
      clearTimeout(timer)
      if (!res.ok) continue
      return { manifest: await res.json(), url }
    } catch {
      continue
    }
  }
  return null
}

function compareWithRemote(local, remote) {
  const localManifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const localMap = new Map(localManifest.files.map((f) => [f.path, f]))
  const remoteMap = new Map(remote.files.map((f) => [f.path, f]))

  const onlyRemote = []   // 仓库有、本机清单没有 → 新版新增的文件
  const onlyLocal = []    // 本机清单有、仓库没有 → 已从仓库移除
  const changed = []      // 两边都有但哈希不同 → 内容更新

  for (const [rel, meta] of remoteMap) {
    if (!localMap.has(rel)) onlyRemote.push({ path: rel, category: meta.category, bytes: meta.bytes })
    else if (localMap.get(rel).sha256 !== meta.sha256) {
      changed.push({ path: rel, category: meta.category, oldBytes: localMap.get(rel).bytes, newBytes: meta.bytes })
    }
  }
  for (const [rel, meta] of localMap) {
    if (!remoteMap.has(rel)) onlyLocal.push({ path: rel, category: meta.category })
  }

  return {
    localVersion: localManifest.version,
    remoteVersion: remote.version,
    versionChanged: localManifest.version !== remote.version,
    localCount: localMap.size,
    remoteCount: remoteMap.size,
    onlyRemote, onlyLocal, changed,
  }
}

/* ---------------------------- 输出层 ---------------------------- */

function statusOf(item) {
  const sev = SEVERITY[item.category] || SEVERITY.other
  return sev
}

function renderText(local, remote) {
  const lines = []
  lines.push('')
  lines.push(paint('bold', '════════ dsh-unrestricted-printing 完整性检测 ════════'))
  lines.push('')

  if (!local.ok) {
    lines.push(paint('red', `✗ ${local.error}`))
    return lines.join('\n')
  }

  lines.push(`${paint('blue', '本机版本')}  ${local.version}    ${paint('gray', `清单基线 ${local.expectedCount} 个文件 / 完好 ${local.intactCount} 个`)}`)
  lines.push('')

  // 缺失
  if (local.missing.length) {
    lines.push(paint('bold', `▼ 缺失 ${local.missing.length} 个文件`))
    lines.push(rowHead())
    for (const m of local.missing.sort((a, b) => statusOf(b).level - statusOf(a).level)) {
      const sev = statusOf(m)
      const mark = sev.level >= 3 ? paint('red', '✗ 必需') : sev.level === 2 ? paint('yellow', '△ 辅助') : paint('gray', '· 可选')
      lines.push(rowLine(mark, m.path, m.category, `${m.bytes}B`, sev.level >= 2 ? '插件功能受影响' : '不影响运行'))
    }
    lines.push('')
  }

  // 被改
  if (local.modified.length) {
    lines.push(paint('bold', `▼ 内容被修改 ${local.modified.length} 个文件`))
    lines.push(rowHead())
    for (const m of local.modified.sort((a, b) => statusOf(b).level - statusOf(a).level)) {
      const sev = statusOf(m)
      const mark = sev.level >= 3 ? paint('red', '✗ 必需') : sev.level === 2 ? paint('yellow', '△ 辅助') : paint('gray', '· 可选')
      lines.push(rowLine(mark, m.path, m.category, `${m.expectedBytes}→${m.actualBytes}B`, `${m.expected}→${m.actual}`))
    }
    lines.push('')
    lines.push(paint('gray', '  提示：本地改动（自研/热修）会显示为「被修改」；想恢复原样请重新从仓库拉取。'))
    lines.push('')
  }

  // 多余
  if (local.extra.length) {
    lines.push(paint('bold', `▼ 清单外文件 ${local.extra.length} 个（本地新增/生成物，通常正常）`))
    lines.push(rowHead())
    for (const e of local.extra.slice(0, 30)) {
      lines.push(rowLine(paint('gray', '· 新增'), e.path, 'other', '-', '清单基线未收录'))
    }
    if (local.extra.length > 30) lines.push(paint('gray', `  …另有 ${local.extra.length - 30} 个`))
    lines.push('')
  }

  if (!local.missing.length && !local.modified.length) {
    lines.push(paint('green', '✓ 本机文件与随包清单完全一致，无缺失、无篡改。'))
    lines.push('')
  }

  // 远端对比
  if (remote) {
    lines.push(paint('bold', '════════ 与仓库最新版对比 ════════'))
    lines.push('')
    if (!remote.ok) {
      lines.push(paint('yellow', `△ ${remote.error}`))
    } else {
      const r = remote
      const verColor = r.versionChanged ? 'yellow' : 'green'
      lines.push(`本机 ${paint(verColor, r.localVersion)}  →  仓库 ${paint(verColor, r.remoteVersion)}${r.versionChanged ? paint('yellow', '  ⚠ 有新版本') : paint('green', '  ✓ 已是最新')}`)
      lines.push(`文件数 ${r.localCount} → ${r.remoteCount}`)
      lines.push('')
      if (r.onlyRemote.length || r.onlyLocal.length || r.changed.length) {
        lines.push(rowHead())
        for (const n of r.onlyRemote) {
          const sev = SEVERITY[n.category] || SEVERITY.other
          lines.push(rowLine(paint('green', '🆕 新版新增'), n.path, n.category, `${n.bytes}B`, sev.level >= 3 ? '需更新才有' : '可选'))
        }
        for (const c2 of r.changed) {
          const sev = SEVERITY[c2.category] || SEVERITY.other
          lines.push(rowLine(paint('yellow', '✎ 已更新'), c2.path, c2.category, `${c2.oldBytes}→${c2.newBytes}B`, sev.level >= 3 ? '建议更新' : '可选'))
        }
        for (const o of r.onlyLocal) {
          lines.push(rowLine(paint('gray', '🗑 仓库已移除'), o.path, o.category, '-', '本地可删'))
        }
        lines.push('')
      } else {
        lines.push(paint('green', '✓ 文件清单与仓库完全一致。'))
        lines.push('')
      }
      lines.push(paint('gray', `  更新方式：重装插件包 / git pull / 重新下载 release`))
    }
    lines.push('')
  } else if (REMOTE) {
    lines.push(paint('yellow', '△ 无法访问仓库（离线或网络受限），仅完成本机比对。'))
    lines.push('')
  }

  return lines.join('\n')
}

function rowHead() {
  if (AS_MD) return '| 状态 | 文件 | 分类 | 大小 | 说明 |\n|------|------|------|------|------|'
  return paint('gray', `  ${'状态'.padEnd(12)} ${'文件'.padEnd(34)} ${'分类'.padEnd(9)} ${'大小'.padEnd(16)} 说明`)
}

function rowLine(mark, file, cat, size, note) {
  if (AS_MD) return `| ${mark.replace(/\u001b\[\d+m/g, '')} | \`${file}\` | ${cat} | ${size} | ${note} |`
  const cleanMark = mark.replace(/\u001b\[\d+m/g, '')
  const pad = 12 + (mark.length - cleanMark.length)
  return `  ${mark}${' '.repeat(Math.max(0, pad - cleanMark.length))} ${file.padEnd(34)} ${String(cat).padEnd(9)} ${String(size).padEnd(16)} ${note}`
}

/* ---------------------------- 主流程 ---------------------------- */

const local = checkLocal()
let remote = null
if (REMOTE && local.ok) {
  const fetched = await fetchRemoteManifest()
  remote = fetched
    ? { ok: true, ...compareWithRemote(local, fetched.manifest) }
    : { ok: false, error: '无法从 GitHub 获取最新 manifest.json（检查网络/代理）' }
}

if (AS_JSON) {
  console.log(JSON.stringify({ local, remote }, null, 2))
} else {
  console.log(renderText(local, remote))
}

if (!local.ok) process.exit(3)
const criticalMissing = local.missing.filter((m) => (SEVERITY[m.category] || {}).level >= 3)
process.exit(criticalMissing.length ? 2 : 0)
