// ~/.claude/projects 히스토리 인덱서: 파일마다 앞부분 + 뒷부분만 스트리밍으로 읽고, 크기·mtime 기준으로 증분 갱신한다.
// 파일 감시(fs.watch recursive) + 디바운스, 감시가 놓친 변경은 주기 확인으로 보완. 인덱스는 앱 데이터에 캐시한다.
// append-only 전제: 커지면 마지막 완성 줄 위치부터 이어 읽고, 줄거나 mtime만 바뀌면 처음부터 다시 읽는다.

import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { SESSION_ID_RE } from '../../shared/ids';
import { listProjectJsonl, readProjectRange, statProjectFile, watchProjects } from '../claudeHome';
import { errMsg, log } from '../logger';
import { applyLine, emptyFacts, headSatisfied, kindOf, titleOf, type FileFacts, type FileKind } from './jsonlFacts';
import { JsonlSplitter } from './lineSplitter';

/** 앞부분 최대 읽기량·뒷부분 창 크기·뒤로 더 찾는 최대량·이어 읽기 최대량. */
export const HEAD_MAX_BYTES = 4 * 1024 * 1024;
export const TAIL_BYTES = 256 * 1024;
export const TAIL_BACK_MAX_BYTES = 2 * 1024 * 1024;
export const APPEND_MAX_BYTES = 8 * 1024 * 1024;
// v2: 이어 읽기 위치 정렬 여부(aligned) 추가, 제목 후보 필드를 앞부분만 보관
// 3: 첫 레코드 시각(firstAt) 추가(F2-2 생성 날짜 정렬). 이전 캐시는 버리고 한 번 다시 읽는다
const CACHE_VERSION = 3;
const WATCH_DEBOUNCE_MS = 400;
const PERIODIC_MS = 30000;
/** 인덱스 캐시 저장 주기(바뀐 것이 있을 때만). 종료 시에도 저장. */
const CACHE_SAVE_MS = 30000;
const CONCURRENCY = 4;

/** 인덱스 항목 하나(파일 하나). */
export interface IndexEntry {
  dir: string;
  file: string;
  size: number;
  mtimeMs: number;
  /** 마지막으로 처리한 완성 줄의 끝(이어 읽기 시작점). */
  offset: number;
  /** offset이 줄 경계인지(false면 이어 읽을 때 첫 조각을 버림: 뒷부분 창에 개행이 하나도 없던 경우). */
  aligned: boolean;
  facts: FileFacts;
}

/** 이어 읽기 위치. */
export interface ReadPos {
  offset: number;
  aligned: boolean;
}

/** 분리기 상태 → 이어 읽기 위치(완성 줄 끝 → 첫 줄 경계 → 경계를 못 찾았으면 시작점, 비정렬). */
function posOf(sp: JsonlSplitter, start: number): ReadPos {
  if (sp.lastEnd >= 0) return { offset: sp.lastEnd, aligned: true };
  if (sp.parseStart >= 0) return { offset: sp.parseStart, aligned: true };
  return { offset: start, aligned: false };
}

/** 목록용 항목. */
export interface HistoryItem {
  sessionId: string;
  dir: string;
  /** 파일 이름(<sessionId>.jsonl). */
  file: string;
  /** 키(<dir>/<file>, keyOf). 앱 저장소(이름 변경·보관) 기준. */
  key: string;
  title: string | null;
  cwd: string | null;
  kind: FileKind;
  teamName: string | null;
  mtimeMs: number;
  /** 첫 레코드 시각(없으면 null → 생성 날짜 정렬은 수정 시각으로 대체). */
  createdMs: number | null;
}

/** 파일 읽기 함수(테스트에서 바꿔 끼움). claudeHome.readProjectRange와 같은 형태. */
export type RangeReader = (dir: string, file: string, start: number, end: number, onChunk: (b: Buffer) => boolean) => Promise<void>;

/**
 * 파일 하나를 처음부터 색인한다: 앞부분(조건을 채우면 멈춤) → 뒷부분 창 → 뒷부분에 ai-title이 없으면 뒤에서 더 찾기.
 *
 * Args:
 *   read: 구간 읽기 함수.
 *   dir: 프로젝트 폴더.
 *   file: 파일 이름.
 *   size: 파일 크기.
 *
 * Returns:
 *   정보와 이어 읽기 시작점.
 */
export async function indexFile(read: RangeReader, dir: string, file: string, size: number): Promise<{ facts: FileFacts } & ReadPos> {
  const f = emptyFacts();
  const headEnd = Math.min(size, HEAD_MAX_BYTES);
  const head = new JsonlSplitter(0, (l) => {
    applyLine(f, l);
    return !headSatisfied(f);
  });
  await read(dir, file, 0, headEnd, (b) => head.push(b));
  const headDone = Math.max(0, head.lastEnd);
  if (!head.stopped && headEnd >= size) return { facts: f, offset: headDone, aligned: true };
  // 팀원 파일(teamName 확인)은 목록에 보이지 않아 제목이 필요 없으므로 뒷부분·뒤로 찾기를 생략
  if (f.teamName !== undefined) return { facts: f, offset: headDone, aligned: true };

  const tailStart = Math.max(headDone, size - TAIL_BYTES);
  // 제목 후보(ai-title·custom-title·summary)는 마지막 값이 필요하다. 앞부분에서 본 값은 뒤쪽에서 못 찾을 때만 쓴다
  const headTitles = { aiTitle: f.aiTitle, customTitle: f.customTitle, summary: f.summary };
  f.aiTitle = undefined;
  f.customTitle = undefined;
  f.summary = undefined;
  const tail = new JsonlSplitter(tailStart, (l) => {
    applyLine(f, l);
    return true;
  }, undefined, tailStart !== headDone);
  await read(dir, file, tailStart, size, (b) => tail.push(b));
  const pos = posOf(tail, tailStart);

  // 뒷부분 창에 ai-title 또는 custom-title이 없으면 그 앞을 창 단위로 거꾸로 찾는다(최대 TAIL_BACK_MAX_BYTES, 앞부분에서
  // 못 봤어도 찾음: 세션 중간부터 생길 수 있음). 뒤쪽 창의 값이 더 나중 값이므로 이미 찾은 값은 덮어쓰지 않는다.
  // summary는 따로 기다리지 않고 지나가며 함께 줍는다. 창 끝 = 다음 창이 실제로 읽기 시작한 줄 경계
  let winStart = tailStart;
  let winEnd = tail.parseStart >= 0 ? tail.parseStart : size;
  while ((f.aiTitle === undefined || f.customTitle === undefined) && winStart > headDone && tailStart - winStart < TAIL_BACK_MAX_BYTES) {
    winStart = Math.max(headDone, winStart - TAIL_BYTES);
    const w = emptyFacts();
    const sp = new JsonlSplitter(winStart, (l) => {
      // 창 안에서는 제목 후보 줄만 해석
      if (/"type"\s*:\s*"(ai-title|custom-title|summary)"/.test(l.text)) applyLine(w, l);
      return true;
    }, undefined, winStart !== headDone);
    await read(dir, file, winStart, winEnd, (b) => sp.push(b));
    f.aiTitle ??= w.aiTitle;
    f.customTitle ??= w.customTitle;
    f.summary ??= w.summary;
    if (sp.parseStart >= 0) winEnd = sp.parseStart;
  }
  f.aiTitle ??= headTitles.aiTitle;
  f.customTitle ??= headTitles.customTitle;
  f.summary ??= headTitles.summary;
  return { facts: f, ...pos };
}

/**
 * 이어 읽기: offset부터 size까지의 새 줄을 반영한다. 너무 많이 늘었으면 뒷부분 창만 읽는다.
 * offset이 줄 경계가 아니면(aligned=false) 첫 조각을 버린다.
 *
 * Returns:
 *   새 이어 읽기 위치.
 */
export async function appendFile(read: RangeReader, e: IndexEntry, size: number): Promise<ReadPos> {
  const start = size - e.offset > APPEND_MAX_BYTES ? size - TAIL_BYTES : e.offset;
  const sp = new JsonlSplitter(start, (l) => {
    applyLine(e.facts, l);
    return true;
  }, undefined, start !== e.offset || !e.aligned);
  await read(e.dir, e.file, start, size, (b) => sp.push(b));
  return posOf(sp, start);
}

/**
 * 이어 읽기 전에 파일이 정말 뒤에만 추가됐는지 확인: offset 바로 앞 바이트가 개행이어야 한다.
 * (compact 등으로 파일이 다시 쓰였는데 크기만 커졌으면 다른 내용이라 처음부터 다시 읽어야 함)
 */
export async function stillAppendOnly(read: RangeReader, e: IndexEntry): Promise<boolean> {
  if (!e.aligned || e.offset === 0) return true;
  let b: number | undefined;
  await read(e.dir, e.file, e.offset - 1, e.offset, (c) => {
    b = c[0];
    return false;
  });
  return b === 0x0a;
}

/** 인덱스 항목 → 목록용 항목. sessionId 형식이 아닌 파일 이름은 null. */
export function toItem(e: IndexEntry): HistoryItem | null {
  const sessionId = e.file.replace(/\.jsonl$/i, '');
  if (!SESSION_ID_RE.test(sessionId)) return null;
  return {
    sessionId, dir: e.dir, file: e.file, key: keyOf(e.dir, e.file), title: titleOf(e.facts), cwd: e.facts.cwd ?? null, kind: kindOf(e.facts),
    teamName: e.facts.teamName ?? null, mtimeMs: e.mtimeMs, createdMs: e.facts.firstAt ?? null,
  };
}

/** 캐시 파일의 항목을 방어적으로 검증한다(형식이 틀린 항목은 버려 다시 읽게 함). */
export function parseCache(raw: unknown): IndexEntry[] {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.version !== CACHE_VERSION || !Array.isArray(o.entries)) return [];
  const out: IndexEntry[] = [];
  for (const x of o.entries) {
    if (!x || typeof x !== 'object') continue;
    const e = x as Record<string, unknown>;
    const f = e.facts as Record<string, unknown> | undefined;
    if (typeof e.dir !== 'string' || typeof e.file !== 'string' || typeof e.size !== 'number' || typeof e.mtimeMs !== 'number' ||
        typeof e.offset !== 'number' || !f || typeof f !== 'object' || typeof f.lines !== 'number') continue;
    const facts = emptyFacts();
    for (const k of ['cwd', 'entrypoint', 'agentSetting', 'teamName', 'firstUser', 'aiTitle', 'customTitle', 'summary', 'lastPrompt'] as const) {
      if (typeof f[k] === 'string') facts[k] = f[k] as string;
    }
    if (typeof f.firstAt === 'number' && Number.isFinite(f.firstAt)) facts.firstAt = f.firstAt;
    facts.teammateMsg = f.teammateMsg === true;
    facts.sawUser = f.sawUser === true;
    facts.lines = f.lines as number;
    facts.bad = typeof f.bad === 'number' ? f.bad : 0;
    out.push({ dir: e.dir, file: e.file, size: e.size, mtimeMs: e.mtimeMs, offset: e.offset, aligned: e.aligned !== false, facts });
  }
  return out;
}

/** 인덱스 키(앱 저장소 history-meta.json 키와 같음). */
export const keyOf = (dir: string, file: string): string => `${dir}/${file}`;

/**
 * 히스토리 인덱서. 이벤트: 'update'(HistoryItem[]), 'error'(string).
 */
export class HistoryIndexer extends EventEmitter {
  private entries = new Map<string, IndexEntry>();
  private inflight = new Map<string, Promise<boolean>>();
  private dirtyAgain = new Set<string>();
  private pendingKeys = new Set<string>();
  private pendingFull = false;
  private debounce: NodeJS.Timeout | null = null;
  private periodic: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private watcher: { close(): void } | null = null;
  private scanning: Promise<void> | null = null;
  private stopped = false;
  private restarting: Promise<void> = Promise.resolve();
  /** 첫 전체 스캔이 끝났는지. */
  ready = false;

  constructor(private readonly cacheFile: string, private readonly read: RangeReader = readProjectRange) {
    super();
  }

  /** 캐시를 읽고(useCache), 전체 스캔·감시·주기 확인을 시작한다. */
  async start(useCache = true): Promise<void> {
    if (useCache) this.loadCache();
    this.watcher = watchProjects((rel) => this.onWatch(rel), (e) => log('warn', `history watch error: ${errMsg(e)} (periodic rescan continues)`));
    this.periodic = setInterval(() => void this.scanAll(), PERIODIC_MS);
    this.saveTimer = setInterval(() => { if (this.dirty) this.saveCache(); }, CACHE_SAVE_MS);
    await this.scanAll();
  }

  /** 감시·타이머 정리. */
  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
    if (this.periodic) clearInterval(this.periodic);
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.dirty) this.saveCache();
  }

  /**
   * 히스토리 폴더가 바뀌었을 때(설정 F8): 감시·타이머를 멈추고 진행 중인 읽기를 기다린 뒤 switchDir로 폴더를 바꾸고,
   * 이전 폴더 항목·캐시를 버리고 처음부터 다시 읽는다. 연달아 불러도 순서대로 하나씩 처리한다(리뷰 m-3).
   *
   * Args:
   *   switchDir: 진행 중인 읽기가 모두 끝난 뒤(이전 폴더 기준 읽기가 새 폴더 경로로 섞이지 않게) 실행할 폴더 전환.
   */
  restart(switchDir: () => void): Promise<void> {
    const run = this.restarting.then(() => this.restartOnce(switchDir));
    this.restarting = run.catch(() => undefined);
    return run;
  }

  private async restartOnce(switchDir: () => void): Promise<void> {
    this.stop();
    await this.scanning;
    await Promise.all([...this.inflight.values()].map((p) => p.catch(() => false)));
    switchDir();
    this.entries.clear();
    this.pendingKeys.clear();
    this.pendingFull = false;
    this.dirtyAgain.clear();
    this.ready = false;
    this.stopped = false;
    await this.start(false);
  }

  /** 현재 목록(sessionId 형식 파일만). */
  items(): HistoryItem[] {
    const out: HistoryItem[] = [];
    for (const e of this.entries.values()) {
      const it = toItem(e);
      if (it) out.push(it);
    }
    return out;
  }

  /** sessionId로 항목 찾기. */
  find(sessionId: string): HistoryItem | null {
    for (const e of this.entries.values()) {
      if (e.file.toLowerCase() === `${sessionId.toLowerCase()}.jsonl`) return toItem(e);
    }
    return null;
  }

  /**
   * 지운 파일(F2-1 휴지통 이동)을 인덱스·캐시에서 바로 뺀다. 파일 감시도 결국 반영하지만 기다리지 않는다.
   *
   * Returns:
   *   빠진 항목이 있으면 true(그때만 'update'를 낸다).
   */
  removeFiles(keys: string[]): boolean {
    let changed = false;
    for (const k of keys) if (this.entries.delete(k)) changed = true;
    if (changed) this.publish();
    return changed;
  }

  /** 전체 확인: 목록·크기·mtime 비교 후 바뀐 파일만 다시 읽는다. 동시에 한 번만 돈다. */
  scanAll(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      try {
        // 목록 자체를 못 읽으면 예외 → 기존 항목 유지. 폴더 하나를 못 읽으면 그 폴더 항목은 지우지 않는다(일시 잠김 등)
        const { files, failedDirs } = await listProjectJsonl();
        const keepDirs = new Set(failedDirs);
        if (failedDirs.length) log('warn', `history: ${failedDirs.length} project folder(s) unreadable; keeping their entries`);
        const seen = new Set(files.map((f) => keyOf(f.dir, f.file)));
        let changed = false;
        for (const [k, e] of [...this.entries]) {
          if (!seen.has(k) && !keepDirs.has(e.dir)) {
            this.entries.delete(k);
            changed = true;
          }
        }
        let i = 0;
        const worker = async (): Promise<void> => {
          while (i < files.length && !this.stopped) {
            const f = files[i++];
            if (await this.updateFile(f.dir, f.file)) changed = true;
          }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
        if (changed || !this.ready) this.publish();
        this.ready = true;
      } catch (e) {
        log('error', `history scan failed: ${errMsg(e)}`);
        this.emit('error', errMsg(e));
      } finally {
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  /** 파일 하나를 갱신한다(같은 파일은 동시에 한 번만, 그 사이 변경은 끝난 뒤 한 번 더). 바뀌었으면 true. */
  updateFile(dir: string, file: string): Promise<boolean> {
    const k = keyOf(dir, file);
    const running = this.inflight.get(k);
    if (running) {
      this.dirtyAgain.add(k);
      return running;
    }
    const p = (async () => {
      let changed = false;
      do {
        this.dirtyAgain.delete(k);
        if (await this.updateOnce(dir, file)) changed = true;
      } while (this.dirtyAgain.has(k) && !this.stopped);
      return changed;
    })().finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  private async updateOnce(dir: string, file: string): Promise<boolean> {
    const k = keyOf(dir, file);
    const st = await statProjectFile(dir, file);
    const prev = this.entries.get(k);
    if (!st) {
      if (prev) this.entries.delete(k);
      return !!prev;
    }
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return false;
    try {
      if (prev && st.size > prev.size && prev.offset > 0 && (await stillAppendOnly(this.read, prev))) {
        // append-only: 마지막 완성 줄 다음부터 이어 읽기(이전 정보에 누적하므로 복사본에 적용)
        const next: IndexEntry = { ...prev, facts: { ...prev.facts } };
        const pos = await appendFile(this.read, next, st.size);
        this.entries.set(k, { ...next, size: st.size, mtimeMs: st.mtimeMs, ...pos });
      } else {
        // 새 파일·크기 감소·mtime만 변경·다시 쓰인 파일 → 처음부터
        const r = await indexFile(this.read, dir, file, st.size);
        this.entries.set(k, { dir, file, size: st.size, mtimeMs: st.mtimeMs, offset: r.offset, aligned: r.aligned, facts: r.facts });
      }
    } catch (e) {
      // 읽기 실패(잠김·삭제 중 등)는 다음 확인 때 다시 시도. 목록에는 이전 값을 유지
      log('warn', `history read failed ${dir}/${file}: ${errMsg(e)}`);
      return false;
    }
    return true;
  }

  private onWatch(rel: string): void {
    const parts = rel.split(/[\\/]/).filter(Boolean);
    if (parts.length === 2 && parts[1].toLowerCase().endsWith('.jsonl')) this.pendingKeys.add(keyOf(parts[0], parts[1]));
    else if (parts.length === 1) this.pendingFull = true; // 프로젝트 폴더 생성·삭제
    else return; // <sid>/subagents/·tool-results/·memory/ 는 대상 아님
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.flushWatch(), WATCH_DEBOUNCE_MS);
  }

  private async flushWatch(): Promise<void> {
    this.debounce = null;
    if (this.stopped) return;
    if (this.pendingFull) {
      this.pendingFull = false;
      this.pendingKeys.clear();
      await this.scanAll();
      return;
    }
    const keys = [...this.pendingKeys];
    this.pendingKeys.clear();
    let changed = false;
    for (const k of keys) {
      const i = k.indexOf('/');
      if (await this.updateFile(k.slice(0, i), k.slice(i + 1))) changed = true;
    }
    if (changed) this.publish();
  }

  private publish(): void {
    this.emit('update', this.items());
    this.dirty = true;
  }

  private loadCache(): void {
    try {
      for (const e of parseCache(JSON.parse(readFileSync(this.cacheFile, 'utf8')))) this.entries.set(keyOf(e.dir, e.file), e);
      if (this.entries.size) log('info', `history cache loaded: ${this.entries.size} files`);
    } catch { /* 캐시 없음·손상: 전체 다시 읽기 */ }
  }

  private saveCache(): void {
    this.dirty = false;
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, entries: [...this.entries.values()] }));
      renameSync(tmp, this.cacheFile);
    } catch (e) {
      log('warn', `history cache save failed: ${errMsg(e)}`);
    }
  }
}
