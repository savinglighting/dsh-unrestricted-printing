# backend-dispatcher.ps1 —— 三后端统一调度器
# 供 sd-inject.ps1 在出图时调用，提供统一的模型发现/加载/出图接口
#
# 2026-10-18 状态：
#   · SD（A1111）  —— 真机全流程实测通过（A/B 两档、手绘蒙版、质检）
#   · Qwen-Image   —— ComfyUI + ComfyUI-GGUF 真机实测通过（文生图 170s / 图生图 326s）
#   · Anima        —— 占位，等接入
# 用法：dot-source 本文件后调 Get-BackendList / Invoke-SdBackend / Invoke-ComfyBackend

# === 后端探测（返回可用列表）====
function Get-BackendList {
    $list = @()

    # ① SD WebUI (A1111)
    try {
        $opt = Invoke-RestMethod "http://127.0.0.1:7860/sdapi/v1/options" -TimeoutSec 5 -UseBasicParsing
        $list += [PSCustomObject]@{
            Name = 'Stable Diffusion (A1111)'; Key = 'sd'; Status = 'ready'
            Model = $opt.sd_model_checkpoint; Backend = 'sd'
        }
    } catch {
        $list += [PSCustomObject]@{
            Name = 'Stable Diffusion (A1111)'; Key = 'sd'; Status = 'offline'
            Model = '服务未运行'; Backend = 'sd'
        }
    }

    # ② Qwen-Image (ComfyUI)
    $qwenCkpt = "D:\ComfyUI\models\unet\qwen-image-2.1-UC-Q4_K_M.gguf"
    $qwenReady = (Test-Path $qwenCkpt) -and ((Get-Item $qwenCkpt).Length -gt 1GB)
    $comfyOnline = $false
    try { $null = Invoke-RestMethod "http://127.0.0.1:8188/queue" -TimeoutSec 3 -UseBasicParsing; $comfyOnline = $true } catch { }
    $list += [PSCustomObject]@{
        Name = 'Qwen-Image-2.1 (ComfyUI)'; Key = 'qwen'
        Status = if ($qwenReady -and $comfyOnline) { 'ready' } elseif ($qwenReady) { 'no-api' } else { 'no-model' }
        Model = if ($qwenReady) { 'Q4_K_M 4.29GB' } else { '模型未下载' }
        Backend = 'comfy'
    }

    # ③ Anima（占位）
    $list += [PSCustomObject]@{
        Name = 'Anima (待接入)'; Key = 'anima'; Status = 'pending'
        Model = '未接入'; Backend = 'comfy'
    }

    return $list
}

# === SD 出图（走 sd-direct.ps1）====
function Invoke-SdBackend {
    param(
        [string]$Prompt,
        [string]$Negative,
        [string]$InitImage,
        [string]$Mask,
        [int]$Width,
        [int]$Height,
        [int]$Steps,
        [double]$Denoise,
        [string]$OutDir,
        [string]$Name,
        [string]$DirectScript = "D:\DSWorkPlace\sd-direct.ps1"
    )
    $args = @(
        '-Prompt', "`"$Prompt`"",
        '-Negative', "`"$Negative`"",
        '-Width', "$Width", '-Height', "$Height",
        '-Steps', "$Steps", '-Denoising', "$Denoise",
        '-OutDir', "`"$OutDir`"", '-Name', $Name,
        '-NoOpen'
    )
    if ($InitImage) { $args += '-InitImage'; $args += "`"$InitImage`"" }
    if ($Mask) { $args += '-Mask'; $args += "`"$Mask`""; $args += '-InpaintFill'; $args += '0' }

    $result = & 'powershell' -NoProfile -ExecutionPolicy Bypass -File $DirectScript @args 2>&1
    $exitCode = $LASTEXITCODE

    $seed = -1; $path = $null
    foreach ($line in $result) {
        if ($line -match 'Seed:\s+(\d+)') { $seed = [int]$Matches[1] }
        if ($line -match '已保存:\s+(\S+\.png)') { $path = $Matches[1] }
        if ($line -match '最终成品:\s+(\S+\.png)') { $path = $Matches[1] }
    }
    return @{ Ok = ($exitCode -eq 0); Path = $path; Seed = $seed; Output = ($result -join "`n") }
}

# === ComfyUI 出图（Qwen-Image-2.1 GGUF）====
# 2026-10-18 真机实测通过的配置（ComfyUI 新版 + city96/ComfyUI-GGUF 扩展）：
#   · unet      → UnetLoaderGGUF（qwen-image-2.1-UC-Q4_K_M.gguf）
#   · clip      → CLIPLoader，type 必须是 "sd3"（Qwen-Image 系）
#   · vae       → VAELoader（qwen_image_2.1_vae_bf16.safetensors）
#   · 底图上传  → POST /upload/image 用 **multipart/form-data**
#                （新版 server.py 是 aiohttp request.post()；老式 JSON {"image": base64} 会 400 且错误体为空）
#   · 出图      → POST /prompt + 轮询 /history/{id}
# 实测耗时（7.9G 卡 + 8.71G 编码器）：文生图 512x768/24 步 ≈ 170s；图生图 1024x1536/24 步 ≈ 326s
# 已知限制：编码器 8.71GB 需整体载入，系统可用内存 <7GB 时会 access violation 崩溃
#           → 跑 Qwen 前建议关掉占内存的大程序（QQ、浏览器等）
$script:ComfyModels = @{
    Unet = 'qwen-image-2.1-UC-Q4_K_M.gguf'
    Clip = 'qwen3vl_8b_int8_convrot.safetensors'
    Vae  = 'qwen_image_2.1_vae_bf16.safetensors'
}

function Invoke-ComfyBackend {
    param(
        [string]$Prompt,
        [string]$Negative,
        [string]$InitImage = "",
        [int]$Width = 512,
        [int]$Height = 768,
        [int]$Steps = 24,
        [double]$Denoise = 1.0,
        [string]$OutDir = "",
        [string]$Name = 'qwen',
        [int]$Seed = -1,
        [int]$TimeoutSec = 900,
        [string]$ApiBase = 'http://127.0.0.1:8188'
    )
    if (-not $OutDir) { $OutDir = (Get-Location).Path }
    $null = New-Item -ItemType Directory -Path $OutDir -Force -ErrorAction SilentlyContinue
    if ($Seed -lt 0) { $Seed = Get-Random -Maximum 2147483647 }

    # ---- 1) 图生图：先把底图上传成 multipart（拿到 ComfyUI 内部文件名）----
    # 坑54（2026-10-18 实测）：PowerShell 5.1 的 Invoke-RestMethod 发 multipart 与新版 ComfyUI
    # （aiohttp request.post()）有边界解析兼容问题——实测无论 boundary 带不带前导横线都报
    # "Could not find starting boundary" → 500。而同样的 bytes 用 Python urllib 直接发就成功。
    # 所以这里改为调用已验证可用的 comfy_upload.py（在 ComfyUI 目录下），stdout 单行返回内部文件名。
    $inputImageName = ''
    if ($InitImage -and (Test-Path -LiteralPath $InitImage)) {
        $uploader = "D:\ComfyUI\comfy_upload.py"
        if (-not (Test-Path -LiteralPath $uploader)) {
            return @{ Ok = $false; Path = $null; Error = "缺少上传脚本: $uploader" }
        }
        try {
            $pyExe = "D:\SD.4.8\python\python.exe"
            if (-not (Test-Path -LiteralPath $pyExe)) { $pyExe = "python" }
            $upName = & $pyExe $uploader $InitImage "input_$Name.png" 2>&1
            if ($LASTEXITCODE -ne 0 -or -not $upName) {
                return @{ Ok = $false; Path = $null; Error = "底图上传失败: $($upName -join ' ')" }
            }
            $inputImageName = ("$upName" -split "`r?`n" | Where-Object { $_ -match '\S' } | Select-Object -First 1).Trim()
        } catch {
            return @{ Ok = $false; Path = $null; Error = "底图上传异常: $($_.Exception.Message)" }
        }
    }

    # ---- 2) 组装工作流（节点号固定，图生图只换 latent 来源）----
    $wf = [ordered]@{
        "1"  = @{ class_type = "UnetLoaderGGUF"; inputs = @{ unet_name = $script:ComfyModels.Unet } }
        "2"  = @{ class_type = "CLIPLoader";      inputs = @{ clip_name = $script:ComfyModels.Clip; type = "sd3" } }
        "3"  = @{ class_type = "VAELoader";       inputs = @{ vae_name  = $script:ComfyModels.Vae } }
        "4"  = @{ class_type = "CLIPTextEncode";  inputs = @{ text = $Prompt;   clip = @("2", 0) } }
        "5"  = @{ class_type = "CLIPTextEncode";  inputs = @{ text = $Negative; clip = @("2", 0) } }
    }
    if ($inputImageName) {
        $wf["6"] = @{ class_type = "LoadImage";       inputs = @{ image = $inputImageName } }
        $wf["7"] = @{ class_type = "VAEEncode";       inputs = @{ pixels = @("6", 0); vae = @("3", 0) } }
        $latentRef = @("7", 0)
    } else {
        $wf["6"] = @{ class_type = "EmptyLatentImage"; inputs = @{ width = $Width; height = $Height; batch_size = 1 } }
        $latentRef = @("6", 0)
    }
    $wf["8"]  = @{ class_type = "KSampler"; inputs = @{
        seed = $Seed; steps = $Steps; cfg = 7.0
        sampler_name = "euler"; scheduler = "normal"; denoise = $Denoise
        model = @("1", 0); positive = @("4", 0); negative = @("5", 0)
        latent_image = $latentRef
    } }
    $wf["9"]  = @{ class_type = "VAEDecode";  inputs = @{ samples = @("8", 0); vae = @("3", 0) } }
    $wf["10"] = @{ class_type = "SaveImage";  inputs = @{ images = @("9", 0); filename_prefix = $Name } }

    # ---- 3) 提交 + 轮询 ----
    $payload = @{ prompt = $wf; client_id = [Guid]::NewGuid().ToString() } | ConvertTo-Json -Depth 12
    $promptId = ''
    try {
        $resp = Invoke-RestMethod "$ApiBase/prompt" -Method Post -Body $payload `
            -ContentType "application/json; charset=utf-8" -TimeoutSec 60
        $promptId = [string]$resp.prompt_id
    } catch {
        $detail = ""
        try { $detail = $_.ErrorDetails.Message } catch { }
        return @{ Ok = $false; Path = $null; Error = "提交失败: $($_.Exception.Message) $detail" }
    }
    if (-not $promptId) { return @{ Ok = $false; Path = $null; Error = 'no prompt_id' } }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        Start-Sleep -Seconds 4
        try {
            $hist = Invoke-RestMethod "$ApiBase/history/$promptId" -TimeoutSec 15
            $entry = $hist.$promptId
            if (-not $entry) { continue }
            $found = $null
            foreach ($nodeId in $entry.outputs.PSObject.Properties.Name) {
                $imgs = $entry.outputs.$nodeId.images
                if ($imgs -and $imgs.Count -gt 0) { $found = $imgs[0]; break }
            }
            if (-not $found) { return @{ Ok = $true; Path = $null; Seed = $Seed; Note = '完成但无图片输出' } }
            $viewUrl = "$ApiBase/view?filename=$($found.filename)&subfolder=$($found.subfolder)&type=$($found.type)"
            $dest = Join-Path $OutDir "$Name`_$(Get-Date -Format 'yyyyMMdd_HHmmss').png"
            Invoke-WebRequest -Uri $viewUrl -OutFile $dest -TimeoutSec 120 -UseBasicParsing
            return @{ Ok = $true; Path = $dest; Seed = $Seed; ElapsedSec = [int]$sw.Elapsed.TotalSeconds }
        } catch { }
    }
    return @{ Ok = $false; Path = $null; Error = "timeout after ${TimeoutSec}s" }
}

# === 后端选择表单 ===
function Show-BackendSelector {
    param([PSCustomObject[]]$Backends)
    Add-Type -AssemblyName System.Windows.Forms

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "选择生图后端"
    $form.ClientSize = New-Object System.Drawing.Size(420, 320)
    $form.StartPosition = 'CenterScreen'
    $form.TopMost = $true

    $lb = New-Object System.Windows.Forms.Label
    $lb.Text = "请选择出图引擎："
    $lb.SetBounds(20, 15, 200, 25)
    $form.Controls.Add($lb)

    $listBox = New-Object System.Windows.Forms.ListBox
    $listBox.SetBounds(20, 45, 380, 160)
    $listBox.DisplayMember = "DisplayText"
    $listBox.ValueMember = "Key"
    $listBox.SelectionMode = 'One'

    foreach ($b in $Backends) {
        $status = switch ($b.Status) {
            'ready'    { '✅' }
            'no-api'   { '⚠ ComfyUI 未运行' }
            'no-model' { '⚠ 模型未下载' }
            'pending'  { '⏳ 待接入' }
            'offline'  { '❌ 服务未运行' }
        }
        $null = $listBox.Items.Add([PSCustomObject]@{
            DisplayText = "$status $($b.Name)（$($b.Model)）"
            Key = $b.Key
        })
    }
    $form.Controls.Add($listBox)

    $cb = New-Object System.Windows.Forms.CheckBox
    $cb.Text = "都不理想，三个模型各出一张"
    $cb.SetBounds(20, 210, 320, 30)
    $form.Controls.Add($cb)

    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = '确定'
    $btnOk.SetBounds(110, 255, 80, 30)
    $form.AcceptButton = $btnOk
    $form.Controls.Add($btnOk)

    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = '取消'
    $btnCancel.SetBounds(210, 255, 80, 30)
    $form.CancelButton = $btnCancel
    $form.Controls.Add($btnCancel)

    $result = $form.ShowDialog()
    if ($result -eq 'OK') {
        $selected = $listBox.SelectedItem
        $allThree = $cb.Checked
        if ($selected) { return @{ Backend = $selected.Key; AllThree = $allThree } }
    }
    return $null
}
