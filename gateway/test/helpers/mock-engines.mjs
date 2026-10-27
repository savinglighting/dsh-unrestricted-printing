/**
 * gateway/test/helpers/mock-engines.mjs — 假 WebUI / 假 ComfyUI
 * 用于集成测试：验证路由分流、状态机、队列单车道、超时熔断、蒙版/图生图参数传递。
 * 故意做成「可注入故障」（hang / 500 / OOM 文本 / 慢响应），不依赖本机真实后端。
 */

'use strict'

import http from 'node:http'
import zlib from 'node:zlib'

/** 生成一张 8x8 的合法 PNG（避免测试依赖任何外部图片文件） */
export function makePng(width = 8, height = 8, rgb = [90, 140, 200]) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1)
    raw[rowStart] = 0 // filter type 0
    for (let x = 0; x < width; x++) {
      const o = rowStart + 1 + x * 3
      raw[o] = rgb[0]
      raw[o + 1] = rgb[1]
      raw[o + 2] = rgb[2]
    }
  }
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
    return Buffer.concat([len, typeBuf, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => { d += c })
    req.on('end', () => resolve(d))
    req.on('error', () => resolve(''))
  })
}

/**
 * 假 WebUI（A1111）
 * @param {object} opts { delayMs, behavior:'ok'|'hang'|'500'|'oom'|'no-image', images }
 */
export async function startMockWebui(opts = {}) {
  const { delayMs = 0, images = 1, checkpoint = 'mock-model.safetensors' } = opts
  const calls = []
  const concurrency = { current: 0, max: 0 }
  const png = makePng()
  const server = http.createServer(async (req, res) => {
    const behavior = opts.behavior || 'ok' // 请求时实时读取：测试中途可以 setBehavior 切换
    const url = req.url || '/'
    const body = await readBody(req)
    calls.push({ method: req.method, url, body: body ? JSON.parse(body) : null, at: Date.now() })
    if (url.startsWith('/sdapi/v1/options')) {
      if (behavior === 'offline') { res.destroy(); return }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ sd_model_checkpoint: checkpoint, lora: [] }))
      return
    }
    if (url.startsWith('/sdapi/v1/loras') || url.startsWith('/sdapi/v1/sd-models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([]))
      return
    }
    if (url.startsWith('/sdapi/v1/reload-checkpoint')) {
      opts.__healed = true // 模拟自愈：此后出图恢复正常
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }
    if (url.startsWith('/sdapi/v1/progress')) {
      // A1111 真实进度接口（进度条数据源）：给一个确定性的 62% + ETA 8s
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ progress: 0.62, eta_relative: 8.0, state: { sampling_step: 15, sampling_steps: 24 }, current_image: null }))
      return
    }
    if (url.includes('/sdapi/v1/txt2img') || url.includes('/sdapi/v1/img2img')) {
      if (behavior === 'hang') return // 永不响应 → 触发客户端超时
      if (behavior === '500') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        // 注意：不要用 ExceptionGroup 这个壳——它是 A1111 对"设备/显存类"失败的包装，
        // 网关会对它走一次自愈重试。业务失败的形状是 RuntimeError + 明确 detail。
        res.end(JSON.stringify({ error: 'RuntimeError', detail: 'mock 500 业务失败' }))
        return
      }
      if (behavior === 'device-mismatch' && !opts.__healed) {
        // 模拟 unload 之后的 HalfTensor 设备错位：直到 /reload-checkpoint 被调用才恢复
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'ExceptionGroup', detail: 'RuntimeError: Input type (torch.cuda.HalfTensor) and weight type (torch.HalfTensor) should be the same' }))
        return
      }
      if (behavior === 'oom') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'RuntimeError', detail: 'CUDA out of memory. Tried to allocate 2.00 GiB' }))
        return
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      if (behavior === 'no-image') { /* 空列表 */ }
      concurrency.current += 1
      concurrency.max = Math.max(concurrency.max, concurrency.current)
      setTimeout(() => { concurrency.current = Math.max(0, concurrency.current - 1) }, 200)
      const list = behavior === 'no-image' ? [] : Array.from({ length: images }, () => png.toString('base64'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ images: list, seed: 4242, info: '{}' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    kind: 'webui',
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    concurrency,
    setBehavior(b) { opts.behavior = b },
    get generationCalls() { return calls.filter((c) => c.url.includes('txt2img') || c.url.includes('img2img')) },
    close: () => new Promise((r) => server.close(r)),
  }
}

/**
 * 假 ComfyUI
 * @param {object} opts { delayMs, behavior:'ok'|'hang'|'error-status'|'no-history', modelFiles }
 */
export async function startMockComfy(opts = {}) {
  const { delayMs = 0, modelFiles = null } = opts
  const calls = []
  const png = makePng(16, 16)
  const submitAt = new Map()
  let seq = 0
  const concurrency = { current: 0, max: 0 }
  const server = http.createServer(async (req, res) => {
    const behavior = opts.behavior || 'ok' // 请求时实时读取
    const url = req.url || '/'
    const body = await readBody(req)
    let parsed = null
    try { parsed = body ? JSON.parse(body) : null } catch { parsed = { raw: body.slice(0, 100) } }
    calls.push({ method: req.method, url, body: parsed, at: Date.now() })
    if (url.startsWith('/queue')) { res.writeHead(200); res.end('{"queue_pending":[]}'); return }
    if (url.startsWith('/system_stats')) { res.writeHead(200); res.end('{"system":{}}'); return }
    if (url.startsWith('/models')) {
      if (!modelFiles) { res.writeHead(404); res.end('{}'); return }
      const folder = decodeURIComponent(url.split('/')[2] || '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(modelFiles[folder] || []))
      return
    }
    if (url.startsWith('/object_info')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        UnetLoaderGGUF: {}, CLIPLoader: {}, VAELoader: {}, CLIPTextEncode: {},
        EmptyLatentImage: {}, KSampler: {}, VAEDecode: {}, SaveImage: {},
        LoadImage: {}, VAEEncode: {}, LoadImageMask: {}, VAEEncodeForInpaint: {},
      }))
      return
    }
    if (url.startsWith('/upload/image')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ name: `uploaded_${++seq}.png`, subfolder: '', type: 'input' }))
      return
    }
    if (url.startsWith('/prompt')) {
      if (behavior === 'hang') return
      const promptId = `mock-${++seq}-${Date.now()}`
      submitAt.set(promptId, Date.now())
      concurrency.current += 1
      concurrency.max = Math.max(concurrency.max, concurrency.current)
      setTimeout(() => { concurrency.current = Math.max(0, concurrency.current - 1) }, 300)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ prompt_id: promptId, number: seq }))
      return
    }
    const hist = url.match(/^\/history\/(.+)$/)
    if (hist) {
      const pid = decodeURIComponent(hist[1])
      const started = submitAt.get(pid) || Date.now()
      if (delayMs && Date.now() - started < delayMs) { res.writeHead(200); res.end('{}'); return }
      if (behavior === 'hang') return
      if (behavior === 'error-status') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ [pid]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'mock 执行失败' }]] }, outputs: {} } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ [pid]: { status: { status_str: 'success' }, outputs: { '11': { images: [{ filename: `${pid}.png`, subfolder: '', type: 'output' }] } } } }))
      return
    }
    if (url.startsWith('/view')) {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(png)
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    kind: 'comfy',
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    concurrency,
    get promptCalls() { return calls.filter((c) => c.url.startsWith('/prompt')) },
    setBehavior(b) { opts.behavior = b },
    close: () => new Promise((r) => server.close(r)),
  }
}

/** 极简假 rosbridge：用 ros2.js 的帧编解码实现订阅发放 */
export async function startMockRosbridge({ payloads = [], onConnect = null } = {}) {
  const { encodeFrame, decodeFrames, acceptKey } = await import('../../lib/ros2.js')
  const sockets = new Set()
  const received = []
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    )
    sockets.add(socket)
    let buf = Buffer.alloc(0)
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      const { frames, rest } = decodeFrames(buf)
      buf = rest
      for (const f of frames) {
        try { received.push(JSON.parse(f.payload.toString('utf8'))) } catch { received.push({ raw: f.payload.toString('utf8') }) }
      }
    })
    socket.on('error', () => sockets.delete(socket))
    socket.on('close', () => sockets.delete(socket))
    if (onConnect) onConnect({ socket, send: (obj) => socket.write(encodeFrame(JSON.stringify(obj), { opcode: 1, mask: false })) })
    for (const p of payloads) {
      setTimeout(() => { try { socket.write(encodeFrame(JSON.stringify(p), { opcode: 1, mask: false })) } catch { /* 已断开 */ } }, 50)
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    received,
    sockets,
    sendAll(obj) {
      for (const s of sockets) { try { s.write(encodeFrame(JSON.stringify(obj), { opcode: 1, mask: false })) } catch { /* 忽略 */ } }
    },
    dropAll() { for (const s of sockets) { try { s.destroy() } catch { /* 忽略 */ } } sockets.clear() },
    close: () => new Promise((r) => { for (const s of sockets) { try { s.destroy() } catch { /* 忽略 */ } } server.close(r) }),
  }
}