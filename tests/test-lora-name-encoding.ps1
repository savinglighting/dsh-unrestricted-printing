/**
 * test-lora-name-encoding.ps1 —— LoRA 名字编码回归测试（中文 Windows 必测）
 *
 * 背景（2026-10-22 真实故障）：
 *   PS 5.1 的 Invoke-RestMethod 在响应头不带 charset 时，会按 Latin-1(28591) 解码
 *   UTF-8 正文 → 中文 LoRA 名变成「å½é£ä±±æ°´_v1.0」，进到表单下拉框里更糟：
 *   被 WPF/WinForms 按系统代码页(936) 再转一次 → 显示成「????????_v1.0」。
 *
 * 本测试不依赖 SD 是否运行：直接对已知字节构造的字符串验证 Repair-Utf8Mojibake。
 *
 * 用法：powershell -NoProfile -ExecutionPolicy Bypass -File test-lora-name-encoding.ps1
 * 退出码：0 通过；1 失败
 */

$ErrorActionPreference = 'Stop'
$fail = 0

function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) {
        Write-Host ("  ✓ {0}" -f $name) -ForegroundColor Green
    } else {
        Write-Host ("  ✗ {0}  {1}" -f $name, $detail) -ForegroundColor Red
        $script:fail++
    }
}

# 从 sd-inject.ps1 里抽真实实现（避免测试与实现漂移）
$injectPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'sd-inject.ps1'
if (-not (Test-Path $injectPath)) { $injectPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'sd-inject.ps1' }

Write-Host "`n=== LoRA 名字编码回归测试 ===" -ForegroundColor Cyan
Write-Host "被测脚本: $injectPath"

if (-not (Test-Path $injectPath)) {
    Write-Host "  ✗ 找不到 sd-inject.ps1" -ForegroundColor Red
    exit 1
}

# 提取 Repair-Utf8Mojibake 函数定义并 dot-source 求值
$src = Get-Content $injectPath -Raw -Encoding UTF8
$m = [regex]::Match($src, 'function\s+Repair-Utf8Mojibake\s*\{[\s\S]*?\n\}')
if (-not $m.Success) {
    Write-Host "  ✗ sd-inject.ps1 里找不到 Repair-Utf8Mojibake 函数" -ForegroundColor Red
    exit 1
}
Invoke-Expression $m.Value
Write-Host "  ✓ 已加载 Repair-Utf8Mojibake" -ForegroundColor Green

Write-Host "`n--- 用例 1：latin-1 乱码必须修回中文 ---"
# 「国风山水」的 UTF-8 字节 = e5 9b bd e9 a3 8e e5 b1 b1 e6 b0 b4
# 被 Latin-1 解码后每个字节变成一个 char（U+00E5 等）
$utf8Bytes = [byte[]](0xE5, 0x9B, 0xBD, 0xE9, 0xA3, 0x8E, 0xE5, 0xB1, 0xB1, 0xE6, 0xB0, 0xB4)
$mojibake = [System.Text.Encoding]::GetEncoding(28591).GetString($utf8Bytes) + '_v1.0'
Write-Host ("  输入: {0}" -f $mojibake)
$fixed = Repair-Utf8Mojibake $mojibake
Write-Host ("  输出: {0}" -f $fixed)
Check '修回「国风山水」' ($fixed -eq '国风山水_v1.0') "期望 国风山水_v1.0，实际 $fixed"
Check '输出含中文' ([bool]($fixed -match '[\u4e00-\u9fff]'))
Check '输出无 latin 高位乱码' (-not ($fixed -match '[\u00c0-\u00ff]{2,}'))

Write-Host "`n--- 用例 2：纯 ASCII 必须原样返回（不能误伤英文 LoRA 名）---"
foreach ($ascii in @('add_detail', 'semirealisticanime', '39_v1.0', 'shorekeeper-smoke_id')) {
    $r = Repair-Utf8Mojibake $ascii
    Check "保持 $ascii" ($r -eq $ascii) "实际 $r"
}

Write-Host "`n--- 用例 3：已经是正确中文的不能再被破坏 ---"
foreach ($cn in @('国风山水_v1.0', '釉彩·麻袋调色盘_v1.0', '赛博朋克场景_v1.0')) {
    $r = Repair-Utf8Mojibake $cn
    Check "保持 $cn" ($r -eq $cn) "实际 $r"
}

Write-Host "`n--- 用例 4：空值/边界不抛异常 ---"
Check '空字符串' ((Repair-Utf8Mojibake '') -eq '')
Check 'null 安全' ($null -eq (Repair-Utf8Mojibake $null) -or '' -eq (Repair-Utf8Mojibake $null))

Write-Host "`n--- 用例 5：问号形态无法修复（必须承认信息已丢）---"
$qm = '????????_v1.0'
$r = Repair-Utf8Mojibake $qm
Write-Host "  输入: $qm"
Write-Host "  输出: $r"
Check '问号形态不产生假中文' (-not ($r -match '[\u4e00-\u9fff]'))

Write-Host "`n--- 用例 6：Get-SdLoras 必须调用 Repair（防止回归）---"
$usesRepair = $src -match 'Repair-Utf8Mojibake\s*\(\[string\]\$_.name\)'
Check 'Get-SdLoras 对 name 做修复' $usesRepair
$usesCkpt = $src -match 'Repair-Utf8Mojibake\s*\(\[string\]\$o\.sd_model_checkpoint\)'
Check 'checkpoint 名也做修复' $usesCkpt

Write-Host "`n=== 结果 ===" -ForegroundColor Cyan
if ($fail -eq 0) {
    Write-Host "全部通过 ✓" -ForegroundColor Green
    exit 0
} else {
    Write-Host "$fail 项失败 ✗" -ForegroundColor Red
    exit 1
}
