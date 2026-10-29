// 붙여넣기 이미지 저장소: <앱 데이터>/clips/<ISO시각>-<6자>.png. 7일 지난 파일은 앱 시작 시 정리. ~/.claude 와 무관.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { clipFileName, staleClipNames } from '../shared/attach';
import { errMsg, log } from './logger';

/** 붙여넣기 이미지 폴더. */
export function clipsDir(dataDir: string): string {
  return join(dataDir, 'clips');
}

/**
 * PNG 바이트를 새 파일로 저장한다(이름 충돌 없음: 시각 + 랜덤 6자).
 *
 * Returns:
 *   저장한 절대 경로.
 *
 * Raises:
 *   Error: 폴더 생성·쓰기 실패.
 */
export function saveClipPng(dataDir: string, png: Buffer, now = new Date()): string {
  const dir = clipsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, clipFileName(now, randomBytes(3).toString('hex')));
  writeFileSync(p, png, { flag: 'wx' });
  log('info', `clip image saved ${p} (${png.length} bytes)`);
  return p;
}

/** 오래된 붙여넣기 이미지 정리(앱이 만든 이름 형식만). 실패는 로그만. 지운 개수를 돌려준다. */
export function cleanupClips(dataDir: string, nowMs = Date.now(), maxAgeDays = 7): number {
  const dir = clipsDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const entries: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) entries.push({ name, mtimeMs: st.mtimeMs });
    } catch { /* 사라진 파일 */ }
  }
  let n = 0;
  for (const name of staleClipNames(entries, nowMs, maxAgeDays)) {
    try {
      rmSync(join(dir, name), { force: true });
      n++;
    } catch (e) {
      log('warn', `clip cleanup failed ${name}: ${errMsg(e)}`);
    }
  }
  if (n) log('info', `clips: removed ${n} file(s) older than ${maxAgeDays} days`);
  return n;
}
