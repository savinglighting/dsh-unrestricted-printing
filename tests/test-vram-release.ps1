# Executable test for "release VRAM before each run" (v0.9.23).
#
# Why: this 8G card is shared by three consumers -- SD(A1111) ~2.5-5G, the mask helper
# (YOLO-World + SAM) ~2-3G and the 8B vision model ~5.3G. Without releasing, the mask helper
# dies with CUDA OOM and the review model is pushed to CPU (40-180s instead of ~12s).
# Measured on this machine before the fix: 0.46 GB free with both resident.
#
# The test extracts the real functions and measures nvidia-smi free VRAM:
#   1) -NoVramRelease must NOT touch either service (delta ~ 0)
#   2) with the release path (threshold raised so it always triggers) free VRAM must grow,
#      or at least no service must still hold VRAM.
# Pure ASCII.
param([string]$Script = (Join-Path (Split-Path $PSScriptRoot -Parent) 'sd-inject.ps1'))
$ErrorActionPreference = 'Continue'
$tokens = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errs)
if ($errs.Count -gt 0) { Write-Output "PARSE-FAIL $($errs.Count)"; exit 1 }
foreach ($name in @('Get-FreeVramGb', 'Release-SdVram', 'Release-OllamaVram', 'Ensure-Vram')) {
    $fn = $ast.FindAll({ param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name
        }, $true)
    if (-not $fn) { Write-Output "MISSING-FUNCTION $name"; exit 1 }
    Invoke-Expression $fn[0].Extent.Text
}
Write-Output 'EXTRACTED Get-FreeVramGb / Release-SdVram / Release-OllamaVram / Ensure-Vram'

$SdPort = 7860
$QwenBase = 'http://127.0.0.1:11434/v1'
$QwenApiKey = 'ollama'
$NoVramRelease = $false
$VramMinFreeGb = 6.5
$rel = [string][char]0x91CA + [char]0x653E
$enough = [string][char]0x591F + [char]0x7528

$fail = 0
function Check($name, $cond, $detail = '') {
    if ($cond) { Write-Output "ok   $name" }
    else { Write-Output ("FAIL {0} {1}" -f $name, $detail); $script:fail++ }
}

$before = Get-FreeVramGb
Write-Output ("free VRAM at start: {0} GB" -f $before)
if ($before -lt 0) { Write-Output 'MASK-QA TEST SKIP (no nvidia-smi)'; exit 0 }
# 阈值必须**高于**当前剩余，才能保证走到"释放"分支（否则上一轮已经释放干净时会打印"够用，不释放"）
$VramMinFreeGb = [Math]::Max(6.5, ($before + 1.0))

# 1) switch off -> nothing is released
$NoVramRelease = $true
$out1 = (& { Ensure-Vram -For 'any' } 6>&1 | Out-String)
$NoVramRelease = $false
$afterSkip = Get-FreeVramGb
Check 'NoVramRelease frees nothing' ([Math]::Abs($afterSkip - $before) -le 0.3 -or $before -ge $VramMinFreeGb) "before=$before after=$afterSkip"
Check 'NoVramRelease prints nothing about releasing' (-not ($out1 -match $rel)) "out=$out1"

# 2) release path -> VRAM must grow (or the services were already empty)
$out2 = (& { Ensure-Vram -For 'any' -Note 'selftest' } 6>&1 | Out-String)
$after = Get-FreeVramGb
$loaded = -1
try { $ps = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/ps' -TimeoutSec 6; $loaded = @($ps.models).Count } catch { }
Write-Output ("free VRAM after release: {0} GB (delta {1:0.00} GB), ollama loaded={2}" -f $after, ($after - $before), $loaded)
Check 'release grows free VRAM (or nothing was resident)' (($after -gt $before + 0.5) -or ($loaded -eq 0)) "before=$before after=$after loaded=$loaded"
Check 'release path reports a decision' (($out2 -match $rel) -or ($out2 -match $enough)) "out=$out2"

if ($fail -gt 0) { Write-Output "VRAM-RELEASE TEST FAILED ($fail)"; exit 1 }
Write-Output 'VRAM-RELEASE TEST OK'
exit 0
