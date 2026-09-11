[CmdletBinding()]
param(
    [switch]$StartAtLogin
)

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$installRoot = Join-Path $env:LOCALAPPDATA "Programs\Pico"
$startMenu = [Environment]::GetFolderPath("StartMenu")
$shortcutPath = Join-Path $startMenu "Programs\Pico.lnk"
$desktop = [Environment]::GetFolderPath("Desktop")
$desktopShortcutPath = Join-Path $desktop "Pico.lnk"
$iconPath = Join-Path $installRoot "Pico.exe"

if ((Resolve-Path $source).Path -ne $installRoot) {
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $source -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $installRoot -Force
    }
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $iconPath
$shortcut.WorkingDirectory = $installRoot
$shortcut.Description = "Pico desktop companion"
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Save()

$desktopShortcut = $shell.CreateShortcut($desktopShortcutPath)
$desktopShortcut.TargetPath = $iconPath
$desktopShortcut.WorkingDirectory = $installRoot
$desktopShortcut.Description = "Pico desktop companion"
$desktopShortcut.IconLocation = "$iconPath,0"
$desktopShortcut.Save()

if ($StartAtLogin) {
    $startup = [Environment]::GetFolderPath("Startup")
    $startupShortcut = $shell.CreateShortcut((Join-Path $startup "Pico.lnk"))
    $startupShortcut.TargetPath = Join-Path $installRoot "Pico.exe"
    $startupShortcut.WorkingDirectory = $installRoot
    $startupShortcut.Description = "Start Pico when I sign in"
    $startupShortcut.Save()
}

Start-Process -FilePath (Join-Path $installRoot "Pico.exe") -WorkingDirectory $installRoot
Write-Host "Pico installed for the current user at $installRoot"
