/**
 * P6 超时熔断（CircuitBreaker + engines 客户端联动）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CircuitBreaker, isTimeoutOrConnError } from '../lib/breaker.js'
import { EngineClients, classifyError } from '../lib/engines.js'

const logs = []
const log = (lv, ev, data) => logs.push({ lv, ev, data })

test('断路器：连续 3 次失败 → open 并拒绝放行', () => {
  const b = new CircuitBreaker({ threshold: 3, cooldownMs: 1000, now: () => 0, log })
  assert.equal(b.allow('webui'), true)
  assert.equal(b.recordFailure('webui', 'timeout'), 'closed')
  assert.equal(b.allow('webui'), true)
  b.recordFailure('webui', 'timeout')
  assert.equal(b.allow('webui'), true)
  b.recordFailure('webui', 'timeout')
  assert.equal(b.state('webui').state, 'open')
  assert.equal(b.allow('webui'), false, 'OPEN 状态下必须拦截')
  assert.equal(b.state('webui').trips, 1)
})

test('断路器：冷却后半开，成功即闭合、失败重开', () => {
  let t = 0
  const b = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, now: () => t, log })
  b.recordFailure('webui', 'timeout')
  b.recordFailure('webui', 'timeout')
  assert.equal(b.allow('webui'), false)
  t = 1500
  assert.equal(b.allow('webui'), true, '冷却结束进入半开，放行探测')
  b.recordSuccess('webui')
  assert.equal(b.state('webui').state, 'closed')
  assert.equal(b.state('webui').failures, 0)

  b.recordFailure('webui', 'timeout')
  b.recordFailure('webui', 'timeout')
  t = 4000
  assert.equal(b.allow('webui'), true)
  b.recordFailure('webui', 'timeout')
  assert.equal(b.state('webui').state, 'open', '半开探测失败 → 立即重新 OPEN')
  assert.equal(b.state('webui').trips, 3, 'OPEN 次数：初次 + 再次 + 半开失败重开')
})

test('断路器：retryAfterMs 反映剩余冷却时间；reset 可清空', () => {
  let t = 0
  const b = new CircuitBreaker({ threshold: 1, cooldownMs: 5000, now: () => t, log })
  b.recordFailure('comfy', 'timeout')
  assert.equal(b.state('comfy').retryAfterMs, 5000)
  t = 2000
  assert.equal(b.state('comfy').retryAfterMs, 3000)
  b.reset('comfy')
  assert.equal(b.state('comfy').state, 'closed')
  assert.equal(b.all().length, 1, 'reset 后状态被清空重建')
})

test('错误分类：超时/连接类可熔断，业务错误不可熔断', () => {
  assert.equal(isTimeoutOrConnError('请求超时 2000ms: http://x'), true)
  assert.equal(isTimeoutOrConnError('ECONNREFUSED 127.0.0.1:7860'), true)
  assert.equal(isTimeoutOrConnError('fetch failed'), true)
  assert.equal(isTimeoutOrConnError('circuit open（webui 连续失败 3 次）'), true)
  assert.equal(isTimeoutOrConnError('Krea2_Q4 宽/高不得超过 1024'), false)
  assert.equal(classifyError('CUDA out of memory'), 'oom')
  assert.equal(classifyError('请求超时 2000ms'), 'timeout')
  assert.equal(classifyError('HTTP 404 /models/unet'), 'engine')
  assert.equal(classifyError('缺少模型文件: unet/x.safetensors'), 'model')
  // A1111 的 ExceptionGroup 空壳 → 走「可疑状态」自愈（坑62/坑64）
  assert.equal(classifyError('HTTP 500 {"error":"ExceptionGroup","detail":""}'), 'device-mismatch')
  assert.equal(classifyError('RuntimeError: Input type (torch.cuda.HalfTensor) and weight type (torch.HalfTensor) should be the same'), 'device-mismatch')
})

test('客户端超时：请求超过 timeoutMs 即返回超时错误并计入熔断', async () => {
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    // 模拟「服务挂着不回」：等 abort 信号
    if (opts && opts.signal) {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }
    setTimeout(() => resolve({ ok: true, text: async () => '{}' }), 10000).unref?.()
  })
  const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 60000, log })
  const c = new EngineClients({ webuiUrl: 'http://127.0.0.1:1', comfyUrl: 'http://127.0.0.1:2', fetchImpl, log, breaker, timeouts: { shortMs: 120 } })
  const r1 = await c.request('http://127.0.0.1:1/slow', { timeoutMs: 120, engine: 'webui' })
  assert.equal(r1.ok, false)
  assert.equal(r1.errorType, 'timeout')
  assert.match(r1.error, /请求超时 120ms/)
  await c.request('http://127.0.0.1:1/slow', { timeoutMs: 120, engine: 'webui' })
  assert.equal(breaker.state('webui').state, 'open')
  const r3 = await c.request('http://127.0.0.1:1/slow', { timeoutMs: 120, engine: 'webui' })
  assert.equal(r3.errorType, 'circuit', '熔断后直接返回 circuit open，不再打后端')
  assert.match(r3.error, /circuit open/)
})

test('客户端超时：非超时错误（HTTP 500）不熔断', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => '{"error":"boom"}' })
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60000, log })
  const c = new EngineClients({ webuiUrl: 'http://x', comfyUrl: 'http://y', fetchImpl, log, breaker })
  for (let i = 0; i < 3; i++) {
    const r = await c.request('http://x/txt2img', { method: 'POST', body: '{}', engine: 'webui' })
    assert.equal(r.ok, false)
    assert.equal(r.errorType, 'engine')
  }
  assert.equal(breaker.state('webui').state, 'closed', '业务 500 不应触发熔断')
})

test('waitReady：引擎起不来时超时返回 false（不抛）', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  const c = new EngineClients({ webuiUrl: 'http://x', comfyUrl: 'http://y', fetchImpl, log, timeouts: { shortMs: 50 } })
  const ok = await c.waitReady('webui', 600)
  assert.equal(ok, false)
})