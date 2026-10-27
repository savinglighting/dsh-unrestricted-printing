/**
 * gateway/lib/vram-guard.js — 标注/训练与出图之间的显存互斥（P5）
 *
 * 为什么必须要有这个文件（本机实测，2026-10-22）：
 *   8GB 显卡上，Ollama 的 qwen3-vl:8b 一加载就占 5.1GB，
 *   SD 只剩约 3GB → 出图直接超时（实测 aborted due to timeout）。
 *   而标注 23 张要 8–12 分钟，期间用户若来一句「再画一张」必然失败。
 *
 * 所以把「谁在用显存」做成显式状态：
 *   · 进入标注/训练前：让 Ollama 卸掉常驻模型（keep_alive:0），把显存还给 SD；
 *   · 退出时（无论成功失败）：不主动重载，交给下一次实际调用按需加载（Ollama 自己会拉）；
 *   · 全程只做"尽力而为"的清理，任何一步失败都只记日志，绝不阻断主流程。
 *
 * 与既有 sd-bridge.js 里 releaseVramSide 的区别：那个在插件进程里做显存自愈，
 * 这个在网关/CLI 进程里给「炼制流水线」用，两边互不依赖。
 */

'use strict'

/** 让 Ollama 卸载常驻模型（keep_alive:0），返回释放了几个 */
export async function releaseVlmVram({
  vlmBase = 'http://127.0.0.1:11434/v1',
  timeoutMs = 20000,
  fetchImpl = globalThis.fetch,
  log = null,
} = {}) {
  const base = String(vlmBase).replace(/\/$/, '').replace(/\/v1$/, '')
  const freed = []
  const failed = []
  try {
    const res = await fetchImpl(`${base}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res || !res.ok) return { ok: false, freed, failed, reason: `HTTP ${res ? res.status : 'n/a'}` }
    const j = await res.json().catch(() => null)
    const models = Array.isArray(j && j.models) ? j.models.map((m) => String(m.name || m.model || '')).filter(Boolean) : []
    for (const m of models) {
      try {
        const r2 = await fetchImpl(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: m, keep_alive: 0 }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (r2 && r2.ok) freed.push(m)
        else failed.push(m)
      } catch (e) {
        failed.push(m)
      }
    }
    log?.('warn', 'vram.vlm_released', { freed, failed })
    return { ok: true, freed, failed }
  } catch (e) {
    log?.('warn', 'vram.vlm_release_failed', { error: e })
    return { ok: false, freed, failed, reason: (e && e.message) || String(e) }
  }
}

/** 让 A1111 卸载 checkpoint（下次出图自动重载），把显存让给训练 */
export async function releaseSdVram({
  sdUrl = 'http://127.0.0.1:7860',
  timeoutMs = 20000,
  fetchImpl = globalThis.fetch,
  log = null,
} = {}) {
  const base = String(sdUrl).replace(/\/$/, '')
  const done = []
  for (const ep of ['sdapi/v1/unload-checkpoint', 'sdapi/v1/free']) {
    try {
      const r = await fetchImpl(`${base}/${ep}`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) })
      if (r && r.ok) done.push(ep)
    } catch { /* 端点不存在/服务没起都不算故障 */ }
  }
  log?.('warn', 'vram.sd_released', { done })
  return { ok: done.length > 0, done }
}

/** 当前 Ollama 常驻模型占了多少显存（GB），用于日志与判断 */
export async function vlmVramUsage({ vlmBase = 'http://127.0.0.1:11434/v1', timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const base = String(vlmBase).replace(/\/$/, '').replace(/\/v1$/, '')
  try {
    const res = await fetchImpl(`${base}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res || !res.ok) return { ok: false, totalGb: null, models: [] }
    const j = await res.json().catch(() => null)
    const models = (Array.isArray(j && j.models) ? j.models : []).map((m) => ({
      name: String(m.name || m.model || ''),
      vramGb: Number.isFinite(Number(m.size_vram)) ? Number((Number(m.size_vram) / 1024 ** 3).toFixed(2)) : null,
    }))
    const totalGb = models.reduce((a, m) => a + (m.vramGb || 0), 0)
    return { ok: true, totalGb: Number(totalGb.toFixed(2)), models }
  } catch {
    return { ok: false, totalGb: null, models: [] }
  }
}

/**
 * 包裹一段「吃显存」的工作：进入前清场，退出后记账（不主动重载）。
 * 任何清理失败都只警告，绝不阻断 work 本身。
 *
 * @param {object} o
 * @param {'vlm'|'sd'|'both'} o.release 先释放谁
 * @param {Function} o.work 实际工作（可以是 async）
 */
export async function withVramReleased({
  release = 'vlm',
  work,
  vlmBase = 'http://127.0.0.1:11434/v1',
  sdUrl = 'http://127.0.0.1:7860',
  fetchImpl = globalThis.fetch,
  log = null,
} = {}) {
  const before = release === 'vlm' || release === 'both' ? await vlmVramUsage({ vlmBase, fetchImpl }) : null
  const released = []
  try {
    if (release === 'vlm' || release === 'both') released.push({ side: 'vlm', ...(await releaseVlmVram({ vlmBase, fetchImpl, log })) })
    if (release === 'sd' || release === 'both') released.push({ side: 'sd', ...(await releaseSdVram({ sdUrl, fetchImpl, log })) })
  } catch (e) {
    log?.('warn', 'vram.release_error', { error: e })
  }
  const result = await work()
  return { result, vram: { before, released } }
}

export default { releaseVlmVram, releaseSdVram, vlmVramUsage, withVramReleased }