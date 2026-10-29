// 탭 상태 집계·탭 화면 상태 저장값 검증. 순수 로직(단위 테스트 대상).

import type { TabStateDto } from '../shared/api';
import type { StatusKind } from './components/StatusDot';
import { clampMainRatio, DEFAULT_TAB_UI, normalizeLayout, type TabUi } from './layout';
import type { Slot } from './slots';

/** 탭 상태 요약: 승인 대기 > 끊김 > 작업 중 > 대기. */
export function tabStatus(t: TabStateDto): StatusKind {
  if (t.panes.some((p) => p.waiting)) return 'approval';
  if (t.status === 'reconnecting' || t.status === 'ended' || t.status === 'error') return 'disconnected';
  if (t.panes.some((p) => p.working)) return 'working';
  return 'idle';
}

/** 탭이 입력(첨부·명령)을 받을 수 있는지: 종료 처리 중이거나 끊김(reconnecting·ended·error)이면 false. */
export function tabAcceptsInput(t: TabStateDto | undefined): t is TabStateDto {
  return !!t && !t.terminating && t.status !== 'reconnecting' && t.status !== 'ended' && t.status !== 'error';
}

/** 폴더 추가(/add-dir)를 받을 리드 칸. 탭이 입력을 받을 수 없거나 리드 칸이 끝났으면 null. */
export function addDirLeadPane(t: TabStateDto | undefined): string | null {
  if (!tabAcceptsInput(t) || t.leadGone || !t.leadPaneId) return null;
  const lead = t.leadPaneId;
  return t.panes.some((p) => p.paneId === lead) ? lead : null;
}

/** 작업 중인 탭 수(경고 뱃지: 2개 이상). 승인 대기 탭도 팀이 도는 중이므로 센다. */
export function workingTabCount(tabs: TabStateDto[]): number {
  return tabs.filter((t) => t.panes.some((p) => p.working || p.waiting)).length;
}

/** 탭별로 영구 저장하는 화면 상태(세션 이름 키, 재시작 후 복원). */
export interface SavedTabUi {
  ui: TabUi;
  slots: Slot[];
  /** 이어가기 안내 배너를 닫았거나 첫 팀원이 생겨 숨겼는지. */
  bannerDone: boolean;
}

/** 저장값(main을 거쳐 온 JSON)을 검증해 복원한다. 형식이 틀린 값은 기본값. */
export function normalizeSavedTabUi(raw: unknown): SavedTabUi {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ratio = (o.mainRatio && typeof o.mainRatio === 'object' ? o.mainRatio : {}) as Record<string, unknown>;
  const ui: TabUi = {
    layout: normalizeLayout(o.layout),
    activePane: typeof o.activePane === 'string' && /^%\d+$/.test(o.activePane) ? o.activePane : null,
    mainRatio: { 3: clampMainRatio(ratio[3] ?? DEFAULT_TAB_UI.mainRatio[3]), 4: clampMainRatio(ratio[4] ?? DEFAULT_TAB_UI.mainRatio[4]) },
  };
  const slots: Slot[] = [];
  if (Array.isArray(o.slots)) {
    for (const s of o.slots.slice(0, 200)) {
      if (!s || typeof s !== 'object') continue;
      const x = s as Record<string, unknown>;
      const paneId = typeof x.paneId === 'string' && /^%\d+$/.test(x.paneId) ? x.paneId : null;
      const name = typeof x.name === 'string' && x.name.length <= 200 ? x.name : null;
      if (paneId !== null || name !== null) slots.push({ paneId, name });
    }
  }
  return { ui, slots, bannerDone: o.bannerDone === true };
}

/** 저장용 값(normalizeSavedTabUi의 역). */
export function toSavedTabUi(ui: TabUi, slots: Slot[], bannerDone: boolean): Record<string, unknown> {
  return { layout: ui.layout, activePane: ui.activePane, mainRatio: ui.mainRatio, slots, bannerDone };
}

/**
 * 탭 순서에 새 탭을 세션 생성 시각 순 자리로 넣는다(재연결·복원 탭도 맨 뒤가 아니라 제자리 → "(2)" 표시가 다른 세션으로 옮겨가지 않음).
 *
 * Args:
 *   order: 현재 순서.
 *   id: 넣을 탭.
 *   createdAt: 넣을 탭의 생성 시각.
 *   createdOf: 기존 탭의 생성 시각 조회.
 */
export function insertByCreatedAt(order: string[], id: string, createdAt: number, createdOf: (id: string) => number | undefined): string[] {
  if (order.includes(id)) return order;
  const i = order.findIndex((x) => (createdOf(x) ?? 0) > createdAt);
  return i < 0 ? [...order, id] : [...order.slice(0, i), id, ...order.slice(i)];
}

/** Ctrl+W(Shift 없이) 분리를 받을 포커스인지: 탭 바·사이드바의 텍스트 입력이 아닌 요소만(터미널·입력창·검색창에서는 무시). */
export function ctrlWAllowed(el: Element | null): boolean {
  if (!el || el.closest('.xterm')) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || (el as HTMLElement).isContentEditable) return false;
  return !!el.closest('.tabbar, .sidebar');
}

/** 탭을 닫은 뒤 활성화할 탭: 같은 자리(오른쪽) → 없으면 왼쪽. 남은 탭이 없으면 null. */
export function nextActiveAfterClose(order: string[], closed: string, active: string | null): string | null {
  const rest = order.filter((x) => x !== closed);
  if (active !== closed) return active && rest.includes(active) ? active : rest[0] ?? null;
  const i = order.indexOf(closed);
  return rest[Math.min(i, rest.length - 1)] ?? null;
}
