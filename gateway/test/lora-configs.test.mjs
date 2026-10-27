/**
 * gateway/test/lora-configs.test.mjs — 交付包参数标准与代码同源（P6 防漂移）
 *
 * LoRA/configs/*.json 是**给人看、给外部工具用**的标准文件；training-profiles.js 是**代码里的真源**。
 * 两份一旦不一致，就会出现「文档写 dim=8、实际跑 dim=12」这种最难查的问题。
 * 所以这里逐字段钉住：改标准必须两边一起改，否则测试红。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROFILES, PROFILE_NAMES, COMMON_STANDARD, INFER_PLAYBOOK } from '../lib/training-profiles.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LORA_DIR = path.resolve(__dirname, '..', '..', 'LoRA')

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(LORA_DIR, rel), 'utf8'))
}

test('交付包结构完整：说明 / 参数标准 / 模板 / 验收 / 打包脚本都在', () => {
  for (const rel of [
    'README.md',
    'configs/id-lora.json',
    'configs/base-lora.json',
    'configs/pipeline.json',
    'templates/dataset-README.md',
    'templates/caption-example.txt',
    'acceptance/acceptance-checklist.md',
    'scripts/sd-lora-pack.ps1',
  ]) {
    assert.equal(fs.existsSync(path.join(LORA_DIR, rel)), true, `交付包缺文件: ${rel}`)
  }
})

test('ID/Base 参数标准与代码同源（module / dim / alpha / lr / steps / 精度）', () => {
  const id = readJson('configs/id-lora.json')
  const base = readJson('configs/base-lora.json')

  for (const [cfg, key] of [[id, 'id'], [base, 'base']]) {
    const p = PROFILES[key]
    const rel = `configs/${key}-lora.json`
    assert.equal(cfg.profile, p.name, `${rel}.profile`)
    assert.equal(cfg.network_module, p.networkModule, `${rel}.network_module`)
    assert.deepEqual(cfg.network_args, p.networkArgs, `${rel}.network_args`)
    assert.equal(cfg.network_dim, p.networkDim, `${rel}.network_dim`)
    assert.equal(cfg.network_alpha, p.networkAlpha, `${rel}.network_alpha`)
    assert.equal(cfg.learning_rate, p.learningRate, `${rel}.learning_rate`)
    assert.equal(cfg.max_train_steps, p.maxTrainSteps, `${rel}.max_train_steps`)
    assert.equal(cfg.resolution, p.resolution, `${rel}.resolution`)
    assert.equal(cfg.clip_skip, p.clipSkip, `${rel}.clip_skip`)
    assert.equal(cfg.optimizer, COMMON_STANDARD.optimizer, `${rel}.optimizer`)
    assert.equal(cfg.optimizer_fallback, COMMON_STANDARD.optimizerFallback, `${rel}.optimizer_fallback`)
    assert.equal(cfg.mixed_precision, COMMON_STANDARD.mixedPrecision, `${rel}.mixed_precision`)
    assert.equal(cfg.enable_bucket, COMMON_STANDARD.enableBucket, `${rel}.enable_bucket`)
    assert.equal(cfg.save_model_as, COMMON_STANDARD.saveModelAs, `${rel}.save_model_as`)
  }

  assert.deepEqual(PROFILE_NAMES, ['id', 'base'])
})

test('护栏区间与代码一致（越界钳制的边界不能两头各说一套）', () => {
  const pairs = [
    ['configs/id-lora.json', 'id'],
    ['configs/base-lora.json', 'base'],
  ]
  const map = {
    min_dim: 'minDim', max_dim: 'maxDim',
    min_alpha: 'minAlpha', max_alpha: 'maxAlpha',
    min_lr: 'minLr', max_lr: 'maxLr',
    min_steps: 'minSteps', max_steps: 'maxSteps',
    min_resolution: 'minResolution', max_resolution: 'maxResolution',
  }
  for (const [rel, key] of pairs) {
    const cfg = readJson(rel)
    const g = PROFILES[key].guard
    for (const [jsonKey, codeKey] of Object.entries(map)) {
      assert.equal(cfg.guard[jsonKey], g[codeKey], `${rel}.guard.${jsonKey} 与代码 ${codeKey} 不一致`)
    }
  }
})

test('数据规范与推理权重策略一致（特写占比 / 体积预期 / Base 硬上限 0.7）', () => {
  const id = readJson('configs/id-lora.json')
  const base = readJson('configs/base-lora.json')

  assert.equal(id.dataset.face_closeup_ratio.min, PROFILES.id.faceCloseupRatio.min)
  assert.equal(base.dataset.face_closeup_ratio.max, PROFILES.base.faceCloseupRatio.max)
  assert.equal(id.dataset.images.min, COMMON_STANDARD.datasetImages.min)
  assert.equal(id.dataset.images.max, COMMON_STANDARD.datasetImages.max)
  assert.equal(id.dataset.reg_images.min, COMMON_STANDARD.regImages.min)
  assert.equal(id.dataset.reg_images.max, COMMON_STANDARD.regImages.max)

  assert.deepEqual(id.expected_size_mb, PROFILES.id.expectedSizeMB)
  assert.deepEqual(base.expected_size_mb, PROFILES.base.expectedSizeMB)

  assert.equal(id.infer_weight.fixed, 1.0)
  assert.equal(id.infer_weight.adjustable, false)
  assert.equal(base.infer_weight.max, 0.7, 'Base 硬上限必须写在交付标准里')
  assert.equal(base.infer_weight.min, 0.3)
  assert.equal(base.infer_weight.default, PROFILES.base.inferWeight.default)
})

test('pipeline.json：阶段 / 推理策略 / 验收条数 / 失败码 与代码对齐', () => {
  const pipe = readJson('configs/pipeline.json')
  assert.equal(pipe.architecture.mode, 'dual-lora-decoupled')
  assert.deepEqual(pipe.architecture.tracks, ['id', 'base'])

  const stages = pipe.stages.map((s) => s.stage)
  for (const s of ['collect', 'caption', 'split', 'naming', 'dataset', 'validate', 'train', 'deliver']) {
    assert.ok(stages.includes(s), `pipeline.json 缺阶段 ${s}`)
  }

  // 推理策略表必须与代码里的 playbook 同源（场景名与权重）
  assert.equal(pipe.inference.playbook.length, INFER_PLAYBOOK.length)
  assert.equal(pipe.inference.playbook[0].base, 0, '解耦自检必须 Base=0')
  assert.equal(pipe.inference.playbook[pipe.inference.playbook.length - 1].base, '不超过 0.7')

  assert.ok(pipe.acceptance.length >= 9, '验收标准至少 9 条')
  for (const code of ['TRAIN_OOM', 'TRAIN_SCRIPT_MISSING', 'TRAIN_DEPS_MISSING', 'TRAIN_LYCON_UNAVAILABLE', 'LORA_DATASET_INVALID', 'LORA_PLAN_INVALID']) {
    assert.ok(pipe.failure_codes[code], `pipeline.json 缺失败码 ${code} 的处置说明`)
  }
})

test('标注示例文件：每一行都必须能通过净化器（不许把错误写法当示例）', async () => {
  const { sanitizeCaption } = await import('../lib/dataset.js')
  const text = fs.readFileSync(path.join(LORA_DIR, 'templates/caption-example.txt'), 'utf8')
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  assert.ok(lines.length >= 5, '示例太少')
  for (const line of lines) {
    const s = sanitizeCaption(line, { bannedTokens: ['Alice'] })
    assert.equal(s.text, line, `示例行含身份类内容，会被净化器改写: ${line}`)
    assert.deepEqual(s.removed, [], `示例行不应再有可剔除内容: ${line}`)
  }
})
