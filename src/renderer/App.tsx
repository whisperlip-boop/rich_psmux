// 앱 루트: [사이드바 240] | [탭 바 36 / 카드 그리드]. 탭별 상태(레이아웃·비율·활성 카드·카드 자리)를 따로 기억하고
// 세션 이름 키로 앱 데이터에 저장해 재시작 후에도 복원한다(M2-05·M2-10).

import { useEffect, useRef, useState } from 'preact/hooks';

import type { AccountDto, DetachedSessionDto, HistoryDto, HistoryItemDto, OpenResult, RunningDto, TabStateDto, UsageDto } from '../shared/api';
import { leadAgentName } from '../shared/agents';
import { getLang, stripEndPunct, type Lang, type MsgKey } from '../shared/i18n';
import { clampSidebarWidth, SIDEBAR_DEFAULT_W } from '../shared/sidebar';
import { addDirCommand, DragHoverTracker, INSERT_EVENT, mentionsFor, type InsertDetail } from '../shared/attach';
import { AccountArea } from './components/AccountArea';
import { AgentsDialog } from './components/AgentsDialog';
import { CardGrid } from './components/CardGrid';
import { LanguageDialog } from './components/LanguageDialog';
import { EndSessionDialog, LogoutDialog, RenameDialog, stopSessionMessage, TrashDialog } from './components/MenuDialogs';
import { AboutDialog, SessionsDialog } from './components/SessionsDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { SidebarHandle } from './components/SidebarHandle';
import { TabBar } from './components/TabBar';
import { UsageArea } from './components/UsageArea';
import { useDialogKeys } from './dialog';
import { DEFAULT_FILTER, displayTitle, isFreshTab, originalTitle, parseFilter, stopTarget, tabConversationId, type HistoryFilter, type StopTarget } from './history';
import { applyLang, t, tx } from './i18n';
import { safeIpc } from './ipc';
import { DEFAULT_TAB_UI, layoutFromCode, type LayoutId, type TabUi } from './layout';
import { errorNotice, type ErrorNotice } from './notice';
import { updateSlots, type Slot } from './slots';
import { addDirLeadPane, ctrlWAllowed, insertByCreatedAt, nextActiveAfterClose, normalizeSavedTabUi, tabAcceptsInput, toSavedTabUi } from './tabs';
import { applyTheme } from './theme';
import { disposeTab, disposeTerminal, isAppShortcut, setActiveTab, setTerminalFont, wireTerminalEvents } from './terminals';

const INFO_LABELS: Record<string, MsgKey> = {
  session: 'info.session', folder: 'info.folder', pane: 'info.pane', window: 'info.window', size: 'info.size', command: 'info.command',
  name: 'info.name', agentType: 'info.agentType', mapping: 'info.mapping', team: 'info.team', lead: 'info.lead',
};

/** 제목줄 로고(빌드가 넣는 40×40 data URL, 테스트 등 번들 밖에서는 빈 값). */
const LOGO_URL = typeof __LOGO_DATA_URL__ === 'string' ? __LOGO_DATA_URL__ : '';
const CANCEL_BTN = '.modal__actions .btn-secondary';

/** 세션 끊기 확인 창 상태: 대화와 확인 창을 열 때 정한 대상(문구·끊는 중 표시용). */
interface StopAsk {
  item: HistoryItemDto;
  target: StopTarget;
}

/** 앱 루트 컴포넌트. */
export function App() {
  const [tabs, setTabs] = useState<Record<string, TabStateDto>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [ui, setUi] = useState<Record<string, TabUi>>({});
  const [bannerDone, setBannerDone] = useState<Record<string, boolean>>({});
  const [recent, setRecent] = useState<string[]>([]);
  const [homeDir, setHomeDir] = useState('');
  const [busy, setBusy] = useState(false);
  /** 오류 배너(메시지 + 그래도 이어가기 대상, TC-180). setError는 항상 통째로 교체한다(이어가기 대상은 지워짐). */
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const setError = (message: string | null): void => setNotice(errorNotice(message));
  /** 실행 중으로 보여 거부된 대화(오류 줄의 "그래도 이어가기"로 강제 이어가기). */
  /** "그래도 이어가기" 확인 대화상자 대상 대화. */
  const [confirmForce, setConfirmForce] = useState<string | null>(null);
  /** 파일 드래그 중 놓을 대상 카드(활성 탭 안). */
  const [drop, setDrop] = useState<{ tabId: string; pane: string } | null>(null);
  const [info, setInfo] = useState<Record<string, string | number | null> | null>(null);
  const [confirmEnd, setConfirmEnd] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<AccountDto | null>(null);
  const [usage, setUsage] = useState<UsageDto | null>(null);
  /** 계정 메뉴에서 연 대화상자. */
  const [dialog, setDialog] = useState<'settings' | 'language' | 'agents' | 'sessions' | 'about' | null>(null);
  /** UI 언어. 문구는 shared/i18n의 현재 언어를 읽고, 이 state는 바뀔 때 전체를 다시 그리는 용도(main.tsx가 첫 렌더 전에 적용). */
  const [lang, setLangState] = useState<Lang>(getLang);
  /** 현재 리드 명령(새 세션 메뉴·첫 화면의 "리더" 표시, F8-1). */
  const [leadCommand, setLeadCommand] = useState<string | null>(null);
  /** 히스토리 항목 메뉴(F2-1) 대화상자. */
  const [renaming, setRenaming] = useState<HistoryItemDto | null>(null);
  const [trashing, setTrashing] = useState<{ item: HistoryItemDto; extra: number; folders: number; busy: boolean } | null>(null);
  /** 세션 끊기 확인 대상(F2-1)과 끊는 중인 대상 키(alias로 묶인 두 행이 같은 세션이라 세션 이름·pid 기준). */
  const [stopAsk, setStopAsk] = useState<StopAsk | null>(null);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  /** 탭 없는 앱 세션 끊기 확인 대상(F2-1 보완). */
  const [stopDetachedAsk, setStopDetachedAsk] = useState<DetachedSessionDto | null>(null);
  /** 로그아웃 확인(F7-2). */
  const [logoutOpen, setLogoutOpen] = useState<{ busy: boolean } | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  /** 사이드바 전체 접힘(ui-state.json에 저장). */
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const sidebarHiddenRef = useRef(false);
  /** 사이드바 폭(px, ui-state.json에 저장). */
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_W);
  /** 히스토리 필터(F2-2, ui-state.json에 저장). */
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>(DEFAULT_FILTER);
  const [history, setHistory] = useState<HistoryDto>({ status: 'loading', items: [] });
  const [running, setRunning] = useState<RunningDto[]>([]);
  /** 탭 없는 앱 세션(F2-1 보완): 있을 때만 사이드바 맨 위 그룹. */
  const [detached, setDetached] = useState<DetachedSessionDto[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const panesSeen = useRef<Record<string, Set<string>>>({});
  // 탭별 카드 자리(생성 순서 고정·동명 팀원 자리 재사용). 탭 상태와 같은 렌더에서 함께 반영됨
  const slots = useRef<Record<string, Slot[]>>({});
  /** 앱 데이터에서 읽은 탭 화면 상태(처음 그 탭을 볼 때 적용). */
  const saved = useRef<Record<string, unknown>>({});
  const lastSaved = useRef<Record<string, string>>({});
  const closed = useRef<Set<string>>(new Set());
  const createdAt = useRef<Record<string, number>>({});
  // 키 처리기에서 최신 값을 쓰기 위한 참조
  const live = useRef({ order, active, ui, busy, tabs });
  live.current = { order, active, ui, busy, tabs };

  const applyTab = (s: TabStateDto): void => {
    if (closed.current.has(s.tabId)) return; // 닫은 탭의 늦은 상태
    // 처음 보는 탭: 저장된 레이아웃·비율·카드 자리 복원
    if (!(s.tabId in slots.current)) {
      const sv = normalizeSavedTabUi(saved.current[s.session]);
      slots.current[s.tabId] = sv.slots;
      setUi((x) => (x[s.tabId] ? x : { ...x, [s.tabId]: sv.ui }));
      if (sv.bannerDone) setBannerDone((b) => ({ ...b, [s.tabId]: true }));
    }
    // 사라진 칸의 터미널 폐기
    const prev = panesSeen.current[s.tabId] ?? new Set<string>();
    const now = new Set(s.panes.map((p) => p.paneId));
    for (const p of prev) if (!now.has(p)) disposeTerminal(s.tabId, p);
    panesSeen.current[s.tabId] = now;
    slots.current[s.tabId] = updateSlots(slots.current[s.tabId] ?? [], s.panes.map((p) => ({ paneId: p.paneId, name: p.label.source === 'fallback' ? null : p.label.name })));
    // 첫 팀원 카드가 생기면 이어가기 안내 배너를 숨긴다
    // 리드 칸 확정 전 상태(leadPaneId null)에서는 판단하지 않는다(리드 칸을 팀원으로 오인)
    if (s.resumeSessionId && s.leadPaneId && s.panes.some((p) => p.paneId !== s.leadPaneId)) setBannerDone((b) => (b[s.tabId] ? b : { ...b, [s.tabId]: true }));
    // 로그인 탭: 다시 실행 중(실패 해제)이면 닫았던 실패 배너를 되살려, 또 실패하면 다시 보이게 한다(리뷰 m-3)
    if (s.purpose === 'login' && !s.loginFailed) {
      setBannerDone((b) => {
        if (!b[s.tabId]) return b;
        const next = { ...b };
        delete next[s.tabId];
        return next;
      });
    }
    setTabs((t) => ({ ...t, [s.tabId]: s }));
    createdAt.current[s.tabId] = s.createdAt;
    setOrder((o) => insertByCreatedAt(o, s.tabId, s.createdAt, (x) => createdAt.current[x]));
    setActive((a) => a ?? s.tabId);
  };

  const removeTab = (tabId: string): void => {
    closed.current.add(tabId);
    disposeTab(tabId);
    delete panesSeen.current[tabId];
    delete slots.current[tabId];
    delete lastSaved.current[tabId];
    const { order: o, active: a } = live.current;
    setActive(nextActiveAfterClose(o, tabId, a));
    setOrder((x) => x.filter((id) => id !== tabId));
    setTabs((t) => {
      const n = { ...t };
      delete n[tabId];
      return n;
    });
  };

  const runOpen = async (fn: () => Promise<OpenResult>, sessionId: string | null = null): Promise<boolean> => {
    if (live.current.busy) return false;
    setNotice(null);
    setBusy(true);
    const r = await safeIpc(fn, { ok: false, error: t('app.openFailed') } as OpenResult, undefined, t('action.openSession'));
    setBusy(false);
    if (!r.ok) {
      // 이어가기 대상은 실행 중으로 보여 거부된 이어가기에서만 붙는다
      setNotice(errorNotice(r.error ?? t('app.openFailed'), r.canForce && sessionId ? sessionId : null));
      return false;
    }
    if (r.warning) setError(r.warning);
    if (r.tab) {
      closed.current.delete(r.tab.tabId);
      applyTab(r.tab);
      setActive(r.tab.tabId);
    } else if (r.tabId) {
      setActive(r.tabId);
    }
    return true;
  };

  /** 새 세션. folder가 없으면 폴더 대화상자, plain이면 에이전트 없이 `claude`만(탭 바 ▾ 메뉴). */
  const startSession = async (folder?: string, plain = false): Promise<void> => {
    if (live.current.busy) return;
    setError(null);
    const f = folder ?? (await safeIpc(() => window.ctd.pickFolder(), null, setError, t('action.pickFolder')));
    if (!f) return;
    if (await runOpen(() => window.ctd.newSession(f, plain))) {
      setRecent((rs) => [f, ...rs.filter((x) => x.toLowerCase() !== f.toLowerCase())].slice(0, 10));
    }
  };

  const openConversation = (sessionId: string, force = false): void => {
    void runOpen(() => window.ctd.openHistory(sessionId, force), sessionId);
  };

  /** 탭 안에서 첨부를 받을 카드: 지정 칸 → 활성 카드 → 리드 → 첫 카드. 입력을 받을 수 없는 탭이면 null. */
  const targetPane = (tabId: string, hovered: string | null): string | null => {
    const t = live.current.tabs[tabId];
    if (!tabAcceptsInput(t)) return null;
    const has = (p: string | null | undefined): p is string => !!p && t.panes.some((x) => x.paneId === p);
    const cand = [hovered, live.current.ui[tabId]?.activePane, t.leadPaneId, t.panes[0]?.paneId];
    return cand.find(has) ?? null;
  };

  const insertInto = (detail: InsertDetail): void => {
    window.dispatchEvent(new CustomEvent<InsertDetail>(INSERT_EVENT, { detail }));
  };

  /** 폴더 추가(F6): 리드 카드 입력창에 /add-dir <경로>(따옴표 없음, 입력창이 비어 있을 때만). */
  const addDir = async (tabId: string): Promise<void> => {
    const lead = addDirLeadPane(live.current.tabs[tabId]);
    if (!lead) return;
    const dir = await safeIpc(() => window.ctd.pickAddDir(), null, setError, t('action.pickFolder'));
    if (!dir) return;
    // 선택 창이 열려 있는 동안 리드 칸이 끝났거나 탭이 끊기거나 닫혔을 수 있다
    if (addDirLeadPane(live.current.tabs[tabId]) !== lead) {
      setError(t('app.addDirBusy'));
      return;
    }
    const q = addDirCommand(dir);
    if (!q.ok) {
      setError(q.reason);
      return;
    }
    insertInto({ tabId, pane: lead, text: q.text, command: true });
  };

  /** 사용량 ↻(F7-1). IPC 자체가 실패하면 영역 안 한 줄로 알린다. */
  /** 이름 변경 저장(빈 값 = 원래 제목). */
  const saveRename = (item: HistoryItemDto, title: string): void => {
    setRenaming(null);
    void safeIpc(() => window.ctd.renameHistory(item.key, title), false, setError, t('action.rename'));
  };
  const setArchived = (item: HistoryItemDto, archived: boolean): void => {
    void safeIpc(() => window.ctd.archiveHistory(item.key, archived), false, setError, t(archived ? 'action.archive' : 'action.unarchive'));
  };
  /** 삭제: main에서 함께 옮길 파일 수·삭제 가능 여부를 먼저 확인하고 확인 창을 연다. */
  const askTrash = async (item: HistoryItemDto): Promise<void> => {
    const p = await safeIpc(() => window.ctd.trashPreview(item.sessionId), null, setError, t('action.trashPreview'));
    if (!p) return;
    if (!p.ok) {
      setError(p.error ?? t('app.cantDelete'));
      return;
    }
    setTrashing({ item, extra: p.extra, folders: p.folders, busy: false });
  };
  const doTrash = async (): Promise<void> => {
    const cur = trashing;
    if (!cur || cur.busy) return;
    setTrashing({ ...cur, busy: true });
    const r = await safeIpc(() => window.ctd.trashHistory(cur.item.sessionId), null, setError, t('action.trash'));
    setTrashing(null);
    if (r && !r.ok) setError(r.error ?? t('app.trashFailed'));
    // 지운 행(대화상자를 연 요소)이 사라지면 포커스가 body로 가므로 목록의 첫 항목으로 옮긴다
    window.setTimeout(() => {
      if (document.activeElement === document.body) document.querySelector<HTMLElement>('.hist [data-nav]')?.focus();
    }, 0);
  };
  /** 세션 끊기 확인 열기: 지금 실행 목록으로 대상(문구용)을 정한다. 그새 대상이 없어졌으면 열지 않고 오류 줄로 알린다. */
  const askStop = (item: HistoryItemDto): void => {
    const target = stopTarget(item.sessionId, tabList, running);
    // main의 'not-running' 안내와 같은 문구(그새 끝났거나 탭으로 열림)
    if (target) setStopAsk({ item, target });
    else setError(t('stop.notRunning'));
  };
  /** 세션 끊기: 실패는 오류 줄 한 줄. 끊는 중에는 같은 대상을 다시 요청하지 않는다(main도 같은 작업으로 묶음). */
  const doStop = async ({ item, target }: StopAsk): Promise<void> => {
    setStopAsk(null);
    if (stopping.has(target.key)) return;
    setStopping((s) => new Set(s).add(target.key));
    // 확인 창을 띄운 사이 상태가 바뀌었어도 main에 보내 거부 사유를 안내받는다(대상은 main이 다시 찾음)
    const r = await safeIpc(() => window.ctd.terminateHistory(item.sessionId), null, setError, t('action.stopSession'));
    setStopping((s) => {
      const n = new Set(s);
      n.delete(target.key);
      return n;
    });
    if (r && !r.ok) setError(r.error ?? t('stop.error'));
  };
  /** 탭 없는 앱 세션 다시 연결(새 탭). */
  const attachDetached = (d: DetachedSessionDto): void => {
    void runOpen(() => window.ctd.attachDetached(d.session));
  };
  /** 탭 없는 앱 세션 끊기(doStop과 같은 패턴, 끊는 중 키 = 세션 이름). */
  const doStopDetached = async (d: DetachedSessionDto): Promise<void> => {
    setStopDetachedAsk(null);
    if (stopping.has(d.session)) return;
    setStopping((s) => new Set(s).add(d.session));
    const r = await safeIpc(() => window.ctd.stopDetached(d.session), null, setError, t('action.stopSession'));
    setStopping((s) => {
      const n = new Set(s);
      n.delete(d.session);
      return n;
    });
    if (r && !r.ok) setError(r.error ?? t('stop.error'));
  };
  const doLogout = async (): Promise<void> => {
    if (!logoutOpen || logoutOpen.busy) return;
    setLogoutOpen({ busy: true });
    const r = await safeIpc(() => window.ctd.logout(), null, setError, t('action.logout'));
    setLogoutOpen(null);
    if (!r) return;
    setAccount(r.account);
    if (!r.ok) setError(r.error ?? t('app.logoutFailed'));
    else if (r.notice) setError(r.notice);
  };
  const doLogin = async (): Promise<void> => {
    if (loginBusy) return;
    setLoginBusy(true);
    await runOpen(() => window.ctd.login());
    setLoginBusy(false);
  };
  /**
   * 언어 선택(대화상자 항목): main에 저장(검증·main 문구 언어 전환·탭 상태 다시 보내기)한 뒤 화면 전체에 바로 적용한다.
   * 지금 언어를 다시 고르면 저장하지 않는다(설정 파일에 사용자가 고른 값만 남기는 규칙 유지).
   */
  const pickLanguage = async (next: Lang): Promise<void> => {
    setDialog(null);
    if (next === lang) return;
    const r = await safeIpc(() => window.ctd.setLanguage(next), null, setError, t('action.changeLanguage'));
    if (!r) return;
    if (!r.ok) {
      if (r.error) setError(r.error);
      return;
    }
    applyLang(r.language);
    setLangState(r.language);
  };

  /**
   * 사이드바 접기·펼치기. 카드 크기는 각 카드의 ResizeObserver가 fit → resize-window로 다시 맞춘다.
   * 누른 버튼이 사라지므로 반대쪽 버튼(펼치기 ↔ 접기)으로 포커스를 옮긴다.
   */
  const toggleSidebar = (): void => {
    // 부수 효과(저장·포커스)는 상태 업데이터 밖에서(리뷰 Nit). 키 처리기는 오래된 클로저라 ref로 현재 값을 읽는다
    const next = !sidebarHiddenRef.current;
    sidebarHiddenRef.current = next;
    setSidebarHidden(next);
    window.ctd.saveSidebarCollapsed(next);
    window.setTimeout(() => document.querySelector<HTMLElement>(next ? '.tabbar__expand' : '.sidebar__toggle')?.focus(), 0);
  };

  const refreshUsage = async (): Promise<void> => {
    const u = await safeIpc(() => window.ctd.refreshUsage(), null);
    setUsage((prev) => u ?? (prev ? { ...prev, error: t('usage.fetchFailed') } : prev));
  };

  const detach = (tabId: string): void => {
    if (live.current.tabs[tabId]?.terminating) return; // 종료 처리 중(Ctrl+W 포함)
    void safeIpc(() => window.ctd.detachTab(tabId), false, setError, t('action.detachTab'));
  };

  useEffect(() => {
    const offs: (() => void)[] = [];
    void safeIpc(() => window.ctd.init(), null, (m) => setError(t('app.restart', { msg: stripEndPunct(m) })), t('action.startApp')).then((init) => {
      if (!init) return;
      setTerminalFont(init.fontSize, init.fontFamily);
      applyTheme(init.theme);
      setAccount(init.account);
      setUsage(init.usage);
      offs.push(window.ctd.onUsage(setUsage));
      offs.push(window.ctd.onAccount(setAccount));
      wireTerminalEvents();
      setRecent(init.recentFolders);
      setHomeDir(init.homeDir);
      saved.current = init.uiState.tabs;
      setCollapsed(new Set(init.uiState.collapsed));
      setSidebarHidden(init.uiState.sidebarCollapsed === true);
      sidebarHiddenRef.current = init.uiState.sidebarCollapsed === true;
      setSidebarWidth(clampSidebarWidth(init.uiState.sidebarWidth));
      setHistoryFilter(parseFilter(init.uiState.historyFilter));
      void safeIpc(() => window.ctd.getLeadCommand(), null).then(setLeadCommand);
      setHistory(init.history);
      setRunning(init.running);
      setDetached(init.detached);
      init.tabs.forEach(applyTab);
      offs.push(window.ctd.onTabState(applyTab));
      offs.push(window.ctd.onTabClosed(removeTab));
      offs.push(window.ctd.onHistory(setHistory));
      offs.push(window.ctd.onRunning(setRunning));
      offs.push(window.ctd.onDetached(setDetached));
      // 설정 저장 즉시 적용(F8): 글꼴·크기·테마
      offs.push(window.ctd.onAppearance((a) => {
        setTerminalFont(a.fontSize, a.fontFamily);
        applyTheme(a.theme);
      }));
      setReady(true);
    });
    return () => offs.forEach((f) => f());
  }, []);

  // 창 전체 드래그앤드롭(F6): 파일·폴더를 놓으면 대상 카드 입력창 커서 위치에 @"경로"(공백 구분). 놓은 곳이 카드면 그 카드, 아니면 활성 카드
  useEffect(() => {
    const isFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const hoveredPane = (e: DragEvent, tabId: string): string | null => {
      const card = (e.target as Element | null)?.closest?.('.card') as HTMLElement | null;
      return card && card.closest(`.tab-page[data-tab="${CSS.escape(tabId)}"]`) ? card.dataset.pane ?? null : null;
    };
    // 취소(Esc·창 밖) 때 dragleave 짝이 안 맞아 점선이 남는 문제(M3-1): 창 밖 이탈 즉시 + dragover 1초 없으면 해제(안전망. 경계에서 dragover가 200ms 넘게 빠질 수 있음, O-3)
    const hover = new DragHoverTracker(() => setDrop(null));
    const onEnter = (e: DragEvent): void => {
      if (isFiles(e)) hover.enter();
    };
    const onOver = (e: DragEvent): void => {
      if (!isFiles(e)) return;
      e.preventDefault(); // 기본 동작(파일 열기·이동) 막기
      hover.over();
      const a = live.current.active;
      const pane = a ? targetPane(a, hoveredPane(e, a)) : null;
      if (e.dataTransfer) e.dataTransfer.dropEffect = pane ? 'copy' : 'none';
      setDrop((d) => (pane && a ? (d && d.tabId === a && d.pane === pane ? d : { tabId: a, pane }) : null));
    };
    const onLeave = (e: DragEvent): void => {
      if (!isFiles(e)) return;
      hover.leave(e.relatedTarget === null);
    };
    const onEnd = (): void => hover.reset();
    const onDrop = (e: DragEvent): void => {
      if (!isFiles(e)) return;
      e.preventDefault();
      hover.reset();
      const a = live.current.active;
      const pane = a ? targetPane(a, hoveredPane(e, a)) : null;
      if (!a || !pane) {
        setError(t(a ? 'app.tabNoInput' : 'app.openSessionFirst'));
        return;
      }
      const files = [...(e.dataTransfer?.files ?? [])];
      const paths = files.map((f) => window.ctd.pathForFile(f));
      const missing = paths.filter((p) => !p).length;
      const m = mentionsFor(paths.filter(Boolean));
      const problems = [...m.rejected, ...(missing ? [t('app.dropPathUnread', { n: missing })] : [])];
      if (problems.length) setError(problems.join('\n'));
      if (!m.text) return;
      setUi((x) => ({ ...x, [a]: { ...(x[a] ?? DEFAULT_TAB_UI), activePane: pane } }));
      insertInto({ tabId: a, pane, text: m.text });
    };
    window.addEventListener('dragenter', onEnter, true);
    window.addEventListener('dragover', onOver, true);
    window.addEventListener('dragleave', onLeave, true);
    window.addEventListener('drop', onDrop, true);
    window.addEventListener('dragend', onEnd, true);
    return () => {
      hover.dispose();
      window.removeEventListener('dragenter', onEnter, true);
      window.removeEventListener('dragover', onOver, true);
      window.removeEventListener('dragleave', onLeave, true);
      window.removeEventListener('drop', onDrop, true);
      window.removeEventListener('dragend', onEnd, true);
    };
  }, []);

  // "그래도 이어가기" 확인 창·종료 확인 창(QA M2-2): 취소 포커스, Esc 닫기, 닫히면 연 버튼으로 포커스 복귀(O-7)
  useDialogKeys(!!confirmForce, () => setConfirmForce(null), CANCEL_BTN);
  useDialogKeys(!!confirmEnd, () => setConfirmEnd(null), CANCEL_BTN);
  // 칸 정보 창도 같은 처리(동적 autoFocus는 Chromium이 무시, QA M4-4 동일 패턴)
  useDialogKeys(!!info, () => setInfo(null));

  // 활성 탭만 터미널에 그린다(비활성 탭은 버퍼만, D14)
  useEffect(() => setActiveTab(active), [active]);

  // 탭 화면 상태 저장(세션 이름 키). 바뀐 탭만 보낸다
  useEffect(() => {
    for (const id of order) {
      const t = tabs[id];
      const u = ui[id];
      if (!t || !u) continue;
      const v = toSavedTabUi(u, slots.current[id] ?? [], !!bannerDone[id]);
      const j = JSON.stringify(v);
      if (lastSaved.current[id] === j) continue;
      lastSaved.current[id] = j;
      window.ctd.saveTabUi(t.session, v);
    }
  }, [ui, tabs, order, bannerDone]);

  // 단축키(D3). 캡처 단계에서 먼저 받아 터미널과 충돌하지 않게 한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const inTerm = !!(document.activeElement as HTMLElement | null)?.closest('.xterm');
      const k = e.key.toLowerCase();
      const { order: o, active: a } = live.current;
      if (e.ctrlKey && !e.altKey && k === 'tab') {
        e.preventDefault();
        if (o.length > 1 && a) {
          const i = o.indexOf(a);
          setActive(o[(i + (e.shiftKey ? o.length - 1 : 1)) % o.length]);
        }
        return;
      }
      // Ctrl+T / Ctrl+W 는 터미널 밖에서만(Claude Code의 Ctrl+T 작업 목록과 충돌 방지), Shift를 더하면 항상
      if (e.ctrlKey && !e.altKey && k === 't' && (e.shiftKey || !inTerm)) {
        e.preventDefault();
        void startSession();
        return;
      }
      // Ctrl+W는 탭 바·사이드바(텍스트 입력 제외)에서만, Ctrl+Shift+W는 항상
      if (e.ctrlKey && !e.altKey && k === 'w' && (e.shiftKey || ctrlWAllowed(document.activeElement))) {
        e.preventDefault();
        if (a) detach(a);
        return;
      }
      // Ctrl+Shift+B: 사이드바 접기·펼치기(터미널 포커스여도 앱이 처리, isAppShortcut)
      if (e.ctrlKey && e.shiftKey && !e.altKey && k === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      const lay = e.ctrlKey && e.shiftKey && !e.altKey ? layoutFromCode(e.code) : null;
      if (lay !== null) {
        e.preventDefault();
        if (a) setLayout(a, lay);
        return;
      }
      if (e.key === 'F6' && isAppShortcut(e)) {
        e.preventDefault();
        cycleZone(e.shiftKey);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const setLayout = (tabId: string, layout: LayoutId): void => {
    setUi((x) => ({ ...x, [tabId]: { ...(x[tabId] ?? DEFAULT_TAB_UI), layout } }));
  };

  const toggleGroup = (key: string): void => {
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      window.ctd.saveCollapsed([...n]);
      return n;
    });
  };

  // F6: 사이드바 → 탭 바 → 활성 카드 입력창 순으로 구역 이동
  const cycleZone = (back: boolean): void => {
    const { active: a, ui: u } = live.current;
    const targets: (() => HTMLElement | null)[] = [
      () => document.querySelector<HTMLElement>('.sidebar button:not(:disabled)'),
      () => document.querySelector<HTMLElement>('.tab.is-active') ?? document.querySelector<HTMLElement>('.tab-new'),
      () => {
        const page = a ? document.querySelector<HTMLElement>(`.tab-page[data-tab="${CSS.escape(a)}"]`) : null;
        const pane = a ? u[a]?.activePane : null;
        const card = (pane && page?.querySelector<HTMLElement>(`.card[data-pane="${CSS.escape(pane)}"]`)) || page?.querySelector<HTMLElement>('.card');
        return card?.querySelector<HTMLElement>('.composer textarea') ?? null; // 카드 안 첫 textarea는 xterm 내부 입력용
      },
    ];
    const cur = document.activeElement as HTMLElement | null;
    const zone = cur?.closest('.sidebar') ? 0 : cur?.closest('.tabbar') ? 1 : cur?.closest('.card') ? 2 : -1;
    const next = zone < 0 ? 0 : (zone + (back ? targets.length - 1 : 1)) % targets.length;
    targets[next]()?.focus();
  };

  const showInfo = async (tabId: string, pane: string): Promise<void> => {
    setInfo(await safeIpc(() => window.ctd.paneInfo(tabId, pane), null, setError, t('action.paneInfo')));
  };

  const tabList = order.map((id) => tabs[id]).filter((t): t is TabStateDto => !!t);
  const cur = active ? tabs[active] : undefined;
  const now = new Date();
  const titleOf = (t: TabStateDto): string | null => {
    const id = tabConversationId(t)?.toLowerCase();
    const it = id ? history.items.find((x) => x.sessionId.toLowerCase() === id) : undefined;
    return it ? displayTitle(it, now) : null;
  };
  const endTab = confirmEnd ? tabs[confirmEnd] : undefined;
  /** 리드 카드 배너: 로그인 탭 실패 안내(F7-2) 또는 이어가기 안내(팀원은 복원되지 않음). */
  const cardBanner = (tab: TabStateDto, dismissed: boolean): string | null => {
    if (tab.purpose === 'login') return tab.loginFailed && !dismissed ? t('banner.loginFailed') : null;
    return tab.resumeSessionId && !dismissed && !tab.panes.some((p) => p.paneId !== tab.leadPaneId) ? t('banner.resume') : null;
  };

  return (
    <div class="shell">
      {/* 앱이 그리는 제목줄(Windows titleBarOverlay): 끌어서 창 이동·더블클릭 최대화. 오른쪽 창 버튼 자리는 비운다. 장식이라 읽지 않음 */}
      <div class="titlebar" aria-hidden="true">
        <div class="titlebar__drag">
          <span class="titlebar__logo" style={{ backgroundImage: `url("${LOGO_URL}")` }} />
          <span class="titlebar__title">Rich psmux</span>
        </div>
      </div>
      <div class="app" style={{ '--sidebar-w': `${sidebarWidth}px` }}>
        <Sidebar history={history} running={running} tabs={tabList} activeConversation={cur ? tabConversationId(cur) : null}
          collapsed={collapsed} onToggle={toggleGroup} onOpen={openConversation} onNew={(f) => void startSession(f)}
          onRetry={() => window.ctd.refreshHistory()} recent={recent} busy={busy}
          onRename={setRenaming} onArchive={setArchived} onTrash={(it) => void askTrash(it)} onStop={askStop} stopping={stopping}
          detached={detached} onAttachDetached={attachDetached} onStopDetached={setStopDetachedAsk}
          hidden={sidebarHidden} onCollapse={toggleSidebar}
          filter={historyFilter} onFilter={(f) => { setHistoryFilter(f); window.ctd.saveHistoryFilter(f); }}
        leadLabel={leadCommand === null ? null : leadAgentName(leadCommand) ?? t('app.leadCustom', { cmd: leadCommand })}
          footer={<>
            <UsageArea usage={usage} loggedIn={account?.loggedIn ?? true} onRefresh={refreshUsage} />
            <AccountArea account={account} onSettings={() => setDialog('settings')} onLanguage={() => setDialog('language')} onAgents={() => setDialog('agents')} onSessions={() => setDialog('sessions')} onAbout={() => setDialog('about')}
              onLogout={() => setLogoutOpen({ busy: false })} onLogin={() => void doLogin()} loginBusy={loginBusy || busy}
              onRefresh={() => void safeIpc(() => window.ctd.getAccount(), null).then((a) => { if (a) setAccount(a); })} />
          </>} />
        {/* 사이드바 폭 조절(접힌 동안은 숨김, 펼치면 저장된 폭) */}
        {!sidebarHidden && <SidebarHandle width={sidebarWidth} onCommit={(w) => { setSidebarWidth(w); window.ctd.saveSidebarWidth(w); }} />}
        <main class="main">
          <TabBar tabs={tabList} active={active} titleOf={titleOf} onSelect={setActive} onNew={() => void startSession()}
            recent={recent} homeDir={homeDir} busy={busy} onNewPlain={(f) => void startSession(f, true)}
            onDetach={detach} onTerminate={setConfirmEnd} isFresh={(tb) => isFreshTab(tb, history.items)} onExpand={sidebarHidden ? toggleSidebar : null}
            layout={cur ? (ui[cur.tabId] ?? DEFAULT_TAB_UI).layout : null} onLayout={(l) => { if (cur) setLayout(cur.tabId, l); }} />
          {notice && (
            <div class="error-banner" role="alert">
              <span>{notice.message}</span>
              <span class="error-banner__actions">
                {notice.forceSid && <button class="btn-secondary" disabled={busy} onClick={() => setConfirmForce(notice.forceSid)}>{t('app.forceResume')}</button>}
                <button aria-label={t('common.close')} onClick={() => setNotice(null)}>×</button>
              </span>
            </div>
          )}
          {tabList.map((t) => (
            <div key={t.tabId} class="tab-page" data-tab={t.tabId} role="tabpanel" style={t.tabId === cur?.tabId ? undefined : { display: 'none' }}>
              <CardGrid tab={t} slots={slots.current[t.tabId]} ui={ui[t.tabId] ?? DEFAULT_TAB_UI} onUi={(u) => setUi((x) => ({ ...x, [t.tabId]: u }))}
                onInfo={(p) => void showInfo(t.tabId, p)}
                banner={cardBanner(t, !!bannerDone[t.tabId])}
                onDismissBanner={() => setBannerDone((b) => ({ ...b, [t.tabId]: true }))}
                dropPane={drop && drop.tabId === t.tabId ? drop.pane : null} onError={setError}
                onAddDir={addDirLeadPane(t) ? () => void addDir(t.tabId) : null} />
            </div>
          ))}
          {ready && !tabList.length && (
            <div class="welcome">
              <h1>Rich psmux</h1>
              <p>{tx('app.welcome', { cmd: <code>{leadCommand ?? 'claude --agent ceo'}</code> })}</p>
              <button class="btn-primary" disabled={busy} onClick={() => void startSession()}>{t(busy ? 'common.opening' : 'common.pickFolder')}</button>
            </div>
          )}
        </main>
        {info && (
          <div class="modal" onClick={() => setInfo(null)}>
            <div class="modal__box" role="dialog" aria-modal="true" aria-label={t('info.title')} onClick={(e) => e.stopPropagation()}>
              <h2>{t('info.title')}</h2>
              <table>
                <tbody>{Object.entries(info).map(([k, v]) => <tr key={k}><th>{k in INFO_LABELS ? t(INFO_LABELS[k]) : k}</th><td>{v ?? '-'}</td></tr>)}</tbody>
              </table>
              <button class="btn-secondary" autoFocus onClick={() => setInfo(null)}>{t('common.close')}</button>
            </div>
          </div>
        )}
        {confirmForce && (
          <div class="modal" onClick={() => setConfirmForce(null)}>
            <div class="modal__box" role="alertdialog" aria-modal="true" aria-label={t('app.forceResume')} onClick={(e) => e.stopPropagation()}>
              <p class="modal__text">{t('app.forceConfirm')}</p>
              <div class="modal__actions">
                <button class="btn-secondary" onClick={() => setConfirmForce(null)}>{t('common.cancel')}</button>
                <button class="btn-danger" onClick={() => { const sid = confirmForce; setConfirmForce(null); openConversation(sid, true); }}>{t('app.resume')}</button>
              </div>
            </div>
          </div>
        )}
        {dialog === 'language' && <LanguageDialog current={lang} onPick={(l) => void pickLanguage(l)} onClose={() => setDialog(null)} />}
        {dialog === 'settings' && <SettingsDialog onClose={() => { setDialog(null); void safeIpc(() => window.ctd.getLeadCommand(), null).then((c) => { if (c !== null) setLeadCommand(c); }); }} />}
      {dialog === 'agents' && <AgentsDialog tabId={cur && cur.purpose !== 'login' ? cur.tabId : null} onClose={() => setDialog(null)} onSaved={setLeadCommand} />}
        {dialog === 'sessions' && (
          <SessionsDialog onClose={() => setDialog(null)} onOpen={(name) => {
            setDialog(null);
            void runOpen(() => window.ctd.openAppSession(name));
          }} />
        )}
        {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
        {renaming && <RenameDialog item={renaming} original={originalTitle(renaming, now)} onSave={(t) => saveRename(renaming, t)} onClose={() => setRenaming(null)} />}
        {trashing && <TrashDialog title={displayTitle(trashing.item, now)} extra={trashing.extra} folders={trashing.folders} busy={trashing.busy} onConfirm={() => void doTrash()} onClose={() => setTrashing(null)} />}
        {logoutOpen && <LogoutDialog openTabs={tabList.filter((t) => t.purpose !== 'login').length} busy={logoutOpen.busy} onConfirm={() => void doLogout()} onClose={() => setLogoutOpen(null)} />}
        {endTab && (
          <EndSessionDialog label={t('app.endTab')} message={t('app.endTabConfirm')} sub={endTab.folder}
            onClose={() => setConfirmEnd(null)}
            onConfirm={() => { const id = endTab.tabId; setConfirmEnd(null); void safeIpc(() => window.ctd.terminateTab(id), false, setError, t('action.endTeam')); }} />
        )}
        {stopAsk && (
          <EndSessionDialog label={t('app.stopSession')} message={stopSessionMessage(stopAsk.target)} sub={displayTitle(stopAsk.item, now)} confirmText={t('app.stop')}
            onClose={() => setStopAsk(null)} onConfirm={() => void doStop(stopAsk)} />
        )}
        {stopDetachedAsk && (
          <EndSessionDialog label={t('app.stopSession')} message={t('stop.askDetached', { name: stopDetachedAsk.session })} sub={stopDetachedAsk.folder} confirmText={t('app.stop')}
            onClose={() => setStopDetachedAsk(null)} onConfirm={() => void doStopDetached(stopDetachedAsk)} />
        )}
      </div>
    </div>
  );
}
