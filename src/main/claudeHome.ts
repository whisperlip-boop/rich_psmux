// ~/.claude 읽기 전용 접근 계층. 이 모듈만 ~/.claude 를 읽으며 쓰기 API(write/rename/unlink/mkdir/touch)는 아예 두지 않는다.
// 비밀값 파일(.credentials.json, sessions/*.key)은 경로 단계에서 거부해 열지도 않는다.
// 유일한 예외: 사용량 ↻(F7-1)은 usage.ts fetchOauthUsage 한 함수가 .credentials.json을 직접 읽는다(읽기 전용 원칙의 예외, 토큰은 그 함수 밖으로 나가지 않음).
// 대화 삭제(F2-1)의 휴지통 이동은 이 모듈이 아니라 trash.ts가 projects 아래 .jsonl만 대상으로 한다(읽기 전용 원칙의 예외).

import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { matchesLeadTmux, sanitizeConfig, type TeamConfig } from './teams/paneMapper';

let rootOverride: string | null = null;
let projectsOverride: string | null = null;

/** ~/.claude 위치(테스트·설정용 재지정 가능). */
export function claudeHomeDir(): string {
  return rootOverride ?? join(homedir(), '.claude');
}

/** 테스트 전용: 루트를 바꾼다. null이면 기본값. */
export function setClaudeHomeForTest(dir: string | null): void {
  rootOverride = dir;
}

/** 히스토리(projects) 폴더를 바꾼다(설정 F8). null·빈 값이면 ~/.claude/projects. */
export function setProjectsDir(dir: string | null): void {
  projectsOverride = dir && dir.trim() ? dir.trim() : null;
}

/** 지금 쓰는 히스토리(projects) 폴더. */
export function projectsDir(): string {
  return projectsOverride ?? join(claudeHomeDir(), 'projects');
}

/**
 * Claude Code가 작업 폴더(cwd)를 projects 아래 폴더 이름으로 바꾸는 규칙(예 `D:\github\x` → `D--github-x`).
 *
 * Args:
 *   cwd: 작업 폴더 절대 경로(끝 구분자는 무시. Claude Code의 cwd에는 붙지 않으므로).
 *
 * Returns:
 *   영숫자가 아닌 문자를 모두 '-'로 바꾼 폴더 이름.
 */
export function projectDirName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  // 드라이브 루트(D:\)·루트(/)는 구분자까지가 경로이므로 그대로 둔다
  const base = trimmed && !trimmed.endsWith(':') ? trimmed : cwd;
  return base.replace(/[^A-Za-z0-9]/g, '-');
}

/** 비밀값 파일 이름이면 true(.credentials.json, *.key). */
function isSecretName(base: string): boolean {
  const b = base.toLowerCase();
  return b === '.credentials.json' || b.endsWith('.key');
}

/**
 * 히스토리 폴더 아래 상대 경로를 절대 경로로 바꾸고 금지 경로를 거부한다(resolveSafe와 같은 규칙, 루트만 다름).
 *
 * Raises:
 *   Error: 루트 밖 경로이거나 비밀값 파일일 때.
 */
export function resolveProjects(...segments: string[]): string {
  const root = resolve(projectsDir());
  const p = resolve(root, ...segments);
  const rel = relative(root, p);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path outside the history folder');
  if (rel && isSecretName(rel.split(sep).pop() ?? '')) throw new Error('secret file access refused');
  return p;
}

/**
 * ~/.claude 아래 상대 경로를 절대 경로로 바꾸고 금지 경로를 거부한다.
 *
 * Raises:
 *   Error: 루트 밖 경로이거나 비밀값 파일일 때.
 */
export function resolveSafe(...segments: string[]): string {
  const root = resolve(claudeHomeDir());
  const p = resolve(root, ...segments);
  const rel = relative(root, p);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path outside ~/.claude');
  if (isSecretName(rel.split(sep).pop() ?? '')) throw new Error('secret file access refused');
  return p;
}

/**
 * 계정 표시값(F7)만 ~/.claude.json 에서 꺼낸다: oauthAccount.emailAddress·organizationName.
 * 이 파일에는 MCP 서버 env·headers 등 비밀값이 같이 있을 수 있어, 파싱한 객체는 함수 밖으로 내보내지 않고 두 문자열만 돌려준다.
 * 값은 로그에 남기지 않는다(호출부 포함). Claude Code가 쓰는 도중이면 잘린 JSON일 수 있어 한 번 다시 읽는다.
 *
 * Returns:
 *   email·org(없거나 읽지 못하면 null).
 */
export async function readAccount(): Promise<{ email: string | null; org: string | null }> {
  const file = join(dirname(resolve(claudeHomeDir())), '.claude.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const o = (JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> | null)?.oauthAccount as Record<string, unknown> | undefined;
      const pick = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.length <= 320 && !/[\x00-\x1f\x7f]/.test(v) ? v.trim() : null);
      return { email: pick(o?.emailAddress), org: pick(o?.organizationName) };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') break;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
    }
  }
  return { email: null, org: null };
}

/**
 * 팀 기능 판정용 값만 ~/.claude/settings.json에서 꺼낸다(F8-1): env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, teammateMode.
 * 이 파일의 다른 값(권한·hook·다른 env 등)은 함수 밖으로 내보내지 않고 로그에도 남기지 않는다.
 */
export async function readTeamSettings(): Promise<{ envFlag: string | null; teammateMode: string | null }> {
  const j = (await readJson('settings.json')) as Record<string, unknown> | null;
  const env = j && typeof j.env === 'object' && j.env ? (j.env as Record<string, unknown>) : null;
  const flag = env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  const mode = j?.teammateMode;
  return {
    envFlag: typeof flag === 'string' || typeof flag === 'number' || typeof flag === 'boolean' ? String(flag).slice(0, 20) : null,
    teammateMode: typeof mode === 'string' ? mode.slice(0, 40) : null,
  };
}

/** 전역 에이전트 정의 폴더(~/.claude/agents). */
export function agentsDir(): string {
  return join(claudeHomeDir(), 'agents');
}

async function readJson(...segments: string[]): Promise<unknown | null> {
  const p = resolveSafe(...segments);
  // Claude Code가 쓰는 도중이면 잘린 JSON일 수 있어 한 번만 다시 읽는다
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return JSON.parse(await readFile(p, 'utf8')) as unknown;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') return null;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 120));
    }
  }
  return null;
}

async function listDir(...segments: string[]): Promise<string[]> {
  try {
    return await readdir(resolveSafe(...segments));
  } catch {
    return [];
  }
}

/**
 * 우리 psmux 세션의 리드 칸에서 실행 중인 Claude Code의 sessionId를 찾는다.
 * sessions/<pid>.json 의 tmux 필드("<세션>:@창.%칸")로 맞춘다. *.key 파일은 이름 필터로 제외한다.
 *
 * Returns:
 *   sessionId(uuid) 또는 null.
 */
export async function findLeadSessionId(session: string, leadPaneId: string | null): Promise<string | null> {
  let best: { sid: string; at: number } | null = null;
  for (const f of await listDir('sessions')) {
    if (!/^\d+\.json$/.test(f)) continue;
    const j = (await readJson('sessions', f)) as Record<string, unknown> | null;
    if (!j || !matchesLeadTmux(j.tmux, session, leadPaneId) || typeof j.sessionId !== 'string') continue;
    const at = typeof j.updatedAt === 'number' ? j.updatedAt : typeof j.startedAt === 'number' ? j.startedAt : 0;
    if (!best || at >= best.at) best = { sid: j.sessionId, at };
  }
  return best?.sid ?? null;
}

/** teams/<teamName>/config.json 을 읽어 정제한다. 없으면 null. */
export async function readTeamConfig(teamName: string): Promise<TeamConfig | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(teamName)) return null;
  const raw = await readJson('teams', teamName, 'config.json');
  return raw === null ? null : sanitizeConfig(raw);
}

/** projects/<폴더>/<sessionId>.jsonl 하나(깊이 1만. <sid>/subagents/ 는 포함하지 않음). */
export interface ProjectFile {
  /** 인코딩된 프로젝트 폴더 이름. */
  dir: string;
  /** 파일 이름(<sessionId>.jsonl). */
  file: string;
}

/**
 * 히스토리 대상 jsonl 목록(projects/<폴더>/*.jsonl, 깊이 1). projects 폴더가 없으면 빈 목록.
 *
 * Returns:
 *   files: 파일 목록, failedDirs: 읽지 못한 프로젝트 폴더(호출부는 그 폴더 항목을 지우지 않는다).
 *
 * Raises:
 *   Error: projects 폴더 자체를 읽지 못했을 때(없는 경우 제외). 일시 오류로 목록 전체가 지워지지 않게 한다.
 */
export async function listProjectJsonl(): Promise<{ files: ProjectFile[]; failedDirs: string[] }> {
  const files: ProjectFile[] = [];
  const failedDirs: string[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(resolveProjects());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { files, failedDirs };
    throw e;
  }
  for (const dir of dirs) {
    if (dir.startsWith('.')) continue;
    let names: string[];
    try {
      names = await readdir(resolveProjects(dir));
    } catch (e) {
      // 폴더가 아닌 항목은 대상 아님. 그 밖의 오류는 일시 실패로 본다
      if ((e as NodeJS.ErrnoException).code !== 'ENOTDIR' && (e as NodeJS.ErrnoException).code !== 'ENOENT') failedDirs.push(dir);
      continue;
    }
    for (const file of names) {
      if (file.toLowerCase().endsWith('.jsonl')) files.push({ dir, file });
    }
  }
  return { files, failedDirs };
}

/**
 * 대화의 서브에이전트 기록 파일(projects/<dir>/<sessionId>/subagents/agent-*.jsonl). 읽기 전용 목록.
 *
 * Returns:
 *   projects 기준 절대 경로. 폴더가 없거나 읽지 못하면 빈 배열.
 */
export async function listSubagentFiles(dir: string, sessionId: string): Promise<string[]> {
  try {
    const sub = resolveProjects(dir, sessionId, 'subagents');
    return (await readdir(sub)).filter((f) => /^agent-[A-Za-z0-9_-]+\.jsonl$/i.test(f)).map((f) => join(sub, f));
  } catch {
    return [];
  }
}

/** projects 아래 파일의 크기·수정 시각. 없거나 파일이 아니면 null. */
export async function statProjectFile(dir: string, file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await stat(resolveProjects(dir, file));
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * projects 아래 파일의 [start, end) 구간을 청크로 읽는다(읽기 전용 스트림, 파일 전체를 메모리에 올리지 않음).
 *
 * Args:
 *   dir: 프로젝트 폴더 이름.
 *   file: 파일 이름.
 *   start: 시작 바이트.
 *   end: 끝 바이트(제외).
 *   onChunk: 청크 콜백. false를 돌려주면 읽기를 멈춘다.
 *
 * Raises:
 *   Error: 금지 경로이거나 읽기 오류일 때.
 */
export async function readProjectRange(dir: string, file: string, start: number, end: number, onChunk: (b: Buffer) => boolean): Promise<void> {
  if (end <= start) return;
  const s = createReadStream(resolveProjects(dir, file), { start, end: end - 1, highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of s) {
      if (!onChunk(chunk as Buffer)) break;
    }
  } finally {
    s.destroy();
  }
}

/**
 * projects 폴더 변경 감시(fs.watch recursive). 콜백에는 projects 기준 상대 경로가 온다.
 * 감시를 시작하지 못하면 null(호출부는 주기 확인으로 대신한다).
 */
export function watchProjects(onChange: (relPath: string) => void, onError: (e: Error) => void): FSWatcher | null {
  try {
    const w = watch(resolveProjects(), { recursive: true, persistent: false }, (_ev, name) => {
      if (name) onChange(String(name));
    });
    w.on('error', onError);
    return w;
  } catch (e) {
    onError(e as Error);
    return null;
  }
}

/** 실행 중인 Claude Code 세션 파일(sessions/<pid>.json)에서 앱이 쓰는 필드만. */
export interface RunningSessionFile {
  pid: number;
  sessionId: string;
  /** "<psmux 세션>:@창.%칸"(psmux 밖에서 실행됐으면 없음). */
  tmux?: string;
}

/**
 * sessions/<pid>.json 하나를 다시 읽는다(세션 끊기 직전 확인용). 목록과 달리 pid를 파일 이름으로 채우지 않는다.
 *
 * Args:
 *   pid: 파일 이름의 pid.
 *
 * Returns:
 *   내용(pid는 내용 값, 없거나 정수가 아니면 null). 파일이 없거나 JSON·sessionId가 아니면 null.
 */
export async function readRunningSessionFile(pid: number): Promise<(Omit<RunningSessionFile, 'pid'> & { pid: number | null }) | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const j = (await readJson('sessions', `${pid}.json`)) as Record<string, unknown> | null;
  if (!j || typeof j !== 'object' || typeof j.sessionId !== 'string') return null;
  return {
    pid: typeof j.pid === 'number' && Number.isInteger(j.pid) ? j.pid : null,
    sessionId: j.sessionId,
    tmux: typeof j.tmux === 'string' ? j.tmux : undefined,
  };
}

/** sessions/<pid>.json 목록(*.key 등 다른 파일은 이름으로 거른다). 프로세스 생존 여부는 호출부가 확인한다. */
export async function listRunningSessionFiles(): Promise<RunningSessionFile[]> {
  const out: RunningSessionFile[] = [];
  for (const f of await listDir('sessions')) {
    if (!/^\d+\.json$/.test(f)) continue;
    const j = (await readJson('sessions', f)) as Record<string, unknown> | null;
    if (!j || typeof j.sessionId !== 'string') continue;
    const pid = typeof j.pid === 'number' && Number.isInteger(j.pid) ? j.pid : Number(f.slice(0, -5));
    out.push({
      pid, sessionId: j.sessionId,
      tmux: typeof j.tmux === 'string' ? j.tmux : undefined,
    });
  }
  return out;
}
