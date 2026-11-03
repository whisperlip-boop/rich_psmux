// @update 카드: 업데이트 명령(winget·claude update) 출력을 보여 주는 읽기 전용 터미널 카드(ui-spec §9.4).
// 기존 카드 외곽·터미널 영역을 재사용하고 입력창·Send·첨부·⋮ 메뉴 대신 상태 표시줄 + [닫기]를 둔다.

import { useEffect, useRef, useState } from 'preact/hooks';

import type { UpdateRunDto } from '../../shared/api';
import type { MsgKey } from '../../shared/i18n';
import { useDialogKeys } from '../dialog';
import { t } from '../i18n';
import { attachUpdateTerminal, FONT_EVENT } from '../terminals';
import { cardState, cardStatusText } from '../update';

interface UpdateCardProps {
  run: UpdateRunDto | null;
  onClose: () => void;
  /** 바깥(Update 탭 ×)에서 [닫기]를 누른 것과 같게 처리하라는 요청 횟수(바뀔 때마다 1번). */
  closeRequest: number;
}

const RESIZE_DEBOUNCE_MS = 150;
const CANCEL_BTN = '.modal__actions .btn-secondary';

/** 업데이트 터미널 카드. */
export function UpdateCard({ run, onClose, closeRequest }: UpdateCardProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const [askStop, setAskStop] = useState(false);
  const st = cardState(run);
  useDialogKeys(askStop, () => setAskStop(false), CANCEL_BTN);

  // 터미널 부착 + 카드 크기에 맞춤(psmux 칸이 아니라 크기를 main에 알리지 않는다)
  useEffect(() => {
    const el = termRef.current;
    if (!el) return;
    const pt = attachUpdateTerminal(el);
    let timer: number | undefined;
    const fit = (): void => {
      if (el.clientWidth < 50 || el.clientHeight < 50) return; // 숨겨진 탭
      try {
        pt.fit.fit();
      } catch { /* 크기 계산 전 */ }
    };
    const schedule = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(fit, RESIZE_DEBOUNCE_MS);
    };
    fit();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener(FONT_EVENT, schedule);
    return () => {
      ro.disconnect();
      window.removeEventListener(FONT_EVENT, schedule);
      window.clearTimeout(timer);
    };
  }, []);

  const close = (): void => {
    if (st === 'running') setAskStop(true);
    else onClose();
  };
  const firstReq = useRef(closeRequest);
  useEffect(() => {
    if (closeRequest !== firstReq.current) close();
  }, [closeRequest]);
  const text = cardStatusText(run);
  const stateLabel = t(`update.cardState.${st}` as MsgKey);
  return (
    <section class="card card--update" aria-label={`@update, ${stateLabel}`}>
      <div class="card__body">
        <div class="card__term" ref={termRef} role="log" aria-live="off" aria-label="@update" />
      </div>
      <footer class="card__toolbar update-bar">
        <span class="update-bar__text">{text}</span>
        {/* 완료·실패만 알린다(진행 중 단계 전환은 알리지 않음) */}
        <span class="sr-only" role="status">{st === 'running' ? '' : text}</span>
        <button class="btn-secondary" onClick={close}>{t('common.close')}</button>
        {/* 시스템 이름표(팀원 아님 = 점선), 상태 표시줄 윗선 오른쪽 20 안쪽 */}
        <div class="card__tag card__tag--system" aria-hidden="true">
          <span class={`update-dot update-dot--${st}`}>{st === 'done' ? '✓' : st === 'failed' ? '✕' : ''}</span>
          <span class="card__tag-name">@update</span>
        </div>
      </footer>
      {askStop && (
        <div class="modal" onClick={() => setAskStop(false)}>
          <div class="modal__box" role="alertdialog" aria-modal="true" aria-label={t('update.stopTitle')} onClick={(e) => e.stopPropagation()}>
            <p class="modal__text">{t('update.stopTitle')}</p>
            <p class="modal__note">{t('update.stopNote')}</p>
            <div class="modal__actions">
              <button class="btn-secondary" onClick={() => setAskStop(false)}>{t('common.cancel')}</button>
              <button class="btn-danger" onClick={() => { setAskStop(false); window.ctd.stopUpdate(); onClose(); }}>{t('update.stop')}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
