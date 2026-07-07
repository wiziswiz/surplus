/**
 * config.ts — SurplusConfig defaults, load/save with deep-merge, and
 * ~/.surplus path helpers (kill switch included).
 *
 * Every helper accepts an optional base-dir override so tests can point at a
 * tmp dir instead of ~/.surplus. Directories are created lazily — nothing
 * touches the filesystem until a write actually happens.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CONFIG_FILE,
  DB_FILE,
  LOGS_DIR,
  PAUSED_FILE,
  SURPLUS_DIR_NAME,
  WORKTREES_DIR,
  type ClaudeAccountConfig,
  type Provider,
  type SurplusConfig,
} from './types.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Base runtime-state dir: the override when given, else ~/.surplus. */
export function surplusDir(dir?: string): string {
  return dir ?? join(homedir(), SURPLUS_DIR_NAME);
}

export function dbPath(dir?: string): string {
  return join(surplusDir(dir), DB_FILE);
}

export function configPath(dir?: string): string {
  return join(surplusDir(dir), CONFIG_FILE);
}

export function pausedPath(dir?: string): string {
  return join(surplusDir(dir), PAUSED_FILE);
}

export function logsDir(dir?: string): string {
  return join(surplusDir(dir), LOGS_DIR);
}

export function worktreesDir(dir?: string): string {
  return join(surplusDir(dir), WORKTREES_DIR);
}

/** Create the runtime-state tree (base, logs/, worktrees/). Returns the base dir. */
export function ensureDirs(dir?: string): string {
  const base = surplusDir(dir);
  mkdirSync(base, { recursive: true });
  mkdirSync(logsDir(dir), { recursive: true });
  mkdirSync(worktreesDir(dir), { recursive: true });
  return base;
}

// ---------------------------------------------------------------------------
// Accounts — single source of truth for enumeration + AccountKey construction
// ---------------------------------------------------------------------------

/** Account id slug: 'main' is reserved for the default account. */
const ACCOUNT_ID_RE = /^[a-z0-9-]{1,24}$/;

/** Hard cap on configured claude accounts. */
export const MAX_CLAUDE_ACCOUNTS = 6;

/** The implicit single-account default for providers.claude.accounts. */
export function defaultClaudeAccounts(): ClaudeAccountConfig[] {
  return [{ id: 'main', label: 'personal', configDir: null, priority: null }];
}

/**
 * Validate a new claude-account slug and return the config with it appended, plus
 * the derived entry. PURE — no filesystem writes (the caller mkdir's the profile
 * dir and saves). Throws a user-facing message on any invalid/duplicate/over-cap
 * slug (incl. the classic "pasted my token here" mistake).
 */
export function addClaudeAccount(
  config: SurplusConfig,
  slug: string,
  opts?: { label?: string },
): { entry: ClaudeAccountConfig; config: SurplusConfig } {
  const id = slug.trim();
  if (/^sk-ant/i.test(id)) {
    throw new Error(
      "that looks like an OAuth token — the account id is just a short nickname (e.g. 'wiz-main'). " +
        'surplus never stores tokens: it signs you in through Claude Code and reads the ' +
        'auto-refreshing credential at call time.',
    );
  }
  if (!ACCOUNT_ID_RE.test(id)) {
    throw new Error(`invalid slug '${id}' — use 1–24 lowercase letters, digits or dashes (e.g. 'wiz-main')`);
  }
  if (id === 'main') {
    throw new Error("'main' is reserved for your default ~/.claude account — pick another slug");
  }
  const accounts = config.providers.claude.accounts ?? defaultClaudeAccounts();
  if (accounts.some((a) => a.id === id)) {
    throw new Error(`account '${id}' already exists`);
  }
  if (accounts.length >= MAX_CLAUDE_ACCOUNTS) {
    throw new Error(`at most ${MAX_CLAUDE_ACCOUNTS} claude accounts`);
  }
  const entry: ClaudeAccountConfig = {
    id,
    label: opts?.label?.trim() || id,
    configDir: `~/.surplus/profiles/${id}`,
    priority: null,
  };
  return {
    entry,
    config: {
      ...config,
      providers: {
        ...config.providers,
        claude: { ...config.providers.claude, accounts: [...accounts, entry] },
      },
    },
  };
}

/** One enumerated burnable account (config-level, not yet bound to a runner). */
export interface ResolvedAccount {
  /** AccountKey: 'claude' (BACK-COMPAT for id 'main') | 'claude:<id>' | 'codex'. */
  key: string;
  provider: Provider;
  id: string;
  label: string;
  /**
   * Absolute Claude Code profile dir ('~' expanded); null = the default
   * env-honoring flow ($CLAUDE_CONFIG_DIR / ~/.claude). With more than one
   * claude account configured, main is pinned to the explicit ~/.claude
   * (never null) so the environment cannot alias it to another account.
   */
  configDir: string | null;
  /** Manual burn order (lower = preferred); null = auto. */
  priority: number | null;
}

/** Expand a leading '~' to the home directory. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Resolved default Claude Code profile dir (~/.claude). */
export function defaultClaudeDir(): string {
  return resolve(join(homedir(), '.claude'));
}

/**
 * Enumerate every burnable account for the enabled providers — the single
 * source of truth for account enumeration and key construction:
 *   - claude (when enabled): config.providers.claude.accounts, defaulting to
 *     the single 'main' account. id 'main' maps to key 'claude' (back-compat
 *     with pre-account db rows/affinities); every other id maps to
 *     'claude:<id>'. Entries with invalid ids ([a-z0-9-]{1,24}) or duplicate
 *     ids are skipped; at most MAX_CLAUDE_ACCOUNTS survive. configDir is
 *     '~'-expanded and resolved to an absolute path (null = default).
 *     Hand-edited configs get the same independence guarantees the PATCH
 *     validator enforces: a non-main entry with a missing/empty configDir or
 *     one resolving to the default ~/.claude is skipped (it would silently
 *     re-enumerate the main subscription under a second key), and any entry
 *     whose resolved dir duplicates an earlier account's dir is skipped (one
 *     credential source = one account). When more than one claude account
 *     survives, main's null configDir is pinned to the explicit ~/.claude so
 *     a stray process-level CLAUDE_CONFIG_DIR (e.g. exported after a profile
 *     login) can never alias the 'claude' key to a non-main account.
 *   - codex (when enabled): the single 'codex' account.
 * Tolerates configs written before the accounts feature (key absent → main).
 */
export function resolveAccounts(config: SurplusConfig): ResolvedAccount[] {
  const out: ResolvedAccount[] = [];

  if (config.providers.claude.enabled) {
    const declared = config.providers.claude.accounts;
    const accounts = Array.isArray(declared) && declared.length > 0 ? declared : defaultClaudeAccounts();
    const defaultDir = defaultClaudeDir();
    const seenIds = new Set<string>();
    const seenDirs = new Set<string>();
    for (const account of accounts) {
      if (out.length >= MAX_CLAUDE_ACCOUNTS) break;
      const id = typeof account?.id === 'string' ? account.id : '';
      if (!ACCOUNT_ID_RE.test(id) || seenIds.has(id)) continue;
      const rawDir = typeof account.configDir === 'string' ? account.configDir.trim() : '';
      const configDir = rawDir === '' ? null : resolve(expandTilde(rawDir));
      // Non-main entries must name their OWN profile dir: a missing configDir
      // or one resolving to ~/.claude is the main subscription again — keeping
      // it would burn one login under two keys (double pacing/claims).
      if (id !== 'main' && (configDir === null || configDir === defaultDir)) continue;
      // One credential source = one account: skip entries whose resolved dir
      // duplicates an earlier account's (main's null counts as ~/.claude).
      const dirKey = configDir ?? defaultDir;
      if (seenDirs.has(dirKey)) continue;
      seenIds.add(id);
      seenDirs.add(dirKey);
      out.push({
        key: id === 'main' ? 'claude' : `claude:${id}`,
        provider: 'claude',
        id,
        label:
          typeof account.label === 'string' && account.label.trim() !== '' ? account.label.trim() : id,
        configDir,
        priority:
          typeof account.priority === 'number' && Number.isFinite(account.priority)
            ? account.priority
            : null,
      });
    }
    // Multi-account: pin main's default (null) configDir to the explicit
    // ~/.claude. Otherwise main resolves through the legacy env-honoring flow
    // ($CLAUDE_CONFIG_DIR), and a profile-login export leaking into the
    // environment that starts surplus would make the 'claude' key read and
    // burn a non-main account's subscription while the real ~/.claude login
    // is never gated at all. Pinning flows everywhere: credentials (keychain
    // service + .credentials.json), the per-account usage cache, and the
    // spawned worker's CLAUDE_CONFIG_DIR override.
    if (out.length > 1) {
      for (const acct of out) {
        if (acct.id === 'main' && acct.configDir === null) acct.configDir = defaultDir;
      }
    }
    if (out.length === 0) {
      // Every declared entry was invalid — never lose the main account.
      out.push({
        key: 'claude',
        provider: 'claude',
        id: 'main',
        label: 'personal',
        configDir: null,
        priority: null,
      });
    }
  }

  if (config.providers.codex.enabled) {
    out.push({
      key: 'codex',
      provider: 'codex',
      id: 'codex',
      label: 'codex',
      configDir: null,
      priority: null,
    });
  }

  return out;
}

/**
 * Sanitize an AccountKey for use in filenames (logs, usage caches):
 * lowercased, [a-z0-9-] only ('claude:work' → 'claude-work').
 */
export function sanitizeAccountKey(key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'account' : slug;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Fresh default config object (never share/mutate a module-level singleton). */
export function defaultConfig(): SurplusConfig {
  return {
    providers: {
      claude: {
        enabled: true,
        defaults: { model: 'opus', effort: 'high' },
        accounts: defaultClaudeAccounts(),
      },
      codex: {
        enabled: false,
        defaults: { model: 'gpt-5.5', effort: 'high' },
        weeklyResetFallback: null,
      },
    },
    modes: {
      weeklySurplus: {
        enabled: true,
        burnWindowHours: 12,
        stopAtPct: 95,
      },
      fiveHourBurst: {
        enabled: false,
        triggerMinutesBeforeReset: 30,
        weeklyGuardPct: 70,
      },
    },
    pacing: {
      fiveHourPausePct: 90,
    },
    reserve: {
      weeklyPct: 10,
      fiveHourPct: 25,
      watchdogIntervalMinutes: 5,
    },
    discovery: {
      roots: ['~/Projects'],
    },
    dispatcher: {
      maxConcurrent: 1,
      maxAttempts: 3,
      taskTimeoutMinutes: 90,
      maxTurnsHint: 40,
    },
    judge: {
      model: 'haiku',
    },
    board: {
      port: 4242,
    },
    judgePassScore: 4,
  };
}

// ---------------------------------------------------------------------------
// Deep merge (user config over defaults)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively merge `override` over `base`. Plain objects merge key-by-key;
 * everything else (primitives, arrays, null) from `override` replaces the
 * base value. `undefined` override values are ignored.
 */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : (override as T);
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const baseValue = (base as Record<string, unknown>)[key];
    out[key] = isPlainObject(baseValue) && isPlainObject(value) ? deepMerge(baseValue, value) : value;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Read <dir or ~/.surplus>/config.json when present and deep-merge it over
 * defaults. Malformed/unreadable JSON falls back to pure defaults with a
 * warning on stderr — never throws.
 */
export function loadConfig(dir?: string): SurplusConfig {
  const file = configPath(dir);
  if (!existsSync(file)) return defaultConfig();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isPlainObject(parsed)) {
      throw new Error('config root is not a JSON object');
    }
    return coerceRetiredCodexModel(deepMerge(defaultConfig(), parsed), file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // console.warn writes to stderr in Node.
    console.warn(`surplus: malformed config at ${file} — falling back to defaults (${msg})`);
    return defaultConfig();
  }
}

/**
 * Codex model slugs retired from the codex CLI. surplus persists the FULL merged
 * config on every Save, so an install that once chose a gpt-5.1-* slug keeps it
 * forever — and `codex exec -m <dead-slug>` then fails at runtime, blocking the
 * task with no hint why. Coerce a retired slug to the current default (loudly, so
 * the user updates their file) rather than dead-slug every codex burn silently.
 */
const RETIRED_CODEX_MODELS: ReadonlySet<string> = new Set([
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1',
  'gpt-5-codex',
  'gpt-5',
]);

function coerceRetiredCodexModel(cfg: SurplusConfig, file: string): SurplusConfig {
  const current = cfg.providers.codex.defaults.model;
  if (RETIRED_CODEX_MODELS.has(current)) {
    const replacement = defaultConfig().providers.codex.defaults.model;
    console.warn(
      `surplus: codex model '${current}' is retired from the codex CLI — using ` +
        `'${replacement}' instead. Update providers.codex.defaults.model in ${file} ` +
        `(run 'codex debug models' for the current slugs).`,
    );
    cfg.providers.codex.defaults.model = replacement;
  }
  return cfg;
}

/** Write config as pretty JSON, creating the state dir lazily. */
export function saveConfig(cfg: SurplusConfig, dir?: string): void {
  mkdirSync(surplusDir(dir), { recursive: true });
  writeFileSync(configPath(dir), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Kill switch (~/.surplus/PAUSED)
// ---------------------------------------------------------------------------

export function isPaused(dir?: string): boolean {
  return existsSync(pausedPath(dir));
}

export function setPaused(on: boolean, dir?: string): void {
  if (on) {
    mkdirSync(surplusDir(dir), { recursive: true });
    writeFileSync(pausedPath(dir), `paused at ${new Date().toISOString()}\n`, 'utf8');
  } else {
    rmSync(pausedPath(dir), { force: true });
  }
}
