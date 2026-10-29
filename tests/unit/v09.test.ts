// v0.9: 히스토리 ⋮ "세션 끊기…"(실행 중 대화, 출처 3분기) 표시 조건·main 재검증·이름/pid/프로세스 검증, 비활성 "삭제…" 사유 라벨(F2-1). 작업 중 Enter 미제출 방지(F5).

import { describe, expect, it } from 'vitest';

import { inputToCommands, splitSubmit } from '../../src/main/controlMode/quote';
import { isClaudeImage, isDefinitiveRefusal, judgeKill, judgeOwner, parseProcessInfo, processInfoScript, type ProcessInfo } from '../../src/main/history/procKill';
import { buildRunning, filterExcluded, isKillablePid, isSafeSessionName, planStop, sessionFileOwns, stopFailMessage, type OpenTabRef, type RunningConversation } from '../../src/main/history/running';
import type { HistoryItemDto, RunningDto, TabStateDto } from '../../src/shared/api';
import { stopSessionMessage } from '../../src/renderer/components/MenuDialogs';
import { isFreshTab, itemDot, stopTarget, trashBlockedReason } from '../../src/renderer/history';

const tab = (o: Partial<TabStateDto>): TabStateDto => ({ session: 'ctd-x-000000', leadSessionId: null, resumeSessionId: null, panes: [], ...o }) as unknown as TabStateDto;

const RUN: RunningDto[] = [
  { sessionId: 'det', psmuxSession: 'ctd-det-000001', ours: true },
  { sessionId: 'ext', psmuxSession: 'win_memory', ours: false },
  { sessionId: 'term', psmuxSession: null, ours: false },
  { sessionId: 'open-ps', psmuxSession: 'ctd-open-000002', ours: true },
];

describe('삭제 비활성 사유 라벨(v0.9)', () => {
  it('탭으로 열림 / 실행 중 / 외부에서 실행 중 / 삭제 가능', () => {
    const tabs = [tab({ resumeSessionId: 'resumed' }), tab({ session: 'ctd-open-000002' })];
    expect(trashBlockedReason('RESUMED', tabs, RUN)).toBe('탭으로 열림');
    // sessionId 갱신 전이라도 실행 중인 psmux 세션이 탭이면 탭으로 열림
    expect(trashBlockedReason('open-ps', tabs, RUN)).toBe('탭으로 열림');
    expect(trashBlockedReason('det', tabs, RUN)).toBe('실행 중');
    expect(trashBlockedReason('ext', tabs, RUN)).toBe('외부에서 실행 중');
    expect(trashBlockedReason('term', tabs, RUN)).toBe('외부에서 실행 중');
    expect(trashBlockedReason('none', tabs, RUN)).toBeNull();
  });
});

describe('"세션 끊기…" 표시 조건(F2-1): 실행 중 + 탭 없음, 출처 무관', () => {
  const RUNP: RunningDto[] = [
    { sessionId: 'det', psmuxSession: 'ctd-det-000001', ours: true, pid: 101, inPsmux: true },
    { sessionId: 'ext', psmuxSession: 'win_memory', ours: false, pid: 102, inPsmux: true },
    { sessionId: 'term', psmuxSession: null, ours: false, pid: 103, inPsmux: false },
    { sessionId: 'open-ps', psmuxSession: 'ctd-open-000002', ours: true, pid: 104, inPsmux: true },
    { sessionId: 'badname', psmuxSession: null, ours: false, pid: 105, inPsmux: true },
    { sessionId: 'nopid', psmuxSession: null, ours: false },
  ];
  it('앱 세션 / 외부 psmux / psmux 밖 프로세스, 탭 열림·미실행·이름 불가는 없음', () => {
    const tabs = [tab({ session: 'ctd-open-000002' }), tab({ leadSessionId: 'lead-open' })];
    expect(stopTarget('DET', tabs, RUNP)).toEqual({ kind: 'app', key: 'ctd-det-000001', name: 'ctd-det-000001', pid: 101 });
    expect(itemDot('det', tabs, RUNP)).toBe('detached');
    expect(stopTarget('ext', tabs, RUNP)).toEqual({ kind: 'psmux', key: 'win_memory', name: 'win_memory', pid: 102 });
    expect(stopTarget('term', tabs, RUNP)).toEqual({ kind: 'process', key: 'pid:103', name: null, pid: 103 });
    expect(stopTarget('open-ps', tabs, RUNP)).toBeNull(); // 탭으로 열림(psmux 세션 일치)
    expect(stopTarget('lead-open', tabs, [{ sessionId: 'lead-open', psmuxSession: 'ctd-o-000003', ours: true }])).toBeNull(); // 탭으로 열림(대화 ID 일치)
    expect(stopTarget('badname', tabs, RUNP)).toBeNull(); // psmux 안인데 이름을 쓸 수 없음
    expect(stopTarget('nopid', tabs, RUNP)).toBeNull(); // pid 모름
    expect(stopTarget('none', tabs, RUNP)).toBeNull(); // 미실행
  });

  it('alias로 묶인 두 행은 같은 대상 키(어느 쪽에서 끊어도 함께 갱신)', () => {
    const run = buildRunning([{ pid: 11, sessionId: 'new-id', tmux: 'ctd-a-000004:@0.%0' }], () => true, () => ({ ours: true, resumeSessionId: 'orig-id' }));
    const dto: RunningDto[] = run.map((r) => ({ sessionId: r.sessionId, psmuxSession: r.psmuxSession, ours: r.ours, pid: r.pid, inPsmux: r.inPsmux }));
    expect(stopTarget('new-id', [], dto)?.key).toBe('ctd-a-000004');
    expect(stopTarget('orig-id', [], dto)?.key).toBe('ctd-a-000004');
    // 끊은 뒤 실행 목록에서 빠지면 두 행 모두 항목이 사라지고 삭제가 가능해진다
    expect(stopTarget('orig-id', [], [])).toBeNull();
    expect(trashBlockedReason('orig-id', [], [])).toBeNull();
  });

  it('확인 문구: 출처별', () => {
    expect(stopSessionMessage({ kind: 'process', key: 'pid:42', name: null, pid: 42 })).toMatch(/다른 창에서 실행 중인 Claude Code\(PID 42\)가 종료됩니다/);
    expect(stopSessionMessage({ kind: 'psmux', key: 'x', name: 'x', pid: 1 })).toMatch(/psmux 세션 'x'가 종료됩니다\(그 안의 팀원 포함\)/);
    expect(stopSessionMessage({ kind: 'app', key: 'ctd-a', name: 'ctd-a', pid: 1 })).toMatch(/CEO에게 종료를 요청한 뒤 세션을 닫습니다/);
    // 세 분기 모두 끝에 같은 이어가기 안내
    for (const kind of ['app', 'psmux', 'process'] as const) {
      expect(stopSessionMessage({ kind, key: 'k', name: 'x', pid: 1 }).endsWith('끊은 뒤에도 이 대화를 클릭하면 새 탭에서 이어갈 수 있습니다(팀원은 복원되지 않음).')).toBe(true);
    }
  });
});

describe('대화 기록이 없는 탭(F1 ×: 분리 대신 종료 안내)', () => {
  const items = [{ sessionId: 'AAAA-lead' }] as unknown as HistoryItemDto[];
  it('이어간 대화면 기록이 히스토리에 없어도 false', () => {
    expect(isFreshTab(tab({ resumeSessionId: 'old', leadSessionId: null }), [])).toBe(false);
  });
  it('로그인 탭은 true(닫으면 바로 끝남)', () => {
    expect(isFreshTab(tab({ purpose: 'login', leadSessionId: 'aaaa-lead' }), items)).toBe(true);
  });
  it('리드 대화 ID를 아직 모르면 true', () => {
    expect(isFreshTab(tab({ leadSessionId: null }), items)).toBe(true);
  });
  it('리드 대화가 히스토리에 있으면 false(대소문자 무시), 없으면 true', () => {
    expect(isFreshTab(tab({ leadSessionId: 'aaaa-LEAD' }), items)).toBe(false);
    expect(isFreshTab(tab({ leadSessionId: 'bbbb-lead' }), items)).toBe(true);
  });
  it('칸을 나눈 탭은 false(셸 작업이 있을 수 있어 분리, main과 같은 규칙)', () => {
    expect(isFreshTab(tab({ leadSessionId: null, panes: [{}, {}] as TabStateDto['panes'] }), items)).toBe(false);
  });
});

describe('main 세션 끊기 재검증(planStop)', () => {
  const run = (o: Partial<RunningConversation> & { sessionId: string }): RunningConversation => ({ psmuxSession: null, ours: false, pid: 500, inPsmux: false, ...o });
  const list: RunningConversation[] = [
    run({ sessionId: 'det', psmuxSession: 'ctd-det-000001', ours: true, pid: 201, inPsmux: true }),
    run({ sessionId: 'orig', psmuxSession: 'ctd-det-000001', ours: true, alias: true, pid: 201, inPsmux: true }),
    run({ sessionId: 'ext', psmuxSession: 'win_memory', pid: 202, inPsmux: true }),
    run({ sessionId: 'term', pid: 203 }),
    run({ sessionId: 'badname', pid: 204, inPsmux: true }),
    run({ sessionId: 'quote', psmuxSession: "a'b", pid: 205, inPsmux: true }),
    run({ sessionId: 'pid0', pid: 0 }),
    run({ sessionId: 'pid4', pid: 4 }),
    run({ sessionId: 'pidf', pid: 1.5 }),
  ];
  const ref = (o: Partial<OpenTabRef>): OpenTabRef => ({ session: 'ctd-y-000000', leadSessionId: null, resumeSessionId: null, ...o });

  it('출처 3분기: 앱 세션(alias 포함) / 외부 psmux / psmux 밖 프로세스', () => {
    expect(planStop('det', list, [ref({})])).toEqual({ kind: 'app', key: 'ctd-det-000001', sessionId: 'det', psmuxSession: 'ctd-det-000001', pid: 201 });
    expect(planStop('ORIG', list, [])).toMatchObject({ kind: 'app', key: 'ctd-det-000001' });
    expect(planStop('ext', list, [])).toEqual({ kind: 'psmux', key: 'win_memory', sessionId: 'ext', psmuxSession: 'win_memory', pid: 202 });
    expect(planStop('term', list, [])).toEqual({ kind: 'process', key: 'pid:203', sessionId: 'term', psmuxSession: null, pid: 203 });
  });

  it('거부: 미실행 / 탭 열림(세션·리드 ID·이어간 ID) / 이름 불가 / pid 불가', () => {
    expect(planStop('none', list, [])).toBe('not-running');
    expect(planStop('det', list, [ref({ session: 'ctd-det-000001' })])).toBe('tab-open');
    expect(planStop('ORIG', list, [ref({ resumeSessionId: 'orig' })])).toBe('tab-open');
    expect(planStop('term', list, [ref({ leadSessionId: 'TERM' })])).toBe('tab-open');
    expect(planStop('badname', list, [])).toBe('bad-name'); // psmux 안인데 이름 없음 → 프로세스만 죽이지 않음
    expect(planStop('quote', list, [])).toBe('bad-name');
    expect(planStop('pid0', list, [])).toBe('bad-pid');
    expect(planStop('pid4', list, [])).toBe('bad-pid');
    expect(planStop('pidf', list, [])).toBe('bad-pid');
    // psmux 밖(세션 null) 대화는 다른 탭의 세션 이름과 일치시키지 않는다
    expect(planStop('term', list, [ref({ session: 'ctd-y-000000' })])).toMatchObject({ kind: 'process' });
  });

  it('사유 코드마다 안내 문구가 있다', () => {
    for (const code of ['not-running', 'tab-open', 'bad-name', 'bad-pid', 'pid-mismatch', 'not-claude', 'self', 'kill-failed', 'not-found'] as const) {
      expect(stopFailMessage(code)).toMatch(/\S/);
    }
  });

  it('buildRunning이 pid·inPsmux를 채운다(tmux 이름 형식이 틀리면 psmuxSession null + inPsmux)', () => {
    const r = buildRunning([
      { pid: 7, sessionId: 'a', tmux: 'bad name:@0.%0' },
      { pid: 8, sessionId: 'b' },
    ], () => true, () => ({ ours: false }));
    expect(r).toEqual([
      { sessionId: 'a', psmuxSession: null, ours: false, pid: 7, inPsmux: true },
      { sessionId: 'b', psmuxSession: null, ours: false, pid: 8, inPsmux: false },
    ]);
  });
});

describe('세션 이름·pid·프로세스 이미지 검증', () => {
  it('세션 이름: 영숫자·_·.·-만, 공백·따옴표·제어문자·빈 값·100자 초과 거부', () => {
    expect(isSafeSessionName('win_memory')).toBe(true);
    expect(isSafeSessionName('ctd-a.b-000001')).toBe(true);
    for (const bad of ['', 'a b', "a'b", 'a"b', 'a\x00b', 'a\nb', 'a;b', 'x'.repeat(101), null, 3]) {
      expect(isSafeSessionName(bad), String(bad)).toBe(false);
    }
  });
  it('pid: 정수 5 이상만', () => {
    expect(isKillablePid(1234)).toBe(true);
    for (const bad of [0, 4, -1, 1.5, NaN, Infinity, '1234', 2 ** 33]) expect(isKillablePid(bad), String(bad)).toBe(false);
  });
  it('CIM JSON 파싱: 정상 / 대상 없음 / 필드 누락·형식 오류·쓰레기는 null(→ error)', () => {
    const ok = JSON.stringify({ Name: 'claude.exe', CommandLine: '"C:\\x\\claude.exe" --agent ceo', CreationDate: '2026-10-26T09:39:30.8001234Z', IsAncestor: false }) + '\r\n';
    expect(parseProcessInfo(ok)).toEqual({ name: 'claude.exe', commandLine: '"C:\\x\\claude.exe" --agent ceo', createdMs: Date.UTC(2026, 9, 26, 9, 39, 30, 800), isAncestor: false });
    // BOM·명령줄 null(다른 사용자 프로세스)은 빈 명령줄로
    expect(parseProcessInfo('\uFEFF{"Name":"node.exe","CommandLine":null,"CreationDate":"2026-10-26T00:00:00Z","IsAncestor":true}')).toMatchObject({ commandLine: '', isAncestor: true });
    expect(parseProcessInfo('null\r\n')).toBe('gone');
    for (const bad of [
      '', 'garbage', '[]', '"x"', '{}',
      '{"CommandLine":"claude","CreationDate":"2026-10-26T00:00:00Z","IsAncestor":false}', // Name 없음
      '{"Name":"node.exe","CommandLine":"claude","IsAncestor":false}', // CreationDate 없음
      '{"Name":"node.exe","CommandLine":"claude","CreationDate":"2026-10-26T00:00:00Z"}', // IsAncestor 없음
      '{"Name":"node.exe","CommandLine":"claude","CreationDate":"2026-10-26T00:00:00Z","IsAncestor":"false"}', // 문자열 boolean
      '{"Name":"node.exe","CommandLine":"claude","CreationDate":"2026-10-26T00:00:00","IsAncestor":false}', // 시간대 없음(로컬로 해석될 수 있음)
      '{"Name":"node.exe","CommandLine":"claude","CreationDate":"/Date(1793007570800)/","IsAncestor":false}',
      '{"Name":"node.exe","CommandLine":5,"CreationDate":"2026-10-26T00:00:00Z","IsAncestor":false}',
    ]) expect(parseProcessInfo(bad), bad).toBeNull();
  });
  it('종료 허용: 이름·명령줄·생성 시각 ≤ 세션 파일 수정 시각·조상 아님을 모두 만족할 때만', () => {
    const mtime = Date.UTC(2026, 9, 26, 9, 40, 0);
    const info = (o: Partial<ProcessInfo>): ProcessInfo => ({ name: 'claude.exe', commandLine: '"C:\\x\\claude.exe" --agent ceo', createdMs: mtime - 60000, isAncestor: false, ...o });
    expect(judgeKill(info({}), mtime)).toBeNull();
    expect(judgeKill(info({ name: 'NODE.EXE', commandLine: 'node C:\\npm\\node_modules\\@anthropic-ai\\CLAUDE-code\\cli.js' }), mtime)).toBeNull();
    expect(judgeKill(info({ createdMs: mtime }), mtime)).toBeNull(); // 같은 시각은 허용(파일은 시작 뒤에 쓰임)
    // 1) 이름
    expect(judgeKill(info({ name: 'notepad.exe' }), mtime)).toBe('not-claude');
    // 2) 명령줄: node.exe라도 claude가 없으면(MCP 서버·vite·hook 스크립트 등에 pid 재사용) 거부, 읽지 못한 빈 명령줄도 거부
    expect(judgeKill(info({ name: 'node.exe', commandLine: 'node D:\\proj\\node_modules\\vite\\bin\\vite.js' }), mtime)).toBe('not-claude');
    expect(judgeKill(info({ commandLine: '' }), mtime)).toBe('not-claude');
    // 3) 세션 파일보다 늦게 생긴 프로세스 = pid만 재사용된 다른 프로세스
    expect(judgeKill(info({ createdMs: mtime + 1 }), mtime)).toBe('pid-mismatch');
    expect(judgeKill(info({}), Number.NaN)).toBe('pid-mismatch');
    // 4) 이 앱의 조상(앱을 실행한 Claude Code 등): /T가 앱까지 끝내므로 거부
    expect(judgeKill(info({ isAncestor: true }), mtime)).toBe('self');
  });
  it('CIM 스크립트: 검증된 정수만 보간, 큰따옴표·줄바꿈 없음, 잘못된 pid는 예외', () => {
    const s = processInfoScript(1234, 5678);
    expect(s).toContain('$t=[long]1234');
    expect(s).toContain('$c=[long]5678');
    expect(s).toContain('Get-CimInstance Win32_Process');
    expect(s).toContain("ToUniversalTime().ToString('o')");
    expect(s).not.toMatch(/["\r\n]/);
    for (const [a, b] of [[4, 5678], [1234, 0], [1.5, 5678], [Number.NaN, 5678]]) expect(() => processInfoScript(a, b)).toThrow();
  });
  it('Claude Code 이미지 이름: claude·node(.exe)만', () => {
    for (const ok of ['claude.exe', 'CLAUDE.EXE', 'node.exe', 'node', 'claude']) expect(isClaudeImage(ok)).toBe(true);
    for (const bad of ['notepad.exe', 'pwsh.exe', 'nodejs.exe', '', null]) expect(isClaudeImage(bad)).toBe(false);
  });
});

describe('QA 8차: psmux 경로 pid 확인·확정 거부 제외 캐시', () => {
  const mtime = Date.UTC(2026, 9, 26, 9, 50, 1);
  const info = (o: Partial<ProcessInfo>): ProcessInfo => ({ name: 'pwsh.exe', commandLine: 'pwsh -NoLogo', createdMs: mtime - 1000, isAncestor: false, ...o });

  it('judgeOwner: 생성 시각 ≤ 세션 파일 수정 시각·조상 아님만 보고 이름·명령줄은 보지 않음(칸 셸 pid)', () => {
    expect(judgeOwner(info({}), mtime)).toBeNull();
    expect(judgeOwner(info({ name: 'PING.EXE', commandLine: '' }), mtime)).toBeNull();
    // QA 재현: PING.EXE 생성 09:59:43Z, 파일 수정 09:50:01Z
    expect(judgeOwner(info({ name: 'PING.EXE', createdMs: Date.UTC(2026, 9, 26, 9, 59, 43) }), mtime)).toBe('pid-mismatch');
    expect(judgeOwner(info({}), Number.NaN)).toBe('pid-mismatch');
    expect(judgeOwner(info({ isAncestor: true }), mtime)).toBe('self');
  });

  it('제외 조건: pid 재사용·Claude 아닌 이미지·읽힌 명령줄에 claude 없음은 제외, 명령줄 못 읽음·조상 등은 제외 안 함', () => {
    expect(isDefinitiveRefusal('pid-mismatch', info({ name: 'claude.exe' }))).toBe(true);
    expect(isDefinitiveRefusal('not-claude', info({ name: 'PING.EXE' }))).toBe(true);
    // 이름은 claude/node인데 명령줄을 못 읽음(다른 사용자·관리자 프로세스) → 실제 실행 중일 수 있음
    expect(isDefinitiveRefusal('not-claude', info({ name: 'node.exe', commandLine: '' }))).toBe(false);
    // 이름은 node인데 읽힌 명령줄에 claude 없음(vite·MCP 서버 등에 pid 재사용) → 제외
    expect(isDefinitiveRefusal('not-claude', info({ name: 'node.exe', commandLine: 'node D:\\proj\\node_modules\\vite\\bin\\vite.js' }))).toBe(true);
    expect(isDefinitiveRefusal('self', info({ name: 'claude.exe', isAncestor: true }))).toBe(false);
    expect(isDefinitiveRefusal('error', info({}))).toBe(false);
    expect(isDefinitiveRefusal(null, info({}))).toBe(false);
  });

  it('제외 캐시: 같은 pid + 같은 수정 시각만 빼고, 수정 시각이 바뀌거나 파일이 없어지면 무효', () => {
    const files = [{ pid: 27888, sessionId: 'a', tmux: 'extsess2:@0.%0' }, { pid: 30000, sessionId: 'b' }];
    const cache = new Map<number, number>([[27888, mtime]]);
    expect(filterExcluded(files, cache, () => mtime).map((f) => f.pid)).toEqual([30000]);
    expect(cache.get(27888)).toBe(mtime); // 그대로 유지
    // 세션 파일이 다시 쓰이면(새 Claude가 같은 pid) 다시 실행 목록에 넣고 캐시에서 지운다
    expect(filterExcluded(files, cache, () => mtime + 1).map((f) => f.pid)).toEqual([27888, 30000]);
    expect(cache.has(27888)).toBe(false);
    // 파일이 사라지면 캐시에서 지운다(같은 pid가 나중에 새로 쓰여도 우연히 제외되지 않게)
    const c2 = new Map<number, number>([[27888, mtime]]);
    expect(filterExcluded([files[1]], c2, () => mtime)).toEqual([files[1]]);
    expect(c2.size).toBe(0);
    // stat 실패(null)도 무효
    const c3 = new Map<number, number>([[27888, mtime]]);
    expect(filterExcluded(files, c3, () => null)).toHaveLength(2);
    expect(c3.size).toBe(0);
    // 캐시가 비면 그대로
    expect(filterExcluded(files, new Map(), () => mtime)).toBe(files);
  });

  it('pid-mismatch 안내: 실행 중이 아닐 수 있음', () => {
    expect(stopFailMessage('pid-mismatch')).toMatch(/실행 중이 아닐 수 있어/);
  });
});

describe('QA 9차(M9-1): 끊기 직전 <pid>.json이 대상을 가리키는지', () => {
  const ids = new Set(['new-id', 'orig-id']);
  it('psmux 경로: 내용 pid = 파일 이름 pid, sessionId(alias 포함), tmux 세션 이름이 모두 맞을 때만', () => {
    const f = { pid: 36792, sessionId: 'NEW-ID', tmux: 'extsess-keep:@0.%0' };
    expect(sessionFileOwns(f, 36792, ids, 'extsess-keep')).toBe(true);
    expect(sessionFileOwns({ ...f, sessionId: 'orig-id' }, 36792, ids, 'extsess-keep')).toBe(true);
    // QA 재현: 36792.json은 tmux 없음(psmux 밖) → 외부 세션 extsess-keep의 소유 확인 실패
    expect(sessionFileOwns({ pid: 36792, sessionId: 'new-id' }, 36792, ids, 'extsess-keep')).toBe(false);
    expect(sessionFileOwns({ ...f, tmux: 'other:@0.%0' }, 36792, ids, 'extsess-keep')).toBe(false);
    expect(sessionFileOwns({ ...f, sessionId: 'someone-else' }, 36792, ids, 'extsess-keep')).toBe(false);
    // 내용 pid가 파일 이름과 다르거나 없음(77777777.json에 pid 36792 같은 경우)
    expect(sessionFileOwns(f, 77777777, ids, 'extsess-keep')).toBe(false);
    expect(sessionFileOwns({ ...f, pid: null }, 36792, ids, 'extsess-keep')).toBe(false);
    expect(sessionFileOwns(null, 36792, ids, 'extsess-keep')).toBe(false);
  });
  it('psmux 밖: tmux 필드가 없어야 함(형식이 틀린 tmux도 psmux 안으로 봄)', () => {
    expect(sessionFileOwns({ pid: 500, sessionId: 'new-id' }, 500, ids, null)).toBe(true);
    expect(sessionFileOwns({ pid: 500, sessionId: 'new-id', tmux: 'extsess:@0.%0' }, 500, ids, null)).toBe(false);
    expect(sessionFileOwns({ pid: 500, sessionId: 'new-id', tmux: 'bad name:@0.%0' }, 500, ids, null)).toBe(false);
  });
});

describe('입력 제출 분리(작업 중 Enter 미제출 방지, v0.9)', () => {
  it('한 줄: 본문 → Enter 두 묶음', () => {
    expect(splitSubmit('%1', inputToCommands('%1', 'hi'))).toEqual([["send-keys -t %1 -l 'hi'"], ['send-keys -t %1 Enter']]);
  });
  it('@ 참조: 본문 → End → Enter 순서로 각각', () => {
    const b = splitSubmit('%1', inputToCommands('%1', 'see @"D:\\x.txt"'));
    expect(b.map((x) => x.length)).toEqual([1, 1, 1]);
    expect(b.slice(1)).toEqual([['send-keys -t %1 End'], ['send-keys -t %1 Enter']]);
  });
  it('여러 줄(paste): 붙여넣기 끝 표지까지 본문, 마지막 Enter만 따로(줄 사이 Enter는 본문에 남음)', () => {
    const cmds = inputToCommands('%2', 'a\nb');
    const b = splitSubmit('%2', cmds);
    expect(b).toHaveLength(2);
    expect(b[0]).toEqual(cmds.slice(0, -1));
    expect(b[0][b[0].length - 1]).toBe('send-keys -t %2 -H 1b 5b 32 30 31 7e');
    expect(b[1]).toEqual(['send-keys -t %2 Enter']);
  });
  it('pwsh(ctrlj)도 같은 방식, 텍스트 "End"는 키로 오인하지 않음, 빈 입력은 빈 목록', () => {
    expect(splitSubmit('%3', inputToCommands('%3', 'a\nb', 'ctrlj')).at(-1)).toEqual(['send-keys -t %3 Enter']);
    expect(splitSubmit('%3', inputToCommands('%3', 'End'))).toEqual([["send-keys -t %3 -l 'End'"], ['send-keys -t %3 Enter']]);
    expect(splitSubmit('%3', [])).toEqual([]);
    expect(splitSubmit('%3', ['send-keys -t %3 C-c'])).toEqual([['send-keys -t %3 C-c']]);
  });
});
