// main ↔ renderer 공용 타입(preload가 노출하는 window.ctd).

import type { Lang } from './i18n';
import type { UsageDto } from './usage';

export type { UsageDto } from './usage';

/** 카드 이름표. */
export interface PaneLabelView {
  name: string;
  color: string;
  textColor: string;
  agentType?: string;
  isLead: boolean;
  source: 'lead' | 'config' | 'hook' | 'cache' | 'fallback';
}

/** 칸 상태. */
export interface PaneViewDto {
  paneId: string;
  windowId: string;
  cols: number;
  rows: number;
  label: PaneLabelView;
  working: boolean;
  waiting: boolean;
}

/** 탭 상태. */
export interface TabStateDto {
  tabId: string;
  session: string;
  folder: string;
  status: 'starting' | 'connected' | 'reconnecting' | 'ended' | 'error';
  leadPaneId: string | null;
  /** 에이전트 없는 Claude만 탭(탭 바 ▾ 메뉴, 리드 명령 `claude`). 탭 툴팁에 표시. */
  plain: boolean;
  teamName: string | null;
  panes: PaneViewDto[];
  error?: string;
  hooksEnabled: boolean;
  /** 리드에서 실행 중인 대화 ID(모르면 null). 사이드바 강조·중복 실행 방지 기준. */
  leadSessionId: string | null;
  /** -r 로 이어간 원래 대화 ID(새 대화면 null). 이어가기 안내 배너 표시 기준. */
  resumeSessionId: string | null;
  /** 리드 칸 종료(세션은 살아 있음). */
  leadGone: boolean;
  /** 종료 처리 중. */
  terminating: boolean;
  createdAt: number;
  /** 탭 용도: 일반 대화 / 로그인 전용(F7-2, 칸에서 claude auth login 실행). */
  purpose: 'conversation' | 'login';
  /** 로그인 탭: 프로세스가 끝났는데 로그인이 확인되지 않음(카드 배너). */
  loginFailed: boolean;
}

/** 사이드바 대화 항목. */
export interface HistoryItemDto {
  sessionId: string;
  /** 제목(없으면 null → 폴더명 + 시각으로 대체 표시). */
  title: string | null;
  cwd: string | null;
  /** 폴더 그룹 키(대소문자 무시). */
  folderKey: string;
  folderName: string;
  mtimeMs: number;
  /** 첫 레코드 시각(없으면 null). 정렬 "생성 날짜"(F2-2)는 없으면 mtimeMs로 대체. */
  createdMs: number | null;
  kind: 'session' | 'lead' | 'sdk';
  /** 이 대화(리드)에 묶인 팀원 대화 파일 수. */
  mates: number;
  /** 앱 저장소 키(`<프로젝트 폴더>/<파일>`, 인덱서 keyOf와 같음). 이름 변경·보관 기준. */
  key: string;
  /** 앱에서 바꾼 표시 이름(F2-1). 없으면 null. */
  customTitle: string | null;
  /** 보관함에 있는지(F2-1). */
  archived: boolean;
}

/** 히스토리 목록 상태. */
export interface HistoryDto {
  status: 'loading' | 'ready' | 'error';
  items: HistoryItemDto[];
  error?: string;
}

/** 실행 중인 대화(사이드바 ◐ 분리됨 판정용). */
export interface RunningDto {
  sessionId: string;
  psmuxSession: string | null;
  /** 앱이 만든 세션인지. */
  ours: boolean;
  /** Claude Code 프로세스 ID(세션 끊기 확인 문구용, 대상 결정은 main). main은 항상 채운다. */
  pid?: number;
  /** psmux 안에서 실행 중인지(tmux 필드 있음). 있는데 psmuxSession이 null이면 이름 형식이 맞지 않아 끊기 대상이 아니다. */
  inPsmux?: boolean;
}

/** 탭 없는 앱 세션(F2-1 보완): 탭을 닫았지만 psmux 세션이 살아 있고 대화 기록이 없어 히스토리 행이 없는 세션. 있을 때만 사이드바에 보인다. */
export interface DetachedSessionDto {
  session: string;
  folder: string;
  folderName: string;
  createdAt: number;
  /** Claude만 탭(에이전트 없음)이었는지. */
  plain: boolean;
}

/** 저장된 화면 상태(내용은 렌더러가 검증). */
export interface UiStateDto {
  collapsed: string[];
  tabs: Record<string, unknown>;
  /** 사이드바 전체 접힘. */
  sidebarCollapsed: boolean;
  /** 사이드바 폭(px). */
  sidebarWidth: number;
  /** 히스토리 필터(F2-2, 렌더러가 parseFilter로 검증). */
  historyFilter: Record<string, string>;
}

/** 테마 설정값. system = OS(prefers-color-scheme) 추종. */
export type ThemeMode = 'light' | 'dark' | 'system';

/** 설정 대화상자에서 바꿀 수 있는 값(F8). 경로의 빈 값은 기본값(자동 탐색·~/.claude/projects·psmux 기본 셸). */
export interface EditableSettings {
  psmuxPath: string;
  pwshPath: string;
  leadCommand: string;
  historyDir: string;
  fontFamily: string;
  fontSize: number;
  theme: ThemeMode;
  showSdkSessions: boolean;
}

/** 항목별 오류(현재 UI 언어). */
export type SettingsErrors = Partial<Record<keyof EditableSettings, string>>;

/** 설정 대화상자 표시용: 현재 값 + 빈 값일 때 쓰이는 기본값 안내. */
export interface SettingsView {
  values: EditableSettings;
  defaults: { psmuxDetected: string | null; historyDir: string; leadCommand: string; fontFamily: string; fontSize: number };
  /** 마지막 새 세션에서 지금 설정된 PowerShell 경로를 적용하지 못했으면 그 안내(현재 UI 언어). */
  shellWarning: string | null;
}

/** 설정 저장 결과. */
export interface SaveSettingsResult {
  ok: boolean;
  errors: SettingsErrors;
  view?: SettingsView;
}

/** 즉시 적용되는 화면 설정. */
export interface AppearanceDto {
  fontSize: number;
  fontFamily: string;
  theme: ThemeMode;
}

/** 계정 영역(F7): 읽기 전용 표시값만. */
export interface AccountDto {
  email: string | null;
  org: string | null;
  /** 로그인 상태(F7-2): claude auth status의 loggedIn, 확인 못 하면 이메일 유무. */
  loggedIn: boolean;
  /** PATH에서 claude 실행 파일을 찾았는지(로그인·로그아웃 가능 여부). */
  cliAvailable: boolean;
}

/** 대화 삭제 미리보기(F2-1): 함께 휴지통으로 갈 다른 파일 수, 삭제할 수 없으면 사유. */
export interface TrashPreviewDto {
  ok: boolean;
  /** 대화 파일 외에 함께 이동할 팀원·서브에이전트 기록 수. */
  extra: number;
  /** 함께 이동할 대화 폴더 수(<대화 ID> 아래 서브에이전트 기록·도구 결과 등). */
  folders: number;
  error?: string;
}

/** 대화 삭제 결과. */
export interface TrashResultDto {
  ok: boolean;
  moved: number;
  failed: number;
  /** 실패·거부 안내(현재 UI 언어 한 줄). */
  error?: string;
}

/** 히스토리 "세션 끊기…"(F2-1) 결과. */
export interface HistoryStopDto {
  ok: boolean;
  /** 거부·실패 안내(현재 UI 언어 한 줄). */
  error?: string;
}

/** 에이전트 정의 하나(F8-1). */
export interface AgentEntryDto {
  file: string;
  scope: 'global' | 'project';
  name: string | null;
  description: string | null;
  /** 형식 오류 안내(정상이면 null). */
  error: string | null;
  /** 이 에이전트를 리더로 볼 때: 본문에 나오는 목록 이름. */
  referenced: string[];
  /** 본문이 참조하지만 목록에 없는 이름. */
  missing: string[];
}

/** Agents 대화상자 데이터(F8-1, 읽기 전용 조사 결과). */
export interface AgentsDto {
  globalDir: string;
  projectDir: string | null;
  projectFolder: string | null;
  agents: AgentEntryDto[];
  /** 개수 상한(200)으로 일부만 읽음. */
  truncated: boolean;
  teams: { enabled: boolean; source: string | null; teammateMode: string | null };
  leadCommand: string;
  /** 리드 명령이 `claude --agent X`면 X, 아니면 null(직접 지정). */
  leadName: string | null;
}

/** 로그아웃 결과. */
export interface LogoutResultDto {
  ok: boolean;
  error?: string;
  /** 성공했지만 알릴 것(예: 로그아웃됨, CLI 상태 확인 불가). 현재 UI 언어. */
  notice?: string;
  account: AccountDto;
}

/** 열린 psmux 세션 목록 항목. app = 앱이 만든 세션(메타 있음), tabId = 지금 탭으로 열려 있으면 그 탭. */
export interface PsmuxSessionDto {
  name: string;
  app: boolean;
  tabId: string | null;
}

/** 언어 변경 결과. language = 적용된 언어(실패면 바뀌기 전 언어). */
export interface SetLanguageResultDto {
  ok: boolean;
  language: Lang;
  error?: string;
}

/** 앱 정보. */
export interface AppInfoDto {
  version: string;
  electron: string;
  chrome: string;
}

/** 앱 초기값. */
export interface InitDto {
  fontSize: number;
  fontFamily: string;
  theme: ThemeMode;
  account: AccountDto;
  recentFolders: string[];
  /** 사용자 홈 폴더(탭 바 ▾ 메뉴 "홈"). */
  homeDir: string;
  tabs: TabStateDto[];
  history: HistoryDto;
  running: RunningDto[];
  /** 탭 없는 앱 세션(F2-1 보완). */
  detached: DetachedSessionDto[];
  uiState: UiStateDto;
  /** 사용량(F7-1): usage.json의 마지막 값. 없으면 세 값 모두 null. */
  usage: UsageDto;
}

/** 세션 열기 결과. tab이 있으면 새로 연 탭, tabId만 있으면 이미 열린 탭으로 전환. */
export interface OpenResult {
  ok: boolean;
  tab?: TabStateDto;
  tabId?: string;
  error?: string;
  /** 실행 중으로 보여 거부했지만 사용자가 확인 후 강제로 이어갈 수 있음(pid 재사용 오판 대비). */
  canForce?: boolean;
  /** 열렸지만 알릴 것이 있음(예: 설정한 셸이 적용되지 않음). 현재 UI 언어. */
  warning?: string;
}

type Unsub = () => void;

/** preload API. */
export interface CtdApi {
  init(): Promise<InitDto>;
  pickFolder(): Promise<string | null>;
  /** 첨부 버튼용 파일 선택(여러 개). 취소면 빈 배열. */
  pickFiles(kind: 'image' | 'any'): Promise<string[]>;
  /** 폴더 추가용 폴더 선택. 취소면 null. */
  pickAddDir(): Promise<string | null>;
  /** 클립보드 이미지를 PNG로 저장하고 경로를 돌려준다. noImage: 읽을 수 있는 이미지가 아예 없음(추측성 붙여넣기에서는 조용히 무시). */
  saveClipboardImage(): Promise<{ ok: boolean; path?: string; error?: string; noImage?: boolean }>;
  /** 드롭한 파일·폴더의 절대 경로(얻지 못하면 빈 문자열). */
  pathForFile(file: File): string;
  /** plain = 에이전트 없이 `claude`만 실행(탭 바 ▾ 메뉴). */
  newSession(folder: string, plain?: boolean): Promise<OpenResult>;
  openHistory(sessionId: string, force?: boolean): Promise<OpenResult>;
  refreshHistory(): void;
  detachTab(tabId: string): Promise<boolean>;
  terminateTab(tabId: string): Promise<boolean>;
  saveCollapsed(folderKeys: string[]): void;
  saveTabUi(session: string, ui: unknown): void;
  /** 사이드바 접힘 저장(ui-state.json). */
  saveSidebarCollapsed(collapsed: boolean): void;
  /** 사이드바 폭 저장(ui-state.json). */
  saveSidebarWidth(width: number): void;
  /** 히스토리 필터 저장(ui-state.json). */
  saveHistoryFilter(filter: unknown): void;
  sendInput(tabId: string, pane: string, text: string): Promise<boolean>;
  sendKeys(tabId: string, pane: string, data: string): void;
  resizePane(tabId: string, pane: string, cols: number, rows: number): void;
  requestResync(tabId: string, pane: string): void;
  paneInfo(tabId: string, pane: string): Promise<Record<string, string | number | null> | null>;
  requestStop(tabId: string, pane: string, name: string): Promise<boolean>;
  reconnect(tabId: string): void;
  onTabState(cb: (s: TabStateDto) => void): Unsub;
  onTabClosed(cb: (tabId: string) => void): Unsub;
  onHistory(cb: (h: HistoryDto) => void): Unsub;
  onRunning(cb: (r: RunningDto[]) => void): Unsub;
  /** 탭 없는 앱 세션 목록이 바뀌었을 때. */
  onDetached(cb: (d: DetachedSessionDto[]) => void): Unsub;
  onOutput(cb: (tabId: string, pane: string, data: Uint8Array) => void): Unsub;
  onResync(cb: (tabId: string, pane: string, data: string) => void): Unsub;
  onSize(cb: (tabId: string, pane: string, cols: number, rows: number) => void): Unsub;
  getSettings(): Promise<SettingsView>;
  /** 지금 UI 언어(설정값, 없으면 Windows 표시 언어를 등록된 모든 언어 중 하나로 매핑, 없으면 FALLBACK_LANG). 첫 렌더 전에 부른다. */
  getLanguage(): Promise<Lang>;
  /** UI 언어 저장·적용(main 문구도 이 언어로 바뀌고 열린 탭 상태를 다시 보낸다). */
  setLanguage(lang: Lang): Promise<SetLanguageResultDto>;
  saveSettings(values: EditableSettings): Promise<SaveSettingsResult>;
  onAppearance(cb: (a: AppearanceDto) => void): Unsub;
  getAccount(): Promise<AccountDto>;
  /** psmux 세션 목록. ok=false면 목록 조회 실패(error에 사유). */
  listSessions(): Promise<{ ok: boolean; sessions: PsmuxSessionDto[]; error?: string }>;
  /** 앱이 만든 세션에 연결(이미 열린 탭이면 그 탭 ID). */
  openAppSession(name: string): Promise<OpenResult>;
  appInfo(): Promise<AppInfoDto>;
  /** 사용량 ↻(F7-1): /api/oauth/usage 1회 조회 후 표시 상태. 실패는 error에 현재 UI 언어 한 줄. */
  refreshUsage(): Promise<UsageDto>;
  onUsage(cb: (u: UsageDto) => void): Unsub;
  /** 히스토리 항목 메뉴(F2-1): 표시 이름 변경(빈 값이면 원래 제목). */
  renameHistory(key: string, title: string): Promise<boolean>;
  /** 보관/보관 해제. */
  archiveHistory(key: string, archived: boolean): Promise<boolean>;
  /** 삭제 전 확인(함께 이동할 파일 수, 삭제 불가 사유). */
  trashPreview(sessionId: string): Promise<TrashPreviewDto>;
  /** 대화와 팀원·서브에이전트 기록을 휴지통으로 이동. */
  trashHistory(sessionId: string): Promise<TrashResultDto>;
  /** 세션 끊기(F2-1): 탭 없는 실행 중 대화를 끝낸다(앱 세션 = 팀 종료 요청 후 kill-session, 외부 psmux = kill-session, psmux 밖 = 프로세스 종료). 대상은 main이 찾고 실행 직전에 다시 확인한다. */
  terminateHistory(sessionId: string): Promise<HistoryStopDto>;
  /** 탭 없는 앱 세션에 다시 연결(새 탭). */
  attachDetached(session: string): Promise<OpenResult>;
  /** 탭 없는 앱 세션 끊기: 대화 기록이 없으므로 종료 요청 없이 kill-session. */
  stopDetached(session: string): Promise<HistoryStopDto>;
  /** 로그아웃(F7-2): claude auth logout. */
  logout(): Promise<LogoutResultDto>;
  /** 로그인 탭 열기(F7-2): 새 탭에서 claude auth login. 이미 있으면 그 탭. */
  login(): Promise<OpenResult>;
  /** Agents 설정(F8-1): 에이전트 정의·팀 기능 상태(읽기 전용). tabId = 활성 탭(그 작업 폴더의 프로젝트 정의도 읽음). */
  listAgents(tabId: string | null): Promise<AgentsDto>;
  /** 리더 저장: 리드 명령을 `claude --agent <name>`으로. */
  setLeadAgent(name: string): Promise<{ ok: boolean; error?: string; leadCommand?: string }>;
  /** 예시 에이전트 템플릿을 클립보드에. */
  copyAgentTemplate(): Promise<boolean>;
  /** 에이전트 폴더 열기(없으면 ~/.claude). */
  openAgentsFolder(): Promise<boolean>;
  /** 현재 리드 명령(새 세션 메뉴의 "리더: …" 표시). */
  getLeadCommand(): Promise<string>;
  /** 계정 상태가 바뀌었을 때(로그인 탭 성공 등). */
  onAccount(cb: (a: AccountDto) => void): Unsub;
}
