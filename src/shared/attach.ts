// 첨부 경로 규칙(F6, M3): @"<절대경로>" 인용, 입력창 커서 위치 삽입, /add-dir 명령, 붙여넣기 이미지 이름·정리. 순수 로직(main·renderer 공용, 단위 테스트 대상).

import { tr } from './i18n';

/** 카드 입력창에 글을 넣으라는 window 이벤트(detail: InsertDetail). 해당 카드가 커서 위치에 넣는다. */
export const INSERT_EVENT = 'ctd:insert';

/** 삽입 요청. */
export interface InsertDetail {
  tabId: string;
  pane: string;
  text: string;
  /** 슬래시 명령(/add-dir): 입력창이 비어 있을 때만 넣는다(명령은 메시지 맨 앞이어야 동작). */
  command?: boolean;
}

/** 경로 인용 결과. */
export type QuoteResult = { ok: true; text: string } | { ok: false; reason: string };

/** Windows 절대 경로(드라이브 문자 + 구분자, 또는 UNC \\server\share)인지. */
export function isAbsoluteWinPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p);
}

/**
 * 경로 하나를 Claude Code 파일 참조로 만든다: @"<절대경로>". 백슬래시는 그대로, 항상 큰따옴표로 감싼다(공백·한글 안전).
 * 큰따옴표가 든 경로는 인용이 깨지므로 거부한다(Windows 파일 이름에는 원래 쓸 수 없음).
 */
export function quoteMention(p: string): QuoteResult {
  const path = p.trim();
  if (!path) return { ok: false, reason: tr('attach.empty') };
  if (path.includes('"')) return { ok: false, reason: tr('attach.quote', { path }) };
  // 줄바꿈·탭 등 제어문자는 입력창·psmux 전송을 깨뜨리므로 거부(메시지에는 제어문자를 보이는 형태로)
  if (/[\x00-\x1f\x7f]/.test(path)) return { ok: false, reason: tr('attach.control', { path: JSON.stringify(path) }) };
  if (!isAbsoluteWinPath(path)) return { ok: false, reason: tr('attach.notAbsolute', { path }) };
  return { ok: true, text: `@"${stripTrailingBackslash(path)}"` };
}

/** 끝 `\`가 닫는 따옴표를 이스케이프(`\"`)로 읽히지 않게 제거한다. 드라이브 루트(`C:\`)는 `C:/`로 바꿔 루트 의미를 유지. */
export function stripTrailingBackslash(path: string): string {
  const s = path.replace(/\\+$/, '');
  return /^[A-Za-z]:$/.test(s) ? `${s}/` : s;
}

/**
 * /add-dir 명령(리드 카드용). 따옴표 없이 경로를 그대로 붙인다: Claude Code는 따옴표를 벗기지 않고 상대 경로로 해석해 실패하며,
 * 명령 뒤 나머지 전체를 경로로 받으므로 공백·한글이 있어도 된다(실측).
 */
export function addDirCommand(p: string): QuoteResult {
  const q = quoteMention(p);
  return q.ok ? { ok: true, text: `/add-dir ${p.trim()}` } : q;
}

/**
 * 여러 경로를 공백으로 이어 붙인다. 거부된 경로는 따로 돌려준다.
 *
 * Returns:
 *   text: 삽입할 글(없으면 빈 문자열), rejected: 거부 사유 목록.
 */
export function mentionsFor(paths: string[]): { text: string; rejected: string[] } {
  const ok: string[] = [];
  const rejected: string[] = [];
  for (const p of paths) {
    const q = quoteMention(p);
    if (q.ok) ok.push(q.text);
    else rejected.push(q.reason);
  }
  return { text: ok.join(' '), rejected };
}

/**
 * 입력창 값의 선택 범위를 snippet으로 바꾼다. 앞뒤 글자와 붙지 않게 필요할 때만 공백을 넣는다.
 *
 * Args:
 *   value: 현재 값.
 *   start: 선택 시작(커서).
 *   end: 선택 끝.
 *   snippet: 넣을 글.
 *
 * Returns:
 *   새 값과 삽입 뒤 커서 위치.
 */
export function insertAt(value: string, start: number, end: number, snippet: string): { value: string; caret: number } {
  let s = Math.max(0, Math.min(start, value.length));
  let e = Math.max(s, Math.min(end, value.length));
  // 커서가 기존 @"…" 안에 있으면 그 경로를 쪼개지 않게 바로 뒤에 넣는다(선택 범위가 없을 때만)
  if (s === e) {
    for (const m of value.matchAll(/@"[^"\r\n]*"/g)) {
      const a = m.index ?? 0;
      const b = a + m[0].length;
      if (s > a && s < b) {
        s = b;
        e = b;
        break;
      }
    }
  }
  const before = value.slice(0, s);
  const after = value.slice(e);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : after ? '' : ' ';
  const ins = `${lead}${snippet}${trail}`;
  // 뒤에 이미 공백이 있으면 그 공백 다음으로 커서를 옮겨 이어 쓰기 자연스럽게
  const skip = !trail && /^\s/.test(after) ? 1 : 0;
  return { value: before + ins + after, caret: before.length + ins.length + skip };
}

/** Windows JPEG 원시 클립보드 형식(Chromium이 image/jpeg로 노출하지 않음). Electron은 이 이름으로만 읽을 수 있다. */
export const CLIP_JFIF_TYPE = 'electron application/osclipboard;format="JFIF"';

/**
 * 클립보드 항목(각 항목의 형식 목록)에서 저장할 이미지 형식을 고른다: image/png > image/jpeg > JFIF 원시 형식.
 *
 * Returns:
 *   항목 번호·형식·PNG 여부(PNG면 바이트 그대로 저장, 아니면 PNG로 변환). 없으면 null.
 */
export function pickClipImage(itemTypes: string[][]): { index: number; type: string; png: boolean } | null {
  for (const type of ['image/png', 'image/jpeg', CLIP_JFIF_TYPE]) {
    const index = itemTypes.findIndex((ts) => ts.includes(type));
    if (index >= 0) return { index, type, png: type === 'image/png' };
  }
  return null;
}

/** 타이머 주입(테스트용). */
export interface DragTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

/**
 * 드래그 중 드롭 표시(점선) 해제 시점 판단. 드래그 취소(Esc·창 밖 이탈) 때 dragleave가 짝 맞게 오지 않아
 * 표시가 남는 문제(M3-1)를 막으려고, 창 밖 이탈 즉시 해제 + dragover가 idleMs 동안 없으면 해제하는 안전 타이머를 둔다.
 * 표시 자체는 dragover가 다시 세우므로 여기서는 해제만 맡는다.
 */
export class DragHoverTracker {
  private depth = 0;
  private timer: unknown = null;

  constructor(
    private readonly onClear: () => void,
    private readonly idleMs = 1000,
    private readonly timers: DragTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
  ) {}

  /** dragenter. */
  enter(): void {
    this.depth++;
  }

  /** dragover: 안전 타이머를 다시 건다. */
  over(): void {
    this.cancelTimer();
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.reset();
    }, this.idleMs);
  }

  /** dragleave. outside=창 밖으로 나감(relatedTarget === null). */
  leave(outside: boolean): void {
    this.depth = Math.max(0, this.depth - 1);
    if (outside || this.depth === 0) this.reset();
  }

  /** drop·dragend·취소: 카운터·타이머를 비우고 표시를 해제한다. */
  reset(): void {
    this.depth = 0;
    this.cancelTimer();
    this.onClear();
  }

  /** 리스너 해제 시 타이머만 정리(표시 콜백 호출 없음). */
  dispose(): void {
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}

/** clips 정리 대상(D15): 앱이 만든 이름 형식의 PNG 중 수정 시각이 maxAgeDays보다 오래된 것. */
export function staleClipNames(entries: { name: string; mtimeMs: number }[], nowMs: number, maxAgeDays = 7): string[] {
  const limit = nowMs - maxAgeDays * 24 * 3600 * 1000;
  return entries.filter((e) => CLIP_NAME_RE.test(e.name) && e.mtimeMs < limit).map((e) => e.name);
}

/** 붙여넣기 이미지 파일 이름 형식: <ISO 시각(':'·'.'→'-')>-<6자 hex>.png */
export const CLIP_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}\.png$/;

/** 붙여넣기 이미지 파일 이름(Windows 파일 이름에 ':'를 쓸 수 없어 ISO 시각의 ':'·'.'을 '-'로). */
export function clipFileName(now: Date, hex6: string): string {
  if (!/^[0-9a-f]{6}$/.test(hex6)) throw new Error('hex6 must be 6 hex chars');
  return `${now.toISOString().replace(/[:.]/g, '-')}-${hex6}.png`;
}
