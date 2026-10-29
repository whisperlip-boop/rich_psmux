// Claude Code hook 이벤트 → 칸별 승인 대기 상태·이름 힌트. 순수 로직(단위 테스트 대상).
// 실측: --settings hooks가 리드·팀원 모두에 적용됨.

import type { PaneHint } from './paneMapper';

/** hookRecorder가 앱 폴더에 남기는 한 줄(본문·경로 없음). */
export interface HookRecord {
  t: number;
  event: string;
  sid?: string;
  pane?: string;
  agentType?: string;
  teammateName?: string;
  notificationType?: string;
  toolName?: string;
}

/** 칸별 승인 대기 상태. */
export interface HookState {
  waiting: Record<string, number>;
  hints: Record<string, PaneHint>;
  sidToPane: Record<string, string>;
}

/** 빈 상태. */
export function emptyHookState(): HookState {
  return { waiting: {}, hints: {}, sidToPane: {} };
}

// 승인 대기를 끝내는 이벤트(도구가 실행됐거나 차례가 끝남)
const CLEARING = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd', 'TeammateIdle']);

/**
 * hook 기록 1건을 상태에 반영한다.
 *
 * Args:
 *   st: 현재 상태(직접 수정).
 *   rec: hook 기록.
 *   leadPaneId: 리드 칸(칸 정보가 없는 리드 이벤트 매핑용).
 *   leadAgentType: 리드 agent 이름(예: ceo).
 *
 * Returns:
 *   이 기록이 적용된 칸 ID(찾지 못하면 null).
 */
export function applyHookRecord(st: HookState, rec: HookRecord, leadPaneId: string | null, leadAgentType: string): string | null {
  let pane = rec.pane && /^%\d+$/.test(rec.pane) ? rec.pane : undefined;
  if (!pane && rec.sid) pane = st.sidToPane[rec.sid];
  if (!pane && leadPaneId && rec.agentType === leadAgentType) pane = leadPaneId;
  if (!pane) return null;
  if (rec.sid) st.sidToPane[rec.sid] = pane;
  if (pane !== leadPaneId && (rec.agentType || rec.teammateName)) {
    const h = st.hints[pane] ?? {};
    st.hints[pane] = { agentType: rec.agentType ?? h.agentType, teammateName: rec.teammateName ?? h.teammateName };
  }
  if (rec.event === 'PermissionRequest' || (rec.event === 'Notification' && rec.notificationType === 'permission_prompt')) {
    st.waiting[pane] = rec.t;
  } else if (CLEARING.has(rec.event) || (rec.event === 'Notification' && rec.notificationType === 'idle_prompt')) {
    delete st.waiting[pane];
  }
  return pane;
}

/** JSON 한 줄을 HookRecord로 방어적으로 해석한다. 형식이 틀리면 null. */
export function parseHookLine(line: string): HookRecord | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o.event !== 'string' || typeof o.t !== 'number') return null;
    const s = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
    return { t: o.t, event: o.event, sid: s('sid'), pane: s('pane'), agentType: s('agentType'), teammateName: s('teammateName'), notificationType: s('notificationType'), toolName: s('toolName') };
  } catch {
    return null;
  }
}
