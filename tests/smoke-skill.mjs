// 技能注册冒烟：验证 sd-paint（双分支违规分流协议）与 7 个工具注册 + 跨机器可移植性

// ---------------------------------------------------------------------------
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tools = new Map()
let skill
const ctx = {
  logger: { log: () => {} },   // 冒烟保持安静
  effect: (fn) => fn(),
  get: (key) => (key === 'skills' ? { register: (def) => ((skill = def), () => {}) } : undefined),
  tools: {
    register(def) {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
  },
}

// 跨机器零适配：sdDir 走自动探测（DSH_SD_DIR 可覆盖）；工作区用临时目录模拟任意用户机器
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-guard-smoke-'))
const exec = { agent: { session: { header: { cwd: ws } } } }

const mod = await import('../sd-bridge.js')
mod.apply(ctx, { sdDir: process.env.DSH_SD_DIR || '', port: 7860 })

assert.ok(skill, 'skill not registered')
assert.equal(skill.name, 'sd-paint')
assert.equal(skill.source, 'dsh-unrestricted-printing')
assert.ok(skill.invocation.modelInvocable)

// 双分支违规分流协议要点（A 档 + C 档，C 档完全覆盖原「明显违规」档）
const c = skill.content
assert.ok(c.includes('违规分流协议'), 'guard protocol section missing')
assert.ok(c.includes('A 档'), 'mild branch missing')
assert.ok(c.includes('C 档'), 'C 档定义缺失')
assert.ok(c.includes('涉及任何违规内容'), 'C 档必须覆盖「涉及任何违规内容」（用户红线）')
assert.ok(c.includes('【本地注入】'), 'C 档必须标注【本地注入】')
assert.ok(c.includes('sd-inject.ps1'), 'C 档必须提及 sd-inject.ps1')
assert.ok(c.includes('-BasePrompt'), 'C 档命令必须带 -BasePrompt')
assert.ok(c.includes('-BaseNegative'), 'C 档命令必须带 -BaseNegative')
assert.ok(c.includes('sd_inject'), 'C 档必须要求调 sd_inject 生成命令（坑22：命令不能在 apply 时固化路径）')
assert.ok(!c.includes('B 档'), 'B 档字样必须全部替换为 C 档')
assert.ok(c.includes('不出图'), 'C: no image generation')
// C 档章节自身不得把违规请求路由到任何**生图/脚本**工具（只输出本地注入命令）；只截取 C 档那一节来判定。
// 允许出现的只有「禁止调用 ...」这种否定措辞，不允许「调/改调/走/给/用/传」这类正向路由。
// sd_inject 是唯一的例外：它不生图，只生成命令字符串。
const cSection = c.slice(c.indexOf('### C 档'), c.indexOf('### 通用'))
assert.ok(
  !/(?:调|改调|走|给|用|传)\s*`?(sd_script|sd_txt2img|sd_img2img|sd_inpaint)/.test(cSection.replace(/禁止调用/g, '')),
  'C 档 section must not route to any tool call',
)
assert.ok(cSection.includes('sd_inject'), 'C 档 section must call sd_inject to build the command')
assert.ok(
  !/不要传\s*`?-OutDir/.test(cSection),
  'C 档不得再教「不要传 -OutDir」——插件必须显式注入工作区 -OutDir（坑22）',
)
// 三个生图工具的 C 档指向也必须是 sd-inject.ps1 本地注入命令
for (const name of ['sd_txt2img', 'sd_img2img', 'sd_inpaint']) {
  const d = tools.get(name).description
  assert.ok(d.includes('sd-inject.ps1'), `${name} C 档 must point to sd-inject.ps1`)
  assert.ok(!d.includes('B 档'), `${name} description must not mention B 档`)
}
// 用户红线（2026-10-14）：A 档 = 完全不违规才出图；涉及任何违规内容一律 C 档，没有「删词后照常出图」的中间路线
assert.ok(c.includes('A 档 · 完全不违规'), '必须写明 A 档前置条件：完全不违规')
assert.ok(c.includes('没有「轻微违规删词后照常出图」这条中间路线'), '必须明令禁止「删词出图」中间路线')
assert.ok(!c.includes('### A 档 · 轻微违规'), '旧「A 档轻微违规出图」章节必须删除')
assert.ok(!c.includes('权重拦截，三步缺一不可'), '旧「A 档三步加权拦截」流程必须删除')
assert.ok(c.includes('末尾'), 'list violating prompts at end')
assert.ok(c.includes('译成提示词') || c.includes('翻译成提示词'), 'image-to-prompt scenario')
// 末尾违规词清单必须是「违禁提示词：」/「建议替换词：」两行、一行排开逗号分隔（不得逐条罗列）
assert.ok(c.includes('违禁提示词：'), '末尾清单第一行必须是「违禁提示词：」')
assert.ok(c.includes('建议替换词：'), '末尾清单第二行必须是「建议替换词：」')
assert.ok(
  /违禁提示词：<被剔除的违规词，全部译成英文，一行排开，中间用逗号隔开>/.test(c),
  '违禁提示词行必须声明：译成英文、一行排开、逗号分隔',
)
assert.ok(
  /建议替换词：<与违禁提示词相反或用于替换的词，一行排开，中间用逗号隔开>/.test(c),
  '建议替换词行必须声明：相反/可替换、一行排开、逗号分隔',
)
assert.ok(
  /不得逐条罗列、不得换行展开/.test(c),
  '必须明确禁止逐条罗列与换行展开',
)
assert.ok(
  /两行都必须是「前缀 \+ 逗号分隔的一行词」/.test(c),
  '必须有两行硬性排版要求',
)

// sd-inject.ps1：素体基底参数 + 出图参数表单（翻译模型已按用户要求整段移除，提示词在表单里直接填）
const injectPs1 = fs.readFileSync(new URL('../sd-inject.ps1', import.meta.url), 'utf8')
assert.ok(injectPs1.includes('$BasePrompt'), 'sd-inject.ps1 必须定义 $BasePrompt')
assert.ok(injectPs1.includes('$BaseNegative'), 'sd-inject.ps1 必须定义 $BaseNegative')
assert.ok(!injectPs1.includes('追加正向提示词'), '翻译弹框已移除：不得再出现「追加正向提示词」弹框')
assert.ok(!injectPs1.includes('追加负向提示词'), '翻译弹框已移除：不得再出现「追加负向提示词」弹框')
// 表单流程：正向/负向多行文本框预填基底，所有参数一次填完
// 坑52：标签改为「正向提示词（基底 + 技术测试词已合并预填，可直接编辑）：」，前缀仍匹配
assert.ok(injectPs1.includes('正向提示词'), '表单必须有正向提示词文本框')
assert.ok(injectPs1.includes('负向提示词：'), '表单必须有负向提示词文本框')
assert.ok(/txtPos\.Text = \$Positive/.test(injectPs1), '正向文本框必须预填基底（-Positive 传入）')
assert.ok(/txtNeg\.Text = \$Negative/.test(injectPs1), '负向文本框必须预填基底（-Negative 传入）')
assert.ok(/Show-ParamForm -DefaultRounds \$paramFormRounds -HasBaseImage \$hasBaseImg -Positive \$formPositive -Negative \$formNegative/.test(injectPs1), '表单必须以素体基底预填提示词（已补末尾逗号）')
assert.ok(injectPs1.includes('确定出图'), '表单必须有「确定出图」按钮')
assert.ok(injectPs1.includes('取消'), '表单必须有「取消」出口')
// 翻译模型链路整段移除（用户要求）：不留 Start-QwenApi / 候选枚举 / 翻译弹框 / e-q 确认循环
for (const gone of ['Start-QwenApi', 'Test-QwenApi', 'Rank-QwenModels', 'Get-QwenCandidates', 'Strip-Cjk', 'QwenRetries', 'QwenDefaultModel', 'NoQwenStart', '输入 e 修改提示词，输入 q 退出', '生成最终提示词']) {
  assert.ok(!injectPs1.includes(gone), `翻译链路已移除：sd-inject.ps1 不得再出现 ${gone}`)
}
// 表单参数：迭代次数默认 3（质检不稳定时快速验证 + 多选）、画质最高 2160p（4K）
assert.ok(/\$paramFormRounds = 3/.test(injectPs1), '迭代次数默认必须为 3')
assert.ok(/'2160p（4K）' \{ \$short = 2160 \}/.test(injectPs1), '画质档必须支持 2160p（4K）')
assert.ok(/-gt 32\) \{ \$rounds = 32 \}/.test(injectPs1), '迭代次数上限必须放宽到 32')
// 脸部质检链路保留：VLM 探活 + 打分 + 素体迭代
assert.ok(/function Test-VlmApi/.test(injectPs1), '脸部质检 VLM 探活必须保留')
assert.ok(/function Test-FaceQuality/.test(injectPs1), '脸部质检打分必须保留')
assert.ok(/function Invoke-BaseIterate/.test(injectPs1), '素体自检迭代必须保留')
assert.ok(/OLLAMA_MODELS/.test(injectPs1), '枚举不到模型时必须点出 OLLAMA_MODELS 这个最常见根因')
assert.ok(!/`?\?`?\?/.test(injectPs1), 'sd-inject.ps1 不得使用 PS7 专有的 ?? 运算符（PS5.1 语法错）')
// 坑23 回归：PS5.1 把 CJK 字母也算变量名字符——「$var次」会被当成变量 $var次（未定义→空值），
// 屏幕上只剩「第1/」。所有包内 .ps1 都不允许出现「$变量 + 非 ASCII 字母」紧邻，必须写 ${变量}。
for (const scriptName of ['sd-inject.ps1', 'sd-direct.ps1', 'install-sd.ps1']) {
  const scriptText = fs.readFileSync(new URL(`../${scriptName}`, import.meta.url), 'utf8')
  const offenders = []
  // 只看代码行：整行注释里的示例（如本文件注释里的反例）不算违规
  const codeLines = scriptText.split(/\r?\n/).filter((line) => !/^\s*#/.test(line))
  for (const line of codeLines) {
    for (const m of line.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)([^\x00-\x7F])/g)) {
      if (/\p{L}/u.test(m[2])) offenders.push(`$${m[1]}${m[2]}`)
    }
  }
  assert.equal(offenders.length, 0, `${scriptName} 里变量名后紧邻中文必须写 \${变量}（坑23）：${offenders.join(', ')}`)
}
// 翻译链路已整段移除（用户要求）：相关的重试文案、原始回复诊断、system prompt、few-shot、坑25 断言一并退役
// 安全底噪 + 权重机制（反 NSFW 拦截）：删词不够，必须把类别词加权压进负向。
// 注意边界（用户红线）：加权安全底噪只属于插件正常出图路径（A 档）的 defaultNegative；
// C 档素体基底（INJECT_BASE_NEGATIVE 与 sd-inject.ps1 的 $BaseNegative 默认值）**只含画质底线**，
// 绝不夹带违禁/安全类标签——所以这里只断言 mod.DEFAULTS，并对 injectPs1 反向锁定。
// 2026-10-19：权重从 1.4-1.6 降到 0.3-0.4（实测 1.6 会把肤色质感/身体轮廓一起压掉，画面发灰发糊）
const SAFETY_TOKENS = ['(nsfw:0.4)', '(nudity:0.35)', '(nude:0.35)', '(explicit sexual content:0.3)', '(suggestive:0.3)']
for (const token of SAFETY_TOKENS) {
  assert.ok(mod.DEFAULTS.defaultNegative.includes(token), `默认负向必须带加权安全底噪 ${token}`)
  assert.ok(!injectPs1.includes(token), `sd-inject.ps1 的 $BaseNegative 默认值不得夹带违禁/安全类标签（C 档素体基底只留画质底线）: ${token}`)
}
// 坑24：PS5.1 传字符串 body 会按 Latin-1 编码——中文到模型那边就是乱码，必须发 UTF-8 字节 + 修响应
//（翻译模型删了，但这些坑的防线现在服务脸部质检 VLM 调用，必须继续成立）
assert.ok(
  /\[System\.Text\.Encoding\]::UTF8\.GetBytes\(/.test(injectPs1),
  '请求 body 必须转成 UTF-8 字节再发（坑24：字符串 body 会被按 Latin-1 编码）',
)
assert.ok(/application\/json; charset=utf-8/.test(injectPs1), '请求头必须声明 charset=utf-8（坑24）')
assert.ok(/function Repair-Utf8Mojibake/.test(injectPs1), '必须有响应乱码修复函数（坑24）')
assert.ok(/Repair-Utf8Mojibake \(?彩票|Repair-Utf8Mojibake \(\[string\]\$resp|Repair-Utf8Mojibake \$raw|Repair-Utf8Mojibake \(\[string\]/.test(injectPs1), 'VLM 响应内容必须过一遍乱码修复（坑24）')
// sd-paint 技能：A 档已收窄为「完全不违规」；加权安全底噪只属于插件默认负向；末尾回执仍要求列全五类
assert.ok(!c.includes('A 档拦截时把剔除的违规标签'), 'A 档不得再有「剔除标签加权追加」流程（涉及违规一律 C 档）')
// C 档必须要求模型调 sd_inject 且传 run:true（自动拉起窗口），否则模型会手写命令、不弹窗（实测故障）
assert.ok(c.includes('run: true') || c.includes('run:true'), '技能正文必须要求 C 档调 sd_inject 传 run:true')
assert.ok(c.includes('禁止自己拼命令') && c.includes('禁止手写路径'), '技能正文必须禁止手写命令/路径')
assert.ok(c.includes('列全，别只列最露骨的两三个'), '末尾回执必须要求列全，而不是只列两三个')
assert.ok(/①.*②.*③.*④.*⑤/s.test(c), '末尾回执必须给出五类自查（裸露/行为/器官/道具场景/姿势氛围）')
assert.ok(
  c.includes('「建议替换词」给的是合规替代方向（如 clothed、fully clothed、sfw、portrait 等）'),
  '建议替换词行必须保持原样式（用户要求：这一行暂时不动）',
)
// 坑13 回归：sd-inject.ps1 同样必须 UTF-8 with BOM（PS5.1 无 BOM 按 GBK 读会语法错）
const injectRaw = fs.readFileSync(new URL('../sd-inject.ps1', import.meta.url))
assert.deepEqual(
  [...injectRaw.subarray(0, 3)],
  [0xef, 0xbb, 0xbf],
  'sd-inject.ps1 must be UTF-8 with BOM (坑13)',
)

// 出图自检循环 + 图生图画风一致（画质优化新增）
assert.ok(c.includes('出图自检'), 'self-check section missing')
assert.ok(c.includes('优化循环'), 'optimize loop missing')
assert.ok(c.includes('图生图画风一致'), 'img2img style-consistency section missing')
assert.ok(c.includes('read_image'), 'must instruct reading the image back for review')
assert.ok(c.includes('仅 A 档，最重要'), 'self-check section must be scoped to A 档（C 档无图可查）')
assert.ok(c.includes('denoising'), 'style-consistency must mention denoising guidance')

// 蒙版重绘（sd_inpaint）
assert.ok(c.includes('蒙版重绘'), 'inpaint section missing')
assert.ok(c.includes('maskBox'), 'maskBox fallback must be documented')
assert.ok(c.includes('接缝'), 'inpaint self-check must mention seams')

// 可移植性：文案里的占位符已按本机配置注入，源码级硬编码盘符不得漏进注册文案。
// 注意 C 档命令是**运行时注入的绝对路径**（用户要照抄执行），允许出现真实路径，
// 但源码里不得写死——这条由「源码不含 D:\ 盘符」单独断言覆盖。
assert.ok(!c.includes('%OUT%') && !c.includes('%SD%') && !c.includes('%REF%') && !c.includes('%DIRECT%'), 'doc tokens must be replaced')
const bridgeSrc = fs.readFileSync(new URL('../sd-bridge.js', import.meta.url), 'utf8')
assert.ok(!/['"`][^'"`]*D:\\DSWorkPlace/.test(bridgeSrc), 'sd-bridge.js 源码不得写死工作区盘符')
// 坑22 回归：C 档命令的路径**不能在 apply 时固化**（技能全局注册，apply 时只有
// process.cwd() = DSH 宿主进程目录 / profile 目录）。命令必须由 sd_inject 在调用时
// 按 sessionCwd(exec) 生成，并且显式带 -OutDir 工作区路径。
// 反面样本（实测踩过）：技能里写死 powershell ... -File "...\profiles\desktop\sd-inject.ps1"，
// 用户跑它时 sd-inject.ps1 的默认 OutDir = $PSScriptRoot\SD-Picture = profile\SD-Picture。
const skillCmdPath = /powershell -ExecutionPolicy Bypass -File "([^"]+)"/.exec(c)
assert.ok(skillCmdPath, '技能里应保留一段形态示例命令')
const examplePath = skillCmdPath[1]
assert.ok(
  examplePath.includes('<工作区>') || path.resolve(examplePath).startsWith(path.resolve(ws)),
  `技能里的示例命令不得固化真实机器路径（坑22），实际：${examplePath}`,
)
const inject = tools.get('sd_inject')
assert.ok(inject, 'sd_inject missing（C 档命令生成器）')
assert.equal(inject.output.schema.properties.generatesImage.type, 'boolean')
assert.ok(inject.description.includes('不生成任何图片'), 'sd_inject 必须声明不出图')

const inj = await inject.execute({ basePrompt: '1girl, solo, upper body, simple background', violationPrompts: 'nude, naked', suggestedPrompts: 'clothed, sfw' }, exec)
assert.equal(inj.mode, '本地注入')
assert.equal(inj.generatesImage, false, 'sd_inject 不得生图')
assert.ok(
  inj.command.startsWith(`powershell -ExecutionPolicy Bypass -File "${path.join(ws, 'sd-inject.ps1')}"`),
  `C 档命令必须引用会话工作区里的 sd-inject.ps1：${inj.command}`,
)
assert.ok(
  inj.command.includes(`-OutDir "${path.join(ws, 'SD-Picture')}"`),
  `C 档命令必须显式注入工作区 -OutDir：${inj.command}`,
)
assert.equal(inj.scriptPath, path.join(ws, 'sd-inject.ps1'))
assert.equal(inj.outDir, path.join(ws, 'SD-Picture'))
assert.ok(fs.existsSync(inj.scriptPath), `C 档命令引用的 sd-inject.ps1 必须真实存在：${inj.scriptPath}`)
assert.ok(inj.asMarkdown.startsWith('【本地注入】\n```powershell'), inj.asMarkdown.slice(0, 40))
assert.ok(inj.command.includes('-BasePrompt "1girl, solo, upper body, simple background"'), inj.command)
assert.ok(inj.command.includes('-BaseNegative "'), '默认素体负向必须带上')
assert.ok(
  !inj.command.includes('(nsfw:0.4)') && !inj.command.includes('nudity'),
  `sd_inject 生成的 -BaseNegative 只能含画质底线，不得夹带违禁/安全类标签（用户红线）：${inj.command}`,
)
// v0.9.18：默认允许冷启动本地视觉模型；插件设置 vlmAutoStart=false 时必须显式追加 -NoVlmStart
assert.ok(!inj.command.includes('-NoVlmStart'), `默认（vlmAutoStart=true）不得带 -NoVlmStart：${inj.command}`)
assert.ok(!inj.command.includes('-NoVlmReview'), `默认（vlmReview=true）不得带 -NoVlmReview：${inj.command}`)
assert.ok(inj.command.includes('-Width 512') && inj.command.includes('-Height 768'), inj.command)
assert.ok(inj.command.includes('-Name "inject"'), inj.command)
// 不传 basePrompt 时用素体兜底（默认 "1girl, solo"，见 sd-bridge.js 与 sd-inject.ps1 的 $BasePrompt 默认值）
const inj2 = await inject.execute({ violationPrompts: 'nude', suggestedPrompts: 'clothed' }, exec)
assert.ok(
  inj2.command.includes('-BasePrompt "1girl, solo"'),
  `留空必须用素体基底兜底：${inj2.command}`,
)
// 反面：命令里的脚本路径与产物目录都不能落在 process.cwd()（= 宿主 profile 目录）里
const hostCwd = path.resolve(process.cwd())
assert.ok(!inj.outDir.startsWith(hostCwd + path.sep) || path.resolve(ws).startsWith(hostCwd + path.sep),
  `产物目录不得落在宿主进程目录：${inj.outDir}`)

// sd-inject.ps1 的默认 OutDir 必须是 $PSScriptRoot（脚本所在目录），不能是 Get-Location
const injectSrc = fs.readFileSync(new URL('../sd-inject.ps1', import.meta.url), 'utf8')
assert.ok(
  /\$OutDir = Join-Path \$PSScriptRoot "SD-Picture"/.test(injectSrc),
  'sd-inject.ps1 默认 OutDir 必须是脚本所在目录下的 SD-Picture（不能是 Get-Location）',
)
assert.ok(
  !/Join-Path \(Get-Location\)/.test(injectSrc),
  'sd-inject.ps1 不得用 Get-Location 解析 OutDir（会随运行目录漂移）',
)

// 十二个工具（九件套 + 一键炼制 LoRA 三件：提交 / 查询 / 清单）
assert.deepEqual(
  [...tools.keys()],
  [
    'sd_txt2img', 'sd_img2img', 'sd_inpaint', 'sd_script', 'sd_script_b', 'sd_inject',
    'sd_models', 'sd_server', 'sd_integrity',
    'sd_train_lora', 'sd_train_official', 'sd_train_status', 'sd_lora_list',
  ],
)

// sd_train_lora：一键炼制（**名字可自定义** + 双轨 + 只提交不阻塞）
const loraTrain = tools.get('sd_train_lora')
assert.ok(loraTrain, 'sd_train_lora missing')
assert.ok(loraTrain.parameters.required.includes('sources'), 'sources 必须是必填')
for (const k of ['name', 'idName', 'baseName', 'idSources', 'baseSources', 'tracks', 'captionMode', 'bannedTokens', 'preview']) {
  assert.ok(loraTrain.parameters.properties[k], `sd_train_lora 缺参数 ${k}`)
}
assert.ok(loraTrain.description.includes('名字可自定义'), '描述必须点明名字可自定义')
assert.ok(loraTrain.description.includes('xxx_id') && loraTrain.description.includes('xxx_base'), '要说明两轨命名规则')
assert.ok(loraTrain.description.includes('sd_train_status'), '要引导用 sd_train_status 查进度')
assert.ok(loraTrain.description.includes('preview'), '要引导先看计划')
assert.ok(!loraTrain.description.includes('D:\\DSWorkPlace') && !loraTrain.description.includes('%SD%'), '描述必须可移植')

// sd_train_status：可列任务、可查单条、失败要能带日志尾部
const loraStatus = tools.get('sd_train_status')
assert.ok(loraStatus, 'sd_train_status missing')
assert.ok(loraStatus.parameters.properties.job && loraStatus.parameters.properties.name && loraStatus.parameters.properties.list, 'job/name/list 参数必须在')
assert.ok(loraStatus.description.includes('日志尾部'), '描述要说明会带日志尾部')

// sd_lora_list：清单 + 双轨权重策略（Base 硬上限 0.7）
const loraList = tools.get('sd_lora_list')
assert.ok(loraList, 'sd_lora_list missing')
assert.ok(loraList.description.includes('0.3–0.7'), '必须写明 Base 可调区间')
assert.ok(loraList.description.includes('上限 0.7'), '必须写明 Base 硬上限')
assert.ok(loraList.description.includes('<lora:名字:权重>'), '必须给出调用语法形态')

// sd_inpaint：蒙版来源二选一 + 蒙版参数 + 自检提醒
const ip = tools.get('sd_inpaint')
assert.ok(ip, 'sd_inpaint missing')
assert.ok(ip.description.includes('蒙版'), 'sd_inpaint description must mention mask')
assert.ok(ip.parameters.properties.mask && ip.parameters.properties.maskBox, 'mask 与 maskBox 必须都在参数表里')
assert.ok(ip.parameters.properties.denoisingStrength, 'denoisingStrength missing')
assert.ok(ip.output.schema.properties.selfCheck, 'sd_inpaint must return selfCheck')
assert.equal(ip.output.schema.properties.script.properties.mode.enum[0], '蒙版重绘')

// 生图工具描述带新分流协议（A 档仅限完全不违规 / 涉及违规一律 C 档）+ 无占位符残留
for (const name of ['sd_txt2img', 'sd_img2img']) {
  const d = tools.get(name).description
  assert.ok(d.includes('完全不违规') && d.includes('sd_inject'), `${name} must route any violation to C 档`)
  assert.ok(!d.includes('轻微违规'), `${name} 不得再保留「轻微违规出图」分支（用户红线）`)
  assert.ok(d.includes('sd-inject.ps1'), `${name} C 档 must point to sd-inject.ps1`)
  assert.ok(!d.includes('B 档'), `${name} description must not mention B 档`)
  assert.ok(d.includes('read_image'), `${name} must require image self-review`)
  assert.ok(!d.includes('D:\\DSWorkPlace') && !d.includes('%OUT%') && !d.includes('%SD%'), `${name} description must be portable (runtime-injected real paths are fine)`)
  assert.ok(tools.get(name).output.schema.properties.script)
  assert.ok(tools.get(name).output.schema.properties.selfCheck, `${name} must return selfCheck hint`)
}

// sd_script：只生成命令、不出图
const st = tools.get('sd_script')
assert.ok(st, 'sd_script missing')
assert.ok(st.description.includes('不生成任何图片'))
assert.ok(st.parameters.properties.prompt)
assert.equal(st.output.schema.properties.generatesImage.type, 'boolean')

// sd_script 纯函数执行（不联网）：脚本路径与输出目录都指向当前会话工作区
const out = await st.execute({ prompt: '1girl, white sheet, soft light', initImage: 'ref/a.jpg', denoising: 0.65 }, exec)
assert.equal(out.mode, '图生图')
assert.equal(out.generatesImage, false)
assert.ok(out.command.includes('-InitImage') && out.command.includes('-Denoising'))
assert.ok(out.command.startsWith(`powershell -ExecutionPolicy Bypass -File "${path.join(ws, 'sd-direct.ps1')}"`), `command must use workspace script: ${out.command}`)
assert.ok(out.command.includes(`-OutDir "${path.join(ws, 'SD-Picture')}"`), 'command must inject -OutDir into the workspace')
assert.ok(out.asMarkdown.startsWith('【图生图】\n```powershell'))
const t2 = await st.execute({ prompt: '1girl, silver hair', width: 640, height: 960, name: 'shorekeeper' }, exec)
assert.equal(t2.mode, '文生图')
assert.ok(t2.command.includes('-Width 640') && t2.command.includes('-Name "shorekeeper"'))
assert.ok(st.description.includes('sd_script_b'), 'sd_script must point to sd_script_b for dual-version alignment')

// sd_script_b：双版本逐位置对齐（纯函数、不联网）——prompt 保序留正向，original 的差异词进负向
const sb = tools.get('sd_script_b')
assert.ok(sb, 'sd_script_b missing')
assert.ok(sb.description.includes('不生成任何图片'))
// originalPrompt 已改为可选（插件可自动提取兜底），prompt 仍必填
assert.deepEqual(sb.parameters.required, ['prompt'])
assert.equal(sb.output.schema.properties.generatesImage.type, 'boolean')
assert.ok(sb.output.schema.properties.positivePrompt && sb.output.schema.properties.negativePrompt, 'sd_script_b must return positive/negative for review')
// originalSource 必须存在，且三态可枚举（标记 originalPrompt 的来源，便于排查）
assert.ok(sb.output.schema.properties.originalSource, 'sd_script_b must return originalSource')
assert.deepEqual(sb.output.schema.properties.originalSource.enum, ['explicit', 'extracted', 'fallback'])

const al = await sb.execute(
  { originalPrompt: '1girl, red dress, beach, sunset', prompt: '1girl, red dress rewritten, beach, sunset', negativePrompt: 'lowres', seed: 42 },
  exec,
)
assert.equal(al.positivePrompt, '1girl, red dress rewritten, beach, sunset', '当前版本（prompt）必须保序留在正向')
assert.equal(al.negativePrompt, 'red dress, lowres', 'original 的差异词 + negativePrompt 必须进负向')
assert.ok(al.command.includes('-Prompt "1girl, red dress rewritten, beach, sunset"'), al.command)
assert.ok(al.command.includes('-Negative "red dress, lowres"'), al.command)
assert.equal(al.mode, '文生图')
assert.equal(al.generatesImage, false)
assert.equal(al.originalSource, 'explicit', '显式传入 originalPrompt → explicit')

// extractOriginalInput：从会话上下文提取最近一条用户消息原文（纯字段读取，失败静默返回 ''）
assert.equal(typeof mod.extractOriginalInput, 'function', 'extractOriginalInput must be exported')
assert.equal(
  mod.extractOriginalInput({
    agent: { session: { messages: [
      { role: 'user', content: '画一个银发少女' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '改成樱花背景' },
    ] } },
  }),
  '改成樱花背景',
  'must pick the LAST user message',
)
assert.equal(
  mod.extractOriginalInput({ agent: { session: { header: { originalInput: '画一张赛博朋克街景' } } } }),
  '画一张赛博朋克街景',
  'must fall back to header.originalInput',
)
// 提取不到（无 messages、无 header.originalInput）→ 空串，调用方维持现状
assert.equal(mod.extractOriginalInput({ agent: { session: { header: { cwd: ws } } } }), '')
assert.equal(mod.extractOriginalInput(undefined), '')
assert.equal(mod.extractOriginalInput({}), '')
// messages 形状异常 → 静默失败，不抛异常
assert.equal(mod.extractOriginalInput({ agent: { session: { messages: [null, { role: 'user' }, 42] } } }), '')

// originalPrompt 留空 + 会话历史有 user 消息 → 自动提取作为对齐基准（extracted）
const execWithHistory = {
  agent: { session: { header: { cwd: ws }, messages: [
    { role: 'user', content: '1girl, white sheet, soft light, masterpiece' },
  ] } },
}
const ex = await sb.execute({ prompt: '1girl, blue silk sheet, soft light, masterpiece', negativePrompt: 'lowres' }, execWithHistory)
assert.equal(ex.originalSource, 'extracted', '留空 + 提取成功 → extracted')
assert.equal(ex.positivePrompt, '1girl, blue silk sheet, soft light, masterpiece')
assert.equal(ex.negativePrompt, 'white sheet, lowres', '提取到的原文的差异词进负向')
// 提取不到（无会话历史）→ fallback，退化为全部保留正向，不抛异常
const fb = await sb.execute({ prompt: '1girl, silver hair' }, exec)
assert.equal(fb.originalSource, 'fallback', '取不到原始输入 → fallback')
assert.equal(fb.positivePrompt, '1girl, silver hair')
assert.equal(fb.negativePrompt, '')

// 仅 original 非空的位置补进正向；仅 prompt 多出来的标签也保留正向
const al2 = await sb.execute({ originalPrompt: 'a, b, c', prompt: 'a, b' }, exec)
assert.equal(al2.positivePrompt, 'a, b, c')
assert.equal(al2.negativePrompt, '')
const al3 = await sb.execute({ originalPrompt: 'a, b', prompt: 'a, b, c' }, exec)
assert.equal(al3.positivePrompt, 'a, b, c')
assert.ok(!al3.command.includes('-Negative'), '负向为空时命令不写 -Negative')

// 只传 prompt（originalPrompt 留空）且会话无历史 → fallback：退化为全部保留正向
const al4 = await sb.execute({ prompt: '1girl, silver hair' }, exec)
assert.equal(al4.originalSource, 'fallback')
assert.equal(al4.positivePrompt, '1girl, silver hair')

// 图生图：参考图参数 + denoising 默认 0.7
const al5 = await sb.execute({ originalPrompt: '1girl, white sheet', prompt: '1girl, white sheet', initImage: 'ref/a.jpg', denoising: 0.65 }, exec)
assert.equal(al5.mode, '图生图')
assert.ok(al5.command.includes('-InitImage') && al5.command.includes('-Denoising 0.65'), al5.command)
assert.ok(al5.command.startsWith(`powershell -ExecutionPolicy Bypass -File "${path.join(ws, 'sd-direct.ps1')}"`), al5.command)
assert.ok(al5.command.includes(`-OutDir "${path.join(ws, 'SD-Picture')}"`), al5.command)
assert.ok(al5.asMarkdown.startsWith('【图生图】\n```powershell'))
const al6 = await sb.execute({ originalPrompt: 'x', prompt: 'x', initImage: 'ref/a.jpg' }, exec)
assert.ok(al6.command.includes('-Denoising 0.7'), `denoising 默认必须 0.7：${al6.command}`)

// 蒙版重绘：mask 优先 / maskBox 现场造蒙版 / 缺 initImage 直接报错（模式与参数跟 sd_inpaint 对齐）
assert.equal(sb.output.schema.properties.mode.enum[2], '蒙版重绘')
assert.ok(sb.parameters.properties.mask && sb.parameters.properties.maskBox, 'mask 与 maskBox 必须都在参数表里')
const demoImg = fileURLToPath(new URL('../docs/assets/demo-txt2img.jpg', import.meta.url))
const m1 = await sb.execute(
  { originalPrompt: '1girl, white sheet', prompt: '1girl, white sheet', initImage: demoImg, mask: demoImg },
  exec,
)
assert.equal(m1.mode, '蒙版重绘')
assert.ok(m1.command.includes('-Mask ') && m1.command.includes('-InitImage'), m1.command)
assert.ok(m1.command.includes('-MaskBlur 4') && m1.command.includes('-InpaintFill 0') && m1.command.includes('-InpaintPadding 32'), m1.command)
assert.ok(m1.asMarkdown.startsWith('【蒙版重绘】\n```powershell'))
assert.ok(m1.mask.includes(`${path.sep}ref${path.sep}`), `mask 应固化到工作区 ref\\：${m1.mask}`)
const m2 = await sb.execute(
  { originalPrompt: '1girl, white sheet', prompt: '1girl, blue sheet', initImage: demoImg, maskBox: '10,10,60,40' },
  exec,
)
assert.equal(m2.mode, '蒙版重绘')
assert.ok(/^mask_box_10_10_60_40_\d+x\d+\.png$/.test(path.basename(m2.mask)), `maskBox 生成的蒙版命名异常：${m2.mask}`)
assert.ok(fs.existsSync(m2.mask), 'maskBox 生成的蒙版必须落盘')
assert.ok(m2.command.includes(`-Mask "${m2.mask}"`), m2.command)
assert.equal(m2.positivePrompt, '1girl, blue sheet')
assert.equal(m2.negativePrompt, 'white sheet')
await assert.rejects(
  () => sb.execute({ originalPrompt: 'a', prompt: 'a', maskBox: '1,1,4,4' }, exec),
  /必须同时给 initImage/,
  'maskBox 缺 initImage 必须报错',
)

// 外部词表（-TermFile）：命令必须含 -TermFile，占位符原样保留（插件不替换）
const tf = await sb.execute(
  {
    originalPrompt: '1girl, dress, beach',
    prompt: '1girl, __TERM_A__, beach',
    width: 512,
    height: 768,
  },
  exec,
)
assert.ok(tf.command.includes('-TermFile'), '命令必须包含 -TermFile 参数')
assert.ok(tf.command.includes('__TERM_A__'), '占位符必须原样进命令，插件不得替换')
assert.ok(tf.termFile, '输出必须带 termFile 路径')
assert.ok(tf.termFile.startsWith(path.join(ws, 'SD-Picture')), `termFile 默认落在输出目录下：${tf.termFile}`)
assert.ok(/terms_\d+\.json$/.test(tf.termFile), `termFile 命名必须为 terms_<时间戳>.json：${tf.termFile}`)
assert.ok(tf.command.includes(`-TermFile "${tf.termFile}"`), tf.command)
assert.ok(tf.positivePrompt === '1girl, __TERM_A__, beach', '正向提示词必须保留占位符原样')
assert.ok(sb.output.schema.properties.termFile, 'sd_script_b 输出 schema 必须声明 termFile')
assert.ok(sb.parameters.properties.termFile, 'sd_script_b 参数表必须声明 termFile')
// 显式传入的 termFile 必须原样使用
const tf2 = await sb.execute({ prompt: 'a, __X__', termFile: 'D:\\wherever\\my-terms.json' }, exec)
assert.ok(tf2.command.includes('-TermFile "D:\\wherever\\my-terms.json"'), tf2.command)
assert.equal(tf2.termFile, 'D:\\wherever\\my-terms.json')

// sd-direct.ps1 必须定义 $TermFile 参数并做替换
const ps1 = fs.readFileSync(new URL('../sd-direct.ps1', import.meta.url), 'utf8')
assert.ok(ps1.includes('$TermFile'), 'sd-direct.ps1 必须定义 $TermFile 参数')
assert.ok(ps1.includes('.Replace($key, $val)'), 'sd-direct.ps1 必须按词表做字符串替换')
// 坑13 回归：.ps1 必须 UTF-8 with BOM（PS5.1 无 BOM 按 GBK 读会语法错），也不能是 UTF-16 LE
const ps1Raw = fs.readFileSync(new URL('../sd-direct.ps1', import.meta.url))
assert.deepEqual(
  [...ps1Raw.subarray(0, 3)],
  [0xef, 0xbb, 0xbf],
  'sd-direct.ps1 must be UTF-8 with BOM (坑13: PS5.1 reads BOM-less files as GBK → syntax errors)',
)
assert.ok(!ps1Raw.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])), 'sd-direct.ps1 must not be UTF-16 LE')

// 工作区脚本必须真实存在（自愈同步）
assert.ok(fs.existsSync(path.join(ws, 'sd-direct.ps1')), 'sd-direct.ps1 must sync into the session workspace')
// C 档本地注入命令引用的 sd-inject.ps1 也必须同步进工作区
assert.ok(fs.existsSync(path.join(ws, 'sd-inject.ps1')), 'sd-inject.ps1 must sync into the session workspace')
const wsInject = fs.readFileSync(path.join(ws, 'sd-inject.ps1'))
assert.deepEqual([...wsInject.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'synced sd-inject.ps1 must be UTF-8 with BOM')
assert.ok(wsInject.toString('utf8').includes('正向提示词'), 'synced sd-inject.ps1 must be the merged-form version（表单一次填完）')
// 同步进工作区的那一份也必须是 UTF-8 with BOM（否则用户复制命令去跑会踩坑13）
const wsRaw = fs.readFileSync(path.join(ws, 'sd-direct.ps1'))
assert.deepEqual([...wsRaw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'synced sd-direct.ps1 must be UTF-8 with BOM')

// DEFAULTS 可移植：无任何写死盘符
const d = mod.DEFAULTS
assert.equal(d.sdDir, '', 'sdDir default must be empty (auto-detect)')
assert.ok(!/^[A-Za-z]:/.test(d.outputDir) && !/^[A-Za-z]:/.test(d.refDir), 'output/ref defaults must be workspace-relative')

// ---------------------------------------------------------------------------
// C 档选项表（A 档出图后必贴）+ 用户自调画风 + 触发话术（0.9.7）
// ---------------------------------------------------------------------------
const quickText = mod.buildQuickOptions ? mod.buildQuickOptions() : ''
assert.ok(quickText.includes('C 档选项表'), 'quickOptions 文本必须自带「C 档选项表」标题')
// 2026-10-16（用户要求）：画风不再列在选项表里 —— 它由 C 档表单档位直接写进正向提示词框。
assert.ok(!/^\| 画风 \|/m.test(quickText), 'C 档选项表不得再有「画风」行（画风写在正向提示词里）')
assert.ok(!quickText.includes('★'), '用户自调画风的 ★ 标记不再出现在选项表里')
assert.ok(quickText.includes('画风不在本表里'), 'C 档选项表必须说明画风去哪了（正向提示词框）')
assert.ok(quickText.includes('比例') && quickText.includes('画质') && quickText.includes('LoRA') && quickText.includes('模型'), 'C 档选项表必须覆盖 比例/画质/LoRA/模型')
assert.ok(quickText.includes('Denoising') && quickText.includes('迭代'), 'C 档选项表必须覆盖 Denoising 与迭代次数')
for (const name of ['sd_txt2img', 'sd_img2img', 'sd_inpaint']) {
  assert.ok(tools.get(name).output.schema.properties.quickOptions, `${name} 输出 schema 必须声明 quickOptions（A 档出图后贴到图片下方）`)
}

// 技能正文：C 档选项表章节 + 触发话术
assert.ok(c.includes('C 档选项表'), '技能正文必须有「C 档选项表」章节（A 档出图后必贴）')
assert.ok(c.includes('quickOptions'), '技能正文必须点名 quickOptions 字段')
assert.ok(/majicMIX \+ 3:4/.test(c) || /再来一张/.test(c), '技能正文必须给出「一句话改参数重出图」的用法示例（画风已移出选项表）')
assert.ok(c.includes('打开SD插件'), '技能正文必须写明触发话术「打开SD插件」')
assert.ok(c.includes('用SD插件绘制'), '技能正文必须写明触发话术「用SD插件绘制」')
assert.ok(/★ 用户自调/.test(c) || /★用户自调/.test(c), '技能正文必须标出 ★ 用户自调画风')

// C 档参数表单（sd-inject.ps1）：用户自调画风进入画风下拉 + Get-StylePrompt 映射
assert.ok(injectPs1.includes('写实二次元·东亚脸'), 'sd-inject.ps1 画风下拉必须含用户自调画风「写实二次元·东亚脸」')
assert.ok(injectPs1.includes('釉彩调色盘'), 'sd-inject.ps1 画风下拉必须含用户自调画风「釉彩调色盘」')
assert.ok(injectPs1.includes('slender oval face') && injectPs1.includes('beautiful detailed almond eyes'), '「写实二次元·东亚脸」配方必须写进 Get-StylePrompt')
assert.ok(injectPs1.includes('釉彩·麻袋调色盘_v1.0'), '「釉彩调色盘」必须挂上本机 LoRA 全名')
assert.ok(/\$P\.Style -in @\('写实二次元', '写实二次元·东亚脸'\)/.test(injectPs1), '东亚脸画风必须复用「不切模型 + 半写实 LoRA」路径')

// ---------------------------------------------------------------------------
// 画风映射完整性回归（2026-10-15「二次元画风画不出来」事故）：
// ① 下拉里的每个画风都必须有 Get-StylePrompt 分支（只有「保持画风」允许是空映射，这是它的语义）；
// ② 「二次元」必须有正向词（当时就是这一档整个没有分支 → 选了等于没选）；
// ③ 「二次元」必须有切回动漫底的模型规则（画风切模型是持久的，不切回来就会停在写实底上出图）。
// ---------------------------------------------------------------------------
const styleListMatch = injectPs1.match(/foreach \(\$s in @\(([^)]*)\)\) \{ \$null = \$cboStyle\.Items\.Add\(\$s\) \}/)
assert.ok(styleListMatch, '画风下拉清单必须可解析（foreach ($s in @(...)) 形式）')
const dropdownStyles = [...styleListMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
assert.ok(dropdownStyles.length >= 10, `画风下拉清单过短：${dropdownStyles.join(', ')}`)

const styleFnMatch = injectPs1.match(/function Get-StylePrompt \{[\s\S]*?\n\}/)
assert.ok(styleFnMatch, 'Get-StylePrompt 函数必须存在')
const mappedStyles = [...styleFnMatch[0].matchAll(/^\s{8}'([^']+)'/gm)].map((m) => m[1])
const intentionallyEmpty = new Set(['保持画风'])
for (const style of dropdownStyles) {
  assert.ok(
    mappedStyles.includes(style) || intentionallyEmpty.has(style),
    `画风「${style}」在下拉里但没有 Get-StylePrompt 映射（选了等于没选）——已知事故：二次元`,
  )
}
const animeCase = styleFnMatch[0].match(/'二次元'\s*\{([\s\S]*?)\n\s{8}\}/)
assert.ok(animeCase, 'Get-StylePrompt 必须有「二次元」分支')
assert.ok(/anime style/.test(animeCase[1]), '「二次元」分支必须给出动漫正向词（anime style / lineart 一类）')
assert.ok(/cel shading/.test(animeCase[1]), '「二次元」分支必须写明赛璐璐平涂（cel shading）')
assert.ok(/function Get-AnimeCheckpoint/.test(injectPs1), '必须有动漫底 checkpoint 选择函数 Get-AnimeCheckpoint')
assert.ok(/\$P\.Style -eq '二次元' -and -not \$formCheckpoint/.test(injectPs1), '「二次元」必须有切回动漫底的模型规则')
assert.ok(/AWPainting\|awpainting/.test(injectPs1), '动漫底选择必须优先 AWPainting（本机动漫默认）')
assert.ok(/function Test-RealisticCheckpoint/.test(injectPs1), '必须有写实底判定（写实二次元在当前底是写实向时先切回动漫底）')
assert.ok(/function Get-SdCurrentModel/.test(injectPs1), '必须能读到真实当前模型（表单首项要显示它，避免「看着二次元其实在写实底上」）')
assert.ok(/function Add-StyleWords/.test(injectPs1) && /function Remove-StyleWords/.test(injectPs1), '画风词注入/剥离必须走净化函数（防止反复切换堆出 ",,"）')

// ---------------------------------------------------------------------------
// 决策树 C-0 / C-1a / C-1b（2026-10-15「换衣服结果画风也变了」）：
// 表单要有 模式（文生图/图生图）+ 蒙版（区域）两个开关；画风/模型要有「一致」档；
// 脚本要有参考图解析链（PNG 元数据 → VLM → A1111 反推）、区域蒙版生成、替换目标识别、一致性合并；
// 最终出图必须能把蒙版传给 sd-direct（-Mask / -InpaintFill）。
// ---------------------------------------------------------------------------
assert.ok(/foreach \(\$m in @\('文生图', '图生图'\)\) \{ \$null = \$cboMode\.Items\.Add\(\$m\) \}/.test(injectPs1), '表单必须有「模式」下拉（文生图 / 图生图）')
assert.ok(/\$cboMode\.Add_SelectedIndexChanged/.test(injectPs1), '模式切换必须联动（图生图 → 画风一致 + denoising 0.45）')
// 2026-10-19 变更（用户要求）：预设几何区域已从下拉移除，一律走视觉抠图；只保留 自动 / 手绘 / 无 三档。
assert.ok(/foreach \(\$v in @\('自动（按图内容抠图）', '手动绘制（鼠标涂抹）', '无（整图重绘）'\)\) \{ \$null = \$cboMask\.Items\.Add\(\$v\) \}/.test(injectPs1), '蒙版下拉必须是 自动抠图 / 手动绘制 / 无 三档（几何区域已移除）')
assert.ok(/'一致（自动检测参考图）'/.test(injectPs1), '画风下拉必须有「一致（自动检测参考图）」档')
assert.ok(/cboModel\.Items\.Add\('一致（照参考图）'\)/.test(injectPs1), '模型下拉必须有「一致（照参考图）」档')
assert.ok(/function Get-PngGenParams/.test(injectPs1), '必须能读参考图的 A1111 PNG 元数据（模型一致/画风一致的依据）')
assert.ok(/-shl 24/.test(injectPs1), 'PNG chunk 长度必须按大端解析（小端会读出垃圾长度）')
assert.ok(/function Get-ImageTags/.test(injectPs1), '必须有 A1111 反推（deepdanbooru/clip）')
assert.ok(/function Get-ImageStyleByVlm/.test(injectPs1), '必须有本地视觉模型判画风（可选增强）')
assert.ok(/function New-RegionMask/.test(injectPs1), '必须有区域蒙版生成')
assert.ok(/function Get-ReplaceTarget/.test(injectPs1), '必须能识别替换目标（衣服/脸/背景）')
assert.ok(/function Merge-ConsistencyPrompt/.test(injectPs1), '必须能把参考图词并入提示词并剥掉冲突标签')
assert.ok(/Invoke-FinalIterate -InitImage \$finalInit -Denoising \$finalDenoise -Rounds \$P\.Rounds -W \$size\.W -H \$size\.H -Checkpoint \$formCheckpoint -Mask \$finalMask -InpaintFill \$inpaintFill/.test(injectPs1), '最终出图必须把蒙版与填充模式传给迭代函数')
assert.ok(/\[string\]\$Mask = ""/.test(injectPs1) && /"-Mask", "`"\$Mask`"", "-InpaintFill"/.test(injectPs1), 'Invoke-FinalIterate 必须把 -Mask/-InpaintFill 传给 sd-direct')
assert.ok(/\$inpaintFill = 0\s+# 填充模式/.test(injectPs1), '蒙版重绘默认必须用 fill=0 填充（实测 fill=2 潜空间噪声会在蒙版区留噪点）')
assert.ok(injectPs1.includes('决策 C-0') && injectPs1.includes('C-1a') && injectPs1.includes('C-1b'), '脚本必须打印决策分支（C-0 / C-1a / C-1b）')
assert.ok(c.includes('C-1b') && c.includes('蒙版重绘'), '技能正文必须写明决策树与蒙版重绘分支')
// 对话判断任务类型 + 提交蒙版区域（v0.9.13）：工具参数 → 命令/启动器 → 表单预置；文生图锁底图/蒙版
assert.ok(/task: \{/.test(bridgeSrc) && /refImage: \{/.test(bridgeSrc) && /mask: \{/.test(bridgeSrc), 'sd_inject 必须有 task / refImage / mask 三个参数（由对话判断后提交）')
assert.ok(/'文生图', '图生图'/.test(bridgeSrc), 'task 参数必须是「文生图 / 图生图」枚举')
assert.ok(/parts\.push\('-Mode'/.test(bridgeSrc) && /parts\.push\('-MaskSpec'/.test(bridgeSrc) && /parts\.push\('-InitImage'/.test(bridgeSrc), '生成的命令必须带上 -Mode / -InitImage / -MaskSpec')
assert.ok(/paramPairs\.push\('-Mode'/.test(bridgeSrc) && /paramPairs\.push\('-MaskSpec'/.test(bridgeSrc), '启动器必须带上 -Mode / -MaskSpec')
assert.ok(c.includes('对话要自己判断任务类型') && c.includes('refImage'), '技能正文必须要求对话自己判断任务类型并提交 refImage/mask')
assert.ok(/\[string\]\$Mode = ""/.test(injectPs1) && /\[string\]\$MaskSpec = ""/.test(injectPs1), 'sd-inject.ps1 必须接受 -Mode / -MaskSpec（对话提交的任务类型与蒙版区域）')
// 坑40（2026-10-17）：表单预置值改用 $maskDefaultForForm —— 用户明确要求「手动绘制」时必须
// 原样保留（不被对话侧预抠的蒙版顶掉），否则主流程判不出「手动」关键词、手绘窗口根本不弹。
assert.ok(/-ModeDefault \$Mode -MaskDefault \$maskDefaultForForm/.test(injectPs1), '表单必须用对话提交的 Mode/MaskSpec（或对话画好的蒙版）预置')
assert.ok(/\$maskDefaultForForm = \$MaskSpec/.test(injectPs1) && /\^手动\|手动绘制\|manual\|手绘/.test(injectPs1), '用户要求手绘时必须保留「手动绘制」，不被预抠蒙版覆盖')
assert.ok(/\$applyModeLock = \{/.test(injectPs1) && /\$txtInit\.Enabled = -not \$isTxt/.test(injectPs1) && /\$cboMask\.Enabled = -not \$isTxt/.test(injectPs1), '文生图必须锁定「底图」与「蒙版」两个控件')
assert.ok(/文生图：不需要蒙版，已锁定/.test(injectPs1) && /文生图：不需要底图，已锁定/.test(injectPs1), '锁定状态必须有明确提示文案')

// ---------------------------------------------------------------------------
// 图生图「和原图没关系 / 底图不生效 / 蒙版位置错」三连修（2026-10-15 事故回归）：
// ① 显式给了底图但解析失败 → 必须明确报错，不许默默换成输出目录最新一张；
// ② 底图解析要能吃下附件/哈希形态（对话常把 "图片 sha256:…"、"xxx.png [8a34ca32]" 传进来）；
// ③ C-1a 出图尺寸必须跟参考图走（原来用表单比例/画质会把 1024x1024 压成 480x853 → 构图对不上），
//    且 denoising 过高要收敛（否则把原图洗掉 = 「和原图没关系」）；
// ④ 蒙版必须按**最终出图尺寸**生成，尺寸不符要缩放对齐（否则区域错位）。
// ---------------------------------------------------------------------------
assert.ok(/底图没能解析成文件/.test(injectPs1) && /不是文件路径，不能直接当底图/.test(injectPs1), '显式底图解析失败必须明确报错（不许静默回落）')
assert.ok(/\$script:LastInitFail/.test(injectPs1), '解析失败原因必须回传（用于报错与日志）')
assert.ok(/sha256:/.test(injectPs1) && /8,64/.test(injectPs1), '底图解析必须能剥掉哈希/附件装饰')
assert.ok(/attachments/.test(injectPs1), '底图解析要能在 DSH 附件目录里按哈希找图')
assert.ok(injectPs1.includes('[A-Za-z]:\\') && injectPs1.includes('-replace'), '底图解析要能从说明文字里抠出无后缀的附件路径')
assert.ok(/refOut = Get-RefOutputSize -Path \$finalInit/.test(injectPs1), 'C-1a 必须按参考图原生尺寸出图（尺寸统一走 Get-RefOutputSize）')
assert.ok(/一致模式：denoising/.test(injectPs1) && /\$finalDenoise = 0\.65/.test(injectPs1), '一致模式 denoising 过高必须收敛')
assert.ok(/box\(px\)\?/.test(injectPs1), '蒙版必须支持精确坐标框 box:/boxpx:')
assert.ok(/region-mask-scaled\.png/.test(injectPs1), '蒙版尺寸与出图尺寸不符时必须缩放对齐')
assert.ok(/if \(\$conflict\) \{ \$merged = \(\$UserPos/.test(injectPs1), '替换任务：用户新指令在前')
assert.ok(/else \{ \$merged = \(\(\$keep -join/.test(injectPs1), '一致任务：参考图词在前（保证与原图一致）')

// ---------------------------------------------------------------------------
// 文档必须写清的两件事（用户明确要求）：本地模型评估链 + 触发话术（0.9.7）
// ---------------------------------------------------------------------------
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const catalog = fs.readFileSync(new URL('../docs/models-loras.md', import.meta.url), 'utf8')
assert.ok(readme.includes('C 档选项表'), 'README 必须写明 C 档选项表（A 档出图后罗列）')
assert.ok(readme.includes('打开SD插件'), 'README 必须写明触发话术「打开SD插件」')
assert.ok(readme.includes('用SD插件绘制'), 'README 必须写明触发话术「用SD插件绘制」')
assert.ok(readme.includes('本地模型评估链'), 'README 必须有「本地模型评估链」专章（调用本地模型做质检/翻译）')
assert.ok(readme.includes('qwen3-vl:8b'), 'README 必须写明视觉审核用的是能识图的 qwen3-vl:8b')
assert.ok(!readme.includes('huihui_ai/qwen2.5-abliterate:14b') || readme.includes('翻译链路已整体移除'), '翻译链路已移除：README 不得再把翻译模型写成现行功能')
assert.ok(readme.includes('≥ 75') || readme.includes('>= 75'), 'README 必须写明质检过关线 75')
assert.ok(readme.includes('-VlmModel') && readme.includes('-IterateRounds'), 'README 必须写明质检相关参数')
assert.ok(readme.includes('A 档没有这一步'), 'README 必须区分：A 档质检是执行模型自己 read_image，不走本地视觉模型')
assert.ok(catalog.includes('本地 Ollama 模型'), 'docs/models-loras.md 必须有本地 Ollama 模型一节')
assert.ok(catalog.includes('ollama pull qwen3-vl:8b'), 'docs/models-loras.md 必须给出视觉审核模型的拉取命令（qwen3-vl:8b）')
assert.ok(catalog.includes('hf-mirror.com'), 'docs/models-loras.md 必须给出 HF 镜像直链')

console.log('skill title:', skill.title)
console.log('sd_inject(C 档):', inj.command)
console.log('sd_script(i2i):', out.command)
console.log('sd_script_b(t2i):', al.command)
console.log('quickOptions head:', quickText.split('\n')[0])
console.log('SKILL SMOKE OK')

// 按图内容自动抠图（2026-10-15 用户要求「蒙版不要预设」）：换衣服抠衣服、换背景抠背景。
// 交付物 = sd-auto-mask.py（YOLO-World 文字提示 → SAM 精细蒙版）+ 脚本里的调用与表单默认值。
// ---------------------------------------------------------------------------
const autoMaskPy = fs.readFileSync(new URL('../sd-auto-mask.py', import.meta.url), 'utf8')
assert.ok(/YOLO-World|world/.test(autoMaskPy) && /segment_anything/.test(autoMaskPy), '抠图脚本必须走 YOLO-World(文字提示) + SAM 分割')
assert.ok(/TARGET_LABELS/.test(autoMaskPy) && /衣服/.test(autoMaskPy) && /背景/.test(autoMaskPy) && /脸/.test(autoMaskPy), '抠图脚本必须支持 衣服/脸/背景/主体 四类目标')
assert.ok(/set_classes\(\[word\]\)/.test(autoMaskPy), '必须单词逐个试（多词混喂会互相稀释，实测命中率骤降）')
assert.ok(/SILHOUETTE_FALLBACK/.test(autoMaskPy), '找不到服饰词时必须按人物剪影兜底（而不是固定矩形）')
assert.ok(/INVERT_TARGETS/.test(autoMaskPy), '背景目标必须取反（人以外的区域）')
const bridgeSrcV101 = fs.readFileSync(new URL('../sd-bridge.js', import.meta.url), 'utf8')
assert.ok(bridgeSrcV101.includes('sd-auto-mask.py'), '插件必须把 sd-auto-mask.py 同步进工作区')
assert.ok(/function New-AutoMaskFromImage/.test(injectPs1), 'sd-inject.ps1 必须有自动抠图调用函数')
assert.ok(/function Find-SdPython/.test(injectPs1), '必须能定位 SD 自带的 python')
assert.ok(/自动（按图内容抠图）/.test(injectPs1), '蒙版下拉首项必须是「自动（按图内容抠图）」')
assert.ok(/\$autoMask = \(\$maskSpec -match '\^自动'/.test(injectPs1), '决策段必须识别「自动」蒙版并当场抠图')
assert.ok(/自动蒙版：按参考图内容抠/.test(injectPs1), '自动抠图必须打印目标与引擎')
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

console.log('AUTO-MASK SMOKE OK')


// ---------------------------------------------------------------------------
// 对话侧预生成 + 表单锁定（2026-10-15 用户要求）：
// C 档触发蒙版条件时，脚本在**弹表单之前**就解析底图、画好蒙版，两项直接填好并锁定；
// 对话只提交 -InitImage（+可选 -MaskSpec），最省 token，用户只点「确定」。
// ---------------------------------------------------------------------------
assert.ok(/\[switch\]\$LockBase = \$false/.test(injectPs1) && /\[switch\]\$LockMask = \$false/.test(injectPs1), 'Show-ParamForm 必须支持 LockBase/LockMask')
// 坑49（装机实测 2026-10-17 P1）：表单先弹，底图解析移到表单确认之后。
// 文案改为匹配新位置（表单后的阻塞步骤里打印）。
assert.ok(/底图已解析/.test(injectPs1), '底图必须在表单确认后阶段被解析并打印')
// 坑49：表单先弹，底图/蒙版解析后移，但文案依然存在（表单确认后才执行）。
assert.ok(/底图已解析/.test(injectPs1), '底图解析文案必须存在（表单确认后阶段）')
// 蒙版自动抠图在表单确认后执行，文案仍保留
assert.ok(/按参考图内容抠/.test(injectPs1), '自动抠图文案必须存在（确认后执行）')
// 蒙版信息以「自动蒙版就绪」为准（表单确认后阶段）
assert.ok(/自动蒙版就绪/.test(injectPs1), '蒙版生成信息文案必须存在（确认后执行）')
// premask- 路径命名规则仍生效（确认后生成）
assert.ok(/premask-/.test(injectPs1), '预生成蒙版要落到可见目录（premask-<参考图>-<目标>.png）')
// 2026-10-16 用户要求：蒙版**不再锁定**，任何情况下都保持可编辑（自动抠图只预填）。
assert.ok(/\$applyExternalLock = \{/.test(injectPs1), '外部锁定逻辑必须存在（底图仍需锁定）')
assert.ok(/对话已解析底图并锁定/.test(injectPs1), '底图锁定文案必须存在')
assert.ok(!/对话已按图抠好蒙版并锁定/.test(injectPs1), '蒙版锁定文案必须已移除（用户要求不再锁定蒙版）')
assert.ok(!/\$cboMask\.Enabled = \$false/.test(injectPs1), '蒙版下拉不得被禁用（用户要求始终可编辑）')
assert.ok((injectPs1.match(/\$lockMask = \$false/g) || []).length >= 3, '三处蒙版来源（图片/box/自动抠图）都必须传 lockMask=false')
assert.ok(!/\$lockMask = \$true/.test(injectPs1), '不得再出现 lockMask = $true（蒙版永不锁定）')
// 坑49：表单前置后底图解析移到表单确认后才执行
assert.ok(/if \(\$mode -eq '图生图' -and \$initRaw\)/.test(injectPs1), '图生图模式下才解析底图（表单确认后执行）')
// 坑49：box 坐标框处理逻辑已移到表单确认后的 `$maskSpec -match '^box'` 分支
assert.ok(/\$maskSpec -match '\^box'/.test(injectPs1), 'box 坐标框必须能识别')
// 坑40+49：表单前置后，蒙版不再预抠，`$preMaskText` 已不存在；
// 表单确认后才解析底图并执行蒙版逻辑，默认真值直接传原始 $MaskSpec。
assert.ok(/MaskDefault \$maskDefaultForForm/.test(injectPs1), '表单蒙版默认值从原始参数直接传入')
console.log('PREDRAW+LOCK SMOKE OK')


// ---------------------------------------------------------------------------
// 手绘蒙版（2026-10-16，用户实测两轮修复）：
// 坑35：WinForms 事件处理器不继承函数局部作用域 → 共享对象必须走 $script: 作用域；
// 坑36：ColorMatrix 做显示层实测把底图盖白 → 改用独立红色叠加层。
// ---------------------------------------------------------------------------
assert.ok(/function Show-MaskPainter \{/.test(injectPs1), '必须存在 Show-MaskPainter 手绘函数')
assert.ok(/手动绘制（鼠标涂抹）/.test(injectPs1), '蒙版下拉必须有「手动绘制（鼠标涂抹）」选项')
assert.ok(/\$maskSpec -match '\^手动/.test(injectPs1), '决策段必须识别「手动绘制」并弹出绘制窗口')
assert.ok(/\$script:mp_canvas/.test(injectPs1), '坑35：画布必须放 $script: 作用域（事件处理器不继承局部作用域）')
assert.ok(/\$script:mp_maskG/.test(injectPs1), '坑35：蒙版 Graphics 必须放 $script: 作用域')
assert.ok(/\$script:mp_recompose = \{/.test(injectPs1), '坑35：重绘闭包必须放 $script: 作用域')
assert.ok(!/mp_redMatrix/.test(injectPs1), '坑36：不得再用 ColorMatrix 做显示层（实测盖白底图）')
assert.ok(/\$script:mp_redBmp/.test(injectPs1), '坑36：必须有独立红色叠加层位图')
assert.ok(/CompositingMode\]::SourceCopy/.test(injectPs1), '擦除必须用 SourceCopy 置 alpha=0（SourceOver 擦不掉）')
assert.ok(/\$script:mp_brushSize/.test(injectPs1) && /MouseWheel/.test(injectPs1), '滚轮必须能调笔刷大小')
assert.ok(/mp_cursor/.test(injectPs1) && /DrawEllipse/.test(injectPs1), '必须有跟随光标的笔刷圈')
assert.ok(/NearestNeighbor/.test(injectPs1), '存盘必须按原图尺寸用 NearestNeighbor 还原')
console.log('MASK-PAINTER SMOKE OK')


// ---------------------------------------------------------------------------
// 真机报告修复（2026-10-16，5 个 issue）防回归断言：Issue 1/2/3/4/5
// ---------------------------------------------------------------------------
assert.ok(injectPs1.includes('if (Test-VisualReviewOff) { return -1 }'), 'Issue1: Test-FaceQuality 必须在视觉审查关闭时早退（统一走 Test-VisualReviewOff）')
assert.ok(injectPs1.includes('if (-not (Test-VlmApi)) { return -1 }'), 'Issue1: Test-FaceQuality 必须在 VLM 不可达时早退')
assert.ok(injectPs1.includes("if (Test-VlmApi) { Ensure-Vram -For 'sd' -Note '视觉审核' }"), 'Issue1: 视觉审核的 Ensure-Vram 必须被 Test-VlmApi 守卫')
assert.ok(injectPs1.includes('$vlmDown = [bool](Test-VisualReviewOff)'), 'Issue3: 视觉审查关闭（-NoVlmReview / -VisualReview off）必须让最终轮质检整条不跑')
assert.ok(injectPs1.includes('$score = if ($vlmOk) { Test-FaceQuality'), 'Issue3: 素体轮质检必须受 $vlmOk 控制')

assert.ok(bridgeSrcV101.includes('function buildInjectCfgSwitches(cfg, args)'), 'Issue2: 必须有共用的 cfg 开关构建器')
assert.equal((bridgeSrcV101.match(/for \(const sw of injectCfgSwitches\)/g) || []).length, 2, 'Issue2: 命令与 launcher 必须共用同一份开关（两处调用）')
assert.ok(/vramRelease: true/.test(bridgeSrcV101) && /vramMinFreeGb: 4\.0/.test(bridgeSrcV101), 'Issue3: 必须暴露 vramRelease / vramMinFreeGb 默认值')
assert.ok(/vramRelease: z/.test(bridgeSrcV101) && /vramMinFreeGb: z/.test(bridgeSrcV101), 'Issue3: 必须暴露 vramRelease / vramMinFreeGb schema')
assert.ok(bridgeSrcV101.includes('function withGitOnPath(env)'), 'Issue5: 必须有 git PATH 修补函数')
assert.ok(bridgeSrcV101.includes('const patched = withGitOnPath(base)'), 'Issue5: buildLaunchEnv 必须调用 withGitOnPath')

const installSrcV101 = fs.readFileSync(new URL('../install-sd.ps1', import.meta.url), 'utf8')
assert.ok(installSrcV101.includes('return @{ Ok = $false; Errs = $errs }'), 'Issue4: SegmentWorker 必须回报失败原因')
assert.ok(installSrcV101.includes('分段失败原因（共'), 'Issue4: 必须打印每段失败原因')
assert.ok(/429\|Too Many Requests/.test(installSrcV101), 'Issue4: 单流必须对 429 退避重试')
console.log('REAL-ISSUES SMOKE OK')


// ---------------------------------------------------------------------------
// 显存自愈三级降级（用户要求 2026-10-16）：
// ① 最多 3 轮清理显存；② 仍不够 → CPU 推理；③ CPU 起不来 → 核显。
// ---------------------------------------------------------------------------
assert.ok(bridgeSrcV101.includes('async function ensureVramWithRetry'), '显存自愈：必须有三级降级决策函数')
assert.ok(bridgeSrcV101.includes('function queryFreeVramGb'), '显存自愈：必须能读剩余显存')
assert.ok(bridgeSrcV101.includes('async function releaseVramSide'), '显存自愈：必须能清 SD 与本地模型两侧')
assert.ok(/for \(let i = 1; i <= 3; i\+\+\)/.test(bridgeSrcV101), '显存自愈：必须是「最多 3 轮」清理')
assert.ok(bridgeSrcV101.includes("'--use-cpu', 'all'"), '显存自愈：CPU 模式必须用 --use-cpu all')
assert.ok(bridgeSrcV101.includes("'--no-half'") && bridgeSrcV101.includes("'--precision', 'full'"), '显存自愈：CPU 模式必须 --no-half + --precision full')
assert.ok(!/cpuModeArgs\(\)[\s\S]{0,400}--threads/.test(bridgeSrcV101), '显存自愈：CPU 参数不得含 --threads（A1111 v1.10.1 不认，实测启动失败）')
assert.ok(bridgeSrcV101.includes('function igpuModeArgs'), '显存自愈：必须有核显模式')
assert.ok(bridgeSrcV101.includes('function detectIgpu'), '显存自愈：必须能探测核显')
assert.ok(bridgeSrcV101.includes('async function apiPostWithVramHeal'), '显存自愈：出图撞 500 必须能自愈')
assert.ok(bridgeSrcV101.includes('function isVramError'), '显存自愈：必须能识别显存类错误')
assert.ok(/Not enough memory/.test(bridgeSrcV101) && /Expected all tensors to be on the same device/.test(bridgeSrcV101), '显存自愈：两类现场都要认（内存不足 + 设备分裂）')
assert.ok(bridgeSrcV101.includes('vramAutoFallback: true'), '显存自愈：必须有开关且默认开')
assert.ok((bridgeSrcV101.match(/apiPostWithVramHeal\(/g) || []).length >= 4, '显存自愈：txt2img/img2img 出图路径都要接上')
console.log('VRAM-FALLBACK SMOKE OK')


// ---------------------------------------------------------------------------
// 服装蒙版再训练（2026-10-15，第三批图）：多件合一 + 行内桥接 + 脸禁区。
// 现象：水手服只抠到领结、大衣只抠到一节围巾；多件合一时曾把整张脸吞进去（换衣服顺手重画脸）。
// ---------------------------------------------------------------------------
assert.ok(/parts = \[\]/.test(autoMaskPy) && /多件合一/.test(autoMaskPy), '必须有「多件合一」（各合格零件并集，上限 30%）')
assert.ok(/行内连通桥接/.test(autoMaskPy), '必须有行内连通桥接（把同一件衣服被拆开的部分补成整块）')
assert.ok(/face_box = None/.test(autoMaskPy) && /face_yolov8/.test(autoMaskPy), '必须检测人脸框（脸禁区基准）')
assert.ok(/_facepx \/ float\(_tot\) > 0\.08/.test(autoMaskPy), '压到脸的候选必须被丢弃（>8% 重叠）')
assert.ok(/已扣除脸区/.test(autoMaskPy), '最终蒙版必须减去脸区（兜底）')
assert.ok(/已补全薄纱区/.test(autoMaskPy), '薄纱/透视布料补全必须存在')
assert.ok(/--no-shoulder-guard/.test(autoMaskPy) && /--grow/.test(autoMaskPy), '肩线守卫与颜色生长开关必须存在')
console.log('GARMENT-V2 SMOKE OK')


// ---------------------------------------------------------------------------
// 真机 bug（2026-10-15，用户截图）：预生成蒙版时报 `缺少 cv2/numpy: No module named 'cv2'`。
// 根因：$SdDir 在预生成阶段是空的 → Find-SdPython 退到系统 python（没有 cv2）；且 --sd-dir 也没传，
// 抠图器接着报「没找到 YOLO-World 权重」。修：候选 python 逐个实测 import cv2/numpy；
// SD 根用 /sdapi/v1/sd-models 的模型路径反推（cmd-flags 的 ckpt_dir 常为空）；扫盘不再限前 60 个目录。
// ---------------------------------------------------------------------------
assert.ok(/import cv2, numpy/.test(injectPs1) && /能 import cv2 \+ numpy 才算数/.test(injectPs1), 'Find-SdPython 必须实测 python 能否 import cv2/numpy')
assert.ok(/sdapi\/v1\/\$ep/.test(injectPs1) && /'sd-models', 'loras'/.test(injectPs1), 'SD 根必须用 sd-models/loras 的模型路径反推')
assert.ok(/SdRootProbed/.test(injectPs1), 'SD 根探测必须只做一次（缓存）')
assert.ok(/\$sdRootForHelper = \$SdDir/.test(injectPs1) && /--sd-dir', \$sdRootForHelper/.test(injectPs1), '抠图器必须拿到探测出的 SD 根（否则找不到 YOLO-World 权重）')
assert.ok(/Get-ChildItem -LiteralPath \$drv -Directory -ErrorAction SilentlyContinue/.test(injectPs1), '扫盘兜底不得限制目录数量（上次被「前 60 个」截掉了 SD.4.8）')
// 坑49 重构后文案为「自动蒙版没成功」，原因串仍在（缺少抠图脚本 / 找不到 python）
assert.ok(/自动蒙版没成功/.test(injectPs1) && /缺少抠图脚本|找不到可用的 python/.test(injectPs1), '抠图失败必须给出可读原因')
console.log('SD-PY-DETECT SMOKE OK')


// ---------------------------------------------------------------------------
// 真机 bug（2026-10-15 第二张截图）：抠图**已经算出来了**（coverage 0.1058），PowerShell 侧却报
// 「抠图输出解析失败」+ JSON 里中文全乱码。根因：子进程 python 的 stdout 走系统 GBK 代码页，
// 中文被写成 GBK 字节 → 按 UTF-8 读回来乱码、把 JSON 的引号都吃坏 → ConvertFrom-Json 失败。
// 修：① 调 python 前强制 PYTHONIOENCODING=utf-8 / PYTHONUTF8=1；
//     ② JSON 改用 ensure_ascii=True（纯 ASCII 的 \uXXXX，任何代码页都破坏不了，PS 侧自动还原中文）；
//     ③ 解析失败再用 Repair-Utf8Mojibake 兜一次。
// ---------------------------------------------------------------------------
assert.ok(/ensure_ascii=True/.test(autoMaskPy), '抠图 JSON 必须走 ensure_ascii=True（纯 ASCII，任何代码页都不会坏）')
assert.ok(!/json\.dumps\(result, ensure_ascii=False\)/.test(autoMaskPy), '不允许再出现 ensure_ascii=False 的 JSON 输出')
assert.ok(/PYTHONIOENCODING = 'utf-8'/.test(injectPs1) && /PYTHONUTF8 = '1'/.test(injectPs1), '调 python 前必须强制 UTF-8（子进程 stdout 默认跟系统 GBK）')
assert.ok(/Repair-Utf8Mojibake -Text \$out/.test(injectPs1), '解析失败必须再用乱码修复兜一次')
assert.ok(/-Encoding UTF8 -ErrorAction SilentlyContinue/.test(injectPs1), '读临时输出文件必须按 UTF-8')
console.log('JSON-ENCODING SMOKE OK')


// ---------------------------------------------------------------------------
// 区域蒙版真跑回归（2026-10-15「C 档蒙版功能不完善」）：
// 源码级 bug —— New-RegionMask 里 `$rects += @{...}` 从 $null 起步，得到的是 Hashtable
// 而不是数组；环形（四周/背景）加第二块时 PowerShell 直接抛
// 「Item has already been added. Key in dictionary: 'Y'」→ 整条「换背景」蒙版路径静默失效
// （单矩形形状只是碰巧还能用：foreach 一个 Hashtable 会把它自己当一项、`.X` 恰好还是键访问）。
// 以前 smoke 对这个函数**只有源码正则**，一行都没真跑过，所以这个 bug 一路发版。
// 现在：源码断言 + 真跑 test-region-mask.ps1（AST 抽真函数 + 量白像素）。
// ---------------------------------------------------------------------------
assert.ok(/\$rects = @\(\)/.test(injectPs1), 'New-RegionMask 必须先初始化 $rects = @()（否则环形的第二块会抛键已存在）')
assert.ok(!/\$rects = \$rects/.test(injectPs1), '不允许残留 `$rects = $rects` 这种空操作（那是忘写初始化的痕迹）')
const ringBlock = /\$band = \[int\]\(\$W \* 0\.18\)([\s\S]{0,700}?)\}\s*if \(\$invert\)/.exec(injectPs1)
assert.ok(ringBlock && (ringBlock[1].match(/\$rects \+=/g) || []).length === 4, '四周（背景）必须是 4 块矩形拼成的环，且每块都真的进了 $rects')
assert.ok(/\$rects\) \{ \$g\.FillRectangle\(\$black/.test(injectPs1) && /\$rects\) \{ \$g\.FillRectangle\(\$white/.test(injectPs1), '反选必须靠「整张涂白 + 形状涂黑」实现（两个分支都要用 $rects）')
assert.ok(/function Get-RefOutputSize/.test(injectPs1), '尺寸推导必须抽成 Get-RefOutputSize（C-1a / C-1b 共用一套）')
assert.ok(/refOut = Get-RefOutputSize -Path \$refPath[\s\S]{0,300}New-RegionMask -Spec \$maskSpec/.test(injectPs1), '区域蒙版必须按「参考图的最终出图尺寸」生成（否则 boxpx 会被当成表单尺寸的像素）')
assert.ok(!/蒙版区域认不出（\$maskSpec）→ 退回整图重绘/.test(injectPs1), '认不出的区域名不得再宣称「退回整图重绘」（实际是落到 C-1a 收敛 denoising）')

const maskTestPs1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-region-mask.ps1')
assert.ok(fs.existsSync(maskTestPs1), 'test-region-mask.ps1 必须随包发布（区域蒙版真跑回归）')
const maskRun = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', maskTestPs1], { encoding: 'utf8', timeout: 180000 })
assert.equal(maskRun.status, 0, `区域蒙版真跑测试必须通过：\n${maskRun.stdout || ''}\n${maskRun.stderr || ''}`)
assert.ok(/REGION-MASK TEST OK/.test(maskRun.stdout || ''), '区域蒙版真跑测试必须打印 REGION-MASK TEST OK')
assert.ok(/ok\s+ring-bg/.test(maskRun.stdout || ''), '四周（背景）环形成必须真跑通过（本轮修的那个 bug）')
console.log('REGION-MASK SMOKE OK')


// ---------------------------------------------------------------------------
// 0.9.16（「极端情况测试，生成还是混乱」那轮）：
//  ① SAM 在 A1111 常驻时 CUDA OOM → 抠图整段失败 → 蒙版拿不到（实测 23:16 复现，notes 里就是
//     "CUDA out of memory ... 2.57 GiB free"）；现在按剩余显存决定设备/分辨率，并加检测框兜底。
//  ② 衣服只留最大连通块 → 同一件衣服被 SAM 拆开时袖子/裙摆那一侧整个丢掉。
//  ③ 蒙版准不准以前只能靠人眼看生成结果（用「脱衣服」提示词去看，模型会把衣服画成半脱状态，
//     看着像漏检，其实那块像素已经改过）→ 新增 sd-mask-qa.py 逐像素体检 + 总览图，并接入 C-1b 流程。
// ---------------------------------------------------------------------------
assert.ok(/mem_get_info/.test(autoMaskPy) && /vram_cpu_gb/.test(autoMaskPy), 'SAM 必须按剩余显存决定上不上 cuda（实测 2.57G 剩余时 ViT-L 直接 CUDA OOM）')
assert.ok(/改走 CPU/.test(autoMaskPy), '显存不够必须能降到 CPU 分割，而不是让蒙版整条失败')
assert.ok(/生成粗蒙版兜底/.test(autoMaskPy), 'SAM 全失败必须用检测框兜底（不许 ok:false 把替换路径废掉）')
assert.ok(/裁到躯干带/.test(autoMaskPy), '粗蒙版吞掉整个人时必须裁到躯干带（否则等于整个人重画）')
assert.ok(/保留 \{len\(keep_ids\)\}\/\{n_lab - 1\} 块/.test(autoMaskPy), '衣服必须保留同一件的多块（旧的「只留最大块」会丢袖子/裙摆那一侧）')
assert.ok(/args\.target == "衣服"/.test(autoMaskPy), '连通块筛选必须按目标分流（衣服走多块规则）')
assert.ok(/sd-mask-qa\.py/.test(injectPs1) && /function Invoke-MaskQaReport/.test(injectPs1), 'C-1b 出图后必须自动跑蒙版命中率体检')
assert.ok(/命中率总览图/.test(injectPs1), '体检必须落地一张可人工审阅的总览图')
assert.ok(/Invoke-MaskQaReport -RefPath \$finalInit -MaskPath \$finalMask/.test(injectPs1), '体检必须用「参考图 + 本次蒙版 + 本次成品」三方对齐')

const qaPs1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-mask-qa.ps1')
assert.ok(fs.existsSync(qaPs1), 'test-mask-qa.ps1 必须随包发布（体检工具真跑测试）')
const qaRun = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', qaPs1], { encoding: 'utf8', timeout: 300000 })
assert.equal(qaRun.status, 0, `蒙版体检工具真跑测试必须通过：\n${qaRun.stdout || ''}\n${qaRun.stderr || ''}`)
assert.ok(/MASK-QA TEST OK|MASK-QA TEST SKIP/.test(qaRun.stdout || ''), '蒙版体检测试必须给出 OK 或 SKIP')
console.log('MASK-QA SMOKE OK')


// ---------------------------------------------------------------------------
// 0.9.17（用户要求：本地视觉模型加入冷启动；C 档脚本跑完删掉产生的额外图片）：
//  ① 质检/画风识别都依赖本地视觉模型（Ollama）。以前它没起就静默降级：
//     素体只出一张、最终出图变成「出满 N 张让你自己挑」——用户看到的就是「插件没质检」。
//     现在解析侧也冷启动：没起就替你 `ollama serve`，就绪后再往下走（-NoVlmStart 可关）。
//  ② 产物目录只留成品：预蒙版 premask-*.png / _overlay.png、命中率总览图都算中间图，
//     跑完自动清掉（-KeepWorkFiles 保留并列出）。
// ---------------------------------------------------------------------------
assert.ok(/function Start-OllamaService/.test(injectPs1), '必须有本地视觉模型冷启动函数')
assert.ok(/\[switch\]\$NoVlmStart/.test(injectPs1) && /\[int\]\$VlmStartTimeout/.test(injectPs1), '冷启动必须有开关与超时参数（-NoVlmStart / -VlmStartTimeout；注意不能沿用已被移除的翻译链路参数名）')
assert.ok(/ArgumentList 'serve'/.test(injectPs1), '冷启动必须真的拉起 `ollama serve`')
assert.ok(/测试|等待 ollama serve 起来/.test(injectPs1), '冷启动必须轮询等待就绪，而不是起完就往下走')
const coldCalls = (injectPs1.match(/Start-OllamaService -TimeoutSec \$VlmStartTimeout/g) || []).length
assert.ok(coldCalls >= 3, `冷启动必须接在三处使用点（预热/质检前置/画风识别），当前 ${coldCalls} 处`)
assert.ok(/function Add-RunWorkFile/.test(injectPs1) && /function Remove-RunWorkFiles/.test(injectPs1), '必须给本次产生的中间图记账并可清理')
// 坑49：表单前置后自动抠图产物落在迭代临时目录（auto-mask.png），随目录一起清理，
// 不再往产物目录写 premask-*，因此记账点改为命中率总览图（qa-*）。
assert.ok(/Add-RunWorkFile \$keepOv/.test(injectPs1), '中间图必须记账（命中率总览图，随迭代目录清理）')
assert.ok(/Invoke-MaskQaReport -RefPath \$finalInit -MaskPath \$finalMask -OutPath \$finalPath -QaDir \$script:IterTempDir/.test(injectPs1), '命中率总览图必须写进迭代临时目录（随目录一起清），而不是产物目录')
assert.ok((injectPs1.match(/Remove-RunWorkFiles/g) || []).length >= 4, '成品保存/多选/失败三条路径都要清中间图')
assert.ok(/\[switch\]\$KeepWorkFiles/.test(injectPs1), '必须能用 -KeepWorkFiles 保留中间图排查')

const vlmPs1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-vlm-cleanup.ps1')
assert.ok(fs.existsSync(vlmPs1), 'test-vlm-cleanup.ps1 必须随包发布（冷启动 + 清理真跑测试）')
const vlmRun = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', vlmPs1], { encoding: 'utf8', timeout: 300000 })
assert.equal(vlmRun.status, 0, `冷启动/清理真跑测试必须通过：\n${vlmRun.stdout || ''}\n${vlmRun.stderr || ''}`)
assert.ok(/VLM-CLEANUP TEST OK/.test(vlmRun.stdout || ''), '冷启动/清理测试必须打印 VLM-CLEANUP TEST OK')
console.log('VLM-COLDSTART+CLEANUP SMOKE OK')


// ---------------------------------------------------------------------------
// 0.9.18（用户要求：本地视觉模型关掉）：插件侧开关 vlmAutoStart=false
//   · true（默认）= C 档质检前探活失败就替你 `ollama serve`
//   · false      = 生成的命令追加 `-NoVlmStart`，服务没起就跳过质检（出满 N 张让你自己挑），
//                  绝不偷偷在你机器上拉起本地模型服务
// ---------------------------------------------------------------------------
{
  const tools2 = new Map()
  const ctx2 = {
    logger: { log: () => {} },
    effect: (fn) => fn(),
    get: (key) => (key === 'skills' ? { register: () => () => {} } : undefined),
    tools: { register(def) { tools2.set(def.name, def); return () => tools2.delete(def.name) } },
  }
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-guard-off-'))
  await mod.apply(ctx2, { sdDir: process.env.DSH_SD_DIR || '', port: 7860, vlmAutoStart: false })
  const inj2 = await tools2.get('sd_inject').execute({ basePrompt: '1girl, solo', violationPrompts: 'nude', suggestedPrompts: 'clothed' }, { agent: { session: { header: { cwd: ws2 } } } })
  assert.ok(inj2.command.includes('-NoVlmStart'), `vlmAutoStart=false 必须把 -NoVlmStart 写进命令：${inj2.command}`)
  assert.ok(/(^|\s)-NoVlmStart(\s|$)/.test(inj2.command), `-NoVlmStart 必须是独立开关：${inj2.command}`)
  assert.ok(inj2.command.startsWith('powershell -ExecutionPolicy Bypass -File '), '关掉冷启动不得破坏命令结构')
  console.log('VLM-AUTOSTART-SWITCH SMOKE OK')
}


// ---------------------------------------------------------------------------
// 0.9.19（用户要求：在插件页加个开关，是否启动可以自己选）：
//   · 插件页两个开关：vlmAutoStart（本地视觉模型服务）、maskAutoSegment（自动抠图 YOLO-World + SAM）
//   · maskAutoSegment=false → 生成命令追加 -NoAutoMask → 脚本完全不加载检测模型，
//     改用几何区域蒙版；且自动抠图失败时**不再 exit 1**、也不再只留一张空蒙版栏。
//   · 真机复现的坑：cuda 下检测模型会把 python 进程**原生崩掉**（连 JSON 都没打，
//     PowerShell 只看到「抠图脚本没有输出」）；同一命令 `--device cpu` 100% 成功且结果一致
//     → 失败说明必须带上退出码/stderr，并自动用 CPU 重试一次。
// ---------------------------------------------------------------------------
assert.ok(/\[switch\]\$NoAutoMask/.test(injectPs1), '必须有 -NoAutoMask 开关（插件页 maskAutoSegment=false 会带它）')
assert.ok(/maskAutoSegment=false/.test(injectPs1), '-NoAutoMask 的说明要指明来自插件设置')
assert.ok(/--device', 'cpu'/.test(injectPs1), 'CPU 重试必须显式传 --device cpu')
assert.ok(/New-AutoMaskFromImage -ImagePath \$ImagePath -Target \$Target -OutPath \$OutPath/.test(injectPs1), '自动抠图失败必须自动用 CPU 重试一次')
assert.ok(/自动改用 CPU 重试一次/.test(injectPs1), 'CPU 重试必须打印出来（用户要知道发生了什么）')
assert.ok(/抠图脚本没有输出（python 退出码/.test(injectPs1), '失败说明必须带 python 退出码（不能只说「没有输出」）')
// 2026-10-19 变更（用户要求）：几何矩形蒙版已删除 —— 抠图失败时**不再**偷偷塞矩形，改为明确告知 + 让用户改用 手绘 / box 坐标 / 换人物图
assert.ok(/不会退回几何矩形蒙版（已按需求移除）/.test(injectPs1), '抠图失败必须明确说明不退回几何矩形，并给出可操作出路')
assert.ok(!/不会退回整图重绘（那会把背景\/姿势一起换掉/.test(injectPs1), '抠图失败不得再直接 exit 1（用户拿到的是「什么都没出」）')
assert.ok(/\[switch\]\$ForceCpu/.test(injectPs1), '必须有 ForceCpu 内部开关（重试路径）')

{
  const tools3 = new Map()
  const ctx3 = {
    logger: { log: () => {} },
    effect: (fn) => fn(),
    get: (key) => (key === 'skills' ? { register: () => () => {} } : undefined),
    tools: { register(def) { tools3.set(def.name, def); return () => tools3.delete(def.name) } },
  }
  const ws3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-guard-maskoff-'))
  await mod.apply(ctx3, { sdDir: process.env.DSH_SD_DIR || '', port: 7860, maskAutoSegment: false })
  const inj3 = await tools3.get('sd_inject').execute({ basePrompt: '1girl, solo', violationPrompts: 'nude', suggestedPrompts: 'clothed' }, { agent: { session: { header: { cwd: ws3 } } } })
  assert.ok(inj3.command.includes('-NoAutoMask'), `maskAutoSegment=false 必须把 -NoAutoMask 写进命令：${inj3.command}`)
  assert.ok(inj3.command.startsWith('powershell -ExecutionPolicy Bypass -File '), '关掉自动抠图不得破坏命令结构')
  console.log('MASK-AUTOSEGMENT-SWITCH SMOKE OK')
}

const retryPs1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-automask-retry.ps1')
assert.ok(fs.existsSync(retryPs1), 'test-automask-retry.ps1 必须随包发布（抠图失败→CPU 重试真跑测试）')
const retryRun = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', retryPs1], { encoding: 'utf8', timeout: 300000 })
assert.equal(retryRun.status, 0, `抠图 CPU 重试真跑测试必须通过：\n${retryRun.stdout || ''}\n${retryRun.stderr || ''}`)
assert.ok(/AUTOMASK-RETRY TEST OK/.test(retryRun.stdout || ''), '抠图 CPU 重试测试必须打印 AUTOMASK-RETRY TEST OK')
console.log('AUTOMASK-RETRY SMOKE OK')

// ---------------------------------------------------------------------------
// 0.9.20（用户要求：插件页加开关「视觉模型审核是否启动」；模型换成 qwen3.6-fable；审核人物肢体）
//   · 插件页 vlmReview（默认 true）：设 false → 命令追加 -NoVlmReview → 不探活、不冷启动、
//     不加载模型、不打分（连参考图画风识别也不调模型），出满 N 张让你自己挑。
//   · 默认模型改成 qwen3.6-fable（插件页 vlmModel 可改，会写成 -VlmModel "<name>"）。
//   · 审核问句从「脸 + 手」扩到「脸 + 手 + 四肢」：手臂/腿是否各两条、左右对称、多肢少肢、
//     关节反向错位、四肢畸形粘连、躯干与四肢比例失衡。
// ---------------------------------------------------------------------------
assert.ok(/\[switch\]\$NoVlmReview/.test(injectPs1), '必须有 -NoVlmReview 开关（插件页 vlmReview=false 会带它）')
assert.ok(/视觉模型审核已关闭/.test(injectPs1), '关掉审核必须打印说明（用户要知道这次没质检）')
assert.ok(/vlmReview=false/.test(injectPs1), '-NoVlmReview 的说明要指明来自插件设置')
assert.ok(/\$VlmModel = "qwen3-vl:8b"/.test(injectPs1), '视觉审核默认模型必须是能识图的 qwen3-vl:8b')
assert.ok(/人物肢体结构是否健康/.test(injectPs1), '审核问句必须覆盖人物肢体结构')
assert.ok(/① 脸部/.test(injectPs1) && /② 手部/.test(injectPs1) && /③ 肢体/.test(injectPs1), '审核问句必须三类都问：脸部 / 手部 / 肢体')
assert.ok(/手臂与腿是否各两条/.test(injectPs1) && /多肢少肢/.test(injectPs1), '肢体审核必须查多肢少肢/左右对称')
assert.ok(/关节反向或错位/.test(injectPs1) && /躯干与四肢比例失衡/.test(injectPs1), '肢体审核必须查关节错位与比例失衡')
assert.ok(/ollama create \$\{?VlmModel\}?|ollama create \$VlmModel/.test(injectPs1) || /ollama create/.test(injectPs1), '模型不在本机时必须给出 ollama pull / ollama create 两条路')
assert.ok(/if \(Test-VisualReviewOff\) \{ return '' \}/.test(injectPs1), '关掉审核（-NoVlmReview / -VisualReview off）后画风识别也不得调模型')

{
  const mk = (toolsMap, cfgOverride) => {
    const ctxN = {
      logger: { log: () => {} },
      effect: (fn) => fn(),
      get: (key) => (key === 'skills' ? { register: () => () => {} } : undefined),
      tools: { register(def) { toolsMap.set(def.name, def); return () => toolsMap.delete(def.name) } },
    }
    return ctxN
  }
  // ① 关闭审核
  const tools4 = new Map()
  const ws4 = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-guard-noreview-'))
  await mod.apply(mk(tools4), { sdDir: process.env.DSH_SD_DIR || '', port: 7860, vlmReview: false })
  const inj4 = await tools4.get('sd_inject').execute({ basePrompt: '1girl, solo', violationPrompts: 'nude', suggestedPrompts: 'clothed' }, { agent: { session: { header: { cwd: ws4 } } } })
  assert.ok(inj4.command.includes('-NoVlmReview'), `vlmReview=false 必须把 -NoVlmReview 写进命令：${inj4.command}`)
  assert.ok(inj4.command.includes('-VlmModel "qwen3-vl:8b"'), `默认模型必须写进命令（能识图的视觉模型）：${inj4.command}`)
  assert.ok(inj4.command.startsWith('powershell -ExecutionPolicy Bypass -File '), '关掉审核不得破坏命令结构')
  // ② 自定义模型名
  const tools5 = new Map()
  const ws5 = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-guard-vlmmodel-'))
  await mod.apply(mk(tools5), { sdDir: process.env.DSH_SD_DIR || '', port: 7860, vlmReview: true, vlmModel: 'my-vl:7b' })
  const inj5 = await tools5.get('sd_inject').execute({ basePrompt: '1girl, solo', violationPrompts: 'nude', suggestedPrompts: 'clothed' }, { agent: { session: { header: { cwd: ws5 } } } })
  assert.ok(inj5.command.includes('-VlmModel "my-vl:7b"'), `插件页自定义模型名必须写进命令：${inj5.command}`)
  assert.ok(!inj5.command.includes('-NoVlmReview'), '显式开启审核时不得带 -NoVlmReview: ' + inj5.command)
  console.log('VLM-REVIEW-SWITCH SMOKE OK')
}

// ---------------------------------------------------------------------------
// 0.9.21（用户要求：素体不需要额外生成了 + 重新调试蒙版）
//   · 有参考图（图生图/蒙版重绘）时**不再先生成素体**：参考图本身就是底图，
//     再跑素体只会多出一张 inject_00N.png（实测那轮产物目录里就有一张 inject_001.png）。
//   · 衣服蒙版：词表补 detached sleeves / hood / cloak / shawl / scarf（同一套衣服的其它部件），
//     检测框上限从写死的 2 提到 --max-boxes 3；肩线守卫从 8% 放宽到 4%（实测 8% 会把肩部服饰丢掉）。
//   · 连通块筛选把各块面积写进 notes，便于定位「保留 1/7 块」到底丢了什么。
// ---------------------------------------------------------------------------
assert.ok(/skipBaseIterate/.test(injectPs1), '有参考图时必须跳过素体自检迭代（不再额外生成素体底图）')
assert.ok(/已有参考图 → 跳过素体自检迭代/.test(injectPs1), '跳过素体迭代必须打印说明（用户要知道为什么没生成素体）')
assert.ok(/\$preInitPath -or \(\$Mode -eq '图生图' -and \$InitImage\)/.test(injectPs1), '跳过条件必须覆盖「对话给了参考图」与「表单选图生图」两条路')
assert.ok(/detached sleeves/.test(autoMaskPy) && /hood/.test(autoMaskPy) && /cloak/.test(autoMaskPy), '衣服词表必须含袖套/兜帽/披风等「同套衣服的其它部件」')
assert.ok(/--max-boxes/.test(autoMaskPy) && /args\.max_boxes/.test(autoMaskPy), '检测框上限必须可配（默认 3，实测只收 2 个会漏袖套）')
assert.ok(/0\.04 \* \(person_box\[1\] - person_box\[0\]\)/.test(autoMaskPy), '肩线守卫必须放宽到 4%（8% 会把肩部服饰整块丢掉）')
assert.ok(/各块面积/.test(autoMaskPy), '连通块筛选必须把各块面积写进 notes（便于定位漏块）')
console.log('BASE-SKIP+MASK-V2 SMOKE OK')

// ---------------------------------------------------------------------------
// 0.9.21（视觉审核「一致失效」的真因与修法 —— 已真机跑到 score=100）
//   真机复现：832x1216 原图 + qwen3-vl:8b → 每次 180s 超时、返回 -1（=「审核一致失效」）。
//   逐层定位：
//     · 根因A：送审原图太大 → 8G 卡上 SD 常驻时 8B 模型走 CPU，180s 跑不完 → 先降分辨率（长边 768）。
//     · 根因B：qwen3-vl 是**思考型**模型 —— 走 /v1/chat/completions 时 content 恒为空（思维链在 reasoning）；
//              原生 /api/chat + think:false + num_predict=1024 → finish=stop、content="SCORE=100"。
//              num_predict 太小（256/512/700）会想一半被截断 → content 空或只剩半截数字（实测回过 "797"）。
//     · 根因C：空白回答在 PowerShell 里是「真值」，-not $raw 判空失效 → 必须 Trim。
// ---------------------------------------------------------------------------
assert.ok(/VlmImageMaxSide/.test(injectPs1) && /Longest|MaxSide/.test(injectPs1) || /VlmImageMaxSide/.test(injectPs1), '必须有送审前降分辨率的参数')
assert.ok(/VlmTimeoutSec/.test(injectPs1), '审核超时秒数必须可配（原来是写死的 180）')
assert.ok(/\/api\/chat/.test(injectPs1), '审核首选原生 /api/chat（只有它认 think:false）')
assert.ok(/num_predict = 1024/.test(injectPs1), '思考型视觉模型必须给足预算（1024；太小会想一半被截断）')
assert.ok(/think = \$false/.test(injectPs1), '必须显式关掉思考')
assert.ok(/SCORE\\s\*\[=:：\]/.test(injectPs1), '解析必须先认显式 SCORE=<n>')
assert.ok(/foreach \(\$mm in \[regex\]::Matches\(\$raw, '\\d\{1,3\}'\)\)/.test(injectPs1), '解析必须退化为「第一个 0-100 的整数」（813 这种要跳过）')
assert.ok(/\$raw = \("\$raw"\)\.Trim\(\)/.test(injectPs1), '回答必须先 Trim 再判空（空白串在 PowerShell 里是真值）')
assert.ok(/没给出可用的 0-100 分数/.test(injectPs1), '拿不到分数必须打印模型原话与耗时（可观测）')
assert.ok(/已用 \$\(\[math\]::Round\(\$sw\.Elapsed\.TotalSeconds,0\)\)s/.test(injectPs1), '失败信息必须带耗时，便于判断是「慢」还是「答非所问」')
console.log('VLM-REVIEW-FIX SMOKE OK')

// ---------------------------------------------------------------------------
// 0.9.22（用户要求：模型换成能识图的；制止它审查技术性之外的内容）
//   · 默认审核模型必须是**能识图**的 qwen3-vl:8b（itsailor/qwen3.6-fable 那类是纯文本模型，
//     模型卡写明 vision 不可用、图片被静默忽略 → 拿它审核只会胡说）。
//   · 审核只许碰技术性内容：system 约束必须存在（禁止评价/描述/审查/拒绝画面内容、
//     不判断题材与服装裸露、不涉及性内容、不做合规判断、不复述画面）。
//   · 解析只认数字（SCORE= 优先，否则首个 0-100 整数）→ 模型多嘴也进不了打分逻辑。
// ---------------------------------------------------------------------------
assert.ok(/\$VlmModel = "qwen3-vl:8b"/.test(injectPs1), '默认审核模型必须是能识图的 qwen3-vl:8b')
assert.ok(/\$systemContent = /.test(injectPs1), '必须有 system 约束（审核范围限制）')
assert.ok(/结构缺陷检测器/.test(injectPs1), 'system 必须把角色钉成「结构缺陷检测器」')
assert.ok(/禁止评价、描述、审查或拒绝画面内容/.test(injectPs1), 'system 必须明确禁止评价/描述/审查/拒绝画面内容')
assert.ok(/不判断题材、不判断服装与裸露程度、不涉及性内容/.test(injectPs1), 'system 必须列出禁止触碰的内容维度')
assert.ok(/不做任何合规\/道德\/安全判断/.test(injectPs1), 'system 必须禁止做合规/道德/安全判断')
assert.ok(/只许输出分数，不许评论画面内容/.test(injectPs1), '用户问句也必须写明只输出分数')
assert.ok((injectPs1.match(/role = 'system'; content = \$systemContent/g) || []).length >= 2, 'system 约束必须同时带在原生端点与 /v1 兜底两条路径上')
assert.ok(/只判断画风（技术属性）/.test(injectPs1), '画风识别也必须限定为技术属性判断')
assert.ok(/vlmModel: 'qwen3-vl:8b'/.test(fs.readFileSync(new URL('../sd-bridge.js', import.meta.url), 'utf8')), '插件设置 vlmModel 默认也必须是 qwen3-vl:8b')
console.log('VLM-VISION-ONLY-REVIEW SMOKE OK')

// ---------------------------------------------------------------------------
// 0.9.23（用户要求：每次运行前先释放显存）
//   这台 8G 卡被三方共抢：SD ~2.5-5G / 抠图(YOLO+SAM) 2-3G / 8B 视觉模型 ~5.3G。
//   实测本机在两者都常驻时只剩 0.46G —— 这就是抠图 CUDA OOM、审核被挤到 CPU（40-180s）的根因。
//   现在每个"要显存"的步骤开跑前按需释放对面那一边：
//     · 抠图前、审核前 → 让 A1111 卸载 checkpoint（出图时自动重载）
//     · 素体/最终出图前 → 让 Ollama 卸载常驻模型（keep_alive:0）
//     · 收工后 → 再把本地模型卸掉，别长期占卡
//   实测释放效果：0.46G → 7.02G（+6.56G）。
// ---------------------------------------------------------------------------
assert.ok(/function Ensure-Vram/.test(injectPs1), '必须有「开跑前确保显存」的入口')
assert.ok(/function Release-SdVram/.test(injectPs1) && /unload-checkpoint/.test(injectPs1), '必须能让 A1111 卸载 checkpoint 释放显存')
assert.ok(/function Release-OllamaVram/.test(injectPs1) && /keep_alive = 0/.test(injectPs1), '必须能让本地模型服务卸掉常驻模型（keep_alive:0）')
assert.ok(/\[switch\]\$NoVramRelease/.test(injectPs1) && /\[double\]\$VramMinFreeGb/.test(injectPs1), '必须有开关与阈值参数（-NoVramRelease / -VramMinFreeGb）')
assert.ok(/if \(\$free -ge \$NeedGb\)/.test(injectPs1), '显存够用时不得乱释放（避免无谓重载）')
assert.ok(/Ensure-Vram -For 'sd' -Note '自动抠图'/.test(injectPs1), '抠图前必须释放 SD 显存（SAM OOM 的根因）')
assert.ok(/Ensure-Vram -For 'sd' -Note '视觉审核'/.test(injectPs1), '审核前必须释放 SD 显存（否则模型被挤到 CPU）')
assert.ok((injectPs1.match(/\$null = Release-OllamaVram/g) || []).length >= 3, '出图前/素体前/收工后都要卸载本地模型')
assert.ok(/老规矩|不阻断/.test(injectPs1) || /return -1/.test(injectPs1), '拿不到显存信息时必须静默跳过（不能因此中断出图）')

const vramPs1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-vram-release.ps1')
assert.ok(fs.existsSync(vramPs1), 'test-vram-release.ps1 必须随包发布（显存释放真跑测试）')
const vramRun = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', vramPs1], { encoding: 'utf8', timeout: 300000 })
assert.equal(vramRun.status, 0, `显存释放真跑测试必须通过：\n${vramRun.stdout || ''}\n${vramRun.stderr || ''}`)
assert.ok(/VRAM-RELEASE TEST OK|MASK-QA TEST SKIP/.test(vramRun.stdout || ''), '显存释放测试必须给出 OK 或 SKIP')
console.log('VRAM-RELEASE SMOKE OK')

// ---------------------------------------------------------------------------
// 0.9.24（用户要求：C 档参数表里两个提示词框最后加逗号）
//   坑：框内容在「切画风」时会被重写，而 Add-StyleWords / Remove-StyleWords **都不带尾部逗号**
//   → 打开时看到的逗号在切一次画风后就没了。现在每次重写后都过一遍 Add-TrailingComma，
//   表单确认取 Pos/Neg 时再兜一次 —— 框里显示什么、后面就用什么，一定以逗号结尾。
// ---------------------------------------------------------------------------
assert.ok(/function Add-TrailingComma/.test(injectPs1), '必须有「补后缀逗号」的函数')
assert.ok((injectPs1.match(/Add-TrailingComma \(Add-StyleWords/g) || []).length >= 4, '切画风注入/重注入的两条路径都要补逗号')
assert.ok((injectPs1.match(/Add-TrailingComma \(Remove-StyleWords/g) || []).length >= 2, '切画风移除旧画风词后也要补逗号')
assert.ok(/Pos     = \(Add-TrailingComma \$txtPos\.Text\)\.TrimEnd\(\)/.test(injectPs1), '确认时正向框必须兜一次后缀逗号')
assert.ok(/Neg     = \(Add-TrailingComma \$txtNeg\.Text\)\.TrimEnd\(\)/.test(injectPs1), '确认时负向框必须兜一次后缀逗号')
assert.ok(/\$formPositive = \$formPositive\.TrimEnd\(\) \+ ", "/.test(injectPs1) && /\$formNegative = \$formNegative\.TrimEnd\(\) \+ ", "/.test(injectPs1), '预填时两个框也必须带逗号（原有行为不能丢）')

const commaPs1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-trailing-comma.ps1')
assert.ok(fs.existsSync(commaPs1), 'test-trailing-comma.ps1 必须随包发布（后缀逗号真跑测试）')
const commaRun = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', commaPs1], { encoding: 'utf8', timeout: 180000 })
assert.equal(commaRun.status, 0, `后缀逗号真跑测试必须通过：\n${commaRun.stdout || ''}\n${commaRun.stderr || ''}`)
assert.ok(/TRAILING-COMMA TEST OK/.test(commaRun.stdout || ''), '后缀逗号测试必须打印 TRAILING-COMMA TEST OK')
console.log('TRAILING-COMMA SMOKE OK')
