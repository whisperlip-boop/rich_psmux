// 본문 검색 공용 규칙(main 검색·렌더러 강조가 같은 기준을 쓰도록). 순수 로직.

/** 본문 검색어 최소 길이(한 글자는 거의 모든 대화에 걸려 의미가 없다). */
export const CONTENT_QUERY_MIN = 2;

/** 검색어 최대 길이(검색창 maxLength, main IPC 검증). */
export const CONTENT_QUERY_MAX = 200;

/** 정규식 특수 문자를 글자 그대로 찾게 이스케이프한다. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 원문에서 검색어(대소문자 무시)의 첫 위치를 찾는다. toLowerCase로 길이가 바뀌는 글자(예: 'İ')가 있어도
 * 위치·길이가 원문 기준이 되도록 원문에 대소문자 무시 정규식을 직접 건다.
 *
 * Returns:
 *   원문 기준 시작 위치와 일치 길이. 없거나 검색어가 비면 null.
 */
export function findMatch(text: string, query: string): { index: number; length: number } | null {
  const q = query.trim();
  if (!q) return null;
  const m = new RegExp(escapeRegExp(q), 'iu').exec(text);
  return m ? { index: m.index, length: m[0].length } : null;
}

/** 일치 부분 앞뒤 글(공백을 한 칸으로 줄인 글)에서 강조할 범위: 검색어도 같은 방식으로 공백을 줄여 찾는다. */
export function highlightRange(snippet: string, query: string): { index: number; length: number } | null {
  return findMatch(snippet, query.replace(/\s+/g, ' '));
}
