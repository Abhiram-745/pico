<#
  Pico installer.

  One file. Downloads the current build, installs it to your user profile,
  makes Start-menu and Desktop shortcuts, and launches it. No zip to extract
  and no files to edit — the app asks for your key on first run.

    irm https://blurt-ai.me/pico/install.ps1 | iex

  Installs per-user, so it never needs administrator rights.
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # the built-in bar is slower than the download

$Repo    = 'Abhiram-745/pico'
$AppName = 'Pico'
$Root    = Join-Path $env:LOCALAPPDATA "Programs\$AppName"

function Say($text, $colour = 'Gray') { Write-Host "  $text" -ForegroundColor $colour }

Write-Host ''
Write-Host "  $AppName" -ForegroundColor White
Write-Host '  ────────' -ForegroundColor DarkGray
Write-Host ''

# --- Node ------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Say 'Node.js is required and was not found.' 'Yellow'
    Say 'Install the LTS build from https://nodejs.org, then run this again.'
    Write-Host ''
    return
}
Say "Node $(& node --version) found." 'DarkGray'

# --- fetch -----------------------------------------------------------------
Say 'Finding the current build...'
$release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{
    Accept       = 'application/vnd.github+json'
    'User-Agent' = 'pico-installer'
}
$asset = $release.assets | Where-Object { $_.name -eq 'Pico-latest.zip' } | Select-Object -First 1
if (-not $asset) { Say 'That release has no build attached.' 'Red'; return }

$build = if ($release.body -match 'Build\s+`?([0-9a-f]{7,})`?') { $Matches[1] } else { $release.tag_name }
Say "Downloading build $build ($([math]::Round($asset.size / 1MB, 1)) MB)..."

$work = Join-Path ([IO.Path]::GetTempPath()) "pico-install-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $work -Force | Out-Null
$zip = Join-Path $work 'pico.zip'

try {
    Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing

    Say 'Installing...'
    Expand-Archive -LiteralPath $zip -DestinationPath $work -Force

    $source = Join-Path $work 'Pico'
    if (-not (Test-Path $source)) { $source = $work }

    # Keep anything personal across a reinstall.
    $keep = @{}
    foreach ($name in '.env', 'settings.json', 'audit.jsonl') {
        $path = Join-Path $Root $name
        if (Test-Path $path) { $keep[$name] = Get-Content $path -Raw }
    }

    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    Copy-Item "$source\*" $Root -Recurse -Force

    foreach ($name in $keep.Keys) {
        Set-Content (Join-Path $Root $name) $keep[$name] -NoNewline -Encoding utf8
    }
    if ($keep.Count) { Say "Kept your existing settings." 'DarkGray' }
}
finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

# --- shortcuts -------------------------------------------------------------
$launcher = Join-Path $Root 'Start Pico.cmd'
$icon     = Join-Path $Root 'phone\icons\icon-192.png'

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @(
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'),
    [Environment]::GetFolderPath('Desktop')
)) {
    $lnk = $shell.CreateShortcut((Join-Path $dir "$AppName.lnk"))
    $lnk.TargetPath       = $launcher
    $lnk.WorkingDirectory = $Root
    $lnk.Description      = 'Pico desktop agent'
    $lnk.WindowStyle      = 7            # start minimised; the app is its own window
    if (Test-Path $icon) { $lnk.IconLocation = $icon }
    $lnk.Save()
}
Say 'Added Start-menu and Desktop shortcuts.' 'DarkGray'

Write-Host ''
Say "Installed to $Root" 'Green'
Write-Host ''
Say 'Starting Pico. It will ask for your OpenAI key once.' 'White'
Write-Host ''

Start-Process -FilePath $launcher -WorkingDirectory $Root -WindowStyle Minimized
