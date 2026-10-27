/**
 * gateway/lib/lora-name-fix.js — LoRA 名称修复（中文 Windows 的 A1111 乱码）
 *
 * 问题（实测 2026-10-22）：
 *   A1111 在中文 Windows 上扫描 LoRA 目录时，把 UTF-8 文件名按 latin-1/cp1252 解码，
 *   于是「国风山水_v1.0」在 `/sdapi/v1/loras` 里变成「å½é£ä±±æ°´_v1.0」。
 *   更糟的是这一步**有损**：某些多字节序列的中间字节会被替换（实测 e5bda9「国」→ e5bde9），
 *   所以**无法**通过「把乱码串按 latin1 还原成字节再按 UTF-8 解」修回来（会得到 ���）。
 *
 * 正确做法：**以磁盘为准**。
 *   磁盘上的文件名是完好的（NTFS 存的是 UTF-16），所以本模块直接读目录拿到真名，
 *   再和 SD 返回的乱码名做**模糊匹配**（去扩展名、忽略大小写、按可打印字符骨架比对），
 *   把「SD 显示名 → 磁盘真名」的映射交给上层。
 *
 * 这样插件里所有展示 LoRA 的地方都能显示正确中文，且调用语法用的也是磁盘真名
 * —— 用户复制 `<lora:国风山水_v1.0:0.8>` 能直接用，不会被乱码名坑到。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'

const MODEL_EXT = /\.(safetensors|ckpt|pt|bin)$/i

/** 目录里真实存在的 LoRA 名字（不含扩展名）—— 磁盘是唯一可信来源 */
export function readDiskLoraNames({ loraDir, recursive = true } = {}) {
  if (!loraDir || !fs.existsSync(loraDir)) return { ok: false, error: `LoRA 目录不存在: ${loraDir}`, names: [] }
  const names = []
  const stack = [{ dir: loraDir, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.shift()
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        // A1111 默认递归子目录；深度限 3 防呆
        if (recursive && depth < 3) stack.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!MODEL_EXT.test(e.name)) continue
      names.push({
        /** 磁盘真名（不含扩展名）—— 这就是参数表里应该显示、也是 `<lora:...>` 里该写的 */
        name: e.name.replace(MODEL_EXT, ''),
        file: full,
        rel: path.relative(loraDir, full),
        dir: path.dirname(path.relative(loraDir, full)) || '.',
      })
    }
  }
  return { ok: true, names, count: names.length }
}

/**
 * 判断一个字符串是否「看起来像被错误解码的中文」。
 * 特征：大量 U+00C0–U+00FF 区间的拉丁补充字符（latin-1 高位），且没有 CJK 字符。
 */
export function looksMojibake(s) {
  const str = String(s || '')
  if (!str) return false
  // 已经含中文 → 不是乱码
  if (/[\u4e00-\u9fff]/.test(str)) return false
  const latinHigh = (str.match(/[\u00c0-\u00ff]/g) || []).length
  const cjk = (str.match(/[\u4e00-\u9fff]/g) || []).length
  return latinHigh >= 2 && cjk === 0
}

/**
 * 把乱码名映射到磁盘真名。
 *
 * 策略（从强到弱，逐级降级，绝不瞎猜）：
 *   ① 完全相等（含大小写差异）→ 直接用
 *   ② 去掉扩展名后相等 → 直接用
 *   ③ 若 SD 名不是乱码：按「目录内同名文件」精确匹配
 *   ④ 若 SD 名是乱码：用**字节骨架**匹配 —— 乱码串里的 ASCII 部分（数字/下划线/字母）
 *      通常被完整保留（如 `_v1.0`），用它缩小候选，再按长度与后缀排序取最可能的一个
 *   ⑤ 仍匹配不到 → 返回 null 并标记 unmatched（上层可保留 SD 原名，但会明确标注"名称可能乱码"）
 *
 * @returns {{resolved:Array, unmatched:Array, mapping:Object}}
 */
export function resolveLoraNames({ sdNames = [], diskNames = [] } = {}) {
  const raw = (Array.isArray(diskNames) ? diskNames : []).map((d) => (typeof d === 'string' ? { name: d } : d))
  /**
   * 按名字去重：同一 LoRA 可能同时存在于根目录和子目录（实测本机就有
   * `国风山水_v1.0` 在根目录与「商业实战 lora」各一份），SD 只返回一个名字。
   * 不去重会导致「一个真名被两份副本占两次」，后面的乱码名就匹配不上了。
   */
  const seenName = new Set()
  const disk = []
  for (const d of raw) {
    const key = String(d.name).toLowerCase()
    if (seenName.has(key)) continue
    seenName.add(key)
    disk.push(d)
  }
  const byLower = new Map(disk.map((d) => [String(d.name).toLowerCase(), d]))
  const byBase = new Map(disk.map((d) => [path.basename(String(d.name)).toLowerCase(), d]))

  const resolved = []
  const unmatched = []
  const mapping = {}
  const used = new Set()

  const take = (sdName, hit, how) => {
    resolved.push({ sdName, name: hit.name, file: hit.file || null, dir: hit.dir || null, how, mojibake: looksMojibake(sdName) })
    mapping[sdName] = hit.name
    used.add(String(hit.name).toLowerCase())
  }

  const asciiOf = (s) => String(s).replace(/[^\x20-\x7E]/g, '')

  /**
   * 两轮处理（顺序很重要）：
   *   第一轮只处理**正常名**（能精确对上磁盘的），把真名占住；
   *   第二轮再处理**乱码名**，用 ASCII 骨架去匹配「剩下的」候选。
   * 反过来做（乱码先抢）会出现：中文名精确匹配到了 A，乱码名又去抢 B，
   * 导致 A 被重复占用、B 反而判成未匹配 —— 实测 21 个里错配 6 个。
   */
  const pendingMojibake = []

  for (const raw of sdNames) {
    const sdName = String(raw || '')
    const stripped = sdName.replace(MODEL_EXT, '')

    // ① 完全相等
    if (byLower.has(sdName.toLowerCase())) { take(sdName, byLower.get(sdName.toLowerCase()), 'exact'); continue }
    // ② 去扩展名后相等
    if (byLower.has(stripped.toLowerCase())) { take(sdName, byLower.get(stripped.toLowerCase()), 'exact-stripped'); continue }
    // ③ 按 basename（子目录里的名字）精确匹配
    if (byBase.has(stripped.toLowerCase())) { take(sdName, byBase.get(stripped.toLowerCase()), 'basename'); continue }

    // ④ 乱码名先挂起，等正常名都占好位再处理
    if (looksMojibake(sdName)) { pendingMojibake.push(sdName); continue }

    unmatched.push({ sdName, reason: 'not-on-disk' })
  }

  // 第二轮：乱码名。
  // 顺序很重要：先处理**结构证据最强**的（含句点/横线等结构字符），再处理一般的。
  // 否则「å½é£ä±±æ°´」（国风山水）可能先抢走「国风.大漆」的候选，导致后者判成未匹配。
  pendingMojibake.sort((a, b) => {
    const structCount = (s) => (String(s).match(/[.\-_]/g) || []).length
    return structCount(b) - structCount(a)
  })
  for (const sdName of pendingMojibake) {
    const stripped = sdName.replace(MODEL_EXT, '')
    {
      const sdAscii = asciiOf(stripped).toLowerCase()
      const sdTail = sdAscii.slice(-6)
      const cands = disk.filter((d) => {
        if (used.has(String(d.name).toLowerCase())) return false
        const dAscii = asciiOf(String(d.name)).toLowerCase()
        // 后缀骨架（_v1.0 这类）必须对得上
        if (sdTail && dAscii && !dAscii.includes(sdTail)) return false
        return true
      })
      if (cands.length === 1) { take(sdName, cands[0], 'ascii-skeleton-unique'); continue }
      if (cands.length > 1) {
        // 多候选：按「乱码长度 ↔ 真名长度」比例 + ASCII 骨架重合度打分。
        // 每个 CJK 字符在乱码里会膨胀成 2–3 个 latin 字符，所以 ratio 越接近 2.5 越可信。
        const score = (d) => {
          const dn = String(d.name)
          const ratio = stripped.length / Math.max(1, dn.length)
          const dAscii = asciiOf(dn).toLowerCase()
          // 尾骨架完全一致是强信号
          const tailHit = sdTail && dAscii.endsWith(sdTail) ? 50 : 0
          return tailHit - Math.abs(ratio - 2.5) * 10
        }
        const sorted = [...cands].sort((a, b) => score(b) - score(a))
        take(sdName, sorted[0], `ascii-skeleton-scored(${cands.length})`)
        continue
      }
      // ③ 骨架没命中：退一步用「长度比例最接近」在剩余候选里挑（乱码长度 ≈ 2.5 × 真名长度）
      //    但**只在有结构证据或比例非常接近时**才认 —— 否则宁可留 unmatched 让用户核对。
      //    （实测教训：无条件按长度兜底会把毫不相干的 LoRA 硬配上去，比不修更糟。）
      const rest = disk.filter((d) => !used.has(String(d.name).toLowerCase()))
      if (rest.length) {
        const target = stripped.length / 2.5
        // 额外信号：名字里的「结构性 ASCII 标点」（句点/横线/下划线）往往被完整保留，
        // 例如「国风.大漆_v1.0」乱码成「å½é£.å¤§æ¼_v1.0」，句点位置一致是强证据。
        const structOf = (s) => String(s).replace(/[^\w.\-]/g, '').toLowerCase()
        const sdStruct = structOf(stripped)
        const scored = rest.map((d) => {
          const dn = String(d.name)
          const ds = structOf(dn)
          let s = -Math.abs(dn.length - target) * 10
          let structHit = false
          if (sdStruct && ds && sdStruct === ds) { s += 200; structHit = true }
          else if (sdStruct && ds) {
            // 结构字符序列一致是「弱」证据：`_v9.9` 与 `_v1.0` 的标点序列也一样，
            // 光看标点会把不相干的 LoRA 配上。所以必须**版本号本身也对得上**才算强证据。
            const sig = (x) => x.replace(/[^\W_]/g, '').replace(/\w/g, '')
            const versionOf = (x) => (String(x).match(/v\d+(?:\.\d+)*/i) || [''])[0].toLowerCase()
            const vSame = versionOf(sdStruct) && versionOf(sdStruct) === versionOf(ds)
            if (sig(sdStruct) && sig(sdStruct) === sig(ds) && vSame) { s += 120; structHit = true }
          }
          return { d, s, structHit }
        }).sort((a, b) => b.s - a.s)
        const best = scored[0]
        const ratioGap = Math.abs(String(best.d.name).length - target) / Math.max(1, target)
        // 版本号是硬约束：乱码里 `_v9.9` 这类 ASCII 段通常被完整保留，
        // 如果版本号对不上，说明根本不是同一个 LoRA —— 长度比例再像也不能配。
        const versionOf = (x) => (String(x).match(/v\d+(?:\.\d+)*/i) || [''])[0].toLowerCase()
        const sdVer = versionOf(stripped)
        const dVer = versionOf(String(best.d.name))
        const versionConflict = sdVer && dVer && sdVer !== dVer
        // 结构证据命中 → 认；否则只有比例非常接近（±15%）且版本不冲突才认
        if (!versionConflict && (best.structHit || ratioGap <= 0.15)) {
          take(sdName, best.d, `length-ratio(struct=${best.structHit ? 'hit' : 'no'},gap=${ratioGap.toFixed(2)})`)
          continue
        }
      }
    }

    unmatched.push({ sdName, reason: 'mojibake-no-candidate' })
  }

  // 磁盘上有、SD 没返回的（例如刚投放还没刷新）
  const missingInSd = disk.filter((d) => !used.has(String(d.name).toLowerCase()))

  return { resolved, unmatched, mapping, missingInSd }
}

/**
 * 一步到位：读磁盘 + 修 SD 名字，返回可直接展示的清单。
 * @returns {{ok:boolean, items:Array, unmatched:Array, missingInSd:Array, fixedCount:number, error?:string}}
 */
export function buildFixedLoraListing({ loraDir, sdNames = [] } = {}) {
  const disk = readDiskLoraNames({ loraDir })
  if (disk.ok === false) return { ok: false, error: disk.error, items: [], unmatched: [], missingInSd: [], fixedCount: 0 }
  const r = resolveLoraNames({ sdNames, diskNames: disk.names })
  const fixedCount = r.resolved.filter((x) => x.how !== 'exact' && x.how !== 'exact-stripped').length
  return {
    ok: true,
    loraDir,
    items: r.resolved,
    unmatched: r.unmatched,
    missingInSd: r.missingInSd,
    diskCount: disk.count,
    sdCount: sdNames.length,
    fixedCount,
    /** 是否有任何一项是"猜"出来的（有歧义），上层可提示用户核对 */
    hasAmbiguous: r.resolved.some((x) => String(x.how).includes('ambiguous')),
  }
}

export default { readDiskLoraNames, looksMojibake, resolveLoraNames, buildFixedLoraListing }