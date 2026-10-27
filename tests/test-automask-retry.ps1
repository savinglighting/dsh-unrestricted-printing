# Executable test for the "empty output -> automatic CPU retry" ladder in New-AutoMaskFromImage.
#
# Why: on this machine the CUDA path of the detector kills the python process natively
# (stderr stops at "YOLO-World detn…", stdout has no JSON at all) and the user only saw
# "抠图脚本没有输出". The ladder must (a) retry once with --device cpu, (b) never loop forever,
# (c) report the exit code / stderr tail instead of a bare "no output".
#
# A stub helper stands in for the real one: it records argv per run and prints nothing.
# Pure ASCII (Chinese expectations via code points).
param([string]$Script = (Join-Path (Split-Path $PSScriptRoot -Parent) 'sd-inject.ps1'))
$ErrorActionPreference = 'Stop'
function U { param([int[]]$cp) -join ($cp | ForEach-Object { [char]$_ }) }

$tokens = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errs)
if ($errs.Count -gt 0) { Write-Output "PARSE-FAIL $($errs.Count)"; exit 1 }
foreach ($name in @('Find-SdPython', 'Repair-Utf8Mojibake', 'Get-FreeVramGb', 'Release-SdVram', 'Release-OllamaVram', 'Ensure-Vram', 'New-AutoMaskFromImage')) {
    $fn = $ast.FindAll({ param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name
        }, $true)
    if (-not $fn) { Write-Output "MISSING-FUNCTION $name"; exit 1 }
    Invoke-Expression $fn[0].Extent.Text
}
Write-Output 'EXTRACTED Find-SdPython / Repair-Utf8Mojibake / New-AutoMaskFromImage'

$SdDir = 'D:\SD.4.8'
$SdPort = 7860
$NoAutoMask = $false
$NoVramRelease = $true      # 这个测试不许去动真实的 SD / Ollama 服务
$VramMinFreeGb = 4.0
$QwenBase = 'http://127.0.0.1:11434/v1'
$QwenApiKey = 'ollama'
$script:SdRoot = $null
$script:SdRootProbed = $false
$script:SdPythonCache = $null

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("automask-retry-" + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $work -Force
$stub = Join-Path $work 'stub-mask.py'
$argLog = Join-Path $work 'argv.log'
$refPng = Join-Path $work 'ref.png'
$outPng = Join-Path $work 'out.png'

# stub: log argv, print nothing, exit 0 -> mimics the native CUDA crash (no JSON on stdout)
Set-Content -LiteralPath $stub -Encoding ASCII -Value @"
import sys, os
open(r'$argLog', 'a', encoding='utf-8').write(' '.join(sys.argv[1:]) + '|' + chr(10))
sys.exit(0)
"@
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(64, 64)
$bmp.Save($refPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$fail = 0
function Check($name, $cond, $detail = '') {
    if ($cond) { Write-Output "ok   $name" }
    else { Write-Output ("FAIL {0} {1}" -f $name, $detail); $script:fail++ }
}

$cloth = U 0x8863, 0x670D              # 衣服
# 捕获宿主输出（Write-Host 走信息流 6）：重试提示是打印出来的，不进 note
$script:retryMask = $null
$console = (& {
        $script:retryMask = New-AutoMaskFromImage -ImagePath $refPng -Target $cloth -OutPath $outPng -Dilate 8 -Feather 4 -HelperPath $stub
    } 6>&1 | Out-String)
$mask = $script:retryMask
$runs = @()
if (Test-Path -LiteralPath $argLog) { $runs = @(Get-Content -LiteralPath $argLog -Encoding UTF8 | Where-Object { "$_".Trim() }) }

Check 'returns empty when the helper never prints JSON' (-not $mask) "mask=$mask"
Check 'retried exactly once (2 attempts, no loop)' ($runs.Count -eq 2) "attempts=$($runs.Count): $($runs -join ' ;; ')"
Check 'first attempt is the auto device' ($runs.Count -ge 1 -and $runs[0] -notmatch '--device cpu') "first=$($runs[0])"
Check 'second attempt forces --device cpu' ($runs.Count -ge 2 -and $runs[1] -match '--device\s+cpu') "second=$($runs[1])"
$note = "$($script:AutoMaskNote)"
Check 'note carries the python exit code' ($note -match 'python') "note=$note"
Check 'retry notice is printed to the console' ($console -match (U 0x81EA, 0x52A8, 0x6539, 0x7528, 0x20, 0x43, 0x50, 0x55, 0x20, 0x91CD, 0x8BD5)) "console=$console"
Check 'note is not the old bare sentence' ($note -ne (U 0x62A0, 0x56FE, 0x811A, 0x672C, 0x6CA1, 0x6709, 0x8F93, 0x51FA)) "note=$note"

# -NoAutoMask must short-circuit without spawning anything
$argLog2 = Join-Path $work 'argv2.log'
$NoAutoMask = $true
$mask2 = New-AutoMaskFromImage -ImagePath $refPng -Target $cloth -OutPath $outPng -HelperPath $stub
$NoAutoMask = $false
$NoVramRelease = $true      # 这个测试不许去动真实的 SD / Ollama 服务
$VramMinFreeGb = 4.0
$QwenBase = 'http://127.0.0.1:11434/v1'
$QwenApiKey = 'ollama'
Check 'NoAutoMask skips the helper entirely' (-not $mask2 -and -not (Test-Path -LiteralPath $argLog2))

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
if ($fail -gt 0) { Write-Output "AUTOMASK-RETRY TEST FAILED ($fail)"; exit 1 }
Write-Output 'AUTOMASK-RETRY TEST OK'
exit 0
