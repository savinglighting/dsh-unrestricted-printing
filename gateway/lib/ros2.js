/**
 * gateway/lib/ros2.js — 零依赖 WebSocket 客户端（RFC6455）+ rosbridge 订阅（P3）
 *
 * 为什么手写：ROS2 监控必须能在**没装 npm 依赖**的插件目录里跑（dsh 插件不允许带一堆依赖）。
 * 实现范围：客户端握手（Sec-WebSocket-Accept 校验）、文本/二进制帧、分片重组、ping/pong、
 * 关闭帧、掩码编码（客户端→服务端必须掩码）。JSON 解析全 try-catch，坏包只记日志。
 *
 * frame 编解码同步导出，测试里可用来起一个 mock rosbridge 服务端做端到端验证。
 */

'use strict'

import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 把各种奇怪的连接错误压成一行可读文本（AggregateError 只取内层） */
export function formatErr(e) {
  if (!e) return 'unknown'
  if (Array.isArray(e.errors) && e.errors.length) {
    return e.errors.map((x) => formatErr(x)).join(' | ')
  }
  const code = e.code ? `${e.code}: ` : ''
  return `${code}${e.message || String(e)}`.trim() || String(e)
}

/** 计算握手应答 */
export function acceptKey(secKey) {
  return crypto.createHash('sha1').update(String(secKey) + WS_GUID).digest('base64')
}

/**
 * 编码一帧。
 * @param {Buffer|string} payload
 * @param {{opcode?:number, mask?:boolean, fin?:boolean}} opts
 */
export function encodeFrame(payload, { opcode = 1, mask = false, fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const len = data.length
  const head = []
  head.push((fin ? 0x80 : 0x00) | (opcode & 0x0f))
  const maskBit = mask ? 0x80 : 0x00
  if (len < 126) {
    head.push(maskBit | len)
  } else if (len < 65536) {
    head.push(maskBit | 126, (len >> 8) & 0xff, len & 0xff)
  } else {
    const b = Buffer.alloc(8)
    b.writeBigUInt64BE(BigInt(len))
    head.push(maskBit | 127, ...b)
  }
  let headBuf = Buffer.from(head)
  if (!mask) return Buffer.concat([headBuf, data])
  const key = crypto.randomBytes(4)
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ key[i % 4]
  return Buffer.concat([headBuf, key, masked])
}

/**
 * 从缓冲区里尽量多地解出完整帧。
 * @returns {{frames:Array<{fin:boolean,opcode:number,payload:Buffer}>, rest:Buffer}}
 */
export function decodeFrames(buf) {
  const frames = []
  let off = 0
  while (true) {
    if (buf.length - off < 2) break
    const b0 = buf[off]
    const b1 = buf[off + 1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let p = off + 2
    if (len === 126) {
      if (buf.length - p < 2) break
      len = buf.readUInt16BE(p); p += 2
    } else if (len === 127) {
      if (buf.length - p < 8) break
      const big = buf.readBigUInt64BE(p); p += 8
      len = Number(big > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : big)
    }
    let key = null
    if (masked) {
      if (buf.length - p < 4) break
      key = buf.subarray(p, p + 4); p += 4
    }
    if (buf.length - p < len) break
    const raw = buf.subarray(p, p + len)
    p += len
    let payload = raw
    if (key) {
      payload = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i++) payload[i] = raw[i] ^ key[i % 4]
    }
    frames.push({ fin, opcode, payload })
    off = p
  }
  return { frames, rest: buf.subarray(off) }
}

/** ws://host:port/path → {protocol, host, port, path} */
export function parseWsUrl(url) {
  const u = new URL(String(url))
  return {
    secure: u.protocol === 'wss:' || u.protocol === 'https:',
    protocol: u.protocol,
    host: u.hostname,
    port: Number(u.port || (u.protocol === 'wss:' ? 443 : 80)),
    path: (u.pathname || '/') + (u.search || ''),
  }
}

export class Ros2WsClient extends EventEmitter {
  constructor({ url, topic, log = null, reconnectMs = 3000, maxReconnectMs = 30000, connectTimeoutMs = 8000 } = {}) {
    super()
    this.url = url
    this.topic = topic
    this.log = log
    this.reconnectMs = reconnectMs
    this.maxReconnectMs = maxReconnectMs
    this.connectTimeoutMs = connectTimeoutMs
    this.socket = null
    this.connected = false
    this.manualStop = false
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.retryDelay = reconnectMs
    this.messages = 0
    this.lastMessageAt = null
    this.lastError = null
    this.reconnects = 0
    this._timer = null
    this._req = null
  }

  start() {
    this.manualStop = false
    this._connect()
    return this
  }

  stop() {
    this.manualStop = true
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    try { this.socket && this.socket.destroy() } catch (e) { this.log?.('debug', 'ros2.socket_destroy_failed', { error: e }) }
    this.socket = null
    if (this.connected) { this.connected = false; this.emit('close', { reason: 'manual-stop' }) }
    return this
  }

  /** 发送一条 JSON 消息（rosbridge 协议） */
  send(obj) {
    if (!this.socket || !this.connected) return false
    try {
      this.socket.write(encodeFrame(JSON.stringify(obj), { opcode: 1, mask: true }))
      return true
    } catch (e) {
      this.lastError = formatErr(e)
      this.log?.('warn', 'ros2.send_failed', { error: this.lastError, obj })
      return false
    }
  }

  _scheduleReconnect() {
    if (this.manualStop) return
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.reconnects += 1
      this._connect()
    }, this.retryDelay)
    this.retryDelay = Math.min(Math.max(this.retryDelay * 2, this.reconnectMs), this.maxReconnectMs)
    if (this._timer.unref) this._timer.unref()
  }

  _connect() {
    if (this.manualStop) return
    let target
    try {
      target = parseWsUrl(this.url)
    } catch (e) {
      this.lastError = `WS 地址非法: ${this.url}`
      this.log?.('warn', 'ros2.bad_url', { url: this.url, error: e })
      this._scheduleReconnect()
      return
    }
    const key = crypto.randomBytes(16).toString('base64')
    const lib = target.secure ? https : http
    const opts = {
      host: target.host,
      port: target.port,
      path: target.path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
      timeout: this.connectTimeoutMs,
    }
    let req
    try {
      req = lib.request(opts)
    } catch (e) {
      this.lastError = formatErr(e)
      this.log?.('warn', 'ros2.request_failed', { url: this.url, error: this.lastError })
      this._scheduleReconnect()
      return
    }
    this._req = req
    req.on('upgrade', (res, socket) => {
      try {
        const expect = acceptKey(key)
        const got = res.headers['sec-websocket-accept']
        if (got !== expect) {
          this.lastError = 'Sec-WebSocket-Accept 校验失败'
          this.log?.('warn', 'ros2.handshake_reject', { url: this.url, got, expect })
          try { socket.destroy() } catch (e) { this.log?.('debug', 'ros2.destroy_failed', { error: e }) }
          this._scheduleReconnect()
          return
        }
        this.socket = socket
        this.connected = true
        this.retryDelay = this.reconnectMs
        this.buffer = Buffer.alloc(0)
        this.fragments = []
        this.log?.('info', 'ros2.connected', { url: this.url, topic: this.topic })
        this.emit('open')
        this._subscribe()
        socket.on('data', (d) => this._onData(d))
        socket.on('close', (hadErr, code) => this._onClose(`socket-close code=${code ?? 'n/a'}`))
        socket.on('error', (e) => {
          this.lastError = formatErr(e)
          this.log?.('warn', 'ros2.socket_error', { error: this.lastError })
        })
        socket.setTimeout?.(0)
      } catch (e) {
        this.lastError = formatErr(e)
        this.log?.('warn', 'ros2.upgrade_handler_failed', { error: this.lastError })
        this._onClose('upgrade-handler-error')
      }
    })
    req.on('response', (res) => {
      // 不是 101：说明对面不是 ws（或 rosbridge 未开）
      this.lastError = `握手失败 HTTP ${res.statusCode}`
      this.log?.('warn', 'ros2.handshake_failed', { url: this.url, status: res.statusCode })
      try { res.resume() } catch (e) { this.log?.('debug', 'ros2.resume_failed', { error: e }) }
      this._onClose('handshake-failed')
    })
    req.on('error', (e) => {
      this.lastError = formatErr(e)
      this.log?.('debug', 'ros2.connect_error', { url: this.url, error: this.lastError })
      this._onClose('connect-error')
    })
    req.on('timeout', () => {
      this.lastError = `连接超时（${this.connectTimeoutMs}ms）`
      try { req.destroy() } catch (e) { this.log?.('debug', 'ros2.destroy_failed', { error: e }) }
      this._onClose('timeout')
    })
    try { req.end() } catch (e) {
      this.lastError = formatErr(e)
      this.log?.('warn', 'ros2.request_end_failed', { error: this.lastError })
      this._onClose('request-end-failed')
    }
  }

  _subscribe() {
    const topicMsg = { op: 'subscribe', topic: this.topic }
    const ok = this.send(topicMsg)
    this.log?.(ok ? 'info' : 'warn', 'ros2.subscribe', { topic: this.topic, ok })
    // rosbridge 的 JSON 传输模式：确保以 JSON 字符串下发（只传 JSON）
    this.send({ op: 'subscribe', topic: this.topic, queue_length: 1 })
  }

  _onClose(reason) {
    if (this.socket) { try { this.socket.destroy() } catch (e) { this.log?.('debug', 'ros2.destroy_failed', { error: e }) } }
    this.socket = null
    const was = this.connected
    this.connected = false
    if (was) {
      this.log?.('warn', 'ros2.disconnected', { url: this.url, reason, lastError: this.lastError })
      this.emit('close', { reason, error: this.lastError })
    }
    this._scheduleReconnect()
  }

  _onData(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk])
      const { frames, rest } = decodeFrames(this.buffer)
      this.buffer = rest
      for (const f of frames) this._onFrame(f)
    } catch (e) {
      // 解析异常：清掉缓冲，避免越滚越大；连接保留
      this.log?.('warn', 'ros2.decode_failed', { error: e })
      this.buffer = Buffer.alloc(0)
      this.fragments = []
    }
  }

  _onFrame(frame) {
    const { opcode, payload, fin } = frame
    try {
      if (opcode === 0x8) { // close
        this.log?.('info', 'ros2.close_frame', {})
        this._onClose('close-frame')
        return
      }
      if (opcode === 0x9) { // ping → pong
        if (this.socket) this.socket.write(encodeFrame(payload, { opcode: 0xa, mask: true }))
        return
      }
      if (opcode === 0xa) return // pong
      if (opcode === 0x0) { // continuation
        this.fragments.push(payload)
        if (!fin) return
        const full = Buffer.concat(this.fragments)
        this.fragments = []
        this._emitMessage(full)
        return
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) { this.fragments = [payload]; return }
        this._emitMessage(payload)
      }
    } catch (e) {
      this.log?.('warn', 'ros2.frame_handler_failed', { opcode, error: e })
    }
  }

  _emitMessage(buf) {
    this.messages += 1
    this.lastMessageAt = Date.now()
    let json = null
    try {
      json = JSON.parse(buf.toString('utf8'))
    } catch (e) {
      this.log?.('debug', 'ros2.non_json', { preview: buf.toString('utf8').slice(0, 120) })
      return
    }
    this.emit('message', json)
  }

  status() {
    return {
      url: this.url,
      topic: this.topic,
      connected: this.connected,
      messages: this.messages,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      reconnects: this.reconnects,
    }
  }
}