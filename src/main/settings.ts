// 앱 설정: <앱 데이터>/settings.json (~/.claude 에 쓰지 않음). 파일이 깨져도 기본값으로 동작.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, win32 } from 'node:path';

import type { EditableSettings, SettingsErrors, ThemeMode } from '../shared/api';
import { isAbsoluteWinPath } from '../shared/attach';
import { isLang, tr, type Lang } from '../shared/i18n';
import { errMsg, log } from './logger';
import { probeDir, probeExecutable, unreachableReason, type PathProbe } from './psmux/env';

/** 사용자 설정. */
export interface Settings {
  psmuxPath: string;
  /** 새 세션의 셸(빈 값 = psmux 기본 셸). */
  pwshPath: string;
  leadCommand: string;
  /** 히스토리(projects) 폴더(빈 값 = ~/.claude/projects). */
  historyDir: string;
  theme: ThemeMode;
  recentFolders: string[];
  fontSize: number;
  fontFamily: string;
  /** 승인 대기 감지용 hook(--settings) 사용 여부. */
  useHooks: boolean;
  /** 히스토리에 entrypoint=sdk-cli 세션도 표시(기본 숨김). */
  showSdkSessions: boolean;
  /** UI 언어. 빈 값 = 고르지 않음(Windows 표시 언어를 따름, 파일에 기록하지 않음). */
  language: Lang | '';
}

/** 기본값. */
export const DEFAULT_SETTINGS: Settings = {
  psmuxPath: '',
  pwshPath: '',
  leadCommand: 'claude --agent ceo',
  historyDir: '',
  theme: 'light',
  recentFolders: [],
  fontSize: 13,
  fontFamily: '"D2Coding", "Cascadia Mono", Consolas, "Malgun Gothic", monospace',
  useHooks: true,
  showSdkSessions: false,
  language: '',
};

const MAX_RECENT = 10;
// 초기 빌드의 기본 글꼴(기본값으로 간주해 새 기본값이 적용되게 함)
const LEGACY_FONT = "'Cascadia Mono', Consolas, 'D2Coding', 'Malgun Gothic', monospace";

/** 저장값을 검증하며 기본값과 합친다(타입이 다른 필드는 버림). */
export function normalizeSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = { ...DEFAULT_SETTINGS };
  if (typeof o.psmuxPath === 'string') s.psmuxPath = o.psmuxPath;
  if (typeof o.pwshPath === 'string') s.pwshPath = o.pwshPath;
  if (typeof o.historyDir === 'string') s.historyDir = o.historyDir;
  if (o.theme === 'light' || o.theme === 'dark' || o.theme === 'system') s.theme = o.theme;
  if (typeof o.leadCommand === 'string' && o.leadCommand.trim() && !/[\r\n]/.test(o.leadCommand)) s.leadCommand = o.leadCommand.trim();
  if (Array.isArray(o.recentFolders)) s.recentFolders = o.recentFolders.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT);
  if (typeof o.fontSize === 'number' && o.fontSize >= 8 && o.fontSize <= 32) s.fontSize = o.fontSize;
  if (typeof o.fontFamily === 'string' && o.fontFamily.trim() && o.fontFamily !== LEGACY_FONT) s.fontFamily = o.fontFamily;
  if (typeof o.useHooks === 'boolean') s.useHooks = o.useHooks;
  if (typeof o.showSdkSessions === 'boolean') s.showSdkSessions = o.showSdkSessions;
  // 알 수 없는 언어 값은 버리고 기본값(시스템 언어)을 쓴다
  if (isLang(o.language)) s.language = o.language;
  else if (o.language !== undefined && o.language !== '') log('warn', `settings: unknown language ignored (${JSON.stringify(o.language).slice(0, 40)})`);
  return s;
}

/** 파일 시스템 확인(테스트 주입용). 비동기 + 시간 제한: 끊긴 네트워크 경로가 main을 멈추지 않게. */
export interface PathChecks {
  /** 실행 파일(앱 실행 별칭 포함)이 있는지. */
  isFile: (p: string) => Promise<PathProbe>;
  isDir: (p: string) => Promise<PathProbe>;
}

/** 실제 파일 시스템 확인. */
export const FS_CHECKS: PathChecks = { isFile: (p) => probeExecutable(p), isDir: (p) => probeDir(p) };

const CONTROL_RE = /[\x00-\x1f\x7f]/;
// 앱이 리드 명령 끝에 -r·--settings를 붙이므로 명령이 여러 개면 인자가 마지막 명령에 붙고, #(pwsh 주석) 뒤면 무시된다
const LEAD_MULTI_RE = /;|&&|\|\||\||`|[\r\n]|#/;
// 허용하는 &: 맨 앞 호출 연산자 + 따옴표 경로(& "C:\…\claude.exe"), 스트림 리디렉션(2>&1, *>&1). 그 밖의 단독 &는 pwsh 7 백그라운드 연산자
const LEAD_CALL_OP_RE = /^\s*&\s*(?=["'\u2018-\u201E])/;
const LEAD_REDIRECT_RE = /[0-9*]>&[0-9]/g;
// 앱이 리드 명령 뒤에 붙이는 옵션. 사용자가 넣으면 중복·충돌한다
// 따옴표로 감싼 옵션("-r")도 pwsh가 같은 인자로 넘기므로 함께 거부. -c/--continue는 -r과 충돌
const LEAD_APP_OPTION_RE = /(^|\s)["']?(--settings|-r|--resume|-c|--continue)["']?(\s|=|$)/;
// pwsh가 따옴표로 읽는 문자(스마트 따옴표 포함)
const SINGLE_QUOTES = "'\u2018\u2019\u201A\u201B";
const DOUBLE_QUOTES = '"\u201C\u201D\u201E';

/** 따옴표 짝이 맞는지('' · "" 이스케이프는 두 번 바뀌어 원래대로 돌아오므로 따로 처리하지 않음). */
export function quotesBalanced(cmd: string): boolean {
  let open: 'single' | 'double' | null = null;
  for (const ch of cmd) {
    if (open === null) {
      if (SINGLE_QUOTES.includes(ch)) open = 'single';
      else if (DOUBLE_QUOTES.includes(ch)) open = 'double';
    } else if ((open === 'single' && SINGLE_QUOTES.includes(ch)) || (open === 'double' && DOUBLE_QUOTES.includes(ch))) {
      open = null;
    }
  }
  return open === null;
}

/**
 * 리드 명령을 검사한다: 여러 명령으로 나뉘는지(뒤에 붙는 -r·--settings가 마지막 명령으로 감), 앱이 붙이는 옵션을 이미 넣었는지,
 * 따옴표 짝이 맞는지(안 맞으면 pwsh가 >> 이어 입력을 기다려 리드가 뜨지 않음). 저장과 세션 시작 두 곳에서 쓴다.
 *
 * Returns:
 *   문제가 없으면 null, 있으면 현재 UI 언어 오류.
 */
export function leadCommandError(cmd: string): string | null {
  const rest = cmd.replace(LEAD_CALL_OP_RE, '').replace(LEAD_REDIRECT_RE, '');
  if (LEAD_MULTI_RE.test(cmd) || rest.includes('&')) {
    return tr('set.leadMulti');
  }
  if (LEAD_APP_OPTION_RE.test(cmd)) return tr('set.leadAppOption');
  if (!quotesBalanced(cmd)) return tr('set.leadQuotes');
  return null;
}

const unreachableMsg = (label: string, v: string, why: string): string => tr('set.unreachable', { label, why, path: v });

/**
 * 설정 대화상자 입력을 검증한다(렌더러 값은 신뢰하지 않음). 경로는 빈 값(기본값) 또는 존재하는 절대 경로만.
 *
 * Args:
 *   raw: 렌더러가 보낸 값.
 *   fsx: 경로 확인 함수.
 *
 * Returns:
 *   values: 정리된 값(경로는 정규화, 오류가 있으면 null), errors: 항목별 현재 UI 언어 오류.
 */
export async function validateSettings(raw: unknown, fsx: PathChecks = FS_CHECKS): Promise<{ values: EditableSettings | null; errors: SettingsErrors }> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const errors: SettingsErrors = {};
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  // 형식 검사를 통과한 경로는 정규화(. · .. · / 정리)해 검사·저장한다. 존재 확인은 세 경로를 함께 기다린다
  const exe = async (k: 'psmuxPath' | 'pwshPath', label: string): Promise<string> => {
    const given = str(k);
    if (!given) return '';
    if (CONTROL_RE.test(given) || given.includes('"')) errors[k] = tr('set.badChars', { label });
    else if (!isAbsoluteWinPath(given)) errors[k] = tr('set.notAbsolute', { label });
    if (errors[k]) return given;
    const v = win32.resolve(given);
    if (!/\.exe$/i.test(v)) errors[k] = tr('set.notExe', { label });
    else {
      const r = await fsx.isFile(v);
      const why = unreachableReason(r);
      if (why) errors[k] = unreachableMsg(label, v, why);
      else if (r !== 'ok') errors[k] = tr('set.exeMissing', { label, path: v });
    }
    return v;
  };
  const histDir = async (): Promise<string> => {
    const given = str('historyDir');
    if (!given) return '';
    if (CONTROL_RE.test(given) || !isAbsoluteWinPath(given)) {
      errors.historyDir = tr('set.historyNotAbsolute');
      return given;
    }
    const v = win32.resolve(given);
    // 드라이브(공유) 전체를 감시·스캔하게 되므로 거부. 정규화 후 비교해야 C:\. · C:\Users\.. 도 걸린다
    if (win32.parse(v).root === v) errors.historyDir = tr('set.historyRoot');
    else {
      const r = await fsx.isDir(v);
      const why = unreachableReason(r);
      if (why) errors.historyDir = unreachableMsg(tr('set.historyLabel'), v, why);
      else if (r !== 'ok') errors.historyDir = tr('set.historyMissing', { path: v });
    }
    return v;
  };
  const [psmuxPath, pwshPath, historyDir] = await Promise.all([exe('psmuxPath', 'psmux'), exe('pwshPath', 'PowerShell'), histDir()]);
  // 리드 명령·글꼴·크기는 비우면 기본값으로 되돌린다
  const leadCommand = str('leadCommand') || DEFAULT_SETTINGS.leadCommand;
  const leadErr = leadCommandError(leadCommand);
  if (leadErr) errors.leadCommand = leadErr;
  else if (CONTROL_RE.test(leadCommand)) errors.leadCommand = tr('set.leadOneLine');
  else if (leadCommand.length > 1000) errors.leadCommand = tr('set.leadTooLong');
  const fontFamily = str('fontFamily') || DEFAULT_SETTINGS.fontFamily;
  if (CONTROL_RE.test(fontFamily) || /[;{}<>]/.test(fontFamily) || fontFamily.length > 300) errors.fontFamily = tr('set.fontChars');
  const rawSize = o.fontSize;
  const blankSize = rawSize === null || rawSize === undefined || rawSize === '' || (typeof rawSize === 'number' && Number.isNaN(rawSize));
  const fontSize = blankSize ? DEFAULT_SETTINGS.fontSize : typeof rawSize === 'number' ? rawSize : Number(rawSize);
  if (!Number.isInteger(fontSize) || fontSize < 8 || fontSize > 32) errors.fontSize = tr('set.fontSize');
  const theme = o.theme;
  if (theme !== 'light' && theme !== 'dark' && theme !== 'system') errors.theme = tr('set.theme');
  if (typeof o.showSdkSessions !== 'boolean') errors.showSdkSessions = tr('set.invalid');
  if (Object.keys(errors).length) return { values: null, errors };
  return {
    values: { psmuxPath, pwshPath, leadCommand, historyDir, fontFamily, fontSize, theme: theme as ThemeMode, showSdkSessions: o.showSdkSessions as boolean },
    errors,
  };
}

/** 최근 폴더 목록 앞에 추가(대소문자 무시 중복 제거). */
export function pushRecent(list: string[], folder: string): string[] {
  return [folder, ...list.filter((f) => f.toLowerCase() !== folder.toLowerCase())].slice(0, MAX_RECENT);
}

/** 기본값과 다른 항목만 남긴다(기본값이 바뀌면 저장 안 된 항목은 새 기본값을 따름). */
export function diffFromDefaults(s: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (JSON.stringify(v) !== JSON.stringify((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k])) out[k] = v;
  }
  return out as Partial<Settings>;
}

/** settings.json 읽기/쓰기. */
export class SettingsStore {
  private cur: Settings;

  constructor(private readonly file: string) {
    this.cur = this.load();
  }

  private load(): Settings {
    if (!existsSync(this.file)) return { ...DEFAULT_SETTINGS };
    try {
      return normalizeSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (e) {
      log('warn', `settings load failed, using defaults: ${errMsg(e)}`);
      return { ...DEFAULT_SETTINGS };
    }
  }

  get(): Settings {
    return { ...this.cur, recentFolders: [...this.cur.recentFolders] };
  }

  /** 일부 값을 바꾸고 원자적으로 저장(임시 파일 → rename). */
  update(patch: Partial<Settings>): Settings {
    this.cur = normalizeSettings({ ...this.cur, ...patch });
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(diffFromDefaults(this.cur), null, 2));
      renameSync(tmp, this.file);
    } catch (e) {
      log('error', `settings save failed: ${errMsg(e)}`);
    }
    return this.get();
  }
}
