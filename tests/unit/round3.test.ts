// 3차 리뷰·QA 반영: 리드 명령 검사(M4-2b·m-4·O-22), 경로 확인 중복·UNC 동시 제한(M4-7).

import { describe, expect, it, vi } from 'vitest';

import { guardedProbe, isUncPath, unreachableReason, type PathProbe } from '../../src/main/psmux/env';
import { DEFAULT_SETTINGS, leadCommandError, quotesBalanced, validateSettings, type PathChecks } from '../../src/main/settings';

vi.mock('../../src/main/logger', () => ({ log: () => undefined, errMsg: (e: unknown) => String(e) }));

const valid = {
  psmuxPath: '', pwshPath: '', leadCommand: DEFAULT_SETTINGS.leadCommand, historyDir: '',
  fontFamily: DEFAULT_SETTINGS.fontFamily, fontSize: 13, theme: 'light', showSdkSessions: false,
};

/** 끝나는 시점을 테스트가 정하는 확인(멈춘 UNC stat 흉내). */
function deferred(): { promise: Promise<boolean>; resolve: (v: boolean) => void } {
  let resolve!: (v: boolean) => void;
  const promise = new Promise<boolean>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('리드 명령: & (M4-2b)', () => {
  it('단독 &(백그라운드 연산자)는 거부', () => {
    for (const bad of ['claude --agent ceo & calc', 'claude &', '& claude & calc', '& claude', '& { Write-Output A }', 'Write-Output A & Write-Output B', 'a&b', '& "C:\\x\\claude.exe" & calc']) {
      expect(leadCommandError(bad), bad).toMatch(/하나의 명령만/);
    }
  });

  it('맨 앞 호출 연산자 + 따옴표 경로, 2>&1·*>&1 리디렉션은 허용', () => {
    for (const ok of ['& "C:\\Program Files\\Claude\\claude.exe" --agent ceo', "  & 'C:\\x\\claude.exe' --agent ceo", 'claude 2>&1', 'claude --agent ceo *>&1', '& "C:\\c.exe" 2>&1']) {
      expect(leadCommandError(ok), ok).toBeNull();
    }
  });

  it('오류 문구에 &와 허용 예외를 적는다', () => {
    expect(leadCommandError('a & b')).toContain('&,');
    expect(leadCommandError('a & b')).toContain('2>&1');
  });
});

describe('리드 명령: 앱이 붙이는 옵션(m-4)', () => {
  it('--settings·-r·--resume은 거부', () => {
    for (const bad of ['claude --settings x.json', 'claude --settings=x.json', 'claude -r abc', 'claude --resume', '-r x', 'claude --agent ceo -r']) {
      expect(leadCommandError(bad), bad).toMatch(/자동으로 붙이거나 그와 충돌하는 옵션/);
    }
  });

  it('따옴표로 감싼 옵션, -c·--continue도 거부(4차, QA O-25)', () => {
    for (const bad of ['claude "-r" abc', "claude '--resume'", 'claude "--settings"=x', 'claude -c', 'claude --continue', 'claude --agent ceo -c', 'claude "-c"', 'claude --continue=x']) {
      expect(leadCommandError(bad), bad).toMatch(/-c·--continue는 쓸 수 없습니다/);
    }
  });

  it('비슷한 다른 옵션은 허용', () => {
    for (const ok of ['claude --agent ceo', 'claude --rules x', 'claude -rx', 'claude --settings-file x', 'claude-r', 'claude --continuex', 'claude -cx', 'claude --config x']) {
      expect(leadCommandError(ok), ok).toBeNull();
    }
  });
});

describe('리드 명령: 따옴표 짝(O-22)', () => {
  it('짝이 안 맞으면 거부(스마트 따옴표 포함)', () => {
    for (const bad of ["Write-Output 'A", 'Write-Output "A', 'Write-Output \u201CA', 'claude --append-system-prompt "it\'s', "a 'b' 'c"]) {
      expect(quotesBalanced(bad), bad).toBe(false);
      expect(leadCommandError(bad), bad).toMatch(/따옴표 짝/);
    }
  });

  it('짝이 맞거나 다른 종류 안의 따옴표는 허용', () => {
    for (const ok of ["claude --append-system-prompt 'x'", 'claude "it\'s"', "a 'it''s'", 'a ""', '& "C:\\x.exe"', 'a \u201Cb\u201D', 'plain']) {
      expect(quotesBalanced(ok), ok).toBe(true);
      expect(leadCommandError(ok), ok).toBeNull();
    }
  });

  it('저장 검증(validateSettings)도 같은 규칙', async () => {
    const fsx: PathChecks = { isFile: async () => 'ok', isDir: async () => 'ok' };
    expect((await validateSettings({ ...valid, leadCommand: 'claude & calc' }, fsx)).errors.leadCommand).toMatch(/하나의 명령만/);
    expect((await validateSettings({ ...valid, leadCommand: 'claude -r x' }, fsx)).errors.leadCommand).toMatch(/자동으로 붙이거나 그와 충돌하는 옵션/);
    expect((await validateSettings({ ...valid, leadCommand: "claude 'x" }, fsx)).errors.leadCommand).toMatch(/따옴표/);
    expect((await validateSettings({ ...valid, leadCommand: 'claude 2>&1' }, fsx)).values?.leadCommand).toBe('claude 2>&1');
  });
});

describe('경로 확인 중복·UNC 동시 제한(M4-7)', () => {
  it('UNC 판정: \\\\?\\C:\\는 로컬, \\\\?\\UNC\\·//srv는 UNC', () => {
    expect(isUncPath('\\\\srv\\share\\p')).toBe(true);
    expect(isUncPath('//srv/share')).toBe(true);
    expect(isUncPath('\\\\?\\UNC\\srv\\share')).toBe(true);
    expect(isUncPath('\\\\?\\C:\\x')).toBe(false);
    expect(isUncPath('\\\\.\\C:\\x')).toBe(false);
    expect(isUncPath('C:\\x')).toBe(false);
  });

  it('같은 경로는 진행 중인 확인을 공유하고, 끝나면 다시 확인한다', async () => {
    const d = deferred();
    const start = vi.fn(() => d.promise);
    const a = guardedProbe('dir:c:\\same', false, start, 1000);
    const b = guardedProbe('dir:c:\\same', false, start, 1000);
    d.resolve(true);
    expect(await Promise.all([a, b])).toEqual(['ok', 'ok']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await guardedProbe('dir:c:\\same', false, async () => false, 1000)).toBe('missing');
  });

  it('UNC 확인이 남아 있으면(시간 초과 뒤에도) 다른 UNC는 stat 없이 바로 busy, 로컬은 그대로 확인', async () => {
    const hung = deferred();
    const t0 = Date.now();
    expect(await guardedProbe('dir:\\\\192.0.2.1\\a', true, () => hung.promise, 30)).toBe('timeout');
    const other = vi.fn(async () => true);
    const r: PathProbe[] = await Promise.all([
      guardedProbe('file:\\\\192.0.2.2\\b.exe', true, other, 30),
      guardedProbe('dir:\\\\192.0.2.3\\c', true, other, 30),
    ]);
    expect(r).toEqual(['busy', 'busy']);
    expect(other).not.toHaveBeenCalled();
    // 같은 UNC 경로는 남은 확인을 공유(새 stat 없음) → 다시 시간 초과
    expect(await guardedProbe('dir:\\\\192.0.2.1\\a', true, other, 30)).toBe('timeout');
    // 로컬 경로는 UNC와 무관하게 바로 확인
    const t1 = Date.now();
    expect(await guardedProbe('dir:c:\\local', false, async () => true, 1000)).toBe('ok');
    expect(Date.now() - t1).toBeLessThan(100);
    // 남은 UNC 확인이 끝나면 다음 UNC는 다시 확인한다
    hung.resolve(false);
    await new Promise((res) => setTimeout(res, 0));
    expect(await guardedProbe('file:\\\\192.0.2.2\\b.exe', true, other, 30)).toBe('ok');
    expect(other).toHaveBeenCalledTimes(1);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('확인이 예외로 끝나도 UNC 자리를 돌려준다', async () => {
    expect(await guardedProbe('dir:\\\\x\\err', true, async () => { throw new Error('boom'); }, 1000)).toBe('missing');
    expect(await guardedProbe('dir:\\\\y\\next', true, async () => true, 1000)).toBe('ok');
  });

  it('busy 문구와 설정 저장 오류', async () => {
    expect(unreachableReason('busy')).toBe('다른 네트워크 경로를 확인하는 중 — 네트워크 경로는 한 번에 하나씩 저장');
    expect(unreachableReason('timeout')).toContain('응답 없음');
    expect(unreachableReason('ok')).toBeNull();
    expect(unreachableReason('missing')).toBeNull();
    const fsx: PathChecks = { isFile: async () => 'busy', isDir: async () => 'busy' };
    const r = await validateSettings({ ...valid, historyDir: '\\\\srv\\share\\p', pwshPath: '\\\\srv\\share\\pwsh.exe' }, fsx);
    expect(r.errors.historyDir).toMatch(/히스토리 경로를 확인할 수 없습니다\(다른 네트워크 경로를 확인하는 중 — /);
    expect(r.errors.pwshPath).toMatch(/PowerShell 경로를 확인할 수 없습니다\(다른 네트워크 경로를 확인하는 중 — /);
  });
});
