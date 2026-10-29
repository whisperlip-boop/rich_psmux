// 사용량 표시(F7-1) main 쪽: usage.json 감시(statusline 자동 갱신)와 ↻ 수동 갱신(GET /api/oauth/usage 1회),
// 기동·로그인 직후 자동 1회(같은 경로, 실패는 조용히). 이 조회가 앱의 유일한 API 호출이다(네트워크 미사용 원칙의 예외). OAuth access token은 fetchOauthUsage 한 함수의 지역변수로만 존재하며
// 반환값·로그·IPC·저장소·예외 메시지 어디에도 넣지 않는다. 토큰 갱신(refresh)·~/.claude 쓰기는 하지 않는다.

import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { msg, resolveMsg, type Msg } from '../shared/i18n';
import { parseOauthUsage, parseUsageRecord, type OauthUsage, type UsageDto } from '../shared/usage';
import { claudeHomeDir } from './claudeHome';
import { errMsg, log } from './logger';
import { writeUsageAtomic } from './usageFile';

/** 사용량 API 주소(Claude Code /usage와 같은 엔드포인트). */
export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** ↻ 요청 시간 제한(ms). */
export const USAGE_TIMEOUT_MS = 10000;

/**
 * ↻ 결과. error는 영역에 보일 현재 UI 언어 한 줄, message는 그 번역 전 문구(언어를 바꾸면 다시 번역, 없으면 error 그대로),
 * reason은 로그용 영어(상태 코드·원인만).
 */
export type FetchUsageResult = { ok: true; data: OauthUsage } | { ok: false; error: string; message?: Msg; reason: string };

/** fetchOauthUsage 옵션(테스트에서 가짜 파일·fetch·시각 주입). */
export interface FetchUsageOptions {
  credentialsFile?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  timeoutMs?: number;
  /** 바깥 취소(로그아웃): 켜지면 요청을 바로 끊고 reason 'aborted'로 실패한다. */
  signal?: AbortSignal;
}

const fail = (message: Msg, reason: string): FetchUsageResult => ({ ok: false, error: resolveMsg(message), message, reason });

/**
 * ~/.claude/.credentials.json의 OAuth access token으로 사용량을 1회 조회한다.
 * 파싱한 자격 증명 객체와 토큰은 이 함수 밖으로 나가지 않는다. 자격 증명 JSON 파싱 오류 메시지에는 원문 일부가 섞일 수 있어
 * 어떤 예외 메시지도 그대로 쓰지 않고 고정 문구로 바꾼다. expiresAt이 지났으면 호출하지 않는다(refresh 금지).
 *
 * Args:
 *   opts: 테스트용 주입값(기본: 실제 파일·전역 fetch·현재 시각·10초).
 *
 * Returns:
 *   성공이면 추출한 사용률, 실패면 안내 문구와 로그용 원인.
 */
export async function fetchOauthUsage(opts: FetchUsageOptions = {}): Promise<FetchUsageResult> {
  const file = opts.credentialsFile ?? join(claudeHomeDir(), '.credentials.json');
  const now = opts.now ?? Date.now();
  let token: string;
  try {
    const o = (JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> | null)?.claudeAiOauth as Record<string, unknown> | undefined;
    const t = o?.accessToken;
    // 헤더에 넣을 수 없는 문자가 있으면 fetch 예외가 나므로 미리 거른다(인쇄 가능한 ASCII만)
    if (typeof t !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(t)) return fail(msg('usage.credUnreadable'), 'credentials: no usable access token');
    if (typeof o?.expiresAt === 'number' && o.expiresAt <= now) return fail(msg('usage.tokenExpired'), 'credentials: token expired (not refreshed by design)');
    token = t;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return fail(msg('usage.credMissing'), 'credentials: file not found');
    return fail(msg('usage.credUnreadable'), `credentials: unreadable (${code ?? (e instanceof SyntaxError ? 'invalid json' : 'error')})`);
  }

  // 시간 제한과 바깥 취소(로그아웃)를 한 신호로 묶는다(본문 읽기까지 적용). 취소는 시간 초과와 구분해 'aborted'로 남긴다
  const timeoutMs = opts.timeoutMs ?? USAGE_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException('usage request timed out', 'TimeoutError')), timeoutMs);
  const onAbort = (): void => ac.abort(opts.signal?.reason);
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // 자격 증명을 읽는 사이 로그아웃됐으면 요청을 보내지 않는다
    if (opts.signal?.aborted) return fail(msg('usage.fetchFailed'), 'aborted');
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(OAUTH_USAGE_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
        signal: ac.signal,
        redirect: 'error',
      });
    } catch (e) {
      if (opts.signal?.aborted) return fail(msg('usage.fetchFailed'), 'aborted');
      const name = e instanceof Error ? e.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') return fail(msg('usage.timeout', { n: timeoutMs / 1000 }), 'network: timeout');
      const cause = (e as { cause?: { code?: unknown } }).cause?.code;
      return fail(msg('usage.network'), `network: ${typeof cause === 'string' ? cause : name || 'error'}`);
    }

    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      if (res.status === 401 || res.status === 403) return fail(msg('usage.auth', { status: String(res.status) }), `http ${res.status}`);
      if (res.status === 429) return fail(msg('usage.rateLimited'), 'http 429');
      return fail(msg('usage.http', { status: String(res.status) }), `http ${res.status}`);
    }
    let data: OauthUsage | null = null;
    try {
      data = parseOauthUsage(await res.json());
    } catch { /* 본문이 JSON이 아님(취소 포함) → 형식 변경으로 처리 */ }
    if (opts.signal?.aborted) return fail(msg('usage.fetchFailed'), 'aborted');
    // 본문을 읽는 중 시간 초과면 형식 오류가 아니라 시간 초과로 남긴다
    if (ac.signal.aborted) return fail(msg('usage.timeout', { n: timeoutMs / 1000 }), 'network: timeout');
    if (!data) return fail(msg('usage.badFormat'), 'unexpected response format');
    return { ok: true, data };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * usage.json을 감시해 표시 상태를 갱신하고, ↻ 요청을 처리한다. 상태가 바뀌면 'update'(UsageDto)를 낸다.
 * 파일은 rename으로 교체되므로 파일이 아니라 폴더를 감시하고 이름으로 거른다.
 */
export class UsageTracker extends EventEmitter {
  private state: UsageDto = { fiveHour: null, sevenDay: null, model: null, updatedAt: null, error: null };
  /** 마지막 ↻ 실패 안내(번역은 get()에서: 언어를 바꾸면 다음 get()부터 새 언어). state.error는 쓰지 않는다. */
  private errorMsg: Msg | string | null = null;
  /** 마지막으로 반영한 파일 레코드의 at(같거나 오래된 레코드는 무시). */
  private fileAt = 0;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<UsageDto> | null = null;
  /** 진행 중 요청이 자동(조용한) 갱신인지. 수동 ↻가 합류하면 false로 바꿔 실패 안내를 보인다. */
  private inflightSilent = false;
  /** clear()(로그아웃)마다 증가: 그 전에 시작해 뒤에 끝난 조회 결과는 버린다(자동·↻ 공통). */
  private generation = 0;
  /** 진행 중 요청이 시작된 세대. 로그아웃 뒤의 새 요청은 버려질 이전 요청에 합류하지 않는다. */
  private inflightGen = 0;
  /** 진행 중 요청의 취소 손잡이(로그아웃 때 끊음). */
  private abortCtl: AbortController | null = null;

  /**
   * Args:
   *   file: usage.json 절대 경로.
   *   fetcher: ↻ 조회 함수(테스트 주입용). 신호가 켜지면 요청을 끊어야 한다.
   */
  constructor(private readonly file: string, private readonly fetcher: (signal: AbortSignal) => Promise<FetchUsageResult> = (signal) => fetchOauthUsage({ signal })) {
    super();
  }


  /** 현재 표시 상태(복사본, 안내는 현재 UI 언어). */
  get(): UsageDto {
    return { ...this.state, error: this.errorMsg === null ? null : resolveMsg(this.errorMsg) };
  }

  /** 로그아웃(F7-2): 표시 값을 비우고(막대 "—") 진행 중 조회는 바로 끊는다. usage.json은 그대로 두고, 이후 더 새 기록이 오면 다시 표시한다. */
  clear(): void {
    this.state = { fiveHour: null, sevenDay: null, model: null, updatedAt: null, error: null };
    this.errorMsg = null;
    this.fileAt = Math.max(this.fileAt, Date.now());
    this.generation++;
    // 결과는 어차피 버리므로 네트워크 대기를 끝까지 하지 않는다(시간 초과 10초를 기다리지 않음)
    this.abortCtl?.abort();
    this.abortCtl = null;
    this.emit('update', this.get());
  }

  /** 저장된 마지막 값을 읽고 감시를 시작한다(앱 재시작 시 마지막 값·시각 그대로 표시). */
  async start(): Promise<void> {
    await this.reload();
    const name = basename(this.file);
    try {
      this.watcher = watch(dirname(this.file), { persistent: false }, (_ev, f) => {
        if (!f || f === name) this.schedule();
      });
      this.watcher.on('error', (e) => log('warn', `usage watch error: ${errMsg(e)}`));
    } catch (e) {
      log('warn', `usage watch failed: ${errMsg(e)}`);
    }
  }

  /** 감시 중지. */
  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    // statusline은 짧은 간격으로 여러 번 쓸 수 있어 묶어서 한 번 읽는다
    this.timer = setTimeout(() => { this.timer = null; void this.reload(); }, 250);
  }

  /** usage.json을 읽어 더 새 값이면 반영한다. */
  async reload(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log('warn', `usage file read failed: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
      return;
    }
    const rec = parseUsageRecord(raw);
    if (!rec) {
      log('warn', 'usage file has unexpected format; ignored');
      return;
    }
    // 받은 시각이 미래면(시계 조정 등) 지금으로 자른다: 그대로 두면 그 시각까지 이후 기록이 모두 무시된다(QA O-14)
    const at = Math.min(rec.at, Date.now());
    if (at <= this.fileAt) return;
    this.fileAt = at;
    // 새 값이 들어오면 이전 ↻ 실패 안내는 지운다(QA O-15)
    this.state = { ...this.state, fiveHour: rec.fiveHour, sevenDay: rec.sevenDay, updatedAt: Math.max(this.state.updatedAt ?? 0, at), error: null };
    this.errorMsg = null;
    this.emit('update', this.get());
  }

  /**
   * ↻: 진행 중이면 같은 요청을 기다린다(연타 방지). 성공하면 5시간·7일 값을 usage.json에도 남긴다(모델별 값은 메모리만).
   *
   * Args:
   *   opts: silent면 자동 갱신(기동·로그인 직후) — 실패해도 안내를 남기지 않고 로그 warn 1줄만.
   *     진행 중인 조용한 요청에 수동 ↻가 합류하면 그 요청은 수동으로 취급한다(실패 안내 표시).
   *
   * Returns:
   *   요청이 끝난 뒤의 표시 상태.
   */
  refresh(opts: { silent?: boolean } = {}): Promise<UsageDto> {
    if (this.inflight && this.inflightGen === this.generation) {
      if (!opts.silent) this.inflightSilent = false;
      return this.inflight;
    }
    // 로그아웃으로 버려질 이전 요청이 아직 끝나지 않았으면(끊는 중) 그 결과에 합류하지 않고 끝난 뒤 새로 조회한다
    const prev = this.inflight;
    const gen = this.generation;
    this.inflightSilent = !!opts.silent;
    this.inflightGen = gen;
    // 기다리는 사이 또 로그아웃됐으면(세대 변경) 조회를 보내지 않는다(비운 표시를 채우지 않게)
    const run = (): Promise<UsageDto> => (gen === this.generation ? this.doRefresh() : Promise.resolve(this.get()));
    const p: Promise<UsageDto> = (prev ? prev.then(run, run) : run())
      .finally(() => { if (this.inflight === p) this.inflight = null; });
    this.inflight = p;
    return p;
  }

  private async doRefresh(): Promise<UsageDto> {
    const generation = this.generation;
    const ac = new AbortController();
    this.abortCtl = ac;
    let r: FetchUsageResult;
    try {
      r = await this.fetcher(ac.signal);
    } catch (e) {
      // fetcher는 예외를 던지지 않게 만들었지만, 만약을 위해 메시지 없이 이름만 남긴다
      r = fail(msg('usage.fetchFailed'), `unexpected: ${e instanceof Error ? e.name : 'error'}`);
    } finally {
      if (this.abortCtl === ac) this.abortCtl = null;
    }
    if (generation !== this.generation) {
      // 조회 중 로그아웃: 비운 표시·usage.json을 이전 계정 값으로 다시 채우지 않는다
      log('info', `usage refresh result discarded (logged out during request, ${r.ok ? 'ok' : r.reason})`);
      return this.get();
    }
    if (!r.ok && this.inflightSilent) {
      // 자동 갱신 실패는 조용히: 표시 값·안내는 그대로(statusline 값 또는 "—"), 로그만
      log('warn', `usage auto refresh failed: ${r.reason}`);
    } else if (!r.ok) {
      log('warn', `usage refresh failed: ${r.reason}`);
      // 테스트용 가짜 fetcher처럼 번역 전 문구가 없으면 받은 문자열 그대로
      this.errorMsg = r.message ?? r.error;
    } else {
      const at = Date.now();
      log('info', `usage refresh ok (five_hour: ${r.data.fiveHour ? 'yes' : 'no'}, seven_day: ${r.data.sevenDay ? 'yes' : 'no'}, model: ${r.data.model ? 'yes' : 'no'})`);
      this.state = { fiveHour: r.data.fiveHour ?? this.state.fiveHour, sevenDay: r.data.sevenDay ?? this.state.sevenDay, model: r.data.model, updatedAt: at, error: null };
      this.errorMsg = null;
      // 자기 기록을 감시가 다시 읽어도 무시되게 먼저 올린다(기록이 실패해도 이보다 오래된 statusline 값은 필요 없음)
      this.fileAt = at;
      try {
        await writeUsageAtomic(this.file, { v: 1, at, fiveHour: this.state.fiveHour, sevenDay: this.state.sevenDay });
      } catch (e) {
        log('warn', `usage file write failed: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
      }
    }
    const d = this.get();
    // 조용한 실패는 표시가 바뀌지 않으므로 알리지 않는다
    if (r.ok || !this.inflightSilent) this.emit('update', d);
    return d;
  }
}

/**
 * 자동 1회 갱신(F7-1: 기동 직후·로그인 확인 직후). 로그인 상태가 확인된 경우에만 ↻와 같은 경로(tracker.refresh)로 조회하고,
 * 실패는 조용히 처리한다(안내 없음, 로그 warn 1줄). 예외를 던지지 않는다.
 *
 * Args:
 *   tracker: 사용량 상태(↻와 같은 진행 중 요청 공유).
 *   isLoggedIn: 로그인 상태 판정(계정 영역과 같은 기준: CLI 확인이 실패하면 이메일 유무). 이 함수가 예외를 던지면 호출하지 않는다.
 *   why: 로그용 계기(startup·login).
 *
 * Returns:
 *   조회를 실행했으면 true(성공 여부와 무관), 로그아웃·판정 실패로 건너뛰었으면 false.
 */
export async function autoRefreshUsage(tracker: Pick<UsageTracker, 'refresh'>, isLoggedIn: () => Promise<boolean>, why: string): Promise<boolean> {
  let loggedIn: boolean;
  try {
    loggedIn = await isLoggedIn();
  } catch (e) {
    log('warn', `usage auto refresh skipped (${why}): login check failed (${e instanceof Error ? e.name : 'error'})`);
    return false;
  }
  if (!loggedIn) {
    log('info', `usage auto refresh skipped (${why}): logged out`);
    return false;
  }
  // 결과 줄(ok·failed)에는 계기가 없고 ↻가 합류하면 ↻ 줄만 남으므로, 자동 시도마다 계기를 한 줄 남긴다(QA m-1)
  log('info', `usage auto refresh start (${why})`);
  try {
    await tracker.refresh({ silent: true });
  } catch (e) {
    // refresh는 예외를 던지지 않게 만들었지만, 기동 흐름을 막지 않도록 만약을 위해 이름만 남긴다
    log('warn', `usage auto refresh failed (${why}): unexpected ${e instanceof Error ? e.name : 'error'}`);
  }
  return true;
}
