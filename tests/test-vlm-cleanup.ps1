# Executable test for the two 0.9.17 behaviours inside sd-inject.ps1:
#   1) VLM cold start switch  - start Ollama unless -NoVlmStart (and say so honestly when it cannot)
#   2) work-file cleanup      - after the C-tier run the product dir keeps the product only
#      (-KeepWorkFiles keeps the intermediates and prints where they are)
#
# Functions are pulled out of sd-inject.ps1 through the PowerShell AST, so the test exercises the
# real code instead of a copy. Pure ASCII: Chinese expectations are built from code points
# (a UTF-8 file without BOM is read as GBK by Windows PowerShell 5.1).
param([string]$Script = (Join-Path (Split-Path $PSScriptRoot -Parent) 'sd-inject.ps1'))
$ErrorActionPreference = 'Stop'
function U { param([int[]]$cp) -join ($cp | ForEach-Object { [char]$_ }) }

$tokens = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errs)
if ($errs.Count -gt 0) { Write-Output "PARSE-FAIL $($errs.Count)"; exit 1 }

foreach ($name in @('Find-Ollama', 'Start-OllamaService', 'Add-RunWorkFile', 'Remove-RunWorkFiles', 'Test-VlmApi')) {
    $fn = $ast.FindAll({ param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name
        }, $true)
    if (-not $fn) { Write-Output "MISSING-FUNCTION $name"; exit 1 }
    Invoke-Expression $fn[0].Extent.Text
}
Write-Output 'EXTRACTED Find-Ollama / Start-OllamaService / Add-RunWorkFile / Remove-RunWorkFiles / Test-VlmApi'

# script-scope knobs the extracted functions read
$QwenBase = 'http://127.0.0.1:59999/v1'    # nothing listens here -> Test-VlmApi false, instantly
$QwenApiKey = 'ollama'
$VlmStartTimeout = 5
$NoVlmStart = $false
$KeepWorkFiles = $false
$OutDir = ''
$script:RunWorkFiles = New-Object System.Collections.Generic.List[string]
$script:OllamaStartTried = $false

$fail = 0
function Check($name, $cond, $detail = '') {
    if ($cond) { Write-Output "ok   $name" }
    else { Write-Output ("FAIL {0} {1}" -f $name, $detail); $script:fail++ }
}

# ---------- 1) -NoVlmStart must not try to launch anything ----------
$noStartMsg = U 0x4E0D, 0x81EA, 0x52A8, 0x51B7, 0x542F, 0x52A8          # 不自动冷启动
$serveWord = U 0x670D, 0x52A1                                              # 服务
$NoVlmStart = $true
$out = (& { Start-OllamaService -TimeoutSec 3 } 6>&1 | Out-String)
$NoVlmStart = $false
Check 'no-start-switch honoured' ($out -match $noStartMsg) "output: $out"
Check 'no-start-switch did not spawn serve' (-not ($out -match 'serve')) "output: $out"

# ---------- 2) cleanup removes intermediates, keeps the product ----------
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("vlm-cleanup-test-" + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $work -Force
$product = Join-Path $work '1girl_solo_anime_011.png'
$premask = Join-Path $work 'premask-abcdef-01.png'
$premaskOv = Join-Path $work 'premask-abcdef-01_overlay.png'
$qaOv = Join-Path $work 'qa-1girl_solo_anime_011.png'
foreach ($p in @($product, $premask, $premaskOv, $qaOv)) { Set-Content -LiteralPath $p -Value 'x' -Encoding ASCII }

$script:RunWorkFiles = New-Object System.Collections.Generic.List[string]
$null = Add-RunWorkFile $premask
$null = Add-RunWorkFile $premaskOv
$null = Add-RunWorkFile $qaOv
Remove-RunWorkFiles -KeepPaths @($product)
Check 'product kept' (Test-Path -LiteralPath $product)
Check 'premask removed' (-not (Test-Path -LiteralPath $premask))
Check 'premask overlay removed' (-not (Test-Path -LiteralPath $premaskOv))
Check 'qa overlay removed' (-not (Test-Path -LiteralPath $qaOv))

# ---------- 3) -KeepWorkFiles keeps them and reports the list ----------
foreach ($p in @($premask, $premaskOv, $qaOv)) { Set-Content -LiteralPath $p -Value 'x' -Encoding ASCII }
$script:RunWorkFiles = New-Object System.Collections.Generic.List[string]
$null = Add-RunWorkFile $premask
$null = Add-RunWorkFile $premaskOv
$null = Add-RunWorkFile $qaOv
$KeepWorkFiles = $true
$out2 = (& { Remove-RunWorkFiles -KeepPaths @($product) } 6>&1 | Out-String)
$KeepWorkFiles = $false
Check 'keep flag keeps premask' (Test-Path -LiteralPath $premask)
Check 'keep flag keeps qa overlay' (Test-Path -LiteralPath $qaOv)
Check 'keep flag lists files' ($out2 -match 'premask') "output: $out2"

# ---------- 4) sanity: Test-VlmApi is false against a dead endpoint ----------
Check 'dead endpoint -> not ready' (-not (Test-VlmApi))

# ---------- 5) cold start spawn + wait + graceful degrade ----------
# Stub Find-Ollama with a harmless executable: Start-OllamaService must try to spawn `serve`,
# poll until the timeout, then give up without throwing (never block the run).
$startMsg = U 0x6B63, 0x5728, 0x51B7, 0x542F, 0x52A8          # 正在冷启动
$giveUpMsg = U 0x6CA1, 0x8D77, 0x6765                          # 没起来
$timeoutExe = Join-Path $env:SystemRoot 'System32\timeout.exe'
if (Test-Path -LiteralPath $timeoutExe) {
    function Find-Ollama { return $timeoutExe }
    $script:OllamaStartTried = $false
    $out3 = (& { Start-OllamaService -TimeoutSec 3 } 6>&1 | Out-String)
    Check 'cold start tried to spawn' ($out3 -match $startMsg) "output: $out3"
    Check 'cold start degrades after timeout' ($out3 -match $giveUpMsg) "output: $out3"
    $threw = $false
    $script:OllamaStartTried = $false
    try { $null = Start-OllamaService -TimeoutSec 2 } catch { $threw = $true }
    Check 'cold start never throws' (-not $threw)
} else {
    Write-Output 'skip cold-start spawn check (no timeout.exe)'
}

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
if ($fail -gt 0) { Write-Output "VLM-CLEANUP TEST FAILED ($fail)"; exit 1 }
Write-Output 'VLM-CLEANUP TEST OK'
exit 0
