// control mode 명령줄 인용·입력 변환. 순수 로직(단위 테스트 대상).

/**
 * 명령 대상(%N, @N, 세션 이름)처럼 인용 없이 넣을 값을 검증한다.
 * '.'·':'는 tmux 대상 문법(세션:창.칸)이라 허용하지만, 값은 앱이 만든 ID·세션 이름만 넣는다(사용자 입력 금지).
 * '-'로 시작하면 psmux가 플래그로 해석하므로 거부한다.
 */
export function assertSafeToken(s: string): string {
  if (!/^[A-Za-z0-9_@%.:][A-Za-z0-9_@%.:\-]*$/.test(s)) throw new Error(`unsafe token: ${JSON.stringify(s)}`);
  return s;
}

/** 한 명령에 넣을 리터럴 텍스트 최대 길이(코드 포인트). 실측에서 2000자가 무손상이었으므로 여유를 둔다. */
export const MAX_LITERAL_CHUNK = 1000;

/** 코드 포인트 경계를 지키며 문자열을 n자씩 나눈다(서로게이트 쌍이 갈라지지 않게). */
export function chunkCodePoints(s: string, n: number = MAX_LITERAL_CHUNK): string[] {
  const cps = Array.from(s);
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += n) out.push(cps.slice(i, i + n).join(''));
  return out;
}

/**
 * 리터럴 텍스트를 send-keys 명령으로 바꾼다.
 * psmux는 '-'로 시작하는 인자를 위치와 상관없이 플래그로 해석해 텍스트를 버리고 응답 블록도 보내지 않는다
 * (실측: 명령 번호도 소비하지 않아 FIFO가 밀림). '--' 구분자도 텍스트를 버린다.
 * 그래서 작은따옴표로 나눈 조각이 '-'로 시작하면 앞의 '-'들을 -H 2d로 따로 보내고 나머지를 -l로 이어 보낸다.
 * 인용: psmux는 tmux식 '\'' 연결을 지원하지 않으므로 작은따옴표는 별도 인자 "'"로 분리한다
 * (send-keys는 여러 인자를 이어 보내므로 결과는 원문과 같음).
 *
 * Raises:
 *   Error: 줄바꿈이 있을 때(명령 종료자라 넣을 수 없음 → 호출부에서 줄 단위로 나눌 것).
 */
export function literalCommands(target: string, text: string): string[] {
  assertSafeToken(target);
  if (/[\r\n]/.test(text)) throw new Error('literalCommands(): newline not allowed in a control mode command line');
  const cmds: string[] = [];
  for (const chunk of chunkCodePoints(text)) {
    let args: string[] = [];
    const flush = (): void => {
      if (args.length) cmds.push(`send-keys -t ${target} -l ${args.join(' ')}`);
      args = [];
    };
    const parts = chunk.split("'");
    parts.forEach((part, i) => {
      let p = part;
      const dashes = /^-+/.exec(p)?.[0].length ?? 0;
      if (dashes) {
        flush();
        cmds.push(`send-keys -t ${target} -H ${Array(dashes).fill('2d').join(' ')}`);
        p = p.slice(dashes);
      }
      if (p) args.push(`'${p}'`);
      if (i < parts.length - 1) args.push(`"'"`);
    });
    flush();
  }
  return cmds;
}

const PASTE_START = 'send-keys -t %T -H 1b 5b 32 30 30 7e';
const PASTE_END = 'send-keys -t %T -H 1b 5b 32 30 31 7e';

/** 여러 줄 입력 방식. paste = bracketed paste(Claude Code), ctrlj = 줄 사이 C-j(pwsh: 붙여넣기 안 CR을 줄마다 실행함). */
export type MultilineMode = 'paste' | 'ctrlj';

/**
 * 카드 입력창 내용을 칸에 보낼 control mode 명령 목록으로 바꾼다.
 * 한 줄: -l 텍스트 + Enter. 여러 줄: paste면 bracketed paste(-H 마커, 줄 사이 Enter), ctrlj면 줄 사이 C-j, 끝에 전송 Enter.
 * 공백뿐인 입력은 빈 목록(빈 Enter가 프롬프트 제안을 전송할 수 있어 보내지 않음).
 *
 * Args:
 *   target: 칸 ID(예: %3).
 *   text: 입력창 원문.
 *   mode: 여러 줄 방식(칸에서 실행 중인 프로그램에 따라 호출부가 정함).
 *
 * Returns:
 *   순서대로 보낼 명령 문자열 목록.
 */
export function inputToCommands(target: string, text: string, mode: MultilineMode = 'paste'): string[] {
  assertSafeToken(target);
  const norm = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (norm.trim() === '') return [];
  const lines = norm.split('\n');
  // Claude Code 칸(paste 모드)에서 @ 파일 참조가 있으면 Enter 전에 End: 커서가 참조 바로 뒤에 있으면 Enter가 전송되지 않음(실측)
  const end = mode === 'paste' && norm.includes('@') ? [`send-keys -t ${target} End`] : [];
  if (lines.length === 1) return [...literalCommands(target, lines[0]), ...end, `send-keys -t ${target} Enter`];
  if (mode === 'ctrlj') {
    const out: string[] = [];
    lines.forEach((line, i) => {
      if (line) out.push(...literalCommands(target, line));
      if (i < lines.length - 1) out.push(`send-keys -t ${target} C-j`);
    });
    out.push(`send-keys -t ${target} Enter`);
    return out;
  }
  const cmds: string[] = [PASTE_START.replace('%T', target)];
  lines.forEach((line, i) => {
    if (line) cmds.push(...literalCommands(target, line));
    if (i < lines.length - 1) cmds.push(`send-keys -t ${target} Enter`);
  });
  cmds.push(PASTE_END.replace('%T', target), ...end, `send-keys -t ${target} Enter`);
  return cmds;
}

/**
 * inputToCommands 결과를 시간 간격을 두고 보낼 묶음으로 나눈다: [본문] → [End](@ 참조일 때) → [Enter].
 * Claude Code가 작업 중이면 입력 읽기가 늦어 텍스트와 Enter(CR)가 한 덩어리로 읽히고, 붙여넣기로 판정돼 CR이 제출되지 않는다
 * (실측). 마지막 Enter와 그 앞 End를 각각 따로 보내 덩어리가 합쳐지지 않게 한다. End+CR이 합쳐져도 같은 위험이라 End도 분리한다.
 *
 * Args:
 *   target: 칸 ID(inputToCommands에 준 값).
 *   cmds: inputToCommands 결과.
 *
 * Returns:
 *   순서대로 보낼 묶음 목록(빈 묶음 없음). 마지막이 Enter가 아니면 한 묶음 그대로.
 */
export function splitSubmit(target: string, cmds: string[]): string[][] {
  const enter = `send-keys -t ${target} Enter`;
  const end = `send-keys -t ${target} End`;
  if (cmds.length < 2 || cmds[cmds.length - 1] !== enter) return cmds.length ? [cmds] : [];
  let body = cmds.slice(0, -1);
  const tail: string[][] = [[enter]];
  if (body.length > 1 && body[body.length - 1] === end) {
    tail.unshift([end]);
    body = body.slice(0, -1);
  }
  return [body, ...tail];
}

// xterm onData가 내는 이스케이프 시퀀스 → psmux 키 이름(실측으로 확인된 이름 위주)
const SEQ_KEYS: Record<string, string> = {
  '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
  '\x1bOA': 'Up', '\x1bOB': 'Down', '\x1bOC': 'Right', '\x1bOD': 'Left',
  '\x1b[H': 'Home', '\x1b[F': 'End', '\x1bOH': 'Home', '\x1bOF': 'End',
  '\x1b[1~': 'Home', '\x1b[4~': 'End',
  '\x1b[2~': 'IC', '\x1b[3~': 'DC', '\x1b[5~': 'PPage', '\x1b[6~': 'NPage',
  '\x1b[Z': 'BTab',
  '\x1bOP': 'F1', '\x1bOQ': 'F2', '\x1bOR': 'F3', '\x1bOS': 'F4',
  '\x1b[15~': 'F5', '\x1b[17~': 'F6', '\x1b[18~': 'F7', '\x1b[19~': 'F8',
  '\x1b[20~': 'F9', '\x1b[21~': 'F10', '\x1b[23~': 'F11', '\x1b[24~': 'F12',
};
const MOD_PREFIX: Record<string, string> = { '2': 'S-', '3': 'M-', '4': 'S-M-', '5': 'C-', '6': 'C-S-', '7': 'C-M-', '8': 'C-M-S-' };
const MOD_FINAL: Record<string, string> = { A: 'Up', B: 'Down', C: 'Right', D: 'Left', H: 'Home', F: 'End' };

/** send-keys로 보낼 단위. literal = -l 텍스트, key = 키 이름, hex = -H 바이트. */
export type KeyToken = { type: 'literal'; text: string } | { type: 'key'; name: string } | { type: 'hex'; bytes: number[] };

function ctrlKeyName(code: number): string | null {
  if (code === 0x0d) return 'Enter';
  if (code === 0x09) return 'Tab';
  if (code === 0x7f || code === 0x08) return 'BSpace';
  if (code === 0x1b) return 'Escape';
  if (code === 0x00) return 'C-Space';
  if (code >= 0x01 && code <= 0x1a) return `C-${String.fromCharCode(code + 0x60)}`;
  return null; // 0x1c~0x1f 는 키 이름 인용이 애매하므로 hex로 보냄
}

/** 이스케이프 시퀀스 하나의 길이(CSI/SS3/ESC+문자). 완성되지 않았으면 data 끝까지. */
function escapeLength(data: string, i: number): number {
  const n = data[i + 1];
  if (n === undefined) return 1;
  if (n === '[') {
    let j = i + 2;
    while (j < data.length && /[0-9;?<>=!]/.test(data[j])) j++;
    // 최종 바이트(0x40~0x7e) 하나 포함
    return Math.min(j + 1, data.length) - i;
  }
  if (n === 'O') return Math.min(3, data.length - i);
  return 2; // ESC + 문자(Alt 조합)
}

/**
 * xterm onData 문자열(터미널이 보낼 원본 입력)을 send-keys 토큰으로 나눈다.
 * 일반 문자(한글 IME 확정 문자 포함)는 literal, 알려진 키는 이름, 그 밖의 시퀀스는 hex로 그대로 보낸다.
 *
 * Args:
 *   data: xterm onData 값.
 *
 * Returns:
 *   순서가 보존된 토큰 목록.
 */
export function xtermDataToTokens(data: string): KeyToken[] {
  const toks: KeyToken[] = [];
  let lit = '';
  const flush = (): void => {
    if (lit) toks.push({ type: 'literal', text: lit });
    lit = '';
  };
  for (let i = 0; i < data.length;) {
    const ch = data[i];
    const code = ch.charCodeAt(0);
    if (code === 0x1b && i + 1 < data.length) {
      const len = escapeLength(data, i);
      const seq = data.slice(i, i + len);
      flush();
      if (SEQ_KEYS[seq]) toks.push({ type: 'key', name: SEQ_KEYS[seq] });
      else if (/^\x1b\[1;[2-8][ABCDHF]$/.test(seq)) toks.push({ type: 'key', name: MOD_PREFIX[seq[4]] + MOD_FINAL[seq[5]] });
      else if (len === 2 && seq[1] === '\r') toks.push({ type: 'key', name: 'M-Enter' });
      // Alt+영숫자만 키 이름으로(그 밖의 기호는 tmux 명령줄 해석(; # $ ~ {)을 피하려고 hex)
      else if (len === 2 && /^[A-Za-z0-9]$/.test(seq[1]) && seq[1] !== 'O') toks.push({ type: 'key', name: `M-${seq[1]}` });
      else toks.push({ type: 'hex', bytes: [...Buffer.from(seq, 'utf8')] });
      i += len;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      flush();
      const name = ctrlKeyName(code);
      if (name) toks.push({ type: 'key', name });
      else toks.push({ type: 'hex', bytes: [code] });
      i += 1;
      continue;
    }
    lit += ch;
    i += 1;
  }
  flush();
  return toks;
}

/** 토큰을 control mode 명령으로 바꾼다. 연속 키 이름은 한 명령으로 묶는다. */
export function tokensToCommands(target: string, toks: KeyToken[]): string[] {
  assertSafeToken(target);
  const cmds: string[] = [];
  let keys: string[] = [];
  const flushKeys = (): void => {
    if (keys.length) cmds.push(`send-keys -t ${target} ${keys.join(' ')}`);
    keys = [];
  };
  for (const t of toks) {
    if (t.type === 'key') {
      keys.push(t.name);
      continue;
    }
    flushKeys();
    if (t.type === 'literal') cmds.push(...literalCommands(target, t.text));
    else cmds.push(`send-keys -t ${target} -H ${t.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  }
  flushKeys();
  return cmds;
}

/**
 * send-keys -l / -H 는 실제로 전달되는데도 즉시 "command timed out" 에러를 돌려준다. 이 경우 성공으로 본다.
 *
 * Args:
 *   cmd: 보낸 명령.
 *   lines: %error 블록 내용.
 *
 * Returns:
 *   무시해도 되는 에러면 true.
 */
export function isBenignError(cmd: string, lines: string[]): boolean {
  return /^send-keys\b.*\s-[lH]\s/.test(cmd) && lines.some((l) => /timed out/i.test(l));
}
