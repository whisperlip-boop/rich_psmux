// v0.6: 히스토리 항목 메뉴(F2-1: 이름·보관·휴지통), 로그아웃·로그인(F7-2), 사용량 영역 항상 표시(F7-1 수정).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { HistoryItemDto, RunningDto, TabStateDto } from '../../src/shared/api';
import { claudeInvocation, isShellCommand, LOGIN_GRACE_MS, loggedInFrom, parseAuthStatus, runClaude, stepLogin } from '../../src/main/auth';
import type { HistoryItem } from '../../src/main/history/indexer';
import { teammatesOf, toHistoryDtos } from '../../src/main/history/list';
import { cleanTitle, HistoryMetaStore, isHistoryKey, parseHistoryMeta } from '../../src/main/historyMeta';
import { extraCount, isTrashablePath, moveToTrash, planTrash, realUnder, trashKind } from '../../src/main/trash';
import { UsageTracker } from '../../src/main/usage';
import { logoutMessage, trashMessage } from '../../src/renderer/components/MenuDialogs';
import { usageLoggedOutNote, usageView } from '../../src/renderer/components/UsageArea';
import { createdOf, dateBucket, DEFAULT_FILTER, displayTitle, groupHistory, historyTip, isDefaultFilter, originalTitle, parseFilter, trashBlockedReason, viewHistory, type HistoryFilter } from '../../src/renderer/history';
import { filterValueLabel } from '../../src/renderer/components/FilterMenu';

vi.mock('../../src/main/logger', () => ({ log: () => undefined, errMsg: (e: unknown) => String(e) }));

const tmp = mkdtempSync(join(tmpdir(), 'ctd-v06-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SID = (n: number): string => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;
const KEY = (dir: string, n: number): string => `${dir}/${SID(n)}.jsonl`;

describe('history-meta 저장소(F2-1)', () => {
  it('이름 변경·빈 값이면 override 제거·보관/해제·파일에 저장', () => {
    const f = join(tmp, 'm1', 'history-meta.json');
    const s = new HistoryMetaStore(f);
    expect(s.rename(KEY('D--a', 1), '  새 이름  ')).toBe(true);
    expect(s.setArchived(KEY('D--a', 2), true)).toBe(true);
    expect(s.get()).toEqual({ overrides: { [KEY('D--a', 1)]: '새 이름' }, archived: [KEY('D--a', 2)] });
    expect(new HistoryMetaStore(f).get()).toEqual(s.get());
    expect(s.rename(KEY('D--a', 1), '   ')).toBe(true);
    expect(s.setArchived(KEY('D--a', 2), false)).toBe(true);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ overrides: {}, archived: [] });
  });

  it('삭제 정리(forget): 해당 키의 이름·보관만 지운다', () => {
    const s = new HistoryMetaStore(join(tmp, 'm2', 'history-meta.json'));
    s.rename(KEY('D--a', 1), 'a');
    s.rename(KEY('D--a', 2), 'b');
    s.setArchived(KEY('D--a', 1), true);
    s.setArchived(KEY('D--a', 3), true);
    s.forget([KEY('D--a', 1), KEY('C--x', 9)]);
    expect(s.get()).toEqual({ overrides: { [KEY('D--a', 2)]: 'b' }, archived: [KEY('D--a', 3)] });
  });

  it('잘못된 키·값은 거부하고, 손상된 파일은 빈 값으로 시작', () => {
    const s = new HistoryMetaStore(join(tmp, 'm3', 'history-meta.json'));
    for (const bad of ['', 'x', '../a.jsonl', `a/b/${SID(1)}.jsonl`, `a\\${SID(1)}.jsonl`, `a/${SID(1)}.json`, 5, null]) expect(isHistoryKey(bad)).toBe(false);
    expect(s.rename('../evil', 'x')).toBe(false);
    expect(s.setArchived(KEY('D--a', 1), 'yes')).toBe(false);
    expect(cleanTitle('a\nb\tc')).toBe('a b c');
    expect(cleanTitle('x'.repeat(300))?.length).toBe(200);
    expect(parseHistoryMeta({ overrides: { [KEY('D--a', 1)]: 'ok', bad: 'x', [KEY('D--a', 2)]: 3 }, archived: [KEY('D--a', 1), 'bad', KEY('D--a', 1)] }))
      .toEqual({ overrides: { [KEY('D--a', 1)]: 'ok' }, archived: [KEY('D--a', 1)] });
    const f = join(tmp, 'm4', 'history-meta.json');
    mkdirSync(join(tmp, 'm4'));
    writeFileSync(f, '{broken');
    expect(new HistoryMetaStore(f).get()).toEqual({ overrides: {}, archived: [] });
  });
});

/** 인덱스 항목 픽스처. */
function hi(n: number, dir: string, kind: HistoryItem['kind'], teamName: string | null = null): HistoryItem {
  return { sessionId: SID(n), dir, file: `${SID(n)}.jsonl`, key: KEY(dir, n), title: `t${n}`, cwd: 'D:\\x', kind, teamName, mtimeMs: n, createdMs: null };
}

describe('목록 오버레이·팀원 묶기', () => {
  const lead = hi(1, 'D--x', 'lead');
  const mates = [hi(91, 'C--other', 'teammate', 'session-00000001'), hi(92, 'D--x', 'teammate', 'session-00000001')];
  const other = hi(2, 'D--x', 'session');

  it('표시 이름·보관 여부·키를 DTO에 넣는다', () => {
    const out = toHistoryDtos([lead, other, ...mates], false, { overrides: { [lead.key]: '이름' }, archived: [other.key] });
    expect(out.find((x) => x.sessionId === lead.sessionId)).toMatchObject({ key: lead.key, customTitle: '이름', archived: false, mates: 2 });
    expect(out.find((x) => x.sessionId === other.sessionId)).toMatchObject({ customTitle: null, archived: true });
  });

  it('teammatesOf: 같은 규칙으로 리드에 묶인 팀원만', () => {
    expect(teammatesOf([lead, other, ...mates], lead.sessionId).map((m) => m.key).sort()).toEqual(mates.map((m) => m.key).sort());
    expect(teammatesOf([lead, other, ...mates], other.sessionId)).toEqual([]);
  });
});

describe('휴지통 대상 경로 검증(F2-1)', () => {
  const root = 'C:\\Users\\u\\.claude\\projects';
  it('허용: <dir>/<sid>.jsonl(파일), <dir>/<sid>(대화 폴더)', () => {
    expect(trashKind(root, `${root}\\D--x\\${SID(1)}.jsonl`)).toBe('file');
    expect(trashKind(root, `${root}/D--x/${SID(1)}.jsonl`)).toBe('file');
    expect(trashKind(root, `${root}\\D--x\\${SID(1)}`)).toBe('dir');
    expect(isTrashablePath(root, `${root}\\D--x\\${SID(1)}\\`)).toBe(true);
  });

  it('거부: projects 밖, history.jsonl, sessions·teams, .. 우회, 폴더 안 개별 파일, 다른 모양·확장자, 루트·프로젝트 폴더 자체', () => {
    for (const p of [
      'C:\\Users\\u\\.claude\\history.jsonl', `${root}\\..\\history.jsonl`, `${root}\\history.jsonl`, `${root}\\D--x\\history.jsonl`,
      `C:\\Users\\u\\.claude\\sessions\\${SID(1)}.jsonl`, `${root}\\sessions\\${SID(1)}.jsonl`, `${root}\\teams\\${SID(1)}.jsonl`, `${root}\\teams\\${SID(1)}`,
      `${root}\\D--x\\..\\..\\${SID(1)}.jsonl`, `${root}\\${SID(1)}.jsonl`, `${root}\\${SID(1)}`, `${root}\\D--x\\notuuid.jsonl`, `${root}\\D--x\\notuuid`,
      `${root}\\D--x\\${SID(1)}.json`, `${root}\\D--x\\${SID(1)}\\tool-results\\a.jsonl`, `${root}\\D--x\\${SID(1)}\\subagents\\agent-a.jsonl`,
      `${root}\\D--x\\${SID(1)}\\subagents`, `D:\\other\\D--x\\${SID(1)}.jsonl`, `D:\\other\\D--x\\${SID(1)}`, root, `${root}\\D--x`, 'C:\\Users\\u\\.claude',
    ]) {
      expect(isTrashablePath(root, p), p).toBe(false);
    }
  });

  it('실제 경로·종류 확인: 파일은 파일, 폴더는 폴더만, 없으면 false', async () => {
    const r = join(tmp, 'proj');
    mkdirSync(join(r, 'D--x', SID(1)), { recursive: true });
    writeFileSync(join(r, 'D--x', `${SID(1)}.jsonl`), '{}\n');
    expect(await realUnder(r, join(r, 'D--x', `${SID(1)}.jsonl`), 'file')).toBe(true);
    expect(await realUnder(r, join(r, 'D--x', SID(1)), 'dir')).toBe(true);
    expect(await realUnder(r, join(r, 'D--x', SID(1)), 'file')).toBe(false);
    expect(await realUnder(r, join(r, 'D--x', `${SID(1)}.jsonl`), 'dir')).toBe(false);
    expect(await realUnder(r, join(r, 'D--x', `${SID(2)}.jsonl`), 'file')).toBe(false);
  });

  it('계획: 대화 + 묶인 팀원 + 있는 대화 폴더(서브에이전트 수 포함), 인덱스에 없으면 null', async () => {
    const lead = hi(1, 'D--x', 'lead');
    const mate = hi(91, 'C--other', 'teammate', 'session-00000001');
    const listSub = async (dir: string, sid: string): Promise<string[]> => (sid === SID(1) ? [join('R', dir, sid, 'subagents', 'agent-a.jsonl'), 'b'] : []);
    const dirs = new Set([join('R', 'D--x', SID(1))]);
    const p = await planTrash('R', [lead, mate, hi(2, 'D--x', 'session')], SID(1), listSub, async (d) => dirs.has(d));
    expect(p?.main).toEqual({ path: join('R', 'D--x', `${SID(1)}.jsonl`), key: lead.key });
    expect(p?.mates).toEqual([{ path: join('R', 'C--other', `${SID(91)}.jsonl`), key: mate.key }]);
    expect(p?.folders).toEqual([join('R', 'D--x', SID(1))]);
    expect(p?.subagents).toBe(2);
    expect(p?.sessionIds).toEqual([SID(1), SID(91)]);
    expect(extraCount(p!)).toBe(3);
    expect(await planTrash('R', [lead], SID(7), listSub)).toBeNull();
    expect(await planTrash('R', [mate], SID(91), listSub)).toBeNull(); // 팀원 파일을 직접 지우지 않음
  });

  it('이동: 검증 통과분만(파일·대화 폴더), 실패해도 계속, 밖의 경로·모양이 다른 경로는 건드리지 않음', async () => {
    const r = join(tmp, 'proj2');
    mkdirSync(join(r, 'D--x', SID(1), 'subagents'), { recursive: true });
    const main = join(r, 'D--x', `${SID(1)}.jsonl`);
    const folder = join(r, 'D--x', SID(1));
    const sub = join(folder, 'subagents', 'agent-z.jsonl');
    const locked = join(r, 'D--x', `${SID(3)}.jsonl`);
    const outside = join(tmp, 'outside.jsonl');
    for (const f of [main, sub, locked, outside]) writeFileSync(f, '{}\n');
    const seen: string[] = [];
    const out = await moveToTrash(r, [main, folder, sub, locked, outside, join(r, 'history.jsonl')], async (p) => {
      seen.push(p);
      if (p === locked) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    expect(seen).toEqual([main, folder, locked]);
    expect(out).toEqual({ moved: [main, folder], failed: [locked], refused: [sub, outside, join(r, 'history.jsonl')] });
  });
});

describe('로그인 상태·로그아웃·로그인 감시(F7-2)', () => {
  it('auth status JSON에서 loggedIn만', () => {
    expect(parseAuthStatus('{"loggedIn":true,"email":"a@b","orgName":"x"}')).toBe(true);
    expect(parseAuthStatus('{"loggedIn":false}')).toBe(false);
    expect(parseAuthStatus('{"loggedIn":"yes"}')).toBeNull();
    expect(parseAuthStatus('Not logged in')).toBeNull();
    expect(parseAuthStatus('')).toBeNull();
  });

  it('상태 판정: CLI 값 우선, 없으면 이메일 유무', () => {
    expect(loggedInFrom(true, null)).toBe(true);
    expect(loggedInFrom(false, 'a@b')).toBe(false);
    expect(loggedInFrom(null, 'a@b')).toBe(true);
    expect(loggedInFrom(null, null)).toBe(false);
  });

  it('로그인 칸 감시: 프로그램을 본 뒤 셸로 돌아오면 끝, 못 봤으면 유예 시간 뒤 끝', () => {
    let w = { sawProgram: false, since: 0 };
    let r = stepLogin(w, 'pwsh', true, 1000);
    expect(r.done).toBe(false);
    r = stepLogin(r.w, '', false, 2000);
    expect(r.done).toBe(false);
    r = stepLogin(r.w, 'claude', false, 3000);
    expect(r).toEqual({ w: { sawProgram: true, since: 0 }, done: false });
    r = stepLogin(r.w, 'claude', false, 60000);
    expect(r.done).toBe(false);
    expect(stepLogin(r.w, 'pwsh', true, 61000).done).toBe(true);
    w = { sawProgram: false, since: 0 };
    expect(stepLogin(w, 'pwsh', true, LOGIN_GRACE_MS - 1).done).toBe(false);
    expect(stepLogin(w, 'pwsh', true, LOGIN_GRACE_MS).done).toBe(true);
    // 실패 뒤 다시 기다리는 상태(since = 무한대)는 프로그램을 다시 봐야만 끝난다
    w = { sawProgram: false, since: Number.POSITIVE_INFINITY };
    expect(stepLogin(w, 'pwsh', true, 1e15).done).toBe(false);
  });

  it('셸 판정: pwsh/powershell 또는 설정한 셸', () => {
    expect(isShellCommand('pwsh', null)).toBe(true);
    expect(isShellCommand('powershell.exe', null)).toBe(true);
    expect(isShellCommand('claude', null)).toBe(false);
    expect(isShellCommand('cmd', null)).toBe(false);
    expect(isShellCommand('nu', 'C:\\x\\nu.exe')).toBe(true);
  });

  it('실행 형태: .exe는 직접, .cmd는 cmd.exe /d /s /c, 그 밖·이상한 인자는 거부', () => {
    expect(claudeInvocation('C:\\b\\claude.exe', ['auth', 'logout'])).toEqual({ file: 'C:\\b\\claude.exe', args: ['auth', 'logout'], verbatim: false });
    const c = claudeInvocation('C:\\Program Files\\n\\claude.cmd', ['auth', 'status', '--json']);
    expect(c.args).toEqual(['/d', '/s', '/c', '""C:\\Program Files\\n\\claude.cmd" auth status --json"']);
    expect(c.verbatim).toBe(true);
    expect(() => claudeInvocation('C:\\b\\claude', ['auth'])).toThrow();
    expect(() => claudeInvocation('C:\\b\\claude.exe', ['auth', 'x & calc'])).toThrow();
    expect(() => claudeInvocation('C:\\b\\claude.exe', ['--email=a@b'])).toThrow();
  });

  it('실제 실행: 공백 경로의 가짜 claude.cmd로 status·logout(종료 코드), 없는 파일은 예외 없이 실패', async () => {
    const d = join(tmp, 'bin dir');
    mkdirSync(d, { recursive: true });
    const cmd = join(d, 'claude.cmd');
    writeFileSync(cmd, '@echo off\r\nif "%2"=="status" echo {"loggedIn":true,"email":"fake@example.com"}\r\nif "%2"=="logout" exit /b 3\r\nexit /b 0\r\n');
    const st = await runClaude(cmd, ['auth', 'status', '--json'], 10000);
    expect(st.code).toBe(0);
    expect(parseAuthStatus(st.stdout)).toBe(true);
    expect((await runClaude(cmd, ['auth', 'logout'], 10000)).code).toBe(3);
    const missing = await runClaude(join(d, 'nope.exe'), ['auth', 'status'], 5000);
    expect(missing.code).toBeNull();
    expect(missing.reason).toBe('ENOENT');
  });
});

describe('사용량 영역 항상 표시(F7-1 v0.6)', () => {
  it('데이터 없음 → 막대 —와 ↻만(안내 문구 없음, v0.6 수정), ↻ 활성', () => {
    expect(usageView(null, true)).toMatchObject({ fiveHour: null, sevenDay: null, model: null, note: null, refreshDisabled: false });
    expect(usageView({ fiveHour: null, sevenDay: null, model: null, updatedAt: null, error: null }, true).note).toBeNull();
  });

  it('데이터 있음 → 안내 없음, 실패 안내가 있으면 그것만', () => {
    const u = { fiveHour: { pct: 5, resetsAt: null }, sevenDay: null, model: null, updatedAt: 1, error: null };
    expect(usageView(u, true)).toMatchObject({ fiveHour: { pct: 5 }, note: null, refreshDisabled: false });
    expect(usageView({ ...u, fiveHour: null, error: '401' }, true)).toMatchObject({ note: null, error: '401' });
  });

  it('로그아웃 → 값을 보이지 않고 ↻ 비활성 + 로그인 안내', () => {
    const u = { fiveHour: { pct: 5, resetsAt: null }, sevenDay: { pct: 1, resetsAt: null }, model: null, updatedAt: 1, error: 'x' };
    expect(usageView(u, false)).toEqual({ fiveHour: null, sevenDay: null, model: null, updatedAt: null, note: usageLoggedOutNote(), error: null, refreshDisabled: true });
  });

  it('UsageTracker.clear: 값 비움, 그보다 오래된 파일 기록은 무시', async () => {
    const f = join(tmp, 'u1', 'usage.json');
    mkdirSync(join(tmp, 'u1'));
    writeFileSync(f, JSON.stringify({ v: 1, at: Date.now() - 1000, fiveHour: { pct: 9, resetsAt: null }, sevenDay: null }));
    const t = new UsageTracker(f, async () => ({ ok: false, error: 'x', reason: 'x' }));
    await t.start();
    expect(t.get().fiveHour?.pct).toBe(9);
    t.clear();
    expect(t.get()).toEqual({ fiveHour: null, sevenDay: null, model: null, updatedAt: null, error: null });
    await t.reload();
    expect(t.get().fiveHour).toBeNull();
    writeFileSync(f, JSON.stringify({ v: 1, at: Date.now() + 5, fiveHour: { pct: 11, resetsAt: null }, sevenDay: null }));
    await new Promise((r) => setTimeout(r, 10));
    await t.reload();
    expect(t.get().fiveHour?.pct).toBe(11);
    t.stop();
  });
});

describe('사이드바 표시 규칙(F2-1)', () => {
  const now = new Date(2026, 9, 26, 12, 0);
  const dto = (n: number, o: Partial<HistoryItemDto> = {}): HistoryItemDto => ({
    sessionId: SID(n), title: `제목${n}`, cwd: 'D:\\x', folderKey: 'd:\\x', folderName: 'x', mtimeMs: n, createdMs: null, kind: 'lead', mates: 0,
    key: KEY('D--x', n), customTitle: null, archived: false, ...o,
  });

  it('표시 이름 override와 원래 제목, 검색은 둘 다 대상', () => {
    const a = dto(1, { customTitle: '바뀐 이름' });
    expect(displayTitle(a, now)).toBe('바뀐 이름');
    expect(originalTitle(a, now)).toBe('제목1');
    expect(groupHistory([a], '바뀐', now)[0].items[0].sessionId).toBe(SID(1));
    expect(groupHistory([a], '제목1', now)[0].items[0].sessionId).toBe(SID(1));
  });

  it('툴팁 마지막 줄은 세션 ID 전체(축약 없음)', () => {
    expect(historyTip(dto(1), '제목1', 'x').split('\n')).toEqual(['제목1', 'D:\\x', `세션 ID: ${SID(1)}`]);
    const full = historyTip(dto(2, { customTitle: '바뀐 이름', mates: 2, cwd: null }), '바뀐 이름', 'x').split('\n');
    expect(full).toEqual(['바뀐 이름', '원래 제목: 제목2', 'x', '팀원 대화 2개', `세션 ID: ${SID(2)}`]);
  });

  it('상태 필터: 활성(기본)은 보관 제외, 보관됨은 보관만, 전체는 모두(검색과 조합)', () => {
    const items = [dto(1), dto(2, { archived: true }), dto(3, { archived: true, title: 'zeta' })];
    const ids = (f: Partial<HistoryFilter>, q = ''): string[] => viewHistory(items, { ...DEFAULT_FILTER, ...f }, q, now).flatMap((g) => g.items.map((i) => i.sessionId));
    expect(groupHistory(items, '', now).flatMap((g) => g.items.map((i) => i.sessionId))).toEqual([SID(1)]);
    expect(ids({ status: 'archived' })).toEqual([SID(3), SID(2)]);
    expect(ids({ status: 'archived' }, 'zeta')).toEqual([SID(3)]);
    expect(ids({ status: 'all' })).toEqual([SID(3), SID(2), SID(1)]);
    expect(ids({ status: 'active' }, 'zeta')).toEqual([]);
    expect(ids({ status: 'all' }, 'nothing')).toEqual([]);
  });
});

describe('히스토리 필터·그룹·정렬(F2-2)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date(2026, 9, 26, 12, 0, 0);
  const t = now.getTime();
  const dto = (n: number, o: Partial<HistoryItemDto> = {}): HistoryItemDto => ({
    sessionId: SID(n), title: `제목${n}`, cwd: 'D:\\x', folderKey: 'd:\\x', folderName: 'x', mtimeMs: t, createdMs: null, kind: 'lead', mates: 0,
    key: KEY('D--x', n), customTitle: null, archived: false, ...o,
  });
  const ids = (items: HistoryItemDto[], f: Partial<HistoryFilter>, q = ''): string[] =>
    viewHistory(items, { ...DEFAULT_FILTER, ...f }, q, now).flatMap((g) => g.items.map((i) => i.sessionId));

  it('최근 활동: 경계 "지금 - N×24h" 포함, 1ms 더 이전은 제외', () => {
    const items = [dto(1, { mtimeMs: t - 7 * DAY }), dto(2, { mtimeMs: t - 7 * DAY - 1 }), dto(3, { mtimeMs: t - DAY })];
    expect(ids(items, { recent: '7' })).toEqual([SID(3), SID(1)]);
    expect(ids(items, { recent: '1' })).toEqual([SID(3)]);
    expect(ids(items, { recent: 'all' })).toHaveLength(3);
  });

  it('날짜 그룹: 자정 경계(오늘 0:00:00.000은 오늘, 그 1ms 전은 어제), 지난 7일·30일·이전, 순서 고정', () => {
    const midnight = new Date(2026, 9, 26).getTime();
    expect(dateBucket(midnight, now)).toBe('today');
    expect(dateBucket(midnight - 1, now)).toBe('yesterday');
    expect(dateBucket(new Date(2026, 9, 25).getTime(), now)).toBe('yesterday');
    expect(dateBucket(new Date(2026, 9, 25).getTime() - 1, now)).toBe('week');
    // 오늘 포함 N일(QA O-34): 지난 7일 = 10/20 0시부터(2~6일 전), 지난 30일 = 9/27 0시부터(7~29일 전)
    expect(dateBucket(new Date(2026, 9, 20).getTime(), now)).toBe('week');
    expect(dateBucket(new Date(2026, 9, 20).getTime() - 1, now)).toBe('month');
    expect(dateBucket(new Date(2026, 9, 19).getTime(), now)).toBe('month');
    expect(dateBucket(new Date(2026, 8, 27).getTime(), now)).toBe('month');
    expect(dateBucket(new Date(2026, 8, 27).getTime() - 1, now)).toBe('older');
    const items = [dto(1, { mtimeMs: midnight - 40 * DAY }), dto(2, { mtimeMs: midnight + 1 }), dto(3, { mtimeMs: midnight - 1 })];
    const g = viewHistory(items, { ...DEFAULT_FILTER, group: 'date' }, '', now);
    expect(g.map((x) => [x.name, x.items.map((i) => i.sessionId)])).toEqual([['오늘', [SID(2)]], ['어제', [SID(3)]], ['이전', [SID(1)]]]);
    expect(g.every((x) => x.kind === 'date')).toBe(true);
  });

  it('그룹 없음: 머리 없는 그룹 1개, 결과가 없으면 빈 배열', () => {
    const items = [dto(1, { folderKey: 'a', mtimeMs: t - 1 }), dto(2, { folderKey: 'b', mtimeMs: t })];
    const g = viewHistory(items, { ...DEFAULT_FILTER, group: 'none' }, '', now);
    expect(g).toHaveLength(1);
    expect(g[0].kind).toBe('none');
    expect(g[0].items.map((i) => i.sessionId)).toEqual([SID(2), SID(1)]);
    expect(viewHistory(items, { ...DEFAULT_FILTER, group: 'none' }, 'zzz', now)).toEqual([]);
  });

  it('정렬 이름: 표시 이름(override 우선)·숫자 인식 오름차순, 제목 없음은 "폴더명 시각"으로 비교', () => {
    const items = [dto(1, { title: '대화 10' }), dto(2, { title: '대화 9' }), dto(3, { title: 'z', customTitle: '가나다' }), dto(4, { title: null, folderName: '나' })];
    expect(ids(items, { sort: 'name', group: 'none' })).toEqual([SID(3), SID(4), SID(2), SID(1)]);
  });

  it('정렬 생성 날짜: 첫 기록 시각(최신 먼저), 없으면 수정 시각으로 대체', () => {
    const items = [dto(1, { createdMs: t - 3 * DAY, mtimeMs: t }), dto(2, { createdMs: null, mtimeMs: t - 2 * DAY }), dto(3, { createdMs: t - DAY, mtimeMs: t - 5 * DAY })];
    expect(ids(items, { sort: 'created', group: 'none' })).toEqual([SID(3), SID(2), SID(1)]);
    expect(createdOf(items[1])).toBe(t - 2 * DAY);
  });

  it('폴더 그룹 순서: 이름 정렬이면 폴더 이름 순(첫 항목 이름과 무관), 그 밖에는 같은 기준(그룹 대표값 = 정렬된 첫 항목)', () => {
    const items = [
      dto(1, { folderKey: 'a', folderName: 'A', title: '나', mtimeMs: t - 2 * DAY }),
      dto(2, { folderKey: 'b', folderName: 'B', title: '가', mtimeMs: t }),
      dto(3, { folderKey: 'a', folderName: 'A', title: '다', mtimeMs: t - 3 * DAY }),
      dto(4, { folderKey: 'p10', folderName: '폴더10', title: '가', mtimeMs: t - 4 * DAY }),
      dto(5, { folderKey: 'p9', folderName: '폴더9', title: '하', mtimeMs: t - 5 * DAY }),
    ];
    const byName = viewHistory(items, { ...DEFAULT_FILTER, sort: 'name' }, '', now);
    // 'ko' 로케일 비교: 한글이 라틴 문자보다 앞, 숫자는 크기순(폴더9 < 폴더10). 항목 이름 정렬과 같은 규칙
    expect(byName.map((g) => g.key)).toEqual(['p9', 'p10', 'a', 'b']);
    expect(byName[2].items.map((i) => i.sessionId)).toEqual([SID(1), SID(3)]); // 그룹 A 안은 항목 이름 순(나 < 다)
    expect(viewHistory(items, DEFAULT_FILTER, '', now).map((g) => g.key)).toEqual(['b', 'a', 'p10', 'p9']);
  });

  it('저장값 검증·기본값 판정·현재 값 표시', () => {
    expect(parseFilter(null)).toEqual(DEFAULT_FILTER);
    expect(parseFilter({ status: 'archived', recent: '99', group: 'date', sort: 'x' })).toEqual({ ...DEFAULT_FILTER, status: 'archived', group: 'date' });
    expect(isDefaultFilter(DEFAULT_FILTER)).toBe(true);
    expect(isDefaultFilter({ ...DEFAULT_FILTER, recent: '30' })).toBe(false);
    expect(filterValueLabel({ ...DEFAULT_FILTER, sort: 'created' }, 'sort')).toBe('생성 날짜');
    expect(filterValueLabel(DEFAULT_FILTER, 'recent')).toBe('전체');
  });

  it('삭제 불가 사유: 탭으로 열림(이어간 원래 ID 포함) / 실행 중', () => {
    const tab = { leadSessionId: null, resumeSessionId: SID(1) } as unknown as TabStateDto;
    const run: RunningDto[] = [{ sessionId: SID(2), psmuxSession: null, ours: false }];
    // v0.9: 툴팁 문장 대신 메뉴 라벨에 붙는 짧은 사유
    expect(trashBlockedReason(SID(1), [tab], [])).toBe('탭으로 열림');
    expect(trashBlockedReason(SID(2), [], run)).toBe('외부에서 실행 중');
    expect(trashBlockedReason(SID(3), [tab], run)).toBeNull();
  });

  it('확인 문구', () => {
    expect(trashMessage('A', 3)).toBe("'A'을(를) 휴지통으로 이동합니다. 팀원·서브에이전트 기록 3개도 함께 이동합니다.");
    expect(trashMessage('A', 0)).toBe("'A'을(를) 휴지통으로 이동합니다.");
    expect(logoutMessage(2)).toBe('열린 세션 2개의 Claude Code가 끊깁니다. 계속할까요?');
    expect(logoutMessage(0)).toBe('로그아웃할까요?');
  });
});

describe('사이드바 접기·메뉴 위치(v0.6 추가)', () => {
  it('ui-state.json: 사이드바 접힘 저장·복원, boolean만 받음', async () => {
    const { UiStateStore } = await import('../../src/main/appData');
    const f = join(tmp, 'ui1', 'ui-state.json');
    const s = new UiStateStore(f);
    expect(s.get().sidebarCollapsed).toBe(false);
    s.setSidebarCollapsed('yes');
    expect(s.get().sidebarCollapsed).toBe(false);
    s.setSidebarCollapsed(true);
    s.flush();
    expect(new UiStateStore(f).get().sidebarCollapsed).toBe(true);
    expect(JSON.parse(readFileSync(f, 'utf8')).sidebarCollapsed).toBe(true);
  });

  it('⋮ 메뉴 위치: 아래 공간이 있으면 아래, 모자라면 위로, 창 밖으로 나가지 않음', async () => {
    const { menuPosition } = await import('../../src/renderer/components/Sidebar');
    expect(menuPosition({ top: 100, bottom: 124, right: 230 }, 160, 106, 1400, 600)).toEqual({ left: 70, top: 126, up: false });
    expect(menuPosition({ top: 500, bottom: 524, right: 230 }, 160, 106, 1400, 600)).toEqual({ left: 70, top: 392, up: true });
    // 위·아래 모두 모자라면 아래쪽에 두되 창 안으로 자른다
    expect(menuPosition({ top: 50, bottom: 74, right: 100 }, 160, 106, 1400, 150)).toEqual({ left: 8, top: 36, up: false });
  });
});

describe('첫 기록 시각(F2-2 생성 날짜)', () => {
  it('timestamp가 있는 첫 레코드 시각만, 형식이 틀리면 건너뜀', async () => {
    const { applyLine, emptyFacts } = await import('../../src/main/history/jsonlFacts');
    const f = emptyFacts();
    const line = (o: unknown) => ({ text: JSON.stringify(o), truncated: false, end: 0 });
    applyLine(f, line({ type: 'summary', summary: 's' }));
    applyLine(f, line({ type: 'user', timestamp: 'not a date' }));
    applyLine(f, line({ type: 'user', timestamp: '2026-10-20T01:02:03.000Z' }));
    applyLine(f, line({ type: 'user', timestamp: '2026-10-21T00:00:00.000Z' }));
    expect(f.firstAt).toBe(Date.parse('2026-10-20T01:02:03.000Z'));
  });
});

describe('사이드바 폭 조절', () => {
  it('범위 200~480으로 자르고 정수로, 숫자가 아니면 기본 240', async () => {
    const { clampSidebarWidth } = await import('../../src/shared/sidebar');
    expect(clampSidebarWidth(240)).toBe(240);
    expect(clampSidebarWidth(199.4)).toBe(200);
    expect(clampSidebarWidth(150)).toBe(200);
    expect(clampSidebarWidth(480)).toBe(480);
    expect(clampSidebarWidth(9999)).toBe(480);
    expect(clampSidebarWidth(321.6)).toBe(322);
    for (const bad of [null, undefined, '300', Number.NaN, Number.POSITIVE_INFINITY, {}]) expect(clampSidebarWidth(bad)).toBe(240);
  });

  it('ui-state.json: 숫자만 저장(범위 밖은 잘라서), 읽을 때도 다시 자름', async () => {
    const { UiStateStore } = await import('../../src/main/appData');
    const f = join(tmp, 'ui2', 'ui-state.json');
    const s = new UiStateStore(f);
    expect(s.get().sidebarWidth).toBe(240);
    s.setSidebarWidth('300');
    expect(s.get().sidebarWidth).toBe(240);
    s.setSidebarWidth(1000);
    s.flush();
    expect(JSON.parse(readFileSync(f, 'utf8')).sidebarWidth).toBe(480);
    expect(new UiStateStore(f).get().sidebarWidth).toBe(480);
    writeFileSync(f, JSON.stringify({ sidebarWidth: 12 }));
    expect(new UiStateStore(f).get().sidebarWidth).toBe(200);
  });
});

describe('v0.6 리뷰 반영', () => {
  it('휴지통 이동 순서: 대화 폴더 → 팀원 파일 → 대화 파일(M-1)', async () => {
    const { trashOrder } = await import('../../src/main/trash');
    const plan = { main: { path: 'M', key: 'k' }, mates: [{ path: 'T1', key: 'k1' }, { path: 'T2', key: 'k2' }], folders: ['F1', 'F2'], subagents: 0, folderSubagents: [0, 0], sessionIds: [] };
    expect(trashOrder(plan)).toEqual(['F1', 'F2', 'T1', 'T2', 'M']);
  });

  it('대화 파일 이동이 실패하면 앞의 폴더·팀원은 옮겨져도 대화 파일은 남는다(실제 파일, 가짜 trashItem)', async () => {
    const { moveToTrash, trashOrder } = await import('../../src/main/trash');
    const r = join(tmp, 'order');
    const folder = join(r, 'D--x', SID(1));
    mkdirSync(folder, { recursive: true });
    const main = join(r, 'D--x', `${SID(1)}.jsonl`);
    const mate = join(r, 'D--x', `${SID(91)}.jsonl`);
    writeFileSync(main, '{}\n');
    writeFileSync(mate, '{}\n');
    const seen: string[] = [];
    const out = await moveToTrash(r, trashOrder({ main: { path: main, key: 'a' }, mates: [{ path: mate, key: 'b' }], folders: [folder], subagents: 0, folderSubagents: [0], sessionIds: [] }), async (p) => {
      seen.push(p);
      if (p === main) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    });
    expect(seen).toEqual([folder, mate, main]);
    expect(out.moved).toEqual([folder, mate]);
    expect(out.failed).toEqual([main]);
  });

  it('확인 창 수는 실제로 옮길 수 있는 대상만(O-29): 없는 폴더·밖의 팀원 경로는 세지 않음', async () => {
    const { movableSummary } = await import('../../src/main/trash');
    const r = join(tmp, 'movable');
    const folder = join(r, 'D--x', SID(1));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(r, 'D--x', `${SID(1)}.jsonl`), '{}\n');
    writeFileSync(join(r, 'D--x', `${SID(91)}.jsonl`), '{}\n');
    const plan = {
      main: { path: join(r, 'D--x', `${SID(1)}.jsonl`), key: 'a' },
      mates: [{ path: join(r, 'D--x', `${SID(91)}.jsonl`), key: 'b' }, { path: join(tmp, 'outside', `${SID(92)}.jsonl`), key: 'c' }],
      folders: [folder, join(r, 'D--x', SID(93))], subagents: 5, folderSubagents: [2, 3], sessionIds: [],
    };
    expect(await movableSummary(r, plan)).toEqual({ mainOk: true, extra: 1 + 2, folders: 1 });
    expect((await movableSummary(r, { ...plan, main: { path: join(tmp, 'x.jsonl'), key: 'z' } })).mainOk).toBe(false);
  });

  it('날짜 그룹 오늘·어제 안 항목은 시각만, 그 밖은 기존 표기', async () => {
    const { itemTimeLabel, formatTime } = await import('../../src/renderer/history');
    const now = new Date(2026, 9, 26, 12, 0);
    const y = new Date(2026, 9, 25, 9, 5).getTime();
    expect(itemTimeLabel(y, now, '<date:yesterday>')).toBe('09:05');
    expect(itemTimeLabel(y, now, '<date:today>')).toBe('09:05');
    expect(itemTimeLabel(y, now, 'd:\\x')).toBe(formatTime(y, now));
    expect(itemTimeLabel(y, now, '<date:week>')).toBe('어제');
  });
});

describe('실기 피드백(v0.6 이후)', () => {
  it('세션 한도 초기화 문구: 60분 미만 N분, 이상 N시간 M분, 지났거나 없으면 null(분은 올림)', async () => {
    const { resetLabel } = await import('../../src/renderer/components/UsageArea');
    const now = 1_800_000_000_000;
    expect(resetLabel(now + 36 * 60_000, now)).toBe('36분 후 초기화');
    expect(resetLabel(now + 30_000, now)).toBe('1분 후 초기화');
    expect(resetLabel(now + 59 * 60_000 + 1, now)).toBe('1시간 0분 후 초기화');
    expect(resetLabel(now + 59 * 60_000, now)).toBe('59분 후 초기화');
    expect(resetLabel(now + (4 * 60 + 5) * 60_000, now)).toBe('4시간 5분 후 초기화');
    expect(resetLabel(now, now)).toBeNull();
    expect(resetLabel(now - 1, now)).toBeNull();
    expect(resetLabel(null, now)).toBeNull();
    expect(resetLabel(undefined, now)).toBeNull();
  });

  it('필터 하위 메뉴 위치: 최상위 메뉴 오른쪽에 붙임, 모자라면 왼쪽, 아래가 모자라면 위로', async () => {
    const { flyoutPosition } = await import('../../src/renderer/components/FilterMenu');
    // 사이드바 200px: 메뉴 11~187, 하위 메뉴 140×110, 창 1600×900 → 오른쪽(카드 영역 위)
    expect(flyoutPosition({ left: 11, right: 187 }, { top: 100 }, 140, 110, 1600, 900)).toEqual({ left: 187, top: 96, side: 'right' });
    // 창 오른쪽이 모자라면 왼쪽에
    expect(flyoutPosition({ left: 400, right: 576 }, { top: 100 }, 140, 110, 700, 900)).toEqual({ left: 260, top: 96, side: 'left' });
    // 아래가 모자라면 창 안으로 올림
    expect(flyoutPosition({ left: 11, right: 187 }, { top: 880 }, 140, 110, 1600, 900).top).toBe(782);
  });

  it('필터 최상위 메뉴 위치: 버튼 오른쪽 끝에 맞춰 왼쪽으로, 넓으면 왼쪽 여백에 붙여 카드 영역 쪽으로, 창 안으로 당김', async () => {
    const { menuPosition } = await import('../../src/renderer/components/FilterMenu');
    // 사이드바 240px, 버튼 영역 오른쪽 228·위 88, 메뉴 216 → 예전 자리(왼쪽 12, 위 88+34)
    expect(menuPosition({ top: 88, right: 228 }, 216, 170, 1280, 800)).toEqual({ left: 12, top: 122 });
    // 내용이 넓은 언어(320px): 왼쪽이 모자라 화면 여백 8에 붙고 사이드바 밖으로 넘친다
    expect(menuPosition({ top: 88, right: 228 }, 320, 170, 1028, 672)).toEqual({ left: 8, top: 122 });
    // 사이드바가 넓어도(480px) 버튼 오른쪽 끝 기준
    expect(menuPosition({ top: 88, right: 468 }, 360, 170, 1028, 672)).toEqual({ left: 108, top: 122 });
    // 창이 좁으면 오른쪽 끝 안으로, 아래가 모자라면 위로
    expect(menuPosition({ top: 88, right: 228 }, 360, 170, 300, 672).left).toBe(8);
    expect(menuPosition({ top: 600, right: 228 }, 216, 170, 1028, 672).top).toBe(494);
  });
});

describe('계정 확인 캐시(AuthCache, 리뷰 Minor)', () => {
  /** 끝나는 시점을 테스트가 정하는 확인. */
  const controlled = () => {
    let calls = 0;
    const waits: (() => void)[] = [];
    const check = async () => {
      calls++;
      await new Promise<void>((r) => waits.push(r));
      return { cli: 'C:\claude.exe', status: calls % 2 === 1, statusReason: null };
    };
    return { check, calls: () => calls, release: () => waits.shift()?.() };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('진행 중일 때 force 2건이 겹쳐도 status는 2회까지만(대기 중인 force 1개 공유)', async () => {
    const { AuthCache } = await import('../../src/main/authCache');
    const c = controlled();
    const a = new AuthCache(c.check);
    const p0 = a.refresh();
    const p1 = a.refresh(true);
    const p2 = a.refresh(true);
    expect(p1).toBe(p2);
    c.release();
    await p0;
    await tick();
    c.release();
    await Promise.all([p1, p2]);
    expect(c.calls()).toBe(2);
    expect(a.get()?.status).toBe(false); // 두 번째(최신) 결과
  });

  it('force 아님은 진행 중인(또는 대기 중인) 확인을 공유', async () => {
    const { AuthCache } = await import('../../src/main/authCache');
    const c = controlled();
    const a = new AuthCache(c.check);
    const p0 = a.refresh();
    expect(a.refresh()).toBe(p0);
    const q = a.refresh(true);
    expect(a.refresh()).toBe(q);
    c.release();
    await p0;
    await tick();
    c.release();
    await q;
    expect(c.calls()).toBe(2);
  });

  it('확인이 예외로 끝나면 캐시는 "모름"(cli·status null), 알림 1회, 다음 확인은 정상', async () => {
    const { AuthCache } = await import('../../src/main/authCache');
    let fail = true;
    const errors: unknown[] = [];
    const a = new AuthCache(async () => {
      if (fail) throw new Error('boom');
      return { cli: 'x', status: true };
    }, (e) => errors.push(e), () => 1234);
    await a.refresh();
    expect(a.get()).toEqual({ cli: null, status: null, statusReason: 'error', at: 1234 });
    expect(errors).toHaveLength(1);
    expect(a.stale(10)).toBe(false);
    fail = false;
    await a.refresh(true);
    expect(a.get()).toMatchObject({ cli: 'x', status: true });
  });
});
