// v0.7: Agents 설정(F8-1) 파서·대조·조사, TC-180 오류 배너 상태 교체.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { setClaudeHomeForTest } from '../../src/main/claudeHome';
import { AGENT_FILE_MAX, listAgents, teamsStatus } from '../../src/main/agentsScan';
import type { AgentsDto } from '../../src/shared/api';
import { AGENT_TEMPLATE, flagOn, leadAgentName, leadCommandFor, parseFrontmatter, teammateCheck } from '../../src/shared/agents';
import { agentIssues, selectableAgents } from '../../src/renderer/components/AgentsDialog';
import { errorNotice } from '../../src/renderer/notice';

vi.mock('../../src/main/logger', () => ({ log: () => undefined, errMsg: (e: unknown) => String(e) }));

const tmp = mkdtempSync(join(tmpdir(), 'ctd-v07-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => setClaudeHomeForTest(null));

describe('frontmatter 파서(name·description만)', () => {
  it('기본, 따옴표, BOM, CRLF', () => {
    expect(parseFrontmatter('---\nname: ceo\ndescription: 리더\n---\n본문')).toEqual({ name: 'ceo', description: '리더', body: '본문', found: true });
    expect(parseFrontmatter('\uFEFF---\r\nname: "qa"\r\ndescription: \'검증 담당\'\r\n---\r\nx')).toMatchObject({ name: 'qa', description: '검증 담당', found: true });
  });

  it('여러 줄 description(| · >), 다른 키는 무시', () => {
    const t = '---\nname: pm\ntools: Read, Grep\ndescription: >\n  요구사항을\n  정리한다\nmodel: opus\n---\nbody';
    expect(parseFrontmatter(t)).toMatchObject({ name: 'pm', description: '요구사항을 정리한다', body: 'body' });
  });

  it('frontmatter 없음·닫는 줄 없음·name 없음', () => {
    expect(parseFrontmatter('# 제목\nname: x')).toMatchObject({ found: false, name: null });
    expect(parseFrontmatter('---\nname: x\n본문')).toMatchObject({ found: false, name: null });
    expect(parseFrontmatter('---\ndescription: d\n---\n')).toMatchObject({ found: true, name: null, description: 'd' });
    expect(parseFrontmatter('---\nname:\n---\n')).toMatchObject({ found: true, name: null });
  });

  it('예시 템플릿은 그대로 파싱된다', () => {
    expect(parseFrontmatter(AGENT_TEMPLATE)).toMatchObject({ found: true, name: 'ceo' });
  });
});

describe('리더 명령 해석', () => {
  it('claude --agent X 꼴만 이름, 그 밖은 직접 지정(null)', () => {
    expect(leadAgentName('claude --agent ceo')).toBe('ceo');
    expect(leadAgentName('  claude  --agent=code-reviewer ')).toBe('code-reviewer');
    expect(leadAgentName('claude --agent ceo --model opus')).toBeNull();
    expect(leadAgentName('& "C:\\c.exe" --agent ceo')).toBeNull();
    expect(leadAgentName('claude')).toBeNull();
    expect(leadCommandFor('pm')).toBe('claude --agent pm');
    expect(flagOn('1') && flagOn('TRUE') && flagOn(' on ')).toBe(true);
    expect(flagOn('0') || flagOn('') || flagOn(undefined) || flagOn(1)).toBe(false);
  });
});

describe('팀원 대조', () => {
  const names = ['ceo', 'pm', 'developer', 'qa', 'code-reviewer'];
  it('@언급·표 첫 칸에서 후보를 모아 목록에 없는 이름만 경고(머리 행·자기 자신 제외)', () => {
    const body = '팀원: @pm, @designer 에게 맡긴다.\n\n| 이름 | 역할 |\n|---|---|\n| developer | 구현 |\n| security | 보안 |\n| `qa` | 검증 |\n\n@ceo 는 나.';
    const r = teammateCheck(body, 'ceo', names);
    expect(r.missing).toEqual(['designer', 'security']);
    expect(r.referenced.sort()).toEqual(['developer', 'pm', 'qa']);
  });

  it('영문 머리 행(name|role)도 이름으로 세지 않음, 이메일의 @는 무시', () => {
    const body = '| name | role |\n| --- | --- |\n| pm | x |\n연락: a@example.com';
    expect(teammateCheck(body, 'ceo', names).missing).toEqual([]);
  });

  it('후보가 하나도 없으면 경고 없음, 하이픈 이름도 단어 경계로', () => {
    const r = teammateCheck('코드 리뷰는 code-reviewer가 한다. reviewer만 쓰면 안 됨', 'ceo', names);
    expect(r.missing).toEqual([]);
    expect(r.referenced).toEqual(['code-reviewer']);
  });
});

describe('판정·선택지', () => {
  const entry = (name: string, o: Partial<AgentsDto['agents'][number]> = {}) => ({ file: `${name}.md`, scope: 'global' as const, name, description: null, error: null, referenced: [], missing: [], ...o });
  const dto = (o: Partial<AgentsDto> = {}): AgentsDto => ({
    globalDir: 'g', projectDir: null, projectFolder: null, agents: [entry('ceo'), entry('pm')], truncated: false,
    teams: { enabled: true, source: '앱 환경변수', teammateMode: null }, leadCommand: 'claude --agent ceo', leadName: 'ceo', ...o,
  });

  it('리더 있음 + 참조 팀원 있음 + 팀 기능 켜짐 → 사용 가능(빈 배열)', () => {
    expect(agentIssues(dto(), 'ceo')).toEqual([]);
  });

  it('항목별 안내: 팀 기능 꺼짐, 정의 없음, 리더 없음, 참조 없음, 직접 지정', () => {
    expect(agentIssues(dto({ teams: { enabled: false, source: null, teammateMode: null } }), 'ceo')).toEqual(['팀 기능이 꺼져 있습니다.']);
    expect(agentIssues(dto({ agents: [] }), 'ceo')).toEqual(['에이전트 정의가 없습니다.', '리더 정의(ceo.md)가 없습니다.']);
    expect(agentIssues(dto({ agents: [entry('ceo', { missing: ['qa', 'designer'] })] }), 'ceo')).toEqual(['리더가 참조하는 정의 없음: qa, designer']);
    expect(agentIssues(dto(), null)[0]).toMatch(/직접 지정/);
  });

  it('선택지: 형식 오류 제외, 같은 이름은 앞(프로젝트)만', () => {
    const list = selectableAgents([entry('ceo', { scope: 'project' }), entry('ceo'), entry('x', { error: '형식 오류', name: null }), entry('pm')]);
    expect(list.map((a) => `${a.scope}:${a.name}`)).toEqual(['project:ceo', 'global:pm']);
  });
});

describe('조사(가짜 홈·프로젝트, 읽기 전용)', () => {
  const home = join(tmp, 'home', '.claude');
  const proj = join(tmp, 'proj');
  const write = (dir: string, file: string, text: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), text);
  };

  it('전역 + 프로젝트, 형식 오류·크기 상한·하위 폴더 무시, 리더 대조', async () => {
    write(join(home, 'agents'), 'ceo.md', '---\nname: ceo\ndescription: 리더\n---\n@pm @qa @designer 에게 맡긴다');
    write(join(home, 'agents'), 'pm.md', '---\nname: pm\ndescription: 기획\n---\n');
    write(join(home, 'agents'), 'broken.md', '# frontmatter 없음');
    write(join(home, 'agents'), 'noname.md', '---\ndescription: 이름 없음\n---\n');
    write(join(home, 'agents'), 'bad name.md', '---\nname: bad name\n---\n');
    write(join(home, 'agents'), 'big.md', `---\nname: big\n---\n${'x'.repeat(AGENT_FILE_MAX + 1)}`);
    write(join(home, 'agents'), 'notes.txt', 'ignored');
    mkdirSync(join(home, 'agents', 'sub.md'), { recursive: true });
    write(join(proj, '.claude', 'agents'), 'qa.md', '---\nname: qa\ndescription: 프로젝트 검증\n---\n');
    setClaudeHomeForTest(home);
    const r = await listAgents(proj, 'claude --agent ceo');
    const byFile = Object.fromEntries(r.agents.map((a) => [`${a.scope}:${a.file}`, a]));
    expect(Object.keys(byFile).sort()).toEqual(['global:bad name.md', 'global:big.md', 'global:broken.md', 'global:ceo.md', 'global:noname.md', 'global:pm.md', 'global:sub.md', 'project:qa.md']);
    expect(byFile['global:broken.md'].error).toMatch(/frontmatter/);
    expect(byFile['global:noname.md'].error).toMatch(/name이 없습니다/);
    expect(byFile['global:bad name.md'].error).toMatch(/쓸 수 없는 문자/);
    expect(byFile['global:big.md'].error).toMatch(/256KB/);
    expect(byFile['global:sub.md'].error).toMatch(/파일이 아닙니다/);
    expect(byFile['global:ceo.md'].missing).toEqual(['designer']);
    expect(byFile['global:ceo.md'].referenced.sort()).toEqual(['pm', 'qa']);
    expect(r.agents[0].scope).toBe('project'); // 프로젝트 정의가 앞
    expect(r).toMatchObject({ leadName: 'ceo', projectFolder: proj, truncated: false });
    expect(JSON.stringify(r)).not.toContain('에게 맡긴다'); // 본문은 내보내지 않음
  });

  it('폴더가 없으면 빈 목록', async () => {
    setClaudeHomeForTest(join(tmp, 'empty', '.claude'));
    const r = await listAgents(null, 'claude');
    expect(r.agents).toEqual([]);
    expect(r.leadName).toBeNull();
  });

  it('팀 기능: 앱 환경변수 → 사용자 환경변수 → settings.json env 순, teammateMode, 다른 값은 내보내지 않음', async () => {
    const h = join(tmp, 'h2', '.claude');
    write(h, 'settings.json', JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', SECRET_TOKEN: 'DO-NOT-LEAK' }, teammateMode: 'tmux', permissions: { allow: ['x'] } }));
    setClaudeHomeForTest(h);
    const none = async () => null;
    expect(await teamsStatus({}, none)).toEqual({ enabled: true, source: '~/.claude/settings.json env', teammateMode: 'tmux' });
    expect(await teamsStatus({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, none)).toMatchObject({ source: '앱 환경변수' });
    expect(await teamsStatus({}, async () => '1')).toMatchObject({ source: '사용자 환경변수' });
    expect(JSON.stringify(await teamsStatus({}, none))).not.toContain('DO-NOT-LEAK');
    write(h, 'settings.json', JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0' } }));
    expect(await teamsStatus({}, none)).toEqual({ enabled: false, source: null, teammateMode: null });
  });
});

describe('오류 배너 상태(TC-180)', () => {
  it('새 오류는 통째로 교체: 이어가기 대상은 명시할 때만 붙고, 다른 오류로 바뀌면 사라진다', () => {
    const running = errorNotice('실행 중인 대화입니다', 'sid-1');
    expect(running).toEqual({ message: '실행 중인 대화입니다', forceSid: 'sid-1' });
    const next = errorNotice('로그아웃을 확인하지 못했습니다');
    expect(next).toEqual({ message: '로그아웃을 확인하지 못했습니다', forceSid: null });
    expect(errorNotice(null)).toBeNull();
    expect(errorNotice('')).toBeNull();
  });
});
