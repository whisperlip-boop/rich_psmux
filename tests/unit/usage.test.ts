import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { autoRefreshUsage, fetchOauthUsage, UsageTracker, type FetchUsageResult } from '../../src/main/usage';
import { writeUsageAtomic, writeUsageAtomicSync } from '../../src/main/usageFile';
import { formatAgo, pctText, usageLevel, usageWarn } from '../../src/renderer/components/UsageArea';
import { parseOauthUsage, parseStatusLineInput, parseUsageRecord, usageEmpty, type UsageRecord } from '../../src/shared/usage';

const logs = vi.hoisted(() => [] as string[]);
vi.mock('../../src/main/logger', () => ({ log: (_l: string, m: string) => { logs.push(m); }, errMsg: (e: unknown) => String(e) }));

const TOKEN = 'sk-ant-oat01-FAKE-TOKEN-DO-NOT-LEAK-1234567890';
const tmp = mkdtempSync(join(tmpdir(), 'ctd-usage-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => { logs.length = 0; });

let n = 0;
const dir = (): string => {
  const d = join(tmp, `d${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

/** Claude Code 2.1.310 statusline 입력 모양(rate_limits 외 필드 포함). */
function statusInput(rl?: unknown): string {
  return JSON.stringify({
    session_id: '11111111-2222-3333-4444-555555555555', cwd: 'C:\\secret\\proj', transcript_path: 'C:\\t.jsonl',
    model: { id: 'claude-x', display_name: 'X' }, cost: { total_cost_usd: 1.23 }, workspace: { current_dir: 'C:\\secret\\proj' },
    ...(rl === undefined ? {} : { rate_limits: rl }),
  });
}

/** 2026-10-26 실제 /api/oauth/usage 응답과 같은 구조(값은 가짜). */
function oauthBody(): Record<string, unknown> {
  return {
    five_hour: { utilization: 8, resets_at: '2026-10-26T10:00:00.000000+00:00', limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
    seven_day: { utilization: 2, resets_at: '2026-10-30T00:00:00+00:00', limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
    seven_day_oauth_apps: null, seven_day_opus: null, seven_day_sonnet: null, seven_day_cowork: null,
    extra_usage: { is_enabled: false, utilization: null, currency: 'USD' },
    limits: [
      { kind: 'session', group: 'session', scope: null, severity: 'normal', percent: 8, resets_at: '2026-10-26T10:00:00Z', is_active: true },
      { kind: 'weekly_all', group: 'weekly', scope: null, severity: 'normal', percent: 2, resets_at: '2026-10-30T00:00:00Z', is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, severity: 'normal', percent: 1, resets_at: '2026-10-30T00:00:00Z', is_active: false },
    ],
    spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, percent: 0 },
  };
}

describe('statusline 입력 파싱', () => {
  it('rate_limits의 사용률·재설정 시각(epoch 초 → ms)과 받은 시각만 남긴다', () => {
    const rec = parseStatusLineInput(statusInput({ five_hour: { used_percentage: 3.4, resets_at: 1793000000 }, seven_day: { used_percentage: 0, resets_at: 1793500000 } }), 1700);
    expect(rec).toEqual({ v: 1, at: 1700, fiveHour: { pct: 3.4, resetsAt: 1793000000000 }, sevenDay: { pct: 0, resetsAt: 1793500000000 } });
    const s = JSON.stringify(rec);
    for (const leak of ['session_id', '1111', 'secret', 'cost', 'transcript', 'claude-x']) expect(s).not.toContain(leak);
  });

  it('rate_limits가 없거나(API 키 계정·첫 응답 전) 형식이 다르면 null', () => {
    expect(parseStatusLineInput(statusInput(), 1)).toBeNull();
    expect(parseStatusLineInput(statusInput(null), 1)).toBeNull();
    expect(parseStatusLineInput(statusInput({ five_hour: { used_percentage: 'x' } }), 1)).toBeNull();
    expect(parseStatusLineInput('{not json', 1)).toBeNull();
    expect(parseStatusLineInput('', 1)).toBeNull();
  });

  it('한쪽만 있어도 기록하고, 범위 밖 값은 0~100으로 자르고, 재설정 시각이 없으면 null', () => {
    expect(parseStatusLineInput(statusInput({ seven_day: { used_percentage: 140 } }), 5)).toEqual({ v: 1, at: 5, fiveHour: null, sevenDay: { pct: 100, resetsAt: null } });
    expect(parseStatusLineInput(statusInput({ five_hour: { used_percentage: -3, resets_at: 'bad' } }), 5)?.fiveHour).toEqual({ pct: 0, resetsAt: null });
  });

  it('usage.json 다시 읽기: 형식이 맞는 값만', () => {
    const rec: UsageRecord = { v: 1, at: 10, fiveHour: { pct: 5, resetsAt: 20 }, sevenDay: null };
    expect(parseUsageRecord(JSON.stringify(rec))).toEqual(rec);
    expect(parseUsageRecord(JSON.stringify({ ...rec, v: 2 }))).toBeNull();
    expect(parseUsageRecord(JSON.stringify({ ...rec, fiveHour: null }))).toBeNull();
    expect(parseUsageRecord('{')).toBeNull();
  });
});

describe('usage.json 원자적 기록', () => {
  it('임시 파일 없이 교체되고, 레코드 외 필드는 쓰지 않는다', () => {
    const d = dir();
    const f = join(d, 'usage.json');
    writeUsageAtomicSync(f, { v: 1, at: 1, fiveHour: { pct: 1, resetsAt: null }, sevenDay: null });
    const extra = { v: 1, at: 2, fiveHour: { pct: 2, resetsAt: null }, sevenDay: null, token: TOKEN } as UsageRecord;
    writeUsageAtomicSync(f, extra);
    expect(readdirSync(d)).toEqual(['usage.json']);
    const raw = readFileSync(f, 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(parseUsageRecord(raw)?.at).toBe(2);
  });

  it('폴더가 없으면 만든다', () => {
    const f = join(dir(), 'a', 'b', 'usage.json');
    writeUsageAtomicSync(f, { v: 1, at: 3, fiveHour: null, sevenDay: { pct: 9, resetsAt: 1 } });
    expect(existsSync(f)).toBe(true);
  });

  it('main용 비동기 기록: 교체·허용 필드만, 실패하면 예외 + 임시 파일 삭제(재시도 없음)', async () => {
    const d = dir();
    const f = join(d, 'usage.json');
    await writeUsageAtomic(f, { v: 1, at: 7, fiveHour: { pct: 7, resetsAt: null }, sevenDay: null, token: TOKEN } as UsageRecord);
    expect(readdirSync(d)).toEqual(['usage.json']);
    expect(readFileSync(f, 'utf8')).not.toContain(TOKEN);
    expect(parseUsageRecord(readFileSync(f, 'utf8'))?.at).toBe(7);
    // 대상 이름이 폴더면 rename 실패
    const bad = join(d, 'isdir');
    mkdirSync(bad);
    await expect(writeUsageAtomic(bad, { v: 1, at: 8, fiveHour: { pct: 1, resetsAt: null }, sevenDay: null })).rejects.toThrow();
    expect(readdirSync(d).filter((x) => x.endsWith('.tmp'))).toEqual([]);
  });
});

describe('statusline 스크립트(번들 실행, 가짜 stdin)', () => {
  let script = '';
  beforeAll(async () => {
    script = join(tmp, 'statusLine.js');
    await build({ entryPoints: [join(process.cwd(), 'src', 'hook', 'statusLine.ts')], outfile: script, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  });
  const run = (out: string, input: string) => spawnSync(process.execPath, [script, out], { input, encoding: 'utf8', timeout: 15000 });

  it('rate_limits만 기록하고 stdout은 비운다', () => {
    const d = dir();
    const f = join(d, 'usage.json');
    const before = Date.now();
    const r = run(f, statusInput({ five_hour: { used_percentage: 12, resets_at: 1793000000 }, seven_day: { used_percentage: 34, resets_at: 1793500000 } }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(readdirSync(d)).toEqual(['usage.json']);
    const raw = readFileSync(f, 'utf8');
    const j = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(['at', 'fiveHour', 'sevenDay', 'v']);
    expect(j.fiveHour).toEqual({ pct: 12, resetsAt: 1793000000000 });
    expect(j.at as number).toBeGreaterThanOrEqual(before);
    for (const leak of ['1111', 'secret', 'cost', 'claude-x']) expect(raw).not.toContain(leak);
  });

  it('rate_limits가 없거나 깨진 입력이면 파일을 만들지 않고 0으로 끝난다(기존 값 유지)', () => {
    const d = dir();
    const f = join(d, 'usage.json');
    for (const input of [statusInput(), '{broken', '']) {
      const r = run(f, input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(existsSync(f)).toBe(false);
    writeFileSync(f, JSON.stringify({ v: 1, at: 1, fiveHour: { pct: 50, resetsAt: null }, sevenDay: null }));
    run(f, statusInput());
    expect(parseUsageRecord(readFileSync(f, 'utf8'))?.fiveHour?.pct).toBe(50);
  });

  it('입력이 1MB를 넘으면 기록하지 않고 바로 0으로 끝난다(리뷰 m-5)', () => {
    const d = dir();
    const f = join(d, 'usage.json');
    const big = statusInput({ five_hour: { used_percentage: 5 } }).replace('"cwd"', `"pad":"${'x'.repeat(1_100_000)}","cwd"`);
    const t0 = Date.now();
    const r = run(f, big);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(existsSync(f)).toBe(false);
  });

  it('출력 경로 인자가 없어도 실패하지 않는다', () => {
    const r = spawnSync(process.execPath, [script], { input: statusInput({ five_hour: { used_percentage: 1 } }), encoding: 'utf8', timeout: 15000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('/api/oauth/usage 응답 파싱', () => {
  it('실제 응답 구조: five_hour·seven_day utilization, 모델별은 limits weekly_scoped의 display_name(Fable)', () => {
    const u = parseOauthUsage(oauthBody());
    expect(u?.fiveHour).toEqual({ pct: 8, resetsAt: Date.parse('2026-10-26T10:00:00Z') });
    expect(u?.sevenDay?.pct).toBe(2);
    expect(u?.model).toEqual({ label: 'Fable', pct: 1, resetsAt: Date.parse('2026-10-30T00:00:00Z') });
  });

  it('weekly_scoped가 여러 개면 사용률이 높은 것', () => {
    const b = oauthBody();
    (b.limits as unknown[]).push({ kind: 'weekly_scoped', scope: { model: { display_name: 'Opus' } }, percent: 40, resets_at: null });
    expect(parseOauthUsage(b)?.model).toEqual({ label: 'Opus', pct: 40, resetsAt: null });
  });

  it('구형 seven_day_opus·sonnet 대체, limits만 있는 응답 대체', () => {
    const b = oauthBody();
    delete b.limits;
    b.seven_day_sonnet = { utilization: 7, resets_at: null };
    expect(parseOauthUsage(b)?.model).toEqual({ label: 'Sonnet', pct: 7, resetsAt: null });
    const only = { limits: oauthBody().limits };
    const u = parseOauthUsage(only);
    expect(u?.fiveHour?.pct).toBe(8);
    expect(u?.sevenDay?.pct).toBe(2);
  });

  it('모델 이름이 이상하면 모델별 값 없음, 5시간·7일이 모두 없으면 형식 변경(null)', () => {
    const b = oauthBody();
    (b.limits as Record<string, unknown>[])[2].scope = { model: { display_name: 'x\u0007y' } };
    expect(parseOauthUsage(b)?.model).toBeNull();
    expect(parseOauthUsage({ something: 1 })).toBeNull();
    expect(parseOauthUsage(null)).toBeNull();
    expect(parseOauthUsage([])).toBeNull();
  });
});

describe('fetchOauthUsage(가짜 자격 증명·가짜 fetch)', () => {
  const creds = (o: unknown): string => {
    const f = join(dir(), '.credentials.json');
    writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o));
    return f;
  };
  const okFetch = (status = 200, body: unknown = oauthBody()) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  const noLeak = (...vals: unknown[]): void => {
    for (const v of vals) expect(JSON.stringify(v) ?? '').not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
  };

  it('Bearer 토큰·beta 헤더로 1회 GET, 결과에는 사용률만', async () => {
    const f = okFetch();
    const r = await fetchOauthUsage({ credentialsFile: creds({ claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 3600000, refreshToken: 'rt-SECRET' } }), fetchImpl: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(init.method).toBe('GET');
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(h['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(r.ok && r.data.model?.label).toBe('Fable');
    noLeak(r);
    expect(JSON.stringify(r)).not.toContain('rt-SECRET');
  });

  it('expiresAt이 지났으면 호출하지 않고 만료 안내(refresh 없음)', async () => {
    const f = okFetch();
    const r = await fetchOauthUsage({ credentialsFile: creds({ claudeAiOauth: { accessToken: TOKEN, expiresAt: 1000, refreshToken: 'rt' } }), fetchImpl: f as unknown as typeof fetch, now: 2000 });
    expect(f).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain('토큰 만료');
    noLeak(r);
  });

  it('파일 없음·토큰 없음·깨진 JSON(토큰 포함) → 안내만, 원문·토큰 없음', async () => {
    const f = okFetch();
    const missing = await fetchOauthUsage({ credentialsFile: join(tmp, 'nope', '.credentials.json'), fetchImpl: f as unknown as typeof fetch });
    expect(!missing.ok && missing.error).toContain('파일이 없습니다');
    const noToken = await fetchOauthUsage({ credentialsFile: creds({ claudeAiOauth: {} }), fetchImpl: f as unknown as typeof fetch });
    expect(noToken.ok).toBe(false);
    // V8 JSON.parse 오류 메시지에는 입력 일부가 들어간다 → 그대로 쓰면 토큰이 샐 수 있음
    const broken = await fetchOauthUsage({ credentialsFile: creds(`{"claudeAiOauth":{"accessToken":"${TOKEN}" oops`), fetchImpl: f as unknown as typeof fetch });
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.reason).toBe('credentials: unreadable (invalid json)');
    const header = await fetchOauthUsage({ credentialsFile: creds({ claudeAiOauth: { accessToken: `${TOKEN}\r\nX: y` } }), fetchImpl: f as unknown as typeof fetch });
    expect(header.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
    noLeak(missing, noToken, broken, header);
  });

  it('401·429·500·형식 변경·네트워크 오류·시간 초과 → 한국어 한 줄, 원인에는 상태 코드만', async () => {
    const file = creds({ claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 3600000 } });
    const call = (fetchImpl: unknown, timeoutMs?: number) => fetchOauthUsage({ credentialsFile: file, fetchImpl: fetchImpl as typeof fetch, timeoutMs });
    const r401 = await call(okFetch(401, { error: { message: `bad token ${TOKEN}` } }));
    expect(r401).toMatchObject({ ok: false, reason: 'http 401' });
    expect(!r401.ok && r401.error).toContain('인증 실패(401)');
    expect(await call(okFetch(429, {}))).toMatchObject({ ok: false, reason: 'http 429' });
    expect(await call(okFetch(500, {}))).toMatchObject({ ok: false, reason: 'http 500' });
    const fmt = await call(okFetch(200, { totally: 'different' }));
    expect(fmt).toMatchObject({ ok: false, reason: 'unexpected response format' });
    const notJson = await call(vi.fn(async () => new Response('<html>', { status: 200 })));
    expect(notJson).toMatchObject({ ok: false, reason: 'unexpected response format' });
    const net = await call(vi.fn(async () => { throw Object.assign(new TypeError(`fetch failed ${TOKEN}`), { cause: { code: 'ENOTFOUND' } }); }));
    expect(net).toMatchObject({ ok: false, reason: 'network: ENOTFOUND' });
    const slow = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(init.signal?.reason));
    }));
    const to = await call(slow, 50);
    expect(to).toMatchObject({ ok: false, reason: 'network: timeout' });
    noLeak(r401, fmt, notJson, net, to);
  });

  it('바깥 취소(로그아웃): 요청을 바로 끊고 시간 초과와 구분해 aborted로 실패', async () => {
    const file = creds({ claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 3600000 } });
    // 실제 fetch처럼: 이미 꺼진 신호면 바로 거부, 아니면 abort 때 거부
    let started: () => void = () => undefined;
    const slow = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      if (init.signal?.aborted) { rej(init.signal.reason); return; }
      init.signal?.addEventListener('abort', () => rej(init.signal?.reason));
      started();
    }));
    const ac = new AbortController();
    const begun = new Promise<void>((r) => { started = r; });
    const p = fetchOauthUsage({ credentialsFile: file, fetchImpl: slow as unknown as typeof fetch, timeoutMs: 10_000, signal: ac.signal });
    await begun; // 요청이 나간 뒤에 끊는다(시간 초과 10초 전에 끝나야 함)
    ac.abort();
    expect(await p).toMatchObject({ ok: false, reason: 'aborted' });
    // 이미 꺼진 신호면 fetch를 부르지 않고 끝난다
    const pre = new AbortController();
    pre.abort();
    const never = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await fetchOauthUsage({ credentialsFile: file, fetchImpl: never as unknown as typeof fetch, signal: pre.signal })).toMatchObject({ ok: false, reason: 'aborted' });
    expect(never).not.toHaveBeenCalled();
  });
});

describe('UsageTracker', () => {
  const rec = (at: number, pct: number): UsageRecord => ({ v: 1, at, fiveHour: { pct, resetsAt: null }, sevenDay: { pct: pct / 2, resetsAt: null } });

  it('재시작: 저장된 마지막 값·시각을 그대로 읽고, 같거나 오래된 레코드는 무시', async () => {
    const f = join(dir(), 'usage.json');
    writeUsageAtomicSync(f, rec(1000, 30));
    const t = new UsageTracker(f, async () => ({ ok: false, error: 'x', reason: 'x' }));
    await t.start();
    expect(t.get()).toEqual({ fiveHour: { pct: 30, resetsAt: null }, sevenDay: { pct: 15, resetsAt: null }, model: null, updatedAt: 1000, error: null });
    writeUsageAtomicSync(f, rec(900, 99));
    await t.reload();
    expect(t.get().fiveHour?.pct).toBe(30);
    writeUsageAtomicSync(f, rec(2000, 40));
    await t.reload();
    expect(t.get()).toMatchObject({ fiveHour: { pct: 40 }, updatedAt: 2000 });
    t.stop();
  });

  it('받은 시각이 미래면 지금으로 잘라 반영하고, 그 뒤 정상 기록도 받는다(QA O-14)', async () => {
    const f = join(dir(), 'usage.json');
    const t = new UsageTracker(f, async () => ({ ok: false, error: 'x', reason: 'x' }));
    await t.start();
    const before = Date.now();
    writeUsageAtomicSync(f, rec(before + 10 * 60_000, 20));
    await t.reload();
    const u1 = t.get();
    expect(u1.fiveHour?.pct).toBe(20);
    expect(u1.updatedAt!).toBeLessThanOrEqual(Date.now());
    expect(u1.updatedAt!).toBeGreaterThanOrEqual(before);
    await new Promise((r) => setTimeout(r, 5));
    writeUsageAtomicSync(f, rec(Date.now(), 21));
    await t.reload();
    expect(t.get().fiveHour?.pct).toBe(21);
    t.stop();
  });

  it('↻ 실패 안내는 그 뒤 statusline 새 값이 오면 지운다(QA O-15)', async () => {
    const f = join(dir(), 'usage.json');
    writeUsageAtomicSync(f, rec(1000, 30));
    const t = new UsageTracker(f, async () => ({ ok: false, error: '인증 실패(401) — …', reason: 'http 401' }));
    await t.start();
    expect((await t.refresh()).error).toContain('401');
    writeUsageAtomicSync(f, rec(Date.now(), 31));
    await t.reload();
    expect(t.get()).toMatchObject({ fiveHour: { pct: 31 }, error: null });
    t.stop();
  });

  it('파일이 없으면 빈 상태(영역 숨김), 깨진 파일은 무시', async () => {
    const f = join(dir(), 'usage.json');
    const t = new UsageTracker(f, async () => ({ ok: false, error: 'x', reason: 'x' }));
    await t.start();
    expect(usageEmpty(t.get())).toBe(true);
    writeFileSync(f, '{"v":1,');
    await t.reload();
    expect(usageEmpty(t.get())).toBe(true);
    t.stop();
  });

  it('파일 감시: statusline이 기록하면 update 이벤트', async () => {
    const f = join(dir(), 'usage.json');
    const t = new UsageTracker(f, async () => ({ ok: false, error: 'x', reason: 'x' }));
    await t.start();
    const got = new Promise<unknown>((res) => t.once('update', res));
    writeUsageAtomicSync(f, rec(Date.now(), 12));
    await expect(Promise.race([got, new Promise((_r, rej) => setTimeout(() => rej(new Error('no update')), 5000))])).resolves.toMatchObject({ fiveHour: { pct: 12 } });
    t.stop();
  });

  it('↻: 연타해도 1회만 조회, 성공하면 모델별 포함 3개 갱신·5시간/7일은 usage.json에 기록', async () => {
    const f = join(dir(), 'usage.json');
    let calls = 0;
    const t = new UsageTracker(f, async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, data: parseOauthUsage(oauthBody())! };
    });
    await t.start();
    const [a, b] = await Promise.all([t.refresh(), t.refresh()]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(a.model?.label).toBe('Fable');
    expect(a.error).toBeNull();
    const saved = parseUsageRecord(readFileSync(f, 'utf8'));
    expect(saved?.fiveHour?.pct).toBe(8);
    expect(Object.keys(JSON.parse(readFileSync(f, 'utf8')) as object).sort()).toEqual(['at', 'fiveHour', 'sevenDay', 'v']);
    await t.refresh();
    expect(calls).toBe(2);
    t.stop();
  });

  it('↻ 실패: 기존 값은 그대로 두고 안내 한 줄만', async () => {
    const f = join(dir(), 'usage.json');
    writeUsageAtomicSync(f, rec(1000, 30));
    const t = new UsageTracker(f, async (): Promise<FetchUsageResult> => ({ ok: false, error: '토큰 만료 — Claude Code에서 갱신 후 다시 시도하세요.', reason: 'credentials: token expired (not refreshed by design)' }));
    await t.start();
    const d = await t.refresh();
    expect(d).toMatchObject({ fiveHour: { pct: 30 }, model: null, error: expect.stringContaining('토큰 만료') });
    expect(logs.some((l) => l.includes('usage refresh failed: credentials: token expired'))).toBe(true);
    t.stop();
  });

  it('토큰 비누출: 실제 fetchOauthUsage 경로 전체(성공·401·네트워크 오류)에서 IPC 페이로드·이벤트·로그·usage.json에 토큰 0건', async () => {
    const f = join(dir(), 'usage.json');
    const cf = join(dir(), '.credentials.json');
    writeFileSync(cf, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'rt', expiresAt: Date.now() + 3600000 } }));
    const fetches: unknown[] = [
      async () => new Response(JSON.stringify(oauthBody()), { status: 200 }),
      async () => new Response(JSON.stringify({ error: TOKEN }), { status: 401 }),
      async () => { throw new Error(`boom ${TOKEN}`); },
    ];
    for (const fetchImpl of fetches) {
      const t = new UsageTracker(f, () => fetchOauthUsage({ credentialsFile: cf, fetchImpl: fetchImpl as typeof fetch }));
      const events: unknown[] = [];
      t.on('update', (d) => events.push(d));
      await t.start();
      const payload = await t.refresh();
      t.stop();
      const all = [JSON.stringify(payload), JSON.stringify(events), logs.join('\n'), existsSync(f) ? readFileSync(f, 'utf8') : ''].join('\n');
      expect(all.split(TOKEN).length - 1).toBe(0);
    }
    expect(logs.some((l) => l.includes('usage refresh ok'))).toBe(true);
    expect(logs.some((l) => l.includes('http 401'))).toBe(true);
  });
});

describe('자동 1회 갱신(기동·로그인 직후)', () => {
  const rec = (at: number, pct: number): UsageRecord => ({ v: 1, at, fiveHour: { pct, resetsAt: null }, sevenDay: { pct: pct / 2, resetsAt: null } });

  /** 실패만 돌려주는 가짜 fetcher(30ms 지연)와 호출 횟수. */
  function failingTracker(f: string): { t: UsageTracker; calls: () => number } {
    let n = 0;
    const t = new UsageTracker(f, async (): Promise<FetchUsageResult> => {
      n++;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: false, error: '네트워크 오류', reason: 'network: ENOTFOUND' };
    });
    return { t, calls: () => n };
  }

  it('실패는 조용히: 기존 값 유지·안내 없음·이벤트 없음·warn 1줄', async () => {
    const f = join(dir(), 'usage.json');
    writeUsageAtomicSync(f, rec(1000, 30));
    const { t, calls } = failingTracker(f);
    await t.start();
    const events: unknown[] = [];
    t.on('update', (d) => events.push(d));
    expect(await autoRefreshUsage(t, async () => true, 'startup')).toBe(true);
    expect(calls()).toBe(1);
    expect(events).toHaveLength(0);
    expect(t.get()).toMatchObject({ fiveHour: { pct: 30 }, model: null, updatedAt: 1000, error: null });
    expect(logs.filter((l) => l.includes('usage auto refresh failed: network: ENOTFOUND'))).toHaveLength(1);
    expect(logs.filter((l) => l.includes('usage auto refresh start (startup)'))).toHaveLength(1);
    expect(logs.some((l) => l.includes('usage refresh failed'))).toBe(false);
    t.stop();
  });

  it('자동 진행 중 ↻ 합류: 같은 요청을 기다리고(조회 1회), ↻ 기준으로 실패 안내 표시', async () => {
    const { t, calls } = failingTracker(join(dir(), 'usage.json'));
    await t.start();
    const auto = autoRefreshUsage(t, async () => true, 'startup');
    await new Promise((r) => setImmediate(r)); // isLoggedIn이 끝나 자동 조회가 fetcher에서 기다리는 시점
    expect(calls()).toBe(1);
    const manual = await t.refresh();
    expect(await auto).toBe(true);
    expect(calls()).toBe(1);
    expect(manual.error).toBe('네트워크 오류');
    expect(t.get().error).toBe('네트워크 오류');
    expect(logs.filter((l) => l.includes('usage refresh failed: network: ENOTFOUND'))).toHaveLength(1);
    expect(logs.some((l) => l.includes('usage auto refresh failed'))).toBe(false);
    t.stop();
  });

  it('↻ 진행 중 자동 합류: 같은 요청(조회 1회), 여전히 ↻ 취급(안내 표시)', async () => {
    const { t, calls } = failingTracker(join(dir(), 'usage.json'));
    await t.start();
    const [manual, auto] = await Promise.all([t.refresh(), t.refresh({ silent: true })]);
    expect(calls()).toBe(1);
    expect(manual).toEqual(auto);
    expect(manual.error).toBe('네트워크 오류');
    expect(logs.filter((l) => l.includes('usage refresh failed: network: ENOTFOUND'))).toHaveLength(1);
    expect(logs.some((l) => l.includes('usage auto refresh failed'))).toBe(false);
    t.stop();
  });

  it('조회 중 로그아웃(clear): 진행 중 요청을 끊고, 그 뒤 새 조회는 끊긴 요청에 합류하지 않는다', async () => {
    const f = join(dir(), 'usage.json');
    const seen: AbortSignal[] = [];
    const t = new UsageTracker(f, (signal): Promise<FetchUsageResult> => {
      seen.push(signal);
      if (seen.length === 1) {
        // 첫 요청은 끊길 때까지 기다린다(끊기지 않으면 테스트 시간 초과)
        return new Promise((res) => { signal.addEventListener('abort', () => res({ ok: false, error: 'x', reason: 'aborted' }), { once: true }); });
      }
      return Promise.resolve({ ok: true, data: parseOauthUsage(oauthBody())! });
    });
    await t.start();
    const first = t.refresh({ silent: true });
    await new Promise((r) => setImmediate(r));
    t.clear();
    expect(seen[0].aborted).toBe(true);
    // 끊는 중에 들어온 새 조회: 이전 요청의 결과를 받지 않고 새 요청(2번째)을 보낸다
    const second = await t.refresh();
    expect(seen).toHaveLength(2);
    expect(second).toMatchObject({ fiveHour: { pct: 8 }, error: null });
    expect(usageEmpty(await first)).toBe(true);
    expect(logs.some((l) => l.includes('usage refresh result discarded (logged out during request, aborted)'))).toBe(true);
    t.stop();
  });

  it('조회 중 로그아웃(clear): 끝난 결과는 버리고 표시·usage.json에 반영하지 않는다', async () => {
    const f = join(dir(), 'usage.json');
    let release: () => void = () => undefined;
    let calls = 0;
    const t = new UsageTracker(f, async (): Promise<FetchUsageResult> => {
      calls++;
      if (calls === 1) await new Promise<void>((r) => { release = r; });
      return { ok: true, data: parseOauthUsage(oauthBody())! };
    });
    await t.start();
    const auto = autoRefreshUsage(t, async () => true, 'login');
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    t.clear();
    release();
    expect(await auto).toBe(true);
    expect(usageEmpty(t.get())).toBe(true);
    expect(existsSync(f)).toBe(false);
    expect(logs.some((l) => l.includes('usage refresh result discarded'))).toBe(true);
    // 그 뒤 새 조회는 정상 반영
    expect(await t.refresh()).toMatchObject({ fiveHour: { pct: 8 }, model: { label: 'Fable' }, error: null });
    expect(parseUsageRecord(readFileSync(f, 'utf8'))?.fiveHour?.pct).toBe(8);
    t.stop();
  });

  it('로그아웃·판정 실패면 조회하지 않는다', async () => {
    const f = join(dir(), 'usage.json');
    let calls = 0;
    const t = new UsageTracker(f, async (): Promise<FetchUsageResult> => { calls++; return { ok: true, data: parseOauthUsage(oauthBody())! }; });
    await t.start();
    expect(await autoRefreshUsage(t, async () => false, 'startup')).toBe(false);
    expect(await autoRefreshUsage(t, async () => { throw new Error('cli'); }, 'startup')).toBe(false);
    expect(calls).toBe(0);
    expect(usageEmpty(t.get())).toBe(true);
    expect(logs.some((l) => l.includes('usage auto refresh skipped (startup): logged out'))).toBe(true);
    // 로그인 상태면 같은 경로로 3개 막대 갱신
    expect(await autoRefreshUsage(t, async () => true, 'login')).toBe(true);
    expect(calls).toBe(1);
    expect(t.get()).toMatchObject({ fiveHour: { pct: 8 }, model: { label: 'Fable' }, error: null });
    t.stop();
  });
});

describe('표시 형식', () => {
  it('n분 전', () => {
    const now = 10_000_000;
    expect(formatAgo(null, now)).toBe('');
    expect(formatAgo(now - 30_000, now)).toBe('방금');
    expect(formatAgo(now + 5000, now)).toBe('방금');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5분 전');
    expect(formatAgo(now - 3 * 3600_000, now)).toBe('3시간 전');
    expect(formatAgo(now - 50 * 3600_000, now)).toBe('2일 전');
  });

  it('경고 색 판정은 표시값(반올림) 기준(QA O-13)', () => {
    expect(usageWarn(null)).toBe(false);
    expect(usageWarn({ pct: 69.4, resetsAt: null })).toBe(false);
    expect(usageWarn({ pct: 69.5, resetsAt: null })).toBe(true);
    expect(usageWarn({ pct: 69.6, resetsAt: null })).toBe(true);
    expect(usageWarn({ pct: 100, resetsAt: null })).toBe(true);
  });

  it('막대 색 4단계: 70 미만 ok, 70~89 warn, 90~99 high, 100 limit(반올림 기준)', () => {
    const lv = (pct: number) => usageLevel({ pct, resetsAt: null });
    expect(usageLevel(null)).toBeNull();
    expect(lv(0)).toBe('ok');
    expect(lv(69.4)).toBe('ok');
    expect(lv(69.5)).toBe('warn');
    expect(lv(89.4)).toBe('warn');
    expect(lv(89.5)).toBe('high');
    expect(lv(99.4)).toBe('high');
    expect(lv(99.5)).toBe('limit');
    expect(lv(100)).toBe('limit');
    expect(lv(120)).toBe('limit');
  });

  it('퍼센트: 반올림, 값 없으면 —', () => {
    expect(pctText(null)).toBe('—');
    expect(pctText({ pct: 3.4, resetsAt: null })).toBe('3%');
    expect(pctText({ pct: 99.6, resetsAt: null })).toBe('100%');
  });
});
