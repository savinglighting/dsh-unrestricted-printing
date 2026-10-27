# Executable regression test for the region-mask pipeline inside sd-inject.ps1.
#
# Why this file exists: the smoke suite used to check New-RegionMask only with
# source-text regexes, so a real runtime defect shipped unnoticed --
# `$rects += @{...}` started from $null, which yields a Hashtable instead of an
# array, and the second rectangle of the ring shape threw
# "Item has already been added. Key in dictionary: 'Y'".
# That silently killed the whole "四周（背景）" / background-replacement path
# (single-rectangle shapes only worked by accident).
#
# What it does: parses sd-inject.ps1, extracts the REAL functions through the
# PowerShell AST (no copy/paste drift), runs every supported mask spec and
# measures the white-pixel ratio of the produced PNG.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File test-region-mask.ps1
param(
    [string]$Script = (Join-Path (Split-Path $PSScriptRoot -Parent) 'sd-inject.ps1'),
    [int]$W = 512,
    [int]$H = 768
)
$ErrorActionPreference = 'Stop'

# Chinese specs are built from code points so this file stays pure ASCII
# (a UTF-8 file without BOM is read as GBK by Windows PowerShell 5.1).
function U { param([int[]]$cp) -join ($cp | ForEach-Object { [char]$_ }) }

if (-not (Test-Path -LiteralPath $Script)) { Write-Output "SCRIPT-MISSING $Script"; exit 1 }

$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
    Write-Output "PARSE-FAIL $($parseErrors.Count)"
    $parseErrors | Select-Object -First 5 | ForEach-Object { Write-Output ("  line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message) }
    exit 1
}

foreach ($name in @('Get-ImageSizePx', 'Get-RefOutputSize', 'New-RegionMask')) {
    $fn = $ast.FindAll({ param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name
        }, $true)
    if (-not $fn) { Write-Output "MISSING-FUNCTION $name"; exit 1 }
    Invoke-Expression $fn[0].Extent.Text
}
Write-Output "EXTRACTED Get-ImageSizePx / Get-RefOutputSize / New-RegionMask"

Add-Type -AssemblyName System.Drawing
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("region-mask-test-" + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $scratch -Force

function Measure-WhitePct([string]$Path) {
    $bmp = [System.Drawing.Bitmap]::FromFile($Path)
    $white = 0; $total = 0
    for ($y = 0; $y -lt $bmp.Height; $y += 4) {
        for ($x = 0; $x -lt $bmp.Width; $x += 4) {
            $total++
            if ($bmp.GetPixel($x, $y).R -gt 127) { $white++ }
        }
    }
    $w = $bmp.Width; $h = $bmp.Height
    $bmp.Dispose()
    return @{ Pct = [math]::Round(100.0 * $white / $total, 1); W = $w; H = $h }
}

$INV = U 0x53CD, 0x9009          # 反选
$LOWER = U 0x4E0B, 0x534A, 0xFF08, 0x8863, 0x670D, 0xFF09     # 下半（衣服）
$UPPER = U 0x4E0A, 0x534A, 0xFF08, 0x8138, 0xFF09             # 上半（脸）
$CENTER = U 0x4E2D, 0x95F4, 0xFF08, 0x4E3B, 0x4F53, 0xFF09    # 中间（主体）
$RING = U 0x56DB, 0x5468, 0xFF08, 0x80CC, 0x666F, 0xFF09      # 四周（背景）

# key -> spec, expected white percentage range, must a mask be produced
$cases = @(
    @{ K = 'box-norm';   Spec = 'box:0.2,0.45,0.6,0.5'; Lo = 26; Hi = 34; Expect = $true }
    @{ K = 'box-px';     Spec = 'boxpx:100,200,400,300'; Lo = 26; Hi = 35; Expect = $true }
    @{ K = 'box-invert'; Spec = ('box:0.2,0.45,0.6,0.5' + $INV); Lo = 66; Hi = 74; Expect = $true }
    @{ K = 'lower';      Spec = $LOWER;  Lo = 26; Hi = 34; Expect = $true }
    @{ K = 'upper';      Spec = $UPPER;  Lo = 12; Hi = 21; Expect = $true }
    @{ K = 'center';     Spec = $CENTER; Lo = 32; Hi = 42; Expect = $true }
    @{ K = 'ring-bg';    Spec = $RING;   Lo = 45; Hi = 58; Expect = $true }
    @{ K = 'ring-inv';   Spec = ($RING + $INV); Lo = 42; Hi = 55; Expect = $true }
    @{ K = 'garbage';    Spec = 'garbage-input'; Lo = -1; Hi = -1; Expect = $false }
)

$failed = 0
foreach ($c in $cases) {
    $out = Join-Path $scratch ("m_" + $c.K + ".png")
    $got = ''
    try {
        $got = New-RegionMask -Spec $c.Spec -W $W -H $H -OutPath $out
    } catch {
        Write-Output ("FAIL {0,-11} THREW: {1}" -f $c.K, $_.Exception.Message)
        $failed++
        continue
    }
    if (-not $c.Expect) {
        if ($got) { Write-Output ("FAIL {0,-11} expected no mask, got {1}" -f $c.K, $got); $failed++ }
        else { Write-Output ("ok   {0,-11} empty as expected" -f $c.K) }
        continue
    }
    if (-not $got -or -not (Test-Path -LiteralPath $got)) {
        Write-Output ("FAIL {0,-11} no mask produced" -f $c.K)
        $failed++
        continue
    }
    $m = Measure-WhitePct $got
    if ($m.W -ne $W -or $m.H -ne $H) {
        Write-Output ("FAIL {0,-11} mask size {1}x{2}, expected {3}x{4}" -f $c.K, $m.W, $m.H, $W, $H)
        $failed++
        continue
    }
    if ($m.Pct -lt $c.Lo -or $m.Pct -gt $c.Hi) {
        Write-Output ("FAIL {0,-11} white {1}% outside [{2},{3}]" -f $c.K, $m.Pct, $c.Lo, $c.Hi)
        $failed++
        continue
    }
    Write-Output ("ok   {0,-11} white {1,5}%  (expected {2}-{3}%)" -f $c.K, $m.Pct, $c.Lo, $c.Hi)
}

# --- Get-RefOutputSize: multiples of 8, long edge capped at 1536, aspect kept ---
$sizes = @(@{ W = 1024; H = 1024 }, @{ W = 1200; H = 2000 }, @{ W = 2496; H = 3648 }, @{ W = 100; H = 100 })
foreach ($s in $sizes) {
    $img = New-Object System.Drawing.Bitmap($s.W, $s.H)
    $path = Join-Path $scratch ("src_" + $s.W + "x" + $s.H + ".png")
    $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $img.Dispose()
    $r = Get-RefOutputSize -Path $path
    $issues = @()
    if ($r.W % 8 -ne 0 -or $r.H % 8 -ne 0) { $issues += 'not multiple of 8' }
    if ([Math]::Max($r.W, $r.H) -gt 1536) { $issues += 'long edge over 1536' }
    if ($r.SrcW -ne $s.W -or $r.SrcH -ne $s.H) { $issues += 'source size not reported' }
    $srcAr = $s.W / [double]$s.H
    $outAr = $r.W / [double]$r.H
    if ([Math]::Abs($srcAr - $outAr) -gt 0.02) { $issues += ("aspect drift {0:N3} vs {1:N3}" -f $outAr, $srcAr) }
    if ($issues.Count -gt 0) {
        Write-Output ("FAIL size {0}x{1} -> {2}x{3}: {4}" -f $s.W, $s.H, $r.W, $r.H, ($issues -join '; '))
        $failed++
    } else {
        Write-Output ("ok   size {0}x{1} -> {2}x{3}" -f $s.W, $s.H, $r.W, $r.H)
    }
}

Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue

if ($failed -gt 0) {
    Write-Output "REGION-MASK TEST FAILED ($failed case(s))"
    exit 1
}
Write-Output "REGION-MASK TEST OK"
exit 0
