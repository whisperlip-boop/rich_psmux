// 인덱스 항목 → 사이드바 목록 항목. 팀원 파일은 숨기고 리드에 묶는다(teamName = session-<리드 sessionId 앞 8자>). 순수 로직.

import type { HistoryItemDto } from '../../shared/api';
import { log } from '../logger';
import type { HistoryItem } from './indexer';

/** 리드가 여러 개 맞아 묶지 못한 팀 이름(같은 팀은 로그 1회만). */
const ambiguousTeams = new Set<string>();

/** 폴더 그룹 키: 첫 cwd(없으면 인코딩 폴더명), 구분자 통일 + 대소문자 무시(D2). */
export function folderKeyOf(cwd: string | null, dir: string): string {
  return (cwd ?? dir).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** 그룹 표시 이름: cwd의 마지막 폴더명(드라이브 루트면 경로 그대로), 없으면 인코딩 폴더명. */
export function folderNameOf(cwd: string | null, dir: string): string {
  if (!cwd) return dir;
  const t = cwd.replace(/[\\/]+$/, '');
  return t.split(/[\\/]/).pop() || cwd;
}

/**
 * 팀원 파일 → 리드 sessionId. 팀원이 아닌 파일 중 sessionId 앞 8자가 teamName(session-<8자>)과 정확히 1개 맞을 때만 묶는다
 * (팀원 파일은 다른 프로젝트 폴더에 있을 수 있어 전체에서 찾음). 목록 묶기와 삭제(F2-1) 대상 계산이 같은 규칙을 쓴다.
 *
 * Returns:
 *   팀원 항목 키 → 리드 sessionId.
 */
export function teammateLeads(items: HistoryItem[]): Map<string, string> {
  const byPrefix = new Map<string, string[]>();
  for (const i of items) {
    if (i.kind === 'teammate') continue;
    const k = i.sessionId.slice(0, 8).toLowerCase();
    byPrefix.set(k, [...(byPrefix.get(k) ?? []), i.sessionId]);
  }
  const out = new Map<string, string>();
  for (const t of items) {
    if (t.kind !== 'teammate' || !t.teamName) continue;
    const pre = /^session-([0-9a-f]{8})$/i.exec(t.teamName)?.[1]?.toLowerCase();
    const hits = pre ? byPrefix.get(pre) ?? [] : [];
    if (hits.length === 1) out.set(t.key, hits[0]);
    else if (hits.length > 1 && !ambiguousTeams.has(t.teamName)) {
      ambiguousTeams.add(t.teamName);
      log('warn', `history: team ${t.teamName} matches ${hits.length} leads by id prefix; teammates not grouped`);
    }
  }
  return out;
}

/** 리드 대화에 묶인 팀원 항목. */
export function teammatesOf(items: HistoryItem[], leadSessionId: string): HistoryItem[] {
  const leads = teammateLeads(items);
  const lead = leadSessionId.toLowerCase();
  return items.filter((i) => leads.get(i.key)?.toLowerCase() === lead);
}

/** 앱 저장소의 표시 이름·보관 목록(F2-1). */
export interface HistoryOverlay {
  overrides: Record<string, string>;
  archived: string[];
}

/**
 * 목록 항목을 만든다.
 *
 * Args:
 *   items: 인덱스 항목 전체(팀원 포함).
 *   showSdk: entrypoint=sdk-cli 세션도 보일지(기본 숨김, 설정).
 *   overlay: 앱 저장소의 표시 이름·보관 목록.
 *
 * Returns:
 *   보일 항목(일반·리드[·sdk]). 리드에는 묶인 팀원 파일 수(mates)를 넣는다.
 */
export function toHistoryDtos(items: HistoryItem[], showSdk: boolean, overlay: HistoryOverlay = { overrides: {}, archived: [] }): HistoryItemDto[] {
  const mates = new Map<string, number>();
  for (const lead of teammateLeads(items).values()) mates.set(lead, (mates.get(lead) ?? 0) + 1);
  const archived = new Set(overlay.archived);
  // cwd가 없는 파일(스텁 등)은 같은 프로젝트 폴더의 다른 파일 cwd로 묶는다(가장 최근 파일 기준). 그래도 없으면 폴더명
  const dirCwd = new Map<string, { cwd: string; at: number }>();
  for (const i of items) {
    if (!i.cwd) continue;
    const cur = dirCwd.get(i.dir);
    if (!cur || i.mtimeMs > cur.at) dirCwd.set(i.dir, { cwd: i.cwd, at: i.mtimeMs });
  }
  return items
    .filter((i) => i.kind === 'session' || i.kind === 'lead' || (showSdk && i.kind === 'sdk'))
    .map((i) => {
      const groupCwd = i.cwd ?? dirCwd.get(i.dir)?.cwd ?? null;
      return {
        sessionId: i.sessionId, title: i.title, cwd: groupCwd, folderKey: folderKeyOf(groupCwd, i.dir), folderName: folderNameOf(groupCwd, i.dir),
        mtimeMs: i.mtimeMs, createdMs: i.createdMs, kind: i.kind as HistoryItemDto['kind'], mates: mates.get(i.sessionId) ?? 0,
        key: i.key, customTitle: overlay.overrides[i.key] ?? null, archived: archived.has(i.key),
      };
    });
}
