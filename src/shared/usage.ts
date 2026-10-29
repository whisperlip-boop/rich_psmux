// 사용량 표시(F7-1) 공용 형식과 순수 파서. statusline 스크립트·main·테스트가 같이 쓴다(node·electron 의존 없음).
// 기록·전달하는 값은 퍼센트·재설정 시각·수신 시각·모델 표시 이름뿐이다(토큰·세션 ID·cwd·비용은 다루지 않음).

/** 한도 하나: 사용률(0~100)과 재설정 시각(epoch ms, 모르면 null). */
export interface UsageWindow {
  pct: number;
  resetsAt: number | null;
}

/** usage.json 내용(statusline 또는 ↻ 결과의 5시간·7일 값). */
export interface UsageRecord {
  v: 1;
  /** 받은 시각(epoch ms). */
  at: number;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

/** 모델별 주간 한도(↻ 결과에만 있음). */
export interface ModelUsage extends UsageWindow {
  label: string;
}

/** ↻(/api/oauth/usage) 응답에서 꺼낸 값. */
export interface OauthUsage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  model: ModelUsage | null;
}

/** 렌더러 표시 상태(IPC usage:update·usage:refresh·init). 세 값이 모두 null이면 영역을 숨긴다. */
export interface UsageDto {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** ↻을 누르기 전(또는 앱 재시작 뒤)에는 null → "—". */
  model: ModelUsage | null;
  /** 마지막 갱신 시각(epoch ms). */
  updatedAt: number | null;
  /** 마지막 ↻ 실패 안내(한국어 한 줄). 성공하면 null. */
  error: string | null;
}

/** 표시할 값이 하나도 없는지(rate_limits 데이터가 한 번도 없음 → 영역 숨김). */
export function usageEmpty(d: UsageDto | null): boolean {
  return !d || (!d.fiveHour && !d.sevenDay && !d.model);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 0~100 범위 밖은 잘라낸다(표시·막대 길이 기준). 숫자가 아니면 null. */
function pctOf(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(100, Math.max(0, v));
}

/** 재설정 시각: epoch 초(statusline)·epoch ms·ISO 문자열(oauth)을 epoch ms로. 해석 못 하면 null. */
function timeOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string' && v.length <= 64) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function windowOf(o: unknown, pctKey: string): UsageWindow | null {
  if (!isObj(o)) return null;
  const pct = pctOf(o[pctKey]);
  return pct === null ? null : { pct, resetsAt: timeOf(o.resets_at) };
}

/**
 * Claude Code statusline stdin JSON에서 rate_limits만 꺼낸다.
 *
 * Args:
 *   raw: stdin 전체 문자열.
 *   now: 받은 시각(epoch ms).
 *
 * Returns:
 *   기록할 레코드. rate_limits가 없거나(API 키 계정·첫 응답 전) 형식이 다르면 null.
 */
export function parseStatusLineInput(raw: string, now: number): UsageRecord | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const rl = isObj(j) ? j.rate_limits : null;
  if (!isObj(rl)) return null;
  const fiveHour = windowOf(rl.five_hour, 'used_percentage');
  const sevenDay = windowOf(rl.seven_day, 'used_percentage');
  return fiveHour || sevenDay ? { v: 1, at: now, fiveHour, sevenDay } : null;
}

/** usage.json 문자열 → 레코드(형식이 다르면 null). 저장된 값도 다시 검증한다. */
export function parseUsageRecord(raw: string): UsageRecord | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(j) || j.v !== 1 || typeof j.at !== 'number' || !Number.isFinite(j.at)) return null;
  const w = (o: unknown): UsageWindow | null => {
    if (!isObj(o)) return null;
    const pct = pctOf(o.pct);
    // 저장값은 항상 epoch ms(초 단위 추정을 다시 하면 값이 1000배가 됨)
    const r = o.resetsAt;
    return pct === null ? null : { pct, resetsAt: typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null };
  };
  const fiveHour = w(j.fiveHour);
  const sevenDay = w(j.sevenDay);
  return fiveHour || sevenDay ? { v: 1, at: j.at, fiveHour, sevenDay } : null;
}

/** 모델 표시 이름: 짧은 한 줄 문자열만(제어문자·과도한 길이는 버림). */
function labelOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= 40 && !/[\x00-\x1f\x7f]/.test(s) ? s : null;
}

/** 구형 필드(seven_day_opus 등) 이름 → 표시 이름. */
const LEGACY_MODEL_KEYS: [string, string][] = [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']];

/**
 * GET /api/oauth/usage 응답에서 5시간·7일·모델별 7일 사용률만 꺼낸다(2026-10-26 실제 응답 기준).
 * - five_hour·seven_day: { utilization(0~100), resets_at(ISO) }. 없으면 limits[]의 kind 'session'·'weekly_all'로 대신한다.
 * - 모델별: limits[]의 kind 'weekly_scoped' + scope.model.display_name(예: "Fable"). 여러 개면 사용률이 가장 높은 것.
 *   없으면 구형 seven_day_opus·seven_day_sonnet 중 값이 있는 것.
 *
 * Args:
 *   body: 응답 JSON.
 *
 * Returns:
 *   추출 값. 5시간·7일이 모두 없으면(형식 변경) null.
 */
export function parseOauthUsage(body: unknown): OauthUsage | null {
  if (!isObj(body)) return null;
  const limits = Array.isArray(body.limits) ? body.limits.filter(isObj) : [];
  const fromLimits = (kind: string): UsageWindow | null => windowOf(limits.find((l) => l.kind === kind), 'percent');
  const fiveHour = windowOf(body.five_hour, 'utilization') ?? fromLimits('session');
  const sevenDay = windowOf(body.seven_day, 'utilization') ?? fromLimits('weekly_all');
  if (!fiveHour && !sevenDay) return null;

  let model: ModelUsage | null = null;
  for (const l of limits) {
    if (l.kind !== 'weekly_scoped' || !isObj(l.scope) || !isObj(l.scope.model)) continue;
    const label = labelOf(l.scope.model.display_name);
    const w = windowOf(l, 'percent');
    if (label && w && (!model || w.pct > model.pct)) model = { label, ...w };
  }
  if (!model) {
    for (const [key, label] of LEGACY_MODEL_KEYS) {
      const w = windowOf(body[key], 'utilization');
      if (w && (!model || w.pct > model.pct)) model = { label, ...w };
    }
  }
  return { fiveHour, sevenDay, model };
}
