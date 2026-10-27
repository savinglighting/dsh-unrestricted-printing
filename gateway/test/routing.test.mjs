/**
 * P1 路由分流 + 模型枚举 + 尺寸规则（纯单测，不碰网络）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_KEYS, MODELS, normalizeModel, routeFor, checkSize, sizeAllowed, probeModelSync, modelsForEngine } from '../lib/models.js'
import { comfySamplerName } from '../server.js'

test('采样器分流：A1111 的名字不能透传给 ComfyUI（用户实测"两次没出图"的根因）', () => {
  // A1111 默认值 → ComfyUI 合法名
  assert.equal(comfySamplerName('DPM++ 2M', 'euler'), 'dpmpp_2m')
  assert.equal(comfySamplerName('DPM++ 2M Karras', 'euler'), 'dpmpp_2m')
  assert.equal(comfySamplerName('Euler a', 'euler'), 'euler_ancestral')
  assert.equal(comfySamplerName('UniPC', 'euler'), 'uni_pc')
  // 已经是 ComfyUI 合法名 → 原样保留
  assert.equal(comfySamplerName('euler', 'dpmpp_2m'), 'euler')
  assert.equal(comfySamplerName('dpmpp_2m_sde', 'euler'), 'dpmpp_2m_sde')
  // 空值 / 认不出的名字 → 回落模型推荐值（绝不把非法名发给 ComfyUI）
  assert.equal(comfySamplerName('', 'euler'), 'euler')
  assert.equal(comfySamplerName(undefined, 'euler'), 'euler')
  assert.equal(comfySamplerName('DPM++ 3M SDE Karras Ultra', 'euler'), 'euler')
  assert.equal(comfySamplerName('Weird Sampler', 'dpmpp_2m'), 'dpmpp_2m')
})

test('模型枚举严格为 4 个：SD_FP16 / Anima_INT8 / QwenImage_NVFP4 / Krea2_Q4', () => {
  assert.deepEqual(MODEL_KEYS, ['SD_FP16', 'Anima_INT8', 'QwenImage_NVFP4', 'Krea2_Q4'])
  assert.deepEqual(Object.keys(MODELS), MODEL_KEYS)
})

test('路由：SD_FP16 / Anima_INT8 → WebUI；QwenImage_NVFP4 / Krea2_Q4 → ComfyUI', () => {
  assert.equal(routeFor('SD_FP16'), 'webui')
  assert.equal(routeFor('Anima_INT8'), 'webui')
  assert.equal(routeFor('QwenImage_NVFP4'), 'comfy')
  assert.equal(routeFor('Krea2_Q4'), 'comfy')
  assert.equal(routeFor('sd_fp16'), null, '大小写敏感（枚举必须精确匹配）')
  assert.equal(routeFor('sd'), null, '旧 backend key 不再属于模型枚举')
  assert.deepEqual(modelsForEngine('webui'), ['SD_FP16', 'Anima_INT8'])
  assert.deepEqual(modelsForEngine('comfy'), ['QwenImage_NVFP4', 'Krea2_Q4'])
})

test('normalizeModel：非法输入一律 null（不抛）', () => {
  for (const bad of [null, undefined, '', '  ', 'SD-FP16', 'qwen', 42, {}, []]) {
    assert.equal(normalizeModel(bad), null, `非法模型应被拒: ${JSON.stringify(bad)}`)
  }
  assert.equal(normalizeModel(' Krea2_Q4 '), 'Krea2_Q4', '允许首尾空白')
})

test('尺寸：Krea2_Q4 宽或高 > 1024 直接拒绝（P5 表单 + 网关双保险）', () => {
  assert.equal(checkSize('Krea2_Q4', 1024, 1024).ok, true)
  const wide = checkSize('Krea2_Q4', 1216, 1024)
  assert.equal(wide.ok, false)
  assert.match(wide.reason, /1024/)
  const tall = checkSize('Krea2_Q4', 1024, 1216)
  assert.equal(tall.ok, false)
  assert.equal(sizeAllowed('Krea2_Q4', 1024, 1536), false)
  assert.equal(sizeAllowed('Krea2_Q4', 512, 768), true)
})

test('尺寸：必须是 8 的倍数、正整数；其他模型长边 ≤ 1536', () => {
  assert.equal(checkSize('SD_FP16', 513, 768).ok, false)
  assert.match(checkSize('SD_FP16', 513, 768).reason, /8 的倍数/)
  assert.equal(checkSize('SD_FP16', 0, 768).ok, false)
  assert.equal(checkSize('SD_FP16', 1216, 1536).ok, true)
  assert.equal(checkSize('SD_FP16', 2048, 1536).ok, false)
  assert.equal(checkSize('QwenImage_NVFP4', 1024, 1536).ok, true)
  assert.equal(checkSize('NoSuchModel', 512, 512).ok, false)
})

test('可用性探测：WebUI 离线 → offline；无 checkpoint → no-model；就绪 → ok', () => {
  const off = probeModelSync('SD_FP16', { webuiOnline: false })
  assert.equal(off.status, 'offline')
  const noCkpt = probeModelSync('SD_FP16', { webuiOnline: true, webuiCheckpoint: null })
  assert.equal(noCkpt.status, 'no-model')
  const ok = probeModelSync('SD_FP16', { webuiOnline: true, webuiCheckpoint: 'x.safetensors' })
  assert.equal(ok.status, 'ok')
  assert.match(ok.detail, /x\.safetensors/)
})

test('可用性探测：ComfyUI 缺模型 → no-model 且列出缺失文件（不崩）', () => {
  const r = probeModelSync('Krea2_Q4', {
    comfyOnline: true,
    comfyDir: null,
    comfyFiles: { unet: new Set(), text_encoders: new Set(['qwen3-vl-4b-heretic_int8.safetensors']), vae: new Set(['qwen_image_2.1_vae_bf16.safetensors']) },
  })
  assert.equal(r.status, 'no-model')
  assert.deepEqual(r.missing, ['unet/krea2_turbo-Q4_K_M.gguf', 'vae/krea2-vae.safetensors'])   // 夹具里 text_encoders 已给，故只缺 unet+vae
  const offline = probeModelSync('QwenImage_NVFP4', { comfyOnline: false, comfyFiles: null })
  assert.equal(offline.status, 'offline')
})

test('可用性探测：Qwen GGUF 三件套齐全 → ok（altUnet 兜底也算命中）', () => {
  const files = {
    unet: new Set(['qwen-image-2.1-uc-q4_k_m.gguf']),
    text_encoders: new Set(['qwen3vl_8b_int8_convrot.safetensors']),
    vae: new Set(['qwen_image_2.1_vae_bf16.safetensors']),
  }
  assert.equal(probeModelSync('QwenImage_NVFP4', { comfyOnline: true, comfyFiles: files }).status, 'ok')
  const altOnly = {
    unet: new Set(['qwen-image-2.1-nvfp4.safetensors']),
    text_encoders: files.text_encoders,
    vae: files.vae,
  }
  assert.equal(probeModelSync('QwenImage_NVFP4', { comfyOnline: true, comfyFiles: altOnly }).status, 'ok', 'NVFP4 权重在时也认')
})
