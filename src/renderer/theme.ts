// 테마 적용(F8): <html data-theme="light|dark">. system은 OS 설정(prefers-color-scheme)을 따라 바뀐다.
// 터미널(xterm)은 양쪽 모두 #0C0C0C라 손대지 않는다.

import type { ThemeMode } from '../shared/api';

/** 설정값과 OS 다크 여부로 실제 테마를 정한다. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
}

let mode: ThemeMode = 'light';
let query: MediaQueryList | null = null;

/** 테마를 적용한다. system이면 OS 설정이 바뀔 때도 따라간다. */
export function applyTheme(next: ThemeMode): void {
  mode = next;
  if (!query) {
    query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', () => { if (mode === 'system') paint(); });
  }
  paint();
}

function paint(): void {
  document.documentElement.dataset.theme = resolveTheme(mode, !!query?.matches);
}
