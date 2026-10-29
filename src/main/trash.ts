// 대화 삭제(~/.claude 읽기 전용 원칙의 예외): 대화 .jsonl, 같은 대화에 묶인 팀원 .jsonl, 각 대화 폴더(<sessionId>\: 서브에이전트 기록·메타·도구 결과)를
// Windows 휴지통으로 옮긴다(영구 삭제 없음). 대상은 반드시 현재 히스토리(projects) 폴더 아래의 두 모양뿐이다:
// <dir>/<sessionId>.jsonl(파일), <dir>/<sessionId>(폴더). history.jsonl·sessions/·teams/ 등 그 밖의 경로는 거부한다.

import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { SESSION_ID_RE } from '../shared/ids';
import { listSubagentFiles } from './claudeHome';
import type { HistoryItem } from './history/indexer';
import { teammatesOf } from './history/list';
import { log } from './logger';

const FORBIDDEN_SEGMENTS = new Set(['sessions', 'teams']);

/** 휴지통 대상 종류. */
export type TrashKind = 'file' | 'dir';

/**
 * 휴지통으로 옮겨도 되는 경로의 종류(경로 문자열만 검사, 정규화 후 prefix·모양 확인). 허용하지 않으면 null.
 *
 * Args:
 *   root: 현재 히스토리(projects) 폴더.
 *   p: 대상 경로.
 */
export function trashKind(root: string, p: string): TrashKind | null {
  const r = resolve(root);
  const t = resolve(p);
  const rel = relative(r, t);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts.length !== 2) return null;
  if (parts.some((x) => FORBIDDEN_SEGMENTS.has(x.toLowerCase()) || x === '.' || x === '..' || !x)) return null;
  const base = parts[1];
  if (base.toLowerCase() === 'history.jsonl') return null;
  if (/\.jsonl$/i.test(base)) return SESSION_ID_RE.test(base.replace(/\.jsonl$/i, '')) ? 'file' : null;
  return SESSION_ID_RE.test(base) ? 'dir' : null;
}

/** 휴지통으로 옮겨도 되는 경로인지. */
export function isTrashablePath(root: string, p: string): boolean {
  return trashKind(root, p) !== null;
}

/**
 * 실제 경로로도 projects 아래이고 종류가 맞는지(심볼릭 링크·정션은 거부). 없으면 false.
 *
 * Args:
 *   root: 현재 히스토리 폴더.
 *   p: 대상 경로.
 *   kind: 기대하는 종류.
 */
export async function realUnder(root: string, p: string, kind: TrashKind = 'file'): Promise<boolean> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink() || (kind === 'file' ? !st.isFile() : !st.isDirectory())) return false;
    const [r, t] = await Promise.all([realpath(root), realpath(p)]);
    return t.toLowerCase().startsWith(r.toLowerCase().replace(/[\\/]+$/, '') + sep);
  } catch {
    return false;
  }
}

/** 인덱스에 있는 대화 파일(경로 + 인덱스·앱 저장소 키). */
export interface TrashFile {
  path: string;
  key: string;
}

/** 삭제 대상. */
export interface TrashPlan {
  /** 대화 본 파일. */
  main: TrashFile;
  /** 같은 대화에 묶인 팀원 파일. */
  mates: TrashFile[];
  /** 있는 대화 폴더(<dir>/<sessionId>, 대화·팀원 각각). 서브에이전트 기록·메타·도구 결과가 들어 있다. */
  folders: string[];
  /** 폴더 안 서브에이전트 기록 수(확인 문구용, 전체). */
  subagents: number;
  /** folders와 같은 순서의 폴더별 서브에이전트 기록 수. */
  folderSubagents: number[];
  /** 대화 + 팀원 sessionId(탭·실행 중 판정용). */
  sessionIds: string[];
}

/** 대화 파일 외에 함께 옮길 기록 수(팀원 + 서브에이전트, 확인 문구용). */
export function extraCount(p: TrashPlan): number {
  return p.mates.length + p.subagents;
}

/** 실제로 옮길 수 있는지(경로 모양 + 실제 경로·종류, 정션·심볼릭 링크 거부). */
export async function canMove(root: string, p: string): Promise<boolean> {
  const kind = trashKind(root, p);
  return !!kind && (await realUnder(root, p, kind));
}

/**
 * 확인 창용 요약: 실제로 옮길 수 있는 대상만 센다.
 *
 * Returns:
 *   mainOk: 대화 파일을 옮길 수 있는지, extra: 함께 옮길 팀원 + 서브에이전트 기록 수, folders: 옮길 수 있는 대화 폴더 수.
 */
export async function movableSummary(root: string, plan: TrashPlan): Promise<{ mainOk: boolean; extra: number; folders: number }> {
  let extra = 0;
  let folders = 0;
  for (const m of plan.mates) if (await canMove(root, m.path)) extra++;
  for (let i = 0; i < plan.folders.length; i++) {
    if (!(await canMove(root, plan.folders[i]))) continue;
    folders++;
    extra += plan.folderSubagents[i] ?? 0;
  }
  return { mainOk: await canMove(root, plan.main.path), extra, folders };
}

/**
 * 이동 순서: 대화 폴더 → 팀원 파일 → 대화 파일. 대화 파일을 마지막에 옮겨, 중간에 실패해도 목록에 대화가 남아 다시 지울 수 있게 한다.
 */
export function trashOrder(plan: TrashPlan): string[] {
  return [...plan.folders, ...plan.mates.map((m) => m.path), plan.main.path];
}

/** 폴더가 있는지(심볼릭 링크 제외는 이동 직전 realUnder가 다시 확인). */
async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 대화 하나의 삭제 대상을 만든다: 대화 파일, 같은 대화에 묶인 팀원 파일(목록 묶기와 같은 규칙), 각자의 대화 폴더.
 *
 * Args:
 *   root: 현재 히스토리 폴더.
 *   items: 인덱스 항목 전체.
 *   sessionId: 지울 대화.
 *   listSub: 서브에이전트 파일 목록 함수(테스트 주입).
 *   dirExists: 폴더 확인 함수(테스트 주입).
 *
 * Returns:
 *   대상. 인덱스에 없는 대화면 null.
 */
export async function planTrash(root: string, items: HistoryItem[], sessionId: string,
  listSub: (dir: string, sid: string) => Promise<string[]> = listSubagentFiles,
  dirExists: (p: string) => Promise<boolean> = isDir): Promise<TrashPlan | null> {
  const lead = items.find((i) => i.sessionId.toLowerCase() === sessionId.toLowerCase() && i.kind !== 'teammate');
  if (!lead) return null;
  const mates = teammatesOf(items, lead.sessionId);
  const fileOf = (i: HistoryItem): TrashFile => ({ path: join(root, i.dir, i.file), key: i.key });
  const folders: string[] = [];
  const folderSubagents: number[] = [];
  for (const it of [lead, ...mates]) {
    const dir = join(root, it.dir, it.sessionId);
    if (!(await dirExists(dir))) continue;
    folders.push(dir);
    folderSubagents.push((await listSub(it.dir, it.sessionId)).length);
  }
  const subagents = folderSubagents.reduce((a, b) => a + b, 0);
  return { main: fileOf(lead), mates: mates.map(fileOf), folders, subagents, folderSubagents, sessionIds: [lead.sessionId, ...mates.map((m) => m.sessionId)] };
}

/** 휴지통 이동 결과. */
export interface TrashOutcome {
  moved: string[];
  failed: string[];
  refused: string[];
}

/**
 * 계획한 파일·폴더를 하나씩 휴지통으로 옮긴다. 경로 검사(문자열 모양 + 실제 경로·종류)를 통과하지 못한 대상은 건드리지 않는다.
 * 실패해도 나머지는 계속한다(부분 성공은 성공분만 반영). 로그에는 개수와 오류 코드만 남긴다.
 *
 * Args:
 *   root: 현재 히스토리 폴더.
 *   targets: 대상 파일·폴더.
 *   trashItem: 휴지통 이동 함수(Electron shell.trashItem, 테스트 주입).
 */
export async function moveToTrash(root: string, targets: string[], trashItem: (p: string) => Promise<void>): Promise<TrashOutcome> {
  const out: TrashOutcome = { moved: [], failed: [], refused: [] };
  for (const f of targets) {
    const kind = trashKind(root, f);
    if (!kind || !(await realUnder(root, f, kind))) {
      out.refused.push(f);
      continue;
    }
    try {
      await trashItem(f);
      out.moved.push(f);
    } catch (e) {
      out.failed.push(f);
      log('warn', `trash failed (${(e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.name : 'error')})`);
    }
  }
  return out;
}
