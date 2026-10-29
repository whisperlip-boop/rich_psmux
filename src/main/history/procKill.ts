// 히스토리 "세션 끊기…"의 psmux 밖 Claude Code 프로세스 종료: 프로세스 정보 확인(PowerShell CIM 1회) → 트리 종료(taskkill).
// 셸을 거치지 않는 execFile, 실행 파일은 System32 절대 경로(PATH에 같은 이름 프로그램이 있어도 그것을 실행하지 않게).

import { execFile } from 'node:child_process';
import { join } from 'node:path';

import { isKillablePid, type StopFailCode } from './running';

/** Claude Code로 인정하는 프로세스 이미지 이름(소문자). 네이티브 설치는 claude.exe, npm 설치는 node.exe. */
const CLAUDE_IMAGES = new Set(['claude.exe', 'claude', 'node.exe', 'node']);
/** 조상 확인에서 부모를 따라 올라가는 최대 단계(부모 pid 재사용으로 생길 수 있는 순환 차단). */
const MAX_ANCESTOR_HOPS = 64;

const system32 = (...p: string[]): string => join(process.env.SystemRoot ?? 'C:\Windows', 'System32', ...p);

/** 종료 판정에 쓰는 대상 프로세스 정보(Win32_Process). */
export interface ProcessInfo {
  name: string;
  /** 다른 사용자·관리자 프로세스면 읽지 못해 빈 문자열. */
  commandLine: string;
  /** 프로세스 생성 시각(epoch ms, UTC). */
  createdMs: number;
  /** 대상이 이 앱의 조상(또는 자신)인지. /T 트리 종료가 앱까지 끝내지 않게 거부한다. */
  isAncestor: boolean;
}

/** 이미지 이름이 Claude Code 프로세스로 볼 수 있는 이름인지(대소문자 무시). */
export function isClaudeImage(name: string | null): boolean {
  return !!name && CLAUDE_IMAGES.has(name.trim().toLowerCase());
}

/**
 * 대상 프로세스 정보를 JSON 한 줄로 내는 PowerShell 스크립트. 숫자 외 데이터는 넣지 않는다(검증된 정수만 보간).
 *
 * Args:
 *   pid: 대상 pid.
 *   appPid: 이 앱(main) pid. 여기서 부모를 따라 올라가며 대상이 조상인지 본다.
 *
 * Returns:
 *   한 줄 스크립트(큰따옴표 없음: execFile 인자 인용과 겹치지 않게). 대상이 없으면 `null`을 출력한다.
 *
 * Raises:
 *   Error: pid·appPid가 종료 가능한 정수 형식이 아닐 때.
 */
export function processInfoScript(pid: number, appPid: number): string {
  if (!isKillablePid(pid) || !isKillablePid(appPid)) throw new Error('invalid pid');
  return [
    '$ErrorActionPreference=\'Stop\'',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    `$t=[long]${pid}`,
    `$c=[long]${appPid}`,
    '$all=@{}',
    'foreach($q in Get-CimInstance Win32_Process){$all[[long]$q.ProcessId]=$q}',
    '$p=$all[$t]',
    'if($null -eq $p){\'null\';exit 0}',
    '$anc=$false',
    `for($i=0;$i -lt ${MAX_ANCESTOR_HOPS} -and $null -ne $all[$c];$i++){if($c -eq $t){$anc=$true;break};$n=[long]$all[$c].ParentProcessId;if($n -le 0 -or $n -eq $c){break};$c=$n}`,
    '$cd=$null',
    'if($p.CreationDate){$cd=$p.CreationDate.ToUniversalTime().ToString(\'o\')}',
    '[pscustomobject]@{Name=$p.Name;CommandLine=$p.CommandLine;CreationDate=$cd;IsAncestor=$anc}|ConvertTo-Json -Compress',
  ].join(';');
}

/**
 * processInfoScript 출력을 해석한다.
 *
 * Args:
 *   out: PowerShell 표준 출력.
 *
 * Returns:
 *   프로세스 정보, 'gone'(대상 없음), null(해석 불가: Name·CreationDate·IsAncestor 누락·형식 오류, JSON 아님).
 */
export function parseProcessInfo(out: string): ProcessInfo | 'gone' | null {
  const s = out.replace(/^\uFEFF/, '').trim();
  if (s === 'null') return 'gone';
  let j: unknown;
  try {
    j = JSON.parse(s);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (typeof o.Name !== 'string' || typeof o.CreationDate !== 'string' || typeof o.IsAncestor !== 'boolean') return null;
  if (o.CommandLine !== null && o.CommandLine !== undefined && typeof o.CommandLine !== 'string') return null;
  // 'o' 형식 UTC(…Z)만 받는다: 시간대 없는 문자열은 로컬 시각으로 해석돼 비교가 틀어진다
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(o.CreationDate)) return null;
  const createdMs = Date.parse(o.CreationDate);
  if (!Number.isFinite(createdMs)) return null;
  return { name: o.Name, commandLine: o.CommandLine ?? '', createdMs, isAncestor: o.IsAncestor };
}

/**
 * 종료해도 되는지 판정한다(모두 만족해야 허용).
 *
 * Args:
 *   info: 대상 프로세스 정보.
 *   sessionFileMtimeMs: sessions/<pid>.json 수정 시각(epoch ms). 파일은 프로세스가 시작된 뒤에 쓰이므로
 *     그보다 늦게 생긴 프로세스는 pid만 재사용된 다른 프로세스다.
 *
 * Returns:
 *   null = 허용, 아니면 거부 사유 코드(not-claude·pid-mismatch·self).
 */
export function judgeKill(info: ProcessInfo, sessionFileMtimeMs: number): StopFailCode | null {
  if (!isClaudeImage(info.name) || !info.commandLine.toLowerCase().includes('claude')) return 'not-claude';
  if (!Number.isFinite(sessionFileMtimeMs) || info.createdMs > sessionFileMtimeMs) return 'pid-mismatch';
  if (info.isAncestor) return 'self';
  return null;
}

/**
 * psmux 경로(외부 psmux·앱 세션)의 pid 확인: 세션 파일보다 늦게 생긴 프로세스면 pid-mismatch, 앱 조상이면 self.
 * 이름·명령줄은 보지 않는다(tmux 필드의 pid가 칸 셸일 수 있음).
 */
export function judgeOwner(info: ProcessInfo, sessionFileMtimeMs: number): StopFailCode | null {
  if (!Number.isFinite(sessionFileMtimeMs) || info.createdMs > sessionFileMtimeMs) return 'pid-mismatch';
  if (info.isAncestor) return 'self';
  return null;
}

/**
 * 끊기 거부가 "이 세션 파일의 pid는 그 Claude Code가 아님"으로 확정인지(→ 실행 목록에서 제외).
 * 생성 시각 불일치, 이미지 이름 불일치, 읽힌 명령줄에 `claude` 없음(Claude Code 본 프로세스 명령줄에는 항상 있음)은 확정.
 * 명령줄을 못 읽었거나(빈 문자열) 조상·실행 실패는 실제 실행 중일 수 있어 아니다.
 */
export function isDefinitiveRefusal(code: StopFailCode | null, info: ProcessInfo): boolean {
  if (code === 'pid-mismatch') return true;
  if (code !== 'not-claude') return false;
  return !isClaudeImage(info.name) || (info.commandLine !== '' && !info.commandLine.toLowerCase().includes('claude'));
}

function run(exe: string, args: string[], timeout = 10000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(exe, args, { encoding: 'utf8', windowsHide: true, timeout }, (error, stdout) => {
      const c = error ? (error as NodeJS.ErrnoException).code : 0;
      resolve({ code: typeof c === 'number' ? c : error ? 1 : 0, out: stdout ?? '' });
    });
  });
}

/** 대상 프로세스 정보(PowerShell CIM 1회). 'gone' = 대상 없음, null = 실행·해석 실패. */
export async function queryProcess(pid: number, appPid: number): Promise<ProcessInfo | 'gone' | null> {
  if (!isKillablePid(pid) || !isKillablePid(appPid)) return null;
  const ps = system32('WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', processInfoScript(pid, appPid)], 20000);
  return r.code === 0 ? parseProcessInfo(r.out) : null;
}

/** pid와 자식 프로세스를 강제 종료(taskkill /T /F). 종료 코드 0이면 true. */
export async function killProcessTree(pid: number): Promise<boolean> {
  if (!isKillablePid(pid)) return false;
  return (await run(system32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'])).code === 0;
}
