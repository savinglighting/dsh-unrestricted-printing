// 设置面板注册专项（0.7.0）：schema 注册、面板改动实时并回 cfg、patch 显式覆盖优先
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-guard-settings-'))
let registered = null
let scopeValue = {}
const scope = {
  get: () => scopeValue,
  watch: (fn) => { scope.watchFn = fn; return () => {} },
}
const ctx = {
  logger: { log: () => {} },
  effect: (fn) => fn(),
  get: (key) => {
    if (key === 'skills') return { register: () => () => {} }
    if (key === 'settings') return { register: (ns, schema) => ((registered = { ns, schema }), scope) }
    return undefined
  },
  tools: { register: (def) => () => {} },
}

const mod = await import('../sd-bridge.js')
// patch 层显式给了 port：设置面板不应覆盖它
mod.apply(ctx, { sdDir: '', port: 7860, defaultSampler: 'PATCH-SAMPLER' })

// 等异步 schema 构造（动态 import schemastery）落地
await new Promise((r) => setTimeout(r, 300))

assert.ok(registered, 'settings.register must be called')
assert.equal(registered.ns, 'sd-bridge', 'namespace must be plugin id sd-bridge')
assert.ok(registered.schema, 'schema must be constructed (schemastery resolvable)')

// schema 覆盖 DEFAULTS 全部字段（schemastery object schema 的字段在 .dict 上）
const shapeKeys = registered.schema && registered.schema.dict ? Object.keys(registered.schema.dict) : []
const defaultsKeys = Object.keys(mod.DEFAULTS)
for (const k of defaultsKeys) {
  assert.ok(shapeKeys.includes(k), `schema missing field: ${k}`)
}
assert.ok(shapeKeys.length >= defaultsKeys.length, 'schema should cover all DEFAULTS keys')

// 面板改动 → watch → cfg 生效（工具调用现读 cfg，无需重启）
scopeValue = { defaultSampler: 'Euler a', outputDir: 'MyPics', img2imgDenoising: 0.35, port: 9999 }
scope.watchFn()
// patch 层显式给了 defaultSampler 与 port → 面板不得覆盖（优先级：patch > 面板）
assert.equal(mod.cfg.defaultSampler, 'PATCH-SAMPLER', 'patch-provided defaultSampler must win over panel')
assert.equal(mod.cfg.port, 7860, 'patch-provided port must win over panel')
// 未被 patch 指定的键由面板接管
assert.equal(mod.cfg.outputDir, 'MyPics', 'panel outputDir must flow into cfg')
assert.equal(mod.cfg.img2imgDenoising, 0.35, 'panel denoising must flow into cfg')
// 越界值自动纠正（port 被 patch 冻结，这里用非 patch 键验证钳制）
scopeValue = { img2imgDenoising: 5, idleStopMinutes: -3, startupTimeoutMs: 10 }
scope.watchFn()
assert.equal(mod.cfg.img2imgDenoising, 1, 'denoising must be clamped to 0-1')
assert.equal(mod.cfg.idleStopMinutes, 0, 'idleStopMinutes must not go negative')
assert.equal(mod.cfg.startupTimeoutMs, 30000, 'startupTimeoutMs must be floored at 30s')

console.log('registered ns:', registered.ns)
console.log('schema fields:', shapeKeys.join(', '))
console.log('SETTINGS SMOKE OK')
