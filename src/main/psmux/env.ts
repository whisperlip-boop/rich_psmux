// psmux·pwsh·node 실행 경로와 환경변수 정리.

import { execFile } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { msg, resolveMsg, type Msg } from '../../shared/i18n';
import { log } from '../logger';

/**
 * 바깥 psmux·Claude Code 세션 변수가 새 세션에 새지 않게 정리한 환경변수.
 * SHELL이 남으면 psmux 기본 셸이 bash가 되고, CLAUDECODE·CLAUDE_CODE_SESSION_ID 등이 세션에 들어간다.
 *
 * Args:
 *   base: 원본 환경변수.
 *   extra: 덧붙일 값.
 */
export function cleanEnv(base: NodeJS.ProcessEnv = process.env, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(env)) {
    const u = k.toUpperCase();
    if (u === 'SHELL' || u.startsWith('TMUX') || u.startsWith('PSMUX_') || u === 'CLAUDECODE' || u === 'AI_AGENT' ||
        u.startsWith('ELECTRON_') || (u.startsWith('CLAUDE_') && u !== 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS')) {
      delete env[k];
    }
  }
  return { ...env, ...extra };
}

/** 경로 확인 결과: 있음 / 없음 / 시간 초과(끊긴 네트워크 경로 등) / 앞선 네트워크 경로 확인이 아직 안 끝나 확인하지 않음. */
export type PathProbe = 'ok' | 'missing' | 'timeout' | 'busy';

/** 확인하지 못한 이유(사용자 문구 괄호 안에 넣는 현재 UI 언어 문구). 있음·없음이면 null. */
export function unreachableReason(r: PathProbe): string | null {
  const m = unreachableMsg(r);
  return m ? resolveMsg(m) : null;
}

/** unreachableReason의 번역 전 문구(상태로 남는 안내에 넣어 언어를 바꾸면 다시 번역되게). 있음·없음이면 null. */
export function unreachableMsg(r: PathProbe): Msg | null {
  if (r === 'timeout') return msg('env.timeout', { n: PATH_TIMEOUT_MS / 1000 });
  if (r === 'busy') return msg('env.busy');
  return null;
}

/** 경로 확인 시간 제한(ms). 연결되지 않은 UNC 경로는 OS가 5~6초 뒤에야 실패를 돌려준다. */
export const PATH_TIMEOUT_MS = 2000;

/** 시간 제한 안에 끝나지 않으면 'timeout'. 늦게 끝난 원래 작업의 결과·오류는 버린다. */
export async function probe(check: Promise<boolean>, ms: number): Promise<PathProbe> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), ms); });
  try {
    return await Promise.race([check.then((ok): PathProbe => (ok ? 'ok' : 'missing'), (): PathProbe => 'missing'), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 실행 파일이 있는지(비동기, main 스레드를 막지 않음). Microsoft Store 앱 실행 별칭(예: %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe,
 * 기본 pwsh 위치)은 reparse point라 stat이 EACCES이고 existsSync가 false를 돌려준다(실측). 이때는 lstat이 되면 있는 것으로 본다.
 */
export async function executableExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EACCES') return false;
    try {
      return (await lstat(p)).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

/** 폴더가 있는지(비동기). */
export async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 네트워크(UNC) 경로인지. \\?\C:\ 같은 로컬 확장 경로는 제외하고 \\?\UNC\는 포함. 매핑된 네트워크 드라이브(Z:)는 구분하지 못한다. */
export function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p) && !/^[\\/]{2}[?.][\\/](?!UNC[\\/])/i.test(p);
}

/** 진행 중인 확인(같은 경로를 다시 확인하면 새 stat을 내지 않고 공유). 끝나면 지운다. */
const inflight = new Map<string, Promise<boolean>>();
/** 진행 중인 UNC 확인 수(최대 1). */
let uncActive = 0;

/**
 * 시간 제한 + 중복·동시 실행 제한이 있는 경로 확인.
 * 시간 제한은 기다림만 끊고 응답 없는 UNC stat은 libuv 스레드 풀(기본 4개)에 OS 실패(5~6초 이상)까지 남는다.
 * 그래서 같은 경로는 진행 중인 확인을 공유하고, UNC 확인은 동시에 1개만 실행해 로컬 경로 확인용 스레드를 남긴다.
 * UNC 확인이 진행 중이면 다른 UNC 경로는 stat을 내지 않고 바로 'busy'.
 *
 * Args:
 *   key: 진행 중 확인 공유 키(종류 + 경로).
 *   unc: 네트워크 경로 여부.
 *   start: 실제 확인 시작.
 *   ms: 시간 제한.
 */
export function guardedProbe(key: string, unc: boolean, start: () => Promise<boolean>, ms: number): Promise<PathProbe> {
  let check = inflight.get(key);
  if (!check) {
    if (unc && uncActive > 0) return Promise.resolve('busy');
    if (unc) uncActive++;
    check = start().finally(() => {
      inflight.delete(key);
      if (unc) uncActive--;
    });
    inflight.set(key, check);
  }
  return probe(check, ms);
}

/** 시간 제한이 있는 실행 파일 확인. */
export function probeExecutable(p: string, ms: number = PATH_TIMEOUT_MS): Promise<PathProbe> {
  return guardedProbe(`file:${p.toLowerCase()}`, isUncPath(p), () => executableExists(p), ms);
}

/** 시간 제한이 있는 폴더 확인. */
export function probeDir(p: string, ms: number = PATH_TIMEOUT_MS): Promise<PathProbe> {
  return guardedProbe(`dir:${p.toLowerCase()}`, isUncPath(p), () => dirExists(p), ms);
}

/**
 * PATH에서 실행 파일 찾기(where.exe, 비동기).
 * PATH의 UNC 실행 파일은 지원 범위 밖: 건너뛰어 UNC 확인 자리(동시 1개)를 쓰지 않는다(설정의 UNC 확인이 busy로 막히지 않게).
 */
async function where(exe: string, accept: (p: string) => boolean = () => true): Promise<string | null> {
  const out = await new Promise<string>((res) => {
    execFile('where.exe', [exe], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: cleanEnv() }, (err, stdout) => res(err ? '' : stdout));
  });
  for (const s of out.split(/\r?\n/).map((x) => x.trim())) {
    if (!s || isUncPath(s) || !accept(s)) continue;
    if ((await probeExecutable(s)) === 'ok') return s;
  }
  return null;
}

/** psmux 실행 파일: 설정값 → PATH → winget 기본 위치. 없으면(설정값이 응답 없음이어도) null. */
export async function resolvePsmux(configured?: string): Promise<string | null> {
  if (configured) {
    const r = await probeExecutable(configured);
    if (r === 'ok') return configured;
    if (r === 'timeout') log('warn', `psmux path did not respond within ${PATH_TIMEOUT_MS}ms; falling back to PATH`);
    if (r === 'busy') log('warn', 'psmux path not checked (previous network path check still running); falling back to PATH');
  }
  const onPath = await where('psmux');
  if (onPath) return onPath;
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const p = join(local, 'Microsoft', 'WinGet', 'Packages', 'marlocarlo.psmux_Microsoft.Winget.Source_8wekyb3d8bbwe', 'psmux.exe');
  return (await probeExecutable(p)) === 'ok' ? p : null;
}

/** hook 실행용 node: PATH의 node. 없으면 null(→ Electron을 node 모드로 사용). */
export function resolveNode(): Promise<string | null> {
  return where('node');
}

/**
 * Claude Code CLI(로그인·로그아웃): PATH의 claude 중 실행할 수 있는 형식(.exe, npm 설치의 .cmd)만.
 * npm 설치는 확장자 없는 sh 스크립트(claude)도 PATH에 있어 그것은 건너뛴다. 설정의 리드 명령과 무관.
 */
export function resolveClaude(): Promise<string | null> {
  return where('claude', (p) => /\.(exe|cmd)$/i.test(p));
}

/** asar 안 경로를 asarUnpack 사본 경로로 바꾼다(…\app.asar\… → …\app.asar.unpacked\…). asar 밖 경로는 그대로. */
export function asarUnpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar(?=[\\/])/i, '$1app.asar.unpacked');
}
