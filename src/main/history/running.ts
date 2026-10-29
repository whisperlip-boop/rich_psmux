// 실행 중인 Claude Code 대화 판정: ~/.claude/sessions/<pid>.json(tmux 필드) + 프로세스 생존 확인. 순수 로직 + pid 확인.
// 같은 대화를 두 프로세스가 이어 쓰지 않게(F2) 대화 클릭 전에 이 결과로 전환·재연결·거부를 정한다.

import { tr, type MsgKey } from '../../shared/i18n';
import type { RunningSessionFile } from '../claudeHome';

/** 실행 중인 대화 하나. */
export interface RunningConversation {
  sessionId: string;
  /** 실행 중인 psmux 세션 이름(psmux 밖이면 null). */
  psmuxSession: string | null;
  /** 앱이 만든(메타가 있는) psmux 세션인지. */
  ours: boolean;
  /** -r 로 이어간 원래 대화 ID로 찾은 항목인지(재개 후 sessionId가 바뀌어도 같은 세션으로 연결). */
  alias?: boolean;
  /** Claude Code 프로세스 ID(sessions/<pid>.json). */
  pid: number;
  /** tmux 필드가 있었는지(psmux 안에서 실행). 있는데 psmuxSession이 null이면 세션 이름을 쓸 수 없는 형식. */
  inPsmux: boolean;
}

/** 외부 psmux 세션 이름 허용 형식: 영숫자·_·.·-만(공백·따옴표·제어문자 거부, CLI 인자로 넘기므로). */
const SAFE_SESSION_RE = /^[A-Za-z0-9_.-]+$/;

/** "<세션>:@창.%칸" → 세션 이름. 형식이 아니면 null. */
export function psmuxSessionOf(tmux: string | undefined): string | null {
  if (!tmux) return null;
  const i = tmux.lastIndexOf(':@');
  if (i <= 0) return null;
  const name = tmux.slice(0, i);
  return SAFE_SESSION_RE.test(name) ? name : null;
}

/** psmux CLI에 넘겨도 되는 세션 이름인지(1~100자, SAFE_SESSION_RE). */
export function isSafeSessionName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 100 && SAFE_SESSION_RE.test(name);
}

/** 종료해도 되는 pid 형식인지(정수, Windows 시스템 pid 0·4 제외, 32비트 범위). 자기 자신 여부는 호출부가 본다. */
export function isKillablePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 4 && pid <= 0xffffffff;
}

/** 프로세스 생존 여부(신호 0: 존재 확인만, 종료시키지 않음). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * sessions/<pid>.json이 끊으려는 대상을 가리키는 파일인지(세션 끊기 직전 재확인).
 *
 * Args:
 *   file: 다시 읽은 파일 내용(pid는 내용 값, 없으면 null).
 *   filePid: 파일 이름의 pid.
 *   sessionIds: 이 대화로 인정하는 ID(소문자, alias 행 포함).
 *   psmuxSession: 대상 psmux 세션 이름. null이면 psmux 밖(tmux 필드가 없어야 함).
 *
 * Returns:
 *   내용 pid = 파일 이름 pid, sessionId가 이 대화, tmux가 대상 세션(또는 없음)일 때만 true.
 */
export function sessionFileOwns(
  file: { pid: number | null; sessionId: string; tmux?: string } | null,
  filePid: number,
  sessionIds: Set<string>,
  psmuxSession: string | null,
): boolean {
  if (!file || file.pid !== filePid || !sessionIds.has(file.sessionId.toLowerCase())) return false;
  return psmuxSession === null ? !file.tmux : psmuxSessionOf(file.tmux) === psmuxSession;
}

/**
 * 끊기에서 확정적으로 거부된 세션 파일(pid → 그때의 sessions/<pid>.json 수정 시각)을 실행 목록 재료에서 뺀다.
 * 수정 시각이 바뀌었거나 파일이 없어진 항목은 무효로 보고 excluded에서 지운다(호출부의 메모리 캐시를 직접 갱신).
 *
 * Args:
 *   files: sessions/<pid>.json 내용.
 *   excluded: 제외 캐시(pid → 수정 시각 ms).
 *   mtimeOf: pid의 세션 파일 수정 시각(없으면 null).
 *
 * Returns:
 *   제외 항목을 뺀 목록.
 */
export function filterExcluded(files: RunningSessionFile[], excluded: Map<number, number>, mtimeOf: (pid: number) => number | null): RunningSessionFile[] {
  if (excluded.size === 0) return files;
  const present = new Set(files.map((f) => f.pid));
  for (const pid of [...excluded.keys()]) if (!present.has(pid)) excluded.delete(pid);
  return files.filter((f) => {
    const m = excluded.get(f.pid);
    if (m === undefined) return true;
    if (mtimeOf(f.pid) === m) return false;
    excluded.delete(f.pid);
    return true;
  });
}

/**
 * 실행 중인 대화 목록을 만든다.
 *
 * Args:
 *   files: sessions/<pid>.json 내용.
 *   alive: pid 생존 확인 함수.
 *   resumeOf: psmux 세션 이름 → 앱 세션인지(ours)와 메타의 resumeSessionId.
 *
 * Returns:
 *   대화 목록(앱 세션 우선 정렬). 앱 세션이 -r 로 이어간 원래 대화 ID도 alias 항목으로 넣는다.
 */
export function buildRunning(
  files: RunningSessionFile[],
  alive: (pid: number) => boolean,
  resumeOf: (session: string) => { ours: boolean; resumeSessionId?: string },
): RunningConversation[] {
  const out: RunningConversation[] = [];
  for (const f of files) {
    if (!alive(f.pid)) continue;
    const ps = psmuxSessionOf(f.tmux);
    const m = ps ? resumeOf(ps) : { ours: false };
    const inPsmux = !!f.tmux;
    out.push({ sessionId: f.sessionId, psmuxSession: ps, ours: m.ours, pid: f.pid, inPsmux });
    if (m.ours && m.resumeSessionId && m.resumeSessionId.toLowerCase() !== f.sessionId.toLowerCase()) {
      out.push({ sessionId: m.resumeSessionId, psmuxSession: ps, ours: true, alias: true, pid: f.pid, inPsmux });
    }
  }
  return out.sort((a, b) => Number(b.ours) - Number(a.ours));
}

/** sessionId로 실행 중인 대화 찾기(대소문자 무시, 앱 세션 우선). */
export function findRunning(list: RunningConversation[], sessionId: string): RunningConversation | null {
  const k = sessionId.toLowerCase();
  return list.find((r) => r.sessionId.toLowerCase() === k) ?? null;
}

/** 종료 가능 판정에 쓰는 탭 상태 일부. */
export interface OpenTabRef {
  session: string;
  leadSessionId: string | null;
  resumeSessionId: string | null;
}

/** 세션 끊기 방식: 앱 세션(팀 종료 요청 후 kill-session) / 외부 psmux 세션(kill-session) / psmux 밖 프로세스(taskkill). */
export type StopKind = 'app' | 'psmux' | 'process';

/** 세션 끊기 대상(main이 실행 목록에서 찾은 값만 담는다). */
export interface StopPlan {
  kind: StopKind;
  /** 중복 실행 방지 키: psmux 세션 이름 또는 `pid:<n>`. */
  key: string;
  sessionId: string;
  psmuxSession: string | null;
  pid: number;
}

/** 세션 끊기 거부·실패 사유 코드(로그에는 이 코드만 남긴다). */
export type StopFailCode =
  | 'not-running' | 'tab-open' | 'bad-name' | 'bad-pid' | 'opening'
  | 'no-psmux' | 'no-meta' | 'not-found' | 'attach-failed' | 'still-alive'
  | 'pid-mismatch' | 'not-claude' | 'self' | 'kill-failed' | 'has-conversation' | 'error';

/** 사유 코드 → 사용자 안내 문구 키. */
const STOP_FAIL_KEY: Record<StopFailCode, MsgKey> = {
  'not-running': 'stop.notRunning',
  'tab-open': 'stop.tabOpen',
  'bad-name': 'stop.badName',
  'bad-pid': 'stop.badPid',
  opening: 'stop.opening',
  'no-psmux': 'psmux.notFound',
  'no-meta': 'stop.noMeta',
  'not-found': 'stop.notFound',
  'attach-failed': 'stop.attachFailed',
  'still-alive': 'stop.stillAlive',
  'pid-mismatch': 'stop.pidMismatch',
  'not-claude': 'stop.notClaude',
  self: 'stop.self',
  'kill-failed': 'stop.killFailed',
  'has-conversation': 'stop.hasConversation',
  error: 'stop.error',
};

/** 사유 코드 → 사용자 안내(현재 UI 언어 한 줄). */
export function stopFailMessage(code: StopFailCode): string {
  return tr(STOP_FAIL_KEY[code]);
}

/**
 * 히스토리 "세션 끊기…"(F2-1) 대상을 정한다. 렌더러 표시 조건(실행 중 + 탭 없음)을 main이 실행 직전에 다시 확인한다.
 *
 * Args:
 *   sessionId: 대화 ID(이어간 원래 ID여도 됨).
 *   list: 실행 중인 대화.
 *   openTabs: 열린 탭.
 *
 * Returns:
 *   끊을 대상 또는 거부 사유 코드.
 */
export function planStop(sessionId: string, list: RunningConversation[], openTabs: OpenTabRef[]): StopPlan | StopFailCode {
  const r = findRunning(list, sessionId);
  if (!r) return 'not-running';
  const k = sessionId.toLowerCase();
  const same = (v: string | null): boolean => !!v && v.toLowerCase() === k;
  if (openTabs.some((t) => (r.psmuxSession !== null && t.session === r.psmuxSession) || same(t.leadSessionId) || same(t.resumeSessionId))) {
    return 'tab-open';
  }
  const base = { sessionId: r.sessionId, psmuxSession: r.psmuxSession, pid: r.pid };
  if (r.psmuxSession !== null) {
    if (!isSafeSessionName(r.psmuxSession)) return 'bad-name';
    return { ...base, kind: r.ours ? 'app' : 'psmux', key: r.psmuxSession };
  }
  // psmux 안인데 세션 이름을 못 읽었으면 프로세스만 죽여 세션을 반쯤 남기지 않는다
  if (r.inPsmux || r.ours) return 'bad-name';
  if (!isKillablePid(r.pid)) return 'bad-pid';
  return { ...base, kind: 'process', key: `pid:${r.pid}` };
}
