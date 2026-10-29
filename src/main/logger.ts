// 앱 로그: <앱 데이터>/logs/app.log (5MB 넘으면 app.1.log로 교체). 대화 내용(입출력 본문)은 기록하지 않는다.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 로그 수준. */
export type LogLevel = 'info' | 'warn' | 'error';

const MAX_BYTES = 5 * 1024 * 1024;
let logFile: string | null = null;
let echo = false;

/**
 * 로그 파일 위치를 정한다.
 *
 * Args:
 *   dir: 로그 폴더.
 *   echoToConsole: 콘솔에도 출력(개발용).
 */
export function initLogger(dir: string, echoToConsole = false): void {
  mkdirSync(dir, { recursive: true });
  logFile = join(dir, 'app.log');
  echo = echoToConsole;
}

/** 한 줄 기록. 기록 실패는 앱 동작을 막지 않는다. */
export function log(level: LogLevel, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  if (echo || !logFile) (level === 'error' ? console.error : console.log)(line.trimEnd());
  if (!logFile) return;
  try {
    try {
      if (statSync(logFile).size > MAX_BYTES) renameSync(logFile, logFile.replace(/\.log$/, '.1.log'));
    } catch { /* 파일 없음 */ }
    appendFileSync(logFile, line);
  } catch { /* 디스크 오류 무시 */ }
}

/** 예외 메시지만 꺼낸다(스택은 error 수준에서만). */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
