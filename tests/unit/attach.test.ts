import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { cleanupClips, saveClipPng } from '../../src/main/clips';
import { safeIpc } from '../../src/renderer/ipc';
import { addDirLeadPane, tabAcceptsInput } from '../../src/renderer/tabs';
import type { TabStateDto } from '../../src/shared/api';
import { addDirCommand, CLIP_JFIF_TYPE, CLIP_NAME_RE, clipFileName, DragHoverTracker, pickClipImage, insertAt, isAbsoluteWinPath, mentionsFor, quoteMention, staleClipNames } from '../../src/shared/attach';

vi.mock('../../src/main/logger', () => ({ log: () => undefined, errMsg: (e: unknown) => String(e) }));

describe('path quoting (F6)', () => {
  it('wraps absolute paths in @"..." keeping backslashes, spaces and Korean', () => {
    expect(quoteMention('D:\\내 문서\\보고서 v2.txt')).toEqual({ ok: true, text: '@"D:\\내 문서\\보고서 v2.txt"' });
    expect(quoteMention('  C:\\a.png ')).toEqual({ ok: true, text: '@"C:\\a.png"' });
    expect(quoteMention('\\\\server\\share\\f.txt')).toEqual({ ok: true, text: '@"\\\\server\\share\\f.txt"' });
  });
  it('rejects control characters (tab, NUL, ESC, DEL)', () => {
    for (const c of ['\t', '\u0000', '\u001b', '\u007f']) expect(quoteMention(`D:\\a${c}b.txt`).ok).toBe(false);
  });
  it('rejects quotes, line breaks, relative and empty paths', () => {
    expect(quoteMention('D:\\a"b.txt').ok).toBe(false);
    expect(quoteMention('D:\\a\nb').ok).toBe(false);
    expect(quoteMention('docs\\a.txt').ok).toBe(false);
    expect(quoteMention('\\a.txt').ok).toBe(false);
    expect(quoteMention('C:a.txt').ok).toBe(false);
    expect(quoteMention('').ok).toBe(false);
    expect(isAbsoluteWinPath('D:/x')).toBe(true);
  });
  it('joins several paths with spaces and reports rejected ones', () => {
    expect(mentionsFor(['D:\\a b.txt', 'rel.txt', 'E:\\c.md'])).toEqual({ text: '@"D:\\a b.txt" @"E:\\c.md"', rejected: ['절대 경로가 아닙니다: rel.txt'] });
    expect(mentionsFor([])).toEqual({ text: '', rejected: [] });
  });
  it('/add-dir command', () => {
    // 따옴표 없이(Claude Code가 따옴표를 경로 일부로 봄), 공백·한글은 그대로
    expect(addDirCommand('D:\\github\\Private\\Rich_psmux\\docs')).toEqual({ ok: true, text: '/add-dir D:\\github\\Private\\Rich_psmux\\docs' });
    expect(addDirCommand(' D:\\내 폴더 A ')).toEqual({ ok: true, text: '/add-dir D:\\내 폴더 A' });
    expect(addDirCommand('D:\\a"b').ok).toBe(false);
    expect(addDirCommand('x').ok).toBe(false);
  });
  it('trailing backslash is dropped so it cannot escape the closing quote (O-2)', () => {
    expect(quoteMention('C:\\')).toEqual({ ok: true, text: '@"C:/"' });
    expect(quoteMention('d:\\\\')).toEqual({ ok: true, text: '@"d:/"' });
    expect(quoteMention('D:\\내 폴더\\')).toEqual({ ok: true, text: '@"D:\\내 폴더"' });
    expect(quoteMention('\\\\srv\\share\\')).toEqual({ ok: true, text: '@"\\\\srv\\share"' });
    expect(quoteMention('C:/')).toEqual({ ok: true, text: '@"C:/"' });
    expect(mentionsFor(['C:\\', 'E:\\a\\']).text).toBe('@"C:/" @"E:\\a"');
  });
});

describe('drag hover tracker (M3-1)', () => {
  const fakeTimers = () => {
    const pending = new Map<number, () => void>();
    let n = 0;
    return {
      pending,
      timers: { set: (fn: () => void) => (pending.set(++n, fn), n), clear: (id: unknown) => void pending.delete(id as number) },
      fire: () => [...pending.entries()].forEach(([id, fn]) => (pending.delete(id), fn())),
    };
  };
  it('clears when nested enter/leave pairs balance out', () => {
    const clear = vi.fn();
    const t = new DragHoverTracker(clear, 200, fakeTimers().timers);
    t.enter(); t.enter(); t.leave(false);
    expect(clear).not.toHaveBeenCalled();
    t.leave(false);
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it('leaving the window (relatedTarget null) clears at once even if counts are unbalanced', () => {
    const clear = vi.fn();
    const t = new DragHoverTracker(clear, 200, fakeTimers().timers);
    t.enter(); t.enter(); t.enter(); t.leave(true);
    expect(clear).toHaveBeenCalledTimes(1);
    t.enter(); t.leave(false); // 카운터도 0으로 돌아가 있어야 함
    expect(clear).toHaveBeenCalledTimes(2);
  });
  it('safety timer clears after dragover stops (cancel without dragleave), re-armed by each dragover', () => {
    const clear = vi.fn();
    const f = fakeTimers();
    const t = new DragHoverTracker(clear, 200, f.timers);
    t.enter(); t.over(); t.over(); t.over();
    expect(f.pending.size).toBe(1); // 이전 타이머는 취소되고 하나만 남음
    expect(clear).not.toHaveBeenCalled();
    f.fire();
    expect(clear).toHaveBeenCalledTimes(1);
    t.enter(); t.leave(false); // 타이머 해제가 카운터도 리셋
    expect(clear).toHaveBeenCalledTimes(2);
  });
  it('drop/dragend reset counter and timer; dispose only cancels the timer', () => {
    const clear = vi.fn();
    const f = fakeTimers();
    const t = new DragHoverTracker(clear, 200, f.timers);
    t.enter(); t.enter(); t.over(); t.reset();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(f.pending.size).toBe(0);
    t.over(); t.dispose();
    expect(f.pending.size).toBe(0);
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it('default timers (1000ms) work with real setTimeout', () => {
    vi.useFakeTimers();
    try {
      const clear = vi.fn();
      const t = new DragHoverTracker(clear);
      t.enter(); t.over();
      vi.advanceTimersByTime(999);
      expect(clear).not.toHaveBeenCalled();
      t.over();
      vi.advanceTimersByTime(999);
      expect(clear).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('insert at caret', () => {
  it('empty input: snippet + trailing space, caret after it', () => {
    expect(insertAt('', 0, 0, '@"D:\\a"')).toEqual({ value: '@"D:\\a" ', caret: 8 });
  });
  it('middle of text: spaces only where needed', () => {
    expect(insertAt('read this please', 9, 9, '@"X"')).toEqual({ value: 'read this @"X" please', caret: 15 });
    expect(insertAt('read  please', 5, 5, '@"X"')).toEqual({ value: 'read @"X" please', caret: 10 });
    expect(insertAt('abc', 3, 3, '@"X"')).toEqual({ value: 'abc @"X" ', caret: 9 });
  });
  it('never splits an existing mention: caret inside @"..." inserts after it', () => {
    const v = 'see @"D:\\a b.txt" now';
    expect(insertAt(v, 9, 9, '@"X"')).toEqual({ value: 'see @"D:\\a b.txt" @"X" now', caret: 23 });
    expect(insertAt(v, 4, 4, '@"X"').value).toBe('see @"X" @"D:\\a b.txt" now'); // 경계(앞)는 쪼개지 않음
  });
  it('replaces the selection and clamps bad ranges', () => {
    expect(insertAt('a OLD b', 2, 5, '@"X"')).toEqual({ value: 'a @"X" b', caret: 7 });
    expect(insertAt('ab', 9, 1, '@"X"').value).toBe('ab @"X" ');
  });
});

describe('pasted image files (D15)', () => {
  const now = new Date('2026-10-23T10:20:30.456Z');
  it('file name is Windows-safe ISO time + 6 hex', () => {
    const n = clipFileName(now, 'a1b2c3');
    expect(n).toBe('2026-10-23T10-20-30-456Z-a1b2c3.png');
    expect(CLIP_NAME_RE.test(n)).toBe(true);
    expect(() => clipFileName(now, 'zz')).toThrow();
  });
  it('only app-named PNGs older than 7 days are stale', () => {
    const day = 24 * 3600 * 1000;
    const t = now.getTime();
    const names = staleClipNames([
      { name: clipFileName(new Date(t - 8 * day), '000001'), mtimeMs: t - 8 * day },
      { name: clipFileName(new Date(t - 6 * day), '000002'), mtimeMs: t - 6 * day },
      { name: 'user-file.png', mtimeMs: t - 30 * day },
      { name: clipFileName(new Date(t - 9 * day), '000003').replace('.png', '.txt'), mtimeMs: t - 9 * day },
    ], t);
    expect(names).toEqual([clipFileName(new Date(t - 8 * day), '000001')]);
  });

  const tmp = mkdtempSync(join(tmpdir(), 'ctd-clips-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  it('saves bytes unchanged and cleans up only old app files', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const p = saveClipPng(tmp, png);
    expect(readFileSync(p)).toEqual(png);
    const dir = join(tmp, 'clips');
    const old = join(dir, clipFileName(new Date(Date.now() - 10 * 86400000), 'abcdef'));
    writeFileSync(old, 'x');
    const oldT = new Date(Date.now() - 10 * 86400000);
    utimesSync(old, oldT, oldT);
    const keep = join(dir, 'mine.png');
    writeFileSync(keep, 'x');
    utimesSync(keep, oldT, oldT);
    mkdirSync(join(dir, 'sub'));
    expect(cleanupClips(tmp)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([p.split(/[\\/]/).pop(), 'mine.png', 'sub'].sort());
    expect(cleanupClips(join(tmp, 'nope'))).toBe(0);
  });
});

describe('M3 wrap-up', () => {
  const tab = (o: Partial<TabStateDto>): TabStateDto => ({
    tabId: 't', session: 's', folder: 'D:\\x', status: 'connected', leadPaneId: '%0', teamName: null,
    panes: [{ paneId: '%0' } as TabStateDto['panes'][number]],
    plain: false, hooksEnabled: true, leadSessionId: null, resumeSessionId: null, leadGone: false, terminating: false, createdAt: 0, purpose: 'conversation', loginFailed: false, ...o,
  });
  it('add-dir is only offered while the tab accepts input and the lead pane is alive (M3-2)', () => {
    expect(addDirLeadPane(tab({}))).toBe('%0');
    for (const status of ['reconnecting', 'ended', 'error'] as const) expect(addDirLeadPane(tab({ status }))).toBeNull();
    expect(addDirLeadPane(tab({ terminating: true }))).toBeNull();
    expect(addDirLeadPane(tab({ leadGone: true }))).toBeNull();
    expect(addDirLeadPane(tab({ leadPaneId: null }))).toBeNull();
    expect(addDirLeadPane(tab({ panes: [] }))).toBeNull();
    expect(addDirLeadPane(undefined)).toBeNull();
    expect(tabAcceptsInput(tab({ status: 'starting' }))).toBe(true);
  });
  it('clipboard image pick order: png > jpeg > raw JFIF (O-4)', () => {
    expect(pickClipImage([['text/plain'], ['image/jpeg', 'image/png']])).toEqual({ index: 1, type: 'image/png', png: true });
    expect(pickClipImage([[CLIP_JFIF_TYPE], ['image/jpeg']])).toEqual({ index: 1, type: 'image/jpeg', png: false });
    expect(pickClipImage([['electron application/osclipboard;format="DataObject"', CLIP_JFIF_TYPE]])).toEqual({ index: 0, type: CLIP_JFIF_TYPE, png: false });
    expect(pickClipImage([['image/gif'], ['text/html']])).toBeNull();
    expect(pickClipImage([])).toBeNull();
  });
  it('safeIpc turns rejections and sync throws into the fallback (Nit 8)', async () => {
    const err = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await safeIpc(() => Promise.resolve(3), 0, err)).toBe(3);
      expect(await safeIpc(() => Promise.reject(new Error('boom')), 0, err, '메시지 보내기')).toBe(0);
      expect(await safeIpc(() => { throw new Error('sync'); }, null, err)).toBeNull();
      expect(await safeIpc(() => Promise.reject(new Error('x')), false)).toBe(false);
      expect(err.mock.calls.map((c) => c[0])).toEqual(['메시지 보내기에 실패했습니다: boom', '요청에 실패했습니다: sync']);
    } finally {
      spy.mockRestore();
    }
  });
});
