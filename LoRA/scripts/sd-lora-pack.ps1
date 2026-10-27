# sd-lora-pack.ps1 —— 打包「一键炼制 LoRA」标准文件
#
# 把 LoRA\ 下的标准文件（说明 / 参数标准 / 数据集模板 / 验收清单 / 打包脚本）
# 连同**最新的成品登记表**打成一份 zip，放进 LoRA\packs\。
# 这样交付出去的是「标准 + 实际炼过什么」的完整快照，而不是一堆散文件。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File "LoRA\scripts\sd-lora-pack.ps1"
#   ... -NoRegistry       # 不带登记表（只交付纯标准文件）
#   ... -OutDir "D:\x"    # 指定输出目录
#
# 退出码：0 成功；1 打包失败（找不到源目录 / Compress-Archive 报错）

[CmdletBinding()]
param(
    [string]$OutDir,
    [switch]$NoRegistry,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { if (-not $Quiet) { Write-Host $msg } }

try {
    $scriptsDir = $PSScriptRoot
    $loraRoot = Split-Path -Parent $scriptsDir
    $pkgRoot = Split-Path -Parent $loraRoot

    if (-not (Test-Path (Join-Path $loraRoot 'README.md'))) {
        throw "LoRA 标准目录不完整：缺少 $loraRoot\README.md"
    }

    $version = 'unknown'
    $pkgFile = Join-Path $pkgRoot 'package.json'
    if (Test-Path $pkgFile) {
        try { $version = (Get-Content $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { $version = 'unknown' }
    }

    if (-not $OutDir) { $OutDir = Join-Path $loraRoot 'packs' }
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $zipName = "dsh-unrestricted-printing-lora-v$version-$stamp.zip"
    $zipPath = Join-Path $OutDir $zipName
    $staging = Join-Path ([System.IO.Path]::GetTempPath()) "lora-pack-$stamp-$PID"

    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    Write-Step "打包源: $loraRoot"
    Write-Step "临时目录: $staging"

    # ① 标准文件（脚本本身就包含在内，保证拿到 zip 的人能自己再打包）
    foreach ($item in @('README.md', 'configs', 'templates', 'acceptance', 'scripts')) {
        $src = Join-Path $loraRoot $item
        if (-not (Test-Path $src)) { Write-Step "  · 跳过缺失项: $item"; continue }
        Copy-Item -LiteralPath $src -Destination $staging -Recurse -Force
        Write-Step "  + $item"
    }

    # ② 成品登记表（运行时产物，可能还没有）
    if (-not $NoRegistry) {
        $candidates = @(
            (Join-Path $pkgRoot '.lora-train\lora-registry.json'),
            (Join-Path $env:LOCALAPPDATA 'dsh-unrestricted-printing\lora-registry.json')
        )
        if ($env:GW_LORA_TRAIN_ROOT) { $candidates = @((Join-Path $env:GW_LORA_TRAIN_ROOT 'lora-registry.json')) + $candidates }
        $reg = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
        if ($reg) {
            Copy-Item -LiteralPath $reg -Destination (Join-Path $staging 'lora-registry.json') -Force
            Write-Step "  + lora-registry.json（$reg）"
        } else {
            Write-Step '  · 尚无登记表（还没炼过任何 LoRA），跳过'
        }
    }

    # ③ 打包清单：让收到的人知道这份 zip 里有什么、什么时候打的
    $files = Get-ChildItem -Path $staging -Recurse -File
    $manifest = [ordered]@{
        package     = 'dsh-unrestricted-printing-lora-standard'
        version     = $version
        packedAt    = (Get-Date).ToString('o')
        host        = $env:COMPUTERNAME
        fileCount   = $files.Count
        totalBytes  = ($files | Measure-Object -Property Length -Sum).Sum
        containsRegistry = ($files.Name -contains 'lora-registry.json')
        files       = @($files | ForEach-Object { [ordered]@{ path = $_.FullName.Substring($staging.Length + 1); bytes = $_.Length } })
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $staging 'PACK-MANIFEST.json') -Encoding UTF8

    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -CompressionLevel Optimal
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue

    $sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
    if (-not $Quiet) {
        Write-Host ''
        Write-Host "打包完成：$zipPath" -ForegroundColor Green
        Write-Host "  文件数: $($files.Count)   体积: $sizeMb MB   版本: v$version" -ForegroundColor Green
        Write-Host '  说明: 解压即得标准文件（参数标准 / 数据集模板 / 验收清单 / 打包脚本 / 可选登记表）'
    }
    exit 0
}
catch {
    Write-Host "打包失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
