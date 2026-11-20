// 잠자기 막기(설정: 끔 / 에이전트가 작업하는 동안 / 항상). Electron powerSaveBlocker는 호출부가 넣는다(단위 테스트 대상).
// prevent-app-suspension: 시스템 잠자기만 막고 화면은 꺼질 수 있다(자리를 비운 동안 에이전트 작업에 필요한 만큼만).

import type { KeepAwakeMode } from '../shared/api';
import { log } from './logger';

/**
 * 에이전트 모드에서 작업이 멈춘 뒤 막기를 유지하는 시간. "작업 중"은 최근 2.5초 안 출력 기준이라 잠깐씩 끊기는데,
 * 막기를 푸는 순간 사용자 입력이 오래 없었으면 Windows가 바로 잠들 수 있어 짧은 끊김에는 풀지 않는다.
 */
export const AGENT_GRACE_MS = 60_000;

/** 잠자기를 막아야 하는지. */
export function wantAwake(mode: KeepAwakeMode, anyWorking: boolean, lastWorkingAt: number, now: number): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return anyWorking || now - lastWorkingAt < AGENT_GRACE_MS;
}

/** powerSaveBlocker 중 쓰는 부분. */
export interface Blocker {
  start(): number;
  stop(id: number): void;
}

/** 막기 상태 관리: update를 탭 상태가 바뀔 때·설정 저장 때 부르고, 종료 때 release. */
export class KeepAwake {
  private id: number | null = null;
  private lastWorkingAt = 0;
  private timer: NodeJS.Timeout | null = null;
  /** 시작이 실패한 모드(같은 모드에서는 탭 상태마다 다시 시도·기록하지 않음, 모드가 바뀌면 다시 시도). */
  private failedMode: KeepAwakeMode | null = null;

  constructor(private readonly blocker: Blocker, private readonly now: () => number = Date.now) {}

  /** 지금 막고 있는지. */
  get active(): boolean {
    return this.id !== null;
  }

  /**
   * 설정과 작업 여부로 막기를 켜거나 끈다. 에이전트 모드에서 작업이 멈췄으면 유예가 끝날 때 다시 확인한다.
   *
   * Args:
   *   mode: 설정값.
   *   anyWorking: 열린 탭 중 작업 중인 칸이 있는지.
   */
  update(mode: KeepAwakeMode, anyWorking: boolean): void {
    const t = this.now();
    if (anyWorking) this.lastWorkingAt = t;
    const want = wantAwake(mode, anyWorking, this.lastWorkingAt, t);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.failedMode !== null && this.failedMode !== mode) this.failedMode = null;
    if (want && this.id === null && this.failedMode === null) {
      try {
        this.id = this.blocker.start();
        log('info', `keep awake on (${mode})`);
      } catch (e) {
        this.failedMode = mode;
        log('warn', `keep awake start failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (!want) {
      this.release();
    }
    if (want && mode === 'agent' && !anyWorking) {
      this.timer = setTimeout(() => this.update(mode, false), Math.max(0, AGENT_GRACE_MS - (t - this.lastWorkingAt)) + 50);
    }
  }

  /** 막기를 푼다(설정 끔·작업 없음·탭 모두 닫힘·앱 종료). 지난 작업 시각도 잊어 유예 때문에 다시 잡지 않는다. */
  release(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastWorkingAt = 0;
    if (this.id === null) return;
    try {
      this.blocker.stop(this.id);
    } catch (e) {
      log('warn', `keep awake stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.id = null;
    log('info', 'keep awake off');
  }
}
