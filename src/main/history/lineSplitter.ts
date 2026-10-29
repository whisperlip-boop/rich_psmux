// 바이트 청크 → 줄 분리(스트리밍). 매우 긴 줄(최대 1.3MB 관측)은 앞부분만 보관해 메모리를 묶어 두지 않는다. 순수 로직.

/** 완성된 한 줄. */
export interface SplitLine {
  /** 줄 내용(끝 개행 제외). truncated면 앞부분만. */
  text: string;
  /** maxKeep을 넘어 뒷부분을 버렸는지. */
  truncated: boolean;
  /** 이 줄의 개행 다음 바이트 위치(파일 기준). */
  end: number;
}

/**
 * 청크를 받아 줄 단위로 넘긴다. 마지막 개행 뒤의 미완성 줄은 넘기지 않는다(쓰는 도중의 줄 방어).
 * skipFirst면 첫 개행까지(구간 중간에서 시작한 잘린 줄)를 버린다.
 */
export class JsonlSplitter {
  private parts: Buffer[] = [];
  private kept = 0;
  private truncated = false;
  private pos: number;
  private skipping: boolean;

  /**
   * Args:
   *   start: 첫 청크의 파일 내 위치.
   *   onLine: 줄 콜백. false를 돌려주면 이후 줄은 무시한다.
   *   maxKeep: 줄당 보관할 최대 바이트.
   *   skipFirst: 첫 개행까지 버릴지(파일 중간부터 읽을 때).
   */
  constructor(start: number, private readonly onLine: (l: SplitLine) => boolean, private readonly maxKeep = 256 * 1024, skipFirst = false) {
    this.pos = start;
    this.skipping = skipFirst && start > 0;
    this.parseStart = this.skipping ? -1 : start;
  }

  /** 줄 해석을 실제로 시작한 위치(잘린 첫 줄을 버린 뒤). 버릴 줄의 끝을 아직 못 찾았으면 -1. */
  parseStart: number;

  /** 마지막으로 넘긴 완성 줄의 끝 위치(이어 읽기 시작점). */
  lastEnd = -1;
  /** onLine이 false를 돌려 멈췄는지. */
  stopped = false;

  /** 청크 하나를 처리한다. 멈췄으면 false. */
  push(chunk: Buffer): boolean {
    if (this.stopped) return false;
    let i = 0;
    while (i < chunk.length) {
      const nl = chunk.indexOf(0x0a, i);
      const stop = nl < 0 ? chunk.length : nl;
      if (!this.skipping) this.keep(chunk.subarray(i, stop));
      if (nl < 0) {
        this.pos += chunk.length - i;
        break;
      }
      this.pos += nl - i + 1;
      i = nl + 1;
      if (this.skipping) {
        this.skipping = false;
        this.parseStart = this.pos;
        continue;
      }
      const text = Buffer.concat(this.parts).toString('utf8').replace(/\r$/, '');
      const truncated = this.truncated;
      this.parts = [];
      this.kept = 0;
      this.truncated = false;
      this.lastEnd = this.pos;
      if (!this.onLine({ text, truncated, end: this.pos })) {
        this.stopped = true;
        return false;
      }
    }
    return true;
  }

  private keep(b: Buffer): void {
    if (this.truncated || b.length === 0) return;
    const room = this.maxKeep - this.kept;
    if (b.length > room) {
      if (room > 0) this.parts.push(Buffer.from(b.subarray(0, room)));
      this.kept = this.maxKeep;
      this.truncated = true;
      return;
    }
    // 청크 버퍼를 오래 붙잡지 않게 복사
    this.parts.push(Buffer.from(b));
    this.kept += b.length;
  }
}
