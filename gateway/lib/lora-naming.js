/**
 * gateway/lib/lora-naming.js — LoRA 产物命名（P3，用户要求：名字必须可自定义）
 *
 * 名字这一层看着小，但它决定三件事，任何一件错了都很难受：
 *   1. **训练侧**：kohya 的 `--output_name` 决定落盘文件名；
 *   2. **推理侧**：A1111 的 LoRA 列表名 = 文件名（不带扩展名），也就是参数表里显示的名字；
 *   3. **语法侧**：调用时要写成 `<lora:名字:权重>` —— 所以名字里**不能出现冒号和逗号**，
 *      否则提示词语法直接被撕开（这是最容易被忽略的坑）。
 *
 * 因此本模块是命名的唯一裁决处：
 *   · 规范化（清洗 Windows 非法字符 + 破坏 LoRA 语法的字符 + 空白）
 *   · 默认推导（用户没给名字时按概念名推 id / base 两轨）
 *   · 冲突处理（目标目录已有同名产物 → 版本化 `_v2` / `_v3`，绝不静默覆盖别人的 LoRA）
 *   · 回传"训练用名 / 落盘文件名 / 推理显示名 / 调用语法"四件套，避免各处各算一遍
 *
 * 纯函数（不读盘），目录冲突检查由调用方通过 existing 注入，便于单测。
 */

'use strict'

/** 名字长度上限（过长会让 A1111 下拉框与提示词语法都很难用） */
export const MAX_NAME_LEN = 64

/** 破坏 LoRA 调用语法的字符：`<lora:名字:0.8>` 里的名字不能含冒号与逗号 */
export const SYNTAX_BREAKERS = [':', ',', '<', '>']

/** 路径/文件系统非法字符 */
const ILLEGAL = /[\\/*?"|]+/g

/**
 * 名字规范化。
 * @returns {{ok:boolean, name?:string, error?:string, changed:boolean, removed:string[]}}
 */
export function normalizeLoraName(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim()
  if (!raw) return { ok: false, error: '名字为空', changed: false, removed: [] }
  const removed = []
  let name = raw
  for (const ch of SYNTAX_BREAKERS) {
    if (name.includes(ch)) { removed.push(ch); name = name.split(ch).join('_') }
  }
  const afterIllegal = name.replace(ILLEGAL, '_')
  if (afterIllegal !== name) { removed.push('路径非法字符'); name = afterIllegal }
  const collapsed = name.replace(/[\s\u3000]+/g, '_').replace(/_+/g, '_').replace(/^[_.\-]+|[_.\-]+$/g, '')
  name = collapsed
  if (!name) return { ok: false, error: `名字净化后为空（原始: ${raw}）`, changed: true, removed }
  if (name.length > MAX_NAME_LEN) {
    removed.push(`超长截断(${name.length}→${MAX_NAME_LEN})`)
    name = name.slice(0, MAX_NAME_LEN).replace(/[_.\-]+$/g, '')
  }
  return { ok: true, name, changed: name !== raw, removed }
}

/**
 * 版本化：目标目录里已存在同名产物时，找下一个可用后缀。
 * @param {string} name 期望名字
 * @param {Iterable<string>} existing 已有名字集合（不含扩展名）
 * @param {{maxVersion?:number, onConflict?:'version'|'fail'|'overwrite'}} [opts]
 */
export function versionedName(name, existing = [], { maxVersion = 20, onConflict = 'version' } = {}) {
  const set = new Set(Array.from(existing || []).map((n) => String(n).toLowerCase()))
  if (!set.has(String(name).toLowerCase())) return { ok: true, name, versioned: false }
  if (onConflict === 'overwrite') return { ok: true, name, versioned: false, overwrite: true }
  if (onConflict === 'fail') {
    return { ok: false, error: `名字「${name}」已存在（onConflict=fail，不覆盖别人的 LoRA）`, name }
  }
  for (let v = 2; v <= maxVersion; v++) {
    const cand = `${name}_v${v}`
    if (!set.has(cand.toLowerCase())) return { ok: true, name: cand, versioned: true, base: name, version: v }
  }
  return { ok: false, error: `名字「${name}」的版本号已用尽（最多 ${maxVersion} 个），请换一个名字` }
}

/** 从来源/概念推一个可读的默认名（去掉扩展名与常见占位） */
export function deriveDefaultName({ concept = null, sources = [], profile = 'id' } = {}) {
  const suffix = getProfileSuffix(profile)
  const cand = concept || firstMeaningfulSource(sources) || 'lora'
  const n = normalizeLoraName(cand)
  const base = n.ok ? n.name : 'lora'
  return `${base}${suffix}`
}

function getProfileSuffix(profile) {
  const p = String(profile || 'id').toLowerCase()
  return p === 'base' ? '_base' : '_id'
}

function firstMeaningfulSource(sources) {
  const list = Array.isArray(sources) ? sources : [sources]
  for (const s of list) {
    const v = String(s || '').trim()
    if (!v) continue
    if (/^https?:\/\//i.test(v)) {
      try {
        const p = new URL(v).pathname
        const parts = p.split('/').filter(Boolean)
        const last = parts[parts.length - 1] || parts[parts.length - 2] || ''
        const guess = last.replace(/\.[^.]+$/, '')
        if (guess && guess.length >= 3) return guess
      } catch { /* 非法 URL：跳过 */ }
      continue
    }
    const base = v.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
    const guess = base.replace(/\.[^.]+$/, '')
    if (guess && !/^(images?|pics?|photos?|dataset|data|src|ref|input|output|new folder)$/i.test(guess)) return guess
  }
  return null
}

/**
 * 一次性解出整套命名（用户自定义 > 默认推导 > 冲突版本化）。
 *
 * @param {object} o
 * @param {string} [o.name]        用户给的公共名（如 `aili`）→ 两轨各自加后缀
 * @param {string} [o.idName]      单独指定 ID 轨名字（优先级最高）
 * @param {string} [o.baseName]    单独指定 Base 轨名字
 * @param {string} [o.concept]     概念名（也用于数据集目录）
 * @param {string[]} [o.sources]   来源（用于推默认名）
 * @param {Iterable<string>} [o.existing] 目标目录已有产物名（不含扩展名）
 * @param {'version'|'fail'|'overwrite'} [o.onConflict]
 * @returns {{ok:boolean, error?:string, id?:object, base?:object, notes:string[]}}
 */
export function resolveLoraNames({
  name = null,
  idName = null,
  baseName = null,
  concept = null,
  sources = [],
  existing = [],
  onConflict = 'version',
} = {}) {
  const notes = []
  const existingSet = new Set(Array.from(existing || []).map((n) => String(n)))

  const shared = normalizeLoraName(name)
  if (name && !shared.ok) return { ok: false, error: `公共名非法: ${shared.error}` }
  if (shared.ok && shared.changed) notes.push(`公共名已规范化为「${shared.name}」（原始含非法字符：${shared.removed.join(' ') || '空白/超长'}）`)
  if (!name) notes.push('未指定名字 → 按来源/概念推导默认名（不影响使用，随时可用 name 参数改名）')

  const conceptName = (() => {
    const c = normalizeLoraName(concept)
    return c.ok ? c.name : null
  })()

  const build = (track) => {
    const explicit = track === 'id' ? idName : baseName
    const suffix = track === 'base' ? '_base' : '_id'
    let desired
    if (explicit) {
      const n = normalizeLoraName(explicit)
      if (!n.ok) return { ok: false, error: `${track} 轨名字非法: ${n.error}` }
      if (n.changed) notes.push(`${track} 轨名字已规范化：「${n.name}」`)
      desired = n.name
    } else if (shared.ok) {
      desired = `${shared.name}${suffix}`
    } else {
      desired = deriveDefaultName({ concept: conceptName, sources, profile: track })
    }
    const v = versionedName(desired, existingSet, { onConflict })
    if (!v.ok) return { ok: false, error: v.error }
    if (v.versioned) {
      notes.push(`「${desired}」已存在 → 本轨改为「${v.name}」`)
      existingSet.add(v.name)
    } else {
      existingSet.add(desired)
    }
    return {
      ok: true,
      track,
      name: v.name,
      /** kohya --output_name 用这个 */
      outputName: v.name,
      /** 落盘文件名 */
      fileName: `${v.name}.safetensors`,
      /** A1111 参数表显示名（= 文件名去扩展名，最终就是这个） */
      displayName: v.name,
      /** 调用语法模板（把 WEIGHT 换成权重即可；刻意用字符串而不是函数，保证能安全 JSON 序列化） */
      callSyntax: `<lora:${v.name}:WEIGHT>`,
      /** 常用权重示例：ID 轨恒 1.0，Base 轨 0.4 */
      callSyntaxExample: `<lora:${v.name}:${track === 'id' ? '1.0' : '0.4'}>`,
      versioned: !!v.versioned,
    }
  }

  const id = build('id')
  if (id.ok === false) return { ok: false, error: id.error }
  const base = build('base')
  if (base.ok === false) return { ok: false, error: base.error }

  // 两轨同名 = 推理时无法分别控权。**显式指定**时这是用户笔误，直接拒并说清（不偷偷改名）；
  // 只有"公共名自动加后缀"这条路径保证不会撞名。
  if (idName && baseName) {
    const a = normalizeLoraName(idName)
    const b = normalizeLoraName(baseName)
    if (a.ok && b.ok && a.name.toLowerCase() === b.name.toLowerCase()) {
      return { ok: false, error: `两条轨道名字相同（${a.name}）：会导致推理时无法分别控权，请给 id 与 base 不同名字` }
    }
  }
  if (id.name === base.name) return { ok: false, error: `两条轨道名字相同（${id.name}）：会导致推理时无法分别控权` }

  return { ok: true, id, base, concept: conceptName, notes }
}

/** 从文件清单里提取"已有名字"（只认模型文件，txt/md 这类附属文件不参与冲突检测） */
export function namesFromFiles(files = []) {
  const out = []
  for (const f of files) {
    const base = String(f).split(/[\\/]/).pop() || ''
    if (!/\.(safetensors|ckpt|pt|bin)$/i.test(base)) continue
    out.push(base.replace(/\.(safetensors|ckpt|pt|bin)$/i, ''))
  }
  return out
}

export default { MAX_NAME_LEN, SYNTAX_BREAKERS, normalizeLoraName, versionedName, deriveDefaultName, resolveLoraNames, namesFromFiles }