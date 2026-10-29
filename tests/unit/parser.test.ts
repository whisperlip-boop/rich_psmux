import { describe, expect, it } from 'vitest';

import { ControlParser, decodeOctal, LineSplitter, type ControlEvent } from '../../src/main/controlMode/parser';

type OutputEvent = Extract<ControlEvent, { kind: 'output' }>;

function run(chunks: (string | Buffer)[]): ControlEvent[] {
  const sp = new LineSplitter();
  const p = new ControlParser();
  const out: ControlEvent[] = [];
  for (const c of chunks) {
    for (const line of sp.push(Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'))) {
      const ev = p.feed(line);
      if (ev) out.push(ev);
    }
  }
  return out;
}

describe('decodeOctal', () => {
  it('decodes CRLF, ESC and backslash', () => {
    expect(decodeOctal(Buffer.from('a\\015\\012\\033[0m\\134\\\\z')).toString('latin1')).toBe('a\r\n\x1b[0m\\\\z');
  });
  it('keeps raw UTF-8 bytes and octal-escaped UTF-8', () => {
    expect(decodeOctal(Buffer.from('한글')).toString('utf8')).toBe('한글');
    // '가' = EA B0 80
    expect(decodeOctal(Buffer.from('\\352\\260\\200')).toString('utf8')).toBe('가');
  });
  it('leaves incomplete escapes as-is', () => {
    expect(decodeOctal(Buffer.from('x\\01')).toString('latin1')).toBe('x\\01');
    expect(decodeOctal(Buffer.from('x\\')).toString('latin1')).toBe('x\\');
    expect(decodeOctal(Buffer.from('\\9ab')).toString('latin1')).toBe('\\9ab');
    // \400 이상은 한 바이트를 넘으므로 이스케이프가 아님
    expect(decodeOctal(Buffer.from('\\400\\777')).toString('latin1')).toBe('\\400\\777');
    expect(decodeOctal(Buffer.from('\\377')).toString('latin1')).toBe('\xff');
  });
});

describe('LineSplitter + ControlParser', () => {
  it('strips DCS prefix and treats flags 0 block as unsolicited', () => {
    const ev = run(['\x1bP1000p%begin 1792737344 1 0\n%end 1792737344 1 0\n']);
    expect(ev).toEqual([{ kind: 'block', ok: true, lines: [], unsolicited: true, num: 1 }]);
  });

  it('parses response blocks with %end and %error', () => {
    const ev = run(['%begin 10 2 1\nline1\nline2\n%end 10 2 1\n%begin 11 3 1\nbad\n%error 11 3 1\n']);
    expect(ev).toEqual([
      { kind: 'block', ok: true, lines: ['line1', 'line2'], unsolicited: false, num: 2 },
      { kind: 'block', ok: false, lines: ['bad'], unsolicited: false, num: 3 },
    ]);
  });

  it('does not end a block on a %end line with a different number (capture-pane content)', () => {
    const ev = run(['%begin 10 5 1\n%end 99 1 1\n%end 10 5 1\n']);
    expect(ev).toEqual([{ kind: 'block', ok: true, lines: ['%end 99 1 1'], unsolicited: false, num: 5 }]);
  });

  it('handles lines split across chunks, including inside a UTF-8 character', () => {
    const full = Buffer.from('%output %3 안녕\\015\\012\n', 'utf8');
    const cut = full.indexOf(Buffer.from('녕', 'utf8')) + 1; // 3바이트 문자 중간
    const ev = run([full.subarray(0, 5), full.subarray(5, cut), full.subarray(cut)]);
    expect(ev).toHaveLength(1);
    const o = ev[0] as OutputEvent;
    expect(o.kind).toBe('output');
    expect(o.pane).toBe('%3');
    expect(o.data.toString('utf8')).toBe('안녕\r\n');
  });

  it('handles very long output lines', () => {
    const payload = 'x'.repeat(2_000_000);
    const line = `%output %1 ${payload}\n`;
    const chunks: string[] = [];
    for (let i = 0; i < line.length; i += 65536) chunks.push(line.slice(i, i + 65536));
    const ev = run(chunks);
    expect(ev).toHaveLength(1);
    expect((ev[0] as OutputEvent).data.length).toBe(2_000_000);
  });

  it('parses CRLF line endings and empty output', () => {
    const ev = run(['%output %2 \r\n', '%output %2\r\n']);
    expect(ev.map((e) => e.kind)).toEqual(['output', 'output']);
    expect((ev[0] as OutputEvent).data.length).toBe(0);
  });

  it('parses notifications and %exit', () => {
    const ev = run(['%layout-change @1 93b5,160x50,0,0 *\n%window-add @1\n%sessions-changed\n%exit\n']);
    expect(ev).toEqual([
      { kind: 'notify', name: 'layout-change', args: '@1 93b5,160x50,0,0 *', line: '%layout-change @1 93b5,160x50,0,0 *' },
      { kind: 'notify', name: 'window-add', args: '@1', line: '%window-add @1' },
      { kind: 'notify', name: 'sessions-changed', args: '', line: '%sessions-changed' },
      { kind: 'exit', reason: '' },
    ]);
  });

  it('parses %extended-output', () => {
    const ev = run(['%extended-output %4 120 : hi\\012\n']);
    expect(ev).toHaveLength(1);
    expect((ev[0] as OutputEvent).data.toString()).toBe('hi\n');
  });

  it('does not treat %output inside a block as output', () => {
    const ev = run(['%begin 1 7 1\n%output %1 inside\n%end 1 7 1\n']);
    expect(ev).toEqual([{ kind: 'block', ok: true, lines: ['%output %1 inside'], unsolicited: false, num: 7 }]);
  });
});
