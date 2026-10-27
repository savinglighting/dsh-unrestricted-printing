# install-sd.ps1 —— 一键自举安装 Stable Diffusion WebUI（dsh-unrestricted-printing 配套）
# 装完把路径记进 ~/.dsh-sd-bridge.json（**无 BOM** UTF-8），插件下次启动自动读到，零配置可用。
# 用法:
#   powershell -ExecutionPolicy Bypass -File install-sd.ps1
#   powershell -ExecutionPolicy Bypass -File install-sd.ps1 -Target "E:\sd" -SkipModel
#   powershell -ExecutionPolicy Bypass -File install-sd.ps1 -Mirror ""        # 用官方源
#   powershell -ExecutionPolicy Bypass -File install-sd.ps1 -Models "awpainting,majicmix"   # 多选模型
#   powershell -ExecutionPolicy Bypass -File install-sd.ps1 -Loras "add_detail,easynegative"
#   powershell -ExecutionPolicy Bypass -File install-sd.ps1 -Upgrade          # sha 复验 + 旧版补拉新版
# 说明:
#   - WebUI 本体约 2GB（git clone）；模型/VAE/LoRA 按清单拉，-SkipModel / -SkipVae / -SkipLora 可跳
#   - 清单键（-Models / -Vaes / -Loras，逗号多选，none = 不拉）：
#       模型  awpainting(默认) | revanimated | anythingv5 | majicmix | darksushi
#       VAE   mse(默认) | animevae
#       LoRA  add_detail | easynegative(默认) | badhandv4(默认)
#     全部 sha256 与本机出图正常的文件逐字节比对过（HF lfs oid = sha256）
#   - 环境预检（-NoPrereq 跳过）：磁盘 ≥15GB / 镜像探活 / git / Python 3.10 / VC++ 运行库，
#     缺啥补啥，每项失败只报一条错就退出；最后打一张「就绪清单」
#   - 首次由插件启动时还会在线安装 Python/torch 依赖（约 10-30 分钟，之后每次启动秒级）
# 画质（「新装 SD 出图很差」的两个根因，本脚本默认修掉）:
#   - 默认模型从 2022 年的 SD1.5 base 换成 **AWPainting v1.2**（远端 sha256 与已验证出图的本机
#     文件逐字节一致 3d1b3c42ec…），并补下 **vae-ft-mse-840000**（sha256 735e4c3a…）——
#     SD1.5 base + 自带 VAE 在 2026 年就是「糊、灰、不像样」的主要来源
#   - 自动写 config.json 质量默认：sd_model_checkpoint / sd_vae / CLIP_stop_at_last_layers=2
#     （AWPainting 官方推荐 CLIP skip 2；-NoConfig 跳过）
# 装机踩坑自愈（对应「从安装到跑通的 12 个坑」）:
#   坑2 没有 git     → 自动下 MinGit 便携版：GitHub 资源带 sha256 digest 就先校验，再 `git --version` 实测，装完入用户 PATH
#   坑4 只有商店占位 Python → 自动静默装官方 Python 3.10.6（用户级 PrependPath），装完写进记录供插件直接用
#   坑5 大文件断流   → Get-SegmentedFile：8 段并行 Range 下载 + 断点续传 + 长度/可选哈希校验
#   坑10 记录带 BOM  → 记录用**无 BOM** UTF-8 写（PS5.1 的 Set-Content -Encoding UTF8 会写 BOM，读侧 JSON.parse 必炸）

param(
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'dsh-sd-bridge\webui'),
    [string]$Repo = 'https://github.com/AUTOMATIC1111/stable-diffusion-webui.git',
    # 主模型清单（逗号多选，键见 $ModelCatalog；none = 不拉模型）
    [string]$Models = 'awpainting,semirealmix',
    # VAE 清单（逗号多选，键见 $VaeCatalog；none = 不拉 VAE）
    [string]$Vaes = 'mse,animevae',
    # LoRA / Embedding 清单（逗号多选，键见 $LoraCatalog；none = 不拉）
    [string]$Loras = 'add_detail,semireal,easynegative,badhandv4',
    # 已存在的文件做 sha 复验、清单里有更高版本就补拉（旧版本按 Supersedes 识别）
    [switch]$Upgrade,
    [string]$Mirror = 'https://hf-mirror.com',   # 填 "" 用官方源
    [switch]$SkipModel,
    [switch]$SkipVae,                           # 不下 VAE（画质会打折扣）
    [switch]$SkipLora,                          # 不下 LoRA/Embedding
    [switch]$NoConfig,                          # 不写 config.json 的质量默认值
    [int]$Segments = 8,                         # 大文件并行分段数（坑5：单连接被限速掐断）
    [string]$ModelSha256 = '',                  # 用 -Models 之外的自定义模型时可带 sha256
    [string]$GitSha256 = '',                    # 可选：MinGit zip 的 sha256（有资源 digest 时优先用它）
    [string]$PythonSha256 = '',                 # 可选：Python 安装包 sha256
    [switch]$SkipGit,                           # 跳过 git 自举（已确定本机 git 可用）
    [switch]$SkipPython,                        # 跳过 Python 自举
    [switch]$SkipVC,                            # 跳过 VC++ 运行库预检
    [switch]$SkipDiskCheck,                     # 跳过磁盘空间预检
    [switch]$NoPrereq,                          # 跳过整个环境预检段
    [string]$StateFile = ''                     # 安装记录路径；留空 = ~/.dsh-sd-bridge.json（可用 DSH_SD_STATE_FILE 覆盖）
)

# ---------------------------------------------------------------------------
# 下载清单：每个条目 = 落盘名 + HF 仓库/文件 + sha256 + 用途标签 + 可被哪个新版本取代。
# 所有 sha256 均与「本机出图正常」的文件逐字节比对过（HF lfs oid = sha256）。
# ---------------------------------------------------------------------------
$ModelCatalog = [ordered]@{
    awpainting  = @{ Name = 'AWPainting_v1.2.safetensors'; Repo = 'sam749/AWPainting-v1-2'; File = 'awpainting_v12.safetensors'; Sha = '3d1b3c42ec704f3397d9e2968e3e544eda111741e10793afd78faa8148b36e12'; Tag = '默认·通用（AWPainting 官方推荐 CLIP skip 2）' }
    revanimated = @{ Name = 'revAnimated_v11.safetensors'; Repo = 'hanafuusen2001/ReVAnimated'; File = 'revAnimated_v11.safetensors'; Sha = 'd725be5d187c172fbabfb2d35cf6bff2237367a8c1cf743d03c1c0e57f0e43fa'; Tag = '动漫综合（v1.1，本机实测同哈希）'; Supersedes = @('revAnimated_v10.safetensors', '动漫ReVAnimated_v1.1.safetensors') }
    anythingv5  = @{ Name = 'AnythingV5V3_v5PrtRE.safetensors'; Repo = 'ckpt/anything-v5.0'; File = 'AnythingV5V3_v5PrtRE.safetensors'; Sha = '7f96a1a9ca9b3a3242a9ae95d19284f0d2da8d5282b42d2d974398bf7663a252'; Tag = '动漫·anything v5（本机实测同哈希）' }
    majicmix    = @{ Name = 'majicmixRealistic_v7.safetensors'; Repo = 'digiplay/majicMIX_realistic_v7'; File = 'majicmixRealistic_v7.safetensors'; Sha = '7c819b6d13663ed720c2254f4fe18373107dfef2448d337913c8fc545640881e'; Tag = '写实（麦橘写实 v7，本机实测同哈希）' }
    semirealmix = @{ Name = 'SemiRealMix.safetensors'; Repo = 'robotjung/SemiRealMix'; File = 'SemiRealMix.safetensors'; Sha = '385ea18efae6a93c19c1fc5e13447e19b5ed6f16d01b7be65f7f48252688e4b4'; Tag = '写实二次元·半写实（二次元脸 + 写实渲染，SemiRealMix）' }
    darksushi   = @{ Name = 'darkSushiMixMix_brighterPruned.safetensors'; Repo = 'mdl-mirror/dark-sushi-mix'; File = 'darkSushiMixMix_brighterPruned.safetensors'; Sha = '099e07547a45dc501a96a7b613e5bfe502be9477199172ca29821882dd8350a1'; Tag = '二次元·大颗寿司 brighterPruned（本机实测同哈希）' }
}

$VaeCatalog = [ordered]@{
    mse      = @{ Name = 'vae-ft-mse-840000-ema-pruned.safetensors'; Repo = 'stabilityai/sd-vae-ft-mse-original'; File = 'vae-ft-mse-840000-ema-pruned.safetensors'; Sha = '735e4c3a447a3255760d7f86845f09f937809baa529c17370d83e4c3758f3c75'; Tag = '通用·不发灰（写进 config.json 默认）' }
    animevae = @{ Name = 'animevae.pt'; Repo = 'akibanzu/animevae'; File = 'animevae.pt'; Sha = 'f921fb3f29891d2a77a6571e56b8b5052420d2884129517a333c60b1b4816cdf'; Tag = '动漫·anything 系专用（本机实测同哈希）' }
}

# LoRA 放 models\Lora，Embedding 放 models\embeddings（A1111 各自的扫描目录）
$LoraCatalog = [ordered]@{
    add_detail   = @{ Sub = 'Lora'; Name = 'add_detail.safetensors'; Repo = 'OedoSoldier/detail-tweaker-lora'; File = 'add_detail.safetensors'; Sha = '47aaaf0d2945ca937151d61304946dd229b3f072140b85484bc93e38f2a6e2f7'; Tag = '细节增强（detail tweaker，38MB）' }
    semireal     = @{ Sub = 'Lora'; Name = 'semirealisticanime.safetensors'; Repo = 'NoneIQalt/semirealisticlora'; File = 'semirealisticanime.safetensors'; Sha = 'ffce33239edde3afd8831beac2168cf60fc0a447e2f76d86dcc06460a2b9359a'; Tag = '写实二次元·半写实 LoRA（288MB）' }
    easynegative = @{ Sub = 'embeddings'; Name = 'EasyNegative.safetensors'; Repo = 'embed/EasyNegative'; File = 'EasyNegative.safetensors'; Sha = 'c74b4e810b030f6b75fde959e2db678c268d07115b85356d3c0138ba5eb42340'; Tag = '负面嵌入·通用质量底线（24KB）' }
    badhandv4    = @{ Sub = 'embeddings'; Name = 'badhandv4.safetensors'; Repo = 'Eugeoter/badhandv4'; File = 'badhandv4.safetensors'; Sha = '6836f178cc41a5436730afded6cbe2bdcef61663b1ad2d2f83ad028019a0ff98'; Tag = '手部修复嵌入（18KB）' }
}

function Resolve-Keys([string]$Spec, $Catalog) {
    if (-not $Spec) { return }
    $out = @()
    foreach ($raw in ($Spec -split ',')) {
        $k = $raw.Trim().ToLowerInvariant()
        if ($k -eq '' -or $k -eq 'none') { continue }
        if (-not $Catalog.Contains($k)) {
            $names = ($Catalog.Keys -join ' / ')
            Write-Host "清单里没有 '$raw'。可用键：$names（或 none）" -ForegroundColor Red
            exit 1
        }
        $out += $k
    }
    # 管道逐个输出（调用方用 @() 收集成一维数组；return ,@() 会多包一层变 Object[]）
    foreach ($k in $out) { $k }
}

function Get-HfUrl([hashtable]$Item, [string]$MirrorBase) {
    $url = "https://huggingface.co/$($Item.Repo)/resolve/main/$($Item.File)"
    if ($MirrorBase -ne '' -and $url -like '*huggingface.co*') { $url = $url -replace 'https://huggingface.co', $MirrorBase }
    return $url
}

# hf-mirror.com 对 resolve/main/ 下的**每个文件**都回 308（Location 指向 huggingface.co，再 302 到 CDN）。
# PS5.1 的 HttpWebRequest 不把 308 当可自动跟随的重定向——即使 AllowAutoRedirect 默认为 true 也直接抛异常。
# 这里手动跟 Location 链（301/302/303/307/308 都跟），返回最终地址；跟不动就退回原 URL 让下载自己报错。
function Resolve-HfRedirect {
    param([string]$Url)
    $maxHop = 8
    $cur = $Url
    for ($hop = 0; $hop -lt $maxHop; $hop++) {
        $code = 0
        $loc = $null
        try {
            $req = [System.Net.HttpWebRequest]::Create($cur)
            $req.Method = 'HEAD'
            $req.AllowAutoRedirect = $false
            $req.Timeout = 20000
            $req.UserAgent = 'dsh-unrestricted-printing/install-sd.ps1'
            $resp = $req.GetResponse()
            $code = [int]$resp.StatusCode
            $loc = [string]$resp.Headers['Location']
            $resp.Close()
        } catch {
            # 308 会让 GetResponse 抛 WebException，但响应体里带着 Location——从这里抠出来
            if ($_.Exception -and $_.Exception.Response) {
                try {
                    $code = [int]$_.Exception.Response.StatusCode
                    $loc = [string]$_.Exception.Response.Headers['Location']
                } catch { }
            }
            if ($code -lt 300 -or $code -ge 400 -or -not $loc) { return $cur }
        }
        if ($code -ge 300 -and $code -lt 400 -and $loc) {
            try { $cur = ([System.Uri]::new([System.Uri]$cur, $loc)).AbsoluteUri } catch { return $cur }
            continue
        }
        return $cur
    }
    return $cur
}


$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)   # 坑10 的关键：无 BOM

Write-Host "== dsh-unrestricted-printing 自举安装 ==" -ForegroundColor Cyan
Write-Host "目标目录: $Target"

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

# 把目录追加进「用户 PATH」（注册表原样读写，保留 ExpandString 类型，不碰系统 PATH）
function Add-UserPath([string]$Dir) {
    if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { return }
    $key = Get-Item 'HKCU:\Environment'
    $cur = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -eq $cur) { $cur = '' }
    $parts = @($cur -split ';' | Where-Object { $_ -ne '' })
    if ($parts -contains $Dir) {
        if ($env:PATH -notlike "*$Dir*") { $env:Path = "$Dir;$env:Path" }
        return
    }
    $kind = 'String'
    try { $kind = $key.GetValueKind('Path').ToString() } catch { $kind = 'String' }
    $new = (($parts + $Dir) -join ';')
    if ($kind -eq 'ExpandString') {
        New-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value $new -PropertyType ExpandString -Force | Out-Null
    } else {
        New-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value $new -PropertyType String -Force | Out-Null
    }
    if ($env:PATH -notlike "*$Dir*") { $env:Path = "$Dir;$env:Path" }
    Write-Host "已加入用户 PATH: $Dir" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 坑2：没有 git 就自动自举 MinGit 便携版（哈希校验 + git --version 实测 + 入 PATH）
# ---------------------------------------------------------------------------
function Install-MinGit {
    Write-Host "未检测到可用 git，自动下载 MinGit 便携版..." -ForegroundColor Yellow
    $rel = $null
    try {
        $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ Accept = 'application/vnd.github+json' } -TimeoutSec 60
    } catch {
        Write-Host "查询 git-for-windows 最新发布失败：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host "可手动装 Git for Windows（https://git-scm.com/download/win）后重跑，或加 -SkipGit。" -ForegroundColor Yellow
        exit 1
    }
    $asset = $rel.assets | Where-Object { $_.name -like 'MinGit-*-64-bit.zip' } | Select-Object -First 1
    if (-not $asset) {
        Write-Host "最新发布里没找到 MinGit-*-64-bit.zip，请手动安装 git 后重跑。" -ForegroundColor Red
        exit 1
    }
    $dest = Join-Path $env:LOCALAPPDATA 'dsh-sd-bridge\MinGit'
    $zip = Join-Path $env:TEMP $asset.name
    Write-Host "下载 $($asset.name) ..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing -TimeoutSec 600

    # 哈希校验：GitHub 资源带 digest 就用它，其次用 -GitSha256，都没有则记录实测值供人工比对
    $actual = Get-Sha256 $zip
    $expected = ''
    if ($asset.digest) { $expected = ($asset.digest -replace '^sha256:', '').ToLowerInvariant() }
    elseif ($GitSha256) { $expected = $GitSha256.ToLowerInvariant() }
    if ($expected) {
        if ($actual -ne $expected) {
            Remove-Item $zip -Force
            Write-Host "MinGit 校验失败：sha256 期望 $expected，实际 $actual（已删除，请重跑或换镜像）" -ForegroundColor Red
            exit 1
        }
        Write-Host "MinGit sha256 校验通过: $actual" -ForegroundColor Green
    } else {
        Write-Host "MinGit sha256（资源未提供 digest，实测值）: $actual" -ForegroundColor Yellow
    }

    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
    Remove-Item $zip -Force
    $gitExe = Join-Path $dest 'cmd\git.exe'
    if (-not (Test-Path $gitExe)) { $gitExe = Join-Path $dest 'mingw64\bin\git.exe' }
    if (-not (Test-Path $gitExe)) {
        Write-Host "MinGit 解压后找不到 git.exe，安装失败。" -ForegroundColor Red
        exit 1
    }
    $v = & $gitExe --version 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $v -notmatch 'git version') {
        Write-Host "git.exe 无法运行：$v" -ForegroundColor Red
        exit 1
    }
    Write-Host "git 就绪：$($v.Trim())" -ForegroundColor Green
    Add-UserPath (Join-Path $dest 'cmd')
    Add-UserPath (Join-Path $dest 'mingw64\bin')
    $env:Path = "$(Join-Path $dest 'cmd');$(Join-Path $dest 'mingw64\bin');$env:Path"
}

# ---------------------------------------------------------------------------
# 坑4：只有 WindowsApps 商店占位符 → 静默装官方 Python 3.10.6（A1111 在 Windows 只认 3.10）
# ---------------------------------------------------------------------------
function Get-RealPython {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) {
        $src = "$($cmd.Source)"
        if ($src -and $src -notlike '*\WindowsApps\*') {
            $out = & $src -c "import sys;print('%d.%d.%d' % sys.version_info[:3])" 2>&1 | Out-String
            if ($LASTEXITCODE -eq 0 -and $out.Trim() -match '^3\.10\.\d+$') { return $src }
        }
    }
    return $null
}

function Install-Python310 {
    Write-Host "未检测到可用的 Python 3.10（商店占位符不算），自动安装官方 3.10.6..." -ForegroundColor Yellow
    $url = 'https://www.python.org/ftp/python/3.10.6/python-3.10.6-amd64.exe'
    $installer = Join-Path $env:TEMP 'python-3.10.6-amd64.exe'
    Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing -TimeoutSec 600
    $actual = Get-Sha256 $installer
    if ($PythonSha256) {
        if ($actual -ne $PythonSha256.ToLowerInvariant()) {
            Remove-Item $installer -Force
            Write-Host "Python 安装包校验失败（实际 $actual），已删除。" -ForegroundColor Red
            exit 1
        }
        Write-Host "Python 安装包 sha256 校验通过: $actual" -ForegroundColor Green
    } else {
        Write-Host "Python 安装包 sha256（实测值，可与 python.org 公布值比对）: $actual" -ForegroundColor Yellow
    }
    # 用户级静默安装：PrependPath 写 HKCU PATH，AssociateFiles/Shortcuts 关掉避免污染右键菜单
    $args = '/quiet InstallAllUsers=0 PrependPath=1 Include_test=0 Include_pip=1 Include_launcher=0 AssociateFiles=0 Shortcuts=0'
    $p = Start-Process -FilePath $installer -ArgumentList $args -Wait -PassThru
    Remove-Item $installer -Force
    if ($p.ExitCode -ne 0) { Write-Host "Python 安装失败（退出码 $($p.ExitCode)）" -ForegroundColor Red; exit 1 }
    # 刷新本进程 PATH（用户 PATH 刚被写进注册表）
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
    $py = Get-RealPython
    if (-not $py) { Write-Host "Python 装完仍不可用，请手动装 3.10.6 后重跑。" -ForegroundColor Red; exit 1 }
    Write-Host "Python 就绪: $py" -ForegroundColor Green
    return $py
}

# ---------------------------------------------------------------------------
# 坑5：8 段并行分段下载（Range）+ 断点续传 + 长度/哈希校验
# 单连接被网络限速掐断时，分段并行能把 3GB 级文件从「几十分钟」拉回「几分钟」。
# ---------------------------------------------------------------------------
$script:SegmentWorker = {
    param([string]$Url, [long]$Start, [long]$End, [string]$Part, [int]$Tries)
    $need = $End - $Start + 1
    $tmp = "$Part.partnew"
    # Issue 4 修复（2026-10-16 真机报告）：以前失败原因被 `catch {}` 完全吞掉，
    # 用户只看到「分段下载全部失败」，无法判断是服务端不支持 Range、还是本地网络/代理问题。
    # 现在把每次尝试的异常（或「长度不符」）收进 $errs，失败时一并回报。
    $errs = @()
    for ($a = 1; $a -le $Tries; $a++) {
        $resp = $null; $src = $null; $dst = $null
        try {
            if ((Test-Path -LiteralPath $Part) -and ((Get-Item -LiteralPath $Part).Length -eq $need)) { return @{ Ok = $true; Errs = @() } }
            # 308 手动跟一次：hf-mirror 对 resolve/main 下每个文件都回 308，PS5.1 不会自动跟随
            $eff = Resolve-HfRedirect -Url $Url
            $req = [System.Net.HttpWebRequest]::Create($eff)
            $req.AddRange($Start, $End)
            $req.AllowAutoRedirect = $true
            $req.UserAgent = 'dsh-unrestricted-printing/install-sd.ps1'
            $req.Timeout = 30000
            $req.ReadWriteTimeout = 120000
            $resp = $req.GetResponse()
            $src = $resp.GetResponseStream()
            # 先写 .partnew，长度校验通过再原子改名——永不产生半成品分片
            $dst = [System.IO.File]::Create($tmp)
            $buf = New-Object byte[] (262144)
            while (($n = $src.Read($buf, 0, $buf.Length)) -gt 0) { $dst.Write($buf, 0, $n) }
            $dst.Flush(); $dst.Close(); $dst = $null
            $src.Close(); $src = $null
            $resp.Close(); $resp = $null
            $got = (Get-Item -LiteralPath $tmp).Length
            if ($got -eq $need) {
                Move-Item -LiteralPath $tmp -Destination $Part -Force
                return @{ Ok = $true; Errs = $errs }
            }
            # 长度不符：把「期望 vs 实收」记下来（服务端忽略 Range 时实收会是整文件长度）
            $errs += "尝试 $a`: 长度不符（期望 $need，实收 $got）——服务端可能忽略了 Range 请求"
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        } catch {
            $msg = $_.Exception.Message
            if ($_.Exception.InnerException) { $msg = "$msg ← $($_.Exception.InnerException.Message)" }
            $code = ''
            try { if ($_.Exception.Response) { $code = " HTTP $([int]$_.Exception.Response.StatusCode)" } } catch { }
            $errs += "尝试 $a`:$code $msg"
        } finally {
            if ($dst) { try { $dst.Dispose() } catch { } }
            if ($src) { try { $src.Dispose() } catch { } }
            if ($resp) { try { $resp.Close() } catch { } }
        }
        Start-Sleep -Seconds ([Math]::Min(10, 2 * $a))
    }
    return @{ Ok = $false; Errs = $errs }
}

function Get-SegmentedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$OutFile,
        [int]$Segs = 8,
        [string]$Sha256 = ''
    )
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    # 0) 先跟 308 跳转拿真实 CDN 地址（PS5.1 不自动跟随 308，HEAD 探测拿不到长度就退化单流）
    $effUrl = Resolve-HfRedirect -Url $Url

    # 1) 探总长度（HEAD；不支持就退回单流）
    $total = -1
    try {
        $head = [System.Net.HttpWebRequest]::Create($effUrl)
        $head.Method = 'HEAD'
        $head.AllowAutoRedirect = $true
        $head.Timeout = 30000
        $head.UserAgent = 'dsh-unrestricted-printing/install-sd.ps1'
        $r = $head.GetResponse(); $total = $r.ContentLength; $r.Close()
    } catch { $total = -1 }

    if ($total -gt 0 -and (Test-Path -LiteralPath $OutFile) -and ((Get-Item -LiteralPath $OutFile).Length -eq $total)) {
        Write-Host "文件已完整，跳过下载：$OutFile" -ForegroundColor Yellow
    } elseif ($total -gt 0 -and $Segs -gt 1) {
        $chunk = [int][Math]::Ceiling($total / $Segs)
        $parts = @()
        $pool = [runspacefactory]::CreateRunspacePool(1, $Segs)
        $pool.Open()
        $jobs = @()
        for ($i = 0; $i -lt $Segs; $i++) {
            [long]$s = [long]($i * $chunk)
            if ($s -ge $total) { break }
            [long]$e = [Math]::Min($total - 1, $s + $chunk - 1)
            $part = "$OutFile.part$i"
            $parts += $part
            # 断点续传：只认「长度正好等于这一段」的完整分片；被截断的半成品不算数（下次重下这一段）
            if ((Test-Path -LiteralPath $part) -and ((Get-Item -LiteralPath $part).Length -eq ($e - $s + 1))) { continue }
            $ps = [powershell]::Create()
            $ps.AddScript($script:SegmentWorker.ToString()).AddArgument($effUrl).AddArgument($s).AddArgument($e).AddArgument($part).AddArgument(5) | Out-Null
            $ps.RunspacePool = $pool
            $jobs += [pscustomobject]@{ Pipe = $ps; Handle = $ps.BeginInvoke(); Part = $part }
        }
        Write-Host "分段并行下载（$Segs 段，共 $([math]::Round($total/1MB,1)) MB）：$effUrl"
        $failed = @()
        $segErrs = @()
        foreach ($j in $jobs) {
            $ok = $false
            $detail = @()
            try {
                $res = $j.Pipe.EndInvoke($j.Handle)
                # Issue 4（2026-10-16）：worker 现在回报 @{ Ok; Errs }，从这里取失败原因
                if ($res -and $res.Count -gt 0) {
                    $last = $res[$res.Count - 1]
                    if ($last -is [hashtable] -and $last.ContainsKey("Ok")) {
                        $ok = [bool]$last["Ok"]
                        $detail = @($last["Errs"])
                    } elseif ($last -is [psobject] -and $last.PSObject.Properties["Ok"]) {
                        $ok = [bool]$last.Ok
                        $detail = @($last.Errs)
                    } else {
                        $ok = [bool]$last
                    }
                }
            } catch { $ok = $false; $detail = @("调用异常：$($_.Exception.Message)") }
            try { $j.Pipe.Dispose() } catch { }
            if (-not $ok) {
                $failed += $j.Part
                if ($detail.Count -gt 0) { $segErrs += "[$([IO.Path]::GetFileName($j.Part))] $($detail[-1])" }
            }
        }
        try { $pool.Close() } catch { }
        try { $pool.Dispose() } catch { }

        # 分段全挂（网络并发不稳 / 整段都失败）→ 自动降级单流重试一轮，而不是直接抛错
        if ($failed.Count -gt 0) {
            # Issue 4（2026-10-16）：先把每个分段的失败原因摊开，别让用户只能猜「为什么不支持分段」
            if ($segErrs.Count -gt 0) {
                Write-Host "  分段失败原因（共 $($segErrs.Count) 段，展示前 3 条）：" -ForegroundColor DarkYellow
                foreach ($e in ($segErrs | Select-Object -First 3)) { Write-Host "    $e" -ForegroundColor DarkGray }
            }
            $left = @($parts | Where-Object { -not (Test-Path -LiteralPath $_) -or ((Get-Item -LiteralPath $_).Length -eq 0) })
            if ($failed.Count -eq $parts.Count -or $left.Count -eq $parts.Count) {
                # 清理半成品分片（逐项 try/catch，别让残留句柄把脚本打断）
                foreach ($p in $parts) {
                    try { Remove-Item -LiteralPath $p -Force -ErrorAction Stop } catch { }
                }
                Write-Host "分段下载全部失败，降级单流下载：$effUrl" -ForegroundColor Yellow
                $ok = $false
                for ($a = 1; $a -le 3 -and -not $ok; $a++) {
                    try {
                        Invoke-WebRequest -Uri $effUrl -OutFile $OutFile -UseBasicParsing -TimeoutSec 1800
                        $ok = (Test-Path -LiteralPath $OutFile) -and ((Get-Item -LiteralPath $OutFile).Length -eq $total)
                    } catch {
                        # Issue 4（2026-10-16）：429 要退避重试——hf-mirror 对小文件限流，
                        # 实测连打 4 次全 429 直接放弃（SemiRealMix / VAE / EasyNegative / badhandv4 都被挡）。
                        $smsg = $_.Exception.Message
                        $is429 = $smsg -match "429|Too Many Requests"
                        $wait = if ($is429) { 30 * $a } else { 3 * $a }
                        $tag = if ($is429) { "（429 限流，退避重试）" } else { "" }
                        Write-Host "单流第 $a 次失败$tag：$smsg" -ForegroundColor Yellow
                        Write-Host "  等待 ${wait}s 后重试…" -ForegroundColor DarkGray
                        Start-Sleep -Seconds $wait
                    }
                }
                if (-not $ok) { throw "下载失败（分段与单流均失败）：$effUrl" }
            } else {
                Write-Host "有 $($failed.Count) 段失败，留待重跑续传（已成功的段不会重下）。" -ForegroundColor Yellow
            }
        }

        # 只在一部分段成功、需要合并时才走下面（全部失败已降级单流直接返回）
        $stillNeedsMerge = $false
        foreach ($p in $parts) { if (Test-Path -LiteralPath $p) { $stillNeedsMerge = $true; break } }
        if ($stillNeedsMerge) {
            # 释放可能残留的文件句柄再合并（下载线程刚 Dispose，句柄有时要一小拍才彻底释放）
            Start-Sleep -Milliseconds 1200
            $out = [System.IO.File]::Create($OutFile)
            try {
                for ($i = 0; $i -lt $parts.Count; $i++) {
                    $p = $parts[$i]
                    if (-not (Test-Path -LiteralPath $p)) { throw "缺少分段 $p（请重跑续传）" }
                    $in = [System.IO.File]::OpenRead($p)
                    try { $in.CopyTo($out) } finally { $in.Dispose() }
                }
            } finally { $out.Dispose() }
            # 合并完成后清分段（逐项 try/catch，文件被占也不掀翻脚本）
            foreach ($p in $parts) {
                try { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction Stop } } catch { }
            }
            if ((Get-Item -LiteralPath $OutFile).Length -ne $total) {
                try { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue } catch { }
                throw "合并后长度不符（期望 $total），已删除，请重跑续传。"
            }
        }
    } else {
        # 服务器不给长度/不支持 Range → 单流 + 重试
        Write-Host "单流下载（服务器未提供长度或不支持 Range）：$effUrl"
        $ok = $false
        for ($a = 1; $a -le 4 -and -not $ok; $a++) {
            try {
                Invoke-WebRequest -Uri $effUrl -OutFile $OutFile -UseBasicParsing -TimeoutSec 1800
                $ok = (Test-Path -LiteralPath $OutFile) -and ((Get-Item -LiteralPath $OutFile).Length -gt 0)
            } catch {
                Write-Host "第 $a 次下载失败：$($_.Exception.Message)" -ForegroundColor Yellow
                Start-Sleep -Seconds (3 * $a)
            }
        }
        if (-not $ok) { throw "下载失败：$effUrl" }
    }

    $size = (Get-Item -LiteralPath $OutFile).Length
    if ($Sha256) {
        $got = Get-Sha256 $OutFile
        if ($got -ne $Sha256.ToLowerInvariant()) {
            try { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue } catch { }
            throw "sha256 校验失败：期望 $Sha256，实际 $got（已删除）"
        }
        Write-Host "sha256 校验通过: $got" -ForegroundColor Green
    }
    Write-Host "下载完成: $OutFile ($([math]::Round($size/1MB,1)) MB)" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 写 WebUI 的质量默认配置（只改点名的键，其余原样保留；文件坏掉则备份重建）
# 「新装 SD 画质差」的第二个根因：只有 SD1.5 base + 默认 VAE + CLIP skip 1。
function Set-WebuiQualityConfig {
    param([string]$WebuiDir, [System.Collections.Specialized.OrderedDictionary]$Want)
    $cfgPath = Join-Path $WebuiDir 'config.json'
    $text = ''
    # A1111 用 open(..., encoding="utf8") 读 config.json（modules/options.py）；BOM 会让它的
    # json.load 直接判「文件损坏」搬走，所以读时剥 BOM、写时一律不带 BOM。
    # 老构建可能按本地代码页存过——严格 UTF-8 解不出来就退回本地代码页，写回时沿用同一编码。
    $enc = New-Object System.Text.UTF8Encoding($false)
    if (Test-Path $cfgPath) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($cfgPath)
            $offset = 0
            if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $offset = 3 }
            try {
                $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
                $text = $strictUtf8.GetString($bytes, $offset, $bytes.Length - $offset)
            } catch {
                $enc = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage)
                $text = $enc.GetString($bytes)
                Write-Host "  config.json 不是 UTF-8，按本地代码页 $($enc.CodePage) 读写以保留原有内容" -ForegroundColor Yellow
            }
            $null = $text | ConvertFrom-Json
        } catch {
            Write-Host "config.json 无法解析（$($_.Exception.Message)），备份为 config.json.bad 后重建" -ForegroundColor Yellow
            Copy-Item $cfgPath "$cfgPath.bad" -Force
            $text = ''
        }
    }
    $obj = if ($text) { $text | ConvertFrom-Json } else { New-Object PSObject }
    $changes = @()
    foreach ($k in $Want.Keys) {
        $new = $Want[$k]
        $old = $obj.$k
        if ("$old" -eq "$new") { continue }
        $changes += ("  {0}: '{1}' -> '{2}'" -f $k, $old, $new)
        $obj | Add-Member -NotePropertyName $k -NotePropertyValue $new -Force
    }
    if ($changes.Count -eq 0) {
        Write-Host "质量默认配置已是目标值，无需改动：$cfgPath" -ForegroundColor Green
        return
    }
    $json = $obj | ConvertTo-Json -Depth 16
    [System.IO.File]::WriteAllText($cfgPath, $json, $enc)   # 与读取同编码；不写 BOM（A1111 读到 BOM 会当损坏文件搬走）
    Write-Host "已写入质量默认配置 $cfgPath ：" -ForegroundColor Green
    $changes | ForEach-Object { Write-Host $_ }
}

# ---------------------------------------------------------------------------
# 0) 环境预检（Test-Prereqs）：任何下载/克隆之前跑完，缺失项逐个自举，
#    每项失败只报一条错 + 一行提示就 exit 1；最后打一张就绪清单。
# ---------------------------------------------------------------------------
function Test-Prereqs {
    $status = [ordered]@{}
    $fail = { param($k, $msg) $status[$k] = "✗ $msg"; Write-Host $msg -ForegroundColor Red; exit 1 }

    # 磁盘空间（模型 + WebUI + 依赖 ≥ 15GB，提前拦比下到 90% 才报错友好）
    if (-not $SkipDiskCheck) {
        $root = [System.IO.Path]::GetPathRoot($Target)
        $drive = Get-PSDrive -Name $root.TrimEnd('\:') -ErrorAction SilentlyContinue
        if ($drive -and $drive.Free -gt 0 -and $drive.Free -lt 15GB) {
            & $fail 'disk' ("磁盘空间不足：{0} 可用 {1:N1}GB，至少需要 15GB（-SkipDiskCheck 跳过）" -f $root, ($drive.Free / 1GB))
        }
        $status['disk'] = if ($drive -and $drive.Free -gt 0) { "✓ $($root) 可用 $([math]::Round($drive.Free/1GB,1))GB" } else { '✓ 空间未知（非固定盘）' }
    } else { $status['disk'] = '✓ 跳过（-SkipDiskCheck）' }

    # 网络连通（镜像探活；失败提示换源，不猜测用户网络）
    if ($Mirror -ne '') {
        $probeOk = $false
        $probeErr = ''
        try {
            $req = [System.Net.HttpWebRequest]::Create("$Mirror/")
            $req.Method = 'HEAD'; $req.Timeout = 15000; $req.UserAgent = 'dsh-unrestricted-printing/preflight'
            $resp = $req.GetResponse(); $resp.Close(); $probeOk = $true
        } catch { $probeOk = $false; $probeErr = $_.Exception.Message }
        if (-not $probeOk) {
            Write-Host "镜像 $Mirror 探活失败（$probeErr）。" -ForegroundColor Yellow
            Write-Host '可改用官方源重跑：powershell -ExecutionPolicy Bypass -File install-sd.ps1 -Mirror ""' -ForegroundColor Yellow
        }
        $status['net'] = if ($probeOk) { "✓ $Mirror 可达" } else { "✗ $Mirror 不可达（继续，下载阶段会再重试）" }
    } else { $status['net'] = '✓ 官方源（-Mirror 为空）' }

    # git（坑2：缺失则自举 MinGit）
    if (-not $SkipGit) {
        $git = Get-Command git -ErrorAction SilentlyContinue
        if (-not $git) { Install-MinGit; $git = Get-Command git -ErrorAction SilentlyContinue }
        if (-not $git) { & $fail 'git' '错误：未找到 git。请先安装 Git for Windows（https://git-scm.com/download/win）后重跑本脚本。' }
        $status['git'] = '✓ git 就绪（本机已有）'
    } else { $status['git'] = '✓ 跳过（-SkipGit）' }

    # Python（坑4：商店占位符 → 静默装 3.10.6）——装完的实例由调用方继续使用
    $py = $null
    if (-not $SkipPython) {
        $py = Get-RealPython
        if (-not $py) { $py = Install-Python310 }
        if ($py) { Add-UserPath (Split-Path -Parent $py) }
        if (-not $py) { & $fail 'python' '错误：Python 3.10 不可用（商店占位符不算）。请安装官方 Python 3.10.6 后重跑。' }
        $status['python'] = "✓ Python 就绪：$py"
    } else {
        $py = Get-RealPython
        $status['python'] = if ($py) { "✓ Python 就绪（-SkipPython）：$py" } else { '✗ 未找到 Python 3.10（-SkipPython）' }
    }

    # VC++ 2015-2022 x64 运行库（torch/A1111 硬依赖，缺了首轮启动报错极迷惑）
    if (-not $SkipVC) {
        $vcOk = $false
        foreach ($rk in @('HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64')) {
            try { if ((Get-ItemProperty -Path $rk -Name Installed -ErrorAction Stop).Installed -eq 1) { $vcOk = $true; break } } catch { }
        }
        if ($vcOk) {
            $status['vc'] = '✓ VC++ 2015-2022 x64 已安装'
        } else {
            Write-Host '未检测到 VC++ 2015-2022 x64 运行库，自动安装官方 vc_redist...' -ForegroundColor Yellow
            $redist = Join-Path $env:TEMP 'dsh-sd-bridge-vc_redist.x64.exe'
            $installed = $false
            try {
                Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $redist -UseBasicParsing -TimeoutSec 300
                $p = Start-Process -FilePath $redist -ArgumentList '/install','/quiet','/norestart' -Wait -PassThru
                $installed = ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010)
                if (-not $installed) { Write-Host "vc_redist 安装失败（退出码 $($p.ExitCode)）。" -ForegroundColor Yellow }
            } catch { Write-Host "vc_redist 下载失败（$($_.Exception.Message)）。" -ForegroundColor Yellow }
            if ($installed) {
                $status['vc'] = '✓ VC++ 2015-2022 x64 已补齐'
                Write-Host 'VC++ 运行库已安装。' -ForegroundColor Green
            } else {
                & $fail 'vc' '错误：VC++ 2015-2022 x64 运行库缺失且自动安装失败。请手动安装 vc_redist.x64.exe（https://aka.ms/vs/17/release/vc_redist.x64.exe）后重跑，或加 -SkipVC 跳过。'
            }
            Remove-Item -LiteralPath $redist -Force -ErrorAction SilentlyContinue
        }
    } else { $status['vc'] = '✓ 跳过（-SkipVC）' }

    Write-Host ''
    Write-Host '== 环境预检结果 ==' -ForegroundColor Cyan
    foreach ($k in $status.Keys) { Write-Host ("  {0}" -f $status[$k]) -ForegroundColor Green }
    Write-Host ''
    return $py
}

# 1) 环境预检（磁盘 / 网络 / git / Python / VC++，缺失即自举）
# ---------------------------------------------------------------------------
$pythonExe = $null
if ($NoPrereq) {
    $pythonExe = Get-RealPython
    Write-Host '已跳过环境预检（-NoPrereq）。' -ForegroundColor Yellow
} else {
    $pythonExe = Test-Prereqs
}

# 3) clone WebUI（已存在则跳过）
$launchPy = Join-Path $Target 'launch.py'
if (Test-Path $launchPy) {
    Write-Host "WebUI 已存在，跳过克隆：$Target" -ForegroundColor Yellow
} else {
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Write-Host "克隆 Stable Diffusion WebUI（约 2GB，请耐心等待）..."
    & git clone --depth 1 $Repo $Target
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $launchPy)) {
        Write-Host "错误：克隆失败。可换 -Repo 指定镜像仓库后重试。" -ForegroundColor Red
        exit 1
    }
}

# ---------------------------------------------------------------------------
# 4) 资源下载（清单循环）：模型 / VAE / LoRA·Embedding
#    - 已存在且未 -Upgrade → 跳过；-Upgrade → sha 复验、不符则重拉
#    - 清单条目带 Supersedes 且命中 -Upgrade → 旧版在、新版缺就补拉新版（旧版保留）
#    - 单项失败只记一行、不阻断其余项（模型可稍后重跑补齐）
# ---------------------------------------------------------------------------
$downloadLog = @()
function Get-CatalogItemState {
    param([string]$Dir, [hashtable]$Item, [switch]$UpgradeMode)
    $path = Join-Path $Dir $Item.Name
    if (-not (Test-Path -LiteralPath $path)) { return @{ Path = $path; Action = 'download'; Reason = '缺失' } }
    if ($UpgradeMode) {
        $got = Get-Sha256 $path
        if ($Item.Sha -and $got -ne $Item.Sha.ToLowerInvariant()) {
            return @{ Path = $path; Action = 'download'; Reason = "sha 不符（实际 $got）→ 重拉" }
        }
        return @{ Path = $path; Action = 'skip'; Reason = $(if ($UpgradeMode) { '已存在·sha 复验通过' } else { '已存在' }) }
    }
    return @{ Path = $path; Action = 'skip'; Reason = '已存在' }
}

function Invoke-CatalogDownload {
    param([string]$Label, [string]$Dir, [hashtable]$Item)
    $st = Get-CatalogItemState -Dir $Dir -Item $Item -UpgradeMode:$Upgrade
    if ($st.Action -eq 'skip') {
        Write-Host "跳过（$($st.Reason)）：$($Item.Name)" -ForegroundColor Yellow
        $script:downloadLog += [pscustomobject]@{ Kind = $Label; Name = $Item.Name; Result = "✓ $($st.Reason)" }
        return $st.Path
    }
    # -Upgrade 且清单声明了取代关系：旧版文件在但新版缺 → 补拉新版（旧版不动）
    if ($Upgrade -and $Item.Supersedes) {
        foreach ($old in $Item.Supersedes) {
            if (Test-Path -LiteralPath (Join-Path $Dir $old)) { Write-Host "检测到旧版本 $old，将补拉新版 $($Item.Name)（旧版保留）" -ForegroundColor Yellow; break }
        }
    }
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $url = Get-HfUrl -Item $Item -MirrorBase $Mirror
    $why = if ($st.Reason -and $st.Reason -ne '缺失') { "（$($st.Reason)）" } else { '' }
    Write-Host "下载 $Label$why：$($Item.Name)（$($Item.Tag)）→ $url"
    try {
        Get-SegmentedFile -Url $url -OutFile $st.Path -Segs $Segments -Sha256 $Item.Sha
        $script:downloadLog += [pscustomobject]@{ Kind = $Label; Name = $Item.Name; Result = '✓ 已下载' }
        return $st.Path
    } catch {
        Write-Host "$Label 下载失败（$($_.Exception.Message)），跳过继续——可稍后重跑补齐。" -ForegroundColor Yellow
        # 逐项 try/catch 清理 .part*：下载线程可能仍占着文件，Remove-Item 抛 IOException
        # 在 $ErrorActionPreference='Stop' 下会把整个脚本掀翻（后续 VAE/LoRA/config/记录全不执行）
        Get-ChildItem -LiteralPath $Dir -Filter '*.part*' -ErrorAction SilentlyContinue | ForEach-Object {
            try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch { }
        }
        if ((Test-Path -LiteralPath $st.Path) -and -not $Item.Sha) { try { Remove-Item -LiteralPath $st.Path -Force -ErrorAction SilentlyContinue } catch { } }
        $script:downloadLog += [pscustomobject]@{ Kind = $Label; Name = $Item.Name; Result = "✗ $($_.Exception.Message)" }
        return $null
    }
}

# 4a) 主模型清单
$modelDir = Join-Path $Target 'models\Stable-diffusion'
$modelKeys = @(Resolve-Keys $Models $ModelCatalog)
$primaryModel = $null
if ($SkipModel) {
    Write-Host "已跳过模型下载（-SkipModel）。请自行把 .safetensors 放进 $modelDir" -ForegroundColor Yellow
} elseif ($modelKeys.Count -eq 0) {
    Write-Host "模型清单为空（-Models none）。请自行把 .safetensors 放进 $modelDir" -ForegroundColor Yellow
} else {
    foreach ($k in $modelKeys) {
        $p = Invoke-CatalogDownload -Label '模型' -Dir $modelDir -Item $ModelCatalog[$k]
        if ($p -and -not $primaryModel) { $primaryModel = $p }
    }
}

# 4b) VAE 清单（画质关键：SD1.5 系默认 VAE 偏灰，mse-840000 明显干净）
$vaeDir = Join-Path $Target 'models\VAE'
$vaeKeys = @(Resolve-Keys $Vaes $VaeCatalog)
$primaryVae = $null
if ($SkipVae) {
    Write-Host '已跳过 VAE（-SkipVae）——建议补上，否则画面容易发灰' -ForegroundColor Yellow
} elseif ($vaeKeys.Count -eq 0) {
    Write-Host 'VAE 清单为空（-Vaes none）——画面容易发灰，建议至少拉 mse' -ForegroundColor Yellow
} else {
    foreach ($k in $vaeKeys) {
        $p = Invoke-CatalogDownload -Label 'VAE' -Dir $vaeDir -Item $VaeCatalog[$k]
        if ($p -and -not $primaryVae) { $primaryVae = $p }
    }
}

# 4c) LoRA / Embedding 清单（LoRA → models\Lora，Embedding → models\embeddings）
$loraKeys = @(Resolve-Keys $Loras $LoraCatalog)
if ($SkipLora) {
    Write-Host '已跳过 LoRA/Embedding（-SkipLora）' -ForegroundColor Yellow
} elseif ($loraKeys.Count -eq 0) {
    Write-Host 'LoRA 清单为空（-Loras none）' -ForegroundColor Yellow
} else {
    foreach ($k in $loraKeys) {
        $item = $LoraCatalog[$k]
        $sub = if ($item.Sub) { $item.Sub } else { 'Lora' }
        $subDir = Join-Path $Target "models\$sub"
        Invoke-CatalogDownload -Label $sub -Dir $subDir -Item $item | Out-Null
    }
}

# 5) 质量默认配置：默认模型 / VAE / CLIP skip 2（AWPainting 官方推荐）
#    取清单里第一个成功落盘的模型与 VAE 作为默认项。
if ($NoConfig) {
    Write-Host "已跳过写入质量默认配置（-NoConfig）" -ForegroundColor Yellow
} else {
    $want = [ordered]@{}
    if ($primaryModel -and (Test-Path -LiteralPath $primaryModel)) { $want['sd_model_checkpoint'] = [System.IO.Path]::GetFileName($primaryModel) }
    if ($primaryVae -and (Test-Path -LiteralPath $primaryVae)) { $want['sd_vae'] = [System.IO.Path]::GetFileName($primaryVae) }
    if ($want.Count -gt 0) { $want['CLIP_stop_at_last_layers'] = 2 }
    if ($want.Count -eq 0) {
        Write-Host "模型/VAE 均未就位，跳过写配置（下次装好后重跑即可）" -ForegroundColor Yellow
    } else {
        Set-WebuiQualityConfig -WebuiDir $Target -Want $want
    }
}

# 5b) 资源清单汇总（下载 / 跳过 / 失败一目了然）
if ($downloadLog.Count -gt 0) {
    Write-Host ''
    Write-Host '== 资源清单汇总 ==' -ForegroundColor Cyan
    foreach ($row in $downloadLog) {
        $color = if ($row.Result -like '✗*') { 'Red' } elseif ($row.Result -like '✓ 已下载') { 'Green' } else { 'Yellow' }
        Write-Host ("  [{0}] {1} — {2}" -f $row.Kind, $row.Name, $row.Result) -ForegroundColor $color
    }
    $failedRows = @($downloadLog | Where-Object { $_.Result -like '✗*' })
    if ($failedRows.Count -gt 0) {
        Write-Host "有 $($failedRows.Count) 项下载失败——重跑本脚本会自动续传/补齐。" -ForegroundColor Yellow
    }
}

# 5) 记录安装位置，插件下次启动自动读到（~/.dsh-sd-bridge.json）
#    坑10 根因：PS5.1 `Set-Content -Encoding UTF8` 写出**带 BOM** 的文件，
#    插件裸 JSON.parse 遇 BOM 抛错 → sdDir 读成空 → 每次都指引重复安装。这里用无 BOM 写入。
#    坑21：记录写失败（目录只读 / 沙箱拦 / 企业策略）**不能把已装好的 SD 判成失败**——
#    WebUI、模型、VAE、配置都已落盘，重跑一次也只是补缺。所以这里只报一条错 + 一行提示，
#    不让未捕获异常把整次安装打成 exit 1。
if ($StateFile) {
    $stateFile = $StateFile
} elseif ($env:DSH_SD_STATE_FILE) {
    $stateFile = $env:DSH_SD_STATE_FILE
} else {
    $stateFile = Join-Path $env:USERPROFILE '.dsh-sd-bridge.json'
}
$record = [ordered]@{ sdDir = $Target }
if ($pythonExe) { $record['pythonDir'] = (Split-Path -Parent $pythonExe) }   # 插件启动时优先用它
$json = ($record | ConvertTo-Json)
$recordWritten = $false
try {
    [System.IO.File]::WriteAllText($stateFile, "$json`r`n", $Utf8NoBom)
    $bytes = [System.IO.File]::ReadAllBytes($stateFile)
    $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    if ($bom) {
        Write-Host "警告：记录仍带 BOM，插件将读不出来！请手动删除该文件重跑：$stateFile" -ForegroundColor Red
    } else {
        Write-Host "已记录安装位置 -> $stateFile  (BOM=$bom，必须 False)" -ForegroundColor Green
    }
    $recordWritten = $true
} catch {
    # 安装本身已成功：只提示，不中断。插件侧还有 DSH_SD_DIR / cordis.patch.yml 两条兜底路径。
    Write-Host "安装记录写入失败（不影响已装好的 SD）：$stateFile — $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "插件读不到记录时可改设环境变量 DSH_SD_DIR=$Target，或在 cordis.patch.yml 按 id sd-bridge 覆盖 sdDir。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "== 完成 ==" -ForegroundColor Cyan
Write-Host "1. 重启 DeepSeek Harness（插件会重新探测 SD 目录）"
if (-not $recordWritten) {
    Write-Host "   （本次安装记录没写成功：重启前先设 DSH_SD_DIR=$Target，否则插件探测不到）" -ForegroundColor Yellow
}
Write-Host "2. 直接让它画一张图即可；首次启动会在线安装 Python/torch 依赖（10-30 分钟），之后秒级"
Write-Host "3. 想换安装位置：设环境变量 DSH_SD_DIR，或在 cordis.patch.yml 按 id sd-bridge 覆盖 sdDir"
Write-Host "4. 首次依赖准备已由插件预置：Blackwell(RTX50 系) 自动用 torch 2.7.0+cu128、pip 钉 setuptools/numpy/opencv、"
Write-Host "   上游已删除的 Stability-AI/stablediffusion 自动换到签名可验证的 camenduru fork"
