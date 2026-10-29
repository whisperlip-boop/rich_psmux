// 비활성 탭 출력 보관: 렌더링을 멈추고 버퍼만 쌓다가, 상한을 넘으면 버리고 활성화 때 capture-pane으로 다시 그린다. 순수 로직.

/** 칸 하나의 보관 상태. */
export interface Held {
  chunks: (Uint8Array | string)[];
  bytes: number;
  /** 상한을 넘어 버렸음 → 활성화 때 재동기화 필요. */
  overflow: boolean;
}

/** 칸당 보관 상한(바이트). */
export const MAX_HELD_BYTES = 2 * 1024 * 1024;

/** 칸별 보관 버퍼. 키는 호출부가 정한다(탭·칸 조합). */
export class HoldBuffer {
  private held = new Map<string, Held>();

  constructor(private readonly max = MAX_HELD_BYTES) {}

  /** 출력 조각 보관. 상한을 넘으면 모두 버리고 overflow로 표시(이후 조각도 버림). */
  push(key: string, data: Uint8Array | string): void {
    const h = this.held.get(key) ?? { chunks: [], bytes: 0, overflow: false };
    if (!h.overflow) {
      h.chunks.push(data);
      h.bytes += data.length;
      if (h.bytes > this.max) {
        h.chunks = [];
        h.bytes = 0;
        h.overflow = true;
      }
    }
    this.held.set(key, h);
  }

  /** 화면 전체 다시 그리기(재동기화) 데이터: 그 앞의 보관분은 의미가 없으므로 이것으로 바꾼다(overflow 해제). */
  replace(key: string, data: string): void {
    this.held.set(key, { chunks: [data], bytes: data.length, overflow: false });
  }

  /** 조건에 맞는 키의 보관분을 꺼내고 지운다. */
  take(match: (key: string) => boolean): [string, Held][] {
    const out: [string, Held][] = [];
    for (const [k, h] of this.held) {
      if (!match(k)) continue;
      out.push([k, h]);
      this.held.delete(k);
    }
    return out;
  }

  /** 보관분 버리기. */
  drop(match: (key: string) => boolean): void {
    for (const k of [...this.held.keys()]) if (match(k)) this.held.delete(k);
  }
}
