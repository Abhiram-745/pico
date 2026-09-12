[CmdletBinding()]
param(
    [switch]$StartAtLogin
)

<#
  Run this from inside an already-downloaded, already-unzipped Pico folder.
  It copies Pico to your per-user Programs folder and adds Start-menu and
  Desktop shortcuts to the launcher. No admin rights needed.

  Prefer not to unzip anything by hand? Use the one-line installer instead,
  which downloads the current build itself:

    irm https://raw.githubusercontent.com/Abhiram-745/pico/main/docs/install.ps1 | iex
#>

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$installRoot = Join-Path $env:LOCALAPPDATA "Programs\Pico"
$startMenu = [Environment]::GetFolderPath("StartMenu")
$shortcutPath = Join-Path $startMenu "Programs\Pico.lnk"
$desktop = [Environment]::GetFolderPath("Desktop")
$desktopShortcutPath = Join-Path $desktop "Pico.lnk"
$launcherPath = Join-Path $installRoot "Start Pico.cmd"
$iconPath = Join-Path $installRoot "phone\icons\icon-192.png"

if ((Resolve-Path $source).Path -ne $installRoot) {
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $source | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $installRoot -Recurse -Force
    }
}

if (-not (Test-Path $launcherPath)) {
    Write-Error "`"Start Pico.cmd`" was not found in $installRoot — is this an extracted Pico release folder?"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.WorkingDirectory = $installRoot
$shortcut.Description = "Pico desktop agent"
if (Test-Path $iconPath) { $shortcut.IconLocation = "$iconPath,0" }
$shortcut.Save()

$desktopShortcut = $shell.CreateShortcut($desktopShortcutPath)
$desktopShortcut.TargetPath = $launcherPath
$desktopShortcut.WorkingDirectory = $installRoot
$desktopShortcut.Description = "Pico desktop agent"
if (Test-Path $iconPath) { $desktopShortcut.IconLocation = "$iconPath,0" }
$desktopShortcut.Save()

if ($StartAtLogin) {
    $startup = [Environment]::GetFolderPath("Startup")
    $startupShortcut = $shell.CreateShortcut((Join-Path $startup "Pico.lnk"))
    $startupShortcut.TargetPath = $launcherPath
    $startupShortcut.WorkingDirectory = $installRoot
    $startupShortcut.Description = "Start Pico when I sign in"
    $startupShortcut.Save()
}

Start-Process -FilePath $launcherPath -WorkingDirectory $installRoot -WindowStyle Minimized
Write-Host "Pico installed for the current user at $installRoot"
