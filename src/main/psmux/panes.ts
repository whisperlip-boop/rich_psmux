// list-panes 결과 해석과 칸 목록 비교. 순수 로직(단위 테스트 대상).
// psmux 창/칸 알림은 ID가 틀리므로 "변화 신호"로만 쓰고 항상 list-panes로 실제 목록을 맞춘다.

/** list-panes -F 형식. 공백 구분, 명령 이름은 공백이 있을 수 있어 맨 끝. */
export const LIST_PANES_FORMAT = "'#{pane_id} #{window_id} #{pane_width} #{pane_height} #{pane_dead} #{window_panes} #{pane_current_command}'";

/** 칸 하나의 상태. */
export interface PaneInfo {
  paneId: string;
  windowId: string;
  width: number;
  height: number;
  dead: boolean;
  windowPanes: number;
  command: string;
}

/**
 * list-panes 출력 줄을 해석한다. 형식이 맞지 않는 줄은 건너뛴다.
 *
 * Args:
 *   lines: LIST_PANES_FORMAT으로 받은 줄.
 *
 * Returns:
 *   칸 목록(입력 순서 유지, 같은 ID 중복 제거).
 */
export function parseListPanes(lines: string[]): PaneInfo[] {
  const out: PaneInfo[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const m = /^(%\d+) (@\d+) (\d+) (\d+) (\d+) (\d+) ?(.*)$/.exec(raw.trim());
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({
      paneId: m[1], windowId: m[2], width: Number(m[3]), height: Number(m[4]),
      dead: m[5] === '1', windowPanes: Number(m[6]), command: m[7] ?? '',
    });
  }
  return out;
}

/** 칸 목록 변화. */
export interface PaneDiff {
  added: PaneInfo[];
  removed: string[];
  changed: PaneInfo[];
}

/**
 * 이전·현재 칸 목록을 비교한다. dead 칸은 "없는 칸"으로 본다
 * (실측: Claude 팀원 종료 뒤 칸이 pane_dead=1로 남음).
 */
export function diffPanes(prev: Map<string, PaneInfo>, next: PaneInfo[]): PaneDiff {
  const alive = next.filter((p) => !p.dead);
  const nextIds = new Set(alive.map((p) => p.paneId));
  const added = alive.filter((p) => !prev.has(p.paneId));
  const removed = [...prev.keys()].filter((id) => !nextIds.has(id));
  const changed = alive.filter((p) => {
    const o = prev.get(p.paneId);
    return o !== undefined && (o.windowId !== p.windowId || o.width !== p.width || o.height !== p.height);
  });
  return { added, removed, changed };
}

/** 창 분리(break-pane)가 필요한 칸: 살아 있고 다른 칸과 창을 같이 쓰는 칸 중 리드가 아닌 것. */
export function panesToBreak(panes: PaneInfo[], leadPaneId: string | null): string[] {
  return panes.filter((p) => !p.dead && p.windowPanes > 1 && p.paneId !== leadPaneId).map((p) => p.paneId);
}

/** 카드 크기 → 칸 크기 제한(너무 작으면 Claude Code 화면이 깨짐). */
export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  const c = Number.isFinite(cols) ? Math.floor(cols) : 80;
  const r = Number.isFinite(rows) ? Math.floor(rows) : 24;
  return { cols: Math.min(500, Math.max(20, c)), rows: Math.min(200, Math.max(5, r)) };
}

/** 칸에서 실행 중인 프로그램이 PowerShell이면 여러 줄을 C-j로, 그 밖(Claude Code 등)은 bracketed paste로(QA FAIL 19). */
export function multilineModeFor(command: string | undefined): 'paste' | 'ctrlj' {
  return /^(pwsh|powershell)(\.exe)?$/i.test((command ?? '').trim()) ? 'ctrlj' : 'paste';
}

/** set-option default-shell 값: psmux가 `\`를 이스케이프로 소비하므로 `/`로 바꾼다(M4 리뷰 실측). */
export function shellOptionPath(shell: string): string {
  return shell.replace(/\\/g, '/');
}

/** 칸의 pane_current_command가 설정한 셸 실행 파일과 같은지(파일 이름, 확장자·대소문자 무시). */
export function shellMatches(command: string, shell: string): boolean {
  const name = (s: string): string => (s.trim().split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase();
  return !!command.trim() && name(command) === name(shell);
}
