// usage.json 원자적 기록(임시 파일 → rename). statusline 스크립트와 main이 같이 쓰므로 electron·logger에 의존하지 않는다.
// 스크립트는 동기 + 짧은 재시도(writeUsageAtomicSync), main은 비동기 1회 시도(writeUsageAtomic, main 스레드를 막지 않음).

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { UsageRecord } from '../shared/usage';

/** 사용량 파일 이름(앱 데이터 폴더 바로 아래). */
export const USAGE_FILE = 'usage.json';

/** 같은 폴더의 고유 임시 파일 이름. */
function tmpName(file: string): string {
  return `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
}

/** 허용 필드만 남긴 본문(5시간·7일 값과 받은 시각). */
function bodyOf(rec: UsageRecord): string {
  const body: UsageRecord = { v: 1, at: rec.at, fiveHour: rec.fiveHour, sevenDay: rec.sevenDay };
  return JSON.stringify(body);
}

/**
 * statusline 스크립트 전용: 동기로 원자적 기록. Windows에서 다른 프로세스가 대상 파일을 열고 있으면 rename이
 * EPERM/EACCES/EBUSY로 실패할 수 있어 짧게(최대 4번, 합계 약 200ms) 다시 시도한다. 짧게 끝나는 별도 프로세스라 동기 대기를 써도 된다.
 *
 * Args:
 *   file: usage.json 절대 경로.
 *   rec: 기록할 레코드.
 *
 * Raises:
 *   Error: 폴더 생성·쓰기·rename이 끝내 실패할 때(임시 파일은 지운다).
 */
export function writeUsageAtomicSync(file: string, rec: UsageRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = tmpName(file);
  writeFileSync(tmp, bodyOf(rec));
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 4 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
}

/**
 * main 전용: 비동기로 원자적 기록을 1번 시도한다(재시도·동기 대기 없음, 리뷰 m-3). 실패하면 임시 파일을 지우고 예외를 그대로 던진다.
 *
 * Args:
 *   file: usage.json 절대 경로.
 *   rec: 기록할 레코드.
 *
 * Raises:
 *   Error: 폴더 생성·쓰기·rename 실패.
 */
export async function writeUsageAtomic(file: string, rec: UsageRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    await writeFile(tmp, bodyOf(rec));
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
