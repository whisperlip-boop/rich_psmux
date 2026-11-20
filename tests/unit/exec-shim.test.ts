// 팀원 칸 exec shim: 세션 PATH 조합(가장 큰 위험: 잘못되면 세션의 모든 칸이 깨짐), shim 파일 쓰기, 실행 정책 판정.
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { ensureExecShim, envPath, EXEC_SHIM, EXEC_SHIM_DIR, EXEC_SHIM_NAME, isWindowsPowerShell, policyBlocksShim, readExecutionPolicy, sessionPath } from '../../src/main/psmux/execShim';

const logs: string[] = [];
vi.mock('../../src/main/logger', () => ({ log: (_l: string, m: string) => void logs.push(m), errMsg: (e: unknown) => String(e) }));

const tmp = mkdtempSync(join(tmpdir(), 'ctd-exec-shim-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('session PATH composition', () => {
  const shim = 'C:\\Users\\u\\AppData\\Roaming\\rich-psmux\\bin';
  it('puts the shim first and keeps every other entry in order', () => {
    const base = 'C:\\Windows\\system32;C:\\Program Files\\PowerShell\\7;C:\\Users\\u\\.local\\bin;';
    expect(sessionPath(shim, base)).toBe(`${shim};C:\\Windows\\system32;C:\\Program Files\\PowerShell\\7;C:\\Users\\u\\.local\\bin;`);
  });
  it('does not duplicate the shim (case, trailing slash, quotes) and never drops other entries', () => {
    const base = `C:\\A;"${shim.toUpperCase()}\\";C:\\B`;
    expect(sessionPath(shim, base)).toBe(`${shim};C:\\A;C:\\B`);
    const again = sessionPath(shim, sessionPath(shim, 'C:\\A;C:\\B'));
    expect(again).toBe(`${shim};C:\\A;C:\\B`);
  });
  it('refuses to build a PATH from an empty base (would leave only the shim)', () => {
    expect(sessionPath(shim, '')).toBeNull();
    expect(sessionPath(shim, '   ')).toBeNull();
    expect(sessionPath(shim, undefined)).toBeNull();
    expect(sessionPath('', 'C:\\A')).toBeNull();
    // shim 말고 실제 항목이 하나도 남지 않으면 설정하지 않음
    expect(sessionPath(shim, ';')).toBeNull();
    expect(sessionPath(shim, shim)).toBeNull();
    expect(sessionPath(shim, `${shim}\\;;`)).toBeNull();
  });
  it('keeps empty middle entries and their order', () => {
    expect(sessionPath(shim, 'C:\\A;;C:\\B')).toBe(`${shim};C:\\A;;C:\\B`);
  });
  it('reads PATH case-insensitively and keeps the original name (Windows uses Path)', () => {
    expect(envPath({ Path: 'C:\\A', OTHER: 'x' })).toEqual({ key: 'Path', value: 'C:\\A' });
    expect(envPath({ PATH: 'C:\\B' })).toEqual({ key: 'PATH', value: 'C:\\B' });
    expect(envPath({ Path: '' })).toBeNull();
    expect(envPath({})).toBeNull();
  });
});

describe('exec shim file', () => {
  it('is ASCII only and implements env / NAME=VALUE / exit code (127 when the program cannot start)', () => {
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(EXEC_SHIM)).toBe(true);
    expect(EXEC_SHIM).toContain("$a[0] -eq 'env'");
    expect(EXEC_SHIM).toContain("SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')");
    expect(EXEC_SHIM).toContain('$global:LASTEXITCODE = 0');
    expect(EXEC_SHIM).toContain('if (-not $? -and $LASTEXITCODE -eq 0) { exit 127 }');
    expect(EXEC_SHIM).toContain('exit $LASTEXITCODE');
    expect(EXEC_SHIM).toContain('# shortcut:');
    // 인자는 그대로(이전 env 형태와 같은 argv, 실측): 이스케이프를 풀지 않는다
    expect(EXEC_SHIM).toContain('$a = @($args)');
    expect(EXEC_SHIM).not.toContain('-replace');
  });
  it('writes the file once and rewrites only when the content differs', () => {
    const dir = ensureExecShim(tmp);
    const file = join(dir, EXEC_SHIM_NAME);
    expect(dir).toBe(join(tmp, EXEC_SHIM_DIR));
    expect(EXEC_SHIM_DIR).toBe('exec-shim');
    expect(readFileSync(file, 'utf8')).toBe(EXEC_SHIM);
    const old = new Date(2020, 0, 1);
    utimesSync(file, old, old);
    ensureExecShim(tmp);
    expect(statSync(file).mtimeMs).toBe(old.getTime()); // 같은 내용이면 다시 쓰지 않음
    writeFileSync(file, 'tampered');
    ensureExecShim(tmp);
    expect(readFileSync(file, 'utf8')).toBe(EXEC_SHIM);
    rmSync(file);
    ensureExecShim(tmp); // 지워졌으면 다시 씀
    expect(readFileSync(file, 'utf8')).toBe(EXEC_SHIM);
  });
  it('warns once (file names only) when the shim folder holds anything else', () => {
    const d = mkdtempSync(join(tmpdir(), 'ctd-exec-shim-extra-'));
    try {
      const dir = ensureExecShim(d);
      expect(logs.filter((m) => m.includes('other files'))).toEqual([]);
      writeFileSync(join(dir, 'git.exe'), 'x');
      ensureExecShim(d);
      ensureExecShim(d);
      const w = logs.filter((m) => m.includes('other files'));
      expect(w).toHaveLength(1);
      expect(w[0]).toContain('git.exe');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('execution policy', () => {
  it('flags only policies that block a local unsigned script', () => {
    expect(policyBlocksShim('Restricted')).toBe(true);
    expect(policyBlocksShim('AllSigned\r\n')).toBe(true);
    for (const p of ['RemoteSigned', 'Unrestricted', 'Bypass', 'Undefined']) expect(policyBlocksShim(p)).toBe(false);
  });
  it('recognises Windows PowerShell 5.1 (needs PowerShell 7 for &&)', () => {
    expect(isWindowsPowerShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(true);
    expect(isWindowsPowerShell('powershell')).toBe(true);
    expect(isWindowsPowerShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(false);
  });
  it('does not run non-PowerShell shells', async () => {
    expect(await readExecutionPolicy('C:\\Program Files\\Git\\bin\\bash.exe', {})).toBeNull();
    expect(await readExecutionPolicy('cmd.exe', {})).toBeNull();
  });
});
