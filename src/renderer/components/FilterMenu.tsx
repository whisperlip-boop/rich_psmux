// 히스토리 필터: 검색창 오른쪽 필터 버튼 → 4항목 메뉴(현재 값 + ›). 항목에 마우스를 올리면(또는 →·Enter) 오른쪽에
// 하위 메뉴(플라이아웃)가 붙어 열리고, 값을 고르면 적용 후 메뉴 전체가 닫힌다.
// 최상위·하위 메뉴 모두 position: fixed라 사이드바(overflow hidden) 밖·카드 영역 위로 나올 수 있다. 하위 메뉴는 화면 오른쪽이 모자라면 왼쪽에 붙인다.
// 최상위 메뉴는 내용 폭(라벨 한 줄·값 전체, 최대 360px)이라 긴 언어(ta·ml 등)에서 사이드바보다 넓어질 수 있다.
// 키보드: ↑↓ 이동, →·Enter 하위 열기, ← 하위 닫기(최상위 그 항목으로), Esc 전체 닫기(필터 버튼으로 포커스).

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { resolveMsg } from '../../shared/i18n';
import { FILTER_FIELDS, isDefaultFilter, type HistoryFilter } from '../history';
import { t } from '../i18n';

interface FilterMenuProps {
  filter: HistoryFilter;
  onChange: (f: HistoryFilter) => void;
}

/** 화면 가장자리 여백(px). */
const EDGE = 8;
/** 필터 버튼 영역 위쪽에서 최상위 메뉴 위쪽까지(px, 예전 CSS top: 34px와 같은 자리). */
const MENU_TOP = 34;

/**
 * 최상위 메뉴 위치(순수 함수, 테스트 대상): 메뉴는 내용 폭(최대 360px)이라 사이드바보다 넓을 수 있다.
 * 필터 버튼 오른쪽 끝에 맞춰 왼쪽으로 펼치고, 왼쪽이 모자라면 화면 왼쪽 여백에 붙여 오른쪽(카드 영역 위)으로 넘긴다.
 * 오른쪽·아래가 모자라면 창 안으로 당긴다.
 *
 * Args:
 *   anchor: 필터 버튼 영역 화면 좌표. w·h: 메뉴 크기. vw·vh: 창 크기.
 */
export function menuPosition(anchor: { top: number; right: number }, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  const left = Math.max(EDGE, Math.min(anchor.right - w, vw - EDGE - w));
  const top = Math.max(EDGE, Math.min(anchor.top + MENU_TOP, vh - EDGE - h));
  return { left: Math.round(left), top: Math.round(top) };
}

/** 필드의 현재 값 표시 이름(현재 언어). */
export function filterValueLabel(f: HistoryFilter, key: keyof HistoryFilter): string {
  const label = FILTER_FIELDS.find((x) => x.key === key)?.options.find(([v]) => v === f[key])?.[1];
  return label ? resolveMsg(label) : '';
}

/**
 * 하위 메뉴 위치(순수 함수, 테스트 대상): 최상위 메뉴 오른쪽 가장자리에 틈 없이 붙이고(위는 그 항목과 맞춤),
 * 오른쪽이 모자라면 최상위 메뉴 왼쪽에 붙인다. 아래가 모자라면 위로 올린다.
 *
 * Args:
 *   menu: 최상위 메뉴 화면 좌표. row: 마우스를 올린 항목 화면 좌표. w·h: 하위 메뉴 크기. vw·vh: 창 크기.
 */
export function flyoutPosition(menu: { left: number; right: number }, row: { top: number }, w: number, h: number, vw: number, vh: number): { left: number; top: number; side: 'right' | 'left' } {
  const right = menu.right + w <= vw - EDGE;
  const left = right ? menu.right : Math.max(EDGE, menu.left - w);
  // 하위 메뉴 첫 선택지가 그 항목 높이에 오도록 메뉴 안쪽 여백(4)만큼 올린다
  const top = Math.max(EDGE, Math.min(row.top - 4, vh - EDGE - h));
  return { left: Math.round(left), top: Math.round(top), side: right ? 'right' : 'left' };
}

/** 필터 버튼 + 메뉴 + 하위 메뉴. */
export function FilterMenu({ filter, onChange }: FilterMenuProps) {
  const [open, setOpen] = useState(false);
  /** 하위 메뉴가 열린 필드(없으면 null). */
  const [sub, setSub] = useState<keyof HistoryFilter | null>(null);
  /** 하위 메뉴를 키보드로 열었으면 체크된 선택지로 포커스를 옮긴다(마우스로 열면 포커스는 그대로). */
  const [subFocus, setSubFocus] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  /** 최상위 메뉴 자리(position: fixed라 사이드바 overflow에 잘리지 않음). 재기 전에는 null. */
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);

  const closeAll = (focusButton: boolean): void => {
    setOpen(false);
    setSub(null);
    setPos(null);
    if (focusButton) btnRef.current?.focus();
  };
  const rowOf = (key: keyof HistoryFilter): HTMLElement | null => rootRef.current?.querySelector<HTMLElement>(`[data-field="${key}"]`) ?? null;
  const openSub = (key: keyof HistoryFilter, viaKeyboard: boolean): void => {
    // 포커스가 하위 메뉴 안에 있었으면(키보드로 들어간 뒤 마우스로 다른 항목에 올림) 새 하위의 체크 항목으로 옮긴다.
    // 아니면 포커스가 사라진 하위 메뉴에 남아 body로 떨어진다
    const inSub = !!subRef.current?.contains(document.activeElement);
    setSubFocus(viaKeyboard || inSub);
    if (sub !== key) setPos(null);
    setSub(key);
  };
  const closeSub = (): void => {
    const key = sub;
    setSub(null);
    setPos(null);
    if (key) rowOf(key)?.focus();
  };

  // 최상위 메뉴: 그린 뒤 실제 크기로 자리를 정한다(그 전에는 visibility: hidden). 창 크기가 바뀌면 메뉴를 닫으므로 열 때 한 번
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const a = ref.current?.getBoundingClientRect();
    const m = rootRef.current;
    if (!a || !m) return;
    setMenuPos(menuPosition(a, m.offsetWidth, m.offsetHeight, window.innerWidth, window.innerHeight));
  }, [open]);
  // 열 때(자리가 정해져 보인 뒤) 첫 항목에 포커스
  useEffect(() => {
    if (open && menuPos) rootRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open, menuPos]);

  // 하위 메뉴: 그린 뒤 실제 크기로 자리를 정한다(그 전에는 visibility: hidden)
  useLayoutEffect(() => {
    if (!sub) return;
    const m = rootRef.current?.getBoundingClientRect();
    const r = rowOf(sub)?.getBoundingClientRect();
    const s = subRef.current;
    if (!m || !r || !s) return;
    setPos(flyoutPosition(m, r, s.offsetWidth, s.offsetHeight, window.innerWidth, window.innerHeight));
  }, [sub]);
  // 키보드로 열었으면 자리가 정해져 보인 뒤(visibility: hidden 요소는 포커스를 받지 못함) 체크된 선택지에 포커스
  useEffect(() => {
    if (!pos || !subFocus) return;
    const s = subRef.current;
    (s?.querySelector<HTMLElement>('[aria-checked="true"]') ?? s?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }, [pos, subFocus]);

  useEffect(() => {
    if (!open) return;
    // 하위 메뉴는 이 요소의 자식이라(화면 위치만 fixed) 밖 클릭 판정에 함께 들어간다
    const outside = (e: PointerEvent): void => { if (!ref.current?.contains(e.target as Node)) closeAll(false); };
    const onKey = (e: KeyboardEvent): void => {
      const inSub = !!subRef.current?.contains(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeAll(true);
        return;
      }
      if (e.key === 'ArrowLeft' && sub) {
        e.preventDefault();
        e.stopPropagation();
        closeSub();
        return;
      }
      if (e.key === 'ArrowRight' && !inSub) {
        const key = (document.activeElement as HTMLElement | null)?.dataset.field as keyof HistoryFilter | undefined;
        if (key) {
          e.preventDefault();
          e.stopPropagation();
          openSub(key, true);
        }
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const box = inSub ? subRef.current : rootRef.current;
      const list = [...(box?.querySelectorAll<HTMLElement>('button') ?? [])];
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const next = list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length];
      next?.focus();
      // 최상위에서 키보드로 옮기면 열려 있던 하위 메뉴는 닫는다(마우스 hover와 섞이지 않게)
      if (!inSub && sub) {
        setSub(null);
        setPos(null);
      }
    };
    const dismiss = (): void => closeAll(false);
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open, sub]);

  const field = sub ? FILTER_FIELDS.find((x) => x.key === sub) : null;
  const pick = (value: string): void => {
    if (!sub) return;
    onChange({ ...filter, [sub]: value } as HistoryFilter);
    closeAll(true);
  };
  const changed = !isDefaultFilter(filter);

  return (
    <div class="filter" ref={ref}>
      <button ref={btnRef} class={`icon-btn filter__btn${changed ? ' has-filter' : ''}`} aria-label={t(changed ? 'filter.labelChanged' : 'filter.label')}
        title={t('filter.label')} aria-haspopup="menu" aria-expanded={open}
        onClick={() => (open ? closeAll(false) : (setSub(null), setPos(null), setOpen(true)))}>
        <span class="ico ico--filter" aria-hidden="true" />
      </button>
      {open && (
        <div ref={rootRef} class="menu__list filter-menu" role="menu" aria-label={t('filter.label')}
          style={menuPos ? { left: `${menuPos.left}px`, top: `${menuPos.top}px` } : { left: '0px', top: '0px', visibility: 'hidden' }}>
          {FILTER_FIELDS.map((x, i) => [
            // 보기 범위(상태·최근 활동)와 보기 방식(그룹화·정렬) 사이 구분선
            i === 2 ? <div key="sep" class="menu__sep" role="separator" /> : null,
            <button key={x.key} role="menuitem" aria-haspopup="menu" aria-expanded={sub === x.key} data-field={x.key}
              class={sub === x.key ? 'is-open' : undefined}
              onMouseEnter={() => openSub(x.key, false)} onClick={() => openSub(x.key, true)}>
              <span class="filter-menu__label">{resolveMsg(x.label)}</span>
              <span class="filter-menu__value" title={filterValueLabel(filter, x.key)}>{filterValueLabel(filter, x.key)}</span>
              <span class="filter-menu__chev" aria-hidden="true">›</span>
            </button>,
          ])}
        </div>
      )}
      {open && field && (
        <div ref={subRef} class="menu__list filter-sub" role="menu" aria-label={resolveMsg(field.label)}
          style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: '0px', top: '0px', visibility: 'hidden' }}>
          {field.options.map(([v, label]) => (
            <button key={v} role="menuitemradio" aria-checked={filter[field.key] === v} onClick={() => pick(v)}>
              <span class="filter-menu__label">{resolveMsg(label)}</span>
              <span class="filter-menu__check" aria-hidden="true">{filter[field.key] === v ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
