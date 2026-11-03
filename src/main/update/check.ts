// 업데이트 확인의 순수 로직: 버전 비교, winget·claude·npm·GitHub 응답 해석. 외부 호출 없음(단위 테스트 대상).
// 원칙: 확실하지 않으면 '최신'이라고 하지 않는다. 해석할 수 없는 출력·예상 밖 종료 코드는 모두 확인 실패.
// winget 출력은 표시 언어에 따라 머리글·안내 문장이 바뀌므로 문장은 읽지 않고 Id 행의 버전 토큰과 종료 코드만 본다.

import type { UpdateFailReason, UpdateRowStatus } from '../../shared/api';

/** 행 하나의 확인 결과(이름 없는 부분 행). */
export interface CheckResult {
  installed: string | null;
  latest: string | null;
  status: Exclude<UpdateRowStatus, 'unknown' | 'checking'>;
  reason?: UpdateFailReason;
}

/** 확인 실패 결과. 설치 버전을 이미 알면 함께 남긴다(네트워크 실패여도 설치 버전은 표시). */
export function failed(reason: UpdateFailReason, installed: string | null = null): CheckResult {
  return { installed, latest: null, status: 'failed', reason };
}

// 버전: 숫자 1~5마디(winget은 7.6.9.0처럼 4마디), 선택적으로 -prerelease·+build. 앞의 v는 normalizeVersion에서 뗀다
const VERSION_RE = /^\d+(?:\.\d+){0,4}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** 버전 문자열 정리: 앞뒤 공백·앞의 v/V를 떼고 형식이 맞으면 그 값, 아니면 null. */
export function normalizeVersion(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^v/i, '');
  return s.length <= 64 && VERSION_RE.test(s) ? s : null;
}

/** 숫자 마디 + prerelease 마디로 나눈다(+build는 비교에서 무시, semver 규칙). */
function parts(v: string): { nums: number[]; pre: string[] } {
  const noBuild = v.split('+')[0];
  const dash = noBuild.indexOf('-');
  const core = dash < 0 ? noBuild : noBuild.slice(0, dash);
  const pre = dash < 0 ? [] : noBuild.slice(dash + 1).split('.');
  return { nums: core.split('.').map(Number), pre };
}

/**
 * 버전 비교(semver 확장: 숫자 마디 수가 달라도 빠진 마디는 0, 7.6.9 = 7.6.9.0). prerelease는 정식보다 낮다.
 *
 * Args:
 *   a: 버전(앞의 v 허용).
 *   b: 버전.
 *
 * Returns:
 *   a < b 이면 음수, 같으면 0, a > b 이면 양수. 어느 쪽이든 형식이 맞지 않으면 null.
 */
export function compareVersions(a: string, b: string): number | null {
  const na = normalizeVersion(a);
  const nb = normalizeVersion(b);
  if (na === null || nb === null) return null;
  const pa = parts(na);
  const pb = parts(nb);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length ? -1 : pb.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 설치 버전·최신 버전으로 상태를 정한다. 최신이 설치보다 높을 때만 '업데이트 가능', 같거나 설치가 더 높으면 '최신'.
 * 설치 버전이 없으면 '미설치'(최신 버전은 알면 보여 준다). 비교할 수 없으면 확인 실패.
 */
export function judge(installed: string | null, latest: string | null): CheckResult {
  if (installed === null) return { installed: null, latest, status: 'notInstalled' };
  if (latest === null) return failed('unexpected', installed);
  const c = compareVersions(latest, installed);
  if (c === null) return failed('unexpected', installed);
  return { installed, latest, status: c > 0 ? 'available' : 'latest' };
}

/** winget: 일치하는 설치 패키지 없음(APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND). 실측: 한국어 winget, 없는 Id → 이 코드. */
export const WINGET_NO_APPLICATIONS_FOUND = 0x8a150014;

/** 종료 코드를 부호 없는 32비트로(Node는 Windows HRESULT 종료 코드를 양수 2316632084 등으로 준다. 음수로 와도 같게). */
export function exitCode32(code: number): number {
  return code >>> 0;
}

/** 정규식 특수 문자 이스케이프. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `winget list --id <id> --exact` 결과 해석. 표 머리글·안내 문장은 언어마다 다르므로 읽지 않는다.
 * Id가 정확히 들어 있는 행 하나만 찾아 Id 뒤 토큰을 [설치 버전, (사용 가능 버전), 원본]으로 본다.
 * - 종료 코드 0 + 행 [버전, 'winget'] → 최신(원본 winget이 더 새 버전을 모름)
 * - 종료 코드 0 + 행 [버전, 더 높은 버전, 'winget'] → 업데이트 가능
 * - 종료 코드 NO_APPLICATIONS_FOUND → 미설치
 * - 그 밖(원본 없음·msstore·Unknown·"< 1.0"·잘린 Id·행 여럿·다른 종료 코드) → 확인 실패
 *
 * Args:
 *   out: stdout(진행 표시의 \r 포함 가능).
 *   code: 종료 코드(실행 실패·시간 초과면 null).
 *   id: winget 패키지 Id(예: 'marlocarlo.psmux').
 */
export function parseWingetList(out: string, code: number | null, id: string): CheckResult {
  if (code === null) return failed('unexpected');
  if (exitCode32(code) === WINGET_NO_APPLICATIONS_FOUND) return { installed: null, latest: null, status: 'notInstalled' };
  if (code !== 0) return failed('unexpected');
  const idRe = new RegExp(`(?:^|\\s)${escapeRe(id)}\\s+(.+)$`, 'i');
  const rows = out.split(/\r\n|\r|\n/).map((l) => idRe.exec(l.trimEnd())).filter((m): m is RegExpExecArray => m !== null);
  if (rows.length !== 1) return failed('unexpected');
  const tokens = rows[0][1].trim().split(/\s+/);
  const installed = normalizeVersion(tokens[0]);
  if (installed === null) return failed('unexpected');
  if (tokens.length === 2 && tokens[1].toLowerCase() === 'winget') return { installed, latest: installed, status: 'latest' };
  if (tokens.length === 3 && tokens[2].toLowerCase() === 'winget') {
    const available = normalizeVersion(tokens[1]);
    const c = available === null ? null : compareVersions(available, installed);
    if (available !== null && c !== null && c > 0) return { installed, latest: available, status: 'available' };
  }
  return failed('unexpected', installed);
}

/** `claude --version` 첫 줄의 버전(예: "2.1.317 (Claude Code)" → "2.1.317"). 형식이 다르면 null. */
export function parseClaudeVersion(stdout: string): string | null {
  const first = stdout.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const m = /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(first);
  return m ? normalizeVersion(m[1]) : null;
}

/** npm registry `<패키지>/latest` 응답의 version. 형식이 다르면 null. */
export function parseNpmLatest(body: unknown): string | null {
  return body && typeof body === 'object' ? normalizeVersion((body as Record<string, unknown>).version) : null;
}

/** GitHub `releases/latest` 응답의 태그 버전(앞의 v 제거). draft·prerelease면(API가 주지 않지만 만약을 위해) null. */
export function parseGithubLatest(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (o.draft === true || o.prerelease === true) return null;
  return normalizeVersion(o.tag_name);
}

/** HTTP 상태 → 실패 사유. GitHub 비인증 한도 초과는 403·429. */
export function httpFailReason(status: number): UpdateFailReason {
  return status === 403 || status === 429 ? 'rateLimited' : 'network';
}

/** 네트워크 계열 실패(오프라인·시간 초과)인지. rate limit·형식 오류는 서버가 응답했으므로 아니다. */
export function isNetworkFail(reason: UpdateFailReason | null): boolean {
  return reason === 'network' || reason === 'timeout';
}

/**
 * 오프라인 보정: npm·GitHub 조회가 **둘 다** 네트워크 계열로 실패했으면 오프라인으로 보고, winget의 최신·업데이트 가능 판단은
 * 캐시된 원본 색인에서 나왔을 수 있어 믿지 않는다 → 확인 실패(network), 설치 버전은 유지. 미설치·이미 실패인 결과는 그대로.
 *
 * Args:
 *   r: winget 확인 결과.
 *   githubFail: GitHub 조회 실패 사유(성공이면 null).
 *   npmFail: npm 조회 실패 사유(성공이면 null).
 */
export function offlineDowngrade(r: CheckResult, githubFail: UpdateFailReason | null, npmFail: UpdateFailReason | null): CheckResult {
  if (!isNetworkFail(githubFail) || !isNetworkFail(npmFail)) return r;
  if (r.status !== 'latest' && r.status !== 'available') return r;
  return failed('network', r.installed);
}

/** 시간 제한: ms 안에 끝나지 않으면 timeout 결과. 늦게 끝난 원래 작업의 결과는 버린다. */
export async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((res) => { timer = setTimeout(() => res(onTimeout()), ms); });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
