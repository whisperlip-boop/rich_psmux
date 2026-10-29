// 열린 psmux 세션 목록(계정 메뉴): 앱 세션은 클릭하면 그 탭으로 전환(분리돼 있으면 새 탭으로 재연결, 사이드바 ◐와 같음).
// 외부 세션은 이름만 보여 준다(연결 기능 없음).

import { useEffect, useState } from 'preact/hooks';

import type { PsmuxSessionDto } from '../../shared/api';
import { useDialogKeys } from '../dialog';
import { t } from '../i18n';
import { safeIpc } from '../ipc';

interface SessionsDialogProps {
  onOpen: (name: string) => void;
  onClose: () => void;
}

/** 세션 목록 대화상자. */
export function SessionsDialog({ onOpen, onClose }: SessionsDialogProps) {
  const [list, setList] = useState<PsmuxSessionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    setError(null);
    void safeIpc(() => window.ctd.listSessions(), { ok: false, sessions: [], error: t('sessions.readFailed') }, undefined, t('action.listSessions')).then((r) => {
      setList(r.sessions);
      if (!r.ok) setError(r.error ?? t('sessions.readFailed'));
    });
  };
  useEffect(load, []);

  useDialogKeys(true, onClose);

  const apps = list?.filter((s) => s.app) ?? [];
  const others = list?.filter((s) => !s.app) ?? [];
  return (
    <div class="modal" onClick={onClose}>
      <div class="modal__box sessions" role="dialog" aria-modal="true" aria-label={t('sessions.title')} onClick={(e) => e.stopPropagation()}>
        <h2>{t('sessions.title')}</h2>
        {error && <div class="field__error" role="alert">{error}</div>}
        {!list && !error && <p class="muted">{t('common.loading')}</p>}
        {list && !list.length && !error && <p class="muted">{t('sessions.empty')}</p>}
        {apps.length > 0 && (
          <>
            <div class="sessions__label">{t('sessions.app')}</div>
            <ul class="sessions__list">
              {apps.map((s) => (
                <li key={s.name}>
                  <button class="sessions__item" onClick={() => onOpen(s.name)} title={t(s.tabId ? 'sessions.switchTip' : 'sessions.reattachTip')}>
                    <span class="sessions__name">{s.name}</span>
                    <span class="sessions__state">{t(s.tabId ? 'sessions.open' : 'sessions.detached')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {others.length > 0 && (
          <>
            <div class="sessions__label">{t('sessions.external')}</div>
            <ul class="sessions__list">
              {others.map((s) => <li key={s.name} class="sessions__item sessions__item--ext"><span class="sessions__name">{s.name}</span></li>)}
            </ul>
          </>
        )}
        <div class="modal__actions">
          <button class="btn-secondary" onClick={load}>{t('common.refresh')}</button>
          <button class="btn-secondary" autoFocus onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}

/** 앱 정보 대화상자. */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<{ version: string; electron: string; chrome: string } | null>(null);
  useDialogKeys(true, onClose);
  useEffect(() => {
    void safeIpc(() => window.ctd.appInfo(), null).then(setInfo);
  }, []);
  return (
    <div class="modal" onClick={onClose}>
      <div class="modal__box" role="dialog" aria-modal="true" aria-label={t('about.title')} onClick={(e) => e.stopPropagation()}>
        <h2>Rich psmux</h2>
        <table>
          <tbody>
            <tr><th>{t('about.version')}</th><td>{info?.version ?? '-'}</td></tr>
            <tr><th>Electron</th><td>{info ? `${info.electron} (Chromium ${info.chrome})` : '-'}</td></tr>
            <tr><th>{t('about.license')}</th><td>MIT</td></tr>
          </tbody>
        </table>
        <p class="about__note">{t('about.note')}</p>
        <button class="btn-secondary" autoFocus onClick={onClose}>{t('common.close')}</button>
      </div>
    </div>
  );
}
