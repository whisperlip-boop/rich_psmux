; Rich psmux installer: all custom UI strings (English 1033, Korean 1042).
; To add a language: add the locale to build.nsis.installerLanguages in package.json and one LangString per id below.
; Numeric language ids are used because this file is included before electron-builder inserts MUI_LANGUAGE.
; Strings contain no NSIS variables; item names, codes and paths are appended in code, or filled into {P}/{C} tokens
; where the word order differs per language. NSIS rejects empty LangStrings (warning 6040), so none may be "".

; Prerequisites page
LangString RP_PageTitle 1033 "Prerequisites"
LangString RP_PageTitle 1042 "필수 구성 요소"
LangString RP_PageSubtitle 1033 "Rich psmux needs psmux, PowerShell 7 and Claude Code."
LangString RP_PageSubtitle 1042 "Rich psmux를 쓰려면 psmux, PowerShell 7, Claude Code가 필요합니다."
LangString RP_PageIntro 1033 "Checked items are installed right after the app. Uncheck an item to install it yourself later."
LangString RP_PageIntro 1042 "체크한 항목은 앱 설치 직후 이어서 설치됩니다. 직접 설치하려면 체크를 해제하세요."
LangString RP_WingetFound 1033 "winget (Windows Package Manager): Found"
LangString RP_WingetFound 1042 "winget(Windows 패키지 관리자): 있음"
LangString RP_WingetMissing 1033 "winget (Windows Package Manager): Not found. Needed to install psmux and PowerShell 7:"
LangString RP_WingetMissing 1042 "winget(Windows 패키지 관리자): 없음. psmux와 PowerShell 7 설치에 필요합니다:"
LangString RP_Found 1033 "Found"
LangString RP_Found 1042 "있음"
LangString RP_FoundNotOnPath 1033 "Found, but not on PATH. Add %USERPROFILE%\.local\bin to your user PATH."
LangString RP_FoundNotOnPath 1042 "있지만 PATH에 없음. %USERPROFILE%\.local\bin 을 사용자 PATH에 추가하세요."
LangString RP_InstallNow 1033 "Not found. Install now"
LangString RP_InstallNow 1042 "없음. 지금 설치"
LangString RP_NeedsWinget 1033 "Not found. Requires winget (install it yourself)"
LangString RP_NeedsWinget 1042 "없음. winget이 필요합니다(직접 설치하세요)"
LangString RP_PageNote 1033 "Checked items run in console windows after the app is installed. PowerShell 7 may ask for administrator (UAC) approval."
LangString RP_PageNote 1042 "체크한 항목은 앱 설치 후 콘솔 창에서 실행됩니다. PowerShell 7은 관리자 권한(UAC) 승인을 요청할 수 있습니다."

; Install progress (status line)
LangString RP_Installing 1033 "Installing (see the console window):"
LangString RP_Installing 1042 "설치 중(콘솔 창을 확인하세요):"

; Finish page summary
LangString RP_SumHeader 1033 "Setup summary"
LangString RP_SumHeader 1042 "설치 요약"
LangString RP_SumFound 1033 "already installed"
LangString RP_SumFound 1042 "이미 설치됨"
LangString RP_SumInstalled 1033 "installed"
LangString RP_SumInstalled 1042 "설치됨"
LangString RP_ExitCode 1033 "exit code"
LangString RP_ExitCode 1042 "종료 코드"
; Template: {P} = path, {C} = " (exit code N, 0xHEX)" or nothing; both are replaced in code (keep both tokens).
LangString RP_SumNotOnPath 1033 "found at {P}{C}, but %USERPROFILE%\.local\bin is not on PATH. Add it to your user PATH."
LangString RP_SumNotOnPath 1042 "{P}에 있지만{C} %USERPROFILE%\.local\bin이 PATH에 없습니다. 사용자 PATH에 추가하세요."
LangString RP_SumNotDetected 1033 "installer finished (exit code 0) but it was not found yet. Sign out and back in, or check PATH."
LangString RP_SumNotDetected 1042 "설치 프로그램은 끝났지만(종료 코드 0) 아직 찾을 수 없습니다. 로그아웃 후 다시 로그인하거나 PATH를 확인하세요."
LangString RP_SumFailed 1033 "install failed, exit code"
LangString RP_SumFailed 1042 "설치 실패, 종료 코드"
LangString RP_SumNoStart 1033 "install command could not be started"
LangString RP_SumNoStart 1042 "설치 명령을 실행할 수 없습니다"
LangString RP_SumSkipped 1033 "not installed (unchecked). Install it yourself:"
LangString RP_SumSkipped 1042 "설치 안 함(체크 해제). 직접 설치:"
LangString RP_SumNoWinget 1033 "not installed. winget is required:"
LangString RP_SumNoWinget 1042 "설치 안 됨. winget이 필요합니다:"
LangString RP_AgentsOk 1033 "Agent definitions: found in %USERPROFILE%\.claude\agents."
LangString RP_AgentsOk 1042 "에이전트 정의: %USERPROFILE%\.claude\agents 에 있음."
LangString RP_AgentsMissing 1033 "Agent definitions: none. Create agent definitions in %USERPROFILE%\.claude\agents (see README)."
LangString RP_AgentsMissing 1042 "에이전트 정의: 없음. %USERPROFILE%\.claude\agents 에 에이전트 정의를 만드세요(README 참고)."
LangString RP_CeoMissing 1033 "The default lead command 'claude --agent ceo' needs %USERPROFILE%\.claude\agents\ceo.md."
LangString RP_CeoMissing 1042 "기본 리드 명령 'claude --agent ceo' 에는 %USERPROFILE%\.claude\agents\ceo.md 가 필요합니다."
LangString RP_TeamsOn 1033 "Agent Teams: enabled."
LangString RP_TeamsOn 1042 "Agent Teams: 켜짐."
LangString RP_TeamsOff 1033 'Agent Teams: off. To enable, add "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" under "env" in %USERPROFILE%\.claude\settings.json, or set the user environment variable CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1. Setup does not change either.'
LangString RP_TeamsOff 1042 'Agent Teams: 꺼짐. 켜려면 %USERPROFILE%\.claude\settings.json 의 "env" 아래에 "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" 을 넣거나, 사용자 환경 변수 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 을 설정하세요. 설치 프로그램은 둘 다 바꾸지 않습니다.'
LangString RP_TeamsTooBig 1033 "Agent Teams: not checked (settings.json is larger than 256 KB)."
LangString RP_TeamsTooBig 1042 "Agent Teams: 확인 안 함(settings.json이 256 KB보다 큼)."
LangString RP_LogLabel 1033 "Log:"
LangString RP_LogLabel 1042 "로그:"
