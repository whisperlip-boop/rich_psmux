// 칸 ↔ 팀원 이름·색 매핑. 순수 로직(단위 테스트 대상).
// 팀 config의 tmuxPaneId: 팀원은 %N, 리드는 "leader"(실측).

import { isPlainLeadCommand, PLAIN_LEAD_COMMAND } from '../../shared/agents';

/** config.json에서 앱이 쓰는 멤버 필드만(prompt 등 본문은 버림). */
export interface MemberInfo {
  name: string;
  agentType: string;
  tmuxPaneId: string;
  color?: string;
  isLead: boolean;
}

/** 정제된 팀 config. */
export interface TeamConfig {
  name?: string;
  leadSessionId?: string;
  members: MemberInfo[];
}

/** 카드 이름표. */
export interface PaneLabel {
  name: string;
  /** 리드는 글자색, 팀원은 배경색. */
  color: string;
  /** 팀원 라벨 글자색(배경 휘도로 결정). */
  textColor: string;
  agentType?: string;
  isLead: boolean;
  source: 'lead' | 'config' | 'hook' | 'cache' | 'fallback';
}

/** hook으로 알게 된 칸별 힌트(hook 프로세스 env의 TMUX_PANE + stdin 필드). */
export interface PaneHint {
  agentType?: string;
  teammateName?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * config.json 원본을 방어적으로 정제한다. 필드가 없거나 타입이 달라도 예외 없이 빈 값으로 처리.
 *
 * Args:
 *   raw: JSON.parse 결과.
 *
 * Returns:
 *   필요한 필드만 남긴 config.
 */
export function sanitizeConfig(raw: unknown): TeamConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const members = Array.isArray(o.members) ? o.members : [];
  return {
    name: str(o.name),
    leadSessionId: str(o.leadSessionId),
    members: members
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof (m as Record<string, unknown>).name === 'string')
      .map((m) => {
        const name = m.name as string;
        const agentType = str(m.agentType) ?? '';
        return {
          name,
          agentType,
          tmuxPaneId: str(m.tmuxPaneId) ?? '',
          color: str(m.color),
          isLead: name === 'team-lead' || agentType === 'team-lead' || m.backendType === 'in-process',
        };
      }),
  };
}

// 팔레트 P0~P9(글자 #1F2328 기준 대비 4.7:1 이상)
export const PALETTE = ['#E06666', '#F6A04D', '#F1C232', '#00B050', '#45C4B0', '#8EA9DB', '#B4A7D6', '#EA9AC8', '#A3C585', '#C9A27E'];
// Claude Code 팀원 색 이름 → 팔레트
const NAMED_COLORS: Record<string, string> = {
  red: PALETTE[0], orange: PALETTE[1], yellow: PALETTE[2], green: PALETTE[3], cyan: PALETTE[4],
  blue: PALETTE[5], purple: PALETTE[6], pink: PALETTE[7], olive: PALETTE[8], tan: PALETTE[9],
};
/** 리드 라벨 글자색(배경 없음). */
export const LEAD_COLOR = '#CF222E';
/** 팀원 라벨 기본 글자색. */
export const LABEL_TEXT = '#1F2328';

/** 이름 기반 고정 색: FNV-1a(이름) % 10. 같은 이름은 항상 같은 색. */
export function hashColor(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

/** 색 결정: config color 이름 → hex 그대로 → 이름 해시. */
export function colorFor(name: string, configColor?: string): string {
  const c = configColor?.trim().toLowerCase();
  if (c && NAMED_COLORS[c]) return NAMED_COLORS[c];
  if (c && /^#[0-9a-f]{6}$/.test(c)) return c.toUpperCase();
  return hashColor(name);
}

/** 배경 hex의 상대휘도(WCAG)가 0.179 초과면 #1F2328, 이하면 #FFFFFF. */
export function textColorFor(bg: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg);
  if (!m) return LABEL_TEXT;
  const lin = (h: string): number => {
    const v = parseInt(h, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
  return l > 0.179 ? LABEL_TEXT : '#FFFFFF';
}

function mateLabel(name: string, color: string, agentType: string | undefined, source: PaneLabel['source']): PaneLabel {
  return { name, color, textColor: textColorFor(color), agentType, isLead: false, source };
}

/** 리드 실행 명령에서 --agent 값을 꺼낸다(카드 이름 @ceo용). 없으면 'lead', 옵션 없는 `claude`(Claude만 탭)는 'claude'. */
export function leadNameFromCommand(cmd: string): string {
  if (isPlainLeadCommand(cmd)) return PLAIN_LEAD_COMMAND;
  const m = /--agent(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? 'lead';
}

/** 매핑 입력. */
export interface ResolveInput {
  panes: string[];
  leadPaneId: string | null;
  leadName: string;
  config: TeamConfig | null;
  cache: Record<string, PaneLabel>;
  hints: Record<string, PaneHint>;
}

/**
 * 칸마다 이름표를 정한다. 우선순위: 리드 칸 → config tmuxPaneId → hook 힌트 → 캐시 → %N 임시 표시.
 * 확정된 매핑(lead/config/hook)은 캐시에 남겨 config가 지워진 뒤에도 이름을 유지한다(F3).
 *
 * Returns:
 *   labels: 칸별 이름표, cache: 갱신된 캐시.
 */
export function resolveLabels(input: ResolveInput): { labels: Record<string, PaneLabel>; cache: Record<string, PaneLabel> } {
  const { panes, leadPaneId, leadName, config, cache, hints } = input;
  const labels: Record<string, PaneLabel> = {};
  const nextCache: Record<string, PaneLabel> = { ...cache };
  const mates = (config?.members ?? []).filter((m) => !m.isLead);
  for (const pane of panes) {
    let label: PaneLabel | null = null;
    if (pane === leadPaneId) {
      label = { name: leadName, color: LEAD_COLOR, textColor: LEAD_COLOR, isLead: true, agentType: leadName, source: 'lead' };
    } else {
      const byPane = mates.find((m) => m.tmuxPaneId === pane);
      const hint = hints[pane];
      const byHint = hint
        ? (hint.teammateName ? mates.find((m) => m.name === hint.teammateName) : undefined)
          ?? uniqueBy(mates, (m) => m.agentType === hint.agentType)
        : undefined;
      const m = byPane ?? byHint;
      if (m) label = mateLabel(m.name, colorFor(m.name, m.color), m.agentType, byPane ? 'config' : 'hook');
      else if (hint?.teammateName) label = mateLabel(hint.teammateName, colorFor(hint.teammateName), hint.agentType, 'hook');
      else if (cache[pane]) label = { ...cache[pane], textColor: cache[pane].textColor ?? textColorFor(cache[pane].color), source: 'cache' };
    }
    if (label && label.source !== 'cache') nextCache[pane] = { ...label };
    labels[pane] = label ?? fallbackLabel(pane);
  }
  return { labels, cache: nextCache };
}

/** 매핑 전 임시 라벨(%N, 점선 테두리). */
export function fallbackLabel(pane: string): PaneLabel {
  return { name: pane, color: 'transparent', textColor: '#59636E', isLead: false, source: 'fallback' };
}

function uniqueBy<T>(arr: T[], pred: (x: T) => boolean): T | undefined {
  const hits = arr.filter(pred);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * sessions/<pid>.json 의 tmux 필드("<세션>:@창.%칸")가 우리 세션의 리드 칸인지.
 *
 * Args:
 *   tmux: sessions json의 tmux 값.
 *   session: psmux 세션 이름.
 *   leadPaneId: 리드 칸 ID(모르면 null → 세션만 비교).
 */
export function matchesLeadTmux(tmux: unknown, session: string, leadPaneId: string | null): boolean {
  if (typeof tmux !== 'string' || !tmux.startsWith(`${session}:`)) return false;
  if (!leadPaneId) return true;
  return tmux.endsWith(`.${leadPaneId}`);
}

/** 리드 sessionId → 팀 폴더 이름(session-<앞 8자>). */
export function teamNameFor(leadSessionId: string): string | null {
  return /^[0-9a-f]{8}/i.test(leadSessionId) ? `session-${leadSessionId.slice(0, 8)}` : null;
}
