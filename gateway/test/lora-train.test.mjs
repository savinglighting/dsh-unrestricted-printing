/**
 * gateway/test/lora-train.test.mjs — 双轨编排（P3）
 *
 * 全链路离线回归：采集 / 标注可注入，训练执行器（runner）也注入，
 * 因此这里能验证「拆轨 → 命名 → 落盘 → 硬校验 → 串行训练 → 产物收集」每一步的判定，
 * 不需要真的跑 kohya、不需要 GPU。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  estimateTrainMinutes,
  assignTracks,
  planTraining,
  prepareDatasets,
  parseProgress,
  classifyTrainFailure,
  findArtifact,
  runTracks,
} from '../lib/lora-train.js'
import { namesFromFiles } from '../lib/lora-naming.js'

let seq = 0
function tmp(tag) {
  const dir = path.join(os.tmpdir(), 'lora-train-test', `${tag}-${process.pid}-${++seq}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 假底模：计划阶段要求 --pretrained_model_name_or_path 指向真实存在的文件 */
const FAKE_BASE_MODEL = (() => {
  const dir = path.join(os.tmpdir(), 'lora-train-test', 'base-model')
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'AWPainting_v1.2.safetensors')
  if (!fs.existsSync(f)) fs.writeFileSync(f, 'fake')
  return f
})()

function png(w = 512, h = 768, fill = 0x33) {
  const b = Buffer.alloc(33, fill)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

const CLOSEUP_CAP = 'woman, portrait, close-up, upper body, sunlight'
const FULL_CAP = 'woman, full body, standing, garden, dress, sunlight'

/** 造素材 + 侧车标注（模拟「用户给一批图，每张旁边有 txt」这种最常见的现实情况） */
function makeSources(root, { closeup = 20, full = 20 } = {}) {
  const dir = path.join(root, 'raw')
  fs.mkdirSync(dir, { recursive: true })
  const images = []
  const push = (i, kind) => {
    const name = `${kind}_${String(i).padStart(2, '0')}.png`
    const p = path.join(dir, name)
    fs.writeFileSync(p, png(512, 768, kind === 'closeup' ? i + 1 : i + 90))
    fs.writeFileSync(p.replace(/\.png$/, '.txt'), kind === 'closeup' ? CLOSEUP_CAP : FULL_CAP, 'utf8')
    images.push({
      path: p,
      name,
      origin: p,
      originKind: 'local-file',
      role: 'user-path',
      sha256: `hash_${kind}_${i}`,
      bytes: 33,
      width: 512,
      height: 768,
      format: 'png',
      shortSide: 512,
    })
  }
  for (let i = 0; i < closeup; i++) push(i, 'closeup')
  for (let i = 0; i < full; i++) push(i, 'full')
  return { dir, result: { ok: true, images, errors: [], skipped: [], sources: [{ input: dir, kind: 'local-dir', role: 'user-path' }], needsProcess: [] } }
}

test('estimateTrainMinutes：ID 轨比 Base 轨轻（LoCon 800 步更重）', () => {
  const id = estimateTrainMinutes('id')
  const base = estimateTrainMinutes('base')
  assert.equal(id.steps, 500)
  assert.equal(base.steps, 800)
  assert.ok(base.minutes[0] > id.minutes[0])
  assert.deepEqual(estimateTrainMinutes('id', 300).steps, 300)
  assert.equal(estimateTrainMinutes('nope'), null)
})

test('assignTracks：特写归 ID、半身全身归 Base，判不清的按缺口交替补齐', () => {
  const images = [{ path: 'a.png' }, { path: 'b.png' }, { path: 'c.png' }]
  const captions = { 'a.png': 'woman, portrait, close-up', 'b.png': 'woman, full body, standing', 'c.png': 'woman, indoors' }
  const r = assignTracks({ images, captions, minPerTrack: 1 })
  assert.deepEqual(r.id.map((x) => x.path), ['a.png', 'c.png'], '判不清的补齐到张数少的那一组')
  assert.deepEqual(r.base.map((x) => x.path), ['b.png'])
  assert.deepEqual(r.errors, [])

  const short = assignTracks({ images: [images[0]], captions: { 'a.png': 'woman, portrait' }, minPerTrack: 15 })
  assert.equal(short.errors.length, 2)
  assert.ok(short.errors.some((e) => e.includes('Base 轨素材只有 0 张')))
})

test('planTraining：双轨参数按标准注入（ID dim=8 标准 LoRA / Base dim=32 LoCon）', () => {
  const root = tmp('plan')
  const p = planTraining({ baseModelPath: FAKE_BASE_MODEL, sources: ['D:\\raw'], name: 'aili', datasetRoot: root })
  assert.equal(p.ok, true, JSON.stringify(p.errors))
  assert.equal(p.tracks.length, 2)
  const [id, base] = p.tracks
  assert.equal(id.profile, 'id')
  assert.equal(id.standard.network_module, 'networks.lora')
  assert.equal(id.standard.network_dim, 8)
  assert.equal(id.standard.max_train_steps, 500)
  assert.equal(id.lora.name, 'aili_id')
  assert.equal(base.standard.network_module, 'lycoris.kohya')
  assert.deepEqual(base.standard.network_args, ['algo=lora', 'conv_dim=4', 'conv_alpha=2'])
  assert.equal(base.standard.network_dim, 32)
  assert.equal(base.standard.max_train_steps, 800)
  assert.equal(base.lora.name, 'aili_base')
  assert.equal(path.basename(id.dataset.mainDir), '10_aili_id')
  assert.equal(path.basename(base.dataset.mainDir), '10_aili_base')
  assert.notEqual(id.dataset.root, base.dataset.root)
  assert.equal(p.baseModelPath, FAKE_BASE_MODEL, '计划里必须带上底模路径')
  assert.ok(p.estimate.minutes[0] > 0)
})

test('planTraining：缺底模 / 底模不存在 / 缺来源 / 名字冲突 / 未知档位 都如实报错', () => {
  const root = tmp('plan2')
  const noModel = planTraining({ sources: ['D:\\raw'], name: 'aili', datasetRoot: root })
  assert.equal(noModel.ok, false)
  assert.ok(noModel.errors.some((e) => e.includes('缺少训练底模')), JSON.stringify(noModel.errors))

  const ghost = planTraining({ baseModelPath: path.join(root, 'nope.safetensors'), sources: ['D:\\raw'], datasetRoot: root })
  assert.equal(ghost.ok, false)
  assert.ok(ghost.errors.some((e) => e.includes('底模不存在')))

  const p = planTraining({ baseModelPath: FAKE_BASE_MODEL, sources: ['D:\\raw'], name: 'aili', datasetRoot: root, existing: ['aili_id', 'aili_base'] })
  assert.equal(p.tracks[0].lora.name, 'aili_id_v2')
  assert.equal(p.tracks[1].lora.name, 'aili_base_v2')
  assert.ok(p.warnings.some((w) => w.includes('已存在')))

  const noSrc = planTraining({ baseModelPath: FAKE_BASE_MODEL, datasetRoot: root })
  assert.equal(noSrc.ok, false)
  assert.ok(noSrc.errors.some((e) => e.includes('没有给任何来源')))

  const bad = planTraining({ baseModelPath: FAKE_BASE_MODEL, sources: ['x'], datasetRoot: root, tracks: ['nope'] })
  assert.equal(bad.ok, false)
})

test('prepareDatasets：自动拆轨 + 落盘 + 硬校验全通过（40 张素材 → 20/20）', async () => {
  const root = tmp('prep')
  const { result } = makeSources(root, { closeup: 20, full: 20 })
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL, sources: [path.join(root, 'raw')], name: 'aili', datasetRoot: root, captionMode: 'auto' })
  const prep = await prepareDatasets({
    plan,
    ingestFn: async () => result,
    captionFn: async () => ({ ok: true, captions: {}, failed: [], errors: [], removed: [] }),
  })
  assert.equal(prep.ok, true, JSON.stringify(prep.errors))
  assert.equal(prep.tracks.length, 2)
  const [idT, baseT] = prep.tracks
  assert.equal(idT.imageCount, 20)
  assert.equal(baseT.imageCount, 20)
  assert.equal(idT.datasetStats.closeupRatio, 1, 'ID 轨全是特写')
  assert.equal(baseT.datasetStats.closeupRatio, 0, 'Base 轨全无特写')
  for (const t of prep.tracks) {
    const files = fs.readdirSync(t.dataset.mainDir)
    assert.equal(files.filter((f) => f.endsWith('.png')).length, 20)
    assert.equal(files.filter((f) => f.endsWith('.txt')).length, 20)
    assert.equal(fs.readFileSync(path.join(t.dataset.mainDir, files.find((f) => f.endsWith('.txt'))), 'utf8').trim().length > 0, true)
  }
  assert.ok(!fs.readdirSync(idT.dataset.root).includes('_collected'), '采集目录不该落在数据集树里')
})

test('prepareDatasets：素材不够 → 训练前就拦（不带着坏数据开训）', async () => {
  const root = tmp('prep-short')
  const { result } = makeSources(root, { closeup: 6, full: 5 })
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL, sources: [path.join(root, 'raw')], name: 'aili', datasetRoot: root })
  const prep = await prepareDatasets({ plan, ingestFn: async () => result })
  assert.equal(prep.ok, false)
  assert.ok(prep.errors.some((e) => e.includes('ID 轨素材只有')), JSON.stringify(prep.errors))
  assert.ok(prep.errors.some((e) => e.includes('Base 轨素材只有')))
})

test('prepareDatasets：自动标注不可用 → 明确要求人工标注（不拿通用模板糊过去）', async () => {
  const root = tmp('prep-nocap')
  const { result } = makeSources(root, { closeup: 18, full: 18 })
  for (const im of result.images) fs.rmSync(im.path.replace(/\.png$/, '.txt'))
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL, sources: [path.join(root, 'raw')], name: 'aili', datasetRoot: root })
  const prep = await prepareDatasets({
    plan,
    ingestFn: async () => result,
    captionFn: async ({ images }) => ({ ok: false, captions: {}, failed: images.map((i) => ({ file: i.path, error: '视觉模型不可用' })), errors: images.map((i) => `${i.path}: 视觉模型不可用`), removed: [] }),
  })
  assert.equal(prep.ok, false)
  assert.ok(prep.errors.some((e) => e.includes('自动标注失败')))
  assert.ok(prep.errors.some((e) => e.includes('同名 .txt')), '必须告诉用户怎么补标注')
})

test('prepareDatasets：占位标注模式显式要求才走，并留下警告', async () => {
  const root = tmp('prep-ph')
  const { result } = makeSources(root, { closeup: 18, full: 18 })
  for (const im of result.images) fs.rmSync(im.path.replace(/\.png$/, '.txt'))
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL, sources: [path.join(root, 'raw')], name: 'aili', datasetRoot: root, captionMode: 'placeholder' })
  const prep = await prepareDatasets({ plan, ingestFn: async () => result })
  assert.ok(prep.warnings.some((w) => w.includes('placeholder')), '占位标注必须留痕警告')
})

test('prepareDatasets：视觉拆解可用时按画面主体拆轨（visionSplit）', async () => {
  const root = tmp('prep-vision')
  const { result } = makeSources(root, { closeup: 18, full: 18 })
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL, sources: [path.join(root, 'raw')], name: 'aili', datasetRoot: root, visionSplit: true })
  const seg = async ({ images }) => {
    const results = {}
    for (const im of images) {
      const file = typeof im === 'string' ? im : im.path
      const isFace = /closeup/.test(path.basename(file))
      results[file] = { composition: isFace ? 'closeup' : 'full', bucket: isFace ? 'identity' : 'wardrobe', faceVisible: true, faceProminence: isFace ? 0.85 : 0.15, outfitProminence: isFace ? 0.1 : 0.6, sceneProminence: 0.2, tags: [] }
    }
    return { ok: true, results, failed: [], errors: [], classified: images.length, total: images.length }
  }
  const prep = await prepareDatasets({ plan, ingestFn: async () => result, segmentFn: seg })
  assert.equal(prep.ok, true, JSON.stringify(prep.errors))
  assert.equal(prep.tracks[0].imageCount, 18, '视觉拆解把特写都分给 ID 轨')
  assert.equal(prep.tracks[1].imageCount, 18)
})

test('prepareDatasets：视觉拆解全部失败 → 回退关键词拆轨（不阻断训练）', async () => {
  const root = tmp('prep-vision-fail')
  const { result } = makeSources(root, { closeup: 18, full: 18 })
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL, sources: [path.join(root, 'raw')], name: 'aili', datasetRoot: root, visionSplit: true })
  const prep = await prepareDatasets({
    plan,
    ingestFn: async () => result,
    segmentFn: async () => ({ ok: false, results: {}, failed: [], errors: ['视觉模型不可用'], classified: 0, total: 36 }),
  })
  assert.equal(prep.ok, true, '视觉拆解失败不该阻断训练')
  assert.ok(prep.warnings.some((w) => w.includes('回退')), JSON.stringify(prep.warnings))
  assert.equal(prep.tracks[0].imageCount, 18, '回退后仍按关键词拆出 18 张特写')
})

test('runTracks：两轨串行，命令行带底模，产物按自定义名落盘并回收', async () => {
  const root = tmp('run')
  const { result } = makeSources(root, { closeup: 18, full: 18 })
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL, sources: [path.join(root, 'raw')], name: 'aili', datasetRoot: root })
  const prep = await prepareDatasets({ plan, ingestFn: async () => result })

  const seen = []
  const argsSeen = []
  const runner = async ({ profile, args, outputDir, outputName }) => {
    seen.push(profile)
    argsSeen.push({ profile, args })
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(path.join(outputDir, `${outputName}.safetensors`), Buffer.from('mock-weights'))
    return { ok: true, exitCode: 0, pid: 1234, logFile: path.join(outputDir, 'train.log') }
  }
  const run = await runTracks({ plan, prepared: prep, runner })
  assert.equal(run.ok, true, JSON.stringify(run.errors))
  assert.deepEqual(seen, ['id', 'base'], '必须按 id → base 串行')
  assert.deepEqual(run.results.map((r) => r.name), ['aili_id', 'aili_base'])
  for (const a of argsSeen) {
    assert.ok(a.args.some((x) => x.startsWith('--pretrained_model_name_or_path=')), '缺底模参数，kohya 跑不起来')
    assert.ok(a.args.some((x) => x.startsWith('--train_data_dir=')))
    assert.ok(a.args.some((x) => x.startsWith('--output_name=')))
  }
  assert.ok(argsSeen[0].args.some((x) => x.includes('--cache_latents')))

  for (const t of prep.tracks) {
    const art = findArtifact({ outputDir: t.outputDir, expectedName: t.lora.name })
    assert.equal(art.ok, true)
    assert.equal(namesFromFiles([art.file])[0], t.lora.name)
    assert.equal(art.bytes > 0, true)
  }
})

test('runTracks：前一轨失败 → 立即中断并给分类原因（不空跑第二轨）', async () => {
  const root = tmp('run-fail')
  const { result } = makeSources(root, { closeup: 18, full: 18 })
  const plan = planTraining({ baseModelPath: FAKE_BASE_MODEL, sources: [path.join(root, 'raw')], name: 'aili', datasetRoot: root })
  const prep = await prepareDatasets({ plan, ingestFn: async () => result })
  const seen = []
  const run = await runTracks({
    plan,
    prepared: prep,
    runner: async ({ profile }) => {
      seen.push(profile)
      return { ok: false, exitCode: 1, logTail: 'RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB' }
    },
  })
  assert.equal(run.ok, false)
  assert.deepEqual(seen, ['id'], 'ID 轨失败后不得继续跑 Base 轨')
  assert.equal(run.results[0].failure.code, 'TRAIN_OOM')
  assert.match(run.errors[0], /显存不足/)
})

test('classifyTrainFailure：按日志给人话结论，而不是裸 exit code', () => {
  assert.equal(classifyTrainFailure({ exitCode: 1, logTail: 'CUDA out of memory' }).code, 'TRAIN_OOM')
  assert.equal(classifyTrainFailure({ exitCode: 2, logTail: "can't open file 'train_network.py'" }).code, 'TRAIN_SCRIPT_MISSING')
  assert.equal(classifyTrainFailure({ exitCode: 1, logTail: 'ModuleNotFoundError: No module named bnb' }).code, 'TRAIN_DEPS_MISSING')
  assert.match(classifyTrainFailure({ exitCode: 1, logTail: 'lycoris.kohya not found' }).hint, /lycoris/)
  assert.equal(classifyTrainFailure({ exitCode: 0, logTail: '' }).code, null)
  assert.equal(classifyTrainFailure({ exitCode: 7, logTail: 'whatever' }).code, 'TRAIN_FAILED')
})

test('parseProgress：解析 kohya 日志尾部进度；解析不到就如实返回 null', () => {
  const log = 'epoch 0/1\nsteps:  20%|10/500 [00:30<24:00, 3.2it/s]\n'
  const p = parseProgress(log)
  assert.equal(p.percent, 20)
  assert.equal(p.step, 10)
  assert.equal(p.total, 500)
  assert.equal(parseProgress('nothing here').percent, null)
  assert.equal(parseProgress('', 500).total, 500)
})

test('findArtifact：输出目录为空/不存在都要如实报（不返回假路径）', () => {
  const root = tmp('artifact')
  assert.equal(findArtifact({ outputDir: path.join(root, 'nope') }).ok, false)
  fs.mkdirSync(path.join(root, 'empty'), { recursive: true })
  assert.equal(findArtifact({ outputDir: path.join(root, 'empty') }).ok, false)
  const dir = path.join(root, 'has')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'x.safetensors'), 'a')
  const r = findArtifact({ outputDir: dir })
  assert.equal(r.ok, true)
  assert.equal(r.name, 'x')
})