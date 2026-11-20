// control mode 밖에서 필요한 psmux CLI 호출(세션 생성·확인·목록). 셸을 거치지 않는 execFile.

import { execFile } from 'node:child_process';

import { log } from '../logger';
import { cleanEnv } from './env';

/** CLI 결과. */
export interface CliResult {
  code: number;
  out: string;
  err: string;
}

/** 이보다 오래 main을 막은 psmux 프로세스 생성만 로그에 남긴다(ms, 실측 보통 13~60). */
const SLOW_SPAWN_MS = 100;

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
    const t0 = Date.now();
    execFile(psmux, args, { env: cleanEnv(), encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, out: (stdout ?? '').trim(), err: (stderr ?? '').trim() || (error ? error.message : '') });
    });
    // 프로세스 생성(CreateProcess)은 main 스레드를 막는다: 느린 경우만 남겨 기동 지연의 원인인지 로그로 확인한다
    const ms = Date.now() - t0;
    if (ms >= SLOW_SPAWN_MS) log('warn', `psmux ${args[0] ?? ''} spawn blocked main ${ms} ms`);
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
