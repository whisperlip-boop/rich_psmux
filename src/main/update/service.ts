// 업데이트 확인·실행 상태(main 단일 원본). 대화상자를 닫았다 열거나 렌더러를 새로 고쳐도 상태는 여기 남는다.
// 외부 호출은 npm registry(Claude Code 최신 버전)와 GitHub Releases(앱 최신 버전) 2건뿐, 버전 문자열만 읽는다(토큰·사용자 데이터 없음).
// 실행은 셸·psmux를 거치지 않는 직접 자식 프로세스(winget.exe·claude). psmux·pwsh는 교체 대상이라 그 안에서 돌리면 안 된다.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { UpdateFailReason, UpdateItemId, UpdateRowDto, UpdateRunDto, UpdateStartDto, UpdateStateDto, UpdateStepId } from '../../shared/api';
import { claudeInvocation, runClaude } from '../auth';
import { killProcessTree } from '../history/procKill';
import { errMsg, log } from '../logger';
import { cleanEnv } from '../psmux/env';
import { failed, httpFailReason, judge, offlineDowngrade, parseClaudeVersion, parseGithubLatest, parseNpmLatest, parseWingetList, withTimeout, type CheckResult } from './check';
import { ABORT_GRACE_MS, NEEDS_SESSION_CLOSE, orderSteps, UpdateRunner } from './runner';

/** 항목별 확인 시간 제한(D9). */
export const CHECK_TIMEOUT_MS = 30_000;
/** 캐시 유효 시간(D10). */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 단계 하나의 최대 실행 시간: 멈춘 설치 프로그램이 세션 잠금을 무한히 잡지 않게(넘으면 그 단계만 실패, 다음 단계로). */
export const STEP_TIMEOUT_MS = 30 * 60 * 1000;
/** 프로세스가 끝난(exit) 뒤 파이프에 남은 출력을 기다리는 시간. 파이프를 물려받은 자식이 남으면 close가 오지 않는다. */
const PIPE_GRACE_MS = 1000;
/** 표 행 순서(고정). */
export const ROW_ORDER: readonly UpdateItemId[] = ['app', 'pwsh', 'psmux', 'claude'];

/** 이 앱 저장소(README의 Releases 링크와 같음). 릴리스 페이지는 응답의 URL이 아니라 이 고정 주소로 연다. */
const GITHUB_REPO = 'whisperlip-boop/rich_psmux';
export const RELEASE_PAGE_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const GITHUB_LATEST_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const NPM_CLAUDE_LATEST = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
/** 응답 본문 상한(버전 문자열만 필요). */
const MAX_BODY_CHARS = 2 * 1024 * 1024;

/** winget 패키지 Id. */
const WINGET_ID: Record<'pwsh' | 'psmux', string> = { pwsh: 'Microsoft.PowerShell', psmux: 'marlocarlo.psmux' };
/** winget 공통 인자: 대화형 입력 금지 + 원본 약관 자동 동의(첫 실행 때 묻는 창 대신). */
const WINGET_COMMON = ['--exact', '--disable-interactivity', '--accept-source-agreements'];

/** 바깥(Electron 기능·앱 상태)에서 받는 것. */
export interface UpdateDeps {
  appVersion: string;
  cacheFile: string;
  resolveClaude: () => Promise<string | null>;
  resolveWinget: () => Promise<string | null>;
  /** 열린 psmux 세션을 모두 닫고 서버를 멈춘다. 다 닫혔으면 true. */
  closeSessions: () => Promise<boolean>;
  onState: (s: UpdateStateDto) => void;
  onOutput: (data: Uint8Array) => void;
  /** 테스트 주입용(기본: 전역 fetch). */
  fetchImpl?: typeof fetch;
  /** 테스트 주입용: winget 1회 실행(기본: 셸 없이 직접 실행, 30초 제한). */
  execWinget?: (winget: string, args: string[]) => Promise<{ code: number | null; out: string; timedOut: boolean }>;
}

/** 캐시 파일 형식. */
interface CacheFile {
  v: 1;
  checkedAt: number;
  appVersion: string;
  rows: UpdateRowDto[];
}

const STATUSES = new Set(['latest', 'available', 'notInstalled', 'failed']);
const REASONS = new Set(['timeout', 'network', 'rateLimited', 'wingetMissing', 'unexpected']);
const strOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length <= 64);

/** 캐시 행 검증(파일 내용은 신뢰하지 않는다). 하나라도 맞지 않으면 null. */
export function parseCache(raw: unknown, appVersion: string, now: number): CacheFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.checkedAt !== 'number' || o.appVersion !== appVersion || !Array.isArray(o.rows)) return null;
  if (!(o.checkedAt <= now && now - o.checkedAt < CACHE_TTL_MS)) return null;
  const rows: UpdateRowDto[] = [];
  for (const id of ROW_ORDER) {
    const r = (o.rows as unknown[]).find((x) => !!x && typeof x === 'object' && (x as Record<string, unknown>).id === id) as Record<string, unknown> | undefined;
    if (!r || !STATUSES.has(r.status as string) || !strOrNull(r.installed) || !strOrNull(r.latest)) return null;
    if (r.reason !== undefined && !REASONS.has(r.reason as string)) return null;
    rows.push({ id, installed: r.installed, latest: r.latest, status: r.status as UpdateRowDto['status'], ...(r.reason ? { reason: r.reason as UpdateFailReason } : {}) });
  }
  return { v: 1, checkedAt: o.checkedAt, appVersion, rows };
}

/** 업데이트 확인·실행 서비스. */
export class UpdateService {
  private rows: UpdateRowDto[];
  private checkedAt: number | null = null;
  private checking: Promise<UpdateStateDto> | null = null;
  private claudeUpdated = false;
  private startupAvailable: number | null = null;
  /** 세션을 닫는 중이거나 psmux·pwsh 단계가 있는 실행 중: psmux를 실행하는 기능(새 세션·목록 조회 등)을 막는다. */
  private lockSessions = false;
  /** 시작 처리(세션 닫기) 중: 두 번째 시작을 거부한다. */
  private starting = false;
  /** 지금 실행 중인 단계 프로세스 pid(앱 종료 시 정리용). */
  private currentPid: number | null = null;
  private readonly runner: UpdateRunner;

  constructor(private readonly deps: UpdateDeps) {
    this.rows = ROW_ORDER.map((id) => ({ id, installed: id === 'app' ? deps.appVersion : null, latest: null, status: 'unknown' }));
    this.runner = new UpdateRunner((step, signal) => this.execStep(step, signal), () => this.emit());
    const cache = this.readCache();
    if (cache) {
      this.rows = cache.rows;
      this.checkedAt = cache.checkedAt;
    }
  }

  /** 단계를 실행 중인지(앱 종료 시 정리 대상). */
  get running(): boolean {
    return this.runner.running;
  }

  /**
   * 앱 종료 전 정리: 실행을 중지하고 현재 단계 프로세스 트리를 끝낸다(중지와 같은 taskkill /T /F, 기다림은 최대 ABORT_GRACE_MS).
   * 끝내지 못해도(UAC로 권한이 올라간 설치 프로그램 등) 종료를 막지 않는다.
   */
  async shutdown(): Promise<void> {
    if (!this.runner.running) return;
    const pid = this.currentPid;
    this.runner.stop();
    if (!pid) return;
    const ok = await withTimeout(killProcessTree(pid), ABORT_GRACE_MS, () => false);
    log(ok ? 'info' : 'warn', `update: process ${pid} ${ok ? 'ended' : 'could not be ended'} on app quit`);
  }

  /** psmux를 실행하면 안 되는 동안(세션 닫기·psmux/pwsh 교체 중)인지. */
  get sessionsLocked(): boolean {
    return this.lockSessions;
  }

  /** 현재 상태. */
  state(): UpdateStateDto {
    return {
      rows: this.rows.map((r) => ({ ...r })), checking: this.checking !== null, starting: this.starting, checkedAt: this.checkedAt,
      run: this.runner.state(), claudeUpdated: this.claudeUpdated, startupAvailable: this.startupAvailable,
    };
  }

  /**
   * 앱 시작 시: 설정이 켜져 있을 때만. 24시간 안의 캐시가 있으면 재조회 없이 그 결과, 없으면 백그라운드 확인.
   * 결과(업데이트 가능 수)는 배너 기준으로 상태에 넣는다. 실패는 로그만.
   */
  startup(enabled: boolean): void {
    if (!enabled) return;
    if (this.checkedAt !== null) {
      this.startupAvailable = this.countAvailable();
      log('info', `update: startup uses cache (${new Date(this.checkedAt).toISOString()}), available=${this.startupAvailable}`);
      this.emit();
      return;
    }
    void this.check().then(() => {
      this.startupAvailable = this.countAvailable();
      this.emit();
    }).catch((e: unknown) => log('warn', `update: startup check failed: ${errMsg(e)}`));
  }

  /** 4개 항목 병렬 확인(캐시 무시). 진행 중이면 같은 확인을 기다린다. 실행 중에도 확인은 허용하지 않는다(버튼 비활성과 같게). */
  check(): Promise<UpdateStateDto> {
    if (this.checking) return this.checking;
    if (this.runner.running || this.starting) return Promise.resolve(this.state());
    for (const r of this.rows) r.status = 'checking';
    const work = (async (): Promise<UpdateStateDto> => {
      // 외부 조회 2건은 한 번씩만 보내고 결과를 공유한다(winget 행의 오프라인 보정에도 쓴다)
      const github = fetchJson(GITHUB_LATEST_API, { Accept: 'application/vnd.github+json' }, this.deps.fetchImpl);
      const npm = fetchJson(NPM_CLAUDE_LATEST, { Accept: 'application/json' }, this.deps.fetchImpl);
      const failOf = (x: FetchResult): UpdateFailReason | null => ('fail' in x ? x.fail : null);
      // winget은 네트워크가 끊겨도 캐시된 원본 색인으로 종료 코드 0을 낼 수 있다 → 두 조회가 모두 네트워크 실패면 믿지 않는다
      const wingetJob = async (id: 'pwsh' | 'psmux'): Promise<CheckResult> => {
        const r = await this.checkWinget(id);
        const [g, n] = await Promise.all([github, npm]);
        const out = offlineDowngrade(r, failOf(g), failOf(n));
        if (out !== r) log('warn', `update check ${id}: npm and GitHub both unreachable; winget result (${r.status}) not trusted`);
        return out;
      };
      const jobs: Record<UpdateItemId, () => Promise<CheckResult>> = {
        app: () => this.checkApp(github), pwsh: () => wingetJob('pwsh'), psmux: () => wingetJob('psmux'), claude: () => this.checkClaude(npm),
      };
      await Promise.all(ROW_ORDER.map(async (id) => {
        let r: CheckResult;
        try {
          r = await withTimeout(jobs[id](), CHECK_TIMEOUT_MS, () => failed('timeout'));
        } catch (e) {
          log('warn', `update check ${id} threw: ${errMsg(e)}`);
          r = failed('unexpected');
        }
        // 앱 설치 버전은 항상 안다(실패해도 표시)
        if (id === 'app' && r.installed === null) r = { ...r, installed: this.deps.appVersion };
        log('info', `update check ${id}: ${r.status}${r.reason ? ` (${r.reason})` : ''} installed=${r.installed ?? '-'} latest=${r.latest ?? '-'}`);
        const i = this.rows.findIndex((x) => x.id === id);
        this.rows[i] = { id, installed: r.installed, latest: r.latest, status: r.status, ...(r.reason ? { reason: r.reason } : {}) };
        this.emit();
      }));
      this.checkedAt = Date.now();
      this.writeCache();
      return this.state();
    })().finally(() => {
      this.checking = null;
      this.emit();
    });
    this.checking = work;
    this.emit();
    return work;
  }

  /**
   * 체크한 단계 실행 시작. 단계는 main이 다시 검사한다(업데이트 가능인 행만). PowerShell 7·psmux가 있으면 먼저 모든 세션을 닫고,
   * 닫지 못하면 아무것도 실행하지 않는다. 실행은 기다리지 않는다(진행은 상태·출력 이벤트로).
   */
  async start(raw: unknown): Promise<UpdateStartDto> {
    if (this.runner.running || this.starting || this.checking) return { ok: false, error: 'busy' };
    const steps = orderSteps(Array.isArray(raw) ? raw : []);
    const ok = steps.length > 0 && steps.every((s) => this.rows.find((r) => r.id === s)?.status === 'available');
    if (!ok) {
      log('warn', `update start rejected: invalid steps ${JSON.stringify(raw).slice(0, 80)}`);
      return { ok: false, error: 'invalid' };
    }
    const needsClose = steps.some((s) => NEEDS_SESSION_CLOSE.has(s));
    this.starting = true;
    this.emit();
    try {
      if (needsClose) {
        this.lockSessions = true;
        let closed = false;
        try {
          closed = await this.deps.closeSessions();
        } catch (e) {
          log('error', `update: closing sessions threw: ${errMsg(e)}`);
        }
        if (!closed) {
          this.lockSessions = false;
          log('warn', 'update: sessions could not be closed; update not started');
          return { ok: false, error: 'closeFailed' };
        }
      }
      this.claudeUpdated = false;
      log('info', `update run start: ${steps.join(' → ')}`);
      const done = this.runner.start(steps);
      if (!done) {
        this.lockSessions = false;
        return { ok: false, error: 'busy' };
      }
      // 실행이 어떻게 끝나든(거부 포함) 세션 잠금을 푼다
      void done.then((run) => this.finish(run), (e: unknown) => {
        log('error', `update run failed: ${errMsg(e)}`);
        this.lockSessions = false;
        this.emit();
      });
      return { ok: true };
    } finally {
      this.starting = false;
      this.emit();
    }
  }

  /** 실행 중지. */
  stop(): void {
    if (!this.runner.running) return;
    log('info', 'update run: stop requested');
    this.runner.stop();
  }

  /** 실행이 끝났을 때: 요약 기록, 세션 잠금 해제, 재확인(업데이트 성공 후 해당 항목 재확인). */
  private finish(run: UpdateRunDto): void {
    this.lockSessions = false;
    this.claudeUpdated = run.steps.some((s) => s.id === 'claude' && s.status === 'ok');
    log('info', `update run ${run.status}: ok=${run.ok} fail=${run.fail} [${run.steps.map((s) => `${s.id}:${s.status}`).join(', ')}]`);
    this.emit();
    void this.check().catch((e: unknown) => log('warn', `update recheck failed: ${errMsg(e)}`));
  }

  private countAvailable(): number {
    return this.rows.filter((r) => r.status === 'available').length;
  }

  private emit(): void {
    try {
      this.deps.onState(this.state());
    } catch (e) {
      log('warn', `update state send failed: ${errMsg(e)}`);
    }
  }

  // --- 확인 ---

  private async checkApp(github: Promise<FetchResult>): Promise<CheckResult> {
    const r = await github;
    if ('fail' in r) return failed(r.fail, this.deps.appVersion);
    const latest = parseGithubLatest(r.body);
    return latest === null ? failed('unexpected', this.deps.appVersion) : judge(this.deps.appVersion, latest);
  }

  private async checkClaude(npm: Promise<FetchResult>): Promise<CheckResult> {
    const [installed, remote] = await Promise.all([this.claudeInstalled(), npm]);
    if (installed === 'failed') return failed('unexpected');
    const latest = 'fail' in remote ? null : parseNpmLatest(remote.body);
    // 미설치여도 최신 버전을 알면 보여 준다
    if (installed === null) return { installed: null, latest, status: 'notInstalled' };
    if ('fail' in remote) return failed(remote.fail, installed);
    return judge(installed, latest);
  }

  /** claude 설치 버전: 못 찾으면 null(미설치), 실행·해석 실패면 'failed'. */
  private async claudeInstalled(): Promise<string | null | 'failed'> {
    const cli = await this.deps.resolveClaude();
    if (!cli) return null;
    const r = await runClaude(cli, ['--version'], CHECK_TIMEOUT_MS);
    if (r.code !== 0) {
      log('warn', `update: claude --version failed (code ${r.code ?? r.reason})`);
      return 'failed';
    }
    return parseClaudeVersion(r.stdout) ?? 'failed';
  }

  private async checkWinget(id: 'pwsh' | 'psmux'): Promise<CheckResult> {
    const winget = await this.deps.resolveWinget();
    if (!winget) return failed('wingetMissing');
    const args = ['list', '--id', WINGET_ID[id], ...WINGET_COMMON];
    const r = await (this.deps.execWinget ? this.deps.execWinget(winget, args) : execText(winget, args, CHECK_TIMEOUT_MS));
    if (r.timedOut) return failed('timeout');
    const res = parseWingetList(r.out, r.code, WINGET_ID[id]);
    if (res.status === 'failed') log('warn', `update: winget list ${WINGET_ID[id]} not understood (code ${r.code === null ? 'null' : `0x${(r.code >>> 0).toString(16)}`})`);
    return res;
  }

  // --- 실행 ---

  private out(text: string): void {
    this.deps.onOutput(new TextEncoder().encode(text));
  }

  /** 단계 하나: 명령 줄을 카드에 먼저 보여 주고 stdout·stderr를 그대로 흘린다. 종료 코드를 돌려준다. */
  private async execStep(step: UpdateStepId, signal: AbortSignal): Promise<number | null> {
    let file: string;
    let args: string[];
    let verbatim = false;
    let display: string;
    if (step === 'claude') {
      const cli = await this.deps.resolveClaude();
      if (!cli) {
        this.out('\r\nclaude: not found\r\n');
        return null;
      }
      try {
        ({ file, args, verbatim } = claudeInvocation(cli, ['update']));
      } catch (e) {
        log('warn', `update: claude invocation rejected: ${errMsg(e)}`);
        return null;
      }
      display = 'claude update';
    } else {
      const winget = await this.deps.resolveWinget();
      if (!winget) {
        this.out('\r\nwinget: not found\r\n');
        return null;
      }
      file = winget;
      args = ['upgrade', '--id', WINGET_ID[step], ...WINGET_COMMON, '--accept-package-agreements'];
      display = `winget ${args.join(' ')}`;
    }
    if (signal.aborted) return null;
    this.out(`\r\n\x1b[1m> ${display}\x1b[0m\r\n\r\n`);
    log('info', `update step ${step}: ${display}`);
    // 단계 시간 제한은 이 단계만 끝낸다(실행 전체 중지 신호와 별개: 다음 단계는 계속)
    const stepTimeout = AbortSignal.timeout(STEP_TIMEOUT_MS);
    const code = await spawnStreaming(file, args, verbatim, AbortSignal.any([signal, stepTimeout]), (d) => this.deps.onOutput(d), (pid) => { this.currentPid = pid; });
    this.currentPid = null;
    if (stepTimeout.aborted) log('warn', `update step ${step} timed out after ${STEP_TIMEOUT_MS / 60000} min`);
    const shown = code === null ? 'none' : code === 0 ? '0' : `${code} (0x${(code >>> 0).toString(16).toUpperCase()})`;
    this.out(`\r\n[exit code ${shown}]\r\n`);
    log(code === 0 ? 'info' : 'warn', `update step ${step} exit=${shown}${signal.aborted ? ' (stopped)' : ''}`);
    return code;
  }

  // --- 캐시 ---

  private readCache(): CacheFile | null {
    try {
      const c = parseCache(JSON.parse(readFileSync(this.deps.cacheFile, 'utf8')), this.deps.appVersion, Date.now());
      if (!c) log('info', 'update cache ignored (expired, other app version or invalid)');
      return c;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log('warn', `update cache read failed: ${errMsg(e)}`);
      return null;
    }
  }

  private writeCache(): void {
    if (this.checkedAt === null) return;
    const data: CacheFile = { v: 1, checkedAt: this.checkedAt, appVersion: this.deps.appVersion, rows: this.rows };
    try {
      mkdirSync(dirname(this.deps.cacheFile), { recursive: true });
      const tmp = `${this.deps.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, this.deps.cacheFile);
    } catch (e) {
      log('warn', `update cache write failed: ${errMsg(e)}`);
    }
  }
}

/** 외부 조회 결과: 본문 또는 실패 사유. */
type FetchResult = { body: unknown } | { fail: UpdateFailReason };

/** GET 1회 → JSON. 실패는 사유만(본문·헤더는 기록하지 않음). 시간 제한은 호출부(항목별 30초)와 같게 건다. 예외를 던지지 않는다. */
async function fetchJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<FetchResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CHECK_TIMEOUT_MS);
  try {
    // GitHub API는 User-Agent가 없으면 거부한다. 일반 클라이언트 이름만 보낸다(사용자 정보 없음)
    const res = await fetchImpl(url, { headers: { ...headers, 'User-Agent': 'rich-psmux-update-check' }, signal: ac.signal, redirect: 'follow' });
    if (!res.ok) {
      log('warn', `update fetch ${new URL(url).host} HTTP ${res.status}`);
      return { fail: httpFailReason(res.status) };
    }
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) return { fail: 'unexpected' };
    return { body: JSON.parse(text) as unknown };
  } catch (e) {
    const name = e instanceof Error ? e.name : 'error';
    log('warn', `update fetch ${new URL(url).host} failed: ${name}`);
    if (name === 'AbortError' || name === 'TimeoutError') return { fail: 'timeout' };
    return { fail: name === 'SyntaxError' ? 'unexpected' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** 셸 없이 1회 실행해 stdout(UTF-8)·종료 코드를 받는다(예외 없음). */
function execText(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((res) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: cleanEnv() }, (err, stdout) => {
      if (!err) return res({ code: 0, out: stdout, timedOut: false });
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
      if (typeof e.code === 'number') return res({ code: e.code, out: stdout ?? '', timedOut: false });
      if (e.killed || e.signal) return res({ code: null, out: '', timedOut: true });
      log('warn', `update: ${file} could not run (${typeof e.code === 'string' ? e.code : 'error'})`);
      res({ code: null, out: '', timedOut: false });
    });
  });
}

/**
 * 자식 프로세스 실행 + 출력 전달. 중지 신호면 프로세스 트리를 끝낸다. 실행 자체를 못 하면 null.
 * close(프로세스 종료 + 파이프 닫힘)를 기다리되, 파이프를 물려받은 자식(설치 프로그램 등)이 남아 close가 오지 않을 수 있어
 * exit 뒤 잠시 기다려 마무리하고, 중지 뒤에는 종료 성공 여부와 무관하게 정해진 시간 안에 실패로 마무리한다(파이프도 끊음).
 */
function spawnStreaming(file: string, args: string[], verbatim: boolean, signal: AbortSignal, onData: (d: Uint8Array) => void, onPid: (pid: number | null) => void): Promise<number | null> {
  return new Promise((res) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, { windowsHide: true, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: verbatim });
      onPid(child.pid ?? null);
    } catch (e) {
      log('warn', `update: spawn failed: ${errMsg(e)}`);
      res(null);
      return;
    }
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      signal.removeEventListener('abort', onAbort);
      res(code);
    };
    const onAbort = (): void => {
      // taskkill /T /F: winget이 띄운 설치 프로그램까지. UAC로 권한이 올라간 설치 프로그램은 끝내지 못할 수 있다(로그로 남김)
      const pid = child.pid;
      void (pid ? killProcessTree(pid) : Promise.resolve(child.kill())).then((ok) => {
        if (!ok) log('warn', `update: could not end process ${pid ?? '-'}`);
      });
      // 끝나지 않은 프로세스를 기다리지 않는다: 잠시 뒤 파이프를 끊고 실패로 마무리
      timers.push(setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        done(null);
      }, ABORT_GRACE_MS));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => onData(new Uint8Array(d)));
    child.stderr?.on('data', (d: Buffer) => onData(new Uint8Array(d)));
    child.on('error', (e) => {
      log('warn', `update: process error: ${errMsg(e)}`);
      done(null);
    });
    child.on('exit', (code) => { timers.push(setTimeout(() => done(code), PIPE_GRACE_MS)); });
    child.on('close', (code) => done(code));
  });
}
