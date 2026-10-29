// 탭 1개 = psmux 세션 1개의 수명 관리: 생성·연결·칸 추적(칸=창 분리)·크기 동기화·입력·재동기화·재연결.
// Electron에 의존하지 않는다(통합 테스트 스크립트에서도 그대로 사용).

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isPlainLeadCommand } from '../../shared/agents';
import { msg, resolveMsg, tr, type Msg } from '../../shared/i18n';
import { SESSION_ID_RE } from '../../shared/ids';
import { appendLeadId, readSessionMeta, removeSessionFiles, sessionFiles, writeSessionMeta } from '../appData';
import { findLeadSessionId, readTeamConfig } from '../claudeHome';
import { ControlClient, type CommandResult } from '../controlMode/client';
import { assertSafeToken, inputToCommands, splitSubmit, tokensToCommands, xtermDataToTokens } from '../controlMode/quote';
import { errMsg, log } from '../logger';
import { applyHookRecord, emptyHookState, parseHookLine, type HookState } from '../teams/hookState';
import { fallbackLabel, leadNameFromCommand, resolveLabels, teamNameFor, type PaneLabel, type TeamConfig } from '../teams/paneMapper';
import { hasSession, psmuxCli } from './cli';
import { cleanEnv, probeDir, unreachableMsg } from './env';
import { OutputBatcher } from './outputBatcher';
import { clampSize, diffPanes, LIST_PANES_FORMAT, multilineModeFor, panesToBreak, parseListPanes, shellMatches, shellOptionPath, type PaneInfo } from './panes';
import { makeSessionName } from './sessionName';

/** 탭 연결 상태. */
export type TabStatus = 'starting' | 'connected' | 'reconnecting' | 'ended' | 'error';

/** 탭 용도: 일반 대화 / 로그인 전용(F7-2). */
export type SessionPurpose = 'conversation' | 'login';

/** 렌더러로 보내는 칸 상태. */
export interface PaneView {
  paneId: string;
  windowId: string;
  cols: number;
  rows: number;
  label: PaneLabel;
  working: boolean;
  waiting: boolean;
}

/** 렌더러로 보내는 탭 상태. */
export interface TabState {
  tabId: string;
  session: string;
  folder: string;
  status: TabStatus;
  leadPaneId: string | null;
  /** 에이전트 없는 Claude만 탭(리드 명령이 `claude`뿐). 탭 툴팁·대화 재개 모드 기록용. */
  plain: boolean;
  teamName: string | null;
  panes: PaneView[];
  error?: string;
  hooksEnabled: boolean;
  /** 리드 칸에서 실행 중인 Claude Code 대화 ID(sessions/<pid>.json 기준, 모르면 null). */
  leadSessionId: string | null;
  /** -r 로 이어간 원래 대화 ID(새 대화면 null). */
  resumeSessionId: string | null;
  /** 리드 칸이 종료됨(세션은 살아 있음). 연결 끊김과 구분해 표시(M1 이월 M7). */
  leadGone: boolean;
  /** 종료 요청 처리 중. */
  terminating: boolean;
  createdAt: number;
  /** 탭 용도(F7-2 로그인 전용 탭이면 'login'). */
  purpose: SessionPurpose;
  /** 로그인 탭: 로그인 프로세스가 끝났는데 로그인이 확인되지 않음. */
  loginFailed: boolean;
}

/** 세션 생성 옵션. */
export interface SessionOptions {
  psmux: string;
  folder: string;
  leadCommand: string;
  dataDir: string;
  /** hook 실행 명령 앞부분(예: "C:/node.exe" "C:/app/hookRecorder.js"). null이면 hook 미사용. */
  hookCommand: string | null;
  /** 사용량 statusLine 전체 명령(F7-1, 예: "C:/node.exe" "C:/app/statusLine.js" "C:/data/usage.json"). 없으면 statusLine 미지정. */
  statusLineCommand?: string | null;
  /** 기존 세션에 붙을 때 이름(없으면 새로 만듦). 이때 folder·leadCommand는 메타 값을 넘긴다. */
  attachName?: string;
  /** 새 세션에서 이어갈 대화 ID(리드 명령 뒤에 -r <id>). */
  resumeSessionId?: string;
  /** 새 세션의 셸 실행 파일(설정 F8 pwsh 경로). 없으면 psmux 기본 셸. 세션 default-shell로 지정한다(applyShell). 리드 명령은 pwsh 문법으로 입력된다. */
  shell?: string | null;
  /** 탭 용도. 'login'이면 리드 명령이 claude auth login(hook·statusLine 없음). 기본 'conversation'. */
  purpose?: SessionPurpose;
}

/** 종료 요청 후 팀원 칸이 사라질 때까지 기다리는 최대 시간. */
const TERMINATE_WAIT_MS = 30000;
/** 카드 입력의 텍스트와 마지막 Enter(·End) 사이 간격: 작업 중인 Claude Code가 둘을 한 덩어리(붙여넣기)로 읽어 제출하지 않는 것 방지(2026-10-26 실기). */
const SUBMIT_DELAY_MS = 150;

const WORKING_WINDOW_MS = 2500;
const QUIET_AFTER_RESIZE_MS = 1500;
/** 재연결 뒤 재동기화 전 무출력 대기(이 시간 동안 출력이 없으면 캡처) / 최대 대기 / 두 번째 재동기화까지 시간(QA NEW-2). */
const RESYNC_QUIET_MS = 300;
const RESYNC_QUIET_MAX_MS = 2000;
const RESYNC_AGAIN_MS = 1500;
const POLL_MS = 2000;
const TEAM_POLL_MS = 1500;
/** 매핑이 확정된 뒤(리드 sessionId 확인 + 모든 칸 이름 확정)의 팀 config 확인 간격. */
const TEAM_POLL_SETTLED_MS = 10000;
/** 창 분리 실패 시 재시도 상한. */
const MAX_PANE_OP_ATTEMPTS = 3;
/** dead 칸 정리 실패 시 재시도 간격(QA BUG-2: 매 2초 무한 반복 방지). */
const DEAD_RETRY_MS = 30000;
const HOOK_POLL_MS = 700;

/** pwsh 작은따옴표 문자열. */
function pwshQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * psmux 세션 하나를 관리한다.
 * 이벤트: 'state'(TabState), 'output'(pane, Buffer), 'resync'(pane, string), 'size'(pane, cols, rows)
 */
export class TabSession extends EventEmitter {
  readonly tabId: string;
  readonly session: string;
  private client: ControlClient | null = null;
  private status: TabStatus = 'starting';
  /** 사용자 안내(번역은 state()에서: 언어를 바꾸면 다시 보낸 상태에 새 언어로 들어간다). */
  private error: Msg | undefined;
  private panes = new Map<string, PaneInfo>();
  private desired = new Map<string, { cols: number; rows: number }>();
  private labels: Record<string, PaneLabel> = {};
  private labelCache: Record<string, PaneLabel> = {};
  private leadPaneId: string | null = null;
  private leadSessionId: string | null = null;
  /** 리드에서 본 대화 ID 전부(본 순서, 메타 leadSessionIds와 같음). /clear 뒤에도 지난 대화를 알아보는 데 쓴다. */
  private leadSessionIds: string[] = [];
  private teamName: string | null = null;
  private teamConfig: TeamConfig | null = null;
  private lastOutput = new Map<string, number>();
  private quietUntil = new Map<string, number>();
  /** 칸별 마지막 출력 도착 시각(재동기화 전 무출력 대기용, quietUntil과 무관하게 항상 갱신). */
  private lastArrival = new Map<string, number>();
  /** 현재 연결이 준비된 시각(재연결 뒤 무출력 대기는 이 시각부터 센다). */
  private connectedAt = 0;
  /** 재연결 뒤 보정 재동기화 타이머(칸별). 다른 주기 타이머와 섞이지 않게 따로 관리한다. */
  private resyncAgainTimers = new Map<string, NodeJS.Timeout>();
  private working = new Set<string>();
  private hook: HookState = emptyHookState();
  private hookOffset = 0;
  // 순번(firstSeq·lastSeq)은 진단용 추가 인자(앱은 쓰지 않음, 통합 테스트가 재동기화 순서 추적에 사용)
  private readonly out = new OutputBatcher((pane, data, firstSeq, lastSeq) => this.emit('output', pane, data, firstSeq, lastSeq));
  private paneOpFailures = new Map<string, number>();
  private deadRetryAt = new Map<string, number>();
  private lastTeamPoll = 0;
  private timers: NodeJS.Timeout[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  /** 카드 입력(deliver) 순서 보장용 체인. */
  private inputQueue: Promise<unknown> = Promise.resolve();
  private refreshAgain = false;
  private closing = false;
  private reconnectDelay = 1000;
  /** 설정한 셸을 이 세션에 적용하지 못했을 때 사용자 안내(한국어). 적용됐거나 설정이 없으면 null. */
  shellWarning: Msg | null = null;

  /** 이 탭이 새로 만든 세션인지(기존 세션 연결이면 false). */
  get isNewSession(): boolean {
    return !this.opts.attachName;
  }
  private wakeReconnect: (() => void) | null = null;
  private readonly leadName: string;
  /** 에이전트 없는 Claude만 탭(▾ 메뉴). 재연결·복원 때는 메타의 leadCommand로 다시 판정된다. */
  readonly plain: boolean;
  private readonly cacheFile: string;
  private readonly hookSettingsFile: string;
  private readonly hookEventsFile: string;
  private readonly resumeSessionId: string | null;
  private createdAt = Date.now();
  private leadGone = false;
  private terminating = false;
  private loginFailed = false;
  private readonly purpose: SessionPurpose;

  constructor(private readonly opts: SessionOptions) {
    super();
    this.session = opts.attachName ?? makeSessionName(opts.folder, randomBytes(3).toString('hex'));
    assertSafeToken(this.session);
    this.tabId = this.session;
    // 리드 이름(@ceo)은 세션을 만들 때의 명령 기준(재연결·복원 때는 호출부가 메타의 leadCommand를 넘김)
    this.leadName = leadNameFromCommand(opts.leadCommand);
    this.plain = isPlainLeadCommand(opts.leadCommand);
    if (opts.resumeSessionId !== undefined && !SESSION_ID_RE.test(opts.resumeSessionId)) throw new Error('invalid session id');
    let resume = opts.resumeSessionId ?? null;
    if (opts.attachName) {
      const meta = readSessionMeta(opts.dataDir, this.session);
      if (meta) {
        this.leadPaneId = meta.leadPaneId;
        resume = meta.resumeSessionId ?? null;
        if (meta.createdAt) this.createdAt = meta.createdAt;
        // 기록해 둔 리드 대화 ID로 시작한다: 복원 직후에도 × 안내·히스토리 강조·끊기 거부가 main과 같게(pollTeam이 바뀐 ID를 찾으면 갱신).
        // 같은 ID면 pollTeam이 팀 이름을 다시 정하지 않으므로 함께 채운다
        this.leadSessionIds = meta.leadSessionIds ?? [];
        if (meta.leadSessionId) {
          this.leadSessionId = meta.leadSessionId;
          this.teamName = teamNameFor(meta.leadSessionId);
        }
      }
    }
    this.resumeSessionId = resume;
    this.purpose = opts.purpose ?? 'conversation';
    const files = sessionFiles(opts.dataDir, this.session);
    this.cacheFile = files.labels;
    this.hookSettingsFile = files.hookSettings;
    this.hookEventsFile = files.hookEvents;
    this.loadCache();
  }

  /** 리드에서 본 대화 ID 전부(복사본, 렌더러로 보내지 않는 main 전용 값). */
  knownLeadIds(): string[] {
    return [...this.leadSessionIds];
  }

  /** 현재 상태 스냅샷. */
  state(): TabState {
    const panes: PaneView[] = [...this.panes.values()].filter((p) => !p.dead).map((p) => ({
      paneId: p.paneId,
      windowId: p.windowId,
      cols: p.width,
      rows: p.height,
      label: this.labels[p.paneId] ?? fallbackLabel(p.paneId),
      working: this.working.has(p.paneId),
      waiting: this.hook.waiting[p.paneId] !== undefined,
    }));
    // 리드 카드를 항상 맨 앞에
    panes.sort((a, b) => (a.paneId === this.leadPaneId ? -1 : b.paneId === this.leadPaneId ? 1 : Number(a.paneId.slice(1)) - Number(b.paneId.slice(1))));
    return {
      tabId: this.tabId, session: this.session, folder: this.opts.folder, status: this.status,
      leadPaneId: this.leadPaneId, plain: this.plain, teamName: this.teamName, panes, error: this.error ? resolveMsg(this.error) : undefined,
      hooksEnabled: this.opts.hookCommand !== null,
      leadSessionId: this.leadSessionId, resumeSessionId: this.resumeSessionId, leadGone: this.leadGone,
      terminating: this.terminating, createdAt: this.createdAt, purpose: this.purpose, loginFailed: this.loginFailed,
    };
  }

  /** 로그인 탭 결과 표시(F7-2). 바뀌었을 때만 상태를 낸다. */
  setLoginFailed(v: boolean): void {
    if (this.loginFailed === v) return;
    this.loginFailed = v;
    this.emitState();
  }

  private emitState(): void {
    this.emit('state', this.state());
  }

  private setStatus(s: TabStatus, error?: Msg): void {
    this.status = s;
    this.error = error;
    this.emitState();
  }

  /**
   * 새 세션을 만들고 리드 명령을 실행한 뒤 연결한다(attachName이 있으면 기존 세션에 연결만).
   *
   * Raises:
   *   Error: 폴더가 없거나 psmux 세션 생성에 실패했을 때.
   */
  async start(): Promise<void> {
    const fresh = !this.opts.attachName;
    if (fresh) {
      // 끊긴 네트워크 폴더가 main을 멈추지 않게 비동기 + 시간 제한(QA M4-1)
      const dir = await probeDir(this.opts.folder);
      const why = unreachableMsg(dir);
      if (why) throw new Error(tr('sess.folderUnreachable', { why, folder: this.opts.folder }));
      if (dir !== 'ok') throw new Error(tr('sess.folderMissing', { folder: this.opts.folder }));
      const r = await psmuxCli(this.opts.psmux, ['new-session', '-d', '-s', this.session, '-x', '200', '-y', '50', '-c', this.opts.folder]);
      if (r.code !== 0) throw new Error(tr('sess.createFailed', { err: r.err || String(r.code) }));
      log('info', `[${this.session}] created in ${this.opts.folder}`);
      if (this.opts.shell) this.shellWarning = await this.applyShell(this.opts.shell);
    }
    try {
      await this.connect();
      if (fresh) {
        await this.refresh();
        this.leadPaneId = [...this.panes.keys()][0] ?? null;
        if (!this.leadPaneId) throw new Error(tr('sess.noPane'));
        this.writeMeta();
        this.relabel();
        this.emitState();
        await this.launchLead();
      }
    } catch (e) {
      // 방금 만든 우리 세션이 반쯤 열린 채 남지 않게 정리(기존 세션 연결 실패는 세션을 건드리지 않음)
      if (fresh) await this.kill();
      throw e;
    }
    this.timers.push(setInterval(() => this.scheduleRefresh(0), POLL_MS));
    this.timers.push(setInterval(() => void this.pollTeam(), TEAM_POLL_MS));
    this.timers.push(setInterval(() => this.updateWorking(), 500));
    if (this.opts.hookCommand) this.timers.push(setInterval(() => this.pollHooks(), HOOK_POLL_MS));
  }

  /**
   * 설정한 셸(F8 pwsh 경로)을 이 세션에만 적용한다: set-option -t <세션> default-shell → 첫 칸 respawn-pane -k → pane_current_command 확인.
   * SHELL 환경변수 주입은 psmux 서버가 이미 떠 있으면 무시되므로 쓰지 않는다(M4 리뷰 M-1). 이후 분할 칸(팀원)도 이 default-shell로 뜬다.
   *
   * Returns:
   *   적용됐으면 null, 아니면 사용자 안내(번역 전 문구). 실패해도 세션은 psmux 기본 셸로 계속 쓴다.
   */
  private async applyShell(shell: string): Promise<Msg | null> {
    const p = this.opts.psmux;
    const set = await psmuxCli(p, ['set-option', '-t', this.session, 'default-shell', shellOptionPath(shell)]);
    const panes = async (): Promise<string[][]> =>
      (await psmuxCli(p, ['list-panes', '-s', '-t', this.session, '-F', '#{pane_id} #{pane_current_command}'])).out.split(/\r?\n/).map((l) => l.trim().split(' ')).filter((x) => x[0]);
    const first = (await panes())[0]?.[0];
    let current = '';
    if (set.code === 0 && first) {
      const rs = await psmuxCli(p, ['respawn-pane', '-k', '-t', first]);
      if (rs.code === 0) {
        // 새 셸 프로세스가 뜰 때까지 잠깐 확인(최대 약 5초)
        for (let i = 0; i < 25; i++) {
          await new Promise((res) => setTimeout(res, 200));
          current = (await panes()).find((x) => x[0] === first)?.slice(1).join(' ') ?? '';
          if (shellMatches(current, shell)) {
            log('info', `[${this.session}] shell applied: ${shell}`);
            return null;
          }
        }
      } else {
        log('warn', `[${this.session}] respawn-pane failed (code ${rs.code}: ${rs.err.slice(0, 120)})`);
      }
    } else {
      log('warn', `[${this.session}] set default-shell failed (code ${set.code}: ${set.err.slice(0, 120)}, first pane ${first ?? '-'})`);
    }
    log('warn', `[${this.session}] shell not applied: expected ${shell}, pane runs ${current || 'unknown'}`);
    // 지정한 실행 파일이 바로 끝나면(셸이 아님 등) 하나뿐인 칸이 닫혀 세션이 사라진다 → 원인을 알리고 실패 처리
    if (!(await hasSession(p, this.session))) {
      this.shellWarning = msg('sess.shellClosed', { shell });
      throw new Error(resolveMsg(this.shellWarning));
    }
    // 세션이 살아 있으면 psmux 기본 셸로 되돌려 계속 쓴다(리드 명령은 pwsh 문법)
    await psmuxCli(p, ['set-option', '-u', '-t', this.session, 'default-shell']);
    if (first) await psmuxCli(p, ['respawn-pane', '-k', '-t', first]);
    return msg('sess.shellNotApplied', { current: current || msg('sess.unknown') });
  }

  private async launchLead(): Promise<void> {
    let cmd = this.opts.leadCommand;
    // 대화 ID는 생성자에서 형식 검증됨(명령 주입 방지)
    if (this.resumeSessionId) cmd += ` -r ${this.resumeSessionId}`;
    const statusLine = this.opts.statusLineCommand ?? null;
    if (this.opts.hookCommand || statusLine) {
      this.writeLeadSettings(statusLine);
      cmd += ` --settings ${pwshQuote(this.hookSettingsFile)}`;
    }
    await this.runCommands(inputToCommands(this.leadPaneId!, cmd));
    log('info', `[${this.session}] lead launched on ${this.leadPaneId} (hooks=${this.opts.hookCommand !== null}, statusline=${statusLine !== null})`);
  }

  /** 리드 --settings 파일: hook(승인 대기 감지)과 statusLine(사용량, F7-1) 중 있는 것만 넣는다. */
  private writeLeadSettings(statusLine: string | null): void {
    mkdirSync(join(this.opts.dataDir, 'hooks'), { recursive: true });
    const out: Record<string, unknown> = {};
    if (this.opts.hookCommand) out.hooks = this.hookSettings(this.opts.hookCommand);
    // 사용량 기록 전용: 스크립트가 stdout을 비워 statusline은 표시되지 않는다(사용자 statusLine 설정은 이 세션에서 가려짐)
    if (statusLine) out.statusLine = { type: 'command', command: statusLine };
    writeFileSync(this.hookSettingsFile, JSON.stringify(out, null, 2));
  }

  private hookSettings(hookCommand: string): Record<string, unknown> {
    const command = `${hookCommand} "${this.hookEventsFile.replace(/\\/g, '/')}"`;
    const h = [{ type: 'command', command, timeout: 10 }];
    const withMatcher = [{ matcher: '*', hooks: h }];
    const plain = [{ hooks: h }];
    const hooks = {
      SessionStart: plain, UserPromptSubmit: plain, Stop: plain, StopFailure: plain, TeammateIdle: plain, Notification: plain, SessionEnd: plain,
      PreToolUse: withMatcher, PostToolUse: withMatcher, PermissionRequest: withMatcher, PermissionDenied: withMatcher,
    };
    return hooks;
  }

  private async connect(): Promise<void> {
    if (!(await hasSession(this.opts.psmux, this.session))) {
      this.setStatus('ended', msg('sess.gone'));
      throw new Error(tr('sess.notFound', { name: this.session }));
    }
    const c = new ControlClient({ psmuxPath: this.opts.psmux, session: this.session, env: cleanEnv(), log });
    this.client = c;
    c.on('output', (pane: string, data: Buffer, seq: number) => this.onOutput(pane, data, seq));
    c.on('notify', (name: string) => {
      if (name !== 'subscription-changed') this.scheduleRefresh(150);
    });
    // ready 전에 끊기면 reject → 호출부(start/재연결 루프)가 처리. 그 전에는 onDisconnected를 타지 않아 재연결 루프가 중첩되지 않음
    let readyDone = false;
    const ready = new Promise<void>((res, rej) => {
      const t = setTimeout(() => { readyDone = true; res(); }, 1500);
      c.once('ready', () => { clearTimeout(t); readyDone = true; res(); });
      c.once('disconnected', (reason: string) => {
        if (readyDone) return;
        clearTimeout(t);
        readyDone = true;
        rej(new Error(`control mode connection failed: ${reason}`));
      });
    });
    c.on('disconnected', (reason: string) => { if (readyDone) void this.onDisconnected(c, reason); });
    c.start();
    try {
      await ready;
    } catch (e) {
      if (this.client === c) this.client = null;
      throw e;
    }
    // 연결을 기다리는 사이 detach됐으면 방금 띄운 -CC 프로세스가 남지 않게 닫는다
    if (this.closing) {
      c.close('detached while connecting');
      if (this.client === c) this.client = null;
      throw new Error('detached while connecting');
    }
    this.reconnectDelay = 1000;
    this.connectedAt = Date.now();
    this.setStatus('connected');
  }

  private async onDisconnected(c: ControlClient, reason: string): Promise<void> {
    if (this.client !== c || this.closing) return;
    this.client = null;
    this.setStatus('reconnecting', msg('sess.reconnecting', { reason }));
    while (!this.closing) {
      await new Promise<void>((r) => {
        const t = setTimeout(() => { this.wakeReconnect = null; r(); }, this.reconnectDelay);
        this.wakeReconnect = () => { clearTimeout(t); this.wakeReconnect = null; r(); };
      });
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
      if (this.closing) return;
      try {
        if (!(await hasSession(this.opts.psmux, this.session))) {
          this.setStatus('ended', msg('sess.ended'));
          this.stopTimers();
          return;
        }
        await this.connect();
        await this.refresh();
        // 크기를 먼저 맞추고(줄바꿈이 바뀌므로) 그다음 캡처한다
        await this.reapplySizes();
        await Promise.all([...this.panes.keys()].map((p) => this.resyncAfterReconnect(p)));
        log('info', `[${this.session}] reconnected`);
        return;
      } catch (e) {
        log('warn', `[${this.session}] reconnect failed: ${errMsg(e)}`);
      }
    }
  }

  /** 끊긴 동안 버려진 리사이즈 요청을 다시 적용한다(QA NEW-1). 이미 맞으면 실제 크기만 렌더러에 다시 알린다. */
  private async reapplySizes(): Promise<void> {
    for (const [pane, want] of this.desired) {
      const p = this.panes.get(pane);
      if (!p) continue;
      if (p.width !== want.cols || p.height !== want.rows) await this.applySize(pane);
      else this.emit('size', pane, p.width, p.height);
    }
  }

  /**
   * 재연결 직후 재동기화(QA NEW-2). psmux가 캡처 전에 만들어진 출력을 캡처 응답 뒤에 늦게 보내 같은 줄이 두 번 그려질 수 있어,
   * 연결 후·마지막 출력 후 둘 다 잠잠할 때까지(최대 2초) 기다린 뒤 캡처하고, 첫 캡처 1.5초 뒤에 무조건 한 번 더 캡처해
   * 중복이 남아도 그 안에 화면을 바로잡는다.
   */
  private async resyncAfterReconnect(pane: string): Promise<void> {
    const client = this.client;
    await this.waitQuiet(pane);
    if (this.client !== client || this.closing) return;
    await this.resync(pane);
    clearTimeout(this.resyncAgainTimers.get(pane));
    this.resyncAgainTimers.set(pane, setTimeout(() => {
      this.resyncAgainTimers.delete(pane);
      if (this.client === client && !this.closing && this.panes.has(pane)) void this.resync(pane);
    }, RESYNC_AGAIN_MS));
  }

  /**
   * 연결 후 RESYNC_QUIET_MS가 지나고 칸 출력도 RESYNC_QUIET_MS 동안 없을 때까지(최대 RESYNC_QUIET_MAX_MS) 기다린다.
   * 새 연결에서 아직 출력이 안 왔을 뿐인 상태를 "잠잠함"으로 오판하지 않게 연결 시각도 함께 본다.
   */
  private async waitQuiet(pane: string): Promise<void> {
    const until = Date.now() + RESYNC_QUIET_MAX_MS;
    for (;;) {
      const now = Date.now();
      const idle = now - Math.max(this.lastArrival.get(pane) ?? 0, this.connectedAt);
      if (idle >= RESYNC_QUIET_MS || now >= until || this.closing) return;
      await new Promise((r) => setTimeout(r, Math.min(RESYNC_QUIET_MS - idle, until - now)));
    }
  }

  private cmd(c: string, timeoutMs?: number): Promise<CommandResult> {
    if (!this.client) return Promise.resolve({ ok: false, lines: ['not connected'] });
    return this.client.command(c, timeoutMs);
  }

  private async runCommands(cmds: string[]): Promise<boolean> {
    // stdin 쓰기 순서 = 실행 순서이므로 한꺼번에 보내고 결과만 모은다. 끝에 표지를 붙여 응답 큐 어긋남을 바로 잡는다(QA BUG-1)
    const client = this.client;
    if (!client) return false;
    const [rs, aligned] = await Promise.all([Promise.all(cmds.map((c) => this.cmd(c))), client.barrier()]);
    const bad = rs.findIndex((r) => !r.ok);
    if (bad >= 0) log('warn', `[${this.session}] command failed: ${cmds[bad].split(' ').slice(0, 3).join(' ')} -> ${rs[bad].lines.join(' | ').slice(0, 200)}`);
    // 표지 실패는 응답 정렬 문제일 뿐 명령은 이미 실행됐으므로 성공으로 본다(false면 호출부가 재전송해 중복 입력)
    if (!aligned) {
      // 정렬이 어긋났을 수 있으니 바로 refresh(표지 2연속 확인, 실패 시 재연결)로 확인한다
      log('warn', `[${this.session}] nonce barrier failed after ${cmds.length} commands`);
      this.scheduleRefresh(0);
    }
    return bad < 0;
  }

  private onOutput(pane: string, data: Buffer, seq: number): void {
    const now = Date.now();
    this.lastArrival.set(pane, now);
    if ((this.quietUntil.get(pane) ?? 0) < now) this.lastOutput.set(pane, now);
    this.out.push(pane, data, seq);
    if (!this.panes.has(pane)) this.scheduleRefresh(50);
  }

  private updateWorking(): void {
    const now = Date.now();
    let changed = false;
    for (const id of this.panes.keys()) {
      const w = now - (this.lastOutput.get(id) ?? 0) < WORKING_WINDOW_MS;
      if (w !== this.working.has(id)) {
        changed = true;
        if (w) this.working.add(id);
        else this.working.delete(id);
      }
    }
    if (changed) this.emitState();
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delayMs);
  }

  /** list-panes로 실제 칸 목록을 맞추고, 새 칸은 창 분리·크기 지정, dead 칸은 정리한다. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        await this.refreshOnce();
      } while (this.refreshAgain);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refreshOnce(): Promise<void> {
    const client = this.client;
    if (!client) return;
    // 응답 밀림 감지: 표지 응답으로 큐를 맞추고, 그래도 안 맞으면 재연결(client.ts 주석)
    // 표지 한 번 실패(내용 불일치 등, QA NEW-4)는 한 번 더 확인하고 그래도 안 맞을 때만 다시 연결
    if (!(await client.barrier()) && (this.client !== client || !(await client.barrier()))) {
      if (this.client !== client) return;
      log('warn', `[${this.session}] protocol drift: nonce barrier failed twice in refresh`);
      client.close('protocol drift (nonce mismatch)');
      return;
    }
    const r = await this.cmd(`list-panes -s -t ${this.session} -F ${LIST_PANES_FORMAT}`);
    if (!r.ok) return;
    let list = parseListPanes(r.lines);
    // 세션에는 항상 칸이 1개 이상 있다. 빈 목록은 비정상 응답으로 보고 카드를 지우지 않는다
    if (list.length === 0) {
      log('warn', `[${this.session}] list-panes returned no panes (${r.lines.length} lines); ignored`);
      return;
    }
    // Claude 팀원 종료 뒤 칸이 pane_dead=1로 남음 → 우리 세션 안의 dead 칸만 정리(카드는 diff에서 바로 빠짐)
    // 리드 칸은 정리·창 분리 둘 다 같은 기준으로 판단한다(리드 미확정이면 첫 칸)
    // 재연결·복원인데 메타에 리드 칸이 없으면(손상 등) 첫 칸을 리드로 본다(앱은 세션을 만들 때 첫 칸에서 리드를 실행함)
    if (this.leadPaneId === null && this.opts.attachName && list[0]) this.leadPaneId = list[0].paneId;
    const lead = this.leadPaneId ?? list[0]?.paneId ?? null;
    const gone = this.leadPaneId !== null && !list.some((x) => x.paneId === this.leadPaneId && !x.dead);
    if (gone !== this.leadGone) {
      this.leadGone = gone;
      log('info', `[${this.session}] lead pane ${this.leadPaneId} ${gone ? 'gone' : 'back'}`);
      this.emitState();
    }
    if (list.some((x) => x.dead)) await this.cleanupDead(list, lead);
    // 칸 = 창 1개. 리드 창을 나눠 생긴 팀원 칸은 자기 창으로 옮긴다
    const toBreak = panesToBreak(list, lead).filter((id) => this.canRetry(`break ${id}`));
    if (toBreak.length) {
      for (const id of toBreak) {
        const b = await this.cmd(`break-pane -d -s ${id}`);
        this.notePaneOp(`break ${id}`, b.ok, `break-pane ${id}`, b.lines);
      }
      const r2 = await this.cmd(`list-panes -s -t ${this.session} -F ${LIST_PANES_FORMAT}`);
      const l2 = r2.ok ? parseListPanes(r2.lines) : [];
      if (l2.length) list = l2;
    }
    const diff = diffPanes(this.panes, list);
    this.panes = new Map(list.filter((p) => !p.dead).map((p) => [p.paneId, p]));
    for (const id of diff.removed) {
      this.out.drop(id);
      this.desired.delete(id);
      clearTimeout(this.resyncAgainTimers.get(id));
      this.resyncAgainTimers.delete(id);
      this.lastOutput.delete(id);
      this.quietUntil.delete(id);
      this.lastArrival.delete(id);
      this.deadRetryAt.delete(id);
      this.working.delete(id);
      delete this.hook.waiting[id];
    }
    for (const p of diff.added) {
      log('info', `[${this.session}] pane added ${p.paneId} ${p.windowId} ${p.width}x${p.height}`);
      const want = this.desired.get(p.paneId) ?? this.desired.get(this.leadPaneId ?? '') ?? null;
      if (want && (want.cols !== p.width || want.rows !== p.height)) void this.applySize(p.paneId);
      void this.resync(p.paneId);
    }
    if (diff.removed.length) log('info', `[${this.session}] panes removed ${diff.removed.join(',')}`);
    for (const p of diff.changed) this.emit('size', p.paneId, p.width, p.height);
    if (diff.added.length || diff.removed.length || diff.changed.length) {
      this.relabel();
      this.emitState();
    }
  }

  /**
   * dead 칸 정리(QA BUG-2). control mode kill-pane은 ok를 돌려줘도 칸이 남으므로, 칸 = 창 구조를 이용해 창을 지운다.
   * 순서: control mode kill-window → list-panes로 확인 → 남으면 CLI kill-window(세션 범위 지정) → 확인.
   * 다른 칸과 창을 같이 쓰는 dead 칸·리드 칸은 창을 지우지 않는다(살아 있는 칸·세션까지 닫히지 않게).
   * 실패하면 로그는 1회만 남기고 30초 뒤 다시 시도한다.
   */
  private async cleanupDead(list: PaneInfo[], lead: string | null): Promise<void> {
    const now = Date.now();
    for (const p of list.filter((x) => x.dead)) {
      const retryAt = this.deadRetryAt.get(p.paneId);
      if (retryAt !== undefined && retryAt > now) continue;
      const steps: string[] = [];
      let gone = false;
      if (p.windowPanes === 1 && p.paneId !== lead) {
        const r = await this.cmd(`kill-window -t ${p.windowId}`);
        steps.push(`cc kill-window ${r.ok ? 'ok' : r.lines.join(' ').slice(0, 80)}`);
        gone = !(await this.paneListed(p.paneId));
        if (!gone) {
          const c = await psmuxCli(this.opts.psmux, ['kill-window', '-t', `${this.session}:${p.windowId}`]);
          steps.push(`cli kill-window code=${c.code}`);
          gone = !(await this.paneListed(p.paneId));
        }
      } else if (p.paneId !== lead) {
        const r = await this.cmd(`kill-pane -t ${p.paneId}`);
        steps.push(`cc kill-pane ${r.ok ? 'ok' : r.lines.join(' ').slice(0, 80)}`);
        gone = !(await this.paneListed(p.paneId));
      } else {
        steps.push('lead pane: not killed');
      }
      if (gone) {
        this.deadRetryAt.delete(p.paneId);
        log('info', `[${this.session}] dead pane ${p.paneId} (${p.windowId}) removed: ${steps.join(', ')}`);
      } else {
        if (retryAt === undefined) log('warn', `[${this.session}] dead pane ${p.paneId} (${p.windowId}) still listed: ${steps.join(', ')}; retry every ${DEAD_RETRY_MS / 1000}s`);
        this.deadRetryAt.set(p.paneId, now + DEAD_RETRY_MS);
      }
    }
  }

  private async paneListed(pane: string): Promise<boolean> {
    const r = await this.cmd(`list-panes -s -t ${this.session} -F '#{pane_id}'`);
    // 응답이 없으면 "남아 있음"으로 본다(지웠다고 잘못 판단하지 않게)
    return !r.ok || r.lines.some((l) => l.trim() === pane);
  }

  private canRetry(op: string): boolean {
    return (this.paneOpFailures.get(op) ?? 0) < MAX_PANE_OP_ATTEMPTS;
  }

  private notePaneOp(op: string, ok: boolean, what: string, lines: string[]): void {
    if (ok) {
      this.paneOpFailures.delete(op);
      log('info', `[${this.session}] ${what}: ok`);
      return;
    }
    const n = (this.paneOpFailures.get(op) ?? 0) + 1;
    this.paneOpFailures.set(op, n);
    log('warn', `[${this.session}] ${what} failed (${n}/${MAX_PANE_OP_ATTEMPTS}${n >= MAX_PANE_OP_ATTEMPTS ? ', giving up' : ''}): ${lines.join(' ').slice(0, 200)}`);
  }

  /**
   * 카드 크기에 맞춰 칸 크기를 바꾼다(resize-window). 실제 크기는 list-panes로 확인해 'size'로 알린다.
   *
   * Args:
   *   pane: 칸 ID.
   *   cols: xterm fit 계산 열 수.
   *   rows: xterm fit 계산 행 수.
   */
  async resizePane(pane: string, cols: number, rows: number): Promise<void> {
    assertSafeToken(pane);
    this.desired.set(pane, clampSize(cols, rows));
    await this.applySize(pane);
  }

  private async applySize(pane: string): Promise<void> {
    const want = this.desired.get(pane);
    const info = this.panes.get(pane);
    if (!want || !info) return;
    this.quietUntil.set(pane, Date.now() + QUIET_AFTER_RESIZE_MS);
    const r = await this.cmd(`resize-window -t ${info.windowId} -x ${want.cols} -y ${want.rows}`);
    if (!r.ok) log('warn', `[${this.session}] resize ${pane} failed: ${r.lines.join(' ')}`);
    const chk = await this.cmd(`list-panes -t ${info.windowId} -F ${LIST_PANES_FORMAT}`);
    const actual = chk.ok ? parseListPanes(chk.lines).find((p) => p.paneId === pane) : undefined;
    // await 사이에 칸이 사라졌으면(refresh가 제거) 되살리지 않는다
    const cur = this.panes.get(pane);
    if (actual && cur) {
      this.panes.set(pane, { ...cur, width: actual.width, height: actual.height });
      if (actual.width !== want.cols || actual.height !== want.rows) log('info', `[${this.session}] ${pane} size wanted ${want.cols}x${want.rows} got ${actual.width}x${actual.height}`);
      this.emit('size', pane, actual.width, actual.height);
    }
  }

  /** 입력창 텍스트 전송(한 줄/여러 줄). 빈 입력은 보내지 않는다. 종료 처리 중에는 받지 않는다. */
  async sendInput(pane: string, text: string): Promise<boolean> {
    if (this.terminating) return false;
    return this.deliver(pane, text, true);
  }

  /** 텍스트 전송(차례 보장). clearWaiting이면 승인 대기 표시를 지운다(사용자 입력일 때만). */
  private deliver(pane: string, text: string, clearWaiting: boolean): Promise<boolean> {
    // 텍스트와 Enter 사이에 간격이 생기므로 입력끼리 섞이지 않게(앞 입력의 Enter 전에 다음 텍스트가 끼지 않게) 차례로 보낸다
    const run = this.inputQueue.then(() => this.deliverNow(pane, text, clearWaiting));
    this.inputQueue = run.catch(() => undefined);
    return run;
  }

  /** 텍스트 전송 본체: 본문 → (End) → Enter를 SUBMIT_DELAY_MS 간격으로. */
  private async deliverNow(pane: string, text: string, clearWaiting: boolean): Promise<boolean> {
    if (!this.panes.has(pane)) return false;
    // pwsh 칸은 여러 줄을 C-j로(붙여넣기 안 CR을 줄마다 실행), Claude Code 칸은 bracketed paste(QA FAIL 19)
    let command = this.panes.get(pane)?.command;
    if (/[\r\n]/.test(text)) {
      // 폴링 값은 최대 2초 늦어 방금 종료·시작한 프로그램을 놓칠 수 있으므로 여러 줄일 때만 직전에 다시 확인(QA NEW-5)
      const r = await this.cmd(`display-message -p -t ${pane} '#{pane_current_command}'`);
      const fresh = r.ok ? (r.lines[0] ?? '').trim() : '';
      const cur = this.panes.get(pane);
      // 프로그램 이름 형태일 때만 반영(응답이 어긋나 다른 명령의 출력이 온 경우 캐시를 오염시키지 않게)
      if (/^[A-Za-z0-9_.-]+$/.test(fresh) && cur) {
        command = fresh;
        this.panes.set(pane, { ...cur, command: fresh });
      }
    }
    const cmds = inputToCommands(pane, text, multilineModeFor(command));
    if (!cmds.length) return false;
    log('info', `[${this.session}] input -> ${pane} (${text.length} chars, ${cmds.length} cmds)`);
    // M3: @ 참조가 있어 Enter 앞에 End를 넣은 경우(QA 실호출 검증용 추적)
    if (cmds.some((c) => c.endsWith(' End'))) log('info', `[${this.session}] input -> ${pane}: End before Enter (@ reference)`);
    if (clearWaiting && this.hook.waiting[pane] !== undefined) {
      delete this.hook.waiting[pane];
      this.emitState();
    }
    const batches = splitSubmit(pane, cmds);
    for (let i = 0; i < batches.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
      // 앞 묶음(본문)이 실패했으면 Enter를 보내지 않는다(일부만 들어간 입력·빈 프롬프트 제출 방지)
      if (!(await this.runCommands(batches[i]))) return false;
    }
    return true;
  }

  /** 터미널 직접 키 입력(xterm onData). */
  async sendKeys(pane: string, data: string): Promise<boolean> {
    if (this.terminating || !this.panes.has(pane) || !data) return false;
    const toks = xtermDataToTokens(data);
    // 승인 프롬프트는 Enter/Esc로 끝나므로 그때 대기 표시를 지운다(hook 해제 이벤트가 늦을 수 있음)
    if (toks.some((t) => t.type === 'key' && (t.name === 'Enter' || t.name === 'Escape')) && this.hook.waiting[pane] !== undefined) {
      delete this.hook.waiting[pane];
      this.emitState();
    }
    return this.runCommands(tokensToCommands(pane, toks));
  }

  /** capture-pane -p -e 로 칸 화면을 다시 그릴 데이터를 만든다(연결 직후·끊김 뒤·요청 시). */
  async resync(pane: string): Promise<void> {
    if (!/^%\d+$/.test(pane)) return;
    this.quietUntil.set(pane, Date.now() + QUIET_AFTER_RESIZE_MS);
    const capP = this.cmd(`capture-pane -p -e -t ${pane}`);
    const curP = this.cmd(`display-message -p -t ${pane} '#{cursor_x} #{cursor_y}'`);
    const cap = await capP;
    if (!cap.ok) return;
    // 캡처 응답 직후 동기 구간에서 처리: 캡처보다 먼저 도착한 출력은 지금(캡처 전에) 내보내고, 뒤에 온 출력은 캡처 다음에 그린다.
    // 커서 응답까지 기다리면 그 사이 배처 타이머가 캡처 뒤 출력을 먼저 내보내 화면 지우기에 덮인다(리뷰 Major 2·2차 M1)
    if (cap.seq !== undefined) this.out.flushBefore(pane, cap.seq);
    this.emit('resync', pane, '\x1b[0m\x1b[H\x1b[2J' + cap.lines.join('\r\n') + '\x1b[0m', cap.seq);
    // 커서 위치는 응답 시점의 스트림 순번으로 배처에 넣어 앞뒤 출력과 순서를 맞춘다
    const cur = await curP;
    const m = cur.ok ? /^(\d+) (\d+)$/.exec((cur.lines[0] ?? '').trim()) : null;
    if (m && this.panes.has(pane)) {
      this.out.push(pane, Buffer.from(`\x1b[${Number(m[2]) + 1};${Number(m[1]) + 1}H`), cur.seq ?? Number.MAX_SAFE_INTEGER);
    }
  }

  /** 칸·세션 정보(⋮ 메뉴). */
  paneInfo(pane: string): Record<string, string | number | null> {
    const p = this.panes.get(pane);
    const l = this.labels[pane];
    return {
      session: this.session, folder: this.opts.folder, pane, window: p?.windowId ?? null,
      size: p ? `${p.width}x${p.height}` : null, command: p?.command ?? null,
      name: l?.name ?? null, agentType: l?.agentType ?? null, mapping: l?.source ?? null,
      team: this.teamName, lead: this.leadPaneId,
    };
  }

  /** 팀원 종료 요청: 리드에게 자연어로 요청한다('@'는 파일 자동완성을 띄우므로 쓰지 않음). */
  async requestStop(pane: string): Promise<boolean> {
    const l = this.labels[pane];
    if (!this.leadPaneId || pane === this.leadPaneId || !l || l.source === 'fallback') return false;
    return this.sendInput(this.leadPaneId, `Please shut down the teammate named ${l.name}.`);
  }

  private async pollTeam(): Promise<void> {
    // 매핑이 확정되면 ~/.claude 전수 파싱을 10초 간격으로 줄인다(새 칸이 생겨 %N이 보이면 다시 1.5초)
    const settled = this.leadSessionId !== null && this.panes.size > 0 && [...this.panes.keys()].every((p) => this.labels[p] && this.labels[p].source !== 'fallback');
    const now = Date.now();
    if (settled && now - this.lastTeamPoll < TEAM_POLL_SETTLED_MS) return;
    this.lastTeamPoll = now;
    try {
      const sid = await findLeadSessionId(this.session, this.leadPaneId);
      if (sid && sid !== this.leadSessionId) {
        this.leadSessionId = sid;
        this.leadSessionIds = appendLeadId(this.leadSessionIds, sid);
        this.teamName = teamNameFor(sid);
        // 분리 뒤에도 메타로 이 세션의 대화 ID를 알 수 있게(탭 없는 세션 판정·히스토리 클릭 재연결)
        this.writeMeta();
        log('info', `[${this.session}] lead session ${sid.slice(0, 8)} team=${this.teamName}`);
        this.emitState();
      }
      const cfg = this.teamName ? await readTeamConfig(this.teamName) : null;
      if (JSON.stringify(cfg) !== JSON.stringify(this.teamConfig)) {
        this.teamConfig = cfg;
        this.relabel();
        this.emitState();
      }
    } catch (e) {
      log('warn', `[${this.session}] team poll: ${errMsg(e)}`);
    }
  }

  private relabel(): void {
    const { labels, cache } = resolveLabels({
      panes: [...this.panes.keys()], leadPaneId: this.leadPaneId, leadName: this.leadName,
      config: this.teamConfig, cache: this.labelCache, hints: this.hook.hints,
    });
    this.labels = labels;
    if (JSON.stringify(cache) !== JSON.stringify(this.labelCache)) {
      this.labelCache = cache;
      this.saveCache();
    }
  }

  private pollHooks(): void {
    let size = 0;
    try { size = statSync(this.hookEventsFile).size; } catch { return; }
    if (size < this.hookOffset) this.hookOffset = 0;
    if (size === this.hookOffset) return;
    let text = '';
    let fd: number | null = null;
    try {
      fd = openSync(this.hookEventsFile, 'r');
      const buf = Buffer.alloc(size - this.hookOffset);
      const n = readSync(fd, buf, 0, buf.length, this.hookOffset);
      const lastNl = buf.subarray(0, n).lastIndexOf(0x0a);
      if (lastNl < 0) return;
      text = buf.subarray(0, lastNl + 1).toString('utf8');
      this.hookOffset += lastNl + 1;
    } catch (e) {
      log('warn', `[${this.session}] hook events read failed: ${errMsg(e)}`);
      return;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    let touched = false;
    for (const line of text.split('\n')) {
      const rec = parseHookLine(line);
      if (!rec) continue;
      const pane = applyHookRecord(this.hook, rec, this.leadPaneId, this.leadName);
      if (pane) touched = true;
      // 리드의 새 대화 시작(/clear·재개 등) → sessionId가 바뀌었을 수 있어 바로 다시 확인(M2-07)
      if (rec.event === 'SessionStart' && pane !== null && pane === this.leadPaneId) {
        this.lastTeamPoll = 0;
        void this.pollTeam();
      }
      log('info', `[${this.session}] hook ${rec.event}${rec.notificationType ? `/${rec.notificationType}` : ''} pane=${pane ?? '?'} (env pane=${rec.pane ?? '-'})`);
    }
    if (touched) {
      this.relabel();
      this.emitState();
    }
  }

  private writeMeta(): void {
    writeSessionMeta(this.opts.dataDir, {
      session: this.session, folder: this.opts.folder, leadPaneId: this.leadPaneId, leadCommand: this.opts.leadCommand,
      createdAt: this.createdAt, resumeSessionId: this.resumeSessionId ?? undefined,
      leadSessionId: this.leadSessionId ?? undefined,
      ...(this.leadSessionIds.length ? { leadSessionIds: this.leadSessionIds } : {}),
      ...(this.purpose === 'login' ? { purpose: 'login' as const } : {}),
    });
  }

  private loadCache(): void {
    try {
      const c = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Record<string, PaneLabel>;
      if (c && typeof c === 'object') this.labelCache = c;
    } catch { /* 캐시 없음 */ }
  }

  private saveCache(): void {
    try {
      mkdirSync(join(this.opts.dataDir, 'cache'), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(this.labelCache, null, 2));
    } catch (e) {
      log('warn', `[${this.session}] label cache save failed: ${errMsg(e)}`);
    }
  }

  private stopTimers(): void {
    for (const t of this.resyncAgainTimers.values()) clearTimeout(t);
    this.resyncAgainTimers.clear();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** 재연결 대기 중이면 기다리지 않고 바로 다시 시도한다(카드 [다시 연결] 버튼). */
  reconnectNow(): void {
    this.reconnectDelay = 1000;
    this.wakeReconnect?.();
  }

  /** 현재 control mode 프로세스 ID(통합 테스트에서 끊김 재현용). */
  get controlPid(): number | undefined {
    return this.client?.pid;
  }

  /** 연결만 끊는다(psmux 세션은 유지 = detach). */
  detach(): void {
    this.closing = true;
    this.stopTimers();
    this.client?.close();
    this.client = null;
  }

  /** psmux 세션까지 종료하고 이 세션의 앱 파일(메타·캐시·hook)을 지운다(명시적 종료·테스트 정리 전용). */
  async kill(): Promise<void> {
    this.detach();
    const r = await psmuxCli(this.opts.psmux, ['kill-session', '-t', this.session]);
    log('info', `[${this.session}] kill-session code=${r.code}`);
    // 세션이 남아 있으면 앱 파일을 지우지 않는다(다음 실행 때 복원·정리 대상)
    if (!(await hasSession(this.opts.psmux, this.session))) removeSessionFiles(this.opts.dataDir, this.session);
  }

  /**
   * 탭 종료(F9 종료): 리드에서 Claude Code가 돌고 있으면 팀 종료를 요청하고, 팀원 칸이 사라지거나 제한 시간이 지나면 세션을 끝낸다.
   *
   * Returns:
   *   종료 요청 메시지를 보냈는지.
   */
  async terminate(): Promise<boolean> {
    if (this.terminating) return false;
    this.terminating = true;
    this.emitState();
    // 탭 없이 막 붙어 바로 종료하는 경우(히스토리 "세션 종료…", F2-1)는 칸 목록·승인 대기 기록을 아직 읽지 않았으므로 먼저 맞춘다
    if (this.client && this.panes.size === 0) {
      await this.refresh();
      if (this.opts.hookCommand) this.pollHooks();
    }
    let requested = false;
    const lead = this.leadPaneId;
    const cmd = lead ? this.panes.get(lead)?.command ?? '' : '';
    // 리드 칸이 셸뿐이면(Claude 종료됨) 요청할 상대가 없으므로 바로 종료
    if (lead && this.client && !this.leadGone && multilineModeFor(cmd) !== 'ctrlj') {
      // 리드가 권한 승인 프롬프트에 떠 있으면 텍스트+Enter가 기본 선택지(승인)로 처리될 수 있다 → 먼저 Esc로 닫는다.
      // 승인 대기 표시는 hook 이벤트가 정리하게 두고 여기서는 지우지 않는다
      if (this.hook.waiting[lead] !== undefined) {
        await this.runCommands(tokensToCommands(lead, xtermDataToTokens('\x1b')));
        log('info', `[${this.session}] terminate: lead was waiting for approval; sent Escape first`);
        await new Promise((r) => setTimeout(r, 300));
      }
      requested = await this.deliver(lead, 'Please shut down all teammates and clean up the team now. The session will be closed right after.', false);
      log('info', `[${this.session}] terminate: shutdown request sent=${requested}`);
      const until = Date.now() + TERMINATE_WAIT_MS;
      while (requested && Date.now() < until && [...this.panes.keys()].some((p) => p !== lead)) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    // 기다리는 사이 밖에서 detach됐으면(앱 종료) 세션은 남긴다: "앱을 끄면 탭 없는 연결은 끊고 세션은 남는다"(F2-1)
    if (this.closing) return requested;
    await this.kill();
    return requested;
  }
}
