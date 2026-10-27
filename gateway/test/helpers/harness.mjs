/**
 * gateway/test/helpers/harness.mjs — 测试用网关夹具
 * 起一个真实 http 网关（随机端口）+ 假引擎 + 临时目录，全程不碰本机真实 SD/ComfyUI。
 */

'use strict'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../../server.js'
import { startMockWebui, startMockComfy } from './mock-engines.mjs'

let seq = 0

export function makeTempDir(tag = 'gw') {
  const dir = path.join(os.tmpdir(), 'dsh-gateway-test', `${tag}-${process.pid}-${++seq}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 造一个假的 ComfyUI 模型目录（含 Qwen 三件套，故意不含 Krea2） */
export function makeFakeComfyDir(root) {
  const files = [
    ['unet', 'qwen-image-2.1-UC-Q4_K_M.gguf'],
    ['text_encoders', 'qwen3vl_8b_int8_convrot.safetensors'],
    ['vae', 'qwen_image_2.1_vae_bf16.safetensors'],
  ]
  for (const [folder, name] of files) {
    const d = path.join(root, 'models', folder)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, name), Buffer.from('mock'))
  }
  return root
}

/**
 * 起一套测试网关。
 * @param {object} o { webui:{...}, comfy:{...}, trainingCmd, ros2, monitor, timeouts, breaker }
 */
export async function startTestGateway(o = {}) {
  const tmpRoot = makeTempDir('gwtest')
  const outDir = path.join(tmpRoot, 'SD-Picture')
  fs.mkdirSync(outDir, { recursive: true })
  const comfyDir = makeFakeComfyDir(path.join(tmpRoot, 'comfy'))
  const webuiMock = o.webui === false ? null : await startMockWebui(o.webui || {})
  const comfyMock = o.comfy === false ? null : await startMockComfy(o.comfy || {})

  // OOM 阶梯会真的 spawn 启动命令：测试里绝不能让它去拉起本机真实 SD，
  // 所以默认换成一个「立刻退出的假启动器」（想验证真实命令时用 o.webuiLauncherScript 覆盖）。
  let launcherScript = o.webuiLauncherScript
  if (!launcherScript) {
    launcherScript = path.join(tmpRoot, 'fake-sd-launcher.cmd')
    fs.writeFileSync(launcherScript, '@echo off\r\nrem 测试用假启动器：什么都不做，立刻退出\r\nexit /b 0\r\n')
  }

  /** 造一个假的底模文件（训练计划要求 --pretrained_model_name_or_path 必须存在） */
  const fakeBaseModel = o.baseModelPath || path.join(tmpRoot, 'Stable-diffusion', 'AWPainting_v1.2.safetensors')
  try {
    fs.mkdirSync(path.dirname(fakeBaseModel), { recursive: true })
    if (!fs.existsSync(fakeBaseModel)) fs.writeFileSync(fakeBaseModel, Buffer.from('fake-base-model'))
  } catch { /* 测试夹具写不进去也要继续（让断言去报错） */ }

  const gw = createGateway({
    host: '127.0.0.1',
    port: 0,
    outDir,
    logDir: path.join(tmpRoot, 'logs'),
    logLevel: o.logLevel || 'error',
    stateFile: path.join(tmpRoot, 'state.json'),
    webui: {
      url: webuiMock ? webuiMock.url : 'http://127.0.0.1:1',
      port: webuiMock ? webuiMock.port : 1,
      launcher: { script: launcherScript, shell: o.webuiLauncherShell || 'cmd' },
    },
    comfy: { url: comfyMock ? comfyMock.url : 'http://127.0.0.1:1', port: comfyMock ? comfyMock.port : 1, dir: comfyDir },
    ros2: { enabled: o.ros2Enabled !== false, url: o.ros2Url || 'ws://127.0.0.1:1', topic: '/hardware_monitor' },
    monitor: {
      vramMinFreeGb: o.vramMinFreeGb ?? 0,
      vramWarnFreeGb: o.vramWarnFreeGb ?? 0,
      staleMs: o.monitorStaleMs ?? 30000,
    },
    breaker: { threshold: o.breakerThreshold ?? 3, cooldownMs: o.breakerCooldownMs ?? 500 },
    timeouts: {
      shortMs: o.shortMs ?? 2000,
      generateMs: o.generateMs ?? 20000,
      pollMs: o.pollMs ?? 1000,
      engineReadyMs: o.engineReadyMs ?? 3000,
    },
    trainer: {
      tempRoot: o.trainTempRoot || path.join(tmpRoot, 'train-tmp'),
      script: o.trainScript !== undefined ? o.trainScript : null,
      python: process.execPath,
      /**
       * 硬底线（不可被用户参数覆盖）。注意这里**不含 --network_dim**：
       * 双轨标准要求 ID=8 / Base=32，底线里写死 dim 会把两条轨道压平（P1 改造）。
       */
      baselineArgs: o.trainBaselineArgs || o.trainForcedArgs || ['--optimizer_type=AdamW8bit', '--mixed_precision=fp16', '--lowvram'],
      forcedArgs: o.trainForcedArgs || null,
      profileDefault: o.trainProfileDefault || 'id',
      trainRoot: o.trainRoot || path.join(tmpRoot, 'lora-train'),
      datasetRoot: o.datasetRoot || path.join(tmpRoot, 'lora-train', 'datasets'),
      /** 训练底模：计划阶段会校验它存在 */
      baseModelPath: fakeBaseModel,
      /** 训练日志与登记表必须落在临时目录里，别污染工作区的 .lora-train */
      logDir: o.trainLogDir || path.join(tmpRoot, 'lora-train', 'logs'),
      registryFile: o.registryFile || path.join(tmpRoot, 'lora-train', 'lora-registry.json'),
      loraDir: o.loraDir || path.join(tmpRoot, 'models', 'Lora'),
    },
    // 端口 0 → 让系统分配，等 listen 后回填
    ...(o.configOverrides || {}),
  })

  // 端口 0 时 cfg.port=0，server.listen(0) 会自动分配
  await gw.start()
  const addr = gw.server.address()
  gw.base = `http://127.0.0.1:${addr.port}`
  gw.outDir = outDir
  gw.tmpRoot = tmpRoot
  gw.webuiMock = webuiMock
  gw.comfyMock = comfyMock
  gw.closeAll = async () => {
    try { await gw.stop() } catch { /* 已停 */ }
    if (webuiMock) await webuiMock.close()
    if (comfyMock) await comfyMock.close()
  }
  return gw
}

export async function post(base, pathName, body, { raw = false } = {}) {
  const r = await fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const text = await r.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
  return raw ? { status: r.status, text, json } : { status: r.status, json }
}

export async function get(base, pathName) {
  const r = await fetch(`${base}${pathName}`)
  const text = await r.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
  return { status: r.status, json }
}

/** 轮询任务状态直到终态 */
export async function waitFinal(base, taskId, timeoutMs = 30000, intervalMs = 200) {
  const t0 = Date.now()
  for (;;) {
    const { json } = await get(base, `/api/status/${taskId}`)
    if (json && (json.status === 'success' || json.status === 'failed')) return json
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待任务终态超时（最后状态 ${json && json.status}）`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

export { fs, path, os }