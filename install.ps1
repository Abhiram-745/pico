[CmdletBinding()]
param(
    [switch]$StartAtLogin
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
$installRoot = Join-Path $env:LOCALAPPDATA "Programs\Halo"
$startMenu = [Environment]::GetFolderPath("StartMenu")
$shortcutPath = Join-Path $startMenu "Programs\Halo.lnk"
$desktop = [Environment]::GetFolderPath("Desktop")
$desktopShortcutPath = Join-Path $desktop "Halo.lnk"
$launcherPath = Join-Path $installRoot "Start Halo.cmd"
$iconPath = Join-Path $installRoot "phone\icons\icon-192.png"

if ((Resolve-Path $source).Path -ne $installRoot) {
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $source | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $installRoot -Recurse -Force
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

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.Arguments = "--app"
$shortcut.WorkingDirectory = $installRoot
$shortcut.Description = "Halo desktop agent"
$shortcut.WindowStyle = 7
if (Test-Path $iconPath) { $shortcut.IconLocation = "$iconPath,0" }
$shortcut.Save()

$desktopShortcut = $shell.CreateShortcut($desktopShortcutPath)
$desktopShortcut.TargetPath = $launcherPath
$desktopShortcut.Arguments = "--app"
$desktopShortcut.WorkingDirectory = $installRoot
$desktopShortcut.Description = "Halo desktop agent"
$desktopShortcut.WindowStyle = 7
if (Test-Path $iconPath) { $desktopShortcut.IconLocation = "$iconPath,0" }
$desktopShortcut.Save()

# One shortcut, "Halo". It runs the launcher with --app: that starts Halo if it
# is not running and opens its window either way, so it never lands on an
# error page at a localhost address. "Halo Settings" and "Halo App" were
# the old names for that window and are removed above.

if ($StartAtLogin) {
    $startup = [Environment]::GetFolderPath("Startup")
    $startupShortcut = $shell.CreateShortcut((Join-Path $startup "Halo.lnk"))
    $startupShortcut.TargetPath = $launcherPath
    $startupShortcut.WorkingDirectory = $installRoot
    $startupShortcut.Description = "Start Halo when I sign in"
    $startupShortcut.Save()
}

Start-Process -FilePath $launcherPath -WorkingDirectory $installRoot -WindowStyle Minimized
Write-Host "Halo installed for the current user at $installRoot"
