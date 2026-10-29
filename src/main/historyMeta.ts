// 히스토리 항목 메뉴(F2-1)의 앱 저장소: 표시 이름 override와 보관 목록. <앱 데이터>/history-meta.json. ~/.claude 는 바꾸지 않는다.
// 키는 인덱서 keyOf와 같은 `<프로젝트 폴더>/<파일>`(예: D--github-x/1234….jsonl).

import { readFileSync } from 'node:fs';

import { writeJsonAtomic } from './appData';
import { errMsg, log } from './logger';

/** 저장 형식. */
export interface HistoryMeta {
  overrides: Record<string, string>;
  archived: string[];
}

/** 표시 이름 최대 길이. */
export const MAX_TITLE = 200;

const KEY_RE = /^[^\\/\x00-\x1f]{1,255}\/[0-9a-f-]{36}\.jsonl$/i;

/** 키 형식 확인(렌더러 입력은 신뢰 경계 밖). */
export function isHistoryKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v) && !v.startsWith('..');
}

/** 표시 이름 정리: 앞뒤 공백 제거, 제어문자는 공백으로, 길이 제한. 빈 값이면 null(override 제거). */
export function cleanTitle(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_TITLE).trim();
  return s || null;
}

/** 저장된 값을 방어적으로 검증한다(형식이 틀린 항목은 버림). */
export function parseHistoryMeta(raw: unknown): HistoryMeta {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const overrides: Record<string, string> = {};
  if (o.overrides && typeof o.overrides === 'object') {
    for (const [k, v] of Object.entries(o.overrides as Record<string, unknown>)) {
      const t = cleanTitle(v);
      if (isHistoryKey(k) && t) overrides[k] = t;
    }
  }
  const archived = Array.isArray(o.archived) ? [...new Set(o.archived.filter(isHistoryKey))] : [];
  return { overrides, archived };
}

/** history-meta.json 읽기/쓰기. */
export class HistoryMetaStore {
  private cur: HistoryMeta;

  constructor(private readonly file: string) {
    this.cur = this.load();
  }

  private load(): HistoryMeta {
    try {
      return parseHistoryMeta(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log('warn', `history meta load failed, starting empty: ${errMsg(e)}`);
      return { overrides: {}, archived: [] };
    }
  }

  private save(): void {
    writeJsonAtomic(this.file, this.cur, 'history meta save');
  }

  /** 현재 값(복사본). */
  get(): HistoryMeta {
    return { overrides: { ...this.cur.overrides }, archived: [...this.cur.archived] };
  }

  /**
   * 표시 이름을 바꾼다. 빈 값이면 override를 지운다(원래 제목 복귀).
   *
   * Returns:
   *   키가 올바르면 true.
   */
  rename(key: unknown, title: unknown): boolean {
    if (!isHistoryKey(key)) return false;
    const t = cleanTitle(title);
    if (t) this.cur.overrides[key] = t;
    else delete this.cur.overrides[key];
    this.save();
    return true;
  }

  /** 보관/보관 해제. 키가 올바르면 true. */
  setArchived(key: unknown, archived: unknown): boolean {
    if (!isHistoryKey(key) || typeof archived !== 'boolean') return false;
    const rest = this.cur.archived.filter((k) => k !== key);
    this.cur.archived = archived ? [...rest, key] : rest;
    this.save();
    return true;
  }

  /** 삭제된 대화의 override·보관 항목을 지운다(바뀐 것이 있을 때만 저장). */
  forget(keys: string[]): void {
    const drop = new Set(keys);
    const before = JSON.stringify(this.cur);
    for (const k of drop) delete this.cur.overrides[k];
    this.cur.archived = this.cur.archived.filter((k) => !drop.has(k));
    if (JSON.stringify(this.cur) !== before) this.save();
  }
}
