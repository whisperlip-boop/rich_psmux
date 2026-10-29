// control mode 명령 큐: 표지(nonce)로 응답 다시 맞추기, send-keys 응답 처리, '-' 인자, 칸 프로그램별 여러 줄 모드.
import { describe, expect, it } from 'vitest';

import { CommandQueue } from '../../src/main/controlMode/client';
import { inputToCommands, literalCommands, tokensToCommands, xtermDataToTokens } from '../../src/main/controlMode/quote';
import { multilineModeFor } from '../../src/main/psmux/panes';

const blk = (num: number, lines: string[] = [], ok = true) => ({ ok, lines, num });

describe('CommandQueue nonce realignment', () => {
  it('realigns when the nonce response arrives at an earlier slot (a dropped command does not consume a number)', () => {
    const q = new CommandQueue();
    const got: string[] = [];
    q.push('a', (r) => got.push(`a:${r.lines[0]}`));
    q.push("send-keys -t %1 -l '-x'", (r) => got.push(`b:${r.lines[0]}`)); // psmux가 응답을 안 보냄
    q.push('c', (r) => got.push(`c:${r.lines[0] ?? ''}`));
    q.push("display-message -p 'ctd-nonce-1'", (r) => got.push(`n:${r.lines[0]}`), 'ctd-nonce-1');
    expect(q.resolve(blk(1, ['A']))).toBe('matched');
    expect(q.resolve(blk(2, []))).toBe('matched'); // c의 빈 응답이 b 자리에 들어감(줄이 없어 번호·내용으로 못 잡음)
    expect(q.resolve(blk(3, ['ctd-nonce-1']))).toBe('realigned');
    expect(got).toEqual(['a:A', 'b:undefined', 'c:no response', 'n:ctd-nonce-1']);
    // 다시 맞춘 뒤 다음 명령은 정상 매칭
    q.push('d', (r) => got.push(`d:${r.lines[0]}`));
    expect(q.resolve(blk(4, ['D']))).toBe('matched');
    expect(got[got.length - 1]).toBe('d:D');
  });
  it('treats a different response in the nonce slot as drift before the offset is known', () => {
    const q = new CommandQueue();
    q.push("display-message -p 'ctd-nonce-9'", () => undefined, 'ctd-nonce-9');
    expect(q.resolve(blk(1, ['something else']))).toBe('drift');
    expect(q.length).toBe(1);
  });
  it('matches a nonce at the head normally', () => {
    const q = new CommandQueue();
    let v = '';
    q.push("display-message -p 'ctd-nonce-2'", (r) => { v = r.lines[0]; }, 'ctd-nonce-2');
    expect(q.resolve(blk(1, ['ctd-nonce-2']))).toBe('matched');
    expect(v).toBe('ctd-nonce-2');
  });
});

describe('CommandQueue reply matching around send-keys and nonce barriers', () => {
  it('a reply with lines in a send-keys slot goes to the next command', () => {
    const q = new CommandQueue();
    const got: string[] = [];
    q.push('a', (r) => got.push(`a:${r.lines[0]}`));
    q.push("send-keys -t %1 -l 'x'", (r) => got.push(`s:${r.ok}:${r.lines[0]}`)); // 응답(번호)을 안 냄
    q.push("display-message -p -t %1 '#{cursor_x}'", (r) => got.push(`d:${r.lines[0]}`));
    q.push('e', (r) => got.push(`e:${r.lines[0]}`));
    expect(q.resolve(blk(1, ['A']))).toBe('matched');
    expect(q.resolve(blk(2, ['7']))).toBe('skipped'); // send-keys는 응답 없음 처리
    expect(q.resolve(blk(3, ['E']))).toBe('matched'); // 번호 차이를 다시 맞춰 다음 명령도 제자리
    expect(got).toEqual(['a:A', 's:false:no response', 'd:7', 'e:E']);
  });
  it('send-keys keeps its own empty reply and its error reply', () => {
    const q = new CommandQueue();
    const got: string[] = [];
    q.push("send-keys -t %1 Enter", (r) => got.push(`s1:${r.ok}`));
    q.push("send-keys -t %9 Enter", (r) => got.push(`s2:${r.ok}:${r.lines[0]}`));
    q.push('d', (r) => got.push(`d:${r.lines[0]}`));
    expect(q.resolve(blk(1, []))).toBe('matched');
    expect(q.resolve({ ok: false, lines: ["can't find pane: %9"], num: 2 })).toBe('matched');
    expect(q.resolve(blk(3, ['D']))).toBe('matched');
    expect(got).toEqual(['s1:true', "s2:false:can't find pane: %9", 'd:D']);
  });
  it('same-number nonce reply with other content fails only the barrier and keeps the queue', () => {
    const q = new CommandQueue();
    const got: string[] = [];
    q.push('a', (r) => got.push(`a:${r.lines[0]}`));
    q.push("display-message -p 'ctd-nonce-3'", (r) => got.push(`n:${r.ok}:${r.lines[0]}`), 'ctd-nonce-3');
    q.push('b', (r) => got.push(`b:${r.lines[0]}`));
    expect(q.resolve(blk(21, ['A']))).toBe('matched');
    expect(q.resolve(blk(22, ['%output %1 x', 'ctd-nonce-3']))).toBe('nonce-mismatch');
    expect(q.resolve(blk(23, ['B']))).toBe('matched');
    expect(got).toEqual(['a:A', 'n:false:nonce mismatch', 'b:B']);
  });
  it('a different-number reply in the nonce slot after the offset is known is still drift', () => {
    const q = new CommandQueue();
    q.push('a', () => undefined);
    q.push("display-message -p 'ctd-nonce-5'", () => undefined, 'ctd-nonce-5');
    expect(q.resolve(blk(21, ['A']))).toBe('matched');
    expect(q.resolve(blk(25, ['other']))).toBe('drift');
    expect(q.length).toBe(1); // drift면 큐를 건드리지 않음
  });
  it('nonce reply surrounded by blank lines still matches', () => {
    const q = new CommandQueue();
    let v = '';
    q.push("display-message -p 'ctd-nonce-4'", (r) => { v = r.lines.join('|'); }, 'ctd-nonce-4');
    expect(q.resolve(blk(1, ['', 'ctd-nonce-4', '']))).toBe('matched');
    expect(v).toBe('|ctd-nonce-4|');
  });
});

describe("generated commands never contain a '-'-leading literal argument", () => {
  const bad = /-l '-|"'" '-/;
  const cases: [string, string][] = [
    ['quoted -x', "'-x'"],
    ['a\'-b', "a'-b"],
    ['1000-char boundary is "-"', 'a'.repeat(1000) + '-b'],
    ['boundary after apostrophe', 'a'.repeat(999) + "'-c"],
    ['many dashes and quotes', "--a '-b' ''-c - -"],
  ];
  for (const [name, text] of cases) {
    it(name, () => {
      const cmds = [...literalCommands('%1', text), ...inputToCommands('%1', text), ...tokensToCommands('%1', xtermDataToTokens(text))];
      expect(cmds.filter((c) => bad.test(c))).toEqual([]);
      // 보낸 글자를 이어 붙이면 원문과 같아야 함(-H 2d = '-')
      const rebuilt = literalCommands('%1', text).map((c) => {
        const h = /-H ((?:2d ?)+)$/.exec(c);
        if (h) return '-'.repeat(h[1].trim().split(' ').length);
        const l = /-l (.*)$/.exec(c)!;
        return (l[1].match(/'[^']*'|"'"/g) ?? []).map((a) => a.slice(1, -1)).join('');
      }).join('');
      expect(rebuilt).toBe(text);
    });
  }
});

describe('multi-line mode by pane program', () => {
  it('uses C-j between lines for pwsh panes', () => {
    expect(inputToCommands('%2', 'a\nb', 'ctrlj')).toEqual([
      "send-keys -t %2 -l 'a'", 'send-keys -t %2 C-j', "send-keys -t %2 -l 'b'", 'send-keys -t %2 Enter',
    ]);
    expect(inputToCommands('%2', 'one', 'ctrlj')).toEqual(["send-keys -t %2 -l 'one'", 'send-keys -t %2 Enter']);
  });
  it('picks the mode from pane_current_command', () => {
    expect(multilineModeFor('pwsh')).toBe('ctrlj');
    expect(multilineModeFor('powershell.exe')).toBe('ctrlj');
    expect(multilineModeFor('claude')).toBe('paste');
    expect(multilineModeFor('node')).toBe('paste');
    expect(multilineModeFor(undefined)).toBe('paste');
  });
});
