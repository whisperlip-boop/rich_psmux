// 업데이트 확인·실행 화면 공용: 이름(고유명사, 번역 안 함), 체크 가능 여부, 카드 상태 문구. 순수 로직.

import type { UpdateItemId, UpdateRowDto, UpdateRunDto, UpdateStateDto, UpdateStepId } from '../shared/api';
import { t } from './i18n';

/** @update 카드만 두는 앱 탭 ID(탭이 하나도 없을 때 자동 생성, psmux 세션 아님). main 탭 ID(세션 이름)와 겹치지 않는다. */
export const UPDATE_TAB = '@update';

/** 표·카드에 쓰는 이름(제품명이라 번역하지 않는다). */
export const UPDATE_NAMES: Record<UpdateItemId, string> = { app: 'Rich psmux', pwsh: 'PowerShell 7', psmux: 'psmux', claude: 'Claude Code' };

/** 체크할 수 있는 행(업데이트 가능)인지. */
export const isSelectable = (r: UpdateRowDto | undefined): boolean => r?.status === 'available';

/** 체크 상태를 지금 표에 맞춘다(업데이트 가능이 아닌 행은 빠진다). */
export function effectiveChecked(state: UpdateStateDto | null, checked: ReadonlySet<UpdateItemId>): UpdateItemId[] {
  if (!state) return [];
  return state.rows.filter((r) => isSelectable(r) && checked.has(r.id)).map((r) => r.id);
}

/** 실행 중(시작 처리 = 세션 닫는 중 포함)이면 확인·업데이트 버튼을 막는다. 대화상자를 닫았다 다시 열어도 main 상태로 판단. */
export const isRunning = (state: UpdateStateDto | null): boolean => !!state?.starting || state?.run?.status === 'running';

/** 카드 이름표 상태: 실행 중 / 완료(실패 0) / 실패(실패 있음·중지). */
export function cardState(run: UpdateRunDto | null): 'running' | 'done' | 'failed' {
  if (!run || run.status === 'running') return 'running';
  return run.status === 'stopped' || run.fail > 0 ? 'failed' : 'done';
}

/** 카드 상태 표시줄 문구. */
export function cardStatusText(run: UpdateRunDto | null): string {
  if (!run) return '';
  if (run.status === 'running') {
    const i = run.steps.findIndex((s) => s.status === 'running' || s.status === 'pending');
    const k = Math.max(0, i);
    return t('update.cardRunning', { name: UPDATE_NAMES[run.steps[k].id], k: k + 1, n: run.steps.length });
  }
  const summary = t(run.status === 'stopped' ? 'update.cardStopped' : 'update.cardDone', { ok: run.ok, fail: run.fail });
  const failedNames = run.steps.filter((s) => s.status === 'failed').map((s) => t('update.cardStepFailed', { name: UPDATE_NAMES[s.id] }));
  // 실패 문구는 각각 한 마디(대문자로 시작하는 언어가 많음)라 목록 구분자(쉼표) 대신 요약 앞과 같은 · 로 잇는다
  return [...failedNames, summary].join(' · ');
}

/** 실행 단계 목록(체크한 항목 중 app 제외: app은 릴리스 페이지만 연다). */
export function stepsOf(ids: readonly UpdateItemId[]): UpdateStepId[] {
  return ids.filter((id): id is UpdateStepId => id !== 'app');
}
