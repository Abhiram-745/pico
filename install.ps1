[CmdletBinding()]
param(
    [switch]$StartAtLogin,
    [switch]$NoLaunch,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\Halo')
)

<#
  Run this from inside an already-downloaded, already-unzipped Halo folder
  (the portable Halo-latest.zip). It copies Halo to your per-user Programs
  folder and adds Start-menu and Desktop shortcuts to the launcher. No admin
  rights needed.

  Prefer a normal installer with a wizard instead of this script? Download
  Halo-Setup.exe from the same release and run it.
#>

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$installRoot = [IO.Path]::GetFullPath($InstallRoot)
$startMenu = [Environment]::GetFolderPath("StartMenu")
$shortcutPath = Join-Path $startMenu "Programs\Halo.lnk"
$desktop = [Environment]::GetFolderPath("Desktop")
$desktopShortcutPath = Join-Path $desktop "Halo.lnk"
$launcherPath = Join-Path $installRoot "Start Halo.cmd"
$iconPath = Join-Path $installRoot "scripts\pico.ico"
$hiddenLauncherPath = Join-Path $installRoot "Start Halo.vbs"
$nodePath = (Get-Command node -ErrorAction Stop).Source

# Update only an installed bridge that belongs to this exact destination.
# A development bridge or any other Node app is left alone.
$installedServer = Join-Path $installRoot 'bridge\server.mjs'
$owned = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($installedServer) })
if ($owned.Count) {
    try { Invoke-RestMethod -Uri 'http://localhost:4177/quit' -Method Post -TimeoutSec 5 | Out-Null } catch { }
    foreach ($appProcess in $owned) {
        $remaining = Get-Process -Id $appProcess.ProcessId -ErrorAction SilentlyContinue
        if ($remaining) {
            try { $remaining.WaitForExit(8000) | Out-Null } catch { }
            $remaining = Get-Process -Id $appProcess.ProcessId -ErrorAction SilentlyContinue
            if ($remaining) { throw 'Close the installed Halo app before updating it.' }
        }
    }
}

if ((Resolve-Path $source).Path -ne $installRoot) {
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    # Keep the install independent of this checkout, without copying git,
    # downloaded legacy executables, test artifacts, or machine settings.
    foreach ($folder in @('bridge', 'pico-ui', 'phone', 'scripts', 'node_modules')) {
        $sourceFolder = Join-Path $source $folder
        if (Test-Path -LiteralPath $sourceFolder -PathType Container) {
            Copy-Item -LiteralPath $sourceFolder -Destination $installRoot -Recurse -Force
        }
    }
    foreach ($file in @('Start Halo.cmd', 'package.json', 'package-lock.json', '.env.example', 'README.md', 'SAFETY.md', 'WINDOWS-TEST.md', 'build.json', 'install.ps1')) {
        $sourceFile = Join-Path $source $file
        if (Test-Path -LiteralPath $sourceFile -PathType Leaf) {
            Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $installRoot $file) -Force
        }
    }
    $guide = Join-Path $source 'docs\desktop-companion.md'
    if (Test-Path -LiteralPath $guide) {
        New-Item -ItemType Directory -Force -Path (Join-Path $installRoot 'docs') | Out-Null
        Copy-Item -LiteralPath $guide -Destination (Join-Path $installRoot 'docs\desktop-companion.md') -Force
    }
    # An existing installation owns its provider configuration. Carry a local
    # checkout's configuration only when there isn't one in the installation.
    $sourceEnv = Join-Path $source '.env'
    $installedEnv = Join-Path $installRoot '.env'
    if ((Test-Path -LiteralPath $sourceEnv) -and -not (Test-Path -LiteralPath $installedEnv)) {
        Copy-Item -LiteralPath $sourceEnv -Destination $installedEnv
    }
}

# Moving over from Pico, the old name. The key in its .env comes across so
# nobody has to find it again, and its shortcuts go, so there are not two
# launchers for one app. The old folder itself is left alone: memory, chats
# and settings are carried over by Halo on its first start (bridge/home.mjs),
# and deleting someone's install is not this script's call.
$oldRoot = Join-Path $env:LOCALAPPDATA "Programs\Pico"
if ((Test-Path (Join-Path $oldRoot ".env")) -and -not (Test-Path (Join-Path $installRoot ".env"))) {
    Copy-Item -LiteralPath (Join-Path $oldRoot ".env") -Destination (Join-Path $installRoot ".env")
}
foreach ($old in @(
    (Join-Path $startMenu "Programs\Pico.lnk"),
    (Join-Path $startMenu "Programs\Pico Settings.lnk"),
    (Join-Path $startMenu "Programs\Pico\Pico.lnk"),
    (Join-Path $startMenu "Programs\Halo Settings.lnk"),
    (Join-Path $startMenu "Programs\Halo App.lnk"),
    (Join-Path $desktop "Pico.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Startup")) "Pico.lnk")
)) {
    if (Test-Path $old) { Remove-Item -LiteralPath $old -Force }
}

if (-not (Test-Path $launcherPath)) {
    Write-Error "`"Start Halo.cmd`" was not found in $installRoot — is this an extracted Halo release folder?"
}

# A downloaded portable package may not include dependencies; complete the
# installation now so a hidden first launch does not hide a failed install.
if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'node_modules\react-dom'))) {
    Push-Location $installRoot
    try {
        & npm.cmd ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Could not install Halo dependencies.' }
    } finally { Pop-Location }
}

# The desktop shortcut starts Node without a console window. Arguments are
# limited to the app flag; no command text is accepted through this wrapper.
$nodeCommand = '"' + $nodePath + '" "' + $installedServer + '"'
$vbCommand = $nodeCommand.Replace('"', '""')
$vbDirectory = $installRoot.Replace('"', '""')
$vbSource = @"
Option Explicit
Dim shell, command, argument
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "$vbDirectory"
command = "$vbCommand"
For Each argument In WScript.Arguments
  If argument = "--app" Then command = command & " --app"
Next
shell.Run command, 0, False
"@
[IO.File]::WriteAllText($hiddenLauncherPath, $vbSource, [Text.Encoding]::Unicode)
$wscriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$hiddenArguments = '//B //Nologo "' + $hiddenLauncherPath + '" --app'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $wscriptPath
$shortcut.Arguments = $hiddenArguments
$shortcut.WorkingDirectory = $installRoot
$shortcut.Description = "Halo desktop agent"
$shortcut.WindowStyle = 1
if (Test-Path $iconPath) { $shortcut.IconLocation = "$iconPath,0" }
$shortcut.Save()

$desktopShortcut = $shell.CreateShortcut($desktopShortcutPath)
$desktopShortcut.TargetPath = $wscriptPath
$desktopShortcut.Arguments = $hiddenArguments
$desktopShortcut.WorkingDirectory = $installRoot
$desktopShortcut.Description = "Halo desktop agent"
$desktopShortcut.WindowStyle = 1
if (Test-Path $iconPath) { $desktopShortcut.IconLocation = "$iconPath,0" }
$desktopShortcut.Save()

# One shortcut, "Halo". It runs the launcher with --app: that starts Halo if it
# is not running and opens its window either way, so it never lands on an
# error page at a localhost address. "Halo Settings" and "Halo App" were
# the old names for that window and are removed above.

if ($StartAtLogin) {
    $startup = [Environment]::GetFolderPath("Startup")
    $startupShortcut = $shell.CreateShortcut((Join-Path $startup "Halo.lnk"))
    $startupShortcut.TargetPath = $wscriptPath
    $startupShortcut.Arguments = '//B //Nologo "' + $hiddenLauncherPath + '"'
    $startupShortcut.WorkingDirectory = $installRoot
    $startupShortcut.Description = "Start Halo when I sign in"
    $startupShortcut.Save()
}

if (-not $NoLaunch) {
    Start-Process -FilePath $wscriptPath -ArgumentList $hiddenArguments -WorkingDirectory $installRoot -WindowStyle Hidden
}
Write-Host "Halo installed for the current user at $installRoot"
