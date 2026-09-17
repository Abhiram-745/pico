@echo off
setlocal

rem ===========================================================================
rem  Halo launcher
rem
rem  Double-click this file. It starts the bridge; the bridge opens the island
rem  itself. Closing this window stops Halo.
rem
rem  NOTHING HERE OPENS A BROWSER, ON PURPOSE.
rem  It used to, with:
rem      start "" /b cmd /c "... start "" "%BROWSER%" --app=\"%URL%\" ..."
rem  Backslash-quotes are not a cmd escape. Nested inside cmd /c they were
rem  stripped, Chrome was handed something that was not an address, and it did
rem  what a browser does with a non-address: searched the web for it. That is
rem  why opening Halo opened Google. Node hands Chrome its arguments directly,
rem  with no second round of shell parsing, so the bridge opens the window.
rem ===========================================================================

cd /d "%~dp0"
title Halo

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

rem Installed on first run, and again whenever a package the interface needs
rem is missing: a copy updated from before the interface was React has a
rem node_modules folder, just not React in it.
set "NEEDS_INSTALL="
if not exist "node_modules" set "NEEDS_INSTALL=1"
if not exist "node_modules\react-dom" set "NEEDS_INSTALL=1"
if not exist "node_modules\esbuild" set "NEEDS_INSTALL=1"

if defined NEEDS_INSTALL (
  echo.
  echo   Installing what Halo needs. This needs the internet once and takes
  echo   a minute; it is skipped on every run after.
  echo.
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   That install failed, so Halo will run in preview mode ^(no real
    echo   mouse/keyboard control^) until it succeeds. Run this file again to retry.
    echo.
    pause
  )
)

echo.
echo   Starting Halo...
echo   The island appears at the top of your screen.
echo   Keep this window open. Close it to stop.
echo.

rem Anything passed in goes to the bridge: "Start Halo.cmd --app" opens the
rem full window too, which is what the "Halo App" shortcut does.
node "bridge/server.mjs" %*
