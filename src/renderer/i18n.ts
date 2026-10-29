// 렌더러 언어 상태: 현재 언어는 shared/i18n의 프로세스 전역 하나(setLang)이고, App이 언어 state를 함께 바꿔 전체를 다시 그린다.
// 컴포넌트는 t(key)로 현재 언어 문구를 읽는다.

import type { ComponentChildren } from 'preact';

import { langDef, langTag, setLang, tr, type Lang, type LangDef, type MsgKey } from '../shared/i18n';

export { tr as t };

// 기본 UI 글꼴(styles.css :root --font-ui와 같은 순서). 언어의 fontFallback은 라틴 글꼴 뒤·한글 글꼴 앞에 넣는다:
// Malgun Gothic에도 가나·한자가 있어 그보다 뒤에 두면 그 언어 문자가 한국어 글꼴 모양으로 그려진다
const UI_FONT_LATIN = ['Segoe UI Variable', 'Segoe UI'];
const UI_FONT_TAIL = ['Malgun Gothic'];

/** 언어에 맞는 UI 글꼴 목록(CSS font-family 값). */
export function uiFontStack(def: LangDef): string {
  return [...UI_FONT_LATIN, ...(def.fontFallback ?? []), ...UI_FONT_TAIL].map((f) => `"${f.replace(/"/g, '')}"`).concat('sans-serif').join(', ');
}

/** 언어를 적용한다: 문구 + html lang(한자·가나 글리프 선택) + UI 글꼴 순서. */
export function applyLang(lang: Lang): void {
  setLang(lang);
  const root = document.documentElement;
  root.lang = langTag(lang);
  root.style.setProperty('--font-ui', uiFontStack(langDef(lang)));
}

/**
 * 문구 안 {이름} 자리에 요소(코드 등)를 넣어 조각 배열로 돌려준다. 어순이 언어마다 달라 문장을 쪼개지 않기 위해 쓴다.
 *
 * Args:
 *   key: 문구 키.
 *   nodes: 토큰 이름 → 넣을 요소.
 */
export function tx(key: MsgKey, nodes: Record<string, ComponentChildren>): ComponentChildren[] {
  // split에 캡처 그룹이 있으면 홀수 자리가 토큰 이름
  return tr(key).split(/\{(\w+)\}/).map((part, i) => (i % 2 === 1 ? (part in nodes ? nodes[part] : `{${part}}`) : part));
}
