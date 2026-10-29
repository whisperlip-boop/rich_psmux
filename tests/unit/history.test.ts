import { describe, expect, it } from 'vitest';

import { appendFile, HEAD_MAX_BYTES, indexFile, parseCache, TAIL_BYTES, toItem, type IndexEntry, type RangeReader } from '../../src/main/history/indexer';
import { applyLine, emptyFacts, isNonTitleText, kindOf, partialUserText, titleOf, type FileFacts } from '../../src/main/history/jsonlFacts';
import { JsonlSplitter, type SplitLine } from '../../src/main/history/lineSplitter';
import { folderKeyOf, folderNameOf, toHistoryDtos } from '../../src/main/history/list';
import { buildRunning, findRunning, psmuxSessionOf } from '../../src/main/history/running';

const SID = '4df7e772-1111-2222-3333-444455556666';
const rec = (o: Record<string, unknown>): string => JSON.stringify({ sessionId: SID, ...o });
const user = (content: unknown, extra: Record<string, unknown> = {}): string =>
  rec({ type: 'user', cwd: 'D:\\work\\proj', entrypoint: 'cli', message: { role: 'user', content }, ...extra });

function factsOf(lines: string[]): FileFacts {
  const f = emptyFacts();
  for (const l of lines) applyLine(f, { text: l, truncated: false, end: 0 });
  return f;
}

/** 메모리 버퍼를 파일처럼 읽는 RangeReader(청크 크기를 바꿔 경계 시험). */
function memReader(buf: Buffer, chunk = 65536): RangeReader & { bytesRead: number } {
  const r = (async (_d: string, _f: string, start: number, end: number, onChunk: (b: Buffer) => boolean) => {
    for (let p = start; p < Math.min(end, buf.length); p += chunk) {
      const b = buf.subarray(p, Math.min(p + chunk, end, buf.length));
      r.bytesRead += b.length;
      if (!onChunk(b)) break;
    }
  }) as RangeReader & { bytesRead: number };
  r.bytesRead = 0;
  return r;
}

describe('JsonlSplitter (streaming boundaries)', () => {
  const text = 'aa\n한글줄\r\n\nlast-partial';
  it('emits the same lines for any chunk size and holds back the unfinished last line', () => {
    const buf = Buffer.from(text, 'utf8');
    for (const size of [1, 2, 3, 5, buf.length]) {
      const got: SplitLine[] = [];
      const sp = new JsonlSplitter(0, (l) => { got.push(l); return true; });
      for (let i = 0; i < buf.length; i += size) sp.push(buf.subarray(i, i + size));
      expect(got.map((l) => l.text)).toEqual(['aa', '한글줄', '']);
      expect(sp.lastEnd).toBe(Buffer.byteLength('aa\n한글줄\r\n\n'));
    }
  });
  it('keeps only the head of very long lines', () => {
    const long = 'x'.repeat(5000);
    const got: SplitLine[] = [];
    const sp = new JsonlSplitter(0, (l) => { got.push(l); return true; }, 100);
    sp.push(Buffer.from(`${long}\nok\n`));
    expect(got[0]).toMatchObject({ truncated: true });
    expect(got[0].text.length).toBe(100);
    expect(got[1]).toMatchObject({ text: 'ok', truncated: false, end: 5004 });
  });
  it('skips the cut first line when starting mid-file and reports where parsing began', () => {
    const got: string[] = [];
    const sp = new JsonlSplitter(10, (l) => { got.push(l.text); return true; }, undefined, true);
    sp.push(Buffer.from('tail-of-line\nfull\n'));
    expect(got).toEqual(['full']);
    expect(sp.parseStart).toBe(10 + 13);
    expect(sp.lastEnd).toBe(10 + 18);
  });
  it('stops when the callback returns false', () => {
    const got: string[] = [];
    const sp = new JsonlSplitter(0, (l) => { got.push(l.text); return false; });
    expect(sp.push(Buffer.from('a\nb\nc\n'))).toBe(false);
    expect(got).toEqual(['a']);
    expect(sp.stopped).toBe(true);
  });
});

describe('jsonl facts (title / cwd / kind rules)', () => {
  it('title: last ai-title wins over the first user message', () => {
    const f = factsOf([user('first question'), rec({ type: 'ai-title', aiTitle: 'Old title' }), rec({ type: 'ai-title', aiTitle: 'New title' })]);
    expect(titleOf(f)).toBe('New title');
  });
  it('title: first human text skips meta, tag-start, tool results and interruptions', () => {
    const f = factsOf([
      user('<command-name>/clear</command-name>'),
      user('caveat', { isMeta: true }),
      user([{ type: 'tool_result', content: 'x' }]),
      user('[Request interrupted by user]'),
      user([{ type: 'image' }, { type: 'text', text: '  실제\n  질문 입니다 ' }]),
      user('second'),
    ]);
    expect(titleOf(f)).toBe('실제 질문 입니다');
  });
  it('title: falls back to last-prompt, then null; custom-title has priority', () => {
    expect(titleOf(factsOf([user('<ide_opened_file>x</ide_opened_file>'), rec({ type: 'last-prompt', lastPrompt: 'lp' })]))).toBe('lp');
    expect(titleOf(factsOf([rec({ type: 'mode', mode: 'x' })]))).toBeNull();
    expect(titleOf(factsOf([rec({ type: 'ai-title', aiTitle: 'ai' }), rec({ type: 'custom-title', customTitle: 'mine' })]))).toBe('mine');
  });
  it('cwd: keeps the first cwd even if it changes later', () => {
    const f = factsOf([rec({ type: 'agent-setting', agentSetting: 'ceo' }), user('a'), rec({ type: 'user', cwd: 'D:\\other', message: { content: 'b' } })]);
    expect(f.cwd).toBe('D:\\work\\proj');
    expect(kindOf(f)).toBe('lead');
  });
  it('kind: teammate by teamName or <teammate-message>, sdk-cli, plain session', () => {
    const mate = factsOf([rec({ type: 'agent-setting', agentSetting: 'qa' }), user('<teammate-message teammate_id="team-lead">do it</teammate-message>'),
      rec({ type: 'assistant', teamName: 'session-4df7e772', agentName: 'qa', message: { content: [] } })]);
    expect(kindOf(mate)).toBe('teammate');
    expect(mate).toMatchObject({ teamName: 'session-4df7e772', teammateMsg: true });
    expect(kindOf(factsOf([user('<teammate-message x>hi</teammate-message>')]))).toBe('teammate');
    expect(kindOf(factsOf([rec({ type: 'user', entrypoint: 'sdk-cli', message: { content: 'x' } })]))).toBe('sdk');
    expect(kindOf(factsOf([user('hello')]))).toBe('session');
    // agent-name 레코드만 있는 스텁은 팀원이 아님(teamName 없음)
    expect(kindOf(factsOf([rec({ type: 'agent-name', agentName: 'x' })]))).toBe('session');
  });
  it('broken lines and missing/odd fields never throw', () => {
    const f = factsOf(['{bad json', '[1,2]', 'null', '"str"', '{"type":"user"}', '{"type":"user","message":null}', '{"type":"user","message":{"content":5}}',
      '{"type":"ai-title","aiTitle":42}', '{"cwd":7,"teamName":""}', '']);
    expect(f.bad).toBe(4);
    expect(titleOf(f)).toBeNull();
    expect(kindOf(f)).toBe('session');
  });
  it('very long first user line: title from its head (partial decode)', () => {
    const big = user(`붙여넣은 긴 글 ${'가'.repeat(400000)}`);
    const f = emptyFacts();
    applyLine(f, { text: big.slice(0, 1000), truncated: true, end: 0 });
    expect(titleOf(f)?.startsWith('붙여넣은 긴 글 가가')).toBe(true);
    expect(partialUserText(rec({ type: 'user', isMeta: true, message: { content: 'x' } }))).toBeNull();
    expect(partialUserText('{"type":"assistant","message":{"content":"x"}}')).toBeNull();
    expect(isNonTitleText('  <local-command-stdout>ok')).toBe(true);
    expect(isNonTitleText('a < b')).toBe(false);
  });
});

describe('indexFile / appendFile (head + tail streaming)', () => {
  const pad = (n: number): string[] => Array.from({ length: n }, (_, i) => rec({ type: 'api-request-blob', blob: `${i}`.padEnd(2000, '.') }));

  it('small file: reads everything once, offset at end of last complete line', async () => {
    const lines = [rec({ type: 'agent-setting', agentSetting: 'ceo' }), user('hello there'), rec({ type: 'ai-title', aiTitle: 'T1' })];
    const buf = Buffer.from(`${lines.join('\n')}\n{"partial":`);
    const r = await indexFile(memReader(buf, 7), 'd', `${SID}.jsonl`, buf.length);
    expect(titleOf(r.facts)).toBe('T1');
    expect(r.offset).toBe(buf.length - '{"partial":'.length);
  });

  it('large file: does not read the middle; last ai-title comes from the tail', async () => {
    const lines = [user('first'), rec({ type: 'ai-title', aiTitle: 'early' }), ...pad(3000), rec({ type: 'ai-title', aiTitle: 'latest' }), rec({ type: 'last-prompt', lastPrompt: 'lp' })];
    const buf = Buffer.from(`${lines.join('\n')}\n`);
    expect(buf.length).toBeGreaterThan(HEAD_MAX_BYTES);
    const rd = memReader(buf);
    const r = await indexFile(rd, 'd', `${SID}.jsonl`, buf.length);
    expect(titleOf(r.facts)).toBe('latest');
    expect(r.facts.cwd).toBe('D:\\work\\proj');
    expect(r.offset).toBe(buf.length);
    // 앞부분은 조건 충족 후 멈추고 뒤는 창 하나만 → 전체의 일부만 읽음
    expect(rd.bytesRead).toBeLessThan(buf.length / 2);
  });

  it('ai-title only before the tail window: found by stepping back', async () => {
    const lines = [user('first'), rec({ type: 'ai-title', aiTitle: 'head-title' }), ...pad(2000), rec({ type: 'ai-title', aiTitle: 'middle' }),
      ...pad(Math.ceil((TAIL_BYTES * 1.5) / 2050))];
    const buf = Buffer.from(`${lines.join('\n')}\n`);
    const r = await indexFile(memReader(buf), 'd', `${SID}.jsonl`, buf.length);
    expect(r.facts.aiTitle).toBe('middle');
  });

  it('append: continues from the offset (append-only) and picks up new titles', async () => {
    const a = `${[user('q1'), rec({ type: 'ai-title', aiTitle: 'A' })].join('\n')}\n`;
    const b = `${rec({ type: 'ai-title', aiTitle: 'B' })}\n${rec({ type: 'last-prompt', lastPrompt: 'x' })}\n`;
    const full = Buffer.from(a + b);
    const first = await indexFile(memReader(Buffer.from(a)), 'd', `${SID}.jsonl`, Buffer.byteLength(a));
    const e: IndexEntry = { dir: 'd', file: `${SID}.jsonl`, size: Buffer.byteLength(a), mtimeMs: 1, offset: first.offset, aligned: first.aligned, facts: first.facts };
    const rd = memReader(full, 3);
    const { offset: off } = await appendFile(rd, e, full.length);
    expect(off).toBe(full.length);
    expect(rd.bytesRead).toBe(Buffer.byteLength(b));
    expect(titleOf(e.facts)).toBe('B');
  });

  it('toItem/parseCache are defensive', () => {
    expect(toItem({ dir: 'd', file: 'not-a-uuid.jsonl', size: 1, mtimeMs: 1, offset: 0, aligned: true, facts: emptyFacts() })).toBeNull();
    expect(toItem({ dir: 'd', file: `${SID}.jsonl`, size: 1, mtimeMs: 1, offset: 0, aligned: true, facts: factsOf([user('x')]) })).toMatchObject({ sessionId: SID, title: 'x', kind: 'session' });
    expect(parseCache(null)).toEqual([]);
    expect(parseCache({ version: 999, entries: [] })).toEqual([]);
    // v0.6: 캐시 버전 3(firstAt 추가). 이전 버전 캐시는 버리고 다시 읽는다
    const entry = { dir: 'd', file: 'f', size: 1, mtimeMs: 2, offset: 0, facts: { lines: 1, aiTitle: 'x', cwd: 5, firstAt: 1700000000000 } };
    expect(parseCache({ version: 2, entries: [entry] })).toEqual([]);
    const ok = parseCache({ version: 3, entries: [entry, { dir: 1 }, null] });
    expect(ok).toHaveLength(1);
    expect(ok[0].facts.aiTitle).toBe('x');
    expect(ok[0].facts.cwd).toBeUndefined();
    expect(ok[0].facts.firstAt).toBe(1700000000000);
    expect(parseCache({ version: 3, entries: [{ ...entry, facts: { lines: 1, firstAt: 'x' } }] })[0].facts.firstAt).toBeUndefined();
  });
});

describe('history list (teammates grouped under the lead)', () => {
  const base = { dir: 'D--x', cwd: 'D:\\x', title: 't', teamName: null, agentName: null, mtimeMs: 1, size: 1, createdMs: null };
  // 파일 이름·키(인덱서 keyOf와 같은 <dir>/<file>)를 붙인다
  const keyed = <T extends { dir: string; sessionId: string }>(o: T): T & { file: string; key: string } => ({ ...o, file: `${o.sessionId}.jsonl`, key: `${o.dir}/${o.sessionId}.jsonl` });
  const lead = keyed({ ...base, sessionId: '4df7e772-0000-0000-0000-000000000000', kind: 'lead' as const });
  const other = keyed({ ...base, sessionId: '11111111-0000-0000-0000-000000000000', kind: 'session' as const, cwd: 'd:\\X\\' });
  const mate = (i: number) => keyed({ ...base, sessionId: `9999999${i}-0000-0000-0000-000000000000`, dir: 'C--elsewhere', kind: 'teammate' as const, teamName: 'session-4df7e772', agentName: `m${i}` });
  const sdk = keyed({ ...base, sessionId: '22222222-0000-0000-0000-000000000000', kind: 'sdk' as const });

  it('hides teammates (even in other folders) and counts them on the matching lead; sdk hidden by default', () => {
    const out = toHistoryDtos([lead, other, mate(1), mate(2), sdk], false);
    expect(out.map((x) => x.sessionId)).toEqual([lead.sessionId, other.sessionId]);
    expect(out[0].mates).toBe(2);
    expect(toHistoryDtos([lead, sdk], true).map((x) => x.kind)).toEqual(['lead', 'sdk']);
  });
  it('groups folders case-insensitively by first cwd', () => {
    expect(folderKeyOf('D:\\X', 'a')).toBe(folderKeyOf('d:\\x\\', 'b'));
    expect(folderKeyOf(null, 'D--x')).toBe('d--x');
    expect(folderNameOf('D:\\github\\win_memory', 'x')).toBe('win_memory');
    expect(folderNameOf(null, 'D--enc')).toBe('D--enc');
  });
  it('a file without cwd joins the group of its project folder', () => {
    const stub = keyed({ ...base, sessionId: '33333333-0000-0000-0000-000000000000', kind: 'session' as const, cwd: null, title: null });
    const out = toHistoryDtos([stub, other], false);
    expect(out[0].folderKey).toBe(out[1].folderKey);
    expect(toHistoryDtos([{ ...stub, dir: 'D--lonely' }], false)[0]).toMatchObject({ folderKey: 'd--lonely', folderName: 'D--lonely', cwd: null });
  });
});

describe('running conversations (sessions/<pid>.json)', () => {
  it('parses the psmux session from tmux', () => {
    expect(psmuxSessionOf('ctd-win_memory-a1b2c3:@1.%0')).toBe('ctd-win_memory-a1b2c3');
    expect(psmuxSessionOf('win_memory:@1.%1')).toBe('win_memory');
    expect(psmuxSessionOf(undefined)).toBeNull();
    expect(psmuxSessionOf('garbage')).toBeNull();
  });
  it('drops dead pids, marks ours, adds the resumed id as alias', () => {
    const files = [
      { pid: 1, sessionId: 'NEW', tmux: 'ctd-a-000001:@1.%0', status: 'busy' },
      { pid: 2, sessionId: 'EXT', tmux: 'win_memory:@1.%1', status: 'idle' },
      { pid: 3, sessionId: 'DEAD', tmux: 'ctd-b-000002:@1.%0' },
    ];
    const list = buildRunning(files, (p) => p !== 3, (s) => (s === 'ctd-a-000001' ? { ours: true, resumeSessionId: 'OLD' } : { ours: false }));
    expect(list.map((r) => [r.sessionId, r.ours, !!r.alias])).toEqual([['NEW', true, false], ['OLD', true, true], ['EXT', false, false]]);
    expect(findRunning(list, 'old')?.psmuxSession).toBe('ctd-a-000001');
    expect(findRunning(list, 'DEAD')).toBeNull();
  });
});
