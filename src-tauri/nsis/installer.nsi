!include "MUI2.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE define is required"
!endif
!ifndef PAYLOAD_DIR
  !error "PAYLOAD_DIR define is required"
!endif

Unicode True
Name "PDF Resizer"
OutFile "${OUTPUT_FILE}"
InstallDir "$PROGRAMFILES64\PDF Resizer"
InstallDirRegKey HKLM "Software\PDF Resizer" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetShellVarContext all
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD_DIR}\*"

  WriteRegStr HKLM "Software\PDF Resizer" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall PDF Resizer.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PDF Resizer" "DisplayName" "PDF Resizer"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PDF Resizer" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PDF Resizer" "Publisher" "PDF Resizer"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PDF Resizer" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PDF Resizer" "UninstallString" "$\"$INSTDIR\Uninstall PDF Resizer.exe$\""
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PDF Resizer" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PDF Resizer" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\PDF Resizer"
  CreateShortcut "$SMPROGRAMS\PDF Resizer\PDF Resizer.lnk" "$INSTDIR\PDF Resizer.exe"
  CreateShortcut "$SMPROGRAMS\PDF Resizer\Uninstall PDF Resizer.lnk" "$INSTDIR\Uninstall PDF Resizer.exe"
  CreateShortcut "$DESKTOP\PDF Resizer.lnk" "$INSTDIR\PDF Resizer.exe"
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  Delete "$DESKTOP\PDF Resizer.lnk"
  Delete "$SMPROGRAMS\PDF Resizer\PDF Resizer.lnk"
  Delete "$SMPROGRAMS\PDF Resizer\Uninstall PDF Resizer.lnk"
  RMDir "$SMPROGRAMS\PDF Resizer"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\PDF Resizer"
  DeleteRegKey HKLM "Software\PDF Resizer"
  RMDir /r "$INSTDIR"
SectionEnd
