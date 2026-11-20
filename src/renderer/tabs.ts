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

/** 알림·읽지 않음 대상: done = 리드 차례 끝, approval = 칸 승인 대기 시작(Claude의 질문 선택지도 PermissionRequest로 옴). */
export interface AgentEvent {
  pane: string;
  kind: 'done' | 'approval';
}

/**
 * 같은 탭의 이전·새 상태를 비교해 새로 생긴 이벤트를 찾는다. 처음 보는 탭(prev 없음)은 기준만 잡고, 종료 처리 중인 탭은 무시한다.
 *
 * Args:
 *   prev: 직전에 받은 상태(없으면 처음).
 *   next: 새 상태.
 *   since: 이 탭을 처음 본 시각. 이보다 이른 차례 끝·승인 대기는 무시한다(재연결 때 hook 기록을 처음부터 다시 읽음).
 *
 * Returns:
 *   승인 대기(approval) 먼저, 그다음 리드 차례 끝(done).
 */
export function agentEvents(prev: TabStateDto | undefined, next: TabStateDto, since: number): AgentEvent[] {
  if (!prev || next.terminating) return [];
  const old = new Map(prev.panes.map((p) => [p.paneId, p]));
  const out: AgentEvent[] = [];
  for (const p of next.panes) if (p.waiting && (p.waitingAt ?? 0) >= since && !old.get(p.paneId)?.waiting) out.push({ pane: p.paneId, kind: 'approval' });
  const lead = next.panes.find((p) => p.paneId === next.leadPaneId);
  if (lead && lead.doneAt !== null && lead.doneAt >= since && lead.doneAt > (old.get(lead.paneId)?.doneAt ?? 0)) out.push({ pane: lead.paneId, kind: 'done' });
  return out;
}

/** 리드 차례 끝 알림·읽지 않음 전에 기다리는 시간(다시 확인 간격도 같음). 팀 실행 중 리드가 팀원 메시지마다 차례를 끝내므로 조용해질 때까지 기다린다. */
export const DONE_SETTLE_MS = 8000;
/** 리드 차례 끝 뒤 팀원이 계속 일할 때 다시 확인하는 최대 시간(차례 끝 hook 시각부터). */
export const DONE_RETRY_CAP_MS = 10 * 60_000;

/**
 * 기다린 뒤 차례 끝을 알릴지.
 * - fire: 리드의 마지막 차례 끝이 그대로이고 어떤 칸도 작업 중(최근 2.5초 안 출력)·승인 대기가 아님.
 * - retry: 리드는 그대로인데 어떤 칸이 작업 중·승인 대기(상한 전이면 다시 기다림).
 * - drop: 탭이 닫혔거나 종료 중, 리드가 다시 움직였음(새 차례 끝이 맡음), 또는 상한이 지남.
 *
 * Args:
 *   tab: 지금 탭 상태(닫혔으면 undefined).
 *   doneAt: 기다리기 시작한 리드 차례 끝 hook 시각.
 *   now: 지금 시각(같은 PC의 epoch ms).
 */
export function doneDecision(tab: TabStateDto | undefined, doneAt: number, now: number): 'fire' | 'retry' | 'drop' {
  if (!tab || tab.terminating) return 'drop';
  const lead = tab.panes.find((p) => p.paneId === tab.leadPaneId);
  if (!lead || lead.doneAt !== doneAt) return 'drop';
  if (!tab.panes.some((p) => p.working || p.waiting)) return 'fire';
  return now - doneAt < DONE_RETRY_CAP_MS ? 'retry' : 'drop';
}

/**
 * 리드 차례 끝을 조용해질 때까지 기다렸다가 onFire를 한 번 부른다(DONE_SETTLE_MS마다 doneDecision으로 확인). 같은 탭의 새 차례 끝은
 * 이전 기다림을 대신하고, timers.cancel(tabId)로 멈춘다.
 *
 * Args:
 *   timers: 탭별 타이머.
 *   tabId: 탭.
 *   doneAt: 리드 차례 끝 hook 시각.
 *   getTab: 확인 시점의 최신 탭 상태.
 *   now: 지금 시각.
 *   onFire: 알릴 때(그때의 탭 상태).
 */
export function settleDone(timers: TabTimers, tabId: string, doneAt: number, getTab: () => TabStateDto | undefined, now: () => number,
  onFire: (tab: TabStateDto) => void): void {
  timers.set(tabId, DONE_SETTLE_MS, () => {
    const tab = getTab();
    const d = doneDecision(tab, doneAt, now());
    if (d === 'retry') settleDone(timers, tabId, doneAt, getTab, now, onFire);
    else if (d === 'fire' && tab) onFire(tab);
  });
}

/** 탭마다 하나뿐인 대기 타이머(차례 끝 알림): 같은 탭에 다시 걸면 이전 것을 취소하고 새로 기다린다. */
export class TabTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** ms 뒤 fn 실행(그 탭의 이전 대기는 취소). */
  set(tabId: string, ms: number, fn: () => void): void {
    this.cancel(tabId);
    this.timers.set(tabId, setTimeout(() => {
      this.timers.delete(tabId);
      fn();
    }, ms));
  }

  /** 그 탭의 대기 취소(탭 닫기). */
  cancel(tabId: string): void {
    clearTimeout(this.timers.get(tabId));
    this.timers.delete(tabId);
  }
}

/** 알림 제목에 넣을 이름을 n자(코드 포인트)로 자른다(main이 긴 제목을 버리지 않게, 서로게이트 쌍을 가르지 않음). */
export function clipName(s: string, n = 60): string {
  const cps = Array.from(s);
  return cps.length > n ? `${cps.slice(0, n - 1).join('')}…` : s;
}

/**
 * 읽지 않음 갱신: 리드 차례 끝을 사용자가 보고 있지 않았으면(다른 탭이 활성이거나 창이 비활성) 표시한다.
 *
 * Returns:
 *   바뀌었으면 새 집합, 아니면 같은 집합.
 */
export function markUnread(unread: ReadonlySet<string>, tabId: string, events: AgentEvent[], viewing: boolean): ReadonlySet<string> {
  if (viewing || unread.has(tabId) || !events.some((e) => e.kind === 'done')) return unread;
  return new Set([...unread, tabId]);
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
  /** 이 탭의 Windows 알림 끄기(읽지 않음 표시는 그대로). */
  muted: boolean;
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
  return { ui, slots, bannerDone: o.bannerDone === true, muted: o.muted === true };
}

/** 저장용 값(normalizeSavedTabUi의 역). */
export function toSavedTabUi(ui: TabUi, slots: Slot[], bannerDone: boolean, muted: boolean): Record<string, unknown> {
  return { layout: ui.layout, activePane: ui.activePane, mainRatio: ui.mainRatio, slots, bannerDone, muted };
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
