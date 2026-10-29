import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { listProjectJsonl, projectsDir, readAccount, resolveProjects, setClaudeHomeForTest, setProjectsDir } from '../../src/main/claudeHome';
import { HistoryIndexer } from '../../src/main/history/indexer';
import { asarUnpackedPath, cleanEnv, executableExists, probe, probeDir, probeExecutable } from '../../src/main/psmux/env';
import { shellMatches, shellOptionPath } from '../../src/main/psmux/panes';
import { classifySessions } from '../../src/main/psmux/sessionName';
import { DEFAULT_SETTINGS, diffFromDefaults, leadCommandError, normalizeSettings, validateSettings, type PathChecks } from '../../src/main/settings';
import { initialOf } from '../../src/renderer/components/AccountArea';
import { trapTarget } from '../../src/renderer/dialog';
import { resolveTheme } from '../../src/renderer/theme';

vi.mock('../../src/main/logger', () => ({ log: () => undefined, errMsg: (e: unknown) => String(e) }));

const tmp = mkdtempSync(join(tmpdir(), 'ctd-settings-account-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  setClaudeHomeForTest(null);
  setProjectsDir(null);
});

const valid = { ...DEFAULT_SETTINGS, psmuxPath: '', pwshPath: '', historyDir: '' };
const fsx = (files: string[], dirs: string[], slow: string[] = []): PathChecks => ({
  isFile: async (p) => (slow.includes(p) ? 'timeout' : files.includes(p) ? 'ok' : 'missing'),
  isDir: async (p) => (slow.includes(p) ? 'timeout' : dirs.includes(p) ? 'ok' : 'missing'),
});
const check = (o: unknown, f: PathChecks = fsx([], [])): ReturnType<typeof validateSettings> => validateSettings(o, f);

describe('settings validation', () => {
  it('accepts defaults and existing absolute paths', async () => {
    const r = await check({ ...valid, psmuxPath: ' C:\\p\\psmux.exe ', pwshPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', historyDir: 'D:\\hist' },
      fsx(['C:\\p\\psmux.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'], ['D:\\hist']));
    expect(r.errors).toEqual({});
    expect(r.values).toMatchObject({ psmuxPath: 'C:\\p\\psmux.exe', pwshPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', historyDir: 'D:\\hist', theme: 'light' });
    expect((await check(valid)).values).not.toBeNull(); // 빈 경로 = 기본값
  });
  it('rejects missing, relative, non-exe and quoted paths per field', async () => {
    const r = await check({ ...valid, psmuxPath: 'psmux.exe', pwshPath: 'C:\\x\\pwsh.exe', historyDir: 'C:\\nope' });
    expect(r.values).toBeNull();
    expect(r.errors.psmuxPath).toMatch(/절대 경로/);
    expect(r.errors.pwshPath).toMatch(/찾을 수 없습니다/);
    expect(r.errors.historyDir).toMatch(/찾을 수 없습니다/);
    expect((await check({ ...valid, pwshPath: 'C:\\x\\pwsh.txt' }, fsx(['C:\\x\\pwsh.txt'], []))).errors.pwshPath).toMatch(/\.exe/);
    expect((await check({ ...valid, psmuxPath: 'C:\\a"b.exe' })).errors.psmuxPath).toMatch(/쓸 수 없는 문자/);
    expect((await check({ ...valid, historyDir: 'C:\\h' }, fsx(['C:\\h'], []))).errors.historyDir).toMatch(/찾을 수 없습니다/); // 파일은 폴더가 아님
  });
  it('rejects bad lead command, font, size, theme and flag', async () => {
    const e = (await check({ ...valid, leadCommand: 'claude\n--x', fontFamily: 'x;}', fontSize: 7.5, theme: 'blue', showSdkSessions: 'yes' })).errors;
    expect(Object.keys(e).sort()).toEqual(['fontFamily', 'fontSize', 'leadCommand', 'showSdkSessions', 'theme']);
    // 빈 값은 기본값으로
    const blank = (await check({ ...valid, leadCommand: '   ', fontFamily: '', fontSize: Number.NaN })).values;
    expect(blank).toMatchObject({ leadCommand: DEFAULT_SETTINGS.leadCommand, fontFamily: DEFAULT_SETTINGS.fontFamily, fontSize: DEFAULT_SETTINGS.fontSize });
    expect((await check({ ...valid, fontSize: '' })).values?.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect((await check({ ...valid, fontSize: 0 })).errors.fontSize).toBeDefined();
    // 드라이브 루트 거부
    for (const d of ['C:\\', 'd:/', 'E:']) expect((await check({ ...valid, historyDir: d }, fsx([], ['C:\\', 'd:\\', 'E:']))).errors.historyDir).toMatch(/드라이브 루트|절대 경로/);
    expect((await check({ ...valid, historyDir: 'C:\\' }, fsx([], ['C:\\']))).errors.historyDir).toMatch(/드라이브 루트/);
    expect((await check({ ...valid, fontSize: 33 })).errors.fontSize).toBeDefined();
    expect((await check(null)).values).toBeNull();
  });
  it('new fields round-trip through normalize and are stored only when changed', () => {
    expect(normalizeSettings({ theme: 'dark', pwshPath: 'C:\\p.exe', historyDir: 'D:\\h' })).toMatchObject({ theme: 'dark', pwshPath: 'C:\\p.exe', historyDir: 'D:\\h' });
    expect(normalizeSettings({ theme: 'neon' }).theme).toBe('light');
    expect(diffFromDefaults(normalizeSettings({ theme: 'system' }))).toEqual({ theme: 'system' });
  });
});

describe('account', () => {
  it('extracts only email and organization; secrets elsewhere in the file are not returned', async () => {
    const home = join(tmp, 'acct');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'a@b.co', organizationName: 'Org', accountUuid: 'u-1', billingType: 'x' },
      projects: { 'D:/p': { mcpServers: { s: { env: { API_KEY: 'SECRET-123' }, headers: { Authorization: 'Bearer SECRET-456' } } } } },
    }));
    setClaudeHomeForTest(join(home, '.claude'));
    const a = await readAccount();
    expect(a).toEqual({ email: 'a@b.co', org: 'Org' });
    expect(JSON.stringify(a)).not.toMatch(/SECRET|u-1/);
  });
  it('missing file, broken JSON, wrong types → nulls', async () => {
    const home = join(tmp, 'acct2');
    mkdirSync(join(home, '.claude'), { recursive: true });
    setClaudeHomeForTest(join(home, '.claude'));
    expect(await readAccount()).toEqual({ email: null, org: null });
    writeFileSync(join(home, '.claude.json'), '{"oauthAccount": {"emailAddress": "a@');
    expect(await readAccount()).toEqual({ email: null, org: null });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 5, organizationName: 'x\u0007y' } }));
    expect(await readAccount()).toEqual({ email: null, org: null });
  });
  it('avatar initial', () => {
    expect(initialOf('kim@x.co')).toBe('K');
    expect(initialOf(null)).toBe('?');
    expect(initialOf('  ')).toBe('?');
  });
});

describe('history folder override', () => {
  it('lists jsonl from the configured folder and keeps the secret-file guard', async () => {
    const h = join(tmp, 'hist');
    mkdirSync(join(h, 'D--proj'), { recursive: true });
    writeFileSync(join(h, 'D--proj', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'), '{}\n');
    setClaudeHomeForTest(join(tmp, 'nohome', '.claude'));
    expect((await listProjectJsonl()).files).toEqual([]); // 기본 위치(없음)
    setProjectsDir(h);
    expect(projectsDir()).toBe(h);
    expect((await listProjectJsonl()).files).toEqual([{ dir: 'D--proj', file: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl' }]);
    expect(() => resolveProjects('..', 'x')).toThrow(/outside/);
    expect(() => resolveProjects('D--proj', '.credentials.json')).toThrow(/secret/);
    setProjectsDir('  ');
    expect(projectsDir()).toBe(join(tmp, 'nohome', '.claude', 'projects'));
  });
});

describe('theme and packaging helpers', () => {
  it('resolves system theme from the OS preference', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
  it('maps asar paths to the unpacked copy only', () => {
    expect(asarUnpackedPath('C:\\Users\\u\\AppData\\Local\\Programs\\ctd\\resources\\app.asar\\out\\hook\\hookRecorder.js'))
      .toBe('C:\\Users\\u\\AppData\\Local\\Programs\\ctd\\resources\\app.asar.unpacked\\out\\hook\\hookRecorder.js');
    expect(asarUnpackedPath('D:/dev/out/hook/hookRecorder.js')).toBe('D:/dev/out/hook/hookRecorder.js');
    expect(asarUnpackedPath('C:\\x\\app.asar.unpacked\\out\\h.js')).toBe('C:\\x\\app.asar.unpacked\\out\\h.js');
    expect(asarUnpackedPath('C:\\my.app.asarx\\h.js')).toBe('C:\\my.app.asarx\\h.js');
  });
});

describe('executable check', () => {
  it('files yes, folders and missing paths no', async () => {
    const f = join(tmp, 'tool.exe');
    writeFileSync(f, 'x');
    expect(await executableExists(f)).toBe(true);
    expect(await executableExists(tmp)).toBe(false);
    expect(await executableExists(join(tmp, 'missing.exe'))).toBe(false);
  });
  it('accepts the Microsoft Store pwsh alias that existsSync reports as missing', async () => {
    const alias = join(process.env.LOCALAPPDATA ?? 'C:\\none', 'Microsoft', 'WindowsApps', 'pwsh.exe');
    let isAlias = false;
    try {
      isAlias = lstatSync(alias).isSymbolicLink();
    } catch { /* 이 PC에 별칭 없음: 아래는 false 기대 */ }
    expect(existsSync(alias)).toBe(false);
    expect(await executableExists(alias)).toBe(isAlias);
  });
});

describe('session shell', () => {
  it('inherited SHELL is always removed from the psmux environment', () => {
    expect(cleanEnv({ SHELL: '/usr/bin/bash', PATH: 'p', CLAUDECODE: '1' })).toEqual({ PATH: 'p' });
  });
  it('default-shell value uses forward slashes; pane command matching ignores case and .exe', () => {
    expect(shellOptionPath('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('C:/Program Files/PowerShell/7/pwsh.exe');
    expect(shellMatches('pwsh', 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe')).toBe(true);
    expect(shellMatches('PowerShell.exe', 'D:/sp ace/powershell.exe')).toBe(true);
    expect(shellMatches('pwsh', 'C:/x/powershell.exe')).toBe(false);
    expect(shellMatches('', 'C:/x/pwsh.exe')).toBe(false);
  });
});

describe('session list classification', () => {
  it('app sessions need the ctd- name and app metadata; only open app sessions get a tab id', () => {
    const live = ['ctd-a-000001', 'ctd-b-000002', 'ctd-gone-000003', 'team', 'ctd-bad name'];
    const meta = new Set(['ctd-a-000001', 'ctd-b-000002', 'team', 'ctd-bad name']);
    expect(classifySessions(live, (n) => meta.has(n), new Set(['ctd-a-000001', 'team']))).toEqual([
      { name: 'ctd-a-000001', app: true, tabId: 'ctd-a-000001' },
      { name: 'ctd-b-000002', app: true, tabId: null }, // 분리됨 → 재연결 대상
      { name: 'ctd-gone-000003', app: false, tabId: null }, // 메타 없음(다른 데이터 폴더) → 외부 취급
      { name: 'team', app: false, tabId: null },
      { name: 'ctd-bad name', app: false, tabId: null },
    ]);
    expect(classifySessions([], () => true, new Set())).toEqual([]);
  });
});

describe('history folder switch', () => {
  const sid = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
  const conv = (dir: string, n: number, title: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sid(n)}.jsonl`), JSON.stringify({ type: 'user', sessionId: sid(n), cwd: 'D:\\w', timestamp: '2026-10-23T10:00:00.000Z', message: { role: 'user', content: title } }) + '\n');
  };
  it('restart drops the old folder entries, reads the new folder, and serializes back-to-back switches', async () => {
    const a = join(tmp, 'histA');
    const b = join(tmp, 'histB');
    const c = join(tmp, 'histC');
    conv(join(a, 'D--p'), 1, 'in A');
    conv(join(b, 'D--q'), 2, 'in B');
    conv(join(c, 'D--r'), 3, 'in C');
    setProjectsDir(a);
    const ix = new HistoryIndexer(join(tmp, 'ix-cache.json'));
    try {
      await ix.start();
      expect(ix.items().map((i) => i.sessionId)).toEqual([sid(1)]);
      const order: string[] = [];
      const p1 = ix.restart(() => { order.push('B'); setProjectsDir(b); });
      const p2 = ix.restart(() => { order.push('C'); setProjectsDir(c); });
      await p1;
      expect(order).toEqual(['B']); // 두 번째 전환은 첫 번째가 끝난 뒤
      await p2;
      expect(order).toEqual(['B', 'C']);
      expect(ix.items().map((i) => i.sessionId)).toEqual([sid(3)]);
      expect(ix.ready).toBe(true);
    } finally {
      ix.stop();
    }
  });
});

describe('path probe timeouts, single lead command, path normalization', () => {
  it('path probes time out instead of waiting for the OS (unreachable UNC)', async () => {
    expect(await probe(new Promise<boolean>(() => undefined), 30)).toBe('timeout');
    expect(await probe(Promise.resolve(true), 30)).toBe('ok');
    expect(await probe(Promise.resolve(false), 30)).toBe('missing');
    expect(await probe(Promise.reject(new Error('x')), 30)).toBe('missing');
    const f = join(tmp, 'probe.exe');
    writeFileSync(f, 'x');
    expect(await probeExecutable(f)).toBe('ok');
    expect(await probeDir(tmp)).toBe('ok');
    expect(await probeDir(f)).toBe('missing');
  });
  it('a path that does not answer in time is rejected with a Korean "no response" error', async () => {
    const r = await check({ ...valid, psmuxPath: '\\\\nohost\\s\\psmux.exe', historyDir: '\\\\nohost\\share\\projects' },
      fsx([], [], ['\\\\nohost\\s\\psmux.exe', '\\\\nohost\\share\\projects']));
    expect(r.values).toBeNull();
    expect(r.errors.psmuxPath).toMatch(/확인할 수 없습니다.*응답 없음/);
    expect(r.errors.historyDir).toMatch(/확인할 수 없습니다.*응답 없음/);
  });
  it('the three path checks run concurrently (total wait ≈ one timeout, not three)', async () => {
    const slowFsx: PathChecks = {
      isFile: () => new Promise((res) => setTimeout(() => res('timeout'), 100)),
      isDir: () => new Promise((res) => setTimeout(() => res('timeout'), 100)),
    };
    const t0 = Date.now();
    await check({ ...valid, psmuxPath: 'C:\\a\\psmux.exe', pwshPath: 'C:\\a\\pwsh.exe', historyDir: 'C:\\a\\h' }, slowFsx);
    expect(Date.now() - t0).toBeLessThan(250);
  });
  it('lead command must be a single command', async () => {
    for (const bad of ['claude; Write-Host done', 'claude && x', 'claude || x', 'claude | Out-Null', 'claude `\n x', 'a`b', 'claude\rx', 'claude --agent ceo # note', 'claude #x']) {
      expect(leadCommandError(bad)).toMatch(/하나의 명령만/);
      expect((await check({ ...valid, leadCommand: bad })).errors.leadCommand).toMatch(/하나의 명령만/);
    }
    for (const ok of ['claude --agent ceo', '& "C:\\Program Files\\claude.exe" --agent ceo', "claude --append-system-prompt 'x'"]) {
      expect(leadCommandError(ok)).toBeNull();
      expect((await check({ ...valid, leadCommand: ok })).values?.leadCommand).toBe(ok);
    }
  });
  it('drive roots are rejected after normalization (. and ..), share roots too', async () => {
    for (const d of ['C:\\.', 'C:\\.\\', 'C:\\Users\\..', 'C:/Windows/..', 'c:\\\\', '\\\\?\\C:\\', '\\\\srv\\share', '\\\\srv\\share\\x\\..']) {
      expect((await check({ ...valid, historyDir: d }, fsx([], [d, 'C:\\', 'c:\\']))).errors.historyDir, d).toMatch(/드라이브 루트/);
    }
  });
  it('history, psmux and pwsh paths are stored normalized', async () => {
    const r = await check({ ...valid, historyDir: 'D:/hist/sub/../', psmuxPath: 'C:/p/./psmux.exe', pwshPath: 'C:\\x\\y\\..\\pwsh.exe' },
      fsx(['C:\\p\\psmux.exe', 'C:\\x\\pwsh.exe'], ['D:\\hist']));
    expect(r.errors).toEqual({});
    expect(r.values).toMatchObject({ historyDir: 'D:\\hist', psmuxPath: 'C:\\p\\psmux.exe', pwshPath: 'C:\\x\\pwsh.exe' });
    // 정규화 결과가 .exe가 아니면 거부(C:\x\pwsh.exe\.. → C:\x)
    expect((await check({ ...valid, pwshPath: 'C:\\x\\pwsh.exe\\..' }, fsx(['C:\\x'], []))).errors.pwshPath).toMatch(/\.exe/);
  });
});

describe('dialog focus trap', () => {
  it('Tab wraps inside the dialog and pulls outside focus back in', () => {
    const [a, b, c] = [{}, {}, {}] as HTMLElement[];
    const items = [a, b, c];
    expect(trapTarget(items, c, false)).toBe(a); // 마지막 → 처음
    expect(trapTarget(items, a, true)).toBe(c); // 처음에서 Shift+Tab → 마지막
    expect(trapTarget(items, b, false)).toBeNull(); // 중간은 브라우저 기본 이동
    expect(trapTarget(items, {} as Element, false)).toBe(a); // 밖(뒤 ⋯ 버튼) → 안으로
    expect(trapTarget(items, null, true)).toBe(c);
    expect(trapTarget([], a, false)).toBeNull();
  });
});
