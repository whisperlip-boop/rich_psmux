// 앱 정보 대화상자: 버전·라이선스 + 업데이트 확인 표(Rich psmux·PowerShell 7·psmux·Claude Code)와 업데이트 실행(ui-spec §9).
// 확인·실행 상태는 main이 갖고(update:state), 체크 상태는 App이 갖는다(대화상자를 닫았다 열어도 유지).

import { useEffect, useRef, useState } from 'preact/hooks';

import type { AppInfoDto, UpdateItemId, UpdateRowDto, UpdateStateDto, UpdateStepId } from '../../shared/api';
import { formatDate, type MsgKey } from '../../shared/i18n';
import { useDialogKeys } from '../dialog';
import { t } from '../i18n';
import { safeIpc } from '../ipc';
import { resetUpdateTerminal } from '../terminals';
import { effectiveChecked, isRunning, isSelectable, stepsOf, UPDATE_NAMES } from '../update';

interface AboutDialogProps {
  state: UpdateStateDto | null;
  checked: ReadonlySet<UpdateItemId>;
  onToggle: (id: UpdateItemId, on: boolean) => void;
  /** 업데이트가 시작됨(App이 대화상자를 닫고 @update 카드를 연다). needsClose = psmux·PowerShell 7 실행(세션을 닫았으므로 항상 Update 탭). */
  onStarted: (needsClose: boolean) => void;
  onClose: () => void;
}

const STATUS_LABEL: Record<Exclude<UpdateRowDto['status'], 'unknown'>, MsgKey> = {
  checking: 'about.status.checking', latest: 'about.status.latest', available: 'about.status.available',
  notInstalled: 'about.status.notInstalled', failed: 'about.status.failed',
};
/** 상태 모양(색만으로 구분하지 않는다). 확인 중은 스피너. */
const STATUS_ICON: Partial<Record<UpdateRowDto['status'], string>> = { latest: '✓', available: '▲', notInstalled: '○', failed: '✕' };
const CANCEL_BTN = '.modal__actions .btn-secondary';

/** 세션 종료 확인 상태. n = 닫을 세션 수(조회 실패면 null), failed = 닫기 실패(취소만 남김). */
interface CloseAsk {
  n: number | null;
  steps: UpdateStepId[];
  busy: boolean;
  failed: boolean;
}

/** 앱 정보 대화상자. */
export function AboutDialog({ state, checked, onToggle, onStarted, onClose }: AboutDialogProps) {
  const [info, setInfo] = useState<AppInfoDto | null>(null);
  const [starting, setStarting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ask, setAsk] = useState<CloseAsk | null>(null);
  const [announce, setAnnounce] = useState('');
  const askRef = useRef(ask);
  askRef.current = ask;
  const wasChecking = useRef(state?.checking ?? false);
  useDialogKeys(true, onClose);
  // 확인 창: 취소 포커스, 닫는 중에는 Esc로 닫지 않는다. 닫히면 [업데이트]로 포커스 복귀(열기 전 포커스)
  useDialogKeys(!!ask, () => closeAsk(), CANCEL_BTN);
  const runBtnRef = useRef<HTMLButtonElement>(null);
  /** 확인 창 닫기(닫는 중에는 무시). 앱 정보는 그대로 두고 [업데이트]로 포커스를 돌린다(§9.3). */
  function closeAsk(): void {
    if (askRef.current?.busy) return;
    setAsk(null);
    window.setTimeout(() => runBtnRef.current?.focus(), 0);
  }
  useEffect(() => {
    void safeIpc(() => window.ctd.appInfo(), null).then(setInfo);
  }, []);

  const rows = state?.rows ?? [];
  const checking = !!state?.checking;
  const running = isRunning(state);
  const locked = checking || running || starting;
  const selected = effectiveChecked(state, checked);
  const available = rows.filter(isSelectable).length;

  // 확인이 끝날 때 한 줄만 알린다(행마다 알리지 않음)
  useEffect(() => {
    if (wasChecking.current && !checking) setAnnounce(t('about.checkDone', { n: available }));
    wasChecking.current = checking;
  }, [checking]);

  const check = (): void => {
    if (locked) return;
    setMsg(null);
    setAnnounce('');
    void safeIpc(() => window.ctd.checkUpdates(), null, setMsg, t('action.checkUpdates'));
  };

  const start = async (steps: UpdateStepId[]): Promise<void> => {
    resetUpdateTerminal();
    const r = await safeIpc(() => window.ctd.startUpdate(steps), { ok: false, error: 'busy' as const }, setMsg, t('action.runUpdate'));
    if (r.ok) {
      setAsk(null);
      onStarted(steps.some((s) => s === 'psmux' || s === 'pwsh'));
      return;
    }
    if (r.error === 'closeFailed') {
      setAsk((a) => ({ n: a?.n ?? null, steps, busy: false, failed: true }));
      return;
    }
    setAsk(null);
    setMsg(t(r.error === 'busy' ? 'update.busy' : 'about.reason.unexpected'));
  };

  // 업데이트 클릭: Rich psmux는 즉시 릴리스 페이지(D5) → psmux·PowerShell 7이 있으면 세션 확인(N=0이면 생략) → 순차 실행 시작
  const run = async (): Promise<void> => {
    if (locked || !selected.length) return;
    setMsg(null);
    setStarting(true);
    try {
      if (selected.includes('app')) {
        const ok = await safeIpc(() => window.ctd.openReleasePage(), false);
        setMsg(t(ok ? 'update.openedRelease' : 'update.openReleaseFailed'));
      }
      const steps = stepsOf(selected);
      if (!steps.length) return;
      if (steps.includes('psmux') || steps.includes('pwsh')) {
        const c = await safeIpc(() => window.ctd.updateSessionCount(), { ok: false, count: 0 });
        if (!c.ok) {
          setAsk({ n: null, steps, busy: false, failed: true });
          return;
        }
        if (c.count > 0) {
          setAsk({ n: c.count, steps, busy: false, failed: false });
          return;
        }
      }
      await start(steps);
    } finally {
      setStarting(false);
    }
  };

  const proceed = async (): Promise<void> => {
    const a = askRef.current;
    if (!a || a.busy || a.failed) return;
    setAsk({ ...a, busy: true });
    await start(a.steps);
  };

  const statusCell = (r: UpdateRowDto) => {
    const label = r.status === 'unknown' ? null : t(STATUS_LABEL[r.status]);
    const why = r.status === 'failed' && r.reason ? t('about.failReason', { name: UPDATE_NAMES[r.id], reason: t(`about.reason.${r.reason}` as MsgKey) }) : null;
    return (
      // title은 항상 상태 글자(좁은 열에서 말줄임돼도 읽히게), 실패면 다음 줄에 사유
      <td class={`about__status about__status--${r.status}`} title={label === null ? undefined : why ? `${label}
${why}` : label} aria-describedby={why ? `upd-why-${r.id}` : undefined}>
        {r.status === 'unknown' ? '—' : (
          <>
            {r.status === 'checking' ? <span class="about__spin" aria-hidden="true" /> : <span class="about__icon" aria-hidden="true">{STATUS_ICON[r.status]}</span>}
            <span>{label}</span>
          </>
        )}
        {why && <span id={`upd-why-${r.id}`} class="sr-only">{why}</span>}
      </td>
    );
  };

  const showClaudeNote = selected.includes('claude') || (!!state?.claudeUpdated && !checking);
  // 확인 창은 앱 정보 .modal의 형제로 그린다: 안에 두면 실제 마우스 클릭이 확인 창이 사라진 뒤 앱 정보 바깥 클릭(onClose)으로 전달될 수 있다
  return (
    <>
    <div class="modal" onClick={onClose}>
      <div class="modal__box about" role="dialog" aria-modal="true" aria-label={t('about.title')} onClick={(e) => e.stopPropagation()}>
        <h2>Rich psmux</h2>
        <table>
          <tbody>
            <tr><th>{t('about.version')}</th><td>{info?.version ?? '-'}</td></tr>
            <tr><th>Electron</th><td>{info ? `${info.electron} (Chromium ${info.chrome})` : '-'}</td></tr>
            <tr><th>{t('about.license')}</th><td>MIT</td></tr>
          </tbody>
        </table>
        <div class="about__sep" />
        <h3 class="about__sub">{t('about.updates')}</h3>
        <div role="status" class="sr-only">{announce}</div>
        <table class="about__updates">
          <caption class="sr-only">{t('about.updates.caption')}</caption>
          <thead>
            {/* 머리글은 좁은 열에서 말줄임되므로 title로 전체 글자를 보인다(상태 셀과 같은 규칙) */}
            <tr>
              <th scope="col" title={t('about.col.name')}>{t('about.col.name')}</th>
              <th scope="col" title={t('about.col.installed')}>{t('about.col.installed')}</th>
              <th scope="col" title={t('about.col.latest')}>{t('about.col.latest')}</th>
              <th scope="col" title={t('about.col.status')}>{t('about.col.status')}</th>
              {/* 보이는 머리글 없음(40 px 열에 번역이 넘치지 않게). 열 이름은 스크린 리더에만 */}
              <th scope="col" class="about__check"><span class="sr-only">{t('about.col.update')}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const can = isSelectable(r);
              const name = UPDATE_NAMES[r.id];
              return (
                <tr key={r.id}>
                  <th scope="row" class="about__name">{name}</th>
                  <td class="about__ver">{r.installed ?? '—'}</td>
                  <td class="about__ver">{r.status !== 'unknown' && r.latest ? r.latest : '—'}</td>
                  {statusCell(r)}
                  <td class="about__check">
                    <label class="about__hit">
                      <input type="checkbox" checked={can && checked.has(r.id)} disabled={!can || locked} aria-label={t('about.update.select', { name })}
                        aria-describedby={can ? `upd-det-${r.id}` : undefined} onChange={(e) => onToggle(r.id, (e.target as HTMLInputElement).checked)} />
                    </label>
                    {can && <span id={`upd-det-${r.id}`} class="sr-only">{t('about.update.detail', { installed: r.installed ?? '—', latest: r.latest ?? '—' })}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {state?.checkedAt != null && <p class="about__meta">{t('about.lastChecked', { time: formatDate(state.checkedAt, 'monthDayTime') })}</p>}
        {showClaudeNote && <p class="about__meta about__claude">{t('about.claudeNote')}</p>}
        {/* 다른 앱 정보 창에서 시작한 세션 닫기가 진행 중(대화상자를 닫았다 다시 연 경우) */}
        {state?.starting && !starting && !ask && <p class="about__meta" role="status">{t('update.closing')}</p>}
        {msg && <p class="about__meta" role="status">{msg}</p>}
        <div class="modal__actions">
          <button class="btn-secondary" disabled={locked} aria-busy={checking ? 'true' : undefined} onClick={check}>
            {checking && <span class="about__spin about__spin--btn" aria-hidden="true" />}{t('about.checkNow')}
          </button>
          <button ref={runBtnRef} class="btn-primary btn-primary--sm" disabled={locked || !selected.length} onClick={() => void run()}>{t('about.runUpdate')}</button>
          <button class="btn-secondary" autoFocus onClick={onClose}>{t('common.close')}</button>
        </div>
        <p class="about__note">{t('about.note')}</p>
      </div>
    </div>
      {ask && (
        <div class="modal" onClick={(e) => { e.stopPropagation(); closeAsk(); }}>
          <div class="modal__box" role="alertdialog" aria-modal="true" aria-label={ask.n === null ? t('update.closeFailed') : t('update.confirmTitle', { n: ask.n })} onClick={(e) => e.stopPropagation()}>
            {ask.n !== null && <p class="modal__text">{t('update.confirmTitle', { n: ask.n })}</p>}
            {ask.n !== null && <p class="modal__note">{t('update.confirmNote')}</p>}
            {ask.failed && <div class="field__error about__close-error" role="alert">{t('update.closeFailed')}</div>}
            <div class="modal__actions">
              <button class="btn-secondary" disabled={ask.busy} onClick={(e) => { e.stopPropagation(); closeAsk(); }}>{t('common.cancel')}</button>
              {!ask.failed && <button class="btn-danger" disabled={ask.busy} onClick={(e) => { e.stopPropagation(); void proceed(); }}>{t(ask.busy ? 'update.closing' : 'update.confirmClose')}</button>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
