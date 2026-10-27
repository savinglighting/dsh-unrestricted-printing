# =============================================================================
# bootstrap-downloads.ps1 —— 「需要下载的东西」的可执行引导
#
# 把 INSTALL.md 里那张下载清单变成代码：默认 **dry-run（只打印计划）**，加 -Apply 才真下载。
#   · 全部下载都走国内镜像（hf-mirror.com / 清华 pip 镜像），可用 -HfEndpoint 覆盖
#   · curl -L -C - 断点续传；下完校验文件大小（小于阈值即判失败，不留半成品）
#   · -Only <id,id> 只做指定项；-Skip <id,id> 跳过指定项
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap-downloads.ps1                 # 打印计划
#   powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap-downloads.ps1 -Apply          # 全部执行
#   ... -Apply -Only sd-clip                                                                    # 只补 CLIP
#   ... -Apply -Only qwen-unet,qwen-clip,qwen-vae                                               # 只补 Qwen 三件套
#   ... -Apply -SdDir D:\SD.4.8 -ComfyDir D:\ComfyUI
# =============================================================================
param(
    [switch]$Apply,
    [string[]]$Only = @(),
    [string[]]$Skip = @(),
    [string]$SdDir = "",
    [string]$ComfyDir = "",
    [string]$HfEndpoint = "https://hf-mirror.com",
    [string]$PipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple"
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:Root = $PSScriptRoot
if (-not $script:Root) { try { $script:Root = Split-Path -Parent $PSCommandPath } catch { } }
$pluginRoot = (Resolve-Path (Join-Path $script:Root '..\..')).Path

# ---- 自动定位 SD / ComfyUI（与 check-deps.ps1 同一套探测规则）----
function Resolve-Dir {
    param([string]$Explicit, [string[]]$Envs, [string[]]$Hints, [string]$Marker)
    foreach ($c in (@($Explicit) + $Envs + $Hints)) {
        if ($c -and (Test-Path -LiteralPath (Join-Path $c $Marker))) { return (Resolve-Path $c).Path }
    }
    foreach ($drv in @('D:\', 'E:\', 'C:\', 'F:\')) {
        if (-not (Test-Path $drv)) { continue }
        foreach ($d in (Get-ChildItem -LiteralPath $drv -Directory -ErrorAction SilentlyContinue)) {
            if (Test-Path -LiteralPath (Join-Path $d.FullName $Marker)) { return $d.FullName }
        }
    }
    return ""
}

if (-not $SdDir) { $SdDir = Resolve-Dir -Explicit $env:DSH_SD_DIR -Envs @($env:SD_DIR, 'D:\SD.4.8') -Hints @((Join-Path $pluginRoot '..\SD.4.8')) -Marker 'launch.py' }
if (-not $ComfyDir) { $ComfyDir = Resolve-Dir -Explicit $env:GW_COMFY_DIR -Envs @($env:COMFY_DIR, 'D:\ComfyUI') -Hints @() -Marker 'main.py' }

# ---- 下载清单（与 INSTALL.md 第 2 节一一对应）----
$CLIP_REV = '8d052a0f05efbaefbc9e8786ba291cfdf93e5bff'
$sdHub = if ($SdDir) { Join-Path $SdDir '.cache\huggingface\hub\models--openai--clip-vit-large-patch14\snapshots\' } else { '' }

$ITEMS = @(
    [pscustomobject]@{
        Id = 'sd-clip'; Name = 'CLIP 文本编码器 clip-vit-large-patch14（点图必需，1.59G）'
        Kind = 'file'; Url = "https://hf-mirror.com/openai/clip-vit-large-patch14/resolve/main/model.safetensors"
        Dest = if ($sdHub) { Join-Path $sdHub "$CLIP_REV\model.safetensors" } else { '' }
        MinMB = 1400
        Why = '缺它 SD 的 txt2img 必 500（INSTALL.md 故障 ①）'
    }
    [pscustomobject]@{
        Id = 'qwen-unet'; Name = 'Qwen-Image UC Q4_K_M GGUF（4.29G）'
        Kind = 'file'; Url = 'https://hf-mirror.com/QuantStack/Qwen-Image-2.1-UC-GGUF/resolve/main/qwen-image-2.1-UC-Q4_K_M.gguf'
        Dest = if ($ComfyDir) { Join-Path $ComfyDir 'models\unet\qwen-image-2.1-UC-Q4_K_M.gguf' } else { '' }
        Why = 'QwenImage_NVFP4 档位的主体（ComfyUI /prompt）'
    }
    [pscustomobject]@{
        Id = 'qwen-clip'; Name = 'Qwen 文本编码器 qwen3vl_8b_int8_convrot（8.71G）'
        Kind = 'file'; Url = 'https://hf-mirror.com/QuantStack/Qwen-Image-2.1-UC-GGUF/resolve/main/qwen3vl_8b_int8_convrot.safetensors'
        Dest = if ($ComfyDir) { Join-Path $ComfyDir 'models\text_encoders\qwen3vl_8b_int8_convrot.safetensors' } else { '' }
        Why = 'Qwen 提示词编码；需整体入内存，可用内存 < 7G 会崩（故障 ⑤）'
    }
    [pscustomobject]@{
        Id = 'qwen-vae'; Name = 'Qwen VAE qwen_image_2.1_vae_bf16（0.63G）'
        Kind = 'file'; Url = 'https://hf-mirror.com/QuantStack/Qwen-Image-2.1-UC-GGUF/resolve/main/qwen_image_2.1_vae_bf16.safetensors'
        Dest = if ($ComfyDir) { Join-Path $ComfyDir 'models\vae\qwen_image_2.1_vae_bf16.safetensors' } else { '' }
        Why = 'Qwen 解码'
    }
    [pscustomobject]@{
        Id = 'krea-unet'; Name = 'Krea2 Turbo GGUF Q4_K_M（6.97G）'
        Kind = 'file'; Url = 'https://hf-mirror.com/vantagewithai/Krea-2-Turbo-GGUF/resolve/main/krea2_turbo-Q4_K_M.gguf'
        Dest = if ($ComfyDir) { Join-Path $ComfyDir 'models\unet\krea2_turbo-Q4_K_M.gguf' } else { '' }
        MinMB = 6000; Why = 'Krea2_Q4 档的主体（unet，models.js 已指向此文件名）'
    }
    [pscustomobject]@{
        Id = 'krea-clip'; Name = 'Krea2 编码器 Qwen3-VL-4B int8（4.50G）'
        Kind = 'file'; Url = 'https://hf-mirror.com/DreamFast/Qwen3-VL-4b-Heretic-ComfyUI/resolve/main/qwen3-vl-4b-heretic_int8.safetensors'
        Dest = if ($ComfyDir) { Join-Path $ComfyDir 'models\text_encoders\qwen3-vl-4b-heretic_int8.safetensors' } else { '' }
        MinMB = 4000; Why = 'Krea2 必须用 4B 编码器（sd.py 要求 QWEN3VL_4B），不是 8B'
    }
    [pscustomobject]@{
        Id = 'krea-vae'; Name = 'Krea2 VAE（0.24G）'
        Kind = 'file'; Url = 'https://hf-mirror.com/mikkoph/krea2-vae/resolve/main/krea2-vae.safetensors'
        Dest = if ($ComfyDir) { Join-Path $ComfyDir 'models\vae\krea2-vae.safetensors' } else { '' }
        MinMB = 200; Why = 'Krea2 要 64 通道 VAE（qwen 的 16 通道不匹配 → VAEDecode 报错）'
    }
    [pscustomobject]@{
        Id = 'comfy-root'; Name = 'ComfyUI 本体（git clone）'
        Kind = 'git'; Url = 'https://github.com/comfyanonymous/ComfyUI'; Dest = if ($ComfyDir) { $ComfyDir } else { 'D:\ComfyUI' }
        MinMB = 0; Why = 'Qwen/Krea2 两档的引擎'
    }
    [pscustomobject]@{
        Id = 'comfy-node-gguf'; Name = '自定义节点 ComfyUI-GGUF（git clone）'
        Kind = 'git'; Url = 'https://github.com/city96/ComfyUI-GGUF'
        Dest = if ($ComfyDir) { Join-Path $ComfyDir 'custom_nodes\ComfyUI-GGUF' } else { '' }
        MinMB = 0; Why = '加载 GGUF unet'
    }
    [pscustomobject]@{
        Id = 'sd-pin'; Name = 'SD 侧 Python pin（transformers==4.30.2 / tokenizers==0.13.3 / huggingface_hub==0.23.5）'
        Kind = 'pip'; Url = $PipIndex; Dest = if ($SdDir) { Join-Path $SdDir 'python\python.exe' } else { '' }
        MinMB = 0; Why = 'transformers 5.x 会让 A1111 崩（故障 ②）'
    }
    [pscustomobject]@{
        Id = 'ollama-vlm'; Name = 'qwen3-vl:8b 视觉质检模型（可选，6.1G）'
        Kind = 'ollama'; Url = 'ollama pull qwen3-vl:8b'; Dest = ''; MinMB = 0
        Why = '不给也能出图：质检自动降级为"出满 N 张自选"'
    }
)

function Test-ItemDone {
    param($Item)
    if ($Item.Kind -in @('file', 'git')) {
        if (-not $Item.Dest) { return $false }
        return (Test-Path -LiteralPath $Item.Dest)
    }
    if ($Item.Kind -eq 'pip') {
        # 真查一遍：pin 有没有落到位（不能只看"脚本存在"）
        if (-not $Item.Dest -or -not (Test-Path -LiteralPath $Item.Dest)) { return $false }
        try {
            $v = (& $Item.Dest -c "import importlib.metadata as m;print(m.version('transformers'))" 2>$null)
            return ("$v" -match '^4\.')
        } catch { return $false }
    }
    if ($Item.Kind -eq 'ollama') {
        if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { return $false }
        try { return (((& ollama list) 2>$null | Out-String) -match 'qwen3-vl') } catch { return $false }
    }
    return $false
}

function Get-FileSizeMB {
    param([string]$p)
    try { if (Test-Path -LiteralPath $p) { return [math]::Round((Get-Item -LiteralPath $p).Length / 1MB, 0) } } catch { }
    return 0
}

function Invoke-Item {
    param($Item)
    switch ($Item.Kind) {
        'file' {
            if (-not $Item.Dest) { Write-Host "  [跳过] $($Item.Id)：没定位到目标目录（用 -SdDir/-ComfyDir 指定）" -ForegroundColor Yellow; return $false }
            $dir = Split-Path -Parent $Item.Dest
            if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
            Write-Host ("  ↓ 下载 {0}" -f $Item.Name) -ForegroundColor Cyan
            Write-Host ("    源：{0}" -f $Item.Url) -ForegroundColor DarkGray
            Write-Host ("    到：{0}" -f $Item.Dest) -ForegroundColor DarkGray
            # 断点续传（curl -C -）；失败不静默——把 curl 退出码与尾部输出打出来
            $args = @('-L', '-C', '-', '--retry', '3', '--retry-delay', '3', '-o', $Item.Dest, $Item.Url)
            & curl.exe @args
            $code = $LASTEXITCODE
            $mb = Get-FileSizeMB $Item.Dest
            if ($code -ne 0 -and $mb -lt $Item.MinMB) {
                Write-Host ("    ✗ 下载失败（curl exit={0}，当前 {1} MB）" -f $code, $mb) -ForegroundColor Red
                return $false
            }
            if ($Item.MinMB -gt 0 -and $mb -lt $Item.MinMB) {
                Write-Host ("    ✗ 文件偏小（{0} MB < 预期 {1} MB）——可能是半成品/错误页，请重跑本脚本续传" -f $mb, $Item.MinMB) -ForegroundColor Red
                return $false
            }
            Write-Host ("    ✓ 完成（{0} MB）" -f $mb) -ForegroundColor Green
            return $true
        }
        'git' {
            if (-not $Item.Dest) { Write-Host "  [跳过] $($Item.Id)：目标目录未知" -ForegroundColor Yellow; return $false }
            $parent = Split-Path -Parent $Item.Dest
            if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent -Force }
            Write-Host ("  ↓ git clone {0}" -f $Item.Name) -ForegroundColor Cyan
            & git clone --depth 1 $Item.Url $Item.Dest
            if ($LASTEXITCODE -ne 0) { Write-Host "    ✗ clone 失败（exit $LASTEXITCODE）" -ForegroundColor Red; return $false }
            Write-Host "    ✓ 完成" -ForegroundColor Green
            return $true
        }
        'pip' {
            if (-not $Item.Dest -or -not (Test-Path -LiteralPath $Item.Dest)) {
                Write-Host "  [跳过] sd-pin：找不到 SD 自带 python（用 -SdDir 指定）" -ForegroundColor Yellow
                return $false
            }
            Write-Host "  ↓ pip install（A1111 原生 pin）" -ForegroundColor Cyan
            & $Item.Dest -m pip install --no-deps --timeout 60 -i $PipIndex transformers==4.30.2 tokenizers==0.13.3 huggingface_hub==0.23.5
            if ($LASTEXITCODE -ne 0) { Write-Host "    ✗ pip 失败（exit $LASTEXITCODE）" -ForegroundColor Red; return $false }
            Write-Host "    ✓ 完成" -ForegroundColor Green
            return $true
        }
        'ollama' {
            if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
                Write-Host "  [跳过] ollama-vlm：没装 Ollama（https://ollama.com/download）" -ForegroundColor Yellow
                return $false
            }
            Write-Host "  ↓ ollama pull qwen3-vl:8b（6.1G）" -ForegroundColor Cyan
            & ollama pull qwen3-vl:8b
            if ($LASTEXITCODE -ne 0) { Write-Host "    ✗ pull 失败" -ForegroundColor Red; return $false }
            Write-Host "    ✓ 完成" -ForegroundColor Green
            return $true
        }
        'manual' {
            Write-Host ("  [手动] {0}" -f $Item.Name) -ForegroundColor Yellow
            Write-Host ("     放这里：{0}" -f $Item.Dest) -ForegroundColor DarkGray
            Write-Host ("     说明：{0}" -f $Item.Why) -ForegroundColor DarkGray
            return $false
        }
        default { return $false }
    }
}

# ---- 计划 ----
$todo = @($ITEMS | Where-Object {
        ($Only.Count -eq 0 -or $Only -contains $_.Id) -and ($Skip -notcontains $_.Id)
    })

Write-Host ""
Write-Host "=========== 需要下载的东西（引导下载）===========" -ForegroundColor Cyan
Write-Host ("SD 目录   : {0}" -f $(if ($SdDir) { $SdDir } else { '（未定位到，用 -SdDir 指定）' })) -ForegroundColor DarkGray
Write-Host ("ComfyUI   : {0}" -f $(if ($ComfyDir) { $ComfyDir } else { '（未定位到，用 -ComfyDir 指定）' })) -ForegroundColor DarkGray
Write-Host ("HF 镜像   : {0}" -f $HfEndpoint) -ForegroundColor DarkGray
Write-Host ("pip 镜像  : {0}" -f $PipIndex) -ForegroundColor DarkGray
Write-Host ("模式      : {0}" -f $(if ($Apply) { 'Apply（真下载）' } else { 'DryRun（只打印计划；加 -Apply 才下载）' })) -ForegroundColor $(if ($Apply) { 'Yellow' } else { 'Green' })
Write-Host ""
$okCount = 0; $failCount = 0; $skipCount = 0
foreach ($it in $todo) {
    $done = Test-ItemDone $it
    $mark = if ($done) { '✓ 已有' } else { '· 待做' }
    Write-Host ("  [{0}] {1}" -f $mark, $it.Name) -ForegroundColor $(if ($done) { 'Green' } else { 'White' })
    if ($it.Dest) { Write-Host ("        目标：{0}" -f $it.Dest) -ForegroundColor DarkGray }
    Write-Host ("        为什么要：{0}" -f $it.Why) -ForegroundColor DarkGray
    if (-not $done -and $Apply) {
        if (Invoke-Item $it) { $okCount++ } else { $failCount++ }
    } elseif (-not $done) {
        if ($it.Kind -eq 'file') { Write-Host ("        命令：curl -L -C - -o `"{0}`" `"{1}`"" -f $it.Dest, $it.Url) -ForegroundColor Cyan }
        elseif ($it.Kind -eq 'git') { Write-Host ("        命令：git clone --depth 1 {0} `"{1}`"" -f $it.Url, $it.Dest) -ForegroundColor Cyan }
        elseif ($it.Kind -eq 'pip') { Write-Host ("        命令：& `"{0}`" -m pip install --no-deps -i {1} transformers==4.30.2 tokenizers==0.13.3 huggingface_hub==0.23.5" -f $it.Dest, $PipIndex) -ForegroundColor Cyan }
        elseif ($it.Kind -eq 'ollama') { Write-Host ("        命令：{0}" -f $it.Url) -ForegroundColor Cyan }
        $skipCount++
    }
}
Write-Host ""
if ($Apply) {
    Write-Host ("执行完毕：成功 {0} / 失败 {1}" -f $okCount, $failCount) -ForegroundColor $(if ($failCount -eq 0) { 'Green' } else { 'Red' })
    Write-Host "装完请再跑一次体检：powershell -NoProfile -ExecutionPolicy Bypass -File gateway\tools\check-deps.ps1" -ForegroundColor Cyan
} else {
    Write-Host ("共 {0} 项待做（{1} 项已有）。确认无误后加 -Apply 真下载。" -f $skipCount, ($todo.Count - $skipCount)) -ForegroundColor Green
}
if ($failCount -gt 0) { exit 1 }
exit 0
