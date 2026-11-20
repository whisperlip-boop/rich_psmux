// 렌더러 진입점. 첫 화면이 다른 언어로 깜빡이지 않게 UI 언어를 먼저 받아 적용한 뒤 그린다.

import '@xterm/xterm/css/xterm.css';
import './styles.css';

import { render } from 'preact';

import { isLang, langFromLocales } from '../shared/i18n';
import { App } from './App';
import { applyLang } from './i18n';

/** 기동 직후 렌더러 멈춤 감시 기간·간격·경고 기준(ms). */
const LAG_PROBE_MS = 60_000;
const LAG_TICK_MS = 100;
const LAG_WARN_MS = 500;

// 기동 시간 진단: 처음 LAG_PROBE_MS 동안 렌더러 스레드가 LAG_WARN_MS 넘게 멈추면 기록한다(main 앱 로그로는 warn·error만 넘어간다).
// 창이 보이지 않을 때는 타이머가 늦춰지므로 세지 않는다
const probeStart = performance.now();
let probeLast = probeStart;
let probeMax = 0;
const probe = window.setInterval(() => {
  const now = performance.now();
  const lag = Math.round(now - probeLast - LAG_TICK_MS);
  probeLast = now;
  if (document.visibilityState !== 'visible') return;
  probeMax = Math.max(probeMax, lag);
  if (lag > LAG_WARN_MS) console.warn(`startup: renderer blocked ~${lag} ms (${Math.round(now - probeStart)} ms after renderer start)`);
}, LAG_TICK_MS);
window.setTimeout(() => {
  window.clearInterval(probe);
  console.warn(`startup: renderer loop probe done (max lag ${probeMax} ms in ${LAG_PROBE_MS / 1000} s)`);
}, LAG_PROBE_MS);

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
