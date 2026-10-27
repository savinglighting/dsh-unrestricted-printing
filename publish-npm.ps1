# publish-npm.ps1 —— dsh-unrestricted-printing 一键发布脚本
# （重要：**必须在你自己的普通 PowerShell 窗口里运行**，原因见下方「为什么」）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File "D:\DSWorkPlace\release\publish-npm.ps1"
#       → 默认路径：让 npm 走浏览器验证（你的 2FA 是安全密钥 / Windows Hello PIN），
#         弹出窗口时用 PIN 确认即可——不需要验证器 App
#   ... -Token npm_xxxxxxxx
#       → 用勾了 Bypass 2FA 的 Granular Access Token：完全不弹窗（npm 已宣布 2027-01 起收紧直接发布）
#   ... -Otp 123456
#       → 万一你临时装了验证器 App，也可以直接传 TOTP 码
#   ... -DryRun
#       → 干跑：npm publish --dry-run，不真正上传（建议先跑这个验证流程）
#
# 为什么必须在普通窗口里跑：
#   npm 的 2FA 分两类——TOTP（验证器 App 的 6 位码）和 WebAuthn（安全密钥 / Windows Hello PIN）。
#   你的账号是后者：npm 只有识别到**交互式终端（TTY）**才会打开「浏览器批准」流程；
#   输出被重定向（管道 / 被脚本捕获 / 在 Agent 或编辑器里跑）时，npm 会退化成「请输入 OTP」→ EOTP 失败。
#   所以在 Windows Terminal / PowerShell 图标里直接开一个窗口运行本脚本，PIN 弹窗就会出现。

[CmdletBinding()]
param(
    [string]$Otp = "",
    [string]$Token = "",
    [string]$Tarball = "",                                  # 留空 = 自动取插件目录里最新的 dsh-unrestricted-printing-*.tgz
    [string]$PluginDir = "C:\Users\zhang\.dsh\profiles\desktop\node_modules\dsh-unrestricted-printing",
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-WarnNote([string]$Text) { Write-Host "  [!] $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "`n[FAIL] $Text" -ForegroundColor Red; exit 1 }

$ver = "0.9.14"
$isTTY = $true
try { $isTTY = -not [Console]::IsOutputRedirected } catch { $isTTY = $true }

Write-Host "dsh-unrestricted-printing · npm 发布脚本" -ForegroundColor Magenta
if ($DryRun) { Write-WarnNote "DRY-RUN 模式：不会真正上传，只验证流程" }
if (-not $isTTY) { Write-WarnNote "输出被重定向（非交互终端）：npm 无法走浏览器验证，只有 -Token / -Otp 两条路" }

# 0) 环境检查
Write-Step "0/5 环境检查"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail "找不到 npm（先装 Node.js 并确保在 PATH 里）" }
Write-Ok ("npm " + (npm -v))
if (-not $Tarball) {
    # 自动挑最新的包：优先插件目录（npm pack 的落点），其次 release 目录
    $cands = @()
    foreach ($dir in @((Split-Path -Parent $MyInvocation.MyCommand.Path), 'D:\DSWorkPlace\release', 'D:\DSWorkPlace')) {
        if ($dir -and (Test-Path -LiteralPath $dir)) {
            $cands += @(Get-ChildItem -LiteralPath $dir -Filter 'dsh-unrestricted-printing-*.tgz' -File -ErrorAction SilentlyContinue)
        }
    }
    if ($cands.Count -gt 0) {
        $Tarball = ($cands | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
        Write-Ok ("自动选中最新 tarball：" + $Tarball)
    }
}
if (-not (Test-Path -LiteralPath $Tarball)) {
    Fail "找不到 tarball（-Tarball 留空也没自动找到）：先在插件目录跑 npm pack"
}
$tb = Get-Item -LiteralPath $Tarball
Write-Ok ("tarball: " + $tb.FullName + "（" + [math]::Round($tb.Length / 1KB, 1) + " KB）")

# 1) 版本一致性
Write-Step "1/5 版本一致性"
$pkgJson = Join-Path $PluginDir 'package.json'
if (-not (Test-Path -LiteralPath $pkgJson)) {
    Write-WarnNote "找不到 $pkgJson，跳过版本核对"
} else {
    $ver = (Get-Content -LiteralPath $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json).version
    if ($tb.Name -notmatch [regex]::Escape($ver)) {
        Fail "tarball 文件名（$($tb.Name)）与 package.json 版本（$ver）不一致：先重新 npm pack"
    }
    Write-Ok "版本一致：$ver"
}

# 2) 认证检查
Write-Step "2/5 认证检查（npm whoami）"
$who = ''
try { $who = ([string](npm whoami 2>$null)).Trim() } catch { $who = '' }
if ([string]::IsNullOrWhiteSpace($who)) {
    Write-WarnNote "npm whoami 没通过——当前 token 可能失效；先 npm login（浏览器 + PIN），或用 -Token <新 token>"
} else {
    Write-Ok "已登录账号：$who"
}

# 3) 组装发布命令
Write-Step "3/5 组装发布命令"
$publishArgs = @('publish', $Tarball, '--access', 'public')
if ($DryRun) { $publishArgs += '--dry-run' }

$authDesc = ''
if ($Token -ne '') {
    $publishArgs += "--//registry.npmjs.org/:_authToken=$Token"
    $authDesc = 'Granular Token（Bypass 2FA，不弹窗）'
} elseif ($Otp -ne '') {
    $publishArgs += "--otp=$Otp"
    $authDesc = "TOTP $Otp"
} elseif ($DryRun) {
    $authDesc = 'DRY-RUN（无需认证）'
} elseif (-not $isTTY) {
    Fail @"
非交互终端，且没给 -Token / -Otp：npm 会直接索要 OTP，而你的 2FA 是安全密钥/PIN，必然 EOTP 失败。
       请二选一：
         a) 在你自己的 PowerShell 窗口里运行本脚本（会弹浏览器，用 PIN 确认）；
         b) 传一个勾了 Bypass 2FA 的 Granular Token：... -Token npm_xxxxxxxx
"@
} else {
    $authDesc = '浏览器验证（安全密钥 / Windows Hello PIN）——请在弹出的窗口里用 PIN 确认'
}
Write-Ok ("认证方式：" + $authDesc)

# 4) 发布
Write-Step "4/5 npm publish"
$shown = ($publishArgs -join ' ')
if ($Token -ne '') { $shown = $shown.Replace($Token, 'npm_***MASKED***') }
Write-Host ("  npm " + $shown) -ForegroundColor DarkGray
& npm @publishArgs
if ($LASTEXITCODE -ne 0) {
    Fail @"
发布失败（exit $LASTEXITCODE）。对照处理：
       a) EOTP → npm 没拿到 2FA：确认是在**你自己的交互式窗口**里跑的（弹浏览器、用 PIN 确认）；
                 或改用 -Token（勾了 Bypass 2FA 的 Granular Access Token）。
       b) E404 → 当前 ~/.npmrc 里的 token 无效/无权：在 npm 网站删掉旧 token，生成带 Bypass 2FA 的新 token。
       c) 403  → 权限问题：确认这个包的主维护者是 savinglighting。
"@
}
Write-Ok "publish 成功"

# 5) 复核 registry
Write-Step "5/5 复核 registry"
Start-Sleep -Seconds 3
$latest = ''
try { $latest = ([string](npm view dsh-unrestricted-printing version 2>$null)).Trim() } catch { $latest = '' }
if ($latest -eq $ver) { Write-Ok "registry 最新版本 = $latest" }
else { Write-WarnNote "registry 返回：$latest（若刚发布，等几秒后再 npm view dsh-unrestricted-printing version 复核）" }

Write-Host "`n完成。包页：https://www.npmjs.com/package/dsh-unrestricted-printing" -ForegroundColor Magenta
