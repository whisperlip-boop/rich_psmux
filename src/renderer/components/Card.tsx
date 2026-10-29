// 카드 = 칸 1개: [헤더 40: @라벨·상태·⋮][본문 xterm][툴바 52: 첨부·입력창·Send].
// 입력창은 위쪽으로 커져 터미널 영역 크기는 바뀌지 않는다. 레이아웃 버튼·최대화는 v0.4에서 제거(탭 바 선택기로 이동).

import { useEffect, useRef, useState } from 'preact/hooks';

import type { PaneViewDto } from '../../shared/api';
import { INSERT_EVENT, insertAt, mentionsFor, type InsertDetail } from '../../shared/attach';
import { inputHeight } from '../composer';
import { t } from '../i18n';
import { safeIpc } from '../ipc';
import { SPLIT_END_EVENT } from '../layout';
import { attachTerminal, FONT_EVENT, getTerminal } from '../terminals';
import { StatusDot, statusLabel } from './StatusDot';

interface CardProps {
  tabId: string;
  pane: PaneViewDto;
  active: boolean;
  disconnected: boolean;
  /** 입력 막기(종료 처리 중). 끊김 오버레이는 띄우지 않는다. */
  locked: boolean;
  onActivate: () => void;
  onInfo: (pane: string) => void;
  onReconnect: () => void;
  /** 리드 카드 배너 문구(없으면 null): 이어가기 안내(-r 로 시작했고 팀원 카드가 아직 없을 때), 로그인 실패 안내(F7-2). */
  banner: string | null;
  onDismissBanner: () => void;
  /** 파일 드래그 중 이 카드가 놓을 대상(드롭 표시). */
  dropTarget: boolean;
  /** 사용자에게 보일 오류(현재 언어). */
  onError: (msg: string) => void;
  /** ⋮ "폴더 추가…": 리드 카드 입력창에 /add-dir. 리드 카드가 없으면 null(비활성). */
  onAddDir: (() => void) | null;
}

/** 크기 변경이 끝난 뒤 cols·rows 계산까지 기다리는 시간. */
const RESIZE_DEBOUNCE_MS = 150;

/** 팀원 카드. */
export function Card(props: CardProps) {
  const { tabId, pane, active, disconnected } = props;
  const noInput = disconnected || props.locked;
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const paneId = pane.paneId;
  // 이벤트·비동기 경로에서 최신 값을 쓰기 위한 참조
  const textRef = useRef(text);
  textRef.current = text;
  const caretAfter = useRef<number | null>(null);
  const noInputRef = useRef(noInput);
  noInputRef.current = noInput;
  const propsRef = useRef(props);
  propsRef.current = props;

  /** 입력창 커서(선택) 위치에 글을 넣고 그 뒤로 커서를 옮긴다(F6, 전송은 사용자가). */
  const insertSnippet = (snippet: string): void => {
    if (!snippet) return;
    const ta = inputRef.current;
    const cur = textRef.current;
    const r = insertAt(cur, ta?.selectionStart ?? cur.length, ta?.selectionEnd ?? cur.length, snippet);
    textRef.current = r.value;
    caretAfter.current = r.caret;
    setText(r.value);
  };
  // 값이 반영된 뒤 커서·포커스 복원(자동 높이는 아래 fitInput 효과가 다시 잼)
  useEffect(() => {
    const ta = inputRef.current;
    const c = caretAfter.current;
    if (!ta || c === null) return;
    caretAfter.current = null;
    ta.focus();
    ta.setSelectionRange(c, c);
  }, [text]);

  // 창 전체 드롭·폴더 추가 등 바깥에서 오는 삽입 요청
  useEffect(() => {
    const onInsert = (e: Event): void => {
      const d = (e as CustomEvent<InsertDetail>).detail;
      if (d.tabId !== tabId || d.pane !== paneId) return;
      if (noInputRef.current) {
        propsRef.current.onError(t('card.noInput'));
        return;
      }
      if (d.command && textRef.current.trim()) {
        propsRef.current.onError(t('card.clearLeadFirst'));
        return;
      }
      insertSnippet(d.text);
    };
    window.addEventListener(INSERT_EVENT, onInsert);
    return () => window.removeEventListener(INSERT_EVENT, onInsert);
  }, [tabId, paneId]);

  const attach = async (kind: 'image' | 'any'): Promise<void> => {
    const paths = await safeIpc(() => window.ctd.pickFiles(kind), [] as string[], props.onError, t('action.pickFiles'));
    if (!paths.length) {
      inputRef.current?.focus();
      return;
    }
    const m = mentionsFor(paths);
    if (m.rejected.length) props.onError(m.rejected.join('\n'));
    if (m.text) insertSnippet(m.text);
    else inputRef.current?.focus();
  };

  // Ctrl+V: 클립보드에 글 없이 이미지만 있으면 PNG로 저장해 경로를 넣는다. 글이 있으면 기본 붙여넣기(엑셀 셀 복사 등은 글+이미지)
  const onPaste = (e: ClipboardEvent): void => {
    const dt = e.clipboardData;
    if (!dt || dt.getData('text/plain')) return;
    // Chromium은 비트맵이 있을 때만 image 파일 항목을 만든다. 항목이 없어도(JFIF만 등) main에 묻고, 이미지가 없으면 조용히 무시(O-4).
    // 글이 없으면 textarea 기본 붙여넣기는 아무것도 넣지 않으므로 기본 동작은 그대로 둬도 된다
    const hasImage = [...dt.items].some((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (hasImage) e.preventDefault();
    void safeIpc(() => window.ctd.saveClipboardImage(), { ok: false, error: t('clip.saveFailed') }).then((r) => {
      if (!r.ok || !r.path) {
        if (hasImage || !r.noImage) props.onError(r.error ?? t('clip.saveFailed'));
        return;
      }
      const m = mentionsFor([r.path]);
      if (m.rejected.length) props.onError(m.rejected.join('\n'));
      insertSnippet(m.text);
    });
  };

  // 터미널 부착 + 카드 크기 → fit 계산 → psmux 칸 크기(resize-window) 동기화
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // 재동기화는 터미널을 새로 만들 때만(기존 터미널은 화면을 이미 갖고 있음). 터미널은 칸의 현재 크기로 만들고,
    // 보이는 카드면 먼저 카드 크기에 맞춘(fit → resize-window) 뒤 캡처를 요청한다. 같은 control mode 큐라
    // resize-window가 capture-pane보다 먼저 실행돼 캡처 줄 수 = 터미널 행 수(QA M2-1). 숨겨진 탭은 칸 크기 그대로 캡처
    const created = !getTerminal(tabId, paneId);
    const pt = attachTerminal(tabId, paneId, el, pane.cols, pane.rows);
    let timer: number | undefined;
    const sync = (): void => {
      // 분할 경계선 드래그 중에는 CSS만 바뀐다. 칸 크기는 드래그가 끝난 뒤(SPLIT_END_EVENT) 한 번에 맞춘다
      if (el.closest('[data-splitting]')) return;
      if (el.clientWidth < 50 || el.clientHeight < 50) return; // 숨겨진 탭의 카드는 마지막 크기 유지(D7)
      const d = pt.fit.proposeDimensions();
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return;
      const cols = Math.max(20, d.cols);
      const rows = Math.max(5, d.rows);
      if (pt.term.cols !== cols || pt.term.rows !== rows) pt.term.resize(cols, rows);
      if (!pt.lastSent || pt.lastSent.cols !== cols || pt.lastSent.rows !== rows) {
        pt.lastSent = { cols, rows };
        window.ctd.resizePane(tabId, paneId, cols, rows);
      }
    };
    const schedule = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(sync, RESIZE_DEBOUNCE_MS);
    };
    // detail = 탭 ID(카드 분할선) 또는 null(사이드바 폭 조절: 모든 탭)
    const onSplitEnd = (e: Event): void => {
      const d = (e as CustomEvent<string | null>).detail;
      if (d === tabId || d === null) schedule();
    };
    if (created) {
      sync();
      window.ctd.requestResync(tabId, paneId);
    }
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener(SPLIT_END_EVENT, onSplitEnd);
    window.addEventListener(FONT_EVENT, schedule);
    return () => {
      ro.disconnect();
      window.removeEventListener(SPLIT_END_EVENT, onSplitEnd);
      window.removeEventListener(FONT_EVENT, schedule);
      window.clearTimeout(timer);
    };
  }, [tabId, paneId]);

  // 입력창 자동 높이(1줄 → 최대 약 6줄 132, 그 이상은 입력창 안에서 스크롤). 여러 줄일 때만 툴바 위로 겹쳐 커진다.
  // 줄바꿈은 폭에 따라 달라지므로 값이 바뀔 때뿐 아니라 입력창 폭이 바뀔 때(카드 크기·레이아웃·탭 전환)도 다시 잰다
  const fitInput = (): void => {
    const ta = inputRef.current;
    if (!ta) return;
    if (ta.value === '') {
      ta.style.height = '';
      return;
    }
    ta.style.height = 'auto';
    const h = inputHeight(ta.value, ta.scrollHeight);
    ta.style.height = h === null ? '' : `${h}px`;
  };
  useEffect(fitInput, [text]);
  useEffect(() => {
    const slot = inputRef.current?.closest('.composer-slot');
    if (!slot) return;
    // 슬롯 높이는 36 고정이라 입력창 높이를 바꿔도 다시 호출되지 않는다
    const ro = new ResizeObserver(fitInput);
    ro.observe(slot);
    return () => ro.disconnect();
  }, []);

  const empty = !text.trim();
  const send = async (): Promise<void> => {
    if (empty || sending || noInput) return; // 빈 입력 무시(빈 Enter가 프롬프트 제안을 전송할 수 있음)
    setSending(true);
    const ok = await safeIpc(() => window.ctd.sendInput(tabId, paneId, text), false, props.onError, t('action.sendMessage'));
    setSending(false);
    if (ok) setText('');
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // 한글 IME 조합 중 Enter는 조합 확정용이므로 전송하지 않음
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void send();
    }
  };

  const label = pane.label;
  const temp = label.source === 'fallback';
  // 팀원 탭은 팀 색으로 채우고 테두리도 같은 색(CSS 변수로 넘겨 입력 포커스 때 테두리만 accent로 바뀔 수 있게)
  const tagStyle = label.isLead ? { color: label.color } : temp ? undefined : { '--tag-bg': label.color, '--tag-fg': label.textColor };
  const status = pane.waiting ? 'approval' : pane.working ? 'working' : null;
  const menuItem = (text: string, onClick: () => void, disabled = false) => (
    // 메뉴 항목은 닫히면서 사라지므로 ⋮ 버튼에 먼저 포커스를 둔다: 칸 정보 창이 닫힌 뒤 이 버튼으로 돌아온다(QA M4-4, 계정 메뉴 m-6과 같은 방식)
    <button role="menuitem" disabled={disabled} onClick={() => { setMenuOpen(false); menuBtnRef.current?.focus(); onClick(); }}>{text}</button>
  );

  // 이름표 태그는 aria-hidden이라 상태(승인 대기·작업 중)는 카드 이름에 붙여 읽힌다(헤더의 상태 점이 하던 역할)
  const cardName = `${temp ? paneId : `@${label.name}`}${status ? `, ${statusLabel(status)}` : ''}`;

  return (
    <section class={`card${active ? ' is-active' : ''}${pane.waiting ? ' card--waiting' : ''}${props.dropTarget ? ' is-drop-target' : ''}`} data-pane={paneId} onPointerDown={props.onActivate} aria-label={cardName}>
      {props.banner && (
        <div class="card__banner" role="note">
          <span class="card__banner-icon" aria-hidden="true">ℹ</span>
          <span class="card__banner-text">{props.banner}</span>
          <button class="icon-btn icon-btn--24" title={t('common.close')} aria-label={t('common.close')} onClick={props.onDismissBanner}>×</button>
        </div>
      )}
      <div class="card__body" onMouseDown={() => getTerminal(tabId, paneId)?.term.focus()}>
        <div class="card__term" ref={bodyRef} />
        {disconnected && (
          <div class="overlay" role="status">
            <span class="overlay__icon" aria-hidden="true">✕</span>
            <span class="overlay__text">{t('card.disconnected')}</span>
            <button class="btn-secondary" onClick={props.onReconnect}>{t('card.reconnect')}</button>
          </div>
        )}
      </div>
      <footer class="card__toolbar">
        <div class="composer-slot">
          <div class="composer">
            <button class="icon-btn icon-btn--32" title={t('card.attachImage')} aria-label={t('card.attachImage')} disabled={noInput} onClick={() => void attach('image')}><Icon d="M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01" /></button>
            <button class="icon-btn icon-btn--32" title={t('card.attachFile')} aria-label={t('card.attachFile')} disabled={noInput} onClick={() => void attach('any')}><Icon d="M20 11.5l-7.8 7.8a5 5 0 01-7-7l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8" /></button>
            <textarea ref={inputRef} rows={1} placeholder="Use Shift+Enter to add new line" value={text} disabled={noInput}
              onFocus={props.onActivate} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} onKeyDown={onKeyDown} onPaste={onPaste} />
            {/* F4-1 이름표: 입력 박스 윗선 위로 솟은 탭(오른쪽 끝에서 20 안쪽, psmux 칸 라벨처럼). 입력 박스가 위로 커지면 함께 올라간다.
                클릭은 아래 터미널로 통과(pointer-events: none), 터미널 hover 중엔 반투명 */}
            <div class={`card__tag${label.isLead ? ' card__tag--lead' : temp ? ' card__tag--temp' : ' card__tag--mate'}`} style={tagStyle} aria-hidden="true">
              {status && <StatusDot kind={status} />}
              <span class="card__tag-name">{temp ? paneId : `@${label.name}`}</span>
            </div>
          </div>
        </div>
        <button class="send-btn" disabled={sending || empty || noInput} onClick={() => void send()}>Send <span class="send-btn__key" aria-hidden="true">↵</span></button>
        <div class="menu">
          <button ref={menuBtnRef} class="icon-btn" title={t('card.menu')} aria-label={t('card.menu')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
            <Icon d="M12 5h.01M12 12h.01M12 19h.01" width={3} />
          </button>
          {menuOpen && (
            <div class="menu__list" role="menu" onMouseLeave={() => setMenuOpen(false)}>
              {menuItem(t('card.stopMate'), () => void safeIpc(() => window.ctd.requestStop(tabId, paneId, label.name), false, props.onError, t('action.requestStop')), label.isLead || temp || disconnected)}
              {menuItem(t('card.clearOutput'), () => getTerminal(tabId, paneId)?.term.clear())}
              {menuItem(t('info.title'), () => props.onInfo(paneId))}
              {menuItem(t('card.addDir'), () => props.onAddDir?.(), !props.onAddDir)}
            </div>
          )}
        </div>
      </footer>
      {props.dropTarget && <div class="drop-hint" aria-hidden="true">{t('card.dropHint')}</div>}
    </section>
  );
}

function Icon({ d, width = 1.8 }: { d: string; width?: number }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={width} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

