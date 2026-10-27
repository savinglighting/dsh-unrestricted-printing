# sd-inject.ps1 —— 本地提示词注入脚本（参数表单最先弹 + 素体自检迭代 + 出图后加字）
# 【C 档流程 · 2026-10-20，用户要求】**参数表单必须第一个弹出来**：脚本一启动就弹窗口，
#   不再有任何阻塞步骤排在它前面（预生成/网关探测都不许挡表单）。
#   根因：2026-10-18 那版「后台先生成 → 再弹窗」让用户先对着空白控制台干等 2-3 分钟
#   （实测心跳 01:10:30 pregenerate-start → 01:13:12 pregenerate-done），表现就是「C 档开始没有任何弹窗」。
#   现在默认「表单先弹」；要老顺序请显式加 -PreGenerate（先生成落盘 → 再弹窗）。
#   出图后加字（-AddText / 表单「加字」栏）：生图用表单选的档，加字固定用**另一档模型**（默认自动挑 Krea2_Q4）。
# 流程：素体自检迭代（只跑基底，换 seed + 面部修复重试到脸/手不崩；正向自动追加脸部细节词）
#   → 出图参数表单（一次填完）：正向/负向提示词[BasePrompt 已预填；传了 ViolationPrompts/SuggestedPrompts 时与基底**合并**预填（基底在前、技术测试词在后），多行文本框可直接改] / 迭代次数[默认3] / Denoising[可编辑，默认 0 = 文生图；填 0.3-0.9 = 图生图重绘幅度] / 底图[留空=素体成品，「最近」=输出目录最新一张，或填路径/点浏览选图] / 比例[默认9:16] / 画风[默认**保持画风**=不往提示词框塞任何画风词；选档位才会注入该档位的词] / 画质[默认480p，最高2160p（4K）] / LoRA[可选，从 SD 拉取列表] / 宽×高（跟随预生成尺寸或比例+画质） / 取消退出
#   → 最终出图：拿到底图 + Denoising>0 → 图生图（-InitImage 底图 + -Denoising）；否则文生图。
#     底图优先级：表单「底图」栏 > 素体自检迭代的 winning 图 > 现场补一张素体底图（质检不可用时素体也会出这一张）。
#     最终图同样按迭代次数做脸/手质检迭代（质检不可用时出满 N 张让你自选），取最高分那张
# 迭代产物写在「可写的迭代根」下的独立子目录（默认 <OutDir 的父目录>\.sd-inject-iter\iter-<随机>，
# 可用 -IterDir 指定，见 坑34）：以前固定写系统 temp，在 DSH workspace-write 沙箱下会被 ACL 拒写，
# 出图落盘失败 → 脚本提前退出 → 工作区一张成品都没有。工作区优先即天然可写。
# 最终只把脸/手最高分的一张复制进 -OutDir；脚本退出（含取消/失败）时删除本次迭代子目录——工作区里只留成品。
# 全程本地运行（SD 与脸/手质检的视觉模型都在本机）。
# 用法：
#   .\sd-inject.ps1                                    # 基底 + 表单直接跑
#   .\sd-inject.ps1 -BasePrompt "1girl, solo, portrait" -Width 512 -Height 768 -Name "inject" -NoOpen
#   .\sd-inject.ps1 -VisualReview off                  # 关掉视觉审查（整条跳过，不碰 Ollama）
#   .\sd-inject.ps1 -VisualReview on                   # 强制视觉审查（模型不可用就报错）
# 跨机器说明：
#   - 脸/手质检走本地视觉模型（-VlmModel，默认 qwen3-vl:8b，Ollama OpenAI 兼容端点 -QwenBase）；
#     接口没起来时质检自动跳过，不阻塞出图。
#   - 脸部细节词（-FaceBoostTags）自动追加进正向提示词，提升脸部质量；不想加传 ""。
#   - LoRA 在表单里选（SD 在跑时自动拉取本机列表）；只作用于最终出图（素体迭代先于表单）。
#   - -SdDirect 不传时取本脚本同目录的 sd-direct.ps1；-OutDir 不传时存到「脚本所在目录\SD-Picture」
#     （不受运行时的当前目录影响，保证与 sd-bridge 工具的落点一致）。
#   - 素体自检迭代（默认开）：出图前先用基底提示词试跑，换 seed 重试 + 面部修复，直到脸/手质检过关
#     （本地视觉模型打分）或到轮数上限；期间**只改 seed / 面部修复 / 脸部细节词，不改用户提示词**。
#     `-NoIterate` 关闭（直接出一张，老行为）；`-IterateRounds N` 调轮数（默认 3）。

param(
    # ===== 视觉审查总开关（放在参数最前面，一眼就能看到）=====
    #   auto（默认）= 视觉模型在跑就用，起不来降级，不阻断出图
    #   on         = 强制使用（模型不可用时报错，不静默降级）
    #   off        = 整条跳过：不探活、不冷启动 Ollama、不打分、不识别画风、不做最后审验
    [ValidateSet("auto","on","off")][string]$VisualReview = "auto",
    [string]$BasePrompt = "1girl, solo",
    [string]$BaseNegative = "lowres, bad anatomy, bad hands, extra fingers, fewer digits, watermark, text, signature, jpeg artifacts, worst quality, low quality",
    [string]$FaceBoostTags = "detailed face, beautiful detailed eyes, perfect face, detailed skin",   # 脸部细节词：自动追加进正向（用户要求）
    [string]$QwenBase = "http://127.0.0.1:11434/v1",   # 本地视觉质检接口（OpenAI 兼容）
    [string]$QwenApiKey = "ollama",                    # API Key（Ollama 任意非空即可）
    [int]$IterateRounds = 3,                           # 素体自检迭代轮数上限（每轮换 seed + 面部修复，脸部过关即停）
    [switch]$NoIterate,                                # 加 -NoIterate 则跳过素体自检迭代，直接出一张（老行为）
    [string]$VlmModel = "qwen3-vl:8b",                  # 人物肢体审核用的本地**能识图**的视觉模型（留空 "" = 自动挑本机 vl/vision 模型）
    [switch]$NoVlmReview,                              # 加 -NoVlmReview 则关闭视觉模型审核（不质检、也不做画风识别），出满 N 张由你自己挑
    [int]$VlmTimeoutSec = 300,                         # 单次审核（一张图一次打分）的超时秒数
    [int]$VlmImageMaxSide = 768,                       # 送审前把图压到长边不超过这个像素（判结构够用，能救「CPU 上跑不完」）
    [switch]$NoVramRelease,                            # 加 -NoVramRelease 则不做「开跑前先释放显存」的动作
    [double]$VramMinFreeGb = 4.0,                      # 开跑前剩余显存低于这个值就先释放对面那一侧（SD / 本地模型服务）
    [int]$SdPort = 7860,                               # SD API 端口（拉取 LoRA 列表用）
    [int]$Width = 512,
    [int]$Height = 768,
    [int]$Steps = 24,
    [double]$Cfg = 7,
    [string]$Sampler = "DPM++ 2M",
    [long]$Seed = -1,                                  # [long]：SD 的 seed 是 uint32（坑14）
    [string]$OutDir = "",
    [string]$Name = "inject",
    [string]$AddText = "",                              # 加字指令：预填进表单「加字」栏；出完图后由**另一档模型**在成品上写这段字（留空 = 不加）
    [string]$AddTextModel = "自动（换另一档）",           # 加字模型：默认自动挑「与生图不同的另一档」（Krea2 的字最准，故优先 Krea2）
    [double]$AddTextDenoise = 0.65,                     # 加字重绘幅度（ComfyUI 路由偏钝：<0.55 基本不动=字根本没写上去；实测 0.65 最稳）
    [int]$AddTextSteps = 0,                             # 加字步数（2026-10-21 加速）：0 = 自动（取该档默认步数与 16 的较小者）；实测 24→16 省 31% 时间且字一样准，想更快可给 12（也验过）
    [switch]$NoAddTextKeepBase,                         # 加 -NoAddTextKeepBase 则保留「整张 AI 重绘版」作为成品（默认改为：只在文字那块贴回原图）
    [string]$AddTextPos = "random",                     # 加字位置（2026-10-21 用户要求）：random=随机挑一格 / TL TC TR ML MC MR BL BC BR / 自由点 "x,y"（0-1 归一化，逗号分隔）
    [string]$AddTextSize = "中",                        # 加字字号（2026-10-21 用户要求）：小 / 中（默认，= 定稿模板那档）/ 大 / 特大
    [string]$AddTextStyle = "粗体无衬线（白）",           # 加字字体风格（2026-10-21 用户要求）：粗体无衬线（白，默认）/ 细体无衬线 / 衬线体 / 手写楷体 / 霓虹发光 / 描边黑体 / 中文书法
    [string]$SdDirect = "",                            # sd-direct.ps1 路径；留空则取脚本同目录
    [string]$SdDir = "",
    [string]$InitImage = "",                           # 底图（图生图用）：预填进表单「底图」栏；留空 = 用最近一张
    [string]$Mode = "",                                # 任务类型（由对话判断后提交）：文生图 / 图生图；留空 = 表单默认（文生图）
    [string]$MaskSpec = "",                            # 蒙版区域（C-1 替换用，对话提交）：上半（脸）/下半（衣服）/中间（主体）/四周（背景）及反选，或蒙版图路径
    [string]$IterDir = "",                             # 迭代中间图目录（必须可写）：留空 = <工作区>\.sd-inject-iter → 脚本目录 → 系统 temp
    [switch]$NoVlmStart,                              # 加 -NoVlmStart 则不自动冷启动本地视觉模型（Ollama 没开时不再替你拉起）
    [int]$VlmStartTimeout = 60,                       # 冷启动等待 Ollama 就绪的秒数（就绪后再等首次推理加载模型）
    [switch]$KeepWorkFiles,                            # 加 -KeepWorkFiles 则保留本次产生的中间图（预蒙版/命中率总览图），默认跑完自动清掉
    [switch]$NoAutoMask,                               # 加 -NoAutoMask 则不跑自动抠图（跳过 YOLO-World/SAM），只用几何区域蒙版（上半/下半/中间/四周）或你手填的框
    [switch]$NoOpen,                                  # 加 -NoOpen 则跑完不自动打开这张图
    [string]$ViolationPrompts = "",                    # 技术测试用：C 档会话末尾的违禁提示词，预填进表单第一个框（正向提示词）
    [string]$SuggestedPrompts = "",                     # 技术测试用：C 档会话末尾的建议替换词，预填进表单第二个框（负向提示词）
    [string]$GatewayUrl = "",                           # P1/P5：本地 AIGC 调度网关地址；留空 = 环境变量 GW_URL / GW_PORT / 默认 127.0.0.1:8799
    [switch]$NoGatewayAutoStart,                        # 加 -NoGatewayAutoStart 则网关没在跑时不自动拉起（直接报错）
    [switch]$LocalBackendFallback,                      # 应急开关：网关完全不可用时才允许退回「本地直连」出图（默认关闭，架构上要求走网关）
    [switch]$NoGateway,                                 # 极端应急：完全禁用网关路径（等同强制本地直连）
    [string]$Model = "QwenImage_NVFP4",                # C 档预生成默认档位（2026-10-20 改：默认 Qwen —— SD1.5 基座跑 1216x1536 会崩解剖，Qwen 原生高分辨率稳定）
    [string]$Lora = "",                                # C 档对话侧指定的 LoRA（"名称" 或 "名称 权重"）。预生成就带上，不再等表单里选（2026-10-27 修「指定不了 LoRA」）
    [switch]$NoPreGenerate,                             # 兼容旧参数：跳过「后台先生成」（现在默认就是跳过 —— 表单最先弹）
    [switch]$PreGenerate,                               # 加 -PreGenerate 才走 2026-10-18 的老顺序（先生成落盘 → 再弹表单）
    [switch]$NoReusePreGen,                             # 加 -NoReusePreGen 则关闭「参数没改就复用预生成成品」的加速路径
    [int]$PreGenTimeoutSec = 1800,                      # 后台预生成的等待上限（秒）
    [switch]$SelfTest,                                 # 加 -SelfTest 只跑参数锁矩阵自检并退出（不弹窗、不出图）
    [ValidateSet('ask','yes','no')][string]$StartDialog = 'ask'   # 开头「是/否」窗：ask=弹窗（默认）；yes/no=跳过弹窗直接定档（自动化/无人值守用）
)

# 启动诊断日志已关闭（用户要求 2026-10-14）：不再写 sd-inject-start.log

# ===========================================================================
# P5（2026-10-18）：网关客户端 —— 本脚本作为「前端」只跟本地 AIGC 调度网关说话，
#   不再直连 WebUI(7860) / ComfyUI(8188)。网关负责：4 模型枚举路由、任务表+状态机、
#   单车道排队锁、训练互斥、OOM 阶梯强杀、ROS2/降级监控。
#   绝对路径一律以 $Root（= $PSScriptRoot）为基准，不受运行时当前目录影响。
# ===========================================================================
$script:Root = $PSScriptRoot
if (-not $script:Root) { try { $script:Root = Split-Path -Parent $PSCommandPath } catch { } }
if (-not $script:Root) { $script:Root = (Get-Location).Path }
$Root = $script:Root

# 模型枚举（严格 4 个，不可扩展；下拉框只列这 4 个）
$script:GatewayModels = @('SD_FP16', 'Anima_INT8', 'QwenImage_NVFP4', 'Krea2_Q4')
$script:GatewayModelLabels = [ordered]@{
    'SD_FP16'         = 'SD_FP16（WebUI·FP16）'
    'Anima_INT8'      = 'Anima_INT8（WebUI·INT8）'
    'QwenImage_NVFP4' = 'QwenImage_NVFP4（ComfyUI）'
    'Krea2_Q4'        = 'Krea2_Q4（ComfyUI·≤1024）'
}

# ---- 每档模型的硬约束：表单据此**锁住**不满足生成条件的选项（用户要求 2026-10-19）----
# 目标：模型选中后，下方比例/画质/Denoising/迭代等只能选「这一档真的能出图」的值，
#       把"选错参数"从"提交后才报错"前移到"下拉里根本选不到"。
# maxSide：长边上限（Krea2 训练分辨率 ≤1024；SD/Qwen 收在 1536）
# minShortSide：短边下限（Get-SizeFor 把画质档作用在**短边**上；<512 时 SD 系必糊）
function Get-ModelMaxSide {
    param([string]$Model)
    if ($Model -eq 'Krea2_Q4') { return 1024 }
    # 2026-10-20：SD 系（A1111）也收到 1024 —— SD1.5 基座在 1216x1536 上必然崩解剖（多头/断肢/关节反向），
    # 用户实测图已确认；要更大尺寸请换 QwenImage_NVFP4（原生高分辨率稳定）。
    return 1024
}
function Get-ModelEngineFor {
    param([string]$Model)
    if ($Model -in @('QwenImage_NVFP4', 'Krea2_Q4')) { return 'comfy' }
    return 'webui'
}
# 返回哪些画质档在该模型+该比例下可用（不可用的进 Rejected，带原因）
# 每档的 CFG 推荐值：SD 系（A1111）= 7；ComfyUI 两档都是 flow 系蒸馏模型，cfg 必须压到 1，
# 用 7 会直接出糊图 + 色斑（本机实测：qwen-image 2.1 在 cfg=7 下整张融化）。
function Get-ModelCfg {
    param([string]$Model)
    if ((Get-ModelEngineFor -Model $Model) -eq 'comfy') { return 1.0 }
    return 7.0
}
# 每档的默认步数（与 gateway/lib/models.js 的 stepsHint 对齐）
function Get-ModelSteps {
    param([string]$Model)
    if ($Model -eq 'QwenImage_NVFP4') { return 24 }
    if ($Model -eq 'Krea2_Q4') { return 24 }
    return 30
}
# 该模型在指定模式下允许的 Denoising 档（返回字符串数组，第一项是默认值）
#   · 文生图：只有「0（文生图·不用底图）」—— 底图都没有，给重绘幅度没有意义
#   · 图生图 + comfy：0.55-0.75（Comfy 的 denoise 语义比 A1111 更敏感，低了不动、高了换人）
#   · 图生图 + webui：0.3-0.9 全开（与原行为一致）
function Get-AllowedDenoiseTiers {
    param([string]$Model, [string]$Mode)
    if ($Mode -eq '文生图') { return @('0（文生图·不用底图）') }
    $isComfy = ((Get-ModelEngineFor -Model $Model) -eq 'comfy')
    if ($isComfy) { return @('0.6', '0.65', '0.7', '0.75', '0.55') }
    return @('0.65', '0.3', '0.4', '0.45', '0.5', '0.6', '0.7', '0.8', '0.9')
}
function Get-AllowedQualityTiers {
    param([string]$Model, [string]$Ratio, [string[]]$AllTiers)
    $maxSide = Get-ModelMaxSide -Model $Model
    $ok = @(); $rej = @()
    foreach ($t in $AllTiers) {
        $s = Get-SizeFor -Ratio $Ratio -Quality $t
        $mx = [Math]::Max($s.W, $s.H)
        $mn = [Math]::Min($s.W, $s.H)
        if ($mx -gt $maxSide) { $rej += [PSCustomObject]@{ Tier = $t; Why = "长边 $mx 超过 $maxSide"; W = $s.W; H = $s.H }; continue }
        if ($mn -lt 512) { $rej += [PSCustomObject]@{ Tier = $t; Why = "短边 $mn 低于 512（会糊）"; W = $s.W; H = $s.H }; continue }
        $ok += $t
    }
    return @{ Allowed = $ok; Rejected = $rej; MaxSide = $maxSide }
}
# 该模型下可用的比例档：只要存在至少一个画质档合法（长边<=maxSide 且 短边>=512），
# 该比例就保留为可选项 —— 21:9 在 Krea2 下只剩 1024p 可用，但比例本身不该整条被删。
function Get-AllowedRatios {
    param([string]$Model, [string]$Quality = "", [string[]]$AllRatios, [string[]]$AllTiers = @())
    $maxSide = Get-ModelMaxSide -Model $Model
    $tiers = if ($AllTiers -and @($AllTiers).Count -gt 0) { @($AllTiers) } else { if ($Quality) { @($Quality) } else { @("1024p") } }
    $ok = @()
    foreach ($r in $AllRatios) {
        foreach ($t in $tiers) {
            $s = Get-SizeFor -Ratio $r -Quality $t
            $mx = [Math]::Max($s.W, $s.H)
            $mn = [Math]::Min($s.W, $s.H)
            if ($mx -le $maxSide -and $mn -ge 512) { $ok += $r; break }
        }
    }
    return $ok
}
# 状态 → 颜色（P5 硬要求：queued 黄 / training 橙 / running 蓝 / success 绿 / failed 红）
# 懒构造：System.Drawing 是在表单段落才 Add-Type 的，这里不能在脚本顶层就摸它。
function Get-GatewayStatusColor {
    param([string]$Status, $Label = $null)
    if (-not $script:GatewayStatusColors) {
        $script:GatewayStatusColors = @{}
        try {
            $script:GatewayStatusColors['queued']   = [System.Drawing.Color]::FromArgb(176, 134, 11)    # 黄
            $script:GatewayStatusColors['training'] = [System.Drawing.Color]::FromArgb(210, 105, 30)    # 橙
            $script:GatewayStatusColors['running']  = [System.Drawing.Color]::FromArgb(30, 144, 255)    # 蓝
            $script:GatewayStatusColors['success']  = [System.Drawing.Color]::FromArgb(34, 139, 34)     # 绿
            $script:GatewayStatusColors['failed']   = [System.Drawing.Color]::FromArgb(178, 34, 34)     # 红
        } catch {
            # System.Drawing 不可用时退化为「不改色」，绝不因为取色失败打断出图
            $script:GatewayStatusColors = $null
            return $null
        }
    }
    $c = $script:GatewayStatusColors[$Status]
    if ($c -and $Label -and $Label.ForeColor) { }
    return $c
}
$script:GatewayTaskId = ''
$script:GatewayPaths = @()
$script:GatewayLastError = ''
# P5：状态文案（含中文说明），表单状态栏显示「running（正在出图）」这种可读形式
function Get-GatewayStatusText {
    param([string]$Status)
    $map = @{
        'queued'       = 'queued（排队中）'
        'training'     = 'training（训练独占中）'
        'running'      = 'running（正在出图）'
        'success'      = 'success（完成）'
        'failed'       = 'failed（失败）'
        'disconnected' = '与网关断开连接'
    }
    if ($map.ContainsKey($Status)) { return $map[$Status] }
    return $Status
}

# ---- 视觉审查总开关（2026-10-19 用户要求：审查必须是"可选项"，拒绝就整条跳过）----
#   -VisualReview off / -NoVlmReview  → 后续生图完全跳过视觉这一步：不探活、不冷启动、
#                                       不打分、不做画风识别、不调 Ollama，出满 N 张由你自己挑
#   auto（默认）→ 模型在跑就用，起不来就降级（不阻断出图）
#   on           → 强制使用（模型不可用时明确报错，不静默降级）
function Test-VisualReviewOff {
    if ($NoVlmReview) { return $true }
    if ("$VisualReview" -eq "off") { return $true }
    return $false
}
function Test-VisualReviewForced {
    return ("$VisualReview" -eq "on")
}

# 网关地址：-GatewayUrl > 环境变量 GW_URL > GW_PORT > 默认端口
function Get-GatewayBase {
    if ($GatewayUrl) { return $GatewayUrl.TrimEnd('/') }
    if ($env:GW_URL) { return $env:GW_URL.TrimEnd('/') }
    $port = 8799
    if ($env:GW_PORT) { $null = [int]::TryParse($env:GW_PORT, [ref]$port) }
    return "http://127.0.0.1:$port"
}

# 网关是否在线（任何异常都当离线，不抛）
function Test-GatewayUp {
    param([string]$Base = '')
    if (-not $Base) { $Base = Get-GatewayBase }
    try {
        $h = Invoke-RestMethod -Uri "$Base/api/health" -Method Get -TimeoutSec 2
        return ($h.gateway -eq 'ok')
    } catch { return $false }
}

# 找网关入口 gateway\index.js（脚本同目录 → 工作区镜像 → DSH 插件目录）
function Find-GatewayEntry {
    $cands = @()
    if ($env:GW_INDEX) { $cands += $env:GW_INDEX }
    $cands += (Join-Path $script:Root 'gateway\index.js')
    $cands += (Join-Path $script:Root 'dsh-unrestricted-printing\gateway\index.js')
    $cands += (Join-Path (Split-Path -Parent $script:Root) 'gateway\index.js')
    $cands += (Join-Path (Split-Path -Parent $script:Root) 'dsh-unrestricted-printing\gateway\index.js')
    if ($env:USERPROFILE) {
        $cands += (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-unrestricted-printing\gateway\index.js')
    }
    foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return ''
}

# 网关没在跑就拉起来（node gateway\index.js），最多等 WaitSec 秒
function Start-GatewayIfNeeded {
    param([int]$WaitSec = 30)
    $base = Get-GatewayBase
    if (Test-GatewayUp -Base $base) { return $true }
    if ($NoGateway -or $NoGatewayAutoStart) { return $false }
    $entry = Find-GatewayEntry
    if (-not $entry) {
        Write-Host "网关未运行，且找不到 gateway\index.js（脚本目录：$script:Root）" -ForegroundColor Yellow
        return $false
    }
    $node = 'node'
    try {
        $cmd = Get-Command node -ErrorAction SilentlyContinue
        if ($cmd) { $node = $cmd.Source }
    } catch { }
    Write-Host "网关未运行 → 正在拉起：$entry" -ForegroundColor Cyan
    try {
        $gwLog = Join-Path $script:IterTempDir 'gateway-run.log'
        Start-Process -FilePath $node -ArgumentList @("`"$entry`"") -WindowStyle Hidden `
            -RedirectStandardOutput $gwLog -RedirectStandardError "$gwLog.err" | Out-Null
    } catch {
        Write-Host "拉起网关失败：$($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }
    $deadline = (Get-Date).AddSeconds($WaitSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 700
        if (Test-GatewayUp -Base $base) { Write-Host "网关已就绪：$base" -ForegroundColor Green; return $true }
    }
    Write-Host "网关启动超时（${WaitSec}s）：$base" -ForegroundColor Yellow
    return $false
}

# Krea2_Q4 尺寸硬闸（P5 硬要求：宽或高 > 1024 弹窗报错并 return）
function Test-GatewayModelSize {
    param([string]$Model, [int]$Width, [int]$Height)
    if ($Model -eq 'Krea2_Q4' -and ($Width -gt 1024 -or $Height -gt 1024)) {
        return @{ Ok = $false; Message = "Krea2_Q4 宽/高不得超过 1024，当前 $Width x $Height（请调小画质档或换模型）" }
    }
    foreach ($k in @('SD_FP16', 'Anima_INT8', 'QwenImage_NVFP4')) {
        if ($Model -eq $k -and ($Width -gt 1536 -or $Height -gt 1536)) {
            return @{ Ok = $false; Message = "$k 长边不得超过 1536，当前 $Width x $Height" }
        }
    }
    if ($Width -lt 64 -or $Height -lt 64) { return @{ Ok = $false; Message = "宽高过小：$Width x $Height" } }
    return @{ Ok = $true; Message = '' }
    # 短边下限（2026-10-19）：264x480 这类尺寸 SD 系必糊 → 表单下拉已先锁，这里是手填尺寸的第二道闸
    $shortSide = [Math]::Min([int]$Width, [int]$Height)
    if ($shortSide -lt 512) {
        return @{ Ok = $false; Message = "短边 $shortSide 小于 512（$Width x $Height 出图会糊）：请把画质档调高，或让宽高都 ≥512" }
    }
}

# 提交任务：POST /api/generate（TimeoutSec 2，全部 try-catch；返回 @{Ok;TaskId;Message}）
# 路由适配（2026-10-21 用户反馈）：画风档注入的 `<lora:name:weight>` 是 **A1111 语法**，
#   ComfyUI 路由（QwenImage_NVFP4 / Krea2_Q4）的文本节点**不解析**它 —— 留着不但不生效，
#   还会把 "<lora:semirealisticanime:0.6>" 当普通文字塞进提示词。所以提交前按路由剔除。
function Remove-LoraTags {
    param([string]$Text)
    if (-not $Text) { return $Text }
    $t = $Text -replace '<lora:[^>]*>\s*,?\s*', ''
    $t = $t -replace '(,\s*){2,}', ', '
    return $t.Trim()
}
# 已知错误 → 人话 + 可执行动作（2026-10-21：用户贴的 `HostBuffer.read_file_slice failed` 属于这一类）
function Get-ErrorHint {
    param([string]$Message)
    $m = "$Message"
    if ($m -match 'read_file_slice|safetensors_rust|HostBuffer') {
        return '↳ 权重/文本编码器文件读取失败（safetensors 读片失败）：多半是①该文件损坏或没下完 ②被别的进程占用（同时开了两个 ComfyUI / 正在下载）③磁盘读错。可执行：重跑一次 → 仍失败就重启 ComfyUI（网关 POST /api/engines/comfy/restart）→ 再不行重下该文件。'
    }
    if ($m -match 'out of memory|Not enough memory|CUDA error|OutOfMemory') {
        return '↳ 显存/内存不足：关掉占显存的程序；网关的三级自愈（清理显存 → CPU → 核显）会自动接手。'
    }
    if ($m -match 'lora' -and $m -match 'not in list|找不到|lora_name') {
        return '↳ LoRA 相关：文件名要能在表单「LoRA」下拉里看到（那就是 ComfyUI 认的可用名，例如 sd_lora\add_detail.safetensors）。'
    }
    if ($m -match 'not in list|Value not in list') {
        return '↳ 参数值不在可选列表里：多为模型/采样器名对不上，按提示换一个再出。'
    }
    return ''
}

function New-GatewayTask {
    param(
        [string]$Model,
        [string]$Prompt,
        [string]$Negative = '',
        [int]$Width, [int]$Height, [int]$Steps, [double]$Cfg = 7,
        [string]$Sampler = 'DPM++ 2M', [double]$Denoise = 0,
        [string]$InitImage = '', [string]$Mask = '', [string]$Name = 'inject',
        [hashtable]$Extra = $null,
        [string]$OutDir = "",
        [string]$Checkpoint = ""    # 2026-10-19 修：表单/画风选的 checkpoint 以前根本没送网关 → 画风改不动
    )
    # LoRA（2026-10-21 用户要求「让 comfy 也能读取并正常使用 lora」）：**不再剔除** ——
    #   网关已把这句 A1111 语法翻译成真正的 ComfyUI 节点（LoraLoaderModelOnly / LoraLoader），
    #   Ai1111 路由本来就原生解析它。这里只是打一条日志说明这次交给了谁。
    $promptForGw = $Prompt
    try {
        $nLora = ([regex]::Matches("$promptForGw", '<\s*lora\s*:\s*[^:>]+')).Count
        if ($nLora -gt 0 -and -not $script:LoraForwardWarned) {
            $script:LoraForwardWarned = $true
            if ((Get-ModelEngineFor -Model $Model) -eq 'comfy') {
                Write-Host ("[LoRA] 提示词含 {0} 个 <lora:…> → 交由网关翻译成 ComfyUI 的 LoRA 节点（Qwen/Krea2 只打 model 补丁；SD/SDXL 系打 model+clip）" -f $nLora) -ForegroundColor Cyan
            } else {
                Write-Host ("[LoRA] 提示词含 {0} 个 <lora:…> → 走 A1111 路由，原生解析" -f $nLora) -ForegroundColor Cyan
            }
        }
    } catch { }
    $body = @{
        model = $Model; prompt = $promptForGw; negative = $Negative
        width = $Width; height = $Height; steps = $Steps; cfg = $Cfg
        denoise = $Denoise; name = $Name
    }
    # 采样器只在 WebUI 路由下透传：A1111 的名字（DPM++ 2M）ComfyUI 不认——
    # 发过去会让 ComfyUI 在工作流校验阶段 400（用户实测：两次都没出图就是这个）。
    # ComfyUI 路由留空 = 由网关按该模型的推荐采样器出图。
    if ($Sampler -and $Model -in @('SD_FP16', 'Anima_INT8')) { $body.sampler = $Sampler }
    if ($InitImage) { $body.init_image = $InitImage }
    if ($Mask) { $body.mask = $Mask }
    if ($OutDir) { $body.out_dir = $OutDir }
    if ($Extra) { $body.extra = $Extra }
    if ($Checkpoint -and $Model -in @("SD_FP16", "Anima_INT8")) { $body.checkpoint = $Checkpoint }   # 只对 WebUI 路由有意义
    $base = Get-GatewayBase   # 2026-10-19 修：这行被误删 → $base 为空 → URI 变成 "/api/generate" → 「无效的 URI：未能分析主机名」
    $json = $body | ConvertTo-Json -Depth 8 -Compress
    try {
        $resp = Invoke-RestMethod -Uri "$base/api/generate" -Method Post -Body $json `
            -ContentType 'application/json; charset=utf-8' -TimeoutSec 2
        if ($resp -and $resp.task_id) { return @{ Ok = $true; TaskId = [string]$resp.task_id; Message = '' } }
        return @{ Ok = $false; TaskId = ''; Message = '网关未返回 task_id' }
    } catch {
        $detail = ''
        try { if ($_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message } } catch { }
        # 409 = 训练独占拦截（明确语义，不当成断连）
        if ("$detail" -match 'TRAINING_IN_PROGRESS' -or "$($_.Exception.Message)" -match '409') {
            return @{ Ok = $false; TaskId = ''; Message = '训练进行中（独占锁）：生图被网关拦截' }
        }
        return @{ Ok = $false; TaskId = ''; Message = "提交失败：$($_.Exception.Message) $detail" }
    }
}

# 查询任务：GET /api/status/{id}（TimeoutSec 2）
function Get-GatewayTask {
    param([string]$TaskId)
    $base = Get-GatewayBase
    try {
        $s = Invoke-RestMethod -Uri "$base/api/status/$TaskId" -Method Get -TimeoutSec 2
        return @{ Ok = $true; Status = [string]$s.status; Raw = $s; Message = '' }
    } catch {
        return @{ Ok = $false; Status = ''; Raw = $null; Message = "$($_.Exception.Message)" }
    }
}

function Get-GatewayStepsDefault {
    try { if ($Steps -and [int]$Steps -gt 0) { return [int]$Steps } } catch { }
    return 30
}

# 让网关按需拉起引擎（webui / comfy）。前端不自己拼启动命令、也不直接连 7860/8188。
function Invoke-GatewayEnsureEngine {
    param(
        [string]$Engine,
        [int]$TimeoutSec = 60,
        [scriptblock]$OnTick = $null   # 2026-10-19：每轮回调（表单侧用它 DoEvents + 刷新"已等待 Ns"，避免 240s 静默假死）
    )
    $base = Get-GatewayBase
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastMsg = ""
    $started = Get-Date
    $firstTry = $true
    while ((Get-Date) -lt $deadline) {
        try {
            # 单次 HTTP 超时：首次（可能触发网关 spawn 引擎）给 300s；之后每次只探测 15s，
            # 这样即使网关卡在 waitReady，前端也能每 15s 拿到一次控制权去刷新界面。
            $per = if ($firstTry) { 300 } else { 15 }
            $firstTry = $false
            $r = Invoke-RestMethod -Uri "$base/api/engines/$Engine/ensure" -Method Post `
                -Body '{}' -ContentType 'application/json' -TimeoutSec $per
            if ($r -and $r.online) { return @{ Ok = $true; Started = [bool]$r.started; Message = "" } }
            $lastMsg = "引擎尚未就绪（已等待 $([int]((Get-Date) - $started).TotalSeconds)s）"
        } catch {
            $lastMsg = "$($_.Exception.Message)（已等待 $([int]((Get-Date) - $started).TotalSeconds)s）"
        }
        if ($OnTick) { try { & $OnTick ([int]((Get-Date) - $started).TotalSeconds) $lastMsg } catch { } }
        Start-Sleep -Milliseconds 1200
    }
    return @{ Ok = $false; Started = $false; Message = $lastMsg }
}
# 同步等待（控制台路径用；表单路径用 Timer 异步轮询，绝不卡界面）
function Wait-GatewayTask {
    param([string]$TaskId, [int]$TimeoutSec = 3600, [int]$IntervalMs = 3000)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $fails = 0
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds $IntervalMs
        $r = Get-GatewayTask -TaskId $TaskId
        if (-not $r.Ok) {
            $fails++
            if ($fails -ge 3) { return @{ Ok = $false; Status = 'disconnected'; Message = '与网关断开连接'; Raw = $null } }
            continue
        }
        $fails = 0
        Write-Host ("  [网关] {0}" -f $r.Status) -ForegroundColor DarkGray
        if ($r.Status -in @('success', 'failed')) { return @{ Ok = ($r.Status -eq 'success'); Status = $r.Status; Raw = $r.Raw; Message = [string]$r.Raw.error } }
    }
    return @{ Ok = $false; Status = 'timeout'; Message = "等待超时（${TimeoutSec}s）"; Raw = $null }
}

# ===========================================================================
# C 档新流程（用户要求 2026-10-18 / 进度显示 2026-10-19）：
#   先在后台把图画好 → 按命名规则落进指定路径（-OutDir，插件调用时就是对话工作区的 SD-Picture）
#   → 再把参数表单窗口弹出来给用户看/改。
#   全程给出**步骤清单 + 进度条**（7 步）：用户随时知道"现在卡在哪一步、还剩多少"。
#   （-NoPreGenerate 可关掉这个行为，退回"先弹窗、点了才出图"的老流程。）
# ===========================================================================

# ---- 进度显示：步骤清单（[n/7]）+ 双进度条（Id1 总步骤 / Id2 采样进度）----
$script:OpTotalSteps = 7
function Write-OpStep {
    param([int]$Index, [string]$Title, [string]$Detail = '', [ValidateSet('run', 'ok', 'fail', 'skip')][string]$State = 'run')
    $mark = switch ($State) { 'ok' { '✓' } 'fail' { '✗' } 'skip' { '−' } default { '▶' } }
    $color = switch ($State) { 'ok' { 'Green' } 'fail' { 'Red' } 'skip' { 'DarkYellow' } default { 'Cyan' } }
    $line = "  [{0}/{1}] {2} {3}" -f $Index, $script:OpTotalSteps, $mark, $Title
    if ($Detail) { $line += "  —— " + $Detail }
    Write-Host $line -ForegroundColor $color
    try {
        $pct = [int](($Index - 1) / $script:OpTotalSteps * 100)
        if ($State -eq 'ok') { $pct = [int]($Index / $script:OpTotalSteps * 100) }
        Write-Progress -Id 1 -Activity 'C 档：后台预生成' -Status ("[{0}/{1}] {2} {3}" -f $Index, $script:OpTotalSteps, $Title, $Detail) -PercentComplete $pct
    } catch { }
}

function Stop-OpProgress {
    try { Write-Progress -Id 1 -Activity 'C 档：后台预生成' -Completed } catch { }
    try { Write-Progress -Id 2 -Activity '出图采样' -Completed } catch { }
}

# 带进度条的等待：轮询网关 /api/progress/{taskId}（前端不直连引擎，进度由网关统一给）
function Wait-GatewayTaskWithProgress {
    param([string]$TaskId, [int]$TimeoutSec = 1800, [int]$StepIndex = 5)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $fails = 0
    $lastPct = -1
    $lastPrint = Get-Date
    while ((Get-Date) -lt $deadline) {
        $pg = $null
        try { $pg = Invoke-RestMethod -Uri "$(Get-GatewayBase)/api/progress/$TaskId" -Method Get -TimeoutSec 3 } catch { $pg = $null }
        if (-not $pg) {
            $fails++
            if ($fails -ge 3) { Stop-OpProgress; return @{ Ok = $false; Status = 'disconnected'; Message = '与网关断开连接'; Raw = $null } }
            Start-Sleep -Seconds 2
            continue
        }
        $fails = 0
        $pct = [int]$pg.percent
        if ($pct -lt 0) { $pct = 0 }; if ($pct -gt 100) { $pct = 100 }
        $eta = if ($pg.eta_sec) { " · 预计剩 $($pg.eta_sec)s" } else { '' }
        try {
            Write-Progress -Id 2 -Activity ("出图（{0}）" -f $pg.model) -Status ("{0}｜{1}%{2}{3}" -f $pg.detail, $pct, $eta, $(if ($pg.estimated) { '（估算）' } else { '' })) -PercentComplete $pct
        } catch { }
        # 控制台每 3 秒或每变化 5% 打一行（避免刷屏）
        if (($pct - $lastPct -ge 5) -or (((Get-Date) - $lastPrint).TotalSeconds -ge 3)) {
            $st = if ($pg.stage -eq 'queued') { '排队' } elseif ($pg.stage -eq 'loading') { '加载' } else { '采样' }
            Write-Host ("      {0} {1,3}%{2}{3}" -f $st, $pct, $eta, $(if ($pg.estimated) { '（估算）' } else { '' })) -ForegroundColor DarkGray
            $lastPct = $pct
            $lastPrint = Get-Date
        }
        if ($pg.status -in @('success', 'failed')) {
            Stop-OpProgress
            $raw = (Get-GatewayTask -TaskId $TaskId).Raw
            return @{ Ok = ($pg.status -eq 'success'); Status = [string]$pg.status; Raw = $raw; Message = [string]$pg.detail }
        }
        Start-Sleep -Milliseconds 800
    }
    Stop-OpProgress
    return @{ Ok = $false; Status = 'timeout'; Message = "等待超时（${TimeoutSec}s）"; Raw = $null }
}

function Invoke-PreGenerate {
    param([string]$Prompt, [string]$Negative, [int]$TimeoutSec = 1800, [string]$ModelOverride = '', [string]$LoraSpec = '')
    # 2026-10-19：预生成必须跟随**表单里最终调用的那一档**，而不是命令行 -Model 参数。
    # 之前只看 $Model（默认 SD_FP16），用户在表单里选 Krea2/Qwen 时，预生成仍在跑 SD —
    # 预生成失败又只 return $null（不弹窗），用户完全看不见，等于白烧一次显卡。
    $pgModel = if ($ModelOverride -and ($script:GatewayModels -contains "$ModelOverride")) {
        "$ModelOverride"
    } elseif ($script:GatewayModels -contains "$Model") { "$Model" } else { 'SD_FP16' }

    # ---- LoRA 预生成拼接（2026-10-27 修「C 档指定不了 LoRA」；用户要求「所有模型通用 LoRA」）----
    #   预生成跑在表单弹出之前，LoRA 只能在命令行 -Lora 传入。这里拼进 prompt；
    #   DiT 档（Qwen/Krea2）**不切档** —— 网关有跨架构 LoRA 搬运（bridge：Stage1 SD_FP16+LoRA
    #   → Stage2 DiT img2img 迁移风格），4 个模型档都能用同一套 SD1.5 LoRA（优先适配 ComfyUI）。
    $pgPrompt = $Prompt
    # 索引语料 = 正向词 + 命名 + 违禁词段（对话侧常把中文角色名翻成外观描述、把角色名丢进 Name 或违规段，
    # 只扫正向框会漏；2026-10-27 实测：BasePrompt 全是 silver hair/blue eyes、只有 Name=shorekeeper 命中）
    $loraSearchText = "$Prompt $Name $ViolationPrompts"
    $pgLoraSpec = Get-EffectiveLoraSpec -Explicit $LoraSpec -Prompt $loraSearchText
    if ($pgLoraSpec -and ($pgLoraSpec -ne "$LoraSpec")) {
        Write-Host "预生成 LoRA：命令行未显式指定 → 从 prompt/命名 模糊索引命中「$pgLoraSpec」" -ForegroundColor Cyan
    }
    if ($pgLoraSpec) {
        $pgPrompt = Add-LoraToPrompt -Prompt $Prompt -LoraSpec $pgLoraSpec
    }
    $pgEngine = Get-ModelEngineFor -Model $pgModel

    # ---- 尺寸保护（2026-10-27 修「SD_FP16 崩解剖 / OOM」）----
    #   SD1.5 基座在 1216x1536 上必然崩（多头/断肢/关节反向），且 WebUI 加载大模型会 OOM。
    #   SD 系（webui 引擎）预生成强制收到 768x1024；DiT 系（comfy）保持原尺寸。
    $pgWidth = $Width
    $pgHeight = $Height
    if ($pgEngine -eq 'webui') {
        if ($pgWidth -gt 768 -or $pgHeight -gt 1024) {
            $pgWidth = 768; $pgHeight = 1024
            Write-Host "预生成尺寸保护：$pgModel 是 SD 系（webui），$($Width)x$($Height) 降为 768x1024（避免崩解剖/OOM）" -ForegroundColor Yellow
        }
    }

    # ---- 显存释放（2026-10-27 修「WebUI CUDA OOM」）----
    #   SD_FP16 出图前必须先卸掉本地视觉模型（Ollama 常驻 5G+），否则 WebUI 加载 checkpoint 直接 OOM。
    if ($pgEngine -eq 'webui') {
        $null = Release-OllamaVram
        Start-Sleep -Milliseconds 800
    }

    # ---- [1/7] 参数与目录 ----
    Write-OpStep 1 '检查参数与目录' ("模型={0} 尺寸={1}x{2} 步数={3} 输出={4}" -f $pgModel, $pgWidth, $pgHeight, $Steps, $OutDir)
    if ($NoGateway) {
        Write-OpStep 1 '检查参数与目录' '已禁用网关（-NoGateway）→ 跳过后台预生成' -State 'skip'
        Stop-OpProgress
        return $null
    }
    $g = Test-GatewayModelSize -Model $pgModel -Width $pgWidth -Height $pgHeight
    if (-not $g.Ok) {
        Write-OpStep 1 '检查参数与目录' ("尺寸不合法：" + $g.Message) -State 'fail'
        Stop-OpProgress
        return $null
    }

    # ---- [2/7] 网关就绪 ----
    Write-OpStep 2 '网关就绪' (Get-GatewayBase)
    if (-not (Start-GatewayIfNeeded -WaitSec 30)) {
        Write-OpStep 2 '网关就绪' '网关不可用 → 跳过（表单照常弹出，可稍后重试）' -State 'fail'
        Stop-OpProgress
        return $null
    }
    Write-OpStep 2 '网关就绪' ("已就绪：" + (Get-GatewayBase)) -State 'ok'

    # ---- [3/7] 引擎就绪（必要时拉起 SD / ComfyUI，30-60s）----
    Write-OpStep 3 ("引擎就绪（$pgEngine）") '在线即秒回；没在线则由网关拉起（SD ~30s / ComfyUI ~40s）'
    $ens = Invoke-GatewayEnsureEngine -Engine $pgEngine -TimeoutSec 240
    if (-not $ens.Ok) {
        Write-OpStep 3 ("引擎就绪（$pgEngine）") ("未就绪：" + $ens.Message) -State 'fail'
        Stop-OpProgress
        return $null
    }
    Write-OpStep 3 ("引擎就绪（$pgEngine）") $(if ($ens.Started) { '本次由网关拉起并已就绪' } else { '本已在线' }) -State 'ok'

    # ---- [3.5/7] 模型可用性（未就绪不静默跳过，写清原因）----
    # 用户要求 2026-10-19：任何档都可以被选，但**不许静默失败**。
    # 缺权重时把"缺哪个文件"直接打到控制台步骤里，表单照常弹出可换档。
    try {
        $mm = Invoke-RestMethod -Uri "$(Get-GatewayBase)/api/models?refresh=1" -Method Get -TimeoutSec 20
        foreach ($it in @($mm.models)) {
            if ([string]$it.key -eq $pgModel) {
                if ([string]$it.status -ne 'ok') {
                    $miss = ''
                    try { if ($it.missing) { $miss = (@($it.missing) -join ', ') } } catch { }
                    Write-OpStep 3 ("模型可用性（$pgModel）") ("未就绪：" + [string]$it.detail + $(if ($miss) { " ｜ 缺少 $miss" } else { '' })) -State 'fail'
                    Stop-OpProgress
                    return $null
                }
                Write-OpStep 3 ("模型可用性（$pgModel）") 'ok' -State 'ok'
                break
            }
        }
    } catch { }

    # ---- [4/7] 提交任务 ----
    # 尺寸/底图/蒙版：图生图模式下带参考图与 denoise
    $pgInit = ''
    $pgMask = ''
    $pgDen = 0.0
    if ($Mode -eq '图生图' -and $InitImage) {
        $pgInit = Resolve-InitImagePath -Raw $InitImage -OutDirPath $OutDir
        $pgDen = 0.65     # 图生图默认重绘幅度（用户 2026-10-18 指定；与表单里的默认档位一致）
        if ($MaskSpec -and $MaskSpec -match '\.(png|jpg|jpeg|webp|bmp)$' -and (Test-Path -LiteralPath $MaskSpec)) { $pgMask = $MaskSpec }
    }
    Write-OpStep 4 '提交任务' ("{0}{1}" -f $(if ($pgInit) { "图生图（底图=$([IO.Path]::GetFileName($pgInit)) denoise=$pgDen）" } else { '文生图' }), $(if ($pgMask) { ' + 蒙版' } else { '' }))
    # 跨架构搬运（bridge）时给 Stage1 指定动漫底模（2026-10-27 用户要求「优先适配 comfy」）：
    #   Stage1 若用 WebUI 当前的 anything-v5，会出灰泥糊图，Stage2 再低 denoise 也救不回来。
    $pgExtra = $null
    if ($pgLoraSpec -and $pgModel -in @('QwenImage_NVFP4', 'Krea2_Q4')) {
        try {
            $animeCk = Get-AnimeCheckpoint -Checkpoints @(Get-SdCheckpoints)
            if (-not $animeCk) {
                $pref = @(Get-SdCheckpoints | Where-Object { $_ -match 'Illustrious|wai|AWPainting|ReVAnimated|寿司' } | Select-Object -First 1)
                if ($pref.Count -gt 0) { $animeCk = [string]$pref[0] }
            }
            if ($animeCk) {
                $pgExtra = @{ use_bridge = $true; bridge_denoise = 0.55; bridge_checkpoint = "$animeCk" }
                Write-Host "跨架构搬运 Stage1 底模 → $animeCk（避免 anything-v5 灰泥风）" -ForegroundColor DarkGray
            }
        } catch { }
    }
    $sub = New-GatewayTask -Model $pgModel -Prompt $pgPrompt -Negative $Negative `
        -Width $pgWidth -Height $pgHeight -Steps (Get-ModelSteps -Model $pgModel) -Cfg (Get-ModelCfg -Model $pgModel) -Denoise $pgDen `
        -Sampler $(if ($pgEngine -eq 'webui') { "$Sampler" } else { '' }) `
        -InitImage $pgInit -Mask $pgMask -Name $Name -OutDir $script:IterTempDir -Extra $pgExtra   # 先落临时目录，随后按命名规则复制进 $OutDir
    # （这样目标目录里只出现一份成品，不会夹带网关的原始文件名）
    if (-not $sub.Ok) {
        Write-OpStep 4 '提交任务' ("失败：" + $sub.Message) -State 'fail'
        Stop-OpProgress
        return $null
    }
    Write-OpStep 4 '提交任务' ("task=" + $sub.TaskId.Substring(0, 8)) -State 'ok'

    # ---- [5/7] 出图（进度条在这里动）----
    # [5/7] 明确写出这次用了什么 LoRA（用户要求 2026-10-27：第五步要能看到 LoRA）
    $loraShow = '（不用 LoRA）'
    if ($pgLoraSpec -and $pgLoraSpec.Trim() -and $pgLoraSpec.Trim() -ne '（不用 LoRA）') {
        $ls0 = Parse-LoraSpec -Spec $pgLoraSpec
        if ($ls0) {
            $loraShow = "<lora:$($ls0.Name):$($ls0.Weight)>"
            if (-not ($LoraSpec -and $LoraSpec.Trim())) { $loraShow += '（自动索引）' }
            if ($pgModel -in @('QwenImage_NVFP4', 'Krea2_Q4')) {
                $loraShow += "（跨架构搬运：Stage1 SD_FP16+LoRA → Stage2 $pgModel img2img）"
            }
        }
    }
    Write-OpStep 5 '出图' ("模型=$pgModel LoRA=$loraShow，进度见下方进度条")
    $wr = Wait-GatewayTaskWithProgress -TaskId $sub.TaskId -TimeoutSec $TimeoutSec -StepIndex 5
    if (-not $wr.Ok -or -not $wr.Raw -or -not $wr.Raw.paths) {
        Write-OpStep 5 '出图' ("未成功（{0} {1}）→ 表单照常弹出，可在窗口里重出" -f $wr.Status, [string]$wr.Message) -State 'fail'
        $hint0 = Get-ErrorHint -Message ([string]$wr.Message)
        if ($hint0) { Write-Host ("  " + $hint0) -ForegroundColor DarkYellow }
        Stop-OpProgress
        return $null
    }
    Write-OpStep 5 '出图' ("完成（{0}）" -f [string]$wr.Status) -State 'ok'
    # 网关的 notes（含「LoRA 已加载 → xxx.safetensors」「LoRA 找不到已跳过」）—— 打出来，别让用户猜 LoRA 生效没有
    try {
        $nt = @($wr.Raw.result.notes)
        if ($nt.Count -gt 0) { foreach ($n0 in $nt) { Write-Host ("  [网关] " + $n0) -ForegroundColor Cyan } }
    } catch { }
    $src = [string]@($wr.Raw.paths)[0]
    if (-not (Test-Path -LiteralPath $src)) {
        Write-OpStep 6 '落盘' ("产物路径不存在：" + $src) -State 'fail'
        Stop-OpProgress
        return $null
    }

    # ---- [6/7] 落进指定路径（唯一名，绝不覆盖已有成品）----
    # 命名优先级：调用方显式给的 -Name（且不是默认 'inject'）> 提示词总结 > 兜底 $Name
    Write-OpStep 6 '落盘到指定路径' $OutDir
    $baseName = ''
    if ($Name -and $Name -ne 'inject') { $baseName = $Name }
    if (-not $baseName) { try { $baseName = Summarize-PromptName -Prompt $Prompt } catch { $baseName = '' } }
    if (-not $baseName) { $baseName = $Name }
    $dst = Get-UniqueOutPath -BaseName $baseName
    try {
        $null = New-Item -ItemType Directory -Path $OutDir -Force -ErrorAction SilentlyContinue
        Copy-Item -LiteralPath $src -Destination $dst -Force
    } catch {
        Write-OpStep 6 '落盘到指定路径' ("失败：" + $_.Exception.Message) -State 'fail'
        Stop-OpProgress
        return $null
    }
    Write-OpStep 6 '落盘到指定路径' (Split-Path $dst -Leaf) -State 'ok'
    Write-Host ("后台预生成完成: {0}" -f $dst) -ForegroundColor Green
    # ---- 加字（用户要求 2026-10-20）：「生图（有加字要求就加字）→ 打开成品 → 弹参数表」----
    #   预生成阶段就把字写上去，用户看到的（自动打开的）那张就是带字的成品；
    #   加字换**另一档模型**（Resolve-AddTextModel 保证 ≠ 生图档）。
    $textedPath = ''
    if ($AddText -and $AddText.Trim()) {
        Write-OpStep 6 '落盘到指定路径' '加字中（换另一档模型）'
        try {
            $textedPath = Invoke-AddTextStage -Path $dst -BaseName $baseName -Text $AddText.Trim() -Model $AddTextModel -GenModel $pgModel -OutDirPath $OutDir -Pos "$AddTextPos" -Size "$AddTextSize" -Style "$AddTextStyle"
        } catch {
            Write-Host ("  预生成加字异常（保留未加字成品）：" + $_.Exception.Message) -ForegroundColor Yellow
            $textedPath = ''
        }
    }
    if ($textedPath -and (Test-Path -LiteralPath $textedPath) -and ("$textedPath" -ne "$dst")) {
        Write-Host ("后台预生成（已加字）完成: {0}" -f $textedPath) -ForegroundColor Green
        return @{ Path = $textedPath; Source = $src; Original = $dst; Model = $pgModel; TaskId = $sub.TaskId; Seed = $(if ($wr.Raw.result) { $wr.Raw.result.seed } else { -1 }); Texted = $true }
    }
    return @{ Path = $dst; Source = $src; Model = $pgModel; TaskId = $sub.TaskId; Seed = $(if ($wr.Raw.result) { $wr.Raw.result.seed } else { -1 }); Texted = $false }
}

# ---- 清除旧进程/卡死任务（脚本执行最前面，用户要求）----
# 1) 清空 SD 队列里卡死的 job（上次面部修复卡 100% 的残留会阻塞后续出图）
try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$SdPort/sdapi/v1/interrupt" -Method Post -TimeoutSec 5
    Write-Host "已清空 SD 卡死任务（interrupt）" -ForegroundColor DarkGray
} catch { }
# 2) 残留迭代目录的清理挪到「迭代根确定之后」（见下方 坑34 段）——旧版固定扫系统 temp，
#    现在迭代根优先落在工作区，得先知道根在哪才能扫对地方。

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ===========================================================================
# 【环境自检 / 适配层】（2026-10-21 用户要求：对所有电脑、所有环境都能适配）
#   原则：探得到就用、探不到就降级兜底，**任何一项失败都不许中断流程**（全部 try/catch）。
#   探到的东西打进日志 —— 换台机器出问题时，一眼能看出「这台是什么环境」。
# ===========================================================================
$script:EnvInfo = [ordered]@{}
try { $script:EnvInfo['PowerShell'] = "$($PSVersionTable.PSVersion)" } catch { $script:EnvInfo['PowerShell'] = 'unknown' }
try { $script:EnvInfo['OS'] = "$([System.Environment]::OSVersion.VersionString)" } catch { $script:EnvInfo['OS'] = 'unknown' }
try { $script:EnvInfo['64bit'] = [System.Environment]::Is64BitOperatingSystem } catch { }
try { $script:EnvInfo['CPU核'] = [System.Environment]::ProcessorCount } catch { }
try { $script:EnvInfo['UserInteractive'] = [System.Environment]::UserInteractive } catch { }
try {
    $scr0 = [System.Windows.Forms.Screen]::PrimaryScreen
    $script:EnvInfo['Screen'] = "$($scr0.Bounds.Width)x$($scr0.Bounds.Height)"
    $script:EnvInfo['WorkArea'] = "$($scr0.WorkingArea.Width)x$($scr0.WorkingArea.Height)"
} catch { $script:EnvInfo['Screen'] = 'unknown' }

# DPI 感知（高 DPI 屏上界面不再被系统整体拉伸成糊的）：Win8.1+ 走 shcore，失败退 user32，再失败就算了。
$script:DpiAware = $false
try {
    Add-Type -Namespace SDInject -Name DpiShcore -MemberDefinition '[DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);' -ErrorAction Stop
    $null = [SDInject.DpiShcore]::SetProcessDpiAwareness(1)
    $script:DpiAware = $true
} catch { }
if (-not $script:DpiAware) {
    try {
        Add-Type -Namespace SDInject -Name DpiUser32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -ErrorAction Stop
        $script:DpiAware = [bool][SDInject.DpiUser32]::SetProcessDPIAware()
    } catch { }
}
Write-Host ("环境：PS {0} · OS {1} · 屏幕 {2}（工作区 {3}）· {4} 核 · DPI 感知={5}" -f $script:EnvInfo['PowerShell'], $script:EnvInfo['OS'], $script:EnvInfo['Screen'], $script:EnvInfo['WorkArea'], $script:EnvInfo['CPU核'], $script:DpiAware) -ForegroundColor DarkGray
if ($script:EnvInfo['UserInteractive'] -eq $false) {
    Write-Host "注意：当前会话不是交互桌面（无桌面/服务会话）——弹窗会自动跳过，出图照常。" -ForegroundColor Yellow
}

# 字体兜底（不同区域/精简版 Windows 上雅黑/宋体/楷体未必都装了）：
#   取第一个**真的装了**的族；一个都没有就用系统默认族 —— 界面照样有字，绝不因缺字体崩。
$script:FontNames = @()
function Get-InstalledFonts {
    if ($script:FontNames.Count -gt 0) { return $script:FontNames }
    $l = @()
    try { foreach ($f in [System.Drawing.FontFamily]::Families) { $l += $f.Name } } catch { }
    if ($l.Count -eq 0) { try { $l += [System.Drawing.FontFamily]::GenericSansSerif.Name } catch { $l += 'Arial' } }
    $script:FontNames = $l
    return $script:FontNames
}
function Get-UiFontFamily {
    $have = Get-InstalledFonts
    foreach ($w in @('Microsoft YaHei', '微软雅黑', 'SimHei', '黑体', 'Microsoft JhengHei', 'Microsoft Sans Serif', 'Segoe UI', 'Tahoma', 'Arial', 'MS Gothic')) {
        if ($have -contains $w) { return $w }
    }
    return $have[0]
}
function Resolve-FontFamily {
    # 指定族装了就用它，否则退到界面字体（楷体/宋体这类不是每台机器都有）
    param([string[]]$Prefer = @())
    $have = Get-InstalledFonts
    foreach ($p in $Prefer) { if ($have -contains $p) { return $p } }
    return (Get-UiFontFamily)
}
Write-Host ("界面字体：{0}（本机共 {1} 个字体族）" -f (Get-UiFontFamily), (Get-InstalledFonts).Count) -ForegroundColor DarkGray

# ===========================================================================
# 【第一步：先弹「是 / 否」】用户要求 2026-10-20
#   必须**最先**（Add-Type 之后立刻弹，实测 2-5 秒就在桌面上）——
#   以前是「先生成、后弹窗」，用户对着空白控制台干等 2-3 分钟，感受就是「脚本启动了什么都没有」。
#   定稿顺序：**弹「是/否」→ 生图（有加字要求就加字）→ 自动打开成品 → 弹出参数表**。
#     · 是 = 开启视觉审查 → 完整生图（素体自检迭代 + 脸/手质检迭代，慢一些但质量有保障）
#     · 否 = 关闭视觉审查 → 正常生图流程（出一轮就收，快）
#   两个选择后续步骤完全一致：都生图、都按 -AddText / 表单「加字」栏加字、都打开成品、都弹参数表。
#   -StartDialog yes|no 可跳过弹窗直接定档（自动化用；默认 ask = 弹窗）。
# ===========================================================================
function Show-StartDialog {
    # 返回 'yes' / 'no'。弹不出来（无桌面 / 自动化环境）时按 'yes'（完整生图）继续，绝不卡死。
    try {
        $f = New-Object System.Windows.Forms.Form
        $f.Text = 'sd-inject · 是否开启视觉审查'
        $f.ClientSize = New-Object System.Drawing.Size(600, 306)
        $f.FormBorderStyle = 'FixedDialog'
        $f.StartPosition = 'CenterScreen'
        $f.TopMost = $true
        $f.MinimizeBox = $false
        $f.MaximizeBox = $false
        $f.ShowInTaskbar = $true

        $lb = New-Object System.Windows.Forms.Label
        $lb.Text = (@(
            '脚本已启动。请选择本次的视觉审查：',
            '',
            '【是】开启视觉审查 = 跑完整生图',
            '      素体自检迭代 + 脸/手质检迭代（慢一些，质量有保障）',
            '',
            '【否】关闭视觉审查 = 按正常生图流程',
            '      出一轮就收，不跑质检迭代（快）',
            '',
            '两种选择都会：生图（有加字要求就加字）→ 自动打开成品 → 弹出参数表。'
        ) -join "`r`n")
        $lb.SetBounds(20, 16, 560, 210)
        $f.Controls.Add($lb)

        $btnYes = New-Object System.Windows.Forms.Button
        $btnYes.Text = '是（开启视觉审查 · 完整生图）'
        $btnYes.Name = 'btnStartYes'
        $btnYes.AccessibleName = 'btnStartYes'
        $btnYes.SetBounds(20, 240, 270, 44)
        $btnYes.Add_Click({ $script:StartDialogResult = 'yes'; $f.Close() })
        $f.Controls.Add($btnYes)

        $btnNo = New-Object System.Windows.Forms.Button
        $btnNo.Text = '否（关闭视觉审查 · 正常流程）'
        $btnNo.Name = 'btnStartNo'
        $btnNo.AccessibleName = 'btnStartNo'
        $btnNo.SetBounds(310, 240, 270, 44)
        $btnNo.Add_Click({ $script:StartDialogResult = 'no'; $f.Close() })
        $f.Controls.Add($btnNo)

        $f.AcceptButton = $btnYes     # 回车 = 是
        $f.CancelButton = $btnNo      # Esc  = 否
        $script:StartDialogResult = 'yes'
        $null = $f.ShowDialog()
        $f.Dispose()
        return "$($script:StartDialogResult)"
    } catch {
        Write-Host ("启动弹窗异常（按「是 · 完整生图」继续）：" + $_.Exception.Message) -ForegroundColor Yellow
        return 'yes'
    }
}

$script:StartChoice = 'yes'
if ($StartDialog -eq 'ask') {
    $script:StartChoice = Show-StartDialog
} else {
    $script:StartChoice = "$StartDialog"
}
if ($script:StartChoice -eq 'yes') {
    $VisualReview = 'auto'
    $NoVlmReview = $false
} else {
    $VisualReview = 'off'
    $NoVlmReview = $true
}
Write-Host ("启动选择：视觉审查 = " + $(if ($script:StartChoice -eq 'yes') { '开启（完整生图：素体迭代 + 脸/手质检）' } else { '关闭（正常生图流程：出一轮就收）' })) -ForegroundColor Cyan

# 可观测性初始化（坑51）：运行日志 + 心跳 status.txt
# 坑57（2026-10-18 实测）：PowerShell **不做函数前向引用**——原文件把这两个函数定义在 700 行之后，
# 而调用在 321 行，于是每次运行都会抛 CommandNotFoundException（被 ErrorActionPreference=Continue
# 吞掉，日志/心跳静默失效，排障时看不到 status.txt）。修法：定义搬到调用点之前。
function Set-ObservabilityStatus {
    param([string]$Status, [string]$Detail = '')
    $line = "$(Get-Date -Format 'HH:mm:ss') | $Status$(if($Detail){' | '+$Detail})"
    Write-Host $line -ForegroundColor DarkGray
    if ($script:StatusFilePath) {
        try {
            Add-Content -LiteralPath $script:StatusFilePath -Value $line -ErrorAction SilentlyContinue
        } catch { }
    }
}

function Init-Observability {
    # 在迭代根下建 logs 子目录，写运行日志和心跳。
    # 这个函数在脚本**很早期**就会调一次（那时 $OutDir / $script:IterDir 可能还没解析完），
    # 所以每个取值都必须容错：算不出来就落 $env:TEMP，绝不因为一个空目录名去抛错（坑57 连带坑）。
    $logsDir = $script:IterDir
    if (-not $logsDir -and $OutDir) {
        try { $logsDir = Join-Path (Split-Path -Parent $OutDir) '.sd-inject-iter' } catch { $logsDir = $null }
    }
    if (-not $logsDir -or -not (Test-Path -LiteralPath $logsDir)) {
        $logsDir = Join-Path $env:TEMP 'sd-inject-logs'
    }
    $null = New-Item -ItemType Directory -Path $logsDir -Force -ErrorAction SilentlyContinue
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $script:RunLogPath = Join-Path $logsDir "run-$ts.log"
    $script:StatusFilePath = Join-Path $logsDir "status.txt"
    try {
        Start-Transcript -Path $script:RunLogPath -Append -ErrorAction SilentlyContinue | Out-Null
    } catch { }
    Set-ObservabilityStatus -Status "INIT" -Detail "脚本启动，日志=$script:RunLogPath"
    Write-Host "本次日志: $script:RunLogPath" -ForegroundColor DarkGray
    Write-Host "心跳文件: $script:StatusFilePath" -ForegroundColor DarkGray
}

Init-Observability

# OutDir 默认 = 脚本所在目录下的 SD-Picture（与 sd-direct.ps1 / 工具落点保持一致，
# 不受用户运行时的当前目录影响）；用户显式传了 -OutDir 则照用。
if ($OutDir -eq "") { $OutDir = Join-Path $PSScriptRoot "SD-Picture" }
# 控制台按 UTF-8 输出：否则 PS5.1 老窗口里中文进度会变乱码（本脚本大量中文日志）
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if ($SdDirect -eq "") {
    $SdDirect = Join-Path $PSScriptRoot "sd-direct.ps1"
}
if (-not (Test-Path -LiteralPath $SdDirect)) {
    Write-Host "错误：找不到 sd-direct.ps1：$SdDirect" -ForegroundColor Red
    exit 1
}

# ---- 迭代临时目录：**必须落在可写的地方**（坑34，外部用户实测反馈）----
# 旧行为：固定用 [System.IO.Path]::GetTempPath()。但 DSH 的 workspace-write 沙箱 ACL 只放行
# 「会话工作区」，而插件是用 cmd start 拉起**独立窗口**跑的（不经过会被改写 TMP/TEMP 的受限子进程），
# 于是 GetTempPath() 指向不可写的用户 temp → sd-direct.ps1 落盘被拒 → 非 0 退出 →
# sd-inject 直接 exit 1 → 三处 Copy-Item 全在迭代**之后**、永远执行不到 → 工作区一张成品都没有
# （只有 SD 自己的 outputs 目录里看得见）。现在改为「工作区优先 + 逐级兜底 + 全不可写就明确报错」。
function Test-DirWritable {
    # 真写一个探针文件再删：只看 Test-Path 会把「存在但被 ACL 拒写」当成可用（这正是坑34 的误判来源）
    param([string]$Path)
    if (-not $Path) { return $false }
    try {
        if (-not (Test-Path -LiteralPath $Path)) { $null = New-Item -ItemType Directory -Path $Path -Force -ErrorAction Stop }
        $probe = Join-Path $Path (".write-probe-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        [System.IO.File]::WriteAllText($probe, 'ok')
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch { return $false }
}

function Resolve-IterRoot {
    # 按顺序挑第一个真的可写的候选目录；全不可写返回 ''（由调用方明确报错，不静默）
    param([string[]]$Candidates)
    foreach ($c in $Candidates) {
        if (-not $c) { continue }
        if (Test-DirWritable $c) { return $c }
        Write-Host "迭代目录不可写，跳过：$c" -ForegroundColor DarkYellow
    }
    return ''
}

# OutDir 先探一次：不可写的话最后那几下 Copy-Item 必然失败，与其让用户等十几分钟才看到
# 「工作区什么都没有」，不如现在就把原因说清楚。
if (-not (Test-DirWritable $OutDir)) {
    Write-Host "错误：输出目录不可写：$OutDir" -ForegroundColor Red
    Write-Host "      DSH 的 workspace-write 沙箱只允许写会话工作区，请把 -OutDir 指到工作区内（例如 <工作区>\SD-Picture）。" -ForegroundColor Yellow
    exit 1
}

# 迭代根候选：① -IterDir 显式指定 ② <OutDir 的父目录>\.sd-inject-iter（正常就是会话工作区）
#             ③ $PSScriptRoot\.sd-inject-iter ④ 系统 temp（旧行为，最后兜底）
# 加固：系统 temp 用 try/catch + 多来源兜底求值——[System.IO.Path]::GetTempPath() 在个别受限宿主/
#       沙箱下会返回空字符串，直接喂给 Join-Path 会在 $ErrorActionPreference='Stop'（启动器就是 Stop）
#       下抛「参数 Path 为空」的致命异常，把整条兜底链打断。
$sysTemp = ''
try { $sysTemp = [System.IO.Path]::GetTempPath() } catch { }
if (-not $sysTemp) { try { $sysTemp = "$env:TEMP" } catch { } }
if (-not $sysTemp) { try { $sysTemp = "$env:TMP" } catch { } }
if (-not $sysTemp) { try { $sysTemp = "$env:USERPROFILE\AppData\Local\Temp" } catch { } }

$iterCandidates = @()
if ($IterDir) { $iterCandidates += $IterDir }
if ($OutDir) { try { $iterCandidates += (Join-Path (Split-Path -Parent $OutDir) '.sd-inject-iter') } catch { } }
if ($PSScriptRoot) { try { $iterCandidates += (Join-Path $PSScriptRoot '.sd-inject-iter') } catch { } }
if ($sysTemp) { try { $iterCandidates += (Join-Path $sysTemp 'sd-inject-iter') } catch { } }
$iterCandidates = @($iterCandidates | Where-Object { $_ } | Select-Object -Unique)

$script:IterRoot = Resolve-IterRoot -Candidates $iterCandidates
if (-not $script:IterRoot) {
    Write-Host "错误：找不到可写的迭代目录，已尝试：" -ForegroundColor Red
    foreach ($c in $iterCandidates) { Write-Host "      $c" -ForegroundColor DarkGray }
    Write-Host "      请把 -OutDir 指到会话工作区内，或用 -IterDir 指定一个可写目录。" -ForegroundColor Yellow
    exit 1
}
Write-Host "迭代目录：$($script:IterRoot)" -ForegroundColor DarkGray

# 清理上次中断残留的迭代目录（新根 + 旧版 temp 根都扫一遍，避免留垃圾）
# 加固：候选目录可能压根不存在（例如 -IterDir 给了个不可写的 Z:\ 候选）——先 Test-Path 再扫，
# 整段再包 try/catch，免得在 $ErrorActionPreference='Stop'（启动器里就是 Stop）下把清理失败升级成流程中断。
# ⚠ 2026-10-21 修：这里原来写的是 `foreach ($root in $iterCandidates)` —— PowerShell 变量名**大小写不敏感**，
#   而顶层作用域的 `$root` 与第 107 行的 `$Root`（= `$script:Root`，脚本目录）**是同一个变量**，
#   循环跑完 `$script:Root` 就变成了「最后一个迭代候选目录」（常是系统 temp 那份）→
#   后面所有用 `$script:Root` 的地方（网关入口查找、加字合成脚本定位…）全都指错地方。
#   实测现场：加字合成脚本被找成 C:\Users\...\Temp\sd-inject-iter\sd-addtext-composite.py。
#   改法：循环变量换成不会撞名的 $iterRootScan。
foreach ($iterRootScan in $iterCandidates) {
    if (-not $iterRootScan) { continue }
    try { if (-not (Test-Path -LiteralPath $iterRootScan)) { continue } } catch { continue }
    foreach ($pat in @('iter-*', 'sd-inject-iter-*')) {
        try {
            Get-ChildItem -LiteralPath $iterRootScan -Directory -Filter $pat -ErrorAction SilentlyContinue | ForEach-Object {
                try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue } catch { }
            }
        } catch { }
    }
}

# 每次运行一个独立子目录（所有中间图都写这里，退出时整体删除；根目录留着复用）
$script:IterTempDir = Join-Path $script:IterRoot ("iter-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $script:IterTempDir -Force
# 清理兜底：正常退出、Ctrl+C、进程被杀（ finally 由 exit 触发）都尽量删掉本次临时目录
$script:IterTempCleaned = $false
function Remove-IterTempDir {
    if ($script:IterTempCleaned) { return }
    $script:IterTempCleaned = $true
    if ($script:IterTempDir -and (Test-Path -LiteralPath $script:IterTempDir)) {
        try { Remove-Item -LiteralPath $script:IterTempDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
    # 根目录空了就顺手收掉（工作区里不留空壳目录）
    if ($script:IterRoot -and (Test-Path -LiteralPath $script:IterRoot)) {
        try {
            if (@(Get-ChildItem -LiteralPath $script:IterRoot -Force -ErrorAction SilentlyContinue).Count -eq 0) {
                Remove-Item -LiteralPath $script:IterRoot -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
}

# 把表单「底图」栏的原始输入解析成真实图片路径：
#   空 → ''（交给上层决定用素体成品）；「最近/最新/上一张/last/latest」→ $OutDirPath 里最新的一张图；
#   其余当路径处理（相对路径先按当前目录、再按 $OutDirPath 解析）。
# 解析失败时把原因写进 $script:LastInitFail（调用方据此决定是「明确报错」还是「回落最近一张」），
# 并返回 ''。**不再默默换一张图**：调用方只要拿到显式底图（对话提交或表单填的），解析不了就必须报错
# ——「底图不生效还被换成别的图」就是 2026-10-15 那个故障的根因。
function Resolve-InitImagePath {
    param([string]$Raw, [string]$OutDirPath)
    $script:LastInitFail = ''
    $t = "$Raw"
    if (-not $t) { return '' }
    $t = $t.Trim().Trim('"', "'", '`')
    if (-not $t) { return '' }

    # ① 关键词：最近 / 最新 / 上一张 / latest …
    if ($t -match '^(最近|最新|上一张|前一张|上次|latest|last|recent|prev)$') {
        $hit = @(Get-ChildItem -LiteralPath $OutDirPath -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -match '^\.(png|jpg|jpeg|webp|bmp)$' } |
            Sort-Object LastWriteTime -Descending) | Select-Object -First 1
        if ($hit) {
            Write-Host "底图 = 输出目录里最新一张：$($hit.FullName)" -ForegroundColor DarkGray
            return $hit.FullName
        }
        $script:LastInitFail = "输出目录 $OutDirPath 里还没有可用图片"
        return ''
    }

    # ② 附件/哈希形态：对话可能把「图片 sha256:xxxx」「xxxx.png [8a34ca32]」这类引用直接传进来。
    #    先剥掉方括号/括号里的哈希装饰，再把裸哈希拿去已落盘的目录里找同名文件。
    $clean = $t
    $clean = $clean -replace '[\s\[\(（【]+(sha256:|sha1:)?[0-9a-fA-F]{8,64}[\s\]\)）】]*$', ''   # 尾巴上的哈希装饰
    $clean = $clean -replace '^(图片|图像|image|attachment|附件)\s*[:：]?\s*', ''                 # 前缀里的说明词
    $clean = $clean -replace '^(sha256|sha1)\s*[:：]\s*', ''
    $clean = $clean.Trim()
    $bareHash = ''
    if ($clean -match '^[0-9a-fA-F]{8,64}$') { $bareHash = $clean }
    elseif ($t -match '(sha256|sha1)\s*[:：]\s*([0-9a-fA-F]{8,64})') { $bareHash = $Matches[2] }

    if ($bareHash) {
        $roots = @()
        if ($OutDirPath) { $roots += $OutDirPath; $roots += (Join-Path (Split-Path -Parent $OutDirPath) 'ref') }
        try { $roots += (Join-Path $env:USERPROFILE '.dsh\attachments') } catch { }
        foreach ($r in $roots) {
            if (-not $r -or -not (Test-Path -LiteralPath $r)) { continue }
            $hit = @(Get-ChildItem -LiteralPath $r -Recurse -File -Depth 3 -ErrorAction SilentlyContinue |
                Where-Object { $_.Extension -match '^\.(png|jpg|jpeg|webp|bmp)$' -and $_.FullName -match [regex]::Escape($bareHash) } |
                Select-Object -First 1)
            if ($hit.Count -gt 0) {
                Write-Host "底图 = 按哈希 '$bareHash' 找到：$($hit[0].FullName)" -ForegroundColor DarkGray
                return $hit[0].FullName
            }
        }
        $script:LastInitFail = "「$t」是哈希/附件引用，不是文件路径；已在输出目录、ref、DSH 附件目录里找过，没有匹配的图片"
        return ''
    }

    # ③ 从字符串里抠出真正的路径（对话常把说明文字和路径混在一起）
    # 先抠「带图片后缀」的路径；再退一步抠任意 Windows 路径 token（DSH 附件是**无后缀**的图片文件，
    # 形如 ...\.dsh\attachments\v1\objects\bd\bd863a…，只认 .png/.jpg 会漏掉它）。
    $cand = $clean
    $m = [regex]::Match($clean, '[A-Za-z]:\\[^\r\n"''<>|]+?\.(png|jpg|jpeg|webp|bmp)', 'IgnoreCase')
    if (-not $m.Success) { $m = [regex]::Match($clean, '[A-Za-z]:\\[^\s\r\n"''<>|]+', 'IgnoreCase') }
    if (-not $m.Success) { $m = [regex]::Match($clean, '(\\\\|\.\.?/)[^\s\r\n"'']+', 'IgnoreCase') }
    if ($m.Success) { $cand = $m.Value.Trim() }

    # ④ 相对路径：先按当前目录、再按输出目录解析
    if (-not [System.IO.Path]::IsPathRooted($cand)) {
        foreach ($base in @((Get-Location).Path, $OutDirPath)) {
            $p2 = Join-Path $base $cand
            if (Test-Path -LiteralPath $p2) { $cand = $p2; break }
        }
    }
    if (Test-Path -LiteralPath $cand -PathType Leaf) {
        $resolved = ''
        try { $resolved = (Resolve-Path -LiteralPath $cand).Path } catch { $resolved = $cand }
        # ---- 底图专用目录（用户要求 2026-10-16，脚本侧实现）----
        # 历史故障：ref\ 是共用目录，堆了各轮实验留下的图（attach_latest.png 那张 10/10 的
        # 终端截图、form-shot 截图、mask_box 蒙版……）。命令里一旦出现相对路径 ref\xxx.png，
        # 按工作区根解析时可能命中**别的遗留文件**；而用户真正传的图被埋在一堆垃圾里，
        # 出问题极难排查（实测：用户以为传的是 shorekeeper1.jpg，脚本却拿到 attach_latest.png）。
        # 现在：每次解析成功都**清空**「输出目录\ref\current\」并把它写成固定名 base<ext>，
        # 返回这个绝对路径。于是「本轮底图」永远只有一张、绝对路径、不会被别的文件污染。
        # （插件侧 stageRefImage 是同一套设计；此处脚本侧兜底，保证即使用户手跑脚本也生效。）
        $currentDir = Join-Path (Split-Path -Parent $OutDirPath) 'ref\current'
        if (-not $currentDir) { $currentDir = Join-Path $OutDirPath 'ref\current' }
        # 坑42（用户实测 2026-10-17，自毁级）：源文件**本身已经在 current 目录里**时
        # （表单把上一轮的 base.jpg 回填进「底图」栏 → 本函数被第二次调用），
        # 上面「先清空目录」会把这个源文件删掉，随后的 Copy-Item 复制的就是**已经不存在的源**
        # → 目录被清空、底图凭空消失 → 后续报「参考图不存在」→ 自动抠图失败 → 退化成几何蒙版。
        # 修法：源已在 current 目录内 → 直接返回它（它本来就是本轮唯一那张），不清空、不复制。
        try {
            $curFull = [System.IO.Path]::GetFullPath($currentDir).TrimEnd('\')
            $resFull = [System.IO.Path]::GetFullPath($resolved)
            if ($resFull.StartsWith($curFull + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
                $resFull -eq $curFull) {
                return $resFull
            }
        } catch { }
        try {
            if (Test-Path -LiteralPath $currentDir) {
                Get-ChildItem -LiteralPath $currentDir -File -Recurse -ErrorAction SilentlyContinue |
                    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
            } else {
                $null = New-Item -ItemType Directory -Path $currentDir -Force -ErrorAction Continue
            }
            $ext = [System.IO.Path]::GetExtension($resolved); if (-not $ext) { $ext = '.png' }
            $staged = Join-Path $currentDir ("base$ext")
            Copy-Item -LiteralPath $resolved -Destination $staged -Force -ErrorAction Continue
            if (Test-Path -LiteralPath $staged) {
                Write-Host "底图已固化到专用目录：$staged（源：$resolved）" -ForegroundColor DarkGray
                return $staged
            }
        } catch { }
        return $resolved
    }
    $script:LastInitFail = "底图路径不存在：$cand"
    return ''
}

# 在工作区 $OutDir 里找一个「不覆盖已有文件」的落盘路径：按 <Name>_<序号:D3>.png 递增，
# 避免每次运行都从 inject_001 开始、用 -Force 覆盖上一次的成品（用户反馈：图片被覆盖）。
function Get-UniqueOutPath {
    param([string]$BaseName = "inject")
    if (-not (Test-Path -LiteralPath $OutDir)) { $null = New-Item -ItemType Directory -Path $OutDir -Force }
    $idx = 1
    do {
        $cand = Join-Path $OutDir ("{0}_{1:D3}.png" -f $BaseName, $idx)
        $idx++
    } while (Test-Path -LiteralPath $cand)
    return $cand
}

# 从正向提示词总结一个简短文件名（取前几个英文标签，转成文件名安全的词）
function Summarize-PromptName {
    param([string]$Prompt)
    if (-not $Prompt) { return "inject" }
    # 去掉 LoRA 片段 <lora:...>、权重括号、特殊字符，取前 3 个词
    $clean = $Prompt -replace '<lora:[^>]+>', ''
    $clean = $clean -replace '[()\[\]:]', ' '
    $words = @($clean -split '[,\s]+' | Where-Object { $_ -and $_ -match '^[a-zA-Z0-9_-]+$' })
    if ($words.Count -eq 0) { return "inject" }
    $summary = ($words | Select-Object -First 3) -join '_'
    if ($summary.Length -gt 40) { $summary = $summary.Substring(0, 40) }
    return $summary
}

# 坑24：PS5.1 / .NET Framework 在响应头没写 charset 时按 Latin-1(28591) 解码 UTF-8 正文，
# UTF-8 的中文会变成「å°å¥³」这种双重编码文本。检测到 Latin-1 扩展字符就按原字节还原一次；
# 纯 ASCII（正常情况下的英文标签）原样返回，不做任何改动。
#
# 坑24b（2026-10-22 真实故障 + 回归测试抓出）：**不能只看有没有 80-FF 字符就修**。
#   「釉彩·麻袋调色盘」里的 `·` 是 U+00B7，正落在 80-FF 区间，
#   旧实现会把它当乱码整串"还原"→ 真实中文反被破坏成一串问号。
#   正确做法：先判断是否**真的**是 UTF-8 被按 Latin-1 解码的结果 ——
#   把字符按 Latin-1 取回字节，再用**严格 UTF-8 解码**试一次：
#     · 解码成功且结果里有 CJK/中文 → 确实是乱码，采用还原结果
#     · 解码失败（出现非法序列）或结果没有中文 → 原样返回，绝不改
#   这样纯中文（含 ·、× 等符号）不会被误伤。
function Repair-Utf8Mojibake {
    param([string]$Text)
    if (-not $Text) { return $Text }
    # 没有任何非 ASCII 字符 → 英文/数字名，直接返回
    if ($Text -notmatch '[\u0080-\uFFFF]') { return $Text }
    # 已经是合法中文 → 不可能是"UTF-8 被当 Latin-1"的结果，直接返回（防误伤）
    if ($Text -match '[\u4e00-\u9fff]') { return $Text }
    if ($Text -notmatch '[\u0080-\u00FF]') { return $Text }
    try {
        $bytes = [System.Text.Encoding]::GetEncoding(28591).GetBytes($Text)
        # 严格 UTF-8 解码：非法字节序列会抛异常，正好用来判定"这不是乱码"
        $strict = New-Object System.Text.UTF8Encoding($false, $true)
        $fixed = $strict.GetString($bytes)
        # 还原结果里必须真的出现中文，否则说明原本就不是 UTF-8 乱码
        if ($fixed -match '[\u4e00-\u9fff]') { return $fixed }
        return $Text
    } catch {
        return $Text
    }
}

# SD API 是否就绪（能回 200 才算；弹表单前预热/拉列表都用它判）
function Test-SdApiReady {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$SdPort/sdapi/v1/options" -Method Get -TimeoutSec 5 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

# 从本机 SD API 拉取 LoRA 列表（SD 没开返回空数组，表单里显示「（无）」）
# 坑24：SD 的 API 响应头不带 charset，PS5.1 按 Latin-1 解码 → 中文 LoRA 名乱码，逐个修复
# ===========================================================================
# 模型/LoRA 列表的**多路来源**（2026-10-21 用户反馈：不管选哪档，LoRA 与模型下拉都是空的）
#   根因：以前只从 A1111 WebUI API（127.0.0.1:7860）拉 —— 而多数时候 WebUI 是 offline
#   （出图走的是网关 + ComfyUI），于是两个列表恒空。
#   现在：API 拿得到就用 API；拿不到就**直接扫本机目录**：
#     · A1111：models\Lora / models\Stable-diffusion
#     · ComfyUI：models\loras / models\checkpoints / models\unet
#   ComfyUI 根目录不是写死的 —— 从网关 /api/health 的引擎 cmdline 反推（D:\ComfyUI\venv\Scripts\python.exe main.py → 往上找带 models 的那层），
#   再兜底 $env:COMFY_DIR、D:\ComfyUI、$SdDir，所以换机器也能找到。
# ===========================================================================
function Get-ModelScanRoots {
    $roots = @()
    if ($SdDir) { $roots += $SdDir }
    try {
        $gp = Invoke-RestMethod -Uri "$(Get-GatewayBase)/api/health" -Method Get -TimeoutSec 3
        foreach ($e0 in @($gp.engine_manager.engines)) {
            $eng = "$($e0.engine)"
            $cl = "$($e0.cmdline)"
            if ($eng -eq 'comfy' -and $cl) {
                $exe = ($cl -replace '"', '') -split '\s+' | Select-Object -First 1
                $dir = Split-Path -Parent $exe
                $up = $dir
                for ($i = 0; $i -lt 4 -and $up; $i++) {
                    if (Test-Path -LiteralPath (Join-Path $up 'models')) { $roots += $up; break }
                    $up = Split-Path -Parent $up
                }
            }
        }
    } catch { }
    if ($env:COMFY_DIR) { $roots += $env:COMFY_DIR }
    $roots += 'D:\ComfyUI', 'D:\SD.4.8'
    return @($roots | Where-Object { $_ } | Select-Object -Unique)
}
function Get-LorasFromDisk {
    $out = @()
    foreach ($r in (Get-ModelScanRoots)) {
        foreach ($sub in @('models\Lora', 'models\loras', 'models\LoRA', 'models\lycoris')) {
            $d = Join-Path $r $sub
            if (-not (Test-Path -LiteralPath $d)) { continue }
            try {
                $out += @(Get-ChildItem -LiteralPath $d -Recurse -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.Extension -match '^(\.safetensors|\.pt|\.ckpt|\.bin)$' } |
                    ForEach-Object { Repair-Utf8Mojibake ([IO.Path]::GetFileNameWithoutExtension($_.Name)) })
            } catch { }
        }
    }
    return @($out | Where-Object { $_ } | Select-Object -Unique | Sort-Object)
}
function Get-CheckpointsFromDisk {
    $out = @()
    foreach ($r in (Get-ModelScanRoots)) {
        foreach ($sub in @('models\Stable-diffusion', 'models\checkpoints', 'models\unet', 'models\diffusion_models')) {
            $d = Join-Path $r $sub
            if (-not (Test-Path -LiteralPath $d)) { continue }
            try {
                $out += @(Get-ChildItem -LiteralPath $d -Recurse -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.Extension -match '^(\.safetensors|\.pt|\.ckpt|\.gguf|\.sft)$' } |
                    ForEach-Object { Repair-Utf8Mojibake ([IO.Path]::GetFileNameWithoutExtension($_.Name)) })
            } catch { }
        }
    }
    return @($out | Where-Object { $_ } | Select-Object -Unique | Sort-Object)
}

function Get-SdLoras {
    $loras = @()
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$SdPort/sdapi/v1/loras" -Method Get -TimeoutSec 5
        if ($r) { $loras = @($r | ForEach-Object { Repair-Utf8Mojibake ([string]$_.name) }) }
    } catch { }
    if (@($loras).Count -eq 0) {
        # A1111 没跑（现在出图多数走网关 + ComfyUI）→ 扫目录，别让下拉恒空
        $loras = @(Get-LorasFromDisk)
        if (@($loras).Count -gt 0) { Write-Host ("LoRA 列表：A1111 未运行 → 改为扫本机目录，共 {0} 个（源：{1}）" -f @($loras).Count, ((Get-ModelScanRoots) -join ' / ')) -ForegroundColor DarkGray }
    } else {
        $extra = @(Get-LorasFromDisk | Where-Object { $loras -notcontains $_ })
        if ($extra.Count -gt 0) { $loras = @($loras + $extra); Write-Host ("LoRA 列表：API {0} 个 + 目录补充 {1} 个" -f (@($loras).Count - $extra.Count), $extra.Count) -ForegroundColor DarkGray }
    }
    return @($loras | Where-Object { $_ } | Select-Object -Unique)
}

# 从本机 SD API 拉取 checkpoint 列表（同样要修乱码）
function Get-SdCheckpoints {
    $cps = @()
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$SdPort/sdapi/v1/sd-models" -Method Get -TimeoutSec 5
        if ($r) { $cps = @($r | ForEach-Object { Repair-Utf8Mojibake ([string]$_.title) }) }
    } catch { }
    if (@($cps).Count -eq 0) {
        $cps = @(Get-CheckpointsFromDisk)
        if (@($cps).Count -gt 0) { Write-Host ("模型列表：A1111 未运行 → 改为扫本机目录，共 {0} 个" -f @($cps).Count) -ForegroundColor DarkGray }
    } else {
        $extra = @(Get-CheckpointsFromDisk | Where-Object { $cps -notcontains $_ })
        if ($extra.Count -gt 0) { $cps = @($cps + $extra) }
    }
    return @($cps | Where-Object { $_ } | Select-Object -Unique)
}

# 当前加载的 checkpoint 名。
# 关键（2026-10-15 修「二次元画风画不出来」）：画风自动切模型是**持久**的——切过一次写实底
# （写实 → majicMIX、彩色哥特 → SemiRealMix），SD 里就一直停在写实底；之后再选「二次元」若
# 不显式切回来，出的还是写实/半写实图。这个函数让表单与画风规则都能看到真实的当前底子。
function Get-SdCurrentModel {
    try {
        $o = Invoke-RestMethod -Uri "http://127.0.0.1:$SdPort/sdapi/v1/options" -Method Get -TimeoutSec 5
        return (Repair-Utf8Mojibake ([string]$o.sd_model_checkpoint))
    } catch { return '' }
}

# 动漫底 checkpoint 选择：优先 AWPainting（本机动漫默认），其次 anything / ReVAnimated / dark sushi / 二次元 / 动漫 / anime。
# 用途：二次元画风强制切回动漫底；写实二次元在「当前底是写实向」时也先切回来（再靠半写实 LoRA 上脸）。
function Get-AnimeCheckpoint {
    param([string[]]$Checkpoints)
    $cps = @($Checkpoints | Where-Object { $_ })
    $first = @($cps | Where-Object { $_ -match 'AWPainting|awpainting' } | Select-Object -First 1)
    if ($first.Count -gt 0) { return [string]$first[0] }
    $second = @($cps | Where-Object { $_ -match 'anything|ReVAnimated|revanimated|dark\s*sushi|二次元|动漫|anime|光辉|Illustrious|illustrious' } | Select-Object -First 1)
    if ($second.Count -gt 0) { return [string]$second[0] }
    return ''
}

# 写实向底子判定（写实 / 半写实 / 真人照片取向的 checkpoint）
function Test-RealisticCheckpoint {
    param([string]$Name)
    if (-not $Name) { return $false }
    return [bool]($Name -match 'majicMIX|majicmix|realistic|SemiReal|semireal|麦橘|写实|real')
}

# 画风词注入 / 剥离时的提示词净化（2026-10-15 修：反复切画风会把逗号越堆越多）。
# 现象：只做 Replace 的话，剥掉画风词会留下 ", " 尾巴，下一次注入再补一个 ", " → 实测连切三次
# 正向词就变成 "1girl, solo, silver hair,,, anime style, ..."（多余的 ",," 空标签）。
# 这两个函数把「连续逗号折叠成一个、开头逗号去掉、结尾不留空标签」集中处理。
function Add-StyleWords {
    param([string]$Text, [string]$Words)
    if (-not $Words) { return $Text }
    $t = "$Text"
    $t = ($t -replace '(\s*,\s*)+', ', ').Trim().TrimEnd(',')
    if (-not $t) { return $Words }
    return "$t, $Words"
}

function Remove-StyleWords {
    param([string]$Text, [string]$Words)
    $t = "$Text"
    if ($Words) { $t = $t.Replace($Words, '') }
    $t = $t -replace '(\s*,\s*)+', ', '   # 连续逗号折叠成一个
    $t = $t -replace '^\s*,\s*', ''       # 开头的逗号去掉
    return $t.Trim()
}

# 提示词框的后缀逗号（用户要求 2026-10-16）：两个框的内容**始终以逗号结尾**。
# 为什么要它：① 用户在框里接着追加时不会和上一个标签粘成一个词；② 整段复制出去拼接也省事；
# ③ 画风切换/模式切换会重写框内容（Add-StyleWords / Remove-StyleWords 都不带尾部逗号），
#    所以每次重写后都要补回来——这是之前"框里时有时无"的原因。
function Add-TrailingComma {
    param([string]$Text)
    $t = "$Text"
    if (-not $t.Trim()) { return $t }
    if ($t -match ',\s*$') { return $t }      # 已经有逗号（后面可有空格）→ 原样
    return ($t.TrimEnd() + ", ")
}

function Normalize-PromptText {
    # 坑46（用户实测 2026-10-17）：提示词里出现**连续逗号**（实测日志「beautiful eyes,, beautiful detailed eyes」）。
    # 成因：表单框的内容本来已带尾逗号，追加画风词/脸部词时又各自补一次逗号 → 叠成 ",,"。
    # 后果：SD 的 CLIP 分词遇到空标签会把相邻概念粘连/错位，实测同一 seed 下画面结构明显变差
    # （重绘产物出现整片黑块就是这一族的极端表现）。
    # 这里只做「格式归一化」：把 2 个以上连续逗号压成 1 个、去掉逗号前后的多余空格、去掉结尾逗号。
    # 纯格式化，不改任何词的内容与顺序。
    param([string]$Text)
    $s = "$Text"
    if (-not $s.Trim()) { return '' }
    $s = $s -replace '\s*,\s*(,\s*)+', ', '   # 连续逗号 → 单个逗号 + 空格
    $s = $s -replace '\s+', ' '                # 折叠空白
    $s = $s.Trim().TrimEnd(',')                # 去掉结尾逗号
    return $s.Trim()
}

# 坑51（用户实测 2026-10-17，P1 阻塞级）：**整体预算看门狗**。
# 自动抠图等阻塞步骤不允许无上限地跑，超过预算就降级继续，绝不让表单等着。
# 同时承担「超时后写 status.txt」的责任，避免「什么都没发生」。
function Invoke-WithBudget {
    param([scriptblock]$Script, [int]$MaxSeconds = 90, [string]$Stage = 'pre',
          [scriptblock]$OnTimeout = {})
    $job = Start-Job -ScriptBlock $Script
    $completed = Wait-Job $job -Timeout $MaxSeconds
    if ($completed) {
        $result = Receive-Job $job -ErrorAction SilentlyContinue
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        return $result
    }
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    Set-ObservabilityStatus -Status "TIMEOUT" -Detail "[$Stage] 超过 ${MaxSeconds}s 未完成，降级继续"
    Write-Host "  [$Stage] 超过 ${MaxSeconds}s 未完成 → 降级继续" -ForegroundColor Yellow
    try { & $OnTimeout } catch { }
    return $null
}

# 可观测性三件套：运行日志 + 心跳 status.txt + 抠图日志保留
# 坑49 的另一个教训：无日志 = 用户只能猜。这三件保证每一步都落盘可查。
$script:RunLogPath = ''
$script:StatusFilePath = ''

# 坑57：Init-Observability / Set-ObservabilityStatus 已上移到调用点之前（见文件开头 321 行附近）——
# 这里保留位置说明，避免以后有人再在原地重复定义。

# ---- 参考图解析（决策 C-1：文生图 / 图生图·一致 / 图生图·替换）----
# 一致从哪里来？优先级：
#   ① 参考图自带 A1111 元数据（我们自己出的图）→ 直接拿到它的模型 + 原提示词/负向词，一致性最强；
#   ② A1111 反推（deepdanbooru / clip）→ 拿到主体标签（用户给的是照片/网图时走这条）；
#   ③ 本地视觉模型判画风（Ollama 在跑时才有）→ 拿到「二次元/写实/厚涂…」这类画风档位。
# 三条都不通也不报错：只按用户自己写的提示词出图，并明确打印「一致：未取到」。

# 读 PNG 里的 A1111 元数据（tEXt 关键字 parameters）→ @{ Model; Positive; Negative; Seed; Size }；读不到返回 $null。
# 注意：PNG 的 chunk 长度是**大端**，用 BitConverter（小端）会读成垃圾长度——这是第一次尝试踩的坑。
function Get-PngGenParams {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
    $b = $null
    try { $b = [System.IO.File]::ReadAllBytes($Path) } catch { return $null }
    if ($b.Length -lt 32 -or $b[0] -ne 0x89 -or $b[1] -ne 0x50 -or $b[2] -ne 0x4E -or $b[3] -ne 0x47) { return $null }
    $pos = 8
    while ($pos + 8 -le $b.Length) {
        $len = ([int]$b[$pos] -shl 24) -bor ([int]$b[$pos + 1] -shl 16) -bor ([int]$b[$pos + 2] -shl 8) -bor ([int]$b[$pos + 3])
        if ($len -lt 0 -or ($pos + 12 + $len) -gt $b.Length) { break }
        $type = [System.Text.Encoding]::ASCII.GetString($b, $pos + 4, 4)
        if ($type -eq 'tEXt' -or $type -eq 'iTXt') {
            $data = [System.Text.Encoding]::UTF8.GetString($b, $pos + 8, $len)
            if ($data.StartsWith('parameters')) {
                $txt = $data.Substring(10).TrimStart([char]0, ' ')
                $res = @{ Model = ''; Positive = ''; Negative = ''; Seed = ''; Size = '' }
                $m = [regex]::Match($txt, 'Model:\s*([^,\r\n]+)')
                if ($m.Success) { $res.Model = $m.Groups[1].Value.Trim() }
                $m = [regex]::Match($txt, 'Seed:\s*(\d+)')
                if ($m.Success) { $res.Seed = $m.Groups[1].Value }
                $m = [regex]::Match($txt, 'Size:\s*(\d+x\d+)')
                if ($m.Success) { $res.Size = $m.Groups[1].Value }
                $negIdx = $txt.IndexOf('Negative prompt:')
                if ($negIdx -ge 0) {
                    $res.Positive = $txt.Substring(0, $negIdx).Trim()
                    $negRest = $txt.Substring($negIdx + 16)
                    $stepsIdx = $negRest.IndexOf("`nSteps:")
                    if ($stepsIdx -lt 0) { $stepsIdx = $negRest.IndexOf('Steps:') }
                    if ($stepsIdx -ge 0) { $negRest = $negRest.Substring(0, $stepsIdx) }
                    $res.Negative = $negRest.Trim()
                } else {
                    $stepsIdx = $txt.IndexOf("`nSteps:")
                    if ($stepsIdx -ge 0) { $res.Positive = $txt.Substring(0, $stepsIdx).Trim() } else { $res.Positive = $txt.Trim() }
                }
                return $res
            }
        }
        if ($type -eq 'IEND') { break }
        $pos += 12 + $len
    }
    return $null
}

# A1111 反推提示词标签（deepdanbooru 适合动漫图、clip 适合照片）。$PreferClip = 参考图没有 A1111 元数据时用 clip。
function Get-ImageTags {
    param([string]$Path, [bool]$PreferClip = $false)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return '' }
    $b64 = $null
    try { $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($Path)) } catch { return '' }
    $order = @('deepdanbooru', 'clip')
    if ($PreferClip) { $order = @('clip', 'deepdanbooru') }
    foreach ($model in $order) {
        try {
            $body = @{ image = $b64; model = $model } | ConvertTo-Json -Compress
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$SdPort/sdapi/v1/interrogate" -Method Post `
                -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 90
            $cap = Repair-Utf8Mojibake ([string]$resp.caption)
            if ($cap) {
                Write-Host "参考图反推（$model）：$($cap.Substring(0, [Math]::Min(110, $cap.Length)))…" -ForegroundColor DarkGray
                return $cap
            }
        } catch { }
    }
    return ''
}

# 本地视觉模型判画风（可选）：让 qwen3-vl 从我们的画风清单里挑一个；取不到返回 ''
function Get-ImageStyleByVlm {
    param([string]$Path)
    $styles = "保持画风/二次元/写实二次元/彩色哥特/国风/赛博朋克/写实/厚涂/水彩/像素风"
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    if (Test-VisualReviewOff) { return '' }   # 视觉审核整体关闭（插件设置 vlmReview=false）→ 连画风识别也不调模型
if (Test-VisualReviewOff) { return "" }   # 视觉审查关闭 → 连画风识别也不调模型
if (-not (Test-VlmApi)) { $null = Start-OllamaService -TimeoutSec $VlmStartTimeout }   # 冷启动：没起就替你拉起来
    $b64 = $null
    try { $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($Path)) } catch { return '' }
    $ask = "只判断画风（技术属性），不评价画面内容、不描述画面里有什么。这张图属于下面哪个画风？只能回答其中一个词，不要解释：$styles"
    try {
        $body = @{
            model = $VlmModel
            messages = @(@{ role = "user"; content = @(
                @{ type = "text"; text = $ask },
                @{ type = "image_url"; image_url = @{ url = "data:image/png;base64,$b64" } }
            ) })
            temperature = 0.1
            stream = $false
        }
        $resp = Invoke-RestMethod -Uri "$QwenBase/chat/completions" -Method Post `
            -Headers @{ "Content-Type" = "application/json; charset=utf-8"; "Authorization" = "Bearer $QwenApiKey" } `
            -Body ([System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 8))) -TimeoutSec 120
        $raw = Repair-Utf8Mojibake ([string]$resp.choices[0].message.content)
        foreach ($s in @('写实二次元', '彩色哥特', '赛博朋克', '二次元', '国风', '厚涂', '水彩', '像素风', '写实')) {
            if ($raw -like "*$s*") { return $s }
        }
    } catch { }
    return ''
}

# 图片像素尺寸（生成区域蒙版要按原图尺寸画）
function Get-ImageSizePx {
    param([string]$Path)
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
        $img = [System.Drawing.Image]::FromFile($Path)
        $r = @{ W = [int]$img.Width; H = [int]$img.Height }
        $img.Dispose()
        return $r
    } catch { return @{ W = 512; H = 768 } }
}

# 参考图原生尺寸 → 最终出图尺寸（8 的倍数、长边 ≤1536）。C-1a / C-1b **共用这一个尺寸**：
# 区域蒙版必须按它来画，否则 boxpx 会被当成「表单尺寸」的像素、区域名还要被最近邻再缩放一次
# （长宽比不一致时就把区域拉歪 —— 用户反馈的「蒙版位置有问题」）。
function Get-RefOutputSize {
    param([string]$Path)
    $rs = Get-ImageSizePx -Path $Path
    $w = [int]([Math]::Floor($rs.W / 8) * 8)
    $h = [int]([Math]::Floor($rs.H / 8) * 8)
    $mx = [Math]::Max($w, $h)
    if ($mx -gt 1536) {
        $k = 1536.0 / $mx
        $w = [int]([Math]::Floor(($rs.W * $k) / 8) * 8)
        $h = [int]([Math]::Floor(($rs.H * $k) / 8) * 8)
    }
    return @{ W = $w; H = $h; SrcW = $rs.W; SrcH = $rs.H }
}

# 区域蒙版生成（白 = 重绘区，黑 = 保留区）。Spec 认不出的形状返回 ''。
# 支持：上半（脸）/ 下半（衣服）/ 中间 / 四周（背景），后缀「反选」= 取补集。
function New-RegionMask {
    param([string]$Spec, [int]$W, [int]$H, [string]$OutPath)
    $s = "$Spec"
    if (-not $s) { return '' }
    # 必须先初始化成数组：`$rects += @{...}` 从 $null 起步会得到一个 Hashtable，
    # 再加第二块时 PowerShell 会抛「Item has already been added. Key in dictionary: 'Y'」
    # → 环形（四周/背景）与它的反选整条路径直接死掉（单块形状只是碰巧能用）。
    $rects = @()
    $shape = ''
    $invert = $false
    if ($s -match '反选|invert') { $invert = $true; $s = ($s -replace '反选', '') -replace 'invert', '' }
    # 精确坐标框（对话可以据此提交任意区域）：box:x,y,w,h（0-1 归一化）或 boxpx:x,y,w,h（像素）
    $mBox = [regex]::Match($s, 'box(px)?\s*[:：]\s*([0-9]*\.?[0-9]+)\s*[,，]\s*([0-9]*\.?[0-9]+)\s*[,，]\s*([0-9]*\.?[0-9]+)\s*[,，]\s*([0-9]*\.?[0-9]+)')
    if ($mBox.Success) {
        $isPx = ($mBox.Groups[1].Value -eq 'px')
        $v1 = [double]$mBox.Groups[2].Value; $v2 = [double]$mBox.Groups[3].Value
        $v3 = [double]$mBox.Groups[4].Value; $v4 = [double]$mBox.Groups[5].Value
        if ($isPx) { $rx = [int]$v1; $ry = [int]$v2; $rw = [int]$v3; $rh = [int]$v4 }
        else { $rx = [int]($W * $v1); $ry = [int]($H * $v2); $rw = [int]($W * $v3); $rh = [int]($H * $v4) }
        # 夹到图像范围内（越界框会让 A1111 把蒙版贴到奇怪的位置）
        if ($rx -lt 0) { $rx = 0 }; if ($ry -lt 0) { $ry = 0 }
        if ($rx -ge $W) { $rx = $W - 8 }; if ($ry -ge $H) { $ry = $H - 8 }
        if ($rw -lt 8) { $rw = 8 }; if ($rh -lt 8) { $rh = 8 }
        if (($rx + $rw) -gt $W) { $rw = $W - $rx }
        if (($ry + $rh) -gt $H) { $rh = $H - $ry }
        $rects += @{ X = $rx; Y = $ry; Wd = $rw; Ht = $rh }
        $shape = 'box'
    }
    if (-not $shape -and ($s -match '上半|脸|face|head')) { $shape = 'upper' }
    elseif (-not $shape -and ($s -match '下半|衣服|服装|clothes|outfit|body')) { $shape = 'lower' }
    elseif (-not $shape -and ($s -match '中间|主体|center|centre')) { $shape = 'center' }
    elseif (-not $shape -and ($s -match '四周|背景|background|bg|边缘')) { $shape = 'ring' }
    if (-not $shape) { return '' }

    Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
    $bmp = New-Object System.Drawing.Bitmap($W, $H)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $black = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.Clear([System.Drawing.Color]::Black)
    if ($shape -eq 'box') { }   # box 分支已经在上面算好矩形了（$rects 已是数组）
    switch ($shape) {
        # 区域框刻意收窄：铺满整幅会把背景/头发一起重画（实测那样出来的是糊块）
        'upper'  { $rects += @{ X = [int]($W * 0.25); Y = [int]($H * 0.04); Wd = [int]($W * 0.5); Ht = [int]($H * 0.32) } }
        'lower'  { $rects += @{ X = [int]($W * 0.2); Y = [int]($H * 0.45); Wd = [int]($W * 0.6); Ht = [int]($H * 0.5) } }
        'center' { $rects += @{ X = [int]($W * 0.22); Y = [int]($H * 0.18); Wd = [int]($W * 0.56); Ht = [int]($H * 0.66) } }
        'box'    { }
        'ring'   {
            $band = [int]($W * 0.18)
            $rects += @{ X = 0; Y = 0; Wd = $W; Ht = $band }
            $rects += @{ X = 0; Y = ($H - $band); Wd = $W; Ht = $band }
            $rects += @{ X = 0; Y = 0; Wd = $band; Ht = $H }
            $rects += @{ X = ($W - $band); Y = 0; Wd = $band; Ht = $H }
        }
    }
    if ($invert) {
        # 取补集：整张涂白，再把上面的形状画黑（比逐像素取反省事且边缘干净）
        $g.Clear([System.Drawing.Color]::White)
        foreach ($r in $rects) { $g.FillRectangle($black, $r.X, $r.Y, $r.Wd, $r.Ht) }
    } else {
        foreach ($r in $rects) { $g.FillRectangle($white, $r.X, $r.Y, $r.Wd, $r.Ht) }
    }
    $g.Dispose(); $black.Dispose(); $white.Dispose()
    try {
        $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        return $OutPath
    } catch { $bmp.Dispose(); return '' }
}

# ---- 手绘蒙版编辑器（用户要求 2026-10-16）：弹出参考图，鼠标涂抹要重绘的区域 ----
# 交互：左键涂抹（白=重绘区）、右键擦除、滚轮调笔刷大小、C 清空、Enter/S 确定、Esc 取消。
# 返回：保存好的蒙版 PNG 路径（白=重绘区）；用户取消或没有参考图时返回 ''。
function Show-MaskPainter {
    param([string]$ImagePath, [string]$OutPath)
    if (-not $ImagePath -or -not (Test-Path -LiteralPath $ImagePath)) { return '' }
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms
    try {
        $src = [System.Drawing.Image]::FromFile($ImagePath)
    } catch { return '' }

    # 画布按参考图等比缩到最长边 900，避免大图卡顿（蒙版后续会被 SD 缩放到目标尺寸）
    $maxSide = 900.0
    $k = 1.0
    if ($src.Width -gt $maxSide -or $src.Height -gt $maxSide) {
        $k = [Math]::Min($maxSide / $src.Width, $maxSide / $src.Height)
    }

    # ---------------------------------------------------------------------------
    # 坑35（2026-10-16 实测）：PowerShell 的 WinForms 事件处理器**不继承函数局部作用域**——
    # 处理器里的 $maskG / $canvas / $baseBmp 全是 $null，FillEllipse 立刻抛错 →
    # 表现就是「看不到笔刷痕迹、也没有实际效果」（用户实测反馈）。
    # 修法：所有跨处理器共享的对象一律放 **$script: 作用域**（mp_ 前缀防撞）。
    #
    # 坑36（同日实测）：显示层最初用 ColorMatrix 把「黑底白笔迹」映射成半透明红——
    # 矩阵行列语义在 PowerShell 里既不好写也不好验（属性名 MatrixRC 与索引器行为不一致），
    # 实测画布直接糊成一片白色（底图被整层盖掉）。
    # 改用**独立红色叠加层**：另开一张透明 ARGB 位图，涂抹时同时往「蒙版层」写黑白、
    # 往「红色层」写半透明红；显示 = 底图 + 红色层。零矩阵、零魔法，所见即所得。
    # ---------------------------------------------------------------------------
    $script:mp_cw = [int][Math]::Max(64, [Math]::Round($src.Width * $k))
    $script:mp_ch = [int][Math]::Max(64, [Math]::Round($src.Height * $k))
    $cw = $script:mp_cw
    $ch = $script:mp_ch

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "手绘蒙版 — 左键涂抹要重绘的区域 / 右键擦除 / 滚轮调笔刷 / C 清空 / Enter 确定 / Esc 取消"
    $form.ClientSize = New-Object System.Drawing.Size($cw, ($ch + 34))
    $form.FormBorderStyle = 'FixedDialog'
    $form.StartPosition = 'CenterScreen'
    $form.MaximizeBox = $false
    $form.TopMost = $true

    $script:mp_canvas = New-Object System.Windows.Forms.PictureBox
    $script:mp_canvas.SetBounds(0, 0, $cw, $ch)
    $script:mp_canvas.SizeMode = 'Normal'
    $script:mp_canvas.BackColor = [System.Drawing.Color]::Black
    # 给画布一个**可识别身份**（用户实测 2026-10-17）：以前 PictureBox 是匿名的，UI 自动化
    # （UIAutomation）在窗口里按名称/类型都找不到它 → 自动化测试脚本报「找不到画布」，
    # 只能靠猜窗口坐标去点。补 Name + AccessibleName 后，任何自动化工具都能精确定位到涂抹区。
    $script:mp_canvas.Name = 'maskCanvas'
    $script:mp_canvas.AccessibleName = 'maskCanvas'
    $script:mp_canvas.AccessibleDescription = '手绘蒙版画布：左键涂抹要重绘的区域，右键擦除'
    $form.Controls.Add($script:mp_canvas)

    # 底图（缩放后，只画一次，之后每帧复用）
    $script:mp_baseBmp = New-Object System.Drawing.Bitmap($cw, $ch)
    $baseG = [System.Drawing.Graphics]::FromImage($script:mp_baseBmp)
    $baseG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $baseG.DrawImage($src, 0, 0, $cw, $ch)
    $baseG.Dispose()

    # 蒙版层（黑底 + 白笔迹；纯黑白两色，SD 只认这个，保存时按原图尺寸导出）
    $script:mp_maskBmp = New-Object System.Drawing.Bitmap($cw, $ch)
    $script:mp_maskG = [System.Drawing.Graphics]::FromImage($script:mp_maskBmp)
    $script:mp_maskG.Clear([System.Drawing.Color]::Black)
    $script:mp_maskG.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    # 红色叠加层（透明底 + 半透明红笔迹；纯显示用，不参与出图）
    $script:mp_redBmp = New-Object System.Drawing.Bitmap($cw, $ch)
    $script:mp_redG = [System.Drawing.Graphics]::FromImage($script:mp_redBmp)
    $script:mp_redG.Clear([System.Drawing.Color]::Transparent)
    $script:mp_redG.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    # 刷子（复用：涂抹用半透明红，擦除用 SourceCopy + 透明）
    $script:mp_redBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(150, 255, 56, 56))
    $script:mp_whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $script:mp_blackBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
    $script:mp_clearBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Transparent)

    # 显示层（底图 + 红色层 + 笔刷圈）
    $script:mp_dispBmp = New-Object System.Drawing.Bitmap($cw, $ch)

    $script:mp_brushSize = 30
    $script:mp_painting = $false
    $script:mp_erasing = $false
    $script:mp_lastPt = $null
    $script:mp_cursor = $null
    $script:mp_painted = $false

    # 重绘显示层：底图 → 红色层 → 笔刷光标圈。
    # 用 $script:mp_recompose 存放，事件处理器可经它直接调到。
    $script:mp_recompose = {
        $g = [System.Drawing.Graphics]::FromImage($script:mp_dispBmp)
        $g.Clear([System.Drawing.Color]::Black)
        $g.DrawImage($script:mp_baseBmp, 0, 0, $script:mp_cw, $script:mp_ch)
        $g.DrawImage($script:mp_redBmp, 0, 0, $script:mp_cw, $script:mp_ch)
        # 笔刷光标圈：让用户看到笔刷多大、涂在哪
        if ($script:mp_cursor) {
            $half = [int]($script:mp_brushSize / 2)
            $cx = [int]$script:mp_cursor.X
            $cy = [int]$script:mp_cursor.Y
            $penB = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 0, 0, 0), 3.0)
            $penW = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 255, 255, 255), 1.5)
            $g.DrawEllipse($penB, ($cx - $half), ($cy - $half), $script:mp_brushSize, $script:mp_brushSize)
            $g.DrawEllipse($penW, ($cx - $half), ($cy - $half), $script:mp_brushSize, $script:mp_brushSize)
            $g.DrawLine($penB, $cx, ($cy - 8), $cx, ($cy + 8))
            $g.DrawLine($penB, ($cx - 8), $cy, ($cx + 8), $cy)
            $g.DrawLine($penW, $cx, ($cy - 8), $cx, ($cy + 8))
            $g.DrawLine($penW, ($cx - 8), $cy, ($cx + 8), $cy)
            $penB.Dispose(); $penW.Dispose()
        }
        $g.Dispose()
        $script:mp_canvas.Image = $script:mp_dispBmp
        $script:mp_canvas.Invalidate()
    }

    # 在 (x,y) 落一个笔刷点：写蒙版层（白/黑）+ 写红色层（红/透明）
    $script:mp_dot = {
        param($x, $y, [bool]$erase)
        $half = [int]($script:mp_brushSize / 2)
        $mBrush = if ($erase) { $script:mp_blackBrush } else { $script:mp_whiteBrush }
        $script:mp_maskG.FillEllipse($mBrush, ($x - $half), ($y - $half), $script:mp_brushSize, $script:mp_brushSize)
        if ($erase) {
            # 擦除：SourceCopy 把该区域的 alpha 直接置 0（普通叠加模式下透明画不出「擦掉」）
            $script:mp_redG.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $script:mp_redG.FillEllipse($script:mp_clearBrush, ($x - $half), ($y - $half), $script:mp_brushSize, $script:mp_brushSize)
            $script:mp_redG.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
        } else {
            $script:mp_redG.FillEllipse($script:mp_redBrush, ($x - $half), ($y - $half), $script:mp_brushSize, $script:mp_brushSize)
            $script:mp_painted = $true
        }
    }

    # 从上次点到本次点之间补一圈插值点（快速拖动不断线）
    $script:mp_paint = {
        param($x, $y, [bool]$erase)
        & $script:mp_dot $x $y $erase
        if ($script:mp_lastPt) {
            $dx = $x - $script:mp_lastPt.X; $dy = $y - $script:mp_lastPt.Y
            $dist = [Math]::Sqrt($dx * $dx + $dy * $dy)
            $steps = [int]($dist / [Math]::Max(1, ($script:mp_brushSize / 4)))
            if ($steps -gt 1) {
                for ($i = 1; $i -lt $steps; $i++) {
                    $ix = [int]($script:mp_lastPt.X + $dx * $i / $steps)
                    $iy = [int]($script:mp_lastPt.Y + $dy * $i / $steps)
                    & $script:mp_dot $ix $iy $erase
                }
            }
        }
        $script:mp_lastPt = New-Object System.Drawing.Point($x, $y)
        $script:mp_cursor = New-Object System.Drawing.Point($x, $y)
        & $script:mp_recompose
    }

    $script:mp_canvas.Add_MouseDown({
        param($s, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            $script:mp_painting = $true; $script:mp_erasing = $false; $script:mp_lastPt = $null
            & $script:mp_paint $e.X $e.Y $false
        } elseif ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
            $script:mp_painting = $true; $script:mp_erasing = $true; $script:mp_lastPt = $null
            & $script:mp_paint $e.X $e.Y $true
        }
    })
    $script:mp_canvas.Add_MouseMove({
        param($s, $e)
        if ($script:mp_painting) {
            & $script:mp_paint $e.X $e.Y $script:mp_erasing
        } else {
            # 没在涂也要跟手更新笔刷圈
            $script:mp_cursor = New-Object System.Drawing.Point($e.X, $e.Y)
            & $script:mp_recompose
        }
    })
    $script:mp_canvas.Add_MouseUp({
        param($s, $e)
        $script:mp_painting = $false; $script:mp_lastPt = $null
    })
    $script:mp_canvas.Add_MouseLeave({
        param($s, $e)
        $script:mp_cursor = $null
        & $script:mp_recompose
    })
    $script:mp_canvas.Add_MouseWheel({
        param($s, $e)
        $delta = if ($e.Delta -gt 0) { 6 } else { -6 }
        $script:mp_brushSize = [Math]::Max(6, [Math]::Min(300, $script:mp_brushSize + $delta))
        $form.Text = "手绘蒙版 — 笔刷 $($script:mp_brushSize)px / 左键涂抹 / 右键擦除 / 滚轮调笔刷 / C 清空 / Enter 确定 / Esc 取消"
        & $script:mp_recompose
    })

    $form.KeyPreview = $true
    $form.Add_KeyDown({
        param($s, $e)
        if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
            $form.DialogResult = 'Cancel'; $form.Close()
        } elseif ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
            $form.DialogResult = 'OK'; $form.Close()
        } elseif ($e.KeyCode -eq [System.Windows.Forms.Keys]::C) {
            $script:mp_maskG.Clear([System.Drawing.Color]::Black)
            $script:mp_redG.Clear([System.Drawing.Color]::Transparent)
            $script:mp_painted = $false
            & $script:mp_recompose
        } elseif ($e.KeyCode -eq [System.Windows.Forms.Keys]::OemOpenBrackets) {
            $script:mp_brushSize = [Math]::Max(6, $script:mp_brushSize - 6)
            & $script:mp_recompose
        } elseif ($e.KeyCode -eq [System.Windows.Forms.Keys]::OemCloseBrackets) {
            $script:mp_brushSize = [Math]::Min(300, $script:mp_brushSize + 6)
            & $script:mp_recompose
        }
    })

    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = '确定（用这块蒙版出图）'
    $btnOk.SetBounds(0, ($ch + 4), 240, 28)
    $btnOk.Add_Click({ $form.DialogResult = 'OK'; $form.Close() })
    $form.Controls.Add($btnOk)
    $btnClear = New-Object System.Windows.Forms.Button
    $btnClear.Text = '清空'
    $btnClear.SetBounds(246, ($ch + 4), 60, 28)
    $btnClear.Add_Click({
        $script:mp_maskG.Clear([System.Drawing.Color]::Black)
        $script:mp_redG.Clear([System.Drawing.Color]::Transparent)
        $script:mp_painted = $false
        & $script:mp_recompose
    })
    $form.Controls.Add($btnClear)
    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = '取消'
    $btnCancel.SetBounds(312, ($ch + 4), 60, 28)
    $btnCancel.Add_Click({ $form.DialogResult = 'Cancel'; $form.Close() })
    $form.Controls.Add($btnCancel)

    & $script:mp_recompose
    $script:mp_cursor = $null
    $dlg = $form.ShowDialog()

    $paintedFlag = $script:mp_painted
    $ok = ''
    if ($dlg -eq [System.Windows.Forms.DialogResult]::OK -and $paintedFlag) {
        # 存盘：按**参考图原始尺寸**输出纯黑白蒙版（SD 需要白=重绘区）
        # 坑44（用户实测 2026-10-17，出图整片黑）：蒙版**必须存成 8 位灰度、且不能带 alpha 通道**。
        # 现场：以前存的是 RGBA PNG（alpha 全不透明 255、黑白像素在 RGB 里）。A1111 处理 inpaint
        # 蒙版时会同时看 RGB 亮度**和 alpha**：alpha 存在且不透明时，它把 alpha 当成「该像素有效」
        # → 相当于整张图都落在蒙版里 → 全图重绘 → 未蒙版区被洗成黑块（实测产物全黑、质检 0/100）。
        # 坑44（用户实测 2026-10-17，出图整片黑）：蒙版**必须是 8 位灰度、绝不能带 alpha**。
        # 现场：以前存出来是 Format32bppArgb（alpha 全 255、黑白在 RGB 里），A1111 处理 inpaint
        # 蒙版时会同时看 RGB 亮度**和 alpha**：alpha 不透明 → 整张图都被当成有效重绘区 →
        # 全图重绘 → 未蒙版区被洗成黑块（实测产物 lum_mean 26、51.85% 像素近黑、质检 0/100）。
        # 实现要点：**不能只靠 DrawImage 画进 8bpp 位图** —— .NET 会把目标悄悄升成 32bpp
        # （实测落盘仍是 Format32bppArgb，改了等于没改）。必须逐像素读亮度、写 8bpp 索引，
        # 并显式设 256 级灰阶调色板。
        $mw = $src.Width; $mh = $src.Height
        $outBmp = New-Object System.Drawing.Bitmap($mw, $mh, [System.Drawing.Imaging.PixelFormat]::Format8bppIndexed)
        try {
            $pal = $outBmp.Palette
            $pEntries = $pal.Entries
            for ($pi = 0; $pi -lt 256; $pi++) { $pEntries[$pi] = [System.Drawing.Color]::FromArgb(255, $pi, $pi, $pi) }
            $pal.Entries = $pEntries
            $outBmp.Palette = $pal
        } catch { }
        # 先把画布蒙版层缩到原图尺寸（24bpp 中间位图，黑底 + 白笔迹，不带 alpha）
        $midBmp = New-Object System.Drawing.Bitmap($mw, $mh, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $mg2 = [System.Drawing.Graphics]::FromImage($midBmp)
        $mg2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $mg2.Clear([System.Drawing.Color]::Black)
        $mg2.DrawImage($script:mp_maskBmp, 0, 0, $mw, $mh)
        $mg2.Dispose()
        # 逐像素：读 24bpp 亮度 → 写 8bpp 索引（>127 记 255，否则 0；纯黑白，SD 判定最稳）
        $rect2 = New-Object System.Drawing.Rectangle(0, 0, $mw, $mh)
        $md = $midBmp.LockBits($rect2, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $od = $outBmp.LockBits($rect2, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format8bppIndexed)
        try {
            $stride = $md.Stride
            $buf = New-Object byte[] ($stride * $mh)
            [System.Runtime.InteropServices.Marshal]::Copy($md.Scan0, $buf, 0, $buf.Length)
            $ostride = $od.Stride
            $obuf = New-Object byte[] ($ostride * $mh)
            for ($y = 0; $y -lt $mh; $y++) {
                $srow = $y * $stride
                $orow = $y * $ostride
                for ($x = 0; $x -lt $mw; $x++) {
                    $si = $srow + $x * 3
                    $lum = [int](($buf[$si] + $buf[$si + 1] + $buf[$si + 2]) / 3)
                    $obuf[$orow + $x] = if ($lum -gt 127) { [byte]255 } else { [byte]0 }
                }
            }
            [System.Runtime.InteropServices.Marshal]::Copy($obuf, 0, $od.Scan0, $obuf.Length)
        } finally {
            $midBmp.UnlockBits($md)
            $outBmp.UnlockBits($od)
        }
        $midBmp.Dispose()
        try {
            $outBmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
            $ok = $OutPath
        } catch { $ok = '' }
        $outBmp.Dispose()
        if ($ok) {
            # 自检：确认落盘的是「无 alpha 的灰度」，亮度分布与涂抹量一致（防止再次整图重绘）
            try {
                $chk = [System.Drawing.Bitmap]::FromFile($ok)
                $fmt = $chk.PixelFormat
                $chk.Dispose()
                Write-Host "手绘蒙版已保存（格式 $fmt，白=重绘区）→ $ok" -ForegroundColor DarkGray
            } catch { }
        }
    } elseif ($dlg -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Host "手绘蒙版：没有涂抹任何区域 → 视为取消本次手绘。" -ForegroundColor Yellow
    }

    # 清理（PictureBox 还挂着 Image，先解绑再 Dispose）
    try { $script:mp_canvas.Image = $null } catch { }
    foreach ($o in @($script:mp_maskG, $script:mp_redG, $script:mp_maskBmp, $script:mp_redBmp,
                     $script:mp_dispBmp, $script:mp_baseBmp, $script:mp_redBrush, $script:mp_whiteBrush,
                     $script:mp_blackBrush, $script:mp_clearBrush, $form)) {
        try { if ($o) { $o.Dispose() } } catch { }
    }
    try { $src.Dispose() } catch { }
    $script:mp_maskG = $null; $script:mp_redG = $null; $script:mp_maskBmp = $null; $script:mp_redBmp = $null
    $script:mp_dispBmp = $null; $script:mp_baseBmp = $null; $script:mp_canvas = $null
    $script:mp_redBrush = $null; $script:mp_whiteBrush = $null; $script:mp_blackBrush = $null; $script:mp_clearBrush = $null
    $script:mp_cursor = $null; $script:mp_lastPt = $null
    return $ok
}

function Invoke-MaskQaReport {
    param([string]$RefPath, [string]$MaskPath, [string]$OutPath, [string]$QaDir = "")
    if (-not $RefPath -or -not $MaskPath -or -not $OutPath) { return }
    foreach ($p in @($RefPath, $MaskPath, $OutPath)) { if (-not (Test-Path -LiteralPath $p)) { return } }
    $scriptDir = $PSScriptRoot
    if (-not $scriptDir) { try { $scriptDir = Split-Path -Parent $PSCommandPath } catch { } }
    $helper = Join-Path $scriptDir 'sd-mask-qa.py'
    if (-not (Test-Path -LiteralPath $helper)) { return }
    $py = Find-SdPython
    if (-not $py) { return }
    $qaArgs = @($helper, '--ref', $RefPath, '--mask', $MaskPath, '--out', $OutPath, '--json')
    if ($QaDir) { $qaArgs += @('--qa-dir', $QaDir) }
    try {
        $raw = & $py @qaArgs 2>$null
        $j = "$raw" | ConvertFrom-Json
        if ($j -and $j.ok) {
            $inMask = [Math]::Max(0.000001, [double]$j.mask)
            $outMask = [Math]::Max(0.000001, 1.0 - [double]$j.mask)
            Write-Host ("  蒙版覆盖 {0:N2}%｜命中 {1:N2}%（占蒙版 {2:N1}%）｜蒙版内未改 {3:N2}%（占蒙版 {4:N1}%）｜外溢 {5:N2}%｜蒙版外保留 {6:N2}%" -f `
                    (100 * [double]$j.mask), (100 * [double]$j.hit), (100 * [double]$j.hit / $inMask), `
                    (100 * [double]$j.ineffective), (100 * [double]$j.ineffective / $inMask), `
                    (100 * [double]$j.leak), (100 * [double]$j.kept)) -ForegroundColor DarkGray
            if ([double]$j.suspect -gt 0.005) {
                Write-Host ("  疑似漏掉的衣料：{0:N2}%（{1} 块 >0.3%）→ 复核总览图里的品红区" -f (100 * [double]$j.suspect), [int]$j.suspect_blobs) -ForegroundColor Yellow
            }
            if ($j.overlay -and (Test-Path -LiteralPath $j.overlay)) {
                # 总览图默认写在迭代临时目录里（随目录一起清掉 —— 产物目录只留成品）；
                # -KeepWorkFiles 时复制一份到产物目录，方便慢慢看。
                if ($KeepWorkFiles -and $OutDir) {
                    try {
                        $keepOv = Join-Path $OutDir (Split-Path $j.overlay -Leaf)
                        Copy-Item -LiteralPath $j.overlay -Destination $keepOv -Force
                        $null = Add-RunWorkFile $keepOv
                        Write-Host "  命中率总览图：$keepOv（绿=蒙版内已改 / 黄=蒙版内未改 / 红=外溢 / 品红=疑似漏掉衣料）" -ForegroundColor DarkGray
                    } catch { }
                } else {
                    Write-Host "  （命中率总览图写在迭代临时目录里，跑完随目录一起清掉；要留图请加 -KeepWorkFiles）" -ForegroundColor DarkGray
                }
            }
        }
    } catch { }
}

# 从用户写的指令里判断「是不是替换动作」以及「替换的是哪一块」（决定默认蒙版区域）。
function Get-ReplaceTarget {
    param([string]$Text)
    $t = "$Text"
    if (-not $t) { return '' }
    $isReplace = ($t -match '换|替换|改成|改为|变成|变为|穿上|脱掉|replace|change|swap|put on|wearing now')
    if (-not $isReplace) { return '' }
    if ($t -match '衣服|服装|裙|上衣|衬衫|外套|内衣|泳装|制服|和服|汉服|dress|clothes|clothing|outfit|shirt|skirt|jacket|uniform|swimsuit|lingerie|bra|panties|kimono') { return '衣服' }
    if ($t -match '背景|场景|环境|background|scene|setting|backdrop') { return '背景' }
    if ($t -match '脸|五官|面容|表情|发型|头发|face|eyes|expression|hairstyle|bangs') { return '脸' }
    return '未指定'
}

# 一致模式：拿参考图的词当基底，剥掉与「替换目标」冲突的旧标签，用户新指令放最前。
# 目的就是用户要的效果：**换衣服但画风/主体不变**（旧衣服标签若留着会和用户的新指令打架）。
function Merge-ConsistencyPrompt {
    param([string]$UserPos, [string]$RefPos, [string]$Target)
    $conflict = ''
    switch ("$Target") {
        '衣服' { $conflict = 'dress|clothes|clothing|outfit|shirt|skirt|jacket|coat|uniform|swimsuit|bikini|lingerie|bra|panties|kimono|hanfu|sleeves|apron|socks|shoes|裙子|衣服|上衣|外套|内衣|泳装|制服|和服|汉服|鞋|袜' }
        '背景' { $conflict = 'background|sky|cloud|tree|forest|flower|blossom|room|city|street|beach|mountain|window|wall|室内|背景|天空|树|花|房间|城市|街|海|山|窗|墙' }
        '脸'   { $conflict = 'face|eyes|expression|mouth|bangs|hair style|表情|五官' }
    }
    $keep = @()
    if ($RefPos) {
        foreach ($tok in ($RefPos -split ',')) {
            $t = $tok.Trim()
            if (-not $t) { continue }
            if ($conflict -and ($t -match $conflict)) { continue }
            $keep += $t
        }
    }
    # 排序策略：**替换**动作 → 用户新指令在前（它是本次要改的东西）；**整体一致** → 参考图的词在前
    # （保证出来的图与原图一致；用户额外加的词跟在后面）。
    $merged = "$UserPos"
    if ($keep.Count -gt 0) {
        if ($conflict) { $merged = ($UserPos.TrimEnd(',', ' ') + ', ' + ($keep -join ', ')) }
        else { $merged = (($keep -join ', ') + ', ' + $UserPos.TrimEnd(',', ' ')) }
    }
    if ($conflict) { Write-Host "一致：已剔除参考图里与「$Target」冲突的标签 $($keep.Count) 个保留 / 原 $((($RefPos -split ',').Count)) 个" -ForegroundColor DarkGray }
    return ($merged -replace '(\s*,\s*)+', ', ').Trim()
}

# LoRA 片段：<lora:名称:权重>；名称带 .safetensors 后缀时保留原样（SD 两种都认）
# ---- 按「这一张图的内容」自动抠图（不再用预设矩形区域）----
# 调用同目录的 sd-auto-mask.py：YOLO-World（文字提示找目标）→ SAM（精细轮廓）→ 蒙版 PNG。
# 换衣服 = 抠衣服/身体剪影；换背景 = 人以外取反；换脸 = 人脸区。全部**跟着这张图的实际内容走**。

# 找 SD 自带的 python（能 import cv2/torch/ultralytics 的那个）
function Find-SdPython {
    # 找一个**真的能用**的 python（必须能 import cv2 / numpy —— 上次真机失败就是挑到了没有 cv2 的系统 python）。
    if ($script:SdPythonCache) { return $script:SdPythonCache }
    $cands = New-Object System.Collections.Generic.List[string]

    function Add-Cand([string]$p) { if ($p -and (Test-Path -LiteralPath $p)) { $cands.Add($p) } }

    # ① 显式 -SdDir（若调用方给了）
    if ($SdDir) {
        Add-Cand (Join-Path $SdDir 'python\python.exe')
        Add-Cand (Join-Path $SdDir 'venv\Scripts\python.exe')
        Add-Cand (Join-Path $SdDir '.venv\Scripts\python.exe')
    }

    # ② 从正在跑的 SD API 反推 SD 根目录：**优先用 sd-models 的完整模型路径**（最可靠）
    if (-not $script:SdRootProbed) {
        $script:SdRootProbed = $true
        # ① /sdapi/v1/sd-models：filename 形如 D:\SD.4.8\models\Stable-diffusion\x.safetensors
        foreach ($ep in @('sd-models', 'loras')) {
            if ($script:SdRoot) { break }
            try {
                $list = Invoke-RestMethod "http://127.0.0.1:$SdPort/sdapi/v1/$ep" -TimeoutSec 12
                foreach ($it in @($list)) {
                    $p = ""
                    if ($it.filename) { $p = "$($it.filename)" } elseif ($it.path) { $p = "$($it.path)" }
                    if (-not $p) { continue }
                    $m = [regex]::Match($p, '^(.*)\\models\\', 'IgnoreCase')
                    if ($m.Success) { $script:SdRoot = $m.Groups[1].Value; break }
                }
            } catch { }
        }
        # ② cmd-flags 的 ckpt_dir（不少版本是空的，只当次要手段）
        if (-not $script:SdRoot) {
            try {
                $flags = Invoke-RestMethod "http://127.0.0.1:$SdPort/sdapi/v1/cmd-flags" -TimeoutSec 8
                $cd = "$($flags.ckpt_dir)"
                if ($cd) {
                    $sdRootLocal = Split-Path (Split-Path $cd -Parent) -Parent   # 2026-10-21：别用 $root（大小写不敏感，会撞顶层 $Root）
                    if ($sdRootLocal -and (Test-Path -LiteralPath $sdRootLocal)) { $script:SdRoot = $sdRootLocal }
                }
            } catch { }
        }
        # ③ 扫盘兜底：不设数量上限（上次就是被「前 60 个」截掉了 SD.4.8），只限深度 1
        if (-not $script:SdRoot) {
            foreach ($drv in @('D:\', 'E:\', 'C:\', 'F:\')) {
                if (Test-Path -LiteralPath $drv) {
                    $dirs = @()
                    try { $dirs = Get-ChildItem -LiteralPath $drv -Directory -ErrorAction SilentlyContinue } catch { }
                    foreach ($d in $dirs) {
                        $hasWebui = (Test-Path -LiteralPath (Join-Path $d.FullName 'webui.py')) -or (Test-Path -LiteralPath (Join-Path $d.FullName 'launch.py'))
                        $hasPy = Test-Path -LiteralPath (Join-Path $d.FullName 'python\python.exe')
                        if ($hasWebui -and $hasPy) { $script:SdRoot = $d.FullName; break }
                    }
                }
                if ($script:SdRoot) { break }
            }
        }
    }
    if ($script:SdRoot) {
        Add-Cand (Join-Path $script:SdRoot 'python\python.exe')
        Add-Cand (Join-Path $script:SdRoot 'venv\Scripts\python.exe')
        Add-Cand (Join-Path $script:SdRoot '.venv\Scripts\python.exe')
    }

    # ④ 系统 python 兜底（最后才试）
    foreach ($n in @('python', 'python3', 'py')) {
        $cmd = Get-Command $n -ErrorAction SilentlyContinue
        if ($cmd) { Add-Cand $cmd.Source }
    }

    # ⑤ 逐个实测：能 import cv2 + numpy 才算数
    $tried = @()
    foreach ($c in $cands) {
        $tried += $c
        try {
            $null = & $c -c "import cv2, numpy" 2>$null
            if ($LASTEXITCODE -eq 0) {
                $script:SdPythonCache = $c
                return $c
            }
        } catch { }
    }
    $script:SdPythonFail = ($tried -join ' | ')
    return ''
}


# 生成自动蒙版：成功返回蒙版路径，失败返回 '' 并把原因写进 $script:AutoMaskNote
function New-AutoMaskFromImage {
    param(
        [string]$ImagePath,
        [string]$Target,           # 衣服 / 脸 / 背景 / 主体
        [string]$OutPath,
        [int]$Dilate = 8,
        [int]$Feather = 4,
        [string]$HelperPath = "",  # 留空 = 脚本同目录下的 sd-auto-mask.py
        [switch]$ForceCpu          # CUDA 崩掉后的自动重试：强制 CPU 跑检测/分割
    )
    $script:AutoMaskNote = ''
    if ($NoAutoMask) {
        # 插件页开关（maskAutoSegment=false）或命令里显式带的 -NoAutoMask：整条自动抠图不跑，
        # 直接走几何区域蒙版（按画面比例画的上半/下半/中间/四周），不加载任何检测模型。
        $script:AutoMaskNote = '已关闭自动抠图（-NoAutoMask / 插件设置 maskAutoSegment=false）→ 用几何区域蒙版'
        Write-Host "  [抠图] $($script:AutoMaskNote)" -ForegroundColor DarkGray
        return ''
    }
    if (-not $ImagePath -or -not (Test-Path -LiteralPath $ImagePath)) { $script:AutoMaskNote = '参考图不存在'; return '' }
    # 抠图要 YOLO-World + SAM（约 2-3G）：先让 SD 卸载模型把显存腾出来（这正是之前 SAM OOM 的根因）
    Ensure-Vram -For 'sd' -Note '自动抠图'
    $scriptDir = $PSScriptRoot
    if (-not $scriptDir) { try { $scriptDir = Split-Path -Parent $PSCommandPath } catch { } }
    if (-not $scriptDir) { try { $scriptDir = (Get-Location).Path } catch { } }
    $helper = if ($HelperPath) { $HelperPath } else { Join-Path $scriptDir 'sd-auto-mask.py' }
    if (-not (Test-Path -LiteralPath $helper)) { $script:AutoMaskNote = "缺少抠图脚本：$helper"; return '' }
    $py = Find-SdPython
    if (-not $py) { $script:AutoMaskNote = '找不到可用的 python（SD 目录下 python\python.exe）'; return '' }
    $args = @($helper, '--image', $ImagePath, '--target', $Target, '--out', $OutPath, '--dilate', "$Dilate", '--feather', "$Feather")
    if ($Target -eq '衣服') { $args += '--fill-sheer' }   # 补薄纱/透视布料（有 2.2 倍与 22% 双上限保护）
    if ($ForceCpu) { $args += @('--device', 'cpu') }      # 自动重试：这条路径明确绕开 CUDA
    # 权重/模型都靠这个根目录：-SdDir 为空时必须用探测出来的 SD 根（否则报「没找到 YOLO-World 权重」）
    $sdRootForHelper = $SdDir
    if (-not $sdRootForHelper) {
        $null = Find-SdPython          # 顺带完成一次探测，$script:SdRoot 会被填上
        $sdRootForHelper = $script:SdRoot
    }
    if ($sdRootForHelper) { $args += @('--sd-dir', $sdRootForHelper) }
    # 逐行实时转发抠图进度（用户能看见在算），并加硬超时（默认 240 秒）防止真卡死
    $outFile = Join-Path $env:TEMP ("automask-" + [Guid]::NewGuid().ToString('N') + ".log")
    $errFile = "$outFile.err"
    $proc = $null
    try {
        # HuggingFace 缓存：不设 HF_HOME 时 python 会去 %USERPROFILE%\.cache\huggingface，
        # 那里往往缺 CLIP 文字编码器 → set_classes 会去联网下载（300MB+）→ 网络一卡就死在检测那一步。
        # SD 启动器给自己设了 HF_HOME，所以 SD 目录下的缓存才是齐的，这里显式沿用。
        $hfRoot = ""
        if ($sdRootForHelper) { $hfRoot = Join-Path $sdRootForHelper '.cache\huggingface' }
        if ($hfRoot -and (Test-Path -LiteralPath $hfRoot)) {
            $env:HF_HOME = $hfRoot
            $env:HUGGINGFACE_HUB_CACHE = Join-Path $hfRoot 'hub'
            $hubDir = Join-Path $hfRoot 'hub'
            $hasClip = $false
            try { $hasClip = [bool](Get-ChildItem -LiteralPath $hubDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*clip*' }) } catch { }
            if ($hasClip) { $env:HF_HUB_OFFLINE = '1' }   # 模型齐了 → 断网，缺就立刻报错而不是挂住
            Write-Host "  [抠图] 模型缓存：$hfRoot（离线=$([bool]$env:HF_HUB_OFFLINE)）" -ForegroundColor DarkGray
        }
        # 子进程 python 的 stdout 默认跟系统 ANSI 代码页（中文机是 GBK）走 → 中文变乱码、JSON 解析失败。
        # 强制 UTF-8（进程级，跑完还原）。
        $env:PYTHONIOENCODING = 'utf-8'
        $env:PYTHONUTF8 = '1'
        $proc = Start-Process -FilePath $py -ArgumentList $args -NoNewWindow -PassThru `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        $deadline = (Get-Date).AddSeconds(240)
        $shown = 0
        while (-not $proc.HasExited) {
            Start-Sleep -Milliseconds 500
            $lines = @()
            if (Test-Path -LiteralPath $errFile) { $lines = @(Get-Content -LiteralPath $errFile -Encoding UTF8 -ErrorAction SilentlyContinue) }   # 必须按 UTF8 读，否则中文进度变乱码
            while ($shown -lt $lines.Count) {
                $ln = "$($lines[$shown])".Trim()
                if ($ln) { Write-Host "  $ln" -ForegroundColor DarkGray }
                $shown++
            }
            if ((Get-Date) -gt $deadline) {
                try { $proc.Kill() } catch { }
                $script:AutoMaskNote = '抠图超时（240 秒）已中止'
                Remove-Item -LiteralPath $outFile, $errFile -ErrorAction SilentlyContinue
                return ''
            }
        }
        $raw = @()
        if (Test-Path -LiteralPath $outFile) { $raw = @(Get-Content -LiteralPath $outFile -Encoding UTF8 -ErrorAction SilentlyContinue) }   # JSON 是 UTF8，按 GBK 读会把中文读成乱码导致解析失败
        $out = "$(($raw | Where-Object { $_ -like '{*' } | Select-Object -Last 1))".Trim()
        # 失败诊断：拉不到 JSON 时必须说清**为什么**（退出码 + stderr 尾巴），
        # 而不是只丢一句「抠图脚本没有输出」——用户反馈里这句话等于没有信息。
        $script:AutoMaskExit = -1
        try { if ($proc.HasExited) { $script:AutoMaskExit = [int]$proc.ExitCode } } catch { }
        $script:AutoMaskErrTail = @()
        if (Test-Path -LiteralPath $errFile) {
            $script:AutoMaskErrTail = @(Get-Content -LiteralPath $errFile -Encoding UTF8 -ErrorAction SilentlyContinue |
                    Where-Object { "$_".Trim() } | Select-Object -Last 6)
        }
    } catch {
        $script:AutoMaskNote = "抠图脚本调用失败：$($_.Exception.Message)"
        Remove-Item -LiteralPath $outFile, $errFile -ErrorAction SilentlyContinue
        return ''
    } finally {
        $env:PYTHONIOENCODING = $null
        $env:PYTHONUTF8 = $null
        $env:HF_HOME = $null
        $env:HUGGINGFACE_HUB_CACHE = $null
        $env:HF_HUB_OFFLINE = $null
        Remove-Item -LiteralPath $outFile, $errFile -ErrorAction SilentlyContinue
    }
    if (-not $out) {
        $why = "抠图脚本没有输出（python 退出码 $($script:AutoMaskExit)"
        if ($script:AutoMaskExit -eq 3221225477 -or $script:AutoMaskExit -eq -1073741819) {
            $why += " 0xC0000005 异常退出 —— 多半是显存不足/CUDA 崩溃（SD 常驻时检测模型也会抢显存）"
        } elseif ($script:AutoMaskExit -eq 1) {
            $why += "，脚本报错退出"
        } elseif ($script:AutoMaskExit -eq -1) {
            $why += "，进程状态未知"
        }
        $why += ")"
        if ($script:AutoMaskErrTail -and @($script:AutoMaskErrTail).Count -gt 0) {
            $why += "；最后输出：" + ((@($script:AutoMaskErrTail) | ForEach-Object { "$_".Trim() }) -join ' | ')
        }
        $script:AutoMaskNote = $why
        # CUDA 原生崩溃时子进程**连 JSON 都没打**（PowerShell 抓不到栈）——实测复现：同一张图、
        # 同样命令，cuda 下进程直接消失，`--device cpu` 下 100% 成功且结果逐像素一致（覆盖 13.01%）。
        # 所以这里自动用 CPU 重试一次，而不是把「没有输出」甩给用户去猜（截图里那次就是这个坑）。
        if (-not $ForceCpu) {
            Write-Host "  [抠图] $why" -ForegroundColor Yellow
            Write-Host "  [抠图] 自动改用 CPU 重试一次（GPU 侧的检测模型崩了；CPU 结果一致，只是慢些）…" -ForegroundColor Cyan
            return (New-AutoMaskFromImage -ImagePath $ImagePath -Target $Target -OutPath $OutPath `
                    -Dilate $Dilate -Feather $Feather -HelperPath $HelperPath -ForceCpu)
        }
        return ''
    }
    $json = $null
    try { $json = $out | ConvertFrom-Json } catch {
        # 双保险：万一是「UTF-8 被按 GBK 读」造成的乱码，用已有的修复函数救一次
        try {
            $fixed = Repair-Utf8Mojibake -Text $out
            if ($fixed -and $fixed -ne $out) { $json = $fixed | ConvertFrom-Json }
        } catch { }
        if (-not $json) { $script:AutoMaskNote = "抠图输出解析失败：$out"; return '' }
    }
    if ($json.ok -and $json.mask -and (Test-Path -LiteralPath $json.mask)) {
        $script:AutoMaskNote = "$($json.engine)｜覆盖 $([math]::Round(100 * [double]$json.coverage, 1))%｜$($json.notes)"
        return $json.mask
    }
    $script:AutoMaskNote = "$($json.notes)"
    return ''
}

function Format-LoraFragment {
    param([string]$LoraName, [double]$Weight)
    if (-not $LoraName) { return "" }
    return "<lora:$LoraName`:$Weight>"
}

# 解析「名称 权重」串（支持 "xxx"、"xxx 0.8"），返回 @{ Name=; Weight= }（Weight 默认 0.8，越界钳制到 0-1.5）
function Parse-LoraSpec {
    param([string]$Spec)
    if (-not $Spec -or -not $Spec.Trim()) { return $null }
    $name = $Spec.Trim()
    $weight = 0.8
    if ($Spec -match '^(.*?)\s+([0-9]+(?:\.[0-9]+)?)\s*$') {
        $name = $Matches[1].Trim()
        $null = [double]::TryParse($Matches[2], [ref]$weight)
        if ($weight -le 0) { $weight = 0.8 } elseif ($weight -gt 1.5) { $weight = 1.5 }
    }
    return @{ Name = $name; Weight = $weight }
}

# 把 LoRA（含触发词）拼进正向提示词。返回拼接后的 prompt（未变则原样返回）。
# 触发词自动注入 + 同名去重（提示词里已有 <lora:同名:...> 就不再追加）。
function Add-LoraToPrompt {
    param([string]$Prompt, [string]$LoraSpec)
    if (-not $LoraSpec -or -not $LoraSpec.Trim()) { return $Prompt }
    if ($LoraSpec.Trim() -eq '（不用 LoRA）') { return $Prompt }
    $p = Parse-LoraSpec -Spec $LoraSpec
    if (-not $p) { return $Prompt }
    $loraName = $p.Name; $loraWeight = $p.Weight
    # 触发词自动注入（不写它角色特征只出一半力）
    $frag = Format-LoraFragment -LoraName $loraName -Weight $loraWeight
    $trig = Get-LoraTrigger -LoraName $loraName
    if ($trig -and ($Prompt -notmatch [regex]::Escape($trig))) {
        $frag = "$trig, $frag"
        Write-Host "LoRA 触发词：已自动加入「$trig」（不写它角色特征会只出一半力）" -ForegroundColor DarkGray
    }
    # 同名去重：提示词里已有 <lora:同名:...> 就不重复挂
    if ($Prompt -match [regex]::Escape("<lora:$loraName`:")) {
        Write-Host "LoRA 去重：正向提示词里已含 <lora:$loraName`：…>，不再重复挂载" -ForegroundColor Yellow
        return $Prompt
    }
    $out = "$Prompt, $frag"
    Write-Host "已挂 LoRA：$frag" -ForegroundColor DarkGray
    return $out
}

# ================= LoRA 模糊索引（2026-10-27 用户要求）=================
# 对话/提示词里写「守岸人」「爱弥斯」这类角色名时，自动索引到本机对应 LoRA 并挂上，
# 不再要求显式 <lora:...> 语法或表单手选。
#   ① 别名表：中文角色名/俗称 → LoRA 核心 token（人工维护，中英文名之间没有算法关系）
#   ② 英文直配：prompt 里含 LoRA 名的核心 token（不区分大小写）也算命中
#   ③ 核心 token 从本机 LoRA 文件名提取（去掉 official/vN 等噪音段）
$script:LoraAliasMap = [ordered]@{
    '守岸人' = 'shorekeeper'
    '秧秧'   = 'yangyang'
    '流萤'   = 'firefly'
    '爱弥斯' = 'aimisi'
    '釉瑚'   = 'youhu'
    '长离'   = 'changli'
    '今汐'   = 'jinhsi'
    '折枝'   = 'zhezhi'
}
$script:LoraNoiseTokens = @('official', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'lora', 'add', 'detail')

function Get-LoraCoreToken {
    param([string]$LoraName)
    if (-not $LoraName) { return '' }
    $base = ($LoraName -replace '\.safetensors$', '').Trim()
    $tokens = ($base -split '[_\-\s]+') | Where-Object { $_ -and ($script:LoraNoiseTokens -notcontains $_.ToLower()) }
    return ((@($tokens) -join '_')).ToLower()
}

# 从 prompt 模糊索引本机 LoRA。返回 "LoRA名 0.8" 或 ""（未命中）。
# 优先级：别名表中文命中 > 英文核心 token 命中。
function Resolve-LoraFromPrompt {
    param([string]$Prompt, [string[]]$LoraList = @())
    if (-not $Prompt -or -not $Prompt.Trim()) { return "" }
    $list = @($LoraList)
    if ($list.Count -eq 0) { try { $list = @(Get-SdLoras) } catch { $list = @() } }
    if ($list.Count -eq 0) { return "" }

    # ① 别名表：中文角色名命中 → 找核心 token 匹配的本机 LoRA
    foreach ($kv in $script:LoraAliasMap.GetEnumerator()) {
        if ($Prompt -match [regex]::Escape($kv.Key)) {
            $token = "$($kv.Value)"
            foreach ($l in $list) {
                $core = Get-LoraCoreToken -LoraName $l
                if ($core -eq $token -or $core -like "*$token*") {
                    Write-Host "LoRA 模糊索引：prompt 命中「$($kv.Key)」→ 自动挂 $l" -ForegroundColor Cyan
                    return "$l 0.8"
                }
            }
        }
    }
    # ② 英文直配：prompt 里含某 LoRA 的核心 token（如写了 shorekeeper）
    foreach ($l in $list) {
        $core = Get-LoraCoreToken -LoraName $l
        if (-not $core -or $core.Length -lt 4) { continue }
        if ($Prompt -match [regex]::Escape($core)) {
            Write-Host "LoRA 模糊索引：prompt 命中「$core」→ 自动挂 $l" -ForegroundColor Cyan
            return "$l 0.8"
        }
    }
    return ""
}

# 统一入口：显式指定的 LoRA 优先；没指定就从 prompt 模糊索引。
function Get-EffectiveLoraSpec {
    param([string]$Explicit, [string]$Prompt, [string[]]$LoraList = @())
    if ($Explicit -and $Explicit.Trim() -and $Explicit.Trim() -ne '（不用 LoRA）') { return $Explicit.Trim() }
    return (Resolve-LoraFromPrompt -Prompt $Prompt -LoraList $LoraList)
}

# 触发词查询（2026-10-26 修「LoRA 出来是无关的人」）：
#   本机角色 LoRA 训练时，每张图标注都以触发词开头（如 shorekeeperoffic / yyv6），
#   推理时**不写触发词**，LoRA 只出一半力 —— 底模默认长相会盖过角色特征。
#   这里从 LoRA 文件的 safetensors 头里读 ss_tag_frequency，取第一个 token 作为触发词。
function Get-LoraTrigger {
    param([string]$LoraName)
    if (-not $LoraName) { return "" }
    if ($script:LoraTriggerCache -and $script:LoraTriggerCache.ContainsKey($LoraName)) {
        return $script:LoraTriggerCache[$LoraName]
    }
    if (-not $script:LoraTriggerCache) { $script:LoraTriggerCache = @{} }
    $result = ""
    try {
        # 在几个已知 LoRA 目录里找同名文件（$SdDir 可能为空 → 先判空再 Join，否则报「Path 不能绑定空字符串」）
        $cands = @()
        $roots = @()
        if ($SdDir) { $roots += (Join-Path $SdDir 'models\Lora'); $roots += (Join-Path $SdDir 'models\loras') }
        $roots += 'D:\ComfyUI\models\loras'
        if (Test-Path 'D:\SD.4.8\models\Lora') { $roots += 'D:\SD.4.8\models\Lora' }
        foreach ($root in $roots) {
            if (-not $root) { continue }
            $f = Join-Path $root ($LoraName + '.safetensors')
            if (Test-Path -LiteralPath $f) { $cands += $f; break }
        }
        if ($cands.Count -gt 0) {
            $file = $cands[0]
            $fs = [System.IO.File]::OpenRead($file)
            try {
                $lenBuf = New-Object byte[] 8
                $null = $fs.Read($lenBuf, 0, 8)
                $hdrLen = [BitConverter]::ToUInt64($lenBuf, 0)
                if ($hdrLen -gt 0 -and $hdrLen -lt 100MB) {
                    $hdrBuf = New-Object byte[] $hdrLen
                    $null = $fs.Read($hdrBuf, 0, $hdrLen)
                    $hdrText = [System.Text.Encoding]::UTF8.GetString($hdrBuf)
                    # ss_tag_frequency 形如 {"10_xxx": {"triggerword": 35}}
                    $m = [regex]::Match($hdrText, '"ss_tag_frequency"\s*:\s*"(.*?)"\s*[,}]')
                    if ($m.Success) {
                        $tf = $m.Groups[1].Value -replace '\\"', '"' -replace '\\\\', '\'
                        $tm = [regex]::Match($tf, ':\s*\{\s*"([^"]+)"\s*:')
                        if ($tm.Success) { $result = $tm.Groups[1].Value }
                    }
                }
            } finally { $fs.Close() }
        }
    } catch { }
    $script:LoraTriggerCache[$LoraName] = $result
    return $result
}

# 画风 → 正/负向提示词映射：返回 @{ Pos = 正向画风词; Neg = 负向画风词 }（均可能为空串）。
# 这是「写实二次元」等画风在 C 档弹表单时，写进两个提示词框的画风描述词（合规描述词，非违规词）。
function Get-StylePrompt {
    param([string]$Style)
    $pos = ""; $neg = ""
    switch ($Style) {
        '写实'     {
            $pos = "RAW photo, photorealistic, natural skin texture, skin pores, film grain, soft natural lighting, depth of field, shot on Canon EOS R5, 85mm f1.8, highly detailed, 8k uhd"
            $neg = "(cartoon, anime, 3d render, cgi, painting, illustration:1.3), (airbrushed, smooth skin, plastic skin, doll:1.2)"
        }
        '写实二次元' {
            # 半写实·现代 CG 插画脸（十轮迭代实测配方）：动漫底子往写实靠。
            # LoRA semirealisticanime 权重 0.6 是平衡点（0.45 脸崩、0.8 御姐化/跑真人照片）。
            # 立体感靠「体积光包」（第 11-13 轮实测：平光=纸片感），但**不锁金色**——
            # 光色交给场景词决定，负向压 golden hue/sepia，避免每张都金灿灿。
            # <lora:...> 直接写进正向，sd-direct/A1111 原生解析；表单 LoRA 栏就别再重复选它（会叠两层）。
            $pos = "<lora:semirealisticanime:0.6>, (modern anime style:1.25), (semi-realistic:1.1), delicate refined anime face, (big detailed anime eyes:1.25), youthful face, detailed skin shading, (volumetric lighting:1.2), (chiaroscuro:1.2), (subsurface scattering:1.2), translucent skin, soft rim light, atmospheric haze, airbrushed shading, soft gradients, three-dimensional body, natural light color"
            $neg = "(old anime style:1.2), retro anime, flat color, cel shading, (photorealistic:1.3), (mature female face:1.3), (flat lighting:1.3), (flat shading:1.2), (golden hue:1.3), (sepia:1.2), oversaturated"
        }
        '彩色哥特' {
            # 原「真人感半写实」（SemiRealMix 旧配方）演化：华丽哥特——巴洛克金饰、暗调室内、
            # 宝石色点缀（绯红/孔雀蓝）、戏剧性明暗。SemiRealMix 堆金、厚涂、高饱和的「毛病」
            # 在这套词里正好变成风格本体。
            $pos = "semi-realistic, gothic, dark baroque, ornate golden filigree, gold body jewelry, (crimson and teal accents:1.2), jewel tones, dramatic chiaroscuro, candle light, decadent atmosphere, detailed skin texture, beautiful detailed face"
            $neg = "flat color, cel shading, lineart, (cartoon:1.3), (photorealistic:1.2), (flat lighting:1.2), low detail, simple background"
        }
        '写实二次元·东亚脸' {
            # 用户自调画风（2026-10-15 本机实测配方，写实二次元·东亚脸眼细节验证版）：
            # 在「写实二次元」基础上把五官往东亚脸收——脸型收窄、杏仁眼 + 虹膜高光、眼神光、
            # 正面偏侧柔光 + 发丝轮廓光，负向压掉宽脸/宽眼距/西方面孔/过曝/真人照片。
            $pos = "<lora:semirealisticanime:0.6>, (modern anime style:1.25), (semi-realistic:1.1), delicate refined face, slender oval face, (beautiful detailed almond eyes:1.3), (detailed sparkling iris:1.2), luminous gradient eyes, long eyelashes, eye highlight, youthful face, detailed skin shading, (volumetric lighting:1.2), (chiaroscuro:1.2), (subsurface scattering:1.2), translucent skin, (soft front-side fill light:1.3), gentle rim light on hair, atmospheric haze, airbrushed shading, soft gradients, three-dimensional body, natural light color"
            $neg = "(old anime style:1.2), retro anime, flat color, cel shading, (photorealistic:1.3), real person, (mature female face:1.3), (flat lighting:1.3), (flat shading:1.2), (golden hue:1.3), (sepia:1.2), oversaturated, (overexposed:1.3), (wide-set eyes:1.4), (wide face:1.2), western features, bad face, deformed face, asymmetrical eyes"
        }
        '釉彩调色盘' {
            # 用户自调画风（本机 LoRA）：釉彩·麻袋调色盘_v1.0——釉面质感 + 麻袋粗布调色盘色域，
            # 只挂 LoRA（权重 0.8）+ 极简风格词，其余交给用户的提示词；LoRA 缺失时整段为空、表单照常可用。
            $pos = "<lora:釉彩·麻袋调色盘_v1.0:0.8>, glaze texture, matte burlap canvas palette, muted earthy tones"
            $neg = ""
        }
        '二次元'   {
            # 2026-10-15 修：这一档以前**完全没有映射**（switch 里没有 '二次元' 分支 → 返回空词），
            # 而它又是「无底图时」的默认档 —— 表现就是「选二次元什么都没有、画不出二次元」。
            # 正统二次元 = 线稿 + 赛璐璐平涂 + 动漫脸；负向压掉 3D/照片感。
            $pos = "anime style, (clean lineart:1.2), (cel shading:1.15), flat color, vibrant colors, (detailed anime eyes:1.2), beautiful detailed face, masterpiece, best quality"
            $neg = "(3d:1.2), (photorealistic:1.3), photo, (realistic skin texture:1.2), (realistic face:1.2), sketch, (blurry lineart:1.1)"
        }
        '国风'     {
            # 国风：以国风山水 LoRA 为主，这里只补底层风格词（不写 <lora:...>，避免与表单 LoRA 栏叠两层）
            $pos = "traditional Chinese style, guofeng, (ink wash painting elements:1.15), elegant hanfu, silk texture, misty mountains, (classical Chinese aesthetic:1.2)"
            $neg = "(3d:1.2), photorealistic, (western cartoon:1.1), modern city, neon lights"
        }
        '赛博朋克' {
            # 赛博朋克：以赛博朋克场景 LoRA 为主，这里只补场景/光照底词
            $pos = "cyberpunk, neon lights, rain-slick night city, holographic signs, (high-tech low-life:1.1), volumetric neon fog, reflective wet streets"
            $neg = "daylight, rural, countryside, (flat lighting:1.1)"
        }
        '一致（自动检测参考图）' {
            # 决策 C-1a：不注入固定画风词——画风与主体从**参考图**里自动检测（PNG 元数据 → A1111 反推 → VLM），
            # 由主流程在出图前写进提示词。这里保持空映射是语义，不是漏写。
        }
        '保持画风' {
            # 明确「不注入任何画风词」：维持底图/LoRA/用户自己的提示词——保持空映射是这个档位的语义，
            # 不是漏写（下方 厚涂/水彩/像素风 同理只补对应风格的词）。
        }
        '厚涂'     {
            $pos = "impasto, thick paint, oil painting, visible brush strokes, palette knife texture"
            $neg = "flat color, cel shading, lineart"
        }
        '水彩'     {
            $pos = "watercolor painting, wet-on-wet, soft washes, pigment bleed, paper texture"
            $neg = "thick paint, impasto, 3d render"
        }
        '像素风'   {
            $pos = "pixel art, 8-bit, limited color palette, dithering, retro game sprite"
            $neg = "smooth shading, gradient, blurry"
        }
    }
    return @{ Pos = $pos; Neg = $neg }
}

# ---- 出图参数表单（WinForms）：正向/负向提示词 + 迭代次数 / Denoising / 比例 / 画风 / 画质 ----
# 提示词（基底已预填）作为多行文本框放在表单顶部，所有可填项一次填完；画风在图生图时默认「保持画风」。
function Show-ParamForm {    param(
        [int]$DefaultRounds,
        [bool]$HasBaseImage,
        [string]$Positive,
        [string]$Negative,
        [string[]]$LoraList,
        [string[]]$CheckpointList,
        [string]$InitImageDefault = "",
        [string]$CurrentModel = "",
        [string]$ModeDefault = "",
        [string]$MaskDefault = "",
        [PSCustomObject[]]$BackendList = @(),     # 坑55/P5：网关模型可用性（键 = 4 枚举之一，Status = ok/offline/no-model）
        [string]$BackendDefault = "",             # 默认模型 key（SD_FP16 / Anima_INT8 / QwenImage_NVFP4 / Krea2_Q4）
        [hashtable]$ModelStatus = @{},            # P5：模型 key → 可用性文字（来自网关 /api/models）
        [hashtable]$ModelMissing = @{},        # 2026-10-19：模型 key → 缺失文件数组（红字提示）
        [string]$GatewayBase = "",                # P5：网关地址（表单状态栏显示用）
        [string]$PreGenPath = "",                 # C 档新流程：后台已生成好的成品路径（表单状态栏直接显示）
        [int]$VlmInitialIndex = 0,           # 视觉审查下拉初值（0自动/1强制/2关闭）
        [int]$GwWidthDefault = 0,                 # C 档新流程：表单宽/高初始值（跟随后台预生成尺寸，避免"预生成尺寸与点确定尺寸不一致"）
        [int]$GwHeightDefault = 0,
        [switch]$LockBase = $false,      # 底图由对话解析好 → 表单直接填好并锁定
        [switch]$LockMask = $false,      # 蒙版由对话画好（或给定精确框）→ 表单直接填好并锁定
        [string]$AddTextDefault = "",    # 加字指令预填（来自 -AddText；表单「加字」栏里可改）
        [string]$AddTextModelDefault = "自动（换另一档）",   # 加字模型预选（来自 -AddTextModel）
        [string]$AddTextPosDefault = '随机',              # 加字位置预填（来自 -AddTextPos）
        [string]$AddTextSizeDefault = '中',               # 字号预填（来自 -AddTextSize）
        [string]$AddTextStyleDefault = '粗体无衬线（白）',   # 字体风格预填（来自 -AddTextStyle）
        [switch]$AutoOpenPosPicker = $false,          # 对话里有加字要求 → 表单弹出后自动开一次选位器
        [string]$PreGenImagePath = "",               # 选位器里预览用的成品图（预生成那张）
        [string]$LoraDefault = ""                    # LoRA 预填（来自 -Lora；"名称" 或 "名称 权重"）
    )
    $form = New-Object System.Windows.Forms.Form
    $form.Text = "sd-inject 出图参数  ·  左：提示词    右：其它参数"
    # ---------------------------------------------------------------------
    # 两栏布局（用户要求 2026-10-19）：左栏放两个提示词框（大、可滚动），右栏放其它参数。
    # 所有控件仍然保留原来的 Name/AccessibleName（UI 自动化可按名字/文字定位）。
    # ---------------------------------------------------------------------
    $script:FmLabelX = 600      # 右栏标签列
    $script:FmCtlX = 716        # 右栏控件列
    $script:FmCtlW = 292        # 右栏控件宽
    $script:FmRowY0 = 18        # 右栏首行 y
    $script:FmRowH = 38         # 行距（2026-10-19：42→38，为新增「视觉审查」行腾空间）
    # P5：新增「宽×高 + 状态栏 + 提交出图（网关·异步）」三行 → 高度 726 → 862
    # 屏幕适配（2026-10-21）：窗口按工作区**收进来**，装不下就开滚动条 —— 小屏/低分屏也不会「按钮跑出屏幕外」。
    $script:FormW = 1024; $script:FormH = 914; $script:FormScroll = $false
    try {
        $wa0 = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        if ($wa0.Width -gt 200) { if ($script:FormW -gt ($wa0.Width - 20)) { $script:FormW = [int]($wa0.Width - 20) } }
        if ($wa0.Height -gt 200) {
            if ($script:FormH -gt ($wa0.Height - 20)) { $script:FormH = [int]($wa0.Height - 20); $script:FormScroll = $true }
        }
    } catch { }
    $form.ClientSize = New-Object System.Drawing.Size($script:FormW, $script:FormH)   # 目标 1024x914（2026-10-21：+38 给「字号/风格」行）
    if ($script:FormScroll) { $form.AutoScroll = $true; Write-Host ("屏幕较小：窗口收成 {0}x{1} 并开滚动条（内容全部保留）" -f $script:FormW, $script:FormH) -ForegroundColor DarkYellow }
    $form.FormBorderStyle = 'FixedDialog'
    $form.StartPosition = 'CenterScreen'
    $form.MaximizeBox = $false
    $form.TopMost = $true

    # 0) 正向 / 负向提示词（多行文本框：BasePrompt 已预填；技术测试词与基底**合并**预填，可直接改）
    $lbPos = New-Object System.Windows.Forms.Label
    $lbPos.Text = '正向提示词（基底 + 技术测试词已合并预填，可直接编辑）：'
    $lbPos.SetBounds(14, 12, 556, 22)
    $form.Controls.Add($lbPos)

    $txtPos = New-Object System.Windows.Forms.TextBox
    $txtPos.Multiline = $true
    $txtPos.ScrollBars = 'Vertical'
    $txtPos.Text = $Positive
    $txtPos.SetBounds(14, 36, 556, 312)
    $form.Controls.Add($txtPos)

    $lbNeg = New-Object System.Windows.Forms.Label
    $lbNeg.Text = '负向提示词：'
    $lbNeg.SetBounds(14, 356, 300, 22)
    $form.Controls.Add($lbNeg)

    $txtNeg = New-Object System.Windows.Forms.TextBox
    $txtNeg.Multiline = $true
    $txtNeg.ScrollBars = 'Vertical'
    $txtNeg.Text = $Negative
    $txtNeg.SetBounds(14, 380, 556, 312)
    $form.Controls.Add($txtNeg)

    # 左栏底部说明（两栏布局后提示词框大幅加宽加高，这里说清编辑习惯）
    $lbPromptHint = New-Object System.Windows.Forms.Label
    $lbPromptHint.Text = '一行一个概念、逗号分隔；画风默认不注入（要加请选右侧「画风」档）；出图前会自动补脸部细节词'
    $lbPromptHint.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 7.5)
    $lbPromptHint.ForeColor = [System.Drawing.Color]::Gray
    $lbPromptHint.SetBounds(14, 700, 556, 18)
    $form.Controls.Add($lbPromptHint)

    # 0-12) 参数行（y 从 200 起，行距 40；共 12 项，表单高度相应 +40）
    # 2026-10-19：模型一选中，下面不满足条件的档位会被 $applyModelLock 从下拉里剔掉（见底部）
    # 坑55（2026-10-18）：新增「后端」项——文生图/图生图时与 SD 并列可选 Qwen-Image-2.1。
    # 后端是总开关，放在「模式」之前；表单 ClientSize 高度 726 → 766。
    $rowY = { param([int]$n) 200 + $n * 40 }
    $labels = @('后端：', '模式：', '底图：', '蒙版：', 'Denoising：', '视觉审查：', '迭代次数：', '比例：', '画风：', '画质：', 'LoRA：', '模型：', '命名：')
    for ($i = 0; $i -lt $labels.Count; $i++) {
        $lb = New-Object System.Windows.Forms.Label
        $lb.Text = $labels[$i]
        $lb.SetBounds($script:FmLabelX, ($script:FmRowY0 + $i * $script:FmRowH), 108, 22)
        $form.Controls.Add($lb)
    }

    # 0) 模型（只读下拉）：**严格限定 4 个枚举**（P5 硬要求）
    #    SD_FP16 / Anima_INT8 → WebUI；QwenImage_NVFP4 / Krea2_Q4 → ComfyUI。
    #    可用性文字来自网关 /api/models（离线/缺模型会直接标出来，避免点下去才发现）。
    $cboBackend = New-Object System.Windows.Forms.ComboBox
    $cboBackend.DropDownStyle = 'DropDownList'
    # UI 自动化可识别身份（P6.2 键鼠验证要按名字定位控件）
    $cboBackend.Name = 'cboBackend'
    $cboBackend.AccessibleName = 'cboBackend'
    $backendItems = @()
    foreach ($key in $script:GatewayModels) {
        $label = $script:GatewayModelLabels[$key]
        if (-not $label) { $label = $key }
        $tag = ''
        $ready = $true
        if ($ModelStatus -and $ModelStatus.ContainsKey($key)) {
            $st = "$($ModelStatus[$key])"
            if ($st -and $st -ne 'ok') {
                $tag = if ($st -eq 'no-model') { '（模型未就绪）' } elseif ($st -eq 'offline') { '（引擎离线）' } else { "（$st）" }
                $ready = $false
            }
        } elseif ($BackendList) {
            foreach ($b in $BackendList) {
                if ("$($b.Key)" -eq $key) {
                    if ("$($b.Status)" -ne 'ok' -and "$($b.Status)" -ne 'ready') {
                        $tag = if ("$($b.Status)" -eq 'no-model') { '（模型未就绪）' } else { '（引擎离线）' }
                        $ready = $false
                    }
                    break
                }
            }
        }
        $item = [PSCustomobject]@{ Text = "$label$tag"; Key = $key; Ready = $ready }
        $null = $cboBackend.Items.Add($item)
        $backendItems += $item
    }
    $cboBackend.DisplayMember = 'Text'
    $cboBackend.ValueMember = 'Key'
    $defIdx = 0
    if ($cboBackend.Items.Count -gt 0) { $cboBackend.SelectedIndex = $defIdx }
    if ("$BackendDefault" -and ($script:GatewayModels -contains "$BackendDefault")) {
        for ($i = 0; $i -lt $backendItems.Count; $i++) {
            if ($backendItems[$i].Key -eq "$BackendDefault") { $cboBackend.SelectedIndex = $i; break }
        }
    }
    $cboBackend.SetBounds($script:FmCtlX, $script:FmRowY0, $script:FmCtlW, 24)
    $form.Controls.Add($cboBackend)
    $lbBackendHint = New-Object System.Windows.Forms.Label
    $lbBackendHint.Text = '（4 档全可选；标「未就绪」也能选——点「确定出图」会自动加载该模型）'
    $lbBackendHint.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 7)
    $lbBackendHint.ForeColor = [System.Drawing.Color]::Gray
    $lbBackendHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 26), $script:FmCtlW, 16)
    $form.Controls.Add($lbBackendHint)

    # 0) 模式（只读下拉：文生图 / 图生图）—— 决策 C-0 / C-1 的总开关
    $cboMode = New-Object System.Windows.Forms.ComboBox
    $cboMode.DropDownStyle = 'DropDownList'
    $cboMode.Name = 'cboMode'
    $cboMode.AccessibleName = 'cboMode'
    foreach ($m in @('文生图', '图生图')) { $null = $cboMode.Items.Add($m) }
    # 任务类型由**对话判断后提交**（-Mode）：文生图 / 图生图；留空时默认文生图
    $cboMode.SelectedIndex = 0
    if ("$ModeDefault" -eq '图生图') { $cboMode.SelectedIndex = 1 }
    $cboMode.SetBounds($script:FmCtlX, ($script:FmRowY0 + 1 * $script:FmRowH), $script:FmCtlW, 24)
    $form.Controls.Add($cboMode)
    $lbModeHint = New-Object System.Windows.Forms.Label
    $lbModeHint.Text = '（图生图用底图重绘；替换衣服/脸/背景请配合蒙版）'
    $lbModeHint.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 7)
    $lbModeHint.ForeColor = [System.Drawing.Color]::Gray
    $lbModeHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 1 * $script:FmRowH + 25), $script:FmCtlW, 13)
    $form.Controls.Add($lbModeHint)

    # 1) 底图（图生图用）：留空 = 最近一张；「最近」= 输出目录最新一张；也可填路径或点「浏览…」选图
    $txtInit = New-Object System.Windows.Forms.TextBox
    $txtInit.Text = "$InitImageDefault"
    $txtInit.SetBounds($script:FmCtlX, ($script:FmRowY0 + 2 * $script:FmRowH), 180, 24)
    $form.Controls.Add($txtInit)
    $btnInitBrowse = New-Object System.Windows.Forms.Button
    $btnInitBrowse.Text = '浏览…'
    $btnInitBrowse.SetBounds(($script:FmCtlX + 186), ($script:FmRowY0 + 2 * $script:FmRowH), 86, 24)
    $btnInitBrowse.Add_Click({
        $ofd = New-Object System.Windows.Forms.OpenFileDialog
        $ofd.Title = '选一张底图（图生图用）'
        $ofd.Filter = '图片|*.png;*.jpg;*.jpeg;*.webp;*.bmp|所有文件|*.*'
        if ($ofd.ShowDialog() -eq 'OK') { $txtInit.Text = $ofd.FileName }
    })
    $form.Controls.Add($btnInitBrowse)
    $lbInitHint = New-Object System.Windows.Forms.Label
    $lbInitHint.Text = '（留空=最近一张；或填路径）'
    $lbInitHint.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 7)
    $lbInitHint.ForeColor = [System.Drawing.Color]::Gray
    $lbInitHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 2 * $script:FmRowH + 25), $script:FmCtlW, 13)
    $form.Controls.Add($lbInitHint)

    # 2) 蒙版（决策 C-1b：替换衣服/脸/背景时只重绘这一块，其余像素原样保留 → 画风天然一致）
    $cboMask = New-Object System.Windows.Forms.ComboBox
    $cboMask.DropDownStyle = 'DropDown'
    # 首项就是「自动」：蒙版按**这张图的内容**现抠（换衣服抠衣服、换背景抠背景），不再靠预设矩形。
    # 「手动绘制」= 弹出手绘窗口，用户拿鼠标涂出要重绘的区域（用户要求 2026-10-16）。
    # 2026-10-19（用户要求）：删掉 4 个预设几何区域（上半/下半/中间/四周）与两个反选 —— 一律走视觉抠图。
    foreach ($v in @('自动（按图内容抠图）', '手动绘制（鼠标涂抹）', '无（整图重绘）')) { $null = $cboMask.Items.Add($v) }
    $cboMask.Text = '自动（按图内容抠图）'
    # 坑41（用户实测 2026-10-17）：对话侧提交的 -MaskSpec 可能是**短形态**（「手动绘制」/「衣服」/
    # 「脸」/「背景」/「主体」/「自动」），而列表里的条目是**长形态**（「手动绘制（鼠标涂抹）」/
    # 「下半（衣服）」/「上半（脸）」…）。短形态不在 Items 里，WinForms 的 DropDown 又会把 Text
    # 回落成首项「自动（按图内容抠图）」→ 主流程拿到的是「自动」→ 手绘窗口根本不弹、
    # 用户选的区域也被吞掉（实测：-MaskSpec 手动绘制 却跑成了自动抠图 + 几何蒙版）。
    # 修法：把短形态**归一化到列表里的长形态**再赋值（实在没匹配的才插入自定义项）。
    $maskAlias = @{
        '自动' = '自动（按图内容抠图）'; 'auto' = '自动（按图内容抠图）'; '自动抠图' = '自动（按图内容抠图）';
        '手动' = '手动绘制（鼠标涂抹）'; '手动绘制' = '手动绘制（鼠标涂抹）'; '手绘' = '手动绘制（鼠标涂抹）'; 'manual' = '手动绘制（鼠标涂抹）';
        '无' = '无（整图重绘）'; '整图' = '无（整图重绘）';
        # 几何区域（脸/衣服/主体/背景及其反选）已从下拉删除：对话若仍提交这些短形态，统一归一到「自动」（按图抠）
        '脸' = '自动（按图内容抠图）'; '上半' = '自动（按图内容抠图）'; '上半（脸）' = '自动（按图内容抠图）';
        '衣服' = '自动（按图内容抠图）'; '下半' = '自动（按图内容抠图）'; '下半（衣服）' = '自动（按图内容抠图）';
        '主体' = '自动（按图内容抠图）'; '中间' = '自动（按图内容抠图）'; '中间（主体）' = '自动（按图内容抠图）';
        '背景' = '自动（按图内容抠图）'; '四周' = '自动（按图内容抠图）'; '四周（背景）' = '自动（按图内容抠图）';
        '脸反选' = '自动（按图内容抠图）'; '背景反选' = '自动（按图内容抠图）'
    }
    if ($MaskDefault) {
        $norm = $MaskDefault.Trim()
        if ($norm -match '\.(png|jpg|jpeg|webp|bmp)$') {
            # 路径形态（对话侧预抠好的蒙版）→ 塞进列表首位再选中（坑37）
            if (-not $cboMask.Items.Contains($norm)) { $null = $cboMask.Items.Insert(0, $norm) }
            $cboMask.Text = $norm
        } elseif ($maskAlias.ContainsKey($norm)) {
            $cboMask.Text = $maskAlias[$norm]          # 短形态 → 列表里的长形态（坑41）
        } elseif ($cboMask.Items.Contains($norm)) {
            $cboMask.Text = $norm
        } else {
            # 认不出的值：插进列表（至少让用户看到对话提交了什么），不再静默回落成「自动」
            $null = $cboMask.Items.Insert(0, $norm)
            $cboMask.Text = $norm
        }
    }
    $cboMask.SetBounds($script:FmCtlX, ($script:FmRowY0 + 3 * $script:FmRowH), $script:FmCtlW, 24)
    $form.Controls.Add($cboMask)
    $lbMaskHint = New-Object System.Windows.Forms.Label
    $lbMaskHint.Text = '（自动=按图抠；也可填区域名/box:x,y,w,h/蒙版图路径）'
    $lbMaskLockHint = $lbMaskHint   # 文生图时改写成锁定提示（下面 applyModeLock 里用）
    $lbMaskHint.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 7)
    $lbMaskHint.ForeColor = [System.Drawing.Color]::Gray
    $lbMaskHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 3 * $script:FmRowH + 25), $script:FmCtlW, 13)
    $form.Controls.Add($lbMaskHint)

    # 3) Denoising（**恒可编辑**下拉：0 = 文生图；>0 = 重绘幅度）
    #    图生图的默认值 = 0.65（用户 2026-10-18 指定）
    $cboDenoise = New-Object System.Windows.Forms.ComboBox
    $cboDenoise.DropDownStyle = 'DropDown'
    foreach ($v in @('0（文生图·不用底图）', '0.3', '0.4', '0.45', '0.5', '0.6', '0.65', '0.7', '0.8', '0.9')) { $null = $cboDenoise.Items.Add($v) }
    $cboDenoise.Text = '0（文生图·不用底图）'
    $cboDenoise.SetBounds($script:FmCtlX, ($script:FmRowY0 + 4 * $script:FmRowH), $script:FmCtlW, 24)
    $cboDenoise.Enabled = $true
    $form.Controls.Add($cboDenoise)
    $lbDenoiseHint = New-Object System.Windows.Forms.Label
    $lbDenoiseHint.Text = '（图生图默认 0.65；0.4-0.5 更贴底图；≥0.7 大改）'
    $lbDenoiseHint.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 7)
    $lbDenoiseHint.ForeColor = [System.Drawing.Color]::Gray
    $lbDenoiseHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 4 * $script:FmRowH + 25), $script:FmCtlW, 13)
    $form.Controls.Add($lbDenoiseHint)

    # 4) 迭代次数（可编辑下拉）
    $cboRounds = New-Object System.Windows.Forms.ComboBox
    $cboRounds.DropDownStyle = 'DropDown'
    foreach ($n in @(1, 2, 3, 4, 5, 8, 12, 16, 24, 32)) { $null = $cboRounds.Items.Add("$n") }
    $cboRounds.Text = "$DefaultRounds"
    $cboRounds.SetBounds($script:FmCtlX, ($script:FmRowY0 + 6 * $script:FmRowH), $script:FmCtlW, 24)
    $form.Controls.Add($cboRounds)
    # 5) 视觉审查（2026-10-19 用户要求：必须是可选项；选「关闭」后续生图整条跳过视觉这一步）
    $cboVlm = New-Object System.Windows.Forms.ComboBox
    $cboVlm.Name = "cboVlm"
    $cboVlm.AccessibleName = "cboVlm"
    $cboVlm.DropDownStyle = "DropDownList"
    foreach ($v in @("自动（模型在就跑，起不来降级）", "强制开启（缺模型就报错）", "关闭（完全跳过视觉）")) { $null = $cboVlm.Items.Add($v) }
    $cboVlm.SelectedIndex = if ($VlmInitialIndex) { [int]$VlmInitialIndex } else { 0 }   # 2026-10-20：改读参数而非 script 变量
    $cboVlm.SetBounds($script:FmCtlX, ($script:FmRowY0 + 5 * $script:FmRowH), $script:FmCtlW, 24)
    $form.Controls.Add($cboVlm)
    $lbVlmHint = New-Object System.Windows.Forms.Label
    $lbVlmHint.Text = "（关闭 = 不探活/不冷启动/不打分/不识别画风，出满 N 张自己挑）"
    $lbVlmHint.Font = New-Object System.Drawing.Font("Microsoft YaHei", 7)
    $lbVlmHint.ForeColor = [System.Drawing.Color]::Gray
    $lbVlmHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 5 * $script:FmRowH + 25), $script:FmCtlW, 13)
    $form.Controls.Add($lbVlmHint)



    # 5) 比例（只读下拉）
    $cboRatio = New-Object System.Windows.Forms.ComboBox
    $cboRatio.DropDownStyle = 'DropDownList'
    foreach ($r in @('9:16', '1:1', '3:4', '4:3', '16:9', '2:3', '3:2', '21:9')) { $null = $cboRatio.Items.Add($r) }
    $cboRatio.SelectedIndex = 0
    $cboRatio.SetBounds($script:FmCtlX, ($script:FmRowY0 + 7 * $script:FmRowH), $script:FmCtlW, 24)
    $form.Controls.Add($cboRatio)

    # 6) 画风（只读下拉）：首项「一致（自动检测参考图）」= 决策 C-1a，从参考图反推画风/主体；
    #    「保持画风」= 不注入任何画风词；其余档位 = 注入对应画风词（见 Get-StylePrompt）。
    $cboStyle = New-Object System.Windows.Forms.ComboBox
    $cboStyle.DropDownStyle = 'DropDownList'
    foreach ($s in @('一致（自动检测参考图）', '保持画风', '二次元', '写实二次元', '写实二次元·东亚脸', '彩色哥特', '釉彩调色盘', '国风', '赛博朋克', '写实', '厚涂', '水彩', '像素风')) { $null = $cboStyle.Items.Add($s) }
    # 默认「保持画风」（= 不往提示词框里塞任何画风词）。
    # 用户反馈（2026-10-18）：默认是「二次元」时，表单会把 anime style / cel shading / flat color… 直接写进
    # 正向框、把 3d/photorealistic… 写进负向框，看起来像"提示词被固定了画风"。现在默认不动用户的词，
    # 想加画风自己选档位即可（选档位仍会把该档位的词幂等写进两个框）。
    $cboStyle.SelectedIndex = 1
    $cboStyle.SetBounds($script:FmCtlX, ($script:FmRowY0 + 8 * $script:FmRowH), $script:FmCtlW, 24)
    $form.Controls.Add($cboStyle)

    # 画风依赖可用性（2026-10-21 用户反馈）：以前只在控制台打一行「LoRA/底模没有」→ 用户看不见，
    #   换完画风发现「跟没换一样」。现在画风下面直接写字：缺什么、当前模型路由下生不生效。
    $lbStyleHint = New-Object System.Windows.Forms.Label
    $lbStyleHint.Name = 'lbStyleHint'
    $lbStyleHint.AccessibleName = 'lbStyleHint'
    $lbStyleHint.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 7)
    $lbStyleHint.ForeColor = [System.Drawing.Color]::FromArgb(200, 60, 60)
    $lbStyleHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 8 * $script:FmRowH + 25), $script:FmCtlW, 13)
    $form.Controls.Add($lbStyleHint)
    $applyStyleHint = {
        try {
            $st = [string]$cboStyle.SelectedItem
            $mk = if ($cboBackend -and $cboBackend.SelectedItem) { [string]$cboBackend.SelectedItem.Key } else { 'SD_FP16' }
            $isComfy = ((Get-ModelEngineFor -Model $mk) -eq 'comfy')
            $loraDeps = @()
            $ckptDeps = @()
            $needLora = $false
            if ($st -in @('写实二次元', '写实二次元·东亚脸')) {
                $needLora = $true
                if (-not (@($LoraList) | Where-Object { $_ -match 'semirealisticanime' })) { $loraDeps += 'LoRA semirealisticanime' }
                if (-not (@($CheckpointList) | Where-Object { $_ -match 'SemiReal|semireal|半写实' })) { $ckptDeps += '底模 SemiRealMix' }
            } elseif ($st -eq '彩色哥特') {
                if (-not (@($CheckpointList) | Where-Object { $_ -match 'SemiReal|semireal|半写实' })) { $ckptDeps += '底模 SemiRealMix' }
            } elseif ($st -eq '釉彩调色盘') {
                $needLora = $true
                if (-not (@($LoraList) | Where-Object { $_ -match '釉彩' })) { $loraDeps += 'LoRA 釉彩·麻袋调色盘' }
            } elseif ($st -eq '写实') {
                if (-not (@($CheckpointList) | Where-Object { $_ -match 'majic' })) { $ckptDeps += '底模 majicMIX' }
            }
            if ($st -in @('保持画风', '一致（自动检测参考图）') -or -not $st) {
                $lbStyleHint.Text = ''
                return
            }
            # 2026-10-27：ComfyUI 路由下 LoRA 已能**跨架构转译**（网关 bridge：Stage1 SD_FP16+LoRA
            #   → Stage2 DiT img2img 迁移风格），所以不再提示「不生效」，改成正面说明；
            #   只有「底模切换」在 DiT 下确实无意义（DiT 用固定 UNet），靠风格词近似。
            $needLoraMissing = ($loraDeps.Count -gt 0)
            if ($isComfy) {
                if ($needLora -and $needLoraMissing) {
                    $lbStyleHint.ForeColor = [System.Drawing.Color]::FromArgb(200, 60, 60)
                    $lbStyleHint.Text = ('（ComfyUI 路由：缺 ' + ($loraDeps -join '、') + ' → 装上后本档即走跨架构转译，效果完整）')
                } elseif ($needLora) {
                    $lbStyleHint.ForeColor = [System.Drawing.Color]::FromArgb(0, 140, 90)
                    $lbStyleHint.Text = '（ComfyUI 路由：本档 LoRA 走跨架构转译 —— Stage1 SD_FP16+LoRA 出图 → Stage2 DiT img2img 迁移风格，效果完整）'
                } elseif ($ckptDeps.Count -gt 0) {
                    $lbStyleHint.ForeColor = [System.Drawing.Color]::FromArgb(210, 130, 20)
                    $lbStyleHint.Text = ('（ComfyUI 路由：本档靠 ' + ($ckptDeps -join '、') + ' 换底——DiT 用固定 UNet 不切底，改由风格词近似；要精确底模请切 SD_FP16）')
                } else {
                    $lbStyleHint.ForeColor = [System.Drawing.Color]::FromArgb(0, 140, 90)
                    $lbStyleHint.Text = '（本档依赖齐全 · ComfyUI 下走跨架构转译/风格词注入）'
                }
            } elseif (($loraDeps.Count + $ckptDeps.Count) -gt 0) {
                $all = @($loraDeps + $ckptDeps)
                $lbStyleHint.ForeColor = [System.Drawing.Color]::FromArgb(200, 60, 60)
                $lbStyleHint.Text = '（本机缺：' + ($all -join '、') + ' → 这档只会注入风格词，效果打折）'
            } else {
                $lbStyleHint.ForeColor = [System.Drawing.Color]::FromArgb(0, 140, 90)
                $lbStyleHint.Text = '（本档依赖齐全）'
            }
        } catch { }
    }
    $cboStyle.Add_SelectedIndexChanged({ try { & $applyStyleHint } catch { } })
    try { & $applyStyleHint } catch { }

    # 7) 画质（只读下拉）
    #    2026-10-19 修正：默认档从 480p 改为 1024p —— 480p + 9:16 会算成 264x480，
    #    短边 264 对 SD 系是必糊尺寸（全身构图下脸只有几十像素，ADetailer 都救不回来）。
    #    真正的"不可用档"由下方 $applyModelLock 按模型动态剔除（短边 <512 全锁）。
    $cboQuality = New-Object System.Windows.Forms.ComboBox
    $cboQuality.DropDownStyle = 'DropDownList'
    foreach ($q in @('480p', '640p', '768p', '1024p', '1280p', '1440p', '2160p（4K）')) { $null = $cboQuality.Items.Add($q) }
    $cboQuality.SelectedIndex = [Math]::Max(0, $cboQuality.Items.IndexOf('1024p'))
    $cboQuality.SetBounds($script:FmCtlX, ($script:FmRowY0 + 9 * $script:FmRowH), $script:FmCtlW, 24)
    $form.Controls.Add($cboQuality)

    # 8) LoRA（可编辑下拉）
    $cboLora = New-Object System.Windows.Forms.ComboBox
    $cboLora.DropDownStyle = 'DropDown'
    $null = $cboLora.Items.Add('（不用 LoRA）')
    foreach ($l in $LoraList) { $null = $cboLora.Items.Add("$l 0.8") }
    $cboLora.SelectedIndex = 0
    # LoRA 预填（2026-10-27）：对话侧 -Lora 直接预选，用户打开表单就能看到已选
    if ($LoraDefault -and $LoraDefault.Trim()) {
        $loraSpec0 = $LoraDefault.Trim()
        $loraName0 = $loraSpec0
        if ($loraSpec0 -match '^(.*?)\s+[0-9]+(?:\.[0-9]+)?\s*$') { $loraName0 = $Matches[1].Trim() }
        # 优先精确匹配下拉里的「名称 0.8」；没有就手填
        $matchIdx = -1
        for ($li = 0; $li -lt $cboLora.Items.Count; $li++) {
            $itName = [string]$cboLora.Items[$li]
            $itBase = $itName
            if ($itName -match '^(.*?)\s+[0-9]+(?:\.[0-9]+)?\s*$') { $itBase = $Matches[1].Trim() }
            if ($itBase -eq $loraName0) { $matchIdx = $li; break }
        }
        if ($matchIdx -ge 0) { $cboLora.SelectedIndex = $matchIdx; $cboLora.Text = [string]$cboLora.Items[$matchIdx] }
        else { $cboLora.Text = $loraSpec0 }
        Write-Host "LoRA 预填：$($cboLora.Text)" -ForegroundColor DarkGray
    }
    $cboLora.SetBounds($script:FmCtlX, ($script:FmRowY0 + 10 * $script:FmRowH), $script:FmCtlW, 24)
    $form.Controls.Add($cboLora)
    if ($LoraList.Count -eq 0) {
        $lbLoraHint = New-Object System.Windows.Forms.Label
        $lbLoraHint.Text = '（本机没扫到 LoRA 文件；可手填「名称 权重」，或把 LoRA 放进 models\Lora / ComfyUI\models\loras）'
        $lbLoraHint.Font = New-Object System.Drawing.Font('Microsoft YaHei', 7.5)
        $lbLoraHint.ForeColor = [System.Drawing.Color]::Gray
    $lbLoraHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 10 * $script:FmRowH + 25), $script:FmCtlW, 13)
        $form.Controls.Add($lbLoraHint)
    }

    # 9) 模型（只读下拉）：首项显示真实当前模型；第 2 项「一致（照参考图）」= 用参考图自带的模型（PNG 元数据）
    $cboModel = New-Object System.Windows.Forms.ComboBox
    $cboModel.DropDownStyle = 'DropDownList'
    $curModelLabel = '（当前模型）'
    if ($CurrentModel) { $curModelLabel = "（当前模型：$CurrentModel）" }
    $null = $cboModel.Items.Add($curModelLabel)
    $null = $cboModel.Items.Add('一致（照参考图）')
    foreach ($m in $CheckpointList) { $null = $cboModel.Items.Add($m) }
    $cboModel.SelectedIndex = 0
    $cboModel.SetBounds($script:FmCtlX, ($script:FmRowY0 + 11 * $script:FmRowH), $script:FmCtlW, 24)
    $form.Controls.Add($cboModel)
    if ($CheckpointList.Count -eq 0) {
        $lbModelHint = New-Object System.Windows.Forms.Label
        $lbModelHint.Text = '（SD 未运行，拉不到列表）'
        $lbModelHint.Font = New-Object System.Drawing.Font('Microsoft YaHei', 7.5)
        $lbModelHint.ForeColor = [System.Drawing.Color]::Gray
    $lbModelHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 11 * $script:FmRowH + 25), $script:FmCtlW, 13)
        $form.Controls.Add($lbModelHint)
    }

    # 10) 命名（留空 = 按提示词总结命名）
    $txtName = New-Object System.Windows.Forms.TextBox
    $txtName.Text = ''
    $txtName.SetBounds($script:FmCtlX, ($script:FmRowY0 + 12 * $script:FmRowH), $script:FmCtlW, 24)
    $form.Controls.Add($txtName)
    $lbNameHint = New-Object System.Windows.Forms.Label
    $lbNameHint.Text = '（留空 = 自动总结提示词命名）'
    $lbNameHint.Font = New-Object System.Drawing.Font('Microsoft YaHei', 7.5)
    $lbNameHint.ForeColor = [System.Drawing.Color]::Gray
    $lbNameHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 12 * $script:FmRowH + 25), $script:FmCtlW, 13)
    $form.Controls.Add($lbNameHint)

    # 画风联动：切换画风时把该画风的词**幂等**写进两个提示词框（剥旧词 → 加新词，不重复、不留 ",,"）
    $script:injectedStylePos = ""
    $script:injectedStyleNeg = ""
    $cboStyle.Add_SelectedIndexChanged({
        if ($script:injectedStylePos -and $txtPos.Text.Contains($script:injectedStylePos)) {
            $txtPos.Text = Add-TrailingComma (Remove-StyleWords -Text $txtPos.Text -Words $script:injectedStylePos)
        }
        if ($script:injectedStyleNeg -and $txtNeg.Text.Contains($script:injectedStyleNeg)) {
            $txtNeg.Text = Add-TrailingComma (Remove-StyleWords -Text $txtNeg.Text -Words $script:injectedStyleNeg)
        }
        $st = Get-StylePrompt -Style ([string]$cboStyle.SelectedItem)
        $script:injectedStylePos = ""
        $script:injectedStyleNeg = ""
        if ($st.Pos) {
            $script:injectedStylePos = $st.Pos
            $txtPos.Text = Add-TrailingComma (Add-StyleWords -Text $txtPos.Text -Words $st.Pos)
        }
        if ($st.Neg) {
            $script:injectedStyleNeg = $st.Neg
            $txtNeg.Text = Add-TrailingComma (Add-StyleWords -Text $txtNeg.Text -Words $st.Neg)
        }
    })

    # 模式联动：切到「图生图」→ Denoising 默认 **0.65**（用户 2026-10-18 指定；画风保持用户当前档位）；
    #            切回「文生图」→ Denoising 0（不用底图）。
    # 文生图 = 不需要底图与蒙版 → 这两个控件**锁定**（灰掉、不可编辑）；图生图时解锁。
    # 蒙版值在锁定时记下来，切回图生图自动还原（不会因为切一下模式就把对话提交的区域丢掉）。
    # 画风的默认既不改写用户的提示词，也不再被模式切换劫持（用户反馈：默认别塞画风词）。
    $script:maskKept = $cboMask.Text
    $applyModeLock = {
        $isTxt = ([string]$cboMode.SelectedItem -eq '文生图')
        $txtInit.Enabled = -not $isTxt
        $btnInitBrowse.Enabled = -not $isTxt
        $cboMask.Enabled = -not $isTxt
        if ($isTxt) {
            if ($cboMask.Text -and $cboMask.Text -notmatch '^无') { $script:maskKept = $cboMask.Text }
            $cboMask.Text = '无（整图重绘）'
            $cboMask.BackColor = [System.Drawing.Color]::FromArgb(240, 240, 240)
            $lbMaskLockHint.Text = '（文生图：不需要蒙版，已锁定）'
            $lbInitHint.Text = '（文生图：不需要底图，已锁定）'
        } else {
            if ($script:maskKept -and $script:maskKept -notmatch '^无') { $cboMask.Text = $script:maskKept }
            $cboMask.BackColor = [System.Drawing.Color]::White
            $lbMaskLockHint.Text = '（白色=重绘区；可填区域名/box:x,y,w,h/蒙版图路径，或选手动绘制）'
            $lbInitHint.Text = '（留空=最近一张；或填路径）'
        }
    }
    $cboMode.Add_SelectedIndexChanged({
        # 模式一变，Denoising 的合法档位也变（文生图只有 0；图生图才给幅度）→ 让模型锁表重算
        # （$applyModelLock 在后面才定义；用户交互时已定义，包 try 兜底）
        try { if ($applyModelLock) { & $applyModelLock } } catch { }
        try { & $applyModeLock } catch { }
        if ([string]$cboMode.SelectedItem -eq '图生图') {
            if ($cboDenoise.Text -notmatch '^0?\.') { $cboDenoise.Text = '0.65' }
        } else {
            $cboDenoise.Text = '0（文生图·不用底图）'
        }
    })

    # 构造完成先套一次锁定（初始模式可能是对话提交的）
    try { & $applyModeLock } catch { }

    # 坑36（用户实测 2026-10-16）：初始模式由 -Mode 提交时，「图生图」的 Denoising 默认值不生效。
    # 原因：$cboMode.SelectedIndex = 1 是在**挂事件之前**设的，
    # 而设 Denoising 默认值的逻辑写在 Add_SelectedIndexChanged 里 —— 事件没触发就不生效。
    # 后果：用户直接点「确定出图」→ den=0 → 走文生图分支 → 参考图被完全忽略（出图与底图无关）。
    # 修法：构造完后**主动补一次**初始模式对应的默认值（与事件处理器里的规则保持一致）。
    if ([string]$cboMode.SelectedItem -eq '图生图') {
        if ($cboDenoise.Text -notmatch '^0?\.') { $cboDenoise.Text = '0.65' }
    }

    # 对话侧锁定（底图 / 蒙版由对话解析或画好）：初始套一次，切模式后再套一次，
    # 保证 $applyModeLock 不会把它们重新解开（用户只点「确定」，不用碰这两个框）。
    if ($LockBase -or $LockMask) {
        $script:extLockBase = [bool]$LockBase
        $script:extLockMask = [bool]$LockMask
        $applyExternalLock = {
            if ($script:extLockBase) {
                $txtInit.Enabled = $false
                $btnInitBrowse.Enabled = $false
                $txtInit.BackColor = [System.Drawing.Color]::FromArgb(235, 245, 255)
                $lbInitHint.Text = '（对话已解析底图并锁定）'
            }
            # 蒙版**始终可编辑**（用户要求 2026-10-16）：即使对话侧已自动抠好蒙版，也只预填、不锁死。
            # 想手绘就选「手动绘制（鼠标涂抹）」，想换区域选区域名，想整图重绘选「无」。
            if ($false -and $script:extLockMask) { }
        }
        try { & $applyExternalLock } catch { }
        $cboMode.Add_SelectedIndexChanged({ try { & $applyExternalLock } catch { } })
    }

    # 初始档位也要注入一次（SelectedIndex 是在挂事件之前设的，不补这一下默认档就没有词）
    try {
        $st0 = Get-StylePrompt -Style ([string]$cboStyle.SelectedItem)
        if ($st0.Pos) {
            $script:injectedStylePos = $st0.Pos
            $txtPos.Text = Add-TrailingComma (Add-StyleWords -Text $txtPos.Text -Words $st0.Pos)
        }
        if ($st0.Neg) {
            $script:injectedStyleNeg = $st0.Neg
            $txtNeg.Text = Add-TrailingComma (Add-StyleWords -Text $txtNeg.Text -Words $st0.Neg)
        }
    } catch { }

    # 按钮：**只有一个出图按钮**（用户反馈 2026-10-18：原来「提交出图」+「确定出图」两个按钮重复，
    # 不知道该点哪个）。现在这一个按钮既是提交、也是"确定"——它 = AcceptButton：
    #   点击 → 校验参数 → POST /api/generate → 定时器异步轮询 → 出图成功即关表单。
    # （内部变量名保留 $btnSubmit，与 P5 要求一致：$form.AcceptButton = $btnSubmit）
    $btnSubmit = New-Object System.Windows.Forms.Button
    $btnSubmit.Text = '确定出图（走网关）'
    $btnSubmit.Name = 'btnSubmit'
    $btnSubmit.AccessibleName = 'btnSubmit'
    $btnSubmit.SetBounds(($script:FmCtlX - 150), ($script:FmRowY0 + 17 * $script:FmRowH + 94), 180, 34)
    $form.Controls.Add($btnSubmit)

    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = '取消'
    $btnCancel.Name = 'btnCancel'
    $btnCancel.AccessibleName = 'btnCancel'
    $btnCancel.SetBounds(($script:FmCtlX - 150 + 190), ($script:FmRowY0 + 17 * $script:FmRowH + 94), 180, 34)
    $form.Controls.Add($btnCancel)

    # 兼容：旧名 $btnOk 指向同一个按钮（老代码/自动化脚本里可能还按 btnOk 找）
    $btnOk = $btnSubmit
    $script:btnOkAlias = $btnSubmit

    # =====================================================================
    # P5（2026-10-18）：宽度/高度 + 网关异步提交 + 状态栏 + Timer 轮询
    #   用户点「提交出图（网关）」→ POST /api/generate 立刻拿到 Task_ID（TimeoutSec 2）
    #   → System.Windows.Forms.Timer(Interval=2000) 轮询 /api/status/{id}
    #   → $lblStatus 按状态上色（queued黄/training橙/running蓝/success绿/failed红）
    #   → 连续 3 次 catch 停表 + 显示「与网关断开连接」
    #   → 任务结束或 FormClosing 时 $timer.Stop() + $timer.Dispose()
    #   整个表单**绝不假死**：所有网络请求都在 2 秒超时内 try-catch 返回。
    # =====================================================================
    $lbGwSize = New-Object System.Windows.Forms.Label
    $lbGwSize.Text = '宽×高（网关）：'
    $lbGwSize.SetBounds($script:FmLabelX, ($script:FmRowY0 + 13 * $script:FmRowH), 108, 22)
    $form.Controls.Add($lbGwSize)

    $sizeDefault = Get-SizeFor -Ratio ([string]$cboRatio.SelectedItem) -Quality ([string]$cboQuality.SelectedItem)
    if ($GwWidthDefault -gt 0 -and $GwHeightDefault -gt 0) { $sizeDefault = @{ W = $GwWidthDefault; H = $GwHeightDefault } }
    $txtGwWidth = New-Object System.Windows.Forms.TextBox
    $txtGwWidth.Name = 'txtGwWidth'
    $txtGwWidth.Text = "$($sizeDefault.W)"
    $txtGwWidth.SetBounds($script:FmCtlX, ($script:FmRowY0 + 13 * $script:FmRowH - 3), 80, 24)
    $form.Controls.Add($txtGwWidth)

    $lbGwX = New-Object System.Windows.Forms.Label
    $lbGwX.Text = '×'
    $lbGwX.SetBounds(($script:FmCtlX + 86), ($script:FmRowY0 + 13 * $script:FmRowH), 14, 22)
    $form.Controls.Add($lbGwX)

    $txtGwHeight = New-Object System.Windows.Forms.TextBox
    $txtGwHeight.Name = 'txtGwHeight'
    $txtGwHeight.Text = "$($sizeDefault.H)"
    $txtGwHeight.SetBounds(($script:FmCtlX + 104), ($script:FmRowY0 + 13 * $script:FmRowH - 3), 80, 24)
    $form.Controls.Add($txtGwHeight)

    $lbGwSizeHint = New-Object System.Windows.Forms.Label
    $lbGwSizeHint.Text = '（8 的倍数；Krea2_Q4 不得超过 1024）'
    $lbGwSizeHint.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 7)
    $lbGwSizeHint.ForeColor = [System.Drawing.Color]::Gray
    $lbGwSizeHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 13 * $script:FmRowH + 25), $script:FmCtlW, 13)
    $form.Controls.Add($lbGwSizeHint)

    # =====================================================================
    # 加字行（2026-10-20 用户要求）：成品出来之后，由**另一档模型**把这段字写上去。
    #   根因：以前加字只能靠对话传 -AddText，表单里根本没地方填 —— 对话漏传就永远没有字。
    #   现在表单里能直接填（预填 = -AddText），档位默认「自动（换另一档）」。
    # =====================================================================
    $lbAddText = New-Object System.Windows.Forms.Label
    $lbAddText.Text = '加字：'
    $lbAddText.SetBounds($script:FmLabelX, ($script:FmRowY0 + 14 * $script:FmRowH), 108, 22)
    $form.Controls.Add($lbAddText)

    $txtAddText = New-Object System.Windows.Forms.TextBox
    $txtAddText.Name = 'txtAddText'
    $txtAddText.AccessibleName = 'txtAddText'
    $txtAddText.Text = "$AddTextDefault"
    $txtAddText.SetBounds($script:FmCtlX, ($script:FmRowY0 + 14 * $script:FmRowH), 180, 24)
    $form.Controls.Add($txtAddText)

    $cboAddTextModel = New-Object System.Windows.Forms.ComboBox
    $cboAddTextModel.DropDownStyle = 'DropDownList'
    $cboAddTextModel.Name = 'cboAddTextModel'
    $cboAddTextModel.AccessibleName = 'cboAddTextModel'
    foreach ($am in (@('自动（换另一档）') + @($script:GatewayModels))) { $null = $cboAddTextModel.Items.Add($am) }
    $cboAddTextModel.SelectedIndex = 0
    if ("$AddTextModelDefault" -and ($cboAddTextModel.Items -contains "$AddTextModelDefault")) {
        $cboAddTextModel.SelectedItem = "$AddTextModelDefault"
    }
    $cboAddTextModel.SetBounds(($script:FmCtlX + 186), ($script:FmRowY0 + 14 * $script:FmRowH), 106, 24)
    $form.Controls.Add($cboAddTextModel)

    $lbAddTextHint = New-Object System.Windows.Forms.Label
    $lbAddTextHint.Text = '（留空=不加字；加字固定换成与生图不同的另一档，中文+英文一起写准的是 Krea2）'
    $lbAddTextHint.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 7)
    $lbAddTextHint.ForeColor = [System.Drawing.Color]::Gray
    $lbAddTextHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 14 * $script:FmRowH + 25), $script:FmCtlW, 13)
    $form.Controls.Add($lbAddTextHint)

    # =====================================================================
    # 加字位置行（用户要求 2026-10-21）：文字位置可以自由决定
    #   · 对话里有加字要求 → 开始时随机挑一格加字 → 表单弹出后**自动打开选位器**（右侧缩略图）
    #   · 用户也可以随时点「缩略图选位置…」自己定：九宫格 / 在缩略图上随便点（自由点）
    #   · 这里显示的规格（随机 / 右下 / 自由点 0.62,0.2）会原样传给加字那一步
    # =====================================================================
    $lbAddTextPos = New-Object System.Windows.Forms.Label
    $lbAddTextPos.Text = '加字位置：'
    $lbAddTextPos.SetBounds($script:FmLabelX, ($script:FmRowY0 + 15 * $script:FmRowH), 108, 22)
    $form.Controls.Add($lbAddTextPos)

    $txtAddTextPos = New-Object System.Windows.Forms.TextBox
    $txtAddTextPos.Name = 'txtAddTextPos'
    $txtAddTextPos.AccessibleName = 'txtAddTextPos'
    $txtAddTextPos.Text = "$AddTextPosDefault"
    $txtAddTextPos.SetBounds($script:FmCtlX, ($script:FmRowY0 + 15 * $script:FmRowH), 180, 24)
    $form.Controls.Add($txtAddTextPos)

    $btnPickPos = New-Object System.Windows.Forms.Button
    $btnPickPos.Text = '缩略图选位置…'
    $btnPickPos.Name = 'btnPickTextPos'
    $btnPickPos.AccessibleName = 'btnPickTextPos'
    $btnPickPos.SetBounds(($script:FmCtlX + 186), ($script:FmRowY0 + 15 * $script:FmRowH), 106, 24)
    $btnPickPos.Add_Click({
        try {
            $imgForPick = "$PreGenImagePath"
            if (-not $imgForPick -and $script:GatewayPaths -and @($script:GatewayPaths).Count -gt 0) { $imgForPick = [string]@($script:GatewayPaths)[0] }
            if (-not $imgForPick -or -not (Test-Path -LiteralPath $imgForPick)) { $imgForPick = '' }
            $r = Show-TextPosPicker -ImagePath $imgForPick -Text $txtAddText.Text.Trim() -Current $txtAddTextPos.Text -Size "$($cboAddTextSize.SelectedItem)" -Style "$($cboAddTextStyle.SelectedItem)"
            if ($r) {
                if ($r -is [hashtable]) {
                    $txtAddTextPos.Text = "$($r.Pos)"
                    if ("$($r.Size)" -and ($cboAddTextSize.Items -contains "$($r.Size)")) { $cboAddTextSize.SelectedItem = "$($r.Size)" }
                    if ("$($r.Style)" -and ($cboAddTextStyle.Items -contains "$($r.Style)")) { $cboAddTextStyle.SelectedItem = "$($r.Style)" }
                    Write-Host ("加字：位置={0}　字号={1}　风格={2}" -f (Format-AddTextPosLabel -Spec "$($r.Pos)"), "$($r.Size)", "$($r.Style)") -ForegroundColor Cyan
                } else {
                    $txtAddTextPos.Text = "$r"
                    Write-Host ("加字位置已选：{0}" -f (Format-AddTextPosLabel -Spec "$r")) -ForegroundColor Cyan
                }
            }
        } catch {
            [System.Windows.Forms.MessageBox]::Show(("选位器异常：" + $_.Exception.Message), '加字位置', 'OK', 'Warning') | Out-Null
        }
    })
    $form.Controls.Add($btnPickPos)

    $lbAddTextPosHint = New-Object System.Windows.Forms.Label
    $lbAddTextPosHint.Text = '（随机 / 左上…右下 / 自由点 x,y（0-1）；点右边按钮在缩略图上随便点）'
    $lbAddTextPosHint.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 7)
    $lbAddTextPosHint.ForeColor = [System.Drawing.Color]::Gray
    $lbAddTextPosHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 15 * $script:FmRowH + 25), $script:FmCtlW, 13)
    $form.Controls.Add($lbAddTextPosHint)

    # 字号 / 字体风格行（用户要求 2026-10-21：字号和字体风格也要能选）
    $lbAddTextSize = New-Object System.Windows.Forms.Label
    $lbAddTextSize.Text = '字号/风格：'
    $lbAddTextSize.SetBounds($script:FmLabelX, ($script:FmRowY0 + 16 * $script:FmRowH), 108, 22)
    $form.Controls.Add($lbAddTextSize)

    $cboAddTextSize = New-Object System.Windows.Forms.ComboBox
    $cboAddTextSize.DropDownStyle = 'DropDownList'
    $cboAddTextSize.Name = 'cboAddTextSize'
    $cboAddTextSize.AccessibleName = 'cboAddTextSize'
    foreach ($sk in $script:AddTextSizeKeys) { $null = $cboAddTextSize.Items.Add($sk) }
    $cboAddTextSize.SelectedItem = (Resolve-AddTextSize -Spec "$AddTextSizeDefault")
    $cboAddTextSize.SetBounds($script:FmCtlX, ($script:FmRowY0 + 16 * $script:FmRowH), 80, 24)
    $form.Controls.Add($cboAddTextSize)

    $cboAddTextStyle = New-Object System.Windows.Forms.ComboBox
    $cboAddTextStyle.DropDownStyle = 'DropDownList'
    $cboAddTextStyle.Name = 'cboAddTextStyle'
    $cboAddTextStyle.AccessibleName = 'cboAddTextStyle'
    foreach ($tk in $script:AddTextStyleKeys) { $null = $cboAddTextStyle.Items.Add($tk) }
    $cboAddTextStyle.SelectedItem = (Resolve-AddTextStyle -Spec "$AddTextStyleDefault")
    $cboAddTextStyle.SetBounds(($script:FmCtlX + 86), ($script:FmRowY0 + 16 * $script:FmRowH), 206, 24)
    $form.Controls.Add($cboAddTextStyle)

    $lbAddTextSizeHint = New-Object System.Windows.Forms.Label
    $lbAddTextSizeHint.Text = '（字号：小/中/大/特大；风格：粗体无衬线…中文书法；改了会从原图重加一遍字）'
    $lbAddTextSizeHint.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 7)
    $lbAddTextSizeHint.ForeColor = [System.Drawing.Color]::Gray
    $lbAddTextSizeHint.SetBounds($script:FmCtlX, ($script:FmRowY0 + 16 * $script:FmRowH + 25), $script:FmCtlW, 13)
    $form.Controls.Add($lbAddTextSizeHint)

    # 比例/画质联动 → 自动回填宽高（用户改档位时不用手算）。
    # 注意（坑63 实测 2026-10-18）：不再用「用户改过就不再同步」的守卫——
    # WinForms 在这个宿主下会在初始化时就把 TextChanged 触发一次，守卫一旦置位，
    # 之后改画质/比例都不会再回填（UI 自动化测试里表现为「尺寸永远停在 264x480」）。
    # 现在档位永远是"最后说话的人"：改比例/画质一定重算并覆盖宽高（手填尺寸请在改档位之后再填）。
    $syncGwSize = {
        if ($script:paramLockBusy) { return }   # 锁表重填期间不响应，避免读到半截 Items
        try {
            $s = Get-SizeFor -Ratio ([string]$cboRatio.SelectedItem) -Quality ([string]$cboQuality.SelectedItem)
            $txtGwWidth.Text = "$($s.W)"
            $txtGwHeight.Text = "$($s.H)"
        } catch { }
    }
    $cboRatio.Add_SelectedIndexChanged({ & $syncGwSize })
    $cboQuality.Add_SelectedIndexChanged({ & $syncGwSize })

    # =====================================================================
    # 模型约束锁（用户要求 2026-10-19）
    #   选中某一档后，下方「这一档真的出不了图」的选项直接从下拉里消失 ——
    #   把"选错参数"从"提交后弹错"前移到"下拉里根本选不到"。
    #   · 所有档：短边 < 512 的画质档锁掉（264x480 / 360x640 这类必糊尺寸不再出现）
    #   · Krea2_Q4：长边 ≤1024 → 1280p/1440p/2160p（以及 21:9 等超宽比例）锁掉
    #   · SD_FP16 / Anima_INT8 / QwenImage_NVFP4：长边上限 1536
    #   · 未就绪（no-model / offline）**绝不锁模型本身** —— 4 档永远都能选；
    #     点「确定出图」时先自动加载引擎、重新探测，缺的只是权重才提示。
    # =====================================================================
    $allQualityTiers = @($cboQuality.Items | ForEach-Object { [string]$_ })
    $allRatioTiers = @($cboRatio.Items | ForEach-Object { [string]$_ })
    $script:paramLockBusy = $false

    $applyModelLock = {
        if ($script:paramLockBusy) { return }
        $script:paramLockBusy = $true
        try {
            $mk = 'SD_FP16'
            if ($cboBackend -and $cboBackend.SelectedItem) { $mk = [string]$cboBackend.SelectedItem.Key }
            $maxSide = Get-ModelMaxSide -Model $mk

            $curR = [string]$cboRatio.SelectedItem
            if (-not $curR) { $curR = '9:16' }
            $curQ = [string]$cboQuality.SelectedItem
            if (-not $curQ) { $curQ = '1024p' }

            # 1) 先筛比例：只要该比例在**任一**画质档下合法就保留
            #    （21:9 在 Krea2 下只剩 1024p 可用，但 21:9 本身不该从下拉里消失）
            $allowedR = @(Get-AllowedRatios -Model $mk -AllRatios $allRatioTiers -AllTiers $allQualityTiers)
            if ($allowedR.Count -eq 0) { $allowedR = @("1:1") }   # 兜底：绝不让下拉空掉
            $cboRatio.Items.Clear()
            foreach ($t in $allowedR) { $null = $cboRatio.Items.Add($t) }
            $pickR = if ($allowedR -contains $curR) { $curR } else { $allowedR[0] }
            $cboRatio.SelectedItem = $pickR

            # 2) 再筛画质：短边 <512 或长边 >maxSide 的档从这里直接消失
            $q = Get-AllowedQualityTiers -Model $mk -Ratio $pickR -AllTiers $allQualityTiers
            $allowedQ = @($q.Allowed)
            if ($allowedQ.Count -eq 0) { $allowedQ = @("1024p") }   # 理论不会发生（比例已先验过）
            $cboQuality.Items.Clear()
            foreach ($t in $allowedQ) { $null = $cboQuality.Items.Add($t) }
            $pickQ = if ($allowedQ -contains $curQ) { $curQ } else { $allowedQ[0] }
            $cboQuality.SelectedItem = $pickQ

            # 2.5) Denoising 档位：文生图只留「0」；图生图按引擎给合法幅度
            $curMode = [string]$cboMode.SelectedItem
            if (-not $curMode) { $curMode = "文生图" }
            $curDen = [string]$cboDenoise.Text
            $denTiers = @(Get-AllowedDenoiseTiers -Model $mk -Mode $curMode)
            $cboDenoise.Items.Clear()
            foreach ($t in $denTiers) { $null = $cboDenoise.Items.Add($t) }
            if ($denTiers -contains $curDen) { $cboDenoise.Text = $curDen } else { $cboDenoise.Text = $denTiers[0] }
            # 3) 宽高回填（档位即真相，手填仍可在改完档位之后再改）
            $s = Get-SizeFor -Ratio $pickR -Quality $pickQ
            # 例外（2026-10-20）：表单**首次**弹出且命令行给了 -Width/-Height 时，用那个尺寸 ——
            #   它是 C 档命令指定的尺寸（本机长边上限 1024，超了就等比收进来，绝不用会报错的尺寸）。
            #   之后用户改比例/画质/换模型，仍是「档位最后说话」（坑63 不受影响）。
            $keepW = 0; $keepH = 0
            if ($script:keepCliSizeOnce -and $GwWidthDefault -gt 0 -and $GwHeightDefault -gt 0) {
                $script:keepCliSizeOnce = $false
                $keepW = [int]$GwWidthDefault; $keepH = [int]$GwHeightDefault
                $mx0 = [Math]::Max($keepW, $keepH)
                if ($mx0 -gt $maxSide) {
                    $k0 = [double]$maxSide / $mx0
                    $keepW = [int]([Math]::Floor(($keepW * $k0) / 8) * 8)
                    $keepH = [int]([Math]::Floor(($keepH * $k0) / 8) * 8)
                }
                $mn0 = [Math]::Min($keepW, $keepH)
                if ($mn0 -lt 512) {
                    $f0 = 512.0 / $mn0
                    $keepW = [int]([Math]::Floor(($keepW * $f0) / 8) * 8)
                    $keepH = [int]([Math]::Floor(($keepH * $f0) / 8) * 8)
                    if ([Math]::Max($keepW, $keepH) -gt $maxSide) { $keepW = 0; $keepH = 0 }
                }
            }
            if ($keepW -gt 0 -and $keepH -gt 0) {
                $txtGwWidth.Text = "$keepW"
                $txtGwHeight.Text = "$keepH"
            } else {
                $txtGwWidth.Text = "$($s.W)"
                $txtGwHeight.Text = "$($s.H)"
            }

            # 4) Denoising 语义提示：ComfyUI 两档不吃 A1111 的 0.55/0.65 习惯
            $isComfy = ((Get-ModelEngineFor -Model $mk) -eq 'comfy')
            $lbDenoiseHint.Text = if ($isComfy) {
                '（ComfyUI 档：文生图恒 1.0；图生图建议 0.55-0.75）'
            } else {
                '（图生图默认 0.65；0.4-0.5 更贴底图；≥0.7 大改）'
            }

            # 5) 提示：本档锁了什么 / 未就绪也能选
            $rejQ = @($q.Rejected | ForEach-Object { "$($_.Tier)（$($_.Why)）" })
            $lockNote = if ($rejQ.Count -gt 0) { "已锁画质：" + ($rejQ -join "、") } else { "本档全部画质可用" }
            $st = ""
            try { if ($ModelStatus -and $ModelStatus.ContainsKey($mk)) { $st = [string]$ModelStatus[$mk] } } catch { }
            # 缺什么 / 哪档能用：从网关探测结果里取，供红字提示直接说人话
            $missingOfModel = @()
            try { if ($ModelMissing -and $ModelMissing.ContainsKey($mk)) { $missingOfModel = @($ModelMissing[$mk]) } } catch { }
            $readyModels = @()
            foreach ($k4 in $script:GatewayModels) {
                $s4 = ""
                try { if ($ModelStatus -and $ModelStatus.ContainsKey($k4)) { $s4 = [string]$ModelStatus[$k4] } } catch { }
                if ($s4 -eq "ok") { $readyModels += $k4 }
            }
            if ($st -eq "no-model") {
                # 缺权重：拉起引擎也没用 → 直接说缺什么、哪档能用（不让用户白等 240s）
                $missTxt = if ($missingOfModel.Count -gt 0) { $missingOfModel -join ", " } else { "权重文件未就位" }
                $readyTxt = if ($readyModels.Count -gt 0) { $readyModels -join " / " } else { "（暂无）" }
                $lbGwSizeHint.Text = "（本档缺权重：$missTxt ｜ 现在能用：$readyTxt）"
                $lbGwSizeHint.ForeColor = [System.Drawing.Color]::FromArgb(178, 34, 34)
            } elseif ($st -and $st -ne "ok" -and $st -ne "unknown") {
                # 引擎离线：点确定会自动拉起 → 这属于提示，不是错误（深橙）
                $lbGwSizeHint.Text = "（引擎未启动 · 点「确定出图」会自动拉起并加载，约 30-60s）"
                $lbGwSizeHint.ForeColor = [System.Drawing.Color]::FromArgb(178, 96, 0)
            } else {
                $lbGwSizeHint.Text = "（$lockNote ｜ 长边上限 $maxSide，短边下限 512）"
                $lbGwSizeHint.ForeColor = [System.Drawing.Color]::Gray
            }
        } catch {
            # 锁表异常绝不影响用户操作：吞掉，下拉保持原样
        } finally {
            $script:paramLockBusy = $false
        }
    }
    # 初始档位也套一次（SelectedIndex 是在挂事件之前设的）
    # 2026-10-20：这一次允许「命令行 -Width/-Height 优先」——C 档命令指定的尺寸
    # （1216x1536 / 768x1024）不该被默认档位(9:16+1024p=576x1024)改小；超出本档长边上限时等比收进来。
    $script:keepCliSizeOnce = $true
    try { & $applyModelLock } catch { }

    $lblStatus = New-Object System.Windows.Forms.Label
    $lblStatus.Name = 'lblStatus'
    $lblStatus.AccessibleName = 'lblStatus'
    $lblStatus.Text = '就绪（未提交）'
    $lblStatus.SetBounds($script:FmCtlX, ($script:FmRowY0 + 17 * $script:FmRowH + 44), $script:FmCtlW, 24)
    $lblStatus.Font = New-Object System.Drawing.Font('Microsoft YaHei', 9, [System.Drawing.FontStyle]::Bold)
    $form.Controls.Add($lblStatus)

    # C 档新流程：后台预生成已经出了图 → 状态栏一打开就告诉用户在哪儿（绿字），而不是"就绪（未提交）"
    if ("$PreGenPath") {
        try {
            $lblStatus.Text = "已后台生成：" + (Split-Path $PreGenPath -Leaf)
            $c = Get-GatewayStatusColor -Status 'success'
            if ($c) { $lblStatus.ForeColor = $c }
        } catch { }
    }

    # 表单内出图进度条（用户要求 2026-10-19）：显示引擎真实/估算百分比
    $pbGen = New-Object System.Windows.Forms.ProgressBar
    $pbGen.Name = 'pbGen'
    $pbGen.AccessibleName = 'pbGen'
    $pbGen.Minimum = 0
    $pbGen.Maximum = 100
    $pbGen.Value = 0
    $pbGen.SetBounds($script:FmCtlX, ($script:FmRowY0 + 17 * $script:FmRowH + 72), $script:FmCtlW, 14)
    $form.Controls.Add($pbGen)

    # 「加载中」可见态（用户要求 2026-10-19）：点确定后若需要拉起引擎/载入权重，
    # 进度条切成跑马灯 + 状态栏写「加载中」，并 DoEvents 让这一帧真的画出来 ——
    # 否则 240s 的 ensure 会让窗口看起来假死（用户以为没反应又点一次）。
    $script:pbIdleStyle = 1   # 1 = Blocks（正常百分比）
    $enterLoading = {
        param([string]$Text = '加载中…')
        try {
            $pbGen.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
            $pbGen.MarqueeAnimationSpeed = 30
            $script:pbIdleStyle = 2
            $lblStatus.Text = $Text
            $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(30, 144, 255)
            $btnSubmit.Enabled = $false
            $cboBackend.Enabled = $false
            [System.Windows.Forms.Application]::DoEvents()
        } catch { }
    }
    $exitLoading = {
        try {
            $pbGen.Style = [System.Windows.Forms.ProgressBarStyle]::Blocks
            $pbGen.MarqueeAnimationSpeed = 0
            $script:pbIdleStyle = 1
            $btnSubmit.Enabled = $true
            $cboBackend.Enabled = $true
            [System.Windows.Forms.Application]::DoEvents()
        } catch { }
    }

    # 状态机轮询定时器（Interval = 2000ms，硬要求）
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 2000
    $script:gatewayPollFails = 0
    $script:gatewayPhase = 'idle'    # idle / running / done

    $setStatusLabel = {
        param([string]$Status, [string]$Extra = '')
        try {
            $color = Get-GatewayStatusColor -Status $Status
            $lblStatus.Text = (Get-GatewayStatusText -Status $Status)
            if ($Extra) { $lblStatus.Text = "$($lblStatus.Text) · $Extra" }
            if ($color) { $lblStatus.ForeColor = $color }
        } catch { }
    }

    $stopTimer = {
        try {
            if ($timer) { $timer.Stop(); $timer.Dispose() }
        } catch { }
    }

    # 表单里的「模型」下拉若与网关枚举冲突（用户手填过 checkpoint），以网关枚举为准做一次提示
    $btnSubmit.Add_Click({
        try {
            # 1) 宽高：必须是整数（[int]::TryParse，硬要求）
            $w = 0; $h = 0
            if (-not [int]::TryParse($txtGwWidth.Text.Trim(), [ref]$w) -or -not [int]::TryParse($txtGwHeight.Text.Trim(), [ref]$h)) {
                [System.Windows.Forms.MessageBox]::Show('宽/高必须是整数（例如 1216 与 1536）。', '参数错误', 'OK', 'Warning') | Out-Null
                return
            }
            # 2) 8 的倍数（SD 潜空间要求）
            if (($w % 8) -ne 0 -or ($h % 8) -ne 0) {
                [System.Windows.Forms.MessageBox]::Show("宽高必须是 8 的倍数，当前 $w x $h（建议 1216 x 1536 或 1024 x 1536）。", '参数错误', 'OK', 'Warning') | Out-Null
                return
            }
            # 3) 模型枚举 + Krea2_Q4 尺寸硬闸（超过 1024 弹窗报错并 return）
            $modelKey = 'SD_FP16'
            if ($cboBackend -and $cboBackend.SelectedItem) { $modelKey = [string]$cboBackend.SelectedItem.Key }
            $guard = Test-GatewayModelSize -Model $modelKey -Width $w -Height $h
            if (-not $guard.Ok) {
                [System.Windows.Forms.MessageBox]::Show($guard.Message, '尺寸超限', 'OK', 'Error') | Out-Null
                return
            }
            # 4) 网关在线检查（没开就自动拉起）
            if (-not (Start-GatewayIfNeeded -WaitSec 30)) {
                & $setStatusLabel 'disconnected'
                [System.Windows.Forms.MessageBox]::Show("网关不可用（$((Get-GatewayBase))）。请先运行 gateway\index.js，或去掉 -NoGatewayAutoStart。", '网关离线', 'OK', 'Error') | Out-Null
                return
            }

            # 4.5) 该档"未就绪"也**不拦提交**：先把引擎拉起来、重新探测一次（用户要求 2026-10-19）
            #      —— 4 档永远可选，点下去之后由这里负责"让它能用"。
            #      · 引擎离线 → POST /api/engines/{engine}/ensure（网关按需拉起，SD ~30s / Comfy ~40s）
            #      · 引擎已在线但缺权重 → 明确告诉缺哪个文件 + 怎么补，不是含糊的"失败"
            $engineForModel = Get-ModelEngineFor -Model $modelKey
            $stBefore = ''
            try { if ($ModelStatus -and $ModelStatus.ContainsKey($modelKey)) { $stBefore = [string]$ModelStatus[$modelKey] } } catch { }
            $isNoModel = ($stBefore -eq "no-model")
            if ($isNoModel) {
                # 缺权重：拉起引擎也不会让它变可用 → 不白等 240s，直接给结论（2026-10-19）
                & $exitLoading
                $miss2 = ""
                try { if ($ModelMissing -and $ModelMissing.ContainsKey($modelKey)) { $miss2 = (@($ModelMissing[$modelKey]) -join ", ") } } catch { }
                $okList = @()
                foreach ($k9 in $script:GatewayModels) { try { if ($ModelStatus[$k9] -eq "ok") { $okList += $k9 } } catch { } }
                $msg2 = "模型 $modelKey 的权重还没下载，无法出图。`n`n缺少：$miss2`n`n可以立刻改用：" + (($okList -join " / ")) + "`n`n说明：Krea2 需要 unet\krea2_q4.safetensors **且** text_encoders 里的 Qwen3-VL-4B 编码器（现在是 8B，配不上）。"
                & $setStatusLabel "failed" "缺权重：$miss2"
                [System.Windows.Forms.MessageBox]::Show($msg2, "模型权重未就绪", "OK", "Warning") | Out-Null
                return
            }
            if ($stBefore -ne "ok") {
                & $enterLoading "加载中 · $modelKey"
                Write-Host ("[加载] $modelKey 当前状态=$stBefore → 拉起引擎 $engineForModel 并重新探测…") -ForegroundColor DarkYellow
                $ens = Invoke-GatewayEnsureEngine -Engine $engineForModel -TimeoutSec 240 -OnTick { param($sec, $msg)
                    try { $lblStatus.Text = "加载中 · $modelKey · 已等待 ${sec}s"; $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(30,144,255) } catch { }
                    [System.Windows.Forms.Application]::DoEvents()
                }
                if (-not $ens.Ok) {
                    & $exitLoading
                    $msg = "引擎 $engineForModel 起不来：$($ens.Message)`n`n" +
                           "手动排查：起 $engineForModel 的启动日志（网关目录 .dsh-gateway\logs\engine-$engineForModel.launch.log）。"
                    & $setStatusLabel 'failed' "引擎 $engineForModel 未就绪"
                    [System.Windows.Forms.MessageBox]::Show($msg, '模型无法加载', 'OK', 'Error') | Out-Null
                    return
                }
                # 重新探测（带 refresh=1，绕过网关 15s 探测缓存）
                $reProbe = $null
                try {
                    $m2 = Invoke-RestMethod -Uri "$(Get-GatewayBase)/api/models?refresh=1" -Method Get -TimeoutSec 20
                    foreach ($it in @($m2.models)) {
                        $k2 = [string]$it.key
                        if (-not $k2) { continue }
                        $ModelStatus[$k2] = [string]$it.status
                        if ($k2 -eq $modelKey) { $reProbe = $it }
                    }
                } catch { }
                $stAfter = if ($reProbe) { [string]$reProbe.status } else { '' }
                if ($stAfter -ne 'ok') {
                    & $exitLoading
                    $miss = ''
                    try { if ($reProbe -and $reProbe.missing) { $miss = (@($reProbe.missing) -join ', ') } } catch { }
                    $detail = if ($reProbe) { [string]$reProbe.detail } else { '' }
                    $msg = "模型 $modelKey 的引擎已就绪，但权重还不全，无法出图。`n`n" +
                           "缺少：$miss`n$detail`n`n" +
                           "补齐方式（二选一）：`n" +
                           "  1) 把对应权重文件放到 ComfyUI 的 models\unet / models\text_encoders / models\vae 下；`n" +
                           "  2) 直接换用已就绪的档位（本机 QwenImage_NVFP4 现在可用）。"
                    & $setStatusLabel 'failed' "缺权重：$miss"
                    [System.Windows.Forms.MessageBox]::Show($msg, '模型权重不全', 'OK', 'Error') | Out-Null
                    return
                }
                # 探测通过 → 刷新下拉标签（去掉"未就绪"后缀），让用户看到状态确实变了
                try {
                    foreach ($it in @($backendItems)) {
                        $k3 = [string]$it.Key
                        if ($ModelStatus -and $ModelStatus.ContainsKey($k3) -and $ModelStatus[$k3] -eq 'ok' -and "$($it.Text)" -match '（') {
                            $it.Text = [string]$script:GatewayModelLabels[$k3]
                        }
                    }
                    $cboBackend.Refresh()
                } catch { }
                Write-Host ("[加载] $modelKey 已就绪，开始出图") -ForegroundColor Green
            }
            & $exitLoading   # 模型已可用 → 交还给正常出图态（下面提交后切成真实百分比）

            # 5) 参数汇总 → POST /api/generate
            $den = 0.0
            $denMatch = [regex]::Match(($cboDenoise.Text -replace ',', '.').Trim(), '^[0-9]*\.?[0-9]+')
            if ($denMatch.Success) { $null = [double]::TryParse($denMatch.Value, [ref]$den) }
            $initForGw = $txtInit.Text.Trim()
            if ($initForGw -eq '最近') { $initForGw = '' }
            $maskForGw = ''
            if ([string]$cboMode.SelectedItem -eq '图生图' -and $cboMask.Text -and $cboMask.Text -match '\.(png|jpg|jpeg|webp|bmp)$') {
                $maskForGw = $cboMask.Text.Trim()
            }
            # 提交即留痕（诊断/自证用）：明确打出"这次到底提交了什么"，含两个提示词框的**原文**
            Write-Host ("[表单提交] 模型={0} 尺寸={1}x{2} denoise={3} 底图={4} 蒙版={5}" -f $modelKey, $w, $h, $den, $(if ($initForGw) { $initForGw } else { '（无）' }), $(if ($maskForGw) { $maskForGw } else { '（无）' })) -ForegroundColor Cyan
            Write-Host ("[表单提交] 正向：{0}" -f $txtPos.Text) -ForegroundColor DarkGray
            Write-Host ("[表单提交] 负向：{0}" -f $txtNeg.Text) -ForegroundColor DarkGray

            # 加速（2026-10-21）：参数与预生成时**一模一样** → 直接复用预生成成品（省一次出图 + 一次加字）
            if (-not $NoReusePreGen -and "$PreGenPath" -and (Test-Path -LiteralPath "$PreGenPath") -and $script:FmPrefillSig) {
                $sigNow = (& $script:FmGetSig)
                if ($sigNow -and $sigNow -eq $script:FmPrefillSig) {
                    Write-Host "[复用] 参数与预生成完全一致 → 直接采用预生成成品（省一次出图+加字）" -ForegroundColor Cyan
                    Write-Host ("[复用] " + $PreGenPath) -ForegroundColor DarkGray
                    $script:GatewayPaths = @($PreGenPath)
                    $script:GatewayTaskId = ''
                    $script:GatewayLastError = ''
                    & $setStatusLabel 'success' '已复用预生成成品（参数未改）'
                    try { if ($timer) { $timer.Stop(); $timer.Dispose() } } catch { }
                    $form.DialogResult = 'OK'
                    $form.Close()
                    return
                } else {
                    # 参数变了（正常出图）——把**具体哪一项变了**打出来，用户/排障一眼可见
                    if (-not $sigNow) { Write-Host "[复用] 指纹读取失败 → 按正常出图" -ForegroundColor Yellow }
                    else {
                        $a0 = "$script:FmPrefillSig" -split '\|'
                        $b0 = "$sigNow" -split '\|'
                        $diff0 = @()
                        for ($ii = 0; $ii -lt [Math]::Min($a0.Count, $b0.Count); $ii++) { if ($a0[$ii] -ne $b0[$ii]) { $diff0 += ("#$ii 预生成=[$($a0[$ii])] 现在=[$($b0[$ii])]") } }
                        Write-Host ("[复用] 参数有改动 → 正常出图（" + ($diff0 -join '；') + "）") -ForegroundColor DarkGray
                    }
                }
            }

            # LoRA 拼接（2026-10-27 修「C 档指定不了 LoRA」）：
            #   表单内提交网关时，LoRA 下拉框的值必须拼进提示词；下拉没选时从正向框模糊索引（角色中文名→LoRA）。
            #   DiT 档**不切档**（用户要求「所有模型通用 LoRA」）—— 网关的跨架构搬运（bridge）会
            #   自动做 Stage1 SD_FP16+LoRA → Stage2 DiT img2img，优先适配 ComfyUI。
            $effLora = Get-EffectiveLoraSpec -Explicit $cboLora.Text.Trim() -Prompt ("$($txtPos.Text) $($txtName.Text)") -LoraList $LoraList
            if ($effLora -and $effLora -ne $cboLora.Text.Trim()) {
                Write-Host "[表单提交] LoRA 未选 → 从正向/命名 模糊索引命中「$effLora」" -ForegroundColor Cyan
            }
            # -OutDir 必须传给网关（2026-10-27 修「表单出图了但找不到图」）：
            #   不传时网关落自己的默认 outDir（dsh-unrestricted-printing\SD-Picture + 随机名），
            #   用户在 -OutDir 指定的目录里就永远看不到成品。
            #   优先落迭代临时目录 → 主流程再复制成「命名_序号.png」进 OutDir，最终目录只留一份规范名。
            $gwOutForForm = if ($script:IterTempDir) { $script:IterTempDir } else { $OutDir }
            # LoRA 拼接成最终提交的 prompt（这一行必须存在：缺了它 $promptForSubmit 为空 → 网关 400 EMPTY_PROMPT）
            $promptForSubmit = Add-LoraToPrompt -Prompt "$($txtPos.Text)" -LoraSpec "$effLora"
            # 兜底：正向框有内容就绝不提交空 prompt
            if (-not "$promptForSubmit".Trim() -and "$($txtPos.Text)".Trim()) { $promptForSubmit = "$($txtPos.Text)" }
            Write-Host ("[表单提交] 提交 prompt 长度={0}（正向框 {1}，LoRA=[{2}]）" -f "$promptForSubmit".Length, "$($txtPos.Text)".Length, "$effLora") -ForegroundColor DarkGray
            $sub = New-GatewayTask -Model $modelKey -Prompt $promptForSubmit -Negative $txtNeg.Text `
                -Width $w -Height $h -Steps (Get-ModelSteps -Model $modelKey) -Cfg (Get-ModelCfg -Model $modelKey) -Denoise $den `
                -Sampler $(if ($modelKey -in @('SD_FP16', 'Anima_INT8')) { "$Sampler" } else { '' }) `
                -InitImage $initForGw -Mask $maskForGw -Name $txtName.Text.Trim() -OutDir $gwOutForForm `
                -Checkpoint $(if ($modelKey -in @('SD_FP16','Anima_INT8') -and $cboModel.SelectedItem -and "$($cboModel.SelectedItem)" -notlike '（当前模型*' -and "$($cboModel.SelectedItem)" -ne '一致（照参考图）') { [string]$cboModel.SelectedItem } else { '' })
            if (-not $sub.Ok) {
                & $setStatusLabel 'failed' $sub.Message
                [System.Windows.Forms.MessageBox]::Show($sub.Message, '提交失败', 'OK', 'Error') | Out-Null
                return
            }
            $script:GatewayTaskId = $sub.TaskId
            $script:gatewayPollFails = 0
            $script:gatewayPhase = "running"
            # 2026-10-20：提交成功立刻把界面切回"正常百分比"态并强制重绘一次 —— 否则跑马灯
            # 停在 enterLoading 时的样式、进度条不动，用户看到的就是"卡住了"。
            try {
                $pbGen.Style = [System.Windows.Forms.ProgressBarStyle]::Blocks
                $pbGen.MarqueeAnimationSpeed = 0
                $script:pbIdleStyle = 1
                $pbGen.Value = 2
                $cboBackend.Enabled = $true
            } catch { }
            & $setStatusLabel "queued" ("task=" + $sub.TaskId.Substring(0, 8))
            $btnSubmit.Enabled = $false
            $lblStatus.Refresh(); $pbGen.Refresh(); $form.Update()
            $timer.Start()
        } catch {
            try { & $exitLoading } catch { }
            & $setStatusLabel 'failed' "$($_.Exception.Message)"
            [System.Windows.Forms.MessageBox]::Show("提交异常：$($_.Exception.Message)", '异常', 'OK', 'Error') | Out-Null
        }
    })

    $timer.Add_Tick({
        if (-not $script:GatewayTaskId) { & $stopTimer; return }
        # 进度条：优先用网关 /api/progress（引擎真实百分比；拿不到则显示 0 并继续）
        try {
            $pgInfo = Invoke-RestMethod -Uri "$(Get-GatewayBase)/api/progress/$($script:GatewayTaskId)" -Method Get -TimeoutSec 2
            if ($pgInfo -and $null -ne $pgInfo.percent) {
                $pv = [int]$pgInfo.percent
                if ($pv -lt 0) { $pv = 0 }; if ($pv -gt 100) { $pv = 100 }
                # 2026-10-20：只要拿到真实 percent 就写（含 0）。以前只在 >0 时写，
                # ComfyUI 前 8 秒估算恒为 0 → 进度条一直不动，看起来像卡死。
                $pbGen.Value = $pv
                # 状态栏同步带出 stage/百分比，肉眼能看到在动
                $stageTxt = if ($pgInfo.stage) { [string]$pgInfo.stage } else { "running" }
                $etaTxt = if ($null -ne $pgInfo.eta_sec) { " · 预计 $($pgInfo.eta_sec)s" } else { "" }
                $script:lastProgressText = "$stageTxt $pv%$etaTxt"
            }
        } catch { }
        $r = Get-GatewayTask -TaskId $script:GatewayTaskId
        if (-not $r.Ok) {
            $script:gatewayPollFails++
            & $setStatusLabel 'running' "轮询失败 $($script:gatewayPollFails)/3"
            if ($script:gatewayPollFails -ge 3) {
                & $stopTimer
                & $setStatusLabel 'disconnected'
                $script:gatewayLastError = '与网关断开连接'
                try { $btnSubmit.Enabled = $true } catch { }
            }
            return
        }
        $script:gatewayPollFails = 0
        $extra = ''
        if ($r.Raw -and $r.Raw.queue_position -gt 0) { $extra = "队列 #$($r.Raw.queue_position)" }
        $ex2 = @($extra, $(if ($script:lastProgressText) { $script:lastProgressText } else { "" })) | Where-Object { $_ }
        & $setStatusLabel $r.Status ($ex2 -join " · ")
        if ($r.Status -eq 'success') {
            $script:gatewayPhase = 'done'
            $script:GatewayPaths = @()
            if ($r.Raw.paths) { $script:GatewayPaths = @($r.Raw.paths) }
            & $stopTimer
            try { $btnSubmit.Enabled = $true } catch { }
            # 出图完成：把表单收起来，交给主流程用 $script:GatewayPaths
            $form.DialogResult = 'OK'
            $form.Close()
        } elseif ($r.Status -eq 'failed') {
            $script:gatewayPhase = 'done'
            $script:gatewayLastError = [string]$r.Raw.error
            & $stopTimer
            try { $btnSubmit.Enabled = $true } catch { }
            [System.Windows.Forms.MessageBox]::Show("出图失败：$($r.Raw.error)", '网关返回失败', 'OK', 'Error') | Out-Null
        }
    })

    # FormClosing：必须停表 + 释放（硬要求）
    $form.Add_FormClosing({
        try {
            if ($timer) { $timer.Stop(); $timer.Dispose() }
        } catch { }
    })

    $btnCancel.Add_Click({ $form.DialogResult = 'Cancel'; $form.Close() })
    $form.CancelButton = $btnCancel
    # P5 硬要求：回车 = 出图提交（走网关），而不是直接关表单。
    # 现在整个表单只有这一个"出图"按钮（$btnOk 已被合并进来，不再单独存在）。
    $form.AcceptButton = $btnSubmit

    # 对话里有加字要求（-AddText 非空）→ 表单弹出后自动开一次「缩略图选位置」，
    # 位置已经在脚本开始时**随机**挑好并加了字，用户在这里随时改成想要的位置（用户要求 2026-10-21）。
    if ($AutoOpenPosPicker) {
        $script:PosPickerAutoOpened = $false
        $form.Add_Shown({
            try {
                if (-not $script:PosPickerAutoOpened) {
                    $script:PosPickerAutoOpened = $true
                    Write-Host "[选位器] 对话里有加字要求 → 自动打开选位器（在缩略图上点位置 / 选九宫格 / 改字号风格）" -ForegroundColor Cyan
                    if ($btnPickPos -and $btnPickPos.Enabled) { $btnPickPos.PerformClick() }
                    else { Write-Host "[选位器] 按钮当前不可用 → 跳过自动打开（手动点「缩略图选位置…」即可）" -ForegroundColor Yellow }
                }
            } catch {
                Write-Host ("[选位器] 自动打开失败（不影响参数表，可手动点按钮）：" + $_.Exception.Message) -ForegroundColor Yellow
            }
        })
    }

    # =====================================================================
    # 加速（2026-10-21）：参数指纹 —— 用户在表单里**一个都没改**、直接点「确定出图」时，
    #   直接复用预生成那张（省一次完整出图 + 一次加字，实测 2-5 分钟）。改过任何一项照常出图。
    # =====================================================================
    $script:FmGetSig = {
        try {
            return (@(
                $txtPos.Text.Trim(),
                $txtNeg.Text.Trim(),
                ($txtGwWidth.Text.Trim() + 'x' + $txtGwHeight.Text.Trim()),
                $(if ($cboBackend -and $cboBackend.SelectedItem) { [string]$cboBackend.SelectedItem.Key } else { 'SD_FP16' }),
                $cboDenoise.Text.Trim(),
                [string]$cboRatio.SelectedItem,
                [string]$cboQuality.SelectedItem,
                $cboRounds.Text.Trim(),
                $cboLora.Text.Trim(),
                $cboMask.Text.Trim(),
                $txtInit.Text.Trim(),
                [string]$cboMode.SelectedItem,
                [string]$cboModel.SelectedItem,
                [string]$cboVlm.SelectedItem,
                $txtName.Text.Trim(),
                $txtAddText.Text.Trim(),
                $txtAddTextPos.Text.Trim(),
                "$($cboAddTextSize.SelectedItem)",
                "$($cboAddTextStyle.SelectedItem)"
            ) -join '|')
        } catch { return '' }
    }
    $script:FmPrefillSig = (& $script:FmGetSig)

    # 诊断日志已关闭（用户要求 2026-10-14）：不再写 sd-inject-form-diag.log
    try {
        $dlgResult = $form.ShowDialog()
    } catch {
        $dlgResult = 'Cancel'
    }
    if ($dlgResult -ne 'OK') {
        Write-Host "已在参数表单取消。" -ForegroundColor Yellow
        # C 档新流程：后台预生成的那张已经落盘了 —— 用户即使直接关窗口，成品也不丢
        if ("$PreGenPath" -and (Test-Path -LiteralPath $PreGenPath)) {
            Write-Host "后台已生成的成品在这里（未删除）: $PreGenPath" -ForegroundColor Green
            Write-Host "最终成品: $PreGenPath" -ForegroundColor Green
        }
        exit 0
    }

    # 解析：非法输入回落默认（迭代次数回落默认轮数、Denoising 回落 0 = 文生图）
    $rounds = $DefaultRounds
    $null = [int]::TryParse($cboRounds.Text.Trim(), [ref]$rounds)
    if ($rounds -lt 1) { $rounds = 1 } elseif ($rounds -gt 32) { $rounds = 32 }
    # Denoising **恒定解析**（不再按 HasBaseImage 强行归零——表单先弹，那一刻必然还没有素体成品）：
    # 取文本框开头的数字（兼容「0（文生图·不用底图）」这类带说明的条目），0 = 文生图，>0 = 图生图重绘幅度；
    # 空值/非法 → 0（等于现状行为）。上限 0.95，防止填 1 直接把底图信息全洗掉。
    $den = 0.0
    $denMatch = [regex]::Match(($cboDenoise.Text -replace ',', '.').Trim(), '^[0-9]*\.?[0-9]+')
    if ($denMatch.Success) { $null = [double]::TryParse($denMatch.Value, [ref]$den) }
    if ($den -lt 0) { $den = 0 } elseif ($den -gt 0.95) { $den = 0.95 }
    return @{
        # 确认时也兜一次后缀逗号（用户要求）：两个框最后一定是 "…," —— 框里显示什么、后面用什么。
        Pos     = (Add-TrailingComma $txtPos.Text).TrimEnd()
        Neg     = (Add-TrailingComma $txtNeg.Text).TrimEnd()
        Rounds  = $rounds
        Denoise = $den
        Ratio   = [string]$cboRatio.SelectedItem
        Style   = [string]$cboStyle.SelectedItem
        Quality = [string]$cboQuality.SelectedItem
        Lora    = $cboLora.Text.Trim()
        Model   = [string]$cboModel.SelectedItem
        Name    = $txtName.Text.Trim()
        InitImg = $txtInit.Text.Trim()
        Mode    = [string]$cboMode.SelectedItem
        Vlm     = [string]$cboVlm.SelectedItem   # 视觉审查：自动 / 强制 / 关闭
        Mask    = $cboMask.Text.Trim()
        # 加字（2026-10-20 用户要求）：表单「加字」栏 + 加字模型栏
        AddText = $txtAddText.Text.Trim()
        AddTextModel = [string]$cboAddTextModel.SelectedItem
        AddTextPos = $txtAddTextPos.Text.Trim()
        AddTextSize = [string]$cboAddTextSize.SelectedItem
        AddTextStyle = [string]$cboAddTextStyle.SelectedItem
        # P5：模型枚举（SD_FP16 / Anima_INT8 / QwenImage_NVFP4 / Krea2_Q4）—— 出图统一走网关
        Backend = if ($cboBackend -and $cboBackend.SelectedItem) { [string]$cboBackend.SelectedItem.Key } else { 'SD_FP16' }
        # P5：宽高（表单里可手改，作为网关出图尺寸；8 的倍数已校验）
        GwWidth  = (Get-GwSizeOrZero -Text $txtGwWidth.Text)
        GwHeight = (Get-GwSizeOrZero -Text $txtGwHeight.Text)
        # P5：表单里已经用网关出过图 → 直接用它，主流程不再重复生成
        GwTaskId = $script:GatewayTaskId
        GwPaths  = @($script:GatewayPaths)
        GwError  = $script:GatewayLastError
        GwStatus = if ($script:GatewayPaths.Count -gt 0) { 'success' } elseif ($script:GatewayLastError) { 'failed' } else { 'idle' }
    }
}

# 表单退出时取值：非法/空 → 0（由调用方回落到比例/画质档算出的尺寸）
function Get-GwSizeOrZero {
    param([string]$Text)
    $v = 0
    if (-not [int]::TryParse("$Text".Trim(), [ref]$v)) { return 0 }
    if ($v -lt 64 -or $v -gt 4096) { return 0 }
    return $v
}

# 比例 + 画质短边档 → SD 尺寸（8 的倍数；面积随画质档走，比例只定形状）
function Get-SizeFor {
    param([string]$Ratio, [string]$Quality)
    $short = 480
    switch ($Quality) {
        '640p'  { $short = 640 }
        '768p'  { $short = 768 }
        '1024p' { $short = 1024 }
        '1280p' { $short = 1280 }
        '1440p' { $short = 1440 }
        '2160p（4K）' { $short = 2160 }
    }
    $rw = 9.0; $rh = 16.0
    if ($Ratio -match '^(\d+):(\d+)$') { $rw = [double]$Matches[1]; $rh = [double]$Matches[2] }
    if ($rw -ge $rh) {
        $w = $short; $h = [int][math]::Round($short * $rh / $rw)
    } else {
        $h = $short; $w = [int][math]::Round($short * $rw / $rh)
    }
    $w = [int]([math]::Floor($w / 8)) * 8
    $h = [int]([math]::Floor($h / 8)) * 8
    if ($w -lt 256) { $w = 256 }
    if ($h -lt 256) { $h = 256 }
    return @{ W = $w; H = $h }
}

# ===========================================================================
# -SelfTest：参数锁矩阵自检（不出图、不弹窗、不联网）
#   验证「每个模型 + 每个比例」下，画质档表被锁成什么样，把结果打到控制台。
#   用途：改了 Get-ModelMaxSide / 上下限阈值后，一条命令确认没有档位被锁空。
# ===========================================================================
if ($SelfTest) {
    $tiers = @('480p', '640p', '768p', '1024p', '1280p', '1440p', '2160p（4K）')
    $ratios = @('9:16', '1:1', '3:4', '4:3', '16:9', '2:3', '3:2', '21:9')
    $fail = 0
    foreach ($mk in $script:GatewayModels) {
        Write-Host ""
        Write-Host ("=== {0}（engine={1}，maxSide={2}）===" -f $mk, (Get-ModelEngineFor -Model $mk), (Get-ModelMaxSide -Model $mk)) -ForegroundColor Cyan
        # 用**多画质档**判据筛比例：只要任一档合法该比例就保留（与表单 applyModelLock 完全同源）
        $baseQ = '1024p'
        $okRatios = @(Get-AllowedRatios -Model $mk -AllRatios $ratios -AllTiers $tiers)
        $goneRatios = @($ratios | Where-Object { $okRatios -notcontains $_ })
        if ($okRatios.Count -eq 0) {
            $fail++
            Write-Host "  【全部比例都被锁空！】" -ForegroundColor Red
            continue
        }
        Write-Host ("  保留比例：{0}" -f ($okRatios -join ' '))
        if ($goneRatios.Count -gt 0) {
            Write-Host ("  锁掉比例：{0}（该比例在 ≤{1} 长边下短边必 <512）" -f ($goneRatios -join ' '), (Get-ModelMaxSide -Model $mk)) -ForegroundColor DarkYellow
        }
        foreach ($rt in $okRatios) {
            $q = Get-AllowedQualityTiers -Model $mk -Ratio $rt -AllTiers $tiers
            if (@($q.Allowed).Count -eq 0) {
                $fail++
                Write-Host ("    {0,-5} → 【锁空！】" -f $rt) -ForegroundColor Red
                continue
            }
            $first = @($q.Allowed)[0]
            $s = Get-SizeFor -Ratio $rt -Quality $first
            Write-Host ("    {0,-5} → 画质 {1}   默认 {2} = {3}x{4}" -f $rt, (@($q.Allowed) -join '/'), $first, $s.W, $s.H)
        }
    }
    Write-Host ""
    Write-Host ""
    Write-Host "=== 每档出图参数（cfg / steps / Denoising 合法档）===" -ForegroundColor Cyan
    foreach ($mk in $script:GatewayModels) {
        $dtT = (Get-AllowedDenoiseTiers -Model $mk -Mode "文生图") -join "/"
        $dtI = (Get-AllowedDenoiseTiers -Model $mk -Mode "图生图") -join "/"
        Write-Host ("  {0,-16} cfg={1}  steps={2}  文生图 Denoise=[{3}]  图生图 Denoise=[{4}]" -f $mk, (Get-ModelCfg -Model $mk), (Get-ModelSteps -Model $mk), $dtT, $dtI)
        if ((Get-ModelCfg -Model $mk) -le 0 -or (Get-ModelSteps -Model $mk) -le 0) { $fail++ }
    }

    if ($fail -gt 0) { Write-Host ("SELFTEST FAILED：$fail 处锁空") -ForegroundColor Red; exit 1 }
    Write-Host ""
    Write-Host "=== 视觉审查开关（-VisualReview auto/on/off，-NoVlmReview 仍兼容）===" -ForegroundColor Cyan
    foreach ($mode in @("auto","on","off")) {
        $script:VisualReview = $mode
        $script:NoVlmReview = $false
        $off = Test-VisualReviewOff
        $forced = Test-VisualReviewForced
        Write-Host ("  -VisualReview {0,-4} → 跳过视觉={1}  强制={2}" -f $mode, $off, $forced)
        if (($mode -eq "off") -ne $off) { $fail++ }
    }
    $script:VisualReview = "auto"
    $script:NoVlmReview = $true
    if (-not (Test-VisualReviewOff)) { $fail++ }
    Write-Host "  -NoVlmReview?  → 跳过视觉=True（旧开关仍生效）" -ForegroundColor Gray
    Write-Host "SELFTEST OK：4 档在各自可用比例下都至少有一个可用画质档；短边 <512 与长边超限的档已剔除" -ForegroundColor Green
    exit 0
}
# ---- 素体自检迭代（只跑基底，绝不改提示词）----
# 脸/手质检：把图发给本地视觉模型（Ollama OpenAI 兼容端点 /chat/completions，image_url 用 base64 data URI），
# 让它只回一个 0-100 的整数分（脸部 + 手部综合）。判定线：>= 75 过关；< 45 且已试过面部修复 → 判定该模型不会看图，质检降级为「只要没成功启动过一次就当过关」，避免无限烧卡。
function Test-VlmApi {
    try {
        $null = Invoke-RestMethod -Uri "$QwenBase/models" -Method Get -TimeoutSec 5
        return $true
    } catch {
        return $false
    }
}

function Get-VlmCandidates {
    # 质检要的是视觉模型：vl / vision 排最前，专用代码模型依旧压底；缓存结果
    if ($script:VlmCandidateCache) { return $script:VlmCandidateCache }
    $models = @()
    foreach ($ep in @("$QwenBase/models", "$QwenBase/../api/tags")) {
        if ($models.Count -gt 0) { break }
        try {
            $r = Invoke-RestMethod -Uri $ep -Method Get -TimeoutSec 10
            if ($r -and $r.data) { $models = @($r.data | ForEach-Object { [string]$_.id }) }
            elseif ($r -and $r.models) { $models = @($r.models | ForEach-Object { [string]$_.name }) }
        } catch { }
    }
    if ($models.Count -eq 0) {
        # 一个都没枚举到：最常见的根因是 OLLAMA_MODELS 指向了空目录（模型实际在别处）。
        Write-Host "本地模型服务上一个模型都没枚举到（$QwenBase）" -ForegroundColor Red
        $ollamaModels = $env:OLLAMA_MODELS
        if (-not $ollamaModels) { $ollamaModels = '(未设，用默认 ~/.ollama/models)' }
        Write-Host "常见根因：OLLAMA_MODELS 指向了空目录。当前值：$ollamaModels" -ForegroundColor Yellow
    }
    $visionFirst = @($models | Where-Object { $_ -match 'vl|vision|llava|bakllava|moondream|minicpm-v|internvl' })
    $rest = @($models | Where-Object { $visionFirst -notcontains $_ })
    $script:VlmCandidateCache = @($visionFirst + $rest | Where-Object { $_ -and ($_ -notmatch 'embed|rerank') })
    return $script:VlmCandidateCache
}

function Test-FaceQuality {
    # 返回 0-100 整数分（解析失败返回 -1）。问句刻意只聊**人物肢体结构**（脸/手/四肢），
    # 不给模型任何「画面内容」的发挥空间。
    # 2026-10-15 用户要求：手部细节纳入质检；同日晚再扩到**整条肢体**——手臂/腿是否各两条、
    # 左右对称、多肢少肢、关节反向错位、四肢畸形粘连、躯干与四肢比例失衡，与脸部一起综合打分。
    # 超时 180s：VLM 冷启动要把模型加载进显存，首问可能远慢于热状态（实测 8B 首问 >120s）。
    param([string]$ImagePath)
    # ── Issue 1/3 修复（2026-10-16 真机报告，阻塞级）──────────────────────────────
    # 本机**根本没有本地视觉模型**时，以前仍会走到下面的 Ensure-Vram：它按「剩余显存 < 4G」的
    # 判据把 SD 的 checkpoint 卸掉，紧接着两次审核请求全部连不上、6 秒后放弃 →
    # 卸载纯属白卸，而 A1111 在「卸载 → 请求内重载」这条路径上会把部分权重留在 CPU
    # （CLIP token embedding / LoRA Linear 都遇到过）→ 同一次请求内张量设备不一致 →
    # **后续每一轮 txt2img 必然 500**（6G 卡常驻只有 3.6G 剩余，所以每轮必中）。
    # 两层修复：① 明确关了审核就整条早退；② 服务不可达时同样早退（不去白卸 SD）。
    if (Test-VisualReviewOff) { return -1 }
    if (-not (Test-VlmApi)) { return -1 }
    try {
        $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($ImagePath))
    } catch { return -1 }
    # 送审前**先降分辨率**（2026-10-16：实测 832x1216 原图在 8G 卡上、SD 常驻时 180s 都跑不完 →
    # 每次质检都返回 -1，用户看到的就是「视觉审核一致失效」）。判「结构是否崩坏」不需要原分辨率，
    # 长边压到 768 后像素数只有原来的 ~40%，CPU 也能在几十秒内出分。
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
        $srcImg = [System.Drawing.Image]::FromFile($ImagePath)
        $maxSide = [Math]::Max($srcImg.Width, $srcImg.Height)
        if ($maxSide -gt $VlmImageMaxSide) {
            $k = [double]$VlmImageMaxSide / $maxSide
            $nw = [int][Math]::Max(16, [Math]::Round($srcImg.Width * $k))
            $nh = [int][Math]::Max(16, [Math]::Round($srcImg.Height * $k))
            $bmp2 = New-Object System.Drawing.Bitmap($nw, $nh)
            $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
            $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g2.DrawImage($srcImg, 0, 0, $nw, $nh)
            $g2.Dispose(); $srcImg.Dispose()
            $ms = New-Object System.IO.MemoryStream
            $bmp2.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp2.Dispose()
            $b64 = [Convert]::ToBase64String($ms.ToArray())
            $ms.Dispose()
        } else { $srcImg.Dispose() }
    } catch { }
    # 只给判据 + 「直接给分」，不要让模型展开长篇推理。实测（2026-10-16，qwen3-vl:8b）：
    #   · 走原生 /api/chat + think:false + num_predict=1024 → 11.9s、finish=stop、content="SCORE=100"；
    #   · /v1/chat/completions 对思考型模型不认 think:false（content 恒空，思维链在 reasoning）；
    #   · num_predict 太小（256/512/700）会「想一半被截断」→ content 空或只剩半截数字（实测回过 "797"）。
    # 用户要求（2026-10-16）：**审查范围只许是技术性的**（生成缺陷/结构），不许评价画面内容。
    # 所以问句里明确划死边界：不看题材、不评服装/裸露/性内容、不做合规判断、不许拒绝、只回分数。
    $systemContent = '你是一个生成图的结构缺陷检测器（自动质检环节的一环）。' +
        '你的唯一任务是检查人物解剖结构是否崩坏（脸 / 手 / 四肢），只输出一个 0-100 的整数分。' +
        '禁止评价、描述、审查或拒绝画面内容：不判断题材、不判断服装与裸露程度、不涉及性内容、' +
        '不做任何合规/道德/安全判断，也不要复述画面里有什么。除分数外不要输出任何字。'
    $userContent = '直接给分，不要展开推理。格式：SCORE=<0-100>。判据：这张图里的人物肢体结构是否健康——' +
        '① 脸部：眼睛是否对称/无多余、五官是否扭曲错位、脸部是否畸形融化；' +
        '② 手部：每只手是否五根手指齐全、有无多余或缺失的手指、手指是否扭曲粘连、手部是否畸形；' +
        '③ 肢体：手臂与腿是否各两条、左右对称、有无多肢少肢、关节反向或错位、四肢畸形或粘连、躯干与四肢比例失衡。' +
        '任一处崩坏都要相应扣分。100=完全健康，0=严重崩坏。只许输出分数，不许评论画面内容。'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $raw = ''
    # 审核要把 8B 视觉模型读进显存（实测常驻 5278MB）：先让 SD 卸载模型，否则模型被挤到 CPU、
    # 一次审核从 ~12s 变成 40-65s 甚至 180s 超时（这就是「审核一致失效」的现场）。
    # Issue 1 修复（2026-10-16）：**只在视觉模型真的可达时才为它腾显存**。
    # 本机没装 Ollama 时以前照样卸载 → 后续 txt2img 必 500（CPU/CUDA 设备分裂，见 Issue 1 说明）。
    if (Test-VlmApi) { Ensure-Vram -For 'sd' -Note '视觉审核' }
    try {
        $nativeBase = $QwenBase -replace '/v1/?$', ''
        $native = @{ model = $VlmModel; think = $false; stream = $false
            options = @{ num_predict = 1024; temperature = 0.1 }
            messages = @(@{ role = 'system'; content = $systemContent },
                            @{ role = 'user'; content = $userContent; images = @($b64) })
        } | ConvertTo-Json -Depth 10
        $r1 = Invoke-RestMethod -Uri ($nativeBase.TrimEnd('/') + '/api/chat') -Method Post `
            -Headers @{ 'Content-Type' = 'application/json; charset=utf-8' } `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($native)) -TimeoutSec $VlmTimeoutSec
        $raw = Repair-Utf8Mojibake ([string]$r1.message.content)
        if (-not $raw) { $raw = Repair-Utf8Mojibake ([string]$r1.message.thinking) }
    } catch {
        Write-Host "  [审核] 原生端点失败：$($_.Exception.Message) → 改用 OpenAI 兼容端点" -ForegroundColor DarkGray
    }
    if (-not $raw) {
        try {
            $body = @{ model = $VlmModel; temperature = 0.1; stream = $false; max_tokens = 1024
                messages = @(@{ role = 'system'; content = $systemContent },
                    @{ role = 'user'; content = @(
                            @{ type = 'text'; text = $userContent }
                            @{ type = 'image_url'; image_url = @{ url = "data:image/png;base64,$b64" } }
                        ) })
            }
            $headers = @{ "Content-Type" = "application/json; charset=utf-8" }
            if ($QwenApiKey) { $headers["Authorization"] = "Bearer $QwenApiKey" }
            $r2 = Invoke-RestMethod -Uri "$QwenBase/chat/completions" -Method Post -Headers $headers `
                -Body ([System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 8))) -TimeoutSec $VlmTimeoutSec
            $raw = Repair-Utf8Mojibake ([string]$r2.choices[0].message.content)
            if (-not $raw) { $raw = Repair-Utf8Mojibake ([string]$r2.choices[0].message.reasoning) }
        } catch {
            $sw.Stop()
            Write-Host "  [审核] 模型 $VlmModel 两个端点都没答上来（已用 $([math]::Round($sw.Elapsed.TotalSeconds,0))s）→ 本轮不打分" -ForegroundColor Yellow
            return -1
        }
    }
    $sw.Stop()
    if (-not $raw) {
        Write-Host "  [审核] $VlmModel 只吐了思考、没给分数（已用 $([math]::Round($sw.Elapsed.TotalSeconds,0))s）→ 本轮不打分" -ForegroundColor Yellow
        return -1
    }    $raw = ("$raw").Trim()
    # 解析必须皮实：实测同一个模型会回 "SCORE=100"、只回 "813"、或只回一段思考。
    # 规则：① 先认显式 SCORE=<n>；② 否则取**第一个 0-100 的整数**（813 这种跳过，别当 813 分）。
    $score = -1
    $mScore = [regex]::Match($raw, 'SCORE\s*[=:：]\s*(\d{1,3})')
    if ($mScore.Success) { $null = [int]::TryParse($mScore.Groups[1].Value, [ref]$score) }
    if ($score -lt 0 -or $score -gt 100) {
        $score = -1
        foreach ($mm in [regex]::Matches($raw, '\d{1,3}')) {
            $v = 0
            if ([int]::TryParse($mm.Value, [ref]$v) -and $v -ge 0 -and $v -le 100) { $score = $v; break }
        }
    }
    if ($score -lt 0) {
        Write-Host "  [审核] $VlmModel 没给出可用的 0-100 分数（已用 $([math]::Round($sw.Elapsed.TotalSeconds,0))s，回答：$(("" + $raw).Substring(0,[Math]::Min(70,("" + $raw).Length)))）" -ForegroundColor Yellow
        return -1
    }
    return $score
}

function Invoke-BaseIterate {
    # 素体迭代主流程：只跑 $BasePrompt，每轮换 seed；有视觉模型时逐轮质检，没有就只出一张。
    # 返回 @{ Path = 图路径; Seed = 实际 seed; Score = 脸/手得分（没质检 = -1） }; 真出不了图才返回 $null。
    # 铁律：本函数不修改 $positive / $negative 的任何内容——不加词、不加替换词、不加安全词。
    # 2026-10-15 修：质检不可用**不再直接 return $null**——那样图生图（Denoising > 0）会因为
    # 「没有素体成品」被静默降级成文生图（用户实测：C 档根本用不了图生图）。现在照样出一张底图。
    $vlmOk = $true
    if (Test-VisualReviewOff) {
        # 插件设置 vlmReview=false（或命令里带 -NoVlmReview）：整条视觉审核不跑 —— 不探活、不冷启动、
        # 不加载模型、不打分；照常出满 N 张并弹多选让你自己挑。
        Write-Host "视觉模型审核已关闭（-NoVlmReview / 插件设置 vlmReview=false）→ 不跑质检，按迭代次数出满 N 张由你自己挑" -ForegroundColor Yellow
        $vlmOk = $false
    } elseif (-not (Test-VlmApi)) { $null = Start-OllamaService -TimeoutSec $VlmStartTimeout }   # 冷启动：先试着把本地视觉模型服务拉起来
    if (-not $vlmOk) {
        # 已明确关闭：不再打印「不可用」，直接走无质检路径
    } elseif (-not (Test-VlmApi)) {
        Write-Host "本地视觉模型不可用（$QwenBase）→ 素体只出一张底图、不跑肢体质检迭代（图生图底图照常可用）" -ForegroundColor Yellow
        $vlmOk = $false
    } elseif (-not $VlmModel -or ((Get-VlmCandidates) -notcontains $VlmModel)) {
        $vlm = Get-VlmCandidates | Where-Object { $_ -match 'vl|vision|llava|moondream|minicpm-v|internvl' } | Select-Object -First 1
        if (-not $vlm) {
            Write-Host "本机没有视觉模型（vl/vision）→ 素体只出一张底图、不跑肢体质检迭代；想审核请先：ollama pull qwen3-vl:8b" -ForegroundColor Yellow
            $vlmOk = $false
        } elseif ($vlm -ne $VlmModel) {
            Write-Host "本机没有『$VlmModel』（枚举到：$((Get-VlmCandidates | Select-Object -First 5) -join ' / ')）" -ForegroundColor Yellow
            Write-Host "质检模型已回退到 '$vlm'；要固定用『$VlmModel』：先 ollama pull $VlmModel（本地自制模型用 ollama create $VlmModel -f Modelfile）" -ForegroundColor Yellow
            $script:VlmModel = $vlm
        }
    }
    # 预热：发一条纯文本空问，把模型先加载进显存——否则首轮带图质检会撞冷启动超时（实测 >120s）
    if ($vlmOk) {
        try {
            $null = Invoke-RestMethod -Uri "$QwenBase/chat/completions" -Method Post `
                -Headers @{ "Content-Type" = "application/json; charset=utf-8"; "Authorization" = "Bearer $QwenApiKey" } `
                -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ model = $VlmModel; messages = @(@{ role = "user"; content = "1" }); stream = $false } | ConvertTo-Json -Depth 6))) `
                -TimeoutSec 300
        } catch { }
    }

    Write-Host "素体自检迭代中..." -ForegroundColor Cyan
    $bestPath = ''
    $bestSeed = -1
    $bestScore = -1
    $roundsUsed = 0
    $vlmEverWorked = $false
    $giveUpVlm = (-not $vlmOk)   # 没质检 → 出完第一轮就收（当底图用）
    for ($round = 1; $round -le $IterateRounds; $round++) {
        $roundsUsed = $round
        $roundSeed = -1
        $candPath = ''    # P5：经网关出图时直接用返回的绝对路径
        if ((-not $NoGateway) -and (Test-GatewayUp)) {
            # 前端不直连 WebUI：素体也交给网关（单车道锁/显存准入/失败可查询都由网关负责）
            $subBase = New-GatewayTask -Model $gwSelectedModel -Prompt $BasePrompt -Negative $BaseNegative `
                -Width $Width -Height $Height -Steps $Steps -Denoise 0 `
                -Sampler $(if ($gwSelectedModel -in @('SD_FP16', 'Anima_INT8')) { "$Sampler" } else { '' }) `
                -Name $Name -OutDir $script:IterTempDir
            if (-not $subBase.Ok) {
                Write-Host "素体提交网关失败：$($subBase.Message)（改用本地直连：需 -LocalBackendFallback）" -ForegroundColor Red
                if (-not $LocalBackendFallback) { Remove-IterTempDir; exit 1 }
            } else {
                Write-Host "  经网关出素体（task=$($subBase.TaskId.Substring(0,8))）..." -ForegroundColor DarkGray
                $wrBase = Wait-GatewayTask -TaskId $subBase.TaskId -TimeoutSec 3600
                if ($wrBase.Ok -and $wrBase.Raw.paths) {
                    $candPath = @($wrBase.Raw.paths)[0]
                    if ($wrBase.Raw.result -and $wrBase.Raw.result.seed) { $roundSeed = [long]$wrBase.Raw.result.seed }
                } else {
                    Write-Host "素体出图失败：[$($wrBase.Status)] $($wrBase.Message)" -ForegroundColor Red
                    if (-not $LocalBackendFallback) { Remove-IterTempDir; exit 1 }
                }
            }
        }
        if (-not $candPath) {
            if (-not $LocalBackendFallback) {
                Write-Host "网关不可用且未开 -LocalBackendFallback → 素体迭代无法进行" -ForegroundColor Red
                Remove-IterTempDir
                exit 1
            }
        $iterArgs = @(
            "-ExecutionPolicy", "Bypass", "-File", "`"$SdDirect`"",
            "-Prompt", "`"$BasePrompt`"",
            "-Negative", "`"$BaseNegative`"",
            "-Width", "$Width", "-Height", "$Height",
            "-Steps", "$Steps", "-Cfg", "$Cfg",
            "-Sampler", "`"$Sampler`"",
            "-Seed", "-1",
            "-OutDir", "`"$script:IterTempDir`"",
            "-Name", "`"$Name`""
        )
        if ($SdDir) { $iterArgs += @("-SdDir", "`"$SdDir`"") }
        # 坑33：不开 SD 内置面部修复（-RestoreFaces）。8G 显存下 CodeFormer/GFPGAN 与质检模型
        # 抢显存，出图进度 100% 后卡死（实测「出图第 2 轮（含面部修复）卡住」）。质检已靠
        # VLM 打分换 seed 重试，不需要 SD 内置修复。
        # 迭代期间不弹窗，最终那张才弹；sd-direct.ps1 会打印 SEEDVALUE 行，捕获真实 seed
        $iterArgs += "-NoOpen"
        Write-Host "素体第 $round/$IterateRounds 轮..." -ForegroundColor Cyan
        $iterOut = & powershell @iterArgs 2>&1
        $iterOut | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "素体出图失败（exit $LASTEXITCODE），中止迭代" -ForegroundColor Red
            Remove-IterTempDir
            exit 1
        }
        # 从输出里解析真实 seed（Seed: 行；SEEDVALUE 是给机器看的冗余行）
        $seedLine = @($iterOut | Where-Object { $_ -match '^SEEDVALUE:\s*(\d+)' } | Select-Object -First 1)
        if ($seedLine -and $seedLine -match '^SEEDVALUE:\s*(\d+)') { $roundSeed = [long]$Matches[1] }
        }
        # 候选图：网关路径直接用返回值；本地应急路径按 sd-direct 的命名规则取序号最大那张
        $cand = $null
        if ($candPath -and (Test-Path -LiteralPath $candPath)) {
            $cand = Get-Item -LiteralPath $candPath
        } else {
            $cand = Get-ChildItem -LiteralPath $script:IterTempDir -Filter "$Name`_*.png" -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending | Select-Object -First 1
        }
        if (-not $cand) {
            Write-Host "找不到本轮产物（$script:IterTempDir\|$Name`_*.png），中止迭代" -ForegroundColor Red
            Remove-IterTempDir
            exit 1
        }
        if ($giveUpVlm) {
            $bestPath = $cand.FullName
            $bestSeed = $roundSeed
            break
        }
        $score = if ($vlmOk) { Test-FaceQuality -ImagePath $cand.FullName } else { -1 }
        if ($score -ge 0) { $vlmEverWorked = $true }
        if ($score -lt 0) {
            # 视觉模型没给出分数：第一轮先重试一轮（可能是冷启动抖动），仍不行就降级为「出一张就收」
            if ($round -lt $IterateRounds) {
                Write-Host "质检无分数（视觉模型未就绪或解析失败），再试一轮" -ForegroundColor Yellow
                continue
            }
            $bestPath = $cand.FullName
            $bestSeed = $roundSeed
            break
        }
        Write-Host "  脸/手质检得分：$score/100（>= 75 过关）" -ForegroundColor DarkGray
        if ($score -gt $bestScore) {
            $bestScore = $score; $bestPath = $cand.FullName; $bestSeed = $roundSeed
            # 增量落盘：新最高分立即复制进工作区（中途关闭也不丢当前最优成品）
            try {
                $null = New-Item -ItemType Directory -Path $OutDir -Force
                Copy-Item -LiteralPath $bestPath -Destination (Join-Path $OutDir (Split-Path $bestPath -Leaf)) -Force
            } catch { }
        }
        if ($score -ge 75) { break }
        # 低于 45 且已经开过面部修复还没救回来 → 质检模型大概率不会看图，别再烧轮数
        if ($score -lt 45 -and $round -ge 2) {
            Write-Host "  连续低分且已开面部修复——判定质检模型不可靠，采用本轮结果" -ForegroundColor Yellow
            $giveUpVlm = $true
            $bestPath = $cand.FullName
            $bestSeed = $roundSeed
            try {
                $null = New-Item -ItemType Directory -Path $OutDir -Force
                Copy-Item -LiteralPath $bestPath -Destination (Join-Path $OutDir (Split-Path $bestPath -Leaf)) -Force
            } catch { }
            break
        }
    }
    if (-not $bestPath) { return $null }
    return @{ Path = $bestPath; Seed = $bestSeed; Score = $bestScore; RoundsUsed = $roundsUsed }
}

function Invoke-FinalIterate {
    # 最终出图迭代：按表单参数连出 $Rounds 张（换 seed），每张质检脸/手取最高分。
    # 质检失败/超时（得分 < 0）时：不再烧轮数，改为把「本轮及后续各轮」都生成出来、
    # 全部保留让用户自己选（多选模式）。返回 @{ Paths = 图路径数组; Seed; Score }。
    param(
        [string]$InitImage = "",
        [double]$Denoising = 0.7,
        [int]$Rounds = 1,
        [int]$W = 512,
        [int]$H = 768,
        [string]$Checkpoint = "",
        [string]$Mask = "",           # 蒙版图（白=重绘区）：决策 C-1b 替换衣服/脸/背景时走蒙版重绘
        [int]$InpaintFill = 0         # 蒙版区底色：0=填充（默认，替换最稳）1=保留原图 2=潜空间噪声（会在蒙版区留噪点）
    )
    $bestPath = ''
    $bestSeed = -1
    $bestScore = -1
    $allPaths = @()
    # Issue 3 修复（2026-10-16）：`-NoVlmReview` 时**直接标记质检已关闭**，
    # 让循环一次都不进 Test-FaceQuality（以前那句「视觉模型审核已关闭」只是打印，
    # 质检函数照跑 → Ensure-Vram 白卸 SD → 后续 txt2img 必 500）。
    $vlmDown = [bool](Test-VisualReviewOff)
    for ($round = 1; $round -le $Rounds; $round++) {
        $finalArgs = @(
            "-ExecutionPolicy", "Bypass", "-File", "`"$SdDirect`"",
            "-Prompt", "`"$positive`"",
            "-Negative", "`"$finalNegative`"",
            "-Width", "$W", "-Height", "$H",
            "-Steps", "$Steps", "-Cfg", "$Cfg",
            "-Sampler", "`"$Sampler`"",
            "-Seed", "-1",
            "-OutDir", "`"$script:IterTempDir`"",
            "-Name", "`"$Name`""
        )
        if ($Checkpoint) { $finalArgs += @("-Checkpoint", "`"$Checkpoint`"") }
        if ($InitImage -and (Test-Path -LiteralPath $InitImage)) {
            $finalArgs += @("-InitImage", "`"$InitImage`"", "-Denoising", "$Denoising")
            if ($Mask -and (Test-Path -LiteralPath $Mask)) {
                $finalArgs += @("-Mask", "`"$Mask`"", "-InpaintFill", "$InpaintFill", "-InpaintPadding", "32")
            }
        }
        if ($SdDir) { $finalArgs += @("-SdDir", "`"$SdDir`"") }
        $finalArgs += "-NoOpen"
        $roundMode = if ($Mask) { "蒙版重绘 denoising=$Denoising" } elseif ($InitImage) { "图生图 denoising=$Denoising" } else { "文生图" }
        Write-Host "出图第 $round/$Rounds 轮（$roundMode）..." -ForegroundColor Cyan
        $finalOut = & powershell @finalArgs 2>&1
        $finalOut | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "出图失败（exit $LASTEXITCODE），中止迭代" -ForegroundColor Red
            Remove-IterTempDir
            exit 1
        }
        $roundSeed = -1
        $seedLine = @($finalOut | Where-Object { $_ -match '^SEEDVALUE:\s*(\d+)' } | Select-Object -First 1)
        if ($seedLine -and $seedLine -match '^SEEDVALUE:\s*(\d+)') { $roundSeed = [long]$Matches[1] }
        $cand = Get-ChildItem -LiteralPath $script:IterTempDir -Filter "$Name`_*.png" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $cand) {
            Write-Host "找不到本轮产物（$script:IterTempDir\$Name`_*.png），中止迭代" -ForegroundColor Red
            Remove-IterTempDir
            exit 1
        }
        # 记录本轮产物
        $allPaths += $cand.FullName
        $bestPath = $cand.FullName
        $bestSeed = $roundSeed

        if ($vlmDown) {
            # 质检已失效：后续轮不再质检，直接出满剩余张数（多选模式）
            Write-Host "  质检已失效，直接生成（用户自选）" -ForegroundColor Yellow
            continue
        }
        # Issue 3 修复（2026-10-16）：`-NoVlmReview` 必须「整条不跑」——上面 `$vlmDown` 初值已带
        # `[bool]$NoVlmReview`，关了审核就在上一个 if 里 continue 掉，这里永远不会执行。
        $score = Test-FaceQuality -ImagePath $cand.FullName
        if ($score -lt 0) {
            # 质检失败/超时/已关闭：不再烧轮数，改为出满 $Rounds 张让用户自选（用户要求）
            Write-Host "  质检无分数——后续各轮直接生成，全部保留供你选择" -ForegroundColor Yellow
            $vlmDown = $true
            $bestScore = -1
            continue
        }
        Write-Host "  脸/手质检得分：$score/100（>= 75 过关）" -ForegroundColor DarkGray
        if ($score -gt $bestScore) { $bestScore = $score; $bestPath = $cand.FullName; $bestSeed = $roundSeed }
        if ($score -ge 75) { break }
    }
    if ($allPaths.Count -eq 0) { return $null }
    return @{ Paths = $allPaths; Path = $bestPath; Seed = $bestSeed; Score = $bestScore; VlmDown = $vlmDown }
}

# 质检模型起不来时的收尾选择器：把候选图列成「文件名 + 勾选框」的多选对话框（纯文本，绝不白屏），
# 右侧带一张选中项的预览图；取消或一张没选 = 全部保留。返回保留的路径数组。
# ===========================================================================
# 网关出图后的**质检**（2026-10-19 新增）
#   以前网关路径成功就把 Score 写死 100、VlmDown 置真 —— 等于质检整段没跑，
#   人物肢体崩坏没人发现（C 档质量差的直接原因之一）。
#   现在对网关返回的每一张逐张 Test-FaceQuality 打分，取最高分那张；
#   全部拿不到分数（模型没起/解析失败）才降级为 VlmDown=true（出满 N 张让你自己挑）。
# ===========================================================================
function Invoke-GatewayQualityCheck {
    param([string[]]$Paths)
    $list = @($Paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
    if ($list.Count -eq 0) { return $null }
    if (Test-VisualReviewOff) {
        Write-Host "  [质检] 已关闭视觉审核（-NoVlmReview）→ 不评分" -ForegroundColor DarkGray
        return @{ Path = $list[0]; Paths = $list; Score = -1; VlmDown = $true }
    }
    if (-not (Test-VlmApi)) {
        Write-Host "  [质检] 视觉模型服务不可达 → 不评分（图照常交付）" -ForegroundColor Yellow
        return @{ Path = $list[0]; Paths = $list; Score = -1; VlmDown = $true }
    }
    $bestPath = $list[0]
    $bestScore = -1
    $scored = 0
    foreach ($pth in $list) {
        $s = Test-FaceQuality -ImagePath $pth
        if ($s -ge 0) { $scored++ }
        Write-Host ("  [质检] {0} → {1}" -f (Split-Path $pth -Leaf), $(if ($s -ge 0) { "$s/100" } else { "无分数" })) -ForegroundColor DarkGray
        if ($s -gt $bestScore) { $bestScore = $s; $bestPath = $pth }
    }
    if ($scored -eq 0) {
        Write-Host "  [质检] 全部没拿到分数（视觉模型未就绪/解析失败）→ 降级为多选自选" -ForegroundColor Yellow
        return @{ Path = $list[0]; Paths = $list; Score = -1; VlmDown = $true }
    }
    if ($bestScore -ge 75) {
        Write-Host ("  [质检] 最高分 {0}/100（≥75 过关）" -f $bestScore) -ForegroundColor Green
    } else {
        Write-Host ("  [质检] 最高分仅 {0}/100（<75）——建议换 seed 重出或调提示词" -f $bestScore) -ForegroundColor Yellow
    }
    return @{ Path = $bestPath; Paths = $list; Score = $bestScore; VlmDown = $false }
}

# ===========================================================================
# 出图完成后的「加字」后处理（2026-10-20 用户要求）
#   表单「加字」栏 / -AddText "DeepSeek / 深度求索" → 先按正常流程把图画完（用表单选的档），
#   再由**另一档模型**（默认 Krea2，自动避开生图档）拿**这张成品**做图生图，把字写上去。
#   实测（本机 ComfyUI / Krea2_Q4，768x1024）：
#     · denoise 0.42 → **基本不动，字压根没画上去**（用户报的「文字没有给我」就是这个）
#     · denoise 0.65 → 字写得干净（DeepSeek + 深度求索 都写准，无多余词）
#     · denoise 0.78 → 多画连接词、人物/画风明显漂移
#   所以默认取 0.65（-AddTextDenoise 可调，建议 0.60-0.70）。
#   为什么用 Krea2：本机实测它是唯一能把中文「深度求索」和英文「DeepSeek」同时写准的档。
# ===========================================================================
# ===========================================================================
# 加字位置（用户要求 2026-10-21）：九宫格 + 自由点，两个入口都能定
#   · 对话侧：sd_inject 传 addTextPos（random / 九宫格码 / "x,y"），脚本开始加字时就按它放
#   · 用户侧：参数表「加字位置」行 →「缩略图选位置…」按钮 → 在成品缩略图上随便点/选格
#   位置最终译成英文方位短语塞进加字提示词**前段**；目标文字仍留在提示词**最末尾**（避免虚词被画进图里）。
# ===========================================================================
$script:AddTextZones = @('TL', 'TC', 'TR', 'ML', 'MC', 'MR', 'BL', 'BC', 'BR')
function Get-ZoneLabel {
    param([string]$Zone)
    switch ("$Zone") {
        'TL' { return '左上' } 'TC' { return '上中' } 'TR' { return '右上' }
        'ML' { return '左中' } 'MC' { return '正中' } 'MR' { return '右中' }
        'BL' { return '左下' } 'BC' { return '下中' } 'BR' { return '右下' }
    }
    return '随机'
}
function Get-ZoneNameFromLabel {
    param([string]$Label)
    switch ("$Label") {
        '左上' { return 'TL' } '上中' { return 'TC' } '右上' { return 'TR' }
        '左中' { return 'ML' } '正中' { return 'MC' } '右中' { return 'MR' }
        '左下' { return 'BL' } '下中' { return 'BC' } '右下' { return 'BR' }
    }
    return ''
}
function Get-ZonePhrase {
    param([string]$Zone)
    switch ("$Zone") {
        'TL' { return 'with the title in the top left corner' }
        'TC' { return 'with the title centered along the top edge' }
        'TR' { return 'with the title in the top right corner' }
        'ML' { return 'with the title on the left side, vertically centered' }
        'MC' { return 'with the title right in the middle of the image' }
        'MR' { return 'with the title on the right side, vertically centered' }
        'BL' { return 'with the title in the bottom left corner' }
        'BC' { return 'with the title centered along the bottom edge' }
        'BR' { return 'with the title in the bottom right corner' }
    }
    return ''
}
function Get-ZoneFromPoint {
    param([double]$X, [double]$Y)
    $cx = if ($X -lt 0.34) { 'L' } elseif ($X -lt 0.67) { 'C' } else { 'R' }
    $cy = if ($Y -lt 0.34) { 'T' } elseif ($Y -lt 0.67) { 'M' } else { 'B' }
    return "$cy$cx"
}
# 解析位置规格 → 标准九宫格码（random 会随机挑一格并记进 $script:AddTextPosChosen）
function Resolve-AddTextPos {
    param([string]$Spec = 'random')
    $script:AddTextFreePoint = $null
    $s = "$Spec".Trim()
    $s = $s -replace '^自由点\s*', ''
    if (-not $s -or $s -eq 'random' -or $s -like '随机*') {
        $z = $script:AddTextZones[(Get-Random -Minimum 0 -Maximum $script:AddTextZones.Count)]
        $script:AddTextPosChosen = $z
        Write-Host ("  [加字] 位置=随机 → 本次取「{0}」" -f (Get-ZoneLabel $z)) -ForegroundColor DarkGray
        return $z
    }
    $u = $s.ToUpper()
    if ($script:AddTextZones -contains $u) { $script:AddTextPosChosen = $u; return $u }
    $zh = Get-ZoneNameFromLabel -Label $s
    if ($zh) { $script:AddTextPosChosen = $zh; return $zh }
    if ($s -match '^\s*([0-9]*\.?[0-9]+)\s*[,，]\s*([0-9]*\.?[0-9]+)\s*$') {
        $x = [double]$Matches[1]; $y = [double]$Matches[2]
        if ($x -gt 1) { $x = $x / 100.0 }
        if ($y -gt 1) { $y = $y / 100.0 }
        if ($x -lt 0) { $x = 0 }; if ($x -gt 1) { $x = 1 }
        if ($y -lt 0) { $y = 0 }; if ($y -gt 1) { $y = 1 }
        $z = Get-ZoneFromPoint -X $x -Y $y
        $script:AddTextFreePoint = @{ X = $x; Y = $y }
        $script:AddTextPosChosen = $z
        Write-Host ("  [加字] 位置=自由点 {0},{1} → 归到「{2}」" -f [Math]::Round($x, 2), [Math]::Round($y, 2), (Get-ZoneLabel $z)) -ForegroundColor DarkGray
        return $z
    }
    $script:AddTextPosChosen = 'MC'
    return 'MC'
}
# ---- 字号 / 字体风格（2026-10-21 用户要求：字号和字体风格也要能选）----
$script:AddTextSizeKeys = @('小', '中', '大', '特大')
$script:AddTextStyleKeys = @('粗体无衬线（白）', '细体无衬线', '衬线体', '手写楷体', '霓虹发光', '描边黑体', '中文书法')
function Resolve-AddTextSize {
    param([string]$Spec = '中')
    $s = "$Spec".Trim()
    switch -Regex ($s) {
        '^(小|small|s)$' { return '小' }
        '^(中|medium|m|默认)$' { return '中' }
        '^(大|large|l)$' { return '大' }
        '^(特大|xlarge|xl|巨大)$' { return '特大' }
    }
    return '中'
}
function Resolve-AddTextStyle {
    param([string]$Spec = '粗体无衬线（白）')
    $s = "$Spec".Trim()
    switch -Regex ($s) {
        '^(粗体|粗体无衬线.*|bold|bold-sans|default|默认)$' { return '粗体无衬线（白）' }
        '^(细体|细体无衬线|thin|light)$' { return '细体无衬线' }
        '^(衬线|衬线体|serif)$' { return '衬线体' }
        '^(手写|楷体|手写楷体|hand|handwriting|brush)$' { return '手写楷体' }
        '^(霓虹|霓虹发光|neon|glow)$' { return '霓虹发光' }
        '^(描边|描边黑体|outline|stroked)$' { return '描边黑体' }
        '^(书法|中文书法|毛笔|calligraphy|ink)$' { return '中文书法' }
    }
    if ($script:AddTextStyleKeys -contains $s) { return $s }
    return '粗体无衬线（白）'
}
function Get-SizePhrase {
    param([string]$Size = '中')
    switch (Resolve-AddTextSize -Spec "$Size") {
        # 2026-10-21 实测三轮：
        #   · 'very large poster title size' → 图中央被画出 "Poster"/"Pioster"
        #   · 'massive title'（与风格词的 title 重复出现）→ 被画出 "Tinle"（Title 糊掉）
        # 定稿做法：字号只出一个**形容词**，直接塞进实测定稿的那一段（'crisp white sans-serif title'）
        # 前面 —— 全句只有一个名词 title，结构跟验过的模板一致，不新增短语、不重复名词。
        '小'   { return 'small' }
        '大'   { return 'big' }
        '特大' { return 'huge' }
    }
    return ''      # 中 = 不追加（= 实测定稿模板那一版，逐字不变）
}
function Get-TextStyleWords {
    param([string]$Style = '粗体无衬线（白）')
    switch (Resolve-AddTextStyle -Spec "$Style") {
        '细体无衬线' { return 'thin white sans-serif title' }
        '衬线体'     { return 'elegant white serif title' }
        '手写楷体'   { return 'white handwritten brush title' }
        '霓虹发光'   { return 'glowing neon white sans-serif title' }
        '描边黑体'   { return 'white sans-serif title with a thin dark outline' }
        '中文书法'   { return 'white brush calligraphy title' }
    }
    return 'crisp white sans-serif title'      # 默认（= 定稿模板原文）
}
function Format-AddTextSizeLabel {
    param([string]$Spec = '中')
    return (Resolve-AddTextSize -Spec "$Spec")
}
function Format-AddTextStyleLabel {
    param([string]$Spec = '粗体无衬线（白）')
    return (Resolve-AddTextStyle -Spec "$Spec")
}

# 展示用标签（表单「加字位置」框里显示人话）
function Format-AddTextPosLabel {
    param([string]$Spec = 'random', [string]$Zone = '')
    $s = "$Spec".Trim()
    if ($s -match '^\s*([0-9]*\.?[0-9]+)\s*[,，]\s*([0-9]*\.?[0-9]+)\s*$') {
        $x = [double]$Matches[1]; $y = [double]$Matches[2]
        if ($x -gt 1) { $x = $x / 100.0 }; if ($y -gt 1) { $y = $y / 100.0 }
        return ("自由点 {0},{1}" -f [Math]::Round($x, 2), [Math]::Round($y, 2))
    }
    if (-not $s -or $s -eq 'random' -or $s -like '随机*') {
        if ("$Zone") { return ("随机（本次：{0}）" -f (Get-ZoneLabel $Zone)) }
        return '随机'
    }
    $zh = Get-ZoneNameFromLabel -Label $s
    if ($zh) { return (Get-ZoneLabel $zh) }
    $u = $s.ToUpper()
    if ($script:AddTextZones -contains $u) { return (Get-ZoneLabel $u) }
    return $s
}

function Invoke-AddTextOnImage {
    param(
        [string]$ImagePath,
        [string]$Text,
        [string]$Model = "Krea2_Q4",
        [double]$Denoise = 0.65,
        [string]$OutDir = "",
        [string]$BaseName = "addtext",
        [string]$Pos = 'random',                # 位置：random / 九宫格码 / "x,y"（自由点）
        [string]$Size = '中',                   # 字号：小 / 中 / 大 / 特大
        [string]$Style = '粗体无衬线（白）'         # 字体风格：粗体无衬线（白）/ 细体无衬线 / 衬线体 / 手写楷体 / 霓虹发光 / 描边黑体 / 中文书法
    )
    if (-not $Text -or -not $Text.Trim()) { return $null }
    if (-not $ImagePath -or -not (Test-Path -LiteralPath $ImagePath)) { return $null }
    if ($script:GatewayModels -notcontains $Model) { $Model = "Krea2_Q4" }
    if (-not $OutDir) { $OutDir = Split-Path -Parent $ImagePath }

    $w = 768; $h = 1024; $srcW = 0; $srcH = 0
    try {
        $rs = Get-ImageSizePx -Path $ImagePath
        if ($rs.W -gt 0 -and $rs.H -gt 0) { $w = [int]$rs.W; $h = [int]$rs.H; $srcW = $w; $srcH = $h }
    } catch { }
    $maxSide = Get-ModelMaxSide -Model $Model
    $mx = [Math]::Max($w, $h)
    if ($mx -gt $maxSide) {
        $k2 = [double]$maxSide / $mx
        $w = [int]([Math]::Floor(($w * $k2) / 8) * 8)
        $h = [int]([Math]::Floor(($h * $k2) / 8) * 8)
        Write-Host ("  [加字] 成品 {0}x{1} 超过 {2} 上限 → 缩到 {3}x{4}" -f $srcW, $srcH, $maxSide, $w, $h) -ForegroundColor DarkGray
    }

    # 2026-10-20 实测调参（本机 ComfyUI / Krea2_Q4，底图 768x1024，六轮对比）：
    #   · 要写的字**用双引号括住、并放到提示词最末尾**（"… exact text: "文字""）——
    #     把字夹在散文中间时，紧邻的虚词会被一起画进图里（实测画进过 `as a`、`the`、末尾一个逗号）。
    #   · 负面补 textless / blank poster / no typography —— 逼模型必须把字写出来（写不出字才算失败）。
    #   · 与 -AddTextDenoise 0.65 配对：DeepSeek 与 深度求索 都写准、无外溢（0.42 完全不写，0.78 会多画连接词）。
    # 位置（2026-10-21 用户要求）：方位短语放**前段**，目标文字仍留**最末尾**（虚词外溢的教训）
    $zone = Resolve-AddTextPos -Spec "$Pos"
    $zonePhrase = Get-ZonePhrase -Zone $zone
    $posPrefix = 'add large bold clean typography onto this image'
    if ($zonePhrase) { $posPrefix = $posPrefix + ', ' + $zonePhrase }
    $sizeKey = Resolve-AddTextSize -Spec "$Size"
    $styleKey = Resolve-AddTextStyle -Spec "$Style"
    $sizeAdj = Get-SizePhrase -Size $sizeKey      # 只出形容词（中 = 空）
    Write-Host ("  [加字] 字号：{0}　字体风格：{1}" -f $sizeKey, $styleKey) -ForegroundColor DarkGray
    if ($script:AddTextFreePoint) {
        $posPrefix = $posPrefix + (", title anchored about {0}% from the left and {1}% from the top" -f [int]([Math]::Round($script:AddTextFreePoint.X * 100)), [int]([Math]::Round($script:AddTextFreePoint.Y * 100)))
    }
    Write-Host ("  [加字] 位置：{0}" -f (Get-ZoneLabel $zone)) -ForegroundColor DarkGray
    $styleSeg = (Get-TextStyleWords -Style $styleKey)
    if ($sizeAdj) { $styleSeg = "$sizeAdj $styleSeg" }
    $pos = $posPrefix + ', ' + $styleSeg + ", strong contrast, correct spelling, sharp legible letters, high quality poster design, exact text: " + [char]34 + $Text + [char]34
    $neg = "textless, blank poster, no typography, garbled letters, misspelled words, blurry text, distorted characters, changed face, different character, extra limbs, lowres, watermark"
    Write-Host ("  [加字] {0} 在成品上加字：{1}（denoise={2}）" -f $Model, $Text, $Denoise) -ForegroundColor Cyan
    # 步数（2026-10-21 加速）：默认取「该档默认步数」与 16 的较小者；-AddTextSteps 可显式覆盖。
    #   实测（Krea2_Q4 / 768x1024 / denoise 0.65，同一底图同一提示词）：24 步 153s、16 步 105s、12 步 81s，
    #   三档用本机视觉模型逐字核对**都只写出目标文字**，故默认砍到 16。
    $stepsForText = if ($AddTextSteps -gt 0) { $AddTextSteps } else { [Math]::Min((Get-ModelSteps -Model $Model), 16) }
    Write-Host ("  [加字] 步数={0}（该档默认 {1}）" -f $stepsForText, (Get-ModelSteps -Model $Model)) -ForegroundColor DarkGray
    $sub = New-GatewayTask -Model $Model -Prompt $pos -Negative $neg -Width $w -Height $h -Steps $stepsForText -Cfg (Get-ModelCfg -Model $Model) -Denoise $Denoise -InitImage $ImagePath -Name $BaseName -OutDir $OutDir
    if (-not $sub.Ok) { Write-Host ("  [加字] 提交失败：" + $sub.Message) -ForegroundColor Yellow; return $null }
    $wr = Wait-GatewayTask -TaskId $sub.TaskId -TimeoutSec 3600
    if (-not $wr.Ok) { Write-Host ("  [加字] 失败：[{0}] {1}" -f $wr.Status, $wr.Message) -ForegroundColor Yellow; return $null }
    $paths = @($wr.Raw.paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
    if ($paths.Count -eq 0) { Write-Host "  [加字] 网关返回成功但没有可用文件" -ForegroundColor Yellow; return $null }
    Write-Host ("  [加字] 完成：" + $paths[0]) -ForegroundColor Green
    return $paths[0]
}
# 找 python（2026-10-21 适配）：py 启动器 → python → python3 → SD 目录自带 → 常见安装路径。
#   找不到就返回空（调用方跳过 Python 后处理，绝不中断）。
function Get-PythonExe {
    if ($script:PyExe -ne $null) { return $script:PyExe }
    $script:PyExe = ''
    foreach ($c in @('py', 'python', 'python3')) {
        try {
            $cmd = Get-Command $c -ErrorAction SilentlyContinue
            if ($cmd -and $cmd.Source) { $script:PyExe = $cmd.Source; break }
        } catch { }
    }
    if (-not $script:PyExe) {
        $cands = @()
        if ($SdDir) { $cands += (Join-Path $SdDir 'python\python.exe') }
        if ($script:Root) { $cands += (Join-Path (Split-Path -Parent $script:Root) 'python\python.exe') }
        if ($env:USERPROFILE) { $cands += (Join-Path $env:USERPROFILE 'AppData\Local\Programs\Python\Python313\python.exe') }
        $cands += 'D:\SD.4.8\python\python.exe'
        foreach ($p in $cands) { if ($p -and (Test-Path -LiteralPath $p)) { $script:PyExe = $p; break } }
    }
    return $script:PyExe
}

# 加字档位选择（用户要求 2026-10-20）：**固定与生图那一档不同** —— 生图用表单选的档，加字用另一档。
function Resolve-AddTextModel {
    param([string]$Requested = "", [string]$GenModel = "")
    $cands = @()
    if ($Requested -and ($Requested -notlike '自动*')) { $cands += $Requested }
    foreach ($c in @('Krea2_Q4', 'QwenImage_NVFP4', 'SD_FP16', 'Anima_INT8')) {
        if ($cands -notcontains $c) { $cands += $c }
    }
    foreach ($c in $cands) {
        if ($script:GatewayModels -notcontains $c) { continue }
        if ($GenModel -and $c -eq $GenModel) { continue }
        return $c
    }
    if ($cands.Count -gt 0) { return $cands[0] }
    return 'Krea2_Q4'
}

# 统一「加字」收尾：任何成功出口都调它，返回最终成品路径。
# 根因修复（2026-10-20）：以前加字只写在「最终出图」那一条分支里，而「追加为空 → 直接收尾」
# 那条捷径是**直接 exit 0** 的，把加字整段跳过去了 —— 用户拿到的图自然没有字。
function Invoke-AddTextStage {
    param(
        [string]$Path,
        [string]$BaseName = "",
        [string]$Text = "",
        [string]$Model = "",
        [string]$GenModel = "",
        [string]$OutDirPath = "",
        [string]$Pos = 'random',          # 加字位置（random / 九宫格码 / "x,y"）
        [string]$Size = '中',             # 字号（小 / 中 / 大 / 特大）
        [string]$Style = '粗体无衬线（白）'   # 字体风格
    )
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $Path }
    if (-not $Text -or -not $Text.Trim()) { return $Path }
    if (-not $BaseName) { $BaseName = [IO.Path]::GetFileNameWithoutExtension($Path) }
    $useModel = Resolve-AddTextModel -Requested $Model -GenModel $GenModel
    Write-Host ""
    Write-Host ("=== 加字：生图档 {0} → 加字档 {1}（另一档） ===" -f $(if ($GenModel) { $GenModel } else { '(表单未指定)' }), $useModel) -ForegroundColor Cyan
    if ($GenModel -and $useModel -eq $GenModel) {
        Write-Host "（提示：本机可用的档里没有别的选择，加字只能仍在同一档上做）" -ForegroundColor Yellow
    }
    $outDirForText = if ($OutDirPath) { $OutDirPath } else { $OutDir }
    Write-Host ("  位置：{0}　字号：{1}　风格：{2}" -f (Format-AddTextPosLabel -Spec "$Pos"), (Format-AddTextSizeLabel -Spec "$Size"), (Format-AddTextStyleLabel -Spec "$Style")) -ForegroundColor DarkGray
    $added = Invoke-AddTextOnImage -ImagePath $Path -Text $Text.Trim() -Model $useModel -Denoise $AddTextDenoise -OutDir $outDirForText -BaseName $BaseName -Pos "$Pos" -Size "$Size" -Style "$Style"
    if (-not $added) {
        Write-Host "加字未成功，保留原成品（未加字）。" -ForegroundColor Yellow
        return $Path
    }
    $textPath = Get-UniqueOutPath -BaseName ($BaseName + "_文字")
    # 根因修复（2026-10-21 用户反馈）：AI 加字 = 另一档模型对成品做高幅度 img2img，
    #   实测**整张 93% 像素被重画**（diffRatio 0.9314）→ 用户要的画风/提示词符合度被洗掉，
    #   观感就是「它拿我的成品重画了一遍，而不是按我的提示词出图」。
    #   现在：**AI 只负责写出那行字**，然后只把「文字所在的那一块」贴回原图，
    #   框外像素级保持原图不变（实测框外变化 3%、整图变化从 93% 降到 22%）。
    #   要完整 AI 重绘版（旧行为）加 -NoAddTextKeepBase。
    if (-not $NoAddTextKeepBase) {
        $compOut = Get-UniqueOutPath -BaseName ($BaseName + "_文字")
        # 脚本位置多候选（2026-10-21：$script:Root 曾被同名循环变量覆盖过 → 不把宝押在一个变量上）
        $compCands = @()
        try { if ($PSScriptRoot) { $compCands += (Join-Path $PSScriptRoot 'sd-addtext-composite.py') } } catch { }
        try { if ($script:Root) { $compCands += (Join-Path $script:Root 'sd-addtext-composite.py') } } catch { }
        try { if ($script:SdRoot) { $compCands += (Join-Path $script:SdRoot 'sd-addtext-composite.py') } } catch { }
        try { if ($OutDir) { $compCands += (Join-Path (Split-Path -Parent $OutDir) 'sd-addtext-composite.py') } } catch { }
        $compPy = ''
        foreach ($cc in ($compCands | Select-Object -Unique)) { if ($cc -and (Test-Path -LiteralPath $cc)) { $compPy = $cc; break } }
        if (-not $compPy) { $compPy = if (@($compCands).Count -gt 0) { @($compCands)[0] } else { 'sd-addtext-composite.py' } }
        $py = Get-PythonExe
        $compHave = (Test-Path -LiteralPath $compPy)
        if (-not ($compHave -and $py)) {
            # 不再静默跳过：缺脚本/缺 python 都要说清楚（2026-10-21：静默跳过害得排查半天）
            Write-Host ("  [加字] 跳过区域合成 → 用整张 AI 版。脚本=$compPy（存在={0}）　python=（{1}）" -f $compHave, $(if ($py) { $py } else { '没找到' })) -ForegroundColor DarkYellow
        }
        if ($compHave -and $py) {
            Write-Host "  [加字] 合成：只把文字那块贴上，画面其余部分保持原图不动…" -ForegroundColor DarkGray
            # 注意：`& $py @args` 是**逐参传递**，不要再手工套引号（套了 python 会把引号当文件名的一部分 → 打不开脚本）
            $pyArgs = @($compPy, '--base', $Path, '--texted', $added, '--out', $compOut, '--pos', "$Pos", '--size', "$Size")
            if ($Style) { $pyArgs += @('--style', "$Style") }
            $compJson = ''
            try {
                $compJson = (& $py @pyArgs 2>&1 | Out-String)
                $okLine = @($compJson -split "`r?`n" | Where-Object { $_ -match '^\{' } | Select-Object -Last 1)
                if ($okLine) {
                    $o = $okLine | ConvertFrom-Json
                    if ($o.ok) {
                        Write-Host ("  [加字] 合成完成：框内变化 {0:P1} · 框外变化 {1:P1}（框外越小越保画面）" -f $o.inside_changed_ratio, $o.outside_changed_ratio) -ForegroundColor Green
                    } else {
                        Write-Host ("  [加字] 合成失败（{0}）→ 退回整张 AI 版" -f $o.error) -ForegroundColor Yellow
                        $compOut = ''
                    }
                } else {
                    Write-Host ('  [加字] 合成没返回 JSON → 退回整张 AI 版（原始输出：' + ($compJson.Trim() -replace "`r?`n", ' | ') + '）') -ForegroundColor Yellow
                    $compOut = ''
                }
            } catch {
                Write-Host ("  [加字] 合成异常（{0}）→ 退回整张 AI 版" -f $_.Exception.Message) -ForegroundColor Yellow
                $compOut = ''
            }
            if ($compOut -and (Test-Path -LiteralPath $compOut)) {
                # AI 原版也留一份（不阉功能：想用整张 AI 版随时可取）
                $aiKeep = Join-Path (Split-Path $textPath -Parent) (([IO.Path]::GetFileNameWithoutExtension($textPath)) + '_AI.png')
                try { Copy-Item -LiteralPath $added -Destination $aiKeep -Force } catch { }
                try {
                    Copy-Item -LiteralPath $compOut -Destination $textPath -Force
                    Write-Host "加字成品: $textPath（原图保留：$Path；整张 AI 版另存：$(Split-Path $aiKeep -Leaf)）" -ForegroundColor Green
                    return $textPath
                } catch {
                    Write-Host ("加字成品另存失败：" + $_.Exception.Message) -ForegroundColor Yellow
                    return $Path
                }
            }
        }
    }
    try {
        Copy-Item -LiteralPath $added -Destination $textPath -Force
    } catch {
        Write-Host ("加字成品另存失败：" + $_.Exception.Message) -ForegroundColor Yellow
        return $Path
    }
    Write-Host "加字成品: $textPath（原图保留：$Path）" -ForegroundColor Green
    return $textPath
}

# ===========================================================================
# 「加字位置」缩略图选位器（用户要求 2026-10-21）
#   右侧 = 成品缩略图：**点哪儿就把字的锚点放哪儿**（画出标记 + 文字预览，实时刷新）
#   左侧 = 九宫格快选 / 随机 / 位置读数。返回 'random' / 九宫格码 / "x,y"；取消返回 $null（= 不改）。
# ===========================================================================
function Show-TextPosPicker {
    param(
        [string]$ImagePath = '',
        [string]$Text = '',
        [string]$Current = 'random',
        [string]$Size = '中',
        [string]$Style = '粗体无衬线（白）'
    )
    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = '加字位置 · 右侧缩略图点选（或左侧九宫格）'
    $dlgW = 1010; $dlgH = 650
    try {
        $wa1 = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        if ($wa1.Width -gt 200 -and $dlgW -gt ($wa1.Width - 20)) { $dlgW = [int]($wa1.Width - 20) }
        if ($wa1.Height -gt 200 -and $dlgH -gt ($wa1.Height - 20)) { $dlgH = [int]($wa1.Height - 20); $dlg.AutoScroll = $true }
    } catch { }
    $dlg.ClientSize = New-Object System.Drawing.Size($dlgW, $dlgH)
    $dlg.FormBorderStyle = 'Sizable'
    $dlg.StartPosition = 'CenterScreen'
    $dlg.TopMost = $true
    $dlg.MinimizeBox = $false
    $dlg.MaximizeBox = $true

    $script:PosPickZone = ''
    $script:PosPickPoint = $null
    $script:PosPickRandom = $false
    $script:PosPickResult = $null
    $script:PosPickOffsetX = 0
    $script:PosPickOffsetY = 0
    $script:PosPickImgW = 1
    $script:PosPickImgH = 1

    $lbTip = New-Object System.Windows.Forms.Label
    $lbTip.Text = '加字位置：在右侧图片上点任意处 = 自由点；或点下面的九宫格 / 随机'
    $lbTip.SetBounds(16, 10, 430, 20)
    $dlg.Controls.Add($lbTip)

    $lbRead = New-Object System.Windows.Forms.Label
    $lbRead.Name = 'lbAddTextPosRead'
    $lbRead.Text = ''
    $lbRead.SetBounds(16, 34, 430, 22)
    $lbRead.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 9, [System.Drawing.FontStyle]::Bold)
    $dlg.Controls.Add($lbRead)

    # 字号 / 字体风格（用户要求 2026-10-21）
    $script:PosPickSize = (Resolve-AddTextSize -Spec "$Size")
    $script:PosPickStyle = (Resolve-AddTextStyle -Spec "$Style")

    $lbSize = New-Object System.Windows.Forms.Label
    $lbSize.Text = '字号：'
    $lbSize.SetBounds(16, 66, 52, 22)
    $dlg.Controls.Add($lbSize)

    $cboSize = New-Object System.Windows.Forms.ComboBox
    $cboSize.DropDownStyle = 'DropDownList'
    $cboSize.Name = 'cboPosSize'
    $cboSize.AccessibleName = 'cboPosSize'
    foreach ($sk in $script:AddTextSizeKeys) { $null = $cboSize.Items.Add($sk) }
    $cboSize.SelectedItem = $script:PosPickSize
    $cboSize.SetBounds(70, 64, 96, 24)
    $cboSize.Add_SelectedIndexChanged({ try { $script:PosPickSize = "$($cboSize.SelectedItem)"; & $updatePreview } catch { } })
    $dlg.Controls.Add($cboSize)

    $lbStyle = New-Object System.Windows.Forms.Label
    $lbStyle.Text = '字体风格：'
    $lbStyle.SetBounds(178, 66, 72, 22)
    $dlg.Controls.Add($lbStyle)

    $cboStyle = New-Object System.Windows.Forms.ComboBox
    $cboStyle.DropDownStyle = 'DropDownList'
    $cboStyle.Name = 'cboPosStyle'
    $cboStyle.AccessibleName = 'cboPosStyle'
    foreach ($tk in $script:AddTextStyleKeys) { $null = $cboStyle.Items.Add($tk) }
    $cboStyle.SelectedItem = $script:PosPickStyle
    $cboStyle.SetBounds(254, 64, 190, 24)
    $cboStyle.Add_SelectedIndexChanged({ try { $script:PosPickStyle = "$($cboStyle.SelectedItem)"; & $updatePreview } catch { } })
    $dlg.Controls.Add($cboStyle)

    $pb = New-Object System.Windows.Forms.PictureBox
    $pb.Name = 'pbPosPreview'
    $pb.AccessibleName = 'pbPosPreview'
    $pb.SizeMode = 'CenterImage'
    $pb.BackColor = [System.Drawing.Color]::FromArgb(24, 26, 32)
    $pb.SetBounds(456, 10, 540, 600)
    $pb.Cursor = [System.Windows.Forms.Cursors]::Cross
    $dlg.Controls.Add($pb)

    $scaled = New-Object System.Drawing.Bitmap -ArgumentList @(1, 1)
    if ($ImagePath -and (Test-Path -LiteralPath $ImagePath)) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($ImagePath)
            $ms = New-Object System.IO.MemoryStream
            $ms.Write($bytes, 0, $bytes.Length)
            $ms.Position = 0
            $srcImg = [System.Drawing.Image]::FromStream($ms)
            $k = [Math]::Min((540.0 / $srcImg.Width), (600.0 / $srcImg.Height))
            if ($k -gt 1) { $k = 1 }
            $w = [int]([Math]::Max(1, [Math]::Floor($srcImg.Width * $k)))
            $h = [int]([Math]::Max(1, [Math]::Floor($srcImg.Height * $k)))
            $scaled = New-Object System.Drawing.Bitmap -ArgumentList @($w, $h)
            $g0 = [System.Drawing.Graphics]::FromImage($scaled)
            $g0.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g0.DrawImage($srcImg, 0, 0, $w, $h)
            $g0.Dispose()
            $srcImg.Dispose()
            $ms.Dispose()
            $script:PosPickOffsetX = [int](($pb.Width - $w) / 2)
            $script:PosPickOffsetY = [int](($pb.Height - $h) / 2)
            $script:PosPickImgW = $w
            $script:PosPickImgH = $h
        } catch { }
    } else {
        $scaled = New-Object System.Drawing.Bitmap -ArgumentList @(540, 600)
        $g0 = [System.Drawing.Graphics]::FromImage($scaled)
        $g0.Clear([System.Drawing.Color]::FromArgb(40, 44, 52))
        $f0 = New-Object System.Drawing.Font((Get-UiFontFamily), 12)
        $b0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 210, 225))
        $g0.DrawString('还没有成品图（预生成没出图）`r`n位置照样能选，出图时就按这个位置加字', $f0, $b0, 30, 60)
        $f0.Dispose(); $b0.Dispose(); $g0.Dispose()
        $script:PosPickImgW = 540
        $script:PosPickImgH = 600
    }
    $pb.Image = $scaled

    $updatePreview = {
        try {
            $W = $script:PosPickImgW; $H = $script:PosPickImgH
            $bmp = New-Object System.Drawing.Bitmap -ArgumentList @($W, $H)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.DrawImage($scaled, 0, 0, $W, $H)
            $zone = $script:PosPickZone
            $pt = $script:PosPickPoint
            $rx = 0.25; $ry = 0.40; $rw = 0.50; $rh = 0.20; $al = 'Center'
            $zoneRects = @{
                'TL' = @(0.05, 0.06, 0.55, 0.22, 'Near');   'TC' = @(0.20, 0.06, 0.60, 0.18, 'Center'); 'TR' = @(0.40, 0.06, 0.55, 0.22, 'Far')
                'ML' = @(0.05, 0.39, 0.50, 0.22, 'Near');   'MC' = @(0.25, 0.40, 0.50, 0.20, 'Center'); 'MR' = @(0.45, 0.39, 0.50, 0.22, 'Far')
                'BL' = @(0.05, 0.72, 0.55, 0.22, 'Near');   'BC' = @(0.20, 0.76, 0.60, 0.18, 'Center'); 'BR' = @(0.40, 0.72, 0.55, 0.22, 'Far')
            }
            if ($pt) {
                $rw = 0.60; $rh = 0.20
                $rx = $pt.X - $rw / 2; $ry = $pt.Y - $rh / 2
                $al = 'Center'
            } elseif ($zone -and $zoneRects.ContainsKey($zone)) {
                $r0 = $zoneRects[$zone]
                $rx = $r0[0]; $ry = $r0[1]; $rw = $r0[2]; $rh = $r0[3]; $al = $r0[4]
            }
            $bx = [int]($rx * $W); $by = [int]($ry * $H); $bw = [int]($rw * $W); $bh = [int]($rh * $H)
            if ($bx -lt 0) { $bx = 0 }
            if ($by -lt 0) { $by = 0 }
            if ($bx + $bw -gt $W) { $bw = $W - $bx }
            if ($by + $bh -gt $H) { $bh = $H - $by }
            $box = New-Object System.Drawing.Rectangle -ArgumentList @($bx, $by, $bw, $bh)
            $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(135, 255, 255, 255))
            $g.FillRectangle($fill, $box)
            $txt = if ("$Text" -and "$Text".Trim()) { "$Text" } else { 'DeepSeek / 深度求索' }
            $frac = 0.055
            switch ("$($script:PosPickSize)") {
                '小'   { $frac = 0.035 }
                '大'   { $frac = 0.075 }
                '特大' { $frac = 0.100 }
            }
            $fam = (Get-UiFontFamily)
            $fst = [System.Drawing.FontStyle]::Bold
            switch ("$($script:PosPickStyle)") {
                '细体无衬线' { $fst = [System.Drawing.FontStyle]::Regular }
                '衬线体'     { $fam = (Resolve-FontFamily -Prefer @('SimSun', '宋体', 'Times New Roman', 'Georgia')); $fst = [System.Drawing.FontStyle]::Regular }
                '手写楷体'   { $fam = (Resolve-FontFamily -Prefer @('KaiTi', '楷体', 'STKaiti', 'SimSun')); $fst = [System.Drawing.FontStyle]::Regular }
                '中文书法'   { $fam = (Resolve-FontFamily -Prefer @('KaiTi', '楷体', 'STXingkai', 'SimSun')); $fst = [System.Drawing.FontStyle]::Bold }
            }
            $fs = [Math]::Max(11, [int]($H * $frac))
            # 自动缩到「最多两行」：特大字号塞进小框会溢出，预览就没法看（真实排版由模型决定）
            for ($try = 1; $try -le 12; $try++) {
                $perLine = [Math]::Max(1, [int](($bw - 14) / ($fs * 0.72)))
                $linesNeed = [int][Math]::Ceiling(([Math]::Max(1, $txt.Length)) / [double]$perLine)
                if ($linesNeed -le 2) { break }
                $fs = [int]($fs * 0.88)
                if ($fs -le 11) { $fs = 11; break }
            }
            $font = New-Object System.Drawing.Font($fam, $fs, $fst, [System.Drawing.GraphicsUnit]::Pixel)
            $sf = New-Object System.Drawing.StringFormat
            if ($al -eq 'Near') { $sf.Alignment = [System.Drawing.StringAlignment]::Near }
            elseif ($al -eq 'Far') { $sf.Alignment = [System.Drawing.StringAlignment]::Far }
            else { $sf.Alignment = [System.Drawing.StringAlignment]::Center }
            $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
            $rf = New-Object System.Drawing.RectangleF -ArgumentList @([single]($bx + 6), [single]$by, [single]([Math]::Max(1, $bw - 12)), [single]$bh)
            # 预览示意（真实效果由模型决定，这里表达「选的是哪一种」）：白字 + 阴影 / 霓虹光晕 / 深色描边
            $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
            $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(190, 12, 14, 20))
            if ("$($script:PosPickStyle)" -eq '霓虹发光') {
                $glow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(60, 130, 225, 255))
                foreach ($o in @(4, 8, 12)) {
                    $g.DrawString($txt, $font, $glow, (New-Object System.Drawing.RectangleF -ArgumentList @([single]($rf.X - $o), [single]$rf.Y, [single]$rf.Width, [single]$rf.Height)), $sf)
                    $g.DrawString($txt, $font, $glow, (New-Object System.Drawing.RectangleF -ArgumentList @([single]($rf.X + $o), [single]$rf.Y, [single]$rf.Width, [single]$rf.Height)), $sf)
                    $g.DrawString($txt, $font, $glow, (New-Object System.Drawing.RectangleF -ArgumentList @([single]$rf.X, [single]($rf.Y - $o), [single]$rf.Width, [single]$rf.Height)), $sf)
                    $g.DrawString($txt, $font, $glow, (New-Object System.Drawing.RectangleF -ArgumentList @([single]$rf.X, [single]($rf.Y + $o), [single]$rf.Width, [single]$rf.Height)), $sf)
                }
                $glow.Dispose()
                $g.DrawString($txt, $font, $white, $rf, $sf)
            } elseif ("$($script:PosPickStyle)" -eq '描边黑体') {
                $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
                $gp.AddString($txt, $font.FontFamily, [int]$font.Style, $fs, $rf, $sf)
                $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 12, 14, 20), [single]([Math]::Max(2, $fs * 0.12)))
                $g.DrawPath($pen, $gp)
                $g.FillPath($white, $gp)
                $pen.Dispose()
                $gp.Dispose()
            } else {
                $g.DrawString($txt, $font, $shadow, (New-Object System.Drawing.RectangleF -ArgumentList @([single]($rf.X + 2), [single]($rf.Y + 2), [single]$rf.Width, [single]$rf.Height)), $sf)
                $g.DrawString($txt, $font, $white, $rf, $sf)
            }
            $white.Dispose()
            $shadow.Dispose()
            if ($pt) {
                $cx = [int]($pt.X * $W); $cy = [int]($pt.Y * $H)
                $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(235, 255, 70, 70), 2)
                $g.DrawLine($pen, ($cx - 16), $cy, ($cx + 16), $cy)
                $g.DrawLine($pen, $cx, ($cy - 16), $cx, ($cy + 16))
                $pen.Dispose()
            }
            $font.Dispose(); $fill.Dispose(); $sf.Dispose()
            $g.Dispose()
            $pb.Image = $bmp
        } catch { }
    }

    $setDisp = {
        if ($script:PosPickPoint) {
            $lbRead.Text = ('自由点  {0},{1}   （左起 {2}% / 上起 {3}%）' -f [Math]::Round($script:PosPickPoint.X, 2), [Math]::Round($script:PosPickPoint.Y, 2), [int]([Math]::Round($script:PosPickPoint.X * 100)), [int]([Math]::Round($script:PosPickPoint.Y * 100)))
        } elseif ($script:PosPickRandom) {
            $lbRead.Text = '随机（脚本开始时随机挑一格）'
        } elseif ($script:PosPickZone) {
            $lbRead.Text = ('九宫格：' + (Get-ZoneLabel $script:PosPickZone))
        } else {
            $lbRead.Text = '（还没选）'
        }
    }

    $zoneDefs = @(
        @('TL', '左上'), @('TC', '上中'), @('TR', '右上'),
        @('ML', '左中'), @('MC', '正中'), @('MR', '右中'),
        @('BL', '左下'), @('BC', '下中'), @('BR', '右下')
    )
    $i = 0
    foreach ($zd in $zoneDefs) {
        $b = New-Object System.Windows.Forms.Button
        $b.Text = $zd[1]
        $b.Tag = $zd[0]
        $b.Name = 'btnPos' + $zd[0]
        $b.AccessibleName = 'btnPos' + $zd[0]
        $col = $i % 3; $row = [int][Math]::Floor($i / 3)
        $b.SetBounds((16 + $col * 142), (104 + $row * 42), 134, 36)
        $b.Add_Click({
            try {
                $script:PosPickZone = "$($this.Tag)"
                $script:PosPickPoint = $null
                $script:PosPickRandom = $false
                & $setDisp
                & $updatePreview
            } catch { }
        })
        $dlg.Controls.Add($b)
        $i++
    }

    $btnRand = New-Object System.Windows.Forms.Button
    $btnRand.Text = '随机（每次不同）'
    $btnRand.Name = 'btnPosRandom'
    $btnRand.AccessibleName = 'btnPosRandom'
    $btnRand.SetBounds(16, 234, 276, 36)
    $btnRand.Add_Click({
        $script:PosPickRandom = $true
        $script:PosPickPoint = $null
        $script:PosPickZone = ''
        & $setDisp
        & $updatePreview
    })
    $dlg.Controls.Add($btnRand)

    $lbHint2 = New-Object System.Windows.Forms.Label
    $lbHint2.Text = '自由点：直接在右侧图上点（点完会画红叉 + 文字预览）；想改就再点一次。'
    $lbHint2.Font = New-Object System.Drawing.Font((Get-UiFontFamily), 8)
    $lbHint2.ForeColor = [System.Drawing.Color]::Gray
    $lbHint2.SetBounds(16, 280, 420, 44)
    $dlg.Controls.Add($lbHint2)

    $pb.Add_Click({
        try {
            $mp = [System.Windows.Forms.Cursor]::Position
            $client = $pb.PointToClient((New-Object System.Drawing.Point -ArgumentList @($mp.X, $mp.Y)))
            $ix = $client.X - $script:PosPickOffsetX
            $iy = $client.Y - $script:PosPickOffsetY
            if ($ix -lt 0 -or $iy -lt 0 -or $ix -gt $script:PosPickImgW -or $iy -gt $script:PosPickImgH) { return }
            $script:PosPickPoint = @{ X = [Math]::Round($ix / [double]$script:PosPickImgW, 3); Y = [Math]::Round($iy / [double]$script:PosPickImgH, 3) }
            $script:PosPickZone = ''
            $script:PosPickRandom = $false
            & $setDisp
            & $updatePreview
        } catch { }
    })

    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = '用这个位置'
    $btnOk.Name = 'btnPosOk'
    $btnOk.AccessibleName = 'btnPosOk'
    $btnOk.SetBounds(16, 332, 276, 44)
    $btnOk.Add_Click({
        $posVal = ''
        if ($script:PosPickPoint) {
            $posVal = ('{0},{1}' -f $script:PosPickPoint.X, $script:PosPickPoint.Y)
        } elseif ($script:PosPickRandom) {
            $posVal = 'random'
        } elseif ($script:PosPickZone) {
            $posVal = $script:PosPickZone
        } else {
            [System.Windows.Forms.MessageBox]::Show('还没选位置：点九宫格、或点随机、或在右侧图上点一下。', '加字位置', 'OK', 'Information') | Out-Null
            return
        }
        $script:PosPickResult = @{
            Pos   = $posVal
            Size  = "$($script:PosPickSize)"
            Style = "$($script:PosPickStyle)"
        }
        $dlg.Close()
    })
    $dlg.Controls.Add($btnOk)

    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = '取消'
    $btnCancel.Name = 'btnPosCancel'
    $btnCancel.AccessibleName = 'btnPosCancel'
    $btnCancel.SetBounds(304, 332, 118, 44)   # 2026-10-21 修：原来从 160 开始宽 132，与「用这个位置」(16..292) 重叠 → 点取消会误触确定
    $btnCancel.Add_Click({ $script:PosPickResult = $null; $dlg.Close() })
    $dlg.Controls.Add($btnCancel)
    $dlg.AcceptButton = $btnOk      # 回车 = 用这个位置
    $dlg.CancelButton = $btnCancel  # Esc  = 取消（2026-10-21：顺手也方便键鼠自动化）

    # 初值：把当前规格读进来看
    $specNow = "$Current".Trim()
    if ($specNow -match '^\s*([0-9]*\.?[0-9]+)\s*[,，]\s*([0-9]*\.?[0-9]+)\s*$') {
        $script:PosPickPoint = @{ X = [double]$Matches[1]; Y = [double]$Matches[2] }
    } elseif ($specNow -like '随机*' -or -not $specNow) {
        $script:PosPickRandom = $true
    } else {
        $u = $specNow.ToUpper()
        $zh = Get-ZoneNameFromLabel -Label $specNow
        if ($script:AddTextZones -contains $u) { $script:PosPickZone = $u }
        elseif ($zh) { $script:PosPickZone = $zh }
    }
    & $setDisp
    & $updatePreview

    # 自检/排障钩子（2026-10-21）：设了 SD_POS_PICKER_DUMP 就不弹窗，把预览图存盘后返回 'DIAG'。
    #   真机排障用（插件/键鼠自检会用到）；正常运行时该环境变量不存在，行为不变。
    if ($env:SD_POS_PICKER_DUMP) {
        try {
            if ($pb.Image) { $pb.Image.Save($env:SD_POS_PICKER_DUMP, [System.Drawing.Imaging.ImageFormat]::Png) }
            Write-Host ('[选位器] 诊断导出：' + $env:SD_POS_PICKER_DUMP)
            Write-Host ('[选位器] 控件：九宫格 9 个 + 随机 + 用这个位置 + 取消 + 缩略图 ' + $script:PosPickImgW + 'x' + $script:PosPickImgH + '（偏移 ' + $script:PosPickOffsetX + ',' + $script:PosPickOffsetY + '）')
            Write-Host ('[选位器] 当前规格：' + (Format-AddTextPosLabel -Spec "$Current"))
        } catch {
            Write-Host ('[选位器] 诊断导出失败：' + $_.Exception.Message) -ForegroundColor Yellow
        }
        try { $dlg.Dispose() } catch { }
        return 'DIAG'
    }

    $null = $dlg.ShowDialog()
    $res = $script:PosPickResult
    try { $dlg.Dispose() } catch { }
    return $res
}

function Show-ImagePicker {
    param([string[]]$Images)
    if (-not $Images -or $Images.Count -eq 0) { return @() }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "质检模型未就绪 · 请选择要保留的图片（勾选 = 保留）"
    $form.ClientSize = New-Object System.Drawing.Size(720, 520)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'Sizable'
    $form.MinimizeBox = $true
    $form.MaximizeBox = $true
    $form.TopMost = $true

    # 左侧：文件名勾选列表（纯文本，不依赖缩略图加载，从根上杜绝白屏）
    $clb = New-Object System.Windows.Forms.CheckedListBox
    $clb.CheckOnClick = $true
    $clb.IntegralHeight = $false
    $clb.SetBounds(12, 12, 300, 460)
    $clb.Font = New-Object System.Drawing.Font('Microsoft YaHei', 9)
    foreach ($src in $Images) {
        $idx = $clb.Items.Add((Split-Path $src -Leaf))
        $clb.SetItemChecked($idx, $true)   # 默认全选
    }
    $form.Controls.Add($clb)

    # 右侧：选中项预览（加载失败就显示灰色占位，不影响左侧列表）
    $pic = New-Object System.Windows.Forms.PictureBox
    $pic.SetBounds(324, 12, 380, 400)
    $pic.SizeMode = 'Zoom'
    $pic.BackColor = [System.Drawing.Color]::FromArgb(40, 40, 46)
    $pic.BorderStyle = 'FixedSingle'
    $form.Controls.Add($pic)

    # 选中变化 → 刷新预览（用脚本作用域数组按索引取路径；缩略图加载失败静默跳过）
    $script:pickerPaths = @($Images)
    $clb.Add_SelectedIndexChanged({
        $i = $clb.SelectedIndex
        if ($i -ge 0 -and $script:pickerPaths[$i]) {
            $srcPath = $script:pickerPaths[$i]
            try {
                if (Test-Path -LiteralPath $srcPath) {
                    $img = [System.Drawing.Image]::FromFile($srcPath)
                    try { $pic.Image = New-Object System.Drawing.Bitmap($img) }
                    finally { $img.Dispose() }
                }
            } catch { $pic.Image = $null }
        }
    })
    # 默认选中第一张并出预览
    if ($clb.Items.Count -gt 0) { $clb.SelectedIndex = 0 }

    $pnl = New-Object System.Windows.Forms.Panel
    $pnl.Dock = 'Bottom'
    $pnl.Height = 46
    $pnl.Padding = New-Object System.Windows.Forms.Padding(8, 8, 8, 8)
    $form.Controls.Add($pnl)

    $btnAll = New-Object System.Windows.Forms.Button
    $btnAll.Text = '全选'
    $btnAll.SetBounds(10, 8, 70, 30)
    $pnl.Controls.Add($btnAll)
    $btnAll.Add_Click({ for ($i = 0; $i -lt $clb.Items.Count; $i++) { $clb.SetItemChecked($i, $true) } })

    $btnNone = New-Object System.Windows.Forms.Button
    $btnNone.Text = '全不选'
    $btnNone.SetBounds(90, 8, 70, 30)
    $pnl.Controls.Add($btnNone)
    $btnNone.Add_Click({ for ($i = 0; $i -lt $clb.Items.Count; $i++) { $clb.SetItemChecked($i, $false) } })

    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = '保留所选'
    $btnOk.SetBounds(560, 8, 90, 30)
    $pnl.Controls.Add($btnOk)
    $form.AcceptButton = $btnOk
    $btnOk.Add_Click({ $form.DialogResult = 'OK'; $form.Close() })

    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = '取消（全部保留）'
    $btnCancel.SetBounds(655, 8, 100, 30)
    $pnl.Controls.Add($btnCancel)
    $form.CancelButton = $btnCancel
    $btnCancel.Add_Click({ $form.DialogResult = 'Cancel'; $form.Close() })

    $null = $form.ShowDialog()
    $kept = @()
    if ($form.DialogResult -eq 'OK') {
        for ($i = 0; $i -lt $clb.Items.Count; $i++) {
            if ($clb.GetItemChecked($i) -and $script:pickerPaths[$i]) { $kept += [string]$script:pickerPaths[$i] }
        }
        if ($kept.Count -eq 0) { $kept = @($Images) }   # 一张没选 = 视为全部保留，避免误删
    } else {
        $kept = @($Images)   # 取消 = 全部保留
    }
    $form.Dispose()
    return $kept
}


function Find-Ollama {
    $cmd = Get-Command ollama -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "D:\ollama\ollama.exe", "C:\ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe", "${env:ProgramFiles(x86)}\Ollama\ollama.exe")) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return ''
}

# 剩余显存（GB）：8G 卡上 SD 常驻时留给视觉模型的余地很小；取不到返回 -1（不阻断）。
function Get-FreeVramGb {
    try {
        $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
        if (-not $smi) { return -1 }
        $line = & $smi.Source --query-gpu=memory.free --format=csv,noheader,nounits 2>$null | Select-Object -First 1
        if (-not $line) { return -1 }
        return [Math]::Round(([double]("$line".Trim()) / 1024.0), 2)
    } catch { return -1 }
}

# ---- 显存释放（用户要求 2026-10-16：每次运行前先释放显存）----
# 这台 8G 卡上三方抢显存是反复踩坑的根源：
#   · SD(A1111) 常驻 ~2.5-5G；· 抠图要 YOLO-World+SAM 约 2-3G；· 视觉审核 8B 模型 ~5.3G（实测 /api/ps 5278MB）。
# 于是：抠图/SAM 会 CUDA OOM（进程被原生崩掉）、审核模型被挤到 CPU（一次 40-65s 甚至 180s 超时）。
# 所以每个"要显存"的步骤开跑前先按需释放对面那一边：
#   要为「抠图/审核」腾地方 → 让 A1111 卸载 checkpoint（POST /sdapi/v1/unload-checkpoint，出图时它会自动重载）；
#   要为「SD 出图」腾地方 → 让 Ollama 卸载常驻模型（POST /api/generate {keep_alive:0}）。
# 只在剩余显存低于阈值时才动手，避免无谓的重载开销。
function Release-SdVram {
    $done = @()
    foreach ($ep in @('sdapi/v1/unload-checkpoint', 'sdapi/v1/free')) {
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$SdPort/$ep" -Method Post -TimeoutSec 20
            $done += $ep
        } catch { }
    }
    if ($done.Count -gt 0) { Write-Host "  [显存] 已让 SD 卸载模型：$($done -join ' / ')（下次出图会自动重载）" -ForegroundColor DarkGray }
    return ($done.Count -gt 0)
}

function Release-OllamaVram {
    $base = $QwenBase -replace '/v1/?$', ''
    $base = $base.TrimEnd('/')
    $loaded = @()
    try {
        $ps = Invoke-RestMethod -Uri "$base/api/ps" -Method Get -TimeoutSec 8
        if ($ps -and $ps.models) { $loaded = @($ps.models | ForEach-Object { [string]$_.name }) }
    } catch { return $false }
    $freed = 0
    foreach ($m in $loaded) {
        try {
            $null = Invoke-RestMethod -Uri "$base/api/generate" -Method Post `
                -Headers @{ 'Content-Type' = 'application/json; charset=utf-8' } `
                -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ model = $m; keep_alive = 0 } | ConvertTo-Json -Depth 4))) -TimeoutSec 20
            $freed++
        } catch { }
    }
    if ($freed -gt 0) { Write-Host "  [显存] 已让本地模型服务卸载 $freed 个常驻模型（下次调用会自动重载）" -ForegroundColor DarkGray }
    return ($freed -gt 0)
}

# 开跑前确保有足够剩余显存：不够就释放指定的一侧（默认双侧都试）。
function Ensure-Vram {
    param([string]$For = 'any', [double]$NeedGb = 0, [string]$Note = "")
    if ($NoVramRelease) { return }
    if ($NeedGb -le 0) { $NeedGb = $VramMinFreeGb }
    $free = Get-FreeVramGb
    if ($free -lt 0) { return }                       # 拿不到显存信息（没 nvidia-smi）→ 不折腾
    if ($free -ge $NeedGb) {
        Write-Host ("  [显存] 开跑前检查：剩余 {0}G（需要 {1}G）→ 够用，不释放" -f $free, $NeedGb) -ForegroundColor DarkGray
        return
    }
    Write-Host ("  [显存] 开跑前检查：剩余 {0}G < 需要 {1}G → 先释放{2}{3}" -f $free, $NeedGb, $(if ($For -eq 'any') { '（SD / 本地模型）' } elseif ($For -eq 'sd') { ' SD 模型' } else { ' 本地模型服务' }), $(if ($Note) { "（$Note）" } else { '' })) -ForegroundColor Yellow
    if ($For -eq 'sd' -or $For -eq 'any') { $null = Release-SdVram }
    if ($For -eq 'ollama' -or $For -eq 'any') { $null = Release-OllamaVram }
    Start-Sleep -Milliseconds 800
    $after = Get-FreeVramGb
    if ($after -ge 0) { Write-Host ("  [显存] 释放后剩余 {0}G" -f $after) -ForegroundColor DarkGray }
}

# 本地视觉模型冷启动（用户要求 2026-10-15）：Ollama 没起过就**替你拉起来**，和 SD 预热同一套路。
# 为什么要它：脸/手质检与「画风=一致」的参考图识别都靠这个模型；以前 Ollama 没开就直接降级
# （素体只出一张、最终出图变成「出满 N 张让你自己挑一个」），用户看到的就是「插件没质检 / 判不出画风」。
# 注意：只拉起 `ollama serve`（不预加载模型）；首次推理仍要 1-3 分钟把模型读进显存，
# 所以质检请求本身留 180s 超时（见 Test-FaceQuality）。
function Start-OllamaService {
    param([int]$TimeoutSec = 60)
    if (Test-VlmApi) { return $true }
    if ($NoVlmStart) {
        Write-Host "本地视觉模型没在跑；已指定 -NoVlmStart → 不自动冷启动（质检/画风识别本次降级）" -ForegroundColor Yellow
        return $false
    }
    if ($script:OllamaStartTried) { return (Test-VlmApi) }   # 一次进程只拉一次，别反复起
    $script:OllamaStartTried = $true
    $exe = Find-Ollama
    if (-not $exe) {
        Write-Host "没找到 ollama.exe（本地视觉模型服务）→ 本次跳过质检与画风识别；装好 Ollama 后会自动冷启动" -ForegroundColor Yellow
        return $false
    }
    Write-Host "本地视觉模型没在跑 → 正在冷启动：$exe serve" -ForegroundColor Cyan
    try {
        $null = Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden -PassThru
    } catch {
        Write-Host "拉起 Ollama 失败：$($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }
    $deadline = (Get-Date).AddSeconds([Math]::Max(5, $TimeoutSec))
    $i = 0
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 800
        if (Test-VlmApi) {
            Write-Host "  本地视觉模型服务已就绪（首次质检要把模型读进显存，可能 1-3 分钟）" -ForegroundColor Green
            return $true
        }
        if ($i % 5 -eq 0) { Write-Host "  等待 ollama serve 起来…（最多 $TimeoutSec 秒）" -ForegroundColor DarkGray }
        $i++
    }
    Write-Host "Ollama 在 $TimeoutSec 秒内没起来 → 本次质检/画风识别降级（不阻断出图）" -ForegroundColor Yellow
    return $false
}

# ---- 本次跑出来的「中间图」记账（用户要求：C 档脚本跑完，产物目录只留成品）----
# 预蒙版（premask-*.png / _overlay.png）是**表单要用的**，必须活到出图结束才能删；
# 命中率总览图默认写进迭代临时目录（随目录一起清），-KeepWorkFiles 时才落到产物目录。
$script:RunWorkFiles = New-Object System.Collections.Generic.List[string]
function Add-RunWorkFile {
    param([string]$Path)
    if ($Path) { $script:RunWorkFiles.Add($Path) | Out-Null }
    return $Path
}
function Remove-RunWorkFiles {
    param([string[]]$KeepPaths = @())
    if ($KeepWorkFiles) {
        if ($script:RunWorkFiles.Count -gt 0) {
            Write-Host "本次中间图（-KeepWorkFiles 保留）：" -ForegroundColor DarkGray
            foreach ($p in $script:RunWorkFiles) { Write-Host "  $p" -ForegroundColor DarkGray }
        }
        return
    }
    $gone = 0
    foreach ($p in $script:RunWorkFiles) {
        if (-not $p -or -not (Test-Path -LiteralPath $p)) { continue }
        if ($KeepPaths -contains $p) { continue }
        try { Remove-Item -LiteralPath $p -Force -ErrorAction Stop; $gone++; Write-Host "  已清理中间图: $(Split-Path $p -Leaf)" -ForegroundColor DarkGray } catch { }
    }
    if ($gone -gt 0) { Write-Host "已清理本次中间图 $gone 个（产物目录只留成品；要留着排查请加 -KeepWorkFiles）" -ForegroundColor DarkGray }
}


# ---- 0) 出图参数表单先弹（脚本一启动就弹，不等任何阻塞步骤）：正向/负向提示词 + 迭代次数 / Denoising / 比例 / 画风 / 画质 / LoRA / 模型 ----
# 表单放最前面：用户先填参数 → 再跑素体迭代与最终出图，避免「屏幕静止几分钟像卡死」。
# 注：表单时素体还没跑（HasBaseImage=false），Denoising 档位先按无素体展示。
# 坑49（装机实测 2026-10-17，P1 阻塞级）：**表单之前不允许有任何同步网络/模型操作**。
# 故障现场（Issue 记录，完整时间线）：
#   1. launcher 启动 sd-inject.ps1（隐藏控制台）
#   2. 脚本依次：interrupt → SD 预热（1-3 min）→ Ollama 冷启动 → 显存检查 → 拉 LoRA 列表 →
#      自动抠图（240s + CPU 重试 240s）→ … 全部同步阻塞
#   3. 13 分钟过去了，进程活着、线程全部 Wait、**0 个窗口**、用户面前什么都没有
#   4. 用户只能 Stop-Process 重跑，完全不知道卡在哪
# 修法：表单在**第一个 Write-Host 之后立刻弹**。LoRA/模型下拉不再要求列表已就绪才显示，
#       而是先显示空列表 + 「点此刷新」按钮，用户需要时手动按。SD 预热 / 抠图 / Ollama 全部
#       挪到**用户已点「确定出图」之后**才执行。心跳文件在表单弹窗前就写入。
# 注：表单需要底图/蒙版的**原始参数**（不是解析后的路径），所以 $InitImage / $MaskSpec 直接传。
$hasBaseImg = $false
if ($baseWin -and (Test-Path -LiteralPath $baseWin.Path)) { $hasBaseImg = $true }

# 心跳文件（坑49/ISSUE P1 补全）：逐阶段写一行到 iter-<id>\status.txt，
# 外部（插件侧/用户/排障）一眼看出卡在哪一步；窗口没出现时 status.txt 是唯一证据。
$script:HeartbeatFile = Join-Path $script:IterTempDir 'status.txt'
function Write-Heartbeat {
    param([string]$Stage, [string]$Detail = '')
    try {
        $line = "[{0:HH:mm:ss}] {1} {2}" -f (Get-Date), $Stage, $Detail
        Add-Content -LiteralPath $script:HeartbeatFile -Value $line -Encoding UTF8
    } catch { }
}
# 脚本刚开始就写第一行（此时迭代目录已建）
Write-Heartbeat 'start' "PID=$PID MaskSpec=$MaskSpec Mode=$Mode"

# 心跳步骤 1：表单出现（写到 status.txt，让外部/插件侧知道「脚本在动」）
# 表单预填前先补末尾英文逗号
$paramFormRounds = 3   # 迭代次数默认
# P5（2026-10-18）：模型下拉的可用性来自**网关** /api/models（不再直连 WebUI/ComfyUI 探测）。
# 网关没在跑就先拉起来；拉不起来也只标「引擎离线」，不影响表单弹出（表单必须先出，坑49）。
$backendChoices = @()
$backendDefault = 'QwenImage_NVFP4'   # 2026-10-20：默认生图模型改为 Qwen（用户要求）
$modelMissingMap = @{}   # 2026-10-19：模型 key → 缺失文件数组（红字提示用）
$modelStatusMap = @{}
$gwBaseForForm = Get-GatewayBase
if (-not $NoGateway) {
    try {
        # 表单最先弹（2026-10-20）：这里只等 3 秒做一次「快探」，网关多数时候已在跑=秒回；
        # 没探到也不影响表单弹出（4 档模型照样全列出来 = unknown），真正的 ensure/加载放到表单之后。
        if (Start-GatewayIfNeeded -WaitSec 3) {
            $m = Invoke-RestMethod -Uri "$gwBaseForForm/api/models" -Method Get -TimeoutSec 3
            foreach ($it in @($m.models)) {
                $k = [string]$it.key
                if (-not $k) { continue }
                $modelStatusMap[$k] = [string]$it.status
                try { if ($it.missing) { $modelMissingMap[$k] = @($it.missing) } } catch { }
                $backendChoices += [PSCustomObject]@{ Name = $k; Key = $k; Status = [string]$it.status; Model = [string]$it.detail }
            }
        }
    } catch {
        Write-Host "网关模型探测失败（表单仍会正常弹出）：$($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}
if (-not $modelStatusMap.ContainsKey('SD_FP16')) {
    # 兜底：网关不可达时 4 个枚举照样列出来（状态未知），用户仍可在表单里选
    foreach ($k in $script:GatewayModels) { if (-not $modelStatusMap.ContainsKey($k)) { $modelStatusMap[$k] = 'unknown' } }
}
foreach ($k in @("QwenImage_NVFP4", "SD_FP16", "Anima_INT8", "Krea2_Q4")) {
    if ($modelStatusMap[$k] -eq "ok") { $backendDefault = $k; break }
}
Write-Host ("网关：{0}｜模型：{1}" -f $gwBaseForForm, (($script:GatewayModels | ForEach-Object { "$_=$($modelStatusMap[$_])" }) -join ' ')) -ForegroundColor DarkGray
# 坑52（装机实测 2026-10-17）：**BasePrompt 与 ViolationPrompts 必须合并预填，不能整框覆盖**。
# 故障现场：`-ViolationPrompts` 非空时，正向框被整框替换成违禁词，`-BasePrompt`（素体主体 +
# 画风 + 面部细节 + 角色触发词）只进「素体自检迭代」，**永远不进入最终出图提示词**
# → 用户改多少次 basePrompt，最终图的主体/角色/画风都不变（实测排查了很久才发现）。
# 修法：两者合并（BasePrompt 在前、违禁词在后，逗号连接），任一方为空时退化为另一方，
#       都空时保持 $BasePrompt 原值（不产生前导逗号/空标签）。
$formPositive = $BasePrompt
$formNegative = $BaseNegative
if ($ViolationPrompts -and $ViolationPrompts.Trim()) {
    $merged = @($BasePrompt.Trim(), $ViolationPrompts.Trim()) | Where-Object { $_ }
    $formPositive = ($merged -join ', ')
    Write-Host "对话侧：BasePrompt + ViolationPrompts 已合并预填进正向框（共 $($merged.Count) 段）" -ForegroundColor DarkGray
}
if ($SuggestedPrompts -and $SuggestedPrompts.Trim()) {
    $mergedN = @($BaseNegative.Trim(), $SuggestedPrompts.Trim()) | Where-Object { $_ }
    $formNegative = ($mergedN -join ', ')
}
if ($formPositive -and ($formPositive -notmatch ',\s*$')) { $formPositive = $formPositive.TrimEnd() + ", " }
if ($formNegative -and ($formNegative -notmatch ',\s*$')) { $formNegative = $formNegative.TrimEnd() + ", " }

# LoRA/模型列表（2026-10-19 修复）：原来用 Start-Job { Get-SdLoras } 后台拉，
# 但 Start-Job 是独立 runspace、拿不到脚本内函数 → job 必 Failed、Receive-Job 拿到空 → 下拉恒空。现改为同步直调（SD 未起时 5s 超时返回空）。
$sdCurrentModel = ''
$sdLoras = @(Get-SdLoras)                 # 同步拿一次（SD 在线时秒回；未起则空数组，不阻塞表单）
$sdCheckpoints = @(Get-SdCheckpoints)

# 坑49：底图不在这里解析（解析需要读盘+可能触发网络），原始字符串直接传给表单作为默认值。
# 蒙版同理。表单底图栏 = $InitImage 原值；蒙版栏 = $MaskSpec 原值。
$maskDefaultForForm = $MaskSpec
if ($MaskSpec -match '^手动|手动绘制|manual|手绘') {
    $maskDefaultForForm = $MaskSpec
    Write-Host "对话侧：用户指定手动绘制 → 表单蒙版栏保留「手动绘制」。" -ForegroundColor DarkGray
}

# ===========================================================================
# C 档新流程（用户要求 2026-10-18）：**先在后台把图生成好 → 落到指定路径 → 再弹表单窗口**。
#   老流程（坑49 定的）是"表单先弹，避免用户干等"；但用户实测下来的真实需求是：
#   打开窗口时图已经在磁盘上（对话侧也能立刻引用），窗口只用来"看结果 + 改参数重出"。
#   所以这里先跑一次预生成：控制台会持续打印进度（窗口随后才出现），
#   预生成失败/超时也不会挡住表单（照常弹出，用户点了再出）。
#   加 -NoPreGenerate 可恢复老顺序。
# ===========================================================================
$script:PreGenResult = $null
$script:PreGenTexted = $false      # 预生成那张是否已经加过字（避免后面再加一遍叠成双份）
# 顺序定稿（用户要求 2026-10-20）：**先弹「是/否」窗 → 生图（含加字）→ 打开成品 → 再弹参数表**。
#   所以预生成恢复成**默认执行**：开头那句「什么弹窗都没有」的抱怨由 是/否 窗解决（它 2-5 秒就出），
#   之后才是这一段 1-3 分钟的出图（控制台有 7 步进度），画完打开成品、再弹参数表。
#   `-NoPreGenerate` 仍可退回「先弹参数表、点了才出图」；`-PreGenerate` 保留兼容（等价默认值）。
if (-not $NoPreGenerate) {
    Write-Heartbeat 'pregenerate-start' "model=$Model mode=$Mode lora=$(if ($Lora) { $Lora } else { '(无)' })"
    Write-Host ""
    Write-Host "=== 先在后台出图（完成后自动弹出参数窗口）===" -ForegroundColor Cyan
    try {
        $script:PreGenResult = Invoke-PreGenerate -Prompt $formPositive -Negative $formNegative -TimeoutSec $PreGenTimeoutSec -LoraSpec $Lora
    } catch {
        Write-Host "后台预生成异常：$($_.Exception.Message)" -ForegroundColor Yellow
        $script:PreGenResult = $null
    }
    if ($script:PreGenResult) {
        $script:GatewayPaths = @($script:PreGenResult.Path)
        if ($script:PreGenResult.Texted) {
            $script:PreGenTexted = $true
            $script:PreGenTextPos = "$($script:AddTextPosChosen)"    # 预生成这次实际落在哪一格（表单里改了就按新的重加）
            $script:PreGenTextSize = "$AddTextSize"
            $script:PreGenTextStyle = "$AddTextStyle"
            Write-Host ("预生成加字位置：{0}" -f (Format-AddTextPosLabel -Spec "$AddTextPos" -Zone "$script:AddTextPosChosen")) -ForegroundColor DarkGray
        }
        Write-Heartbeat 'pregenerate-done' "path=$($script:PreGenResult.Path) texted=$(if ($script:PreGenResult.Texted) { 'yes' } else { 'no' })"
        Write-Host "本次预生成成品: $($script:PreGenResult.Path)" -ForegroundColor Green
        if (-not $NoOpen) { try { Start-Process -FilePath $script:PreGenResult.Path } catch { } }
    } else {
        Write-Heartbeat 'pregenerate-skip' 'no-result'
        Write-Host "后台预生成未产出（表单照常弹出，可在窗口里点确定出图）" -ForegroundColor Yellow
    }
}

# ---- [7/7] 弹出参数窗口（图已落盘，用户直接看/改）----
Write-OpStep 7 '弹出参数窗口' '图已在磁盘上；改完参数点「确定出图（走网关）」即重出'
Write-OpStep 7 '弹出参数窗口' '已打开' -State 'ok'

$P = Show-ParamForm -DefaultRounds $paramFormRounds -HasBaseImage $hasBaseImg -Positive $formPositive -Negative $formNegative -LoraList $sdLoras -CheckpointList $sdCheckpoints -InitImageDefault $InitImage -CurrentModel $sdCurrentModel -ModeDefault $Mode -MaskDefault $maskDefaultForForm -BackendList $backendChoices -BackendDefault $backendDefault -ModelStatus $modelStatusMap -ModelMissing $modelMissingMap -VlmInitialIndex $(if ($NoVlmReview -or "$VisualReview" -eq "off") { 2 } elseif ("$VisualReview" -eq "on") { 1 } else { 0 }) -GatewayBase $gwBaseForForm -PreGenPath $(if ($script:PreGenResult) { $script:PreGenResult.Path } else { '' }) -GwWidthDefault $Width -GwHeightDefault $Height -LockBase:$lockBase -LockMask:$lockMask -AddTextDefault $AddText -AddTextModelDefault $AddTextModel -AddTextPosDefault $(Format-AddTextPosLabel -Spec "$AddTextPos") -AddTextSizeDefault "$AddTextSize" -AddTextStyleDefault "$AddTextStyle" -PreGenImagePath $(if ($script:PreGenResult) { $script:PreGenResult.Path } else { '' }) -AutoOpenPosPicker:([bool]($AddText -and $AddText.Trim())) -LoraDefault (Get-EffectiveLoraSpec -Explicit $Lora -Prompt $formPositive -LoraList $sdLoras)

# 用户点完「确定出图」之后，才允许做阻塞操作（SD 预热 / Ollama / 列表拉取 / 抠图等）
Write-Host ""
Write-Host "开始绘制" -ForegroundColor Cyan
# ===== 表单返回值 → 主流程提示词（2026-10-27 修：这一直缺着，$positive/$negative 从未被赋值）=====
#   症状：主流程打印「正向: , detailed face, ...」（只剩自动追加的脸部词），
#   命名从空串总结成 detailed_face_beautiful、最终出图还会用空正向词。
#   以表单两个框为准，表单空则退回预填值。
$positive = "$($P.Pos)"
$negative = "$($P.Neg)"
if (-not $positive.Trim()) { $positive = "$formPositive" }
if (-not $negative.Trim()) { $negative = "$formNegative" }
Write-Host ("表单提示词 → 正向 {0} 字 / 负向 {1} 字" -f $positive.Length, $negative.Length) -ForegroundColor DarkGray
# 2026-10-19：表单里的「视觉审查」选择 → 覆盖本次运行的 $VisualReview（拒绝 = 后续整条跳过视觉）
$vlmChoice = ""
try { $vlmChoice = [string]$P.Vlm } catch { }
if (-not $vlmChoice) { $vlmChoice = "自动" }
if ($vlmChoice.StartsWith("关闭")) { $NoVlmReview = $true; $VisualReview = "off" }
elseif ($vlmChoice.StartsWith("强制")) { $NoVlmReview = $false; $VisualReview = "on" }
else { $NoVlmReview = $false; $VisualReview = "auto" }
Write-Host ("视觉审查：表单选择 = " + $vlmChoice + "（生效值 = " + $VisualReview + "）") -ForegroundColor Cyan
# 加字（2026-10-20 用户要求）：表单「加字」栏 > 命令行 -AddText；加字模型默认「另一档」。
$addTextFinal = ""
try { if ("$($P.AddText)") { $addTextFinal = [string]$P.AddText } } catch { }
if (-not $addTextFinal -and $AddText -and $AddText.Trim()) { $addTextFinal = $AddText.Trim() }
$addTextModelAsked = ""
try { if ("$($P.AddTextModel)") { $addTextModelAsked = [string]$P.AddTextModel } } catch { }
if (-not $addTextModelAsked) { $addTextModelAsked = $AddTextModel }
# 加字位置（2026-10-21）：表单「加字位置」栏 > 命令行 -AddTextPos（random 就是开始时随机挑一格）
$addTextPosFinal = ""
try { if ("$($P.AddTextPos)") { $addTextPosFinal = [string]$P.AddTextPos } } catch { }
if (-not $addTextPosFinal) { $addTextPosFinal = $AddTextPos }
# 加字字号/字体风格（2026-10-21）：表单 > 命令行
$addTextSizeFinal = ""
try { if ("$($P.AddTextSize)") { $addTextSizeFinal = [string]$P.AddTextSize } } catch { }
if (-not $addTextSizeFinal) { $addTextSizeFinal = $AddTextSize }
$addTextStyleFinal = ""
try { if ("$($P.AddTextStyle)") { $addTextStyleFinal = [string]$P.AddTextStyle } } catch { }
if (-not $addTextStyleFinal) { $addTextStyleFinal = $AddTextStyle }
if ($addTextFinal) { Write-Host ("加字：位置={0}　字号={1}　风格={2}" -f (Format-AddTextPosLabel -Spec "$addTextPosFinal"), (Format-AddTextSizeLabel -Spec "$addTextSizeFinal"), (Format-AddTextStyleLabel -Spec "$addTextStyleFinal")) -ForegroundColor DarkGray }
# P5：预热不再是「本地直连 sd-direct.ps1 -StartOnly」，而是让网关按需拉起引擎。
# ---- 0a) 阻塞步骤：经网关预热引擎 + 拉 LoRA/模型列表 + Ollama 冷启动 ----
# 这些都在用户点了「确定出图」之后才做，不会阻塞表单（坑49）。
$gwSelectedModel = 'QwenImage_NVFP4'   # 2026-10-20：默认生图模型改为 Qwen
try {
    if ($P.Backend -and ($script:GatewayModels -contains [string]$P.Backend)) { $gwSelectedModel = [string]$P.Backend }
} catch { }
$gwEngineForModel = if ($gwSelectedModel -in @('QwenImage_NVFP4', 'Krea2_Q4')) { 'comfy' } else { 'webui' }

# LoRA 通用性（2026-10-27 用户要求「做到所有模型通用（相互转译）LoRA，优先适配 comfy」）：
#   DiT 档（QwenImage_NVFP4 / Krea2_Q4）**不再强制切 SD_FP16** —— 网关有跨架构 LoRA 搬运
#   （bridge：Stage1 SD_FP16+LoRA 出图 → Stage2 DiT img2img 迁移风格），4 个模型档都能用同一套 SD1.5 LoRA。
#   prompt 里含 <lora:...> + DiT 档 → 网关自动走 bridge 管线（日志里 task.kind=bridge）。

$genModelForText = $gwSelectedModel   # 加字要「另一档」：以它为基准避开同档
if (-not $NoGateway) {
    $ensure = Invoke-GatewayEnsureEngine -Engine $gwEngineForModel -TimeoutSec 240
    if ($ensure.Ok) {
        if ($ensure.Started) { Write-Host "网关已拉起引擎：$gwEngineForModel" -ForegroundColor Green }
    } else {
        Write-Host "网关预热引擎失败（$gwEngineForModel）：$($ensure.Message)" -ForegroundColor Yellow
    }
}
# LoRA/模型列表已在表单弹出前同步拿过（上方），这里不再有后台 job 需要回收
$sdCurrentModel = Get-SdCurrentModel  # 这里才阻塞，用户已点了确定，没事

# Ollama 冷启动
if (-not (Test-VisualReviewOff)) { if (-not (Test-VlmApi)) { $null = Start-OllamaService -TimeoutSec $VlmStartTimeout } } else { Write-Host "视觉审查已关闭 → 不冷启动 Ollama" -ForegroundColor DarkGray }
$freeVram = Get-FreeVramGb
if ($freeVram -ge 0 -and $freeVram -lt 3.0) {
    Write-Host "显存提醒：只剩 $freeVram GB —— 本地视觉模型（$VlmModel）会被 Ollama 放到 CPU / 部分卸载，质检会明显变慢（首次加载可能 1-3 分钟）" -ForegroundColor Yellow
}

# ---- 0b) 末尾补英文逗号：提示词末尾没有逗号就补一个，保证后面追加时不会粘连 ----
# 保证后面追加脸部词/LoRA/全身等拼接时不会粘连（用户要求）。
if ($positive -and $positive.Trim() -and ($positive.Trim() -notmatch ',\s*$')) { $positive = $positive.Trim() + ", " }
if ($negative -and $negative.Trim() -and ($negative.Trim() -notmatch ',\s*$')) { $negative = $negative.Trim() + ", " }

# 默认景别「全身」：若用户未在正向提示词里指定任何构图/景别词（上半身/半身/头像/特写等），
# 自动追加 "full body"（用户要求：没说明就默认全身）。
$framingWords = 'full body|upper body|half body|headshot|portrait|close-up|closeup|bust|waist up|waist-up|cowboy shot|knee up|face|half-length|three-quarter|fullbody|whole body'
if ($positive -and ($positive -notmatch $framingWords)) {
    if ($positive -notmatch 'full body') {
        $positive = "$positive full body, "
    }
}

# ---- 0b) 素体自检迭代（表单确认后再跑）：只跑基底，换 seed + 面部修复迭代到脸部过关 ----
# 追加为空时迭代产物就是最终图；有追加/参数变化时用 winning seed/图锚定最终出图，保住过关的脸。
# 2026-10-16 用户要求「素体不需要额外生成了」：**有参考图（图生图/蒙版重绘）时不再先生成素体** ——
# 参考图本身就是底图，再跑一遍素体只会多出一张 inject_00N.png 并白烧时间/显存
# （实测那轮产物目录里就多了一张 inject_001.png）。文生图（没有参考图）仍按原逻辑跑素体迭代。
$baseWin = $null
$skipBaseIterate = $false
if ($NoIterate) { $skipBaseIterate = $true }
elseif ($P.GwPaths -and @($P.GwPaths).Count -gt 0) {
    # 表单里已经用网关出过图（用户点的就是「确定出图（走网关）」）→ 不再多跑一遍素体迭代。
    # 用户反馈（2026-10-18）：点了确定却出了两张（一张表单的 + 一张素体迭代），白烧时间/显存。
    $skipBaseIterate = $true
    Write-Host "表单已出图 → 跳过素体自检迭代（不再重复出图）" -ForegroundColor Cyan
}
elseif ($preInitPath -or ($Mode -eq '图生图' -and $InitImage)) {
    $skipBaseIterate = $true
    Write-Host "已有参考图 → 跳过素体自检迭代（不再额外生成素体底图，直接用参考图出图）" -ForegroundColor Cyan
}
if (-not $skipBaseIterate) {
    $null = Release-OllamaVram      # 素体出图也要 SD 掌卡：先卸掉本地模型（用户要求：每次运行前先释放显存）
    $baseWin = Invoke-BaseIterate
    if ($baseWin) {
        Write-Host "素体迭代完成：$($baseWin.Path)（seed=$($baseWin.Seed)，脸/手 $($baseWin.Score)/100）" -ForegroundColor Green
    }
}
if ($baseWin -and (Test-Path -LiteralPath $baseWin.Path)) { $hasBaseImg = $true }

# 脸部细节词：自动追加进正向（去重——用户已手写过的词不重复加）
$faceTags = @()
foreach ($t in ($FaceBoostTags -split ',')) {
    $tt = $t.Trim()
    if ($tt -and ($positive -notmatch [regex]::Escape($tt))) { $faceTags += $tt }
}
if ($faceTags.Count -gt 0) {
    # 先去掉正向已有的尾逗号再加（否则会拼出「..., , 脸部词」→ 连续逗号，见 Normalize-PromptText 说明）
    $positive = (Normalize-PromptText $positive) + ", $($faceTags -join ', ')"
    Write-Host "已追加脸部细节词：$($faceTags -join ', ')" -ForegroundColor DarkGray
}

# LoRA：表单选择 → <lora:名称:权重> 拼进正向（统一走 Add-LoraToPrompt；没选时模糊索引兜底）
$loraFragment = ""
$effLoraMain = Get-EffectiveLoraSpec -Explicit $P.Lora -Prompt ("$positive $($P.Name)") -LoraList $sdLoras
if ($effLoraMain -and $effLoraMain -ne '（不用 LoRA）') {
    if ($effLoraMain -ne "$($P.Lora)") {
        Write-Host "LoRA 模糊索引：表单未选 → 从正向/命名 命中「$effLoraMain」" -ForegroundColor Cyan
    }
    $beforeLora = $positive
    $positive = Add-LoraToPrompt -Prompt $positive -LoraSpec $effLoraMain
    if ($positive -ne $beforeLora) {
        # 提取实际追加的片段用于日志
        $p0 = Parse-LoraSpec -Spec $effLoraMain
        if ($p0) { $loraFragment = Format-LoraFragment -LoraName $p0.Name -Weight $p0.Weight }
    }
}

$size = Get-SizeFor -Ratio $P.Ratio -Quality $P.Quality
# 模型切换：表单选了具体 checkpoint（非「（当前模型）」）才传给出图子流程
$formCheckpoint = ""
if ($P.Model -and ($P.Model -notlike '（当前模型*') -and $P.Model -ne '') { $formCheckpoint = $P.Model }

# 最终命名：表单「命名」栏 > 提示词总结 > 默认 inject；统一用 Get-UniqueOutPath 去重递增
$finalBaseName = $P.Name
if (-not $finalBaseName) { $finalBaseName = Summarize-PromptName -Prompt $positive }
if (-not $finalBaseName) { $finalBaseName = $Name }

Write-Host ""
$denoiseDesc = if ($P.Denoise -gt 0) { "Denoising $($P.Denoise)（图生图）" } else { "Denoising 0（文生图）" }
$initDesc = if ("$($P.InitImg)") { "底图「$($P.InitImg)」" } else { "底图=素体成品" }
Write-Host "出图参数：迭代 $($P.Rounds) 次 | $denoiseDesc | $initDesc | 比例 $($P.Ratio)（$($size.W)x$($size.H)） | 画风 $($P.Style) | 画质 $($P.Quality)$(if ($loraFragment) { " | LoRA $loraFragment" })$(if ($formCheckpoint) { " | 模型 $formCheckpoint" }) | 命名 $finalBaseName" -ForegroundColor Green
Write-Host "正向: $positive" -ForegroundColor White
Write-Host "负向: $negative" -ForegroundColor White

# ---- 5) 最终出图（按表单参数迭代，取脸/手最高分那张）----
# 画风词已由表单联动（切换画风时注入两个提示词框）写进 $P.Pos/$P.Neg，这里**不再二次追加**，
# 否则会重复（用户要求：C 档弹表单时根据画风在两个提示词框里加入对应画风词）。
# 这里只保留「画风 → 自动切模型」的兜底逻辑（写实 → majicMIX；写实二次元 → 首选动漫底子不切模型，备选 SemiRealMix）。

# 二次元画风：**必须显式切回动漫底**（2026-10-15 修「二次元画风画不出来」的核心）。
# 原因：画风自动切模型是持久的——写实 → majicMIX、彩色哥特 → SemiRealMix 之后，SD 会一直停在那；
# 再选「二次元」若不切回来，出的就是写实/半写实图（实测现网 SD 当时正停在 SemiRealMix 上）。
if ($P.Style -eq '二次元' -and -not $formCheckpoint) {
    $animeCkpt = Get-AnimeCheckpoint -Checkpoints $sdCheckpoints
    if ($animeCkpt) {
        $formCheckpoint = $animeCkpt
        if ($sdCurrentModel -and $sdCurrentModel -ne $animeCkpt) {
            Write-Host "二次元画风：当前底子是 $sdCurrentModel（不是动漫底）→ 自动切回动漫底 $animeCkpt" -ForegroundColor DarkGray
        } else {
            Write-Host "二次元画风：使用动漫底 $animeCkpt" -ForegroundColor DarkGray
        }
    } else {
        Write-Host "二次元画风：本机未找到动漫底 checkpoint（当前 $sdCurrentModel），建议装 AWPainting / anything-v5" -ForegroundColor Yellow
    }
}

# 写实画风且用户没在表单里手动选模型 → 自动切到本机写实 checkpoint（majicMIX），
# 否则写实词落在动漫模型上会画风漂移（实测：AWPainting + 写实词 → 光影写实但脸还是动漫）。
if ($P.Style -eq '写实' -and -not $formCheckpoint) {
    $realisticCkpt = @($sdCheckpoints | Where-Object { $_ -match 'majicMIX|majicmix|realistic|麦橘|写实' } | Select-Object -First 1)
    if ($realisticCkpt) {
        $formCheckpoint = $realisticCkpt
        Write-Host "写实画风：自动切换模型 → $formCheckpoint" -ForegroundColor DarkGray
    } else {
        Write-Host "写实画风：本机未找到写实 checkpoint，用当前模型（建议 ollama 或 SD 里补装 majicMIX）" -ForegroundColor Yellow
    }
}

# 写实二次元画风（十轮迭代实测结论）：首选「动漫底子 + 半写实 LoRA」——画风词里的
# <lora:semirealisticanime:0.6> 已经把脸拉向现代 CG 半写实，此时**保持动漫模型（不切）**效果最好；
# 实测 SemiRealMix 做底反而容易出 3D 娃娃脸或直接跑成真人照片，只在半写实 LoRA 缺失时退回它。
if ($P.Style -in @('写实二次元', '写实二次元·东亚脸') -and -not $formCheckpoint) {
    $hasSemirealLora = @($sdLoras | Where-Object { $_ -match 'semirealisticanime' }).Count -gt 0
    if ($hasSemirealLora) {
        if (Test-RealisticCheckpoint $sdCurrentModel) {
            # 当前底是写实向（多半是上一次 写实/彩色哥特 留下的）→ 先切回动漫底，不然半写实 LoRA 挂在写实底上更糊
            $animeCkpt = Get-AnimeCheckpoint -Checkpoints $sdCheckpoints
            if ($animeCkpt) {
                $formCheckpoint = $animeCkpt
                Write-Host "写实二次元画风：当前底子是写实向（$sdCurrentModel）→ 先切回动漫底 $animeCkpt，再挂半写实 LoRA 0.6" -ForegroundColor DarkGray
            } else {
                Write-Host "写实二次元画风：当前是写实底（$sdCurrentModel）且本机找不到动漫底，保持当前模型 + 半写实 LoRA（会偏写实）" -ForegroundColor Yellow
            }
        } else {
            Write-Host "写实二次元画风：保持动漫模型 + 半写实 LoRA 0.6（实测最优路径，不切模型）" -ForegroundColor DarkGray
        }
    } else {
        $semirealCkpt = @($sdCheckpoints | Where-Object { $_ -match 'SemiReal|semireal|半写实|2.5d|2\.5D' } | Select-Object -First 1)
        if ($semirealCkpt) {
            $formCheckpoint = $semirealCkpt
            Write-Host "写实二次元画风：未找到半写实 LoRA（semirealisticanime），退回 SemiRealMix 模型 → $formCheckpoint（建议跑 install-sd.ps1 补装 semireal LoRA，效果更稳）" -ForegroundColor Yellow
        } else {
            Write-Host "写实二次元画风：半写实 LoRA 与 SemiRealMix 都没有，用当前模型（跑 install-sd.ps1 补装 semireal / semirealmix）" -ForegroundColor Yellow
        }
    }
}

# 彩色哥特画风（原「真人感半写实」改名演化）：SemiRealMix 做底——它堆金、厚涂、高饱和的
# 特性在这套词里正好是哥特华丽感的本体。用户没手动选模型时自动切到 SemiRealMix。
if ($P.Style -eq '彩色哥特' -and -not $formCheckpoint) {
    $semirealCkpt = @($sdCheckpoints | Where-Object { $_ -match 'SemiReal|semireal|半写实|2.5d|2\.5D' } | Select-Object -First 1)
    if ($semirealCkpt) {
        $formCheckpoint = $semirealCkpt
        Write-Host "彩色哥特画风：自动切换模型 → $formCheckpoint" -ForegroundColor DarkGray
    } else {
        Write-Host "彩色哥特画风：本机未找到 SemiRealMix，用当前模型（跑 install-sd.ps1 补装 semirealmix）" -ForegroundColor Yellow
    }
}

# 追加为空（表单里提示词与基底一致 + 无脸部词/LoRA 追加）+ 素体迭代已产出成品 + 参数全是默认形态（无比例/画质/画风调整）
# + Denoising=0（用户没要求图生图）：不重复出图，直接收尾。
# 注：Denoising>0 时**不**走这条捷径——用户明确要用素体图做底图重绘，必须真正出一轮图生图。
$defaultsOnly = ($P.Ratio -eq '9:16' -and $P.Quality -eq '480p' -and $P.Style -in @('保持画风', '二次元') -and $P.Rounds -eq $paramFormRounds -and $P.Denoise -le 0 -and -not "$($P.InitImg)")
$promptsUntouched = ($positive -eq $formPositive.Trim() -and $negative -eq $formNegative.Trim())
# 决策日志已关闭（用户要求 2026-10-14）：不再写 sd-inject-decision.log
if ($promptsUntouched -and $hasBaseImg -and $defaultsOnly) {
    Write-Host ""
    Write-Host "追加为空：素体迭代产物即最终图，不再重复出图。" -ForegroundColor Green
    # 素体图目前还在临时目录：用「工作区唯一序号」复制进工作区（不覆盖历史成品）
    $finalPath = Get-UniqueOutPath -BaseName $finalBaseName
    Copy-Item -LiteralPath $baseWin.Path -Destination $finalPath -Force
    Remove-IterTempDir
    Write-Host "成品: $finalPath（seed=$($baseWin.Seed)，脸/手 $($baseWin.Score)/100）"
    # 根因修复（2026-10-20）：这条捷径以前直接 exit 0，**把加字整段跳过**（用户拿到的图没有字）。
    if ($addTextFinal) {
        $finalPath = Invoke-AddTextStage -Path $finalPath -BaseName $finalBaseName -Text $addTextFinal -Model $addTextModelAsked -GenModel $genModelForText -OutDirPath $OutDir -Pos "$addTextPosFinal" -Size "$addTextSizeFinal" -Style "$addTextStyleFinal"
    }
    if (-not $NoOpen) {
        try {
            Start-Process -FilePath $finalPath
            Write-Host "已打开: $finalPath"
        } catch {
            Write-Host "自动打开失败（$($_.Exception.Message)），可手动打开：$finalPath" -ForegroundColor Yellow
        }
    }
    exit 0
}

# 组装最终负向：负向提示词已含「画风负面词」（表单联动注入），这里直接用 $negative。
# 画风词不再二次追加（否则会与表单里已注入的词重复）。
$finalNegative = $negative

# 组装最终正向：正向提示词已含「画风正向词」（表单联动注入），这里直接用 $positive。

# 最终末尾补英文逗号：正向/负向经过 full body、脸部词、LoRA、画风负面等追加后，
# 末尾可能又没有逗号了，出图前统一再补一次（用户要求：提示词末尾加英文逗号）。
if ($positive -and ($positive -notmatch ',\s*$')) { $positive = $positive.TrimEnd() + ", " }
if ($finalNegative -and ($finalNegative -notmatch ',\s*$')) { $finalNegative = $finalNegative.TrimEnd() + ", " }

# 送 SD 前最后一道提示词净化：脸部词/LoRA/画风词反复追加可能留下 "a,, b" 这种空标签（实测会出现），
# 折叠成单个逗号后再补回结尾逗号（把「末尾必须有英文逗号」这条要求保下来）。
if ($positive) { $positive = (($positive -replace '(\s*,\s*)+', ', ').Trim().TrimEnd(',')).Trim() + ", " }
if ($finalNegative) { $finalNegative = (($finalNegative -replace '(\s*,\s*)+', ', ').Trim().TrimEnd(',')).Trim() + ", " }

# ---- 决策树：C-0 文生图 / C-1a 图生图·一致 / C-1b 图生图·替换（蒙版重绘）----
# 表单的「模式」是总开关：
#   C-0  文生图                → 忽略底图与蒙版，用完整提示词直出
#   C-1  图生图 + 画风=一致     → 从**参考图**自动检测画风/主体/模型并写进提示词，denoising 0.4-0.5 保画风
#   C-1b 图生图 + 替换（衣服/脸/背景）→ **蒙版重绘**：只重绘目标区域，未蒙版区域像素原样保留
#        （画风天然一致；这正是「换个衣服结果画风也变了」的正解）
$mode = "$($P.Mode)"
$maskSpecRaw = "$($P.Mask)"
$formInitRaw = "$($P.InitImg)"
$paramInitRaw = "$InitImage"
# 只要「对话提交」或「表单填写」给了底图，就算显式指定 —— 解析不了必须报错，
# 绝不能默默换成「输出目录最新一张」（那正是「底图不生效、图生图和原图没关系」的根因）。
$initRaw = if ($formInitRaw) { $formInitRaw } else { $paramInitRaw }
$refPath = ''
if ($mode -eq '图生图' -and $initRaw) {
    $refPath = Resolve-InitImagePath -Raw $initRaw -OutDirPath $OutDir
    if (-not $refPath) {
        Write-Host "错误：底图没能解析成文件 —— $script:LastInitFail" -ForegroundColor Red
        Write-Host "      收到的是：$initRaw" -ForegroundColor DarkGray
        Write-Host "      请传**图片文件路径**（例：D:\pics\ref.png）；「底图」栏也可以填「最近」用输出目录最新一张。" -ForegroundColor Yellow
        Write-Host "      提示：附件哈希（sha256:…）不是文件路径，不能直接当底图。" -ForegroundColor DarkGray
        Remove-IterTempDir
        exit 1
    }
    $rsz = Get-ImageSizePx -Path $refPath
    Write-Host "底图已解析：$refPath（$($rsz.W)x$($rsz.H)）" -ForegroundColor DarkGray
}
$finalInit = ""
$finalDenoise = 0.0
$finalMask = ""
$inpaintFill = 0
$branchTag = "C-0 文生图"

if ($mode -eq '图生图' -and -not $refPath) {
    # 2026-10-15 事故根因（用户反馈「图生图和原图完全没关系」）：
    # 以前底图留空会**静默**去拿「输出目录最新一张」——结果经常抓到一个无关文件
    # （表单截图、别的会话的产物、上一轮的放大图），出图当然和用户心里的原图毫无关系。
    # 现在**不再猜**：没底图就停下来问清楚；只有显式填「最近」时才用最新一张。
    Write-Host "错误：选了「图生图」但没有底图（表单「底图」栏是空的，-InitImage 也没传）。" -ForegroundColor Red
    Write-Host "      请三选一：① 填图片完整路径（如 D:\pics\ref.png）；② 点右边「浏览…」选一张；" -ForegroundColor Yellow
    Write-Host "                ③ 填「最近」= 明确表示要用输出目录里最新的一张图。" -ForegroundColor Yellow
    Write-Host "      也可以改选「文生图」——那样根本不需要底图。" -ForegroundColor DarkGray
    Remove-IterTempDir
    exit 1
}

if ($mode -eq '文生图') {
    Write-Host "[决策 C-0] 文生图：忽略底图与蒙版，用完整提示词直出" -ForegroundColor Cyan
} else {
    $finalInit = $refPath
    $pngParams = Get-PngGenParams -Path $refPath          # ① 参考图自带 A1111 元数据（最强一致）
    $refTags = ''
    $styleFromRef = ''
    $styleBasis = @()
    if ($pngParams) {
        if ($pngParams.Model) { $styleBasis += "PNG 元数据 Model=$($pngParams.Model)" }
        if ($pngParams.Positive) { $styleBasis += 'PNG 元数据 原提示词' }
    }

    # 画风=一致 → 自动检测（元数据 → VLM → A1111 反推），并把参考图的词并进提示词
    if ("$($P.Style)" -eq '一致（自动检测参考图）') {
        if ($pngParams -and $pngParams.Model) {
            if (Test-RealisticCheckpoint $pngParams.Model) { $styleFromRef = '写实二次元' } else { $styleFromRef = '二次元' }
        }
        if (-not $styleFromRef) { $styleFromRef = Get-ImageStyleByVlm -Path $refPath }
        if (-not $refTags) { $refTags = Get-ImageTags -Path $refPath -PreferClip ([bool](-not $pngParams)) }
        if (-not $styleFromRef -and $refTags) {
            if ($refTags -match 'photo|realistic|photograph|portrait photo') { $styleFromRef = '写实' } else { $styleFromRef = '二次元' }
        }
        if ($styleFromRef) {
            Write-Host "画风一致：检测到「$styleFromRef」（依据：$($styleBasis -join ' / ')）" -ForegroundColor DarkGray
            # 用检测到的画风补一套画风词（之前注入的是空的「一致」档，这里补上）
            $stRef = Get-StylePrompt -Style $styleFromRef
            if ($stRef.Pos) { $positive = Add-StyleWords -Text $positive -Words $stRef.Pos }
            if ($stRef.Neg) { $negative = Add-StyleWords -Text $negative -Words $stRef.Neg }
            if (-not $formCheckpoint) {
                if ($styleFromRef -eq '写实二次元') {
                    $animeCk = Get-AnimeCheckpoint -Checkpoints $sdCheckpoints
                    if ($animeCk) { $formCheckpoint = $animeCk }
                } elseif ($styleFromRef -eq '二次元') {
                    $animeCk = Get-AnimeCheckpoint -Checkpoints $sdCheckpoints
                    if ($animeCk) { $formCheckpoint = $animeCk }
                } elseif ($styleFromRef -eq '写实') {
                    $realCk = @($sdCheckpoints | Where-Object { $_ -match 'majicMIX|majicmix|realistic|麦橘|写实' } | Select-Object -First 1)
                    if ($realCk.Count -gt 0) { $formCheckpoint = [string]$realCk[0] }
                }
            }
        } else {
            Write-Host "画风一致：没能从参考图判出画风（元数据/反推/VLM 都不可用），按当前设置出图" -ForegroundColor Yellow
        }
    }

    # 主体/画风一致性：把参考图的词并进提示词（剥掉与「替换目标」冲突的旧标签 → 换衣服不改画风）
    $replaceTarget = Get-ReplaceTarget -Text $positive
    $refBase = ''
    if ($pngParams -and $pngParams.Positive) { $refBase = $pngParams.Positive } elseif ($refTags) { $refBase = $refTags }
    if ($refBase) {
        $positive = Merge-ConsistencyPrompt -UserPos $positive -RefPos $refBase -Target $replaceTarget
        if ($pngParams -and $pngParams.Negative) { $negative = Add-StyleWords -Text $negative -Words $pngParams.Negative }
        Write-Host "一致性：已把参考图的词并入提示词（$(if ($replaceTarget) { "替换目标=$replaceTarget" } else { '整体一致' })）" -ForegroundColor DarkGray
    }

    # 模型=一致（照参考图）→ 用参考图自带模型
    if ("$($P.Model)" -like '一致*' -and $pngParams -and $pngParams.Model) {
        $formCheckpoint = $pngParams.Model
        Write-Host "模型一致：按参考图元数据切换 → $formCheckpoint" -ForegroundColor DarkGray
    }

    # 蒙版（C-1b）：显式填了就用；填「无」但检测到替换动作 → 按目标自动选区域
    $maskSpec = $maskSpecRaw
    $autoPathUsedForClothes = $false
    # 「手动绘制」= 弹出蒙版编辑器，让用户拿鼠标涂要重绘的区域（用户要求 2026-10-16）。
    # 优先级最高：用户既然选了手绘，就不该再被「自动抠图/替换目标推断」覆盖。
    if ($maskSpec -match '^手动|手动绘制|manual|手绘') {
        $paintOut = Join-Path $script:IterTempDir 'manual-mask.png'
        Write-Host "手动蒙版：正在打开绘制窗口（左键涂抹要重绘的区域，右键擦除，滚轮调笔刷，C 清空，Enter 确定）…" -ForegroundColor Cyan
        $painted = Show-MaskPainter -ImagePath $refPath -OutPath $paintOut
        if ($painted) {
            $finalMask = $painted
            Write-Host "手动蒙版就绪：$painted" -ForegroundColor Green
        } else {
            # 用户取消/没涂 → 不静默重画整张；退回「自动」逻辑（或几何区域），并明确告知
            Write-Host "手绘蒙版未完成（取消或没涂抹）→ 回退到自动蒙版逻辑。" -ForegroundColor Yellow
            $maskSpec = '自动（按图内容抠图）'
        }
    }
    # 「自动」是**关键字**，不是区域名：必须先把它从区域名里摘出去，否则后面会当成「认不出的区域」→
    # 退回整图重绘（2026-10-15 实测事故：用户选自动 → 日志「蒙版区域认不出 → 退回整图重绘」→ 整张图重画）。
    $autoMask = ($maskSpec -match '^自动' -or $maskSpec -eq 'auto' -or $maskSpec -eq '')
    if ($autoMask) { $maskSpec = '' }
    if ($maskSpec -match '^无') { $maskSpec = '' }
    # 自动抠图：按这张参考图的内容现生成（换衣服→衣服/身体；换背景→人以外；换脸→人脸区）
    if ($autoMask -and -not $finalMask) {
        $autoTarget = if ($replaceTarget) { $replaceTarget } else { '衣服' }
        if ($replaceTarget -eq '未指定') { $autoTarget = '主体' }
        $autoOut = Join-Path $script:IterTempDir 'auto-mask.png'
        Set-ObservabilityStatus -Status "AUTOMASK" -Detail "抠图目标=$autoTarget"
        Write-Host "自动蒙版：按参考图内容抠「$autoTarget」…（YOLO-World + SAM，首次会稍慢）" -ForegroundColor DarkGray
        # 2026-10-19 修复（关键）：这里原来用 Start-Job 调 New-AutoMaskFromImage，
        # 但 Start-Job 起的是**独立 runspace**，拿不到父脚本里定义的函数（也没传 -InitializationScript）
        # → job 必然 Failed、Receive-Job 拿到空 → 每次都静默降级成几何矩形蒙版。
        # 本机实测：同构写法 Wait-Job 返回「已完成」但 Job.State=Failed、输出为空。
        # 现在改为**同步直调**：函数内部的 240s 硬超时与逐行进度转发都能正常生效。
        $autoPath = $null
        try {
            $autoPath = New-AutoMaskFromImage -ImagePath $refPath -Target $autoTarget -OutPath $autoOut -Dilate 8 -Feather 4
        } catch {
            $script:AutoMaskNote = "抠图调用异常：$($_.Exception.Message)"
            $autoPath = $null
        }
        if ($autoPath) {
            $finalMask = $autoPath
            $lockMask = $false
            if ($autoTarget -eq '衣服') { $autoPathUsedForClothes = $true }
            Write-Host "自动蒙版就绪：$($script:AutoMaskNote)" -ForegroundColor Cyan
        } else {
            # 自动抠图失败：**不再 exit 1**（用户拿到的是「什么都没出」）。改用几何区域蒙版继续出图 ——
            # 仍然兑现「不做整图重绘」的承诺：区域蒙版只重绘画面里那一块，画风/背景照样保留。
            Write-Host "自动蒙版没成功：$($script:AutoMaskNote)" -ForegroundColor Yellow
            # 「换词没用」这类情形不要再让用户去猜（用户 2026-10-16 实测：参考图是终端报错截图，
            # 图里根本没人物，黄字却写「换词」→ 用户换多少词都不可能成功）。按诊断结果分流给出下一步。
            if ($script:AutoMaskNote -match '没检测到人物|不是人物图|是截图') {
                Write-Host "      → 这张参考图里没有人物，「换检测词」不会有用。" -ForegroundColor Yellow
                Write-Host "      → 请换一张**人物图**当参考图；若确实要在当前这张图上改，就把「蒙版」栏改成具体区域" -ForegroundColor Yellow
            }
            Write-Host "      → 不会退回几何矩形蒙版（已按需求移除）。请改用：①「手动绘制」涂出区域；② 蒙版栏填 box:x,y,w,h；③ 或先换一张人物图再抠" -ForegroundColor Yellow
            # 2026-10-19：自动抠图失败时**不再**塞几何矩形 —— 设 $maskSpec 为空 → 落到 C-1a（整图图生图，denoise 已收敛）
            $maskSpec = ""
        }
    }   # 收 if ($autoMask -and -not $finalMask)
    if (-not $finalMask -and -not $maskSpec -and $replaceTarget) {
        # 2026-10-19：不再按替换目标自动塞几何区域 —— 保持无蒙版，走 C-1a（整图图生图 + denoise 收敛）
        Write-Host "检测到替换动作（$replaceTarget）但没有可用蒙版 → 走整图图生图（C-1a）。要局部替换请用「手动绘制」或 box:x,y,w,h" -ForegroundColor DarkYellow
    }
    # 坑50（用户要求 2026-10-17）：**图生图 + 有底图 + 无蒙版 → 走默认整图图生图（C-1a）**。
    # 以前这里会在 $maskSpec 有值时强造一个几何区域蒙版，再把整条路径赶到 C-1b；
    # 但用户语义是「我就想用默认图生图流程改全图，不需要蒙版」。所以如果用户明确选了
    # 「无（整图重绘）」或者蒙版栏留空/填了非区域非图像的形态，就保持 $finalMask 为空，
    # 让后面的 `if ($finalMask) { C-1b } else { C-1a }` 自然走到 C-1a 整图图生图。
    $noMaskChosen = ($maskSpec -match '^无' -or $maskSpec -eq '' -or $maskSpec -eq '无（整图重绘）')
    if ($noMaskChosen) {
        $maskSpec = ''
        # $finalMask 保持空 → 后面走 C-1a
        Write-Host "未指定蒙版区域 → 走整图图生图流程（C-1a），不限制重绘区域" -ForegroundColor DarkGray
    } elseif ($maskSpec) {
        if ($maskSpec -match '\.(png|jpg|jpeg|webp|bmp)$') {
            $mp = $maskSpec
            if (-not [System.IO.Path]::IsPathRooted($mp)) { $mp = Join-Path $OutDir $mp }
            if (Test-Path -LiteralPath $mp) { $finalMask = $mp; $lockMask = $false } else { Write-Host "蒙版图不存在：$maskSpec → 改为按区域生成" -ForegroundColor Yellow }
        }
        if (-not $finalMask) {
            # box 坐标框: 只在确实有 box: 前缀时才给 $lockMask = $false
            if ($maskSpec -match '^box') { $lockMask = $false }
            # 先把尺寸定成「参考图的最终出图尺寸」再画蒙版：boxpx 才是参考图像素，
            # 区域名也不用再被缩放一次（用户反馈「蒙版位置有问题」的一个来源）。
            $refOut = Get-RefOutputSize -Path $refPath
            if ($refOut.W -ge 64 -and $refOut.H -ge 64) { $size = @{ W = $refOut.W; H = $refOut.H } }
            $maskOut = Join-Path $script:IterTempDir 'region-mask.png'
            $finalMask = New-RegionMask -Spec $maskSpec -W $size.W -H $size.H -OutPath $maskOut
            if ($finalMask) {
                Write-Host "区域蒙版已生成：$maskSpec（$($size.W)x$($size.H)）" -ForegroundColor DarkGray
            } else {
                # 认不出的区域名 → 落到 C-1a（图生图·一致 + denoising 收敛），**不是**把整张图重画一遍
                Write-Host "蒙版区域认不出（$maskSpec）→ 改走图生图·一致（收敛 denoising，不做整图重绘）" -ForegroundColor Yellow
            }
        }
    }

    # 坑48（用户实测 2026-10-17）：**手绘蒙版**必须给足重绘幅度，否则等于白涂。
    # 实测证据：用户涂抹腰部一条横带、denoising 0.45 → 产物与原图差异 mean=0.2、
    # 蒙版区「已改」只有 0.54% 而「未改」0.78%（qa 总览图统计）→ 涂过的地方超过一半没变化，
    # 画面上只留下一道半透明淡痕。用户语义是「这里我要改」，不是「这里轻描一下」。
    # 所以对手绘来源的蒙版单独设下限 0.62（0.45 显然盖不住原有像素）：
    #   · 用户填 >0.62 → 照用户的（尊重明确意图）
    #   · 用户填 <=0.62 或没填 → 抬到 0.62，并明确告知（不让用户对着「涂了没反应」发呆）
    # 自动抠图/区域蒙版不受此影响（它们的保护逻辑见下方 坑38/39）。
    $isManualMask = ($maskSpec -match '^手动|手动绘制|manual|手绘') -or ("$finalMask" -match 'manual-mask')
    if ($isManualMask -and $finalMask) {
        $userDen = [double]$P.Denoise
        if ($userDen -le 0.62) {
            $script:ManualDenoiseFloor = 0.62
            if ($userDen -gt 0) {
                Write-Host "手绘蒙版：denoising $userDen 偏低（涂过的区域会盖不住旧内容，实测只改动 54%）→ 抬到 0.62；要更彻底请填 0.7+" -ForegroundColor Yellow
            } else {
                Write-Host "手绘蒙版：未指定 denoising → 用 0.62（保证涂抹区域真的被重绘）" -ForegroundColor DarkGray
            }
        }
    }

    if ($finalMask) {
        # 蒙版重绘：只改目标区域，其余像素原样 → 画风/背景天然一致
        $branchTag = "C-1b 图生图·替换$(if ($replaceTarget) { "（$replaceTarget）" })"
        $finalDenoise = [double]$P.Denoise
        # 坑38（用户实测 2026-10-17）：以前这里写死 `if ($finalDenoise -lt 0.55) { $finalDenoise = 0.75 }`，
        # 把用户在表单里明确填的值（实测填了 0.45）无条件抬到 0.75 —— 用户在表单里选什么都被无视，
        # 且抬到 0.75 之后下面的「衣服保护」又判断不出来（见坑39），结果姿势/身体被一起重画。
        # 现在分三种情况：
        #   · 用户填 0（= 仍停在「文生图·不用底图」，等于没想过蒙版幅度）→ 用 0.75（蒙版内要盖住旧内容）
        #   · 用户明确填 >0（0.3-0.95）→ **照用户的值走**，不再强抬；只在偏低时给一句提示
        #   · 用户明确填 0.7+ 但属于「自动衣服蒙版」→ 仍收敛到 0.6（见下方保护）
        if ($finalDenoise -le 0) {
            $finalDenoise = 0.75            # 用户没表达幅度偏好 → 用能换掉旧内容的默认值
        } elseif ($finalDenoise -lt 0.55 -and $finalDenoise -gt 0) {
            Write-Host "注意：denoising $finalDenoise 偏小（蒙版内可能盖不住旧内容、改动不明显）；要大改请填 0.7+，要轻改保持现状即可。" -ForegroundColor DarkYellow
        }
        # 坑48：手绘蒙版套用下限 0.62（上方已判定并提示）—— 用户涂抹的语义是「这里必须改」。
        if ($isManualMask -and $finalDenoise -lt 0.62) { $finalDenoise = 0.62 }
        # 实测经验（2026-10-15）：**自动抠图给的衣服蒙版**已经贴着织物，denoising 一上 0.7-0.8 就会把
        # 躯干/姿势一起重画（用户看到的就是「换件衣服整个人都变了」）。这类蒙版收敛到 0.6：
        #   0.55-0.6 = 换版型/改动明显但姿势脸都保住；0.7+ = 换得彻底、但姿势可能变。
        # 坑39（用户实测 2026-10-17）：这个保护以前只在「主流程自己抠了图」时才生效
        # （$autoPathUsedForClothes 只在下面的自动蒙版分支里被置 true）。但对话侧**已经预抠好**
        # 蒙版时（表单里直接是 premask-*.png），主流程不会再进那个分支 → 标志位一直是 false →
        # 保护失效 → 实测 denoising 0.75 真的把姿势/身体一起重画了。
        # 现在：蒙版值只要**等于对话侧预抠的那张**（premask-*）或主流程抠的那张，就认定是衣服自动蒙版。
        if (-not $autoPathUsedForClothes -and $finalMask) {
            if ("$finalMask" -match 'premask-|auto-mask') { $autoPathUsedForClothes = $true }
        }
        if ($autoPathUsedForClothes -and $finalDenoise -gt 0.62) {
            Write-Host "衣服重绘：denoising $finalDenoise 偏大（会把姿势/身体一起重画）→ 收敛到 0.6；要大改请手动填 0.7+ 或在提示词里写清" -ForegroundColor Yellow
            $finalDenoise = 0.6
        }
        $inpaintFill = 0                                       # 填充模式（实测 fill=2 潜空间噪声会在蒙版区留噪点）
        # 出图尺寸 = 参考图原生尺寸（对齐到 8 的倍数、长边 ≤1536）；区域蒙版已在上面按**同一尺寸**画好，
        # 这里只有「用户自带蒙版图」才可能尺寸不符 → 按最近邻缩放对齐，保证区域位置不漂。
        $refOut = Get-RefOutputSize -Path $refPath
        if ($refOut.W -ge 64 -and $refOut.H -ge 64) { $size = @{ W = $refOut.W; H = $refOut.H } }
        try {
            Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
            $mb = [System.Drawing.Bitmap]::FromFile($finalMask)
            if ($mb.Width -ne $size.W -or $mb.Height -ne $size.H) {
                # 坑44：蒙版一律存成**8 位灰度、无 alpha**（原理见 Show-MaskPainter 里的说明）。
                $scaled = New-Object System.Drawing.Bitmap($size.W, $size.H, [System.Drawing.Imaging.PixelFormat]::Format8bppIndexed)
                $g2 = [System.Drawing.Graphics]::FromImage($scaled)
                $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
                # 先铺黑：源若带 alpha，DrawImage 会做透明合成，白区可能被淡化；先黑底再加白笔迹
                $g2.Clear([System.Drawing.Color]::Black)
                $g2.DrawImage($mb, 0, 0, $size.W, $size.H)
                $g2.Dispose()
                $mb.Dispose()
                try {
                    $pal2 = $scaled.Palette
                    $e2 = $pal2.Entries
                    for ($i2 = 0; $i2 -lt 256; $i2++) { $e2[$i2] = [System.Drawing.Color]::FromArgb(255, $i2, $i2, $i2) }
                    $pal2.Entries = $e2
                    $scaled.Palette = $pal2
                } catch { }
                $fixed = Join-Path $script:IterTempDir 'region-mask-scaled.png'
                $scaled.Save($fixed, [System.Drawing.Imaging.ImageFormat]::Png)
                $scaled.Dispose()
                Write-Host "蒙版尺寸已对齐：$($finalMask) → $($size.W)x$($size.H)（8bpp 灰度、无 alpha）" -ForegroundColor DarkGray
                $finalMask = $fixed
            } else {
                # 尺寸已对但带 alpha → 转灰度存一份（同样防「整图重绘」）
                if ($mb.PixelFormat -match 'Alpha') {
                    $mg = New-Object System.Drawing.Bitmap($size.W, $size.H, [System.Drawing.Imaging.PixelFormat]::Format8bppIndexed)
                    $g3 = [System.Drawing.Graphics]::FromImage($mg)
                    $g3.Clear([System.Drawing.Color]::Black)
                    $g3.DrawImage($mb, 0, 0, $size.W, $size.H)
                    $g3.Dispose()
                    $mb.Dispose()
                    try {
                        $pal3 = $mg.Palette; $e3 = $pal3.Entries
                        for ($i3 = 0; $i3 -lt 256; $i3++) { $e3[$i3] = [System.Drawing.Color]::FromArgb(255, $i3, $i3, $i3) }
                        $pal3.Entries = $e3; $mg.Palette = $pal3
                    } catch { }
                    $fixed2 = Join-Path $script:IterTempDir 'region-mask-scaled.png'
                    $mg.Save($fixed2, [System.Drawing.Imaging.ImageFormat]::Png)
                    $mg.Dispose()
                    Write-Host "蒙版已转灰度（去 alpha）→ $fixed2" -ForegroundColor DarkGray
                    $finalMask = $fixed2
                } else { $mb.Dispose() }
            }
        } catch { }
        Write-Host "[决策 C-1b] 蒙版重绘：蒙版=$finalMask（denoising=$finalDenoise，填充=填充模式，尺寸=$($size.W)x$($size.H)）" -ForegroundColor Cyan
        Write-Host "            未蒙版区域按原图保留 → 画风不会跟着换衣服一起变" -ForegroundColor DarkGray
        # ---- 坑43（用户实测 2026-10-17，出图为黑块/碎片）：底图与蒙版必须**同尺寸**交给 SD ----
        # 现场：参考图 2496x3648，出图尺寸被 Get-RefOutputSize 收敛到 1048x1536；蒙版已按
        # 1048x1536 存好（上面这段对齐），但 -InitImage 仍指向 **2496x3648 的原图**。
        # A1111 的 img2img+mask 在这种情况下会**各自独立缩放** init 与 mask，两者对齐出错 →
        # 结果是「大片黑块 + 左上角一块碎片」（实测产物就是那样，完全不可用）。
        # 修法：出图前把底图也缩到 $size，与蒙版逐像素同尺寸。蒙版未覆盖区域本就是原图像素被
        # 保留，所以缩底图不影响「未蒙版区保持原样」的承诺（缩放只发生一次、两者同步）。
        if ($finalInit -and (Test-Path -LiteralPath $finalInit)) {
            try {
                Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
                $ib = [System.Drawing.Bitmap]::FromFile($finalInit)
                if ($ib.Width -ne $size.W -or $ib.Height -ne $size.H) {
                    # 坑45（同批实测）：底图也**不能带 alpha**。原图是 RGBA 时，缩放后存 PNG 仍带 alpha，
                    # A1111 在 inpaint 里会把「有 alpha 的 init 图」当成带蒙版信息 → 与 mask 双重判定，
                    # 导致整图重绘（产物全黑）。这里明确用 Format24bppRgb 输出，彻底去掉 alpha 通道。
                    $iscaled = New-Object System.Drawing.Bitmap($size.W, $size.H, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
                    $ig = [System.Drawing.Graphics]::FromImage($iscaled)
                    $ig.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    # 纯色底：先把目标涂黑，避免源 alpha 参与合成（FromFile 读 RGBA 时 DrawImage 会做透明合成）
                    $ig.Clear([System.Drawing.Color]::Black)
                    $ig.DrawImage($ib, 0, 0, $size.W, $size.H)
                    $ig.Dispose()
                    $ib.Dispose()
                    $ifixed = Join-Path $script:IterTempDir 'init-scaled.png'
                    $iscaled.Save($ifixed, [System.Drawing.Imaging.ImageFormat]::Png)
                    $iscaled.Dispose()
                    Write-Host "底图尺寸已对齐：→ $($size.W)x$($size.H)（24bpp 无 alpha，与蒙版同尺寸）" -ForegroundColor DarkGray
                    $finalInit = $ifixed
                } else {
                    # 尺寸已对，但可能仍带 alpha → 同样转成 24bpp 版本
                    if ($ib.PixelFormat -match 'Alpha') {
                        $irgb = New-Object System.Drawing.Bitmap($size.W, $size.H, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
                        $ig2 = [System.Drawing.Graphics]::FromImage($irgb)
                        $ig2.Clear([System.Drawing.Color]::Black)
                        $ig2.DrawImage($ib, 0, 0, $size.W, $size.H)
                        $ig2.Dispose()
                        $ib.Dispose()
                        $ifixed2 = Join-Path $script:IterTempDir 'init-scaled.png'
                        $irgb.Save($ifixed2, [System.Drawing.Imaging.ImageFormat]::Png)
                        $irgb.Dispose()
                        Write-Host "底图已去 alpha：→ $ifixed2" -ForegroundColor DarkGray
                        $finalInit = $ifixed2
                    } else { $ib.Dispose() }
                }
            } catch {
                Write-Host "底图尺寸对齐失败（沿用原图）：$($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    } else {
        $branchTag = 'C-1a 图生图·一致'
        $finalDenoise = [double]$P.Denoise
        if ($finalDenoise -le 0) { $finalDenoise = 0.65 }   # 表单没填/填 0 时的图生图默认值（用户 2026-10-18 指定）
        if ($finalDenoise -gt 0.65) {
            Write-Host "一致模式：denoising $finalDenoise 偏大（会把原图洗掉 → 实测就是「和原图没关系」）→ 收敛到 0.65；要大改请用「替换 + 蒙版」" -ForegroundColor Yellow
            $finalDenoise = 0.65
        }
        # 尺寸跟着**参考图走**（原来用表单比例/画质，会把 1024x1024 压成 480x853 → 构图和原图对不上）
        $refOut = Get-RefOutputSize -Path $finalInit
        if ($refOut.W -ge 64 -and $refOut.H -ge 64) { $size = @{ W = $refOut.W; H = $refOut.H } }
        Write-Host "[决策 C-1a] 图生图：底图=$finalInit（原图 $($refOut.SrcW)x$($refOut.SrcH)），denoising=$finalDenoise，出图尺寸=$($size.W)x$($size.H)" -ForegroundColor Cyan
    }
}
Write-Host "最终出图：$branchTag" -ForegroundColor Cyan
# 坑46（用户实测 2026-10-17）：出图前把两个提示词**统一归一化**（压连续逗号、去尾逗号）。
# 这是最后一道关，保证交给 SD 的字符串永远是「逗号分隔、无空标签」的规范形态——
# 空标签会让 CLIP 分词把相邻概念错位（实测这类脏提示词下重绘产物出现整片黑块）。
$positive = Normalize-PromptText $positive
$finalNegative = Normalize-PromptText $finalNegative
if ($finalNegative -and $positive -notmatch [regex]::Escape($finalNegative)) { }  # 正负互不干扰，仅格式归一
Write-Host "最终正向（归一化后）: $positive" -ForegroundColor DarkGray
# 出图要 SD 把模型读回显存：先把本地模型服务卸掉，别跟 SD 抢卡（用户要求：每次运行前先释放显存）
$null = Release-OllamaVram
# P5（2026-10-18）：最终出图**统一经网关**（前端不再直连 WebUI/ComfyUI）：
#   · 用户在表单里点过「提交出图（网关·异步）」并且成功了 → 直接用那张（$P.GwPaths）
#   · 否则：把最终提示词/底图/蒙版交给网关 → POST /api/generate → 同步轮询 /api/status
#   · 网关彻底不可用时：ComfyUI 两档（QwenImage_NVFP4 / Krea2_Q4）明确报错退出（禁止直连 ComfyUI）；
#     SD 两档允许用 -LocalBackendFallback 应急退回本地 sd-direct 管线（默认关闭）。
$selectedModel = $gwSelectedModel
if ($script:GatewayModels -notcontains $selectedModel) { $selectedModel = 'SD_FP16' }
$gwBase = Get-GatewayBase
$gwModelUsed = $selectedModel

if ($P.GwPaths -and @($P.GwPaths).Count -gt 0) {
    $gwPaths = @($P.GwPaths)
    $existing = @($gwPaths | Where-Object { Test-Path -LiteralPath $_ })
    if ($existing.Count -gt 0) {
        # 表单路径出的图也要过质检（原来这里写死 Score=100、VlmDown=$true，等于跳过质检）
        $finalWin = Invoke-GatewayQualityCheck -Paths $existing
        Write-Host "表单已用网关出图（$selectedModel）→ 直接采用：$($existing -join ' | ')" -ForegroundColor Green
    }
}

if (-not $finalWin) {
    $gatewayReady = $false
    if (-not $NoGateway) { $gatewayReady = Start-GatewayIfNeeded -WaitSec 30 }
    if ($gatewayReady) {
        $gwW = $size.W; $gwH = $size.H
        if ($P.GwWidth -gt 0 -and $P.GwHeight -gt 0) {
            $g = Test-GatewayModelSize -Model $selectedModel -Width ([int]$P.GwWidth) -Height ([int]$P.GwHeight)
            if ($g.Ok) { $gwW = [int]$P.GwWidth; $gwH = [int]$P.GwHeight }
            else { Write-Host "表单宽高不合法（$($g.Message)）→ 改用比例/画质档尺寸 ${gwW}x${gwH}" -ForegroundColor Yellow }
        }
        # ADetailer 面部修复（默认启用单单元 face_yolov8s.pt，正负词留空 = 原行为）透传给 WebUI 侧
        $extraWebui = @{}
        if ($selectedModel -in @('SD_FP16', 'Anima_INT8')) {
            $extraWebui = @{
                # 内置 restore_faces 保持关闭（坑33：8G 卡上 GFPGAN/CodeFormer 与质检模型抢显存会在 100% 处卡死）
                alwayson_scripts = @{ ADetailer = @{ args = @(@{ ad_model = 'face_yolov8s.pt'; ad_prompt = ''; ad_negative_prompt = '' }) } }
            }
        }
        Write-Host "经网关出图：$gwBase 模型=$selectedModel 尺寸=${gwW}x${gwH} 步数=$Steps denoising=$finalDenoise" -ForegroundColor Cyan
        $sub = New-GatewayTask -Model $selectedModel -Prompt $positive -Negative $finalNegative `
            -Width $gwW -Height $gwH -Steps (Get-ModelSteps -Model $selectedModel) -Cfg (Get-ModelCfg -Model $selectedModel) -Denoise $finalDenoise `
            -Sampler $(if ($selectedModel -in @('SD_FP16', 'Anima_INT8')) { "$Sampler" } else { '' }) `
            -InitImage $(if ($finalInit) { $finalInit } else { '' }) `
            -Mask $finalMask -Name $Name -OutDir $OutDir -Checkpoint "$formCheckpoint" -Extra $(if ($extraWebui.Count -gt 0) { $extraWebui } else { $null })
        if (-not $sub.Ok) {
            Write-Host "网关提交失败：$($sub.Message)" -ForegroundColor Red
        } else {
            $wr = Wait-GatewayTask -TaskId $sub.TaskId -TimeoutSec 3600
            if ($wr.Ok) {
                $paths = @($wr.Raw.paths)
                $existing = @($paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
                if ($existing.Count -eq 0) {
                    Write-Host "网关返回成功但没有可用图片路径（$($paths -join ', ')）" -ForegroundColor Red
                } else {
                    # 网关出的图逐张质检取最高分（原来写死 100 = 跳过质检）
                    $finalWin = Invoke-GatewayQualityCheck -Paths $existing
                    Write-Host "最终成品（网关/$selectedModel）: $($existing -join ' | ')" -ForegroundColor Green
                }
            } else {
                Write-Host "网关卡在 [$($wr.Status)]：$($wr.Message)" -ForegroundColor Red
            }
        }
    } else {
        Write-Host "网关不可用（$gwBase）" -ForegroundColor Yellow
        if ($selectedModel -in @('QwenImage_NVFP4', 'Krea2_Q4')) {
            Write-Host "与网关断开连接：ComfyUI 系模型（$selectedModel）禁止前端直连 → 本次不出图。请先启动 gateway\\index.js。" -ForegroundColor Red
            exit 1
        }
        if (-not $LocalBackendFallback) {
            Write-Host "与网关断开连接：默认不再直连 WebUI 出图。应急可加 -LocalBackendFallback（架构上不推荐）。" -ForegroundColor Red
            exit 1
        }
        Write-Host "已启用 -LocalBackendFallback → 退回本地 sd-direct 管线出图（仅应急）" -ForegroundColor Yellow
    }
}

if (-not $finalWin -and $LocalBackendFallback -and $selectedModel -in @('SD_FP16', 'Anima_INT8')) {
    # 应急本地直连（默认关闭）：网关完全不可用且用户显式加 -LocalBackendFallback 时才走这里
    Write-Host "本地直连管线出图（应急路径）" -ForegroundColor Yellow
    $finalWin = Invoke-FinalIterate -InitImage $finalInit -Denoising $finalDenoise -Rounds $P.Rounds -W $size.W -H $size.H -Checkpoint $formCheckpoint -Mask $finalMask -InpaintFill $inpaintFill
} elseif (-not $finalWin) {
    Write-Host "最终出图未产出（网关路径失败或未提交）" -ForegroundColor Red
}


if ($finalWin) {
    if ($finalWin.VlmDown) {
        # 质检模型起不来：先把本轮生成的所有候选图复制进工作区并全部打开，
        # 再弹带缩略图的多选对话框，让用户勾选要保留的（单选/多选/全选），未勾选的删除。
        Write-Host ""
        Write-Host "质检模型未就绪，已生成 $($finalWin.Paths.Count) 张候选图：" -ForegroundColor Green
        $saved = @()
        foreach ($p in $finalWin.Paths) {
            $dst = Get-UniqueOutPath -BaseName $finalBaseName
            Copy-Item -LiteralPath $p -Destination $dst -Force
            $saved += $dst
            Write-Host "  $dst"
        }
        Remove-IterTempDir
        if (-not $NoOpen) {
            foreach ($dst in $saved) {
                try { Start-Process -FilePath $dst } catch { }
            }
        }
        if ($saved.Count -gt 1) {
            $kept = Show-ImagePicker -Images $saved
            foreach ($dst in $saved) {
                if ($kept -notcontains $dst) {
                    try { Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue } catch { }
                    Write-Host "  已删除未选中: $(Split-Path $dst -Leaf)" -ForegroundColor DarkGray
                }
            }
            Write-Host "已保留 $($kept.Count) 张。" -ForegroundColor Green
        } else {
            Write-Host "仅生成 1 张，已保留。" -ForegroundColor DarkGray
        }
        # 加字（2026-10-20）：这一档可能保留多张；加字只作用于保留的第 1 张（逐张加字太慢）
        $preGenInSaved = ($script:PreGenTexted -and $script:PreGenResult -and (@($saved) -contains "$($script:PreGenResult.Path)"))
        if ($addTextFinal -and @($saved).Count -gt 0 -and -not $preGenInSaved) {
            $texted = Invoke-AddTextStage -Path @($saved)[0] -BaseName $finalBaseName -Text $addTextFinal -Model $addTextModelAsked -GenModel $genModelForText -OutDirPath $OutDir -Pos "$addTextPosFinal" -Size "$addTextSizeFinal" -Style "$addTextStyleFinal"
            if ($texted -and $texted -ne @($saved)[0]) { $saved = @($texted) + @(@($saved) | Select-Object -Skip 1) }
        }
        Remove-RunWorkFiles -KeepPaths @($saved)
    } else {
        # 正常模式：复制最高分那张
        $finalPath = Get-UniqueOutPath -BaseName $finalBaseName
        Copy-Item -LiteralPath $finalWin.Path -Destination $finalPath -Force
        # 蒙版重绘的产物自动体检一次（在临时目录被清掉之前跑，蒙版就在那里面）
        if ($finalMask -and $finalInit) {
            Write-Host ""
            Write-Host "蒙版命中率体检（换中性提示词时，未蒙版残留就是漏检）：" -ForegroundColor Cyan
            Invoke-MaskQaReport -RefPath $finalInit -MaskPath $finalMask -OutPath $finalPath -QaDir $script:IterTempDir
        }
        Remove-IterTempDir
        Write-Host ""
        Write-Host "最终成品: $finalPath（seed=$($finalWin.Seed)$(if ($finalWin.Score -ge 0) { "，脸/手 $($finalWin.Score)/100" })）" -ForegroundColor Green
        Write-Host "（迭代中间图已存于临时目录并清理，工作区只保留成品）" -ForegroundColor DarkGray
        # ---- 加字后处理（2026-10-20）：先正常出图，最后由**另一档模型**在成品上加字 ----
        #   例外：这张就是预生成那张、而预生成阶段已经加过字 → 不再加第二遍（否则字会叠成双份）。
        #   2026-10-21：位置能在表单里改 —— 改过就从**未加字的原图**重加一遍（不能叠在旧字上）。
        $preGenAlreadyTexted = ($script:PreGenTexted -and $finalWin.Path -and $script:PreGenResult -and ("$($finalWin.Path)" -eq "$($script:PreGenResult.Path)"))
        $posChanged = ($script:PreGenTextPos -and "$addTextPosFinal" -and ("$addTextPosFinal" -ne "$script:PreGenTextPos"))
        $sizeChanged = ($script:PreGenTextSize -and "$addTextSizeFinal" -and ((Format-AddTextSizeLabel -Spec "$addTextSizeFinal") -ne (Format-AddTextSizeLabel -Spec "$script:PreGenTextSize")))
        $styleChanged = ($script:PreGenTextStyle -and "$addTextStyleFinal" -and ((Format-AddTextStyleLabel -Spec "$addTextStyleFinal") -ne (Format-AddTextStyleLabel -Spec "$script:PreGenTextStyle")))
        if ($sizeChanged -or $styleChanged) { $posChanged = $true }
        if ($addTextFinal -and ((-not $preGenAlreadyTexted) -or $posChanged)) {
            $textBase = $finalPath
            if ($preGenAlreadyTexted -and $posChanged -and $script:PreGenResult.Original -and (Test-Path -LiteralPath "$($script:PreGenResult.Original)")) {
                $textBase = "$($script:PreGenResult.Original)"
                Write-Host ("位置改成「{0}」→ 用未加字的原图重加一遍：{1}" -f (Format-AddTextPosLabel -Spec "$addTextPosFinal"), (Split-Path $textBase -Leaf)) -ForegroundColor Cyan
            }
            $finalPath = Invoke-AddTextStage -Path $textBase -BaseName $finalBaseName -Text $addTextFinal -Model $addTextModelAsked -GenModel $genModelForText -OutDirPath $OutDir -Pos "$addTextPosFinal" -Size "$addTextSizeFinal" -Style "$addTextStyleFinal"
        } elseif ($preGenAlreadyTexted) {
            Write-Host "这张就是预生成阶段已加过字的那张 → 不重复加字" -ForegroundColor DarkGray
        }
        Remove-RunWorkFiles -KeepPaths @($finalPath)
        # 收工：把本地视觉模型也卸掉，别让它长期占着显卡（下次审核会自动重载）
        $null = Release-OllamaVram
        if (-not $NoOpen) {
            try {
                Start-Process -FilePath $finalPath
                Write-Host "已打开: $finalPath"
            } catch {
                Write-Host "自动打开失败（$($_.Exception.Message)），可手动打开：$finalPath" -ForegroundColor Yellow
            }
        }
    }
} else {
    Remove-IterTempDir
    Remove-RunWorkFiles
    Write-Host "最终出图未产出（迭代全部失败）" -ForegroundColor Red
    exit 1
}
