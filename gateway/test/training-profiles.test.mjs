/**
 * gateway/test/training-profiles.test.mjs — 双轨训练参数三层归一的单元测试（P1）
 *
 * 覆盖：档位标准值、硬底线不可覆盖、越界钳制、档位权威参数、校验器、脚本候选顺序。
 * 纯函数测试，不起网关、不碰文件系统。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROFILES,
  PROFILE_NAMES,
  COMMON_STANDARD,
  getProfile,
  listProfiles,
  profileArgList,
  normalizeArgs,
  validateProfileArgs,
  keyOf,
  trainerScriptCandidates,
} from '../lib/training-profiles.js'

const BASELINE = ['--optimizer_type=AdamW8bit', '--mixed_precision=fp16', '--lowvram']

test('档位标准：ID 低秩锁身份 / Base LoCon 覆盖卷积', () => {
  assert.deepEqual(PROFILE_NAMES, ['id', 'base'])
  const id = getProfile('id')
  const base = getProfile('base')
  assert.equal(id.networkModule, 'networks.lora')
  assert.deepEqual(id.networkArgs, [])
  assert.equal(id.networkDim, 8)
  assert.equal(id.networkAlpha, 16)
  assert.equal(id.learningRate, 4e-5)
  assert.equal(id.maxTrainSteps, 500)

  assert.equal(base.networkModule, 'lycoris.kohya')
  assert.deepEqual(base.networkArgs, ['algo=lora', 'conv_dim=4', 'conv_alpha=2'])
  assert.equal(base.networkDim, 32)
  assert.equal(base.networkAlpha, 16)
  assert.equal(base.learningRate, 7e-5)
  assert.equal(base.maxTrainSteps, 800)

  assert.equal(COMMON_STANDARD.resolution, 512)
  assert.equal(COMMON_STANDARD.optimizerFallback, 'AdamW', '没有 bitsandbytes 时要有退避优化器')
  // 档位名大小写不敏感，未知档位返回 null（调用方据此报错，不猜）
  assert.equal(getProfile('ID').name, 'id')
  assert.equal(getProfile('nope'), null)
  assert.equal(getProfile(''), null)
})

test('listProfiles：护栏与推理权重都随档位暴露', () => {
  const list = listProfiles()
  const id = list.find((p) => p.name === 'id')
  const base = list.find((p) => p.name === 'base')
  assert.deepEqual(id.guard, PROFILES.id.guard)
  assert.equal(id.infer_weight.fixed, 1.0)
  assert.equal(id.infer_weight.adjustable, false)
  assert.equal(base.infer_weight.max, 0.7, 'Base 权重硬上限 0.7（超过污染面部）')
  assert.equal(base.face_closeup_ratio.max, 0.25, 'Base 脸部特写占比不得超 25%')
  assert.equal(id.face_closeup_ratio.min, 0.6, 'ID 轨以脸部为主')
  assert.ok(base.expected_size_mb.max > id.expected_size_mb.max, 'Base 明显更重')
})

test('ID 轨：未传参时注入档位标准值（含 512 / 500 步 / clip_skip=2）', () => {
  const r = normalizeArgs({ profile: 'id', userArgs: [], baselineArgs: BASELINE })
  assert.deepEqual(r.args.slice(0, 3), BASELINE, '底线项必须排在最前')
  const line = r.args.join(' ')
  assert.match(line, /--network_module=networks\.lora/)
  assert.match(line, /--network_dim=8/)
  assert.match(line, /--network_alpha=16/)
  assert.match(line, /--learning_rate=0\.00004/)
  assert.match(line, /--max_train_steps=500/)
  assert.match(line, /--resolution=512/)
  assert.match(line, /--clip_skip=2/)
  assert.deepEqual(r.adjusted, [])
  assert.deepEqual(r.ignored, [])
})

test('Base 轨：裸 token 形式的 network_args 必须完整入列（LoCon 才生效）', () => {
  const r = normalizeArgs({ profile: 'base', userArgs: [], baselineArgs: BASELINE })
  assert.equal(r.args.filter((a) => a === '--network_args').length, 1)
  for (const t of ['algo=lora', 'conv_dim=4', 'conv_alpha=2']) {
    assert.ok(r.args.includes(t), `缺 ${t}`)
  }
  assert.match(r.args.join(' '), /--network_module=lycoris\.kohya/)
  assert.match(r.args.join(' '), /--network_dim=32/)
})

test('硬底线不可覆盖：用户同名参数被丢弃并记账（P4 语义保留）', () => {
  const r = normalizeArgs({
    profile: 'id',
    userArgs: ['--optimizer_type=SGD', '--lowvram=false', '--mixed_precision=bf16'],
    baselineArgs: BASELINE,
  })
  const line = r.args.join(' ')
  assert.match(line, /--optimizer_type=AdamW8bit/)
  assert.doesNotMatch(line, /SGD/)
  assert.doesNotMatch(line, /bf16/)
  assert.equal(r.ignored.length, 3)
  assert.ok(r.ignored.every((i) => i.reason === 'baseline-enforced'))
})

test('越界钳制：ID 轨传 dim=32 → 12；Base 轨传 dim=8 → 16（各自护栏，不静默）', () => {
  const a = normalizeArgs({ profile: 'id', userArgs: ['--network_dim=32'], baselineArgs: BASELINE })
  assert.match(a.args.join(' '), /--network_dim=12/)
  assert.equal(a.args.filter((x) => keyOf(x) === '--network_dim').length, 1, '同名参数只保留一份')
  assert.equal(a.adjusted.length, 1)
  assert.deepEqual(a.adjusted[0], {
    key: '--network_dim', arg: '--network_dim=12', adjusted: true, reason: 'above-guard-max',
    from: 32, to: 12, guard: { min: 4, max: 12 }, profile: 'id',
  })

  const b = normalizeArgs({ profile: 'base', userArgs: ['--network_dim=8'], baselineArgs: BASELINE })
  assert.match(b.args.join(' '), /--network_dim=16/)
  assert.equal(b.adjusted[0].reason, 'below-guard-min')
})

test('步数下限也钳制：ID 轨 300 步是地板（防欠拟合），Base 轨 400 是地板', () => {
  const a = normalizeArgs({ profile: 'id', userArgs: ['--max_train_steps=5'], baselineArgs: BASELINE })
  assert.match(a.args.join(' '), /--max_train_steps=300/)
  const b = normalizeArgs({ profile: 'base', userArgs: ['--max_train_steps=99999'], baselineArgs: BASELINE })
  assert.match(b.args.join(' '), /--max_train_steps=1200/)
})

test('档位权威参数：module / network_args 不接受用户覆盖（防止模块与卷积参数错配）', () => {
  const r = normalizeArgs({
    profile: 'base',
    userArgs: ['--network_module=networks.lora', '--network_args=conv_dim=64'],
    baselineArgs: BASELINE,
  })
  const line = r.args.join(' ')
  assert.equal((line.match(/--network_module=/g) || []).length, 1)
  assert.match(line, /--network_module=lycoris\.kohya/)
  assert.doesNotMatch(line, /conv_dim=64/)
  assert.equal(r.ignored.filter((i) => i.reason === 'profile-authoritative').length, 2)
})

test('未知档位不套档位层：只注入硬底线（旧调用方兼容路径）', () => {
  const r = normalizeArgs({ profile: null, userArgs: ['--network_dim=6'], baselineArgs: BASELINE })
  assert.equal(r.profileArgs.length, 0)
  assert.match(r.args.join(' '), /--network_dim=6/, '无档位时用户参数原样透传')
  assert.deepEqual(r.args.slice(0, 3), BASELINE)
})

test('validateProfileArgs：模块错配 / 缺 dim / 越界都要报错，ID 高秩给告警', () => {
  const ok = validateProfileArgs({ profile: 'id', args: profileArgList('id') })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.errors, [])

  const bad = validateProfileArgs({ profile: 'id', args: ['--network_module=networks.lora'] })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((e) => e.includes('--network_dim')))

  const wrongModule = validateProfileArgs({ profile: 'base', args: ['--network_module=networks.lora', '--network_dim=32'] })
  assert.equal(wrongModule.ok, false)
  assert.ok(wrongModule.errors.some((e) => e.includes('lycoris.kohya')))

  const unknown = validateProfileArgs({ profile: 'xxx', args: [] })
  assert.equal(unknown.ok, false)
  assert.match(unknown.errors[0], /未知训练档位/)

  const highRank = validateProfileArgs({ profile: 'id', args: ['--network_module=networks.lora', '--network_dim=12'] })
  assert.equal(highRank.ok, true, '12 在护栏内仍算通过')
  assert.ok(highRank.warnings.some((w) => w.includes('秩偏高')))
})

test('脚本候选：SD1.5 优先 train_network.py，SDXL 优先 sdxl_train_network.py', () => {
  assert.equal(trainerScriptCandidates('sd15')[0], 'train_network.py')
  assert.equal(trainerScriptCandidates('sdxl')[0], 'sdxl_train_network.py')
  assert.equal(trainerScriptCandidates(undefined)[0], 'train_network.py', '未给基础模型时按本机主流 SD1.5 处理')
  assert.equal(trainerScriptCandidates('sd15').length, 2, '候选要留后备，不能只找一个名字')
})