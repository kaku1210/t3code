<#
.SYNOPSIS
Installs this prepared T3 Code Plus portable release after the user exits the desktop client.
.DESCRIPTION
Checks the release payload, stages a complete copy and preserves an existing installation as a
backup. It neither stops processes nor launches the app, and does not change the user profile.
.PARAMETER DestinationRoot
Installation directory. The normal launcher uses D:\AI Program Files\T3 Code Plus; a separate
directory can be supplied for a file-installation smoke test without opening another client.
.PARAMETER ValidateOnly
Checks this release without creating or changing an installation directory.
.NOTES
Run the copy shipped beside release.json and the packaged payload. Source checkouts keep this
template under scripts; the Windows ZIP build exports the ready-to-use release directory.
#>
[CmdletBinding()]
param(
    [string]$DestinationRoot = 'D:\AI Program Files\T3 Code Plus',
    [switch]$ValidateOnly,
    [string]$ExpectedExecutableName,
    [string]$ExpectedVersion,
    [string]$ExpectedBranch
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-ContainedPath {
    param([string]$Root, [string]$RelativePath)
    $candidate = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    if (-not $candidate.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the release or installation directory: $RelativePath"
    }
    return $candidate
}

# The release file list checks complete copies without downloading dependencies or changing data.
function Assert-ReleaseFiles {
    param([string]$Directory, [object[]]$Files)
    $entries = @(Get-ChildItem -LiteralPath $Directory -Recurse -File)
    if ($entries.Count -ne $Files.Count) { throw "Incomplete portable directory: $Directory" }
    foreach ($entry in $Files) {
        $file = Get-Item -LiteralPath (Get-ContainedPath $Directory $entry.path)
        if ($file.PSIsContainer -or $file.Length -ne $entry.length) {
            throw "Release file is missing or incomplete: $($entry.path)"
        }
    }
}

try {
    $releaseRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
    $destination = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
    if ($destination -eq $releaseRoot -or
        $destination.StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $releaseRoot.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The installation directory must be separate from this release directory.'
    }
    $manifest = Get-Content -LiteralPath (Join-Path $releaseRoot 'release.json') -Raw -Encoding UTF8 |
        ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($manifest.appName) -or @($manifest.files).Count -eq 0) {
        throw 'This is not a complete T3 Code Plus release.'
    }
    # Older prepared releases did not record the payload directory. New builds also support
    # electron-builder's win-arm64-unpacked layout and the nightly executable name.
    $payloadProperty = $manifest.PSObject.Properties['payloadDirectory']
    $payloadDirectory = if ($null -eq $payloadProperty) { 'win-unpacked' } else { [string]$payloadProperty.Value }
    $source = Get-ContainedPath $releaseRoot $payloadDirectory
    $installed = Get-ContainedPath $destination 'win-unpacked'
    $executableName = [string]$manifest.appName + '.exe'
    if ($ExpectedExecutableName -and $ExpectedExecutableName -ne $executableName) { throw 'The package executable does not match this client.' }
    if ($ExpectedVersion -and $ExpectedVersion -ne [string]$manifest.version) { throw 'The prepared package changed after confirmation. Check again.' }
    if ($ExpectedBranch -and ($null -eq $manifest.PSObject.Properties['buildInfo'] -or [string]$manifest.buildInfo.sourceBranch -ne $ExpectedBranch)) { throw 'The package branch does not match this client.' }
    foreach ($directory in @($source, $destination, $installed)) {
        if ((Test-Path -LiteralPath $directory) -and
            ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "A release or installation directory is a link: $directory"
        }
    }
    Assert-ReleaseFiles $source @($manifest.files)
    if (-not (Test-Path -LiteralPath (Get-ContainedPath $source $executableName))) {
        throw "Application executable is missing: $executableName"
    }
    if ($ValidateOnly) {
        Write-Host "Release validated: $($manifest.appName) $($manifest.version), $(@($manifest.files).Count) files."
        exit 0
    }

    # Production clients share the existing profile. Require a manual exit before installation;
    # sandbox destinations only need their own executable to be closed.
    $blockedRoots = @($installed)
    if ($destination -eq 'D:\AI Program Files\T3 Code Plus') {
        $blockedRoots += 'D:\AI Program Files\T3 Code_kaku\win-unpacked'
        $blockedRoots += 'D:\AI Program Files\T3 Code\win-unpacked'
    }
    $running = @(Get-CimInstance Win32_Process |
        Where-Object {
            $executable = $_.ExecutablePath
            $executable -and @($blockedRoots | Where-Object {
                $executable.StartsWith($_ + '\', [StringComparison]::OrdinalIgnoreCase)
            }).Count -gt 0
        })
    if ($running.Count -gt 0) {
        Write-Host 'T3 Code is still running. Exit it completely, including the tray icon, and run this tool again.'
        Write-Host ('Running process IDs: ' + (($running | ForEach-Object { $_.ProcessId }) -join ', '))
        Write-Host 'No installed files were changed.'
        exit 2
    }

    if (-not (Test-Path -LiteralPath $destination)) {
        New-Item -ItemType Directory -Path $destination | Out-Null
    }
    $suffix = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $stage = Get-ContainedPath $destination ('.install-' + $suffix)
    $backup = Get-ContainedPath $destination ('win-unpacked.backup-' + $suffix)
    New-Item -ItemType Directory -Path $stage | Out-Null
    $stagedPayload = Get-ContainedPath $stage 'win-unpacked'
    Copy-Item -LiteralPath $source -Destination $stagedPayload -Recurse
    Assert-ReleaseFiles $stagedPayload @($manifest.files)

    $backedUp = $false
    if (Test-Path -LiteralPath $installed) {
        Move-Item -LiteralPath $installed -Destination $backup
        $backedUp = $true
    }
    try {
        Move-Item -LiteralPath $stagedPayload -Destination $installed
    } catch {
        # A failed activation restores the old directory before reporting the original failure.
        if ($backedUp -and -not (Test-Path -LiteralPath $installed)) {
            Move-Item -LiteralPath $backup -Destination $installed
        }
        throw
    }
    # The payload was moved out, so only this task's empty staging directory is removed.
    Remove-Item -LiteralPath $stage
    Write-Host "Installed: $($manifest.appName) $($manifest.version)"
    if ($backedUp) { Write-Host "Previous installation retained at: $backup" }
    Write-Host ('Open manually: ' + (Join-Path $installed $executableName))
    exit 0
} catch {
    Write-Error $_
    exit 1
}
