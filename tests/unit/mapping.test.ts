import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findLeadSessionId, readTeamConfig, resolveSafe, setClaudeHomeForTest } from '../../src/main/claudeHome';
import { applyHookRecord, emptyHookState, parseHookLine } from '../../src/main/teams/hookState';
import { colorFor, hashColor, LEAD_COLOR, leadNameFromCommand, matchesLeadTmux, PALETTE, resolveLabels, sanitizeConfig, teamNameFor, textColorFor } from '../../src/main/teams/paneMapper';

const RAW_CONFIG = {
  name: 'session-2bff0bfd',
  leadSessionId: '2bff0bfd-c982-4f75-9486-8d9160530bd2',
  members: [
    { name: 'team-lead', agentType: 'team-lead', tmuxPaneId: 'leader', backendType: 'in-process', prompt: 'secret body' },
    { name: 'pm', agentType: 'pm', tmuxPaneId: '%5', color: 'yellow', backendType: 'tmux', prompt: 'body' },
    { name: 'dev-tagfinder', agentType: 'developer', tmuxPaneId: '', color: 'red' },
    { bogus: true },
    null,
  ],
};

describe('sanitizeConfig', () => {
  it('keeps only needed fields and tolerates garbage', () => {
    const c = sanitizeConfig(RAW_CONFIG);
    expect(c.members).toHaveLength(3);
    expect(c.members[0].isLead).toBe(true);
    expect(JSON.stringify(c)).not.toContain('secret body');
    expect(sanitizeConfig(null).members).toEqual([]);
    expect(sanitizeConfig({ members: 'x' }).members).toEqual([]);
  });
});

describe('colors and names', () => {
  it('uses the fixed palette for named colors, hex as-is, else FNV-1a % 10', () => {
    expect(PALETTE).toHaveLength(10);
    expect(colorFor('pm', 'yellow')).toBe('#F1C232');
    expect(colorFor('pm', 'RED')).toBe('#E06666');
    expect(colorFor('pm', '#123abc')).toBe('#123ABC');
    expect(PALETTE).toContain(hashColor('anything'));
    expect(colorFor('qa', undefined)).toBe(hashColor('qa'));
    expect(hashColor('qa')).toBe(hashColor('qa'));
    expect(colorFor('x', 'nonsense')).toBe(hashColor('x'));
  });
  it('picks label text color by luminance (0.179)', () => {
    for (const c of PALETTE) expect(textColorFor(c)).toBe('#1F2328');
    expect(textColorFor('#123ABC')).toBe('#FFFFFF');
    expect(textColorFor('#FFFFFF')).toBe('#1F2328');
    expect(textColorFor('bad')).toBe('#1F2328');
  });
  it('extracts the --agent name', () => {
    expect(leadNameFromCommand('claude --agent ceo')).toBe('ceo');
    expect(leadNameFromCommand('claude --agent=lead2 -r abc')).toBe('lead2');
    expect(leadNameFromCommand("claude --agent 'my lead'")).toBe('my lead');
    expect(leadNameFromCommand('claude')).toBe('claude'); // Claude만 탭(탭 바 ▾ 메뉴)의 카드 이름
    expect(leadNameFromCommand('claude --model opus')).toBe('lead');
  });
  it('matches lead tmux field and team name', () => {
    expect(matchesLeadTmux('ctd-a-1:@1.%1', 'ctd-a-1', '%1')).toBe(true);
    expect(matchesLeadTmux('ctd-a-1:@1.%12', 'ctd-a-1', '%1')).toBe(false);
    expect(matchesLeadTmux('ctd-a-10:@1.%1', 'ctd-a-1', '%1')).toBe(false);
    expect(matchesLeadTmux(undefined, 'ctd-a-1', null)).toBe(false);
    expect(teamNameFor('2bff0bfd-c982')).toBe('session-2bff0bfd');
    expect(teamNameFor('x')).toBeNull();
  });
});

describe('resolveLabels', () => {
  const config = sanitizeConfig(RAW_CONFIG);
  it('maps lead, config panes, hook hints, cache, fallback', () => {
    const { labels, cache } = resolveLabels({
      panes: ['%1', '%5', '%6', '%7', '%8'], leadPaneId: '%1', leadName: 'ceo', config,
      cache: { '%7': { name: 'qa', color: '#000000', textColor: '#FFFFFF', isLead: false, source: 'config' } },
      hints: { '%6': { agentType: 'developer' } },
    });
    expect(LEAD_COLOR).toBe('#CF222E');
    expect(labels['%1']).toMatchObject({ name: 'ceo', color: LEAD_COLOR, isLead: true, source: 'lead' });
    expect(labels['%5']).toMatchObject({ name: 'pm', source: 'config', color: '#F1C232', textColor: '#1F2328' });
    expect(labels['%6']).toMatchObject({ name: 'dev-tagfinder', source: 'hook' });
    expect(labels['%7']).toMatchObject({ name: 'qa', source: 'cache' });
    expect(labels['%8']).toMatchObject({ name: '%8', source: 'fallback', color: 'transparent' });
    expect(Object.keys(cache).sort()).toEqual(['%1', '%5', '%6', '%7']);
  });
  it('keeps names from cache after the config is deleted', () => {
    const first = resolveLabels({ panes: ['%5'], leadPaneId: '%1', leadName: 'ceo', config, cache: {}, hints: {} });
    const after = resolveLabels({ panes: ['%5'], leadPaneId: '%1', leadName: 'ceo', config: null, cache: first.cache, hints: {} });
    expect(after.labels['%5']).toMatchObject({ name: 'pm', source: 'cache' });
  });
  it('does not guess when agentType is ambiguous', () => {
    const cfg = sanitizeConfig({ members: [{ name: 'd1', agentType: 'developer', tmuxPaneId: '' }, { name: 'd2', agentType: 'developer', tmuxPaneId: '' }] });
    const { labels } = resolveLabels({ panes: ['%3'], leadPaneId: '%1', leadName: 'ceo', config: cfg, cache: {}, hints: { '%3': { agentType: 'developer' } } });
    expect(labels['%3'].source).toBe('fallback');
  });
});

describe('hookState', () => {
  it('marks approval waiting from PermissionRequest / permission_prompt and clears on progress', () => {
    const st = emptyHookState();
    expect(applyHookRecord(st, { t: 1, event: 'SessionStart', sid: 's-lead', agentType: 'ceo' }, '%1', 'ceo')).toBe('%1');
    expect(applyHookRecord(st, { t: 2, event: 'PermissionRequest', sid: 's-lead', toolName: 'Bash' }, '%1', 'ceo')).toBe('%1');
    expect(st.waiting['%1']).toBe(2);
    applyHookRecord(st, { t: 3, event: 'PostToolUse', sid: 's-lead' }, '%1', 'ceo');
    expect(st.waiting['%1']).toBeUndefined();
    applyHookRecord(st, { t: 4, event: 'Notification', pane: '%5', sid: 's-pm', agentType: 'pm', notificationType: 'permission_prompt' }, '%1', 'ceo');
    expect(st.waiting['%5']).toBe(4);
    expect(st.hints['%5']).toEqual({ agentType: 'pm', teammateName: undefined });
    applyHookRecord(st, { t: 5, event: 'Notification', sid: 's-pm', notificationType: 'idle_prompt' }, '%1', 'ceo');
    expect(st.waiting['%5']).toBeUndefined();
  });
  it('returns null for events that cannot be mapped', () => {
    expect(applyHookRecord(emptyHookState(), { t: 1, event: 'Stop', sid: 'zzz', agentType: 'qa' }, '%1', 'ceo')).toBeNull();
  });
  it('parses lines defensively', () => {
    expect(parseHookLine('{"t":1,"event":"Stop","pane":"%2"}')).toMatchObject({ event: 'Stop', pane: '%2' });
    expect(parseHookLine('{"t":"x","event":"Stop"}')).toBeNull();
    expect(parseHookLine('{broken')).toBeNull();
  });
});

describe('claudeHome (read-only layer)', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctd-home-'));
    mkdirSync(join(dir, 'sessions'));
    mkdirSync(join(dir, 'teams', 'session-2bff0bfd'), { recursive: true });
    writeFileSync(join(dir, 'sessions', '111.json'), JSON.stringify({ sessionId: 'aaaa1111-x', tmux: 'other:@1.%1', updatedAt: 5 }));
    writeFileSync(join(dir, 'sessions', '222.json'), JSON.stringify({ sessionId: '2bff0bfd-c982', tmux: 'ctd-x-abc123:@1.%1', updatedAt: 9 }));
    writeFileSync(join(dir, 'sessions', '222.deadbeef.key'), 'SECRET');
    writeFileSync(join(dir, 'sessions', '333.json'), '{truncated');
    writeFileSync(join(dir, 'teams', 'session-2bff0bfd', 'config.json'), JSON.stringify(RAW_CONFIG));
    setClaudeHomeForTest(dir);
  });
  afterAll(() => {
    setClaudeHomeForTest(null);
    rmSync(dir, { recursive: true, force: true });
  });
  it('refuses secrets and paths outside the root', () => {
    expect(() => resolveSafe('.credentials.json')).toThrow(/secret/);
    expect(() => resolveSafe('sessions', '222.deadbeef.key')).toThrow(/secret/);
    expect(() => resolveSafe('..', 'x')).toThrow(/outside/);
    expect(resolveSafe('teams', 'a', 'config.json')).toContain('config.json');
  });
  it('finds the lead session by tmux field and reads the team config', async () => {
    expect(await findLeadSessionId('ctd-x-abc123', '%1')).toBe('2bff0bfd-c982');
    expect(await findLeadSessionId('ctd-none', '%1')).toBeNull();
    const cfg = await readTeamConfig('session-2bff0bfd');
    expect(cfg?.members.map((m) => m.name)).toEqual(['team-lead', 'pm', 'dev-tagfinder']);
    expect(await readTeamConfig('../escape')).toBeNull();
    expect(await readTeamConfig('session-missing')).toBeNull();
  });
});
