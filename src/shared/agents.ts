// Agents 설정 순수 로직: md frontmatter의 name·description, 리더 명령 해석, 리더 본문의 팀원 대조, 팀 기능 판정.
// YAML 라이브러리 없이 `---` 블록의 두 키만 읽는다. main(파일 조사)·renderer(표시)·테스트가 같이 쓴다.

/** 에이전트 이름으로 쓸 수 있는 형식(리드 명령 `claude --agent <name>`에 그대로 넣을 수 있어야 함). */
export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** frontmatter 해석 결과. */
export interface Frontmatter {
  name: string | null;
  description: string | null;
  /** frontmatter 다음의 본문. */
  body: string;
  /** frontmatter(`---` 블록)가 있었는지. */
  found: boolean;
}

const unquote = (v: string): string => {
  const t = v.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1).trim() : t;
};

/**
 * md 맨 앞의 `---` 블록에서 name·description만 읽는다. 값이 `|`·`>`(여러 줄)이면 이어지는 들여쓴 줄을 한 줄로 합친다.
 *
 * Args:
 *   text: md 전체(BOM 허용).
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { name: null, description: null, body: text, found: false };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { name: null, description: null, body: text, found: false };
  const fm = lines.slice(1, end);
  const read = (key: 'name' | 'description'): string | null => {
    const i = fm.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
    if (i < 0) return null;
    let v = fm[i].slice(fm[i].indexOf(':') + 1).trim();
    if (v === '' || v === '|' || v === '>' || v === '|-' || v === '>-') {
      const more: string[] = [];
      for (let j = i + 1; j < fm.length && /^\s+\S/.test(fm[j]); j++) more.push(fm[j].trim());
      v = more.join(' ');
    }
    const u = unquote(v);
    return u ? u : null;
  };
  return { name: read('name'), description: read('description'), body: lines.slice(end + 1).join('\n'), found: true };
}

/** 리드 명령이 `claude --agent <name>` 꼴이면 그 이름, 아니면 null(직접 지정). */
export function leadAgentName(cmd: string): string | null {
  const m = /^\s*claude\s+--agent(?:\s+|=)([A-Za-z0-9][A-Za-z0-9_-]*)\s*$/.exec(cmd);
  return m ? m[1] : null;
}

/** 이름으로 리드 명령을 만든다. */
export function leadCommandFor(name: string): string {
  return `claude --agent ${name}`;
}

/** 에이전트 없는 탭(탭 바 ▾ "Claude만")의 리드 명령. 설정의 리드 명령 대신 쓴다. */
export const PLAIN_LEAD_COMMAND = 'claude';

/** 옵션 없는 `claude`뿐이면 true(Claude만 탭). 설정에 직접 `claude`만 적은 경우도 같은 뜻으로 본다. */
export function isPlainLeadCommand(cmd: string): boolean {
  return cmd.trim() === PLAIN_LEAD_COMMAND;
}

/** 표 머리·구분 행 등 이름이 아닌 칸. */
const NOT_A_NAME = new Set(['name', 'names', 'agent', 'agents', 'role', 'roles', 'member', 'members', 'teammate', 'teammates', '이름', '역할', '에이전트', '팀원']);

/** 이름 열로 보는 표 머리 행 첫 칸(대소문자 무시). */
const NAME_HEADER_RE = /^(이름|name|agent|role|역할)$/i;
/** 펜스 코드 블록 시작·끝 줄(``` 또는 ~~~). */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
/** 표 구분 행(|---|, | :--- |). */
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}/;

/** 표 행의 첫 칸(앞뒤 공백·`·* 제거). 표 행이 아니면 null. */
function firstCell(line: string): string | null {
  const m = /^\s*\|([^|]*)\|/.exec(line);
  return m ? m[1].trim().replace(/^[`*]+|[`*]+$/g, '').trim() : null;
}

/**
 * 리더 본문의 팀원 대조: `@name` 언급과 이름 표의 첫 칸을 참조 후보로 모아 목록과 대조한다.
 * 코드(펜스 블록·인라인 `...`) 안의 `@`는 예시일 수 있어 세지 않고, 표는 머리 행 첫 칸이 이름·name·agent·role·역할인
 * 표만 본다. 목록 이름이 단어 경계로 본문에 나오면 "참조함"으로 센다. 후보가 없으면 경고하지 않는다(missing 빈 배열).
 *
 * Args:
 *   body: 리더 md 본문(frontmatter 제외).
 *   leader: 리더 이름(자기 자신은 대조에서 뺀다).
 *   names: 목록에 있는 에이전트 이름.
 *
 * Returns:
 *   referenced: 본문에 나오는 목록 이름, missing: 참조 후보 중 목록에 없는 이름(소문자 비교, 나온 순서).
 */
export function teammateCheck(body: string, leader: string, names: string[]): { referenced: string[]; missing: string[] } {
  const known = new Map(names.map((n) => [n.toLowerCase(), n]));
  const self = leader.toLowerCase();
  const candidates: string[] = [];
  const add = (n: string): void => {
    const k = n.toLowerCase();
    if (k !== self && !NOT_A_NAME.has(k) && !candidates.some((c) => c.toLowerCase() === k)) candidates.push(n);
  };
  const lines = body.split(/\r?\n/);
  let fence: string | null = null;
  let nameTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE_RE.exec(line);
    if (fence) {
      // 같은 문자로 같거나 더 긴 펜스가 나와야 닫힌다(CommonMark)
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      nameTable = false;
      continue;
    }
    const cell = firstCell(line);
    if (cell === null) {
      nameTable = false;
      for (const m of line.replace(/(`+)[^`]*?\1/g, ' ').matchAll(/(^|[^\w@.])@([A-Za-z][A-Za-z0-9_-]*)/g)) add(m[2]);
      continue;
    }
    if (TABLE_SEP_RE.test(line) && !/[A-Za-z0-9가-힣]/.test(line)) continue; // 구분 행
    if (TABLE_SEP_RE.test(lines[i + 1] ?? '')) {
      nameTable = NAME_HEADER_RE.test(cell); // 머리 행: 이름 열 표인지 정하고, 머리 칸 자체는 이름이 아니다
      continue;
    }
    if (nameTable && /^[A-Za-z][A-Za-z0-9_-]*$/.test(cell)) add(cell);
  }
  const referenced = [...known.values()].filter((n) => n.toLowerCase() !== self && new RegExp(`(^|[^A-Za-z0-9_-])${n.replace(/[-]/g, '\\-')}([^A-Za-z0-9_-]|$)`, 'i').test(body));
  const missing = candidates.filter((c) => !known.has(c.toLowerCase()));
  return { referenced, missing };
}

/** 환경변수 값이 켜짐인지(1·true·yes·on). */
export function flagOn(v: unknown): boolean {
  return typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim());
}

/** [예시 템플릿 복사]로 넣는 리더 정의 예(~/.claude/agents/ceo.md). 팀원 정의도 같은 형식으로 만든다. */
export const AGENT_TEMPLATE = `---
name: ceo
description: 요청을 받아 팀을 꾸리고 팀원에게 일을 나눠 맡기는 리더
---

당신은 이 프로젝트의 리더입니다. 요청을 받으면 팀을 만들고 아래 팀원에게 일을 나눠 맡긴 뒤, 결과를 모아 보고하세요.

| 이름 | 역할 |
|---|---|
| pm | 요구사항·완료 기준 정리 |
| developer | 구현 |
| qa | 검증 |
`;
