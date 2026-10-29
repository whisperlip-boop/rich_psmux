// 사이드바 폭(드래그 조절) 규칙. main(ui-state.json 저장)과 renderer(드래그·복원)가 같이 쓴다. 순수 로직.

/** 기본 폭. */
export const SIDEBAR_DEFAULT_W = 240;
/** 최소·최대 폭. */
export const SIDEBAR_MIN_W = 200;
export const SIDEBAR_MAX_W = 480;

/** 폭 값 정리: 숫자가 아니면 기본값, 정수로 반올림해 범위 안으로 자른다. */
export function clampSidebarWidth(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return SIDEBAR_DEFAULT_W;
  return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, Math.round(v)));
}
