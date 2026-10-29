// %output을 칸별로 짧게 모아 한 번에 내보낸다(IPC 횟수 절감).
// 재동기화(capture-pane) 때는 캡처 응답 블록보다 먼저 도착한 출력만 캡처 직전에 내보내고, 뒤에 도착한 출력은
// 캡처 다음에 그려지도록 남긴다. 순서 판단은 control mode 스트림 순번(seq)으로 한다.

interface Chunk {
  data: Buffer;
  seq: number;
}

/** 칸별 출력 묶음. */
export class OutputBatcher {
  private buf = new Map<string, Chunk[]>();
  private timer: NodeJS.Timeout | null = null;

  /**
   * Args:
   *   emit: 칸별로 합친 출력을 내보내는 함수(묶음의 첫·마지막 스트림 순번 포함: 진단용).
   *   delayMs: 묶는 시간.
   */
  constructor(private readonly emit: (pane: string, data: Buffer, firstSeq: number, lastSeq: number) => void, private readonly delayMs = 16) {}

  /** 출력 추가(seq = 스트림 순번). 늦게 넣은 조각(재동기화 커서 위치)도 seq 순서 자리에 끼운다. */
  push(pane: string, data: Buffer, seq: number): void {
    const arr = this.buf.get(pane);
    if (!arr) this.buf.set(pane, [{ data, seq }]);
    else {
      let i = arr.length;
      while (i > 0 && arr[i - 1].seq > seq) i--;
      arr.splice(i, 0, { data, seq });
    }
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** 쌓인 출력을 모두 지금 내보낸다. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const all = this.buf;
    this.buf = new Map();
    for (const [p, arr] of all) this.emit(p, Buffer.concat(arr.map((c) => c.data)), arr[0].seq, arr[arr.length - 1].seq);
  }

  /** 칸의 출력 중 seq보다 앞선 것만 지금 내보낸다(재동기화 직전). 뒤의 것은 다음 flush까지 남긴다. */
  flushBefore(pane: string, seq: number): void {
    const arr = this.buf.get(pane);
    if (!arr) return;
    const early = arr.filter((c) => c.seq < seq);
    const late = arr.filter((c) => c.seq >= seq);
    if (late.length) this.buf.set(pane, late);
    else this.buf.delete(pane);
    if (early.length) this.emit(pane, Buffer.concat(early.map((c) => c.data)), early[0].seq, early[early.length - 1].seq);
  }

  /** 칸의 쌓인 출력을 버린다(칸 제거 시). */
  drop(pane: string): void {
    this.buf.delete(pane);
  }
}
