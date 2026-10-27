/**
 * gateway/lib/logger.js — 结构化日志
 *
 * 约定：**不静默吞错**。所有 catch 都必须 log.warn/log.error 带上下文；
 * 任何一次降级（ROS2 断连、熔断、阶梯重启失败）都要在日志与 /api/health 里可见。
 *
 * 形态兼容：返回的 logger 既可当函数调用 `log('warn', event, data)`，
 * 也可当对象用 `log.warn(event, data)`——历史模块两种写法都有，统一在这里兜住。
 */

'use strict'

import fs from 'node:fs'
import path from 'node:path'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

export function Logger({ dir = null, level = 'info', name = 'gateway', ringSize = 300, ring: sharedRing = null } = {}) {
  const S = {
    name,
    level: LEVELS[level] || LEVELS.info,
    dir,
    file: null,
    ring: sharedRing || [],
    ringSize,
    scope: undefined,
  }

  if (S.dir) {
    try {
      fs.mkdirSync(S.dir, { recursive: true })
      const day = new Date().toISOString().slice(0, 10)
      S.file = path.join(S.dir, `${S.name}-${day}.log`)
    } catch (e) {
      // 日志目录建不出来：退化为纯 stdout，并把原因说出来（不静默）
      process.stderr.write(`[gateway][logger] 日志目录不可用（改为仅控制台）：${S.dir} → ${e && e.message}\n`)
      S.file = null
    }
  }

  function log(lv, event, data) {
    if ((LEVELS[lv] || 0) < S.level) return
    const rec = {
      t: new Date().toISOString(),
      level: lv,
      scope: S.scope || undefined,
      event,
      ...(data && typeof data === 'object' && !(data instanceof Error) ? { data: normalize(data) } : (data !== undefined ? { data: normalize({ v: data }).v } : {})),
    }
    const tag = rec.scope ? `${S.name}:${rec.scope}` : S.name
    const pretty = `[${rec.t.slice(11, 19)}] ${lv.toUpperCase().padEnd(5)} ${tag} ${event}${rec.data ? ' ' + safeStr(rec.data) : ''}`
    try { (lv === 'error' || lv === 'warn' ? process.stderr : process.stdout).write(pretty + '\n') } catch { /* stdout 关闭时忽略 */ }
    if (S.file) {
      try { fs.appendFileSync(S.file, JSON.stringify(rec) + '\n', 'utf8') } catch { /* 磁盘满/权限：忽略写入，不抛 */ }
    }
    S.ring.push(rec)
    if (S.ring.length > S.ringSize) S.ring.shift()
  }

  // 可调用主体
  const fn = function loggerFn(lv, event, data) { return log(lv, event, data) }
  fn.log = log
  fn.debug = (e, d) => log('debug', e, d)
  fn.info = (e, d) => log('info', e, d)
  fn.warn = (e, d) => log('warn', e, d)
  fn.error = (e, d) => log('error', e, d)
  fn.recent = (n = 100) => S.ring.slice(-n)
  fn.child = (scope) => {
    const c = Logger({ dir: S.dir, level: nameOf(S.level), name: S.name, ringSize: S.ringSize, ring: S.ring })
    c.scope = scope
    c.file = S.file
    return c
  }
  Object.defineProperty(fn, 'file', { get: () => S.file, set: (v) => { S.file = v }, enumerable: true, configurable: true })
  Object.defineProperty(fn, 'scope', { get: () => S.scope, set: (v) => { S.scope = v }, enumerable: true, configurable: true })
  Object.defineProperty(fn, 'ring', { get: () => S.ring, enumerable: true, configurable: true })
  Object.defineProperty(fn, 'level', { get: () => S.level, set: (v) => { S.level = LEVELS[v] ?? Number(v) ?? S.level }, enumerable: true, configurable: true })
  Object.defineProperty(fn, 'dir', { get: () => S.dir, enumerable: true, configurable: true })
  Object.defineProperty(fn, 'name', { get: () => S.name, enumerable: true, configurable: true })
  return fn
}

function nameOf(lv) {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === lv) || 'info'
}

function safeStr(v) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s && s.length > 400 ? s.slice(0, 400) + '…' : s
  } catch { return '[unserializable]' }
}

/** 保证日志可序列化（Error → 消息 + 栈首行） */
function normalize(data) {
  if (!data || typeof data !== 'object') return data
  const out = {}
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Error) out[k] = `${v.message} @ ${String(v.stack || '').split('\n')[1] || ''}`.trim()
    else if (typeof v === 'bigint') out[k] = Number(v)
    else out[k] = v
  }
  return out
}

export const logger = Logger({
  dir: process.env.GW_LOG_DIR || null,
  level: process.env.GW_LOG_LEVEL || 'info',
})

export { LEVELS }