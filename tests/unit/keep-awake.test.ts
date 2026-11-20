// 잠자기 막기(설정 끔/에이전트/항상, 에이전트 모드 유예), 알림·잠자기 설정 검증, 이어가기 명령.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_GRACE_MS, KeepAwake, wantAwake } from '../../src/main/keepAwake';
import { DEFAULT_SETTINGS, diffFromDefaults, normalizeSettings } from '../../src/main/settings';
import { pwshQuote, resumeCommand } from '../../src/shared/agents';

vi.mock('../../src/main/logger', () => ({ log: () => undefined, errMsg: (e: unknown) => String(e) }));

describe('wantAwake', () => {
  it('follows the mode and keeps agent mode awake for the grace period', () => {
    expect(wantAwake('off', true, 0, 1)).toBe(false);
    expect(wantAwake('on', false, 0, 1)).toBe(true);
    expect(wantAwake('agent', true, 0, 10)).toBe(true);
    expect(wantAwake('agent', false, 1000, 1000 + AGENT_GRACE_MS - 1)).toBe(true);
    expect(wantAwake('agent', false, 1000, 1000 + AGENT_GRACE_MS)).toBe(false);
    expect(wantAwake('agent', false, 0, 10 * AGENT_GRACE_MS)).toBe(false);
  });
});

describe('KeepAwake', () => {
  let now = 0;
  const calls: string[] = [];
  const blocker = { start: () => { calls.push('start'); return 7; }, stop: (id: number) => { calls.push(`stop ${id}`); } };
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    calls.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('starts once, holds through short pauses and releases after the grace period', () => {
    const k = new KeepAwake(blocker, () => now);
    k.update('agent', false);
    expect(calls).toEqual([]); // 작업 전에는 막지 않음
    k.update('agent', true);
    k.update('agent', true);
    expect(calls).toEqual(['start']);
    now += 5000;
    k.update('agent', false); // 잠깐 멈춤: 유지
    expect(k.active).toBe(true);
    now += AGENT_GRACE_MS;
    vi.advanceTimersByTime(AGENT_GRACE_MS);
    expect(calls).toEqual(['start', 'stop 7']);
    expect(k.active).toBe(false);
  });
  it('a new working state cancels the pending release', () => {
    const k = new KeepAwake(blocker, () => now);
    k.update('agent', true);
    k.update('agent', false);
    now += 1000;
    k.update('agent', true);
    vi.advanceTimersByTime(AGENT_GRACE_MS * 2);
    expect(calls).toEqual(['start']);
  });
  it('on holds without work, off and release() stop it', () => {
    const k = new KeepAwake(blocker, () => now);
    k.update('on', false);
    expect(k.active).toBe(true);
    k.update('off', true);
    expect(calls).toEqual(['start', 'stop 7']);
    k.update('on', false);
    k.release();
    k.release(); // 두 번 불러도 한 번만
    expect(calls).toEqual(['start', 'stop 7', 'start', 'stop 7']);
  });
  it('a failing start is tried once per mode, then again after a mode change', () => {
    let tries = 0;
    const k = new KeepAwake({ start: () => { tries++; throw new Error('x'); }, stop: () => undefined }, () => now);
    k.update('on', false);
    k.update('on', true);
    k.update('on', false);
    expect(tries).toBe(1);
    k.update('agent', true);
    expect(tries).toBe(2);
  });
  it('release() forgets recent work so agent mode does not re-take the blocker within the grace', () => {
    const k = new KeepAwake(blocker, () => now);
    k.update('agent', true);
    k.release();
    now += 1000;
    k.update('agent', false);
    expect(k.active).toBe(false);
    expect(calls).toEqual(['start', 'stop 7']);
  });
  it('a failing blocker does not throw', () => {
    const k = new KeepAwake({ start: () => { throw new Error('x'); }, stop: () => undefined }, () => now);
    expect(() => k.update('on', false)).not.toThrow();
    expect(k.active).toBe(false);
  });
});

describe('notification and keep-awake settings', () => {
  it('defaults: notifications on, keep awake off; bad values fall back', () => {
    expect(DEFAULT_SETTINGS.notifications).toBe(true);
    expect(DEFAULT_SETTINGS.keepAwake).toBe('off');
    expect(normalizeSettings({ notifications: false, keepAwake: 'agent' })).toMatchObject({ notifications: false, keepAwake: 'agent' });
    expect(normalizeSettings({ notifications: 'no', keepAwake: 'always' })).toMatchObject({ notifications: true, keepAwake: 'off' });
    expect(diffFromDefaults(normalizeSettings({ keepAwake: 'on' }))).toEqual({ keepAwake: 'on' });
  });
});

describe('resume command', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  it('uses the lead command with -r and moves into the folder literally (PowerShell quoting)', () => {
    expect(resumeCommand('claude --agent ceo', id, 'D:\\proj')).toBe(`Set-Location -LiteralPath 'D:\\proj'; claude --agent ceo -r ${id}`);
    expect(resumeCommand('claude', id, "C:\\it's here")).toBe(`Set-Location -LiteralPath 'C:\\it''s here'; claude -r ${id}`);
    // [ ]는 -LiteralPath라 와일드카드가 아님
    expect(resumeCommand('claude', id, 'D:\\work[1]')).toBe(`Set-Location -LiteralPath 'D:\\work[1]'; claude -r ${id}`);
    expect(resumeCommand(' claude ', id, null)).toBe(`claude -r ${id}`);
    expect(pwshQuote("a'b")).toBe("'a''b'");
  });
  it('doubles every quote PowerShell reads as a single quote (smart quotes cannot end the string)', () => {
    expect(pwshQuote('a\u2019b')).toBe("'a\u2019\u2019b'");
    expect(pwshQuote('\u2018\u201a\u201b')).toBe("'\u2018\u2018\u201a\u201a\u201b\u201b'");
    // 주입 모양 경로: 모든 따옴표가 짝으로 남아 문자열이 중간에 끝나지 않는다
    const cmd = resumeCommand('claude', id, 'D:\\a\u2019; calc; \u2018b');
    expect(cmd).toBe(`Set-Location -LiteralPath 'D:\\a\u2019\u2019; calc; \u2018\u2018b'; claude -r ${id}`);
    const inner = cmd.slice('Set-Location -LiteralPath \''.length, cmd.indexOf("'; claude"));
    expect(inner.replace(/(['\u2018\u2019\u201a\u201b])\1/g, '')).not.toMatch(/['\u2018\u2019\u201a\u201b]/);
  });
});
