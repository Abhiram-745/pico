@echo off
setlocal

rem ===========================================================================
rem  Pico launcher
rem
rem  Starts the bridge and opens the interface. Double-click this file.
rem  Closing this window stops Pico.
rem
rem  Pico.exe is the older Windows build and still carries the previous
rem  interface; this launcher opens the current one.
rem ===========================================================================

cd /d "%~dp0"
title Pico

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is required and was not found.
  echo   Install the LTS build from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

rem No .env step here: the app asks for a key on first run.

if not exist "node_modules" (
  echo.
  echo   First run: installing the desktop-control module. This needs the
  echo   internet once and takes a minute; it is skipped on every run after.
  echo.
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   That install failed, so Pico will run in preview mode ^(no real
    echo   mouse/keyboard control^) until it succeeds. Run this file again to retry.
    echo.
    pause
  )
)

set "URL=http://localhost:4177/pico-ui/app.html"

rem Prefer an app window - no tabs, no address bar - so it reads as an app.
set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER%" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

echo.
echo   Starting Pico...
echo   Keep this window open. Close it to stop.
echo.

rem Open the window once the bridge has had a moment to bind. Runs detached so
rem the bridge itself can own this console - closing it then stops everything.
if exist "%BROWSER%" (
  start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" "%BROWSER%" --app=\"%URL%\" --window-size=1280,880"
) else (
  start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" "%URL%""
)

node "bridge\server.mjs"
