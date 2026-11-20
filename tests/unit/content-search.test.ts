// 대화 본문 검색: 사람 입력·assistant 텍스트만, 대소문자 무시, JSON 이스케이프, 첫 일치에서 멈춤, 취소, 긴 줄·읽기 실패 건너뜀.
import { describe, expect, it } from 'vitest';

import { searchContent, searchableTexts, snippetAround, type ContentReader, type ContentTarget } from '../../src/main/history/contentSearch';
import { CONTENT_QUERY_MAX, CONTENT_QUERY_MIN, findMatch, highlightRange } from '../../src/shared/search';

const line = (o: Record<string, unknown>): string => JSON.stringify(o);
const user = (content: unknown, extra: Record<string, unknown> = {}): string => line({ type: 'user', message: { role: 'user', content }, ...extra });
const ai = (content: unknown): string => line({ type: 'assistant', message: { model: 'm', content } });

/** 메모리 파일 읽기(작은 조각으로 나눠 줄 경계가 조각 사이에 걸리게). reads = 파일별 읽은 바이트. */
function memReader(files: Record<string, string>, chunk = 7): { read: ContentReader; reads: Record<string, number> } {
  const reads: Record<string, number> = {};
  const read: ContentReader = async (_dir, file, start, end, onChunk) => {
    if (!(file in files)) throw new Error('ENOENT');
    const buf = Buffer.from(files[file]);
    reads[file] = 0;
    for (let p = start; p < Math.min(end, buf.length); p += chunk) {
      const b = buf.subarray(p, Math.min(p + chunk, buf.length));
      reads[file] += b.length;
      if (!onChunk(b)) break;
    }
  };
  return { read, reads };
}
const target = (id: string): ContentTarget => ({ sessionId: id, dir: 'd', file: `${id}.jsonl` });
const run = async (files: Record<string, string>, q: string): Promise<string[]> =>
  (await searchContent(memReader(files).read, Object.keys(files).map((f) => target(f.replace('.jsonl', ''))), q, { cancelled: false })).hits.map((h) => h.sessionId);

describe('searchableTexts', () => {
  it('takes user input and assistant text blocks only', () => {
    expect(searchableTexts(JSON.parse(user('hello')))).toEqual(['hello']);
    expect(searchableTexts(JSON.parse(user([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])))).toEqual(['a', 'b']);
    expect(searchableTexts(JSON.parse(user('x', { isMeta: true })))).toEqual([]);
    expect(searchableTexts(JSON.parse(user([{ type: 'tool_result', content: 'secret output' }])))).toEqual([]);
    expect(searchableTexts(JSON.parse(ai([{ type: 'thinking', thinking: 't' }, { type: 'tool_use', input: { q: 'x' } }, { type: 'text', text: 'answer' }])))).toEqual(['answer']);
    expect(searchableTexts({ type: 'summary', summary: 's' })).toEqual([]);
    expect(searchableTexts({ type: 'user', message: 'bad' })).toEqual([]);
  });
});

describe('snippetAround', () => {
  it('collapses whitespace, marks cut ends and keeps surrogate pairs whole', () => {
    expect(snippetAround('short\n\ntext', 0, 5)).toBe('short text');
    const long = `${'a'.repeat(100)}NEEDLE${'b'.repeat(200)}`;
    const s = snippetAround(long, 100, 6);
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('NEEDLE');
    // 두 끝이 모두 서로게이트 쌍 가운데(낮은 쪽)에 떨어지게: 시작 161-40=121, 끝 161+1+80=242
    const emoji = `${'😀'.repeat(80)}abc${'😀'.repeat(80)}`;
    const cut = snippetAround(emoji, 161, 1);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(cut)).toBe(false);
    expect(cut).toBe(`…${'😀'.repeat(20)}abc${'😀'.repeat(40)}…`);
  });
});

describe('highlightRange', () => {
  it('collapses runs of spaces in the query like the snippet does', () => {
    expect(highlightRange('fix the parser bug', 'the   PARSER')).toEqual({ index: 4, length: 10 });
    expect(findMatch('fix the parser bug', 'the   parser')).toBeNull(); // 그대로면 놓침
    expect(highlightRange('abc', 'zz')).toBeNull();
    expect(CONTENT_QUERY_MAX).toBe(200);
  });
});

describe('searchContent', () => {
  it('finds case-insensitive matches in user and assistant text, not in tool output', async () => {
    const files = {
      'a.jsonl': `${user('Please fix the Parser')}\n`,
      'b.jsonl': `${ai([{ type: 'text', text: 'the parser is fixed' }])}\n`,
      'c.jsonl': `${user([{ type: 'tool_result', content: 'parser log' }])}\n${ai([{ type: 'tool_use', input: { cmd: 'parser' } }])}\n`,
      'd.jsonl': `${user('한글 검색 테스트')}\n`,
    };
    expect(await run(files, 'PARSER')).toEqual(['a', 'b']);
    expect(await run(files, '검색')).toEqual(['d']);
    expect(await run(files, 'p')).toEqual([]); // 최소 길이 미만
    expect(CONTENT_QUERY_MIN).toBe(2);
  });
  it('matches text that JSON escapes (quotes, backslashes, newlines)', async () => {
    const files = { 'e.jsonl': `${user('open "C:\\temp" now')}\n`, 'f.jsonl': `${user('line one\nline two')}\n` };
    expect(await run(files, '"c:\\temp"')).toEqual(['e']);
    expect(await run(files, 'one\nline')).toEqual(['f']);
  });
  it('stops reading a file at the first match and returns a snippet', async () => {
    const big = `${user('needle here')}\n${Array.from({ length: 50 }, () => ai([{ type: 'text', text: 'filler '.repeat(20) }])).join('\n')}\n`;
    const m = memReader({ 'g.jsonl': big });
    const r = await searchContent(m.read, [target('g')], 'needle', { cancelled: false });
    expect(r.hits).toEqual([{ sessionId: 'g', snippet: 'needle here' }]);
    expect(m.reads['g.jsonl']).toBeLessThan(big.length / 2);
  });
  it('honours cancellation and reports progress', async () => {
    const files = { 'h.jsonl': `${user('word')}\n`, 'i.jsonl': `${user('word')}\n` };
    const token = { cancelled: false };
    const seen: [number, number][] = [];
    const r = await searchContent(memReader(files).read, [target('h'), target('i')], 'word', token, (d, t) => {
      seen.push([d, t]);
      token.cancelled = true;
    });
    expect(r.hits.map((h) => h.sessionId)).toEqual(['h']);
    expect(seen).toEqual([[1, 2]]);
  });
  it('keeps snippet and highlight on the original text when lowercasing changes length (İ)', async () => {
    // 'İ'.toLowerCase()는 두 글자라 소문자 문자열 기준 위치를 쓰면 일치 부분이 밀린다
    const text = `${'İ'.repeat(60)} needle tail`;
    expect(findMatch(text, 'NEEDLE')).toEqual({ index: 61, length: 6 });
    expect(findMatch(text, '  ')).toBeNull();
    const m = memReader({ 'l.jsonl': `${user(text)}\n` });
    const r = await searchContent(m.read, [target('l')], 'needle', { cancelled: false });
    expect(r.hits[0].snippet).toBe(`…${'İ'.repeat(39)} needle tail`);
    expect(findMatch('x İstanbul', 'İSTANBUL')).toEqual({ index: 2, length: 8 });
  });
  it('finds text typed next to a pasted image when it comes before the image data (over-long user line)', async () => {
    const big = 'A'.repeat(300 * 1024);
    const textFirst = user([{ type: 'text', text: 'look at this Screenshot please' }, { type: 'image', source: { type: 'base64', data: big } }]);
    const imageFirst = user([{ type: 'image', source: { type: 'base64', data: big } }, { type: 'text', text: 'screenshot after image' }]);
    const { read } = memReader({ 'm.jsonl': `${textFirst}\n`, 'n.jsonl': `${imageFirst}\n` }, 64 * 1024);
    const r = await searchContent(read, [target('m'), target('n')], 'screenshot', { cancelled: false });
    // 이미지 뒤의 글은 잘린 뒷부분이라 찾지 못한다(알려진 제약)
    expect(r.hits).toEqual([{ sessionId: 'm', snippet: 'look at this Screenshot please' }]);
  });
  it('never matches over-long tool results or assistant tool calls; typed quotes do not trip the guard', async () => {
    const big = 'x'.repeat(300 * 1024);
    const files = {
      // 도구 결과: 문자열 형태 / 블록 형태(둘 다 type user 레코드)
      'o.jsonl': `${user([{ type: 'tool_result', tool_use_id: 't1', content: `needle ${big}` }])}\n`,
      'p.jsonl': `${user([{ tool_use_id: 't2', type: 'tool_result', content: [{ type: 'text', text: `needle ${big}` }] }])}\n`,
      // assistant 도구 호출: 입력 안에 "type":"user"와 content 문자열
      'q.jsonl': `${ai([{ type: 'tool_use', id: 't3', input: { type: 'user', content: `needle ${big}` } }])}\n`,
      // 사람이 입력한 글 안의 "type":"tool_result"(이스케이프된 따옴표) + 뒤에 이미지
      'r.jsonl': `${user([{ type: 'text', text: 'see "type":"tool_result" needle' }, { type: 'image', source: { type: 'base64', data: big } }])}\n`,
    };
    const { read } = memReader(files, 64 * 1024);
    const r = await searchContent(read, ['o', 'p', 'q', 'r'].map(target), 'needle', { cancelled: false });
    expect(r.hits).toEqual([{ sessionId: 'r', snippet: 'see "type":"tool_result" needle' }]);
  });
  it('skips over-long non-user lines, broken lines and unreadable files', async () => {
    const huge = ai([{ type: 'text', text: `needle ${'x'.repeat(300 * 1024)}` }]);
    const { read } = memReader({ 'j.jsonl': `${huge}\n{broken needle\n`, 'k.jsonl': `${user('needle')}\n` }, 64 * 1024);
    const r = await searchContent(read, [target('j'), target('gone'), target('k')], 'needle', { cancelled: false });
    expect(r.hits.map((h) => h.sessionId)).toEqual(['k']);
    expect(r.failed).toBe(1);
    expect(r.scanned).toBe(2);
  });
});
