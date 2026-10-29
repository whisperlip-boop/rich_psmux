// Electron 런타임 ICU 검사: 등록 언어마다 실제로 쓰는 표기 로케일(formatLocale)이 Electron 번들 ICU에서 그 언어(또는 선언한
// intlFallback)의 데이터로 해석되는지 본다. Node는 full ICU라 단위 테스트로는 Chromium 축소 ICU의 누락(예: pa)을 못 잡는다.
// 실행: npm run itest:intl  (Node로 띄우면 ELECTRON_RUN_AS_NODE=1로 Electron에서 자신을 다시 실행한다.
//       직접: ELECTRON_RUN_AS_NODE=1 npx electron out/itest/intl-itest.js). 결과: 콘솔 + out/itest/intl-result.json.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { formatLocale, LANGS, langDef, relativeDayName, setLang, t, type Lang } from '../../src/shared/i18n';

type Check = { name: string; pass: boolean; detail?: unknown };

/** 긴 월 이름 확인용 시각(2000-10-15 UTC). 언어 데이터가 없으면 ICU root 자리표시 M10이 나온다. */
const PROBE_MS = Date.UTC(2000, 9, 15);
const ROOT_MONTH_RE = /^M\d+$/;
const primary = (tag: string): string => tag.toLowerCase().split('-')[0];

type IntlCtor = { supportedLocalesOf(l: string[]): string[]; new (l: string): { resolvedOptions(): { locale: string } } };
const CTORS: Readonly<Record<string, IntlCtor>> = {
  NumberFormat: Intl.NumberFormat, DateTimeFormat: Intl.DateTimeFormat, RelativeTimeFormat: Intl.RelativeTimeFormat, Collator: Intl.Collator,
};

/** Node로 실행됐으면 Electron(같은 ICU를 쓰는 앱 런타임)에서 이 파일을 다시 실행하고 그 종료 코드로 끝낸다. */
function relaunchInElectron(): never {
  const electron = createRequire(__filename)('electron') as string;
  const r = spawnSync(electron, [__filename], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  if (r.error) console.error(`failed to start electron: ${r.error.message}`);
  process.exit(r.status ?? 1);
}

/** 언어 하나의 검사 목록. */
function checkLang(lang: Lang): Check[] {
  const l = langDef(lang);
  const eff = formatLocale(lang);
  const out: Check[] = [];
  const add = (name: string, pass: boolean, detail?: unknown): void => void out.push({ name: `${l.code}: ${name}`, pass, detail });
  add('formatLocale is intlLocale or declared intlFallback', eff === l.intlLocale || eff === l.intlFallback, { intlLocale: l.intlLocale, eff });
  for (const [kind, C] of Object.entries(CTORS)) {
    const supported = C.supportedLocalesOf([eff]);
    const resolved = new C(eff).resolvedOptions().locale;
    add(`${kind} supports ${eff} and resolves to its language`, supported.length === 1 && primary(resolved) === primary(eff), { supported, resolved });
  }
  const month = new Intl.DateTimeFormat(eff, { month: 'long', timeZone: 'UTC' }).format(PROBE_MS);
  add('DateTimeFormat has locale data (month name is not root M10)', !ROOT_MONTH_RE.test(month), { month });
  // 복수형은 사전 범주가 그 언어 기준이라 대체 로케일이 아니라 intlLocale의 런타임 규칙이 사전이 쓰는 범주를 모두 가져야 한다
  const cats = new Intl.PluralRules(l.intlLocale).resolvedOptions().pluralCategories;
  const used = [...new Set(Object.values(l.dict).flatMap((e) => (typeof e === 'string' ? [] : Object.keys(e))))];
  add('PluralRules has the categories the dictionary uses', used.every((c) => cats.includes(c as Intl.LDMLPluralRule)), { cats, used });
  setLang(lang);
  const names = [relativeDayName(0), relativeDayName(-1)];
  // root 데이터면 영어(today·yesterday)가 나온다: 영어 외 언어는 영어 단어와 달라야 한다
  const english = primary(l.intlLocale) === 'en';
  add('relativeDayName is in the UI language', english || !names.some((s) => /^(today|yesterday)$/i.test(s)), { names });
  return out;
}

/** 인도계 자릿수: 단위 테스트(5라운드)와 같은 기대값(CLDR: kn만 서양식 1,234,567, 나머지는 인도식 12,34,567)을 Electron ICU로 확인한다. */
function indicGrouping(): Check[] {
  const INDIC: Lang[] = ['hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'pa'];
  return INDIC.map((c) => {
    const raw = new Intl.NumberFormat(langDef(c).intlLocale).format(1_234_567.5);
    const shown = new Intl.NumberFormat(formatLocale(c)).format(1_234_567.5);
    const days = t(c, 'filter.days', { n: 1_234_567 });
    console.log(`${c.padEnd(3)} intlLocale ${raw.padEnd(12)} formatLocale ${shown.padEnd(12)} t(filter.days) ${days}`);
    const want = c === 'kn' ? /^1,234,567 / : /^12,34,567 /;
    return { name: `${c}: filter.days digit grouping matches unit test`, pass: want.test(days), detail: { raw, shown, days } };
  });
}

function main(): void {
  if (!process.versions.electron) relaunchInElectron();
  console.log(`electron ${process.versions.electron}, ICU ${process.versions.icu}`);
  const codes: Lang[] = LANGS.map((l) => l.code);
  const checks = [...codes.flatMap(checkLang), ...indicGrouping()];
  const fallbacks = codes.filter((c) => formatLocale(c) !== langDef(c).intlLocale).map((c) => `${c}→${formatLocale(c)}`);
  for (const c of checks) if (!c.pass) console.log(`FAIL ${c.name} ${JSON.stringify(c.detail)}`);
  console.log(`fallback in effect: ${fallbacks.join(', ') || 'none'}`);
  const failed = checks.filter((c) => !c.pass).length;
  writeFileSync(join(__dirname, 'intl-result.json'), JSON.stringify({ electron: process.versions.electron, icu: process.versions.icu, fallbacks, checks }, null, 2));
  console.log(`${checks.length - failed}/${checks.length} passed (${LANGS.length} languages)`);
  process.exit(failed ? 1 : 0);
}

main();
