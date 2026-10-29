import { describe, expect, it } from 'vitest';

import { chunkCodePoints, inputToCommands, isBenignError, literalCommands, tokensToCommands, xtermDataToTokens } from '../../src/main/controlMode/quote';

describe('literalCommands quoting', () => {
  const L = (t: string): string[] => literalCommands('%1', t);
  it('wraps in single quotes', () => {
    expect(L('hello world')).toEqual(["send-keys -t %1 -l 'hello world'"]);
    expect(L('')).toEqual([]);
  });
  it('splits single quotes into a separate "\'" argument', () => {
    expect(L("it's")).toEqual([`send-keys -t %1 -l 'it' "'" 's'`]);
    expect(L("'a'")).toEqual([`send-keys -t %1 -l "'" 'a' "'"`]);
  });
  it('keeps special characters, Korean and trailing backslash literal', () => {
    const special = 'a "dq" $x `bt` %p \\bs\\ ; # {}';
    expect(L(special)).toEqual([`send-keys -t %1 -l '${special}'`]);
    expect(L('안녕 😀')).toEqual(["send-keys -t %1 -l '안녕 😀'"]);
    expect(L('end\\')).toEqual(["send-keys -t %1 -l 'end\\'"]);
  });
  it('rejects newlines', () => {
    expect(() => L('a\nb')).toThrow();
    expect(() => L('a\rb')).toThrow();
  });
});

describe('literalCommands: leading "-" args (review Blocker)', () => {
  const L = (t: string): string[] => literalCommands('%1', t);
  it('-abc', () => {
    expect(L('-abc')).toEqual(['send-keys -t %1 -H 2d', "send-keys -t %1 -l 'abc'"]);
    expect(L('-')).toEqual(['send-keys -t %1 -H 2d']);
  });
  it('--help', () => {
    expect(L('--help')).toEqual(['send-keys -t %1 -H 2d 2d', "send-keys -t %1 -l 'help'"]);
  });
  it("- item: it's -v", () => {
    expect(L("- item: it's -v")).toEqual([
      'send-keys -t %1 -H 2d',
      `send-keys -t %1 -l ' item: it' "'" 's -v'`,
    ]);
  });
  it("'-v after an apostrophe", () => {
    expect(L("it'-v")).toEqual([`send-keys -t %1 -l 'it' "'"`, 'send-keys -t %1 -H 2d', "send-keys -t %1 -l 'v'"]);
    expect(L("'-")).toEqual([`send-keys -t %1 -l "'"`, 'send-keys -t %1 -H 2d']);
  });
  it('Korean 300 bytes stays literal in one command', () => {
    const ko = '가'.repeat(100);
    expect(Buffer.byteLength(ko)).toBe(300);
    expect(L(ko)).toEqual([`send-keys -t %1 -l '${ko}'`]);
  });
  it('no generated -l argument ever starts with "-"', () => {
    const samples = ['-a', '--', "x'-y'-z", '- a\t-b', "''--''", '-한글'];
    for (const t of samples) {
      for (const c of L(t)) {
        const m = /^send-keys -t %1 -l (.*)$/.exec(c);
        if (!m) continue;
        for (const arg of m[1].match(/'[^']*'|"'"/g) ?? []) expect(arg.slice(1, -1).startsWith('-')).toBe(false);
      }
    }
  });
  it('input box path uses the same rule', () => {
    expect(inputToCommands('%2', '-r')).toEqual(['send-keys -t %2 -H 2d', "send-keys -t %2 -l 'r'", 'send-keys -t %2 Enter']);
    expect(tokensToCommands('%2', xtermDataToTokens('-'))).toEqual(['send-keys -t %2 -H 2d']);
  });
  it('rejects targets starting with "-"', () => {
    expect(() => literalCommands('-t', 'x')).toThrow();
  });
});

describe('chunkCodePoints', () => {
  it('never splits surrogate pairs', () => {
    expect(chunkCodePoints('😀'.repeat(5), 2)).toEqual(['😀😀', '😀😀', '😀']);
  });
});

describe('inputToCommands: End before Enter when @ references are present', () => {
  it('Claude pane (paste mode), single and multi line', () => {
    expect(inputToCommands('%1', 'see @"D:\\a b.txt"')).toEqual(["send-keys -t %1 -l 'see @\"D:\\a b.txt\"'", 'send-keys -t %1 End', 'send-keys -t %1 Enter']);
    const ml = inputToCommands('%1', 'a\n@"D:\\x"');
    expect(ml.slice(-2)).toEqual(['send-keys -t %1 End', 'send-keys -t %1 Enter']);
  });
  it('no @ or pwsh pane: unchanged', () => {
    expect(inputToCommands('%1', 'hi')).toEqual(["send-keys -t %1 -l 'hi'", 'send-keys -t %1 Enter']);
    expect(inputToCommands('%1', 'a@b', 'ctrlj')).toEqual(["send-keys -t %1 -l 'a@b'", 'send-keys -t %1 Enter']);
  });
});

describe('inputToCommands', () => {
  it('sends a single line as literal + Enter', () => {
    expect(inputToCommands('%1', '안녕')).toEqual(["send-keys -t %1 -l '안녕'", 'send-keys -t %1 Enter']);
  });
  it('ignores empty / whitespace-only input', () => {
    expect(inputToCommands('%1', '')).toEqual([]);
    expect(inputToCommands('%1', '  \n\t\n')).toEqual([]);
  });
  it('wraps multi-line input in bracketed paste and submits once', () => {
    expect(inputToCommands('%2', 'a\r\n\nb\n')).toEqual([
      'send-keys -t %2 -H 1b 5b 32 30 30 7e',
      "send-keys -t %2 -l 'a'",
      'send-keys -t %2 Enter',
      'send-keys -t %2 Enter',
      "send-keys -t %2 -l 'b'",
      'send-keys -t %2 -H 1b 5b 32 30 31 7e',
      'send-keys -t %2 Enter',
    ]);
  });
  it('splits long lines into chunks', () => {
    const cmds = inputToCommands('%1', 'x'.repeat(2500));
    expect(cmds).toHaveLength(4);
    expect(cmds[3]).toBe('send-keys -t %1 Enter');
  });
  it('rejects unsafe targets', () => {
    expect(() => inputToCommands('%1; kill-server', 'x')).toThrow();
  });
});

describe('xtermDataToTokens / tokensToCommands', () => {
  it('maps keys used for permission prompts', () => {
    expect(xtermDataToTokens('\x1b[A\x1b[B\r\x1b')).toEqual([
      { type: 'key', name: 'Up' }, { type: 'key', name: 'Down' }, { type: 'key', name: 'Enter' }, { type: 'key', name: 'Escape' },
    ]);
    expect(xtermDataToTokens('\x1bOC')).toEqual([{ type: 'key', name: 'Right' }]);
    expect(xtermDataToTokens('\t\x1b[Z\x03\x7f')).toEqual([
      { type: 'key', name: 'Tab' }, { type: 'key', name: 'BTab' }, { type: 'key', name: 'C-c' }, { type: 'key', name: 'BSpace' },
    ]);
  });
  it('keeps IME-composed Korean as literal text', () => {
    expect(xtermDataToTokens('한글입력')).toEqual([{ type: 'literal', text: '한글입력' }]);
  });
  it('maps modifiers and Alt', () => {
    expect(xtermDataToTokens('\x1b[1;5C\x1bb\x1b\r')).toEqual([
      { type: 'key', name: 'C-Right' }, { type: 'key', name: 'M-b' }, { type: 'key', name: 'M-Enter' },
    ]);
  });
  it('sends unknown sequences as hex (bracketed paste markers, symbols with Alt, odd controls)', () => {
    expect(xtermDataToTokens('\x1b[200~hi\x1b[201~')).toEqual([
      { type: 'hex', bytes: [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e] },
      { type: 'literal', text: 'hi' },
      { type: 'hex', bytes: [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e] },
    ]);
    expect(xtermDataToTokens('\x1b;')).toEqual([{ type: 'hex', bytes: [0x1b, 0x3b] }]);
    expect(xtermDataToTokens('\x1c')).toEqual([{ type: 'hex', bytes: [0x1c] }]);
  });
  it('groups consecutive keys into one command and preserves order', () => {
    const cmds = tokensToCommands('%5', xtermDataToTokens("\x1b[A\x1b[Aab'c\r"));
    expect(cmds).toEqual(['send-keys -t %5 Up Up', `send-keys -t %5 -l 'ab' "'" 'c'`, 'send-keys -t %5 Enter']);
  });
});

describe('isBenignError', () => {
  it('treats timed-out -l / -H errors as success only', () => {
    expect(isBenignError("send-keys -t %1 -l 'x'", ['command timed out'])).toBe(true);
    expect(isBenignError('send-keys -t %1 -H 41', ['command timed out'])).toBe(true);
    expect(isBenignError('send-keys -t %1 Enter', ['command timed out'])).toBe(false);
    expect(isBenignError("send-keys -t %1 -l 'x'", ["can't find pane"])).toBe(false);
    expect(isBenignError('capture-pane -p', ['command timed out'])).toBe(false);
  });
});
