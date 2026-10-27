# fix-bom.ps1 —— 给被工具改写过的 PowerShell 脚本补回 UTF-8 BOM
# 背景：PS 5.1 读 .ps1 时若无 BOM，会按 ANSI(GBK) 解码 → 中文全部乱码 → 语法解析直接失败。
# 用法：powershell -NoProfile -File fix-bom.ps1 <文件1> [<文件2> ...]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)
$enc = New-Object System.Text.UTF8Encoding($true)
foreach ($f in $Files) {
    if (-not (Test-Path -LiteralPath $f)) { Write-Host "跳过（不存在）：$f"; continue }
    $full = (Resolve-Path -LiteralPath $f).Path
    $bytes = [System.IO.File]::ReadAllBytes($full)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        Write-Host "已有 BOM：$full"
        continue
    }
    $text = [System.IO.File]::ReadAllText($full, (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::WriteAllText($full, $text, $enc)
    Write-Host "已补 BOM：$full"
}