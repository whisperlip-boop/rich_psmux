import { describe, expect, it } from 'vitest';

import { CommandQueue } from '../../src/main/controlMode/client';
import { clampSize, diffPanes, panesToBreak, parseListPanes, type PaneInfo } from '../../src/main/psmux/panes';
import { isAppSessionName, makeSessionName } from '../../src/main/psmux/sessionName';

describe('parseListPanes', () => {
  it('parses rows, keeps command with spaces, skips garbage and duplicates', () => {
    const ps = parseListPanes(['%1 @1 200 50 0 2 claude', '%5 @1 100 30 1 2 shell', 'garbage', '%1 @1 1 1 0 1 x', '%7 @3 80 24 0 1 node my script']);
    expect(ps.map((p) => p.paneId)).toEqual(['%1', '%5', '%7']);
    expect(ps[1]).toEqual({ paneId: '%5', windowId: '@1', width: 100, height: 30, dead: true, windowPanes: 2, command: 'shell' });
    expect(ps[2].command).toBe('node my script');
  });
});

describe('diffPanes', () => {
  const p = (id: string, w = 80, dead = false, win = '@1'): PaneInfo => ({ paneId: id, windowId: win, width: w, height: 24, dead, windowPanes: 1, command: 'pwsh' });
  it('detects added, removed, changed; dead panes count as removed', () => {
    const prev = new Map([['%1', p('%1')], ['%5', p('%5')]]);
    const d = diffPanes(prev, [p('%1', 100), p('%5', 80, true), p('%6')]);
    expect(d.added.map((x) => x.paneId)).toEqual(['%6']);
    expect(d.removed).toEqual(['%5']);
    expect(d.changed.map((x) => x.paneId)).toEqual(['%1']);
  });
});

describe('panesToBreak', () => {
  it('breaks non-lead panes sharing a window', () => {
    const ps = parseListPanes(['%1 @1 200 50 0 2 claude', '%5 @1 100 50 0 2 claude', '%6 @2 80 24 0 1 claude', '%7 @1 1 1 1 2 shell']);
    expect(panesToBreak(ps, '%1')).toEqual(['%5']);
  });
});

describe('clampSize', () => {
  it('clamps to sane limits', () => {
    expect(clampSize(5, 2)).toEqual({ cols: 20, rows: 5 });
    expect(clampSize(120.7, 40.2)).toEqual({ cols: 120, rows: 40 });
    expect(clampSize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ cols: 80, rows: 24 });
  });
});

describe('makeSessionName', () => {
  it('normalizes folder names', () => {
    expect(makeSessionName('D:\\github\\Private\\win_memory', 'a1b2c3')).toBe('ctd-win_memory-a1b2c3');
    expect(makeSessionName('D:\\work\\my.proj:v2\\', 'a1b2c3')).toBe('ctd-my_proj_v2-a1b2c3');
    expect(makeSessionName('C:\\사용자\\한글 폴더', '000000')).toBe('ctd-session-000000');
    expect(makeSessionName('C:\\x\\' + 'a'.repeat(60), 'ffffff')).toBe(`ctd-${'a'.repeat(24)}-ffffff`);
    expect(() => makeSessionName('C:\\x', 'zz')).toThrow();
  });
  it('recognizes app sessions', () => {
    expect(isAppSessionName('ctd-win_memory-a1b2c3')).toBe(true);
    expect(isAppSessionName('win_memory')).toBe(false);
    expect(isAppSessionName('ctd-a;b')).toBe(false);
  });
});

describe('CommandQueue', () => {
  const blk = (num: number, lines: string[] = [], ok = true) => ({ ok, lines, num });
  it('matches responses by command number and keeps timed-out slots', () => {
    const q = new CommandQueue();
    const got: string[] = [];
    const a = q.push('cmd-a', (r) => got.push(`a:${r.ok}`));
    q.push('cmd-b', (r) => got.push(`b:${r.lines[0]}`));
    a.cancel(); // 호출자 타임아웃: 자리는 유지
    expect(q.resolve(blk(1, ['for-a']))).toBe('matched');
    expect(q.resolve(blk(2, ['for-b']))).toBe('matched');
    expect(got).toEqual(['b:for-b']);
    expect(q.resolve(blk(3))).toBe('empty');
  });
  it('fails earlier slots with "no response" when a later number arrives', () => {
    const q = new CommandQueue();
    const got: string[] = [];
    q.push('x1', (r) => got.push(`1:${r.lines[0]}`));
    q.push('x2', (r) => got.push(`2:${r.lines[0]}`));
    q.push('x3', (r) => got.push(`3:${r.lines[0]}`));
    expect(q.resolve(blk(1, ['one']))).toBe('matched');
    expect(q.resolve(blk(3, ['three']))).toBe('skipped');
    expect(got).toEqual(['1:one', '2:no response', '3:three']);
    expect(q.length).toBe(0);
  });
  it('reports drift for an unknown/older number without consuming the queue', () => {
    const q = new CommandQueue();
    q.push('x1', () => undefined);
    q.push('x2', () => undefined);
    expect(q.resolve(blk(1))).toBe('matched');
    expect(q.resolve(blk(1))).toBe('drift'); // 같은 번호가 다시 옴
    expect(q.resolve(blk(9))).toBe('drift'); // 큐에 없는 큰 번호
    expect(q.length).toBe(1);
    expect(q.headNum).toBe(2);
  });
  it('calibrates the starting number from the first response', () => {
    const q = new CommandQueue();
    const got: string[] = [];
    q.push('x1', (r) => got.push(r.lines[0]));
    q.push('x2', (r) => got.push(r.lines[0]));
    expect(q.resolve(blk(41, ['a']))).toBe('matched');
    expect(q.resolve(blk(42, ['b']))).toBe('matched');
    expect(got).toEqual(['a', 'b']);
  });
  it('treats send-keys "command timed out" as success, and failAll', () => {
    const q = new CommandQueue();
    const got: boolean[] = [];
    q.push("send-keys -t %1 -l 'x'", (r) => got.push(r.ok));
    q.push('list-panes', (r) => got.push(r.ok));
    q.resolve(blk(1, ['command timed out'], false));
    q.failAll('bye');
    expect(got).toEqual([true, false]);
    expect(q.length).toBe(0);
  });
});
