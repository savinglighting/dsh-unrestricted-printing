# Executable test for sd-mask-qa.py (the mask hit-rate report).
#
# Builds a synthetic triple (reference / mask / output) where the expected numbers are
# known analytically, then asserts the tool reports them. Keeping this executable matters:
# the tool decides "did the mask work", and a silently wrong verdict is worse than no verdict.
#
# Layout (256x192):
#   reference : flat gray field 100 + one dark block (30) at 40,40 120x100   <- "the garment"
#   mask      : white exactly over that dark block                          <- 24.41% of frame
#   output    : inside mask -> bright 210 (changed);  plus a 20x20 patch at 200,140 (outside mask, changed)
# Expected: mask 24.41%, hit 24.41%, ineffective 0, leak 0.81%, kept 74.77%
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File test-mask-qa.ps1 [-Python <python.exe>]
param(
    [string]$Python = "",
    [string]$QaScript = (Join-Path (Split-Path $PSScriptRoot -Parent) 'sd-mask-qa.py')
)
$ErrorActionPreference = 'Stop'

function Find-CvPython {
    param([string]$Explicit)
    if ($Explicit -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }
    $cands = New-Object System.Collections.Generic.List[string]
    foreach ($root in @('D:\SD.4.8', 'D:\SD', 'C:\SD', 'E:\SD')) {
        if (Test-Path -LiteralPath $root) { $cands.Add((Join-Path $root 'python\python.exe')) }
    }
    try {
        Get-ChildItem 'D:\' -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'SD*' } |
            ForEach-Object { $cands.Add((Join-Path $_.FullName 'python\python.exe')) }
    } catch { }
    foreach ($c in $cands) {
        if (-not (Test-Path -LiteralPath $c)) { continue }
        try {
            $null = & $c -c "import cv2, numpy" 2>$null
            if ($LASTEXITCODE -eq 0) { return $c }
        } catch { }
    }
    return ''
}

if (-not (Test-Path -LiteralPath $QaScript)) { Write-Output "QA-SCRIPT-MISSING $QaScript"; exit 1 }
$py = Find-CvPython -Explicit $Python
if (-not $py) { Write-Output 'MASK-QA TEST SKIP (no python with cv2/numpy found)'; exit 0 }
Write-Output "python: $py"

Add-Type -AssemblyName System.Drawing
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("mask-qa-test-" + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $scratch -Force
$W = 256; $H = 192
$bpr = 40; $bpc = 40; $bpw = 120; $bph = 100      # dark block = "garment"
$lpx = 200; $lpy = 140; $lpw = 20; $lph = 20      # unrelated change outside the mask

function New-Canvas([int]$r, [int]$g, [int]$b) {
    $bmp = New-Object System.Drawing.Bitmap($W, $H)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.Clear([System.Drawing.Color]::FromArgb($r, $g, $b))
    $gfx.Dispose()
    return $bmp
}
function Fill-Rect($bmp, [int]$x, [int]$y, [int]$w, [int]$h, [int]$r, [int]$g, [int]$b) {
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($r, $g, $b))
    $gfx.FillRectangle($brush, $x, $y, $w, $h)
    $brush.Dispose(); $gfx.Dispose()
}

$ref = New-Canvas 100 100 100
Fill-Rect $ref $bpr $bpc $bpw $bph 30 30 30
$mask = New-Canvas 0 0 0
Fill-Rect $mask $bpr $bpc $bpw $bph 255 255 255
$out = New-Canvas 100 100 100
Fill-Rect $out $bpr $bpc $bpw $bph 210 210 210       # inside mask -> changed
Fill-Rect $out $lpx $lpy $lpw $lph 210 210 210       # outside mask -> leak

$refP = Join-Path $scratch 'ref.png'; $maskP = Join-Path $scratch 'mask.png'; $outP = Join-Path $scratch 'out.png'
$ref.Save($refP, [System.Drawing.Imaging.ImageFormat]::Png); $ref.Dispose()
$mask.Save($maskP, [System.Drawing.Imaging.ImageFormat]::Png); $mask.Dispose()
$out.Save($outP, [System.Drawing.Imaging.ImageFormat]::Png); $out.Dispose()

$env:PYTHONIOENCODING = 'utf-8'; $env:PYTHONUTF8 = '1'
$raw = & $py $QaScript '--ref' $refP '--mask' $maskP '--out' $outP '--qa-dir' $scratch '--json' 2>$null
$line = @($raw | Where-Object { "$_".Trim().StartsWith('{') }) | Select-Object -Last 1
if (-not $line) { Write-Output "FAIL no JSON from sd-mask-qa.py (raw: $raw)"; exit 1 }
$j = "$line" | ConvertFrom-Json

$fail = 0
function Check($name, $actual, $expect, $tol) {
    $d = [Math]::Abs([double]$actual - [double]$expect)
    if ($d -gt $tol) {
        Write-Output ("FAIL {0}: got {1}, expected {2} +-{3}" -f $name, $actual, $expect, $tol)
        $script:fail++
    } else {
        Write-Output ("ok   {0} = {1}" -f $name, $actual)
    }
}
if (-not $j.ok) { Write-Output "FAIL ok flag false: $($j.notes)"; exit 1 }
Check 'mask'         $j.mask         0.2441 0.01
Check 'hit'          $j.hit          0.2441 0.01
Check 'ineffective'  $j.ineffective  0.0    0.004
Check 'leak'         $j.leak         0.0081 0.004
Check 'kept'         $j.kept         0.7477 0.01
Check 'suspect'      $j.suspect      0.0    0.02
if (-not ($j.overlay -and (Test-Path -LiteralPath $j.overlay))) {
    Write-Output "FAIL overlay not written: $($j.overlay)"; $fail++
} else {
    Write-Output "ok   overlay -> $($j.overlay)"
}
Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
if ($fail -gt 0) { Write-Output "MASK-QA TEST FAILED ($fail)"; exit 1 }
Write-Output "MASK-QA TEST OK"
exit 0
