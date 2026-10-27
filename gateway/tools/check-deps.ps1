# =============================================================================
# check-deps.ps1 —— 依赖体检（安装引导的可执行版）
#
# 逐项扫描本机：插件本体 / Node / SD WebUI / checkpoint / VAE / LoRA / CLIP 权重 /
# transformers pin / ADetailer / ComfyUI / ComfyUI-GGUF / Qwen 三件套 / Krea2 /
# Ollama + qwen3-vl / ROS2 rosbridge / 网关端口 / 产物目录。
#
# 每项输出：状态（OK / MISSING / WARN）、路径、大小，以及**缺失时的下载命令**。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File check-deps.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File check-deps.ps1 -Markdown docs\deps-report.md
#   powershell -NoProfile -ExecutionPolicy Bypass -File check-deps.ps1 -SdDir D:\SD.4.8 -ComfyDir D:\ComfyUI
#   powershell -NoProfile -ExecutionPolicy Bypass -File check-deps.ps1 -Quiet      # 只输出 JSON（给 CI 用）
#
# 退出码：0 = 无 MISSING（可有 WARN）；1 = 有 MISSING
# =============================================================================
param(
    [string]$SdDir = "",
    [string]$ComfyDir = "",
    [string]$GatewayBase = "",
    [string]$Markdown = "",
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:Root = $PSScriptRoot
if (-not $script:Root) { try { $script:Root = Split-Path -Parent $PSCommandPath } catch { } }
# gateway\tools → 插件根
$pluginRoot = (Resolve-Path (Join-Path $script:Root '..\..')).Path

$results = New-Object System.Collections.Generic.List[object]

function Add-Result {
    param([string]$Id, [string]$Name, [string]$Status, [string]$Path = '', [string]$Detail = '', [string]$Fix = '')
    $size = ''
    if ($Path -and (Test-Path -LiteralPath $Path)) {
        try {
            $it = Get-Item -LiteralPath $Path -ErrorAction Stop
            if ($it.PSIsContainer) {
                $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
                $size = ("{0:N0} 文件 / {1} GB" -f (Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count, [math]::Round($sum / 1GB, 2))
            } else {
                $size = ("{0} GB" -f [math]::Round($it.Length / 1GB, 2))
            }
        } catch { }
    }
    $results.Add([pscustomobject]@{ Id = $Id; Name = $Name; Status = $Status; Path = $Path; Size = $size; Detail = $Detail; Fix = $Fix })
}

function Find-FileShallow {
    param([string]$Dir, [string]$Filter, [int]$Depth = 3)
    if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { return $null }
    try {
        $hit = Get-ChildItem -LiteralPath $Dir -Recurse -Depth $Depth -File -Filter $Filter -ErrorAction SilentlyContinue |
            Sort-Object Length -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    } catch { }
    return $null
}

function Find-DirShallow {
    param([string]$Dir, [string]$Name, [int]$Depth = 3)
    if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { return $null }
    try {
        $hit = Get-ChildItem -LiteralPath $Dir -Recurse -Depth $Depth -Directory -Filter $Name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    } catch { }
    return $null
}

# ---------------------------------------------------------------- 1. 运行时
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nv = (& node -v) 2>$null
    $major = 0
    if ("$nv" -match '^v(\d+)') { $major = [int]$Matches[1] }
    Add-Result 'node' 'Node.js ≥18（网关运行时）' $(if ($major -ge 18) { 'OK' } else { 'MISSING' }) $nodeCmd.Source "版本 $nv" `
        'winget install OpenJS.NodeJS.LTS   # 或 https://nodejs.org/dist/'
} else {
    Add-Result 'node' 'Node.js ≥18（网关运行时）' 'MISSING' '' 'PATH 里没有 node' 'winget install OpenJS.NodeJS.LTS'
}

Add-Result 'plugin' '插件本体' 'OK' $pluginRoot (Split-Path -Leaf $pluginRoot) ''
Add-Result 'gateway' '调度网关（gateway\index.js）' $(if (Test-Path (Join-Path $pluginRoot 'gateway\index.js')) { 'OK' } else { 'MISSING' }) (Join-Path $pluginRoot 'gateway') '' '插件包不完整：重新解压 Releases 里的 zip / 重装 npm 包'

# ---------------------------------------------------------------- 2. SD 侧
if (-not $SdDir) {
    foreach ($c in @($env:DSH_SD_DIR, $env:SD_DIR, (Join-Path $pluginRoot '..\SD.4.8'), 'D:\SD.4.8')) {
        if ($c -and (Test-Path -LiteralPath (Join-Path $c 'launch.py'))) { $SdDir = (Resolve-Path $c).Path; break }
    }
}
if (-not $SdDir) {
    # 浅扫各盘一级目录
    foreach ($drv in @('D:\', 'E:\', 'C:\', 'F:\')) {
        if (-not (Test-Path $drv)) { continue }
        foreach ($d in (Get-ChildItem -LiteralPath $drv -Directory -ErrorAction SilentlyContinue)) {
            if (Test-Path -LiteralPath (Join-Path $d.FullName 'launch.py')) { $SdDir = $d.FullName; break }
        }
        if ($SdDir) { break }
    }
}

if ($SdDir -and (Test-Path -LiteralPath (Join-Path $SdDir 'launch.py'))) {
    Add-Result 'sd-root' 'Stable Diffusion WebUI（launch.py）' 'OK' $SdDir '' ''
} else {
    Add-Result 'sd-root' 'Stable Diffusion WebUI（launch.py）' 'MISSING' '' '找不到含 launch.py 的目录（可 -SdDir 指定）' `
        'powershell -NoProfile -ExecutionPolicy Bypass -File install-sd.ps1   # 插件自带自举安装器'
}

if ($SdDir) {
    $ckptDir = Join-Path $SdDir 'models\Stable-diffusion'
    $ckpt = Find-FileShallow $ckptDir '*.safetensors' 0
    Add-Result 'sd-ckpt' 'SD checkpoint（主模型）' $(if ($ckpt) { 'OK' } else { 'MISSING' }) $(if ($ckpt) { $ckpt } else { $ckptDir }) '' `
        'Civitai/HF 下载 .safetensors 放进 models\Stable-diffusion\（示例：AWPainting_v1.2 / anything-v5）'

    $vae = Find-FileShallow (Join-Path $SdDir 'models\VAE') '*.safetensors' 0
    if (-not $vae) { $vae = Find-FileShallow (Join-Path $SdDir 'models\VAE') '*.pt' 0 }
    Add-Result 'sd-vae' 'VAE（可选，颜色/细节修正）' $(if ($vae) { 'OK' } else { 'WARN' }) $(if ($vae) { $vae } else { Join-Path $SdDir 'models\VAE' }) '' `
        'https://huggingface.co/stabilityai/sd-vae-ft-mse-original （镜像 hf-mirror.com）'

    $loraCount = 0
    try { $loraCount = (Get-ChildItem (Join-Path $SdDir 'models\Lora') -File -ErrorAction SilentlyContinue | Measure-Object).Count } catch { }
    Add-Result 'sd-lora' 'LoRA（可选：细节/负面词/手部）' $(if ($loraCount -gt 0) { 'OK' } else { 'WARN' }) (Join-Path $SdDir 'models\Lora') "$loraCount 个文件" `
        'Civitai 下载 add_detail / easynegative / badhandv4 放进 models\Lora\'

    # CLIP 权重（坑56）
    $clipRoot = Join-Path $SdDir '.cache\huggingface\hub\models--openai--clip-vit-large-patch14'
    $clipW = $null
    if (Test-Path -LiteralPath $clipRoot) {
        $clipW = Get-ChildItem -LiteralPath $clipRoot -Recurse -File -Include 'model.safetensors', 'pytorch_model.bin' -ErrorAction SilentlyContinue |
            Where-Object { $_.Length -gt 100MB } | Select-Object -First 1
    }
    if ($clipW) {
        Add-Result 'sd-clip' 'CLIP 文本编码器 clip-vit-large-patch14（点图必需）' 'OK' $clipW.FullName '' ''
    } else {
        $rev = '8d052a0f05efbaefbc9e8786ba291cfdf93e5bff'
        Add-Result 'sd-clip' 'CLIP 文本编码器 clip-vit-large-patch14（点图必需）' 'MISSING' $clipRoot '缺失 → txt2img 必 500（故障 ①）' `
            ('curl -L -C - -o "{0}\snapshots\{1}\model.safetensors" https://hf-mirror.com/openai/clip-vit-large-patch14/resolve/main/model.safetensors' -f $clipRoot, $rev)
    }

    # transformers pin（坑56 ②）
    $sdPy = Join-Path $SdDir 'python\python.exe'
    if (Test-Path -LiteralPath $sdPy) {
        $ver = (& $sdPy -c "import importlib.metadata as m;print(m.version('transformers'))" 2>$null)
        $tok = (& $sdPy -c "import importlib.metadata as m;print(m.version('tokenizers'))" 2>$null)
        $hub = (& $sdPy -c "import importlib.metadata as m;print(m.version('huggingface-hub'))" 2>$null)
        $verOk = ("$ver" -match '^4\.')
        Add-Result 'sd-pin' "Python 依赖 pin（transformers $ver / tokenizers $tok / hf_hub $hub）" $(if ($verOk) { 'OK' } else { 'MISSING' }) $sdPy `
            $(if ($verOk) { '' } else { 'transformers 5.x 会让 A1111 崩（故障 ②）' }) `
            ('& "{0}" -m pip install --no-deps --timeout 60 -i https://pypi.tuna.tsinghua.edu.cn/simple transformers==4.30.2 tokenizers==0.13.3 huggingface_hub==0.23.5' -f $sdPy)
    } else {
        Add-Result 'sd-pin' 'Python 依赖 pin（transformers 4.x）' 'WARN' '' '没找到 SD 自带 python，跳过' ''
    }

    $ad = Find-DirShallow (Join-Path $SdDir 'extensions') 'adetailer' 1
    Add-Result 'sd-ext-adetailer' 'ADetailer 扩展（默认面部修复）' $(if ($ad) { 'OK' } else { 'WARN' }) $(if ($ad) { $ad } else { Join-Path $SdDir 'extensions' }) '' `
        'WebUI → Extensions → Install from URL：https://github.com/Bing-su/adetailer'
}

# ---------------------------------------------------------------- 3. ComfyUI 侧
if (-not $ComfyDir) {
    foreach ($c in @($env:GW_COMFY_DIR, $env:COMFY_DIR, 'D:\ComfyUI')) {
        if ($c -and (Test-Path -LiteralPath (Join-Path $c 'main.py'))) { $ComfyDir = (Resolve-Path $c).Path; break }
    }
}
if (-not $ComfyDir) {
    foreach ($drv in @('D:\', 'E:\', 'C:\', 'F:\')) {
        if (-not (Test-Path $drv)) { continue }
        foreach ($d in (Get-ChildItem -LiteralPath $drv -Directory -ErrorAction SilentlyContinue)) {
            if (Test-Path -LiteralPath (Join-Path $d.FullName 'main.py')) { $ComfyDir = $d.FullName; break }
        }
        if ($ComfyDir) { break }
    }
}

if ($ComfyDir -and (Test-Path -LiteralPath (Join-Path $ComfyDir 'main.py'))) {
    Add-Result 'comfy-root' 'ComfyUI（main.py）' 'OK' $ComfyDir '' ''
} else {
    Add-Result 'comfy-root' 'ComfyUI（main.py）' 'MISSING' '' 'QwenImage_NVFP4 / Krea2_Q4 两档需要它' `
        'git clone https://github.com/comfyanonymous/ComfyUI D:\ComfyUI'
}

if ($ComfyDir) {
    $py = Join-Path $ComfyDir 'venv\Scripts\python.exe'
    if (-not (Test-Path $py)) { $py = Join-Path $ComfyDir '.venv\Scripts\python.exe' }
    if (Test-Path $py) {
        $tv = (& $py -c "import torch;print(torch.__version__, torch.version.cuda)" 2>$null)
        Add-Result 'comfy-venv' 'ComfyUI 独立 venv（torch cu128）' 'OK' $py "torch $tv" ''
    } else {
        Add-Result 'comfy-venv' 'ComfyUI 独立 venv（torch cu128）' 'MISSING' (Join-Path $ComfyDir 'venv') '' `
            'python -m venv venv; .\venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu128; .\venv\Scripts\pip install -r requirements.txt'
    }

    $gguf = Find-DirShallow (Join-Path $ComfyDir 'custom_nodes') 'ComfyUI-GGUF' 1
    Add-Result 'comfy-node-gguf' '自定义节点 ComfyUI-GGUF' $(if ($gguf) { 'OK' } else { 'MISSING' }) $(if ($gguf) { $gguf } else { Join-Path $ComfyDir 'custom_nodes' }) '' `
        'git clone https://github.com/city96/ComfyUI-GGUF custom_nodes\ComfyUI-GGUF'

    $qwen = Find-FileShallow (Join-Path $ComfyDir 'models\unet') '*.gguf' 1
    Add-Result 'qwen-unet' 'Qwen-Image UC Q4_K_M GGUF（4.29G）' $(if ($qwen) { 'OK' } else { 'MISSING' }) $(if ($qwen) { $qwen } else { Join-Path $ComfyDir 'models\unet' }) '' `
        'HF QuantStack/Qwen-Image-2.1-UC-GGUF → models\unet\（镜像：hf-mirror.com）'

    $qclip = Find-FileShallow (Join-Path $ComfyDir 'models\text_encoders') 'qwen3vl_8b_int8_convrot.safetensors' 1
    Add-Result 'qwen-clip' 'Qwen 文本编码器（8.71G，需整体入内存）' $(if ($qclip) { 'OK' } else { 'MISSING' }) $(if ($qclip) { $qclip } else { Join-Path $ComfyDir 'models\text_encoders' }) '' `
        '同仓库 text_encoders 文件 → models\text_encoders\；可用内存 < 7G 会崩（故障 ⑤）'

    $qvae = Find-FileShallow (Join-Path $ComfyDir 'models\vae') 'qwen_image_2.1_vae_bf16.safetensors' 1
    Add-Result 'qwen-vae' 'Qwen VAE（0.63G）' $(if ($qvae) { 'OK' } else { 'MISSING' }) $(if ($qvae) { $qvae } else { Join-Path $ComfyDir 'models\vae' }) '' `
        '同仓库 vae 文件 → models\vae\'

    $krea = Find-FileShallow (Join-Path $ComfyDir 'models\unet') 'krea2*.safetensors' 1
    Add-Result 'krea-unet' 'Krea2_Q4 权重（可选）' $(if ($krea) { 'OK' } else { 'WARN' }) $(if ($krea) { $krea } else { Join-Path $ComfyDir 'models\unet' }) `
        $(if ($krea) { '' } else { '未装则该档位明确报 no-model（不崩）' }) '按你手上的 Krea2 发布渠道下载 → models\unet\krea2_q4.safetensors'
}

# ---------------------------------------------------------------- 4. 可选：VLM 质检
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollama) {
    $models = (& ollama list) 2>$null | Out-String
    $hasVl = $models -match 'qwen3-vl'
    Add-Result 'ollama' 'Ollama（本地视觉质检运行时，可选）' 'OK' $ollama.Source '' ''
    Add-Result 'ollama-vlm' 'qwen3-vl:8b 视觉质检模型（6.1G，可选）' $(if ($hasVl) { 'OK' } else { 'WARN' }) '' `
        $(if ($hasVl) { '' } else { '未装 → 脸/手质检自动降级为"出满 N 张你自选"，不影响出图' }) 'ollama pull qwen3-vl:8b'
} else {
    Add-Result 'ollama' 'Ollama（本地视觉质检运行时，可选）' 'WARN' '' '未装 → 质检自动降级，不影响出图' 'https://ollama.com/download'
}

# ---------------------------------------------------------------- 5. 可选：ROS2 监控
$ros2 = $false
try {
    $t = Test-NetConnection -ComputerName 127.0.0.1 -Port 9090 -InformationLevel Quiet -WarningAction SilentlyContinue
    $ros2 = [bool]$t
} catch { }
Add-Result 'ros2' 'rosbridge（ws://localhost:9090，可选）' $(if ($ros2) { 'OK' } else { 'WARN' }) '' `
    $(if ($ros2) { '' } else { '未运行 → 监控自动降级 nvidia-smi（本机实测即此路径）' }) '装 rosbridge_suite 并 ros2 launch rosbridge_server rosbridge_websocket_launch.xml'

# ---------------------------------------------------------------- 6. 服务与产物目录
if (-not $GatewayBase) {
    $port = 8799
    if ($env:GW_PORT) { $null = [int]::TryParse($env:GW_PORT, [ref]$port) }
    $GatewayBase = "http://127.0.0.1:$port"
}
$gwUp = $false
try { $gwUp = ((Invoke-RestMethod "$GatewayBase/api/health" -TimeoutSec 3).gateway -eq 'ok') } catch { }
Add-Result 'gateway-up' ("网关在跑（{0}）" -f $GatewayBase) $(if ($gwUp) { 'OK' } else { 'WARN' }) '' `
    $(if ($gwUp) { '' } else { '没跑也没关系：sd-inject / 插件会在需要时自动拉起它' }) 'node gateway\index.js'

$outDir = if ($env:GW_OUT_DIR) { $env:GW_OUT_DIR } else { Join-Path (Split-Path -Parent $pluginRoot) 'SD-Picture' }
Add-Result 'out-dir' '产物目录' $(if (Test-Path -LiteralPath $outDir) { 'OK' } else { 'WARN' }) $outDir '' "New-Item -ItemType Directory -Force '$outDir'"

$nvsmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvsmi) {
    $gpu = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader) 2>$null
    Add-Result 'gpu' 'NVIDIA 驱动/显卡' 'OK' $nvsmi.Source "$gpu" ''
} else {
    Add-Result 'gpu' 'NVIDIA 驱动/显卡' 'MISSING' '' '没有 nvidia-smi：无 N 卡或驱动未装（SD/ComfyUI 基本跑不动）' '装 NVIDIA 驱动'
}

# ---------------------------------------------------------------- 输出
$missing = @($results | Where-Object { $_.Status -eq 'MISSING' })
$warn = @($results | Where-Object { $_.Status -eq 'WARN' })

if ($Quiet) {
    ($results | ConvertTo-Json -Depth 4)
} else {
    Write-Host ""
    Write-Host "================= 依赖体检 =================" -ForegroundColor Cyan
    foreach ($r in $results) {
        $mark = switch ($r.Status) { 'OK' { '✓' } 'WARN' { '!' } default { '✗' } }
        $color = switch ($r.Status) { 'OK' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
        Write-Host ("  [{0}] {1}" -f $mark, $r.Name) -ForegroundColor $color
        if ($r.Path) { Write-Host ("       路径: {0}" -f $r.Path) -ForegroundColor DarkGray }
        if ($r.Size) { Write-Host ("       大小: {0}" -f $r.Size) -ForegroundColor DarkGray }
        if ($r.Detail) { Write-Host ("       说明: {0}" -f $r.Detail) -ForegroundColor DarkGray }
        if ($r.Fix -and $r.Status -ne 'OK') { Write-Host ("       修法: {0}" -f $r.Fix) -ForegroundColor Cyan }
    }
    Write-Host ""
    Write-Host ("合计 {0} 项：OK {1} / WARN {2} / MISSING {3}" -f $results.Count, ($results.Count - $missing.Count - $warn.Count), $warn.Count, $missing.Count) `
        -ForegroundColor $(if ($missing.Count -eq 0) { 'Green' } else { 'Yellow' })
    if ($missing.Count -gt 0) {
        Write-Host "缺失项（按上面每条的『修法』做，或用 gateway\tools\bootstrap-downloads.ps1 引导下载）：" -ForegroundColor Yellow
        foreach ($m in $missing) { Write-Host ("  · " + $m.Name) -ForegroundColor Yellow }
    }
}

if ($Markdown) {
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# 依赖体检报告')
    $lines.Add('')
    $lines.Add(("生成时间：{0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')))
    $lines.Add('')
    $lines.Add('| 状态 | 项目 | 路径 / 说明 | 缺失时的修法 |')
    $lines.Add('|---|---|---|---|')
    foreach ($r in $results) {
        $mark = switch ($r.Status) { 'OK' { '✓' } 'WARN' { '⚠' } default { '✗' } }
        $pd = (@($r.Path, $r.Size, $r.Detail) | Where-Object { $_ }) -join '；'
        $fix = if ($r.Fix) { '`' + ($r.Fix -replace '\|', '\|') + '`' } else { '' }
        $lines.Add(("| {0} | {1} | {2} | {3} |" -f $mark, $r.Name, $pd, $fix))
    }
    $lines.Add('')
    $lines.Add(("合计 {0} 项：OK {1} / WARN {2} / MISSING {3}" -f $results.Count, ($results.Count - $missing.Count - $warn.Count), $warn.Count, $missing.Count))
    try {
        $dir = Split-Path -Parent $Markdown
        if ($dir -and -not (Test-Path $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
        [System.IO.File]::WriteAllText($Markdown, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "报告已写入：$Markdown" -ForegroundColor Green
    } catch {
        Write-Host "报告写入失败：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}

if ($missing.Count -gt 0) { exit 1 }
exit 0
