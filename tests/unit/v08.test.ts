// v0.8: Agents 소규모 수정(TC-200 상한 순서, TC-203 대소문자, TC-205 팀원 대조 오탐).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { setClaudeHomeForTest } from '../../src/main/claudeHome';
import { AGENT_COUNT_MAX, listAgents } from '../../src/main/agentsScan';
import type { AgentsDto } from '../../src/shared/api';
import { teammateCheck } from '../../src/shared/agents';
import { agentIssues, findAgent, initialSelection, selectableAgents } from '../../src/renderer/components/AgentsDialog';

vi.mock('../../src/main/logger', () => ({ log: () => undefined, errMsg: (e: unknown) => String(e) }));

const tmp = mkdtempSync(join(tmpdir(), 'ctd-v08-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => setClaudeHomeForTest(null));

const md = (name: string, body = '') => `---\nname: ${name}\ndescription: d\n---\n${body}`;
const write = (dir: string, file: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
};

describe('TC-200 상한: 프로젝트 먼저, 남는 개수만 전역', () => {
  it('전역이 상한을 넘어도 프로젝트 정의(리더)는 모두 읽고 합계는 상한', async () => {
    const home = join(tmp, 'cap', '.claude');
    const proj = join(tmp, 'cap', 'proj');
    for (let i = 0; i < AGENT_COUNT_MAX + 30; i++) write(join(home, 'agents'), `g${String(i).padStart(3, '0')}.md`, md(`g${i}`));
    write(join(proj, '.claude', 'agents'), 'ceo.md', md('ceo', '@pm 에게'));
    write(join(proj, '.claude', 'agents'), 'pm.md', md('pm'));
    setClaudeHomeForTest(home);
    const r = await listAgents(proj, 'claude --agent ceo');
    expect(r.agents.length).toBe(AGENT_COUNT_MAX);
    expect(r.agents.filter((a) => a.scope === 'project').map((a) => a.name)).toEqual(['ceo', 'pm']);
    expect(r.agents.filter((a) => a.scope === 'global').length).toBe(AGENT_COUNT_MAX - 2);
    expect(r.truncated).toBe(true);
    // 리더·참조 팀원이 프로젝트에 있으니 사용 가능(팀 기능은 이 PC 환경과 무관하게 켜진 것으로 고정)
    expect(agentIssues({ ...r, teams: { enabled: true, source: '앱 환경변수', teammateMode: null } }, 'ceo')).toEqual([]);
  });

  it('프로젝트만으로 상한이면 전역은 0개, 더 있음 표시', async () => {
    const home = join(tmp, 'cap2', '.claude');
    const proj = join(tmp, 'cap2', 'proj');
    write(join(home, 'agents'), 'ceo.md', md('ceo'));
    for (let i = 0; i < AGENT_COUNT_MAX; i++) write(join(proj, '.claude', 'agents'), `p${String(i).padStart(3, '0')}.md`, md(`p${i}`));
    setClaudeHomeForTest(home);
    const r = await listAgents(proj, 'claude --agent ceo');
    expect(r.agents.every((a) => a.scope === 'project')).toBe(true);
    expect(r.truncated).toBe(true);
  });

  const entry = (name: string, o: Partial<AgentsDto['agents'][number]> = {}) => ({ file: `${name}.md`, scope: 'global' as const, name, description: null, error: null, referenced: [], missing: [], ...o });
  const dto = (o: Partial<AgentsDto> = {}): AgentsDto => ({
    globalDir: 'g', projectDir: null, projectFolder: null, agents: [entry('pm')], truncated: true,
    teams: { enabled: true, source: '앱 환경변수', teammateMode: null }, leadCommand: 'claude --agent ceo', leadName: 'ceo', ...o,
  });

  it('상한에 걸려 리더·참조 팀원을 못 찾으면 "없음"이 아니라 "확인할 수 없음"', () => {
    expect(agentIssues(dto(), 'ceo')).toEqual(['리더 정의(ceo.md): 정의가 200개를 넘어 확인할 수 없습니다.']);
    expect(agentIssues(dto({ agents: [entry('ceo', { missing: ['qa'] })] }), 'ceo')).toEqual(['리더가 참조하는 정의(qa): 정의가 200개를 넘어 확인할 수 없습니다.']);
    expect(agentIssues(dto({ truncated: false }), 'ceo')).toEqual(['리더 정의(ceo.md)가 없습니다.']);
  });
});

describe('TC-203 드롭다운 선택값: 대소문자 무시로 정의 이름에 맞춤', () => {
  const list = selectableAgents([
    { file: 'CEO.md', scope: 'project', name: 'Ceo', description: null, error: null, referenced: [], missing: [] },
    { file: 'ceo.md', scope: 'global', name: 'ceo', description: null, error: null, referenced: [], missing: [] },
    { file: 'pm.md', scope: 'global', name: 'pm', description: null, error: null, referenced: [], missing: [] },
  ]);

  it('리드 명령 이름 CEO → 목록의 Ceo(프로젝트 우선), 없으면 그대로, 직접 지정은 null', () => {
    expect(initialSelection(list, 'CEO')).toBe('Ceo');
    expect(initialSelection(list, 'PM')).toBe('pm');
    expect(initialSelection(list, 'ghost')).toBe('ghost');
    expect(initialSelection(list, null)).toBeNull();
    expect(findAgent(list, 'cEo')?.scope).toBe('project');
  });
});

describe('TC-205 팀원 대조 오탐', () => {
  const names = ['ceo', 'pm', 'qa'];

  it('인라인 코드 안의 @는 무시', () => {
    const body = '예시: `@designer 에게 맡겨` 처럼 쓴다. ``a @security b`` 도 예시. 실제로는 @pm 에게.';
    expect(teammateCheck(body, 'ceo', names).missing).toEqual([]);
  });

  it('펜스 코드 블록(``` · ~~~) 안의 @와 표는 무시, 블록 밖은 그대로', () => {
    const body = ['```md', '@designer', '| 이름 | 역할 |', '|---|---|', '| ghost | x |', '```', '~~~', '@writer', '~~~', '@tester 에게'].join('\n');
    expect(teammateCheck(body, 'ceo', names).missing).toEqual(['tester']);
  });

  it('머리 행 첫 칸이 이름·name·agent·role·역할인 표만 대상(대소문자 무시)', () => {
    const body = [
      '| 파일 | 설명 |', '|---|---|', '| README | 안내 |', '| src | 코드 |', '',
      '| Option | 값 |', '| --- | --- |', '| verbose | true |', '',
      '| Agent | 담당 |', '| :--- | --- |', '| pm | 기획 |', '| security | 보안 |', '',
      '| 역할 | 설명 |', '|---|---|', '| `designer` | 디자인 |',
    ].join('\n');
    expect(teammateCheck(body, 'ceo', names).missing).toEqual(['security', 'designer']);
  });
});
