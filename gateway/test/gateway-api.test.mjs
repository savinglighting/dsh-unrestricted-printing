/**
 * P1/P4/P6 集成：路由分流、状态机、参数透传、队列单车道、训练互斥 409、错误可查询
 * 全程对着「假 WebUI / 假 ComfyUI」，不碰本机真实后端。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startTestGateway, post, get, waitFinal, makeTempDir, rmrf } from './helpers/harness.mjs'
import { makePng } from './helpers/mock-engines.mjs'

const PROMPT = '1girl, solo, portrait, masterpiece, best quality'

/** 进程存活探测（只探测，绝不抛） */
function isAlive(pid) {
  const p = Number(pid)
  if (!Number.isInteger(p) || p <= 0) return false
  try { process.kill(p, 0); return true } catch { return false }
}

test('路由分流：SD_FP16 → WebUI；QwenImage_NVFP4 → ComfyUI（互不串门）', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })

  const a = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 8 })
  assert.equal(a.status, 200)
  assert.equal(a.json.status, 'queued')
  assert.equal(a.json.engine, 'webui')
  assert.ok(a.json.task_id)
  const aDone = await waitFinal(gw.base, a.json.task_id)
  assert.equal(aDone.status, 'success')
  assert.ok(aDone.paths.length === 1 && fs.existsSync(aDone.paths[0]), '产物必须落盘')
  assert.equal(gw.webuiMock.generationCalls.length, 1)
  assert.equal(gw.comfyMock.promptCalls.length, 0, 'WebUI 模型不得打到 ComfyUI')

  const b = await post(gw.base, '/api/generate', { model: 'QwenImage_NVFP4', prompt: PROMPT, width: 1024, height: 1024, steps: 8 })
  assert.equal(b.status, 200)
  assert.equal(b.json.engine, 'comfy')
  const bDone = await waitFinal(gw.base, b.json.task_id, 40000)
  assert.equal(bDone.status, 'success')
  assert.equal(gw.comfyMock.promptCalls.length, 1, 'ComfyUI 模型必须走 /prompt')
  assert.equal(gw.webuiMock.generationCalls.length, 1, 'ComfyUI 模型不得打到 WebUI')
  assert.ok(fs.existsSync(bDone.paths[0]))

  // Anima_INT8 也走 WebUI
  const c = await post(gw.base, '/api/generate', { model: 'Anima_INT8', prompt: PROMPT, width: 512, height: 512, steps: 6 })
  const cDone = await waitFinal(gw.base, c.json.task_id)
  assert.equal(cDone.status, 'success')
  assert.equal(cDone.engine, 'webui')
  assert.equal(gw.webuiMock.generationCalls.length, 2)
})

test('状态机经 API 可见：queued → running/success，失败任务带 error_code', async (t) => {
  const gw = await startTestGateway({ webui: { delayMs: 300 } })
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })

  const r = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 8 })
  const id = r.json.task_id
  const s0 = await get(gw.base, `/api/status/${id}`)
  assert.ok(['queued', 'running', 'success'].includes(s0.json.status))
  const final = await waitFinal(gw.base, id)
  assert.equal(final.status, 'success')
  assert.ok(final.started_at && final.finished_at, '时间戳必须齐全')
  assert.equal(final.error, null)

  const missing = await get(gw.base, '/api/status/does-not-exist')
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error, 'NOT_FOUND')
})

test('入参校验：未知模型 / 空 prompt / 非 8 倍数 / Krea2 超 1024 全部 400 且给出原因', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })

  const unknown = await post(gw.base, '/api/generate', { model: 'qwen', prompt: PROMPT })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.json.error, 'UNKNOWN_MODEL')
  assert.match(unknown.json.message, /SD_FP16/)

  const empty = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: '   ' })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error, 'EMPTY_PROMPT')

  const unaligned = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 513, height: 768 })
  assert.equal(unaligned.status, 400)
  assert.equal(unaligned.json.error, 'SIZE_NOT_ALLOWED')

  const kreaBig = await post(gw.base, '/api/generate', { model: 'Krea2_Q4', prompt: PROMPT, width: 1216, height: 1024 })
  assert.equal(kreaBig.status, 400)
  assert.equal(kreaBig.json.error, 'SIZE_NOT_ALLOWED')
  assert.match(kreaBig.json.message, /1024/)
  assert.equal(kreaBig.json.max_side, 1024)
})

test('缺模型的 Krea2_Q4：提交后任务明确 failed（MODEL_UNAVAILABLE），网关不崩', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const r = await post(gw.base, '/api/generate', { model: 'Krea2_Q4', prompt: PROMPT, width: 1024, height: 1024 })
  assert.equal(r.status, 200)
  const done = await waitFinal(gw.base, r.json.task_id)
  assert.equal(done.status, 'failed')
  assert.equal(done.error_code, 'MODEL_UNAVAILABLE')
  assert.match(done.error, /krea2_turbo-Q4_K_M\.gguf/)   // 2026-10-19：Krea2 权重改为 GGUF

  const health = await get(gw.base, '/api/health')
  assert.equal(health.json.gateway, 'ok', '缺模型不该影响网关存活')

  const models = await get(gw.base, '/api/models')
  const krea = models.json.models.find((m) => m.key === 'Krea2_Q4')
  assert.deepEqual(krea.missing, ['unet/krea2_turbo-Q4_K_M.gguf', 'text_encoders/qwen3-vl-4b-heretic_int8.safetensors', 'vae/krea2-vae.safetensors'])   // 三件缺时一并列出
})

test('参数透传（WebUI 文生图）：尺寸/步数/CFG/采样器/负面词 + ADetailer 面部修复', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const r = await post(gw.base, '/api/generate', {
    model: 'SD_FP16', prompt: PROMPT, negative: 'lowres, bad anatomy',
    width: 512, height: 768, steps: 12, cfg: 6.5, sampler: 'Euler a', seed: 12345,
  })
  await waitFinal(gw.base, r.json.task_id)
  const call = gw.webuiMock.generationCalls[0]
  assert.match(call.url, /txt2img/)
  assert.equal(call.body.prompt, PROMPT)
  assert.equal(call.body.negative_prompt, 'lowres, bad anatomy')
  assert.equal(call.body.width, 512)
  assert.equal(call.body.height, 768)
  assert.equal(call.body.steps, 12)
  assert.equal(call.body.cfg_scale, 6.5)
  assert.equal(call.body.sampler_name, 'Euler a')
  assert.equal(call.body.seed, 12345)
  assert.equal(call.body.alwayson_scripts.ADetailer.args[0].ad_model, 'face_yolov8s.pt', '默认启用单单元面部修复')
})

test('进度接口（进度条数据源）：排队/采样/完成三态都有百分比、阶段与说明', async (t) => {
  const gw = await startTestGateway({ webui: { delayMs: 1500 } })
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })

  const r = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 8 })
  const id = r.json.task_id

  // 立刻查：字段齐全（前端靠这些画进度条）
  const p0 = await get(gw.base, `/api/progress/${id}`)
  assert.equal(p0.status, 200)
  assert.equal(p0.json.task_id, id)
  assert.ok(['queued', 'running', 'loading', 'sampling', 'success'].includes(p0.json.stage))
  assert.ok(p0.json.percent >= 0 && p0.json.percent <= 100)
  assert.equal(typeof p0.json.elapsed_ms, 'number')

  // 等它进入采样：WebUI 能拿到引擎真实进度（mock 固定 62% / ETA 8s）
  let sampled = null
  for (let i = 0; i < 40; i++) {
    await new Promise((res2) => setTimeout(res2, 100))
    const p = await get(gw.base, `/api/progress/${id}`)
    if (p.json.stage === 'sampling' && !p.json.estimated) { sampled = p.json; break }
  }
  assert.ok(sampled, '应在采样阶段拿到引擎真实进度（不是估算）')
  assert.equal(sampled.percent, 62)
  assert.equal(sampled.eta_sec, 8)
  assert.match(sampled.detail, /采样 15\/24 步/)

  await waitFinal(gw.base, id)
  const pEnd = await get(gw.base, `/api/progress/${id}`)
  assert.equal(pEnd.json.stage, 'success')
  assert.equal(pEnd.json.percent, 100)

  const notFound = await get(gw.base, '/api/progress/does-not-exist')
  assert.equal(notFound.status, 404)
})

test('参数透传（透传扩展）：extra 里的 hires/restore_faces 原样进 A1111，核心字段不可被覆盖', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const r = await post(gw.base, '/api/generate', {
    model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 10,
    extra: { enable_hr: true, hr_scale: 2, hr_upscaler: 'R-ESRGAN 4x+', restore_faces: true, prompt: 'hacked' },
  })
  await waitFinal(gw.base, r.json.task_id)
  const call = gw.webuiMock.generationCalls[0]
  assert.equal(call.body.enable_hr, true)
  assert.equal(call.body.hr_scale, 2)
  assert.equal(call.body.hr_upscaler, 'R-ESRGAN 4x+')
  assert.equal(call.body.restore_faces, true)
  assert.equal(call.body.prompt, PROMPT, 'extra 不得覆盖网关接管的核心字段')
})

test('参数透传（WebUI 图生图 + 蒙版）：init_images/mask/inpaint 参数齐全', async (t) => {
  const dir = makeTempDir('img')
  const initPath = path.join(dir, 'init.png')
  const maskPath = path.join(dir, 'mask.png')
  fs.writeFileSync(initPath, makePng(32, 32))
  fs.writeFileSync(maskPath, makePng(32, 32, [255, 255, 255]))
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot); rmrf(dir) })

  const r = await post(gw.base, '/api/generate', {
    model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 8,
    init_image: initPath, mask: maskPath, denoise: 0.5,
  })
  const done = await waitFinal(gw.base, r.json.task_id)
  assert.equal(done.status, 'success')
  const call = gw.webuiMock.generationCalls[0]
  assert.match(call.url, /img2img/)
  assert.equal(call.body.init_images.length, 1)
  assert.equal(Buffer.from(call.body.init_images[0], 'base64').length, fs.statSync(initPath).size)
  assert.ok(call.body.mask, '蒙版必须传过去')
  assert.equal(call.body.inpainting_fill, 0)
  assert.equal(call.body.mask_blur, 4)
  assert.equal(call.body.denoising_strength, 0.5)
  assert.equal(call.body.alwayson_scripts.ADetailer.args[0].ad_model, 'face_yolov8s.pt', '图生图也要带 ADetailer 面部修复（2026-10-19 修）')
})

test('参数透传（ComfyUI）：工作流节点齐全，图生图走 LoadImage/VAEEncode，蒙版走 VAEEncodeForInpaint', async (t) => {
  const dir = makeTempDir('comfyin')
  const initPath = path.join(dir, 'init.png')
  const maskPath = path.join(dir, 'mask.png')
  fs.writeFileSync(initPath, makePng(64, 64))
  fs.writeFileSync(maskPath, makePng(64, 64, [255, 255, 255]))
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot); rmrf(dir) })

  const t2i = await post(gw.base, '/api/generate', { model: 'QwenImage_NVFP4', prompt: PROMPT, width: 1024, height: 1024, steps: 8, cfg: 7 })
  await waitFinal(gw.base, t2i.json.task_id, 40000)
  const wf = gw.comfyMock.promptCalls[0].body.prompt
  assert.equal(wf['1'].class_type, 'UnetLoaderGGUF')
  assert.equal(wf['1'].inputs.unet_name, 'qwen-image-2.1-UC-Q4_K_M.gguf')
  assert.equal(wf['2'].inputs.type, 'sd3', 'Qwen 系 CLIP 必须按 sd3 加载')
  assert.equal(wf['3'].class_type, 'VAELoader')
  assert.equal(wf['6'].class_type, 'EmptyLatentImage')
  assert.equal(wf['6'].inputs.width, 1024)
  assert.equal(wf['9'].class_type, 'KSampler')
  assert.equal(wf['9'].inputs.cfg, 7)
  assert.equal(wf['11'].class_type, 'SaveImage')

  const i2i = await post(gw.base, '/api/generate', { model: 'QwenImage_NVFP4', prompt: PROMPT, width: 512, height: 512, steps: 8, init_image: initPath, mask: maskPath, denoise: 0.5 })
  await waitFinal(gw.base, i2i.json.task_id, 40000)
  const wf2 = gw.comfyMock.promptCalls[1].body.prompt
  assert.equal(wf2['6'].class_type, 'LoadImage')
  assert.equal(wf2['7'].class_type, 'LoadImageMask')
  assert.equal(wf2['8'].class_type, 'VAEEncodeForInpaint')
  assert.equal(wf2['9'].inputs.denoise, 0.5)
  assert.equal(wf2['9'].inputs.latent_image[0], '8')
})

test('队列：单车道串行（并发上限恒为 1），后到任务排队而不是被拒', async (t) => {
  const gw = await startTestGateway({ webui: { delayMs: 400 } })
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })

  const subs = []
  for (let i = 0; i < 3; i++) {
    subs.push(await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: `${PROMPT}, variant ${i}`, width: 512, height: 768, steps: 8 }))
  }
  assert.deepEqual(subs.map((s) => s.json.status), ['queued', 'queued', 'queued'])
  assert.deepEqual(subs.map((s) => s.json.queue_position), [1, 2, 3], '准备阶段即可看到排队位次')

  const finals = await Promise.all(subs.map((s) => waitFinal(gw.base, s.json.task_id, 30000)))
  assert.deepEqual(finals.map((f) => f.status), ['success', 'success', 'success'])
  assert.equal(gw.webuiMock.concurrency.max, 1, '单车道：引擎侧并发必须为 1')

  const q = await get(gw.base, '/api/queue')
  assert.equal(q.json.summary.queueLength, 0)
  assert.equal(q.json.summary.success, 3)
  assert.equal(q.json.summary.gate.locked, false, '跑完必须释放锁')
})

test('训练互斥（P4）：训练中提交生图 → 409，闸门锁归 training', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })

  const tr = await post(gw.base, '/api/training/start', {
    // 用 '--' 把训练参数与 node 自身选项分开（否则 node 会把 --network_module=... 当成非法选项直接退出 9）
    cmd: [process.execPath, '-e', 'setTimeout(() => {}, 60000)', '--'],
  })
  assert.equal(tr.status, 200)
  assert.equal(tr.json.status, 'training')
  // 硬底线（不可被用户参数覆盖）；P1 起 --network_dim 不再在底线里（双轨标准 ID=8 / Base=32）
  assert.deepEqual(tr.json.injected, ['--optimizer_type=AdamW8bit', '--mixed_precision=fp16', '--lowvram'])
  assert.equal(tr.json.profile, 'id', '缺省档位 = config.trainer.profileDefault')
  assert.match(tr.json.cmd_line, /--network_module=networks\.lora/)
  assert.match(tr.json.cmd_line, /--network_dim=8/)
  assert.match(tr.json.cmd_line, /--optimizer_type=AdamW8bit/)
  assert.match(tr.json.cmd_line, /--lowvram/)
  assert.ok(Array.isArray(tr.json.cmd), 'cmd 保留数组形态（可直接复现命令行）')
  assert.match(tr.json.temp_dir, /gateway-train-/)

  const blocked = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768 })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.json.error, 'TRAINING_IN_PROGRESS')

  const health = await get(gw.base, '/api/health')
  assert.equal(health.json.store.training, true)
  assert.equal(health.json.store.gate.owner, 'training')

  const tstatus = await get(gw.base, '/api/training/status')
  assert.equal(tstatus.json.training, true)
  assert.equal(tstatus.json.task.status, 'training', '训练任务在状态机里就是 training 态')

  const pid = tr.json.pid
  const end = await post(gw.base, '/api/training/end', {})
  assert.equal(end.status, 200)
  const after = await get(gw.base, '/api/health')
  assert.equal(after.json.store.training, false)
  assert.equal(after.json.store.gate.locked, false)
  // 进程终止要轮询等待：Windows 上 taskkill /T 遍历整棵树会耗时甚至先报超时，
  // 死等固定 600ms 会把"已经在死"误判成"没杀掉"（旧断言就是被这个坑掉的）。
  let alive = isAlive(pid)
  const deadline = Date.now() + 8000
  while (alive && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    alive = isAlive(pid)
  }
  assert.equal(alive, false, '训练进程必须被强杀（taskkill /F /T，或直接 SIGKILL 兜底）')

  const ok = await post(gw.base, '/api/generate', { model: 'SD_FP16', prompt: PROMPT, width: 512, height: 768, steps: 6 })
  assert.equal(ok.status, 200, '释放锁后生图恢复正常')
  const done = await waitFinal(gw.base, ok.json.task_id)
  assert.equal(done.status, 'success')

  const dlog = fs.readdirSync(path.join(gw.tmpRoot, 'train-tmp'))
  assert.deepEqual(dlog, [], '训练临时目录必须被清理（tempRoot 下不留残渣）')
})

test('训练异常退出：任务 failed + 锁释放 + 临时文件清理（不静默）', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const tr = await post(gw.base, '/api/training/start', { cmd: [process.execPath, '-e', 'process.exit(3)', '--'] })
  assert.equal(tr.status, 200)
  const taskId = tr.json.task_id
  await new Promise((r) => setTimeout(r, 800))
  const s = await get(gw.base, `/api/status/${taskId}`)
  assert.equal(s.json.status, 'failed')
  assert.equal(s.json.error_code, 'TRAIN_FAILED')
  assert.match(s.json.error, /exit=3/)
  const h = await get(gw.base, '/api/health')
  assert.equal(h.json.store.training, false, '异常退出也必须释放独占锁')
  assert.equal(h.json.store.gate.locked, false)
})

test('训练缺启动器：明确 501 + 可执行提示（不猜路径）', async (t) => {
  const gw = await startTestGateway({ trainScript: null })
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const tr = await post(gw.base, '/api/training/start', {})
  assert.equal(tr.status, 501)
  assert.equal(tr.json.error, 'TRAIN_LAUNCHER_UNAVAILABLE')
  assert.match(tr.json.message, /GW_TRAIN_SCRIPT/)
})

test('参数三层归一：底线不可覆盖 + 档位标准值注入 + 用户越界被钳制（不静默）', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const tr = await post(gw.base, '/api/training/start', {
    cmd: [process.execPath, '-e', 'setTimeout(() => {}, 3000)', '--'],
    profile: 'id',
    args: ['--network_dim=32', '--optimizer_type=SGD', '--max_train_steps=5', '--foo=bar'],
  })
  assert.equal(tr.status, 200)
  const cmd = tr.json.cmd_line
  assert.equal(tr.json.profile, 'id')
  assert.equal(cmd.split('--network_dim=').length - 1, 1, '--network_dim 只能有一份')
  assert.match(cmd, /--network_dim=12/, '超出 ID 轨护栏的秩被钳到上限 12（ID 必须刻意低秩）')
  assert.doesNotMatch(cmd, /--network_dim=32/)
  assert.match(cmd, /--max_train_steps=300/, '低于 ID 轨下限的步数被钳到 300')
  assert.doesNotMatch(cmd, /--max_train_steps=5/)
  assert.match(cmd, /--optimizer_type=AdamW8bit/)
  assert.doesNotMatch(cmd, /--optimizer_type=SGD/, '底线项不可被覆盖（保留 P4 语义）')
  assert.match(cmd, /--foo=bar/, '无关参数要透传')
  assert.ok(tr.json.adjusted.some((a) => a.key === '--network_dim' && a.to === 12), '钳制项必须记账回传')
  assert.ok(tr.json.ignored.some((i) => i.key === '--optimizer_type'), '被丢弃的项必须记账回传')
  await post(gw.base, '/api/training/end', {})
})

test('Base 轨：LoCon 覆盖卷积 + dim=32；未知档位明确 400（不猜、不静默退化）', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })

  const b = await post(gw.base, '/api/training/start', {
    cmd: [process.execPath, '-e', 'setTimeout(() => {}, 3000)', '--'],
    profile: 'base',
  })
  assert.equal(b.status, 200)
  assert.equal(b.json.profile, 'base')
  assert.match(b.json.cmd_line, /--network_module=lycoris\.kohya/)
  assert.match(b.json.cmd_line, /--network_dim=32/)
  assert.match(b.json.cmd_line, /--network_alpha=16/)
  assert.match(b.json.cmd_line, /--max_train_steps=800/)
  assert.match(b.json.cmd_line, /--network_args/)
  assert.match(b.json.cmd_line, /algo=lora/)
  assert.match(b.json.cmd_line, /conv_dim=4/)
  assert.match(b.json.cmd_line, /conv_alpha=2/)
  await post(gw.base, '/api/training/end', {})

  const bad = await post(gw.base, '/api/training/start', { profile: 'xl-anything' })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error, 'TRAIN_PROFILE_UNKNOWN')
})

test('档位与目录自检接口：双轨标准 / 推理策略 / LoRA 投递目录可查', async (t) => {
  const gw = await startTestGateway()
  t.after(async () => { await gw.closeAll(); rmrf(gw.tmpRoot) })
  const r = await get(gw.base, '/api/training/profiles')
  assert.equal(r.status, 200)
  const names = r.json.profiles.map((p) => p.name)
  assert.deepEqual(names, ['id', 'base'])
  const id = r.json.profiles.find((p) => p.name === 'id')
  const base = r.json.profiles.find((p) => p.name === 'base')
  assert.equal(id.network_dim, 8)
  assert.equal(base.network_dim, 32)
  assert.equal(base.network_module, 'lycoris.kohya')
  assert.equal(id.infer_weight.fixed, 1.0, 'ID 权重固定 1.0')
  assert.equal(base.infer_weight.max, 0.7, 'Base 权重硬上限 0.7')
  assert.ok(r.json.infer_playbook.some((s) => s.base === 0), '解耦自检档（Base 归零）必须在策略表里')
  assert.ok(r.json.lora_dir, '必须能解析出 LoRA 投递目录')
  assert.ok(r.json.dataset_root)
})
