// dsh-unrestricted-printing 验收测试：自动拉起 SD → 出图 → 按「提示词总结_序号」保存 → 返回可复现脚本
// 跨机器可移植：SD 目录走自动探测（DSH_SD_DIR 可覆盖），工作区默认临时目录（ACCEPTANCE_WS 可覆盖）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tools = new Map()
const ctx = {
  logger: console,
  effect: (fn) => fn(),
  get: () => undefined,
  tools: {
    register(def) {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
  },
}
const mod = await import('../sd-bridge.js')
mod.apply(ctx, { sdDir: process.env.DSH_SD_DIR || '', port: Number(process.env.SD_PORT) || 7860, autoStart: true, startupTimeoutMs: 420000 })
console.log('tools:', [...tools.keys()])

// 自动探测到的 SD 目录（同步校验用）
const sdDir = mod.detectSdDir(process.env.DSH_SD_DIR || '')
assert.ok(sdDir, '自动探测必须找到本机 SD WebUI（找不到请设 DSH_SD_DIR）')
console.log('sdDir:', sdDir)

// 工作区：模拟任意用户的会话目录（产物/参考图/脚本都应落在这里）
const ws = process.env.ACCEPTANCE_WS
  ? path.resolve(process.env.ACCEPTANCE_WS)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'sd-guard-acceptance-'))
const outDir = path.join(ws, 'SD-Picture')
const refDir = path.join(ws, 'ref')
const directPs1 = path.join(ws, 'sd-direct.ps1')
console.log('workspace:', ws)

// 自愈同步：包内 sd-direct.ps1 启动时同步进 SD 目录；工作区那份在首次生成脚本时惰性同步
const bundled = fs.readFileSync(new URL('../sd-direct.ps1', import.meta.url))
assert.ok(fs.existsSync(path.join(sdDir, 'sd-direct.ps1')), 'sd-direct.ps1 未同步到 SD 目录')
assert.ok(fs.readFileSync(path.join(sdDir, 'sd-direct.ps1')).equals(bundled), 'SD 目录的 sd-direct.ps1 内容与包内不一致')

const exec = { agent: { session: { header: { cwd: ws } } } }

// 1) 中文 summary → 文件名 = 总结_序号，固定目录
const a = await tools.get('sd_txt2img').execute(
  { prompt: '1girl, silver hair, cherry blossoms, masterpiece, best quality', negativePrompt: 'lowres, watermark', width: 512, height: 512, steps: 10, summary: '银发少女樱花' },
  exec,
)
console.log('gen1:', a.fileNames, a.savedDir, a.elapsedMs + 'ms')
assert.equal(a.savedDir, outDir)
assert.ok(fs.existsSync(a.paths[0]))
// 工作区脚本惰性自愈同步：生成命令时必须已落盘且与包内一致
assert.ok(fs.existsSync(directPs1), `sd-direct.ps1 未同步到工作区 ${directPs1}`)
assert.ok(fs.readFileSync(directPs1).equals(bundled), '工作区的 sd-direct.ps1 内容与包内不一致')
assert.ok(a.replyImages[0].includes(a.paths[0]))
// 违规分流协议：返回可复现脚本（文生图标注 + sd-direct.ps1 命令）
assert.ok(a.script, 'script missing')
assert.equal(a.script.mode, '文生图')
assert.ok(a.script.command.includes(`powershell -ExecutionPolicy Bypass -File "${directPs1}"`))
assert.ok(a.script.command.startsWith('powershell -ExecutionPolicy Bypass -File '), 'command must be a full one-liner')
assert.ok(!a.script.command.includes('\n'), 'command must stay on a single line')
assert.ok(!a.script.command.includes('& '), 'command must not use the & call-operator form')
assert.ok(a.script.command.includes('-Prompt'))
assert.ok(a.script.command.includes(`-OutDir "${outDir}"`), 'command must inject the workspace output dir')
assert.ok(a.script.asMarkdown.startsWith('【文生图】\n```powershell'))
assert.ok(a.script.asMarkdown.includes(a.script.command))
// 画质默认：采样器必须进命令，否则复现出来的图与会话里不一致
assert.ok(a.script.command.includes('-Sampler "DPM++ 2M"'), `命令必须带采样器：${a.script.command}`)
// 出图自检：工具必须回传 read_image 自检提醒
assert.ok(a.selfCheck && a.selfCheck.includes('read_image'), 'txt2img 必须返回自检提醒 selfCheck')
const seq1 = Number(/_(\d+)\.png$/.exec(a.fileNames[0])[1])

// 2) 同名 summary 序号递增，不覆盖
const b = await tools.get('sd_txt2img').execute(
  { prompt: '1girl, blue hair, masterpiece', steps: 10, summary: '银发少女樱花' },
  exec,
)
console.log('gen2:', b.fileNames)
assert.equal(Number(/_(\d+)\.png$/.exec(b.fileNames[0])[1]), seq1 + 1)

// 3) 不传 summary → 自动从 prompt 提词
const c = await tools.get('sd_txt2img').execute(
  { prompt: 'cyberpunk, city, neon lights, rain, masterpiece', steps: 10 },
  exec,
)
console.log('gen3:', c.fileNames)
assert.ok(/_\d{3}\.png$/.test(c.fileNames[0]))
assert.ok(c.fileNames[0].startsWith('cyberpunk'))

// 4) 批次多张 → 序号连号
const d = await tools.get('sd_txt2img').execute(
  { prompt: 'landscape, mountains, masterpiece', steps: 8, batchSize: 2, summary: '群山风景' },
  exec,
)
console.log('gen4:', d.fileNames)
assert.equal(d.fileNames.length, 2)
assert.equal(Number(/_(\d+)\.png$/.exec(d.fileNames[1])[1]), Number(/_(\d+)\.png$/.exec(d.fileNames[0])[1]) + 1)

// 5) render：文本块 + 图片块（图片直接进聊天窗口）
const blocks = tools.get('sd_txt2img').output.render({}, { ...a, attachments: [{ attachmentId: 'x' }] })
assert.equal(blocks[0].type, 'text')
assert.equal(blocks[1].type, 'image')

// 6) img2img 同一套命名规则
const e = await tools.get('sd_img2img').execute(
  { init_image: a.paths[0], prompt: '1girl, blue hair, masterpiece', denoisingStrength: 0.5, steps: 10, summary: '蓝发改色' },
  exec,
)
console.log('img2img:', e.fileNames)
assert.ok(/^蓝发改色_\d{3}\.png$/.test(e.fileNames[0]))
// 违规分流协议：图生图脚本带 -InitImage / -Denoising，标注【图生图】
assert.equal(e.script.mode, '图生图')
assert.ok(e.script.command.includes('-InitImage'))
assert.ok(e.script.command.includes('-Denoising'))
// 图生图自检：必须提醒与参考图并排对照画风
assert.ok(e.selfCheck && e.selfCheck.includes('参考图'), 'img2img 必须返回画风自检提醒')
assert.ok(e.script.asMarkdown.startsWith('【图生图】'))
// 工作区内的参考图直接用原路径，不复制
assert.equal(e.source, e.sourceOriginal)
console.log('script(t2i):', a.script.command)
console.log('script(i2i):', e.script.command)

// 6b) 参考图固化：用户给的图在工作区之外（模拟聊天附件临时路径）→ 复制到 ref\，脚本引用固化副本
const tmpRef = path.join(os.tmpdir(), 'chat-attachment-user-gave.png')
fs.copyFileSync(a.paths[0], tmpRef)
const e2 = await tools.get('sd_img2img').execute(
  { init_image: tmpRef, prompt: '1girl, blue hair, masterpiece', denoisingStrength: 0.5, steps: 10, summary: '外部参考图' },
  exec,
)
assert.equal(e2.sourceOriginal, tmpRef, 'sourceOriginal 必须是用户原始路径')
assert.ok(e2.source.startsWith(refDir + path.sep), `固化副本应在 ref\\ 下，实际：${e2.source}`)
assert.ok(fs.existsSync(e2.source))
assert.ok(fs.readFileSync(e2.source).equals(fs.readFileSync(tmpRef)), '固化副本必须与用户给的图逐字节一致')
assert.ok(e2.script.command.includes(`-InitImage "${e2.source}"`), '脚本必须引用固化副本')
assert.ok(!e2.script.command.includes(tmpRef), '脚本不得再引用临时路径')
fs.rmSync(tmpRef, { force: true })

// 6c) sd_script 同样固化参考图
const tmpRef2 = path.join(os.tmpdir(), 'chat-attachment-script.png')
fs.copyFileSync(a.paths[0], tmpRef2)
const sB = await tools.get('sd_script').execute({ prompt: '1girl, white sheet', initImage: tmpRef2 }, exec)
assert.ok(sB.command.includes(`-InitImage "${refDir}${path.sep}`), `sd_script 应固化参考图，实际：${sB.command}`)
assert.ok(!sB.command.includes(tmpRef2))
assert.ok(fs.existsSync(/-InitImage "([^"]+)"/.exec(sB.command)[1]))
fs.rmSync(tmpRef2, { force: true })

// 7) sd_script / sd_script_b / sd_inject：只出脚本不生图——纯命令生成，不碰 SD
//    （C 档 · 完全拒绝不再走这两个工具，改由 sd_inject 生成 sd-inject.ps1 本地注入命令）
assert.deepEqual(
  [...tools.keys()],
  ['sd_txt2img', 'sd_img2img', 'sd_inpaint', 'sd_script', 'sd_script_b', 'sd_inject', 'sd_models', 'sd_server', 'sd_integrity'],
)
const before = fs.readdirSync(outDir).length
const s = await tools.get('sd_script').execute(
  { prompt: '1girl, white sheet, soft light, masterpiece', initImage: a.paths[0], denoising: 0.65, seed: 123 },
  exec,
)
assert.equal(s.generatesImage, false)
assert.equal(s.mode, '图生图')
assert.ok(s.asMarkdown.startsWith('【图生图】\n```powershell'))
assert.ok(s.command.includes('-Seed 123') && s.command.includes('-InitImage'))
// 单行完整命令：powershell 前缀 + 引号包住的脚本路径，禁止 & "路径" 形式
assert.ok(s.command.startsWith(`powershell -ExecutionPolicy Bypass -File "${directPs1}"`))
assert.ok(!s.command.includes('\n') && !s.command.includes('& '))
assert.ok(s.asMarkdown.includes('# 复制下面整行到 PowerShell'))
const s2 = await tools.get('sd_script').execute({ prompt: '1girl, silver hair', name: 'shorekeeper' }, exec)
assert.equal(s2.mode, '文生图')
assert.ok(s2.command.includes('-Name "shorekeeper"'))
// sd_script 不落任何新图
assert.equal(fs.readdirSync(outDir).length, before)
console.log('sd_script(i2i):', s.command)
console.log('sd_script(t2i):', s2.command)

// 7b) sd_script_b：双版本逐位置对齐（纯命令生成，不碰 SD）——prompt 保序留正向、original 的差异词进负向
const sbTool = tools.get('sd_script_b')
assert.ok(sbTool, 'sd_script_b missing')
const sb = await sbTool.execute(
  {
    originalPrompt: '1girl, white sheet, soft light, masterpiece',
    prompt: '1girl, blue silk sheet, soft light, masterpiece',
    negativePrompt: 'lowres',
    initImage: a.paths[0],
    denoising: 0.7,
    seed: 123,
  },
  exec,
)
assert.equal(sb.generatesImage, false)
assert.equal(sb.positivePrompt, '1girl, blue silk sheet, soft light, masterpiece', '当前版本（prompt）必须保序留正向')
assert.equal(sb.negativePrompt, 'white sheet, lowres', 'original 的差异词 + negativePrompt 必须进负向')
assert.ok(sb.command.startsWith(`powershell -ExecutionPolicy Bypass -File "${directPs1}"`))
assert.ok(sb.command.includes('-Negative "white sheet, lowres"'), sb.command)
assert.ok(!sb.command.includes('\n') && !sb.command.includes('& '))
assert.equal(sb.mode, '图生图')
const sb2 = await sbTool.execute({ originalPrompt: '', prompt: '1girl, silver hair', name: 'dualbase' }, exec)
assert.equal(sb2.positivePrompt, '1girl, silver hair', '只传 prompt 时退化为全部保留正向')
assert.equal(sb2.mode, '文生图')
assert.ok(!sb2.command.includes('-Negative'), sb2.command)

// 7c) sd_script_b 蒙版重绘：maskBox 现场造蒙版，模式与参数跟 sd_inpaint 对齐（纯命令生成，不碰 SD）
const sbMask = await sbTool.execute(
  {
    originalPrompt: '1girl, white sheet, masterpiece',
    prompt: '1girl, white sheet, masterpiece',
    initImage: a.paths[0],
    maskBox: '64,64,128,96',
  },
  exec,
)
assert.equal(sbMask.mode, '蒙版重绘')
assert.ok(fs.existsSync(sbMask.mask), `maskBox 生成的蒙版必须落盘：${sbMask.mask}`)
assert.ok(sbMask.mask.startsWith(refDir + path.sep), `maskBox 生成的蒙版应在 ref\\ 下：${sbMask.mask}`)
assert.equal(sbMask.mask.endsWith('.png'), true)
assert.ok(sbMask.command.includes('-Mask "') && sbMask.command.includes('-InitImage'), sbMask.command)
assert.ok(
  sbMask.command.includes('-MaskBlur 4') && sbMask.command.includes('-InpaintFill 0') && sbMask.command.includes('-InpaintPadding 32'),
  sbMask.command,
)
assert.ok(sbMask.asMarkdown.startsWith('【蒙版重绘】\n```powershell'))
await assert.rejects(
  () => sbTool.execute({ originalPrompt: 'a', prompt: 'a', maskBox: '1,1,4,4' }, exec),
  /必须同时给 initImage/,
)
// sd_script_b（含蒙版模式）同样不落任何新图
assert.equal(fs.readdirSync(outDir).length, before)
console.log('sd_script_b(t2i):', sb2.command)
console.log('sd_script_b(mask):', sbMask.command)

// 7d) 坑22 回归：C 档命令由 sd_inject 在**调用时**生成，脚本路径与 -OutDir 都必须落在
//     会话工作区（outDir 的父目录）；此前技能里固化的是 apply 时的 process.cwd()——
//     DSH 宿主进程目录（profile 目录），用户跑它就把图存进了 profile\SD-Picture。
const injectTool = tools.get('sd_inject')
assert.ok(injectTool, 'sd_inject missing')
const injBase = fs.readdirSync(outDir).length
const inj = await injectTool.execute(
  {
    basePrompt: '1girl, solo, upper body, simple background',
    violationPrompts: 'nude, naked',
    suggestedPrompts: 'clothed, sfw',
  },
  exec,
)
assert.equal(inj.mode, '本地注入')
assert.equal(inj.generatesImage, false, 'sd_inject 不得生图')
assert.equal(inj.scriptPath, path.join(ws, 'sd-inject.ps1'))
assert.ok(inj.command.startsWith(`powershell -ExecutionPolicy Bypass -File "${path.join(ws, 'sd-inject.ps1')}"`), inj.command)
assert.ok(inj.command.includes(`-OutDir "${outDir}"`), `C 档命令必须显式注入工作区 -OutDir：${inj.command}`)
assert.ok(inj.command.includes('-BasePrompt "1girl, solo, upper body, simple background"'), inj.command)
assert.ok(inj.command.includes('-BaseNegative "lowres'), inj.command)
assert.ok(
  !inj.command.includes('(nsfw:1.6)') && !inj.command.includes('nudity'),
  `-BaseNegative 只能含画质底线，不得夹带违禁/安全类标签（用户红线）：${inj.command}`,
)
assert.ok(inj.asMarkdown.startsWith('【本地注入】\n```powershell'))
assert.ok(!inj.command.includes('profiles'), `C 档命令不得指向 profile 目录：${inj.command}`)
assert.equal(fs.readdirSync(outDir).length, injBase, 'sd_inject 只出命令，不落任何图')
console.log('sd_inject(C 档):', inj.command)

// 8) 真跑一遍可复现脚本：用 powershell.exe（PS5.1 语义）执行——
//    a) .ps1 必须带 UTF-8 BOM，否则 PS5.1 按 GBK 读中文注释会直接语法错（坑13）
//    b) -Seed 必须能吃 uint32（3845143617 > Int32.Max，用 [int] 会参数转换失败）
const EXEC_SEED = 3845143617
const beforeRun = fs.readdirSync(outDir)
const s3 = await tools.get('sd_script').execute(
  { prompt: '1girl, silver hair, masterpiece', seed: EXEC_SEED, steps: 8, name: 'scriptrun' },
  exec,
)
assert.ok(s3.command.includes(`-Seed ${EXEC_SEED}`), `命令必须携带 uint32 seed：${s3.command}`)
const run = spawnSync(`${s3.command} -NoOpen`, { shell: true, encoding: 'utf8', timeout: 180000 })
assert.equal(run.status, 0, `sd-direct.ps1 执行失败（status=${run.status}）\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
const made = fs.readdirSync(outDir).filter((f) => /^scriptrun_\d{3}\.png$/.test(f) && !beforeRun.includes(f))
assert.equal(made.length, 1, `脚本应产出一张 scriptrun_XXX.png，实际：${JSON.stringify(made)}`)
console.log('script ran:', path.join(outDir, made[0]))

// 9) sd_models：结构 + 画质诊断（新装只有 SD1.5 base 时必须给 qualityHint，模型正常的机器不给）
const m = JSON.parse(await tools.get('sd_models').execute({ section: 'all' }, exec))
assert.ok(Array.isArray(m.checkpoints) && m.checkpoints.length > 0, 'checkpoints 必须非空')
assert.ok(m.options && 'sd_model_checkpoint' in m.options, '必须返回当前生效选项')
const baseOnly = m.checkpoints.every((t) => /v1-5-pruned|v1-5\.ckpt|v1-4|sd-v1-/i.test(String(t)))
if (baseOnly) {
  assert.ok(
    typeof m.qualityHint === 'string' && m.qualityHint.includes('install-sd.ps1'),
    '只有 base 模型时必须返回 qualityHint 并指向 install-sd.ps1',
  )
} else {
  assert.equal(m.qualityHint, undefined, '模型正常的环境不该返回 qualityHint')
}
console.log('sd_models:', m.options, '| qualityHint:', m.qualityHint ? '有' : '无')

// 10) 蒙版重绘：maskBox 自动造蒙版 → 真跑一次 → 脚本必须带 -Mask
const inpaint = await tools.get('sd_inpaint').execute(
  {
    image: a.paths[0],
    maskBox: '160,40,200,200',
    prompt: 'pink flower crown, pink roses, masterpiece, best quality',
    denoisingStrength: 0.7,
    steps: 12,
    summary: '蒙版测试',
  },
  exec,
)
assert.equal(inpaint.script.mode, '蒙版重绘', '蒙版脚本标注应为【蒙版重绘】')
assert.ok(inpaint.mask && inpaint.mask.includes('mask_box'), `maskBox 应生成蒙版文件，实际：${inpaint.mask}`)
const maskBytes = fs.readFileSync(inpaint.mask)
assert.equal(maskBytes.readUInt32BE(0), 0x89504e47, '生成的蒙版必须是合法 PNG')
assert.ok(inpaint.script.command.includes('-Mask '), `蒙版脚本必须带 -Mask：${inpaint.script.command}`)
assert.ok(inpaint.script.command.includes('-InitImage'), '蒙版脚本必须带 -InitImage')
assert.ok(inpaint.script.command.includes('-MaskBlur'), '蒙版脚本应带 -MaskBlur 以便复现接缝效果')
assert.ok(inpaint.selfCheck && inpaint.selfCheck.includes('接缝'), '蒙版重绘必须返回接缝自检提醒')
assert.equal(fs.readdirSync(outDir).filter((f) => /^蒙版测试_\d{3}\.png$/.test(f)).length, 1, '蒙版重绘应产出一张图')
console.log('inpaint:', inpaint.fileNames, '| mask =', inpaint.mask)
console.log('script(ip):', inpaint.script.command)

console.log('ACCEPTANCE OK')
