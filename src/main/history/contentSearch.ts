// 대화 본문 검색(사이드바 검색창 Enter): 목록의 대화 파일을 스트리밍으로 읽어 사람 입력·assistant 텍스트에서 검색어를 찾는다.
// 색인 없이 요청할 때만 읽는다(실측 239개·480MB 약 3~5초). 검색어·본문은 기록하지 않는다(호출부가 개수·시간만 기록). 순수 로직 + 파일 읽기 주입.

import { CONTENT_QUERY_MIN, escapeRegExp, findMatch } from '../../shared/search';
import { partialUserText } from './jsonlFacts';
import { JsonlSplitter } from './lineSplitter';

/** 검색 대상 파일. */
export interface ContentTarget {
  sessionId: string;
  dir: string;
  file: string;
}

/** 찾은 대화와 일치 부분 앞뒤 글. */
export interface ContentHit {
  sessionId: string;
  snippet: string;
}

/** 취소 표시(새 검색·취소 요청이면 호출부가 true로 바꾼다). */
export interface SearchToken {
  cancelled: boolean;
}

/** 검색 결과. scanned = 끝까지(또는 첫 일치까지) 읽은 파일 수, failed = 읽지 못한 파일 수. */
export interface ContentResult {
  hits: ContentHit[];
  scanned: number;
  failed: number;
}

/** 파일 읽기(claudeHome.readProjectRange와 같은 형태). */
export type ContentReader = (dir: string, file: string, start: number, end: number, onChunk: (b: Buffer) => boolean) => Promise<void>;

/** 잘린 긴 줄에서 도구 결과·도구 호출·assistant 레코드 표시(JSON 키 그대로일 때만, 이스케이프된 글 안의 같은 모양은 아님). */
const TOOL_OR_ASSISTANT_RE = /"tool_use_id"\s*:|"type"\s*:\s*"(?:tool_result|tool_use|assistant)"/;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;

/** 레코드에서 검색할 글: 사람 입력(user)과 assistant의 text 블록만. 메타·요약·도구 결과·thinking·도구 호출은 제외. */
export function searchableTexts(o: Record<string, unknown>): string[] {
  if (o.type !== 'user' && o.type !== 'assistant') return [];
  if (o.isMeta === true || o.isCompactSummary === true || o.isVisibleInTranscriptOnly === true) return [];
  const m = o.message;
  if (!m || typeof m !== 'object') return [];
  const c = (m as Record<string, unknown>).content;
  if (typeof c === 'string') return [c];
  if (!Array.isArray(c)) return [];
  const out: string[] = [];
  for (const b of c) {
    if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text' && typeof (b as Record<string, unknown>).text === 'string') out.push((b as Record<string, unknown>).text as string);
  }
  return out;
}

const isLowSurrogate = (s: string, i: number): boolean => {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
};

/** 일치 위치 앞뒤 글(공백 정리, 잘린 쪽은 …). 서로게이트 쌍을 가르지 않는다. */
export function snippetAround(text: string, idx: number, len: number): string {
  let start = Math.max(0, idx - SNIPPET_BEFORE);
  let end = Math.min(text.length, idx + len + SNIPPET_AFTER);
  if (start > 0 && isLowSurrogate(text, start)) start--;
  if (end < text.length && isLowSurrogate(text, end)) end++;
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/**
 * 대화 파일들에서 검색어를 찾는다(대소문자 무시). 파일마다 첫 일치에서 읽기를 멈추고, 파일 사이마다 이벤트 루프에 양보한다.
 * 원문 줄에서 먼저 가볍게 거른 뒤(JSON 이스케이프 형태 포함) 걸린 줄만 해석한다. 아주 긴 줄(256KB 넘음)은 남은 앞부분의 첫 사람 입력 글만 본다.
 *
 * Args:
 *   read: 파일 읽기.
 *   targets: 검색할 파일(앞에서부터, 호출부가 최근 순으로 정렬).
 *   query: 검색어.
 *   token: 취소 표시.
 *   onProgress: 파일 하나를 마칠 때마다(마친 수, 전체 수).
 *
 * Returns:
 *   찾은 대화와 읽은·실패 파일 수. 취소되면 그때까지 찾은 것.
 */
export async function searchContent(read: ContentReader, targets: ContentTarget[], query: string, token: SearchToken,
  onProgress?: (done: number, total: number) => void): Promise<ContentResult> {
  const q = query.trim();
  const res: ContentResult = { hits: [], scanned: 0, failed: 0 };
  if (q.length < CONTENT_QUERY_MIN) return res;
  // 원문 줄 거르기는 findMatch와 같은 대소문자 규칙(iu)이어야 해석 뒤 일치를 놓치지 않는다
  const forms = new Set([q, JSON.stringify(q).slice(1, -1)]);
  const pre = new RegExp([...forms].map(escapeRegExp).join('|'), 'iu');
  for (const t of targets) {
    if (token.cancelled) break;
    let snippet: string | null = null;
    const sp = new JsonlSplitter(0, (l) => {
      if (!pre.test(l.text)) return true;
      if (l.truncated) {
        // 아주 긴 줄(대개 붙여넣은 이미지가 든 사람 입력)은 남은 앞부분에서 첫 사람 입력 글(최대 600자)만 본다. 이미지 뒤에 있는 글은 못 찾는다.
        // 도구 결과(type user 레코드)·assistant 레코드·도구 호출은 건너뛴다(입력한 글 안의 따옴표는 \"로 이스케이프돼 이 검사에 걸리지 않음)
        if (TOOL_OR_ASSISTANT_RE.test(l.text)) return true;
        const partial = partialUserText(l.text);
        const m = partial === null ? null : findMatch(partial, q);
        if (!partial || !m) return true;
        snippet = snippetAround(partial, m.index, m.length);
        return false;
      }
      let o: unknown;
      try {
        o = JSON.parse(l.text);
      } catch {
        return true;
      }
      if (!o || typeof o !== 'object' || Array.isArray(o)) return true;
      for (const text of searchableTexts(o as Record<string, unknown>)) {
        const m = findMatch(text, q);
        if (m) {
          snippet = snippetAround(text, m.index, m.length);
          return false;
        }
      }
      return true;
    });
    try {
      // 끝은 파일 크기 대신 아주 큰 값(읽는 동안 늘어난 부분까지 EOF에서 멈춤)
      await read(t.dir, t.file, 0, Number.MAX_SAFE_INTEGER, (b) => !token.cancelled && sp.push(b));
      res.scanned++;
    } catch {
      // 지워졌거나 잠긴 파일은 건너뛴다(호출부가 개수만 기록)
      res.failed++;
    }
    if (snippet !== null) res.hits.push({ sessionId: t.sessionId, snippet });
    onProgress?.(res.scanned + res.failed, targets.length);
    await new Promise((r) => setImmediate(r));
  }
  return res;
}
