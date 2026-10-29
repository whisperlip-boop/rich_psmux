// 앱 psmux 세션 이름 규칙(D12): ctd-<정규화 폴더명>-<6자 hex>. 순수 로직.

/** 앱이 만든 세션 접두사. 재실행 시 이 접두사로 자기 세션을 찾는다(M2). */
export const SESSION_PREFIX = 'ctd-';

/**
 * 폴더 경로로 세션 이름을 만든다. tmux 계열은 '.', ':'를 세션 이름에 쓸 수 없으므로 영숫자·'_'·'-'만 남긴다.
 *
 * Args:
 *   folder: 작업 폴더 절대 경로.
 *   id: 6자 hex(호출부에서 crypto로 생성).
 *
 * Returns:
 *   세션 이름(예: ctd-win_memory-a1b2c3).
 */
export function makeSessionName(folder: string, id: string): string {
  if (!/^[0-9a-f]{6}$/.test(id)) throw new Error('id must be 6 hex chars');
  const base = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  let norm = base.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  if (norm.length > 24) norm = norm.slice(0, 24).replace(/[_-]+$/, '');
  return `${SESSION_PREFIX}${norm || 'session'}-${id}`;
}

/** 앱 세션 이름인지(실험용 ctd-spike-* 포함). */
export function isAppSessionName(name: string): boolean {
  return name.startsWith(SESSION_PREFIX) && /^[A-Za-z0-9_-]+$/.test(name);
}

/**
 * 앱 시작 시 복원할 세션(D13): ctd- 접두사 + 이 앱 데이터에 메타가 있는 세션만.
 * 메타 조건은 다른 데이터 폴더(검증 자동화·다른 사용자 프로필)가 만든 ctd- 세션에 붙지 않게 하기 위함.
 *
 * Args:
 *   live: list-sessions 결과.
 *   metas: 메타가 있는 세션 이름.
 */
export function selectRestorable(live: string[], metas: Iterable<string>): string[] {
  const m = new Set(metas);
  return live.filter((n) => isAppSessionName(n) && m.has(n));
}

/**
 * list-sessions 결과 해석. 서버가 없으면("no server running" 등, 종료 코드 1) 세션 0개로 본다.
 * 그 밖의 실패는 null(호출부는 복원·정리를 하지 않음: 일시 오류로 앱 파일을 지우지 않게).
 */
export function parseListSessions(code: number, out: string, err: string): string[] | null {
  if (code !== 0) return /no server running|no sessions/i.test(`${err}\n${out}`) ? [] : null;
  return out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

/** 메타는 있는데 psmux 세션이 없는(종료된) 세션 = 앱 파일 정리 대상. live는 list-sessions가 성공했을 때만 넘길 것. */
export function staleSessions(live: string[], metas: Iterable<string>): string[] {
  const l = new Set(live);
  return [...metas].filter((n) => !l.has(n));
}

/**
 * 열린 psmux 세션 목록 분류(F7 메뉴): 앱 세션 = ctd- 이름 + 이 앱 데이터에 메타 있음. 앱 세션이 탭으로 열려 있으면 tabId(= 세션 이름).
 *
 * Args:
 *   live: list-sessions 결과.
 *   hasMeta: 메타 존재 여부.
 *   openTabs: 지금 탭으로 열린 세션 이름.
 */
export function classifySessions(live: string[], hasMeta: (name: string) => boolean, openTabs: ReadonlySet<string>): { name: string; app: boolean; tabId: string | null }[] {
  return live.map((name) => {
    const app = isAppSessionName(name) && hasMeta(name);
    return { name, app, tabId: app && openTabs.has(name) ? name : null };
  });
}
