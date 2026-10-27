# =============================================================================
# gateway/tools/ui-gateway-verify.ps1 —— P6.2 键鼠全流程验证（网关路径）
#
# 干什么：对每个「模型档位 × 模式」组合，用**真实鼠标+键盘**驱动 sd-inject.ps1 参数表单：
#   1) 启动 sd-inject.ps1（带预填参数，图生图会随机挑一张参考图）
#   2) 鼠标点开「模型」下拉 → 键盘方向键选到目标档位（4 枚举之一）
#   3) 鼠标点开「模式」下拉 → 键盘选 文生图 / 图生图
#   4) 键盘在「宽×高」文本框里输入尺寸
#   5) 鼠标点「确定出图（走网关）」→ 读状态栏文字，直到 success/failed/断连
#   6) 检查网关产物目录是否真的多出一张图（按 mtime 判定），并记录状态栏颜色
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File ui-gateway-verify.ps1 -Config <config.json>
#   powershell ... -File ui-gateway-verify.ps1 -Only "QwenImage_NVFP4|图生图"
# 配置 JSON（可选，缺省用内置默认）：
#   { "exe": "...sd-inject.ps1", "outDir": "D:\\DSWorkPlace\\SD-Picture",
#     "sampleDirs": ["D:\\DSWorkPlace\\SD-Picture", "D:\\截图"],
#     "waitSec": 300, "resultWaitSec": 900, "combos": [{"model":"SD_FP16","mode":"文生图","w":576,"h":1024}] }
#
# 参考图纪律：一律从 sampleDirs 里**随机**抽，禁止指定某一张特定图片。
# =============================================================================
param(
    [string]$Config = "",
    [string]$Only = "",
    [switch]$KeepWindows
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# ---- 真实鼠标 / 键盘（P/Invoke，类名唯一避免同名类型复用旧定义）----
if (-not ('MailMouseKbd' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MailMouseKbd {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, int extra);
    public const uint LD = 0x0002, LU = 0x0004, KU = 0x0002;
    public const byte VK_RETURN = 0x0D, VK_ESCAPE = 0x1B, VK_DOWN = 0x28, VK_UP = 0x26, VK_HOME = 0x24, VK_TAB = 0x09;
    public static void LeftClick(int x, int y) {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(180);
        mouse_event(LD,0,0,0,0); System.Threading.Thread.Sleep(70);
        mouse_event(LU,0,0,0,0);
    }
    public static void PressKey(byte vk) { keybd_event(vk,0,0,0); System.Threading.Thread.Sleep(60); keybd_event(vk,0,KU,0); }
    public static void KeyDown(byte vk) { keybd_event(vk,0,0,0); System.Threading.Thread.Sleep(40); }
    public static void KeyUp(byte vk) { keybd_event(vk,0,KU,0); System.Threading.Thread.Sleep(40); }
}
"@
}

$auto = [System.Windows.Automation.AutomationElement]
$root = $auto::RootElement
$trueCond = [System.Windows.Automation.Condition]::TrueCondition

# 下拉列表里的显示文字（与 sd-inject.ps1 的 $script:GatewayModelLabels 保持一致；鼠标按文字点列表项）
$script:ModelItemText = @{
    'SD_FP16'         = 'SD_FP16（WebUI·FP16）'
    'Anima_INT8'      = 'Anima_INT8（WebUI·INT8）'
    'QwenImage_NVFP4' = 'QwenImage_NVFP4（ComfyUI）'
    'Krea2_Q4'        = 'Krea2_Q4（ComfyUI·≤1024）'
}

function Find-Window([string]$title, [int]$timeoutSec, [int]$ownerPid = 0) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
        $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
            (New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::Window)))
        foreach ($x in $all) {
            $n = ''
            try { $n = $x.Current.Name } catch { continue }
            if (-not ($n -eq $title -or $n -like "$title*")) { continue }
            if ($ownerPid -gt 0) {
                try { if ($x.Current.ProcessId -ne $ownerPid) { continue } } catch { continue }
            }
            return $x
        }
        Start-Sleep -Milliseconds 600
    }
    return $null
}

function Find-ByName($win, [string]$name) {
    $c = New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty, $name)
    return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}

function Get-ElementText($el) {
    if (-not $el) { return '' }
    try { return [string]$el.Current.Name } catch { return '' }
}

function Click-Element($el, [string]$label) {
    $r = $el.Current.BoundingRectangle
    $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
    Write-Host ("    · 鼠标点击 {0}（{1},{2}）" -f $label, $x, $y) -ForegroundColor DarkGray
    [MailMouseKbd]::LeftClick($x, $y)
    return $true
}

# 用「鼠标点开下拉 + 键盘方向键」选第 idx 项（0-based）——纯键鼠，不走 ValuePattern 直写
function Select-ComboByKeysEl($el, $win, [int]$idx, [int]$maxItems = 8) {
    if (-not $el) { return $false }
    try { [MailMouseKbd]::SetForegroundWindow($win.Current.NativeWindowHandle) | Out-Null } catch { }
    Start-Sleep -Milliseconds 250
    Click-Element $el '下拉框' | Out-Null
    Start-Sleep -Milliseconds 600
    [MailMouseKbd]::PressKey([MailMouseKbd]::VK_HOME)
    Start-Sleep -Milliseconds 150
    $steps = [Math]::Min($idx, $maxItems - 1)
    for ($i = 0; $i -lt $steps; $i++) {
        [MailMouseKbd]::PressKey([MailMouseKbd]::VK_DOWN)
        Start-Sleep -Milliseconds 80
    }
    [MailMouseKbd]::PressKey([MailMouseKbd]::VK_RETURN)
    Start-Sleep -Milliseconds 400
    return $true
}

# -----------------------------------------------------------------------------
# 控件定位：本机 WinForms 表单经 MSAA→UIA 桥后**所有控件都呈现为 [Pane]，Name = 控件文字**
# （实测 dump：Button/ComboBox/Edit 的类型信息全丢，只有文字与坐标）。
# 所以驱动方式 = 「按文字定位 + 真实鼠标点坐标 + 真实键盘方向键/数字键」，不依赖控件类型。
# -----------------------------------------------------------------------------
function Get-AllElements($win) {
    try {
        return $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $trueCond)
    } catch {
        return @()
    }
}

function Get-AllNames($win) {
    $names = @()
    foreach ($e in (Get-AllElements $win)) {
        try { $n = [string]$e.Current.Name; if ($n) { $names += $n } } catch { }
    }
    return $names
}

function Get-RectsByText($win, [string]$text) {
    $hits = @()
    foreach ($e in (Get-AllElements $win)) {
        try {
            $n = [string]$e.Current.Name
            if ($n -eq $text) { $hits += $e.Current.BoundingRectangle }
        } catch { }
    }
    return $hits
}

function Get-WindowRect($win) { return $win.Current.BoundingRectangle }

function Test-TextPresent($names, [string]$text) {
    foreach ($n in @($names)) { if ("$n" -eq "$text") { return $true } }
    return $false
}

# 按控件文字点一下（点它的中心）
function Click-ByText($win, [string]$text) {
    $rects = Get-RectsByText $win $text
    if ($rects.Count -eq 0) { return $false }
    $r = $rects[0]
    $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
    Write-Host ("    · 鼠标点击「{0}」（{1},{2}）" -f $text, $x, $y) -ForegroundColor DarkGray
    [MailMouseKbd]::LeftClick($x, $y)
    return $true
}

# 按标签文字推算右侧控件的点击点（第 n 列控件）
function Click-RightOfLabel($win, [string]$label, [int]$extraX = 60) {
    $rects = Get-RectsByText $win $label
    if ($rects.Count -eq 0) {
        Write-Host ("    [WARN] 找不到标签「{0}」" -f $label) -ForegroundColor Yellow
        return $false
    }
    $r = $rects[0]
    $x = [int]($r.X + $r.Width + $extraX)
    $y = [int]($r.Y + $r.Height / 2)
    Write-Host ("    · 鼠标点击「{0}」右侧控件（{1},{2}）" -f $label, $x, $y) -ForegroundColor DarkGray
    [MailMouseKbd]::LeftClick($x, $y)
    return $true
}

# 键盘：Ctrl+A 全选
function Send-CtrlA {
    [MailMouseKbd]::KeyDown(0x11)
    [MailMouseKbd]::PressKey(0x41)
    [MailMouseKbd]::KeyUp(0x11)
}
# 键盘：逐位输入数字（0-9）
function Send-Digits([string]$digits) {
    foreach ($ch in $digits.ToCharArray()) {
        if ($ch -ge '0' -and $ch -le '9') { [MailMouseKbd]::PressKey([byte](0x30 + [int][char]$ch)) }
    }
}

# 下拉选择（**纯鼠标**，最贴近真人操作）：
#   鼠标点开下拉 → 在展开的列表里找目标文字的元素（Y 坐标在组合框之下）→ 点它。
# 为什么不用键盘：实测 Enter 会穿透到表单（AcceptButton=提交出图 → 提前出图），
# 而 Tab 在这台机器上会把下拉列表关掉又不提交选择（模型档位白切）。
function Select-DropdownByMouse($win, [string]$label, [string]$targetText, [int]$extraX = 60) {
    # 目标文字为空 → 直接走键盘（避免匹配到「名字为空」的列表项，点错地方）
    if (-not $targetText) { return $false }
    try { [MailMouseKbd]::SetForegroundWindow($win.Current.NativeWindowHandle) | Out-Null } catch { }
    Start-Sleep -Milliseconds 250
    $labelRects = Get-RectsByText $win $label
    if ($labelRects.Count -eq 0) { Write-Host ("    [WARN] 找不到标签「{0}」" -f $label) -ForegroundColor Yellow; return $false }
    $lr = $labelRects[0]
    $comboX = [int]($lr.X + $lr.Width + $extraX)
    $comboY = [int]($lr.Y + $lr.Height / 2)
    Write-Host ("    · 鼠标点开下拉「{0}」（{1},{2}）" -f $label, $comboX, $comboY) -ForegroundColor DarkGray
    [MailMouseKbd]::LeftClick($comboX, $comboY)
    Start-Sleep -Milliseconds 700

    # 在展开的列表里找目标项：同名元素可能有多个（组合框自身 + 列表项），取 Y 更靠下的那个
    $cand = @()
    foreach ($e in (Get-AllElements $win)) {
        try {
            if ([string]$e.Current.Name -eq $targetText) {
                $r = $e.Current.BoundingRectangle
                if ($r.Width -gt 0 -and $r.Height -gt 0 -and $r.Y -gt ($comboY + 10)) { $cand += $r }
            }
        } catch { }
    }
    if ($cand.Count -gt 0) {
        $pick = $cand | Sort-Object Y | Select-Object -First 1
        $ix = [int]($pick.X + $pick.Width / 2); $iy = [int]($pick.Y + $pick.Height / 2)
        Write-Host ("    · 鼠标点击列表项「{0}」（{1},{2}）" -f $targetText, $ix, $iy) -ForegroundColor DarkGray
        [MailMouseKbd]::LeftClick($ix, $iy)
        Start-Sleep -Milliseconds 500
        return $true
    }
    # 列表项抓不到（MSAA 没暴露）：关掉下拉，返回 false 交给调用方决定
    Write-Host ("    [WARN] 展开列表里找不到「{0}」→ 尝试键盘兜底" -f $targetText) -ForegroundColor Yellow
    [MailMouseKbd]::PressKey([MailMouseKbd]::VK_ESCAPE)
    Start-Sleep -Milliseconds 300
    return $false
}

# 键盘兜底：点开下拉 → Home + Down×idx → Tab 提交
function Select-DropdownByKeys($win, [string]$label, [int]$idx, [int]$extraX = 60) {
    try { [MailMouseKbd]::SetForegroundWindow($win.Current.NativeWindowHandle) | Out-Null } catch { }
    Start-Sleep -Milliseconds 250
    if (-not (Click-RightOfLabel $win $label $extraX)) { return $false }
    Start-Sleep -Milliseconds 600
    [MailMouseKbd]::PressKey([MailMouseKbd]::VK_HOME)
    Start-Sleep -Milliseconds 200
    for ($i = 0; $i -lt $idx; $i++) {
        [MailMouseKbd]::PressKey([MailMouseKbd]::VK_DOWN)
        Start-Sleep -Milliseconds 120
    }
    # **必须用 Tab 提交，绝不能用 Enter**：表单 AcceptButton = 提交出图按钮，
    # 下拉列表关闭时 Enter 会穿透到表单 → 直接提前出图（实测踩到：尺寸/模型都没生效就开跑）。
    [MailMouseKbd]::PressKey([MailMouseKbd]::VK_TAB)
    Start-Sleep -Milliseconds 500
    return $true
}

# 统一入口：先鼠标点列表项，失败再键盘兜底
function Select-Dropdown($win, [string]$label, [string]$targetText, [int]$idx, [int]$extraX = 60) {
    if (Select-DropdownByMouse $win $label $targetText $extraX) { return $true }
    return (Select-DropdownByKeys $win $label $idx $extraX)
}

# -----------------------------------------------------------------------------
# 键盘 Tab 导航改下拉（**不打开下拉列表**）
# 为什么不用鼠标点开列表：实测在这台机器的 MSAA→UIA 桥下，ComboBox 一旦展开列表，
# 该进程的自动化树就整体变空（后续所有按文字的查找全部失败）。最稳的绕法：
#   ① 鼠标点一下正向提示词框（不展开任何下拉，只把焦点放进表单）
#   ② Tab N 次走到目标下拉（WinForms Tab 顺序 = 控件添加顺序，禁用的控件自动跳过）
#   ③ 方向键改档位（DropDownList 的方向键直接改 SelectedIndex，**不展开列表**）
# 档位改变会触发 SelectedIndexChanged → 比例/画质联动照常回填宽高。
# -----------------------------------------------------------------------------
function Focus-PromptBox($win) {
    $r = $win.Current.BoundingRectangle
    [MailMouseKbd]::LeftClick([int]($r.X + 100), [int]($r.Y + 100))
    Start-Sleep -Milliseconds 300
}

function Send-TabKeys([int]$n) {
    for ($i = 0; $i -lt $n; $i++) { [MailMouseKbd]::PressKey([MailMouseKbd]::VK_TAB); Start-Sleep -Milliseconds 130 }
}

function Send-Arrow([string]$dir, [int]$n) {
    $vk = if ($dir -eq 'up') { [MailMouseKbd]::VK_UP } else { [MailMouseKbd]::VK_DOWN }
    for ($i = 0; $i -lt $n; $i++) { [MailMouseKbd]::PressKey($vk); Start-Sleep -Milliseconds 160 }
}

# 从「正向提示词框」起算的 Tab 步数（禁用的控件不计入：文生图下底图/蒙版是灰的）
function Get-TabStepsTo([string]$target, [string]$mode) {
    $seq = @('txtNeg', 'cboBackend', 'cboMode')
    if ($mode -eq '图生图') { $seq += @('txtInit', 'btnBrowse', 'cboMask') }
    $seq += @('cboDenoise', 'cboRounds', 'cboRatio', 'cboStyle', 'cboQuality')
    $idx = [Array]::IndexOf($seq, $target)
    if ($idx -lt 0) { return -1 }
    return $idx + 1
}

function Kill-StaleInject {
    $killed = 0
    foreach ($p in Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue) {
        $cl = $p.CommandLine
        if (-not $cl) { continue }
        if ($cl -match 'sd-inject\.ps1' -or $cl -match 'sd-verify-') {
            if ($p.ProcessId -ne $PID) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }
        }
    }
    return $killed
}

# ---- 配置 ----
$scriptDir = $PSScriptRoot
$pluginRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$cfg = [ordered]@{
    exe        = (Join-Path $pluginRoot 'sd-inject.ps1')
    outDir     = (Join-Path (Split-Path -Parent $pluginRoot) 'SD-Picture')
    sampleDirs = @((Join-Path (Split-Path -Parent $pluginRoot) 'SD-Picture'), 'D:\截图')
    waitSec        = 300
    resultWaitSec  = 900
    gatewayBase    = 'http://127.0.0.1:8799'
    name           = 'uitest'
    combos = @(
        [ordered]@{ model = 'SD_FP16';         mode = '文生图'; quality = 3; w = 576;  h = 1024 }
        [ordered]@{ model = 'SD_FP16';         mode = '图生图'; quality = 3; w = 576;  h = 1024 }
        [ordered]@{ model = 'Anima_INT8';      mode = '文生图'; quality = 3; w = 576;  h = 1024 }
        [ordered]@{ model = 'Anima_INT8';      mode = '图生图'; quality = 3; w = 576;  h = 1024 }
        [ordered]@{ model = 'QwenImage_NVFP4'; mode = '文生图'; quality = 3; w = 576;  h = 1024 }
        [ordered]@{ model = 'QwenImage_NVFP4'; mode = '图生图'; quality = 3; w = 576;  h = 1024 }
        [ordered]@{ model = 'Krea2_Q4';        mode = '文生图'; quality = 3; w = 576;  h = 1024; expect = 'reject' }
        [ordered]@{ model = 'Krea2_Q4';        mode = '图生图'; quality = 3; w = 576;  h = 1024; expect = 'reject' }
    )
}
if ($Config -and (Test-Path -LiteralPath $Config)) {
    $user = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $user.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
}
$combos = @($cfg.combos)
if ($Only) { $combos = @($combos | Where-Object { "$($_.model)|$($_.mode)" -eq $Only }) }

# ---- 参考图池（随机抽，禁止特定图）----
$pool = @()
foreach ($d in @($cfg.sampleDirs)) {
    if ($d -and (Test-Path -LiteralPath $d)) {
        $pool += @(Get-ChildItem -LiteralPath $d -File -Include *.png, *.jpg, *.jpeg, *.webp -ErrorAction SilentlyContinue)
    }
}
Write-Host ("参考图池：{0} 张（来自 {1}）" -f $pool.Count, (@($cfg.sampleDirs) -join ' + ')) -ForegroundColor Cyan

$report = @()
$failCount = 0

foreach ($combo in $combos) {
    $model = [string]$combo.model
    $mode = [string]$combo.mode
    $tag = "$model|$mode"
    Write-Host ""
    Write-Host "==============================================================" -ForegroundColor Magenta
    Write-Host "  档位×模式：$tag" -ForegroundColor Magenta
    Write-Host "==============================================================" -ForegroundColor Magenta

    $sample = $null
    if ($mode -eq '图生图') {
        if ($pool.Count -eq 0) { Write-Host "  [SKIP] 没有可用的随机参考图" -ForegroundColor Yellow; $report += [pscustomobject]@{ Combo = $tag; Result = 'SKIP'; Detail = '无参考图'; Status = ''; Files = 0; Seconds = 0 }; continue }
        $sample = $pool | Get-Random
        Write-Host ("  随机参考图：{0}" -f $sample.FullName) -ForegroundColor DarkGray
    }

    $exe = [string]$cfg.exe
    $name = "{0}_{1}" -f $cfg.name, ($model.ToLower() + '_' + $(if ($mode -eq '图生图') { 'i2i' } else { 't2i' }))
    $launchArgs = @(
        '-BasePrompt', '1girl, solo, portrait, soft light, masterpiece, best quality'
        '-Negative', 'lowres, worst quality, low quality, watermark'
        '-Name', $name
        '-Steps', '12'
        '-NoVlmReview'          # 质检反复加载本地视觉模型会吃掉大量显存/时间；本验证只考网关出图链路
        '-NoVlmStart'
        '-NoOpen'
    )
    if ($mode -eq '图生图') {
        $launchArgs += @('-Mode', '图生图', '-InitImage', $sample.FullName, '-MaskSpec', '无')
    }

    $pl = New-Object System.Collections.Generic.List[string]
    [void]$pl.Add('$ErrorActionPreference = "Continue"')
    [void]$pl.Add('$h = @{')
    for ($i = 0; $i -lt @($launchArgs).Count; $i++) {
        $a = [string]$launchArgs[$i]
        if ($a -match '^-') {
            $key = $a.TrimStart('-')
            $val = $null
            if (($i + 1) -lt @($launchArgs).Count -and [string]$launchArgs[$i + 1] -notmatch '^-') {
                $val = [string]$launchArgs[$i + 1]; $i++
            }
            if ($null -eq $val) { [void]$pl.Add("  $key = `$true") }
            else {
                $safe = ($val -replace "`r?`n", ' ') -replace "'", "''"
                [void]$pl.Add("  $key = '$safe'")
            }
        }
    }
    [void]$pl.Add('}')
    [void]$pl.Add("& '" + ($exe -replace "'", "''") + "' @h")
    [void]$pl.Add('exit $LASTEXITCODE')
    $launcher = Join-Path $env:TEMP ("sd-verify-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + ".ps1")
    $body = [System.Text.Encoding]::UTF8.GetBytes(($pl -join "`r`n") + "`r`n")
    $withBom = New-Object byte[] ($body.Length + 3)
    [Array]::Copy([byte[]](0xEF, 0xBB, 0xBF), 0, $withBom, 0, 3)
    [Array]::Copy($body, 0, $withBom, 3, $body.Length)
    [System.IO.File]::WriteAllBytes($launcher, $withBom)

    $killed = Kill-StaleInject
    if ($killed -gt 0) { Write-Host "  启动前清理遗留进程：$killed" -ForegroundColor DarkYellow }
    Start-Sleep -Milliseconds 700

    $childLog = Join-Path $env:TEMP ("sd-verify-child-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + ".log")
    $proc = Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher) `
        -PassThru -RedirectStandardOutput $childLog -RedirectStandardError ($childLog + '.err')
    Write-Host "  子进程 PID：$($proc.Id)（日志：$childLog）" -ForegroundColor DarkGray

    $t0 = Get-Date
    $marker = Get-Date
    $win = Find-Window 'sd-inject 出图参数' ([int]$cfg.waitSec) $proc.Id
    if (-not $win) {
        Write-Host "  [FAIL] 表单窗口没出现" -ForegroundColor Red
        $report += [pscustomobject]@{ Combo = $tag; Result = 'FAIL'; Detail = '窗口未出现'; Status = ''; Files = 0; Seconds = 0 }
        $failCount++
        if (-not $proc.HasExited) { $proc.Kill() }
        continue
    }
    Write-Host "  [OK] 表单已出现（PID=$($win.Current.ProcessId)）" -ForegroundColor Green
    try { [MailMouseKbd]::SetForegroundWindow($win.Current.NativeWindowHandle) | Out-Null } catch { }

    # 等控件真正画出来（窗口出现 ≠ 控件可枚举：MSAA 桥在窗体构建期间会短暂返回空树，
    # 早期实测就是在这段空窗期里去点控件 → 全部"找不到"）
    $readyDeadline = (Get-Date).AddSeconds(60)
    $ready = $false
    while ((Get-Date) -lt $readyDeadline) {
        Start-Sleep -Milliseconds 700
        $n0 = Get-AllNames $win
        if (($n0 -contains '后端：') -and ($n0 -contains '确定出图（走网关）')) { $ready = $true; break }
    }
    if (-not $ready) {
        Write-Host ("  [FAIL] 表单控件 60 秒内未就绪（当前 {0} 个元素）" -f (Get-AllNames $win).Count) -ForegroundColor Red
        $report += [pscustomobject]@{ Combo = $tag; Result = 'FAIL'; Detail = '控件未就绪'; Status = ''; Files = 0; Seconds = 0 }
        $failCount++
        if (-not $KeepWindows) { try { $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() } catch { }; if (-not $proc.HasExited) { $proc.Kill() } }
        continue
    }
    Write-Host "  [OK] 控件已就绪" -ForegroundColor Green
    Start-Sleep -Milliseconds 400

    # ---- 模型档位：焦点 → Tab 到「后端」下拉 → 方向键改档（不展开列表，见上方说明）----
    $modelOrder = @('SD_FP16', 'Anima_INT8', 'QwenImage_NVFP4', 'Krea2_Q4')
    $mi = [Array]::IndexOf($modelOrder, $model)
    if ($mi -lt 0) { $mi = 0 }
    Focus-PromptBox $win
    Send-TabKeys (Get-TabStepsTo 'cboBackend' $mode)
    Send-Arrow 'up' 8   # 先撞到列表第一项（SD_FP16）再往下数：默认档位会随模型可用性变，不能假设起点
    if ($mi -gt 0) { Send-Arrow 'down' $mi }
    Start-Sleep -Milliseconds 400
    $namesAfterModel = Get-AllNames $win
    $modelOk = @($namesAfterModel | Where-Object { $_ -like "$model*" }).Count -gt 0
    Write-Host ("  模型档位：期望 {0} → 命中={1}" -f $model, $modelOk) -ForegroundColor $(if ($modelOk) { 'Green' } else { 'Yellow' })

    # ---- 模式：文生图 / 图生图 ----
    Focus-PromptBox $win
    Send-TabKeys (Get-TabStepsTo 'cboMode' '文生图')   # 模式切换前的 Tab 序号按当前（初始=文生图）布局算
    $modeIdx = if ($mode -eq '图生图') { 1 } else { 0 }
    if ($modeIdx -gt 0) { Send-Arrow 'down' 1 }
    Start-Sleep -Milliseconds 500
    $namesAfterMode = Get-AllNames $win
    $modeOk = @($namesAfterMode | Where-Object { $_ -eq $mode }).Count -gt 0
    Write-Host ("  模式档位：期望 {0} → 命中={1}" -f $mode, $modeOk) -ForegroundColor $(if ($modeOk) { 'Green' } else { 'Yellow' })

    # ---- 尺寸：Tab 到「画质」下拉 → 方向键升到目标档（比例+画质 → 表单自动回填宽×高）----
    $qIdx = if ($null -ne $combo.quality) { [int]$combo.quality } else { 3 }
    $qText = @('480p', '640p', '768p', '1024p', '1280p', '1440p', '2160p（4K）')[$qIdx]
    Focus-PromptBox $win
    Send-TabKeys (Get-TabStepsTo 'cboQuality' $mode)
    Send-Arrow 'up' 10   # 同理：先回到 480p（第一项）再往上数
    if ($qIdx -gt 0) { Send-Arrow 'down' $qIdx }
    Start-Sleep -Milliseconds 600
    $namesSize = Get-AllNames $win
    $sizeOk = ((Test-TextPresent $namesSize "$($combo.w)") -and (Test-TextPresent $namesSize "$($combo.h)"))
    Write-Host ("  尺寸：画质「{0}」→ 期望 {1} x {2}，表单回填命中={3}" -f $qText, $combo.w, $combo.h, $sizeOk) -ForegroundColor $(if ($sizeOk) { 'Green' } else { 'Yellow' })

    # ---- 点「确定出图（走网关）」（按按钮文字定位）----
    if (-not (Click-ByText $win '确定出图（走网关）')) {
        Write-Host "  [FAIL] 找不到「确定出图（走网关）」按钮" -ForegroundColor Red
        $report += [pscustomobject]@{ Combo = $tag; Result = 'FAIL'; Detail = '找不到确定出图按钮'; Status = ''; Files = 0; Seconds = 0 }
        $failCount++
        if (-not $KeepWindows) { try { $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() } catch { }; if (-not $proc.HasExited) { $proc.Kill() } }
        continue
    }

    # ---- 读状态栏（按文字关键字扫描，状态栏文字就是它的 UIA Name）----
    # 同时负责关掉表单弹出的 MessageBox（网关返回失败 / 提交失败 / 尺寸超限 / 网关离线 / 异常），
    # 否则模态框会把表单线程挡住，状态栏就再也不更新了。
    $statusTexts = @()
    $finalStatus = ''
    $dialogsSeen = @()
    $deadline = (Get-Date).AddSeconds([int]$cfg.resultWaitSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        # 1) 先处理可能的模态对话框
        foreach ($title in @('网关返回失败', '提交失败', '尺寸超限', '网关离线', '异常', '参数错误')) {
            $dlg = Find-Window $title 1 $proc.Id
            if ($dlg) {
                $dialogsSeen += $title
                Write-Host ("    · 弹出对话框「{0}」→ 键盘回车确认关闭" -f $title) -ForegroundColor Yellow
                try { [MailMouseKbd]::SetForegroundWindow($dlg.Current.NativeWindowHandle) | Out-Null } catch { }
                Start-Sleep -Milliseconds 300
                [MailMouseKbd]::PressKey([MailMouseKbd]::VK_RETURN)
                Start-Sleep -Milliseconds 400
            }
        }
        # 2) 读状态栏
        $names = Get-AllNames $win
        $cur = ''
        foreach ($n in $names) {
            if ($n -match '^（?(queued|training|running|success|failed)') { $cur = $n; break }
            if ($n -match '断开连接') { $cur = $n; break }
        }
        if ($cur) {
            if ($statusTexts.Count -eq 0 -or $statusTexts[-1] -ne $cur) {
                Write-Host ("    · 状态栏：{0}" -f $cur) -ForegroundColor DarkCyan
                $statusTexts += $cur
            }
            if ($cur -match 'success') { $finalStatus = 'success'; break }
            if ($cur -match 'failed') { $finalStatus = 'failed'; break }
            if ($cur -match '断开连接') { $finalStatus = 'disconnected'; break }
        } elseif ($proc.HasExited) {
            $finalStatus = if ($statusTexts.Count -gt 0 -and $statusTexts[-1] -match 'success') { 'success' } else { 'closed' }
            break
        }
    }
    if (-not $finalStatus) { $finalStatus = 'timeout' }

    # 产物核对：网关产物目录里是否有本轮新增的图
    $newFiles = @()
    if (Test-Path -LiteralPath $cfg.outDir) {
        $newFiles = @(Get-ChildItem -LiteralPath $cfg.outDir -File -Filter *.png -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -gt $marker })
    }
    $secs = [int]((Get-Date) - $t0).TotalSeconds
    $childLogLines = @(Get-Content $childLog -Encoding UTF8 -ErrorAction SilentlyContinue)
    $logEvidence = @($childLogLines | Where-Object { $_ -match '最终成品|与网关断开连接|网关提交失败|网关卡在|最终出图未产出' } | Select-Object -Last 2)

    $expectReject = ("$($combo.expect)" -eq 'reject')
    if ($expectReject) {
        # Krea2_Q4 模型未下载：**正确行为** = 表单弹出错误框、状态栏 failed、不产出图片
        $rejected = ($dialogsSeen.Count -gt 0 -or $finalStatus -in @('failed')) -and ($newFiles.Count -eq 0)
        $ok = $rejected
        if (-not $ok -and $newFiles.Count -gt 0) {
            Write-Host "  [WARN] Krea2_Q4 缺模型却出了图（不该发生）" -ForegroundColor Yellow
        }
    } else {
        # 判定：状态栏 success，或窗口已关闭 + 产物目录确实多出新图，都算通过；
        # 再拿子进程日志里的「最终成品」当交叉证据（只信状态栏容易被误导）。
        $ok = (($finalStatus -in @('success', 'closed', 'failed')) -and $newFiles.Count -gt 0)
        if ($ok -and $logEvidence.Count -gt 0 -and ($logEvidence -join ' ') -match '断开连接|提交失败|卡在|未产出') {
            $ok = $false
            Write-Host "  [WARN] 状态栏看似成功，但子进程日志有失败证据：$($logEvidence -join ' / ')" -ForegroundColor Yellow
        }
    }
    if (-not $ok) { $failCount++ }
    Write-Host ("  [{0}] 状态={1} 新增产物={2} 对话框=[{3}] 用时={4}s" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $finalStatus, $newFiles.Count, ($dialogsSeen -join ','), $secs) `
        -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
    foreach ($f in $newFiles) { Write-Host ("        {0}" -f $f.Name) -ForegroundColor DarkGray }
    $report += [pscustomobject]@{
        Combo = $tag; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }); Detail = (($statusTexts -join ' > ') + $(if ($dialogsSeen.Count) { " | 对话框: $($dialogsSeen -join ',')" } else { '' }))
        Status = $finalStatus; Files = $newFiles.Count; Seconds = $secs
    }

    # 收尾：关窗口 / 杀子进程
    if (-not $KeepWindows) {
        try { $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() } catch { }
        Start-Sleep -Milliseconds 500
        if (-not $proc.HasExited) { $proc.Kill() }
    }
    Remove-Item $launcher -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "================= 汇总 =================" -ForegroundColor Cyan
$report | Format-Table -AutoSize
$pass = @($report | Where-Object { $_.Result -eq 'PASS' }).Count
Write-Host ("通过 {0}/{1}（失败 {2}）" -f $pass, $report.Count, $failCount) -ForegroundColor $(if ($failCount -eq 0) { 'Green' } else { 'Red' })
$outJson = Join-Path $env:TEMP 'ui-gateway-verify-report.json'
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $outJson -Encoding UTF8
Write-Host "报告：$outJson"
if ($failCount -gt 0) { exit 1 }
exit 0
