// 로그인 상태 확인(where claude + claude auth status) 캐시(F7-2). 실행 순서만 다루는 순수 로직이라 electron에 의존하지 않는다(단위 테스트 대상).

/** 확인 한 번의 결과. */
export interface AuthCheckResult {
  cli: string | null;
  /** auth status의 loggedIn(읽지 못하면 null). */
  status: boolean | null;
  /** status가 null인 이유(timeout 등, 로그·판정용). */
  statusReason?: string | null;
}

/** 캐시 값. */
export interface AuthCacheValue extends AuthCheckResult {
  at: number;
}

/**
 * 확인 실행 관리:
 * - 보통(force 아님)은 진행 중인 확인을 공유한다.
 * - force(로그아웃·로그인 직후)는 진행 중인 확인이 끝난 뒤 새로 한 번 실행한다(그 확인은 이전 상태를 읽었을 수 있음, 리뷰 m-1).
 *   force가 겹치면 대기 중인 force 실행 1개를 공유한다(리뷰 Minor: status 중복 실행 방지).
 * - 확인이 예외로 끝나면 캐시를 "모름"(cli·status null)으로 둔다.
 */
export class AuthCache {
  private value: AuthCacheValue | null = null;
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;

  /**
   * Args:
   *   check: 실제 확인(where claude + claude auth status).
   *   onError: 확인 실패 알림(로그용, 메시지에는 비밀값이 없어야 함).
   *   now: 시각(테스트 주입).
   */
  constructor(
    private readonly check: () => Promise<AuthCheckResult>,
    private readonly onError: (e: unknown) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** 현재 캐시(없으면 null). */
  get(): AuthCacheValue | null {
    return this.value;
  }

  /** 캐시를 직접 바꾼다(로그아웃 판정 보정용). */
  set(v: AuthCacheValue): void {
    this.value = v;
  }

  /** 캐시가 없거나 ttl보다 오래됐는지. */
  stale(ttlMs: number): boolean {
    return !this.value || this.now() - this.value.at > ttlMs;
  }

  private start(): Promise<void> {
    const p: Promise<void> = (async () => {
      let r: AuthCheckResult;
      try {
        r = await this.check();
      } catch (e) {
        this.onError(e);
        r = { cli: null, status: null, statusReason: 'error' };
      }
      this.value = { ...r, at: this.now() };
    })().finally(() => {
      if (this.running === p) this.running = null;
    });
    this.running = p;
    return p;
  }

  /**
   * 확인을 (다시) 실행한다.
   *
   * Args:
   *   force: 진행 중인 확인이 있으면 그 뒤에 새로 한 번 더(대기 중인 force는 공유).
   */
  refresh(force = false): Promise<void> {
    if (!this.running) return this.start();
    if (!force) return this.queued ?? this.running;
    this.queued ??= this.running.catch(() => undefined).then(() => {
      this.queued = null;
      return this.start();
    });
    return this.queued;
  }
}
