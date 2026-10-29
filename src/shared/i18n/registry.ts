// 지원 언어 레지스트리. 새 언어 = 사전 파일 1개(<코드>.ts) + 아래 import 1줄 + LANGS 1줄(docs/i18n.md).
// 대화상자 목록·검색·시스템 로케일 매핑·settings.json 검증·사전 검사 테스트가 모두 이 배열을 돈다(코드를 다른 곳에 쓰지 않는다).

import { bn } from './bn';
import { da } from './da';
import { de } from './de';
import { en } from './en';
import { es419 } from './es-419';
import { esES } from './es-ES';
import { fi } from './fi';
import { fil } from './fil';
import { fr } from './fr';
import { gu } from './gu';
import { hi } from './hi';
import { id } from './id';
import { it } from './it';
import { ja } from './ja';
import { kn } from './kn';
import { ko } from './ko';
import { ml } from './ml';
import { mr } from './mr';
import { nb } from './nb';
import { nl } from './nl';
import { pa } from './pa';
import { ptBR } from './pt-BR';
import { ru } from './ru';
import { sv } from './sv';
import { ta } from './ta';
import { te } from './te';
import { tr } from './tr';
import { uk } from './uk';
import { vi } from './vi';
import { zhCN } from './zh-CN';
import { zhTW } from './zh-TW';
import type { Dict } from './types';

/** 언어 하나의 등록 정보. */
export interface LangDef {
  /** BCP 47 태그(예: 'ko', 'pt-BR', 'es-419'). 사전 파일 이름·settings.json 값과 같다. */
  code: string;
  /** 그 언어로 쓴 이름(선택 대화상자 굵은 줄). */
  native: string;
  /** 영어 이름(회색 줄, 목록 정렬 기준). */
  english: string;
  /** 복수형 기준 Intl 로케일. 날짜·숫자·정렬은 formatLocale(데이터가 없으면 intlFallback), html lang은 -u- 확장을 뺀 langTag. */
  intlLocale: string;
  /** 같은 언어(첫 하위 태그)의 변형이 여럿일 때 시스템 로케일이 정확히 맞지 않으면 고를 대표(예: es-MX → es-419). 언어마다 하나. */
  default?: boolean;
  /** 이 언어 UI에서 기본 라틴 글꼴 뒤·한글 글꼴 앞에 넣을 글꼴(그 문자를 제대로 그리는 Windows 글꼴). */
  fontFallback?: readonly string[];
  /** 같은 언어를 가리키는 다른(옛) 언어 하위 태그(예: fil ← 'tl'). 시스템 로케일 매핑에서만 쓰고 settings.json 값으로는 받지 않는다. */
  aliases?: readonly string[];
  /** 이 변형의 문자 체계(ISO 15924, 예: 'Hant'·'Hans'). 같은 언어의 변형이 문자 체계로 갈릴 때(중국어) 시스템 로케일의 스크립트·지역에 맞는 변형을 고른다. */
  script?: string;
  /**
   * 런타임 ICU에 이 언어의 날짜·숫자 데이터가 없을 때 날짜·숫자·정렬에 대신 쓸 로케일(복수형·html lang은 intlLocale 그대로).
   * Electron 번들 ICU(Chromium 축소판)에는 pa 데이터가 없어 root 표기(2026-10-29, 1,234,567, "Yesterday")가 나온다.
   */
  intlFallback?: string;
  /** intlFallback을 쓰는 동안의 상대 날짜 이름(그 언어 Intl.RelativeTimeFormat의 numeric:'auto' 출력 그대로). 사전이 아니라 여기 둔다. */
  relativeDays?: { readonly today: string; readonly yesterday: string };
  dict: Dict;
}

export const LANGS = [
  { code: 'en', native: 'English (United States)', english: 'English (United States)', intlLocale: 'en-US', default: true, dict: en },
  { code: 'ja', native: '日本語 (日本)', english: 'Japanese (Japan)', intlLocale: 'ja-JP', default: true, fontFallback: ['Yu Gothic UI', 'Meiryo'], dict: ja },
  { code: 'ko', native: '한국어(대한민국)', english: 'Korean (South Korea)', intlLocale: 'ko-KR', default: true, dict: ko },
  { code: 'es-419', native: 'Español (Latinoamérica)', english: 'Spanish (Latin America)', intlLocale: 'es-419', default: true, dict: es419 },
  { code: 'es-ES', native: 'Español (España)', english: 'Spanish (Spain)', intlLocale: 'es-ES', dict: esES },
  { code: 'pt-BR', native: 'Português (Brasil)', english: 'Portuguese (Brazil)', intlLocale: 'pt-BR', default: true, dict: ptBR },
  { code: 'fr', native: 'Français (France)', english: 'French (France)', intlLocale: 'fr-FR', default: true, dict: fr },
  { code: 'de', native: 'Deutsch (Deutschland)', english: 'German (Germany)', intlLocale: 'de-DE', default: true, dict: de },
  { code: 'it', native: 'Italiano (Italia)', english: 'Italian (Italy)', intlLocale: 'it-IT', default: true, dict: it },
  { code: 'nl', native: 'Nederlands', english: 'Dutch', intlLocale: 'nl-NL', default: true, dict: nl },
  { code: 'id', native: 'Indonesia (Indonesia)', english: 'Indonesian (Indonesia)', intlLocale: 'id-ID', default: true, aliases: ['in'], dict: id },
  { code: 'fil', native: 'Filipino', english: 'Filipino', intlLocale: 'fil-PH', default: true, aliases: ['tl'], dict: fil },
  { code: 'vi', native: 'Tiếng Việt', english: 'Vietnamese', intlLocale: 'vi-VN', default: true, dict: vi },
  { code: 'tr', native: 'Türkçe', english: 'Turkish', intlLocale: 'tr-TR', default: true, dict: tr },
  { code: 'zh-CN', native: '中文（简体）', english: 'Chinese (Simplified)', intlLocale: 'zh-CN', default: true, script: 'Hans', fontFallback: ['Microsoft YaHei UI'], dict: zhCN },
  { code: 'zh-TW', native: '中文（繁體）', english: 'Chinese (Traditional)', intlLocale: 'zh-TW', script: 'Hant', fontFallback: ['Microsoft JhengHei UI'], dict: zhTW },
  { code: 'ru', native: 'Русский (Россия)', english: 'Russian (Russia)', intlLocale: 'ru-RU', default: true, dict: ru },
  { code: 'uk', native: 'Українська (Україна)', english: 'Ukrainian (Ukraine)', intlLocale: 'uk-UA', default: true, dict: uk },
  { code: 'da', native: 'Dansk (Danmark)', english: 'Danish (Denmark)', intlLocale: 'da-DK', default: true, dict: da },
  { code: 'sv', native: 'Svenska (Sverige)', english: 'Swedish (Sweden)', intlLocale: 'sv-SE', default: true, dict: sv },
  { code: 'nb', native: 'Norsk bokmål (Norge)', english: 'Norwegian Bokmål (Norway)', intlLocale: 'nb-NO', default: true, aliases: ['no'], dict: nb },
  { code: 'fi', native: 'Suomi (Suomi)', english: 'Finnish (Finland)', intlLocale: 'fi-FI', default: true, dict: fi },
  { code: 'hi', native: 'हिन्दी (भारत)', english: 'Hindi (India)', intlLocale: 'hi-IN', default: true, fontFallback: ['Nirmala UI'], dict: hi },
  // bn·mr: CLDR 기본 숫자가 벵골·데바나가리 숫자라 -u-nu-latn으로 라틴 숫자를 강제한다(앱의 다른 숫자·시각 표기와 맞춤). html lang에는 붙이지 않는다(langTag)
  { code: 'bn', native: 'বাংলা (ভারত)', english: 'Bengali (India)', intlLocale: 'bn-IN-u-nu-latn', default: true, fontFallback: ['Nirmala UI'], dict: bn },
  { code: 'ta', native: 'தமிழ் (இந்தியா)', english: 'Tamil (India)', intlLocale: 'ta-IN', default: true, fontFallback: ['Nirmala UI'], dict: ta },
  { code: 'te', native: 'తెలుగు (భారతదేశం)', english: 'Telugu (India)', intlLocale: 'te-IN', default: true, fontFallback: ['Nirmala UI'], dict: te },
  // mr: bn과 같은 이유로 -u-nu-latn(데바나가리 숫자 대신 라틴 숫자)
  { code: 'mr', native: 'मराठी (भारत)', english: 'Marathi (India)', intlLocale: 'mr-IN-u-nu-latn', default: true, fontFallback: ['Nirmala UI'], dict: mr },
  { code: 'gu', native: 'ગુજરાતી (ભારત)', english: 'Gujarati (India)', intlLocale: 'gu-IN', default: true, fontFallback: ['Nirmala UI'], dict: gu },
  { code: 'kn', native: 'ಕನ್ನಡ (ಭಾರತ)', english: 'Kannada (India)', intlLocale: 'kn-IN', default: true, fontFallback: ['Nirmala UI'], dict: kn },
  { code: 'ml', native: 'മലയാളം (ഇന്ത്യ)', english: 'Malayalam (India)', intlLocale: 'ml-IN', default: true, fontFallback: ['Nirmala UI'], dict: ml },
  { code: 'pa', native: 'ਪੰਜਾਬੀ (ਭਾਰਤ)', english: 'Punjabi (India)', intlLocale: 'pa-IN', default: true, script: 'Guru', fontFallback: ['Nirmala UI'],
    intlFallback: 'en-IN', relativeDays: { today: 'ਅੱਜ', yesterday: 'ਬੀਤਿਆ ਕੱਲ੍ਹ' }, dict: pa },
] as const satisfies readonly LangDef[];

/** 지원 언어 코드(레지스트리에서 도출). */
export type Lang = (typeof LANGS)[number]['code'];

/** 원문 사전 언어(키 집합 기준, 언어를 정하기 전 기본값 — 단위 테스트가 이 언어 문구를 기대한다). */
export const SOURCE_LANG: Lang = 'ko';
/** 시스템 로케일이 등록 언어와 맞지 않을 때, 그리고 사전에 키가 없을 때 먼저 쓰는 언어. */
export const FALLBACK_LANG: Lang = 'en';
