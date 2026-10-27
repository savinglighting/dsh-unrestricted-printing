/**
 * 集成：OOM 阶梯强杀重启（P2）+ 超时熔断（P6）+ 训练恢复（P4）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startTestGateway, post, get, waitFinal, rmrf } from './helpers/harness.mjs'
import { createGateway } from '../server.js'

const PROMPT = '1girl, solo, portrait, masterpiece, best quality'

test('OOM 阶梯：三级用尽 → 任务 failed(OOM_LADDER_EXHAUSTED)，逐级记录可查', async (t) => {
  const gw = await startTestGateway({ webui: { behavior: 'oom' }, logLevel: 'error' })
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })

  const spawns = []
  const origSpawn = gw.mgr.spawnFn
  gw.mgr.spawnFn = (file, args, opts) => { spawns.push({ file, args, opts }); return origSpawn.call(gw.mgr, file, args, opts) }

  const r = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 8 })
  const done = await waitFinal(gw.base, r.json.task_id, 60000)

  assert.equal(done.status, 'failed')
  assert.equal(done.error_code, 'OOM_LADDER_EXHAUSTED')
  const restarts = done.oom_ladder.filter((l) => l.restarted)
  assert.equal(restarts.length, 3, `应逐级重启 3 次，实际 ${JSON.stringify(done.oom_ladder)}`)
  assert.deepEqual(restarts.map((l) => l.flag), ['--medvram', '--medvram-sdxl', '--lowvram'])
  assert.deepEqual(restarts.map((l) => l.level), [0, 1, 2])
  assert.equal(done.oom_ladder[done.oom_ladder.length - 1].reason, 'ladder-exhausted', '最后一次必须明确记录阶梯用尽')
  assert.match(done.error, /阶梯/)

  // 每次重启都是「先强杀进程树，再按阶梯旗标启动」
  assert.equal(spawns.length, 3, '每级最多重启一次（共 3 次，不得无限循环）')
  assert.deepEqual(spawns.map((s) => s.args.slice(-2)), [
    ['-VramFlag', '--medvram'],
    ['-VramFlag', '--medvram-sdxl'],
    ['-VramFlag', '--lowvram'],
  ])
  const engineSnap = await get(gw.base, '/api/engines')
  assert.deepEqual(engineSnap.json.levelUse.webui, [0, 1, 2], '阶梯使用情况在台账里可查')

  // 网关仍然活着，且能继续接单
  const health = await get(gw.base, '/api/health')
  assert.equal(health.json.gateway, 'ok')
  const q = await get(gw.base, '/api/queue')
  assert.equal(q.json.summary.gate.locked, false, 'OOM 失败后锁必须释放')
})

test('设备错位自愈（坑62）：HalfTensor 报错 → 网关 reload-checkpoint 后重试成功', async (t) => {
  const gw = await startTestGateway({ webui: { behavior: 'device-mismatch' } })
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const r = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 8 })
  const done = await waitFinal(gw.base, r.json.task_id, 60000)
  assert.equal(done.status, 'success', `设备错位应被自愈救回，实际 ${done.status} / ${done.error}`)
  assert.equal(done.attempts, 2, '第一次失败 + 自愈后重试一次')
  assert.equal(done.oom_ladder.length, 0, '设备错位不该走 OOM 阶梯（不重启整台引擎）')
  assert.ok(gw.webuiMock.calls.some((c) => c.url.includes('reload-checkpoint')), '必须调用 reload-checkpoint 自愈')
})

test('OOM 只吞真 OOM：普通 500 不触发强杀重启', async (t) => {
  const gw = await startTestGateway({ webui: { behavior: '500' } })
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const spawns = []
  const origSpawn = gw.mgr.spawnFn
  gw.mgr.spawnFn = (f, a, o) => { spawns.push(a); return origSpawn.call(gw.mgr, f, a, o) }
  const r = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 8 })
  const done = await waitFinal(gw.base, r.json.task_id)
  assert.equal(done.status, 'failed')
  assert.equal(done.error_code, 'GENERATE_FAILED')
  assert.match(done.error, /HTTP 500/)
  assert.deepEqual(done.oom_ladder, [])
  assert.equal(spawns.length, 0, '非 OOM 错误不得重启引擎')
})

test('超时熔断：连续超时后 OPEN，后续任务直接被熔断拦截且不打后端', async (t) => {
  const gw = await startTestGateway({ webui: { behavior: 'hang' }, generateMs: 700, breakerThreshold: 3, breakerCooldownMs: 60000 })
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })

  const results = []
  for (let i = 0; i < 3; i++) {
    const r = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: `${PROMPT} #${i}`, width: 512, height: 768, steps: 4 })
    results.push(await waitFinal(gw.base, r.json.task_id, 20000))
  }
  assert.deepEqual(results.map((x) => x.status), ['failed', 'failed', 'failed'])
  assert.ok(results.every((x) => x.error_code === 'GENERATE_FAILED'))
  assert.match(results[0].error, /请求超时/)

  const br = await get(gw.base, '/api/breaker')
  const webui = br.json.breakers.find((b) => b.key === 'webui')
  assert.equal(webui.state, 'open', `熔断器应 OPEN，实际 ${JSON.stringify(br.json.breakers)}`)
  assert.equal(webui.trips, 1)

  const callsBefore = gw.webuiMock.generationCalls.length
  const r4 = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 4 })
  const done4 = await waitFinal(gw.base, r4.json.task_id, 20000)
  assert.equal(done4.status, 'failed')
  assert.match(done4.error, /circuit open/)
  assert.equal(gw.webuiMock.generationCalls.length, callsBefore, '熔断期间不得再打后端')

  const reset = await post(gw.base, '/api/breaker/reset', { engine: 'webui' })
  assert.equal(reset.status, 200)
  assert.equal(reset.json.breaker.state, 'closed', 'reset 后该引擎回到 closed')
})

test('超时熔断：冷却结束 + 后端恢复 → 任务成功并自动闭合', async (t) => {
  const gw = await startTestGateway({ webui: { behavior: 'hang' }, generateMs: 500, breakerThreshold: 2, breakerCooldownMs: 300 })
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  for (let i = 0; i < 2; i++) {
    const r = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 4 })
    await waitFinal(gw.base, r.json.task_id, 20000)
  }
  assert.equal((await get(gw.base, '/api/breaker')).json.breakers.find((b) => b.key === 'webui').state, 'open')
  gw.webuiMock.setBehavior('ok')
  await new Promise((r) => setTimeout(r, 600))
  const r3 = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 4 })
  const done = await waitFinal(gw.base, r3.json.task_id, 20000)
  assert.equal(done.status, 'success')
  assert.equal((await get(gw.base, '/api/breaker')).json.breakers.find((b) => b.key === 'webui').state, 'closed')
})

test('网关重启恢复（P4）：读到残留训练锁 → 强制释放 + 清理遗留临时目录', async (t) => {
  const gw = await startTestGateway()
  const trainTmp = path.join(gw.tmpRoot, 'train-tmp')
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })

  const tr = await post(gw.base, '/api/training/start', { cmd: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'] })
  const pid = tr.json.pid
  const stateFile = path.join(gw.tmpRoot, 'state.json')
  assert.equal(fs.existsSync(stateFile), true, '训练中必须有状态落盘（崩溃恢复依据）')
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(st.training, true)

  // 模拟「网关被强杀」：不调用 stop()，直接在进程内新建一个网关实例读同一份 state.json
  const gw2 = createGateway({
    host: '127.0.0.1', port: 0,
    outDir: gw.outDir, logDir: path.join(gw.tmpRoot, 'logs2'), logLevel: 'error',
    stateFile,
    webui: { url: 'http://127.0.0.1:1', port: 1 },
    comfy: { url: 'http://127.0.0.1:1', port: 1, dir: gw.cfg.comfy.dir },
    ros2: { enabled: false },
    monitor: { vramMinFreeGb: 0, vramWarnFreeGb: 0 },
    trainer: { tempRoot: trainTmp, script: null, python: process.execPath },
  })
  const orphan = path.join(trainTmp, 'gateway-train-orphan')
  fs.mkdirSync(orphan, { recursive: true })
  fs.writeFileSync(path.join(orphan, 'junk.txt'), 'leftover')
  await gw2.start()
  t.after(async () => { try { await gw2.stop() } catch { /* 已停 */ } })

  const h = await get(gw2.base, '/api/health')
  assert.equal(h.json.store.training, false, '重启后不得残留训练独占锁')
  assert.equal(h.json.store.gate.locked, false)
  assert.equal(fs.existsSync(orphan), false, '重启必须清理遗留训练临时目录')

  const r = await post(gw2.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 6 })
  assert.equal(r.status, 200, '恢复后生图立即可用')

  // 收尾：把第一个网关里还挂着的训练进程干掉
  try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
})