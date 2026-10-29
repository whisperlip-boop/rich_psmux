// Electron main: 창 생성, IPC, 탭 세션 관리. 렌더러는 sandbox + contextIsolation, Node 접근은 preload API로만.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, parse } from 'node:path';

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

import type {
  AccountDto, AgentsDto, AppearanceDto, DetachedSessionDto, EditableSettings, HistoryDto, HistoryStopDto, LogoutResultDto, OpenResult, PsmuxSessionDto, RunningDto, SaveSettingsResult, SettingsView,
  SetLanguageResultDto, TrashPreviewDto, TrashResultDto, UsageDto,
} from '../shared/api';
import { AGENT_NAME_RE, AGENT_TEMPLATE, leadCommandFor, PLAIN_LEAD_COMMAND } from '../shared/agents';
import { pickClipImage } from '../shared/attach';
import { getLang, isLang, langFromLocales, msg, resolveMsg, setLang, tr, type Lang, type Msg } from '../shared/i18n';
import { SESSION_ID_RE } from '../shared/ids';
import { listMetaSessions, readSessionMeta, removeSessionFiles, UiStateStore, type SessionMeta } from './appData';
import { listAgents } from './agentsScan';
import { AuthCache, type AuthCheckResult } from './authCache';
import { isShellCommand, LOGOUT_TIMEOUT_MS, loggedInFrom, parseAuthStatus, runClaude, STATUS_TIMEOUT_MS, stepLogin, type LoginWatch } from './auth';
import {
  agentsDir, claudeHomeDir, listRunningSessionFiles, projectDirName, projectsDir, readAccount, readRunningSessionFile, resolveProjects, setProjectsDir,
} from './claudeHome';
import { cleanupClips, saveClipPng } from './clips';
import { selectDetached, sessionHasConversation } from './detached';
import { HistoryIndexer } from './history/indexer';
import { HistoryMetaStore } from './historyMeta';
import { toHistoryDtos } from './history/list';
import { isDefinitiveRefusal, judgeKill, judgeOwner, killProcessTree, queryProcess } from './history/procKill';
import {
  buildRunning, filterExcluded, findRunning, isKillablePid, sessionFileOwns, isSafeSessionName, pidAlive, planStop, stopFailMessage, type RunningConversation, type StopFailCode, type StopPlan,
} from './history/running';
import { errMsg, initLogger, log } from './logger';
import { hasSession, listSessionNames, psmuxCli } from './psmux/cli';
import { asarUnpackedPath, probeDir, probeExecutable, resolveClaude, resolveNode, resolvePsmux, unreachableMsg, unreachableReason } from './psmux/env';
import { TabSession, type TabState } from './psmux/sessionManager';
import { classifySessions, isAppSessionName, parseListSessions, selectRestorable, staleSessions } from './psmux/sessionName';
import { DEFAULT_SETTINGS, leadCommandError, pushRecent, SettingsStore, validateSettings, type Settings } from './settings';
import { movableSummary, moveToTrash, planTrash, trashOrder } from './trash';
import { autoRefreshUsage, UsageTracker } from './usage';
import { USAGE_FILE } from './usageFile';

// 앱 데이터 = %APPDATA%\rich-psmux (package.json name과 같음, 명시적으로 고정)
// CTD_USER_DATA_DIR: 검증 자동화용(개발 전용) 격리 폴더. Electron은 APPDATA 환경변수를 무시하므로 ready 전에 경로를 직접 바꾼다.
// 설치본에서는 무시한다. 드라이브가 있는 절대 경로만 쓰고(상대·드라이브 상대 경로는 실행 위치에 따라 달라짐),
// 폴더를 못 만들면 기본 경로로 돌아간다(로거 준비 전이라 예외가 나면 아무 기록 없이 앱이 죽음)
const devUserDataRaw = app.isPackaged ? '' : (process.env.CTD_USER_DATA_DIR ?? '').trim();
let devUserData: string | null = null;
let devUserDataWarn: string | null = null;
if (devUserDataRaw) {
  // Windows에서 '/x'·'(역슬래시)x'는 isAbsolute여도 현재 드라이브 기준이라 거부. 루트가 'C:' + 구분자(3글자)여야 함
  const root = parse(devUserDataRaw).root;
  if (!isAbsolute(devUserDataRaw) || !/^[A-Za-z]:/.test(root) || root.length !== 3) {
    devUserDataWarn = `CTD_USER_DATA_DIR ignored (needs an absolute path with a drive): ${devUserDataRaw}`;
  } else {
    try {
      mkdirSync(devUserDataRaw, { recursive: true });
      devUserData = devUserDataRaw;
    } catch (e) {
      devUserDataWarn = `CTD_USER_DATA_DIR ignored (cannot create folder: ${errMsg(e)}): ${devUserDataRaw}`;
    }
  }
}
app.setPath('userData', devUserData ?? join(app.getPath('appData'), 'rich-psmux'));
const dataDir = app.getPath('userData');
initLogger(join(dataDir, 'logs'), !app.isPackaged);
if (devUserDataWarn) log('warn', devUserDataWarn);
const settings = new SettingsStore(join(dataDir, 'settings.json'));
const uiStore = new UiStateStore(join(dataDir, 'ui-state.json'));
const indexer = new HistoryIndexer(join(dataDir, 'cache', 'history-index.json'));
// 히스토리 항목 표시 이름·보관 목록. ~/.claude 는 바꾸지 않는다
const historyMeta = new HistoryMetaStore(join(dataDir, 'history-meta.json'));
// 사용량: statusline 스크립트가 쓰는 usage.json 감시 + ↻ 수동 갱신. 첫 app:init 때 저장값을 읽고 감시를 시작한다
const usageFile = join(dataDir, USAGE_FILE);
const usage = new UsageTracker(usageFile);
let usageReady: Promise<void> | null = null;
/** 기동 직후 자동 1회 갱신(첫 app:init 뒤 한 번만, 렌더러 새로고침으로 다시 부르지 않음). */
let startupUsage: Promise<boolean> | null = null;
usage.on('update', (d: UsageDto) => send('usage:update', d));
setProjectsDir(settings.get().historyDir);
nativeTheme.themeSource = settings.get().theme;
const tabs = new Map<string, TabSession>();
let win: BrowserWindow | null = null;
let history: HistoryDto = { status: 'loading', items: [] };
let running: RunningConversation[] = [];
let runningJson = '';
let restoring: Promise<void> | null = null;
/** 같은 대화를 연달아 클릭해도 세션을 두 번 만들지 않게 진행 중인 열기를 공유한다. */
const opening = new Map<string, Promise<OpenResult>>();
/** 히스토리 "세션 끊기…" 작업 하나: 앱 세션이면 탭 없는 연결, 결과. */
interface StopJob { conn: TabSession | null; done: Promise<HistoryStopDto> }
/** 끊는 중인 대상(psmux 세션 이름 또는 `pid:<n>` → 작업). 그 사이 탭으로 붙거나 두 번 끊지 않게 한다. */
const stopping = new Map<string, StopJob>();
/**
 * 끊기에서 확정적으로 거부된(pid 재사용·Claude 아닌 이미지) 세션 파일: pid → 그때의 sessions/<pid>.json 수정 시각.
 * 실행 목록에서 빼서 삭제·이어가기가 막히지 않게 한다. 메모리에만 두고(~/.claude는 쓰지 않음), 수정 시각이 바뀌면 무효.
 */
const notRunning = new Map<number, number>();
const RUNNING_POLL_MS = 2500;
/** 탭 없는 앱 세션 마지막 목록과 그 JSON(바뀌었을 때만 보낸다). */
let detached: DetachedSessionDto[] = [];
let detachedJson = '';
/** refreshDetached 세대 번호: 겹친 호출 중 마지막 것만 결과를 보낸다. */
let detachedGen = 0;
const DETACHED_POLL_MS = 10_000;

// 검증 자동화용(개발 전용) 환경변수: 지정 폴더로 세션 자동 생성, 프롬프트 1회 입력, 스크린샷 저장, 자동 종료
// 설치본(app.isPackaged)에서는 무시: 환경변수만으로 세션이 종료되거나 명령이 바뀌지 않게 함
const devEnv: NodeJS.ProcessEnv = app.isPackaged ? {} : process.env;
const AUTO = {
  folder: devEnv.CTD_AUTOSTART_FOLDER,
  prompt: devEnv.CTD_AUTOPROMPT,
  shot: devEnv.CTD_SCREENSHOT,
  shotDelayMs: Number(devEnv.CTD_SCREENSHOT_DELAY_MS ?? 45000),
  quit: devEnv.CTD_AUTOQUIT === '1',
  killOnQuit: devEnv.CTD_KILL_ON_QUIT === '1',
  leadCommand: devEnv.CTD_LEAD_COMMAND,
  /** 파일 선택 창 대신 쓸 경로('|' 구분) / 폴더 추가 선택 창 대신 쓸 폴더. 네이티브 창은 자동화로 조작할 수 없어서. */
  pickFiles: devEnv.CTD_TEST_PICK_FILES,
  pickDir: devEnv.CTD_TEST_PICK_DIR,
};

/** 붙여넣기 이미지 바이트 상한(메모리·디스크 보호). */
const MAX_CLIP_BYTES = 64 * 1024 * 1024;

/** 이미지 첨부 버튼 필터. */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

/**
 * out/hook/<name>을 외부 node로 실행하는 명령 앞부분. 스크립트가 없으면 null.
 * node는 PATH의 node(호출부에서 1번만 찾아 넘김), 없으면 Electron을 node 모드로. what은 로그용 기능 이름.
 */
function nodeScriptCommand(name: string, what: string, node: string | null): string | null {
  // 설치본: 외부 node는 asar 안 파일을 읽지 못하므로 asarUnpack된 사본(app.asar.unpacked)을 쓴다
  const script = asarUnpackedPath(join(__dirname, '..', 'hook', name)).replace(/\\/g, '/');
  if (!existsSync(script)) {
    log('warn', `${name} missing; ${what} disabled`);
    return null;
  }
  if (node) return `"${node.replace(/\\/g, '/')}" "${script}"`;
  // node가 없으면 Electron을 node 모드로(bash 문법). Claude Code가 hook을 어떤 셸로 실행하는지 확인하지 못해 미검증(README 알려진 제약)
  log('warn', `node not found on PATH; ${what} falls back to ELECTRON_RUN_AS_NODE (unverified)`);
  return `ELECTRON_RUN_AS_NODE=1 "${process.execPath.replace(/\\/g, '/')}" "${script}"`;
}

/**
 * 리드에 붙일 hook(승인 대기 감지)·statusLine(사용량) 명령. PATH의 node는 한 번만 찾는다(where.exe 1회).
 *
 * Args:
 *   withStatusLine: statusLine도 만들지(재연결은 리드를 다시 실행하지 않으므로 불필요).
 */
async function leadScriptCommands(withStatusLine: boolean): Promise<{ hook: string | null; statusLine: string | null }> {
  const useHooks = settings.get().useHooks;
  if (!useHooks && !withStatusLine) return { hook: null, statusLine: null };
  const node = await resolveNode();
  const hook = useHooks ? nodeScriptCommand('hookRecorder.js', 'approval hook', node) : null;
  const base = withStatusLine ? nodeScriptCommand('statusLine.js', 'usage statusline', node) : null;
  return { hook, statusLine: base ? `${base} "${usageFile.replace(/\\/g, '/')}"` : null };
}

function wireTab(t: TabSession): void {
  t.on('state', (s: TabState) => {
    // 이미 닫은 탭(분리·종료)의 늦은 상태는 보내지 않는다(렌더러에 탭이 되살아나지 않게)
    if (tabs.get(t.tabId) === t) send('tab:state', s);
    // Claude만 탭의 대화 ID를 기억해 두면 히스토리에서 다시 열 때도 에이전트 없이 열린다
    if (t.plain && s.leadSessionId) uiStore.markPlainSession(s.leadSessionId);
  });
  // Buffer는 공유 풀의 일부일 수 있어 IPC 직렬화 전에 필요한 바이트만 복사한다
  t.on('output', (pane: string, data: Buffer) => send('pane:output', t.tabId, pane, new Uint8Array(data)));
  t.on('resync', (pane: string, data: string) => send('pane:resync', t.tabId, pane, data));
  t.on('size', (pane: string, cols: number, rows: number) => send('pane:size', t.tabId, pane, cols, rows));
}

/** 탭 세션을 등록·시작한다. 실패하면 정리 후 오류 결과. */
async function startTab(t: TabSession, what: string): Promise<OpenResult> {
  tabs.set(t.tabId, t);
  wireTab(t);
  try {
    await t.start();
    if (t.shellWarning) {
      lastShellWarning = { path: settings.get().pwshPath, message: t.shellWarning };
      return { ok: true, tab: t.state(), warning: resolveMsg(t.shellWarning) };
    }
    if (t.isNewSession && settings.get().pwshPath) lastShellWarning = null; // 같은 설정으로 적용에 성공하면 경고 해제
    return { ok: true, tab: t.state() };
  } catch (e) {
    log('error', `${what} failed: ${errMsg(e)}`);
    if (t.shellWarning) lastShellWarning = { path: settings.get().pwshPath, message: t.shellWarning };
    t.detach();
    tabs.delete(t.tabId);
    return { ok: false, error: tr('open.failed', { err: errMsg(e) }) };
  }
}

/**
 * 새 세션(새 탭). resumeSessionId가 있으면 리드 명령 뒤에 -r <id>를 붙여 그 대화를 이어간다.
 * plain이면 설정의 리드 명령 대신 `claude`만 실행한다(에이전트 없음).
 */
async function newSession(folder: string, resumeSessionId?: string, plain = false): Promise<OpenResult> {
  const s = settings.get();
  // 끊긴 네트워크 폴더가 main을 멈추지 않게 비동기 + 시간 제한
  const dir = folder ? await probeDir(folder) : 'missing';
  const dirWhy = unreachableMsg(dir);
  if (dirWhy) return { ok: false, error: tr('sess.folderUnreachable', { why: dirWhy, folder }) };
  if (dir !== 'ok') return { ok: false, error: tr('sess.folderMissing', { folder }) };
  // CTD_LEAD_COMMAND: 검증 자동화용 덮어쓰기(Claude 호출 없이 GUI 확인)
  const leadCommand = AUTO.leadCommand ?? (plain ? PLAIN_LEAD_COMMAND : s.leadCommand);
  // 이전 버전에서 저장한 여러 명령짜리 리드 명령도 막는다(-r·--settings가 마지막 명령에 붙음)
  const leadErr = AUTO.leadCommand ? null : leadCommandError(leadCommand);
  if (leadErr) return { ok: false, error: tr('open.fixLead', { err: leadErr }) };
  const psmux = await resolvePsmux(s.psmuxPath);
  if (!psmux) return { ok: false, error: tr('open.psmuxInstall') };
  // 설정 저장 뒤 파일이 지워졌을 수 있어 세션을 만들 때 다시 확인한다
  if (s.pwshPath) {
    const r = await probeExecutable(s.pwshPath);
    const why = unreachableReason(r);
    if (why) return { ok: false, error: tr('open.pwshUnreachable', { why, path: s.pwshPath }) };
    if (r !== 'ok') return { ok: false, error: tr('open.pwshMissing', { path: s.pwshPath }) };
  }
  // CTD_LEAD_COMMAND(검증용 가짜 리드)에는 --settings를 붙이지 않는다
  const { hook, statusLine } = AUTO.leadCommand ? { hook: null, statusLine: null } : await leadScriptCommands(true);
  let t: TabSession;
  try {
    t = new TabSession({ psmux, folder, leadCommand, dataDir, hookCommand: hook, statusLineCommand: statusLine, resumeSessionId, shell: s.pwshPath || null });
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
  if (resumeSessionId) log('info', `[${t.session}] resume conversation ${resumeSessionId.slice(0, 8)} in ${folder}`);
  if (plain) {
    log('info', `[${t.session}] plain claude (no agents) in ${folder}`);
    if (resumeSessionId) uiStore.markPlainSession(resumeSessionId);
  }
  const r = await startTab(t, 'new session');
  if (r.ok) settings.update({ recentFolders: pushRecent(s.recentFolders, folder) });
  return r;
}

/** 살아 있는 앱 세션에 다시 연결(복원·◐ 재연결). 폴더·리드 명령은 메타 값을 쓴다(리드 이름 @ceo 기준). */
async function attachSession(name: string): Promise<OpenResult> {
  const existing = tabs.get(name);
  if (existing) return { ok: true, tabId: existing.tabId };
  if (stopping.has(name)) return { ok: false, error: tr('open.stopping') };
  const meta = readSessionMeta(dataDir, name);
  const psmux = await resolvePsmux(settings.get().psmuxPath);
  if (!meta || !psmux) return { ok: false, error: tr('open.reattachFailed', { name, why: msg(!meta ? 'open.noMeta' : 'open.noPsmux') }) };
  // 메타의 용도도 넘긴다: 로그인 세션에 다시 붙으면 로그인 탭으로 표시·감시
  const purpose = meta.purpose ?? 'conversation';
  const t = new TabSession({ psmux, folder: meta.folder, leadCommand: meta.leadCommand, dataDir, hookCommand: purpose === 'login' ? null : (await leadScriptCommands(false)).hook, attachName: name, purpose });
  log('info', `[${name}] attaching (lead ${meta.leadPaneId ?? '?'}, resume ${meta.resumeSessionId?.slice(0, 8) ?? '-'})`);
  const r = await startTab(t, `attach ${name}`);
  if (r.ok && purpose === 'login') watchLogin(t);
  void refreshDetached();
  return r;
}

/**
 * 앱 시작 시 복원: list-sessions 중 ctd- 접두사 + 메타가 있는 세션만 연결한다.
 * 목록 조회에 성공했을 때만, 세션이 없어진 메타의 앱 파일을 정리한다.
 */
async function restoreSessions(): Promise<void> {
  const psmux = await resolvePsmux(settings.get().psmuxPath);
  if (!psmux) return;
  const r = await psmuxCli(psmux, ['list-sessions', '-F', '#{session_name}']);
  const metas = listMetaSessions(dataDir);
  const live = parseListSessions(r.code, r.out, r.err);
  if (live === null) {
    log('warn', `restore: list-sessions failed (code ${r.code}: ${r.err.slice(0, 120)}); nothing restored, no cleanup`);
    return;
  }
  if (r.code !== 0) log('info', 'restore: no psmux server running (0 sessions)');
  for (const n of staleSessions(live, metas)) {
    removeSessionFiles(dataDir, n);
    uiStore.removeTab(n);
  }
  // 로그인 전용 탭의 세션은 복원하지 않고 정리한다(로그인 확인 흐름이 앱 실행 사이에 이어지지 않음)
  const loginLeft = selectRestorable(live, metas).filter((n) => readSessionMeta(dataDir, n)?.purpose === 'login');
  for (const n of loginLeft) {
    await psmuxCli(psmux, ['kill-session', '-t', n]);
    removeSessionFiles(dataDir, n);
    uiStore.removeTab(n);
    log('info', `restore: login session ${n} closed`);
  }
  const names = selectRestorable(live, metas)
    .filter((n) => !loginLeft.includes(n))
    .map((n) => ({ n, at: readSessionMeta(dataDir, n)?.createdAt ?? 0 }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.n);
  const skipped = live.filter((n) => isAppSessionName(n) && !names.includes(n));
  log('info', `restore: ${names.length} session(s) [${names.join(', ')}]${skipped.length ? `, skipped (no app data): ${skipped.join(', ')}` : ''}`);
  const results = await Promise.all(names.map((n) => attachSession(n)));
  results.forEach((x, i) => { if (!x.ok) log('warn', `restore ${names[i]} failed: ${x.error}`); });
  await refreshDetached();
}

/** 대화 기록(.jsonl)이 있는지: 인덱스에 있거나, 인덱스 갱신이 늦을 수 있어 파일이 바로 있는지도 본다. */
function hasConversationFile(sessionId: string, folder: string): boolean {
  if (indexer.find(sessionId)) return true;
  try {
    return existsSync(resolveProjects(projectDirName(folder), `${sessionId}.jsonl`));
  } catch {
    return false;
  }
}

/** 그 작업 폴더의 projects 폴더에서 가장 최근 .jsonl 수정 시각. 폴더가 없거나 읽지 못하면 null. */
function newestJsonl(folder: string): number | null {
  try {
    const dir = resolveProjects(projectDirName(folder));
    let newest: number | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.jsonl')) continue;
      try {
        const m = statSync(join(dir, f)).mtimeMs;
        if (newest === null || m > newest) newest = m;
      } catch { /* 읽는 사이 지워진 파일 */ }
    }
    return newest;
  } catch {
    return null;
  }
}

/** newestJsonl 결과 캐시(폴더 이름 → 시각). 한 번의 목록 갱신 안에서 같은 폴더를 여러 메타가 쓸 때 다시 읽지 않는다. */
type JsonlCache = Map<string, number | null>;

/**
 * 세션에 대화 기록이 있는지(탭 ×·탭 없는 세션 목록·끊기가 같은 규칙을 쓴다). ids에는 아는 대화 ID를 모두 넣는다.
 * cache를 주면 폴더별 최근 .jsonl 시각을 그 안에서 한 번만 읽는다.
 */
function conversationProbe(folder: string, createdAt: number, ids: (string | null | undefined)[], cache?: JsonlCache): boolean {
  const newest = (f: string): number | null => {
    if (!cache) return newestJsonl(f);
    const k = projectDirName(f);
    if (!cache.has(k)) cache.set(k, newestJsonl(f));
    return cache.get(k) ?? null;
  };
  return sessionHasConversation({ ids, folder, createdAt, hasFile: hasConversationFile, newestJsonl: newest });
}

/** 그 psmux 세션에서 실행 중인 대화 ID(실행 목록 기준, 없으면 undefined). */
const runningIdOf = (session: string): string | undefined => running.find((r) => r.psmuxSession === session)?.sessionId;

/** 메타로 본 세션의 대화 기록 여부(탭 없는 세션 목록·끊기). 리드 대화 ID는 지난 것(/clear 전)까지 모두 본다. */
function metaHasConversation(meta: SessionMeta, name: string, cache?: JsonlCache): boolean {
  return conversationProbe(meta.folder, meta.createdAt, [meta.resumeSessionId, ...(meta.leadSessionIds ?? []), meta.leadSessionId, runningIdOf(name)], cache);
}

/**
 * 대화 기록이 없는 탭(탭 ×: 분리 대신 종료): 이어간 대화가 아니고, 칸이 리드 하나뿐이고(나눈 칸에는 셸 작업이 있을 수 있음),
 * 아는 대화 ID(탭·메타의 지난 ID 포함, 실행 목록)의 기록이 없음. ID를 하나도 모를 때만 세션 생성 뒤 수정된 .jsonl로 판정.
 */
function isFreshTab(t: TabSession): boolean {
  const st = t.state();
  if (st.resumeSessionId || st.panes.length > 1) return false;
  // 다시 연결한 직후에는 탭이 리드 대화 ID를 아직 못 찾았을 수 있어 메타·실행 목록의 값도 본다(대화가 있는 세션을 끝내지 않게)
  const meta = readSessionMeta(dataDir, st.session);
  const ids = [st.leadSessionId, ...t.knownLeadIds(), ...(meta?.leadSessionIds ?? []), meta?.leadSessionId, meta?.resumeSessionId, runningIdOf(st.session)];
  return !conversationProbe(st.folder, st.createdAt, ids);
}

/** 탭 없는 앱 세션 목록을 다시 세어 바뀌었으면 렌더러에 보낸다. 사라진 세션의 메타 정리는 복원 때만 한다. */
async function refreshDetached(): Promise<void> {
  try {
    await refreshDetachedInner();
  } catch (e) {
    // 호출부가 모두 void라 여기서 삼키고 기록한다(다음 폴링에서 다시 센다)
    log('warn', `detached sessions refresh failed: ${errMsg(e)}`);
  }
}

/** refreshDetached 본체. 겹쳐 불리면 마지막 호출만 결과를 보낸다(세대 번호). */
async function refreshDetachedInner(): Promise<void> {
  const gen = ++detachedGen;
  const metas = listMetaSessions(dataDir);
  let out: DetachedSessionDto[] = [];
  // 후보가 없으면 psmux를 부르지 않는다
  if (metas.some((n) => !tabs.has(n))) {
    const psmux = await resolvePsmux(settings.get().psmuxPath);
    if (gen !== detachedGen) return;
    // psmux를 찾지 못하면 다시 연결·끊기도 할 수 없으므로 빈 목록을 보낸다(옛 행을 남기지 않게)
    if (psmux) {
      const r = await psmuxCli(psmux, ['list-sessions', '-F', '#{session_name}']);
      if (gen !== detachedGen) return;
      const live = parseListSessions(r.code, r.out, r.err);
      // 조회 실패: 지난 목록을 그대로 둔다
      if (live === null) return;
      const cache: JsonlCache = new Map();
      const sel = selectDetached({
        metas, live, isTab: (n) => tabs.has(n) || stopping.has(n), metaOf: (n) => readSessionMeta(dataDir, n), hasConversation: (m, n) => metaHasConversation(m, n, cache),
      });
      out = sel.detached;
    }
  }
  detached = out;
  const j = JSON.stringify(out);
  if (j !== detachedJson) {
    detachedJson = j;
    send('session:detached', out);
  }
}

/** 탭 없는 앱 세션 끊기: 대화 기록이 없으니 리드에 종료 요청 문장을 보내지 않고(보내면 그 문장으로 대화가 생긴다) 바로 kill-session. */
async function stopOrphan(name: string): Promise<HistoryStopDto> {
  const fail = (code: StopFailCode): HistoryStopDto => {
    log('warn', `detached stop ${name} refused: ${code}`);
    return { ok: false, error: stopFailMessage(code) };
  };
  if (!isAppSessionName(name) || !isSafeSessionName(name)) return fail('bad-name');
  if (tabs.has(name)) return fail('tab-open');
  const cur = stopping.get(name);
  if (cur) return cur.done;
  const job: StopJob = { conn: null, done: Promise.resolve({ ok: false }) };
  stopping.set(name, job);
  job.done = (async (): Promise<HistoryStopDto> => {
    const meta = readSessionMeta(dataDir, name);
    if (!meta) return fail('no-meta');
    // 목록을 본 뒤 대화가 생겼을 수 있다: 대화가 있으면 여기서 kill하지 않고 히스토리 행의 끊기(종료 요청 후 종료)로 보낸다
    if (metaHasConversation(meta, name)) return fail('has-conversation');
    const psmux = await resolvePsmux(settings.get().psmuxPath);
    if (!psmux) return fail('no-psmux');
    // 정확히 같은 이름이 지금 목록에 있을 때만(-t 접두어 일치로 다른 세션을 끝내지 않게)
    const before = await psmuxCli(psmux, ['list-sessions', '-F', '#{session_name}']);
    const found = parseListSessions(before.code, before.out, before.err);
    if (found === null || !found.includes(name)) return fail('not-found');
    // 목록을 읽는 사이(await) 탭으로 붙었으면 끝내지 않는다(attachSession은 stopping을 보고 거부하지만 한 번 더)
    if (tabs.has(name)) return fail('tab-open');
    const r = await psmuxCli(psmux, ['kill-session', '-t', name]);
    log('info', `[${name}] detached session killed (no conversation) code=${r.code}`);
    // 목록 조회 실패를 "사라짐"으로 보면 살아 있는 세션의 메타를 지울 수 있다 → 조회 실패면 still-alive로 두고 파일을 남긴다
    if ((await sessionGone(psmux, name)) !== true) return fail('still-alive');
    removeSessionFiles(dataDir, name);
    uiStore.removeTab(name);
    return { ok: true };
  })().catch((e: unknown): HistoryStopDto => {
    log('error', `detached stop ${name} failed: ${errMsg(e)}`);
    return { ok: false, error: stopFailMessage('error') };
  }).finally(() => {
    stopping.delete(name);
    void refreshDetached();
    void refreshRunning();
  });
  return job.done;
}

/** 탭 순서: 세션 생성 시각 순(복원 후에도 같은 순서). */
function orderedTabs(): TabSession[] {
  return [...tabs.values()].sort((a, b) => a.state().createdAt - b.state().createdAt);
}

/** 마지막 새 세션에서 설정한 셸을 적용하지 못한 기록(경로가 바뀌면 무효). 안내는 보여 줄 때 현재 언어로 번역한다. */
let lastShellWarning: { path: string; message: Msg } | null = null;
/** 자동 탐색한 psmux 위치(where.exe 호출이라 처음 한 번만). */
let psmuxDetected: string | null | undefined;
/** 설정 저장 직렬화: 검증이 비동기라 연속 저장의 적용 순서가 뒤바뀌지 않게(마지막 저장이 최종값). */
let saveChain: Promise<unknown> = Promise.resolve();

async function settingsView(): Promise<SettingsView> {
  const s = settings.get();
  psmuxDetected ??= await resolvePsmux('');
  return {
    values: { psmuxPath: s.psmuxPath, pwshPath: s.pwshPath, leadCommand: s.leadCommand, historyDir: s.historyDir, fontFamily: s.fontFamily, fontSize: s.fontSize, theme: s.theme, showSdkSessions: s.showSdkSessions },
    defaults: {
      psmuxDetected, historyDir: join(claudeHomeDir(), 'projects'),
      leadCommand: DEFAULT_SETTINGS.leadCommand, fontFamily: DEFAULT_SETTINGS.fontFamily, fontSize: DEFAULT_SETTINGS.fontSize,
    },
    shellWarning: lastShellWarning && s.pwshPath && lastShellWarning.path === s.pwshPath ? resolveMsg(lastShellWarning.message) : null,
  };
}

/** 설정 저장: 검증 → 저장 → 즉시 적용(글꼴·테마·히스토리 경로·sdk 표시). psmux·pwsh·리드 명령은 다음 세션부터. */
function saveSettings(raw: unknown): Promise<SaveSettingsResult> {
  const p = saveChain.then(() => saveSettingsNow(raw));
  saveChain = p.catch(() => undefined);
  return p;
}

async function saveSettingsNow(raw: unknown): Promise<SaveSettingsResult> {
  const { values, errors } = await validateSettings(raw);
  if (!values) {
    log('warn', `settings rejected: ${Object.keys(errors).join(', ')}`);
    return { ok: false, errors };
  }
  const prev = settings.get();
  const next: Settings = settings.update(values satisfies EditableSettings);
  const changed = (Object.keys(values) as (keyof EditableSettings)[]).filter((k) => prev[k] !== next[k]);
  log('info', `settings saved (changed: ${changed.join(', ') || 'none'})`);
  if (prev.theme !== next.theme) {
    nativeTheme.themeSource = next.theme;
    applyWindowTheme();
  }
  if (prev.theme !== next.theme || prev.fontSize !== next.fontSize || prev.fontFamily !== next.fontFamily) {
    send('settings:appearance', { fontSize: next.fontSize, fontFamily: next.fontFamily, theme: next.theme } satisfies AppearanceDto);
  }
  if (prev.historyDir !== next.historyDir) {
    history = { status: 'loading', items: [] };
    send('history:update', history);
    void indexer.restart(() => setProjectsDir(next.historyDir)).catch((e) => log('error', `history restart failed: ${errMsg(e)}`));
  } else if (prev.showSdkSessions !== next.showSdkSessions && indexer.ready) {
    publishHistory();
  }
  return { ok: true, errors: {}, view: await settingsView() };
}

/** Windows 표시 언어(선호 언어 목록의 첫 값, 없으면 앱 로케일) 기준 기본 UI 언어. app ready 뒤에만 부른다. */
function systemLang(): Lang {
  return langFromLocales([...app.getPreferredSystemLanguages(), app.getLocale()]);
}

/** 설정의 언어, 고르지 않았으면 시스템 언어. */
function effectiveLang(): Lang {
  return settings.get().language || systemLang();
}

/**
 * UI 언어 변경: 검증 → 저장(사용자가 고른 값만 settings.json에 남음) → main 문구 언어 전환 →
 * 열린 탭 상태·사용량을 다시 보내 이미 표시 중인 main 안내(탭 오류·사용량 오류)도 새 언어로 바꾼다.
 */
function setLanguage(raw: unknown): SetLanguageResultDto {
  if (!isLang(raw)) {
    log('warn', 'language rejected: unknown value');
    return { ok: false, language: getLang(), error: tr('set.language') };
  }
  settings.update({ language: raw });
  setLang(raw);
  log('info', `language set: ${raw}`);
  for (const t of orderedTabs()) send('tab:state', t.state());
  send('usage:update', usage.get());
  return { ok: true, language: raw };
}

/**
 * 계정 표시값과 로그인 상태. 이메일·조직은 ~/.claude.json, 로그인 여부는 claude auth status(JSON의 loggedIn만)를 쓰고
 * CLI가 없거나 실패하면 이메일 유무로 판정한다. 값 자체는 로그에 남기지 않는다(있음/없음·종료 코드만).
 * CLI 확인은 30초 캐시: 시작·⋯ 메뉴는 캐시를 바로 쓰고(오래됐으면 뒤에서 갱신 후 account:update), 로그아웃·로그인 확인은 fresh로 기다린다.
 *
 * Args:
 *   opts: fresh면 CLI 확인을 다시 실행하고 기다린다.
 */
async function loadAccount(opts: { fresh?: boolean } = {}): Promise<AccountDto> {
  if (opts.fresh) await auth.refresh(true);
  else if (auth.stale(AUTH_TTL_MS)) {
    // 시작·메뉴 열기를 막지 않게 CLI 확인은 뒤에서 하고, 끝나면 바뀐 값을 account:update로 보낸다
    void auth.refresh().then(async () => send('account:update', await accountDto()));
  }
  return accountDto();
}

/** CLI 확인 캐시 유효 시간(ms). */
const AUTH_TTL_MS = 30000;

/** where claude + claude auth status 1회(약 0.3~0.5초). 출력 본문은 남기지 않는다. */
async function runAuthCheck(): Promise<AuthCheckResult> {
  const cli = await resolveClaude();
  if (!cli) return { cli: null, status: null, statusReason: 'no cli' };
  const r = await runClaude(cli, ['auth', 'status', '--json'], STATUS_TIMEOUT_MS);
  const status = parseAuthStatus(r.stdout);
  if (status === null) log('warn', `claude auth status unreadable (exit ${r.code ?? r.reason ?? '?'}); falling back to account file`);
  return { cli, status, statusReason: status === null ? (r.reason ?? `exit ${r.code ?? '?'}`) : null };
}

/** CLI 확인 캐시(진행 중 공유·force 대기 1개 공유·예외 시 "모름", authCache.ts). */
const auth = new AuthCache(runAuthCheck, (e) => log('warn', `claude auth check failed: ${e instanceof Error ? e.name : 'error'}`));

/** 기동 시 자동 갱신용 로그인 판정: CLI 확인(진행 중이면 그 결과)을 기다린 뒤 계정 영역과 같은 기준으로 본다. */
async function startupLoggedIn(): Promise<boolean> {
  if (auth.stale(AUTH_TTL_MS)) await auth.refresh();
  return (await accountDto()).loggedIn;
}

/** 계정 표시값: ~/.claude.json(빠름) + CLI 캐시. 캐시가 아직 없으면 이메일 유무로 판정하고 CLI는 없는 것으로 본다. */
async function accountDto(): Promise<AccountDto> {
  const a = await readAccount();
  const cache = auth.get();
  const loggedIn = loggedInFrom(cache?.status ?? null, a.email);
  log('info', `account read (email: ${a.email ? 'yes' : 'no'}, org: ${a.org ? 'yes' : 'no'}, cli: ${cache ? (cache.cli ? 'yes' : 'no') : 'pending'}, loggedIn: ${loggedIn})`);
  return { ...a, loggedIn, cliAvailable: !!cache?.cli };
}


/** 로그아웃: claude auth logout(셸 없이, 15초 제한) → 계정 다시 읽기 → 사용량 표시 비우기. 열린 탭은 닫지 않는다. */
async function logout(): Promise<LogoutResultDto> {
  const cli = await resolveClaude();
  if (!cli) return { ok: false, error: tr('main.noCli'), account: await loadAccount({ fresh: true }) };
  const r = await runClaude(cli, ['auth', 'logout'], LOGOUT_TIMEOUT_MS);
  log('info', `auth logout ${r.timedOut ? 'timed out' : `exit ${r.code ?? r.reason ?? '?'}`}`);
  await auth.refresh(true);
  const cache = auth.get();
  // logout이 0으로 끝났는데 status를 읽지 못하면(비JSON·비0) 로그아웃된 것으로 본다. 이메일 유무로 대신 판정하지 않음.
  // 단 status 확인이 시간 초과로 끝났으면 상태를 모르는 것이므로 성공으로 보지 않는다
  if (r.code === 0 && cache?.status === null && cache.statusReason === 'timeout') {
    const account = await accountDto();
    send('account:update', account);
    return { ok: false, account, error: tr('logout.unverifiedTimeout') };
  }
  const unverified = r.code === 0 && cache?.status === null;
  if (unverified && cache) auth.set({ ...cache, status: false });
  const account = await accountDto();
  send('account:update', account);
  if (account.loggedIn) {
    return { ok: false, account, error: r.timedOut ? tr('logout.timeout') : tr('logout.unverifiedCode', { code: String(r.code ?? '?') }) };
  }
  usage.clear();
  return unverified ? { ok: true, account, notice: tr('logout.doneUnverified') } : { ok: true, account };
}

/** 열려 있는 로그인 탭(동시에 1개). */
function loginTab(): TabSession | undefined {
  return [...tabs.values()].find((t) => t.state().purpose === 'login');
}

/**
 * 로그인 탭: 새 psmux 세션의 칸에서 claude auth login을 실행한다(hook·statusLine 없음). 카드 터미널에서 브라우저 열기·코드 입력을 한다.
 * 칸이 셸로 돌아오면 계정을 다시 읽어 로그인됐으면 탭을 닫고, 아니면 카드에 안내를 띄운 채 감시를 계속한다(다시 실행하면 다시 확인).
 */
async function openLogin(): Promise<OpenResult> {
  const existing = loginTab();
  if (existing) return { ok: true, tabId: existing.tabId };
  const s = settings.get();
  const cli = await resolveClaude();
  if (!cli) return { ok: false, error: tr('main.noCli') };
  const psmux = await resolvePsmux(s.psmuxPath);
  if (!psmux) return { ok: false, error: tr('open.psmuxInstall') };
  // 작업 폴더는 앱 데이터 아래(세션 이름이 ctd-login-…이 되고, 프로젝트 폴더에 아무것도 남기지 않음)
  const folder = join(dataDir, 'login');
  mkdirSync(folder, { recursive: true });
  // pwsh 문법: 작은따옴표 경로(변수 확장 없음, '는 ''로) + 호출 연산자
  const leadCommand = `& '${cli.replace(/'/g, "''")}' auth login`;
  let t: TabSession;
  try {
    t = new TabSession({ psmux, folder, leadCommand, dataDir, hookCommand: null, statusLineCommand: null, shell: s.pwshPath || null, purpose: 'login' });
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
  const r = await startTab(t, 'login');
  if (r.ok) watchLogin(t);
  return r;
}

/** 로그인 칸 감시 주기(ms). 칸 명령은 TabSession이 주기적으로 읽어 둔 값을 쓴다(추가 psmux 호출 없음). */
const LOGIN_POLL_MS = 1000;

function watchLogin(t: TabSession): void {
  let w: LoginWatch = { sawProgram: false, since: Date.now() };
  let checking = false;
  const timer = setInterval(() => {
    if (tabs.get(t.tabId) !== t) {
      clearInterval(timer);
      return;
    }
    const lead = t.state().leadPaneId;
    if (!lead || checking) return;
    const cmd = String(t.paneInfo(lead).command ?? '');
    const shellNow = isShellCommand(cmd, settings.get().pwshPath || null);
    if (!shellNow && cmd.trim()) t.setLoginFailed(false); // 다시 실행 중이면 안내를 내린다
    const step = stepLogin(w, cmd, shellNow, Date.now());
    w = step.w;
    if (!step.done) return;
    checking = true;
    void (async () => {
      const a = await loadAccount({ fresh: true });
      send('account:update', a);
      if (a.loggedIn) {
        clearInterval(timer);
        log('info', `[${t.session}] login confirmed; closing login tab`);
        // 로그인 확인 직후 사용량 1회(실패는 조용히). 탭 닫기를 기다리게 하지 않는다
        void autoRefreshUsage(usage, async () => a.loggedIn, 'login');
        await closeTab(t, true);
      } else {
        log('info', `[${t.session}] login process ended but not logged in`);
        t.setLoginFailed(true);
        // 사용자가 칸에서 다시 실행하면 그 프로세스가 끝날 때 다시 확인한다
        w = { sawProgram: false, since: Number.POSITIVE_INFINITY };
      }
      checking = false;
    })();
  }, LOGIN_POLL_MS);
}


/** 대화(와 팀원)가 탭으로 열려 있거나, 여는 중이거나, 실행 중이면 삭제할 수 없는 사유. */
function trashBlockReason(sessionIds: string[]): string | null {
  const ids = new Set(sessionIds.map((x) => x.toLowerCase()));
  const has = (v: string | null | undefined): boolean => !!v && ids.has(v.toLowerCase());
  if ([...tabs.values()].some((t) => { const s = t.state(); return has(s.leadSessionId) || has(s.resumeSessionId); })) {
    return tr('trash.blockTab');
  }
  // 이어가기 세션을 만드는 중(아직 탭 없음)
  if ([...opening.keys()].some((k) => ids.has(k))) return tr('trash.blockOpening');
  if (running.some((r) => has(r.sessionId))) return tr('trash.blockRunning');
  return null;
}

/** 삭제 전 확인: 함께 옮길 파일 수와 삭제 불가 사유. */
async function trashPreview(sessionId: string): Promise<TrashPreviewDto> {
  await refreshRunning();
  const plan = await planTrash(projectsDir(), indexer.items(), sessionId);
  if (!plan) return { ok: false, extra: 0, folders: 0, error: tr('trash.notFound') };
  const blocked = trashBlockReason(plan.sessionIds);
  const sum = await movableSummary(projectsDir(), plan);
  const base = { extra: sum.extra, folders: sum.folders };
  if (blocked) return { ok: false, ...base, error: blocked };
  return sum.mainOk ? { ok: true, ...base } : { ok: false, ...base, error: tr('trash.unsafe') };
}

/**
 * 대화 삭제(~/.claude 읽기 전용 원칙의 예외): 대화·팀원 .jsonl과 각 대화 폴더(서브에이전트 기록·도구 결과)를 휴지통으로 옮긴다. 부분 실패면 성공분만 반영하고 한 줄 안내.
 * 끝나면 인덱스·캐시·앱 저장소(이름·보관) 항목을 바로 정리하고 목록을 다시 보낸다.
 */
async function trashConversation(sessionId: string): Promise<TrashResultDto> {
  await refreshRunning();
  const root = projectsDir();
  const plan = await planTrash(root, indexer.items(), sessionId);
  if (!plan) return { ok: false, moved: 0, failed: 0, error: tr('trash.notFound') };
  const blocked = trashBlockReason(plan.sessionIds);
  if (blocked) return { ok: false, moved: 0, failed: 0, error: blocked };
  const out = await moveToTrash(root, trashOrder(plan), (p) => shell.trashItem(p));
  const moved = new Set(out.moved);
  const gone = [plan.main, ...plan.mates].filter((x) => moved.has(x.path)).map((x) => x.key);
  indexer.removeFiles(gone);
  historyMeta.forget(gone);
  publishHistory();
  const failed = out.failed.length + out.refused.length;
  log('info', `history trash: moved ${out.moved.length}, failed ${out.failed.length}, refused ${out.refused.length}`);
  // 안전상 거부(정션·심볼릭 링크·모양 불일치)와 이동 실패(잠김·권한)를 구분해 안내한다
  if (out.refused.includes(plan.main.path)) return { ok: false, moved: out.moved.length, failed, error: tr('trash.unsafe') };
  if (!moved.has(plan.main.path)) return { ok: false, moved: out.moved.length, failed, error: tr('trash.moveFailed') };
  if (failed) {
    const parts = [out.failed.length ? tr('trash.partFailed', { n: out.failed.length }) : '', out.refused.length ? tr('trash.partRefused', { n: out.refused.length }) : ''].filter(Boolean);
    return { ok: false, moved: out.moved.length, failed, error: tr('trash.partial', { parts: parts.join(tr('common.listSep')) }) };
  }
  return { ok: true, moved: out.moved.length, failed: 0 };
}

/** psmux 세션 목록(계정 메뉴): 앱 세션(메타 있음)은 탭 전환·재연결 대상, 그 밖은 이름만. */
async function listPsmuxSessions(): Promise<{ ok: boolean; sessions: PsmuxSessionDto[]; error?: string }> {
  const psmux = await resolvePsmux(settings.get().psmuxPath);
  if (!psmux) return { ok: false, sessions: [], error: tr('psmux.notFound') };
  const r = await psmuxCli(psmux, ['list-sessions', '-F', '#{session_name}']);
  const live = parseListSessions(r.code, r.out, r.err);
  if (live === null) {
    log('warn', `session list failed (code ${r.code}: ${r.err.slice(0, 120)})`);
    return { ok: false, sessions: [], error: tr('sessions.readFailed') };
  }
  return { ok: true, sessions: classifySessions(live, (n) => readSessionMeta(dataDir, n) !== null, new Set(tabs.keys())) };
}

function publishHistory(): void {
  history = { status: 'ready', items: toHistoryDtos(indexer.items(), settings.get().showSdkSessions, historyMeta.get()) };
  send('history:update', history);
}

function runningDto(): RunningDto[] {
  return running.map((r) => ({ sessionId: r.sessionId, psmuxSession: r.psmuxSession, ours: r.ours, pid: r.pid, inPsmux: r.inPsmux }));
}

/** 실행 중인 대화 목록을 다시 읽고 바뀌었으면 렌더러에 알린다. */
async function refreshRunning(): Promise<RunningConversation[]> {
  try {
    const files = filterExcluded(await listRunningSessionFiles(), notRunning, sessionFileMtime);
    const metas = new Set(listMetaSessions(dataDir));
    running = buildRunning(files, pidAlive, (ps) => {
      const ours = isAppSessionName(ps) && metas.has(ps);
      return { ours, resumeSessionId: ours ? readSessionMeta(dataDir, ps)?.resumeSessionId : undefined };
    });
  } catch (e) {
    log('warn', `running sessions read failed: ${errMsg(e)}`);
  }
  const dto = runningDto();
  const j = JSON.stringify(dto);
  if (j !== runningJson) {
    runningJson = j;
    send('history:running', dto);
  }
  return running;
}

const eqi = (a: string | null | undefined, b: string): boolean => !!a && a.toLowerCase() === b.toLowerCase();

/**
 * 대화 클릭: 이미 탭이면 전환 → 앱 세션에서 실행 중이면 재연결 → 다른 곳에서 실행 중이면 거부 → 아니면 새 탭에서 -r.
 */
async function openHistory(sessionId: string, force: boolean): Promise<OpenResult> {
  const open = [...tabs.values()].find((t) => { const st = t.state(); return eqi(st.leadSessionId, sessionId) || eqi(st.resumeSessionId, sessionId); });
  if (open) return { ok: true, tabId: open.tabId };
  const r = findRunning(await refreshRunning(), sessionId);
  if (r) {
    if (r.psmuxSession && tabs.has(r.psmuxSession)) return { ok: true, tabId: r.psmuxSession };
    if (r.ours && r.psmuxSession) return attachSession(r.psmuxSession);
    // 같은 대화를 두 프로세스가 이어 쓰면 기록이 섞인다(중복 실행 금지).
    // 판정은 sessions/<pid>.json + pid 생존이라 pid가 재사용되면 오판할 수 있어, 사용자가 확인 후 강제로 이어갈 수 있게 한다
    if (!force) {
      const where = r.psmuxSession ? msg('open.wherePsmux', { name: r.psmuxSession }) : msg('open.whereOther');
      return { ok: false, canForce: true, error: tr('open.runningElsewhere', { where }) };
    }
    log('warn', `resume ${sessionId.slice(0, 8)} forced by user (running entry pid-based, psmux=${r.psmuxSession ?? '-'})`);
  }
  // 앱이 이 대화를 이어가던(또는 새로 시작한) 세션을 분리해 두었고 아직 살아 있으면(Claude는 끝났더라도) 새로 만들지 않고 그 세션에 붙는다(세션 누수 방지)
  const detached = await findDetachedResumeSession(sessionId);
  if (detached) return attachSession(detached);
  const item = indexer.find(sessionId);
  if (!item) return { ok: false, error: tr('open.notInHistory') };
  if (!item.cwd) return { ok: false, error: tr('open.noCwd') };
  // 에이전트 없이 열었던 대화는 그대로 에이전트 없이 이어간다(설정의 리드 명령을 붙이지 않음)
  return newSession(item.cwd, sessionId, uiStore.isPlainSession(sessionId));
}

/**
 * 메타의 resumeSessionId 또는 리드 대화 ID(지난 ID 목록 포함)가 이 대화인, 탭으로 열려 있지 않은 살아 있는 앱 세션. 없으면 null.
 * 새로 시작한 대화를 분리해 둔 경우도 새 세션을 만들지 않고 그 세션에 붙게 한다(세션 누수 방지).
 */
async function findDetachedResumeSession(sessionId: string): Promise<string | null> {
  const psmux = await resolvePsmux(settings.get().psmuxPath);
  if (!psmux) return null;
  for (const name of listMetaSessions(dataDir)) {
    if (tabs.has(name)) continue;
    const meta = readSessionMeta(dataDir, name);
    const ids = [meta?.resumeSessionId, meta?.leadSessionId, ...(meta?.leadSessionIds ?? [])];
    if (!ids.some((id) => eqi(id, sessionId))) continue;
    if (await hasSession(psmux, name)) return name;
  }
  return null;
}

/**
 * 히스토리 "세션 끊기…": 실행 중이고 탭으로 열려 있지 않은 대화의 세션을 끝낸다. 대상(앱 세션·외부 psmux 세션·psmux 밖 프로세스)은
 * 렌더러가 보낸 대화 ID로 main이 실행 목록에서 직접 찾고 실행 직전에 다시 확인한다. 같은 대상(alias 행 포함)의 요청은 같은 작업을 기다린다.
 */
async function stopDetached(sessionId: string): Promise<HistoryStopDto> {
  const sid = sessionId.slice(0, 8);
  const fail = (code: StopFailCode): HistoryStopDto => {
    log('warn', `history stop ${sid} refused: ${code}`);
    return { ok: false, error: stopFailMessage(code) };
  };
  if (opening.has(sessionId.toLowerCase())) return fail('opening');
  const list = await refreshRunning();
  const plan = planStop(sessionId, list, [...tabs.values()].map((t) => t.state()));
  if (typeof plan === 'string') {
    // planStop이 거부했어도(끊는 도중 목록이 바뀌어 미실행·탭 열림으로 보일 수 있음) alias 행 등 같은 대상을 이미 끊는 중이면 그 결과를 기다린다
    const name = findRunning(list, sessionId)?.psmuxSession;
    const cur = name ? stopping.get(name) : undefined;
    return cur ? cur.done : fail(plan);
  }
  const cur = stopping.get(plan.key);
  if (cur) return cur.done;
  // 목록을 읽는 사이(await) 같은 대상이 열리기 시작했거나 탭이 됐을 수 있다 → 등록 직후, 시작 전에 다시 본다(여기부터 시작까지 await 없음)
  const job: StopJob = { conn: null, done: Promise.resolve({ ok: false }) };
  stopping.set(plan.key, job);
  const raced = stopRace(plan, list);
  if (raced) {
    stopping.delete(plan.key);
    return fail(raced);
  }
  job.done = runStop(plan, job).then((code) => {
    if (code === null) {
      log('info', `history stop ${sid}: ${plan.kind} closed`);
      return { ok: true };
    }
    return fail(code);
  }, (e) => {
    log('error', `history stop ${sid} (${plan.kind}) failed: ${errMsg(e)}`);
    return { ok: false, error: stopFailMessage('error') };
  }).finally(() => {
    stopping.delete(plan.key);
    void refreshDetached();
  });
  return job.done;
}

/** 같은 대상(alias 행 포함: 같은 psmux 세션 또는 같은 pid)의 대화가 지금 열리는 중이거나 탭이면 사유 코드, 아니면 null. */
function stopRace(plan: StopPlan, list: RunningConversation[]): StopFailCode | null {
  const same = (r: RunningConversation): boolean => (plan.psmuxSession !== null ? r.psmuxSession === plan.psmuxSession : r.pid === plan.pid);
  const ids = new Set([plan.sessionId, ...[...list, ...running].filter(same).map((r) => r.sessionId)].map((id) => id.toLowerCase()));
  if ([...ids].some((id) => opening.has(id))) return 'opening';
  const open = [...tabs.values()].some((t) => {
    const st = t.state();
    return (plan.psmuxSession !== null && st.session === plan.psmuxSession)
      || (!!st.leadSessionId && ids.has(st.leadSessionId.toLowerCase())) || (!!st.resumeSessionId && ids.has(st.resumeSessionId.toLowerCase()));
  });
  return open ? 'tab-open' : null;
}

/** stopDetached 본체: 방식별로 끊고, 실행 목록에서 빠질 때까지 짧게 다시 읽어 렌더러에 바로 알린다. null = 성공. */
async function runStop(plan: StopPlan, job: StopJob): Promise<StopFailCode | null> {
  const code = plan.kind === 'process' ? await stopProcess(plan) : await stopPsmux(plan, job);
  // 끝난 뒤 Claude 프로세스가 사라지기까지 잠깐 걸릴 수 있어 몇 번 다시 읽는다(2.5초 폴링을 기다리지 않게).
  // 거부·실패면 기다리지 않고 한 번만 다시 읽는다(확정 거부로 실행 목록에서 빠진 행을 바로 반영)
  if (code !== null) {
    await refreshRunning();
    return code;
  }
  for (let i = 0; i < 5; i++) {
    const still = (await refreshRunning()).some((r) => (plan.psmuxSession !== null ? r.psmuxSession === plan.psmuxSession : r.pid === plan.pid));
    if (!still) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return code;
}

/** 앱 세션: 탭 ⋮ "종료…"와 같은 경로(탭 없이 붙어 리드에 팀 종료 요청 → 최대 30초 → kill-session). 외부 psmux 세션: 목록 확인 후 kill-session. */
async function stopPsmux(plan: StopPlan, job: StopJob): Promise<StopFailCode | null> {
  const name = plan.psmuxSession;
  if (!name || !isSafeSessionName(name)) return 'bad-name';
  const psmux = await resolvePsmux(settings.get().psmuxPath);
  if (!psmux) return 'no-psmux';
  if (plan.kind === 'psmux') {
    // 정확히 같은 이름이 지금 목록에 있을 때만(-t 접두어 일치로 다른 세션을 끝내지 않게)
    if (!(await listSessionNames(psmux)).includes(name)) return 'not-found';
    // pid가 재사용돼 남은 세션 파일이 같은 이름의 새 세션을 가리킬 수 있다 → 세션 파일을 확인할 수 없으면 끊지 않는다
    const owner = await checkPsmuxOwner(plan);
    if (owner !== null) return owner === 'unknown' ? 'pid-mismatch' : owner;
    const r = await psmuxCli(psmux, ['kill-session', '-t', name]);
    log('info', `history stop: external psmux kill-session code=${r.code}`);
    // 목록 조회 실패를 "사라짐"으로 보지 않는다(살아 있는 세션을 끊긴 것으로 보고하지 않게)
    return (await sessionGone(psmux, name)) === true ? null : 'still-alive';
  }
  const meta = readSessionMeta(dataDir, name);
  if (!meta) return 'no-meta';
  // 앱 세션은 메타로 대상을 정하므로 세션 파일 pid를 확인할 수 없으면 확인만 건너뛴다(어긋남이 확인되면 거부)
  const owner = await checkPsmuxOwner(plan);
  if (owner === 'unknown') log('info', `[${name}] history stop: owner check=skipped`);
  else if (owner !== null) return owner;
  const purpose = meta.purpose ?? 'conversation';
  const t = new TabSession({ psmux, folder: meta.folder, leadCommand: meta.leadCommand, dataDir, hookCommand: purpose === 'login' ? null : (await leadScriptCommands(false)).hook, attachName: name, purpose });
  job.conn = t;
  log('info', `[${name}] history stop: attaching without a tab`);
  try {
    await t.start();
  } catch (e) {
    t.detach();
    log('warn', `[${name}] history stop: attach failed: ${errMsg(e)}`);
    return 'attach-failed';
  }
  try {
    if (purpose === 'login') {
      // 로그인 세션에 종료 요청 문장을 보내면 로그인 프롬프트 입력이 되므로 바로 끝낸다(closeTab의 로그인 탭과 같음)
      await t.kill();
      log('info', `[${name}] history stop: login session killed`);
    } else {
      const requested = await t.terminate();
      log('info', `[${name}] history stop: shutdown request ${requested ? 'sent' : 'skipped'}`);
    }
  } finally {
    t.detach(); // terminate가 중간에 예외로 끝나도 -CC 연결을 남기지 않는다(kill 경로에서는 이미 끊김)
  }
  // 정확한 이름으로 확인(-t 접두어 일치 아님). 목록 조회 실패는 still-alive로 두어 탭 상태를 지우지 않는다
  const gone = (await sessionGone(psmux, name)) === true;
  if (gone) uiStore.removeTab(name);
  return gone ? null : 'still-alive';
}

/** 세션이 psmux 목록에서 사라졌는지(정확히 같은 이름). 목록 조회에 실패하면 null(모름). */
async function sessionGone(psmux: string, name: string): Promise<boolean | null> {
  const r = await psmuxCli(psmux, ['list-sessions', '-F', '#{session_name}']);
  const live = parseListSessions(r.code, r.out, r.err);
  return live === null ? null : !live.includes(name);
}

/**
 * psmux 밖 Claude Code: sessions/<pid>.json·생존을 다시 확인하고, 프로세스 정보(이름·명령줄·생성 시각·앱 조상 여부)로
 * pid 재사용·앱 자신의 조상을 거른 뒤 taskkill /T /F.
 */
async function stopProcess(plan: StopPlan): Promise<StopFailCode | null> {
  const pid = plan.pid;
  if (!isKillablePid(pid)) return 'bad-pid';
  if (pid === process.pid || pid === process.ppid) return 'self';
  // <pid>.json 자체를 다시 읽는다(다른 이름의 파일이 같은 pid를 담고 있어도 그것으로 통과하지 않게)
  if (!sessionFileOwns(await readRunningSessionFile(pid), pid, new Set([plan.sessionId.toLowerCase()]), null)) return 'pid-mismatch';
  if (!pidAlive(pid)) return 'not-running';
  const mtimeMs = sessionFileMtime(pid);
  if (mtimeMs === null) return 'pid-mismatch'; // 파일 이름의 pid와 내용의 pid가 다르거나 그새 지워짐
  const info = await queryProcess(pid, process.pid);
  if (info === 'gone') return 'not-running';
  if (info === null) return 'error'; // PowerShell 실행·출력 해석 실패: 확인 못 한 것을 Claude 아님으로 보고하지 않는다
  const refused = judgeKill(info, mtimeMs);
  if (refused) {
    log('warn', `history stop: pid ${pid} check=${refused}`);
    if (isDefinitiveRefusal(refused, info)) excludeRunning(pid, mtimeMs);
    return refused;
  }
  const killed = await killProcessTree(pid);
  for (let i = 0; i < 10 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 300));
  log('info', `history stop: taskkill pid ${pid} exit=${killed ? 0 : 'nonzero'}`);
  return pidAlive(pid) ? 'kill-failed' : null;
}

/** sessions/<pid>.json 수정 시각(ms). 없거나 읽지 못하면 null. */
function sessionFileMtime(pid: number): number | null {
  try {
    return statSync(join(claudeHomeDir(), 'sessions', `${pid}.json`)).mtimeMs;
  } catch {
    return null;
  }
}

/** 확정 거부된 세션 파일을 다음 재조회부터 실행 목록에서 뺀다. */
function excludeRunning(pid: number, mtimeMs: number): void {
  notRunning.set(pid, mtimeMs);
  log('info', `history stop: pid ${pid} excluded from running list`);
}

/**
 * psmux 경로(외부 psmux·앱 세션)의 세션 파일 pid 확인. 'unknown' = pid·세션 파일이 없어 확인 불가, null = 통과.
 * <pid>.json이 이 대화(alias 포함)·이 psmux 세션·같은 pid를 가리키지 않으면 pid-mismatch(파일 내용 불일치라 제외 캐시에는 넣지 않음).
 * 생성 시각 불일치(judgeOwner)는 확정 거부로 실행 목록에서 뺀다.
 */
async function checkPsmuxOwner(plan: StopPlan): Promise<StopFailCode | 'unknown' | null> {
  const pid = plan.pid;
  const file = isKillablePid(pid) ? await readRunningSessionFile(pid) : null;
  if (!file) return 'unknown';
  // alias 행이면 plan.sessionId는 이어간 원래 ID이고 파일에는 새 ID가 있으므로, 같은 세션·같은 pid 행의 ID를 모두 인정한다
  const ids = new Set([plan.sessionId, ...running.filter((r) => r.pid === pid && r.psmuxSession === plan.psmuxSession).map((r) => r.sessionId)].map((id) => id.toLowerCase()));
  if (!sessionFileOwns(file, pid, ids, plan.psmuxSession)) {
    log('warn', `history stop: pid ${pid} check=pid-mismatch (session file)`);
    return 'pid-mismatch';
  }
  const mtimeMs = sessionFileMtime(pid);
  if (mtimeMs === null) return 'unknown';
  const info = await queryProcess(pid, process.pid);
  if (info === 'gone') return 'not-running';
  if (info === null) return 'error';
  const refused = judgeOwner(info, mtimeMs);
  if (refused) {
    log('warn', `history stop: pid ${pid} check=${refused}`);
    if (isDefinitiveRefusal(refused, info)) excludeRunning(pid, mtimeMs);
  }
  return refused;
}

/** 탭을 닫는다: 분리(세션 유지) 또는 종료 후. 세션이 이미 없으면 앱 파일도 정리. */
async function closeTab(t: TabSession, terminate: boolean): Promise<boolean> {
  // 종료 처리 중에는 분리·중복 종료를 받지 않는다(종료가 끝나면 탭이 닫힘)
  if (t.state().terminating) return false;
  let how = terminate ? 'terminated' : 'detached';
  if (t.state().purpose === 'login') {
    // 로그인 탭은 분리해도 남길 이유가 없고, 종료 요청 문장을 로그인 프롬프트에 보내면 안 되므로 바로 세션을 끝낸다
    await t.kill();
    uiStore.removeTab(t.session);
  } else if (terminate) {
    await t.terminate();
    uiStore.removeTab(t.session);
  } else if (isFreshTab(t)) {
    // 대화 기록이 없는 탭: 분리해 둘 이유가 없고, 종료 요청 문장을 보내면 그 문장으로 대화가 생기므로 바로 세션을 끝낸다(로그인 탭과 같음)
    await t.kill();
    uiStore.removeTab(t.session);
    how = 'killed (no conversation)';
  } else {
    t.detach();
    const psmux = await resolvePsmux(settings.get().psmuxPath);
    // 끝난 세션의 탭을 닫으면(세션 없음 확인) 그 앱 파일도 정리
    if (t.state().status === 'ended' && psmux && !(await hasSession(psmux, t.session))) {
      removeSessionFiles(dataDir, t.session);
      uiStore.removeTab(t.session);
    }
  }
  if (tabs.get(t.tabId) === t) tabs.delete(t.tabId);
  log('info', `[${t.session}] tab closed (${how})`);
  send('tab:closed', t.tabId);
  void refreshRunning();
  void refreshDetached();
  return true;
}

// IPC 인자 검증(렌더러 입력은 신뢰 경계 밖)
const isStr = (v: unknown, max = 100000): v is string => typeof v === 'string' && v.length <= max;
const isPane = (v: unknown): v is string => typeof v === 'string' && /^%\d+$/.test(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 10000;
const isSid = (v: unknown): v is string => typeof v === 'string' && SESSION_ID_RE.test(v);
/** 폴더면 true(없거나 파일이면 false). */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function tabOf(id: unknown): TabSession | null {
  return typeof id === 'string' ? tabs.get(id) ?? null : null;
}

function registerIpc(): void {
  ipcMain.handle('app:init', async () => {
    restoring ??= restoreSessions().catch((e) => log('error', `restore failed: ${errMsg(e)}`));
    await restoring;
    await refreshRunning();
    usageReady ??= usage.start().catch((e) => log('warn', `usage start failed: ${errMsg(e)}`));
    await usageReady;
    const s = settings.get();
    const init = {
      fontSize: s.fontSize, fontFamily: s.fontFamily, theme: s.theme, account: await loadAccount(), recentFolders: s.recentFolders, homeDir: app.getPath('home'),
      tabs: orderedTabs().map((t) => t.state()), history, running: runningDto(), detached, uiState: uiStore.get(), usage: usage.get(),
    };
    // 기동 시 1회: 렌더러가 init 응답(현재 값)을 받은 뒤 결과가 usage:update로 간다(CLI 확인·네트워크를 기다리므로 응답보다 늦음)
    startupUsage ??= autoRefreshUsage(usage, startupLoggedIn, 'startup');
    return init;
  });
  // ↻: /api/oauth/usage 1회(진행 중이면 같은 요청을 기다림). 반환값에는 사용률·시각·안내 문구만 있다
  ipcMain.handle('usage:refresh', () => usage.refresh());
  // 설정
  ipcMain.handle('settings:get', () => settingsView());
  ipcMain.handle('settings:save', (_e, raw: unknown) => saveSettings(raw));
  // UI 언어: 렌더러가 첫 렌더 전에 읽고, 언어 선택 대화상자에서 바꾼다
  ipcMain.handle('settings:language', () => getLang());
  ipcMain.handle('settings:setLanguage', (_e, lang: unknown) => setLanguage(lang));
  // 계정·세션 목록·앱 정보
  ipcMain.handle('account:get', () => loadAccount());
  // 로그아웃·로그인
  ipcMain.handle('auth:logout', () => logout());
  ipcMain.handle('auth:login', () => openLogin());
  // Agents 설정(읽기 전용 조사 + 리드 명령 저장만. ~/.claude 에는 쓰지 않는다)
  ipcMain.handle('agents:list', async (_e, tabId: unknown): Promise<AgentsDto> => {
    // 프로젝트 폴더는 렌더러가 준 경로가 아니라 main의 탭 상태에서 꺼낸다(로그인 탭 제외)
    const st = typeof tabId === 'string' ? tabs.get(tabId)?.state() : undefined;
    const folder = st && st.purpose !== 'login' ? st.folder : null;
    const r = await listAgents(folder, settings.get().leadCommand);
    log('info', `agents list: ${r.agents.length} file(s) (errors ${r.agents.filter((a) => a.error).length}, project ${r.projectDir ? 'yes' : 'no'}, teams ${r.teams.enabled ? 'on' : 'off'})`);
    return r;
  });
  ipcMain.handle('agents:setLead', (_e, name: unknown) => {
    if (typeof name !== 'string' || !AGENT_NAME_RE.test(name)) return { ok: false, error: tr('agents.badName') };
    const leadCommand = leadCommandFor(name);
    const err = leadCommandError(leadCommand);
    if (err) return { ok: false, error: err };
    settings.update({ leadCommand });
    log('info', `lead agent set: ${name}`);
    return { ok: true, leadCommand };
  });
  ipcMain.handle('agents:copyTemplate', () => {
    clipboard.writeText(AGENT_TEMPLATE);
    return true;
  });
  ipcMain.handle('agents:openFolder', async () => {
    // agents가 폴더가 아니면(없음·같은 이름의 파일) 그 파일을 실행하지 않도록 ~/.claude를 연다
    const dir = isDirectory(agentsDir()) ? agentsDir() : claudeHomeDir();
    const r = await shell.openPath(dir);
    if (r) log('warn', 'agents folder open failed');
    return !r;
  });
  ipcMain.handle('agents:leadCommand', () => settings.get().leadCommand);
  // 히스토리 항목 메뉴(키·ID는 main에서 형식 검증)
  // 인덱스에 있는 대화의 키만 받는다(없는 키로 저장소가 불어나지 않게)
  const indexedKey = (key: unknown): boolean => typeof key === 'string' && indexer.items().some((i) => i.key === key);
  ipcMain.handle('history:rename', (_e, key: unknown, title: unknown) => {
    if (!indexedKey(key) || !historyMeta.rename(key, typeof title === 'string' ? title : '')) return false;
    publishHistory();
    return true;
  });
  ipcMain.handle('history:archive', (_e, key: unknown, archived: unknown) => {
    if (!indexedKey(key) || !historyMeta.setArchived(key, archived)) return false;
    publishHistory();
    return true;
  });
  ipcMain.handle('history:trashPreview', (_e, sid: unknown): Promise<TrashPreviewDto> | TrashPreviewDto =>
    (isSid(sid) ? trashPreview(sid) : { ok: false, extra: 0, folders: 0, error: tr('ipc.badSessionId') }));
  ipcMain.handle('history:trash', (_e, sid: unknown): Promise<TrashResultDto> | TrashResultDto =>
    (isSid(sid) ? trashConversation(sid) : { ok: false, moved: 0, failed: 0, error: tr('ipc.badSessionId') }));
  // 세션 끊기: 렌더러는 대화 ID만 보낸다(psmux 세션 이름·pid는 main이 실행 목록에서 찾음)
  ipcMain.handle('history:terminate', (_e, sid: unknown): Promise<HistoryStopDto> | HistoryStopDto =>
    (isSid(sid) ? stopDetached(sid) : { ok: false, error: tr('ipc.badSessionId') }));
  // 탭 없는 앱 세션: 다시 연결(새 탭)·끊기(종료 요청 없이 kill-session). 이름은 앱 세션 형식만 받는다
  ipcMain.handle('session:attach', (_e, name: unknown): Promise<OpenResult> | OpenResult =>
    (isStr(name, 200) && isAppSessionName(name) ? attachSession(name) : { ok: false, error: tr('ipc.badSessionId') }));
  ipcMain.handle('session:stopDetached', (_e, name: unknown): Promise<HistoryStopDto> | HistoryStopDto =>
    (isStr(name, 200) && isAppSessionName(name) ? stopOrphan(name) : { ok: false, error: tr('ipc.badSessionId') }));
  ipcMain.handle('psmux:sessions', () => listPsmuxSessions());
  ipcMain.handle('psmux:open', async (_e, name: unknown) => {
    if (!isStr(name, 200) || !isAppSessionName(name)) return { ok: false, error: tr('ipc.appSessionOnly') };
    const existing = tabs.get(name);
    if (existing) return { ok: true, tabId: existing.tabId };
    const psmux = await resolvePsmux(settings.get().psmuxPath);
    // 없는 이름으로 연결하면 psmux가 새 세션을 만든다 → 먼저 확인
    if (!psmux || !(await hasSession(psmux, name))) return { ok: false, error: tr('ipc.sessionGone', { name }) };
    return attachSession(name);
  });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('history:open', async (_e, sid: unknown, force: unknown) => {
    if (!isSid(sid)) return { ok: false, error: tr('ipc.badSessionId') };
    const key = sid.toLowerCase();
    const cur = opening.get(key);
    if (cur) return cur;
    const p = openHistory(sid, force === true).finally(() => opening.delete(key));
    opening.set(key, p);
    return p;
  });
  ipcMain.on('history:refresh', () => {
    if (history.status === 'error') {
      history = { status: 'loading', items: [] };
      send('history:update', history);
    }
    void indexer.scanAll().then(() => { if (indexer.ready) publishHistory(); });
  });
  ipcMain.handle('tab:detach', async (_e, tabId: unknown) => {
    const t = tabOf(tabId);
    return t ? closeTab(t, false) : false;
  });
  ipcMain.handle('tab:terminate', async (_e, tabId: unknown) => {
    const t = tabOf(tabId);
    return t ? closeTab(t, true) : false;
  });
  ipcMain.on('ui:collapsed', (_e: IpcMainEvent, keys: unknown) => uiStore.setCollapsed(keys));
  ipcMain.on('ui:sidebar', (_e: IpcMainEvent, v: unknown) => uiStore.setSidebarCollapsed(v));
  ipcMain.on('ui:sidebarWidth', (_e: IpcMainEvent, v: unknown) => uiStore.setSidebarWidth(v));
  ipcMain.on('ui:filter', (_e: IpcMainEvent, v: unknown) => uiStore.setHistoryFilter(v));
  ipcMain.on('ui:tab', (_e: IpcMainEvent, session: unknown, ui: unknown) => { if (typeof session === 'string' && tabs.has(session)) uiStore.setTab(session, ui); });
  ipcMain.handle('dialog:pickFolder', async (e: IpcMainInvokeEvent) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w!, { title: tr('dialog.pickProject'), properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  // 이미지·파일 첨부 버튼(여러 개 선택)
  ipcMain.handle('dialog:pickFiles', async (e: IpcMainInvokeEvent, kind: unknown) => {
    if (AUTO.pickFiles) return AUTO.pickFiles.split('|').filter(Boolean);
    const w = BrowserWindow.fromWebContents(e.sender);
    const image = kind === 'image';
    const r = await dialog.showOpenDialog(w!, {
      title: tr(image ? 'dialog.attachImages' : 'dialog.attachFiles'), properties: ['openFile', 'multiSelections'],
      filters: image ? [{ name: tr('dialog.images'), extensions: IMAGE_EXTS }, { name: tr('dialog.allFiles'), extensions: ['*'] }] : [{ name: tr('dialog.allFiles'), extensions: ['*'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  // 폴더 추가(/add-dir)
  ipcMain.handle('dialog:pickAddDir', async (e: IpcMainInvokeEvent) => {
    if (AUTO.pickDir) return AUTO.pickDir;
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w!, { title: tr('dialog.addDir'), properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  // Ctrl+V 이미지: 시스템 클립보드 이미지를 PNG(무손실)로 앱 데이터 clips에 저장
  ipcMain.handle('clip:saveImage', async () => {
    try {
      // PNG는 바이트 그대로(픽셀 동일), JPEG(image/jpeg 또는 Windows 'JFIF' 원시 형식)만 있으면 nativeImage로 PNG 변환
      const items = await clipboard.read();
      const src = pickClipImage(items.map((i) => i.types));
      if (!src) {
        const types = [...new Set(items.flatMap((i) => i.types))];
        const anyImage = types.some((t) => t.startsWith('image/'));
        log('warn', `clip image: ${anyImage ? 'unsupported format' : 'no image'} [${types.join(', ').slice(0, 300)}]`);
        return anyImage ? { ok: false, error: tr('clip.unsupported') } : { ok: false, error: tr('clip.none'), noImage: true };
      }
      const blob = (await items[src.index].getType(src.type)) as Blob;
      if (blob.size > MAX_CLIP_BYTES) {
        log('warn', `clip image too large: ${blob.size} bytes (${src.type})`);
        return { ok: false, error: tr('clip.tooLarge', { mb: MAX_CLIP_BYTES / 1024 / 1024 }) };
      }
      let buf: Buffer = Buffer.from(await blob.arrayBuffer());
      if (!src.png) {
        const img = nativeImage.createFromBuffer(buf);
        buf = img.isEmpty() ? Buffer.alloc(0) : img.toPNG();
      }
      if (!buf.length) {
        log('warn', `clip image: could not decode ${src.type} (${blob.size} bytes)`);
        return { ok: false, error: tr('clip.unreadable') };
      }
      return { ok: true, path: saveClipPng(dataDir, buf) };
    } catch (e) {
      log('error', `clip image save failed: ${errMsg(e)}`);
      return { ok: false, error: tr('clip.saveFailedErr', { err: errMsg(e) }) };
    }
  });
  ipcMain.handle('session:new', async (_e, folder: unknown, plain: unknown) => (isStr(folder, 1000) ? newSession(folder, undefined, plain === true) : { ok: false, error: tr('ipc.badFolder') }));
  ipcMain.handle('pane:input', async (_e, tabId: unknown, pane: unknown, text: unknown) => {
    const t = tabOf(tabId);
    return !!t && isPane(pane) && isStr(text) ? t.sendInput(pane, text) : false;
  });
  ipcMain.on('pane:keys', (_e: IpcMainEvent, tabId: unknown, pane: unknown, data: unknown) => {
    const t = tabOf(tabId);
    if (t && isPane(pane) && isStr(data, 20000)) void t.sendKeys(pane, data);
  });
  ipcMain.on('pane:resize', (_e: IpcMainEvent, tabId: unknown, pane: unknown, cols: unknown, rows: unknown) => {
    const t = tabOf(tabId);
    if (t && isPane(pane) && isInt(cols) && isInt(rows)) void t.resizePane(pane, cols, rows);
  });
  ipcMain.on('pane:resync', (_e: IpcMainEvent, tabId: unknown, pane: unknown) => {
    const t = tabOf(tabId);
    if (t && isPane(pane)) void t.resync(pane);
  });
  ipcMain.on('tab:reconnect', (_e: IpcMainEvent, tabId: unknown) => tabOf(tabId)?.reconnectNow());
  ipcMain.handle('pane:info', (_e, tabId: unknown, pane: unknown) => {
    const t = tabOf(tabId);
    return t && isPane(pane) ? t.paneInfo(pane) : null;
  });
  ipcMain.handle('pane:stop', async (e: IpcMainInvokeEvent, tabId: unknown, pane: unknown, name: unknown) => {
    const t = tabOf(tabId);
    if (!t || !isPane(pane) || !isStr(name, 200)) return false;
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showMessageBox(w!, {
      // 메뉴·상태 문구는 현재 UI 언어
      type: 'question', buttons: [tr('stopMate.confirm'), tr('common.cancel')], defaultId: 1, cancelId: 1,
      title: tr('card.stopMate'), message: tr('stopMate.message', { name }),
      detail: tr('stopMate.detail'),
    });
    return r.response === 0 ? t.requestStop(pane) : false;
  });
}

/** 창 배경(첫 그리기·크기 조절 때 보이는 색): 테마의 bg.app. */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0D1117' : '#FBFBF9';
}

/** 앱이 그리는 제목줄 높이(px). 렌더러 .titlebar와 같아야 한다. */
const TITLE_BAR_H = 32;

/** 제목줄 오버레이(최소화·최대화·닫기) 색: 배경 bg.sidebar, 기호 text.primary. */
function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#010409' : '#F5F4EF', symbolColor: dark ? '#E6EDF3' : '#1F2328', height: TITLE_BAR_H };
}

/** 테마가 바뀌면(설정·OS) 창 배경과 제목줄 버튼 색을 함께 맞춘다. */
function applyWindowTheme(): void {
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(windowBackground());
  win.setTitleBarOverlay(titleBarOverlay());
}

/** 창 아이콘 경로(설치본은 asarUnpack 사본: Windows 아이콘 로더는 asar 안을 읽지 못함). */
const appIcon = asarUnpackedPath(join(__dirname, '..', 'assets', 'app.ico'));

function createWindow(): void {
  win = new BrowserWindow({
    // 최소 내용 폭 1028 = 사이드바 240 + 그리드 padding 24 + 경계선 12 + (카드 360 + 세로 스크롤바 16)×2: 레이아웃 4(50%)에서
    // 팀원 열에 스크롤바가 생겨도 팀원 카드 ≥ 360(실측: 1021 → 357, 1028 → 361)
    // 크기·최소 크기는 창 테두리를 뺀 내용 영역 기준(useContentSize). 테두리 포함 기준이면 위 계산보다 좁아짐
    // 최소 높이 672 = 기존 앱 영역 640 + 앱이 그리는 제목줄 32(제목줄이 내용 영역 안으로 들어옴)
    width: 1600, height: 1000, minWidth: 1028, minHeight: 640 + TITLE_BAR_H, useContentSize: true,
    title: 'Rich psmux',
    // 제목줄은 렌더러가 그린다(왼쪽 logo1 + 제목). 최소화·최대화·닫기는 Windows 기본 오버레이(Windows 전용 기능)
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    // 창·작업표시줄 아이콘(logo2.ico). 설치본은 exe 아이콘과 같지만, 개발 실행(electron.exe)에서도 같게 보이도록 지정
    ...(existsSync(appIcon) ? { icon: appIcon } : {}),
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
    },
  });
  win.removeMenu();
  // 테마가 '시스템'일 때 OS 설정이 바뀌면 창 배경·제목줄 버튼 색도 맞춘다
  nativeTheme.on('updated', () => applyWindowTheme());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', (_e, d) => log('error', `renderer gone: ${d.reason}`));
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') log(e.level === 'error' ? 'error' : 'warn', `[renderer] ${e.message.slice(0, 500)}`);
  });
  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  // 히스토리 인덱스: 창과 별개로 시작(첫 스캔이 끝나면 목록을 보냄)
  indexer.on('update', () => publishHistory());
  indexer.on('error', (msg: string) => {
    if (indexer.ready) return;
    history = { status: 'error', items: [], error: msg };
    send('history:update', history);
  });
  void indexer.start();
  setInterval(() => void refreshRunning(), RUNNING_POLL_MS);
  setInterval(() => void refreshDetached(), DETACHED_POLL_MS);
  win.on('closed', () => { win = null; });
  if (AUTO.folder) win.webContents.once('did-finish-load', () => void runAuto());
}

async function runAuto(): Promise<void> {
  log('info', `[auto] start session in ${AUTO.folder}`);
  const r = await newSession(AUTO.folder!);
  if (!r.ok || !r.tab) {
    log('error', `[auto] failed: ${r.error}`);
    return;
  }
  send('tab:state', r.tab);
  const t = tabs.get(r.tab.tabId)!;
  // 검증 자동화: 이번 실행이 만든 세션만 정리 대상으로 기록
  autoTabs.add(t.tabId);
  if (AUTO.prompt) {
    // CEO 입력창이 준비될 때까지 기다린 뒤 입력창 경로(sendInput)로 1회 전송
    setTimeout(() => {
      const lead = t.state().leadPaneId;
      if (lead) void t.sendInput(lead, AUTO.prompt!).then((ok) => log('info', `[auto] prompt sent ok=${ok}`));
    }, Number(devEnv.CTD_AUTOPROMPT_DELAY_MS ?? 25000));
  }
  if (AUTO.shot) {
    setTimeout(async () => {
      try {
        const img = await win!.webContents.capturePage();
        writeFileSync(AUTO.shot!, img.toPNG());
        log('info', `[auto] screenshot saved ${AUTO.shot}`);
        writeFileSync(AUTO.shot!.replace(/\.png$/i, '.state.json'), JSON.stringify(t.state(), null, 2));
      } catch (e) {
        log('error', `[auto] screenshot failed: ${errMsg(e)}`);
      }
      if (AUTO.quit) app.quit();
    }, AUTO.shotDelayMs);
  }
}

app.on('second-instance', () => win?.focus());
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    // 시스템 로케일은 ready 뒤에만 정확하다. IPC·창보다 먼저 정해 첫 메시지부터 이 언어로 만든다
    setLang(effectiveLang());
    log('info', `ui language: ${getLang()}${settings.get().language ? '' : ' (system)'}`);
    registerIpc();
    cleanupClips(dataDir);
    createWindow();
    log('info', `app ready (data=${dataDir}, sessionData=${app.getPath('sessionData')})`);
  });
}

let quitting = false;
/** 검증 자동화(CTD_AUTOSTART_FOLDER)로 이번 실행이 만든 탭. */
const autoTabs = new Set<string>();
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  indexer.stop();
  usage.stop();
  uiStore.flush();
  const autoList = [...tabs.values()].filter((t) => autoTabs.has(t.tabId));
  if (AUTO.killOnQuit && autoList.length) {
    // 검증 자동화에서 이번 실행이 만든 ctd- 세션만 정리(복원한 세션은 분리만)
    // Claude가 팀 폴더 등을 스스로 정리하도록 /exit 후 잠시 기다렸다가 세션 종료
    e.preventDefault();
    for (const t of tabs.values()) if (!autoTabs.has(t.tabId)) t.detach();
    const all = autoList;
    void Promise.all(all.map((t) => { const l = t.state().leadPaneId; return l ? t.sendInput(l, '/exit') : Promise.resolve(false); }))
      .then(() => new Promise((r) => setTimeout(r, 6000)))
      .then(() => Promise.all(all.map((t) => t.kill())))
      .finally(() => app.quit());
    return;
  }
  for (const t of tabs.values()) t.detach();
  // 히스토리 "세션 끊기…" 중이던 탭 없는 연결도 끊는다(-CC 프로세스가 남지 않게, 세션은 다음 실행 때 다시 보임)
  for (const j of stopping.values()) j.conn?.detach();
});
app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (e) => log('error', `uncaught: ${e.stack ?? e.message}`));
process.on('unhandledRejection', (e) => log('error', `unhandled rejection: ${errMsg(e)}`));
