# =============================================================================
# pack-github.ps1 —— 本地打「GitHub 发布格式」产物（与 .github/workflows/release.yml 同一套步骤）
#
# 产出（dist\）：
#   dsh-unrestricted-printing-<version>.zip   —— 解包即用的插件源码包（含 package.json / INSTALL.md / workflows / docs / gateway）
#   dsh-unrestricted-printing-<version>.tgz   —— npm pack 产物（npm i -g / DSH npm 源用）
#   deps-report.md                       —— 依赖体检报告（可选，-WithDepsReport 时生成）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File pack-github.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File pack-github.ps1 -WithDepsReport -KeepStage
# =============================================================================
param(
    [switch]$WithDepsReport,
    [switch]$KeepStage,
    [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = $PSScriptRoot
if (-not $root) { try { $root = Split-Path -Parent $PSCommandPath } catch { } }
Set-Location -LiteralPath $root

function Read-JsonUtf8 { param([string]$p) return (Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json) }

$pkg = Read-JsonUtf8 'package.json'
$ver = $pkg.version
Write-Host "打包 dsh-unrestricted-printing v$ver" -ForegroundColor Cyan

if (-not $SkipChecks) {
    Write-Host "· 门禁：manifest 一致性" -ForegroundColor DarkGray
    node gen-manifest.mjs --check | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "manifest 不是最新的（先跑 node gen-manifest.mjs）" }
    Write-Host "· 门禁：完整性" -ForegroundColor DarkGray
    node verify-integrity.mjs | Select-Object -Last 3 | Out-Host
    Write-Host "· 门禁：网关测试" -ForegroundColor DarkGray
    node --test "gateway/test/*.test.mjs" | Select-String -Pattern '^ℹ (tests|pass|fail)' | Out-Host
    Write-Host "· 门禁：插件冒烟" -ForegroundColor DarkGray
    node tests/smoke-skill.mjs | Select-String -Pattern 'TEST FAILED' | Out-Host
}

if ($WithDepsReport) {
    Write-Host "· 生成依赖体检报告" -ForegroundColor DarkGray
    powershell -NoProfile -ExecutionPolicy Bypass -File 'gateway\tools\check-deps.ps1' -Markdown 'docs\deps-report.md' | Select-Object -Last 3 | Out-Host
}

$dist = Join-Path $root 'dist'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
$stage = Join-Path $dist "dsh-unrestricted-printing-$ver"
$null = New-Item -ItemType Directory -Force -Path $stage

# 1) package.json 的 files 清单 = 要发给用户的东西
foreach ($f in $pkg.files) {
    $rel = "$f".TrimEnd('/')
    $src = Join-Path $root $rel
    if (-not (Test-Path -LiteralPath $src)) { Write-Host "  跳过不存在的条目: $rel" -ForegroundColor Yellow; continue }
    if ((Get-Item -LiteralPath $src).PSIsContainer) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $stage (Split-Path $rel -Leaf)) -Recurse -Force
    } else {
        Copy-Item -LiteralPath $src -Destination $stage -Force
    }
}
# 2) GitHub 打包必备项（npm 会自动带 package.json；手打 zip 必须显式加）
foreach ($extra in @('package.json', 'INSTALL.md', 'docs\deps-report.md', '.gitignore', '.gitattributes')) {
    $p = Join-Path $root $extra
    if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination $stage -Force }
}
# 3) GitHub 侧工作流（拿到包的人自己发版也能用）
$wf = Join-Path $root '.github\workflows'
if (Test-Path -LiteralPath $wf) {
    $dst = Join-Path $stage '.github\workflows'
    $null = New-Item -ItemType Directory -Force -Path $dst
    # 2026-10-20 修：LiteralPath 不展开通配符 → 以前 .github/workflows 里一个文件都没进包
    Copy-Item -Path (Join-Path $wf '*') -Destination $dst -Recurse -Force
}
# 4) 清运行产物（绝不把 -iter / SD-Picture / __pycache__ 打进包）
foreach ($junk in @('.sd-inject-iter', 'SD-Picture', '__pycache__', 'ref', 'node_modules')) {
    Get-ChildItem -LiteralPath $stage -Recurse -Force -Directory -Filter $junk -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

$zip = Join-Path $dist "dsh-unrestricted-printing-$ver.zip"
# 2026-10-20：带顶层目录打包（下载者解压得到一个文件夹，而不是把 70 个文件散在当前目录）
# ⚠ Compress-Archive 在 Windows 上写的是反斜杠分隔符，Linux/macOS 的 unzip 会把整个路径当成文件名
#   （解压出来是一堆 "dsh-unrestricted-printing-1.0.5\gateway\lib\models.js" 这种怪名字）。
#   这里用 .NET 逐条写条目，统一用 '/' —— 跨平台解压都正常。
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zipStream = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$arch = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $stageFull = (Resolve-Path -LiteralPath $stage).Path.TrimEnd('\', '/')
    foreach ($f in (Get-ChildItem -LiteralPath $stage -Recurse -File -Force)) {
        $rel = "dsh-unrestricted-printing-$ver/" + $f.FullName.Substring($stageFull.Length).TrimStart('\', '/').Replace('\', '/')
        $entry = $arch.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
        $es = $entry.Open()
        $fs = [System.IO.File]::OpenRead($f.FullName)
        try { $fs.CopyTo($es) } finally { $fs.Dispose(); $es.Dispose() }
    }
} finally { $arch.Dispose(); $zipStream.Dispose() }
Write-Host "· zip 已生成" -ForegroundColor Green

# 5) npm pack（npm 安装形态）
#    注意：npm 会把 notice 写到 stderr；而本脚本 $ErrorActionPreference='Stop' 会把原生命令的 stderr
#    当成错误抛出（实测把整包流程打断在最后一步）→ 这里临时放宽，只认"有没有生成 tgz"。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { $null = (npm pack 2>&1 | Out-String) } catch { Write-Host "  npm pack 异常（忽略）：$($_.Exception.Message)" -ForegroundColor Yellow }
$ErrorActionPreference = $prevEap
$tgz = Join-Path $root "dsh-unrestricted-printing-$ver.tgz"
if (Test-Path -LiteralPath $tgz) {
    Copy-Item -LiteralPath $tgz -Destination $dist -Force
    Write-Host "· tgz 已生成（npm pack）" -ForegroundColor Green
} else {
    Write-Host "· 警告：没找到 npm pack 产物（npm 不可用时正常，zip 仍可用）" -ForegroundColor Yellow
}

if (-not $KeepStage) { Remove-Item -LiteralPath $stage -Recurse -Force }

Write-Host ""
Write-Host "=== dist 产物 ===" -ForegroundColor Cyan
Get-ChildItem -LiteralPath $dist -File | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } } | Format-Table -AutoSize
Write-Host "下一步（GitHub 发布）：" -ForegroundColor DarkGray
Write-Host "  git add -A; git commit -m 'release: v$ver'; git tag v$ver; git push origin main --tags" -ForegroundColor DarkGray
Write-Host "  → .github/workflows/release.yml 会自动构建并把这些产物挂到 Release" -ForegroundColor DarkGray
