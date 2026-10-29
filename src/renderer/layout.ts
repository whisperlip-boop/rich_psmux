// 카드 배치(F4): tmux 표준 레이아웃 5종 선택기. 순수 로직(단위 테스트 대상).

/** 레이아웃 번호(선택기 1~5). */
export type LayoutId = 1 | 2 | 3 | 4 | 5;

/** 레이아웃 정의. */
export const LAYOUTS: { id: LayoutId; name: string }[] = [
  { id: 1, name: 'even-horizontal' },
  { id: 2, name: 'even-vertical' },
  { id: 3, name: 'main-horizontal' },
  { id: 4, name: 'main-vertical' },
  { id: 5, name: 'tiled' },
];

/** 기본 레이아웃(main-horizontal). */
export const DEFAULT_LAYOUT: LayoutId = 3;

/** 리드 영역(main)이 있는 레이아웃(3·4). 분할 비율 조절 대상. */
export type MainLayoutId = 3 | 4;

/** 리드 영역 비율(%) 기본값·범위·키보드 1회 이동량(분할 경계선). */
export const DEFAULT_MAIN_RATIO = 50;
export const MIN_MAIN_RATIO = 25;
export const MAX_MAIN_RATIO = 75;
export const MAIN_RATIO_STEP = 2;

/** 경계선 드래그가 끝났음을 카드에 알리는 window 이벤트(detail = 탭 ID). 카드는 이때 칸 크기를 다시 맞춘다. */
export const SPLIT_END_EVENT = 'ctd:split-end';

/** 탭별 화면 상태(D6: 탭 단위로 기억). */
export interface TabUi {
  layout: LayoutId;
  /** 활성 카드(마지막으로 클릭·입력한 카드). */
  activePane: string | null;
  /** 리드 영역 비율(%). 3·4는 방향이 달라 따로 기억한다. */
  mainRatio: Record<MainLayoutId, number>;
}

/** 탭 화면 상태 기본값. */
export const DEFAULT_TAB_UI: TabUi = {
  layout: DEFAULT_LAYOUT,
  activePane: null,
  mainRatio: { 3: DEFAULT_MAIN_RATIO, 4: DEFAULT_MAIN_RATIO },
};

/** 선택기 툴팁. */
export function layoutTooltip(id: LayoutId): string {
  return `${LAYOUTS[id - 1].name} — Ctrl+Shift+${id}`;
}

/** 키 이벤트 code(Digit1~5, Numpad1~5)를 레이아웃 번호로. 해당 없으면 null. */
export function layoutFromCode(code: string): LayoutId | null {
  const m = /^(?:Digit|Numpad)([1-5])$/.exec(code);
  return m ? (Number(m[1]) as LayoutId) : null;
}

/** 저장값을 레이아웃 번호로(이전 버전 값·잘못된 값은 기본값). */
export function normalizeLayout(v: unknown): LayoutId {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : DEFAULT_LAYOUT;
}

/** 분할 경계선이 있는 레이아웃(3·4)인지. */
export function isMainLayout(id: LayoutId): id is MainLayoutId {
  return id === 3 || id === 4;
}

/** 비율을 25~75%로 제한(소수 1자리). 숫자가 아니면 기본값. */
export function clampMainRatio(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_MAIN_RATIO;
  return Math.round(Math.min(MAX_MAIN_RATIO, Math.max(MIN_MAIN_RATIO, v)) * 10) / 10;
}

/** 탭의 해당 레이아웃 리드 비율(저장값이 없거나 잘못되면 기본값). */
export function getMainRatio(ui: TabUi, layout: MainLayoutId): number {
  return clampMainRatio(ui.mainRatio?.[layout]);
}

/** 해당 레이아웃의 리드 비율만 바꾼 새 탭 상태(다른 레이아웃 값은 유지). */
export function withMainRatio(ui: TabUi, layout: MainLayoutId, ratio: number): TabUi {
  return { ...ui, mainRatio: { ...DEFAULT_TAB_UI.mainRatio, ...ui.mainRatio, [layout]: clampMainRatio(ratio) } };
}

/**
 * 포인터 위치를 리드 비율로. 경계선 가운데가 포인터를 따라가도록 경계선 폭의 절반을 뺀다.
 *
 * Args:
 *   pos: 분할 축의 포인터 좌표(경계선을 잡은 위치 보정 후).
 *   start: 그리드 내용 영역 시작 좌표(padding 안쪽).
 *   size: 그리드 내용 영역 길이(padding 제외).
 *   gap: 경계선 폭.
 *
 * Returns:
 *   25~75%로 제한한 비율. 영역이 경계선보다 작으면 기본값.
 */
export function ratioFromPointer(pos: number, start: number, size: number, gap: number): number {
  const avail = size - gap;
  if (!(avail > 0)) return DEFAULT_MAIN_RATIO;
  return clampMainRatio(((pos - start - gap / 2) / avail) * 100);
}

/** 경계선 키 입력(↑←: 리드 축소, ↓→: 확대, Home: 50%, End: 75%)을 새 비율로. 해당 키가 아니면 null. */
export function ratioFromKey(key: string, current: number): number | null {
  if (key === 'Home') return DEFAULT_MAIN_RATIO;
  if (key === 'End') return MAX_MAIN_RATIO;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return clampMainRatio(current - MAIN_RATIO_STEP);
  if (key === 'ArrowDown' || key === 'ArrowRight') return clampMainRatio(current + MAIN_RATIO_STEP);
  return null;
}

/** tiled: 열 = ceil(√n), 행 = ceil(n/열). */
export function tiledGrid(n: number): { cols: number; rows: number } {
  const count = Math.max(1, n);
  const cols = Math.ceil(Math.sqrt(count));
  return { cols, rows: Math.ceil(count / cols) };
}

/**
 * 카드를 리드 자리와 나머지로 나눈다. 리드는 3·4에서 main 자리, 1·2·5에서 첫 자리.
 * 나머지는 자리 고정 순서(slots.ts) 그대로.
 *
 * Args:
 *   ordered: 자리 순서로 정렬된 칸 ID.
 *   leadPaneId: 리드 칸(없으면 리드 자리 비움).
 *
 * Returns:
 *   main: 리드 칸 또는 null, rest: 나머지 칸.
 */
export function splitLead(ordered: string[], leadPaneId: string | null): { main: string | null; rest: string[] } {
  const main = leadPaneId && ordered.includes(leadPaneId) ? leadPaneId : null;
  return { main, rest: ordered.filter((p) => p !== main) };
}

/** 폴더 경로의 마지막 이름(끝 구분자 무시). 드라이브 루트처럼 이름이 없으면 경로 그대로. */
export function folderName(f: string): string {
  return f.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || f;
}

/** 같은 폴더 탭이 여러 개면 "이름 (2)"처럼 구분한 표시 이름. */
export function tabTitles(folders: string[]): string[] {
  const base = folders.map(folderName);
  const seen = new Map<string, number>();
  return base.map((b) => {
    const k = b.toLowerCase();
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? b : `${b} (${n})`;
  });
}
