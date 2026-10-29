// 카드 그리드(F4): 레이아웃 1~5. 배치는 CSS가 정하고 psmux 레이아웃에는 의존하지 않는다.
// 모든 레이아웃에서 같은 DOM 구조([리드 자리][나머지])를 써서 레이아웃을 바꿔도 카드(xterm)가 다시 만들어지지 않게 한다.
// 1·2·5에서는 두 묶음이 display: contents로 풀려 한 흐름이 된다. 분할 경계선도 항상 두고 3·4에서만 CSS로 보인다.

import { useRef } from 'preact/hooks';

import type { TabStateDto } from '../../shared/api';
import { t } from '../i18n';
import {
  DEFAULT_MAIN_RATIO, MAX_MAIN_RATIO, MIN_MAIN_RATIO, SPLIT_END_EVENT, getMainRatio, isMainLayout, ratioFromKey,
  ratioFromPointer, splitLead, tiledGrid, withMainRatio, type MainLayoutId, type TabUi,
} from '../layout';
import { sortBySlots, type Slot } from '../slots';
import { Card } from './Card';

interface CardGridProps {
  tab: TabStateDto;
  /** 카드 자리 순서(main이 보낸 순서·pane 번호로 재정렬하지 않음). */
  slots: Slot[] | undefined;
  ui: TabUi;
  onUi: (ui: TabUi) => void;
  onInfo: (pane: string) => void;
  /** 리드 카드 배너 문구(없으면 null): 이어가기 안내, 로그인 실패 안내. */
  banner: string | null;
  onDismissBanner: () => void;
  /** 파일 드래그 중 놓을 대상 카드(없으면 null). */
  dropPane: string | null;
  onError: (msg: string) => void;
  /** 폴더 추가(리드 카드가 없으면 null). */
  onAddDir: (() => void) | null;
}

/** 경계선 드래그 상태. offset = 잡은 위치와 경계선 가운데의 차이(잡자마자 튀지 않게). */
interface SplitDrag {
  pointerId: number;
  offset: number;
  ratio: number;
}

/** 분할 축(3: 세로 위치, 4: 가로 위치)의 포인터 좌표. */
const axisPos = (layout: MainLayoutId, e: PointerEvent): number => (layout === 3 ? e.clientY : e.clientX);

/** 그리드 내용 영역(padding 안쪽·스크롤 반영) 기준으로 포인터 좌표를 리드 비율로. */
function pointerRatio(grid: HTMLElement, handle: HTMLElement, layout: MainLayoutId, pos: number): number {
  const cs = getComputedStyle(grid);
  const r = grid.getBoundingClientRect();
  const h = handle.getBoundingClientRect();
  if (layout === 3) {
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    return ratioFromPointer(pos, r.top + grid.clientTop + pt - grid.scrollTop, grid.clientHeight - pt - pb, h.height);
  }
  const pl = parseFloat(cs.paddingLeft) || 0;
  const pr = parseFloat(cs.paddingRight) || 0;
  return ratioFromPointer(pos, r.left + grid.clientLeft + pl - grid.scrollLeft, grid.clientWidth - pl - pr, h.width);
}

/** 탭 하나의 카드 그리드. */
export function CardGrid({ tab, slots, ui, onUi, onInfo, banner, onDismissBanner, dropPane, onError, onAddDir }: CardGridProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const drag = useRef<SplitDrag | null>(null);
  const disconnected = tab.status === 'reconnecting' || tab.status === 'ended' || tab.status === 'error';
  if (!tab.panes.length) {
    const msg = t(tab.status === 'starting' ? 'grid.starting' : disconnected ? 'card.disconnected' : tab.leadGone ? 'grid.leadGone' : 'grid.waiting');
    return <div class="grid-empty">{msg}</div>;
  }
  const sorted = sortBySlots(tab.panes, slots);
  const byId = new Map(sorted.map((p) => [p.paneId, p]));
  const { main, rest } = splitLead(sorted.map((p) => p.paneId), tab.leadPaneId);
  const activePane = ui.activePane && byId.has(ui.activePane) ? ui.activePane : main ?? rest[0] ?? null;
  const tiled = tiledGrid(sorted.length);
  const split = isMainLayout(ui.layout) ? ui.layout : null;
  const ratio = split ? getMainRatio(ui, split) : DEFAULT_MAIN_RATIO;
  const style = { '--cols': String(tiled.cols), '--rows': String(tiled.rows), '--main-ratio': String(ratio) } as Record<string, string>;

  // 드래그 중에는 CSS 변수만 바꾸고(재렌더·칸 크기 변경 없음), 끝날 때 탭 상태에 저장 + 카드에 크기 재계산 알림
  const onSplitDown = (e: PointerEvent): void => {
    if (!split || e.button !== 0) return;
    const h = e.currentTarget as HTMLElement;
    const r = h.getBoundingClientRect();
    const center = split === 3 ? r.top + r.height / 2 : r.left + r.width / 2;
    drag.current = { pointerId: e.pointerId, offset: axisPos(split, e) - center, ratio };
    h.setPointerCapture(e.pointerId);
    // class는 재렌더 때 덮어써지므로(드래그 중 탭 상태 갱신) Preact가 관리하지 않는 data 속성으로 표시
    if (gridRef.current) gridRef.current.dataset.splitting = '1';
    e.preventDefault(); // 텍스트 선택·터미널 포커스 이동 방지
  };
  const onSplitMove = (e: PointerEvent): void => {
    const d = drag.current;
    const grid = gridRef.current;
    if (!split || !d || !grid || e.pointerId !== d.pointerId) return;
    const h = e.currentTarget as HTMLElement;
    const next = pointerRatio(grid, h, split, axisPos(split, e) - d.offset);
    if (next === d.ratio) return;
    d.ratio = next;
    grid.style.setProperty('--main-ratio', String(next));
    h.setAttribute('aria-valuenow', String(Math.round(next)));
  };
  const onSplitEnd = (e: PointerEvent): void => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    if (gridRef.current) delete gridRef.current.dataset.splitting;
    if (split && d.ratio !== ratio) onUi(withMainRatio(ui, split, d.ratio));
    window.dispatchEvent(new CustomEvent(SPLIT_END_EVENT, { detail: tab.tabId }));
  };
  const onSplitKey = (e: KeyboardEvent): void => {
    const next = split ? ratioFromKey(e.key, ratio) : null;
    if (!split || next === null) return;
    e.preventDefault();
    if (next !== ratio) onUi(withMainRatio(ui, split, next));
  };

  const card = (id: string) => {
    const p = byId.get(id)!;
    return (
      <Card key={id} tabId={tab.tabId} pane={p} active={activePane === id} disconnected={disconnected} locked={tab.terminating}
        banner={id === main ? banner : null} onDismissBanner={onDismissBanner}
        dropTarget={dropPane === id} onError={onError} onAddDir={onAddDir}
        onActivate={() => { if (ui.activePane !== id) onUi({ ...ui, activePane: id }); }}
        onInfo={onInfo} onReconnect={() => window.ctd.reconnect(tab.tabId)} />
    );
  };
  return (
    <div class="grid-wrap">
    {tab.leadGone && <div class="grid-notice" role="status">{t('grid.leadGoneNotice')}</div>}
    <div ref={gridRef} class={`grid lay-${ui.layout}${rest.length === 0 ? ' no-rest' : ''}${main === null ? ' no-main' : ''}`} style={style} data-layout={ui.layout}>
      <div class="lay-main">{main && card(main)}</div>
      <div class="split-handle" role="separator" tabIndex={0} aria-label={t('grid.splitLabel')}
        aria-orientation={split === 4 ? 'vertical' : 'horizontal'} aria-valuemin={MIN_MAIN_RATIO} aria-valuemax={MAX_MAIN_RATIO}
        aria-valuenow={Math.round(ratio)} onPointerDown={onSplitDown} onPointerMove={onSplitMove} onPointerUp={onSplitEnd}
        onPointerCancel={onSplitEnd} onLostPointerCapture={onSplitEnd} onKeyDown={onSplitKey}
        onDblClick={() => { if (split && ratio !== DEFAULT_MAIN_RATIO) onUi(withMainRatio(ui, split, DEFAULT_MAIN_RATIO)); }} />
      <div class="lay-rest">{rest.map(card)}</div>
    </div>
    </div>
  );
}
