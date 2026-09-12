; ============================================================================
; Pico installer.
;
; A real Windows installer with the wizard people expect: welcome, choose a
; folder, install, finish with a "Launch Pico now" option. No script to
; right-click, no execution-policy prompt, no file that opens in Notepad
; instead of running.
;
; Per-user install (no admin rights, no UAC prompt) into
; %LOCALAPPDATA%\Programs\Pico, with Start-menu/Desktop shortcuts and a
; normal entry in "Add or remove programs".
;
; Built with: makensis -DSTAGEDIR=<staged app folder> -DOUTFILE=<output .exe> installer.nsi
; STAGEDIR must already contain "Start Pico.cmd", pico-ui/, phone/, bridge/,
; etc. — the same layout release.yml assembles for Pico-latest.zip.
; ============================================================================

!ifndef STAGEDIR
  !define STAGEDIR "..\out\Pico"
!endif
!ifndef OUTFILE
  !define OUTFILE "..\out\Pico-Setup.exe"
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "Pico"
OutFile "${OUTFILE}"
Unicode true
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Pico"
InstallDirRegKey HKCU "Software\Pico" "InstallDir"
SetCompressor /SOLID lzma

!define MUI_ICON "pico.ico"
!define MUI_UNICON "pico.ico"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Pico setup"
!define MUI_WELCOMEPAGE_TEXT "This installs Pico, a desktop agent that works your screen — clicking, typing, scrolling — and stops to ask you before anything it can't undo.$\r$\n$\r$\nNode.js must already be on this computer; setup checks for it and tells you if it's missing.$\r$\n$\r$\nClick Next to choose where to install it."

!define MUI_FINISHPAGE_RUN "$INSTDIR\Start Pico.cmd"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Pico now"
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
  WriteRegStr HKCU "Software\Pico" "InstallDir" "$INSTDIR"

  CreateDirectory "$SMPROGRAMS\Pico"
  CreateShortCut "$SMPROGRAMS\Pico\Pico.lnk" "$INSTDIR\Start Pico.cmd" "" "$INSTDIR\phone\icons\icon-192.png" 0 SW_SHOWMINIMIZED
  CreateShortCut "$SMPROGRAMS\Pico\Uninstall Pico.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\Pico.lnk" "$INSTDIR\Start Pico.cmd" "" "$INSTDIR\phone\icons\icon-192.png" 0 SW_SHOWMINIMIZED

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pico" "DisplayName" "Pico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pico" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pico" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pico" "DisplayIcon" "$INSTDIR\phone\icons\icon-192.png"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pico" "Publisher" "Pico"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pico" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pico" "NoRepair" 1

  ; Node.js is a hard requirement; Start Pico.cmd also checks, but tell people
  ; up front rather than after they think setup finished successfully.
  nsExec::ExecToStack 'node --version'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_YESNO "Pico also needs Node.js, which wasn't found on this computer.$\r$\n$\r$\nOpen the Node.js download page now?" IDNO +2
    ExecShell "open" "https://nodejs.org"
  ${EndIf}
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\Pico\Pico.lnk"
  Delete "$SMPROGRAMS\Pico\Uninstall Pico.lnk"
  RMDir "$SMPROGRAMS\Pico"
  Delete "$DESKTOP\Pico.lnk"

  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pico"
  DeleteRegKey HKCU "Software\Pico"
SectionEnd
