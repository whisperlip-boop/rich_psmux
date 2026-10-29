// 사이드바 폭 조절 핸들(클릭 영역 8px, accent 선은 경계). 카드 분할선(CardGrid)과 같은 방식: 드래그 중에는 .app의 --sidebar-w만 바꾸고
// (재렌더·칸 크기 변경 없음, 카드는 data-splitting 동안 크기 계산을 건너뜀), 끝날 때 저장 + 모든 카드에 크기 재계산 알림 1회.

import { useEffect, useRef } from 'preact/hooks';

import { clampSidebarWidth, SIDEBAR_DEFAULT_W, SIDEBAR_MAX_W, SIDEBAR_MIN_W } from '../../shared/sidebar';
import { t } from '../i18n';
import { SPLIT_END_EVENT } from '../layout';

interface SidebarHandleProps {
  width: number;
  /** 바뀐 폭 확정(상태·ui-state.json 저장). */
  onCommit: (width: number) => void;
}

/** 키보드 한 번에 바꾸는 폭(px). */
const KEY_STEP = 16;

/** 카드들에 크기 재계산을 알린다(detail null = 모든 탭). */
function notifyCards(): void {
  window.dispatchEvent(new CustomEvent(SPLIT_END_EVENT, { detail: null }));
}

/** 사이드바 폭 핸들. */
export function SidebarHandle({ width, onCommit }: SidebarHandleProps) {
  const drag = useRef<{ pointerId: number; startX: number; startW: number; w: number; app: HTMLElement | null } | null>(null);

  // 드래그 중에 핸들이 사라지면(접기 단축키 등) 표시를 지우고 카드 크기를 다시 맞춘다(리뷰 Nit)
  useEffect(() => () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.app) delete d.app.dataset.splitting;
    notifyCards();
  }, []);
  const app = (e: Event): HTMLElement | null => (e.currentTarget as HTMLElement).closest<HTMLElement>('.app');

  const commit = (w: number): void => {
    if (w !== width) onCommit(w);
    notifyCards();
  };
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const a = app(e);
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startW: width, w: width, app: a };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (a) a.dataset.splitting = '1';
    e.preventDefault(); // 텍스트 선택·터미널 포커스 이동 방지
  };
  const onMove = (e: PointerEvent): void => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const next = clampSidebarWidth(d.startW + (e.clientX - d.startX));
    if (next === d.w) return;
    d.w = next;
    d.app?.style.setProperty('--sidebar-w', `${next}px`);
    (e.currentTarget as HTMLElement).setAttribute('aria-valuenow', String(next));
  };
  const onEnd = (e: PointerEvent): void => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    if (d.app) delete d.app.dataset.splitting;
    commit(d.w);
  };
  const onKey = (e: KeyboardEvent): void => {
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = width - KEY_STEP;
    else if (e.key === 'ArrowRight') next = width + KEY_STEP;
    else if (e.key === 'Home') next = SIDEBAR_DEFAULT_W;
    if (next === null) return;
    e.preventDefault();
    commit(clampSidebarWidth(next));
  };

  return (
    <div class="sidebar-handle" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t('sidebar.width')}
      title={t('sidebar.widthTip')} aria-valuemin={SIDEBAR_MIN_W} aria-valuemax={SIDEBAR_MAX_W} aria-valuenow={width}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onEnd} onLostPointerCapture={onEnd}
      onDblClick={() => commit(SIDEBAR_DEFAULT_W)} onKeyDown={onKey} />
  );
}
