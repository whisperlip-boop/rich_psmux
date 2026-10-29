// psmux control mode 클라이언트: 프로세스 실행, 명령 큐(FIFO 응답 매칭), 끊김 감지.
// node-pty 없이 child_process.spawn 파이프만 사용.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { ControlParser, LineSplitter, type ControlEvent } from './parser';
import { isBenignError } from './quote';

/** 명령 응답. */
export interface CommandResult {
  ok: boolean;
  lines: string[];
  /** 응답 블록이 끝난 스트림 순번(출력 순서 비교용). 응답이 없으면 undefined. */
  seq?: number;
}

/**
 * 응답 매칭 결과. matched = 맨 앞과 일치, skipped = 응답 없는 앞 명령을 실패 처리 후 번호로 일치,
 * realigned = 표지(nonce) 응답으로 앞선 미응답 명령을 실패 처리하고 큐를 다시 맞춤,
 * nonce-mismatch = 표지 자리 번호의 응답인데 내용이 다름(표지만 실패 처리, 연결 유지), drift = 불일치, empty = 대기 명령 없음.
 */
export type ResolveOutcome = 'matched' | 'skipped' | 'realigned' | 'nonce-mismatch' | 'drift' | 'empty';

/** 성공 시 출력 줄이 없는 명령(QA NEW-3). 이 자리에 줄이 있는 성공 응답이 오면 다음 명령의 응답으로 본다. */
const SILENT_CMD_RE = /^send-keys\b/;

interface QueueItem {
  cmd: string;
  num: number;
  /** 표지 명령이면 응답 첫 줄로 와야 할 값. */
  expect?: string;
  settle: ((r: CommandResult) => void) | null;
}

/**
 * 응답 대기 큐(FIFO) + 명령 번호 검증. psmux는 연결마다 명령 번호를 1부터 매긴다(실측).
 * 타임아웃된 항목도 응답이 올 때까지 자리를 지켜 이후 응답이 밀리지 않게 한다.
 * 주의: '-' 인자처럼 psmux가 응답 블록을 아예 안 보내는 명령은 번호도 소비하지 않아(실측) 번호로는 못 잡는다
 * → 원인 입력을 quote.ts에서 막고, 명령 묶음 뒤에 표지(display-message -p <nonce>)를 붙여 응답 내용으로 다시 맞춘다.
 */
export class CommandQueue {
  private items: QueueItem[] = [];
  private nextNum = 1;
  /** 첫 응답으로 맞춘 번호 차이(버전에 따라 시작 번호가 다를 경우 대비). */
  private offset: number | null = null;

  /** 명령을 큐에 넣고 응답 콜백을 등록한다. */
  push(cmd: string, settle: (r: CommandResult) => void, expect?: string): { cancel: () => void } {
    const item: QueueItem = { cmd, num: this.nextNum++, expect, settle };
    this.items.push(item);
    return { cancel: () => { item.settle = null; } };
  }

  /**
   * 응답 블록 하나를 명령 번호로 매칭한다.
   *
   * Args:
   *   block: 응답(num = %begin의 명령 번호).
   *
   * Returns:
   *   매칭 결과. drift면 큐를 건드리지 않는다(호출부가 연결을 다시 맺어야 함).
   */
  resolve(block: { ok: boolean; lines: string[]; num: number; seq?: number }): ResolveOutcome {
    const head = this.items[0];
    if (!head) return 'empty';
    // 표지 응답이 앞 명령 자리에 왔으면(앞에 응답 없는 명령이 있었음) 그 사이를 실패 처리하고 표지 기준으로 다시 맞춘다
    const nonEmpty = block.lines.map((l) => l.trim()).filter((l) => l !== '');
    const first = nonEmpty.length === 1 ? nonEmpty[0] : null;
    const tokenIdx = first === null ? -1 : this.items.findIndex((it) => it.expect !== undefined && it.expect === first);
    if (tokenIdx >= 0) {
      for (const skipped of this.items.splice(0, tokenIdx)) skipped.settle?.({ ok: false, lines: ['no response'] });
      const item = this.items.shift()!;
      this.offset = block.num - item.num;
      item.settle?.({ ok: block.ok, lines: block.lines, seq: block.seq });
      return tokenIdx === 0 ? 'matched' : 'realigned';
    }
    if (head.expect !== undefined) {
      // 번호는 표지 자리와 같은데 내용만 다름(QA NEW-4 "got #22, expected #22"): 큐는 어긋나지 않았으므로 표지만 실패로 끝낸다
      if (this.offset !== null && block.num - this.offset === head.num) {
        this.items.shift();
        head.settle?.({ ok: false, lines: ['nonce mismatch', ...block.lines], seq: block.seq });
        return 'nonce-mismatch';
      }
      return 'drift'; // 표지 자리에 번호도 다른 응답
    }
    if (this.offset === null) this.offset = block.num - head.num;
    const want = block.num - this.offset;
    let idx = this.items.findIndex((it) => it.num === want);
    if (idx < 0) return 'drift';
    // send-keys는 성공하면 줄을 내지 않는다. 그 자리에 줄 있는 성공 응답이 오면 send-keys가 응답(번호)을 안 낸 것이므로
    // send-keys는 응답 없음으로 끝내고 다음 명령에 매칭한 뒤 번호 차이를 다시 맞춘다(QA NEW-3)
    if (block.ok && nonEmpty.length > 0 && SILENT_CMD_RE.test(this.items[idx].cmd) && idx + 1 < this.items.length) {
      idx += 1;
      this.offset = block.num - this.items[idx].num;
    }
    for (const skipped of this.items.splice(0, idx)) skipped.settle?.({ ok: false, lines: ['no response'] });
    const item = this.items.shift()!;
    const ok = block.ok || isBenignError(item.cmd, block.lines);
    item.settle?.({ ok, lines: block.lines, seq: block.seq });
    return idx === 0 ? 'matched' : 'skipped';
  }

  /** 남은 명령을 모두 실패로 끝낸다(연결 종료 시). */
  failAll(reason: string): void {
    const items = this.items;
    this.items = [];
    for (const it of items) it.settle?.({ ok: false, lines: [reason] });
  }

  get length(): number {
    return this.items.length;
  }

  /** 맨 앞 명령 이름(진단용). */
  get head(): string | undefined {
    return this.items[0]?.cmd;
  }

  /** 맨 앞 명령의 예상 번호(진단용). */
  get headNum(): number | undefined {
    return this.items[0] === undefined ? undefined : this.items[0].num + (this.offset ?? 0);
  }
}

/** 클라이언트 생성 옵션. */
export interface ControlClientOptions {
  psmuxPath: string;
  session: string;
  env: NodeJS.ProcessEnv;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** 응답이 이 시간 동안 하나도 없으면 연결 이상으로 본다. */
  stallMs?: number;
}

/**
 * psmux -CC 연결 하나. 이벤트: 'output'(pane, Buffer, seq), 'notify'(name, args), 'disconnected'(reason), 'ready'.
 * seq는 파싱한 이벤트마다 1씩 늘어나는 스트림 순번이다.
 */
export class ControlClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private readonly splitter = new LineSplitter();
  private readonly parser = new ControlParser();
  private readonly queue = new CommandQueue();
  private closedReason: string | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private nonce = 0;

  constructor(private readonly opts: ControlClientOptions) {
    super();
  }

  /** psmux -CC attach 프로세스를 시작한다. */
  start(): void {
    const { psmuxPath, session, env, log } = this.opts;
    // `-CC -t`는 -t를 무시하고, PSMUX_SESSION_NAME은 없는 이름이면 새 세션을 만든다.
    // `-CC attach -t`는 없는 세션이면 exit 1로 끝나고 세션을 만들지 않는다(실측) → has-session 확인 뒤 사라져도 안전
    this.proc = spawn(psmuxPath, ['-CC', 'attach', '-t', session], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of this.splitter.push(chunk)) {
        const ev = this.parser.feed(line);
        if (ev) this.handle(ev);
      }
    });
    this.proc.stderr?.on('data', (d: Buffer) => log('warn', `[cc ${session}] stderr: ${d.toString('utf8').trim().slice(0, 300)}`));
    this.proc.on('error', (e) => this.close(`spawn error: ${e.message}`));
    this.proc.on('exit', (code) => this.close(`process exit ${code}`));
    this.proc.stdin?.on('error', (e) => this.close(`stdin error: ${e.message}`));
    log('info', `[cc ${session}] started pid=${this.proc.pid}`);
  }

  private handle(ev: ControlEvent): void {
    const seq = ++this.seq;
    switch (ev.kind) {
      case 'block':
        if (ev.unsolicited) {
          this.emit('ready');
          return;
        }
        this.resetStall();
        this.onBlock({ ...ev, seq });
        return;
      case 'output':
        this.emit('output', ev.pane, ev.data, seq);
        return;
      case 'notify':
        this.emit('notify', ev.name, ev.args);
        return;
      case 'exit':
        this.close(`%exit ${ev.reason}`);
        return;
      case 'other':
        return;
    }
  }

  private onBlock(ev: { ok: boolean; lines: string[]; num: number; seq: number }): void {
    const expected = this.queue.headNum;
    const head = this.queue.head;
    const r = this.queue.resolve(ev);
    if (r === 'empty') this.opts.log('warn', `[cc ${this.opts.session}] response #${ev.num} without pending command`);
    else if (r === 'skipped') this.opts.log('warn', `[cc ${this.opts.session}] no response for commands before #${ev.num} (head: ${head?.split(' ').slice(0, 2).join(' ')})`);
    else if (r === 'realigned') this.opts.log('warn', `[cc ${this.opts.session}] queue realigned by nonce at #${ev.num} (head was: ${head?.split(' ').slice(0, 2).join(' ')})`);
    else if (r === 'nonce-mismatch') this.opts.log('warn', `[cc ${this.opts.session}] nonce reply #${ev.num} had other content; barrier failed, connection kept (${this.describe(ev)})`);
    else if (r === 'drift') {
      this.opts.log('warn', `[cc ${this.opts.session}] drift detail: ${this.describe(ev)}`);
      this.close(`protocol drift: got #${ev.num}, expected #${expected}`);
    }
  }

  /** 진단 로그용: 응답 블록 앞부분과 큐 상태. */
  private describe(ev: { ok: boolean; lines: string[]; num: number }): string {
    const body = ev.lines.slice(0, 3).map((l) => JSON.stringify(l.slice(0, 80))).join(', ');
    return `block ${ev.ok ? 'end' : 'error'} ${ev.lines.length} lines [${body}]; queue ${this.queue.length} head=${this.queue.head?.slice(0, 60) ?? '-'} #${this.queue.headNum ?? '-'}`;
  }

  private resetStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    if (this.queue.length > 0) this.armStall();
  }

  private armStall(): void {
    if (this.stallTimer) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.queue.length > 0) this.close(`stalled: no response for ${this.opts.stallMs ?? 15000}ms (head: ${this.queue.head?.slice(0, 60)})`);
    }, this.opts.stallMs ?? 15000);
  }

  /**
   * 명령 하나를 보내고 응답을 기다린다.
   *
   * Args:
   *   cmd: 한 줄 명령(줄바꿈 불가).
   *   timeoutMs: 호출자 대기 한도. 지나면 ok=false로 끝나지만 큐 자리는 유지된다.
   *
   * Returns:
   *   응답 결과. 연결이 없으면 ok=false.
   */
  command(cmd: string, timeoutMs = 10000, expect?: string): Promise<CommandResult> {
    if (/[\r\n]/.test(cmd)) return Promise.resolve({ ok: false, lines: ['newline in command'] });
    if (this.closedReason || !this.proc?.stdin?.writable) return Promise.resolve({ ok: false, lines: ['not connected'] });
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: CommandResult): void => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(r);
      };
      const h = this.queue.push(cmd, finish, expect);
      const t = setTimeout(() => {
        h.cancel();
        finish({ ok: false, lines: ['client timeout'] });
      }, timeoutMs);
      this.armStall();
      this.proc!.stdin!.write(cmd + '\n');
    });
  }

  /**
   * 표지 명령(display-message -p <nonce>)을 보내 응답 큐가 맞는지 확인한다. 앞에 응답 없는 명령이 있었으면 큐가 다시 맞춰진다.
   *
   * Returns:
   *   표지 응답을 제자리에서 받았으면 true.
   */
  async barrier(timeoutMs = 10000): Promise<boolean> {
    const token = `ctd-nonce-${++this.nonce}`;
    const r = await this.command(`display-message -p '${token}'`, timeoutMs, token);
    return r.ok && (r.lines[0] ?? '').trim() === token;
  }

  /** 연결을 끊는다(psmux 세션은 유지 = detach). */
  close(reason = 'closed by app'): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.queue.failAll(`disconnected: ${reason}`);
    const p = this.proc;
    if (p && p.exitCode === null) {
      try { p.stdin?.end(); } catch { /* 이미 닫힘 */ }
      setTimeout(() => { if (p.exitCode === null) p.kill(); }, 3000).unref();
    }
    this.opts.log(reason === 'closed by app' ? 'info' : 'warn', `[cc ${this.opts.session}] disconnected: ${reason}`);
    this.emit('disconnected', reason);
  }

  get connected(): boolean {
    return this.closedReason === null && this.proc !== null;
  }

  /** psmux -CC 프로세스 ID(진단·통합 테스트용). */
  get pid(): number | undefined {
    return this.proc?.pid;
  }
}
