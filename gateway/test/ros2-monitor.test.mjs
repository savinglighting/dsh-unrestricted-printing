/**
 * P3 ROS2 监控：真实 WebSocket 握手/帧编解码（对着 mock rosbridge），断连降级 nvidia-smi
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFrame, decodeFrames, acceptKey, parseWsUrl, Ros2WsClient, formatErr } from '../lib/ros2.js'
import { Monitor } from '../lib/monitor.js'
import { startMockRosbridge } from './helpers/mock-engines.mjs'

const logs = []
const log = (lv, ev, data) => logs.push({ lv, ev, data })

function fakeExec({ output = '8151, 6145, 12', fail = false } = {}) {
  const exec = (file, args, opts, cb) => {
    exec.calls.push({ file, args })
    if (fail) cb(Object.assign(new Error('nvidia-smi not found'), { code: 'ENOENT' }), '', '')
    else cb(null, output + '\n', '')
  }
  exec.calls = []
  return exec
}

test('帧编解码：文本帧带掩码往返一致；分片/多帧缓冲可解', () => {
  const f = encodeFrame('hello', { opcode: 1, mask: true })
  const { frames, rest } = decodeFrames(f)
  assert.equal(rest.length, 0)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].opcode, 1)
  assert.equal(frames[0].payload.toString(), 'hello')

  const a = encodeFrame('{"op":"publish"}', { opcode: 1, mask: true })
  const b = encodeFrame('second', { opcode: 1, mask: false })
  const { frames: two } = decodeFrames(Buffer.concat([a, b]))
  assert.equal(two.length, 2)
  assert.equal(two[1].payload.toString(), 'second')

  // 半包：第一段解不出完整帧，拼上第二段才解出
  const half = a.subarray(0, a.length - 3)
  const r1 = decodeFrames(half)
  assert.equal(r1.frames.length, 0)
  const r2 = decodeFrames(Buffer.concat([r1.rest, a.subarray(a.length - 3)]))
  assert.equal(r2.frames.length, 1)

  // 大 payload（>125 字节）走 16 位长度分支
  const big = 'x'.repeat(900)
  const { frames: bigF } = decodeFrames(encodeFrame(big, { mask: true }))
  assert.equal(bigF[0].payload.toString().length, 900)
})

test('握手：Sec-WebSocket-Accept 按 RFC 计算', () => {
  // RFC6455 官方示例
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('parseWsUrl / formatErr：可读的错误文本（AggregateError 展平）', () => {
  assert.deepEqual(parseWsUrl('ws://localhost:9090/'), { secure: false, protocol: 'ws:', host: 'localhost', port: 9090, path: '/' })
  assert.equal(parseWsUrl('wss://example.com/ros').port, 443)
  const agg = Object.assign(new Error(''), { errors: [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9090'), { code: 'ECONNREFUSED' })] })
  assert.match(formatErr(agg), /ECONNREFUSED/)
})

test('ROS2 端到端：连上 mock rosbridge → 发出 subscribe → 收到 JSON 更新快照', async (t) => {
  const bridge = await startMockRosbridge({
    payloads: [
      { op: 'publish', topic: '/hardware_monitor', msg: { vram_free_gb: 5.5, vram_total_gb: 8, gpu_util: 37 } },
    ],
  })
  t.after(async () => { await bridge.close() })

  const exec = fakeExec({ fail: true }) // nvidia-smi 不可用 → 只有 ROS2 能提供快照
  const mon = new Monitor({ url: bridge.url, topic: '/hardware_monitor', log, exec, nvidiaIntervalMs: 100000 })
  mon.start()
  t.after(() => mon.stop())

  const deadline = Date.now() + 5000
  while (Date.now() < deadline && mon.getSnapshot().source !== 'ros2') await new Promise((r) => setTimeout(r, 100))
  const snap = mon.getSnapshot()
  assert.equal(snap.source, 'ros2')
  assert.equal(snap.vramFreeGb, 5.5)
  assert.equal(snap.vramTotalGb, 8)
  assert.equal(snap.gpuUtil, 37)
  assert.equal(snap.degraded, false, 'ROS2 在线时不应标记降级')
  assert.equal(snap.ros2.connected, true)
  assert.ok(bridge.received.some((m) => m.op === 'subscribe' && m.topic === '/hardware_monitor'), '必须向 rosbridge 发 subscribe')
})

test('ROS2 只认 JSON：坏包/非 JSON 不影响连接与后续消息', async (t) => {
  const bridge = await startMockRosbridge()
  t.after(async () => { await bridge.close() })
  const mon = new Monitor({ url: bridge.url, topic: '/hw', log, exec: fakeExec(), nvidiaIntervalMs: 100000 })
  mon.start()
  t.after(() => mon.stop())
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !mon.isRosConnected()) await new Promise((r) => setTimeout(r, 50))
  assert.equal(mon.isRosConnected(), true)

  // 裸 socket 发一段非 JSON 文本帧：客户端应忽略而不是断开
  for (const s of bridge.sockets) s.write(encodeFrame('not-json{{{', { opcode: 1, mask: false }))
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(mon.isRosConnected(), true, '坏 JSON 不能把连接搞断')
  assert.equal(mon.getSnapshot().source, 'nvidia-smi', '未收到有效监控报文时保持降级来源')

  // 非硬件报文（缺字段）也不得污染快照
  bridge.sendAll({ op: 'publish', topic: '/other', msg: { foo: 'bar' } })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(mon.getSnapshot().source, 'nvidia-smi')

  // 位号单位换算：给的是 MB 也要归一成 GB
  bridge.sendAll({ op: 'publish', msg: { vram_free: 4096, vram_total: 8192 } })
  const d2 = Date.now() + 2000
  while (Date.now() < d2 && mon.getSnapshot().vramFreeGb !== 4) await new Promise((r) => setTimeout(r, 50))
  assert.equal(mon.getSnapshot().vramFreeGb, 4)
})

test('断连降级：rosbridge 掉线 → 立刻回落到 nvidia-smi，准入判定仍可用', async (t) => {
  const bridge = await startMockRosbridge({ payloads: [{ vram_free_gb: 6, vram_total_gb: 8 }] })
  const exec = fakeExec({ output: '8151, 5120, 3' })
  const mon = new Monitor({ url: bridge.url, topic: '/hw', log, exec, nvidiaIntervalMs: 100000, vramMinFreeGb: 1.5, vramWarnFreeGb: 3 })
  mon.start()
  t.after(() => { mon.stop(); return bridge.close() })
  const d0 = Date.now() + 4000
  while (Date.now() < d0 && mon.getSnapshot().source !== 'ros2') await new Promise((r) => setTimeout(r, 50))
  assert.equal(mon.getSnapshot().source, 'ros2')

  bridge.dropAll()
  const d1 = Date.now() + 4000
  while (Date.now() < d1 && mon.getSnapshot().source !== 'nvidia-smi') await new Promise((r) => setTimeout(r, 50))
  const snap = mon.getSnapshot()
  assert.equal(snap.source, 'nvidia-smi', '断连必须降级到 nvidia-smi')
  assert.equal(snap.degraded, true)
  assert.equal(snap.vramFreeGb, 5)
  assert.ok(exec.calls.length >= 1)
  const adm = mon.admission()
  assert.equal(adm.admit, true)
  assert.equal(adm.level, 'ok')

  // 断连期间尝试重连：mock 已关，客户端不应抛错也不应卡住
  assert.ok(mon.getSnapshot().ros2.reconnects >= 0)
})

test('ROS2 未运行：连不上也不阻塞（监控降级、快照过期 → 放行）', async () => {
  const mon = new Monitor({ url: 'ws://127.0.0.1:1', topic: '/hw', log, exec: fakeExec({ fail: true }), nvidiaIntervalMs: 100000 })
  mon.start()
  await new Promise((r) => setTimeout(r, 300))
  const snap = mon.getSnapshot()
  assert.equal(snap.degraded, true)
  assert.equal(snap.source, 'none', 'ROS2 与 nvidia-smi 都不可用时 source=none')
  const adm = mon.admission()
  assert.equal(adm.admit, true, '监控不可用时必须放行出图（监控不阻塞生图）')
  assert.equal(adm.level, 'unknown')
  assert.equal(mon.oomRisk().risk, 'unknown')
  mon.stop()
})

test('准入与 OOM 预警分级：低显存 → block（排队等待不丢任务）；偏低 → warn/high', async () => {
  const mon = new Monitor({ url: 'ws://127.0.0.1:1', enabled: false, log, exec: fakeExec({ output: '8151, 1024, 90' }), vramMinFreeGb: 1.5, vramWarnFreeGb: 3 })
  await mon.refreshNvidia()
  const adm = mon.admission()
  assert.equal(adm.admit, false)
  assert.equal(adm.level, 'block')
  assert.ok(adm.waitMs > 0, '不通过时应给出等待时间（排队而不是失败）')
  assert.equal(mon.oomRisk().risk, 'high')

  const mon2 = new Monitor({ url: 'ws://127.0.0.1:1', enabled: false, log, exec: fakeExec({ output: '8151, 2560, 20' }), vramMinFreeGb: 1.5, vramWarnFreeGb: 3 })
  await mon2.refreshNvidia()
  assert.equal(mon2.admission().level, 'warn')
  assert.equal(mon2.oomRisk().risk, 'medium')

  const mon3 = new Monitor({ url: 'ws://127.0.0.1:1', enabled: false, log, exec: fakeExec({ output: '8151, 7000, 1' }), vramMinFreeGb: 1.5, vramWarnFreeGb: 3 })
  await mon3.refreshNvidia()
  assert.equal(mon3.admission().level, 'ok')
  assert.equal(mon3.oomRisk().risk, 'low')
})

test('快照过期判定：超过 staleMs 标 stale（调用方据此放行）', async () => {
  let now = 1000
  const mon = new Monitor({ url: 'ws://x', enabled: false, log, exec: fakeExec({ output: '8151, 6000, 5' }), staleMs: 1000, now: () => now })
  await mon.refreshNvidia()
  assert.equal(mon.getSnapshot().stale, false)
  now = 5000
  const snap = mon.getSnapshot()
  assert.equal(snap.stale, true)
  assert.equal(mon.admission().admit, true, '数据过期时不做准入拦截')
  assert.equal(mon.admission().level, 'unknown')
})