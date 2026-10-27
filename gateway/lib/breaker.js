/**
 * gateway/lib/breaker.js — 超时/失败熔断（P6：超时熔断）
 *
 * 设计：每个引擎一个断路器。连续 threshold 次「超时/连接类」失败 → OPEN；
 * 冷却 cooldownMs 后进入 HALF_OPEN，放行一次探测，成功则 CLOSED，失败则重新 OPEN。
 * 业务类失败（尺寸非法、模型缺失）不计入熔断。
 */

'use strict'

export class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 60000, now = () => Date.now(), log = null } = {}) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
    this.now = now
    this.log = log
    /** @type {Map<string, {state:string, failures:number, openedAt:number|null, lastError:string|null, trips:number}>} */
    this.map = new Map()
  }

  _rec(key) {
    if (!this.map.has(key)) {
      this.map.set(key, { key, state: 'closed', failures: 0, openedAt: null, lastError: null, trips: 0, lastSuccessAt: null })
    }
    return this.map.get(key)
  }

  /** 是否放行本次调用 */
  allow(key) {
    const r = this._rec(key)
    if (r.state === 'closed') return true
    if (r.state === 'open') {
      if (this.now() - r.openedAt >= this.cooldownMs) {
        r.state = 'half-open'
        this.log?.('warn', 'breaker.half_open', { key })
        return true
      }
      return false
    }
    // half-open：只放行一次探测（由 recordSuccess/recordFailure 复位状态）
    return true
  }

  /** 记录成功 → CLOSED */
  recordSuccess(key) {
    const r = this._rec(key)
    if (r.state !== 'closed' || r.failures) this.log?.('info', 'breaker.closed', { key, from: r.state, failures: r.failures })
    r.state = 'closed'
    r.failures = 0
    r.openedAt = null
    r.lastError = null
    r.lastSuccessAt = this.now()
  }

  /** 记录失败（仅超时/连接类调用方才会调用）→ 可能 OPEN */
  recordFailure(key, error) {
    const r = this._rec(key)
    r.failures += 1
    r.lastError = String(error || 'unknown')
    if (r.state === 'half-open' || r.failures >= this.threshold) {
      r.state = 'open'
      r.openedAt = this.now()
      r.trips += 1
      this.log?.('error', 'breaker.open', { key, failures: r.failures, error: r.lastError })
    }
    return r.state
  }

  state(key) {
    const r = this._rec(key)
    return {
      key: r.key,
      state: r.state,
      failures: r.failures,
      trips: r.trips,
      lastError: r.lastError,
      openedAt: r.openedAt,
      retryAfterMs: r.state === 'open' ? Math.max(0, this.cooldownMs - (this.now() - r.openedAt)) : 0,
    }
  }

  all() {
    return [...this.map.keys()].map((k) => this.state(k))
  }

  reset(key) {
    if (key) this.map.delete(key)
    else this.map.clear()
  }
}

/** 判定一个错误是否属于「超时/连接」类（可熔断） */
export function isTimeoutOrConnError(msg) {
  const s = String(msg || '')
  return /timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|aborted|AbortError|fetch failed|circuit open|网络|超时/i.test(s)
}