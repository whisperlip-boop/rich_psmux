// 칸별 xterm.js 인스턴스 관리. 카드(Preact) 재렌더와 무관하게 유지하고, main에서 오는 출력은 여기서 바로 기록한다.

import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal, type ITheme } from '@xterm/xterm';

import type { CtdApi } from '../shared/api';
import { HoldBuffer } from './holdBuffer';
import { layoutFromCode } from './layout';

declare global {
  interface Window {
    ctd: CtdApi;
  }
}

/** 칸 터미널 하나. */
export interface PaneTerm {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  lastSent: { cols: number; rows: number } | null;
}

// term.* 토큰: 터미널 영역만 검정(#0C0C0C). ANSI 16색은 지정하지 않아 xterm 기본값 그대로(출력 색 보정 금지)
const TERM_THEME: ITheme = {
  background: '#0C0C0C', foreground: '#CCCCCC', cursor: '#FFFFFF', cursorAccent: '#0C0C0C',
  selectionBackground: 'rgba(255, 255, 255, 0.25)',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.3)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.5)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.5)',
};

/**
 * 터미널 포커스 중에도 앱이 처리할 키. 여기 해당하면 xterm이 칸으로 보내지 않는다.
 * Tab·Shift+Tab·Esc·Ctrl+T·Ctrl+W는 Claude Code로 보낸다. Ctrl+Shift+1~5는 레이아웃 선택(항상 앱).
 */
export function isAppShortcut(e: KeyboardEvent): boolean {
  const k = e.key.toLowerCase();
  if (e.key === 'F6' && !e.ctrlKey && !e.altKey) return true;
  if (e.ctrlKey && !e.altKey && k === 'tab') return true;
  // Ctrl+Shift+B 사이드바 접기·펼치기(Ctrl+B는 Claude Code 백그라운드 실행·tmux 접두사와 겹쳐 쓰지 않음)
  if (e.ctrlKey && e.shiftKey && !e.altKey && (k === 't' || k === 'w' || k === 'b')) return true;
  if (e.ctrlKey && e.shiftKey && !e.altKey && layoutFromCode(e.code) !== null) return true; // 레이아웃 1~5
  return false;
}

const terms = new Map<string, PaneTerm>();
const pending = new Map<string, Uint8Array[]>();
const MAX_PENDING_CHUNKS = 2000;
// 비활성 탭 출력은 xterm에 쓰지 않고 보관(렌더링 중지)
const held = new HoldBuffer();
let activeTab: string | null = null;
let font = { size: 13, family: '"D2Coding", "Cascadia Mono", Consolas, "Malgun Gothic", monospace' };

const key = (tabId: string, pane: string): string => `${tabId}\u0000${pane}`;
const inTab = (tabId: string) => (k: string): boolean => k.startsWith(`${tabId}\u0000`);

/**
 * 활성 탭을 바꾼다. 새 활성 탭의 보관 출력을 터미널에 쓰고, 상한을 넘어 버린 칸은 capture-pane 재동기화를 요청한다.
 *
 * Args:
 *   tabId: 활성 탭(없으면 null).
 */
export function setActiveTab(tabId: string | null): void {
  activeTab = tabId;
  if (tabId === null) return;
  for (const [k, h] of held.take(inTab(tabId))) {
    const pt = terms.get(k);
    if (!pt) continue;
    if (h.overflow) window.ctd.requestResync(tabId, k.slice(tabId.length + 1));
    else for (const c of h.chunks) pt.term.write(c);
  }
}

/** 탭의 모든 칸 터미널 폐기(탭을 닫았을 때). */
export function disposeTab(tabId: string): void {
  const m = inTab(tabId);
  for (const [k, pt] of [...terms]) {
    if (!m(k)) continue;
    pt.term.dispose();
    terms.delete(k);
  }
  for (const k of [...pending.keys()]) if (m(k)) pending.delete(k);
  held.drop(m);
}

/** 글꼴 설정: 앱 시작 시와 설정 변경 시(열린 터미널에도 즉시 적용). */
export function setTerminalFont(size: number, family: string): void {
  const changed = font.size !== size || font.family !== family;
  font = { size, family };
  if (!changed) return;
  // 설정 변경: 열린 터미널에도 즉시 적용. 글자 크기가 바뀌면 열·행 수가 달라지므로 카드가 다시 맞추게 알린다
  for (const pt of terms.values()) {
    pt.term.options.fontSize = size;
    pt.term.options.fontFamily = family;
  }
  window.dispatchEvent(new Event(FONT_EVENT));
}

/** 터미널 글꼴이 바뀌었음을 카드에 알리는 window 이벤트(카드는 fit → resize-window). */
export const FONT_EVENT = 'ctd:font';

/**
 * 칸용 터미널을 만들거나(이미 있으면 재사용) host 요소에 붙인다.
 *
 * Args:
 *   tabId: 탭 ID.
 *   pane: 칸 ID.
 *   container: 터미널을 넣을 요소.
 *   cols: 새로 만들 때의 열 수(psmux 칸의 현재 크기).
 *   rows: 새로 만들 때의 행 수.
 */
export function attachTerminal(tabId: string, pane: string, container: HTMLElement, cols = 80, rows = 24): PaneTerm {
  const k = key(tabId, pane);
  let pt = terms.get(k);
  if (!pt) {
    const host = document.createElement('div');
    host.className = 'xterm-host';
    const term = new Terminal({
      // 처음부터 psmux 칸의 실제 크기로 만든다(80x24 기본값에 44줄 캡처가 먼저 쓰이면 화면이 어긋남)
      cols: Math.max(20, Math.min(500, Math.floor(cols) || 80)), rows: Math.max(5, Math.min(200, Math.floor(rows) || 24)),
      allowProposedApi: true, // unicode11 활성화에 필요
      fontSize: font.size, fontFamily: font.family, lineHeight: 1.2, scrollback: 5000,
      theme: TERM_THEME, cursorBlink: false, macOptionIsMeta: false,
      windowsPty: { backend: 'conpty' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    swallowQueries(term);
    term.open(host);
    term.onData((data) => {
      // 포커스 보고(\x1b[I, \x1b[O)는 표시용 xterm이 만든 것이라 칸으로 보내지 않음
      if (data === '\x1b[I' || data === '\x1b[O') return;
      window.ctd.sendKeys(tabId, pane, data);
    });
    term.attachCustomKeyEventHandler((e) => {
      if (isAppShortcut(e)) return false; // 창 단축키 처리기로 넘김
      // 선택 영역이 있을 때 Ctrl+C = 복사(터미널로 보내지 않음). 선택이 없으면 그대로 C-c 전송
      if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      return true;
    });
    pt = { term, fit, host, lastSent: null };
    terms.set(k, pt);
    const buf = pending.get(k);
    if (buf) {
      for (const d of buf) term.write(d);
      pending.delete(k);
    }
  }
  if (pt.host.parentElement !== container) container.appendChild(pt.host);
  return pt;
}

/**
 * 표시용 xterm이 질의(DA·DSR·DECRQM·XTVERSION·색 질의)에 응답하지 않게 막는다.
 * 실제 터미널은 psmux라 psmux가 이미 응답한다. xterm 응답이 onData로 나가면 칸 입력에 섞인다.
 */
function swallowQueries(term: Terminal): void {
  const p = term.parser;
  p.registerCsiHandler({ final: 'c' }, () => true);
  p.registerCsiHandler({ prefix: '>', final: 'c' }, () => true);
  p.registerCsiHandler({ prefix: '=', final: 'c' }, () => true);
  p.registerCsiHandler({ final: 'n' }, () => true);
  p.registerCsiHandler({ prefix: '?', final: 'n' }, () => true);
  p.registerCsiHandler({ intermediates: '$', final: 'p' }, () => true);
  p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, () => true);
  p.registerCsiHandler({ prefix: '>', final: 'q' }, () => true);
  p.registerCsiHandler({ final: 't' }, () => true);
  p.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true);
  for (const id of [4, 10, 11, 12]) p.registerOscHandler(id, (data) => data.includes('?'));
}

/** 칸 터미널 폐기(칸이 사라졌을 때). */
export function disposeTerminal(tabId: string, pane: string): void {
  const k = key(tabId, pane);
  terms.get(k)?.term.dispose();
  terms.delete(k);
  pending.delete(k);
  held.drop((x) => x === k);
}

/** 존재하는 터미널 조회. */
export function getTerminal(tabId: string, pane: string): PaneTerm | undefined {
  return terms.get(key(tabId, pane));
}

/** main 이벤트를 터미널에 연결한다(앱 시작 시 1회). */
export function wireTerminalEvents(): void {
  window.ctd.onOutput((tabId, pane, data) => {
    const k = key(tabId, pane);
    const pt = terms.get(k);
    if (pt) {
      if (tabId === activeTab) pt.term.write(data);
      else held.push(k, data);
      return;
    }
    // 카드가 아직 안 만들어진 칸: 잠시 쌓아 두고 카드 생성 시 기록(상한 초과 시 버림 → 카드 생성 시 capture-pane 재동기화)
    const arr = pending.get(k) ?? [];
    if (arr.length < MAX_PENDING_CHUNKS) arr.push(data);
    pending.set(k, arr);
  });
  window.ctd.onResync((tabId, pane, data) => {
    const k = key(tabId, pane);
    const pt = terms.get(k);
    if (!pt) return;
    if (tabId === activeTab) pt.term.write(data);
    else held.replace(k, data);
  });
  window.ctd.onSize((tabId, pane, cols, rows) => {
    const pt = terms.get(key(tabId, pane));
    // 실제 칸 크기가 요청보다 작을 수 있어 xterm을 실제 크기에 맞춘다
    if (pt && (pt.term.cols !== cols || pt.term.rows !== rows)) pt.term.resize(cols, rows);
  });
}
