// 탭 바: 탭(상태 점·폴더명 (2)·×=분리, 대화 기록이 없는 탭은 ×=바로 종료), 우클릭 메뉴(분리/종료…), [+]·[▾](Claude만 메뉴), 작업 중 탭 경고, 레이아웃 선택기 1~5.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { TabStateDto } from '../../shared/api';
import { t } from '../i18n';
import { folderName, LAYOUTS, layoutTooltip, tabTitles, type LayoutId } from '../layout';
import { tabStatus, workingTabCount } from '../tabs';
import { StatusDot, statusLabel } from './StatusDot';

interface TabBarProps {
  tabs: TabStateDto[];
  active: string | null;
  /** 탭별 대화 제목(툴팁). */
  titleOf: (t: TabStateDto) => string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** ▾ 메뉴 "Claude만(에이전트 없음)": 홈·최근 폴더·폴더 선택(folder 없음). 항목은 나중에 늘어날 수 있다. */
  onNewPlain: (folder?: string) => void;
  recent: string[];
  homeDir: string;
  /** 세션 여는 중이면 ▾ 비활성(사이드바 새 세션 버튼과 같음). */
  busy: boolean;
  onDetach: (id: string) => void;
  onTerminate: (id: string) => void;
  /** 대화 기록이 없는 탭인지(× = 분리 대신 바로 종료 안내). */
  isFresh: (t: TabStateDto) => boolean;
  /** 사이드바가 접혀 있으면 펼치기(왼쪽 끝 버튼). 펼쳐져 있으면 null. */
  onExpand: (() => void) | null;
  /** 활성 탭의 레이아웃(탭이 없으면 null → 선택기 비활성). */
  layout: LayoutId | null;
  onLayout: (id: LayoutId) => void;
}

/** 탭 목록. */
export function TabBar({ tabs, active, titleOf, onSelect, onNew, onNewPlain, recent, homeDir, busy, onDetach, onTerminate, isFresh, onExpand, layout, onLayout }: TabBarProps) {
  const titles = tabTitles(tabs.map((t) => t.folder));
  const norm = (f: string): string => f.replace(/[\\/]+$/, '').toLowerCase();
  const plainRecent = recent.filter((f) => norm(f) !== norm(homeDir));
  const workingTabs = workingTabCount(tabs);
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [more, setMore] = useState(false);
  // ▾ 메뉴가 창 오른쪽을 넘으면 오른쪽 정렬(탭이 많아 [+]가 오른쪽 끝에 있을 때)
  const [moreRight, setMoreRight] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // 종료 처리 중인 탭은 분리·종료를 받지 않는다(main도 거부)
  const menuTab = menu ? tabs.find((x) => x.tabId === menu.id) : undefined;
  const menuTerminating = !!menuTab?.terminating;
  const menuFresh = !!menuTab && isFresh(menuTab);

  // 활성 탭은 항상 보이게 자동 스크롤
  useEffect(() => {
    if (!active) return;
    listRef.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(active)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  useEffect(() => {
    if (!menu) return;
    // 메뉴가 열리면 첫 항목(비활성이면 그다음)에 포커스(QA M2-2)
    listRef.current?.parentElement?.querySelector<HTMLElement>('.ctx-menu button:not(:disabled)')?.focus();
    const close = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  // ▾ 메뉴: 바깥 클릭·Esc로 닫고, 열리면 첫 항목에 포커스(사이드바 새 세션 메뉴와 같은 동작)
  useEffect(() => {
    if (!more) return;
    moreRef.current?.querySelector<HTMLElement>('.new-menu button')?.focus();
    const close = (e: PointerEvent): void => { if (!moreRef.current?.contains(e.target as Node)) setMore(false); };
    // Esc는 포커스를 ▾ 버튼으로 돌려준다(메뉴 항목이 사라지며 포커스가 body로 떨어지지 않게)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setMore(false);
      moreRef.current?.querySelector<HTMLElement>('.tab-new--more')?.focus();
    };
    const onBlur = (): void => setMore(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [more]);

  // 세션을 여는 동안은 메뉴를 닫는다(열린 채로 busy가 되면 항목이 눌러도 아무 일도 없음)
  useEffect(() => { if (busy) setMore(false); }, [busy]);
  useLayoutEffect(() => {
    if (!more) { setMoreRight(false); return; }
    const r = moreRef.current?.querySelector<HTMLElement>('.new-menu')?.getBoundingClientRect();
    if (r && r.right > window.innerWidth - 8) setMoreRight(true);
  }, [more]);

  // 탭 목록 안 ←→ 이동(roving tabindex), Enter·Space 전환, Delete = 분리
  const onListKey = (e: KeyboardEvent): void => {
    const els = [...(listRef.current?.querySelectorAll<HTMLElement>('.tab') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      els[(i + (e.key === 'ArrowRight' ? 1 : els.length - 1)) % els.length]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const id = els[i].dataset.tab;
      if (id) onSelect(id);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = els[i].getBoundingClientRect();
      const id = els[i].dataset.tab;
      if (id) setMenu({ id, x: r.left, y: r.bottom });
    }
  };

  return (
    <nav class="tabbar" aria-label={t('tabbar.label')}>
      {onExpand && (
        <button class="icon-btn tabbar__expand" aria-label={t('sidebar.expand')} title={t('sidebar.expandTip')} onClick={onExpand}>
          <span class="ico ico--expand" aria-hidden="true" />
        </button>
      )}
      <div class="tabbar__tabs" role="tablist" ref={listRef} onKeyDown={onListKey}
        onWheel={(e) => { if (listRef.current && e.deltaY) listRef.current.scrollLeft += e.deltaY; }}>
        {tabs.map((tab, i) => {
          const st = tab.terminating ? 'disconnected' : tabStatus(tab);
          const on = tab.tabId === active;
          const title = titleOf(tab);
          const extra = tab.terminating ? t('tab.ending') : tab.leadGone ? t('tab.leadGone') : tab.error && st === 'disconnected' ? tab.error : '';
          const fresh = isFresh(tab);
          return (
            <div key={tab.tabId} role="tab" aria-selected={on} tabIndex={on ? 0 : -1} data-tab={tab.tabId}
              class={`tab${on ? ' is-active' : ''} tab--${st}`} onClick={() => onSelect(tab.tabId)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ id: tab.tabId, x: e.clientX, y: e.clientY }); }}
              title={[tab.folder, tab.plain ? t('tab.plainHeader') : null, title ?? t('tab.noTitle'), statusLabel(st), extra].filter(Boolean).join('\n')}>
              <StatusDot kind={st} />
              <span class="tab__name">{tab.purpose === 'login' ? t('tab.login') : titles[i]}</span>
              <button class="tab__close" tabIndex={-1} title={t(fresh ? 'tab.closeFreshTip' : 'tab.detachTip')} aria-label={t(fresh ? 'tab.closeFresh' : 'tab.detach')}
                disabled={tab.terminating} onClick={(e) => { e.stopPropagation(); onDetach(tab.tabId); }}>×</button>
            </div>
          );
        })}
      </div>
      <div class="tab-new-wrap" ref={moreRef}>
        <button class="tab-new" title={t('tab.newTip')} aria-label={t('tab.new')} onClick={() => { setMore(false); onNew(); }}>+</button>
        <button class="tab-new tab-new--more" title={t('tab.moreTip')} aria-label={t('tab.moreTip')} aria-haspopup="menu" aria-expanded={more}
          disabled={busy} onClick={() => setMore(!more)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        {more && (
          <div class={`new-menu new-menu--tab${moreRight ? ' new-menu--tab-right' : ''}`} role="menu">
            <div class="new-menu__label">{t('tab.plainHeader')}</div>
            {/* init 전에는 홈 경로를 모르므로 항목을 숨긴다 */}
            {homeDir && <button role="menuitem" title={homeDir} onClick={() => { setMore(false); onNewPlain(homeDir); }}>{t('tab.plainHome', { path: homeDir })}</button>}
            {/* 홈은 위에 고정 항목이 있으므로 최근 목록에서는 뺀다 */}
            {plainRecent.length > 0 && <div class="new-menu__label">{t('sidebar.recent')}</div>}
            {plainRecent.map((f) => (
              <button key={f} role="menuitem" title={f} onClick={() => { setMore(false); onNewPlain(f); }}>{folderName(f)}</button>
            ))}
            <button role="menuitem" class="new-menu__pick" onClick={() => { setMore(false); onNewPlain(); }}>{t('common.pickFolder')}</button>
          </div>
        )}
      </div>
      <span class="tabbar__spacer" />
      {workingTabs >= 2 && <span class="warn-badge" title={t('tab.workingTip')}>{t('tab.working', { n: workingTabs })}</span>}
      {/* 레이아웃 선택기 1~5 */}
      <div class="layout-sel" role="group" aria-label={t('tab.layout')}>
        {LAYOUTS.map((l) => (
          <button key={l.id} class="layout-sel__btn" title={layoutTooltip(l.id)} aria-label={layoutTooltip(l.id)}
            aria-pressed={layout === l.id} disabled={layout === null} onClick={() => onLayout(l.id)}>{l.id}</button>
        ))}
      </div>
      {menu && (
        <div class="ctx-menu" role="menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }} onPointerDown={(e) => e.stopPropagation()}>
          <button role="menuitem" autoFocus disabled={menuTerminating} onClick={() => { setMenu(null); onDetach(menu.id); }}>{t(menuFresh ? 'tab.closeFresh' : 'tab.detach')}</button>
          {/* 확인 창이 닫힌 뒤 포커스가 돌아올 곳: 사라지는 메뉴 항목 대신 그 탭(QA M4-4) */}
          <button role="menuitem" class="is-danger" disabled={menuTerminating} onClick={() => {
            setMenu(null);
            listRef.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(menu.id)}"]`)?.focus();
            onTerminate(menu.id);
          }}>{t('tab.end')}</button>
        </div>
      )}
    </nav>
  );
}
