# Installs a T3 Code Plus build after the client exits, showing progress, then reopens the client.
# Started through WMI so it outlives the client's job object; see WindowsLocalUpdate.ts.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RequestPath,
    # No window or dialogs, for tests.
    [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$logPath = Join-Path (Split-Path -Parent $RequestPath) 'update.log'
$installRoot = $request.installDirectory.TrimEnd('\') + '\'
$form = $null
$status = $null

function Write-UpdateLog([string]$Message) {
    Add-Content -LiteralPath $logPath -Value ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message) -Encoding UTF8
}

function Show-Step([int]$Step, [string]$Message) {
    Write-UpdateLog "$Step/3 $Message"
    if ($null -eq $script:status) { return }
    $script:status.Text = "$Step/3  $Message"
    [Windows.Forms.Application]::DoEvents()
}

# Keeps the window responsive while waiting; returns $false on timeout.
function Wait-Until([scriptblock]$Condition, [int]$TimeoutSeconds, [int]$IntervalMilliseconds = 200) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not (& $Condition)) {
        if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) { return $false }
        if ($null -ne $script:form) { [Windows.Forms.Application]::DoEvents() }
        Start-Sleep -Milliseconds $IntervalMilliseconds
    }
    return $true
}

function Get-InstalledProcesses {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)
    })
}

function Show-Message([string]$Text, [string]$Title, [string]$Icon) {
    Write-UpdateLog $Text
    if ($Quiet) { return }
    [Windows.Forms.MessageBox]::Show($script:form, $Text, $Title, 'OK', $Icon) | Out-Null
}

if (-not $Quiet) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $form = New-Object Windows.Forms.Form
    $form.Text = 'T3 Code Plus 更新'
    $form.ClientSize = New-Object Drawing.Size(460, 140)
    $form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9.5)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.ControlBox = $false
    $form.TopMost = $true
    try { $form.Icon = [Drawing.Icon]::ExtractAssociatedIcon($request.executable) } catch {}
    $heading = New-Object Windows.Forms.Label
    $heading.Location = New-Object Drawing.Point(20, 16)
    $heading.Size = New-Object Drawing.Size(420, 24)
    $heading.Text = "正在更新到 $($request.targetVersion)"
    $status = New-Object Windows.Forms.Label
    $status.Location = New-Object Drawing.Point(20, 48)
    $status.Size = New-Object Drawing.Size(420, 40)
    $bar = New-Object Windows.Forms.ProgressBar
    $bar.Location = New-Object Drawing.Point(20, 98)
    $bar.Size = New-Object Drawing.Size(420, 18)
    $bar.Style = 'Marquee'
    $bar.MarqueeAnimationSpeed = 30
    $form.Controls.AddRange(@($heading, $status, $bar))
    $form.Show()
    [Windows.Forms.Application]::DoEvents()
}

$stage = 0
try {
    $stage = 1
    Show-Step 1 '等待 T3 Code Plus 退出'
    if (-not (Wait-Until { @(Get-InstalledProcesses).Count -eq 0 } 90 500)) {
        $names = (Get-InstalledProcesses | ForEach-Object { "$($_.Name) ($($_.ProcessId))" }) -join ', '
        throw "T3 Code Plus 在 90 秒内没有完全退出，安装没有改动。仍在运行：$names"
    }

    $stage = 2
    Show-Step 2 '正在安装新版本'
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $request.installer
    # NSIS takes /D= only as the last argument, unquoted even with spaces.
    $info.Arguments = '--updated /S /D=' + $request.installDirectory
    $info.UseShellExecute = $false
    $info.WorkingDirectory = Split-Path -Parent $request.installer
    $installer = [Diagnostics.Process]::Start($info)
    if (-not (Wait-Until { $installer.HasExited } 600)) { throw '安装程序 10 分钟内没有完成。' }
    if ($installer.ExitCode -ne 0) { throw "安装程序失败（退出代码 $($installer.ExitCode)）。" }
    $version = (Get-Item -LiteralPath $request.executable).VersionInfo.FileVersion
    if ($version -ne $request.targetVersion) {
        throw "安装后的版本是 $version，不是 $($request.targetVersion)。"
    }
    $stage = 3
    Show-Step 3 '正在打开 T3 Code Plus'
    if ($Quiet) { exit 0 }
    # Explorer starts it like the Start menu does, so nothing ties it to this hidden console.
    Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('"' + $request.executable + '"')
    $opened = Wait-Until {
        @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.Path -eq $request.executable
        }).Count -gt 0
    } 60 500
    if (-not $opened) {
        Show-Message "已更新到 $($request.targetVersion)，但新版本 60 秒内没有打开。请从开始菜单打开 T3 Code Plus。" 'T3 Code Plus 更新' 'Information'
    }
    Write-UpdateLog 'done'
    exit 0
} catch {
    $detail = $_.Exception.Message
    $hint = if ($stage -eq 2) { "`n`n如果 T3 Code Plus 无法正常使用，请手动运行安装包：`n$($request.installer)" } else { '' }
    Show-Message "更新没有完成：`n$detail$hint`n`n日志：$logPath" 'T3 Code Plus 更新失败' 'Error'
    # Reopen what is installed now, unless the client never exited.
    if (-not $Quiet -and $stage -ge 2 -and (Test-Path -LiteralPath $request.executable)) {
        Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('"' + $request.executable + '"')
    }
    exit 1
} finally {
    if ($null -ne $form) {
        $form.Close()
        $form.Dispose()
    }
}
