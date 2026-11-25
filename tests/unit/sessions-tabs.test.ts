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
import { agentEvents, clipName, DONE_RETRY_CAP_MS, DONE_SETTLE_MS, doneDecision, markUnread, nextActiveAfterClose, normalizeSavedTabUi, settleDone, tabStatus, TabTimers, toSavedTabUi, workingTabCount } from '../../src/renderer/tabs';

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

// 승인 대기면 대기 시작 시각을 기본 1000(테스트의 since보다 뒤)으로 둔다
const pane = (id: string, o: Partial<{ working: boolean; waiting: boolean; waitingAt: number | null; doneAt: number | null }> = {}) => ({
  paneId: id, windowId: '@1', cols: 80, rows: 24, working: false, waiting: false, doneAt: null as number | null,
  label: { name: id, color: '', textColor: '', isLead: id === '%0', source: 'lead' as const }, ...o,
  waitingAt: o.waiting ? o.waitingAt ?? 1000 : null,
});
const tab = (o: Partial<TabStateDto>): TabStateDto => ({
  tabId: 't', session: 'ctd-t-000001', folder: 'D:\\x', status: 'connected', leadPaneId: '%0', teamName: null, panes: [pane('%0')],
  plain: false, hooksEnabled: true, leadSessionId: null, resumeSessionId: null, leadGone: false, leadExited: false, terminating: false, createdAt: 0, purpose: 'conversation', loginFailed: false, ...o,
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
    const v = toSavedTabUi({ layout: 4, activePane: '%2', mainRatio: { 3: 30, 4: 70 } }, [{ paneId: '%0', name: 'ceo' }, { paneId: null, name: 'qa' }], true, true);
    expect(normalizeSavedTabUi(JSON.parse(JSON.stringify(v)))).toEqual({
      ui: { layout: 4, activePane: '%2', mainRatio: { 3: 30, 4: 70 } }, slots: [{ paneId: '%0', name: 'ceo' }, { paneId: null, name: 'qa' }], bannerDone: true, muted: true,
    });
    expect(normalizeSavedTabUi({ layout: 9, activePane: 'x', mainRatio: { 3: 99 }, slots: [{}, 5, { paneId: 'bad', name: 'n' }], muted: 'yes' })).toEqual({
      ui: { ...DEFAULT_TAB_UI, mainRatio: { 3: 75, 4: 50 } }, slots: [{ paneId: null, name: 'n' }], bannerDone: false, muted: false,
    });
    expect(normalizeSavedTabUi(undefined).ui).toEqual(DEFAULT_TAB_UI);
  });
  it('agent events: approval edge on any pane, lead turn end only after first sight', () => {
    const base = tab({ panes: [pane('%0'), pane('%1')] });
    // 처음 보는 탭은 기준만(재연결 때 다시 읽은 오래된 기록)
    expect(agentEvents(undefined, tab({ panes: [pane('%0', { doneAt: 50 })] }), 0)).toEqual([]);
    expect(agentEvents(base, tab({ panes: [pane('%0'), pane('%1', { waiting: true })] }), 0)).toEqual([{ pane: '%1', kind: 'approval' }]);
    // 이미 대기 중이면 다시 알리지 않음
    const waiting = tab({ panes: [pane('%0'), pane('%1', { waiting: true })] });
    expect(agentEvents(waiting, waiting, 0)).toEqual([]);
    expect(agentEvents(base, tab({ panes: [pane('%0', { doneAt: 200 }), pane('%1')] }), 100)).toEqual([{ pane: '%0', kind: 'done' }]);
    // 처음 본 시각보다 이른 차례 끝, 같은 값, 팀원 차례 끝은 무시
    expect(agentEvents(base, tab({ panes: [pane('%0', { doneAt: 50 }), pane('%1')] }), 100)).toEqual([]);
    const done = tab({ panes: [pane('%0', { doneAt: 200 }), pane('%1')] });
    expect(agentEvents(done, done, 100)).toEqual([]);
    expect(agentEvents(base, tab({ panes: [pane('%0'), pane('%1', { doneAt: 200 })] }), 100)).toEqual([]);
    // 종료 처리 중인 탭은 무시
    expect(agentEvents(base, tab({ terminating: true, panes: [pane('%0', { doneAt: 200 }), pane('%1', { waiting: true })] }), 100)).toEqual([]);
    // 둘 다면 승인 대기 먼저
    expect(agentEvents(base, tab({ panes: [pane('%0', { doneAt: 200 }), pane('%1', { waiting: true })] }), 100).map((e) => e.kind)).toEqual(['approval', 'done']);
  });
  it('approval replayed on reattach (waiting since before first sight) is not a new event', () => {
    const base = tab({ panes: [pane('%0'), pane('%1')] });
    expect(agentEvents(base, tab({ panes: [pane('%0'), pane('%1', { waiting: true, waitingAt: 50 })] }), 100)).toEqual([]);
    expect(agentEvents(base, tab({ panes: [pane('%0'), pane('%1', { waiting: true, waitingAt: 150 })] }), 100)).toEqual([{ pane: '%1', kind: 'approval' }]);
  });
  it('done toast only after the tab settled (lead unchanged, nothing working or waiting)', () => {
    const settled = tab({ panes: [pane('%0', { doneAt: 200 }), pane('%1')] });
    expect(doneDecision(settled, 200, 300)).toBe('fire');
    // 리드가 다시 움직여 새 차례 끝이 옴(새 기다림이 맡음)
    expect(doneDecision(tab({ panes: [pane('%0', { doneAt: 300 }), pane('%1')] }), 200, 300)).toBe('drop');
    // 리드·팀원이 아직 작업 중이거나 승인 대기: 다시 확인, 상한이 지나면 그만
    expect(doneDecision(tab({ panes: [pane('%0', { doneAt: 200, working: true }), pane('%1')] }), 200, 300)).toBe('retry');
    expect(doneDecision(tab({ panes: [pane('%0', { doneAt: 200 }), pane('%1', { working: true })] }), 200, 300)).toBe('retry');
    expect(doneDecision(tab({ panes: [pane('%0', { doneAt: 200 }), pane('%1', { waiting: true })] }), 200, 300)).toBe('retry');
    expect(doneDecision(tab({ panes: [pane('%0', { doneAt: 200 }), pane('%1', { working: true })] }), 200, 200 + DONE_RETRY_CAP_MS)).toBe('drop');
    // 탭이 닫혔거나 종료 중
    expect(doneDecision(undefined, 200, 300)).toBe('drop');
    expect(doneDecision(tab({ terminating: true, panes: [pane('%0', { doneAt: 200 })] }), 200, 300)).toBe('drop');
  });
  it('settleDone: retries while a teammate works, fires once when quiet, drops on resume / cap / close', () => {
    vi.useFakeTimers();
    try {
      let clock = 1_000_000;
      const now = (): number => clock;
      const step = (): void => { clock += DONE_SETTLE_MS; vi.advanceTimersByTime(DONE_SETTLE_MS); };
      const busy = tab({ panes: [pane('%0', { doneAt: clock }), pane('%1', { working: true })] });
      const quiet = tab({ panes: [pane('%0', { doneAt: clock }), pane('%1')] });
      const fired: string[] = [];
      // 8초에 팀원 작업 중 → 16초에 조용 → 한 번만
      let cur: TabStateDto | undefined = busy;
      const tt = new TabTimers();
      settleDone(tt, 't', clock, () => cur, now, (x) => fired.push(x.tabId));
      step();
      expect(fired).toEqual([]);
      cur = quiet;
      step();
      expect(fired).toEqual(['t']);
      step();
      expect(fired).toEqual(['t']);
      // 다시 확인하는 동안 리드가 다시 움직임 → 그만
      const t0 = clock;
      cur = tab({ panes: [pane('%0', { doneAt: t0 }), pane('%1', { working: true })] });
      settleDone(tt, 't', t0, () => cur, now, (x) => fired.push(`resume ${x.tabId}`));
      step();
      cur = tab({ panes: [pane('%0', { doneAt: t0 + 5 }), pane('%1')] });
      step();
      step();
      expect(fired).toEqual(['t']);
      // 상한까지 계속 작업 중 → 그만(뒤에 조용해져도 알리지 않음)
      const t1 = clock;
      cur = tab({ panes: [pane('%0', { doneAt: t1 }), pane('%1', { working: true })] });
      settleDone(tt, 't', t1, () => cur, now, (x) => fired.push(`cap ${x.tabId}`));
      for (let i = 0; i < DONE_RETRY_CAP_MS / DONE_SETTLE_MS + 2; i++) step();
      cur = tab({ panes: [pane('%0', { doneAt: t1 }), pane('%1')] });
      step();
      expect(fired).toEqual(['t']);
      // 다시 확인하는 동안 탭이 닫힘 → 알리지 않음(상태 없음·타이머 취소 둘 다)
      const t2 = clock;
      cur = tab({ panes: [pane('%0', { doneAt: t2 }), pane('%1', { working: true })] });
      settleDone(tt, 't', t2, () => cur, now, (x) => fired.push(`closed ${x.tabId}`));
      step();
      cur = undefined;
      step();
      settleDone(tt, 'u', t2, () => quiet, now, (x) => fired.push(`cancel ${x.tabId}`));
      tt.cancel('u');
      step();
      expect(fired).toEqual(['t']);
    } finally {
      vi.useRealTimers();
    }
  });
  it('a newer turn end restarts the wait; closing the tab cancels it', () => {
    vi.useFakeTimers();
    try {
      const fired: string[] = [];
      const tt = new TabTimers();
      tt.set('t', 8000, () => fired.push('first'));
      vi.advanceTimersByTime(5000);
      tt.set('t', 8000, () => fired.push('second')); // 새 차례 끝: 처음부터 다시
      vi.advanceTimersByTime(5000);
      expect(fired).toEqual([]);
      vi.advanceTimersByTime(3000);
      expect(fired).toEqual(['second']);
      tt.set('u', 8000, () => fired.push('closed'));
      tt.cancel('u');
      vi.advanceTimersByTime(10000);
      expect(fired).toEqual(['second']);
    } finally {
      vi.useRealTimers();
    }
  });
  it('clips names for the toast title without splitting surrogate pairs', () => {
    expect(clipName('short')).toBe('short');
    expect(clipName('a'.repeat(61))).toBe(`${'a'.repeat(59)}…`);
    const e = clipName('😀'.repeat(70));
    expect(Array.from(e)).toHaveLength(60);
    expect(e).toBe(`${'😀'.repeat(59)}…`);
  });
  // 읽지 않음은 settleDone이 알릴 때(onFire) 그 시점의 보고 있는지로 판단한다(App). 판단 규칙 자체:
  it('marks unread only for a lead turn end the user did not see', () => {
    const none = new Set<string>();
    const done = [{ pane: '%0', kind: 'done' as const }];
    expect([...markUnread(none, 't', done, false)]).toEqual(['t']);
    expect(markUnread(none, 't', done, true)).toBe(none);
    expect(markUnread(none, 't', [{ pane: '%1', kind: 'approval' }], false)).toBe(none);
    const has = new Set(['t']);
    expect(markUnread(has, 't', done, false)).toBe(has);
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
    ({ sessionId: sid, title, cwd: `D:\\${folderName}`, folderKey, folderName, mtimeMs, kind: 'lead' as const, mates: 0, key: `d/${sid}.jsonl`, customTitle: null, archived: false, createdMs: null, gitBranch: null, model: null, preview: null });
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
