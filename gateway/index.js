/**
 * gateway/index.js — 网关启动入口
 *
 * 用法：
 *   node gateway/index.js                 # 按配置启动（默认 127.0.0.1:8799）
 *   node gateway/index.js --port 9000     # 覆盖端口
 *   node gateway/index.js --print-config  # 打印解析后的配置（不含密钥）后退出
 *   node gateway/index.js --check         # 只探测一次并打印健康信息后退出
 *
 * 幂等：端口上已经是本网关时直接退出 0（避免重复启动互相抢端口）。
 */

'use strict'

import process from 'node:process'
import { createGateway } from './server.js'
import { describeConfig, config as baseConfig } from './lib/config.js'

function argVal(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

const overrides = {}
const port = argVal('--port')
if (port) overrides.port = Number(port)

if (process.argv.includes('--print-config')) {
  process.stdout.write(JSON.stringify({ resolved: describeConfig(), full: baseConfig }, null, 2) + '\n')
  process.exit(0)
}

const gw = createGateway(overrides)

async function alreadyRunning() {
  try {
    const r = await fetch(`http://${gw.cfg.host}:${gw.cfg.port}/api/health`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) return false
    const j = await r.json()
    return !!(j && j.gateway === 'ok')
  } catch { return false }
}

async function main() {
  if (process.argv.includes('--check')) {
    const probes = await gw.probeModels(true)
    const snap = gw.monitor.getSnapshot()
    process.stdout.write(JSON.stringify({
      config: describeConfig(),
      models: probes.list,
      engines: { webui: probes.engines.webui.online, comfy: probes.engines.comfy.online },
      monitor: { source: snap.source, degraded: snap.degraded, vramFreeGb: snap.vramFreeGb },
    }, null, 2) + '\n')
    process.exit(0)
  }

  if (await alreadyRunning()) {
    gw.log.info('gateway.already_running', { url: `http://${gw.cfg.host}:${gw.cfg.port}`, note: '端口上已有本网关，本次启动直接退出（幂等）' })
    process.stdout.write(`[gateway] already running on http://${gw.cfg.host}:${gw.cfg.port}\n`)
    process.exit(0)
  }

  try {
    await gw.start()
    process.stdout.write(`[gateway] ready http://${gw.cfg.host}:${gw.cfg.port} outDir=${gw.cfg.outDir}\n`)
  } catch (e) {
    gw.log.error('gateway.listen_failed', { port: gw.cfg.port, error: e })
    process.stderr.write(`[gateway] 启动失败: ${(e && e.message) || e}\n`)
    process.exit(1)
  }
}

async function shutdown(signal) {
  gw.log.warn('gateway.signal', { signal })
  try { await gw.stop() } catch (e) { gw.log.error('gateway.stop_failed', { error: e }) }
  process.exit(0)
}

process.on('SIGINT', () => { shutdown('SIGINT') })
process.on('SIGTERM', () => { shutdown('SIGTERM') })
process.on('uncaughtException', (e) => {
  gw.log.error('gateway.uncaught_exception', { error: e })
  // 致命异常：释放锁后退出，交给外部守护重启（不静默吞掉）
  try { gw.store.endTraining('uncaught'); gw.store.clearState() } catch { /* 退出前的最后清理，失败也不阻塞退出 */ }
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  gw.log.error('gateway.unhandled_rejection', { error: e })
})

main()