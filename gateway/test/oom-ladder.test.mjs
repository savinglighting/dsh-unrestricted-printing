/**
 * P2 进程管家 + OOM 阶梯强杀（mock exec/spawn，不真杀本机进程）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { EngineManager } from '../lib/engine-manager.js'

/** 记录 taskkill / spawn 调用，可注入失败 */
function fakeDeps({ killFails = false, spawnFails = false } = {}) {
  const exec = (file, args, opts, cb) => {
    exec.calls.push({ file, args, opts })
    if (killFails) {
      const e = Object.assign(new Error('not found'), { stderr: 'ERROR: 找不到进程' })
      cb(e, '', e.stderr)
    } else {
      cb(null, 'SUCCESS: 已终止 PID 1234 的进程。', '')
    }
  }
  exec.calls = []
  const spawnFn = (file, args, opts) => {
    spawnFn.calls.push({ file, args, opts })
    if (spawnFails) throw new Error('spawn ENOENT')
    const child = new EventEmitter()
    child.pid = 4321
    child.unref = () => { child.unrefed = true }
    return child
  }
  spawnFn.calls = []
  return { exec, spawnFn }
}

const logs = []
const log = (lv, ev, data) => logs.push({ lv, ev, data })

test('台账：register / list / health / unregister 记录 PID 与参数', () => {
  const mgr = new EngineManager({ log })
  mgr.register('webui', { pid: process.pid, args: ['--api'], cmdline: 'python launch.py --api', port: 7860, source: 'spawned' })
  const [rec] = mgr.list()
  assert.equal(rec.engine, 'webui')
  assert.equal(rec.pid, process.pid)
  assert.equal(rec.healthy, true, '当前进程必然存活')
  assert.equal(rec.port, 7860)
  assert.match(rec.cmdline, /launch\.py/)
  mgr.unregister('webui', 'test')
  assert.equal(mgr.get('webui'), null)
  assert.deepEqual(mgr.list(), [])
})

test('OOM 判定：CUDA out of memory / 显存不足 命中，普通错误不命中', () => {
  const mgr = new EngineManager({ log })
  assert.equal(mgr.isOomError('RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB'), true)
  assert.equal(mgr.isOomError('torch.cuda.OutOfMemoryError: CUDA out of memory'), true)
  assert.equal(mgr.isOomError('显存不足，无法加载模型'), true)
  assert.equal(mgr.isOomError('HTTP 500 模型未找到'), false)
  assert.equal(mgr.isOomError(''), false)
  assert.equal(mgr.isOomError(null), false)
})

test('强杀：taskkill /PID {pid} /F /T 参数正确（P2 硬要求）', async () => {
  const { exec } = fakeDeps()
  const mgr = new EngineManager({ log, exec })
  const r = await mgr.killTree(1234)
  assert.equal(r.ok, true)
  assert.equal(exec.calls.length, 1)
  assert.equal(exec.calls[0].file, 'taskkill')
  assert.deepEqual(exec.calls[0].args, ['/PID', '1234', '/F', '/T'])
  assert.equal(r.cmdline, 'taskkill /PID 1234 /F /T')
})

test('强杀失败不抛：记录原因后返回 ok:false', async () => {
  const { exec } = fakeDeps({ killFails: true })
  const mgr = new EngineManager({ log, exec })
  const r = await mgr.killTree(987)
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /not found/)
})

test('强杀：非法 PID 直接拒绝，不执行 taskkill', async () => {
  const { exec } = fakeDeps()
  const mgr = new EngineManager({ log, exec })
  for (const bad of [null, undefined, 0, -3, 'abc']) {
    const r = await mgr.killTree(bad)
    assert.equal(r.ok, false)
  }
  assert.equal(exec.calls.length, 0)
})

test('直接强杀只施加于自家登记的 PID；taskkill 报超时也必须算终止成功', async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 500))
  const aliveOf = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  try {
    // 未登记 → ownsPid 为 false（不会对"陌生 pid"做直接强杀）
    const mgrA = new EngineManager({ log, exec: fakeDeps().exec })
    assert.equal(mgrA.ownsPid(child.pid), false)
    assert.equal(mgrA.ownsPid(0), false)
    assert.equal(mgrA.ownsPid('abc'), false)

    // 登记后 → 走直接强杀；这里故意让 taskkill 失败（模拟本机"整棵树超时报错"）
    const { exec } = fakeDeps({ killFails: true })
    const mgrB = new EngineManager({ log, exec })
    mgrB.register('trainer', { pid: child.pid, source: 'training' })
    assert.equal(mgrB.ownsPid(child.pid), true)
    const r = await mgrB.killTree(child.pid)
    assert.equal(r.ok, true, '直接强杀成功时，taskkill 超时报错不得把结果判成失败（训练中止会卡死）')
    assert.equal(r.method, 'sigkill')
    assert.equal(r.direct.ok, true)

    let alive = aliveOf(child.pid)
    const deadline = Date.now() + 8000
    while (alive && Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 120))
      alive = aliveOf(child.pid)
    }
    assert.equal(alive, false, '登记过的进程必须被真的杀掉')
  } finally {
    try { if (aliveOf(child.pid)) child.kill('SIGKILL') } catch { /* 已死 */ }
  }
})

test('阶梯：--medvram → --medvram-sdxl → --lowvram，每级最多 1 次', async () => {
  const { exec, spawnFn } = fakeDeps()
  const mgr = new EngineManager({ log, exec, spawnFn })
  mgr.register('webui', { pid: 1000, port: 7860 })
  const buildCmd = () => ['powershell', '-File', 'sd-direct.ps1', '-StartOnly']

  const r1 = await mgr.handleOom({ engine: 'webui', error: 'CUDA out of memory. Tried to allocate 2.00 GiB', buildCmd })
  assert.equal(r1.restarted, true)
  assert.equal(r1.level, 0)
  assert.equal(r1.flag, '--medvram')
  assert.deepEqual(spawnFn.calls[0].args.slice(-1), ['--medvram'])
  assert.equal(mgr.get('webui').pid, 4321)
  assert.equal(mgr.get('webui').restartCount, 1)

  const r2 = await mgr.handleOom({ engine: 'webui', error: 'CUDA out of memory', buildCmd })
  assert.equal(r2.level, 1)
  assert.equal(r2.flag, '--medvram-sdxl')

  const r3 = await mgr.handleOom({ engine: 'webui', error: 'CUDA out of memory', buildCmd })
  assert.equal(r3.level, 2)
  assert.equal(r3.flag, '--lowvram')
  assert.equal(mgr.get('webui').restartCount, 3)

  const r4 = await mgr.handleOom({ engine: 'webui', error: 'CUDA out of memory', buildCmd })
  assert.equal(r4.restarted, false)
  assert.equal(r4.reason, 'ladder-exhausted', '三级用尽后必须返回失败而不是无限重启')
  assert.equal(spawnFn.calls.length, 3, '总共只能重启 3 次（每级 1 次）')
  assert.equal(mgr.get('webui'), null, '强杀后未重启成功不得留下假 PID 记录')
})

test('阶梯：非 OOM 错误不触发强杀/重启', async () => {
  const { exec, spawnFn } = fakeDeps()
  const mgr = new EngineManager({ log, exec, spawnFn })
  mgr.register('webui', { pid: 1000 })
  const r = await mgr.handleOom({ engine: 'webui', error: 'HTTP 500 模型不存在', buildCmd: () => ['x'] })
  assert.equal(r.restarted, false)
  assert.equal(r.reason, 'not-oom')
  assert.equal(exec.calls.length, 0)
  assert.equal(spawnFn.calls.length, 0)
})

test('阶梯：spawn 失败 → 返回失败并保留原因（不崩）', async () => {
  const { exec, spawnFn } = fakeDeps({ spawnFails: true })
  const mgr = new EngineManager({ log, exec, spawnFn })
  mgr.register('comfy', { pid: 2000, port: 8188 })
  const r = await mgr.handleOom({ engine: 'comfy', error: 'CUDA out of memory', buildCmd: () => ['python', 'main.py'] })
  assert.equal(r.restarted, false)
  assert.equal(r.reason, 'spawn-failed')
  assert.match(String(r.error), /ENOENT/)
  assert.equal(mgr.get('comfy'), null, '强杀后先摘牌，spawn 失败不应留下假 PID')
})

test('阶梯：没有启动命令时不硬猜（no-launch-command）', async () => {
  const mgr = new EngineManager({ log })
  mgr.register('webui', { pid: 1 })
  const r = await mgr.handleOom({ engine: 'webui', error: 'CUDA out of memory', buildCmd: null })
  assert.equal(r.restarted, false)
  assert.equal(r.reason, 'no-launch-command')
})

test('阶梯：buildCmd 返回 {cmd,cwd,includeFlag:false} 时由调用方摆旗标（webui -VramFlag）', async () => {
  const { spawnFn } = fakeDeps()
  const mgr = new EngineManager({ log, spawnFn })
  mgr.register('webui', { pid: 5, port: 7860 })
  const r = await mgr.handleOom({
    engine: 'webui',
    error: 'CUDA out of memory',
    buildCmd: ({ flag }) => ({ cmd: ['powershell', '-File', 'sd-direct.ps1', '-StartOnly', '-VramFlag', flag], includeFlag: false }),
  })
  assert.equal(r.restarted, true)
  const args = spawnFn.calls[0].args
  assert.deepEqual(args.slice(-2), ['-VramFlag', '--medvram'])
  assert.equal(args.filter((a) => a === '--medvram').length, 1, '旗标不能重复追加')
})

test('阶梯：resetLadder 后可再次使用（网关重试循环复用）', async () => {
  const { spawnFn } = fakeDeps()
  const mgr = new EngineManager({ log, spawnFn })
  mgr.register('webui', { pid: 7 })
  await mgr.handleOom({ engine: 'webui', error: 'CUDA out of memory', buildCmd: () => ['a'] })
  assert.equal(mgr.nextLevel('webui'), 1)
  mgr.resetLadder('webui')
  assert.equal(mgr.nextLevel('webui'), 0)
})

test('强杀安全闸：拒绝杀网关自身 / 父进程（避免误端整棵树）', async () => {
  const { exec } = fakeDeps()
  const mgr = new EngineManager({ log, exec })
  const selfKill = await mgr.killTree(process.pid)
  assert.equal(selfKill.ok, false)
  assert.equal(selfKill.reason, 'refused-self-or-parent')
  const parentKill = await mgr.killTree(process.ppid)
  assert.equal(parentKill.ok, false)
  assert.equal(parentKill.reason, 'refused-self-or-parent')
  assert.equal(exec.calls.length, 0, '被拒绝时不得真的执行 taskkill')
  assert.ok(logs.some((l) => l.ev === 'engine.kill_refused_self'))
})

test('端口反查 PID：netstat 输出解析（mock exec）', async () => {
  const exec = (file, args, opts, cb) => {
    cb(null, [
      '  协议  本地地址          外部地址        状态           PID',
      '  TCP    127.0.0.1:7860         0.0.0.0:0              LISTENING       16868',
      '  TCP    127.0.0.1:8799         0.0.0.0:0              LISTENING       2916',
    ].join('\r\n'), '')
  }
  const mgr = new EngineManager({ log, exec })
  assert.equal(await mgr.findPidByPort(7860), 16868)
  assert.equal(await mgr.findPidByPort(8799), 2916)
  assert.equal(await mgr.findPidByPort(9999), null)

  const rec = await mgr.adopt('webui', { port: 7860 })
  assert.equal(rec.pid, 16868)
  assert.equal(rec.source, 'adopted')
  assert.equal((await mgr.adopt('webui', { port: 7860 })).pid, 16868, '重复 adopt 不重建记录')
})

test('isAlive：不存在的 PID 判定为死', () => {
  const mgr = new EngineManager({ log })
  mgr.register('webui', { pid: 999999 })
  assert.equal(mgr.isAlive('webui'), false)
  mgr.register('webui', { pid: process.pid })
  assert.equal(mgr.isAlive('webui'), true)
})

test('snapshot：暴露梯子与各级使用情况（排障可见）', async () => {
  const { spawnFn } = fakeDeps()
  const mgr = new EngineManager({ log, spawnFn })
  mgr.register('webui', { pid: 8 })
  await mgr.handleOom({ engine: 'webui', error: 'CUDA out of memory', buildCmd: () => ['a'] })
  const snap = mgr.snapshot()
  assert.deepEqual(snap.ladders.webui, ['--medvram', '--medvram-sdxl', '--lowvram'])
  assert.deepEqual(snap.levelUse.webui, [0])
  assert.equal(snap.engines[0].pid, 4321)
  assert.equal(snap.engines[0].source, 'ladder-restart')
})