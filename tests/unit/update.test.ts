// 업데이트 확인·실행의 순수 로직: winget 출력 해석(영어·비영어 모두 fail-safe), 버전 비교, claude --version 해석,
// GitHub·npm 응답, 캐시 검증, 순차 실행기(순서·실패 후 계속·중지·중복 실행 금지).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { UpdateRunDto, UpdateStepId } from '../../src/shared/api';
import {
  compareVersions, httpFailReason, isNetworkFail, judge, normalizeVersion, offlineDowngrade, parseClaudeVersion, parseGithubLatest, parseNpmLatest, parseWingetList,
  WINGET_NO_APPLICATIONS_FOUND, withTimeout,
} from '../../src/main/update/check';
import { orderSteps, settleAfterAbort, UpdateRunner } from '../../src/main/update/runner';
import { CACHE_TTL_MS, parseCache, UpdateService, type UpdateDeps } from '../../src/main/update/service';

vi.mock('../../src/main/logger', () => ({ log: () => undefined, errMsg: (e: unknown) => String(e) }));

const PSMUX = 'marlocarlo.psmux';
const PWSH = 'Microsoft.PowerShell';
/** winget이 출력 앞에 내는 진행 표시(\r로 같은 줄을 덮어씀). */
const SPIN = '   - \r   \\ \r   | \r                                                                                                                        \r';

describe('winget list 해석', () => {
  it('영어: 행 [버전, winget] = 최신, [버전, 더 높은 버전, winget] = 업데이트 가능', () => {
    const latest = `${SPIN}Name  Id               Version Source\r\n--------------------------------------\r\npsmux marlocarlo.psmux 3.4.0   winget\r\n`;
    expect(parseWingetList(latest, 0, PSMUX)).toEqual({ installed: '3.4.0', latest: '3.4.0', status: 'latest' });
    const avail = 'Name       Id                   Version Available Source\n-----------------------------------------------------------\nPowerShell Microsoft.PowerShell 7.5.4.0 7.6.9.0   winget\n';
    expect(parseWingetList(avail, 0, PWSH)).toEqual({ installed: '7.5.4.0', latest: '7.6.9.0', status: 'available' });
  });

  it('비영어(한국어 실측·일본어): 머리글·안내 문장과 무관하게 Id 행 토큰만으로 판단', () => {
    // 이 PC(한국어 Windows)의 실제 출력 모양
    const ko = `${SPIN}이름  ID          버전  원본\r\n------------------------------------\r\npsmux marlocarlo.psmux 3.4.0 winget\r\n`;
    expect(parseWingetList(ko, 0, PSMUX).status).toBe('latest');
    const ja = '名前       ID                   バージョン 利用可能 ソース\r\n----------------------------------------\r\nPowerShell Microsoft.PowerShell 7.5.4.0    7.6.9.0  winget\r\n';
    expect(parseWingetList(ja, 0, PWSH)).toMatchObject({ status: 'available', latest: '7.6.9.0' });
  });

  it('비영어 안내 문장만 있고 행이 없으면 종료 코드 0이어도 확인 실패(최신 아님)', () => {
    const koNoRow = '사용 가능한 업그레이드를 찾을 수 없습니다.\r\n구성된 원본에서 사용할 수 있는 최신 패키지 버전이 없습니다.\r\n';
    expect(parseWingetList(koNoRow, 0, PSMUX)).toEqual({ installed: null, latest: null, status: 'failed', reason: 'unexpected' });
    const deNoRow = 'Es wurde kein installiertes Paket gefunden, das den Eingabekriterien entspricht.\r\n';
    expect(parseWingetList(deNoRow, 0, PSMUX).status).toBe('failed');
  });

  it('미설치: NO_APPLICATIONS_FOUND(양수·음수 표현 모두)', () => {
    const text = '입력 조건과 일치하는 설치된 패키지를 찾을 수 없습니다.\r\n';
    expect(parseWingetList(text, WINGET_NO_APPLICATIONS_FOUND, PSMUX).status).toBe('notInstalled');
    expect(parseWingetList(text, WINGET_NO_APPLICATIONS_FOUND | 0, PSMUX).status).toBe('notInstalled'); // -1978335212
  });

  it('fail-safe: 원본 없음·msstore·Unknown·"< 7.0"·잘린 Id·행 여럿·낮은 Available·다른 종료 코드·실행 실패는 모두 확인 실패', () => {
    const hdr = 'Name Id Version Available Source\r\n----\r\n';
    const cases: [string, number | null][] = [
      [`${hdr}psmux marlocarlo.psmux 3.4.0\r\n`, 0], // 원본 없음(winget 밖에서 설치) → 새 버전 유무를 모름
      [`${hdr}PowerShell Microsoft.PowerShell 7.6.9.0 msstore\r\n`, 0],
      [`${hdr}psmux marlocarlo.psmux Unknown winget\r\n`, 0],
      [`${hdr}PowerShell Microsoft.PowerShell < 7.0 winget\r\n`, 0],
      [`${hdr}psmux marlocarlo.ps… 3.4.0 winget\r\n`, 0],
      [`${hdr}psmux marlocarlo.psmux 3.4.0 winget\r\npsmux marlocarlo.psmux 3.3.0 winget\r\n`, 0],
      [`${hdr}psmux marlocarlo.psmux 3.4.0 3.4.0 winget\r\n`, 0],
      [`${hdr}psmux marlocarlo.psmux 3.4.0 3.3.9 winget\r\n`, 0],
      [`${hdr}psmux marlocarlo.psmux 3.4.0 winget\r\n`, 0x8a15002b],
      [`${hdr}psmux marlocarlo.psmux 3.4.0 winget\r\n`, 1],
      ['', null],
    ];
    for (const [out, code] of cases) {
      const r = parseWingetList(out, code, out.includes('PowerShell') ? PWSH : PSMUX);
      expect(r.status, JSON.stringify(out)).toBe('failed');
    }
    // 설치 버전을 읽었으면 실패여도 표시
    expect(parseWingetList(`${hdr}psmux marlocarlo.psmux 3.4.0\r\n`, 0, PSMUX).installed).toBe('3.4.0');
  });

  it('Id는 정확히(다른 Id의 접두어·부분 일치 행은 무시)', () => {
    const out = 'Name Id Version Source\r\n----\r\npsmux-x marlocarlo.psmuxPlus 9.9.9 winget\r\n';
    expect(parseWingetList(out, 0, PSMUX).status).toBe('failed');
  });
});

describe('오프라인 보정(winget 캐시 색인)', () => {
  const latest = { installed: '3.4.0', latest: '3.4.0', status: 'latest' as const };
  const avail = { installed: '7.5.4.0', latest: '7.6.9.0', status: 'available' as const };

  it('npm·GitHub가 둘 다 네트워크 계열로 실패하면 winget의 최신·업데이트 가능을 확인 실패(network)로, 설치 버전은 유지', () => {
    for (const [g, n] of [['network', 'network'], ['timeout', 'network'], ['network', 'timeout'], ['timeout', 'timeout']] as const) {
      expect(offlineDowngrade(latest, g, n)).toEqual({ installed: '3.4.0', latest: null, status: 'failed', reason: 'network' });
      expect(offlineDowngrade(avail, g, n)).toMatchObject({ status: 'failed', reason: 'network', installed: '7.5.4.0' });
    }
  });

  it('하나라도 성공했거나 서버가 응답한 실패(rate limit·형식 오류)면 winget 결과 그대로', () => {
    for (const [g, n] of [[null, 'network'], ['network', null], [null, null], ['rateLimited', 'network'], ['network', 'unexpected']] as const) {
      expect(offlineDowngrade(latest, g, n)).toBe(latest);
    }
  });

  it('미설치·이미 실패인 결과는 바꾸지 않는다', () => {
    const notInstalled = { installed: null, latest: null, status: 'notInstalled' as const };
    const missing = { installed: null, latest: null, status: 'failed' as const, reason: 'wingetMissing' as const };
    expect(offlineDowngrade(notInstalled, 'network', 'network')).toBe(notInstalled);
    expect(offlineDowngrade(missing, 'network', 'network')).toBe(missing);
    expect(isNetworkFail('rateLimited')).toBe(false);
    expect(isNetworkFail(null)).toBe(false);
  });
});

describe('버전 비교', () => {
  it('숫자 마디·앞의 v·빠진 마디는 0', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('7.6.9', '7.6.9.0')).toBe(0);
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('2.0.0+build.5', '2.0.0')).toBe(0);
  });

  it('prerelease는 정식보다 낮고, 마디별로 비교', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-2', '1.0.0-alpha')).toBeLessThan(0); // 숫자 마디 < 문자 마디
  });

  it('형식이 맞지 않으면 null', () => {
    for (const bad of ['', 'latest', '1.x', 'Unknown', '< 7.0', '1..2', '1.2.3.4.5.6']) expect(compareVersions(bad, '1.0.0'), bad).toBeNull();
    expect(normalizeVersion(' v3.4.0 ')).toBe('3.4.0');
    expect(normalizeVersion(123)).toBeNull();
  });

  it('judge: 최신이 더 높을 때만 업데이트 가능, 비교 불가는 실패', () => {
    expect(judge('1.0.0', '1.1.0').status).toBe('available');
    expect(judge('1.1.0', '1.1.0').status).toBe('latest');
    expect(judge('1.2.0', '1.1.0').status).toBe('latest'); // 개발 빌드가 더 새 버전
    expect(judge(null, '1.1.0')).toEqual({ installed: null, latest: '1.1.0', status: 'notInstalled' });
    expect(judge('1.0.0', null).status).toBe('failed');
    expect(judge('1.0.0', 'nope').status).toBe('failed');
  });
});

describe('claude --version·npm·GitHub 응답', () => {
  it('claude --version 첫 줄의 버전', () => {
    expect(parseClaudeVersion('2.1.317 (Claude Code)\n')).toBe('2.1.317');
    expect(parseClaudeVersion('\r\n2.1.317 (Claude Code)\r\n')).toBe('2.1.317');
    expect(parseClaudeVersion('2.2.0-beta.1 (Claude Code)')).toBe('2.2.0-beta.1');
    for (const bad of ['', 'claude: command not found', '2.1 (Claude Code)', 'Claude Code 2.1.317', 'x2.1.317']) expect(parseClaudeVersion(bad), bad).toBeNull();
  });

  it('npm latest의 version, GitHub latest의 tag_name(v 제거, draft·prerelease 무시)', () => {
    expect(parseNpmLatest({ name: '@anthropic-ai/claude-code', version: '2.1.317' })).toBe('2.1.317');
    expect(parseNpmLatest({ version: 2 })).toBeNull();
    expect(parseNpmLatest(null)).toBeNull();
    expect(parseGithubLatest({ tag_name: 'v1.2.0', draft: false, prerelease: false })).toBe('1.2.0');
    expect(parseGithubLatest({ tag_name: 'v1.3.0-rc.1', prerelease: true })).toBeNull();
    expect(parseGithubLatest({ tag_name: 'v1.3.0', draft: true })).toBeNull();
    expect(parseGithubLatest({ tag_name: 'release-one' })).toBeNull();
    expect(parseGithubLatest('v1.0.0')).toBeNull();
  });

  it('HTTP 403·429는 rate limit, 그 밖은 network', () => {
    expect(httpFailReason(403)).toBe('rateLimited');
    expect(httpFailReason(429)).toBe('rateLimited');
    expect(httpFailReason(404)).toBe('network');
    expect(httpFailReason(500)).toBe('network');
  });

  it('withTimeout: 늦으면 timeout 결과, 빠르면 원래 결과', async () => {
    vi.useFakeTimers();
    try {
      const slow = withTimeout(new Promise<string>(() => undefined), 30_000, () => 'timeout');
      vi.advanceTimersByTime(30_000);
      await expect(slow).resolves.toBe('timeout');
      await expect(withTimeout(Promise.resolve('ok'), 30_000, () => 'timeout')).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('캐시 검증', () => {
  const rows = [
    { id: 'app', installed: '1.0.0', latest: '1.1.0', status: 'available' },
    { id: 'pwsh', installed: '7.6.9.0', latest: '7.6.9.0', status: 'latest' },
    { id: 'psmux', installed: null, latest: null, status: 'failed', reason: 'wingetMissing' },
    { id: 'claude', installed: null, latest: '2.1.317', status: 'notInstalled' },
  ];
  const now = 1_800_000_000_000;

  it('24시간 안·같은 앱 버전이면 행 순서대로 읽는다', () => {
    const c = parseCache({ v: 1, checkedAt: now - 1000, appVersion: '1.0.0', rows: [...rows].reverse() }, '1.0.0', now);
    expect(c?.rows.map((r) => r.id)).toEqual(['app', 'pwsh', 'psmux', 'claude']);
    expect(c?.rows[2].reason).toBe('wingetMissing');
  });

  it('만료·다른 앱 버전·미래 시각·잘못된 행은 버린다', () => {
    expect(parseCache({ v: 1, checkedAt: now - CACHE_TTL_MS, appVersion: '1.0.0', rows }, '1.0.0', now)).toBeNull();
    expect(parseCache({ v: 1, checkedAt: now - 1000, appVersion: '0.9.0', rows }, '1.0.0', now)).toBeNull();
    expect(parseCache({ v: 1, checkedAt: now + 60_000, appVersion: '1.0.0', rows }, '1.0.0', now)).toBeNull();
    expect(parseCache({ v: 1, checkedAt: now, appVersion: '1.0.0', rows: rows.slice(1) }, '1.0.0', now)).toBeNull();
    expect(parseCache({ v: 1, checkedAt: now, appVersion: '1.0.0', rows: [{ ...rows[0], status: 'checking' }, ...rows.slice(1)] }, '1.0.0', now)).toBeNull();
    expect(parseCache({ v: 1, checkedAt: now, appVersion: '1.0.0', rows: [{ ...rows[0], reason: 'oops' }, ...rows.slice(1)] }, '1.0.0', now)).toBeNull();
    expect(parseCache('x', '1.0.0', now)).toBeNull();
  });
});

describe('순차 실행기', () => {
  /** 단계별 종료 코드를 정해 둔 가짜 실행. 실행 순서와 동시 실행 수를 기록한다. */
  function fakeExec(codes: Partial<Record<UpdateStepId, number | null | 'throw'>>) {
    const order: UpdateStepId[] = [];
    let active = 0;
    let maxActive = 0;
    const exec = async (step: UpdateStepId): Promise<number | null> => {
      order.push(step);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      const c = codes[step] ?? 0;
      if (c === 'throw') throw new Error('spawn failed');
      return c;
    };
    return { exec, order, max: () => maxActive };
  }

  it('orderSteps: 고정 순서(claude → psmux → pwsh), 중복·알 수 없는 값 제거', () => {
    expect(orderSteps(['pwsh', 'claude', 'psmux', 'claude', 'app', 'x'])).toEqual(['claude', 'psmux', 'pwsh']);
  });

  it('체크 순서와 무관하게 고정 순서로 한 번에 하나씩, 실패해도 계속하고 요약에 반영', async () => {
    const f = fakeExec({ psmux: 1, pwsh: 'throw' });
    const states: UpdateRunDto[] = [];
    const runner = new UpdateRunner(f.exec, (s) => states.push(s));
    const done = runner.start(['pwsh', 'psmux', 'claude']);
    expect(done).not.toBeNull();
    expect(runner.running).toBe(true);
    const end = await done!;
    expect(f.order).toEqual(['claude', 'psmux', 'pwsh']);
    expect(f.max()).toBe(1);
    expect(end).toMatchObject({ status: 'done', ok: 1, fail: 2 });
    expect(end.steps.map((s) => s.status)).toEqual(['ok', 'failed', 'failed']);
    expect(runner.running).toBe(false);
    // 단계가 시작될 때마다 상태를 보낸다(카드의 k/n 표시)
    expect(states.some((s) => s.steps[1].status === 'running' && s.steps[0].status === 'ok')).toBe(true);
  });

  it('실행 중 두 번째 시작은 거부, 단계가 없으면 시작하지 않음', async () => {
    const f = fakeExec({});
    const runner = new UpdateRunner(f.exec, () => undefined);
    expect(runner.start([])).toBeNull();
    const first = runner.start(['claude']);
    expect(runner.start(['psmux'])).toBeNull();
    await first;
    expect(f.order).toEqual(['claude']);
    expect(runner.start(['psmux'])).not.toBeNull(); // 끝난 뒤에는 다시 시작 가능
  });

  it('중지: 현재 단계는 실패(신호로 종료), 남은 단계는 건너뛰고, 완료된 단계는 유지', async () => {
    const order: UpdateStepId[] = [];
    const exec = (step: UpdateStepId, signal: AbortSignal): Promise<number | null> => {
      order.push(step);
      if (step === 'claude') return Promise.resolve(0);
      // 프로세스가 중지 신호로 끝나는 모양: 종료 코드 없이 돌아온다
      return new Promise((res) => signal.addEventListener('abort', () => res(null), { once: true }));
    };
    const runner = new UpdateRunner(exec, () => undefined);
    const done = runner.start(['claude', 'psmux', 'pwsh'])!;
    await vi.waitFor(() => expect(order).toEqual(['claude', 'psmux']));
    runner.stop();
    const end = await done;
    expect(order).toEqual(['claude', 'psmux']);
    expect(end.status).toBe('stopped');
    expect(end.steps.map((s) => s.status)).toEqual(['ok', 'failed', 'skipped']);
    expect(end).toMatchObject({ ok: 1, fail: 1 });
  });

  it('중지 신호 뒤에 종료 코드 0으로 끝나도 성공으로 세지 않는다', async () => {
    let stop!: () => void;
    const exec = (_s: UpdateStepId, signal: AbortSignal): Promise<number | null> =>
      new Promise((res) => { signal.addEventListener('abort', () => res(0), { once: true }); stop(); });
    const runner = new UpdateRunner(exec, () => undefined);
    stop = () => runner.stop();
    const end = await runner.start(['claude'])!;
    expect(end.steps[0].status).toBe('failed');
    expect(end.status).toBe('stopped');
  });
});

describe('끝나지 않는 단계·세션 잠금 수명', () => {
  it('중지 뒤 끝나지 않는 단계(종료할 수 없는 설치 프로그램)도 정해진 시간 뒤 실패로 마무리', async () => {
    const order: UpdateStepId[] = [];
    const exec = (step: UpdateStepId): Promise<number | null> => {
      order.push(step);
      return new Promise(() => undefined); // 영원히 끝나지 않음
    };
    const runner = new UpdateRunner(exec, () => undefined, 20);
    const done = runner.start(['psmux', 'pwsh'])!;
    await vi.waitFor(() => expect(order).toEqual(['psmux']));
    runner.stop();
    const end = await done;
    expect(end.status).toBe('stopped');
    expect(end.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(runner.running).toBe(false);
  });

  it('settleAfterAbort: 신호 전에는 원래 결과를 기다리고, 예외는 null', async () => {
    const ac = new AbortController();
    await expect(settleAfterAbort(Promise.resolve(0), ac.signal, 10)).resolves.toBe(0);
    await expect(settleAfterAbort(Promise.reject(new Error('x')), ac.signal, 10)).resolves.toBeNull();
    ac.abort();
    await expect(settleAfterAbort(new Promise(() => undefined), ac.signal, 10)).resolves.toBeNull();
  });

  it('상태 알림(onState)이 예외를 던져도 실행은 끝까지 간다', async () => {
    const runner = new UpdateRunner(async () => 0, () => { throw new Error('send failed'); });
    const end = await runner.start(['claude', 'psmux'])!;
    expect(end).toMatchObject({ status: 'done', ok: 2, fail: 0 });
  });

  const tmp = mkdtempSync(join(tmpdir(), 'ctd-update-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  let seq = 0;
  /** psmux·Claude Code가 업데이트 가능인 캐시로 서비스를 만든다. 외부 호출 없음(winget·claude 없음, fetch는 실패). */
  function service(closeSessions: () => Promise<boolean>, extra: Partial<UpdateDeps> = {}): UpdateService {
    const cacheFile = join(tmp, `c${seq++}.json`);
    writeFileSync(cacheFile, JSON.stringify({ v: 1, checkedAt: Date.now() - 1000, appVersion: '1.0.0', rows: [
      { id: 'app', installed: '1.0.0', latest: '1.0.0', status: 'latest' },
      { id: 'pwsh', installed: '7.6.9.0', latest: '7.6.9.0', status: 'latest' },
      { id: 'psmux', installed: '3.3.0', latest: '3.4.0', status: 'available' },
      { id: 'claude', installed: '2.1.0', latest: '2.1.317', status: 'available' },
    ] }));
    const deps: UpdateDeps = {
      appVersion: '1.0.0', cacheFile, closeSessions,
      resolveClaude: async () => null, resolveWinget: async () => null,
      onState: () => undefined, onOutput: () => undefined,
      fetchImpl: (async () => { throw new TypeError('offline'); }) as typeof fetch,
      ...extra,
    };
    return new UpdateService(deps);
  }

  it('세션을 닫지 못하면 시작하지 않고 잠금을 푼다', async () => {
    const svc = service(async () => false);
    await expect(svc.start(['psmux'])).resolves.toEqual({ ok: false, error: 'closeFailed' });
    expect(svc.sessionsLocked).toBe(false);
    expect(svc.state().run).toBeNull();
  });

  it('closeSessions가 예외를 던져도 잠금을 푼다', async () => {
    const svc = service(async () => { throw new Error('boom'); });
    await expect(svc.start(['psmux'])).resolves.toEqual({ ok: false, error: 'closeFailed' });
    expect(svc.sessionsLocked).toBe(false);
  });

  it('psmux 단계: 실행 중에는 잠그고, 실행이 끝나면(실패여도) 잠금을 풀고 재확인한다', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    // 단계가 winget을 찾는 동안 멈춰 둔다(실행 중 상태를 관찰)
    const svc = service(async () => true, { resolveWinget: async () => { await gate; return null; } });
    await expect(svc.start(['psmux'])).resolves.toEqual({ ok: true });
    expect(svc.sessionsLocked).toBe(true);
    expect(svc.state().run?.status).toBe('running');
    open();
    await vi.waitFor(() => expect(svc.state().run?.status).toBe('done'));
    await vi.waitFor(() => expect(svc.state().checking).toBe(false));
    expect(svc.sessionsLocked).toBe(false);
    expect(svc.state().run).toMatchObject({ ok: 0, fail: 1 }); // winget 없음 → 실패
    // 재확인: winget 없음·claude 없음·오프라인(가짜 fetch) → 최신으로 표시하지 않는다
    expect(svc.state().rows.map((r) => `${r.id}:${r.status}${r.reason ? `/${r.reason}` : ''}`))
      .toEqual(['app:failed/network', 'pwsh:failed/wingetMissing', 'psmux:failed/wingetMissing', 'claude:notInstalled']);
  });

  it('세션 닫는 동안 starting = true(다시 연 앱 정보가 버튼을 막는 기준), 끝나면 false', async () => {
    let open!: (v: boolean) => void;
    const states: boolean[] = [];
    const svc = service(() => new Promise<boolean>((r) => { open = r; }), { onState: (st) => states.push(st.starting) });
    const p = svc.start(['psmux']);
    await vi.waitFor(() => expect(svc.state().starting).toBe(true));
    expect(states).toContain(true);
    await expect(svc.start(['claude'])).resolves.toEqual({ ok: false, error: 'busy' }); // 시작 처리 중 중복 시작 거부
    open(false);
    await expect(p).resolves.toEqual({ ok: false, error: 'closeFailed' });
    expect(svc.state().starting).toBe(false);
    expect(states[states.length - 1]).toBe(false);
  });

  it('shutdown(앱 종료): 실행 중이면 중지해 남은 단계를 실행하지 않는다, 실행 중이 아니면 아무것도 안 함', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const svc = service(async () => true, { resolveWinget: async () => { await gate; return null; } });
    await svc.shutdown(); // 실행 전: 아무 일 없음
    expect(svc.state().run).toBeNull();
    await svc.start(['claude', 'psmux']);
    await vi.waitFor(() => expect(svc.state().run?.steps[1].status).toBe('running'));
    expect(svc.running).toBe(true);
    await svc.shutdown();
    open();
    await vi.waitFor(() => expect(svc.state().run?.status).toBe('stopped'));
    expect(svc.sessionsLocked).toBe(false);
  });

  it('오프라인(fetch가 TypeError) + winget이 캐시 색인으로 깨끗한 "최신" 행: PowerShell 7·psmux는 확인 실패(network), 설치 버전 유지', async () => {
    const row = (id: string, v: string): string => `Name Id Version Source
----
X ${id} ${v} winget
`;
    const execWinget = vi.fn(async (_w: string, args: string[]) => ({ code: 0, out: args[2] === PWSH ? row(PWSH, '7.6.9.0') : row(PSMUX, '3.4.0'), timedOut: false }));
    const svc = service(async () => true, { resolveWinget: async () => 'C:\fake\winget.exe', execWinget });
    const st = await svc.check();
    expect(execWinget).toHaveBeenCalledTimes(2);
    const byId = Object.fromEntries(st.rows.map((r) => [r.id, r]));
    expect(byId.pwsh).toMatchObject({ status: 'failed', reason: 'network', installed: '7.6.9.0' });
    expect(byId.psmux).toMatchObject({ status: 'failed', reason: 'network', installed: '3.4.0' });
    expect(byId.app).toMatchObject({ status: 'failed', reason: 'network' });
  });

  it('온라인(조회 성공)이면 같은 winget 행은 최신 그대로', async () => {
    const row = (id: string, v: string): string => `Name Id Version Source
----
X ${id} ${v} winget
`;
    const execWinget = async (_w: string, args: string[]) => ({ code: 0, out: args[2] === PWSH ? row(PWSH, '7.6.9.0') : row(PSMUX, '3.4.0'), timedOut: false });
    const fetchImpl = (async (url: string) => new Response(JSON.stringify(String(url).includes('github') ? { tag_name: 'v1.0.0' } : { version: '2.1.317' }), { status: 200 })) as unknown as typeof fetch;
    const svc = service(async () => true, { resolveWinget: async () => 'C:\fake\winget.exe', execWinget, fetchImpl });
    const st = await svc.check();
    expect(st.rows.map((r) => `${r.id}:${r.status}`)).toEqual(['app:latest', 'pwsh:latest', 'psmux:latest', 'claude:notInstalled']);
  });

  it('Claude Code만이면 세션을 닫지 않고 잠그지도 않는다, 업데이트 가능이 아닌 단계는 거부', async () => {
    const close = vi.fn(async () => true);
    const svc = service(close);
    await expect(svc.start(['pwsh'])).resolves.toEqual({ ok: false, error: 'invalid' });
    await expect(svc.start(['claude'])).resolves.toEqual({ ok: true });
    expect(svc.sessionsLocked).toBe(false);
    expect(close).not.toHaveBeenCalled();
    await expect(svc.start(['psmux'])).resolves.toEqual({ ok: false, error: 'busy' }); // 실행 중 중복 시작
    await vi.waitFor(() => expect(svc.state().run?.status).toBe('done'));
  });
});
