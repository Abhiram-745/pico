; ============================================================================
; Halo installer.
;
; A real Windows installer with the wizard people expect: welcome, choose a
; folder, install, finish with a "Launch Halo now" option. No script to
; right-click, no execution-policy prompt, no file that opens in Notepad
; instead of running.
;
; Per-user install (no admin rights, no UAC prompt) into
; %LOCALAPPDATA%\Programs\Halo, with Start-menu/Desktop shortcuts and a
; normal entry in "Add or remove programs".
;
; Built with: makensis -DSTAGEDIR=<staged app folder> -DOUTFILE=<output .exe> installer.nsi
; STAGEDIR must already contain "Start Halo.cmd", pico-ui/, phone/, bridge/,
; etc. — the same layout release.yml assembles for Halo-latest.zip.
; ============================================================================

!ifndef STAGEDIR
  !define STAGEDIR "..\out\Halo"
!endif
!ifndef OUTFILE
  !define OUTFILE "..\out\Halo-Setup.exe"
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "Halo"
OutFile "${OUTFILE}"
Unicode true
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Halo"
InstallDirRegKey HKCU "Software\Halo" "InstallDir"
SetCompressor /SOLID lzma

!define MUI_ICON "pico.ico"
!define MUI_UNICON "pico.ico"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Halo setup"
!define MUI_WELCOMEPAGE_TEXT "This installs Halo, a desktop agent that works your screen — clicking, typing, scrolling — and stops to ask you before anything it can't undo.$\r$\n$\r$\nNode.js must already be on this computer; setup checks for it and tells you if it's missing.$\r$\n$\r$\nClick Next to choose where to install it."

!define MUI_FINISHPAGE_RUN "$INSTDIR\Start Halo.cmd"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Halo now"
!define MUI_FINISHPAGE_RUN_WORKINGDIR "$INSTDIR"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install" SEC_INSTALL
  SetOutPath "$INSTDIR"
  File /r "${STAGEDIR}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Halo" "InstallDir" "$INSTDIR"

  CreateDirectory "$SMPROGRAMS\Halo"
  CreateShortCut "$SMPROGRAMS\Halo\Halo.lnk" "$INSTDIR\Start Halo.cmd" "--app" "$INSTDIR\phone\icons\icon-192.png" 0 SW_SHOWMINIMIZED
  CreateShortCut "$SMPROGRAMS\Halo\Uninstall Halo.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\Halo.lnk" "$INSTDIR\Start Halo.cmd" "--app" "$INSTDIR\phone\icons\icon-192.png" 0 SW_SHOWMINIMIZED

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Halo" "DisplayName" "Halo"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Halo" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Halo" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Halo" "DisplayIcon" "$INSTDIR\phone\icons\icon-192.png"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Halo" "Publisher" "Halo"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Halo" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Halo" "NoRepair" 1

  ; Node.js is a hard requirement; Start Halo.cmd also checks, but tell people
  ; up front rather than after they think setup finished successfully.
  nsExec::ExecToStack 'node --version'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_YESNO "Halo also needs Node.js, which wasn't found on this computer.$\r$\n$\r$\nOpen the Node.js download page now?" IDNO +2
    ExecShell "open" "https://nodejs.org"
  ${EndIf}
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\Halo\Halo.lnk"
  Delete "$SMPROGRAMS\Halo\Halo App.lnk"
  Delete "$SMPROGRAMS\Halo\Uninstall Halo.lnk"
  RMDir "$SMPROGRAMS\Halo"
  Delete "$DESKTOP\Halo.lnk"

  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Halo"
  DeleteRegKey HKCU "Software\Halo"
SectionEnd
