// Agents 설정(F8-1) 읽기 전용 조사: ~/.claude/agents/*.md(전역)와 활성 탭 작업 폴더의 .claude/agents/*.md(프로젝트),
// 팀 기능 상태(환경변수·사용자 환경변수 레지스트리·~/.claude/settings.json). 아무것도 쓰지 않고, 파일 내용은 로그에 남기지 않는다.

import { execFile } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { AgentEntryDto, AgentsDto } from '../shared/api';
import { AGENT_NAME_RE, flagOn, leadAgentName, parseFrontmatter, teammateCheck } from '../shared/agents';
import { tr } from '../shared/i18n';
import { agentsDir, readTeamSettings } from './claudeHome';

/** md 하나의 크기 상한(byte). */
export const AGENT_FILE_MAX = 256 * 1024;
/** 프로젝트 + 전역 합계 파일 수 상한(프로젝트 먼저). */
export const AGENT_COUNT_MAX = 200;
/** 팀 기능 환경변수 이름. */
export const TEAMS_ENV = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';

interface Scanned extends AgentEntryDto {
  body: string;
}

/**
 * 폴더 하나의 *.md를 읽는다(하위 폴더·심볼릭 링크 제외, 크기·개수 상한).
 *
 * Args:
 *   dir: 대상 폴더.
 *   scope: 출처.
 *   room: 남은 개수.
 */
async function scanDir(dir: string, scope: 'global' | 'project', room: number): Promise<{ items: Scanned[]; more: boolean }> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => /\.md$/i.test(f)).sort((a, b) => a.localeCompare(b));
  } catch {
    return { items: [], more: false };
  }
  const items: Scanned[] = [];
  for (const file of names.slice(0, Math.max(0, room))) {
    const base: Scanned = { file, scope, name: null, description: null, error: null, referenced: [], missing: [], body: '' };
    try {
      const st = await lstat(join(dir, file));
      if (!st.isFile()) {
        items.push({ ...base, error: tr('agents.errNotFile') });
        continue;
      }
      if (st.size > AGENT_FILE_MAX) {
        items.push({ ...base, error: tr('agents.errTooBig') });
        continue;
      }
      const fm = parseFrontmatter(await readFile(join(dir, file), 'utf8'));
      let error: string | null = null;
      if (!fm.found) error = tr('agents.errNoFrontmatter');
      else if (!fm.name) error = tr('agents.errNoName');
      else if (!AGENT_NAME_RE.test(fm.name)) error = tr('agents.errBadName');
      items.push({ ...base, name: fm.name, description: fm.description ? fm.description.slice(0, 300) : null, error, body: error ? '' : fm.body });
    } catch (e) {
      items.push({ ...base, error: tr('agents.errRead', { code: (e as NodeJS.ErrnoException).code ?? 'error' }) });
    }
  }
  return { items, more: names.length > room };
}

/** 사용자 환경변수(HKCU\Environment)의 팀 기능 값(reg.exe, 읽기 전용, 3초 제한). 없거나 실패하면 null. */
function readUserEnv(name: string): Promise<string | null> {
  // 이름은 정규식·reg.exe 인자에 그대로 들어가므로 환경변수 이름 꼴만 허용
  if (!/^[A-Z0-9_]+$/.test(name)) return Promise.resolve(null);
  return new Promise((res) => {
    execFile('reg.exe', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err) return res(null);
      const m = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'mi').exec(stdout);
      res(m ? m[1].trim().slice(0, 20) : null);
    });
  });
}

/**
 * 팀 기능 상태: 앱 프로세스 환경변수 → 사용자 환경변수(레지스트리) → ~/.claude/settings.json env 순으로 켜짐을 찾는다.
 * teammateMode는 settings.json 값(없으면 null).
 */
export async function teamsStatus(env: NodeJS.ProcessEnv = process.env, userEnv: (n: string) => Promise<string | null> = readUserEnv): Promise<AgentsDto['teams']> {
  const s = await readTeamSettings();
  const sources: [string, string | null | undefined][] = [
    [tr('agents.srcApp'), env[TEAMS_ENV]],
    [tr('agents.srcUser'), await userEnv(TEAMS_ENV)],
    ['~/.claude/settings.json env', s.envFlag],
  ];
  const on = sources.find(([, v]) => flagOn(v));
  return { enabled: !!on, source: on ? on[0] : null, teammateMode: s.teammateMode };
}

/**
 * Agents 대화상자 데이터(F8-1).
 *
 * Args:
 *   projectFolder: 활성 탭 작업 폴더(없으면 전역만). main이 탭 상태에서 꺼낸 값만 받는다.
 *   leadCommand: 현재 설정의 리드 명령.
 */
export async function listAgents(projectFolder: string | null, leadCommand: string): Promise<AgentsDto> {
  const globalDir = agentsDir();
  // 상한(200)은 프로젝트 정의부터 채우고 남는 개수를 전역에 준다(TC-200: 리더는 대개 프로젝트에 두므로 전역이 많아도 가려지지 않게)
  const projectDir = projectFolder ? resolve(projectFolder, '.claude', 'agents') : null;
  const p = projectDir ? await scanDir(projectDir, 'project', AGENT_COUNT_MAX) : { items: [] as Scanned[], more: false };
  const g = await scanDir(globalDir, 'global', AGENT_COUNT_MAX - p.items.length);
  const all = [...p.items, ...g.items]; // 같은 이름이면 프로젝트 정의가 앞(Claude Code도 프로젝트 정의를 우선)
  const names = [...new Set(all.filter((a) => !a.error && a.name).map((a) => a.name as string))];
  const agents: AgentEntryDto[] = all.map(({ body, ...a }) => (a.error || !a.name ? a : { ...a, ...teammateCheck(body, a.name, names) }));
  return {
    globalDir, projectDir, projectFolder,
    agents, truncated: g.more || p.more,
    teams: await teamsStatus(),
    leadCommand, leadName: leadAgentName(leadCommand),
  };
}
