// 앱 데이터 폴더(%APPDATA%\rich-psmux)의 세션별 파일·화면 상태 저장. ~/.claude 와 무관.
// 세션별 파일: sessions/<세션>.json(메타), cache/labels-<세션>.json(이름표 캐시), hooks/<세션>.settings.json·.events.jsonl(hook).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SESSION_ID_RE } from '../shared/ids';
import { clampSidebarWidth, SIDEBAR_DEFAULT_W } from '../shared/sidebar';
import { errMsg, log } from './logger';

/** 세션 메타(앱이 만든 세션을 다시 찾고 복원하는 데 쓰는 값). */
export interface SessionMeta {
  session: string;
  folder: string;
  leadPaneId: string | null;
  /** 리드 실행 명령(-r 제외 원본). 리드 이름(@ceo) 계산 기준. */
  leadCommand: string;
  createdAt: number;
  /** -r 로 이어간 대화 sessionId(새 대화면 없음). */
  resumeSessionId?: string;
  /** 리드에서 실행된 대화 sessionId. 알게 되면 기록. 탭 없는 세션 판정·히스토리 클릭 재연결 기준. */
  leadSessionId?: string;
  /** 리드에서 본 대화 sessionId 전부(본 순서, 최대 MAX_LEAD_IDS개). /clear로 ID가 바뀌어도 지난 대화를 이 세션 것으로 알아본다. */
  leadSessionIds?: string[];
  /** 로그인 전용 탭(F7-2)이 만든 세션. 앱을 다시 열면 복원하지 않고 정리한다. */
  purpose?: 'login';
}

/** 세션별 앱 파일 경로. */
export function sessionFiles(dataDir: string, session: string): { meta: string; labels: string; hookSettings: string; hookEvents: string } {
  return {
    meta: join(dataDir, 'sessions', `${session}.json`),
    labels: join(dataDir, 'cache', `labels-${session}.json`),
    hookSettings: join(dataDir, 'hooks', `${session}.settings.json`),
    hookEvents: join(dataDir, 'hooks', `${session}.events.jsonl`),
  };
}

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/** 메타에 남기는 리드 대화 ID 최대 개수(오래된 것부터 버림). */
export const MAX_LEAD_IDS = 50;

/**
 * 리드 대화 ID 목록에 새 ID를 덧붙인다(대소문자 무시 중복이면 그대로, 넘치면 오래된 것부터 버림).
 *
 * Args:
 *   list: 지금까지 본 ID(본 순서).
 *   id: 새로 본 ID.
 *
 * Returns:
 *   새 배열(입력은 바꾸지 않음).
 */
export function appendLeadId(list: readonly string[], id: string): string[] {
  if (list.some((x) => x.toLowerCase() === id.toLowerCase())) return [...list];
  return [...list, id].slice(-MAX_LEAD_IDS);
}

/** 메타 원본의 leadSessionIds 검증: 형식이 맞는 것만, 중복 없이, 최근 MAX_LEAD_IDS개. 옛 메타(목록 없음)는 leadSessionId로 채운다. */
function parseLeadIds(raw: unknown, latest: string | undefined): string[] {
  let out: string[] = [];
  const ids = Array.isArray(raw) ? raw : [];
  for (const x of ids) if (typeof x === 'string' && SESSION_ID_RE.test(x)) out = appendLeadId(out, x);
  if (latest) out = appendLeadId(out, latest);
  return out;
}

/** 메타 원본을 검증한다. 필수 값이 틀리면 null. */
export function parseMeta(raw: unknown, session: string): SessionMeta | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof o.folder !== 'string' || !o.folder) return null;
  const lead = typeof o.leadSessionId === 'string' && SESSION_ID_RE.test(o.leadSessionId) ? o.leadSessionId : undefined;
  const leadIds = parseLeadIds(o.leadSessionIds, lead);
  return {
    session,
    folder: o.folder,
    leadPaneId: typeof o.leadPaneId === 'string' && /^%\d+$/.test(o.leadPaneId) ? o.leadPaneId : null,
    leadCommand: typeof o.leadCommand === 'string' && o.leadCommand.trim() && !/[\r\n]/.test(o.leadCommand) ? o.leadCommand : 'claude --agent ceo',
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    resumeSessionId: typeof o.resumeSessionId === 'string' && SESSION_ID_RE.test(o.resumeSessionId) ? o.resumeSessionId : undefined,
    leadSessionId: lead,
    ...(leadIds.length ? { leadSessionIds: leadIds } : {}),
    ...(o.purpose === 'login' ? { purpose: 'login' as const } : {}),
  };
}

/** 메타 읽기. 없거나 손상이면 null. */
export function readSessionMeta(dataDir: string, session: string): SessionMeta | null {
  if (!SAFE_NAME.test(session)) return null;
  try {
    return parseMeta(JSON.parse(readFileSync(sessionFiles(dataDir, session).meta, 'utf8')), session);
  } catch {
    return null;
  }
}

/** 메타 저장(임시 파일 → rename). 실패는 로그만. */
export function writeSessionMeta(dataDir: string, meta: SessionMeta): void {
  writeJsonAtomic(sessionFiles(dataDir, meta.session).meta, meta, `[${meta.session}] meta save`);
}

/** 메타가 있는 세션 이름 목록. */
export function listMetaSessions(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, 'sessions'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .filter((n) => SAFE_NAME.test(n));
  } catch {
    return [];
  }
}

/** 종료된 세션의 앱 파일을 지운다(메타·이름표 캐시·hook 설정·hook 기록). */
export function removeSessionFiles(dataDir: string, session: string): void {
  if (!SAFE_NAME.test(session)) return;
  const removed: string[] = [];
  for (const p of Object.values(sessionFiles(dataDir, session))) {
    try {
      if (existsSync(p)) {
        rmSync(p, { force: true });
        removed.push(p.slice(dataDir.length + 1));
      }
    } catch (e) {
      log('warn', `[${session}] cleanup failed ${p}: ${errMsg(e)}`);
    }
  }
  if (removed.length) log('info', `[${session}] app files removed: ${removed.join(', ')}`);
}

/** JSON을 임시 파일 → rename으로 저장한다. 실패는 warn 로그만(what = 로그용 작업 이름). */
export function writeJsonAtomic(file: string, value: unknown, what: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    log('warn', `${what} failed: ${errMsg(e)}`);
  }
}

/** 히스토리 필터 원본 정리: 알려진 4개 키의 짧은 영숫자 값만(렌더러 입력은 신뢰 경계 밖). */
function cleanFilter(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object') return out;
  for (const k of ['status', 'recent', 'group', 'sort']) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === 'string' && /^[a-z0-9]{1,16}$/.test(x)) out[k] = x;
  }
  return out;
}

/** 렌더러 화면 상태(폴더 접기·탭별 레이아웃/비율/카드 자리). 내용 검증은 렌더러가 읽을 때 한다. */
export interface UiState {
  collapsed: string[];
  tabs: Record<string, unknown>;
  /** 사이드바 전체 접힘. */
  sidebarCollapsed: boolean;
  /** 사이드바 폭(px, 200~480). */
  sidebarWidth: number;
  /** 히스토리 필터(F2-2). 값 검증은 렌더러가 읽을 때 한다(여기서는 짧은 문자열 필드만 보관). */
  historyFilter: Record<string, string>;
}

/** 탭 화면 상태 1개의 최대 JSON 길이(렌더러 입력은 신뢰 경계 밖). */
const MAX_TAB_UI_JSON = 20000;

/** Claude만 대화 ID 기억 상한(오래된 것부터 버림). */
const MAX_PLAIN_SESSIONS = 500;

/** ui-state.json 저장소(쓰기는 모아서 지연). */
export class UiStateStore {
  private cur: UiState = { collapsed: [], tabs: {}, sidebarCollapsed: false, sidebarWidth: SIDEBAR_DEFAULT_W, historyFilter: {} };
  /** 에이전트 없이 연 대화 ID(소문자). 히스토리에서 다시 열 때 `claude -r`로 열기 위해 기억한다(렌더러에는 보내지 않음). */
  private plainSessions: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    try {
      const o = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (Array.isArray(o.collapsed)) this.cur.collapsed = o.collapsed.filter((x): x is string => typeof x === 'string').slice(0, 500);
      this.cur.sidebarCollapsed = o.sidebarCollapsed === true;
      this.cur.sidebarWidth = clampSidebarWidth(o.sidebarWidth);
      this.cur.historyFilter = cleanFilter(o.historyFilter);
      if (Array.isArray(o.plainSessions)) this.plainSessions = o.plainSessions.filter((x): x is string => typeof x === 'string' && SESSION_ID_RE.test(x)).map((x) => x.toLowerCase()).slice(-MAX_PLAIN_SESSIONS);
      if (o.tabs && typeof o.tabs === 'object' && !Array.isArray(o.tabs)) {
        for (const [k, v] of Object.entries(o.tabs as Record<string, unknown>)) if (SAFE_NAME.test(k)) this.cur.tabs[k] = v;
      }
    } catch { /* 없음·손상: 기본값 */ }
  }

  /** 현재 값(복사본). */
  get(): UiState {
    return { collapsed: [...this.cur.collapsed], tabs: { ...this.cur.tabs }, sidebarCollapsed: this.cur.sidebarCollapsed, sidebarWidth: this.cur.sidebarWidth, historyFilter: { ...this.cur.historyFilter } };
  }

  /** 접힌 폴더 목록 저장. */
  setCollapsed(list: unknown): void {
    if (!Array.isArray(list)) return;
    this.cur.collapsed = list.filter((x): x is string => typeof x === 'string' && x.length < 2000).slice(0, 500);
    this.schedule();
  }

  /** 히스토리 필터 저장(F2-2). */
  setHistoryFilter(v: unknown): void {
    this.cur.historyFilter = cleanFilter(v);
    this.schedule();
  }

  /** 사이드바 폭 저장(숫자만, 범위 밖이면 잘라서). */
  setSidebarWidth(v: unknown): void {
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    const w = clampSidebarWidth(v);
    if (w === this.cur.sidebarWidth) return;
    this.cur.sidebarWidth = w;
    this.schedule();
  }

  /** 사이드바 접힘 저장(boolean만). */
  setSidebarCollapsed(v: unknown): void {
    if (typeof v !== 'boolean' || v === this.cur.sidebarCollapsed) return;
    this.cur.sidebarCollapsed = v;
    this.schedule();
  }

  /** 탭 화면 상태 저장(세션 이름 키). 너무 크거나 이름이 이상하면 무시. */
  setTab(session: unknown, ui: unknown): void {
    if (typeof session !== 'string' || !SAFE_NAME.test(session)) return;
    try {
      if (JSON.stringify(ui).length > MAX_TAB_UI_JSON) return;
    } catch {
      return;
    }
    this.cur.tabs[session] = ui;
    this.schedule();
  }

  /** 에이전트 없이 연 대화로 기록한다(이미 있으면 무시). */
  markPlainSession(sessionId: string): void {
    const id = sessionId.toLowerCase();
    if (!SESSION_ID_RE.test(id) || this.plainSessions.includes(id)) return;
    this.plainSessions.push(id);
    if (this.plainSessions.length > MAX_PLAIN_SESSIONS) this.plainSessions.splice(0, this.plainSessions.length - MAX_PLAIN_SESSIONS);
    this.schedule();
  }

  /** 에이전트 없이 열었던 대화인지. */
  isPlainSession(sessionId: string): boolean {
    return this.plainSessions.includes(sessionId.toLowerCase());
  }

  /** 세션 종료 시 그 탭 상태를 지운다. */
  removeTab(session: string): void {
    if (!(session in this.cur.tabs)) return;
    delete this.cur.tabs[session];
    this.schedule();
  }

  /** 대기 중인 저장을 바로 쓴다(앱 종료 시). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    writeJsonAtomic(this.file, { ...this.cur, plainSessions: this.plainSessions }, 'ui state save');
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }
}
