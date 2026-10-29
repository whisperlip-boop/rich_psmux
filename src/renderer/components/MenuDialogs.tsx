// 히스토리 항목 메뉴·로그아웃·세션 종료·세션 끊기 대화상자: 이름 변경, 휴지통 이동 확인, 로그아웃 확인, 종료·끊기 확인. 공통 키 처리는 useDialogKeys.

import { useState } from 'preact/hooks';

import type { HistoryItemDto } from '../../shared/api';
import { useDialogKeys } from '../dialog';
import type { StopTarget } from '../history';
import { t } from '../i18n';

/** 표시 이름 최대 길이(main과 같음). */
const MAX_TITLE = 200;

/** 휴지통 이동 확인 문구(순수 함수, 테스트 대상). */
export function trashMessage(title: string, extra: number): string {
  return extra > 0 ? t('trash.messageExtra', { title, n: extra }) : t('trash.message', { title });
}

/** 로그아웃 확인 문구. */
export function logoutMessage(openTabs: number): string {
  return openTabs > 0 ? t('logout.confirmTabs', { n: openTabs }) : t('logout.confirm');
}

/** 이름 변경. 빈 값으로 저장하면 원래 제목으로 돌아간다. */
export function RenameDialog({ item, original, onSave, onClose }: { item: HistoryItemDto; original: string; onSave: (title: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(item.customTitle ?? '');
  useDialogKeys(true, onClose, 'input');
  const submit = (e: Event): void => {
    e.preventDefault();
    onSave(value);
  };
  return (
    <div class="modal" onClick={onClose}>
      <div class="modal__box rename" role="dialog" aria-modal="true" aria-label={t('rename.title')} onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit}>
          <h2>{t('rename.title')}</h2>
          <div class="field">
            <label for="rename-title">{t('rename.label')}</label>
            <input id="rename-title" type="text" spellcheck={false} maxLength={MAX_TITLE} value={value} placeholder={original}
              onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
            <span class="field__hint">{t('rename.hint')}</span>
          </div>
          <div class="modal__actions">
            <button type="button" class="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" class="btn-primary">{t('common.save')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** 휴지통 이동 확인. */
export function TrashDialog({ title, extra, folders, busy, onConfirm, onClose }: { title: string; extra: number; folders: number; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  useDialogKeys(true, onClose, '.modal__actions .btn-secondary');
  return (
    <div class="modal" onClick={onClose}>
      <div class="modal__box" role="alertdialog" aria-modal="true" aria-label={t('trash.title')} onClick={(e) => e.stopPropagation()}>
        <p class="modal__text">{trashMessage(title, extra)}</p>
        <p class="modal__note">{t(folders > 0 ? 'trash.noteFolders' : 'trash.note')}</p>
        <div class="modal__actions">
          <button class="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button class="btn-danger" disabled={busy} onClick={onConfirm}>{t(busy ? 'trash.moving' : 'trash.confirm')}</button>
        </div>
      </div>
    </div>
  );
}

/** 로그아웃 확인. 열린 탭은 닫지 않는다(사용자 책임). */
export function LogoutDialog({ openTabs, busy, onConfirm, onClose }: { openTabs: number; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  useDialogKeys(true, onClose, '.modal__actions .btn-secondary');
  return (
    <div class="modal" onClick={onClose}>
      <div class="modal__box" role="alertdialog" aria-modal="true" aria-label={t('logout.title')} onClick={(e) => e.stopPropagation()}>
        <p class="modal__text">{logoutMessage(openTabs)}</p>
        <p class="modal__note">{t('logout.note')}</p>
        <div class="modal__actions">
          <button class="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button class="btn-danger" disabled={busy} onClick={onConfirm}>{t(busy ? 'logout.busy' : 'logout.title')}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 히스토리 "세션 끊기…" 확인 문구(순수 함수, 테스트 대상). 앱 세션은 탭 ⋮ "종료…"와 같은 종료 경로라 같은 설명을 쓴다.
 *
 * Args:
 *   target: 끊을 대상.
 *
 * Returns:
 *   확인 창 본문.
 */
export function stopSessionMessage(target: StopTarget): string {
  const tail = t('stop.tail');
  if (target.kind === 'psmux') return t('stop.askPsmux', { name: target.name ?? '', tail });
  if (target.kind === 'process') return t('stop.askProcess', { pid: String(target.pid ?? ''), tail });
  return t('stop.askApp', { tail });
}

/** 세션 종료·끊기 확인(탭 ⋮ "종료…"·히스토리 "세션 끊기…" 공용). 취소가 기본 포커스, Esc=취소, 닫히면 연 요소(탭·대화 행)로 포커스가 돌아간다. */
export function EndSessionDialog({ label, message, sub, confirmText = t('end.confirm'), onConfirm, onClose }: {
  label: string; message: string; sub: string; confirmText?: string; onConfirm: () => void; onClose: () => void;
}) {
  useDialogKeys(true, onClose, '.modal__actions .btn-secondary');
  return (
    <div class="modal" onClick={onClose}>
      <div class="modal__box" role="alertdialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <p class="modal__text">{message}</p>
        <p class="modal__sub">{sub}</p>
        <div class="modal__actions">
          <button class="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button class="btn-danger" onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}
