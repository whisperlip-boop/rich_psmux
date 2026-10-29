// jsonl 레코드 → 히스토리 항목 정보(제목·cwd·팀원 여부 등). 순수 로직(단위 테스트 대상).
// 비공식 형식이라 모르는 type은 건너뛰고, 필드가 없거나 타입이 달라도 예외 없이 처리한다.

import type { SplitLine } from './lineSplitter';

/** 파일 하나에서 모은 정보. 앞에서부터 순서대로 줄을 넣으면 "처음 값"·"마지막 값" 규칙이 맞게 쌓인다. */
export interface FileFacts {
  /** 첫 cwd(폴더명 디코딩 대신 사용, D2). */
  cwd?: string;
  entrypoint?: string;
  /** --agent 정의 이름(리드·팀원). */
  agentSetting?: string;
  /** 팀원 파일 표시(session-<리드 sessionId 앞 8자>). */
  teamName?: string;
  /** 첫 사람 입력이 <teammate-message 로 시작(팀원 보조 신호). */
  teammateMsg: boolean;
  /** 사람 입력을 한 번이라도 봤는지(첫 입력 판정용). */
  sawUser: boolean;
  /** 태그로 시작하지 않는 첫 사람 입력(정리된 앞부분). */
  firstUser?: string;
  /** 마지막 값들(모두 cleanTitle로 앞 TITLE_MAX자만 보관: 인덱스 캐시에 본문 전체가 남지 않게). */
  aiTitle?: string;
  customTitle?: string;
  summary?: string;
  lastPrompt?: string;
  /** 첫 레코드 시각(epoch ms, timestamp 필드). 정렬 "생성 날짜"(F2-2) 기준. */
  firstAt?: number;
  /** 넣은 줄 수·해석 실패 줄 수. */
  lines: number;
  bad: number;
}

/** 파일 분류. */
export type FileKind = 'session' | 'lead' | 'teammate' | 'sdk';

/** 제목 최대 길이(표시는 CSS 말줄임). */
export const TITLE_MAX = 200;

/** 빈 정보. */
export function emptyFacts(): FileFacts {
  return { teammateMsg: false, sawUser: false, lines: 0, bad: 0 };
}

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** 공백·줄바꿈을 하나로 줄이고 앞부분만 남긴다. */
export function cleanTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
}

/** 제목 후보 필드: 비어 있지 않은 문자열이면 정리한 앞부분, 아니면 undefined. */
function titleField(v: unknown): string | undefined {
  const t = nonEmpty(v);
  return t === undefined ? undefined : cleanTitle(t) || undefined;
}

/** 제목으로 쓰면 안 되는 사람 입력(명령·IDE·팀원 메시지 태그로 시작, 중단 표시). */
export function isNonTitleText(s: string): boolean {
  const t = s.trimStart();
  return /^<[A-Za-z][\w-]*[\s>/]/.test(t) || /^\[Request interrupted/.test(t);
}

/** user 레코드에서 사람이 입력한 텍스트(메타·도구 결과·요약은 제외). 없으면 null. */
export function userText(o: Record<string, unknown>): string | null {
  if (o.isMeta === true || o.isCompactSummary === true || o.isVisibleInTranscriptOnly === true) return null;
  const msg = o.message;
  if (!msg || typeof msg !== 'object') return null;
  const content = (msg as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text') {
      const t = (b as Record<string, unknown>).text;
      if (typeof t === 'string') return t;
    }
  }
  return null;
}

function applyUserText(f: FileFacts, text: string): void {
  if (!f.sawUser) {
    f.sawUser = true;
    if (text.trimStart().startsWith('<teammate-message')) f.teammateMsg = true;
  }
  if (f.firstUser === undefined && text.trim() && !isNonTitleText(text)) f.firstUser = cleanTitle(text);
}

/**
 * 잘린(매우 긴) 줄에서 user 레코드의 첫 텍스트를 앞부분만 꺼낸다. 확실하지 않으면 null.
 * 첫 사람 입력이 아주 긴 붙여넣기일 때만 쓰인다.
 */
export function partialUserText(prefix: string): string | null {
  if (!/"type"\s*:\s*"user"/.test(prefix) || /"isMeta"\s*:\s*true/.test(prefix) || /"isCompactSummary"\s*:\s*true/.test(prefix)) return null;
  const m = /"content"\s*:\s*"((?:[^"\\]|\\.){1,600})/.exec(prefix) ?? /"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.){1,600})/.exec(prefix);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1].replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, '')}"`) as string;
  } catch {
    return null;
  }
}

/**
 * 한 줄을 정보에 반영한다(손상 줄은 bad만 늘림).
 *
 * Args:
 *   f: 누적 정보(직접 수정).
 *   line: 줄(잘렸으면 앞부분만).
 */
export function applyLine(f: FileFacts, line: SplitLine): void {
  f.lines++;
  if (line.truncated) {
    // 긴 줄은 대부분 api-request-blob·attachment·도구 결과. 사람 입력일 때만 앞부분을 쓴다
    if (f.firstUser === undefined || !f.sawUser) {
      const t = partialUserText(line.text);
      if (t !== null) applyUserText(f, t);
    }
    return;
  }
  const s = line.text.trim();
  if (!s) return;
  let o: unknown;
  try {
    o = JSON.parse(s);
  } catch {
    f.bad++;
    return;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    f.bad++;
    return;
  }
  const r = o as Record<string, unknown>;
  if (f.cwd === undefined) f.cwd = nonEmpty(r.cwd);
  if (f.entrypoint === undefined) f.entrypoint = nonEmpty(r.entrypoint);
  f.teamName ??= nonEmpty(r.teamName);
  if (f.firstAt === undefined && typeof r.timestamp === 'string') {
    const t = Date.parse(r.timestamp);
    if (Number.isFinite(t)) f.firstAt = t;
  }
  switch (r.type) {
    case 'ai-title': f.aiTitle = titleField(r.aiTitle) ?? f.aiTitle; break;
    case 'custom-title': f.customTitle = titleField(r.customTitle) ?? f.customTitle; break;
    case 'summary': f.summary = titleField(r.summary) ?? f.summary; break;
    case 'last-prompt': f.lastPrompt = titleField(r.lastPrompt) ?? f.lastPrompt; break;
    case 'agent-setting': f.agentSetting ??= nonEmpty(r.agentSetting); break;
    case 'user': {
      const t = userText(r);
      if (t !== null) applyUserText(f, t);
      break;
    }
    default: break;
  }
}

/** 앞부분 읽기를 멈춰도 되는지(cwd·제목 후보 확보). 팀원 파일은 teamName을 확인하는 즉시(목록에 안 보이므로 더 읽을 필요 없음). */
export function headSatisfied(f: FileFacts, minLines = 30): boolean {
  if (f.teamName !== undefined) return true;
  if (f.lines < minLines || f.cwd === undefined) return false;
  if (f.firstUser === undefined && f.lines < 400) return false;
  return !f.teammateMsg;
}

/** 제목: 사용자 지정(custom-title) → ai-title 마지막 → summary → 첫 사람 입력 → last-prompt. 없으면 null. */
export function titleOf(f: FileFacts): string | null {
  const t = f.customTitle ?? f.aiTitle ?? f.summary ?? f.firstUser ?? f.lastPrompt;
  return t === undefined ? null : cleanTitle(t) || null;
}

/** 분류: 팀원(teamName 또는 <teammate-message) → sdk-cli → 리드(--agent) → 일반. */
export function kindOf(f: FileFacts): FileKind {
  if (f.teamName !== undefined || f.teammateMsg) return 'teammate';
  if (f.entrypoint === 'sdk-cli') return 'sdk';
  if (f.agentSetting !== undefined) return 'lead';
  return 'session';
}
