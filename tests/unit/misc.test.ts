import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cleanEnv } from '../../src/main/psmux/env';
import { DEFAULT_SETTINGS, diffFromDefaults, normalizeSettings, pushRecent } from '../../src/main/settings';

describe('cleanEnv', () => {
  it('removes outer session variables but keeps AGENT_TEAMS', () => {
    const env = cleanEnv({
      PATH: 'x', SHELL: '/bin/bash', TMUX: 't', TMUX_PANE: '%1', PSMUX_SESSION_NAME: 's', CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'id', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', ELECTRON_RUN_AS_NODE: '1', AI_AGENT: 'x',
    }, { EXTRA: 'y' });
    expect(env).toEqual({ PATH: 'x', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', EXTRA: 'y' });
  });
});

describe('settings', () => {
  it('normalizes and rejects bad values', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const s = normalizeSettings({ leadCommand: 'claude\n--x', fontSize: 99, recentFolders: ['a', 1, 'b'], useHooks: false });
    expect(s.leadCommand).toBe(DEFAULT_SETTINGS.leadCommand);
    expect(s.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(s.recentFolders).toEqual(['a', 'b']);
    expect(s.useHooks).toBe(false);
  });
  it('migrates the legacy font default and saves only non-default values', () => {
    expect(normalizeSettings({ fontFamily: "'Cascadia Mono', Consolas, 'D2Coding', 'Malgun Gothic', monospace" }).fontFamily).toBe(DEFAULT_SETTINGS.fontFamily);
    expect(DEFAULT_SETTINGS.fontFamily.startsWith('"D2Coding"')).toBe(true);
    expect(diffFromDefaults({ ...DEFAULT_SETTINGS, recentFolders: ['D:\\a'] })).toEqual({ recentFolders: ['D:\\a'] });
  });
  it('keeps recent folders unique (case-insensitive) and capped', () => {
    expect(pushRecent(['D:\\A', 'D:\\b'], 'd:\\a')).toEqual(['d:\\a', 'D:\\b']);
    expect(pushRecent(Array.from({ length: 12 }, (_, i) => `f${i}`), 'new')).toHaveLength(10);
  });
});

describe('claudeHome has no write API', () => {
  it('imports only read functions from fs', () => {
    const src = readFileSync(join(__dirname, '../../src/main/claudeHome.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^import .* from 'node:fs/.test(l));
    // 읽기 전용 함수만(스트림 읽기·감시·stat 포함). 쓰기 API는 import도 호출도 없어야 한다
    expect(imports).toEqual([
      "import { createReadStream, watch, type FSWatcher } from 'node:fs';",
      "import { readdir, readFile, stat } from 'node:fs/promises';",
    ]);
    expect(src).not.toMatch(/\b(writeFile|appendFile|rename|unlink|rm|mkdir|utimes|copyFile|open|createWriteStream|truncate|chmod|symlink|link)\w*\(/);
    expect(src).not.toMatch(/flags\s*:/);
  });
});
