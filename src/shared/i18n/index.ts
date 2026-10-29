// UI 문구(main·renderer 공용). 언어 등록은 registry.ts, 문자열은 언어별 사전 파일에만 둔다.
// 현재 언어는 프로세스(main·renderer)마다 하나: main은 설정·시스템 로케일로, renderer는 main이 알려 준 값으로 setLang한다.
// 기본값(SOURCE_LANG)은 언어를 정하기 전(단위 테스트 포함)의 원래 동작을 유지하기 위한 것이다.

import { FALLBACK_LANG, LANGS, SOURCE_LANG, type Lang, type LangDef } from './registry';
import type { Dict, Entry, Msg, MsgKey, Param } from './types';

export { FALLBACK_LANG, LANGS, SOURCE_LANG, type Lang, type LangDef } from './registry';
export type { Dict, Entry, Msg, MsgKey, Param, PluralEntry } from './types';

const BY_CODE = new Map<string, LangDef>(LANGS.map((l) => [l.code, l]));
const TOKEN_RE = /\{(\w+)\}/g;

/** 지원 언어 코드인지(레지스트리 기준, 대소문자 구분: settings.json 값은 등록한 그대로여야 한다). */
export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && BY_CODE.has(v);
}

/** 언어 등록 정보. */
export function langDef(lang: Lang): LangDef {
  return BY_CODE.get(lang)!;
}

/** Intl 로케일(복수형 기준; 날짜·숫자·정렬은 formatLocale). */
export function intlLocale(lang: Lang): string {
  return langDef(lang).intlLocale;
}

/** html lang 속성 값: intlLocale에서 -u- 확장(예: bn의 -u-nu-latn)을 뺀 태그. intlFallback과 무관하게 항상 그 언어(글꼴·스크린 리더). */
export function langTag(lang: Lang): string {
  return new Intl.Locale(intlLocale(lang)).baseName;
}

/** 등록된 언어 항목(코드가 Lang으로 좁혀진 LangDef). */
export type RegisteredLang = (typeof LANGS)[number];

/** 등록 언어를 영어 이름 순으로(선택 대화상자 표시 순서, 등록 순서와 무관). */
export function sortedLangs<T extends LangDef>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.english.localeCompare(b.english, 'en', { sensitivity: 'base' }));
}

const norm = (tag: string): string => tag.trim().replace(/_/g, '-').toLowerCase();
const primary = (tag: string): string => norm(tag).split('-')[0];

/** 첫 하위 태그를 등록 언어의 것으로 바꾼다(다른 이름 aliases, 예: 'tl' → 'fil'). 해당 없으면 그대로. */
function canonicalPrimary(tag: string, list: readonly LangDef[]): string {
  const p = primary(tag);
  const owner = list.find((l) => l.aliases?.some((a) => norm(a) === p));
  return owner ? primary(owner.code) : p;
}

/**
 * 지역 하위 태그만 있는 로케일의 문자 체계(언어별). 중국어는 지역이 번체·간체를 정하므로 스크립트가 없는 'zh-TW' 같은 태그를 Hant/Hans로 본다.
 * 펀자브어는 파키스탄(pa-PK)이 샤무키(아랍 문자)라 구르무키(pa)로 맞추지 않는다.
 */
const REGION_SCRIPT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  zh: { tw: 'hant', hk: 'hant', mo: 'hant', cn: 'hans', sg: 'hans', my: 'hans' },
  pa: { pk: 'arab' },
};

/** 태그가 가리키는 문자 체계(소문자): 명시적 스크립트 하위 태그(4자) 우선, 없으면 언어별 지역→스크립트 표. 모르면 null. */
function scriptOf(tag: string, lang: string): string | null {
  const sub = norm(tag).split('-').slice(1);
  const explicit = sub.find((s) => /^[a-z]{4}$/.test(s));
  if (explicit) return explicit;
  const region = sub.find((s) => /^([a-z]{2}|\d{3})$/.test(s));
  return (region && REGION_SCRIPT[lang]?.[region]) ?? null;
}

/**
 * 로케일 태그 하나를 등록 언어로 맞춘다: ① 전체 태그 일치(대소문자·_ 무시) → ② 같은 언어(첫 하위 태그, 등록 언어의
 * aliases도 같은 언어로 본다)의 변형 중, 태그의 문자 체계(스크립트 하위 태그 또는 지역→스크립트 표)와 `script`가 같은 변형이
 * 있으면 그것(여럿이면 default → 첫 변형), 없으면 default 변형(default 표시가 없으면 등록된 첫 변형) → ③ 없으면 null.
 * 단, 태그의 문자 체계를 아는데 그 언어의 등록 변형이 모두 다른 문자 체계로 표시돼 있으면 null(예: pa-Arab·pa-PK → 구르무키 pa 아님).
 *
 * Args:
 *   tag: BCP 47 태그(예: 'ko-KR', 'es-MX', 'ja_JP', 'tl-PH', 'zh-HK', 'zh-Hant-TW').
 *   list: 등록 목록(테스트에서 가짜 레지스트리 주입).
 */
export function matchLang(tag: string, list: readonly LangDef[] = LANGS): string | null {
  const t = norm(tag);
  if (!t) return null;
  const exact = list.find((l) => norm(l.code) === t);
  if (exact) return exact.code;
  const p = canonicalPrimary(t, list);
  const same = list.filter((l) => primary(l.code) === p);
  const script = scriptOf(t, p);
  const pick = (c: readonly LangDef[]): LangDef | undefined => c.find((l) => l.default) ?? c[0];
  const byScript = script ? same.filter((l) => l.script && norm(l.script) === script) : [];
  // 읽을 수 없는 문자로 UI를 띄우느니 FALLBACK_LANG(영어)이 낫다
  if (script && !byScript.length && same.length && same.every((l) => l.script)) return null;
  return (pick(byScript) ?? pick(same))?.code ?? null;
}

/**
 * 시스템 로케일 목록의 첫 값(Windows 표시 언어)을 UI 언어로: matchLang, 맞는 언어가 없으면 FALLBACK_LANG.
 *
 * Args:
 *   locales: 선호 순 로케일(예: app.getPreferredSystemLanguages() + app.getLocale()). 빈 값은 건너뛴다.
 */
export function langFromLocales(locales: readonly (string | null | undefined)[]): Lang {
  const first = locales.find((l): l is string => typeof l === 'string' && l.trim() !== '');
  const m = first ? matchLang(first) : null;
  return isLang(m) ? m : FALLBACK_LANG;
}

/**
 * 언어 검색(선택 대화상자): 네이티브 이름·영어 이름에 대한 대소문자 무시 부분 일치. 빈 검색어면 전체. 결과는 영어 이름 순.
 *
 * Args:
 *   query: 검색어(앞뒤 공백 무시).
 *   list: 대상 목록(기본 LANGS).
 */
export function filterLangs(query: string): RegisteredLang[];
export function filterLangs<T extends LangDef>(query: string, list: readonly T[]): T[];
export function filterLangs(query: string, list: readonly LangDef[] = LANGS): LangDef[] {
  const q = query.trim().toLowerCase();
  return sortedLangs(list).filter((l) => !q || l.native.toLowerCase().includes(q) || l.english.toLowerCase().includes(q));
}

/** Intl 객체 캐시(로케일·옵션별 1개). 목록 렌더링마다 수백 번 불리므로 만들기 비용을 한 번만 낸다. */
const intlCache = new Map<string, unknown>();

function cached<T>(kind: string, locale: string, opts: object, make: () => T): T {
  const key = `${kind}|${locale}|${JSON.stringify(opts)}`;
  let v = intlCache.get(key) as T | undefined;
  if (v === undefined) intlCache.set(key, (v = make()));
  return v;
}

/** 데이터 확인용 시각(2000-10-15 UTC)과, 언어 데이터가 없을 때 ICU root가 내는 월 이름(M10). */
const PROBE_MS = Date.UTC(2000, 9, 15);
const ROOT_MONTH_RE = /^M\d+$/;

/**
 * 런타임 ICU가 이 로케일의 날짜·숫자 데이터를 실제로 갖는지. Electron 번들 ICU는 pa를 지원 목록(supportedLocalesOf)에
 * 올리고 'pa'로 해석까지 하지만 데이터는 root라서, 지원 목록·해석 언어만으로는 못 가린다 → 긴 월 이름이 root 자리표시(M10)인지 본다.
 */
function hasIcuData(locale: string): boolean {
  if (Intl.DateTimeFormat.supportedLocalesOf([locale]).length === 0) return false;
  const f = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  return primary(f.resolvedOptions().locale) === primary(locale) && !ROOT_MONTH_RE.test(f.format(PROBE_MS));
}

let icuDataCheck: (locale: string) => boolean = hasIcuData;
/** hasIcuData 결과 캐시(로케일별 1회, 런타임 ICU는 실행 중 바뀌지 않는다). */
const icuDataCache = new Map<string, boolean>();

/** 테스트 전용: 런타임 ICU 데이터 확인을 바꾼다(Node의 full ICU로는 Electron의 pa 누락을 재현할 수 없다). null이면 기본값. */
export function setIntlSupportForTest(check: ((locale: string) => boolean) | null): void {
  icuDataCheck = check ?? hasIcuData;
  icuDataCache.clear();
}

/**
 * 날짜·숫자·상대 날짜·정렬에 실제로 쓰는 로케일: 런타임 ICU에 intlLocale 데이터가 있으면 intlLocale, 없으면 intlFallback
 * (없으면 intlLocale 그대로). 복수형(사전 범주가 그 언어 기준)과 html lang은 항상 intlLocale.
 *
 * Args:
 *   lang: 언어.
 */
export function formatLocale(lang: Lang): string {
  const { intlLocale: loc, intlFallback } = langDef(lang);
  if (!intlFallback) return loc;
  let ok = icuDataCache.get(loc);
  if (ok === undefined) icuDataCache.set(loc, (ok = icuDataCheck(loc)));
  return ok ? loc : intlFallback;
}

function plurals(locale: string): Intl.PluralRules {
  return cached('plural', locale, {}, () => new Intl.PluralRules(locale));
}

/** 현재 로케일 숫자 표시(보간 값용, 자릿수 구분 포함). */
function numberText(locale: string, n: number): string {
  return cached('number', locale, {}, () => new Intl.NumberFormat(locale)).format(n);
}

/** 복수형 문구에서 수(n)에 맞는 범주를 고른다. 그 범주가 없으면 other. */
function pickForm(e: Entry, locale: string, n: Param | undefined): string {
  if (typeof e === 'string') return e;
  if (typeof n !== 'number') return e.other;
  return e[plurals(locale).select(n)] ?? e.other;
}

/** 사전 값(없으면 FALLBACK_LANG → SOURCE_LANG 순). 사전은 타입으로 모든 키를 갖게 강제하지만 런타임에도 비지 않게. */
function entryOf(lang: Lang, key: MsgKey): Entry {
  const d = (code: Lang): Dict | undefined => BY_CODE.get(code)?.dict;
  return d(lang)?.[key] ?? d(FALLBACK_LANG)?.[key] ?? d(SOURCE_LANG)![key];
}

/**
 * 문구를 번역한다. 복수형 문구는 params.n으로 범주를 고르고, {이름} 토큰은 params 값으로 바꾼다
 * (숫자는 그 언어 숫자 표시, Msg는 같은 언어로 먼저 번역). 없는 토큰은 그대로 둔다.
 * 수처럼 보이지만 식별자인 값(PID·HTTP 상태·종료 코드)은 자릿수 구분이 붙지 않게 문자열로 넘긴다.
 *
 * Args:
 *   lang: 언어.
 *   key: 문구 키.
 *   params: 보간 값.
 */
export function t(lang: Lang, key: MsgKey, params?: Record<string, Param>): string {
  const s = pickForm(entryOf(lang, key), intlLocale(lang), params?.n);
  if (!params) return s;
  // 치환 함수를 써서 값 안의 $& 같은 패턴이 해석되지 않게 한다(경로·명령에 $가 들어갈 수 있음)
  return s.replace(TOKEN_RE, (m, name: string) => (name in params ? paramText(lang, params[name]) : m));
}

function paramText(lang: Lang, p: Param): string {
  if (typeof p === 'number') return numberText(formatLocale(lang), p);
  return typeof p === 'object' ? t(lang, p.key, p.params) : p;
}

/** 문구의 보간 토큰 이름(정렬, 사전 검사용). */
export function tokensOf(s: string): string[] {
  return [...new Set([...s.matchAll(TOKEN_RE)].map((m) => m[1]))].sort();
}

/** 언어별 사전(테스트·검사용 읽기 전용). */
export function dictOf(lang: Lang): Readonly<Dict> {
  return langDef(lang).dict;
}

let current: Lang = SOURCE_LANG;

/** 이 프로세스의 현재 언어를 바꾼다. */
export function setLang(lang: Lang): void {
  current = lang;
}

/** 이 프로세스의 현재 언어. */
export function getLang(): Lang {
  return current;
}

/** 현재 언어의 Intl 로케일. */
export function currentLocale(): string {
  return intlLocale(current);
}

/** 현재 언어로 번역. */
export function tr(key: MsgKey, params?: Record<string, Param>): string {
  return t(current, key, params);
}

/** 번역을 미룬 문구를 만든다. */
export function msg(key: MsgKey, params?: Record<string, Param>): Msg {
  return params ? { key, params } : { key };
}

/** 미룬 문구(또는 이미 만든 문자열)를 현재 언어로 바꾼다. */
export function resolveMsg(m: Msg | string): string {
  return typeof m === 'string' ? m : tr(m.key, m.params);
}

/**
 * 현재 언어의 상대 날짜 이름(Intl): 0 = 오늘, -1 = 어제(날짜 그룹·사이드바 시각 열). "n분 전" 같은 상대 시간은 사전 time.* 복수형. 영어처럼 소문자로 나오는 언어는 첫 글자만 대문자로.
 *
 * Args:
 *   days: 오늘 기준 일수.
 */
export function relativeDayName(days: number): string {
  const locale = formatLocale(current);
  // 대체 로케일(intlFallback)의 Intl은 그 언어 단어를 못 만들므로 등록된 단어를 쓴다(오늘·어제만; 호출부도 0·-1만)
  const own = locale === currentLocale() ? undefined : langDef(current).relativeDays;
  const fixed = days === 0 ? own?.today : days === -1 ? own?.yesterday : undefined;
  const s = fixed ?? cached('relative', locale, { numeric: 'auto' }, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })).format(days, 'day');
  return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
}

/**
 * 현재 언어의 날짜·시각 표시(Intl.DateTimeFormat). 시각은 24시간제로 통일(목록 시각 열 폭·기존 표기 유지).
 *
 * Args:
 *   ms: 시각(ms).
 *   style: time = 시:분, monthDay = 월/일, date = 연/월/일, monthDayTime = 월/일 시:분.
 */
export function formatDate(ms: number, style: 'time' | 'monthDay' | 'date' | 'monthDayTime'): string {
  const time = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
  const md = { month: '2-digit', day: '2-digit' } as const;
  const opts: Intl.DateTimeFormatOptions = style === 'time' ? time : style === 'monthDay' ? md : style === 'date' ? { year: 'numeric', ...md } : { ...md, ...time };
  const locale = formatLocale(current);
  return cached('date', locale, opts, () => new Intl.DateTimeFormat(locale, opts)).format(ms);
}

/** 현재 언어의 퍼센트 표시(정수 반올림). pct는 0~100. */
export function formatPercent(pct: number): string {
  const locale = formatLocale(current);
  const opts = { style: 'percent', maximumFractionDigits: 0 } as const;
  return cached('number', locale, opts, () => new Intl.NumberFormat(locale, opts)).format(pct / 100);
}

/** 현재 언어의 문자열 비교(정렬: 숫자 인식, 대소문자·악센트 무시). */
export function compareText(a: string, b: string): number {
  const locale = formatLocale(current);
  const opts = { numeric: true, sensitivity: 'base' } as const;
  return cached('collator', locale, opts, () => new Intl.Collator(locale, opts)).compare(a, b);
}

/**
 * 끝 문장부호(. 。 ． ! ？ । ॥ 등)와 공백을 떼어 낸다. 문구 안에 다른 문장을 넣을 때 "…다.. " 처럼 부호가 겹치지 않게 쓴다.
 *
 * Args:
 *   s: 넣을 문장.
 */
export function stripEndPunct(s: string): string {
  return s.replace(/[\s.。．!！?？…।॥]+$/u, '');
}
