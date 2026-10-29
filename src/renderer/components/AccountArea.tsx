// 사이드바 하단 계정 영역: 이니셜 원 + 이메일/조직(읽기 전용) + ⋯ 메뉴(설정·언어·Agents·열린 psmux 세션·앱 정보·로그아웃).
// 로그아웃 상태면 이메일 자리에 [로그인] 버튼.

import { useEffect, useRef, useState } from 'preact/hooks';

import type { AccountDto } from '../../shared/api';
import { t } from '../i18n';

interface AccountAreaProps {
  account: AccountDto | null;
  onSettings: () => void;
  /** 언어 선택 대화상자. */
  onLanguage: () => void;
  /** Agents 설정 대화상자. */
  onAgents: () => void;
  onSessions: () => void;
  onAbout: () => void;
  /** 로그아웃 확인 대화상자 열기. */
  onLogout: () => void;
  /** 로그인 탭 열기. */
  onLogin: () => void;
  /** 로그인 탭을 여는 중. */
  loginBusy: boolean;
  /** 메뉴를 열 때 계정 정보를 다시 읽는다(로그인 계정이 바뀌었을 수 있음). */
  onRefresh: () => void;
}


/** 이메일 첫 글자(없으면 '?'). */
export function initialOf(email: string | null): string {
  const c = email?.trim().charAt(0) ?? '';
  return c ? c.toUpperCase() : '?';
}

/** 계정 영역. */
export function AccountArea({ account, onSettings, onLanguage, onAgents, onSessions, onAbout, onLogout, onLogin, loginBusy, onRefresh }: AccountAreaProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('.account__menu button:not(:disabled)')?.focus();
    const close = (e: PointerEvent): void => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      // 메뉴 안 위아래 이동(비활성 항목은 건너뜀)
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('.account__menu button:not(:disabled)') ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const email = account?.email ?? null;
  const org = account?.org ?? null;
  // 계정 정보를 받기 전에는 로그인 버튼을 띄우지 않는다(시작 직후 깜빡임 방지)
  const loggedOut = account !== null && !account.loggedIn;
  const cli = account?.cliAvailable ?? false;
  // 메뉴 항목은 닫히면서 사라지므로 ⋯ 버튼에 먼저 포커스를 둔다: 대화상자가 닫힌 뒤 이 버튼으로 돌아온다
  const pick = (fn: () => void) => () => {
    setOpen(false);
    btnRef.current?.focus();
    fn();
  };
  // CLI가 없을 때 사유(툴팁)
  const noCliTip = t('account.noCliTip');
  const logoutTip = !cli ? noCliTip : loggedOut ? t('account.notLoggedIn') : undefined;

  return (
    <div class="account" ref={ref}>
      <span class={`account__avatar${loggedOut ? ' is-out' : ''}`} aria-hidden="true">{loggedOut ? '?' : initialOf(email)}</span>
      {loggedOut ? (
        <div class="account__text">
          <button class="btn-primary account__login" disabled={!cli || loginBusy} title={cli ? t('account.loginTip') : noCliTip} onClick={onLogin}>
            <span class="ico ico--login" aria-hidden="true" />{t(loginBusy ? 'common.opening' : 'account.login')}
          </button>
        </div>
      ) : (
        <div class="account__text" title={[email, org].filter(Boolean).join('\n') || undefined}>
          {email ? <span class="account__email">{email}</span> : <span class="account__email muted">{t('account.noInfo')}</span>}
          {org && <span class="account__org">{org}</span>}
        </div>
      )}
      <button ref={btnRef} class="icon-btn account__more" aria-label={t('account.menu')} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { if (!open) onRefresh(); setOpen(!open); }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" /></svg>
      </button>
      {open && (
        <div class="account__menu" role="menu">
          <button role="menuitem" onClick={pick(onSettings)}><span class="ico ico--settings" aria-hidden="true" />{t('menu.settings')}</button>
          <button role="menuitem" onClick={pick(onLanguage)}><span class="ico ico--language" aria-hidden="true" />{t('menu.language')}</button>
          <button role="menuitem" onClick={pick(onAgents)}><span class="ico ico--agents" aria-hidden="true" />{t('menu.agents')}</button>
          <button role="menuitem" onClick={pick(onSessions)}><span class="ico ico--sessions" aria-hidden="true" />{t('menu.sessions')}</button>
          <button role="menuitem" onClick={pick(onAbout)}><span class="ico ico--about" aria-hidden="true" />{t('menu.about')}</button>
          <button role="menuitem" disabled={!cli || loggedOut} title={logoutTip} onClick={pick(onLogout)}><span class="ico ico--logout" aria-hidden="true" />{t('menu.logout')}</button>
        </div>
      )}
    </div>
  );
}
