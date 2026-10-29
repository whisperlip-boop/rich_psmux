// 탭 없는 앱 세션(F2-1 보완, 2026-10-28): 메타 있음·psmux 살아 있음·탭 없음·대화 기록 없음 판정, 대화 기록 공통 판정, 폴더 이름.

import { describe, expect, it } from 'vitest';

import type { SessionMeta } from '../../src/main/appData';
import { projectDirName } from '../../src/main/claudeHome';
import { folderBaseName, selectDetached, sessionHasConversation, type ConversationProbe, type DetachedInput } from '../../src/main/detached';
import { stopFailMessage, type StopFailCode } from '../../src/main/history/running';

const meta = (session: string, o: Partial<SessionMeta> = {}): SessionMeta => ({
  session, folder: `D:\\work\\${session}`, leadPaneId: '%0', leadCommand: 'claude --agent ceo', createdAt: 100, ...o,
});

/** 기본 입력: 모든 메타가 살아 있고 탭 없음, 대화 기록 없음. */
const input = (metas: SessionMeta[], o: Partial<DetachedInput> = {}): DetachedInput => ({
  metas: metas.map((m) => m.session),
  live: metas.map((m) => m.session),
  isTab: () => false,
  metaOf: (n) => metas.find((m) => m.session === n) ?? null,
  hasConversation: () => false,
  ...o,
});

describe('selectDetached', () => {
  it('대화 기록이 없는 살아 있는 세션은 포함, 탭으로 열렸거나 끊는 중인 세션은 제외', () => {
    const r = selectDetached(input([meta('ctd-a-1'), meta('ctd-b-2'), meta('ctd-c-3')], { isTab: (n) => n === 'ctd-b-2' || n === 'ctd-c-3' }));
    expect(r.detached.map((d) => d.session)).toEqual(['ctd-a-1']);
    expect(r.detached[0]).toEqual({ session: 'ctd-a-1', folder: 'D:\\work\\ctd-a-1', folderName: 'ctd-a-1', createdAt: 100, plain: false });
    expect(r.stale).toEqual([]);
  });
  it('psmux에 없는 메타는 stale(탭으로 열린 세션은 stale도 아님)', () => {
    const r = selectDetached(input([meta('ctd-a-1'), meta('ctd-gone-2'), meta('ctd-tab-3')], { live: ['ctd-a-1'], isTab: (n) => n === 'ctd-tab-3' }));
    expect(r.stale).toEqual(['ctd-gone-2']);
    expect(r.detached.map((d) => d.session)).toEqual(['ctd-a-1']);
  });
  it('live가 비면 모두 stale, 목록 없음', () => {
    const r = selectDetached(input([meta('ctd-a-1'), meta('ctd-b-2')], { live: [] }));
    expect(r.detached).toEqual([]);
    expect(r.stale).toEqual(['ctd-a-1', 'ctd-b-2']);
  });
  it('로그인 세션·메타를 못 읽는 세션은 제외', () => {
    const metas = [meta('ctd-login-1', { purpose: 'login' }), meta('ctd-a-2')];
    const r = selectDetached(input(metas, { metas: ['ctd-login-1', 'ctd-a-2', 'ctd-bad-3'], live: ['ctd-login-1', 'ctd-a-2', 'ctd-bad-3'] }));
    expect(r.detached.map((d) => d.session)).toEqual(['ctd-a-2']);
    expect(r.stale).toEqual([]);
  });
  it('대화 기록 판정은 콜백(메타·이름)을 따른다: ID 없는 옛 메타도 기록이 있으면 제외', () => {
    const legacy = meta('ctd-legacy-1');
    const seen: string[] = [];
    const has = selectDetached(input([legacy], { hasConversation: (m, n) => { seen.push(`${m.session}:${n}`); return true; } }));
    expect(has.detached).toEqual([]);
    expect(seen).toEqual(['ctd-legacy-1:ctd-legacy-1']);
    expect(selectDetached(input([legacy], { hasConversation: () => false })).detached.map((d) => d.session)).toEqual(['ctd-legacy-1']);
  });
  it('생성 시각 순, Claude만 탭(plain) 판정', () => {
    const metas = [
      meta('ctd-late-1', { createdAt: 300 }),
      meta('ctd-early-2', { createdAt: 100, leadCommand: 'claude' }),
      meta('ctd-mid-3', { createdAt: 200, leadCommand: '  claude  ' }),
    ];
    const r = selectDetached(input(metas));
    expect(r.detached.map((d) => [d.session, d.plain])).toEqual([['ctd-early-2', true], ['ctd-mid-3', true], ['ctd-late-1', false]]);
  });
});

describe('sessionHasConversation', () => {
  const CREATED = 1_000_000;
  const probe = (o: Partial<ConversationProbe>): ConversationProbe => ({
    ids: [], folder: 'D:\\x', createdAt: CREATED, hasFile: () => false, newestJsonl: () => null, ...o,
  });
  it('아는 ID의 파일이 있으면 true(이어간 대화 등)', () => {
    expect(sessionHasConversation(probe({ ids: [null, 'resumed-1'], hasFile: (id) => id === 'resumed-1' }))).toBe(true);
  });
  it('ID 없음 + .jsonl 없음 → false', () => {
    expect(sessionHasConversation(probe({}))).toBe(false);
  });
  it('ID 없음 + 세션 생성 뒤 수정된 .jsonl → true, 생성 5초 전보다 오래된 것만 있으면 false', () => {
    expect(sessionHasConversation(probe({ newestJsonl: () => CREATED + 10 }))).toBe(true);
    expect(sessionHasConversation(probe({ ids: [null, undefined, ''], newestJsonl: () => CREATED + 10 }))).toBe(true);
    expect(sessionHasConversation(probe({ newestJsonl: () => CREATED - 5000 }))).toBe(true);
    expect(sessionHasConversation(probe({ newestJsonl: () => CREATED - 5001 }))).toBe(false);
  });
  it('ID를 알고 파일이 없으면 같은 폴더에 더 새 .jsonl(다른 탭·외부 대화)이 있어도 false, 폴더는 보지 않는다', () => {
    let asked = false;
    expect(sessionHasConversation(probe({ ids: ['mine'], newestJsonl: () => { asked = true; return CREATED + 60_000; } }))).toBe(false);
    expect(asked).toBe(false);
  });
  it('/clear: 지난 ID(파일 있음) + 새 ID(파일 아직 없음) → true', () => {
    expect(sessionHasConversation(probe({ ids: ['old', 'new'], hasFile: (id) => id === 'old' }))).toBe(true);
  });
  it('ID는 대소문자 무시로 한 번씩만 확인하고, 폴더를 함께 넘긴다', () => {
    const calls: [string, string][] = [];
    sessionHasConversation(probe({ ids: ['AbC', 'abc', undefined, 'ABC', 'def'], hasFile: (id, f) => { calls.push([id, f]); return false; } }));
    expect(calls).toEqual([['AbC', 'D:\\x'], ['def', 'D:\\x']]);
  });
});

describe('projectDirName', () => {
  it('Claude Code projects 폴더 이름 규칙', () => {
    expect(projectDirName('D:\\github\\x')).toBe('D--github-x');
    expect(projectDirName('D:\\github\\x\\')).toBe('D--github-x');
    expect(projectDirName('C:\\my proj\\a.b_c\\한글')).toBe('C--my-proj-a-b-c---');
    expect(projectDirName('\\\\srv\\share\\p')).toBe('--srv-share-p');
  });
  it('드라이브 루트는 구분자까지 경로', () => {
    expect(projectDirName('D:\\')).toBe('D--');
  });
});

describe('folderBaseName', () => {
  it('마지막 이름, 끝 구분자 무시', () => {
    expect(folderBaseName('D:\\github\\proj')).toBe('proj');
    expect(folderBaseName('D:\\github\\proj\\')).toBe('proj');
    expect(folderBaseName('/home/u/proj//')).toBe('proj');
  });
  it('루트는 원래 값', () => {
    expect(folderBaseName('D:\\')).toBe('D:');
    expect(folderBaseName('/')).toBe('/');
  });
});

describe('끊기 거부 사유', () => {
  it("'has-conversation'은 안내 문구가 있다", () => {
    const code: StopFailCode = 'has-conversation';
    expect(stopFailMessage(code)).toBeTruthy();
    expect(stopFailMessage(code)).not.toBe('stop.hasConversation');
  });
});
