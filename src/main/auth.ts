// 로그아웃·로그인(~/.claude 읽기 전용 원칙의 예외): 앱은 자격 증명 파일을 직접 읽거나 쓰지 않고 Claude Code CLI만 실행한다.
// claude auth status(JSON)에서는 loggedIn 하나만 꺼내고, CLI 출력 본문은 로그에 남기지 않는다(종료 코드만).

import { execFile } from 'node:child_process';

import { cleanEnv } from './psmux/env';
import { shellMatches } from './psmux/panes';

/** CLI 실행 결과. */
export interface CliRun {
  /** 종료 코드(실행 자체를 못 했거나 시간 초과면 null). */
  code: number | null;
  stdout: string;
  timedOut: boolean;
  /** 실행 실패 원인 코드(ENOENT 등, 로그용). */
  reason?: string;
}

/** 로그아웃 시간 제한(ms). */
export const LOGOUT_TIMEOUT_MS = 15000;
/** 상태 확인 시간 제한(ms). */
export const STATUS_TIMEOUT_MS = 10000;

/**
 * claude 실행 형태. .exe는 셸 없이 직접, npm 설치의 .cmd는 Node가 셸 없이 실행할 수 없어(CVE-2024-27980 이후 EINVAL)
 * cmd.exe /d /s /c "\"<경로>\" <인자>"로 감싼다. 인자는 고정 토큰만 허용(사용자 입력 없음), 경로는 where.exe 결과(Windows 경로에 " 불가).
 *
 * Args:
 *   cli: claude 실행 파일 경로(.exe/.cmd).
 *   args: 고정 인자(영문 소문자·하이픈).
 *
 * Raises:
 *   Error: 허용하지 않는 인자·경로.
 */
export function claudeInvocation(cli: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (!args.every((a) => /^-{0,2}[a-z]+$/.test(a))) throw new Error('unsupported claude argument');
  if (cli.includes('"')) throw new Error('unsupported claude path');
  if (/\.exe$/i.test(cli)) return { file: cli, args, verbatim: false };
  if (/\.cmd$/i.test(cli)) return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `""${cli}" ${args.join(' ')}"`], verbatim: true };
  throw new Error('unsupported claude executable type');
}

/** claude를 실행해 종료 코드와 stdout을 받는다(예외 없음). */
export function runClaude(cli: string, args: string[], timeoutMs: number): Promise<CliRun> {
  let inv: ReturnType<typeof claudeInvocation>;
  try {
    inv = claudeInvocation(cli, args);
  } catch (e) {
    return Promise.resolve({ code: null, stdout: '', timedOut: false, reason: e instanceof Error ? e.message : 'invalid' });
  }
  return new Promise((res) => {
    execFile(inv.file, inv.args, {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: cleanEnv(), windowsVerbatimArguments: inv.verbatim,
    }, (err, stdout) => {
      if (!err) return res({ code: 0, stdout, timedOut: false });
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
      // 출력이 상한(1MB)을 넘으면 Node가 프로세스를 끝내고 killed도 true다 → 시간 초과와 구분
      if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return res({ code: null, stdout: '', timedOut: false, reason: 'maxBuffer' });
      if (e.killed || e.signal) return res({ code: null, stdout: '', timedOut: true, reason: 'timeout' });
      if (typeof e.code === 'number') return res({ code: e.code, stdout, timedOut: false });
      res({ code: null, stdout: '', timedOut: false, reason: typeof e.code === 'string' ? e.code : 'error' });
    });
  });
}

/** `claude auth status --json` 출력에서 loggedIn만 꺼낸다(형식이 다르면 null). 다른 필드(이메일·조직 등)는 쓰지 않는다. */
export function parseAuthStatus(stdout: string): boolean | null {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown> | null;
    return j && typeof j.loggedIn === 'boolean' ? j.loggedIn : null;
  } catch {
    return null;
  }
}

/** 로그인 상태: CLI 확인값이 있으면 그것, 없으면(CLI 없음·실패) ~/.claude.json 이메일 유무. */
export function loggedInFrom(status: boolean | null, email: string | null): boolean {
  return status ?? email !== null;
}

/** 칸 명령이 셸(로그인 프로세스가 끝나 돌아온 상태)인지: pwsh/powershell 또는 설정한 셸. */
export function isShellCommand(command: string, configuredShell: string | null): boolean {
  if (/^(pwsh|powershell)(\.exe)?$/i.test(command.trim())) return true;
  return !!configuredShell && shellMatches(command, configuredShell);
}

/** 로그인 칸 감시 상태. */
export interface LoginWatch {
  /** 셸이 아닌 프로그램(claude·cmd 등)이 실행 중인 것을 한 번이라도 봤는지. */
  sawProgram: boolean;
  /** 감시 시작 시각(ms). */
  since: number;
}

/** 프로그램을 보지 못했어도 이 시간이 지나 셸이면 끝난 것으로 본다(바로 실패해 폴링이 놓친 경우). */
export const LOGIN_GRACE_MS = 15000;

/**
 * 로그인 칸 감시 한 단계(순수 함수). 셸이 아닌 프로그램을 본 뒤 셸로 돌아오면 끝.
 *
 * Args:
 *   w: 이전 상태.
 *   command: 칸의 pane_current_command(모르면 빈 문자열).
 *   shell: 그 명령이 셸인지.
 *   now: 현재 시각(ms).
 *
 * Returns:
 *   다음 상태와 끝났는지.
 */
export function stepLogin(w: LoginWatch, command: string, shell: boolean, now: number): { w: LoginWatch; done: boolean } {
  if (!command.trim()) return { w, done: false };
  if (!shell) return { w: { ...w, sawProgram: true }, done: false };
  return { w, done: w.sawProgram || now - w.since >= LOGIN_GRACE_MS };
}
