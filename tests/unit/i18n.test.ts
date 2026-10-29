import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stopFailMessage } from '../../src/main/history/running';
import { DEFAULT_SETTINGS, diffFromDefaults, normalizeSettings } from '../../src/main/settings';
import { quoteMention } from '../../src/shared/attach';
import {
  compareText, dictOf, FALLBACK_LANG, filterLangs, formatDate, formatLocale, formatPercent, getLang, intlLocale, isLang, langTag, LANGS, langFromLocales, matchLang, msg,
  relativeDayName, resolveMsg, setIntlSupportForTest, setLang, SOURCE_LANG, sortedLangs, stripEndPunct, t, tokensOf, tr, type Entry, type Lang, type LangDef,
  type MsgKey,
} from '../../src/shared/i18n';
import { trashMessage } from '../../src/renderer/components/MenuDialogs';
import { formatAgo, pctText } from '../../src/renderer/components/UsageArea';
import { dateBucketName, formatTime } from '../../src/renderer/history';

const CODES = LANGS.map((l) => l.code) as Lang[];
const keysOf = (l: Lang): string[] => Object.keys(dictOf(l)).sort();
const forms = (e: Entry): string[] => (typeof e === 'string' ? [e] : Object.values(e).filter((x): x is string => typeof x === 'string'));
const primaryOf = (code: string): string => code.split('-')[0].toLowerCase();
const categories = (l: Lang): string[] => new Intl.PluralRules(LANGS.find((x) => x.code === l)!.intlLocale).resolvedOptions().pluralCategories.slice().sort();

afterEach(() => setLang(SOURCE_LANG));

describe('레지스트리', () => {
  it('코드는 겹치지 않는 BCP 47 태그, intlLocale은 Intl이 지원', () => {
    expect(new Set(CODES).size).toBe(CODES.length);
    for (const l of LANGS) {
      expect(() => Intl.getCanonicalLocales(l.code), l.code).not.toThrow();
      expect(Intl.DateTimeFormat.supportedLocalesOf([l.intlLocale]), l.code).toHaveLength(1);
      expect(l.native.trim() && l.english.trim(), l.code).toBeTruthy();
    }
    expect(isLang(SOURCE_LANG) && isLang(FALLBACK_LANG)).toBe(true);
  });

  it('같은 언어(첫 하위 태그)의 변형 중 default는 최대 하나', () => {
    const byPrimary = new Map<string, number>();
    for (const l of LANGS as readonly LangDef[]) if (l.default) byPrimary.set(primaryOf(l.code), (byPrimary.get(primaryOf(l.code)) ?? 0) + 1);
    expect([...byPrimary.values()].every((n) => n === 1)).toBe(true);
  });

  it('LANGS 표시 이름(정확한 문자열)', () => {
    const byCode = Object.fromEntries(LANGS.map((x) => [x.code, [x.native, x.english]]));
    expect(byCode).toEqual({
      ko: ['한국어(대한민국)', 'Korean (South Korea)'],
      en: ['English (United States)', 'English (United States)'],
      ja: ['日本語 (日本)', 'Japanese (Japan)'],
      'es-419': ['Español (Latinoamérica)', 'Spanish (Latin America)'],
      'es-ES': ['Español (España)', 'Spanish (Spain)'],
      'pt-BR': ['Português (Brasil)', 'Portuguese (Brazil)'],
      fr: ['Français (France)', 'French (France)'],
      de: ['Deutsch (Deutschland)', 'German (Germany)'],
      it: ['Italiano (Italia)', 'Italian (Italy)'],
      nl: ['Nederlands', 'Dutch'],
      id: ['Indonesia (Indonesia)', 'Indonesian (Indonesia)'],
      fil: ['Filipino', 'Filipino'],
      vi: ['Tiếng Việt', 'Vietnamese'],
      tr: ['Türkçe', 'Turkish'],
      'zh-CN': ['中文（简体）', 'Chinese (Simplified)'],
      'zh-TW': ['中文（繁體）', 'Chinese (Traditional)'],
      ru: ['Русский (Россия)', 'Russian (Russia)'],
      uk: ['Українська (Україна)', 'Ukrainian (Ukraine)'],
      da: ['Dansk (Danmark)', 'Danish (Denmark)'],
      sv: ['Svenska (Sverige)', 'Swedish (Sweden)'],
      nb: ['Norsk bokmål (Norge)', 'Norwegian Bokmål (Norway)'],
      fi: ['Suomi (Suomi)', 'Finnish (Finland)'],
      hi: ['हिन्दी (भारत)', 'Hindi (India)'],
      bn: ['বাংলা (ভারত)', 'Bengali (India)'],
      ta: ['தமிழ் (இந்தியா)', 'Tamil (India)'],
      te: ['తెలుగు (భారతదేశం)', 'Telugu (India)'],
      mr: ['मराठी (भारत)', 'Marathi (India)'],
      gu: ['ગુજરાતી (ભારત)', 'Gujarati (India)'],
      kn: ['ಕನ್ನಡ (ಭಾರತ)', 'Kannada (India)'],
      ml: ['മലയാളം (ഇന്ത്യ)', 'Malayalam (India)'],
      pa: ['ਪੰਜਾਬੀ (ਭਾਰਤ)', 'Punjabi (India)'],
    });
  });

  it('aliases는 다른 등록 언어의 첫 하위 태그·다른 alias와 겹치지 않는 언어 하위 태그', () => {
    const seen = new Map<string, string>();
    for (const l of LANGS as readonly LangDef[]) seen.set(primaryOf(l.code), l.code);
    for (const l of LANGS as readonly LangDef[]) {
      for (const a of l.aliases ?? []) {
        expect(a, l.code).toMatch(/^[a-z]{2,3}$/);
        expect(seen.has(a), `${l.code}: ${a}`).toBe(false);
        seen.set(a, l.code);
      }
    }
  });

  it('언어별 복수 범주(CLDR, Intl.PluralRules) — 사전 검사가 이 범주를 강제한다', () => {
    const got = Object.fromEntries(CODES.map((c) => [c, categories(c).join(',')]));
    expect(got).toMatchObject({
      fr: 'many,one,other', it: 'many,one,other', 'es-419': 'many,one,other', 'pt-BR': 'many,one,other',
      de: 'one,other', nl: 'one,other', tr: 'one,other', fil: 'one,other', en: 'one,other',
      id: 'other', vi: 'other', ko: 'other', ja: 'other',
      // 4라운드
      ru: 'few,many,one,other', uk: 'few,many,one,other',
      da: 'one,other', sv: 'one,other', nb: 'one,other', fi: 'one,other',
      'zh-CN': 'other', 'zh-TW': 'other',
      // 5라운드(인도계): 모두 one/other
      hi: 'one,other', bn: 'one,other', ta: 'one,other', te: 'one,other', mr: 'one,other',
      gu: 'one,other', kn: 'one,other', ml: 'one,other', pa: 'one,other',
    });
  });
});

describe('사전: 모든 등록 언어가 원문 사전과 맞는다', () => {
  it.each(CODES)('%s: 키 집합 = 원문 키 집합', (l) => {
    expect(keysOf(l)).toEqual(keysOf(SOURCE_LANG));
  });

  it.each(CODES)('%s: 빈 문자열 없음', (l) => {
    const empty = Object.entries(dictOf(l)).filter(([, v]) => forms(v as Entry).some((s) => s.trim() === '')).map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it.each(CODES)('%s: 원문 값의 백슬래시(경로 예시 C:\\... 등)가 사라지지 않는다(복수형은 모든 형태)', (l) => {
    const count = (x: string): number => x.split('\\').length - 1;
    const bad: string[] = [];
    for (const k of keysOf(SOURCE_LANG) as MsgKey[]) {
      const want = Math.max(...forms(dictOf(SOURCE_LANG)[k]).map(count));
      for (const x of forms(dictOf(l)[k])) if (count(x) < want) bad.push(`${k}: ${x}`);
    }
    expect(bad).toEqual([]);
  });

  it('사전 소스: 문자열 안의 \\ 뒤에는 \\ n t \' " u x 만 온다(\\. \\p 처럼 JS가 조용히 버리는 이스케이프 금지)', () => {
    const dir = join(__dirname, '../../src/shared/i18n');
    const STR = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
    const bad: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      readFileSync(join(dir, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (line.trimStart().startsWith('//')) return; // 주석의 따옴표는 문자열이 아니다
        for (const lit of line.match(STR) ?? []) {
          for (const m of lit.matchAll(/\\(.)/g)) if (!`\\nt'"ux`.includes(m[1])) bad.push(`${f}:${i + 1}: ${lit.slice(0, 80)}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it.each(CODES)('%s: 보간 토큰 {…}이 원문과 같다(복수형은 모든 형태)', (l) => {
    const bad: string[] = [];
    for (const k of keysOf(SOURCE_LANG) as MsgKey[]) {
      const base = tokensOf(forms(dictOf(SOURCE_LANG)[k])[0]).join(',');
      for (const s of forms(dictOf(l)[k])) if (tokensOf(s).join(',') !== base) bad.push(k);
    }
    expect(bad).toEqual([]);
  });

  it.each(CODES)('%s: 복수형 여부가 원문과 같고, 그 언어의 복수 범주를 빠짐없이·그것만 갖는다', (l) => {
    const want = categories(l);
    const bad: string[] = [];
    for (const k of keysOf(SOURCE_LANG) as MsgKey[]) {
      const src = dictOf(SOURCE_LANG)[k];
      const v = dictOf(l)[k];
      if ((typeof src === 'string') !== (typeof v === 'string')) bad.push(`${k}: plural mismatch`);
      else if (typeof v !== 'string' && Object.keys(v).sort().join(',') !== want.join(',')) bad.push(`${k}: ${Object.keys(v).join(',')}`);
      if (typeof src !== 'string' && !tokensOf(src.other).includes('n')) bad.push(`${k}: plural without {n}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('t(): 보간·복수형·숫자·fallback', () => {
  it('토큰 치환, 없는 토큰은 그대로, $ 패턴은 해석하지 않음', () => {
    expect(t('ko', 'common.noResults', { q: 'a$&b' })).toBe("'a$&b' 검색 결과 없음");
    expect(t('en', 'common.noResults')).toBe("No results for '{q}'");
  });

  it('복수형: Intl.PluralRules로 형태 선택(en one/other, ko·ja other)', () => {
    expect(t('en', 'filter.days', { n: 1 })).toBe('1 day');
    expect(t('en', 'filter.days', { n: 7 })).toBe('7 days');
    expect(t('en', 'tab.working', { n: 2 })).toBe('⚠ 2 tabs working');
    expect(t('ko', 'filter.days', { n: 1 })).toBe('1일');
    expect(t('ja', 'filter.days', { n: 30 })).toBe('30日');
    expect(t('en', 'filter.days')).toBe('{n} days'); // 수가 없으면 other
  });

  it('숫자 보간은 그 언어의 숫자 표시(자릿수 구분)', () => {
    expect(t('en', 'agents.defs', { n: 1234 })).toBe('1,234 agent definitions');
    expect(t('ko', 'agents.defs', { n: 1234 })).toBe('에이전트 정의 1,234개');
  });

  it('Msg 값은 같은 언어로 먼저 번역(언어를 바꾸면 다시 번역)', () => {
    const m = msg('sess.shellNotApplied', { current: msg('sess.unknown') });
    expect(resolveMsg(m)).toContain('확인된 셸: 알 수 없음');
    setLang('en');
    expect(resolveMsg(m)).toContain('detected shell: unknown');
    setLang('ja');
    expect(resolveMsg(m)).toContain('確認されたシェル：不明');
    expect(resolveMsg('plain')).toBe('plain');
  });

  it('사전에 키가 없으면 런타임 fallback: FALLBACK_LANG → SOURCE_LANG', () => {
    const ja = dictOf('ja') as Record<string, Entry>;
    const en = dictOf('en') as Record<string, Entry>;
    const savedJa = ja['common.cancel'];
    const savedEn = en['common.cancel'];
    try {
      delete ja['common.cancel'];
      expect(t('ja', 'common.cancel')).toBe(t(FALLBACK_LANG, 'common.cancel'));
      delete en['common.cancel'];
      expect(t('ja', 'common.cancel')).toBe(t(SOURCE_LANG, 'common.cancel'));
    } finally {
      ja['common.cancel'] = savedJa;
      en['common.cancel'] = savedEn;
    }
  });
});

describe('시스템 로케일 → UI 언어(등록 언어)', () => {
  it.each([
    [['ko-KR'], 'ko'], [['ko'], 'ko'], [['ja'], 'ja'], [['ja-JP'], 'ja'], [['en-US'], 'en'], [['en-GB'], 'en'], [['en'], 'en'],
    [['th-TH'], FALLBACK_LANG], [['sw-KE', 'ko-KR'], FALLBACK_LANG], [['am-ET'], FALLBACK_LANG],
    // 4라운드: 중국어는 스크립트·지역으로 번체/간체, 노르웨이어는 no → nb(aliases), 나머지는 단일 변형
    [['zh-CN'], 'zh-CN'], [['zh-TW'], 'zh-TW'], [['zh-HK'], 'zh-TW'], [['zh-MO'], 'zh-TW'], [['zh-SG'], 'zh-CN'], [['zh'], 'zh-CN'],
    [['zh-Hant'], 'zh-TW'], [['zh-Hans'], 'zh-CN'], [['zh-Hant-TW'], 'zh-TW'], [['zh-Hans-SG'], 'zh-CN'], [['zh_tw'], 'zh-TW'],
    [['ru-RU'], 'ru'], [['ru'], 'ru'], [['ru-BY'], 'ru'], [['uk-UA'], 'uk'], [['uk'], 'uk'],
    [['da-DK'], 'da'], [['da-GL'], 'da'], [['sv-SE'], 'sv'], [['sv-FI'], 'sv'], [['fi-FI'], 'fi'], [['fi'], 'fi'],
    [['nb-NO'], 'nb'], [['nb'], 'nb'], [['no'], 'nb'], [['no-NO'], 'nb'], [['nn-NO'], FALLBACK_LANG],
    // 5라운드: 인도계 9개는 단일 변형(지역 무관하게 언어 태그로). pa는 구르무키(Guru)로 등록: 샤무키(pa-Arab·pa-PK)는 FALLBACK_LANG
    [['hi-IN'], 'hi'], [['hi'], 'hi'], [['hi-IN', 'ko-KR'], 'hi'], [['bn-IN'], 'bn'], [['bn-BD'], 'bn'], [['ta-IN'], 'ta'], [['ta-LK'], 'ta'],
    [['te-IN'], 'te'], [['mr-IN'], 'mr'], [['gu-IN'], 'gu'], [['kn-IN'], 'kn'], [['ml-IN'], 'ml'], [['pa-IN'], 'pa'], [['pa-Guru-IN'], 'pa'],
    [['pa'], 'pa'], [['pa-Guru'], 'pa'], [['pa-PK'], FALLBACK_LANG], [['pa-Arab-PK'], FALLBACK_LANG], [['pa-Arab'], FALLBACK_LANG], [['pa-Arab-IN'], FALLBACK_LANG],
    [['zh-Latn'], FALLBACK_LANG], [['zh-Latn-CN'], FALLBACK_LANG],
    [['ur-IN'], FALLBACK_LANG], [['ne-NP'], FALLBACK_LANG],
    // 지역 변형: 정확 일치 우선, 아니면 같은 언어의 default(es-419·pt-BR)
    [['es-ES'], 'es-ES'], [['es-es'], 'es-ES'], [['es-419'], 'es-419'], [['es'], 'es-419'], [['es-MX'], 'es-419'], [['es-AR'], 'es-419'], [['es-US'], 'es-419'],
    [['pt-BR'], 'pt-BR'], [['pt'], 'pt-BR'], [['pt-PT'], 'pt-BR'],
    // 3라운드(단일 변형): 지역이 달라도 같은 언어로
    [['fr-FR'], 'fr'], [['fr'], 'fr'], [['fr-CA'], 'fr'], [['fr-BE'], 'fr'], [['fr-CH'], 'fr'],
    [['de-DE'], 'de'], [['de'], 'de'], [['de-AT'], 'de'], [['de-CH'], 'de'], [['de-DE', 'ko-KR'], 'de'],
    [['it-IT'], 'it'], [['it-CH'], 'it'], [['nl-NL'], 'nl'], [['nl-BE'], 'nl'],
    [['id-ID'], 'id'], [['id'], 'id'], [['in-ID'], 'id'], [['vi-VN'], 'vi'], [['vi'], 'vi'], [['tr-TR'], 'tr'], [['tr'], 'tr'],
    // 필리핀어: 표준 태그 fil, 옛 코드 tl(Tagalog)도 fil로(aliases)
    [['fil-PH'], 'fil'], [['fil'], 'fil'], [['tl'], 'fil'], [['tl-PH'], 'fil'], [['TL_ph'], 'fil'],
    [[], FALLBACK_LANG], [[''], FALLBACK_LANG], [[null, undefined, ' ', 'ja_JP'], 'ja'], [['KO-kr'], 'ko'],
  ] as [(string | null | undefined)[], Lang][])('%j → %s', (input, want) => {
    expect(langFromLocales(input)).toBe(want);
  });

  // 지역 변형 언어 추가(es-419·es-ES·pt-BR 등)에 대비한 일반 규칙: ① 전체 태그 일치 ② 같은 언어의 default 변형 ③ 없음
  const fake = (code: string, def = false): LangDef => ({ code, native: code, english: code, intlLocale: code, default: def, dict: dictOf('en') });
  const REG: LangDef[] = [fake('es-419', true), fake('es-ES'), fake('pt-BR', true), fake('zh-Hant'), fake('zh-Hans', true), fake('ko', true)];
  it.each([
    ['es-ES', 'es-ES'], ['es-es', 'es-ES'], ['es-419', 'es-419'], ['es-MX', 'es-419'], ['es', 'es-419'], ['pt', 'pt-BR'], ['pt-PT', 'pt-BR'],
    ['zh-Hant', 'zh-Hant'], ['ko-KR', 'ko'], ['de-DE', null], ['', null],
  ] as [string, string | null][])('matchLang(%s) → %s', (tag, want) => {
    expect(matchLang(tag, REG)).toBe(want);
  });

  it('default 표시가 없으면 같은 언어의 첫 변형', () => {
    expect(matchLang('fr-CA', [fake('fr-FR'), fake('fr-BE')])).toBe('fr-FR');
  });

  it('aliases: 옛 언어 하위 태그를 등록 언어로(정확 일치 우선, 변형이 여럿이면 default)', () => {
    const he: LangDef = { ...fake('he', true), aliases: ['iw'] };
    const nb: LangDef = { ...fake('nb-NO', true), aliases: ['no'] };
    const list = [he, nb, fake('nn-NO'), fake('ko', true)];
    expect(matchLang('iw-IL', list)).toBe('he');
    expect(matchLang('iw', list)).toBe('he');
    expect(matchLang('no', list)).toBe('nb-NO');
    expect(matchLang('no-NO', list)).toBe('nb-NO');
    expect(matchLang('nn-NO', list)).toBe('nn-NO'); // 정확 일치가 alias보다 먼저
    expect(matchLang('ko-KR', list)).toBe('ko');
    expect(matchLang('tl-PH', list)).toBeNull(); // alias를 가진 언어가 없으면 그대로
  });

  it('script: 같은 언어가 문자 체계로 갈리면 태그의 스크립트·지역에 맞는 변형(없으면 default)', () => {
    const tw: LangDef = { ...fake('zh-TW'), script: 'Hant' };
    const cn: LangDef = { ...fake('zh-CN', true), script: 'Hans' };
    const list = [tw, cn, fake('ko', true)];
    expect(matchLang('zh-TW', list)).toBe('zh-TW'); // 정확 일치
    expect(matchLang('zh-HK', list)).toBe('zh-TW'); // 지역 → Hant
    expect(matchLang('zh-MO', list)).toBe('zh-TW');
    expect(matchLang('zh-SG', list)).toBe('zh-CN'); // 지역 → Hans
    expect(matchLang('zh-Hant', list)).toBe('zh-TW'); // 명시적 스크립트
    expect(matchLang('zh-Hant-HK', list)).toBe('zh-TW');
    expect(matchLang('zh-hans-cn', list)).toBe('zh-CN');
    expect(matchLang('zh-Hans-TW', list)).toBe('zh-CN'); // 스크립트가 지역보다 우선
    expect(matchLang('zh', list)).toBe('zh-CN'); // 스크립트를 모르면 default
    expect(matchLang('zh-XX', list)).toBe('zh-CN');
    expect(matchLang('zh-Latn', list)).toBeNull(); // 스크립트를 아는데 변형이 모두 다른 스크립트로 표시돼 있으면 없음(→ FALLBACK_LANG)
    expect(matchLang('zh-Latn', [fake('zh-TW'), cn])).toBe('zh-CN'); // script 없는 변형이 섞여 있으면 기존 규칙(default)
    // script 없는 등록 언어는 기존 규칙 그대로(지역 변형 → default)
    expect(matchLang('es-MX', REG)).toBe('es-419');
  });

  it('isLang은 레지스트리 코드만(대소문자 구분)', () => {
    expect(CODES.every(isLang)).toBe(true);
    for (const v of ['KO', 'zh', 'tl', 'in', 'de-DE', 'FR', '', null, undefined, 1, {}]) expect(isLang(v)).toBe(false);
  });
});

describe('언어 검색(filterLangs)', () => {
  const codes = (q: string): string[] => filterLangs(q).map((x) => x.code);
  it('빈 검색어(공백 포함)는 전체, 영어 이름 알파벳순', () => {
    const all = sortedLangs(LANGS).map((x) => x.code);
    expect(codes('')).toEqual(all);
    expect(codes('   ')).toEqual(all);
    expect(all).toEqual(['bn', 'zh-CN', 'zh-TW', 'da', 'nl', 'en', 'fil', 'fi', 'fr', 'de', 'gu', 'hi', 'id', 'it', 'ja', 'kn', 'ko', 'ml', 'mr', 'nb', 'pt-BR', 'pa', 'ru', 'es-419', 'es-ES', 'sv', 'ta', 'te', 'tr', 'uk', 'vi']);
  });
  it('등록 순서와 무관하게 영어 이름 순', () => {
    const list: LangDef[] = [{ ...LANGS[2] }, { ...LANGS[0] }, { ...LANGS[1] }];
    expect(filterLangs('', list).map((x) => x.english)).toEqual(['English (United States)', 'Japanese (Japan)', 'Korean (South Korea)']);
  });
  it('네이티브·영어 이름 모두 대소문자 무시 부분 일치', () => {
    expect(codes('한국')).toEqual(['ko']);
    expect(codes('KOREA')).toEqual(['ko']);
    expect(codes('日本')).toEqual(['ja']);
    expect(codes('japan')).toEqual(['ja']);
    expect(codes(' english ')).toEqual(['en']);
    // Danish/Danmark·Nederlands·Finland·French/Français·German/Deutschland·Indonesian·Italian/Italiano·Japanese·Kannada·Korean·Norwegian·Russian·Spanish(×2)·Ukrainian
    expect(codes('an')).toEqual(['da', 'nl', 'fi', 'fr', 'de', 'id', 'it', 'ja', 'kn', 'ko', 'nb', 'ru', 'es-419', 'es-ES', 'uk']);
    expect(codes('español')).toEqual(['es-419', 'es-ES']);
    expect(codes('BRASIL')).toEqual(['pt-BR']);
    expect(codes('deutsch')).toEqual(['de']);
    expect(codes('TÜRK')).toEqual(['tr']);
    expect(codes('tiếng')).toEqual(['vi']);
    expect(codes('filipino')).toEqual(['fil']);
    expect(codes('indonesia')).toEqual(['id']);
    expect(codes('zz')).toEqual([]);
  });
});

describe('settings.json language', () => {
  it('등록된 값은 그대로, 무효·없음은 빈 값(= 시스템 언어)', () => {
    for (const c of CODES) expect(normalizeSettings({ language: c }).language).toBe(c);
    for (const bad of ['JA', 'zh', 'tl', 'in', 'fr-FR', '', 1, null, ['ko'], { ko: 1 }]) expect(normalizeSettings({ language: bad }).language).toBe('');
    expect(normalizeSettings({}).language).toBe('');
    expect(DEFAULT_SETTINGS.language).toBe('');
  });

  it('기존 파일(language 없음)은 다른 값이 그대로 읽힌다', () => {
    expect(normalizeSettings({ theme: 'dark', fontSize: 15 })).toMatchObject({ theme: 'dark', fontSize: 15, language: '' });
  });

  it('고르지 않았으면 파일에 쓰지 않고, 고른 값만 쓴다', () => {
    expect('language' in diffFromDefaults(normalizeSettings({ theme: 'dark' }))).toBe(false);
    expect(diffFromDefaults(normalizeSettings({ language: 'ko' }))).toEqual({ language: 'ko' });
  });
});

describe('현재 언어 전환이 문구·Intl 표기에 반영된다', () => {
  it('렌더러·main 순수 함수(휴지통 문구·경로 거부·세션 끊기 실패)', () => {
    expect(getLang()).toBe(SOURCE_LANG);
    setLang('en');
    expect(trashMessage('A', 1)).toBe("'A' will be moved to the Recycle Bin, along with 1 related teammate or subagent record.");
    expect(trashMessage('A', 3)).toBe("'A' will be moved to the Recycle Bin, along with 3 related teammate and subagent records.");
    expect(quoteMention('rel.txt')).toEqual({ ok: false, reason: 'Not an absolute path: rel.txt' });
    expect(stopFailMessage('not-running')).toBe('No running session.');
    setLang('ja');
    expect(trashMessage('A', 0)).toBe('「A」をごみ箱に移動します。');
    expect(tr('ipc.failed', { what: tr('action.sendMessage'), msg: 'boom' })).toBe('メッセージの送信に失敗しました：boom');
  });

  it('날짜 그룹·어제·상대 시간·날짜·퍼센트는 Intl(현재 로케일)', () => {
    const now = new Date(2026, 9, 22, 12, 0);
    const yesterday = new Date(2026, 9, 21, 9, 0).getTime();
    const thisYear = new Date(2026, 0, 2, 9, 5).getTime();
    const lastYear = new Date(2025, 9, 21).getTime();
    expect(dateBucketName('today')).toBe('오늘');
    expect(formatTime(yesterday, now)).toBe('어제');
    expect(formatTime(thisYear, now)).toBe('01. 02.');
    expect(formatTime(lastYear, now)).toBe('2025. 10. 21.');
    setLang('en');
    expect(dateBucketName('today')).toBe('Today');
    expect(dateBucketName('week')).toBe('Last 7 days');
    expect(formatTime(yesterday, now)).toBe('Yesterday');
    expect(formatTime(thisYear, now)).toBe('01/02');
    expect(formatTime(lastYear, now)).toBe('10/21/2025');
    expect(formatDate(thisYear, 'time')).toBe('09:05');
    expect(formatAgo(now.getTime() - 5 * 60_000, now.getTime())).toBe('5 minutes ago');
    expect(formatAgo(now.getTime() - 60 * 60_000, now.getTime())).toBe('1 hour ago');
    expect(formatPercent(79.6)).toBe('80%');
    setLang('es-419');
    expect(relativeDayName(-1)).toBe('Ayer');
    expect(t('es-419', 'filter.days', { n: 1 })).toBe('1 día');
    expect(t('es-ES', 'filter.days', { n: 7 })).toBe('7 días');
    expect(t('pt-BR', 'tab.working', { n: 3 })).toBe('⚠ 3 guias trabalhando');
    expect(t('es-ES', 'card.addDir')).toBe('Añadir carpeta…');
    expect(t('es-419', 'card.addDir')).toBe('Agregar carpeta…');
    expect(t('es-ES', 'common.cancel')).toBe('Cancelar'); // es-419에서 물려받음
    expect(formatAgo(now.getTime() - 60_000, now.getTime())).toBe('Hace 1 min');
    setLang('pt-BR');
    expect(formatAgo(now.getTime() - 3 * 3600_000, now.getTime())).toBe('Há 3 h');
    setLang('ja');
    expect(formatAgo(now.getTime() - 5 * 60_000, now.getTime())).toBe('5分前');
    expect(relativeDayName(-1)).toBe('昨日');
    expect(formatTime(lastYear, now)).toBe('2025/10/21');
    expect(formatAgo(now.getTime() - 10_000, now.getTime())).toBe('たった今');
    expect(pctText({ pct: 3.4, resetsAt: null })).toBe('3%');
  });

  it('5라운드 언어(인도계): 복수 one/other, 인도식 자릿수(12,34,567)와 라틴 숫자(bn·mr는 -u-nu-latn), 상태 라벨', () => {
    const INDIC = ['hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'pa'] as Lang[];
    // 인도 숫자 체계: 천 단위 다음은 두 자리씩(CLDR에서 kn만 서양식). bn·mr는 기본 숫자 체계가 벵골·데바나가리 숫자라 라틴 숫자를 강제한다
    for (const l of INDIC) expect(t(l, 'filter.days', { n: 1_234_567 }), l).toMatch(l === 'kn' ? /^1,234,567 / : /^12,34,567 /);
    expect(t('ta', 'filter.days', { n: 1 })).toBe('1 நாள்');
    expect(t('ta', 'filter.days', { n: 2 })).toBe('2 நாட்கள்');
    for (const l of INDIC) {
      expect(t(l, 'common.saving'), l).not.toBe(t(l, 'common.save'));
      const failed = t(l, 'ipc.failed', { what: t(l, 'action.openSession'), msg: 'boom' });
      expect(failed, l).toContain('boom');
      expect(failed, l).toContain(t(l, 'action.openSession'));
      expect(failed, l).not.toContain('{');
      expect((LANGS as readonly LangDef[]).find((x) => x.code === l)!.fontFallback, l).toEqual(['Nirmala UI']);
    }
  });

  it('런타임 ICU에 데이터가 있으면(Node full ICU) 모든 언어가 intlLocale로 표기, relativeDays는 그 언어 Intl 출력과 같다', () => {
    for (const l of LANGS) expect(formatLocale(l.code), l.code).toBe(l.intlLocale);
    for (const l of LANGS as readonly LangDef[]) {
      if (!l.relativeDays) continue;
      const rtf = new Intl.RelativeTimeFormat(l.intlLocale, { numeric: 'auto' });
      expect([rtf.format(0, 'day'), rtf.format(-1, 'day')], l.code).toEqual([l.relativeDays.today, l.relativeDays.yesterday]);
    }
    setLang('pa');
    expect([relativeDayName(0), relativeDayName(-1)]).toEqual(['ਅੱਜ', 'ਬੀਤਿਆ ਕੱਲ੍ਹ']);
  });

  it('런타임 ICU에 데이터가 없으면(Electron의 pa) 날짜·숫자·정렬은 intlFallback, 상대 날짜는 relativeDays, 복수형·html lang은 그대로', () => {
    const asked: string[] = [];
    setIntlSupportForTest((loc) => (asked.push(loc), primaryOf(loc) !== 'pa'));
    try {
      expect(formatLocale('pa')).toBe('en-IN');
      for (const l of LANGS) if (l.code !== 'pa') expect(formatLocale(l.code), l.code).toBe(l.intlLocale);
      expect(intlLocale('pa')).toBe('pa-IN');
      expect(langTag('pa')).toBe('pa-IN'); // html lang은 대체 로케일과 무관(글꼴·스크린 리더)
      setLang('pa');
      expect(relativeDayName(0)).toBe('ਅੱਜ');
      expect(relativeDayName(-1)).toBe('ਬੀਤਿਆ ਕੱਲ੍ਹ');
      expect(relativeDayName(-2)).toBe(new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' }).format(-2, 'day'));
      const ms = new Date(2026, 9, 29, 13, 5).getTime();
      expect(formatDate(ms, 'monthDayTime')).toBe(new Intl.DateTimeFormat('en-IN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms));
      expect(formatDate(ms, 'date')).toBe('29/10/2026');
      expect(formatPercent(42)).toBe('42%');
      expect(t('pa', 'filter.days', { n: 1_234_567.5 })).toBe('12,34,567.5 ਦਿਨ');
      expect(['b10', 'a2', 'B1', 'a10'].sort(compareText)).toEqual(['a2', 'a10', 'B1', 'b10']);
      // 복수형은 pa 규칙(0도 one): en-IN이었다면 0은 other
      expect(t('pa', 'filter.days', { n: 0 })).toBe('0 ਦਿਨ');
      expect(asked.filter((l) => l === 'pa-IN')).toHaveLength(1); // 로케일별 1회만 확인(캐시)
      expect(asked.every((l) => l === 'pa-IN')).toBe(true); // intlFallback이 없는 언어는 확인하지 않는다(기존 동작 그대로)
    } finally {
      setIntlSupportForTest(null);
    }
    expect(formatLocale('pa')).toBe('pa-IN');
  });

  it('langTag(html lang): intlLocale에서 -u- 확장만 뺀다', () => {
    expect(langTag('bn')).toBe('bn-IN');
    expect(langTag('mr')).toBe('mr-IN');
    expect(langTag('pa')).toBe('pa-IN');
    expect(langTag('zh-TW')).toBe('zh-TW');
    expect(langTag('es-419')).toBe('es-419');
    for (const l of LANGS) if (!l.intlLocale.includes('-u-')) expect(langTag(l.code), l.code).toBe(l.intlLocale);
  });

  it('stripEndPunct: 데바나가리 단다(। ॥)도 떼어 낸다(문구 끝 । 와 겹치지 않게)', () => {
    expect(stripEndPunct('कुछ गलत हुआ।')).toBe('कुछ गलत हुआ');
    expect(stripEndPunct('ਕੁਝ ਗਲਤ ਹੋਇਆ ॥ ')).toBe('ਕੁਝ ਗਲਤ ਹੋਇਆ');
    expect(stripEndPunct('boom.!? ')).toBe('boom');
    expect(t('hi', 'app.restart', { msg: stripEndPunct('कुछ गलत हुआ।') })).toBe('कुछ गलत हुआ। ऐप को पुनः प्रारंभ करें।');
  });

  it('4라운드 언어: 슬라브 복수 4범주(1·2·5·21·11·1.5), 북유럽·중국어 복수, 동작 문구 조립, 상태 라벨', () => {
    const days = (l: Lang, ns: number[]): string[] => ns.map((n) => t(l, 'filter.days', { n }));
    expect(days('ru', [1, 2, 5, 21, 11, 1.5])).toEqual(['1 день', '2 дня', '5 дней', '21 день', '11 дней', '1,5 дня']);
    expect(days('uk', [1, 2, 5, 21, 11, 1.5])).toEqual(['1 день', '2 дні', '5 днів', '21 день', '11 днів', '1,5 дня']);
    expect(t('ru', 'tab.working', { n: 21 })).toBe('⚠ 21 вкладка в работе');
    expect(t('uk', 'tab.working', { n: 5 })).toBe('⚠ 5 вкладок працюють');
    expect(days('da', [1, 2])).toEqual(['1 dag', '2 dage']);
    expect(days('sv', [1, 2])).toEqual(['1 dag', '2 dagar']);
    expect(days('nb', [1, 2])).toEqual(['1 dag', '2 dager']);
    expect(days('fi', [1, 2])).toEqual(['1 päivä', '2 päivää']);
    expect(days('zh-CN', [1, 2])).toEqual(['1 天', '2 天']);
    expect(days('zh-TW', [1_000_000])).toEqual(['1,000,000 天']);
    const failed = (l: Lang): string => t(l, 'ipc.failed', { what: t(l, 'action.openSession'), msg: 'boom' });
    expect(failed('zh-CN')).toBe('打开会话失败：boom');
    expect(failed('zh-TW')).toBe('無法開啟工作階段：boom');
    expect(failed('ru')).toBe('Не удалось открыть сеанс: boom');
    expect(failed('uk')).toBe('Не вдалося відкрити сеанс: boom');
    expect(failed('da')).toBe('Kunne ikke åbne sessionen: boom');
    expect(failed('sv')).toBe('Det gick inte att öppna sessionen: boom');
    expect(failed('nb')).toBe('Kunne ikke åpne økten: boom');
    expect(failed('fi')).toBe('Istunnon avaaminen epäonnistui: boom');
    // open.where*는 전치사(또는 중국어 괄호·핀란드어 콜론)까지 포함해 runningElsewhere에 들어간다
    expect(t('ru', 'open.runningElsewhere', { where: t('ru', 'open.wherePsmux', { name: 'x' }) })).toMatch(/^Похоже, эта беседа выполняется в сеансе psmux «x»\./);
    expect(t('zh-TW', 'open.runningElsewhere', { where: t('zh-TW', 'open.wherePsmux', { name: 'x' }) })).toMatch(/^此對話似乎正在其他位置執行（psmux 工作階段「x」）。/);
    expect(t('fi', 'open.runningElsewhere', { where: t('fi', 'open.wherePsmux', { name: 'x' }) })).toMatch(/^Tämä keskustelu näyttää olevan käynnissä muualla: psmux-istunto ”x”\./);
    // sessions.open은 상태 라벨(명령형 아님), 진행 문구는 버튼과 다르다
    expect((['zh-CN', 'zh-TW', 'ru', 'uk', 'da', 'sv', 'nb', 'fi'] as Lang[]).map((l) => t(l, 'sessions.open'))).toEqual([
      '已在标签页中打开', '已在索引標籤中開啟', 'Открыт во вкладке', 'Відкрито у вкладці', 'Åben i en fane', 'Öppen i en flik', 'Åpen i fane', 'Avoinna välilehdessä',
    ]);
    for (const l of ['zh-CN', 'zh-TW', 'ru', 'uk', 'da', 'sv', 'nb', 'fi'] as Lang[]) expect(t(l, 'common.saving')).not.toBe(t(l, 'common.save'));
  });

  it('3라운드 언어: 복수 범주 경계(fr one=0·1, fr/it many=100만 단위), 동작 문구 조립, Intl 표기', () => {
    const now = new Date(2026, 9, 22, 12, 0);
    const lastYear = new Date(2025, 9, 21).getTime();
    const million = (loc: string): string => new Intl.NumberFormat(loc).format(1_000_000);
    expect(t('fr', 'filter.days', { n: 0 })).toBe('0 jour');
    expect(t('fr', 'filter.days', { n: 1 })).toBe('1 jour');
    expect(t('fr', 'filter.days', { n: 2 })).toBe('2 jours');
    expect(t('fr', 'filter.days', { n: 1_000_000 })).toBe(`${million('fr-FR')} de jours`);
    expect(t('fr', 'tab.working', { n: 1_000_000 })).toBe(`⚠ ${million('fr-FR')} d'onglets en activité`);
    expect(t('it', 'filter.days', { n: 1 })).toBe('1 giorno');
    expect(t('it', 'filter.days', { n: 21 })).toBe('21 giorni');
    expect(t('it', 'filter.days', { n: 1_000_000 })).toBe('1.000.000 di giorni');
    expect(t('de', 'filter.days', { n: 1 })).toBe('1 Tag');
    expect(t('de', 'time.daysAgo', { n: 5 })).toBe('Vor 5 Tagen');
    expect(t('nl', 'tab.working', { n: 2 })).toBe('⚠ 2 tabbladen bezig');
    expect(t('tr', 'filter.days', { n: 5 })).toBe('5 gün');
    expect(t('fil', 'filter.days', { n: 4 })).toBe('4 araw'); // fil: 4·6·9로 끝나면 other
    expect(t('id', 'filter.days', { n: 21 })).toBe('21 hari');
    expect(t('vi', 'filter.days', { n: 21 })).toBe('21 ngày');
    const failed = (l: Lang): string => t(l, 'ipc.failed', { what: t(l, 'action.openSession'), msg: 'boom' });
    expect(failed('fr')).toBe("Impossible d'ouvrir la session : boom");
    expect(failed('de')).toBe('Fehler beim Öffnen der Sitzung: boom');
    expect(failed('it')).toBe('Impossibile aprire la sessione: boom');
    expect(failed('nl')).toBe('Fout bij het openen van de sessie: boom');
    expect(failed('id')).toBe('Tidak dapat membuka sesi: boom');
    expect(failed('fil')).toBe('Hindi nagawang buksan ang session: boom');
    expect(failed('vi')).toBe('Không thể mở phiên: boom');
    expect(failed('tr')).toBe('Oturum başlatma başarısız oldu: boom');
    // sessions.open은 상태 라벨(명령형 아님)
    expect(['fr', 'de', 'it', 'nl', 'id', 'fil', 'vi', 'tr'].map((l) => t(l as Lang, 'sessions.open'))).toEqual([
      'Ouverte dans un onglet', 'In Tab geöffnet', 'Aperta in una scheda', 'Geopend in tabblad', 'Terbuka di tab', 'Bukas sa tab', 'Đang mở trong thẻ', 'Sekmede açık',
    ]);
    setLang('de');
    expect(relativeDayName(-1)).toBe('Gestern');
    expect(formatTime(lastYear, now)).toBe('21.10.2025');
    setLang('tr');
    expect(relativeDayName(-1)).toBe('Dün');
    setLang('vi');
    expect(relativeDayName(-1)).toBe('Hôm qua');
  });
});
