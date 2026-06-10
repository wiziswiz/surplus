import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configPath,
  dbPath,
  defaultConfig,
  ensureDirs,
  isPaused,
  loadConfig,
  logsDir,
  pausedPath,
  saveConfig,
  setPaused,
  surplusDir,
  worktreesDir,
} from '../src/config.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'surplus-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('defaultConfig', () => {
  it('matches the documented defaults', () => {
    const c = defaultConfig();
    expect(c.providers.claude).toEqual({
      enabled: true,
      defaults: { model: 'opus', effort: 'high' },
    });
    expect(c.providers.codex).toEqual({
      enabled: false,
      defaults: { model: 'gpt-5.1-codex', effort: 'high' },
      weeklyResetFallback: null,
    });
    expect(c.modes.weeklySurplus).toEqual({ enabled: true, burnWindowHours: 12, stopAtPct: 95 });
    expect(c.modes.fiveHourBurst).toEqual({
      enabled: false,
      triggerMinutesBeforeReset: 30,
      weeklyGuardPct: 70,
    });
    expect(c.pacing.fiveHourPausePct).toBe(90);
    expect(c.dispatcher).toEqual({
      maxConcurrent: 1,
      maxAttempts: 3,
      taskTimeoutMinutes: 90,
      maxTurnsHint: 40,
    });
    expect(c.judge.model).toBe('haiku');
    expect(c.board.port).toBe(4242);
    expect(c.judgePassScore).toBe(4);
  });

  it('returns a fresh object every call (no shared mutable singleton)', () => {
    const a = defaultConfig();
    a.modes.weeklySurplus.stopAtPct = 1;
    expect(defaultConfig().modes.weeklySurplus.stopAtPct).toBe(95);
  });
});

describe('path helpers', () => {
  it('build paths under the override dir', () => {
    expect(surplusDir(tmp)).toBe(tmp);
    expect(dbPath(tmp)).toBe(join(tmp, 'surplus.db'));
    expect(configPath(tmp)).toBe(join(tmp, 'config.json'));
    expect(pausedPath(tmp)).toBe(join(tmp, 'PAUSED'));
    expect(logsDir(tmp)).toBe(join(tmp, 'logs'));
    expect(worktreesDir(tmp)).toBe(join(tmp, 'worktrees'));
  });

  it('default to ~/.surplus when no override is given', () => {
    expect(surplusDir()).toBe(join(homedir(), '.surplus'));
    expect(dbPath()).toBe(join(homedir(), '.surplus', 'surplus.db'));
  });

  it('ensureDirs creates base, logs/ and worktrees/ lazily', () => {
    const base = join(tmp, 'nested', 'state');
    expect(existsSync(base)).toBe(false);
    expect(ensureDirs(base)).toBe(base);
    expect(existsSync(base)).toBe(true);
    expect(existsSync(join(base, 'logs'))).toBe(true);
    expect(existsSync(join(base, 'worktrees'))).toBe(true);
    // Idempotent.
    expect(() => ensureDirs(base)).not.toThrow();
  });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    expect(loadConfig(tmp)).toEqual(defaultConfig());
  });

  it('deep-merges a partial user config over defaults', () => {
    writeFileSync(
      configPath(tmp),
      JSON.stringify({
        providers: { codex: { enabled: true } },
        modes: { weeklySurplus: { stopAtPct: 80 } },
        board: { port: 5555 },
      }),
    );
    const c = loadConfig(tmp);
    // Overridden leaves.
    expect(c.providers.codex.enabled).toBe(true);
    expect(c.modes.weeklySurplus.stopAtPct).toBe(80);
    expect(c.board.port).toBe(5555);
    // Sibling defaults survive at every depth.
    expect(c.providers.codex.defaults).toEqual({ model: 'gpt-5.1-codex', effort: 'high' });
    expect(c.providers.claude.enabled).toBe(true);
    expect(c.modes.weeklySurplus.enabled).toBe(true);
    expect(c.modes.weeklySurplus.burnWindowHours).toBe(12);
    expect(c.modes.fiveHourBurst.weeklyGuardPct).toBe(70);
    expect(c.judgePassScore).toBe(4);
  });

  it('replaces non-object leaves rather than merging them', () => {
    writeFileSync(
      configPath(tmp),
      JSON.stringify({ providers: { codex: { weeklyResetFallback: 'Thu 21:00' } } }),
    );
    expect(loadConfig(tmp).providers.codex.weeklyResetFallback).toBe('Thu 21:00');
  });

  it('falls back to defaults on malformed JSON, warning on stderr', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(configPath(tmp), '{not valid json!!');
    expect(loadConfig(tmp)).toEqual(defaultConfig());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('malformed config');
  });

  it('falls back to defaults when the JSON root is not an object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(configPath(tmp), '[1,2,3]');
    expect(loadConfig(tmp)).toEqual(defaultConfig());
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('saveConfig', () => {
  it('round-trips through loadConfig', () => {
    const c = defaultConfig();
    c.board.port = 9999;
    c.providers.codex.enabled = true;
    saveConfig(c, tmp);
    expect(loadConfig(tmp)).toEqual(c);
  });

  it('creates the state dir lazily', () => {
    const base = join(tmp, 'does', 'not', 'exist');
    saveConfig(defaultConfig(), base);
    expect(existsSync(configPath(base))).toBe(true);
    expect(JSON.parse(readFileSync(configPath(base), 'utf8'))).toEqual(defaultConfig());
  });
});

describe('paused kill switch', () => {
  it('toggles via the PAUSED file', () => {
    expect(isPaused(tmp)).toBe(false);
    setPaused(true, tmp);
    expect(isPaused(tmp)).toBe(true);
    expect(existsSync(pausedPath(tmp))).toBe(true);
    setPaused(false, tmp);
    expect(isPaused(tmp)).toBe(false);
    expect(existsSync(pausedPath(tmp))).toBe(false);
  });

  it('setPaused(true) creates the state dir lazily', () => {
    const base = join(tmp, 'fresh');
    setPaused(true, base);
    expect(isPaused(base)).toBe(true);
  });

  it('setPaused(false) is a no-op when not paused', () => {
    expect(() => setPaused(false, tmp)).not.toThrow();
    expect(isPaused(tmp)).toBe(false);
  });
});
