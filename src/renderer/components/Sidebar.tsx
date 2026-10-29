// 좌측 사이드바: [+ 새 세션](최근 폴더), 검색, 탭 없는 세션 그룹(있을 때만 맨 위), 폴더 그룹(접기 상태 저장) 안 최신순 대화, 상태 점, 활성 대화 강조, 계정 영역(M4).

import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { DetachedSessionDto, HistoryDto, HistoryItemDto, RunningDto, TabStateDto } from '../../shared/api';
import { getLang } from '../../shared/i18n';
import {
  displayTitle, formatTime, historyTip, isDefaultFilter, itemDot, itemTimeLabel, stopTarget, trashBlockedReason, viewHistory, type DotKind, type HistoryFilter,
} from '../history';
import { t } from '../i18n';
import { folderName } from '../layout';
import { FilterMenu } from './FilterMenu';
import { StatusDot } from './StatusDot';


interface SidebarProps {
  history: HistoryDto;
  running: RunningDto[];
  tabs: TabStateDto[];
  /** 활성 탭의 대화 ID(강조). */
  activeConversation: string | null;
  collapsed: Set<string>;
  onToggle: (folderKey: string) => void;
  onOpen: (sessionId: string) => void;
  onNew: (folder?: string) => void;
  onRetry: () => void;
  recent: string[];
  busy: boolean;
  /** 하단 계정 영역(F7). */
  footer: ComponentChildren;
  /** 항목 메뉴(F2-1). */
  onRename: (item: HistoryItemDto) => void;
  onArchive: (item: HistoryItemDto, archived: boolean) => void;
  onTrash: (item: HistoryItemDto) => void;
  /** 세션 끊기 확인 열기(F2-1): 실행 중이고 탭이 없는 대화. */
  onStop: (item: HistoryItemDto) => void;
  /** 끊는 중인 대상 키(psmux 세션 이름 또는 `pid:<n>`). */
  stopping: ReadonlySet<string>;
  /** 접힘(F: 사이드바 접기). 접혀 있으면 화면에서 빼되 상태(검색어 등)는 유지한다. */
  hidden: boolean;
  onCollapse: () => void;
  /** 새 세션 메뉴에 보일 현재 리더(F8-1, "claude --agent X"면 X, 아니면 리드 명령). 모르면 null. */
  leadLabel: string | null;
  /** 히스토리 필터(F2-2, ui-state.json에 저장). */
  filter: HistoryFilter;
  onFilter: (f: HistoryFilter) => void;
  /** 탭 없는 앱 세션(F2-1 보완): 있을 때만 맨 위 그룹. */
  detached: DetachedSessionDto[];
  /** 탭 없는 세션 다시 연결(새 탭). */
  onAttachDetached: (d: DetachedSessionDto) => void;
  /** 탭 없는 세션 끊기 확인 열기. */
  onStopDetached: (d: DetachedSessionDto) => void;
}

/** 탭 없는 세션 그룹의 접기 키(폴더 키는 경로라 '<'로 시작하지 않고 날짜 키는 `<date:…>`라 겹치지 않음). */
const DETACHED_GROUP_KEY = '<detached>';

/** 메뉴 가장자리 여백(px). */
const MENU_MARGIN = 8;

/**
 * 고정 위치 메뉴의 좌표(순수 함수, 테스트 대상): ⋮ 버튼 아래·오른쪽 정렬, 아래 공간이 모자라면 위로 펼친다. 창 밖으로 나가지 않게 자른다.
 *
 * Args:
 *   anchor: ⋮ 버튼 화면 좌표.
 *   w: 메뉴 폭. h: 메뉴 높이. vw: 창 폭. vh: 창 높이.
 */
export function menuPosition(anchor: { top: number; bottom: number; right: number }, w: number, h: number, vw: number, vh: number): { left: number; top: number; up: boolean } {
  const up = anchor.bottom + 2 + h > vh - MENU_MARGIN && anchor.top - 2 - h >= MENU_MARGIN;
  const top = up ? anchor.top - 2 - h : Math.max(MENU_MARGIN, Math.min(anchor.bottom + 2, vh - MENU_MARGIN - h));
  const left = Math.max(MENU_MARGIN, Math.min(anchor.right - w, vw - MENU_MARGIN - w));
  return { left: Math.round(left), top: Math.round(top), up };
}

interface HistRowProps {
  it: HistoryItemDto;
  groupKey: string;
  title: string;
  time: string;
  dot: DotKind;
  active: boolean;
  busy: boolean;
  tabIndex: number;
  tip: string;
  menuOpen: boolean;
  /** 삭제할 수 없으면 사유(라벨에 글자로 붙임). */
  trashBlocked: string | null;
  /** "세션 끊기…" 항목을 넣을지(실행 중 + 탭 없음). */
  canStop: boolean;
  /** 이 대화의 세션을 끊는 중(항목 비활성·행 클릭 무시). */
  stopping: boolean;
  onMenu: (open: boolean) => void;
  onOpen: () => void;
  onRename: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onStop: () => void;
}

/** 행 ⋮ 메뉴의 고정 위치. 자리를 정하기 전(null)에는 숨겨 그린다. */
function useMenuPos(open: boolean, moreRef: RefObject<HTMLButtonElement | null>, menuRef: RefObject<HTMLDivElement | null>): { left: number; top: number } | null {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // 메뉴는 position: fixed(목록 overflow에 잘리지 않고 목록 스크롤 높이도 늘리지 않음). 그린 뒤 실제 크기로 자리를 정한다
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const a = moreRef.current?.getBoundingClientRect();
    const m = menuRef.current;
    if (a && m) setPos(menuPosition(a, m.offsetWidth, m.offsetHeight, window.innerWidth, window.innerHeight));
  }, [open]);
  return pos;
}

/** 메뉴 자리 스타일(자리를 정하기 전에는 숨김). */
function menuStyle(pos: { left: number; top: number } | null): Record<string, string> {
  return pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: '0px', top: '0px', visibility: 'hidden' };
}

/**
 * 행 메뉴 항목 클릭 처리기 만들기: 메뉴 항목은 닫히면서 사라지므로 행에 먼저 포커스를 둔다.
 * 대화상자가 닫힌 뒤 이 행으로 돌아온다(계정 메뉴 m-6과 같은 방식).
 */
function menuPick(onMenu: (open: boolean) => void, rowRef: RefObject<HTMLButtonElement | null>): (fn: () => void) => () => void {
  return (fn) => () => {
    onMenu(false);
    rowRef.current?.focus();
    fn();
  };
}

/** ⋮ 버튼 아이콘. */
function MoreIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="8" cy="13" r="1.4" /></svg>;
}

/** 대화 한 줄 + hover·포커스 때 보이는 ⋮ 메뉴(F2-1). 행 버튼 안에 버튼을 넣을 수 없어 형제로 둔다. */
function HistRow(p: HistRowProps) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pos = useMenuPos(p.menuOpen, moreRef, menuRef);
  const pick = menuPick(p.onMenu, rowRef);
  return (
    <div class={`hist-item${p.menuOpen ? ' is-menu' : ''}${p.it.archived ? ' is-archived' : ''}`}>
      <button ref={rowRef} class={`hist-row${p.active ? ' is-active' : ''}`} data-nav="item" data-group={p.groupKey} tabIndex={p.tabIndex}
        aria-current={p.active ? 'true' : undefined} disabled={p.busy} title={p.tip} onClick={p.onOpen}
        onContextMenu={(e) => { e.preventDefault(); p.onMenu(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            p.onMenu(true);
          }
        }}>
        <span class="hist-row__dot">{p.dot && <StatusDot kind={p.dot} />}</span>
        <span class="hist-row__title">{p.title}</span>
        {/* 보관 표시: 좁은 폭에서도 들어가게 글자 대신 12px 아이콘(designer 4) */}
        {p.it.archived && <span class="ico ico--archive hist-row__badge" role="img" aria-label={t('hist.archived')} title={t('hist.archived')} />}
        <span class="hist-row__time">{p.time}</span>
      </button>
      <button ref={moreRef} class="icon-btn icon-btn--24 hist-row__more" tabIndex={-1} title={t('hist.menuTip')} aria-label={t('hist.menu')} aria-haspopup="menu"
        aria-expanded={p.menuOpen} disabled={p.busy} onClick={() => p.onMenu(!p.menuOpen)}>
        <MoreIcon />
      </button>
      {p.menuOpen && (
        <div ref={menuRef} class="menu__list hist-menu" role="menu" aria-label={t('hist.menu')} style={menuStyle(pos)}>
          <button role="menuitem" onClick={pick(p.onRename)}><span class="ico ico--rename" aria-hidden="true" />{t('hist.rename')}</button>
          <button role="menuitem" onClick={pick(p.onArchive)}><span class="ico ico--archive" aria-hidden="true" />{t(p.it.archived ? 'hist.unarchive' : 'hist.archive')}</button>
          {p.canStop && (
            <button role="menuitem" class="is-danger" disabled={p.stopping} onClick={pick(p.onStop)}>
              <span class="ico ico--sessioncut" aria-hidden="true" />{t('hist.stop')}{p.stopping && <span class="menu__reason">{t('hist.stopping')}</span>}
            </button>
          )}
          <button role="menuitem" class="is-danger" disabled={!!p.trashBlocked} onClick={pick(p.onTrash)}>
            <span class="ico ico--delete" aria-hidden="true" />{t('hist.delete')}{p.trashBlocked && <span class="menu__reason">{t('common.withReason', { reason: p.trashBlocked })}</span>}
          </button>
        </div>
      )}
    </div>
  );
}

interface DetachedRowProps {
  d: DetachedSessionDto;
  now: Date;
  busy: boolean;
  tabIndex: number;
  menuOpen: boolean;
  /** 이 세션을 끊는 중(항목 비활성·행 클릭 무시). */
  stopping: boolean;
  onMenu: (open: boolean) => void;
  onAttach: () => void;
  onStop: () => void;
}

/** 탭 없는 앱 세션 한 줄(F2-1 보완): 클릭 = 다시 연결, ⋮ 메뉴 = 세션 끊기…만. HistRow와 같은 구조. */
function DetachedRow(p: DetachedRowProps) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pos = useMenuPos(p.menuOpen, moreRef, menuRef);
  const pick = menuPick(p.onMenu, rowRef);
  const tip = [p.d.folder, t('hist.detachedNote'), p.d.plain ? t('tab.plainHeader') : null, p.d.session].filter(Boolean).join('\n');
  return (
    <div class={`hist-item${p.menuOpen ? ' is-menu' : ''}`}>
      <button ref={rowRef} class="hist-row" data-nav="item" data-group={DETACHED_GROUP_KEY} tabIndex={p.tabIndex}
        disabled={p.busy} title={tip} onClick={() => { if (!p.stopping) p.onAttach(); }}
        onContextMenu={(e) => { e.preventDefault(); p.onMenu(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            p.onMenu(true);
          }
        }}>
        <span class="hist-row__dot"><StatusDot kind="detached" /></span>
        <span class="hist-row__title">{t('hist.detachedTitle', { folder: p.d.folderName })}</span>
        <span class="hist-row__time">{formatTime(p.d.createdAt, p.now)}</span>
      </button>
      <button ref={moreRef} class="icon-btn icon-btn--24 hist-row__more" tabIndex={-1} title={t('hist.menuTip')} aria-label={t('hist.menu')} aria-haspopup="menu"
        aria-expanded={p.menuOpen} disabled={p.busy} onClick={() => p.onMenu(!p.menuOpen)}>
        <MoreIcon />
      </button>
      {p.menuOpen && (
        <div ref={menuRef} class="menu__list hist-menu" role="menu" aria-label={t('hist.menu')} style={menuStyle(pos)}>
          <button role="menuitem" class="is-danger" disabled={p.stopping} onClick={pick(p.onStop)}>
            <span class="ico ico--sessioncut" aria-hidden="true" />{t('hist.stop')}{p.stopping && <span class="menu__reason">{t('hist.stopping')}</span>}
          </button>
        </div>
      )}
    </div>
  );
}


/** 사이드바. */
export function Sidebar(props: SidebarProps) {
  const { history, running, tabs, activeConversation, collapsed, busy } = props;
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(() => new Date());
  const [newOpen, setNewOpen] = useState(false);
  /** 메뉴가 열린 항목 키(F2-1). */
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const newRef = useRef<HTMLDivElement>(null);

  // 항목 메뉴: 첫 항목 포커스, 밖 클릭·Esc로 닫기(Esc는 행으로 포커스), ↑↓ 이동
  useEffect(() => {
    if (!menuKey) return;
    const box = (): HTMLElement | null => listRef.current?.querySelector<HTMLElement>('.hist-item.is-menu') ?? null;
    // 메뉴는 fixed라 목록을 스크롤할 필요가 없다. 포커스가 목록을 스크롤하면 아래 dismiss가 메뉴를 바로 닫는다
    box()?.querySelector<HTMLElement>('.hist-menu button:not(:disabled)')?.focus({ preventScroll: true });
    const close = (e: PointerEvent): void => { if (!box()?.contains(e.target as Node)) setMenuKey(null); };
    const onKey = (e: KeyboardEvent): void => {
      const b = box();
      if (!b) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMenuKey(null);
        b.querySelector<HTMLElement>('.hist-row')?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...b.querySelectorAll<HTMLElement>('.hist-menu button:not(:disabled)')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      e.preventDefault();
      e.stopPropagation();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus({ preventScroll: true });
    };
    // 메뉴는 화면 기준(fixed)이라 목록이 스크롤되거나 창 크기가 바뀌면 행과 어긋나므로 닫는다
    const dismiss = (): void => setMenuKey(null);
    const list = listRef.current;
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', dismiss);
    list?.parentElement?.addEventListener('scroll', dismiss, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', dismiss);
      list?.parentElement?.removeEventListener('scroll', dismiss);
    };
  }, [menuKey]);

  // 시각 표기(오늘/어제)가 날짜를 넘겨도 맞게 1분마다 갱신
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (!newOpen) return;
    const close = (e: PointerEvent): void => { if (!newRef.current?.contains(e.target as Node)) setNewOpen(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setNewOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [newOpen]);

  // 날짜 그룹 이름·이름 정렬이 언어를 따르므로 언어가 바뀌면 다시 계산한다
  const lang = getLang();
  const groups = useMemo(() => viewHistory(history.items, props.filter, query, now), [history.items, props.filter, query, now, lang]);
  const searching = query.trim() !== '';
  const isCollapsedKey = (key: string): boolean => collapsed.has(key);
  const toggleKey = (key: string): void => props.onToggle(key);
  const active = activeConversation?.toLowerCase() ?? null;

  // 목록 키보드: ↑↓ 이동, ← 그룹 접기(항목이면 그룹 머리로), → 펼치기, Enter 열기(버튼 기본 동작)
  const onListKey = (e: KeyboardEvent): void => {
    const els = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])];
    const cur = document.activeElement as HTMLElement;
    const i = els.indexOf(cur);
    if (i < 0) return;
    const focus = (el: HTMLElement | undefined): void => {
      if (!el) return;
      els.forEach((x) => { x.tabIndex = -1; });
      el.tabIndex = 0;
      el.focus();
    };
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focus(els[Math.min(els.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const key = cur.dataset.group;
      if (cur.dataset.nav === 'group' && key) {
        const isCollapsed = isCollapsedKey(key);
        if ((e.key === 'ArrowLeft') !== isCollapsed) toggleKey(key);
      } else if (e.key === 'ArrowLeft' && key) {
        focus(els.find((x) => x.dataset.nav === 'group' && x.dataset.group === key));
      }
    }
  };

  // 목록에서 처음 그린 항목만 Tab으로 들어온다(roving tabindex). 탭 없는 세션 그룹이 맨 위라 먼저 그린다
  let first = true;
  const roving = (): number => {
    const v = first ? 0 : -1;
    first = false;
    return v;
  };
  const head = (key: string, name: string, count: number, open: boolean, tip: string) => (
    <button class="hist-group__head" data-nav="group" data-group={key} tabIndex={roving()} aria-expanded={open} title={tip} onClick={() => toggleKey(key)}>
      <span class="hist-group__caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      <span class="hist-group__name">{name}</span>
      <span class="hist-group__count">{count}</span>
    </button>
  );
  // 탭 없는 앱 세션(F2-1 보완): 있을 때만, 히스토리 상태(로딩·오류·비어 있음)와 무관하게 보인다. 검색 중에는 대화 결과만 보이게 숨긴다
  let detachedGroup = null;
  if (props.detached.length > 0 && !searching) {
    const open = !collapsed.has(DETACHED_GROUP_KEY);
    detachedGroup = (
      <div key={DETACHED_GROUP_KEY} class="hist-group" role="group">
        {head(DETACHED_GROUP_KEY, t('hist.detachedGroup'), props.detached.length, open, t('hist.detachedTip'))}
        {open && props.detached.map((d) => (
          <DetachedRow key={d.session} d={d} now={now} busy={busy} tabIndex={roving()} menuOpen={menuKey === d.session} stopping={props.stopping.has(d.session)}
            onMenu={(o) => setMenuKey(o ? d.session : null)} onAttach={() => props.onAttachDetached(d)} onStop={() => props.onStopDetached(d)} />
        ))}
      </div>
    );
  }
  // 그룹 목록이 없을 때(로딩·오류·안내문): 탭 없는 세션만 담은 트리를 안내문 위에 둔다
  const detachedTree = detachedGroup && (
    <div class="hist" role="tree" aria-label={t('common.history')} ref={listRef} onKeyDown={onListKey}>{detachedGroup}</div>
  );

  let body;
  if (history.status === 'loading') {
    body = (
      <>
        {detachedTree}
        <div class="hist-skeleton" aria-busy="true" aria-label={t('hist.loading')}>
          {Array.from({ length: 6 }, (_, i) => <div key={i} class="hist-skeleton__row" />)}
        </div>
      </>
    );
  } else if (history.status === 'error') {
    body = (
      <>
        {detachedTree}
        <div class="hist-empty" role="alert">
          <p>{t('hist.readFailed')}</p>
          <button class="btn-secondary" onClick={props.onRetry}>{t('common.retry')}</button>
        </div>
      </>
    );
  } else if (!history.items.length) {
    body = <>{detachedTree}<div class="hist-empty">{t('hist.empty')}</div></>;
  } else if (!groups.length) {
    body = <>{detachedTree}<div class="hist-empty">{searching ? t('common.noResults', { q: query.trim() }) : t(isDefaultFilter(props.filter) ? 'hist.noActive' : 'hist.noMatch')}</div></>;
  } else {
    const row = (it: HistoryItemDto, groupKey: string, groupName: string) => {
      const title = displayTitle(it, now);
      const target = stopTarget(it.sessionId, tabs, running);
      const stoppingRow = target !== null && props.stopping.has(target.key);
      return (
        <HistRow key={it.key} it={it} groupKey={groupKey} title={title} time={itemTimeLabel(it.mtimeMs, now, groupKey)} dot={itemDot(it.sessionId, tabs, running)}
          active={active !== null && it.sessionId.toLowerCase() === active} busy={busy} tabIndex={roving()}
          tip={historyTip(it, title, groupName)}
          menuOpen={menuKey === it.key} trashBlocked={trashBlockedReason(it.sessionId, tabs, running)} canStop={target !== null} stopping={stoppingRow}
          onMenu={(o) => setMenuKey(o ? it.key : null)} onOpen={() => { if (!stoppingRow) props.onOpen(it.sessionId); }}
          onRename={() => props.onRename(it)} onArchive={() => props.onArchive(it, !it.archived)} onTrash={() => props.onTrash(it)} onStop={() => props.onStop(it)} />
      );
    };
    // 검색 중에는 결과가 보이게 접힌 그룹도 펼쳐 보인다(저장된 접기 상태는 그대로). 그룹 없음(F2-2)은 머리 없이 평면 목록
    body = (
      <div class="hist" role="tree" aria-label={t('common.history')} ref={listRef} onKeyDown={onListKey}>
        {detachedGroup}
        {groups.map((g) => {
          if (g.kind === 'none') return <div key={g.key} class="hist-group hist-group--flat" role="group">{g.items.map((it) => row(it, g.key, it.folderName))}</div>;
          const open = searching || !collapsed.has(g.key);
          return (
            <div key={g.key} class="hist-group" role="group">
              {head(g.key, g.name, g.items.length, open, g.path ?? g.name)}
              {open && g.items.map((it) => row(it, g.key, g.kind === 'folder' ? g.name : it.folderName))}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <aside class="sidebar" aria-label={t('sidebar.label')} hidden={props.hidden}>
      <div class="sidebar__top">
        <div class="sidebar__row">
          <div class="new-wrap" ref={newRef}>
            <button class="new-session" disabled={busy} aria-haspopup="menu" aria-expanded={newOpen} onClick={() => setNewOpen(!newOpen)}>
              {t(busy ? 'common.opening' : 'sidebar.new')}
            </button>
            {newOpen && (
              <div class="new-menu" role="menu">
                {props.leadLabel && <div class="new-menu__lead" title={t('sidebar.leadTip')}>{t('sidebar.leader', { name: props.leadLabel })}</div>}
                {props.recent.length > 0 && <div class="new-menu__label">{t('sidebar.recent')}</div>}
                {props.recent.map((f) => (
                  <button key={f} role="menuitem" title={f} onClick={() => { setNewOpen(false); props.onNew(f); }}>{folderName(f)}</button>
                ))}
                <button role="menuitem" class="new-menu__pick" onClick={() => { setNewOpen(false); props.onNew(); }}>{t('common.pickFolder')}</button>
              </div>
            )}
          </div>
          <button class="icon-btn sidebar__toggle" aria-label={t('sidebar.collapse')} title={t('sidebar.collapseTip')} onClick={props.onCollapse}>
            <span class="ico ico--collapse" aria-hidden="true" />
          </button>
        </div>
        <div class="sidebar__row">
          <div class="search">
            <svg class="search__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
            <input type="search" placeholder={t('sidebar.search')} aria-label={t('sidebar.search')} value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }} />
            {query && <button class="search__clear" title={t('sidebar.clear')} aria-label={t('sidebar.clearSearch')} onClick={() => setQuery('')}>×</button>}
          </div>
          <FilterMenu filter={props.filter} onChange={props.onFilter} />
        </div>
      </div>
      <div class="sidebar__list">{body}</div>
      {props.footer}
    </aside>
  );
}
