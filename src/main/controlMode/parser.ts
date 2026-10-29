// psmux control mode(-CC) 프로토콜 파서. 입출력이 없는 순수 로직이라 단위 테스트 대상.

/** 파서가 내보내는 이벤트. */
export type ControlEvent =
  | { kind: 'block'; ok: boolean; lines: string[]; unsolicited: boolean; num: number }
  | { kind: 'output'; pane: string; data: Buffer }
  | { kind: 'notify'; name: string; args: string; line: string }
  | { kind: 'exit'; reason: string }
  | { kind: 'other'; line: string };

const DCS_PREFIX = Buffer.from('\x1bP1000p', 'latin1');
const ST = Buffer.from('\x1b\\', 'latin1');

/**
 * 바이트 스트림을 줄 단위 Buffer로 나눈다. 청크 경계에서 잘린 줄·UTF-8 문자는 다음 청크와 합친다.
 * 길이 제한은 두지 않는다(%output 한 줄이 매우 길 수 있음).
 */
export class LineSplitter {
  private pending: Buffer[] = [];
  private pendingLen = 0;

  /** 청크를 넣고 완성된 줄들을 돌려준다(줄바꿈 \n, 끝의 \r 제거). */
  push(chunk: Buffer): Buffer[] {
    const lines: Buffer[] = [];
    let start = 0;
    let nl: number;
    while ((nl = chunk.indexOf(0x0a, start)) >= 0) {
      let piece = chunk.subarray(start, nl);
      if (this.pendingLen > 0) {
        piece = Buffer.concat([...this.pending, piece], this.pendingLen + piece.length);
        this.pending = [];
        this.pendingLen = 0;
      }
      lines.push(stripFraming(piece));
      start = nl + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.pending.push(Buffer.from(rest));
      this.pendingLen += rest.length;
    }
    return lines;
  }
}

/** 줄 앞의 DCS 시작(ESC P1000p)·종료(ESC \) 표시와 끝의 \r을 제거한다. */
function stripFraming(line: Buffer): Buffer {
  let b = line;
  if (b.length > 0 && b[b.length - 1] === 0x0d) b = b.subarray(0, b.length - 1);
  for (;;) {
    if (startsWith(b, DCS_PREFIX)) b = b.subarray(DCS_PREFIX.length);
    else if (startsWith(b, ST)) b = b.subarray(ST.length);
    else break;
  }
  return b;
}

function startsWith(b: Buffer, prefix: Buffer): boolean {
  return b.length >= prefix.length && b.subarray(0, prefix.length).equals(prefix);
}

/**
 * %output 값의 8진수 이스케이프(\NNN, \\)를 원래 바이트로 되돌린다.
 * 이스케이프되지 않은 바이트(UTF-8 원문 포함)는 그대로 둔다.
 */
export function decodeOctal(src: Buffer): Buffer {
  const out = Buffer.allocUnsafe(src.length);
  let o = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === 0x5c && i + 1 < src.length) {
      const n1 = src[i + 1];
      if (n1 === 0x5c) {
        out[o++] = 0x5c;
        i += 1;
        continue;
      }
      // \400 이상은 한 바이트(0~255)를 넘으므로 이스케이프로 보지 않고 그대로 둔다
      if (i + 3 < src.length && isOct(n1) && n1 <= 0x33 && isOct(src[i + 2]) && isOct(src[i + 3])) {
        out[o++] = ((n1 - 0x30) << 6) | ((src[i + 2] - 0x30) << 3) | (src[i + 3] - 0x30);
        i += 3;
        continue;
      }
    }
    out[o++] = c;
  }
  return out.subarray(0, o);
}

function isOct(c: number | undefined): boolean {
  return c !== undefined && c >= 0x30 && c <= 0x37;
}

const OUTPUT_PREFIX = Buffer.from('%output ', 'latin1');
const EXT_OUTPUT_PREFIX = Buffer.from('%extended-output ', 'latin1');
const BEGIN_RE = /^%begin (\d+) (\d+) (\d+)$/;
const END_RE = /^%(end|error) (\d+) (\d+) (\d+)$/;

/**
 * 줄 단위 상태 기계. %begin…%end/%error 블록 안의 줄은 명령 출력으로 모으고,
 * 블록 밖의 % 줄은 알림으로 해석한다. 종료 줄은 %begin과 같은 명령 번호일 때만 인정한다
 * (capture-pane 결과에 "%end …" 글자가 있어도 블록이 끊기지 않게 하려는 것).
 */
export class ControlParser {
  private cur: { num: number; time: string; unsolicited: boolean; lines: string[] } | null = null;

  /** 줄 하나를 해석한다. 이벤트가 완성되지 않았으면 null. */
  feed(line: Buffer): ControlEvent | null {
    if (this.cur) {
      const s = line.toString('utf8');
      const m = END_RE.exec(s);
      if (m && Number(m[3]) === this.cur.num && m[2] === this.cur.time) {
        const blk = this.cur;
        this.cur = null;
        return { kind: 'block', ok: m[1] === 'end', lines: blk.lines, unsolicited: blk.unsolicited, num: blk.num };
      }
      this.cur.lines.push(s);
      return null;
    }
    if (startsWith(line, OUTPUT_PREFIX)) return parseOutput(line, OUTPUT_PREFIX.length, false);
    if (startsWith(line, EXT_OUTPUT_PREFIX)) return parseOutput(line, EXT_OUTPUT_PREFIX.length, true);

    const s = line.toString('utf8');
    const b = BEGIN_RE.exec(s);
    if (b) {
      // flags 0 = 서버가 스스로 보낸 블록(연결 직후), 그 외 = 클라이언트 명령 응답
      this.cur = { time: b[1], num: Number(b[2]), unsolicited: b[3] === '0', lines: [] };
      return null;
    }
    if (s.startsWith('%exit')) return { kind: 'exit', reason: s.slice(5).trim() };
    if (s.startsWith('%')) {
      const sp = s.indexOf(' ');
      return { kind: 'notify', name: sp < 0 ? s.slice(1) : s.slice(1, sp), args: sp < 0 ? '' : s.slice(sp + 1), line: s };
    }
    if (s === '') return null;
    return { kind: 'other', line: s };
  }

  /** 현재 블록 안에 있는지(테스트·진단용). */
  get inBlock(): boolean {
    return this.cur !== null;
  }
}

function parseOutput(line: Buffer, from: number, extended: boolean): ControlEvent | null {
  const sp = line.indexOf(0x20, from);
  const pane = line.subarray(from, sp < 0 ? line.length : sp).toString('latin1');
  if (!/^%\d+$/.test(pane)) return { kind: 'other', line: line.toString('utf8') };
  let dataStart = sp < 0 ? line.length : sp + 1;
  if (extended) {
    // %extended-output %<pane> <age> … : <value>
    const colon = line.indexOf(' : ', from);
    dataStart = colon < 0 ? line.length : colon + 3;
  }
  return { kind: 'output', pane, data: decodeOctal(line.subarray(dataStart)) };
}
