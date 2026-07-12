/**
 * models.ts — dynamic Codex model discovery.
 *
 * The Codex CLI's catalog changes often (gpt-5.1-* → 5.4/5.5 → 5.6-* in weeks),
 * so a hardcoded picker list rots. We source it from `codex debug models` and
 * cache the result under ~/.surplus so the hot /api/state path never spawns a
 * subprocess on every poll. ANY failure (codex missing, parse error, timeout)
 * degrades to a safe static fallback — the board never breaks. Claude models use
 * stable aliases (fable/opus/sonnet/haiku), so only Codex needs this.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { surplusDir } from './config.js';

/** Safe static fallback when the CLI is unavailable or unparseable. */
export const CODEX_MODEL_FALLBACK: readonly string[] = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];

const CACHE_FILE = 'codex-models.json';
const CACHE_TTL_MS = 12 * 60 * 60_000; // 12h — model lists change rarely

interface ModelCache {
  models: string[];
  fetchedAt: number;
}

export interface CodexModelDeps {
  now?: () => number;
  /** Test seam: raw `codex debug models` stdout, or null on failure. */
  probe?: () => string | null;
  /** Surplus state-dir override (tests). */
  dir?: string;
}

function defaultProbe(): string | null {
  try {
    const r = spawnSync('codex', ['debug', 'models'], { encoding: 'utf8', timeout: 10_000 });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout;
  } catch {
    return null;
  }
}

/**
 * Parse `codex debug models` JSON into usable worker model slugs. Keeps only
 * list-visible models and drops review-only ones (codex-auto-review is not a
 * general task worker). Throws on malformed JSON (callers treat that as failure).
 */
export function parseCodexModels(stdout: string): string[] {
  const data = JSON.parse(stdout) as { models?: Array<{ slug?: string; visibility?: string }> };
  const models = Array.isArray(data.models) ? data.models : [];
  return models
    .filter((m) => typeof m.slug === 'string' && m.slug.length > 0)
    .filter((m) => m.visibility === undefined || m.visibility === 'list')
    .map((m) => m.slug as string)
    .filter((slug) => slug !== 'codex-auto-review');
}

/**
 * Available Codex model slugs, cached under ~/.surplus (TTL 12h). NEVER throws:
 * returns a fresh probe → stale cache → CODEX_MODEL_FALLBACK, in that order.
 */
export function codexModels(deps: CodexModelDeps = {}): string[] {
  const now = deps.now ?? (() => Date.now());
  const cachePath = join(surplusDir(deps.dir), CACHE_FILE);

  const readCache = (): ModelCache | null => {
    try {
      if (!existsSync(cachePath)) return null;
      const c = JSON.parse(readFileSync(cachePath, 'utf8')) as ModelCache;
      return Array.isArray(c.models) && c.models.length > 0 && typeof c.fetchedAt === 'number'
        ? c
        : null;
    } catch {
      return null;
    }
  };

  const cached = readCache();
  if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return cached.models;

  // Cache missing or stale → probe the CLI.
  const stdout = (deps.probe ?? defaultProbe)();
  if (stdout) {
    try {
      const models = parseCodexModels(stdout);
      if (models.length > 0) {
        try {
          mkdirSync(surplusDir(deps.dir), { recursive: true });
          writeFileSync(cachePath, JSON.stringify({ models, fetchedAt: now() } satisfies ModelCache));
        } catch {
          // caching is best-effort
        }
        return models;
      }
    } catch {
      // parse failed → fall through
    }
  }

  // Probe failed: a stale cache still beats the static fallback.
  if (cached) return cached.models;
  return [...CODEX_MODEL_FALLBACK];
}
