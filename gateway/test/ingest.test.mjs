/**
 * gateway/test/ingest.test.mjs — 三源采集归一（P2）
 *
 * 本地路径 / URL / 参考图三种来源统一成一份清单；用本地 http mock 提供图片，
 * 覆盖"HTML 错误页冒充图片""超限文件""重复来源"这些现实坑。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import { classifySource, expandLocalDir, extFromUrl, suggestName, collect, checkCollection, isUrlLike } from '../lib/ingest.js'

let seq = 0
function tmp(tag) {
  const dir = path.join(os.tmpdir(), 'lora-ingest-test', `${tag}-${process.pid}-${++seq}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function png(width = 512, height = 768, fill = 0x11) {
  const b = Buffer.alloc(33, fill)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

/** 起一个只服务几张图的本地 http 服务器（不碰外网） */
async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('classifySource：目录 / 文件 / URL / 不存在 四类如实区分（不猜）', () => {
  const dir = tmp('cls')
  const file = path.join(dir, 'a.png')
  fs.writeFileSync(file, png())
  assert.equal(classifySource(dir).kind, 'local-dir')
  assert.equal(classifySource(file).kind, 'local-file')
  assert.equal(classifySource('https://example.com/a.png').kind, 'url')
  const missing = classifySource(path.join(dir, 'nope.png'))
  assert.equal(missing.kind, 'missing')
  assert.equal(missing.exists, false)
  assert.equal(classifySource('').kind, 'missing')
  assert.equal(classifySource(null).kind, 'missing')
  assert.equal(isUrlLike('HTTP://X/Y.JPG'), true)
  assert.equal(isUrlLike('D:\\pics'), false)
})

test('expandLocalDir：递归收图片，跳过隐藏目录与非图片', () => {
  const dir = tmp('expand')
  fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.hidden'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'a.png'), png())
  fs.writeFileSync(path.join(dir, 'b.jpg'), png())
  fs.writeFileSync(path.join(dir, 'note.txt'), 'x')
  fs.writeFileSync(path.join(dir, 'sub', 'c.webp'), png())
  fs.writeFileSync(path.join(dir, 'sub', 'deep', 'd.png'), png())
  fs.writeFileSync(path.join(dir, '.hidden', 'e.png'), png())
  const files = expandLocalDir(dir)
  assert.deepEqual(files.map((f) => path.basename(f)), ['a.png', 'b.jpg', 'c.webp', 'd.png'])
  assert.deepEqual(expandLocalDir(dir, { maxDepth: 1 }).map((f) => path.basename(f)), ['a.png', 'b.jpg', 'c.webp'])
})

test('extFromUrl / suggestName：URL 无扩展名时按 content-type 兜底命名', () => {
  assert.equal(extFromUrl('https://x.com/a.PNG?q=1'), '.png')
  assert.equal(extFromUrl('https://x.com/img?id=3', 'image/jpeg'), '.jpg')
  assert.equal(extFromUrl('https://x.com/img?id=3', 'text/html'), null)
  const n = suggestName('https://x.com/some/long%20name.jpg', 'abcdef0123456789', '.jpg')
  assert.match(n, /^long_name_[0-9a-f]{12}\.jpg$/)
  assert.match(suggestName('https://x.com/', 'abcdef0123456789', '.png'), /^ref_[0-9a-f]{12}\.png$/)
})

test('collect：本地目录来源 → 归一落盘 + 精确去重 + 短边标记 + 来源留痕', async () => {
  const src = tmp('src')
  const dest = tmp('dest')
  fs.mkdirSync(path.join(src, 'batch'), { recursive: true })
  fs.writeFileSync(path.join(src, 'batch', 'ok1.png'), png(512, 768, 0x01))
  fs.writeFileSync(path.join(src, 'batch', 'ok2.png'), png(768, 512, 0x02))
  fs.writeFileSync(path.join(src, 'batch', 'same-as-ok1.png'), png(512, 768, 0x01), 'binary')
  fs.writeFileSync(path.join(src, 'batch', 'small.png'), png(256, 256, 0x03))

  const r = await collect({ sources: [src], destDir: dest, role: 'user-path' })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.images.length, 3, '重复图只留一份')
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].reason, 'duplicate')
  assert.equal(r.needsProcess.length, 1)
  // 跨目录来源会带哈希后缀落进归一目录（防止不同来源同名互相覆盖）
  assert.match(path.basename(r.needsProcess[0].path), /^small_[0-9a-f]{12}\.png$/)
  assert.ok(r.trailPath && fs.existsSync(r.trailPath))
  const trail = JSON.parse(fs.readFileSync(r.trailPath, 'utf8'))
  assert.equal(trail.sources[0].kind, 'local-dir')
  assert.equal(trail.sources[0].files, 4)

  // 跨目录来源会被拷进归一目录（同名不同内容不会互相覆盖：文件名带哈希前缀）
  for (const im of r.images) {
    assert.equal(path.dirname(im.path), dest)
    assert.match(im.sha256, /^[0-9a-f]{64}$/)
    assert.equal(im.width * im.height > 0, true)
  }
})

test('collect：URL 来源 → 正常收图；HTML 错误页冒充图片必须拒收', async () => {
  const dest = tmp('url')
  let served = 0
  await withServer((req, res) => {
    served++
    if (req.url === '/ok.png') {
      const b = png(640, 960, 0x05)
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(b.length) })
      res.end(b)
      return
    }
    if (req.url === '/fake.png') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>404 not found</html>')
      return
    }
    if (req.url === '/huge.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) })
      res.end(png())
      return
    }
    res.writeHead(404)
    res.end('nope')
  }, async (base) => {
    const r = await collect({ sources: [`${base}/ok.png`, `${base}/fake.png`, `${base}/huge.png`, `${base}/missing.png`], destDir: dest, role: 'url' })
    assert.equal(r.images.length, 1, '只有真图被收下')
    assert.equal(path.extname(r.images[0].path), '.png')
    assert.equal(r.images[0].originKind, 'url')
    assert.equal(r.errors.length, 3, '假图 / 超限 / 404 三条都要如实报错')
    assert.ok(r.errors.some((e) => e.includes('不像图片')))
    assert.ok(r.errors.some((e) => e.includes('过大')))
    assert.ok(r.errors.some((e) => e.includes('HTTP 404')))
    assert.equal(served, 4, '四条来源都真的去请求了（404 不算静默跳过）')
  })
})

test('collect：同图两次出现在 URL 列表里 → 第二次判重，不重复落盘', async () => {
  const dest = tmp('url-dup')
  const body = png(512, 512, 0x07)
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(body)
  }, async (base) => {
    const r = await collect({ sources: [`${base}/a.png`, `${base}/b.png`], destDir: dest, role: 'reference-image' })
    assert.equal(r.images.length, 1)
    assert.equal(r.skipped.length, 1)
    assert.equal(r.skipped[0].duplicateOf, `${base}/a.png`)
  })
})

test('collect：来源不存在 / 目录为空 都记账，不静默通过', async () => {
  const dest = tmp('missing')
  const empty = tmp('empty-dir')
  const r = await collect({ sources: [path.join(dest, 'nope'), empty], destDir: dest })
  assert.equal(r.ok, false)
  assert.equal(r.images.length, 0)
  assert.ok(r.errors.some((e) => e.includes('不存在或不可读')))
  assert.ok(r.errors.some((e) => e.includes('没有可用图片')))
  assert.equal(r.sources.length, 2)
})

test('checkCollection：数量不足 / 需裁剪 / 重复 都要给出可执行结论', () => {
  const base = { images: [], skipped: [], errors: [], needsProcess: [] }
  const few = checkCollection({ ...base, images: Array.from({ length: 8 }, (_, i) => ({ format: 'png', originKind: 'url' })) }, { minImages: 15 })
  assert.equal(few.ok, false)
  assert.ok(few.errors.some((e) => e.includes('少于下限')))

  const enough = checkCollection({
    ...base,
    images: Array.from({ length: 20 }, () => ({ format: 'png', originKind: 'local-file' })),
    needsProcess: [{}],
    skipped: [{}],
  })
  assert.equal(enough.ok, true)
  assert.equal(enough.stats.images, 20)
  assert.deepEqual(enough.stats.formats, { png: 20 })
  assert.ok(enough.warnings.some((w) => w.includes('短边不足')))
  assert.ok(enough.warnings.some((w) => w.includes('去重命中')))

  const withErr = checkCollection({ ...base, images: Array.from({ length: 20 }, () => ({ format: 'png' })), errors: ['来源 X 下载失败'] })
  assert.equal(withErr.ok, false, '来源错误必须传导到体检结论')
})