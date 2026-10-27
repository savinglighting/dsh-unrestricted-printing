# Executable test: both C-tier prompt boxes must end with a comma (v0.9.24).
#
# Why: the boxes are rewritten whenever the style changes (Add-StyleWords / Remove-StyleWords)
# and those helpers never append a trailing comma -- so the comma the user saw at open time
# silently disappeared after switching 画风. The form must always submit "…,".
# Pure ASCII.
param([string]$Script = (Join-Path (Split-Path $PSScriptRoot -Parent) 'sd-inject.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errs)
if ($errs.Count -gt 0) { Write-Output "PARSE-FAIL $($errs.Count)"; exit 1 }
foreach ($name in @('Add-StyleWords', 'Remove-StyleWords', 'Add-TrailingComma')) {
    $fn = $ast.FindAll({ param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name
        }, $true)
    if (-not $fn) { Write-Output "MISSING-FUNCTION $name"; exit 1 }
    Invoke-Expression $fn[0].Extent.Text
}
Write-Output 'EXTRACTED Add-StyleWords / Remove-StyleWords / Add-TrailingComma'

$fail = 0
function Check($name, $cond, $detail = '') {
    if ($cond) { Write-Output "ok   $name" }
    else { Write-Output ("FAIL {0} {1}" -f $name, $detail); $script:fail++ }
}
function EndsWithComma([string]$s) { return ($s -match ',\s*$') }   # 框里就是 ", "（逗号+空格）

# 1) the helper itself
Check 'plain text gets a comma' (EndsWithComma (Add-TrailingComma 'a, b')) ("got: '" + (Add-TrailingComma 'a, b') + "'")
Check 'existing comma is untouched' ((Add-TrailingComma 'a, b, ') -eq 'a, b, ') ("got: '" + (Add-TrailingComma 'a, b, ') + "'")
Check 'comma without space is untouched' ((Add-TrailingComma 'a, b,') -eq 'a, b,')
Check 'empty stays empty' ((Add-TrailingComma '') -eq '')
Check 'whitespace stays whitespace-like' ((Add-TrailingComma '   ').Trim() -eq '')

# 2) the exact pipeline the form uses on every rewrite (style switch in / out)
$base = '1girl, solo, upper body, simple background'
$withStyle = Add-TrailingComma (Add-StyleWords -Text $base -Words 'anime style, cel shading')
Check 'after style inject the box ends with a comma' (EndsWithComma $withStyle) ("got: '$withStyle'")
$removed = Add-TrailingComma (Remove-StyleWords -Text $withStyle -Words 'anime style, cel shading')
Check 'after style remove the box still ends with a comma' (EndsWithComma $removed) ("got: '$removed'")
Check 'style remove leaves the original words' ($removed -match '1girl' -and $removed -match 'simple background') ("got: '$removed'")

# 3) negative-prompt pipeline as well (same code path, different box)
$neg = Add-TrailingComma (Add-StyleWords -Text 'lowres, bad anatomy' -Words '(3d:1.2), photo')
Check 'negative box ends with a comma too' (EndsWithComma $neg) ("got: '$neg'")

# 4) the submitted value (form gathers with .TrimEnd() after Add-TrailingComma)
$submitted = (Add-TrailingComma $base).TrimEnd()
Check 'submitted value ends with a comma (no trailing space)' ((EndsWithComma $submitted) -and (-not $submitted.EndsWith(' '))) ("got: '$submitted'")

if ($fail -gt 0) { Write-Output "TRAILING-COMMA TEST FAILED ($fail)"; exit 1 }
Write-Output 'TRAILING-COMMA TEST OK'
exit 0
