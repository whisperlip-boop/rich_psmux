// 업데이트 순차 실행: 고정 순서(claude → psmux → pwsh)로 한 번에 하나씩, 실패해도 다음 단계로, 중지하면 남은 단계는 건너뛴다.
// 실제 프로세스 실행은 주입(exec)으로 받아 이 모듈은 순서·상태만 맡는다(단위 테스트 대상).

import type { UpdateRunDto, UpdateStepDto, UpdateStepId } from '../../shared/api';

/** 실행 순서(D6): Claude Code는 세션 종료가 필요 없고, PowerShell MSI는 UAC·재부팅 요구 가능성이 있어 맨 뒤. */
export const STEP_ORDER: readonly UpdateStepId[] = ['claude', 'psmux', 'pwsh'];

/** 세션을 모두 닫아야 하는 단계(psmux 서버 exe·셸 exe를 교체). */
export const NEEDS_SESSION_CLOSE: ReadonlySet<UpdateStepId> = new Set<UpdateStepId>(['psmux', 'pwsh']);

/** 단계 하나 실행: 종료 코드(0 = 성공). signal이 켜지면 프로세스를 끝내고 돌아와야 한다. 예외는 실패로 본다. */
export type StepExec = (step: UpdateStepId, signal: AbortSignal) => Promise<number | null>;

/** 체크한 단계를 실행 순서로 정렬·중복 제거(알 수 없는 값은 버림). */
export function orderSteps(steps: readonly unknown[]): UpdateStepId[] {
  return STEP_ORDER.filter((s) => steps.includes(s));
}

/** 중지 뒤 단계가 끝나기를 기다리는 최대 시간(ms). 넘으면 그 단계를 실패로 보고 실행을 끝낸다. */
export const ABORT_GRACE_MS = 5000;

/**
 * 단계 결과: 중지 신호가 온 뒤 graceMs 안에 끝나지 않으면 null(실패)로 마무리한다. UAC로 권한이 올라간 설치 프로그램처럼
 * 종료할 수 없는 프로세스가 남아도 실행(과 세션 잠금)이 영원히 "실행 중"으로 남지 않게. 예외도 null.
 */
export function settleAfterAbort(work: Promise<number | null>, signal: AbortSignal, graceMs: number): Promise<number | null> {
  return new Promise((res) => {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => { timer = setTimeout(() => res(null), graceMs); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    work.then(res, () => res(null)).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/** 순차 실행기. 동시에 하나만 실행한다. */
export class UpdateRunner {
  private cur: UpdateRunDto | null = null;
  private abort: AbortController | null = null;

  /**
   * Args:
   *   exec: 단계 실행.
   *   onState: 상태가 바뀔 때마다(시작·단계 시작/끝·완료). 예외를 던져도 실행은 계속된다.
   *   abortGraceMs: 중지 뒤 단계가 끝나기를 기다리는 최대 시간.
   */
  constructor(private readonly exec: StepExec, private readonly onState: (r: UpdateRunDto) => void, private readonly abortGraceMs = ABORT_GRACE_MS) {}

  /** 실행 중인지. */
  get running(): boolean {
    return this.cur?.status === 'running';
  }

  /** 마지막(또는 진행 중) 실행 상태 사본. */
  state(): UpdateRunDto | null {
    return this.cur ? { ...this.cur, steps: this.cur.steps.map((s) => ({ ...s })) } : null;
  }

  /**
   * 실행 시작. 이미 실행 중이거나 단계가 없으면 null(시작하지 않음).
   *
   * Returns:
   *   끝날 때(완료·중지) 최종 상태로 풀리는 Promise, 시작하지 않았으면 null.
   */
  start(steps: readonly UpdateStepId[]): Promise<UpdateRunDto> | null {
    const list = orderSteps(steps);
    if (this.running || !list.length) return null;
    this.cur = { status: 'running', steps: list.map((id): UpdateStepDto => ({ id, status: 'pending' })), ok: 0, fail: 0 };
    this.abort = new AbortController();
    this.emit();
    return this.loop(this.cur, this.abort.signal);
  }

  /** 중지: 현재 단계 프로세스를 끝내고(exec가 signal을 받음) 남은 단계는 건너뛴다. 완료된 단계 결과는 유지. */
  stop(): void {
    if (this.running) this.abort?.abort();
  }

  private async loop(run: UpdateRunDto, signal: AbortSignal): Promise<UpdateRunDto> {
    try {
      for (const step of run.steps) {
        if (signal.aborted) {
          step.status = 'skipped';
          continue;
        }
        step.status = 'running';
        this.emit();
        let code: number | null;
        try {
          code = await settleAfterAbort(Promise.resolve().then(() => this.exec(step.id, signal)), signal, this.abortGraceMs);
        } catch {
          code = null;
        }
        // 중지로 끝난 단계는 성공으로 세지 않는다(프로세스를 강제 종료했으므로 결과를 알 수 없음)
        if (code === 0 && !signal.aborted) {
          step.status = 'ok';
          run.ok++;
        } else {
          step.status = 'failed';
          run.fail++;
        }
        this.emit();
      }
    } finally {
      // 어떤 경우에도 "실행 중"으로 남지 않게 마무리한다(남은 단계는 건너뜀으로)
      for (const s of run.steps) if (s.status === 'pending' || s.status === 'running') s.status = 'skipped';
      run.status = signal.aborted ? 'stopped' : 'done';
      this.abort = null;
      this.emit();
    }
    return this.state()!;
  }

  private emit(): void {
    const s = this.state();
    try {
      if (s) this.onState(s);
    } catch { /* 상태 알림 실패가 실행을 멈추지 않게 */ }
  }
}
