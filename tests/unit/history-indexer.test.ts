// 히스토리 인덱서: 제목 필드 길이 제한, 팀원 앞부분 조기 종료, 비정렬 이어 읽기, append-only 확인, 인덱서 갱신 분기, 꼬리 앞 역방향 탐색, list-sessions 결과 해석.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readProjectRange, setClaudeHomeForTest } from '../../src/main/claudeHome';
import { appendFile, HistoryIndexer, indexFile, stillAppendOnly, TAIL_BYTES, type IndexEntry, type RangeReader } from '../../src/main/history/indexer';
import { applyLine, emptyFacts, headSatisfied, TITLE_MAX } from '../../src/main/history/jsonlFacts';

vi.mock('../../src/main/logger', () => ({ log: () => undefined, errMsg: (e: unknown) => String(e) }));

const SID = '4df7e772-1111-2222-3333-444455556666';
const rec = (o: Record<string, unknown>): string => JSON.stringify({ sessionId: SID, ...o });
const user = (content: string): string => rec({ type: 'user', cwd: 'D:\\w', message: { role: 'user', content } });
const mem = (buf: Buffer): RangeReader => async (_d, _f, start, end, onChunk) => {
  for (let p = start; p < Math.min(end, buf.length); p += 4096) if (!onChunk(buf.subarray(p, Math.min(p + 4096, end, buf.length)))) break;
};

describe('title fields are capped before caching', () => {
  it('ai-title / custom-title / summary / last-prompt keep only TITLE_MAX chars, whitespace collapsed', () => {
    const f = emptyFacts();
    const long = `a\n\n${'b'.repeat(5000)}`;
    for (const [type, key] of [['ai-title', 'aiTitle'], ['custom-title', 'customTitle'], ['summary', 'summary'], ['last-prompt', 'lastPrompt']]) {
      applyLine(f, { text: rec({ type, [key]: long }), truncated: false, end: 0 });
    }
    for (const v of [f.aiTitle, f.customTitle, f.summary, f.lastPrompt]) {
      expect(v?.length).toBe(TITLE_MAX);
      expect(v?.startsWith('a b')).toBe(true);
    }
  });
});

describe('teammate head scan stops at teamName', () => {
  it('stops immediately once teamName is seen, even before cwd/title', () => {
    const f = emptyFacts();
    applyLine(f, { text: rec({ type: 'attachment', teamName: 'session-4df7e772' }), truncated: false, end: 0 });
    expect(headSatisfied(f)).toBe(true);
  });
  it('a big teammate file reads only a little', async () => {
    const lines = [rec({ type: 'agent-setting', agentSetting: 'qa' }), rec({ type: 'user', teamName: 'session-4df7e772', cwd: 'D:\\w', message: { content: '<teammate-message>x</teammate-message>' } }),
      ...Array.from({ length: 3000 }, (_, i) => rec({ type: 'api-request-blob', b: `${i}`.padEnd(2000, '.') }))];
    const buf = Buffer.from(`${lines.join('\n')}\n`);
    let read = 0;
    const r: RangeReader = async (d, f, s, e, cb) => mem(buf)(d, f, s, e, (b) => { read += b.length; return cb(b); });
    const out = await indexFile(r, 'd', `${SID}.jsonl`, buf.length);
    expect(out.facts.teamName).toBe('session-4df7e772');
    // 앞부분 조기 종료, 뒷부분·뒤로 찾기 생략 → 앞 청크 몇 개만
    expect(read).toBeLessThan(TAIL_BYTES);
    expect(out).toMatchObject({ aligned: true });
    expect(out.offset).toBeLessThan(TAIL_BYTES);
  });
});

describe('alignment of the resume offset', () => {
  it('tail window without any newline → offset not aligned → next append skips the cut piece', async () => {
    const head = `${user('q')}\n`;
    const huge = `${rec({ type: 'api-request-blob', b: 'x'.repeat(TAIL_BYTES * 3) })}`; // 개행 없는 긴 줄(쓰는 중)
    const buf = Buffer.from(head + 'p'.repeat(5 * 2 ** 20) + huge);
    const r = await indexFile(mem(buf), 'd', `${SID}.jsonl`, buf.length);
    expect(r.aligned).toBe(false);
    const e: IndexEntry = { dir: 'd', file: `${SID}.jsonl`, size: buf.length, mtimeMs: 1, offset: r.offset, aligned: r.aligned, facts: r.facts };
    const grown = Buffer.concat([buf, Buffer.from(`\n${rec({ type: 'ai-title', aiTitle: 'after' })}\n`)]);
    const pos = await appendFile(mem(grown), e, grown.length);
    expect(pos).toEqual({ offset: grown.length, aligned: true });
    expect(e.facts.aiTitle).toBe('after');
    expect(e.facts.bad).toBe(r.facts.bad); // 잘린 조각을 해석하지 않음
  });
  it('stillAppendOnly: byte before the offset must be a newline', async () => {
    const a = Buffer.from(`${user('q')}\n${user('r')}\n`);
    const e: IndexEntry = { dir: 'd', file: 'f', size: a.length, mtimeMs: 1, offset: a.length, aligned: true, facts: emptyFacts() };
    expect(await stillAppendOnly(mem(Buffer.concat([a, Buffer.from('more\n')])), e)).toBe(true);
    const rewritten = Buffer.from(`${user('compacted summary that is longer')}\n${user('z')}\n`);
    expect(await stillAppendOnly(mem(rewritten), e)).toBe(false);
    expect(await stillAppendOnly(mem(rewritten), { ...e, aligned: false })).toBe(true);
  });
});

describe('HistoryIndexer update branches', () => {
  let home: string;
  let proj: string;
  let file: string;
  const D = 'D--w';
  const write = (s: string): void => writeFileSync(file, s);
  const titleNow = (ix: HistoryIndexer): string | null => ix.find(SID)?.title ?? null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ctd-ix-'));
    proj = join(home, 'projects', D);
    mkdirSync(proj, { recursive: true });
    file = join(proj, `${SID}.jsonl`);
    setClaudeHomeForTest(home);
  });
  afterEach(() => {
    setClaudeHomeForTest(null);
    rmSync(home, { recursive: true, force: true });
  });
  afterAll(() => setClaudeHomeForTest(null));

  it('append → incremental; shrink → full; same size but new mtime → full; rewritten while growing → full', async () => {
    write(`${user('first')}\n${rec({ type: 'ai-title', aiTitle: 'A' })}\n`);
    let reads: [number, number][] = [];
    const reader: RangeReader = async (d, f, s, e, cb) => { reads.push([s, e]); return readProjectRange(d, f, s, e, cb); };
    const ix = new HistoryIndexer(join(home, 'cache.json'), reader);
    await ix.scanAll();
    expect(titleNow(ix)).toBe('A');

    const before = statSync(file).size;
    reads = [];
    appendFileSync(file, `${rec({ type: 'ai-title', aiTitle: 'B' })}\n`);
    expect(await ix.updateFile(D, `${SID}.jsonl`)).toBe(true);
    expect(titleNow(ix)).toBe('B');
    expect(reads.every(([s]) => s >= before - 1)).toBe(true); // 이어 읽기(경계 확인 1바이트 포함)

    reads = [];
    write(`${user('short')}\n`);
    await ix.updateFile(D, `${SID}.jsonl`);
    expect(titleNow(ix)).toBe('short');
    expect(reads[0][0]).toBe(0); // 처음부터

    const same = `${user('x'.repeat(5))}\n`;
    write(same);
    await ix.updateFile(D, `${SID}.jsonl`);
    write(`${user('y'.repeat(5))}\n`);
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await ix.updateFile(D, `${SID}.jsonl`);
    expect(titleNow(ix)).toBe('yyyyy');

    // 다시 쓰이면서 커짐(append 아님) → 경계 확인 실패 → 처음부터
    write(`${rec({ type: 'custom-title', customTitle: 'rewritten' })}${' '.repeat(40)}\n${user('z')}\n`);
    await ix.updateFile(D, `${SID}.jsonl`);
    expect(titleNow(ix)).toBe('rewritten');
    ix.stop();
  });

  it('read failure keeps the previous entry; unreadable projects root keeps all entries', async () => {
    write(`${user('keep me')}\n`);
    let fail = false;
    const reader: RangeReader = async (d, f, s, e, cb) => {
      if (fail) throw new Error('EBUSY');
      return readProjectRange(d, f, s, e, cb);
    };
    const ix = new HistoryIndexer(join(home, 'cache.json'), reader);
    await ix.scanAll();
    fail = true;
    appendFileSync(file, `${rec({ type: 'ai-title', aiTitle: 'new' })}\n`);
    expect(await ix.updateFile(D, `${SID}.jsonl`)).toBe(false);
    expect(titleNow(ix)).toBe('keep me');

    // projects 자체를 못 읽는 상황(파일로 바뀜 → ENOTDIR): 예외 → 기존 항목 유지
    rmSync(join(home, 'projects'), { recursive: true, force: true });
    writeFileSync(join(home, 'projects'), 'not a dir');
    const errors: string[] = [];
    ix.on('error', (m: string) => errors.push(m));
    await ix.scanAll();
    expect(errors.length).toBe(1);
    expect(titleNow(ix)).toBe('keep me');
    ix.stop();
  });

  it('a removed file disappears from the list', async () => {
    write(`${user('bye')}\n`);
    const ix = new HistoryIndexer(join(home, 'cache.json'));
    await ix.scanAll();
    expect(ix.items()).toHaveLength(1);
    rmSync(file);
    await ix.scanAll();
    expect(ix.items()).toHaveLength(0);
    ix.stop();
  });
});

describe('tail back-scan and list-sessions parsing', () => {
  it('back-scan also finds custom-title / summary before the tail window, newest wins', async () => {
    const pad = (n: number): string[] => Array.from({ length: n }, (_, i) => rec({ type: 'api-request-blob', b: `${i}`.padEnd(2000, '.') }));
    const lines = [user('first'), rec({ type: 'custom-title', customTitle: 'old name' }), ...pad(2200), rec({ type: 'custom-title', customTitle: 'renamed' }),
      rec({ type: 'summary', summary: 'sum' }), ...pad(Math.ceil((TAIL_BYTES * 1.5) / 2050))];
    const buf = Buffer.from(`${lines.join('\n')}\n`);
    const r = await indexFile(mem(buf), 'd', `${SID}.jsonl`, buf.length);
    expect(r.facts.customTitle).toBe('renamed');
    expect(r.facts.summary).toBe('sum');
  });
  it('list-sessions "no server running" = 0 sessions; other failures = unknown', async () => {
    const { parseListSessions } = await import('../../src/main/psmux/sessionName');
    expect(parseListSessions(0, 'a\r\nb\n', '')).toEqual(['a', 'b']);
    expect(parseListSessions(1, '', 'no server running on \\.\pipe\psmux')).toEqual([]);
    expect(parseListSessions(1, '', 'timed out')).toBeNull();
  });
});
