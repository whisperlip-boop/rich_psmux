// 설정 대화상자: 값 검증·저장은 main(settings:save)이 하고, 여기서는 입력과 항목별 오류 표시만 한다.
// 글꼴·테마·히스토리 경로는 저장 즉시 적용, psmux·PowerShell 경로와 리드 명령은 다음 새 세션부터.

import { useEffect, useRef, useState } from 'preact/hooks';

import type { EditableSettings, SettingsErrors, SettingsView, ThemeMode } from '../../shared/api';
import type { MsgKey } from '../../shared/i18n';
import { useDialogKeys } from '../dialog';
import { t } from '../i18n';
import { safeIpc } from '../ipc';

interface SettingsDialogProps {
  onClose: () => void;
}

const THEMES: { id: ThemeMode; label: MsgKey }[] = [
  { id: 'light', label: 'theme.light' },
  { id: 'dark', label: 'theme.dark' },
  { id: 'system', label: 'theme.system' },
];

/** 설정 대화상자. */
export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [form, setForm] = useState<EditableSettings | null>(null);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const boxRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    void safeIpc(() => window.ctd.getSettings(), null, setLoadError, t('action.loadSettings')).then((v) => {
      if (!v) return;
      setView(v);
      setForm(v.values);
    });
  }, []);

  useDialogKeys(true, onClose);
  useEffect(() => {
    if (form) boxRef.current?.querySelector<HTMLElement>('input')?.focus();
  }, [!!form]);

  const set = <K extends keyof EditableSettings>(k: K, v: EditableSettings[K]): void => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const save = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (!form || saving) return;
    setSaving(true);
    const r = await safeIpc(() => window.ctd.saveSettings(form), null, setLoadError, t('action.saveSettings'));
    setSaving(false);
    if (!r) return;
    if (!r.ok) {
      setErrors(r.errors);
      // 브라우저 기본 검증(min·max)은 끄고(noValidate) main 검증 결과만 쓴다. 첫 오류 항목으로 포커스
      const first = Object.keys(r.errors)[0];
      if (first) boxRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    onClose();
  };

  const text = (k: 'psmuxPath' | 'pwshPath' | 'leadCommand' | 'historyDir' | 'fontFamily', label: string, placeholder: string, hint?: string, warn?: string | null) => (
    <div class="field">
      <label for={`set-${k}`}>{label}</label>
      <input id={`set-${k}`} name={k} type="text" spellcheck={false} value={form ? form[k] : ''} placeholder={placeholder}
        aria-invalid={errors[k] ? 'true' : undefined} aria-describedby={errors[k] ? `err-${k}` : hint ? `hint-${k}` : undefined}
        onInput={(e) => set(k, (e.target as HTMLInputElement).value)} />
      {hint && !errors[k] && <div class="field__hint" id={`hint-${k}`}>{hint}</div>}
      {warn && !errors[k] && <div class="field__warn" role="status">{warn}</div>}
      {errors[k] && <div class="field__error" id={`err-${k}`} role="alert">{errors[k]}</div>}
    </div>
  );

  const d = view?.defaults;
  return (
    <div class="modal" onClick={onClose}>
      <div class="modal__box settings" role="dialog" aria-modal="true" aria-label={t('settings.title')} onClick={(e) => e.stopPropagation()}>
        <form ref={boxRef} noValidate onSubmit={(e) => void save(e)}>
          <h2>{t('settings.title')}</h2>
          {loadError && <div class="field__error" role="alert">{loadError}</div>}
          {!form && !loadError && <p class="muted">{t('common.loading')}</p>}
          {form && d && (
            <>
              <fieldset>
                <legend>{t('settings.secRun')}</legend>
                {text('psmuxPath', t('settings.psmuxPath'), d.psmuxDetected ? t('settings.psmuxAuto', { path: d.psmuxDetected }) : t('settings.psmuxNotFound'))}
                {text('pwshPath', t('settings.pwshPath'), t('settings.pwshPlaceholder'), t('settings.pwshHint'), view?.shellWarning)}
                {text('leadCommand', t('settings.leadCommand'), d.leadCommand, t('settings.resetHint'))}
                <p class="field__note">{t('settings.nextSessionNote')}</p>
              </fieldset>
              <fieldset>
                <legend>{t('common.history')}</legend>
                {text('historyDir', t('settings.historyDir'), d.historyDir, t('settings.historyHint'))}
                <label class="check">
                  <input type="checkbox" name="showSdkSessions" checked={form.showSdkSessions} onChange={(e) => set('showSdkSessions', (e.target as HTMLInputElement).checked)} />
                  {t('settings.showSdk')}
                </label>
              </fieldset>
              <fieldset>
                <legend>{t('settings.secDisplay')}</legend>
                {text('fontFamily', t('settings.fontFamily'), d.fontFamily, t('settings.resetHint'))}
                <div class="field field--short">
                  <label for="set-fontSize">{t('settings.fontSize')}</label>
                  <input id="set-fontSize" name="fontSize" type="number" min={8} max={32} step={1} value={Number.isNaN(form.fontSize) ? '' : form.fontSize}
                    placeholder={String(d.fontSize)} aria-invalid={errors.fontSize ? 'true' : undefined}
                    onInput={(e) => { const v = (e.target as HTMLInputElement).value; set('fontSize', v.trim() === '' ? Number.NaN : Number(v)); }} />
                  {errors.fontSize && <div class="field__error" role="alert">{errors.fontSize}</div>}
                </div>
                <div class="field" role="radiogroup" aria-label={t('settings.theme')}>
                  <span class="field__label">{t('settings.theme')}</span>
                  <div class="radios">
                    {THEMES.map((th) => (
                      <label key={th.id} class="check">
                        <input type="radio" name="theme" value={th.id} checked={form.theme === th.id} onChange={() => set('theme', th.id)} />
                        {t(th.label)}
                      </label>
                    ))}
                  </div>
                </div>
              </fieldset>
            </>
          )}
          <div class="modal__actions">
            <button type="button" class="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" class="btn-primary btn-primary--sm" disabled={!form || saving}>{t(saving ? 'common.saving' : 'common.save')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
