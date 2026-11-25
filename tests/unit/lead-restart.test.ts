// 다시 시작 칩: 리드 칸이 살아 있는 채 Claude Code만 끝나 셸로 돌아왔을 때만 표시, 눌렀을 때만 같은 칸·폴더에서 리드 명령(-r) 실행.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { inputToCommands } from '../../src/main/controlMode/quote';
import { TabSession, type SessionOptions } from '../../src/main/psmux/sessionManager';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
/** 칩을 눌렀을 때 리드 칸에 입력돼야 하는 명령: 탭 폴더로 이동(실패하면 멈춤) + 리드 명령을 한 줄로. */
const expected = (lead: string): string[] => inputToCommands('%0', `Set-Location -LiteralPath 'D:\\work dir' -ErrorAction Stop; ${lead}`);

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** 연결 없이 칸 목록·입력만 흉내 낸 세션(private 필드는 테스트에서만 직접 맞춘다). */
function fake(o: Partial<SessionOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'lr-'));
  dirs.push(dataDir);
  const s = new TabSession({ psmux: 'psmux', folder: 'D:\\work dir', leadCommand: 'claude --agent ceo', dataDir, hookCommand: null, ...o });
  const raw = s as unknown as Record<string, unknown>;
  const sent: string[] = [];
  raw.leadPaneId = '%0';
  raw.runCommands = async (cmds: string[]) => { sent.push(...cmds); return true; };
  // 누른 시점 확인(display-message)은 칸의 지금 프로그램을 돌려준다. now로 폴링 값과 다르게 둘 수 있다
  const pane = { now: '' };
  raw.cmd = async () => ({ ok: true, lines: [pane.now] });
  const run = (command: string): boolean => {
    pane.now = command;
    raw.panes = new Map([['%0', { paneId: '%0', windowId: '@0', width: 80, height: 24, dead: false, windowPanes: 1, command }]]);
    (raw.trackLeadExit as () => void).call(s);
    return s.state().leadExited;
  };
  return { s, raw, sent, run, pane };
}

describe('다시 시작 칩(리드 프로그램 종료)', () => {
  it('프로그램을 본 뒤 셸로 돌아오면 표시, 다시 프로그램이면 내림', () => {
    const { run } = fake();
    expect(run('pwsh')).toBe(false); // 리드 실행 전 셸
    expect(run('claude')).toBe(false);
    expect(run('')).toBe(false); // 모르는 값은 상태를 바꾸지 않는다
    expect(run('pwsh')).toBe(true);
    expect(run('node')).toBe(false); // 사용자가 셸에서 직접 다시 실행
  });

  it('프로그램을 보기 전에는 셸이 오래 보여도 표시하지 않는다(늦게 뜨는 Claude에 두 번 실행 방지)', () => {
    const { run } = fake();
    expect(run('pwsh')).toBe(false);
    expect(run('pwsh')).toBe(false);
  });

  it('로그인 탭에는 표시하지 않는다', () => {
    const { run } = fake({ purpose: 'login' });
    run('claude');
    expect(run('pwsh')).toBe(false);
  });

  it('Restart는 탭 폴더로 이동 후 -r 없이, 두 번 눌러도 한 번만', async () => {
    const { s, sent, run } = fake();
    run('claude');
    run('pwsh');
    expect(await s.restartLead(false, null)).toBe(true);
    expect(s.state().leadExited).toBe(false);
    expect(await s.restartLead(false, null)).toBe(false);
    expect(sent).toEqual(expected('claude --agent ceo'));
    // 다시 시작 직후 폴링이 아직 셸을 봐도 칩을 되살리지 않는다
    expect(run('pwsh')).toBe(false);
  });

  it('누른 시점에 칸에서 프로그램이 돌고 있으면 입력하지 않고 칩만 내린다', async () => {
    const { s, sent, run, pane } = fake();
    run('claude');
    run('pwsh');
    pane.now = 'claude'; // 폴링 사이에 사용자가 직접 claude 실행
    expect(await s.restartLead(false, null)).toBe(false);
    expect(sent).toEqual([]);
    expect(s.state().leadExited).toBe(false);
    expect(run('claude')).toBe(false);
    expect(run('pwsh')).toBe(true); // 그 claude가 끝나면 다시 표시
  });

  it('Resume은 마지막 리드 대화 ID로 -r, ID를 모르면 -r만(대화 선택)', async () => {
    const a = fake();
    a.raw.leadSessionId = ID;
    a.run('claude');
    a.run('pwsh');
    await a.s.restartLead(true, null);
    expect(a.sent).toEqual(expected(`claude --agent ceo -r ${ID}`));

    const b = fake();
    b.raw.leadSessionId = 'bad; rm -rf'; // 형식이 틀린 ID는 명령에 넣지 않는다
    b.run('claude');
    b.run('pwsh');
    await b.s.restartLead(true, null);
    expect(b.sent).toEqual(expected('claude --agent ceo -r'));
  });

  it('입력이 실패하면 false, 칸이 셸이면 다음 폴링에서 칩이 다시 뜬다', async () => {
    const { s, raw, run } = fake();
    run('claude');
    run('pwsh');
    raw.runCommands = async () => false;
    expect(await s.restartLead(false, null)).toBe(false);
    expect(s.state().leadExited).toBe(false);
    expect(run('pwsh')).toBe(true);
  });

  it('기존 세션에 붙은 탭: 누를 때 받은 statusLine과 hook을 --settings에 넣는다', async () => {
    const { s, raw, sent, run } = fake({ attachName: 'ctd-x-000001', hookCommand: '"node" "hook.js"' });
    expect(run('pwsh')).toBe(true); // 붙은 세션은 리드를 이미 실행한 것으로 본다
    expect(await s.restartLead(false, '"node" "statusLine.js" "u.json"')).toBe(true);
    const file = raw.hookSettingsFile as string;
    expect(sent).toEqual(expected(`claude --agent ceo --settings '${file}'`));
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(json.statusLine).toEqual({ type: 'command', command: '"node" "statusLine.js" "u.json"' });
    expect(json.hooks).toBeTruthy();
  });

  it('기존 세션에 붙은 탭도 설정한 셸(pwsh 외 이름)을 셸로 본다', () => {
    expect(fake({ attachName: 'ctd-x-000001', shell: 'C:/tools/nu.exe' }).run('nu')).toBe(true);
    expect(fake({ attachName: 'ctd-x-000001' }).run('nu')).toBe(false);
  });
});
