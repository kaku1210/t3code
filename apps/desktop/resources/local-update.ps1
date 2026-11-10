# This coordinator lives outside the installation so the portable directory can be replaced.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RequestPath, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$logPath = Join-Path $PSScriptRoot 'update.log'
$resultPath = Join-Path $PSScriptRoot 'result.json'
$ready = $false
function Invoke-Installer([bool]$CheckOnly) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $env:ComSpec
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
        $child.WaitForExit()
        Add-Content -LiteralPath $logPath -Value ($stdout.Result + $stderr.Result) -Encoding UTF8
        if ($child.ExitCode -ne 0) { throw "Installer exited with code $($child.ExitCode). See $logPath" }
    } finally { $child.Dispose() }
}
try {
    # Capture the original handle before readiness; a recycled PID cannot become our parent.
    $parent = if ($ValidateOnly) { $null } else { [Diagnostics.Process]::GetProcessById([int]$request.parentPid) }
    if ($null -ne $parent) { $null = $parent.Handle }
    Invoke-Installer $true
    if ($ValidateOnly) { exit 0 }
    [Console]::Out.WriteLine('T3_LOCAL_UPDATE_READY')
    [Console]::Out.Flush()
    $ready = $true
    if (-not $parent.WaitForExit(45000)) { throw 'The original client did not exit. No installation was changed.' }
    $parent.Dispose()
    Invoke-Installer $false
    $executable = Join-Path (Join-Path $request.destinationRoot 'win-unpacked') $request.executableName
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Installed application is missing: $executable" }
    $launch = New-Object Diagnostics.ProcessStartInfo
    $launch.FileName = $executable
    $launch.WorkingDirectory = Split-Path -Parent $executable
    $launch.UseShellExecute = $false
    $launch.CreateNoWindow = $true
    foreach ($name in @('ELECTRON_RUN_AS_NODE','T3CODE_LOCAL_UPDATE','T3CODE_UPDATE_CMD','T3CODE_UPDATE_DEST','T3CODE_UPDATE_EXE','T3CODE_UPDATE_VERSION','T3CODE_UPDATE_BRANCH')) { $launch.EnvironmentVariables.Remove($name) }
    $newApp = [Diagnostics.Process]::Start($launch)
    if ($newApp.WaitForExit(1000)) { throw 'The installed client exited immediately. Check its startup log before retrying.' }
    @{ success=$true; processId=$newApp.Id; executable=$executable } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    $newApp.Dispose()
    exit 0
} catch {
    $message = $_.Exception.Message
    Add-Content -LiteralPath $logPath -Value $message -Encoding UTF8
    @{ success=$false; error=$message; logPath=$logPath } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    if ($ready) {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show("本地更新未完成。`n$message`n日志：$logPath", 'T3 Code Plus 更新失败', 'OK', 'Error') | Out-Null
    } else { [Console]::Error.WriteLine($message) }
    exit 1
}
