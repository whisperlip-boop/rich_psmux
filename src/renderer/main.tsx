// 렌더러 진입점. 첫 화면이 다른 언어로 깜빡이지 않게 UI 언어를 먼저 받아 적용한 뒤 그린다.

import '@xterm/xterm/css/xterm.css';
import './styles.css';

import { render } from 'preact';

import { isLang, langFromLocales } from '../shared/i18n';
import { App } from './App';
import { applyLang } from './i18n';

void window.ctd.getLanguage()
  .catch((e: unknown) => {
    console.error(`[ipc] getLanguage failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  })
  .then((lang) => {
    // main이 답하지 못하면 브라우저 로케일에 같은 매핑 규칙(정확 일치 → 같은 언어의 default 변형 → FALLBACK_LANG)을 적용한다
    applyLang(isLang(lang) ? lang : langFromLocales([navigator.language]));
    render(<App />, document.getElementById('root')!);
  });
