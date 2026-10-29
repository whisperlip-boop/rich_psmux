// 사이드바 하단 사용량 영역(F7-1): 계정 영역 바로 위. 세션 한도(5시간)·주간 모든 모델·주간 모델별 막대 3개 + 마지막 갱신 시각 + ↻.
// 영역은 항상 보인다(v0.6): 데이터가 없으면 막대 "—"와 ↻만(안내 문구 없음), 로그아웃 상태면 "—"·↻ 비활성·로그인 안내. 모델별 막대는 첫 조회(기동 시 자동 1회 또는 ↻) 전까지 "—".

import { useEffect, useState } from 'preact/hooks';

import { formatDate, formatPercent } from '../../shared/i18n';
import type { ModelUsage, UsageDto, UsageWindow } from '../../shared/usage';
import { t } from '../i18n';

interface UsageAreaProps {
  usage: UsageDto | null;
  /** 로그인 상태(F7-2). false면 값을 보이지 않고 ↻ 비활성. */
  loggedIn: boolean;
  /** ↻: main에 조회를 요청하고 끝날 때까지 기다린다(그동안 버튼 비활성). */
  onRefresh: () => Promise<void>;
}

/** 로그아웃 상태 안내(현재 언어). */
export function usageLoggedOutNote(): string {
  return t('usage.loggedOut');
}

/** 화면에 그릴 값(순수 함수, 테스트 대상). */
export interface UsageView {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  model: ModelUsage | null;
  updatedAt: number | null;
  /** 안내 한 줄(없으면 null). */
  note: string | null;
  error: string | null;
  refreshDisabled: boolean;
}

/** 표시 상태: 로그아웃이면 모두 "—" + ↻ 비활성 + 로그인 안내. 데이터가 없으면 "—"와 ↻만. */
export function usageView(usage: UsageDto | null, loggedIn: boolean): UsageView {
  if (!loggedIn) return { fiveHour: null, sevenDay: null, model: null, updatedAt: null, note: usageLoggedOutNote(), error: null, refreshDisabled: true };
  const u = usage;
  return {
    fiveHour: u?.fiveHour ?? null, sevenDay: u?.sevenDay ?? null, model: u?.model ?? null, updatedAt: u?.updatedAt ?? null,
    note: null, error: u?.error ?? null, refreshDisabled: false,
  };
}

/** 막대 색 단계: ok(70% 미만) → warn(70~89) → high(90~99) → limit(100, 한도 도달). */
export type UsageLevel = 'ok' | 'warn' | 'high' | 'limit';
/** 이 사용률 이상이면 경고 색(warn). */
export const USAGE_WARN_PCT = 70;
/** 이 사용률 이상이면 위험 색(high). */
export const USAGE_HIGH_PCT = 90;

/** 막대 색 단계. 표시값(반올림)과 같은 기준으로 판정한다: 69.6%는 "70%"로 보이므로 warn(QA O-13). 값이 없으면 null. */
export function usageLevel(w: UsageWindow | null): UsageLevel | null {
  if (!w) return null;
  const p = Math.round(w.pct);
  return p >= 100 ? 'limit' : p >= USAGE_HIGH_PCT ? 'high' : p >= USAGE_WARN_PCT ? 'warn' : 'ok';
}

/** 경고 이상(warn·high·limit)인지. */
export function usageWarn(w: UsageWindow | null): boolean {
  const l = usageLevel(w);
  return l !== null && l !== 'ok';
}

/** 마지막 갱신 시각 → "방금"·"n분 전"·"n시간 전"·"n일 전"(사전 복수형: Intl 상대 시간보다 현지 표기가 자연스러움, 예 ja "5分前"). */
export function formatAgo(at: number | null, now: number): string {
  if (at === null) return '';
  const min = Math.floor(Math.max(0, now - at) / 60000);
  if (min < 1) return t('usage.justNow');
  if (min < 60) return t('time.minutesAgo', { n: min });
  const h = Math.floor(min / 60);
  return h < 24 ? t('time.hoursAgo', { n: h }) : t('time.daysAgo', { n: Math.floor(h / 24) });
}

/** 퍼센트 글자: 정수 반올림(Intl, 현재 언어), 값이 없으면 "—". */
export function pctText(w: UsageWindow | null): string {
  return w ? formatPercent(w.pct) : '—';
}

/** 절대 시각(툴팁용): 월/일 시:분(Intl, 현재 언어). */
function stamp(ms: number): string {
  return formatDate(ms, 'monthDayTime');
}

/**
 * 초기화까지 남은 시간(세션 한도 행): 60분 미만 "N분 후 초기화", 이상 "N시간 M분 후 초기화". 지났거나 모르면 null.
 * 분은 올림(30초 남음 → 1분).
 */
export function resetLabel(resetsAt: number | null | undefined, now: number): string | null {
  if (resetsAt === null || resetsAt === undefined || !Number.isFinite(resetsAt)) return null;
  const left = resetsAt - now;
  if (left <= 0) return null;
  const min = Math.ceil(left / 60000);
  return min < 60 ? t('usage.resetMin', { n: min }) : t('usage.resetHourMin', { h: Math.floor(min / 60), m: min % 60 });
}

function UsageRow({ label, w, reset }: { label: string; w: UsageWindow | null; reset?: string | null }) {
  const level = usageLevel(w);
  const tip = w?.resetsAt ? t('usage.resetTip', { at: stamp(w.resetsAt) }) : undefined;
  return (
    <div class={`usage__row${level ? ` is-${level}` : ''}`} title={tip}>
      <div class="usage__line">
        {/* 좁은 사이드바에서 라벨이 말줄임되므로 전체 문구 툴팁(행의 초기화 시각 툴팁은 라벨 밖에서 그대로) */}
        <span class="usage__label" title={label}>{label}</span>
        {reset && <span class="usage__reset" title={reset}>{reset}</span>}
        <span class="usage__pct">{pctText(w)}</span>
      </div>
      <div class="usage__track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={w ? Math.round(w.pct) : undefined} aria-valuetext={w ? undefined : t('usage.noValue')}>
        {w && w.pct > 0 && <div class="usage__fill" style={{ width: `${w.pct}%` }} />}
      </div>
    </div>
  );
}

/** 사용량 영역. */
export function UsageArea({ usage, loggedIn, onRefresh }: UsageAreaProps) {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // "n분 전" 표기를 맞추려고 30초마다 다시 그린다(데이터 조회는 하지 않음)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(t);
  }, []);
  // 새 값이 들어오면 기준 시각도 바로 맞춘다
  useEffect(() => setNow(Date.now()), [usage?.updatedAt]);

  const v = usageView(usage, loggedIn);
  const refresh = async (): Promise<void> => {
    if (busy || v.refreshDisabled) return;
    setBusy(true);
    try {
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="usage" aria-label={t('usage.title')}>
      <div class="usage__head">
        <span class="usage__title">{t('usage.title')}</span>
        <span class="usage__time" title={v.updatedAt ? t('usage.lastUpdated', { at: stamp(v.updatedAt) }) : undefined}>{formatAgo(v.updatedAt, now)}</span>
        <button class={`icon-btn icon-btn--24 usage__refresh${busy ? ' is-busy' : ''}`} aria-label={t('usage.refresh')}
          title={v.refreshDisabled ? usageLoggedOutNote() : t('usage.refresh')}
          disabled={busy || v.refreshDisabled} aria-busy={busy} onClick={() => void refresh()}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 2.5v3h-3" />
          </svg>
        </button>
      </div>
      {/* 초기화까지 남은 시간은 세션 한도 행에만(주간 행은 툴팁의 재설정 시각만). 30초 타이머로 갱신 */}
      <UsageRow label={t('usage.session')} w={v.fiveHour} reset={resetLabel(v.fiveHour?.resetsAt, now)} />
      <UsageRow label={t('usage.weekAll')} w={v.sevenDay} />
      <UsageRow label={t('usage.weekModel', { model: v.model?.label ?? t('usage.perModel') })} w={v.model} />
      {v.note && <p class="usage__note">{v.note}</p>}
      {v.error && <p class="usage__error" role="status">{v.error}</p>}
    </section>
  );
}
