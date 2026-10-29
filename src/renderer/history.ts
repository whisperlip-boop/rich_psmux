// 사이드바 히스토리 표시 규칙: 시각 표기, 폴더 그룹·검색, 상태 점. 순수 로직(단위 테스트 대상).

import type { HistoryItemDto, RunningDto, TabStateDto } from '../shared/api';
import { compareText, formatDate, msg, relativeDayName, tr, type Msg } from '../shared/i18n';
import { tabStatus } from './tabs';

/** 대화 항목 상태 점: 작업 중 / 대기 / 분리됨 / 없음(닫힘). */
export type DotKind = 'working' | 'idle' | 'detached' | null;

const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 시각 표기(모두 Intl, 현재 언어): 오늘 시:분(24시간) / 어제 "어제" / 올해 월/일 / 그 전 연/월/일. 예(ko): "14:32" · "어제" · "10. 21." · "2025. 10. 21.". */
export function formatTime(ms: number, now: Date): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  if (sameDay(d, now)) return formatDate(ms, 'time');
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, y)) return relativeDayName(-1);
  return formatDate(ms, d.getFullYear() === now.getFullYear() ? 'monthDay' : 'date');
}

/** 원래 제목: 제목이 없으면 폴더명 + 시각(대체 규칙). */
export function originalTitle(i: HistoryItemDto, now: Date): string {
  return i.title ?? `${i.folderName} ${formatTime(i.mtimeMs, now)}`;
}

/** 표시 제목: 앱에서 바꾼 이름이 있으면 그것, 없으면 원래 제목. */
export function displayTitle(i: HistoryItemDto, now: Date): string {
  return i.customTitle ?? originalTitle(i, now);
}

/** 대화 항목 툴팁: 표시 제목 / (이름을 바꿨으면) 원래 제목 / 폴더 전체 경로 / (있으면) 팀원 대화 수 / 세션 ID 전체. */
export function historyTip(i: HistoryItemDto, title: string, groupName: string): string {
  return [
    title,
    i.customTitle && i.title ? tr('hist.tipOriginal', { title: i.title }) : '',
    i.cwd ?? groupName,
    i.mates ? tr('hist.tipMates', { n: i.mates }) : '',
    tr('hist.tipSession', { id: i.sessionId }),
  ].filter(Boolean).join('\n');
}

/** 검색 일치(표시 제목·원래 제목·폴더명, 대소문자 무시). q는 소문자·공백 제거된 검색어. */
function matches(i: HistoryItemDto, q: string, now: Date): boolean {
  return !q || displayTitle(i, now).toLowerCase().includes(q) || originalTitle(i, now).toLowerCase().includes(q) || i.folderName.toLowerCase().includes(q);
}

/** 상태 필터: 활성 = 보관 안 됨. */
export type StatusFilter = 'active' | 'archived' | 'all';
/** 최근 활동 필터: N일(지금 - N×24h 이후 수정) 또는 전체. */
export type RecentFilter = '1' | '3' | '7' | '30' | 'all';
/** 그룹화 기준. */
export type GroupBy = 'folder' | 'date' | 'none';
/** 정렬 기준. */
export type SortBy = 'name' | 'created' | 'activity';

/** 히스토리 필터. ui-state.json에 저장한다. */
export interface HistoryFilter {
  status: StatusFilter;
  recent: RecentFilter;
  group: GroupBy;
  sort: SortBy;
}

/** 기본값: 활성 / 전체 기간 / 폴더 / 최근 활동. */
export const DEFAULT_FILTER: HistoryFilter = { status: 'active', recent: 'all', group: 'folder', sort: 'activity' };

/** 메뉴 항목: [필드, 이름, [값, 표시]...]. 표시는 번역 전 문구라 그릴 때 현재 언어로 바꾼다(일수는 복수형). */
export const FILTER_FIELDS: { key: keyof HistoryFilter; label: Msg; options: [string, Msg][] }[] = [
  { key: 'status', label: msg('filter.status'), options: [['active', msg('filter.active')], ['archived', msg('hist.archived')], ['all', msg('filter.all')]] },
  { key: 'recent', label: msg('filter.recent'), options: [...([1, 3, 7, 30] as const).map((n): [string, Msg] => [String(n), msg('filter.days', { n })]), ['all', msg('filter.all')]] },
  { key: 'group', label: msg('filter.group'), options: [['folder', msg('filter.folder')], ['date', msg('filter.date')], ['none', msg('filter.none')]] },
  { key: 'sort', label: msg('filter.sort'), options: [['name', msg('filter.name')], ['created', msg('filter.created')], ['activity', msg('filter.activity')]] },
];

/** 기본값과 다른 항목이 하나라도 있는지(필터 아이콘 점). */
export function isDefaultFilter(f: HistoryFilter): boolean {
  return FILTER_FIELDS.every(({ key }) => f[key] === DEFAULT_FILTER[key]);
}

/** 저장값 검증: 필드별로 허용 값이 아니면 기본값. */
export function parseFilter(raw: unknown): HistoryFilter {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_FILTER } as Record<keyof HistoryFilter, string>;
  for (const { key, options } of FILTER_FIELDS) {
    if (typeof o[key] === 'string' && options.some(([v]) => v === o[key])) out[key] = o[key] as string;
  }
  return out as unknown as HistoryFilter;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 생성 시각: 첫 레코드 시각, 없으면 수정 시각으로 대체. */
export function createdOf(i: HistoryItemDto): number {
  return i.createdMs ?? i.mtimeMs;
}

/**
 * 상태·최근 활동·검색으로 거른다(검색은 필터 결과 안에서). 최근 활동 경계는 "지금 - N×24h"(포함).
 *
 * Args:
 *   items: 목록 항목.
 *   f: 필터.
 *   query: 검색어(표시 제목·원래 제목·폴더명, 대소문자 무시).
 *   now: 기준 시각.
 */
export function filterHistory(items: HistoryItemDto[], f: HistoryFilter, query: string, now: Date): HistoryItemDto[] {
  const q = query.trim().toLowerCase();
  const since = f.recent === 'all' ? Number.NEGATIVE_INFINITY : now.getTime() - Number(f.recent) * DAY_MS;
  return items.filter((i) => (f.status === 'all' || (f.status === 'archived') === i.archived) && i.mtimeMs >= since && matches(i, q, now));
}

/** 정렬 비교: 이름(표시 제목, 현재 언어 로케일·숫자 인식, 오름차순) / 생성 날짜(최신 먼저) / 최근 활동(최신 먼저). 같으면 최근 활동. */
export function compareHistory(sort: SortBy, now: Date): (a: HistoryItemDto, b: HistoryItemDto) => number {
  const byActivity = (a: HistoryItemDto, b: HistoryItemDto): number => b.mtimeMs - a.mtimeMs;
  if (sort === 'name') return (a, b) => compareText(displayTitle(a, now), displayTitle(b, now)) || byActivity(a, b);
  if (sort === 'created') return (a, b) => createdOf(b) - createdOf(a) || byActivity(a, b);
  return byActivity;
}

/** 날짜 그룹(로컬 시간). */
export type DateBucket = 'today' | 'yesterday' | 'week' | 'month' | 'older';
/** 날짜 그룹 순서. */
export const DATE_BUCKETS: DateBucket[] = ['today', 'yesterday', 'week', 'month', 'older'];

/** 날짜 그룹 이름(현재 언어): 오늘·어제는 Intl 상대 날짜, 나머지는 사전. */
export function dateBucketName(b: DateBucket): string {
  if (b === 'today') return relativeDayName(0);
  if (b === 'yesterday') return relativeDayName(-1);
  return tr(b === 'week' ? 'hist.week' : b === 'month' ? 'hist.month' : 'hist.older');
}

/**
 * 수정 시각의 날짜 그룹(로컬 자정 기준): 오늘 / 어제 / 지난 7일 / 지난 30일 / 이전.
 * "지난 N일"은 오늘을 포함한 N일: 지난 7일 = 2~6일 전, 지난 30일 = 7~29일 전.
 */
export function dateBucket(ms: number, now: Date): DateBucket {
  const at = (back: number): number => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).getTime();
  if (ms >= at(0)) return 'today';
  if (ms >= at(1)) return 'yesterday';
  if (ms >= at(6)) return 'week';
  if (ms >= at(29)) return 'month';
  return 'older';
}

/** 항목 시각 표기: 날짜 그룹 "오늘"·"어제" 안에서는 시각만(designer 8), 그 밖에는 formatTime. */
export function itemTimeLabel(ms: number, now: Date, groupKey: string): string {
  if (groupKey === '<date:today>' || groupKey === '<date:yesterday>') {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : formatDate(ms, 'time');
  }
  return formatTime(ms, now);
}

/** 그룹 없음일 때 그룹 키(폴더 키와 겹치지 않음). */
export const NO_GROUP_KEY = '<all>';

/** 목록 그룹. */
export interface HistoryGroup {
  key: string;
  name: string;
  /** 그룹 전체 경로(폴더 그룹: 대표 항목의 cwd). */
  path: string | null;
  items: HistoryItemDto[];
  latest: number;
  kind: GroupBy;
}

/**
 * 필터·검색·정렬·그룹화를 적용한 목록. 그룹 안은 정렬 기준대로, 폴더 그룹 순서는 이름 정렬이면 폴더 이름 순, 그 밖에는 같은 기준(그룹의 첫 항목 = 대표값),
 * 날짜 그룹은 오늘 → 이전 고정 순서, 그룹 없음은 그룹 1개(머리 없이 표시).
 *
 * Args:
 *   items: 목록 항목.
 *   f: 필터.
 *   query: 검색어.
 *   now: 기준 시각.
 */
export function viewHistory(items: HistoryItemDto[], f: HistoryFilter, query: string, now: Date): HistoryGroup[] {
  const cmp = compareHistory(f.sort, now);
  const list = filterHistory(items, f, query, now).sort(cmp);
  if (!list.length) return [];
  const latest = (xs: HistoryItemDto[]): number => Math.max(...xs.map((x) => x.mtimeMs));
  if (f.group === 'none') return [{ key: NO_GROUP_KEY, name: '', path: null, items: list, latest: latest(list), kind: 'none' }];
  if (f.group === 'date') {
    const by = new Map<DateBucket, HistoryItemDto[]>();
    for (const i of list) {
      const b = dateBucket(i.mtimeMs, now);
      const arr = by.get(b);
      if (arr) arr.push(i);
      else by.set(b, [i]);
    }
    return DATE_BUCKETS.filter((b) => by.has(b)).map((b) => ({ key: `<date:${b}>`, name: dateBucketName(b), path: null, items: by.get(b)!, latest: latest(by.get(b)!), kind: 'date' as const }));
  }
  const groups = new Map<string, HistoryGroup>();
  for (const i of list) {
    let g = groups.get(i.folderKey);
    if (!g) {
      g = { key: i.folderKey, name: i.folderName, path: i.cwd, items: [], latest: i.mtimeMs, kind: 'folder' };
      groups.set(i.folderKey, g);
    }
    g.items.push(i);
    g.latest = Math.max(g.latest, i.mtimeMs);
  }
  // 이름 정렬이면 폴더 그룹은 폴더 이름 순(lead 결정), 그 밖에는 같은 기준의 대표값(정렬된 첫 항목) 순
  if (f.sort === 'name') {
    return [...groups.values()].sort((a, b) => compareText(a.name, b.name) || b.latest - a.latest);
  }
  return [...groups.values()].sort((a, b) => cmp(a.items[0], b.items[0]));
}

/** 기본 필터(활성·폴더·최근 활동)로 묶은 목록. 보관된 대화는 빠진다. */
export function groupHistory(items: HistoryItemDto[], query: string, now: Date): HistoryGroup[] {
  return viewHistory(items, DEFAULT_FILTER, query, now);
}

const eqi = (a: string | null | undefined, b: string): boolean => !!a && a.toLowerCase() === b.toLowerCase();

/** 탭이 보여 주는 대화 ID(실행 중 대화 우선, 아직 모르면 이어간 대화). */
export function tabConversationId(t: TabStateDto): string | null {
  return t.leadSessionId ?? t.resumeSessionId;
}

/** 이 대화를 보여 주는 탭(실행 중 대화 ID 또는 이어간 원래 ID 일치). */
export function tabForConversation(sessionId: string, tabs: TabStateDto[]): TabStateDto | undefined {
  return tabs.find((t) => eqi(t.leadSessionId, sessionId) || eqi(t.resumeSessionId, sessionId));
}

/** 대화를 보여 주는 탭(이어간 원래 ID 포함), 없으면 그 대화가 실행 중인 psmux 세션의 탭(sessionId 갱신 전). */
function openTabOf(sessionId: string, tabs: TabStateDto[], r: RunningDto | undefined): TabStateDto | undefined {
  return tabForConversation(sessionId, tabs) ?? (r?.psmuxSession ? tabs.find((x) => x.session === r.psmuxSession) : undefined);
}

/**
 * 대화 항목의 상태 점. 탭으로 열려 있으면 그 탭 상태(승인 대기도 작업 중으로 표시), 앱 세션에서 실행 중인데 탭이 없으면 분리됨.
 *
 * Args:
 *   sessionId: 대화 ID.
 *   tabs: 열린 탭.
 *   running: 실행 중인 대화.
 */
export function itemDot(sessionId: string, tabs: TabStateDto[], running: RunningDto[]): DotKind {
  const r = running.find((x) => eqi(x.sessionId, sessionId));
  const t = openTabOf(sessionId, tabs, r);
  if (t) {
    const st = tabStatus(t);
    return st === 'working' || st === 'approval' ? 'working' : 'idle';
  }
  return r?.ours ? 'detached' : null;
}

/**
 * 삭제를 막는 사유: 메뉴 "삭제… (사유)"에 글자로 붙인다. main도 삭제 직전에 다시 확인한다.
 *
 * Args:
 *   sessionId: 대화 ID.
 *   tabs: 열린 탭.
 *   running: 실행 중인 대화.
 *
 * Returns:
 *   현재 언어의 '탭으로 열림' / '실행 중'(앱 세션, 탭 없음) / '외부에서 실행 중'(앱 밖 실행) 또는 null(삭제 가능).
 */
export function trashBlockedReason(sessionId: string, tabs: TabStateDto[], running: RunningDto[]): string | null {
  const r = running.find((x) => eqi(x.sessionId, sessionId));
  if (openTabOf(sessionId, tabs, r)) return tr('hist.blockTab');
  if (!r) return null;
  return tr(r.ours ? 'hist.blockRunning' : 'hist.blockExternal');
}

/** 히스토리 "세션 끊기…" 대상: 앱 세션 / 외부 psmux 세션 / psmux 밖 Claude Code 프로세스. */
export interface StopTarget {
  kind: 'app' | 'psmux' | 'process';
  /** 끊는 중 표시 키(main의 중복 실행 방지 키와 같음): psmux 세션 이름 또는 `pid:<n>`. */
  key: string;
  /** psmux 세션 이름(process면 null). */
  name: string | null;
  pid: number | null;
}

/**
 * 히스토리 "세션 끊기…" 대상: 실행 중이고 탭으로 열려 있지 않은 대화(출처 무관). 실제 대상은 main이 다시 찾는다.
 *
 * Args:
 *   sessionId: 대화 ID.
 *   tabs: 열린 탭.
 *   running: 실행 중인 대화.
 *
 * Returns:
 *   대상 또는 null(메뉴 항목을 넣지 않음: 미실행·탭으로 열림·psmux 안인데 세션 이름을 쓸 수 없음).
 */
export function stopTarget(sessionId: string, tabs: TabStateDto[], running: RunningDto[]): StopTarget | null {
  const r = running.find((x) => eqi(x.sessionId, sessionId));
  if (!r || openTabOf(sessionId, tabs, r)) return null;
  const pid = typeof r.pid === 'number' ? r.pid : null;
  if (r.psmuxSession) return { kind: r.ours ? 'app' : 'psmux', key: r.psmuxSession, name: r.psmuxSession, pid };
  if (r.inPsmux || r.ours || pid === null) return null;
  return { kind: 'process', key: `pid:${pid}`, name: null, pid };
}

/**
 * 탭에 대화 기록이 없는지(탭 ×: 분리 대신 종료 안내용. 판정은 main이 다시 한다). 로그인 탭도 닫으면 바로 끝나므로 true.
 *
 * Args:
 *   t: 탭 상태.
 *   items: 히스토리 항목(대화 기록이 있는 대화).
 *
 * Returns:
 *   이어간 대화가 아니고, 칸이 리드 하나뿐이고(main과 같은 규칙), 리드 대화가 히스토리에 없으면 true.
 */
export function isFreshTab(t: TabStateDto, items: HistoryItemDto[]): boolean {
  if (t.resumeSessionId) return false;
  if (t.purpose === 'login') return true;
  if (t.panes.length > 1) return false;
  const lead = t.leadSessionId;
  if (!lead) return true;
  return !items.some((i) => eqi(i.sessionId, lead));
}
