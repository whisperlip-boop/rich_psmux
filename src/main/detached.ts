// 탭 없는 앱 세션(F2-1 보완): 메타는 있는데 탭으로 열려 있지 않은 살아 있는 psmux 세션 중,
// 대화 기록이 없어 히스토리 행으로는 닿을 수 없는 것. 순수 로직(단위 테스트 대상).

import { isPlainLeadCommand } from '../shared/agents';
import type { DetachedSessionDto } from '../shared/api';
import type { SessionMeta } from './appData';

/** 판정 입력. */
export interface DetachedInput {
  /** 메타가 있는 세션 이름(listMetaSessions). */
  metas: string[];
  /** list-sessions가 성공했을 때의 세션 이름 목록. */
  live: string[];
  /** 탭으로 열려 있거나 끊는 중인지. */
  isTab: (name: string) => boolean;
  metaOf: (name: string) => SessionMeta | null;
  /** 그 세션에 대화 기록이 있는지(main이 sessionHasConversation으로 판정). */
  hasConversation: (meta: SessionMeta, name: string) => boolean;
}

/** 대화 기록 판정 입력. */
export interface ConversationProbe {
  /** 알려진 대화 ID(탭·메타의 leadSessionIds, meta.resumeSessionId, running 목록의 sessionId). null/undefined 섞여도 됨. */
  ids: (string | null | undefined)[];
  folder: string;
  /** 세션 생성 시각(메타 createdAt). */
  createdAt: number;
  /** <projects>/<projectDirName(folder)>/<id>.jsonl 이 있는지(인덱스 또는 파일). */
  hasFile: (id: string, folder: string) => boolean;
  /** 그 프로젝트 폴더에서 가장 최근 .jsonl 수정 시각(없으면 null). ids가 비었을 때만 부른다. */
  newestJsonl: (folder: string) => number | null;
}

/** 세션 생성 시각과 .jsonl 수정 시각 비교 여유(ms): 시계·파일 시스템 시각 차이를 안전한 쪽(대화 있음)으로 흡수한다. */
const CONVERSATION_SLACK_MS = 5000;

/**
 * 대화 기록이 있는지: 아는 ID의 파일이 하나라도 있으면 true, ID를 알지만 어느 것도 파일이 없으면 false.
 * 대화 ID를 하나도 모를 때만(옛 메타·ID를 찾기 전) 세션 생성 이후 수정된 .jsonl이 폴더에 있으면 true(안전한 쪽).
 * ID를 알 때 폴더 시각을 보지 않는 이유: 같은 폴더의 다른 탭·외부 claude 대화 때문에 새 탭이 "대화 있음"으로 오판돼
 * 탭 없는 세션 목록에서 빠지면(누수) 이 기능의 목적이 깨진다. /clear로 바뀐 ID는 지난 ID 목록(leadSessionIds)으로 덮는다.
 *
 * Args:
 *   p: 알려진 대화 ID·폴더·세션 생성 시각과 파일 조회 함수.
 *
 * Returns:
 *   대화 기록이 있다고 볼 수 있으면 true.
 */
export function sessionHasConversation(p: ConversationProbe): boolean {
  const seen = new Set<string>();
  for (const id of p.ids) {
    if (!id) continue;
    const k = id.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (p.hasFile(id, p.folder)) return true;
  }
  if (seen.size > 0) return false;
  const newest = p.newestJsonl(p.folder);
  return newest !== null && newest >= p.createdAt - CONVERSATION_SLACK_MS;
}

/** 폴더 경로의 마지막 이름(끝 구분자 무시). */
export function folderBaseName(folder: string): string {
  const parts = folder.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || folder;
}

/**
 * 탭 없는 세션 목록과 정리 대상(세션이 사라진 메타)을 가른다.
 *
 * Returns:
 *   detached: 생성 시각 순. stale: psmux에 없는 메타(참고용. 정리는 복원 때만 하므로 main은 쓰지 않는다).
 */
export function selectDetached(i: DetachedInput): { detached: DetachedSessionDto[]; stale: string[] } {
  const live = new Set(i.live);
  const detached: DetachedSessionDto[] = [];
  const stale: string[] = [];
  for (const name of i.metas) {
    if (i.isTab(name)) continue;
    if (!live.has(name)) {
      stale.push(name);
      continue;
    }
    const meta = i.metaOf(name);
    // 로그인 세션은 복원하지 않고 정리하는 대상이므로 목록에 넣지 않는다
    if (!meta || meta.purpose === 'login') continue;
    // 이어간 대화든 새로 시작한 대화든 기록이 있으면 히스토리 행에서 다시 연결·끊기가 되므로 뺀다
    if (i.hasConversation(meta, name)) continue;
    detached.push({ session: name, folder: meta.folder, folderName: folderBaseName(meta.folder), createdAt: meta.createdAt, plain: isPlainLeadCommand(meta.leadCommand) });
  }
  detached.sort((a, b) => a.createdAt - b.createdAt);
  return { detached, stale };
}
