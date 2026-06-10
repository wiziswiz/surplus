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
import { join } from 'node:path';
import {
  CONFIG_FILE,
  DB_FILE,
  LOGS_DIR,
  PAUSED_FILE,
  SURPLUS_DIR_NAME,
  WORKTREES_DIR,
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
// Defaults
// ---------------------------------------------------------------------------

/** Fresh default config object (never share/mutate a module-level singleton). */
export function defaultConfig(): SurplusConfig {
  return {
    providers: {
      claude: {
        enabled: true,
        defaults: { model: 'opus', effort: 'high' },
      },
      codex: {
        enabled: false,
        defaults: { model: 'gpt-5.1-codex', effort: 'high' },
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
    return deepMerge(defaultConfig(), parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // console.warn writes to stderr in Node.
    console.warn(`surplus: malformed config at ${file} — falling back to defaults (${msg})`);
    return defaultConfig();
  }
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
