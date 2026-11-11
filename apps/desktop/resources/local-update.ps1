# This coordinator lives outside the installation so the portable directory can be replaced.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RequestPath, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot
[Environment]::CurrentDirectory = $PSScriptRoot
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$logPath = Join-Path $PSScriptRoot 'update.log'
$resultPath = Join-Path $PSScriptRoot 'result.json'
$cancelPath = $RequestPath + '.cancelled'
$ready = $false
$progressWindow = $null
$progressLabel = $null
$mayCloseProgress = $false
function Show-UpdateProgress([int]$Step, [string]$Message) {
    Add-Content -LiteralPath $logPath -Value ("[{0}] {1}/4 {2}" -f (Get-Date -Format 'HH:mm:ss'), $Step, $Message) -Encoding UTF8
    if ($ValidateOnly) { return }
    if ($null -eq $script:progressWindow) {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [Windows.Forms.Application]::EnableVisualStyles()
        $script:progressWindow = New-Object Windows.Forms.Form
        $script:progressWindow.Text = 'T3 Code Plus 更新'
        $script:progressWindow.ClientSize = New-Object Drawing.Size(460, 160)
        $script:progressWindow.Font = New-Object Drawing.Font('Segoe UI', 10)
        $script:progressWindow.StartPosition = 'CenterScreen'
        $script:progressWindow.FormBorderStyle = 'FixedDialog'
        $script:progressWindow.ControlBox = $false
        $script:progressWindow.Add_FormClosing({ param($sender, $eventArgs)
            if (-not $script:mayCloseProgress) { $eventArgs.Cancel = $true }
        })
        $versionLabel = New-Object Windows.Forms.Label
        $versionLabel.Location = New-Object Drawing.Point(20, 18)
        $versionLabel.Size = New-Object Drawing.Size(420, 24)
        $versionLabel.Text = "正在更新到 $($request.targetVersion)"
        $script:progressLabel = New-Object Windows.Forms.Label
        $script:progressLabel.Location = New-Object Drawing.Point(20, 54)
        $script:progressLabel.Size = New-Object Drawing.Size(420, 42)
        $bar = New-Object Windows.Forms.ProgressBar
        $bar.Location = New-Object Drawing.Point(20, 112)
        $bar.Size = New-Object Drawing.Size(420, 18)
        $bar.Style = 'Marquee'
        $script:progressWindow.Controls.AddRange(@($versionLabel, $script:progressLabel, $bar))
        $script:progressWindow.Show()
    }
    $script:progressLabel.Text = "$Step/4  $Message"
    [Windows.Forms.Application]::DoEvents()
}
function Wait-UpdateProcess([Diagnostics.Process]$Process, [int]$TimeoutMilliseconds = -1) {
    if ($null -eq $script:progressWindow) { return $Process.WaitForExit($TimeoutMilliseconds) }
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    while (-not $Process.WaitForExit(100)) {
        [Windows.Forms.Application]::DoEvents()
        if ($TimeoutMilliseconds -ge 0 -and $elapsed.ElapsedMilliseconds -ge $TimeoutMilliseconds) { return $false }
    }
    [Windows.Forms.Application]::DoEvents()
    return $true
}
function Invoke-Installer([bool]$CheckOnly) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $env:ComSpec
    $info.WorkingDirectory = $PSScriptRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables['T3CODE_LOCAL_UPDATE'] = '1'
    $info.EnvironmentVariables['T3CODE_UPDATE_CMD'] = [string]$request.commandPath
    $info.EnvironmentVariables['T3CODE_UPDATE_DEST'] = [string]$request.destinationRoot
    $info.EnvironmentVariables['T3CODE_UPDATE_EXE'] = [string]$request.executableName
    $info.EnvironmentVariables['T3CODE_UPDATE_VERSION'] = [string]$request.targetVersion
    $info.EnvironmentVariables['T3CODE_UPDATE_BRANCH'] = [string]$request.sourceBranch
    $info.Arguments = '/d /s /c ""%T3CODE_UPDATE_CMD%" -DestinationRoot "%T3CODE_UPDATE_DEST%" -ExpectedExecutableName "%T3CODE_UPDATE_EXE%" -ExpectedVersion "%T3CODE_UPDATE_VERSION%" -ExpectedBranch "%T3CODE_UPDATE_BRANCH%"'
    if ($CheckOnly) { $info.Arguments += ' -ValidateOnly' }
    $info.Arguments += '"'
    $child = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        $null = Wait-UpdateProcess $child
        Add-Content -LiteralPath $logPath -Value ($stdout.Result + $stderr.Result) -Encoding UTF8
        if ($child.ExitCode -ne 0) {
            $detail = $stderr.Result.Trim()
            if (-not $detail) { $detail = $stdout.Result.Trim() }
            throw "本地安装失败（退出代码 $($child.ExitCode)）。`n$detail"
        }
    } finally { $child.Dispose() }
}
try {
    # Capture the original handle before readiness; a recycled PID cannot become our parent.
    $parent = if ($ValidateOnly) { $null } else { [Diagnostics.Process]::GetProcessById([int]$request.parentPid) }
    if ($null -ne $parent) { $null = $parent.Handle }
    Show-UpdateProgress 1 '正在校验本地安装包'
    Invoke-Installer $true
    if ($ValidateOnly) { exit 0 }
    if (Test-Path -LiteralPath $cancelPath) { throw '本地更新已取消。' }
    Show-UpdateProgress 2 '正在等待当前客户端和本机任务退出'
    $ready = $true
    [IO.File]::WriteAllText($RequestPath + '.ready.tmp', [string]$PID)
    [IO.File]::Move($RequestPath + '.ready.tmp', $RequestPath + '.ready')
    if (-not (Wait-UpdateProcess $parent 45000)) { throw 'The original client did not exit. No installation was changed.' }
    $parent.Dispose()
    if (Test-Path -LiteralPath $cancelPath) { throw '本地更新已取消。' }
    Show-UpdateProgress 3 '正在备份旧版并安装新版本'
    Invoke-Installer $false
    $executable = Join-Path (Join-Path $request.destinationRoot 'win-unpacked') $request.executableName
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Installed application is missing: $executable" }
    $launch = New-Object Diagnostics.ProcessStartInfo
    $launch.FileName = $executable
    $launch.WorkingDirectory = Split-Path -Parent $executable
    $launch.UseShellExecute = $false
    $launch.CreateNoWindow = $true
    foreach ($name in @('ELECTRON_RUN_AS_NODE','T3CODE_LOCAL_UPDATE','T3CODE_UPDATE_CMD','T3CODE_UPDATE_DEST','T3CODE_UPDATE_EXE','T3CODE_UPDATE_VERSION','T3CODE_UPDATE_BRANCH')) { $launch.EnvironmentVariables.Remove($name) }
    Show-UpdateProgress 4 '正在启动新客户端'
    $newApp = [Diagnostics.Process]::Start($launch)
    try {
        $startup = [Diagnostics.Stopwatch]::StartNew()
        while ($true) {
            $newApp.Refresh()
            if ($newApp.HasExited) { throw 'The installed client exited before showing its window. Check its startup log before retrying.' }
            if ($newApp.MainWindowHandle -ne [IntPtr]::Zero) { break }
            if ($startup.ElapsedMilliseconds -ge 45000) { throw 'Installation completed, but the new client window did not appear within 45 seconds. Check its startup log.' }
            $null = Wait-UpdateProcess $newApp 100
        }
        @{ success=$true; processId=$newApp.Id; executable=$executable } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    } finally { $newApp.Dispose() }
    exit 0
} catch {
    $message = $_.Exception.Message
    Add-Content -LiteralPath $logPath -Value $message -Encoding UTF8
    @{ success=$false; error=$message; logPath=$logPath } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    [IO.File]::WriteAllText($RequestPath + '.error.tmp', $message)
    [IO.File]::Move($RequestPath + '.error.tmp', $RequestPath + '.error')
    if ($ready) {
        [Windows.Forms.MessageBox]::Show($progressWindow, "本地更新未完成。`n$message`n日志：$logPath", 'T3 Code Plus 更新失败', 'OK', 'Error') | Out-Null
    } else { [Console]::Error.WriteLine($message) }
    exit 1
} finally {
    if ($null -ne $progressWindow) {
        $script:mayCloseProgress = $true
        $progressWindow.Close()
        $progressWindow.Dispose()
    }
}
