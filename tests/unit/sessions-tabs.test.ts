import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { appendLeadId, listMetaSessions, MAX_LEAD_IDS, parseMeta, readSessionMeta, removeSessionFiles, sessionFiles, UiStateStore, writeSessionMeta } from '../../src/main/appData';
import { selectRestorable, staleSessions } from '../../src/main/psmux/sessionName';
import type { RunningDto, TabStateDto } from '../../src/shared/api';
import { displayTitle, formatTime, groupHistory, itemDot } from '../../src/renderer/history';
import { HoldBuffer } from '../../src/renderer/holdBuffer';
import { DEFAULT_TAB_UI, ratioFromKey } from '../../src/renderer/layout';
import { nextActiveAfterClose, normalizeSavedTabUi, tabStatus, toSavedTabUi, workingTabCount } from '../../src/renderer/tabs';

vi.mock('../../src/main/logger', () => ({ log: () => undefined, errMsg: (e: unknown) => String(e) }));

const tmp = mkdtempSync(join(tmpdir(), 'ctd-sessions-tabs-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('session restore filter', () => {
  it('restores only ctd- sessions that have app data; external (ceoteam) and foreign ctd- sessions are skipped', () => {
    const live = ['win_memory', 'github', 'ctd-a-000001', 'ctd-b-000002', 'ctd-qa-x', 'ctd-bad;name'];
    expect(selectRestorable(live, ['ctd-a-000001', 'ctd-b-000002', 'ctd-gone-000003', 'ctd-bad;name'])).toEqual(['ctd-a-000001', 'ctd-b-000002']);
    expect(staleSessions(live, ['ctd-a-000001', 'ctd-gone-000003'])).toEqual(['ctd-gone-000003']);
  });
});

describe('app data per session', () => {
  it('meta round-trip and validation', () => {
    writeSessionMeta(tmp, {
      session: 'ctd-a-000001', folder: 'D:\\x', leadPaneId: '%0', leadCommand: 'claude --agent boss', createdAt: 5, resumeSessionId: '4df7e772-1111-2222-3333-444455556666',
      leadSessionId: '9a8b7c6d-1111-2222-3333-444455556666',
    });
    expect(readSessionMeta(tmp, 'ctd-a-000001')).toMatchObject({
      folder: 'D:\\x', leadPaneId: '%0', leadCommand: 'claude --agent boss', resumeSessionId: '4df7e772-1111-2222-3333-444455556666', leadSessionId: '9a8b7c6d-1111-2222-3333-444455556666',
    });
    expect(listMetaSessions(tmp)).toContain('ctd-a-000001');
    const bad = parseMeta({ folder: 'D:\\y', leadPaneId: 'x', leadCommand: 'a\nb', resumeSessionId: '; rm -rf', leadSessionId: '../x' }, 's');
    expect(bad).toEqual({
      session: 's', folder: 'D:\\y', leadPaneId: null, leadCommand: 'claude --agent ceo', createdAt: 0, resumeSessionId: undefined,
    });
    // 잘못된 대화 ID는 버린다(형식이 틀리면 undefined)
    expect(bad?.leadSessionId).toBeUndefined();
    expect(parseMeta({ folder: 'D:\\y', leadSessionId: 42 }, 's')?.leadSessionId).toBeUndefined();
  });
  it('leadSessionIds: 잘못된 값·중복(대소문자 무시)은 버리고 최근 MAX_LEAD_IDS개, 옛 메타는 leadSessionId로 채움', () => {
    const id = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
    const m = parseMeta({ folder: 'D:\\y', leadSessionIds: [id(1), 'bad', 7, id(1).toUpperCase(), id(2)], leadSessionId: id(3) }, 's');
    expect(m?.leadSessionIds).toEqual([id(1), id(2), id(3)]);
    expect(m?.leadSessionId).toBe(id(3));
    const many = parseMeta({ folder: 'D:\\y', leadSessionIds: Array.from({ length: 60 }, (_, i) => id(i)) }, 's');
    expect(many?.leadSessionIds).toHaveLength(MAX_LEAD_IDS);
    expect(many?.leadSessionIds?.[0]).toBe(id(10));
    expect(parseMeta({ folder: 'D:\\y', leadSessionId: id(5) }, 's')?.leadSessionIds).toEqual([id(5)]);
    expect(parseMeta({ folder: 'D:\\y', leadSessionIds: 'x' }, 's')?.leadSessionIds).toBeUndefined();
    // 덧붙이기: 있으면 그대로, 새 ID면 끝에(입력은 바꾸지 않음)
    const base = [id(1)];
    expect(appendLeadId(base, id(1).toUpperCase())).toEqual([id(1)]);
    expect(appendLeadId(base, id(2))).toEqual([id(1), id(2)]);
    expect(base).toEqual([id(1)]);
    expect(parseMeta({}, 's')).toBeNull();
    expect(readSessionMeta(tmp, '../evil')).toBeNull();
  });
  it('removes meta, label cache and hook files of an ended session only', () => {
    const f = sessionFiles(tmp, 'ctd-b-000002');
    const keep = sessionFiles(tmp, 'ctd-c-000003');
    for (const p of [...Object.values(f), keep.meta]) {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, '{}');
    }
    removeSessionFiles(tmp, 'ctd-b-000002');
    expect(Object.values(f).map((p) => existsSync(p))).toEqual([false, false, false, false]);
    expect(existsSync(keep.meta)).toBe(true);
  });
  it('ui state store validates names and sizes', () => {
    const file = join(tmp, 'ui-state.json');
    const s = new UiStateStore(file);
    s.setCollapsed(['d:\\x', 5]);
    s.setTab('ctd-a-000001', { layout: 4 });
    s.setTab('../x', { layout: 1 });
    s.setTab('ctd-big', { x: 'y'.repeat(30000) });
    s.flush();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw).toEqual({ collapsed: ['d:\\x'], tabs: { 'ctd-a-000001': { layout: 4 } }, sidebarCollapsed: false, sidebarWidth: 240, historyFilter: {}, plainSessions: [] });
    s.removeTab('ctd-a-000001');
    s.flush();
    expect(new UiStateStore(file).get().tabs).toEqual({});
  });
});

const pane = (id: string, o: Partial<{ working: boolean; waiting: boolean }> = {}) => ({
  paneId: id, windowId: '@1', cols: 80, rows: 24, working: false, waiting: false,
  label: { name: id, color: '', textColor: '', isLead: id === '%0', source: 'lead' as const }, ...o,
});
const tab = (o: Partial<TabStateDto>): TabStateDto => ({
  tabId: 't', session: 'ctd-t-000001', folder: 'D:\\x', status: 'connected', leadPaneId: '%0', teamName: null, panes: [pane('%0')],
  plain: false, hooksEnabled: true, leadSessionId: null, resumeSessionId: null, leadGone: false, terminating: false, createdAt: 0, purpose: 'conversation', loginFailed: false, ...o,
});

describe('tab status aggregation', () => {
  it('approval > disconnected > working > idle', () => {
    expect(tabStatus(tab({}))).toBe('idle');
    expect(tabStatus(tab({ panes: [pane('%0'), pane('%1', { working: true })] }))).toBe('working');
    expect(tabStatus(tab({ status: 'reconnecting', panes: [pane('%0', { working: true })] }))).toBe('disconnected');
    expect(tabStatus(tab({ status: 'ended', panes: [pane('%1', { waiting: true })] }))).toBe('approval');
  });
  it('counts working tabs (approval counts as running team)', () => {
    expect(workingTabCount([tab({ panes: [pane('%0', { working: true })] }), tab({ panes: [pane('%3', { waiting: true })] }), tab({})])).toBe(2);
  });
  it('restores saved tab ui defensively and round-trips', () => {
    const v = toSavedTabUi({ layout: 4, activePane: '%2', mainRatio: { 3: 30, 4: 70 } }, [{ paneId: '%0', name: 'ceo' }, { paneId: null, name: 'qa' }], true);
    expect(normalizeSavedTabUi(JSON.parse(JSON.stringify(v)))).toEqual({
      ui: { layout: 4, activePane: '%2', mainRatio: { 3: 30, 4: 70 } }, slots: [{ paneId: '%0', name: 'ceo' }, { paneId: null, name: 'qa' }], bannerDone: true,
    });
    expect(normalizeSavedTabUi({ layout: 9, activePane: 'x', mainRatio: { 3: 99 }, slots: [{}, 5, { paneId: 'bad', name: 'n' }] })).toEqual({
      ui: { ...DEFAULT_TAB_UI, mainRatio: { 3: 75, 4: 50 } }, slots: [{ paneId: null, name: 'n' }], bannerDone: false,
    });
    expect(normalizeSavedTabUi(undefined).ui).toEqual(DEFAULT_TAB_UI);
  });
  it('picks the neighbour after closing a tab', () => {
    expect(nextActiveAfterClose(['a', 'b', 'c'], 'b', 'b')).toBe('c');
    expect(nextActiveAfterClose(['a', 'b', 'c'], 'c', 'c')).toBe('b');
    expect(nextActiveAfterClose(['a', 'b'], 'a', 'b')).toBe('b');
    expect(nextActiveAfterClose(['a'], 'a', 'a')).toBeNull();
  });
  it('split handle End key = 75%', () => {
    expect(ratioFromKey('End', 40)).toBe(75);
    expect(ratioFromKey('Home', 70)).toBe(50);
  });
});

describe('inactive tab hold buffer', () => {
  it('keeps chunks until the cap, then drops them and asks for resync', () => {
    const h = new HoldBuffer(10);
    h.push('t\u0000%0', 'abc');
    h.push('t\u0000%0', new Uint8Array(5));
    h.push('u\u0000%0', 'x');
    expect(h.take((k) => k.startsWith('t\u0000'))).toEqual([['t\u0000%0', { chunks: ['abc', new Uint8Array(5)], bytes: 8, overflow: false }]]);
    h.push('t\u0000%1', 'a'.repeat(11));
    h.push('t\u0000%1', 'more');
    expect(h.take((k) => k === 't\u0000%1')[0][1]).toEqual({ chunks: [], bytes: 0, overflow: true });
    h.push('t\u0000%1', 'a'.repeat(11));
    h.replace('t\u0000%1', 'SCREEN');
    expect(h.take(() => true).map(([k, v]) => [k, v.chunks, v.overflow])).toEqual([['u\u0000%0', ['x'], false], ['t\u0000%1', ['SCREEN'], false]]);
  });
});

describe('sidebar rules', () => {
  const now = new Date(2026, 9, 23, 18, 0);
  it('time format: today / yesterday / this year / older', () => {
    expect(formatTime(new Date(2026, 9, 23, 9, 5).getTime(), now)).toBe('09:05');
    expect(formatTime(new Date(2026, 9, 22, 23, 59).getTime(), now)).toBe('어제');
    // 날짜는 Intl(현재 언어 = 기본 ko)
    expect(formatTime(new Date(2026, 0, 2).getTime(), now)).toBe('01. 02.');
    expect(formatTime(new Date(2025, 9, 21).getTime(), now)).toBe('2025. 10. 21.');
    expect(formatTime(Number.NaN, now)).toBe('');
  });
  const item = (sid: string, folderKey: string, folderName: string, mtimeMs: number, title: string | null) =>
    ({ sessionId: sid, title, cwd: `D:\\${folderName}`, folderKey, folderName, mtimeMs, kind: 'lead' as const, mates: 0, key: `d/${sid}.jsonl`, customTitle: null, archived: false, createdMs: null });
  const items = [item('a', 'd:\\one', 'one', 10, 'Alpha'), item('b', 'd:\\two', 'two', 30, 'Beta'), item('c', 'd:\\one', 'One', 20, null)];
  it('groups by folder (newest group first, newest item first) and searches title + folder name', () => {
    const g = groupHistory(items, '', now);
    expect(g.map((x) => [x.key, x.items.map((i) => i.sessionId)])).toEqual([['d:\\two', ['b']], ['d:\\one', ['c', 'a']]]);
    expect(groupHistory(items, 'alp', now).map((x) => x.items.map((i) => i.sessionId))).toEqual([['a']]);
    expect(groupHistory(items, 'TWO', now)[0].items[0].sessionId).toBe('b');
    expect(groupHistory(items, 'zzz', now)).toEqual([]);
    expect(displayTitle(items[2], now)).toBe(`One ${formatTime(20, now)}`);
  });
  it('status dot: open tab working/idle, our detached session, external = none', () => {
    const run: RunningDto[] = [
      { sessionId: 'det', psmuxSession: 'ctd-det-000009', ours: true },
      { sessionId: 'ext', psmuxSession: 'win_memory', ours: false },
      { sessionId: 'new-id', psmuxSession: 'ctd-t-000001', ours: true },
    ];
    const tabs = [tab({ leadSessionId: 'open', panes: [pane('%0', { working: true })] })];
    expect(itemDot('OPEN', tabs, run)).toBe('working');
    expect(itemDot('det', tabs, run)).toBe('detached');
    expect(itemDot('ext', tabs, run)).toBeNull();
    expect(itemDot('none', tabs, run)).toBeNull();
    // 탭의 sessionId 갱신 전이라도 실행 중 세션이 열린 탭이면 그 탭 상태
    expect(itemDot('new-id', [tab({ panes: [pane('%0')] })], run)).toBe('idle');
    expect(itemDot('old', [tab({ resumeSessionId: 'old' })], [])).toBe('idle');
  });
});

describe('tab order and Ctrl+W scope', () => {
  it('tab order: reconnected tabs go back to their creation-time slot', async () => {
    const { insertByCreatedAt } = await import('../../src/renderer/tabs');
    const at: Record<string, number> = { a: 10, c: 30 };
    expect(insertByCreatedAt(['a', 'c'], 'b', 20, (x) => at[x])).toEqual(['a', 'b', 'c']);
    expect(insertByCreatedAt(['a', 'c'], 'z', 99, (x) => at[x])).toEqual(['a', 'c', 'z']);
    expect(insertByCreatedAt(['a', 'c'], 'a', 1, (x) => at[x])).toEqual(['a', 'c']);
  });
  it('Ctrl+W only from tab bar / sidebar non-text focus', async () => {
    const { ctrlWAllowed } = await import('../../src/renderer/tabs');
    const el = (tagName: string, inside: string[]): Element => ({ tagName, isContentEditable: false, closest: (sel: string) => (sel.split(',').some((x) => inside.includes(x.trim())) ? {} : null) }) as unknown as Element;
    expect(ctrlWAllowed(el('DIV', ['.tabbar']))).toBe(true);
    expect(ctrlWAllowed(el('BUTTON', ['.sidebar']))).toBe(true);
    expect(ctrlWAllowed(el('INPUT', ['.sidebar']))).toBe(false);
    expect(ctrlWAllowed(el('TEXTAREA', ['.card']))).toBe(false);
    expect(ctrlWAllowed(el('TEXTAREA', ['.xterm', '.tabbar']))).toBe(false);
    expect(ctrlWAllowed(el('BUTTON', ['.card']))).toBe(false);
    expect(ctrlWAllowed(null)).toBe(false);
  });
});
