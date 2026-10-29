; Rich psmux setup wizard additions (electron-builder nsis.include).
; Flow: License (nsis.license) -> Prerequisites (custom) -> Install -> Finish (summary + Run).
; Silent mode (/S) runs none of this: no detection, no prerequisite installs, no network, no log.
; Setup only reads ~/.claude and environment variables; it never writes them.

!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh

; Keep the folder of the earlier one-click installer (%LOCALAPPDATA%\Programs\rich-psmux). One-click used the sanitized
; package name; APP_PACKAGE_NAME is the raw package name with '/' -> '\', which is the same string for "rich-psmux".
; The assisted installer would otherwise default to the product name ("Rich psmux"). Upgrades use the registry location anyway.
!undef APP_FILENAME
!define APP_FILENAME "${APP_PACKAGE_NAME}"
; electron-builder defines this only when APP_FILENAME differs from the product file name; restore it so that
; "--delete-app-data" on uninstall still removes %APPDATA%\Rich psmux as before (uninstaller.nsh).
!define /ifndef APP_PRODUCT_FILENAME "${PRODUCT_FILENAME}"

; Per-user only: skip the "install for all users" (admin) page in the assisted installer.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Uninstall: also remove electron-builder's installer cache (%LOCALAPPDATA%\<package>-updater\installer.exe, a copy of
; the whole setup). The app has no auto-updater, so nothing else uses it. Kept on update runs (--updated), where the
; new version's setup is about to store its own copy there. Everything else the uninstaller does is unchanged.
!ifdef APP_INSTALLER_STORE_FILE
  !if "${APP_INSTALLER_STORE_FILE}" != "${APP_PACKAGE_NAME}-updater\installer.exe"
    !error "installer.nsh: unexpected installer cache path ${APP_INSTALLER_STORE_FILE}; update customUnInstall"
  !endif
!endif
!macro customUnInstall
  ${IfNot} ${isUpdated}
    ; The cache is always per user (same handling as electron-builder include/installer.nsh, where it is written)
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    ${If} $LOCALAPPDATA != ""
      RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
    ${EndIf}
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER

!define RP_WINGET_URL "https://learn.microsoft.com/windows/package-manager/winget/"
!define RP_PSMUX_ID "marlocarlo.psmux"
!define RP_PWSH_ID "Microsoft.PowerShell"
!define RP_WINGET_ARGS "-e --source winget --accept-package-agreements --accept-source-agreements"
!define RP_CLAUDE_PS_ARGS '-NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"'
; Short forms shown on the page and in the summary
!define RP_PSMUX_SHORT "winget install --id ${RP_PSMUX_ID} -e --source winget"
!define RP_PWSH_SHORT "winget install --id ${RP_PWSH_ID} -e --source winget"
!define RP_CLAUDE_SHORT 'powershell -Command "irm https://claude.ai/install.ps1 | iex"'
!define RP_TEAMS_KEY '"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"'

; Environment snapshot
Var RP_LocalAppData
Var RP_UserProfile
Var RP_PathProc
Var RP_PathUser
Var RP_PathSys
; PATH search scratch
Var RP_Name
Var RP_Found
Var RP_List
Var RP_Seg
Var RP_Idx
Var RP_Len
Var RP_Ch
Var RP_KeyLen
Var RP_MaxIdx
Var RP_PathWarn   ; buffered PATH read warnings, logged after the setup header
Var RP_Num
; Detected tools ("" = not found)
Var RP_WingetPath
Var RP_PsmuxPath
Var RP_PwshPath
Var RP_ClaudePath
Var RP_ClaudeOnPath   ; 1 = found on PATH (usable by the app), 0 = only at %USERPROFILE%\.local\bin
; State at the time the user confirmed the page
Var RP_Detected
Var RP_PsmuxPre
Var RP_PwshPre
Var RP_ClaudePre
Var RP_ClaudePreOnPath
Var RP_WantPsmux
Var RP_WantPwsh
Var RP_WantClaude
; Exit codes ("" = not run, "error" = could not start)
Var RP_CodePsmux
Var RP_CodePwsh
Var RP_CodeClaude
; Page controls
Var RP_Dlg
Var RP_Ctl
Var RP_Y
Var RP_ChkPsmux
Var RP_ChkPwsh
Var RP_ChkClaude
; Command runner / summary / checks
Var RP_Item
Var RP_Cmd
Var RP_Code
Var RP_Hex
Var RP_CodeSfx
Var RP_RIn
Var RP_RTok
Var RP_RVal
Var RP_Line
Var RP_Summary
Var RP_Val
Var RP_Bool
Var RP_Fh
Var RP_HasAgents
Var RP_HasCeo
Var RP_TeamsOn
Var RP_TeamsSrc
Var RP_TeamsTooBig
; Log
Var RP_LogFile
Var RP_LogOk   ; 1 once a line was written
Var RP_LogFh
Var RP_Msg
Var RP_T1
Var RP_T2
Var RP_T3
Var RP_T4
Var RP_T5
Var RP_T6
Var RP_T7

!include "${__FILEDIR__}\strings.nsh"

!macro RP_Log TEXT
  StrCpy $RP_Msg "${TEXT}"
  Call RP_Log
!macroend

; Appends "$RP_Msg" with a timestamp to %APPDATA%\rich-psmux\logs\installer.log (UTF-16LE, user names may be non-ASCII).
Function RP_Log
  ${If} $RP_LogFile == ""
    ReadEnvStr $RP_LogFile APPDATA
    ${If} $RP_LogFile == ""
      StrCpy $RP_LogFile $APPDATA
    ${EndIf}
    CreateDirectory "$RP_LogFile\rich-psmux\logs"
    StrCpy $RP_LogFile "$RP_LogFile\rich-psmux\logs\installer.log"
  ${EndIf}
  ClearErrors
  FileOpen $RP_LogFh $RP_LogFile a
  ${If} ${Errors}
    Return
  ${EndIf}
  FileSeek $RP_LogFh 0 END
  ${GetTime} "" "L" $RP_T1 $RP_T2 $RP_T3 $RP_T4 $RP_T5 $RP_T6 $RP_T7
  ClearErrors
  FileWriteUTF16LE /BOM $RP_LogFh "$RP_T3-$RP_T2-$RP_T1 $RP_T5:$RP_T6:$RP_T7 $RP_Msg$\r$\n"
  ${IfNot} ${Errors}
    StrCpy $RP_LogOk 1
  ${EndIf}
  FileClose $RP_LogFh
FunctionEnd

; Checks one PATH entry ($RP_Seg) for $RP_Name. Only absolute local drive paths count: UNC entries are skipped as in
; the app; relative entries and remote/missing drives are also skipped here (the app does not) so the page never
; waits on a disconnected network drive.
Function RP_CheckSeg
  ${Do}
    StrCpy $RP_Ch $RP_Seg 1
    ${If} $RP_Ch != " "
      ${ExitDo}
    ${EndIf}
    StrCpy $RP_Seg $RP_Seg "" 1
  ${Loop}
  ${Do}
    StrCpy $RP_Ch $RP_Seg 1 -1
    ${If} $RP_Ch != "\"
    ${AndIf} $RP_Ch != " "
      ${ExitDo}
    ${EndIf}
    StrCpy $RP_Seg $RP_Seg -1
  ${Loop}
  StrCpy $RP_Ch $RP_Seg 1 1
  ${If} $RP_Ch != ":"
    Return
  ${EndIf}
  ; DRIVE_NO_ROOT_DIR (1) = drive does not exist, DRIVE_REMOTE (4) = mapped network drive
  StrCpy $RP_Ch $RP_Seg 1
  Push "$RP_Ch:\"
  System::Call 'kernel32::GetDriveTypeW(w s) i .s'
  Pop $RP_Num
  ${If} $RP_Num == 1
  ${OrIf} $RP_Num == 4
    Return
  ${EndIf}
  ; a folder that happens to be named like the tool does not count
  ${If} ${FileExists} "$RP_Seg\$RP_Name"
  ${AndIfNot} ${FileExists} "$RP_Seg\$RP_Name\*.*"
    StrCpy $RP_Found "$RP_Seg\$RP_Name"
  ${EndIf}
FunctionEnd

; 1 in $RP_Bool if $RP_Val exists, is a reparse point and is not a directory (App Installer execution alias; rejects
; a junction/folder named like the alias), else 0.
Function RP_IsReparsePoint
  StrCpy $RP_Bool 0
  Push $RP_Val
  System::Call 'kernel32::GetFileAttributesW(w s) i .s'
  Pop $RP_Num
  ${If} $RP_Num != -1
    ; FILE_ATTRIBUTE_REPARSE_POINT (0x400) set, FILE_ATTRIBUTE_DIRECTORY (0x10) clear
    IntOp $RP_Num $RP_Num & 0x410
    ${If} $RP_Num = 0x400   ; integer compare (IntOp yields decimal)
      StrCpy $RP_Bool 1
    ${EndIf}
  ${EndIf}
FunctionEnd

; Searches the ';'-separated list $RP_List for $RP_Name; result in $RP_Found ("" if absent).
Function RP_SearchList
  StrCpy $RP_Found ""
  StrCpy $RP_Seg ""
  StrCpy $RP_Idx 0
  StrLen $RP_Len $RP_List
  ${Do}
    ${If} $RP_Idx < $RP_Len
      StrCpy $RP_Ch $RP_List 1 $RP_Idx
    ${Else}
      StrCpy $RP_Ch ";"
    ${EndIf}
    ${If} $RP_Ch == ";"
      Call RP_CheckSeg
      ${If} $RP_Found != ""
        Return
      ${EndIf}
      StrCpy $RP_Seg ""
    ${ElseIf} $RP_Ch != '"'
      StrCpy $RP_Seg "$RP_Seg$RP_Ch"
    ${EndIf}
    IntOp $RP_Idx $RP_Idx + 1
  ${LoopUntil} $RP_Idx > $RP_Len
FunctionEnd

; Finds $RP_Name on the process PATH, then the registry user/system PATH (they reflect installs made during this setup).
Function RP_FindExe
  StrCpy $RP_List $RP_PathProc
  Call RP_SearchList
  ${If} $RP_Found == ""
    StrCpy $RP_List $RP_PathUser
    Call RP_SearchList
  ${EndIf}
  ${If} $RP_Found == ""
    StrCpy $RP_List $RP_PathSys
    Call RP_SearchList
  ${EndIf}
FunctionEnd

; Sets $RP_Found to BASE\REST if still empty, BASE is set and it is an existing file (not a folder).
!macro RP_TryPath BASE REST
  ${If} $RP_Found == ""
  ${AndIf} ${BASE} != ""
  ${AndIf} ${FileExists} "${BASE}\${REST}"
  ${AndIfNot} ${FileExists} "${BASE}\${REST}\*.*"
    StrCpy $RP_Found "${BASE}\${REST}"
  ${EndIf}
!macroend

; PATH read problems are collected in $RP_PathWarn on the first detection only and logged by RP_RunPrereqs after its
; header line (no duplicates from the re-detection after installs). NSIS returns an empty string for a value longer
; than NSIS_MAX_STRLEN (8192 chars) and, for environment variables, does NOT set the error flag (verified), so an
; empty result is the signal. A missing HKCU Path value is normal and not reported.
!macro RP_PathWarn TEXT
  ${If} $RP_Detected != 1
    StrCpy $RP_PathWarn "$RP_PathWarn${TEXT}; "
  ${EndIf}
!macroend

; $RP_Num = data size in bytes of the "Path" value under ROOT\KEY, or -1 if the value does not exist.
!macro RP_RegPathSize ROOT KEY
  Push $0
  Push $1
  StrCpy $1 0
  ; RRF_RT_ANY | RRF_NOEXPAND, size query only (no buffer)
  System::Call 'advapi32::RegGetValueW(p ${ROOT}, w "${KEY}", w "Path", i 0x1000FFFF, p 0, p 0, *i r1 r1) i .r0'
  ${If} $0 == 0
    StrCpy $RP_Num $1
  ${Else}
    StrCpy $RP_Num -1
  ${EndIf}
  Pop $1
  Pop $0
!macroend

; Reads registry PATH ROOT\KEY into VAR (expanded); records a warning when the value exists but reads or expands empty.
!macro RP_ReadRegPath VAR ROOTNAME ROOT KEY LABEL
  ReadRegStr ${VAR} ${ROOTNAME} "${KEY}" "Path"
  ${If} ${VAR} == ""
    !insertmacro RP_RegPathSize ${ROOT} "${KEY}"
    ${If} $RP_Num != -1
      !insertmacro RP_PathWarn "${LABEL} exists ($RP_Num bytes) but reads empty (empty, or longer than 8191 characters)"
    ${EndIf}
  ${Else}
    ExpandEnvStrings ${VAR} ${VAR}
    ${If} ${VAR} == ""
      !insertmacro RP_PathWarn "${LABEL} is empty after expanding variables (longer than 8191 characters)"
    ${EndIf}
  ${EndIf}
!macroend

; Presence check by path only (nothing is executed). Mirrors src/main/psmux/env.ts lookups.
Function RP_Detect
  ReadEnvStr $RP_LocalAppData LOCALAPPDATA
  ReadEnvStr $RP_UserProfile USERPROFILE
  ${If} $RP_UserProfile == ""
    StrCpy $RP_UserProfile $PROFILE
  ${EndIf}
  ReadEnvStr $RP_PathProc PATH
  ${If} $RP_PathProc == ""
    !insertmacro RP_PathWarn "process PATH is empty or longer than 8191 characters"
  ${EndIf}
  ; HKEY_CURRENT_USER = 0x80000001, HKEY_LOCAL_MACHINE = 0x80000002
  !insertmacro RP_ReadRegPath $RP_PathUser HKCU 0x80000001 "Environment" "user PATH (HKCU\Environment)"
  !insertmacro RP_ReadRegPath $RP_PathSys HKLM 0x80000002 "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "system PATH (HKLM)"

  ; winget is executed, so only the App Installer alias counts (never a PATH match from a user-writable folder)
  StrCpy $RP_WingetPath ""
  ${If} $RP_LocalAppData != ""
    StrCpy $RP_Val "$RP_LocalAppData\Microsoft\WindowsApps\winget.exe"
    Call RP_IsReparsePoint
    ${If} $RP_Bool == 1
      StrCpy $RP_WingetPath $RP_Val
    ${EndIf}
  ${EndIf}

  StrCpy $RP_Name "psmux.exe"
  Call RP_FindExe
  !insertmacro RP_TryPath $RP_LocalAppData "Microsoft\WinGet\Packages\marlocarlo.psmux_Microsoft.Winget.Source_8wekyb3d8bbwe\psmux.exe"
  StrCpy $RP_PsmuxPath $RP_Found

  StrCpy $RP_Name "pwsh.exe"
  Call RP_FindExe
  !insertmacro RP_TryPath $RP_LocalAppData "Microsoft\WindowsApps\pwsh.exe"
  !insertmacro RP_TryPath $PROGRAMFILES64 "PowerShell\7\pwsh.exe"
  StrCpy $RP_PwshPath $RP_Found

  ; Native install is claude.exe, npm install is claude.cmd; the extensionless npm shell script is not usable
  StrCpy $RP_Name "claude.exe"
  Call RP_FindExe
  ${If} $RP_Found == ""
    StrCpy $RP_Name "claude.cmd"
    Call RP_FindExe
  ${EndIf}
  ; The app resolves claude from PATH only; the native-install location alone is reported as "not on PATH"
  StrCpy $RP_ClaudeOnPath 1
  ${If} $RP_Found == ""
    StrCpy $RP_ClaudeOnPath 0
  ${EndIf}
  !insertmacro RP_TryPath $RP_UserProfile ".local\bin\claude.exe"
  StrCpy $RP_ClaudePath $RP_Found
FunctionEnd

; $RP_Val -> $RP_Bool (1 if 1/true/yes/on, case-insensitive, same rule as the app).
Function RP_FlagOn
  StrCpy $RP_Bool 0
  ${Do}
    StrCpy $RP_Ch $RP_Val 1 -1
    ${If} $RP_Ch != " "
    ${AndIf} $RP_Ch != "$\t"
      ${ExitDo}
    ${EndIf}
    StrCpy $RP_Val $RP_Val -1
  ${Loop}
  ${Do}
    StrCpy $RP_Ch $RP_Val 1
    ${If} $RP_Ch != " "
    ${AndIf} $RP_Ch != "$\t"
      ${ExitDo}
    ${EndIf}
    StrCpy $RP_Val $RP_Val "" 1
  ${Loop}
  ${If} $RP_Val == "1"
  ${OrIf} $RP_Val == "true"
  ${OrIf} $RP_Val == "yes"
  ${OrIf} $RP_Val == "on"
    StrCpy $RP_Bool 1
  ${EndIf}
FunctionEnd

; Extracts the value following RP_TEAMS_KEY in $RP_Line into $RP_Val ("" if the key is absent).
; Guidance only, deliberately not a JSON parser. It can differ from the app, which reads only the top-level "env"
; object: the key is matched anywhere in the line (e.g. also in a nested object), and FileRead returns at most
; NSIS_MAX_STRLEN (8 KB) per read, so a key split across an 8 KB boundary is missed.
Function RP_TeamsValueInLine
  StrCpy $RP_Val ""
  ; Fast native prefilter (case-sensitive); the per-character scan below only runs on lines containing the key
  Push '${RP_TEAMS_KEY}'
  Push $RP_Line
  System::Call 'shlwapi::StrStrW(w s, w s) p .s'
  Pop $RP_Num
  ${If} $RP_Num == 0
    Return
  ${EndIf}
  StrLen $RP_Len $RP_Line
  StrLen $RP_KeyLen '${RP_TEAMS_KEY}'
  IntOp $RP_MaxIdx $RP_Len - $RP_KeyLen
  StrCpy $RP_Idx 0
  ${Do}
    ${If} $RP_Idx > $RP_MaxIdx
      Return
    ${EndIf}
    StrCpy $RP_Seg $RP_Line $RP_KeyLen $RP_Idx
    ${If} $RP_Seg S== '${RP_TEAMS_KEY}'
      ${ExitDo}
    ${EndIf}
    IntOp $RP_Idx $RP_Idx + 1
  ${Loop}
  IntOp $RP_Idx $RP_Idx + $RP_KeyLen
  ; skip blanks and ':' and an opening quote
  ${Do}
    StrCpy $RP_Ch $RP_Line 1 $RP_Idx
    ${If} $RP_Ch != " "
    ${AndIf} $RP_Ch != "$\t"
    ${AndIf} $RP_Ch != ":"
    ${AndIf} $RP_Ch != '"'
      ${ExitDo}
    ${EndIf}
    IntOp $RP_Idx $RP_Idx + 1
  ${LoopUntil} $RP_Idx >= $RP_Len
  ${Do}
    StrCpy $RP_Ch $RP_Line 1 $RP_Idx
    ${If} $RP_Ch == ""
    ${OrIf} $RP_Ch == '"'
    ${OrIf} $RP_Ch == ","
    ${OrIf} $RP_Ch == "}"
    ${OrIf} $RP_Ch == " "
    ${OrIf} $RP_Ch == "$\t"
    ${OrIf} $RP_Ch == "$\r"
    ${OrIf} $RP_Ch == "$\n"
      ${ExitDo}
    ${EndIf}
    StrCpy $RP_Val "$RP_Val$RP_Ch"
    IntOp $RP_Idx $RP_Idx + 1
  ${Loop}
FunctionEnd

; Agent Teams flag: process env -> user env (registry) -> ~/.claude/settings.json "env" (read only, line-based string
; match, see RP_TeamsValueInLine for its limits). Files over RP_SETTINGS_MAX bytes are not scanned (keeps the install
; page responsive). Sets $RP_TeamsOn, $RP_TeamsTooBig, $RP_TeamsSrc.
!define RP_SETTINGS_MAX 262144
Function RP_CheckTeams
  StrCpy $RP_TeamsOn 0
  StrCpy $RP_TeamsTooBig 0
  StrCpy $RP_TeamsSrc "none"
  ReadEnvStr $RP_Val CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  Call RP_FlagOn
  ${If} $RP_Bool == 1
    StrCpy $RP_TeamsOn 1
    StrCpy $RP_TeamsSrc "process environment"
    Return
  ${EndIf}
  ReadRegStr $RP_Val HKCU "Environment" "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"
  Call RP_FlagOn
  ${If} $RP_Bool == 1
    StrCpy $RP_TeamsOn 1
    StrCpy $RP_TeamsSrc "user environment variable"
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$RP_UserProfile\.claude\settings.json"
    Return
  ${EndIf}
  ClearErrors
  FileOpen $RP_Fh "$RP_UserProfile\.claude\settings.json" r
  ${If} ${Errors}
    !insertmacro RP_Log "Could not open settings.json for reading"
    Return
  ${EndIf}
  FileSeek $RP_Fh 0 END $RP_Num
  ${If} $RP_Num > ${RP_SETTINGS_MAX}
    FileClose $RP_Fh
    StrCpy $RP_TeamsTooBig 1
    StrCpy $RP_TeamsSrc "not checked: settings.json too large ($RP_Num bytes)"
    Return
  ${EndIf}
  FileSeek $RP_Fh 0 SET
  ${Do}
    ClearErrors
    FileRead $RP_Fh $RP_Line
    ${If} ${Errors}
      ${ExitDo}
    ${EndIf}
    Call RP_TeamsValueInLine
    ${If} $RP_Val != ""
      Call RP_FlagOn
      ${If} $RP_Bool == 1
        StrCpy $RP_TeamsOn 1
        StrCpy $RP_TeamsSrc "settings.json env"
        ${ExitDo}
      ${EndIf}
    ${EndIf}
  ${Loop}
  FileClose $RP_Fh
FunctionEnd

; ~/.claude/agents has at least one *.md file; ceo.md for the default lead command. Sets $RP_HasAgents/$RP_HasCeo.
Function RP_CheckAgents
  StrCpy $RP_HasAgents 0
  StrCpy $RP_HasCeo 0
  ClearErrors
  FindFirst $RP_Fh $RP_Val "$RP_UserProfile\.claude\agents\*.md"
  ${DoUntil} $RP_Val == ""
    ${IfNot} ${FileExists} "$RP_UserProfile\.claude\agents\$RP_Val\*.*"
      StrCpy $RP_HasAgents 1
      ${ExitDo}
    ${EndIf}
    FindNext $RP_Fh $RP_Val
  ${Loop}
  ${If} $RP_Fh != ""
    FindClose $RP_Fh
  ${EndIf}
  ${If} ${FileExists} "$RP_UserProfile\.claude\agents\ceo.md"
  ${AndIfNot} ${FileExists} "$RP_UserProfile\.claude\agents\ceo.md\*.*"
    StrCpy $RP_HasCeo 1
  ${EndIf}
FunctionEnd

; Runs $RP_Cmd for $RP_Item in its own console window and waits; exit code in $RP_Code ("error" if it could not start).
Function RP_RunCmd
  !insertmacro RP_Log "$RP_Item: running $RP_Cmd"
  SetDetailsPrint textonly
  DetailPrint "$(RP_Installing) $RP_Item"
  SetDetailsPrint none
  ClearErrors
  ExecWait $RP_Cmd $RP_Code
  ${If} ${Errors}
    StrCpy $RP_Code "error"
    !insertmacro RP_Log "$RP_Item: command could not be started"
  ${Else}
    IntFmt $RP_Hex "0x%08X" $RP_Code
    !insertmacro RP_Log "$RP_Item: exit code $RP_Code ($RP_Hex)"
  ${EndIf}
FunctionEnd

; Replaces the first $RP_RTok in $RP_RIn with $RP_RVal (in place). Used for {P}/{C} tokens in translated templates.
Function RP_ReplaceToken
  StrLen $RP_KeyLen $RP_RTok
  StrLen $RP_Len $RP_RIn
  StrCpy $RP_Idx 0
  ${DoWhile} $RP_Idx < $RP_Len
    StrCpy $RP_Seg $RP_RIn $RP_KeyLen $RP_Idx
    ${If} $RP_Seg S== $RP_RTok
      StrCpy $RP_Seg ""
      ${If} $RP_Idx > 0
        StrCpy $RP_Seg $RP_RIn $RP_Idx
      ${EndIf}
      IntOp $RP_MaxIdx $RP_Idx + $RP_KeyLen
      StrCpy $RP_Ch $RP_RIn "" $RP_MaxIdx
      StrCpy $RP_RIn "$RP_Seg$RP_RVal$RP_Ch"
      Return
    ${EndIf}
    IntOp $RP_Idx $RP_Idx + 1
  ${Loop}
FunctionEnd

; $RP_Line = "found at PATH<code suffix>, but ... not on PATH ..." from the RP_SumNotOnPath template.
; {C} is filled first so that a path containing "{C}" is not touched.
!macro RP_NotOnPathLine PATH
  StrCpy $RP_RIn "$(RP_SumNotOnPath)"
  StrCpy $RP_RTok "{C}"
  StrCpy $RP_RVal $RP_CodeSfx
  Call RP_ReplaceToken
  StrCpy $RP_RTok "{P}"
  StrCpy $RP_RVal "${PATH}"
  Call RP_ReplaceToken
  StrCpy $RP_Line $RP_RIn
!macroend

; Appends "NAME: status" for one prerequisite to $RP_Summary.
; PRE/NOW = path before/after the installs, PREOK/NOWOK = 1 if usable by the app (0 = found but not on PATH).
!macro RP_SumItem NAME PRE PREOK WANT CODE NOW NOWOK NEEDWINGET SHORT
  StrCpy $RP_Line ""
  ${If} "${PRE}" != ""
    ${If} "${PREOK}" == 1
      StrCpy $RP_Line "$(RP_SumFound)"
    ${Else}
      StrCpy $RP_CodeSfx ""
      !insertmacro RP_NotOnPathLine "${PRE}"
    ${EndIf}
  ${ElseIf} "${WANT}" == 1
    ${If} "${NOW}" != ""
      ; Detected after the run counts as installed, whatever the exit code; a non-zero code is shown (dec + hex)
      ; right after the status, before any advice sentence
      StrCpy $RP_CodeSfx ""
      ${If} "${CODE}" != "0"
      ${AndIf} "${CODE}" != "error"
      ${AndIf} "${CODE}" != ""
        IntFmt $RP_Hex "0x%08X" "${CODE}"
        StrCpy $RP_CodeSfx " ($(RP_ExitCode) ${CODE}, $RP_Hex)"
      ${EndIf}
      ${If} "${NOWOK}" == 1
        StrCpy $RP_Line "$(RP_SumInstalled)$RP_CodeSfx"
      ${Else}
        !insertmacro RP_NotOnPathLine "${NOW}"
      ${EndIf}
    ${ElseIf} "${CODE}" == "error"
      StrCpy $RP_Line "$(RP_SumNoStart)"
    ${ElseIf} "${CODE}" != "0"
      IntFmt $RP_Hex "0x%08X" "${CODE}"
      StrCpy $RP_Line "$(RP_SumFailed) ${CODE} ($RP_Hex)"
    ${Else}
      StrCpy $RP_Line "$(RP_SumNotDetected)"
    ${EndIf}
  ${ElseIf} "${NEEDWINGET}" == 1
  ${AndIf} $RP_WingetPath == ""
    StrCpy $RP_Line "$(RP_SumNoWinget) ${RP_WINGET_URL}"
  ${Else}
    StrCpy $RP_Line `$(RP_SumSkipped) ${SHORT}`
  ${EndIf}
  StrCpy $RP_Summary "$RP_Summary${NAME}: $RP_Line$\r$\n"
  !insertmacro RP_Log "Result ${NAME}: $RP_Line"
!macroend

; Install-section step (interactive only): run the checked prerequisite installers, re-detect, build the finish summary.
Function RP_RunPrereqs
  ${If} $RP_Detected != 1
    ; Prerequisites page was not shown (--updated run or page error): detect for the summary, install nothing
    Call RP_Detect
    StrCpy $RP_PsmuxPre $RP_PsmuxPath
    StrCpy $RP_PwshPre $RP_PwshPath
    StrCpy $RP_ClaudePre $RP_ClaudePath
    StrCpy $RP_ClaudePreOnPath $RP_ClaudeOnPath
    StrCpy $RP_WantPsmux 0
    StrCpy $RP_WantPwsh 0
    StrCpy $RP_WantClaude 0
    StrCpy $RP_Detected 1
  ${EndIf}
  !insertmacro RP_Log "=== Rich psmux ${VERSION} setup: prerequisites ==="
  ${If} $RP_PathWarn != ""
    StrCpy $RP_PathWarn $RP_PathWarn -2   ; drop the trailing "; "
    !insertmacro RP_Log "Warning: PATH not fully searched: $RP_PathWarn"
  ${EndIf}
  !insertmacro RP_Log "Detected winget: $RP_WingetPath"
  !insertmacro RP_Log "Detected psmux: $RP_PsmuxPre"
  !insertmacro RP_Log "Detected PowerShell 7: $RP_PwshPre"
  !insertmacro RP_Log "Detected Claude Code: $RP_ClaudePre (on PATH: $RP_ClaudePreOnPath)"
  !insertmacro RP_Log "Selected installs: psmux=$RP_WantPsmux pwsh=$RP_WantPwsh claude=$RP_WantClaude"

  StrCpy $RP_CodePsmux ""
  StrCpy $RP_CodePwsh ""
  StrCpy $RP_CodeClaude ""

  ${If} $RP_WantPsmux == 1
  ${AndIf} $RP_WingetPath != ""
    StrCpy $RP_Item "psmux"
    StrCpy $RP_Cmd '"$RP_WingetPath" install --id ${RP_PSMUX_ID} ${RP_WINGET_ARGS}'
    Call RP_RunCmd
    StrCpy $RP_CodePsmux $RP_Code
  ${EndIf}
  ${If} $RP_WantPwsh == 1
  ${AndIf} $RP_WingetPath != ""
    StrCpy $RP_Item "PowerShell 7"
    StrCpy $RP_Cmd '"$RP_WingetPath" install --id ${RP_PWSH_ID} ${RP_WINGET_ARGS}'
    Call RP_RunCmd
    StrCpy $RP_CodePwsh $RP_Code
  ${EndIf}
  ${If} $RP_WantClaude == 1
    StrCpy $RP_Item "Claude Code"
    ; Native (64-bit) Windows PowerShell: this setup is a 32-bit process, so System32 would be redirected
    ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
      StrCpy $RP_Cmd '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" ${RP_CLAUDE_PS_ARGS}'
    ${Else}
      StrCpy $RP_Cmd '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" ${RP_CLAUDE_PS_ARGS}'
    ${EndIf}
    Call RP_RunCmd
    StrCpy $RP_CodeClaude $RP_Code
  ${EndIf}

  ${If} $RP_WantPsmux$RP_WantPwsh$RP_WantClaude != "000"
    Call RP_Detect
    !insertmacro RP_Log "Re-detected psmux: $RP_PsmuxPath | PowerShell 7: $RP_PwshPath | Claude Code: $RP_ClaudePath (on PATH: $RP_ClaudeOnPath)"
  ${EndIf}

  StrCpy $RP_Summary "$(RP_SumHeader)$\r$\n"
  !insertmacro RP_SumItem "psmux" $RP_PsmuxPre 1 $RP_WantPsmux $RP_CodePsmux $RP_PsmuxPath 1 1 "${RP_PSMUX_SHORT}"
  !insertmacro RP_SumItem "PowerShell 7" $RP_PwshPre 1 $RP_WantPwsh $RP_CodePwsh $RP_PwshPath 1 1 "${RP_PWSH_SHORT}"
  !insertmacro RP_SumItem "Claude Code" $RP_ClaudePre $RP_ClaudePreOnPath $RP_WantClaude $RP_CodeClaude $RP_ClaudePath $RP_ClaudeOnPath 0 '${RP_CLAUDE_SHORT}'

  StrCpy $RP_Summary "$RP_Summary$\r$\n"
  Call RP_CheckAgents
  ${If} $RP_HasAgents == 1
    StrCpy $RP_Summary "$RP_Summary$(RP_AgentsOk)$\r$\n"
  ${Else}
    StrCpy $RP_Summary "$RP_Summary$(RP_AgentsMissing)$\r$\n"
  ${EndIf}
  ${If} $RP_HasCeo != 1
    StrCpy $RP_Summary "$RP_Summary$(RP_CeoMissing)$\r$\n"
  ${EndIf}
  Call RP_CheckTeams
  ${If} $RP_TeamsOn == 1
    StrCpy $RP_Summary "$RP_Summary$(RP_TeamsOn)$\r$\n"
  ${ElseIf} $RP_TeamsTooBig == 1
    StrCpy $RP_Summary "$RP_Summary$(RP_TeamsTooBig)$\r$\n"
  ${Else}
    StrCpy $RP_Summary "$RP_Summary$(RP_TeamsOff)$\r$\n"
  ${EndIf}
  !insertmacro RP_Log "Agents: any *.md=$RP_HasAgents ceo.md=$RP_HasCeo | Agent Teams: $RP_TeamsOn ($RP_TeamsSrc)"
  ; Log path first: the box needs scrolling, so the most useful pointer stays visible
  ${If} $RP_LogOk == 1
    StrCpy $RP_Summary "$(RP_LogLabel) $RP_LogFile$\r$\n$\r$\n$RP_Summary"
  ${EndIf}
FunctionEnd

!macro customInstall
  ${IfNot} ${Silent}
    Call RP_RunPrereqs
  ${EndIf}
!macroend

; One row at $RP_Y (dialog units), advancing $RP_Y: "NAME: Found" + path, "found but not on PATH" + path (OK=0),
; or a checkbox to install + the command (disabled when winget is required but missing).
; Path/command labels use SS_NOPREFIX so '&' in a path is shown, not turned into a mnemonic.
!macro RP_PageRow NAME PATH OK WANT CHK NEEDWINGET SHORT
  StrCpy ${CHK} ""
  ${If} "${PATH}" != ""
    ${If} "${OK}" == 1
      ${NSD_CreateLabel} 0u $RP_Yu 100% 10u "${NAME}: $(RP_Found)"
      Pop $RP_Ctl
      IntOp $RP_Y $RP_Y + 10
    ${Else}
      ${NSD_CreateLabel} 0u $RP_Yu 100% 18u "${NAME}: $(RP_FoundNotOnPath)"
      Pop $RP_Ctl
      IntOp $RP_Y $RP_Y + 18
    ${EndIf}
    ${NSD_CreateLabel} 12u $RP_Yu 288u 9u "${PATH}"
    Pop $RP_Ctl
    ${NSD_AddStyle} $RP_Ctl ${SS_PATHELLIPSIS}|${SS_NOPREFIX}
  ${ElseIf} "${NEEDWINGET}" == 1
  ${AndIf} $RP_WingetPath == ""
    ${NSD_CreateCheckbox} 0u $RP_Yu 100% 10u "${NAME}: $(RP_NeedsWinget)"
    Pop $RP_Ctl
    EnableWindow $RP_Ctl 0
    IntOp $RP_Y $RP_Y + 10
    ${NSD_CreateLabel} 12u $RP_Yu 288u 9u `${SHORT}`
    Pop $RP_Ctl
    ${NSD_AddStyle} $RP_Ctl ${SS_NOPREFIX}
  ${Else}
    ${NSD_CreateCheckbox} 0u $RP_Yu 100% 10u "${NAME}: $(RP_InstallNow)"
    Pop ${CHK}
    ${If} "${WANT}" == 1
      ${NSD_Check} ${CHK}
    ${EndIf}
    ${NSD_OnClick} ${CHK} RP_OnCheck
    IntOp $RP_Y $RP_Y + 10
    ${NSD_CreateLabel} 12u $RP_Yu 288u 9u `${SHORT}`
    Pop $RP_Ctl
    ${NSD_AddStyle} $RP_Ctl ${SS_NOPREFIX}
  ${EndIf}
  IntOp $RP_Y $RP_Y + 11
!macroend

; Inserted by electron-builder after the license page, before the install page.
!macro customPageAfterChangeDir
  Page custom RP_PrereqPre RP_PrereqLeave

  Function RP_PrereqPre
    ; Update runs (--updated) skip this page like the license page; nothing is installed then
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ${If} $RP_Detected != 1
      Call RP_Detect
      StrCpy $RP_PsmuxPre $RP_PsmuxPath
      StrCpy $RP_PwshPre $RP_PwshPath
      StrCpy $RP_ClaudePre $RP_ClaudePath
      StrCpy $RP_ClaudePreOnPath $RP_ClaudeOnPath
      ; Missing items are checked by default; winget-based ones only when winget exists.
      ; Claude found only outside PATH gets guidance, not an install.
      StrCpy $RP_WantPsmux 0
      StrCpy $RP_WantPwsh 0
      StrCpy $RP_WantClaude 0
      ${If} $RP_PsmuxPre == ""
      ${AndIf} $RP_WingetPath != ""
        StrCpy $RP_WantPsmux 1
      ${EndIf}
      ${If} $RP_PwshPre == ""
      ${AndIf} $RP_WingetPath != ""
        StrCpy $RP_WantPwsh 1
      ${EndIf}
      ${If} $RP_ClaudePre == ""
        StrCpy $RP_WantClaude 1
      ${EndIf}
      StrCpy $RP_Detected 1
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "$(RP_PageTitle)" "$(RP_PageSubtitle)"
    nsDialogs::Create 1018
    Pop $RP_Dlg
    ${If} $RP_Dlg == error
      ; The user never saw the choices: install nothing
      StrCpy $RP_WantPsmux 0
      StrCpy $RP_WantPwsh 0
      StrCpy $RP_WantClaude 0
      Abort
    ${EndIf}

    ; Layout (page is 300u x 140u): intro 2 lines, winget 1 line (or 2 lines + link), 3 rows, note 2 lines
    ${NSD_CreateLabel} 0u 0u 100% 18u "$(RP_PageIntro)"
    Pop $RP_Ctl
    ${If} $RP_WingetPath != ""
      ${NSD_CreateLabel} 0u 20u 100% 10u "$(RP_WingetFound)"
      Pop $RP_Ctl
      StrCpy $RP_Y 32
    ${Else}
      ${NSD_CreateLabel} 0u 20u 100% 18u "$(RP_WingetMissing)"
      Pop $RP_Ctl
      ${NSD_CreateLink} 12u 38u 288u 10u "${RP_WINGET_URL}"
      Pop $RP_Ctl
      ${NSD_OnClick} $RP_Ctl RP_OnWingetLink
      StrCpy $RP_Y 50
    ${EndIf}

    !insertmacro RP_PageRow "psmux" $RP_PsmuxPre 1 $RP_WantPsmux $RP_ChkPsmux 1 "${RP_PSMUX_SHORT}"
    !insertmacro RP_PageRow "PowerShell 7" $RP_PwshPre 1 $RP_WantPwsh $RP_ChkPwsh 1 "${RP_PWSH_SHORT}"
    !insertmacro RP_PageRow "Claude Code" $RP_ClaudePre $RP_ClaudePreOnPath $RP_WantClaude $RP_ChkClaude 0 '${RP_CLAUDE_SHORT}'

    ; Note fills the rest with a 2u bottom margin. Rows are 21u (29u for "not on PATH"): usual case leaves 43u,
    ; worst case (winget missing + Claude not on PATH: 50+21+21+29) leaves 17u = 2 lines
    IntOp $RP_Num 138 - $RP_Y
    ${NSD_CreateLabel} 0u $RP_Yu 100% $RP_Numu "$(RP_PageNote)"
    Pop $RP_Ctl

    nsDialogs::Show
  FunctionEnd

  Function RP_OnWingetLink
    Pop $RP_Ctl
    ExecShell "open" "${RP_WINGET_URL}"
  FunctionEnd

  ; Keeps checkbox state on every click, so going Back and Next again keeps the user's choices
  Function RP_OnCheck
    Pop $RP_Ctl
    ${If} $RP_Ctl == $RP_ChkPsmux
      ${NSD_GetState} $RP_Ctl $RP_WantPsmux
    ${ElseIf} $RP_Ctl == $RP_ChkPwsh
      ${NSD_GetState} $RP_Ctl $RP_WantPwsh
    ${ElseIf} $RP_Ctl == $RP_ChkClaude
      ${NSD_GetState} $RP_Ctl $RP_WantClaude
    ${EndIf}
  FunctionEnd

  Function RP_PrereqLeave
    ${If} $RP_ChkPsmux != ""
      ${NSD_GetState} $RP_ChkPsmux $RP_WantPsmux
    ${EndIf}
    ${If} $RP_ChkPwsh != ""
      ${NSD_GetState} $RP_ChkPwsh $RP_WantPwsh
    ${EndIf}
    ${If} $RP_ChkClaude != ""
      ${NSD_GetState} $RP_ChkClaude $RP_WantClaude
    ${EndIf}
  FunctionEnd
!macroend

; Standard finish page (Run checkbox kept) plus a read-only, scrolling summary box below it.
; Geometry follows MUI2 Contrib\Modern UI 2\Pages\Finish.nsh (all at x=120u, w=195u; the page is 193u tall):
;   title 10u h28u (ends 38u), text 45u h40u (ends 85u), Run checkbox 90u h10u (ends 100u) -> box 103u..187u.
; Without the checkbox MUI2 makes the text 130u tall and the box would overlap it, so nsis.runAfterFinish must stay
; enabled; the 3-line title / large text variants would move the checkbox down, so they are rejected too.
!ifdef HIDE_RUN_AFTER_FINISH
  !error "installer.nsh: the finish summary layout needs the Run checkbox; keep nsis.runAfterFinish enabled"
!endif
!ifdef MUI_FINISHPAGE_TITLE_3LINES | MUI_FINISHPAGE_TEXT_LARGE
  !error "installer.nsh: the finish summary layout assumes the default MUI2 title/text heights"
!endif
!define /math RP_SUM_TOP 90 + 13          ; checkbox top + 10u height + 3u gap
!define /math RP_SUM_HEIGHT 187 - ${RP_SUM_TOP}
!macro customFinishPage
  ; Same as electron-builder's default StartApp
  Function RP_StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "RP_StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW RP_FinishShow
  !insertmacro MUI_PAGE_FINISH

  Function RP_FinishShow
    ${If} $RP_Summary == ""
      Return
    ${EndIf}
    nsDialogs::CreateControl EDIT ${DEFAULT_STYLES}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL} ${WS_EX_CLIENTEDGE} 120u ${RP_SUM_TOP}u 195u ${RP_SUM_HEIGHT}u "$RP_Summary"
    Pop $RP_Ctl
  FunctionEnd
!macroend

!endif ; BUILD_UNINSTALLER
