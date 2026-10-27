/**
 * gateway/lib/num.js — 数值归一（小而关键）
 *
 * 存在的理由：本项目里 `Number.isFinite(Number(x))` 这个写法被踩了三次同一个坑 ——
 * `Number(null) === 0`、`Number('') === 0`、`Number([]) === 0` 都是 **有限数**，
 * 于是"没传值"被当成"显式传了 0"：
 *   · 训练档位被钳到 0 步（estimateTrainMinutes）
 *   · 参数校验把缺省项误判成越界（validateProfileArgs）
 *   · 登记表把没记录的步数写成 0（buildRecord）
 * 所以统一从这里走：null / undefined / 空串 / 布尔 / 不可解析 → 一律回落默认值。
 */

'use strict'

/** 严格取数：只在"真的给了数字"时返回数字，否则返回 fallback */
export function numOr(v, fallback = null) {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'boolean') return fallback
  if (typeof v === 'string' && v.trim() === '') return fallback
  if (Array.isArray(v)) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 整数化（四舍五入）；不可解析时回落 */
export function intOr(v, fallback = null) {
  const n = numOr(v, null)
  return n === null ? fallback : Math.round(n)
}

/** 取值并夹到区间内（用于护栏钳制） */
export function clamp(v, min, max) {
  const n = numOr(v, null)
  if (n === null) return null
  if (min !== null && min !== undefined && n < min) return min
  if (max !== null && max !== undefined && n > max) return max
  return n
}

export default { numOr, intOr, clamp }