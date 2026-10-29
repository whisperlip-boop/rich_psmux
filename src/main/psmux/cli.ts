// control mode 밖에서 필요한 psmux CLI 호출(세션 생성·확인·목록). 셸을 거치지 않는 execFile.

import { execFile } from 'node:child_process';

import { cleanEnv } from './env';

/** CLI 결과. */
export interface CliResult {
  code: number;
  out: string;
  err: string;
}

/**
 * psmux CLI 1회 실행.
 *
 * Args:
 *   psmux: 실행 파일 경로.
 *   args: 인자(셸 해석 없음).
 *   timeoutMs: 제한 시간.
 */
export function psmuxCli(psmux: string, args: string[], timeoutMs = 15000): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(psmux, args, { env: cleanEnv(), encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, out: (stdout ?? '').trim(), err: (stderr ?? '').trim() || (error ? error.message : '') });
    });
  });
}

/** 세션 존재 확인(없는 이름으로 -CC 연결하면 새 세션이 생기므로 연결 전에 반드시 확인). */
export async function hasSession(psmux: string, name: string): Promise<boolean> {
  return (await psmuxCli(psmux, ['has-session', '-t', name])).code === 0;
}

/** 세션 이름 목록(조회 전용). */
export async function listSessionNames(psmux: string): Promise<string[]> {
  const r = await psmuxCli(psmux, ['list-sessions', '-F', '#{session_name}']);
  if (r.code !== 0) return [];
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
