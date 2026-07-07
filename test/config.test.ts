import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CLAUDE_ACCOUNTS,
  addClaudeAccount,
  configPath,
  dbPath,
  defaultConfig,
  ensureDirs,
  isPaused,
  loadConfig,
  logsDir,
  pausedPath,
  resolveAccounts,
  sanitizeAccountKey,
  saveConfig,
  setPaused,
  surplusDir,
  worktreesDir,
} from '../src/config.js';
import type { ClaudeAccountConfig, SurplusConfig } from '../src/types.js';

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
      accounts: [{ id: 'main', label: 'personal', configDir: null, priority: null }],
    });
    expect(c.providers.codex).toEqual({
      enabled: false,
      defaults: { model: 'gpt-5.5', effort: 'high' },
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

describe('addClaudeAccount', () => {
  it('appends a valid account (pinning nothing, tilde-form profile dir) and derives label', () => {
    const { entry, config } = addClaudeAccount(defaultConfig(), '  Wiz-Main  '.toLowerCase().trim());
    expect(entry).toEqual({
      id: 'wiz-main',
      label: 'wiz-main',
      configDir: '~/.surplus/profiles/wiz-main',
      priority: null,
    });
    const accounts = config.providers.claude.accounts!;
    expect(accounts.map((a) => a.id)).toEqual(['main', 'wiz-main']);
    // pure: the input config is not mutated
    expect(defaultConfig().providers.claude.accounts).toHaveLength(1);
  });

  it('uses an explicit label when given', () => {
    const { entry } = addClaudeAccount(defaultConfig(), 'work', { label: 'Work Max' });
    expect(entry.label).toBe('Work Max');
  });

  it('rejects a pasted OAuth token with a specific message', () => {
    expect(() => addClaudeAccount(defaultConfig(), 'sk-ant-oat01-Abc')).toThrow(/looks like an OAuth token/i);
  });

  it('rejects bad slugs, the reserved id, duplicates, and over-cap', () => {
    expect(() => addClaudeAccount(defaultConfig(), 'Bad Slug')).toThrow(/invalid slug/i);
    expect(() => addClaudeAccount(defaultConfig(), 'UPPER')).toThrow(/invalid slug/i);
    expect(() => addClaudeAccount(defaultConfig(), 'main')).toThrow(/reserved/i);
    const one = addClaudeAccount(defaultConfig(), 'a').config;
    expect(() => addClaudeAccount(one, 'a')).toThrow(/already exists/i);
    // fill to the cap (main + 5 = 6), then the next is rejected
    let cfg = defaultConfig();
    for (const id of ['a', 'b', 'c', 'd', 'e']) cfg = addClaudeAccount(cfg, id).config;
    expect(cfg.providers.claude.accounts).toHaveLength(MAX_CLAUDE_ACCOUNTS);
    expect(() => addClaudeAccount(cfg, 'f')).toThrow(new RegExp(`at most ${MAX_CLAUDE_ACCOUNTS}`));
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
    expect(c.providers.codex.defaults).toEqual({ model: 'gpt-5.5', effort: 'high' });
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

  it('coerces a retired codex model slug to the current default, warning on stderr', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(
      configPath(tmp),
      JSON.stringify({ providers: { codex: { defaults: { model: 'gpt-5.1-codex' } } } }),
    );
    const c = loadConfig(tmp);
    expect(c.providers.codex.defaults.model).toBe('gpt-5.5');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gpt-5.1-codex'));
    warn.mockRestore();
  });

  it('leaves a still-valid codex model slug untouched', () => {
    writeFileSync(
      configPath(tmp),
      JSON.stringify({ providers: { codex: { defaults: { model: 'gpt-5.4' } } } }),
    );
    expect(loadConfig(tmp).providers.codex.defaults.model).toBe('gpt-5.4');
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

// ---------------------------------------------------------------------------
// resolveAccounts — single source of truth for account enumeration + keys
// ---------------------------------------------------------------------------

function configWithAccounts(
  accounts: ClaudeAccountConfig[] | undefined,
  opts: { claudeEnabled?: boolean; codexEnabled?: boolean } = {},
): SurplusConfig {
  const c = defaultConfig();
  c.providers.claude.enabled = opts.claudeEnabled ?? true;
  c.providers.codex.enabled = opts.codexEnabled ?? false;
  if (accounts === undefined) delete c.providers.claude.accounts;
  else c.providers.claude.accounts = accounts;
  return c;
}

describe('resolveAccounts', () => {
  it('defaults to the single main account (key "claude") when accounts is absent', () => {
    expect(resolveAccounts(configWithAccounts(undefined))).toEqual([
      { key: 'claude', provider: 'claude', id: 'main', label: 'personal', configDir: null, priority: null },
    ]);
  });

  it('treats an empty accounts array as the default main account', () => {
    expect(resolveAccounts(configWithAccounts([]))[0]).toMatchObject({ key: 'claude', id: 'main' });
  });

  it("maps id 'main' to bare key 'claude' (db/affinity back-compat) and others to 'claude:<id>'", () => {
    const accounts = resolveAccounts(
      configWithAccounts([
        { id: 'work', label: 'work acct', configDir: '/opt/claude-work', priority: 1 },
        { id: 'main', label: 'personal', configDir: null, priority: null },
      ]),
    );
    expect(accounts.map((a) => a.key)).toEqual(['claude:work', 'claude']);
    expect(accounts[0]).toMatchObject({ label: 'work acct', priority: 1, configDir: '/opt/claude-work' });
  });

  it("expands '~' in configDir to an absolute path under the home dir", () => {
    const [acct] = resolveAccounts(
      configWithAccounts([{ id: 'work', label: 'w', configDir: '~/claude-work', priority: null }]),
    );
    expect(acct!.configDir).toBe(join(homedir(), 'claude-work'));
  });

  it('skips invalid and duplicate ids, caps at MAX_CLAUDE_ACCOUNTS, never loses main entirely', () => {
    const many: ClaudeAccountConfig[] = [
      { id: 'UPPER', label: 'bad', configDir: '~/p/upper', priority: null }, // invalid slug
      { id: 'a-very-long-id-way-over-twenty-four-chars', label: 'bad', configDir: '~/p/long', priority: null },
      { id: 'dup', label: 'first', configDir: '~/p/dup1', priority: null },
      { id: 'dup', label: 'second', configDir: '~/p/dup2', priority: null }, // duplicate
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({
        id,
        label: id,
        configDir: `~/p/${id}`,
        priority: null,
      })),
    ];
    const accounts = resolveAccounts(configWithAccounts(many));
    expect(accounts).toHaveLength(MAX_CLAUDE_ACCOUNTS);
    expect(accounts.filter((a) => a.id === 'dup')).toHaveLength(1);
    expect(accounts.find((a) => a.id === 'dup')!.label).toBe('first');

    // Every declared entry invalid → fall back to the main account.
    const fallback = resolveAccounts(
      configWithAccounts([{ id: 'NOPE!', label: 'x', configDir: null, priority: null }]),
    );
    expect(fallback).toEqual([
      { key: 'claude', provider: 'claude', id: 'main', label: 'personal', configDir: null, priority: null },
    ]);
  });

  it('skips non-main entries with a missing/empty configDir (they would alias the main login)', () => {
    const accounts = resolveAccounts(
      configWithAccounts([
        { id: 'main', label: 'personal', configDir: null, priority: null },
        { id: 'work', label: 'work', configDir: null, priority: null }, // hand-edited: no dir
        { id: 'ci', label: 'ci', configDir: '   ', priority: null }, // whitespace only
      ]),
    );
    expect(accounts.map((a) => a.key)).toEqual(['claude']);
    expect(accounts[0]!.configDir).toBeNull(); // single account → env-honoring default flow
  });

  it("skips non-main entries whose configDir resolves to the default ~/.claude (that's main)", () => {
    const accounts = resolveAccounts(
      configWithAccounts([
        { id: 'main', label: 'personal', configDir: null, priority: null },
        { id: 'work', label: 'work', configDir: '~/.claude', priority: null },
      ]),
    );
    expect(accounts.map((a) => a.key)).toEqual(['claude']);
  });

  it('skips entries whose resolved configDir duplicates an earlier account (one source = one account)', () => {
    const accounts = resolveAccounts(
      configWithAccounts([
        { id: 'work', label: 'work', configDir: '~/profiles/work', priority: null },
        { id: 'work2', label: 'work2', configDir: '~/profiles/work', priority: null }, // same dir
        { id: 'ci', label: 'ci', configDir: '/opt/profiles/ci', priority: null },
      ]),
    );
    expect(accounts.map((a) => a.key)).toEqual(['claude:work', 'claude:ci']);
  });

  it('pins main configDir to the explicit ~/.claude when other accounts exist (env cannot alias it)', () => {
    const multi = resolveAccounts(
      configWithAccounts([
        { id: 'main', label: 'personal', configDir: null, priority: null },
        { id: 'work', label: 'work', configDir: '~/profiles/work', priority: null },
      ]),
    );
    expect(multi.find((a) => a.id === 'main')!.configDir).toBe(join(homedir(), '.claude'));

    // Single account: null is preserved (legacy env-honoring default flow).
    const single = resolveAccounts(
      configWithAccounts([{ id: 'main', label: 'personal', configDir: null, priority: null }]),
    );
    expect(single[0]!.configDir).toBeNull();
  });

  it('appends the single codex account when codex is enabled, and honors disabled claude', () => {
    const both = resolveAccounts(configWithAccounts(undefined, { codexEnabled: true }));
    expect(both.map((a) => a.key)).toEqual(['claude', 'codex']);
    expect(both[1]).toMatchObject({ provider: 'codex', label: 'codex', priority: null, configDir: null });

    const codexOnly = resolveAccounts(
      configWithAccounts(undefined, { claudeEnabled: false, codexEnabled: true }),
    );
    expect(codexOnly.map((a) => a.key)).toEqual(['codex']);
  });

  it('loadConfig tolerates configs written before the accounts feature (deep-merge keeps the default)', () => {
    writeFileSync(
      configPath(tmp),
      JSON.stringify({ providers: { claude: { enabled: true, defaults: { model: 'opus', effort: 'high' } } } }),
    );
    const accounts = resolveAccounts(loadConfig(tmp));
    expect(accounts.map((a) => a.key)).toEqual(['claude']);
  });
});

describe('sanitizeAccountKey', () => {
  it('lowercases and collapses non [a-z0-9-] runs to dashes', () => {
    expect(sanitizeAccountKey('claude:work')).toBe('claude-work');
    expect(sanitizeAccountKey('claude')).toBe('claude');
    expect(sanitizeAccountKey('Claude::Work!!')).toBe('claude-work');
    expect(sanitizeAccountKey('::')).toBe('account');
  });
});
