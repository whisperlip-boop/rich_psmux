// 실제 psmux 통합 테스트(Claude 호출 없음, pwsh 칸 기준): 연결 → 분할 → 창 분리 → 크기 지정 → 입력 → 출력 수신
// → 끊김 재연결·재동기화 → 칸 종료 감지 → 정리. 세션 이름은 ctd-itest_<랜덤>, 끝나면 kill-session 후 잔여 확인.
// M2: 세션 2개 동시 연결(입출력 분리)·분리·재연결(메타 기준)·복원 필터·리드 칸 종료 표시·종료 시 앱 파일 정리.
// 실행: npm run itest   (결과: 콘솔 + out/itest/result.json). 테스트 세션 이름은 ctd-dev-<6자>(임시 폴더 dev).
// 기존 psmux 세션은 list-sessions 조회만 하고 건드리지 않는다.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listMetaSessions, readSessionMeta, sessionFiles } from '../../src/main/appData';
import { ControlClient } from '../../src/main/controlMode/client';
import { initLogger } from '../../src/main/logger';
import { hasSession, listSessionNames, psmuxCli } from '../../src/main/psmux/cli';
import { cleanEnv, resolvePsmux } from '../../src/main/psmux/env';
import { TabSession, type TabState } from '../../src/main/psmux/sessionManager';
import { selectRestorable } from '../../src/main/psmux/sessionName';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
type Check = { name: string; pass: boolean; detail?: unknown };
type CheckFn = (name: string, pass: boolean, detail?: unknown) => void;

const waitUntil = async (pred: () => boolean, ms: number): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (pred()) return true;
  return pred();
};

/** 임시 폴더 아래 <name>/dev 폴더(세션 이름이 ctd-dev-<6자>가 되게). */
function devFolder(root: string, name: string): string {
  const f = join(root, name, 'dev');
  mkdirSync(f, { recursive: true });
  return f;
}

/** M2: 서로 다른 폴더의 세션 2개를 동시에 연결해 입출력이 섞이지 않는지, 분리·재연결·복원 필터·정리를 확인한다. */
async function multiSession(psmux: string, dataDir: string, before: string[], check: CheckFn): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ctd-itest-ms-'));
  const out = new Map<string, string>();
  const collect = (t: TabSession): void => {
    t.on('output', (_p: string, d: Buffer) => out.set(t.session, (out.get(t.session) ?? '') + d.toString('utf8')));
    t.on('resync', (_p: string, d: string) => out.set(`${t.session}#resync`, (out.get(`${t.session}#resync`) ?? '') + d));
  };
  const text = (t: TabSession): string => out.get(t.session) ?? '';
  // --agent <이름>은 Write-Output의 추가 인자로 출력될 뿐이고 리드 이름 계산에 쓰인다(메타 leadCommand 기준 확인용).
  // 리드 명령에 #(주석)은 쓸 수 없으므로(QA M4-2) 주석 없이 한 명령으로 둔다
  const A = new TabSession({ psmux, folder: devFolder(root, 'a'), dataDir, hookCommand: null, leadCommand: "Write-Output ('MS-A-' + (2+3)) --agent alpha" });
  const B = new TabSession({ psmux, folder: devFolder(root, 'b'), dataDir, hookCommand: null, leadCommand: "Write-Output ('MS-B-' + (3+4)) --agent beta" });
  const all: TabSession[] = [A, B];
  collect(A);
  collect(B);
  try {
    await Promise.all([A.start(), B.start()]);
    const names = [A.session, B.session];
    check('M2 two sessions started concurrently (ctd-dev-*)', names.every((n) => /^ctd-dev-[0-9a-f]{6}$/.test(n)) && A.session !== B.session, names);
    const leadA = A.state().leadPaneId!;
    const leadB = B.state().leadPaneId!;
    const ok = await waitUntil(() => text(A).includes('MS-A-5') && text(B).includes('MS-B-7'), 15000);
    check('M2 each lead output arrives in its own tab only', ok && !text(A).includes('MS-B-') && !text(B).includes('MS-A-'));
    check('M2 lead names from each command', A.state().panes[0]?.label.name === 'alpha' && B.state().panes[0]?.label.name === 'beta',
      [A.state().panes[0]?.label.name, B.state().panes[0]?.label.name]);
    await A.sendInput(leadA, "Write-Output ('ONLY-A-' + (3*3))");
    await B.sendInput(leadB, "Write-Output ('ONLY-B-' + (4*4))");
    const routed = await waitUntil(() => text(A).includes('ONLY-A-9') && text(B).includes('ONLY-B-16'), 8000);
    check('M2 input to each tab reaches only that session', routed && !text(A).includes('ONLY-B-') && !text(B).includes('ONLY-A-'));

    // 앱 시작 시 복원 필터: 메타가 있는 ctd- 세션만(시작 전부터 있던 세션은 제외)
    const live = await listSessionNames(psmux);
    const pick = selectRestorable(live, listMetaSessions(dataDir));
    check('M2 restore filter picks only sessions with app data', pick.includes(A.session) && pick.includes(B.session) && !pick.some((n) => before.includes(n)), pick);

    // 분리: 연결만 끊고 세션 유지 → 메타로 재연결
    A.detach();
    await sleep(500);
    check('M2 detach keeps the psmux session', await hasSession(psmux, A.session));
    const meta = readSessionMeta(dataDir, A.session);
    check('M2 meta keeps folder / lead pane / lead command', !!meta && meta.leadPaneId === leadA && meta.leadCommand.includes('--agent alpha'), meta);
    const A2 = new TabSession({ psmux, folder: meta!.folder, leadCommand: meta!.leadCommand, dataDir, hookCommand: null, attachName: A.session });
    all.push(A2);
    collect(A2);
    await A2.start();
    const re = await waitUntil(() => (out.get(`${A2.session}#resync`) ?? '').includes('ONLY-A-9'), 8000);
    const st = A2.state();
    check('M2 reattach: connected, lead pane + name from meta, screen restored by capture-pane', re && st.status === 'connected' && st.leadPaneId === leadA &&
      st.panes.find((p) => p.paneId === leadA)?.label.name === 'alpha', { status: st.status, lead: st.leadPaneId, name: st.panes[0]?.label.name, resync: re });
    const fromA = text(A2).length;
    await A2.sendInput(leadA, "Write-Output ('AFTER-REATTACH-' + (5+5))");
    check('M2 input works after reattach', await waitUntil(() => text(A2).slice(fromA).includes('AFTER-REATTACH-10'), 8000));
    check('M2 other tab unaffected by detach/reattach', B.state().status === 'connected' && !text(B).includes('AFTER-REATTACH'));

    // 리드 칸 종료(팀원 칸은 남음) → 끊김이 아니라 leadGone으로 구분(M1 이월 M7)
    const sp = await psmuxCli(psmux, ['split-window', '-t', B.session]);
    const two = await waitUntil(() => B.state().panes.length === 2, 8000);
    const leadWin = B.state().panes.find((p) => p.paneId === leadB)?.windowId;
    const kw = leadWin ? await psmuxCli(psmux, ['kill-window', '-t', `${B.session}:${leadWin}`]) : { code: -1 };
    const gone = await waitUntil(() => B.state().leadGone, 8000);
    check('M2 lead pane gone is reported as leadGone (not disconnected)', sp.code === 0 && two && kw.code === 0 && gone && B.state().status === 'connected',
      { split: sp.code, two, kill: kw.code, leadGone: B.state().leadGone, status: B.state().status });

    // 종료: 리드가 셸뿐이면 요청 없이 세션 종료 + 앱 파일 정리
    const filesA = sessionFiles(dataDir, A2.session);
    const requested = await A2.terminate();
    check('M2 terminate (shell lead): no request sent, session killed, app files removed', !requested && !(await hasSession(psmux, A2.session)) &&
      !existsSync(filesA.meta) && !existsSync(filesA.labels), { requested });
    const filesB = sessionFiles(dataDir, B.session);
    await B.kill();
    check('M2 kill removes app files', !(await hasSession(psmux, B.session)) && !existsSync(filesB.meta));

    // v0.9 히스토리 "세션 종료…": 분리된 세션에 탭 없이 붙어 바로 terminate → 칸 목록을 먼저 읽고(리드 판정) 세션 종료 + 앱 파일 정리
    const D = new TabSession({ psmux, folder: devFolder(root, 'd'), dataDir, hookCommand: null, leadCommand: "Write-Output ('LEAD-' + 'D')" });
    all.push(D);
    await D.start();
    const leadD = D.state().leadPaneId;
    D.detach();
    const metaD = readSessionMeta(dataDir, D.session);
    const D2 = new TabSession({ psmux, folder: metaD!.folder, leadCommand: metaD!.leadCommand, dataDir, hookCommand: null, attachName: D.session });
    all.push(D2);
    await D2.start();
    const filesD = sessionFiles(dataDir, D2.session);
    const reqD = await D2.terminate();
    const stD = D2.state();
    check('v0.9 hidden attach + terminate: panes read first, shell lead -> no request, session killed, app files removed',
      !reqD && stD.leadPaneId === leadD && stD.panes.length >= 1 && !(await hasSession(psmux, D2.session)) && !existsSync(filesD.meta),
      { requested: reqD, lead: stD.leadPaneId, panes: stD.panes.length });

    // 리뷰 Major 1: 리드가 승인 대기 중이면 종료 요청 전에 Esc를 먼저 보낸다(텍스트+Enter가 승인으로 처리되지 않게).
    // 리뷰 Minor 9: 종료 처리 중에는 입력을 받지 않는다. hook 기록은 가짜 PermissionRequest 1줄로 흉내(Claude 호출 없음)
    const C = new TabSession({ psmux, folder: devFolder(root, 'c'), dataDir, hookCommand: '"node" "noop.js"', statusLineCommand: '"node" "sl.js" "u.json"', leadCommand: "Write-Output ('LEAD-' + 'C')" });
    all.push(C);
    await C.start();
    const leadC = C.state().leadPaneId!;
    // F7-1: 리드 --settings 파일에 hook과 statusLine이 함께 들어간다
    const leadSettings = JSON.parse(readFileSync(sessionFiles(dataDir, C.session).hookSettings, 'utf8')) as { hooks?: Record<string, unknown>; statusLine?: { type?: string; command?: string } };
    check('F7-1 lead --settings has hooks and statusLine command',
      !!leadSettings.hooks?.PermissionRequest && leadSettings.statusLine?.type === 'command' && leadSettings.statusLine.command === '"node" "sl.js" "u.json"',
      leadSettings.statusLine);
    await C.sendInput(leadC, 'node');
    const nodeUp = await waitUntil(() => C.paneInfo(leadC).command === 'node', 10000);
    appendFileSync(sessionFiles(dataDir, C.session).hookEvents, `${JSON.stringify({ t: Date.now(), event: 'PermissionRequest', pane: leadC, toolName: 'Bash' })}\n`);
    const waiting = await waitUntil(() => C.state().panes.find((x) => x.paneId === leadC)?.waiting === true, 5000);
    const term = C.terminate();
    await sleep(50);
    const refused = await C.sendInput(leadC, 'should-not-arrive');
    const requestedC = await term;
    const logText = readFileSync(join(dataDir, 'logs', 'app.log'), 'utf8').split('\n').filter((l) => l.includes(`[${C.session}]`));
    const iEsc = logText.findIndex((l) => l.includes('sent Escape first'));
    const iReq = logText.findIndex((l) => l.includes('shutdown request sent=true'));
    check('M2 terminate on approval-waiting lead: Escape first, then request; input refused while terminating',
      nodeUp && waiting && requestedC && iEsc >= 0 && iReq > iEsc && !refused && !(await hasSession(psmux, C.session)),
      { nodeUp, waiting, requestedC, iEsc, iReq, refused });
  } catch (e) {
    check('M2 no exception', false, (e as Error).message);
  } finally {
    for (const t of all) await t.kill();
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const psmux = await resolvePsmux();
  if (!psmux) throw new Error('psmux not found');
  const dataDir = mkdtempSync(join(tmpdir(), 'ctd-itest-'));
  initLogger(join(dataDir, 'logs'), !!process.env.ITEST_VERBOSE);
  const before = await listSessionNames(psmux);
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail?: unknown): void => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
  };

  const wsRoot = mkdtempSync(join(tmpdir(), 'ctd-itest-ws-'));
  const t = new TabSession({
    psmux, folder: devFolder(wsRoot, 'main'), dataDir, hookCommand: null,
    // 리드 명령 자리에 pwsh 명령(Claude 호출 없음)
    leadCommand: "Write-Output ('ITEST-READY-' + (1+1))",
    attachName: undefined,
  });
  const text = new Map<string, string>();
  const sizes: { pane: string; cols: number; rows: number }[] = [];
  const resyncs = new Map<string, string>();

  const statuses: string[] = [];
  t.on('output', (p: string, d: Buffer) => text.set(p, (text.get(p) ?? '') + d.toString('utf8')));
  t.on('size', (pane: string, cols: number, rows: number) => sizes.push({ pane, cols, rows }));
  t.on('resync', (p: string, d: string) => resyncs.set(p, d));
  // 화면 재현용: 칸별 출력·재동기화 순서 기록(QA NEW-2 중복 판정)
  // seq: control mode 스트림 순번(출력 묶음은 첫~끝, 재동기화는 캡처 응답) — NEW-2 실패 회차 진단용
  const stream = new Map<string, { kind: 'out' | 'resync'; data: string; at: number; seq: string }[]>();
  const rec = (p: string, kind: 'out' | 'resync', data: string, seq: string): void => { const a = stream.get(p) ?? []; a.push({ kind, data, at: Date.now(), seq }); stream.set(p, a); };
  t.on('output', (p: string, d: Buffer, s1?: number, s2?: number) => rec(p, 'out', d.toString('utf8'), `${s1 ?? '?'}-${s2 ?? '?'}`));
  t.on('resync', (p: string, d: string, s?: number) => rec(p, 'resync', d, `${s ?? '?'}`));
  t.on('state', (s: TabState) => {

    if (statuses[statuses.length - 1] !== s.status) statuses.push(s.status);
  });
  const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (pred()) return true;
    return pred();
  };
  const state = (): TabState => t.state();
  const since = (p: string): number => (text.get(p) ?? '').length;
  const outAfter = (p: string, from: number): string => (text.get(p) ?? '').slice(from);

  try {
    await t.start();
    check('session created with ctd- prefix', t.session.startsWith('ctd-') && (await hasSession(psmux, t.session)), t.session);
    const lead = state().leadPaneId!;
    check('lead pane detected', /^%\d+$/.test(lead ?? ''), lead);
    check('lead command output received via %output', await waitFor(() => (text.get(lead) ?? '').includes('ITEST-READY-2'), 15000));

    // 팀원 칸 흉내: 리드 창 분할 → 앱이 자기 창으로 분리해야 함
    const sp = await psmuxCli(psmux, ['split-window', '-t', t.session]);
    check('split-window (external, like Claude teammate spawn)', sp.code === 0, sp.err || undefined);
    const two = await waitFor(() => state().panes.length === 2, 8000);
    const mate = state().panes.find((p) => p.paneId !== lead)?.paneId ?? '';
    check('new pane detected as card', two, state().panes.map((p) => p.paneId));
    const lp = await psmuxCli(psmux, ['list-panes', '-s', '-t', t.session, '-F', '#{pane_id} #{window_id} #{window_panes}']);
    const rows = lp.out.split(/\r?\n/).map((l) => l.trim().split(' '));
    check('each pane in its own window (break-pane)', rows.length === 2 && rows.every((r) => r[2] === '1') && rows[0][1] !== rows[1][1], rows);
    check('label fallback is %N before mapping', state().panes.find((p) => p.paneId === mate)?.label.source === 'fallback');

    // 크기 지정: 칸마다 다른 cols×rows
    await t.resizePane(lead, 90, 25);
    await t.resizePane(mate, 70, 20);
    const sz = (p: string) => [...sizes].reverse().find((s) => s.pane === p);
    check('lead resized (actual from list-panes)', sz(lead)?.cols === 90 && (sz(lead)?.rows === 25 || sz(lead)?.rows === 24), sz(lead));
    check('mate resized independently', sz(mate)?.cols === 70 && (sz(mate)?.rows === 20 || sz(mate)?.rows === 19), sz(mate));
    await sleep(800);

    // 입력창 경로(한 줄) + 한글·작은따옴표 + pwsh가 본 창 너비
    let from = since(mate);
    await t.sendInput(mate, "Write-Output ('한글-ITEST-' + 'it''s')");
    check('input box path: Korean + quote echoed', await waitFor(() => outAfter(mate, from).includes("한글-ITEST-it's"), 8000));
    from = since(mate);
    await t.sendInput(mate, "Write-Output ('W=' + $Host.UI.RawUI.WindowSize.Width)");
    check('pwsh sees resized width', await waitFor(() => outAfter(mate, from).includes('W=70'), 8000), outAfter(mate, from).match(/W=\d+/)?.[0]);
    await sleep(500);
    from = since(mate);
    const sentBlank = await t.sendInput(mate, '   ');
    await sleep(700);
    check('whitespace-only input not sent', !sentBlank && outAfter(mate, from).length === 0, outAfter(mate, from).length);

    // 직접 키 입력 경로(xterm onData 형식)
    from = since(lead);
    await t.sendKeys(lead, 'Write-Output KEYS-OK');
    await t.sendKeys(lead, '\r');
    check('terminal key path (literal + Enter)', await waitFor(() => outAfter(lead, from).includes('KEYS-OK'), 8000));
    from = since(lead);
    await t.sendKeys(lead, 'Write-Output BAD-LINE');
    await t.sendKeys(lead, '\x1b'); // PSReadLine: Esc = 줄 지우기
    // 간헐 실패(F2-1) 방지: Esc로 줄이 실제로 지워진 것(화면 마지막 줄에 BAD-LINE 없음)을 확인한 뒤 다음 입력
    const leadWin = state().panes.find((p) => p.paneId === lead)?.windowId ?? '';
    const lastLine = async (): Promise<string> => {
      const c = await psmuxCli(psmux, ['capture-pane', '-p', '-t', `${t.session}:${leadWin}`]);
      return c.out.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).pop() ?? '';
    };
    let cleared = false;
    for (const end = Date.now() + 5000; Date.now() < end && !cleared; await sleep(100)) cleared = !(await lastLine()).includes('BAD-LINE');
    await t.sendKeys(lead, 'Write-Output ESC-OK\r');
    const escOk = await waitFor(() => outAfter(lead, from).includes('ESC-OK'), 8000);
    check('Escape key reaches pane (line cleared)', cleared && escOk && !/BAD-LINEWrite-Output ESC-OK/.test(outAfter(lead, from)), { cleared, escOk });
    // '-'로 시작하는 인자(맨 앞, ' 뒤)가 텍스트 손실·응답 누락·큐 밀림을 일으키지 않는지
    from = since(mate);
    await t.sendInput(mate, "-join ('DASH', '-OK', '--', '-v')");
    check("input starting with '-' (and '-' after quote) delivered", await waitFor(() => outAfter(mate, from).includes('DASH-OK---v'), 8000), outAfter(mate, from).match(/DASH\S*/)?.[0]);
    // QA BUG-1: 터미널에서 '-' 한 타 → '-'가 칸에 전달되고 3초 동안 칸 수 유지
    from = since(mate);
    const keyOk = await t.sendKeys(mate, '-');
    const dashEchoed = await waitFor(() => outAfter(mate, from).includes('-'), 3000);
    await sleep(3000);
    check("sendKeys('-') delivered and panes kept for 3s", keyOk && dashEchoed && state().panes.length === 2, { keyOk, dashEchoed, panes: state().panes.length });
    await t.sendKeys(mate, '\x7f'); // 입력한 '-' 지움
    from = since(mate);
    await t.sendInput(mate, "Write-Output 'AFTER-DASH'");
    check("single '-' keystroke keeps queue aligned", await waitFor(() => outAfter(mate, from).includes('AFTER-DASH'), 8000));
    await sleep(2500); // 2초 주기 refresh(표지 + list-panes)가 한 번 이상 돌게
    check("cards kept after '-' inputs (no drift)", state().panes.length === 2 && state().status === 'connected', { panes: state().panes.map((p) => p.paneId), status: state().status });
    // QA FAIL 19: pwsh 칸 여러 줄은 C-j로 → 두 줄이 한 입력으로 실행
    from = since(mate);
    await t.sendInput(mate, "Write-Output 'ML-A'\nWrite-Output 'ML-B'");
    const mlOk = await waitFor(() => /ML-A[\s\S]*ML-B/.test(outAfter(mate, from).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')), 8000);
    check('pwsh multi-line input (C-j) runs both lines', mlOk);
    check('outputs routed per pane (no leak)', !(text.get(mate) ?? '').includes('KEYS-OK') && !(text.get(lead) ?? '').includes('한글-ITEST'));

    // 재동기화(capture-pane -p -e)
    await t.resync(mate);
    check('resync contains screen text', (resyncs.get(mate) ?? '').includes('한글-ITEST'));

    // 끊김 → 재연결 → 재동기화
    const pid = t.controlPid;
    if (pid) process.kill(pid);
    const recon = await waitFor(() => statuses.includes('reconnecting') && state().status === 'connected', 20000);
    check('disconnect detected and reconnected', recon, statuses);
    from = since(lead);
    await t.sendInput(lead, "Write-Output ('AFTER-RECONNECT-' + 3)");
    check('works after reconnect', await waitFor(() => outAfter(lead, from).includes('AFTER-RECONNECT-3'), 8000));

    // QA NEW-1: 끊긴 동안 들어온 리사이즈가 재연결 뒤 다시 적용되는지
    sizes.length = 0;
    const pid1 = t.controlPid;
    if (pid1) process.kill(pid1);
    await waitFor(() => state().status === 'reconnecting', 5000);
    await t.resizePane(mate, 66, 18); // 연결 없음 → 버려짐(이전 동작)
    await waitFor(() => state().status === 'connected', 20000);
    const sized = await waitFor(() => t.paneInfo(mate).size === '66x18' && sizes.some((z) => z.pane === mate && z.cols === 66 && z.rows === 18), 8000);
    check('resize during reconnect re-applied (NEW-1)', sized, { info: t.paneInfo(mate).size, last: sizes.filter((z) => z.pane === mate).slice(-1) });

    // QA NEW-2: 60ms마다 출력이 나오는 중에 재연결(3회). 화면(직전 재동기화 + 그 뒤 출력)에 같은 줄이 두 번 보이는 시간이 2초 이하이고,
    // 최종 화면에는 중복이 없어야 한다. 중복 지속 = 첫 재동기화부터 화면에 중복이 마지막으로 보인 이벤트까지
    const dupRuns: { final: number; dupMs: number; resyncs: number; firstResyncMs: number; trace?: string[] }[] = [];
    for (let run = 1; run <= 3; run++) {
      await t.sendInput(lead, `1..80 | % { "DUP${run}-$_"; Start-Sleep -Milliseconds 60 }`);
      await waitFor(() => new RegExp(`DUP${run}-5(?![0-9])`).test(outAfter(lead, 0).slice(-4000)), 8000);
      stream.set(lead, []);
      const pid2 = t.controlPid;
      const killedAt = Date.now();
      if (pid2) process.kill(pid2);
      await waitFor(() => state().status === 'reconnecting', 5000);
      await waitFor(() => state().status === 'connected', 20000);
      await sleep(7000); // 루프 종료(약 5초) + 보정 재동기화까지
      const all = stream.get(lead) ?? [];
      const dups = (ev: typeof all, fromIdx: number): number => {
        if (fromIdx < 0) return -1;
        const screen = ev.slice(fromIdx).map((e) => e.data).join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
        const counts = new Map<string, number>();
        for (const m of screen.matchAll(new RegExp(`DUP${run}-([0-9]+)(?![0-9])`, 'g'))) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
        return [...counts.values()].filter((c) => c > 1).length;
      };
      const rIdx = all.map((e, i) => (e.kind === 'resync' ? i : -1)).filter((i) => i >= 0);
      // 각 이벤트 시점의 화면 = 그 시점 직전 재동기화부터 그 이벤트까지
      let firstDupAt = 0;
      let lastDupAt = 0;
      for (let i = rIdx[0] ?? all.length; i < all.length; i++) {
        const from = Math.max(...rIdx.filter((r) => r <= i));
        if (dups(all.slice(0, i + 1), from) > 0) {
          if (!firstDupAt) firstDupAt = all[i].at;
          lastDupAt = all[i].at;
        }
      }
      const firstAt = rIdx.length ? all[rIdx[0]].at : 0;
      const runRes: (typeof dupRuns)[number] = { final: dups(all, rIdx[rIdx.length - 1] ?? -1), dupMs: lastDupAt - firstDupAt, resyncs: rIdx.length, firstResyncMs: firstAt ? firstAt - killedAt : -1 };
      // 실패 회차만: 첫 재동기화 앞뒤 이벤트의 종류·시각(끊긴 시점 기준 ms)·스트림 순번·보인 DUP 번호
      if (runRes.final !== 0 || runRes.resyncs === 0 || runRes.dupMs > 2000) {
        const i0 = Math.max(0, (rIdx[0] ?? 0) - 5);
        runRes.trace = all.slice(i0, i0 + 40).map((ev) => {
          const nums = [...ev.data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').matchAll(new RegExp(`DUP${run}-([0-9]+)`, 'g'))].map((m) => m[1]);
          return `${ev.kind}@${ev.at - killedAt}ms seq=${ev.seq} dup=[${nums.length > 6 ? `${nums.slice(0, 3).join(',')}..${nums.slice(-3).join(',')}` : nums.join(',')}]`;
        });
      }
      dupRuns.push(runRes);
    }
    check('reconnect during output x3: duplicates gone within 2s, none at the end (NEW-2)', dupRuns.every((r) => r.final === 0 && r.resyncs > 0 && r.dupMs <= 2000), dupRuns);

    // QA BUG-1 보강: 응답이 빠지는 명령(-l 뒤 '-' 인자)을 일부러 보낸 뒤 표지(nonce)로 큐가 다시 맞춰지는지(별도 연결)
    const warns: string[] = [];
    const raw = new ControlClient({ psmuxPath: psmux, session: t.session, env: cleanEnv(), log: (lv, m) => { if (lv !== 'info') warns.push(m); } });
    raw.start();
    await sleep(1500);
    const dropped = raw.command("send-keys -t " + lead + " -l '-abc'", 3000);
    const after = raw.command("display-message -p 'AFTER-DROP'");
    const aligned = await raw.barrier();
    const next = await raw.command("display-message -p 'NEXT-OK'");
    const [d, a] = await Promise.all([dropped, after]);
    // QA NEW-3: 응답 없는 send-keys 뒤 명령의 응답은 그 명령이 받아야 한다(이전엔 send-keys가 가져가고 뒤 명령은 'no response')
    check('reply after a dropped send-keys goes to the next command (NEW-3)', a.ok && a.lines[0] === 'AFTER-DROP' && !d.ok, { dropped: { ok: d.ok, l: d.lines[0] }, after: a.lines[0] });
    check('queue stays aligned after a dropped response', aligned && next.ok && next.lines[0] === 'NEXT-OK' && warns.some((w) => /realigned|no response for commands/.test(w)),
      { aligned, next: next.lines[0], dropped: { ok: d.ok, l: d.lines[0] }, after: a.lines[0], warns: warns.map((w) => w.replace(/^\[cc [^\]]+\] /, '').slice(0, 80)) });
    raw.close();
    await sleep(500);
    // 칸 종료(셸 exit) → 카드 제거
    await t.sendInput(mate, 'exit');
    check('pane exit removes card', await waitFor(() => state().panes.length === 1, 10000), state().panes.map((p) => p.paneId));
  } catch (e) {
    check('no exception', false, (e as Error).message);
  } finally {
    await t.kill();
    await sleep(500);
    const gone = !(await hasSession(psmux, t.session));
    check('cleanup: session killed', gone);
    await multiSession(psmux, dataDir, before, check);
    const after = (await listSessionNames(psmux)).filter((s) => s !== t.session);
    // 동시에 도는 다른 세션(QA 등)이 생기는 건 허용: 시작 전에 있던 세션이 그대로 남았는지만 본다
    const missing = before.filter((s) => !after.includes(s));
    check('other sessions untouched', missing.length === 0, { before, after, missing });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(wsRoot, { recursive: true, force: true });
  }
  const failed = checks.filter((c) => !c.pass).length;
  writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ session: t.session, checks }, null, 2));
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main();
