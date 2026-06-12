/**
 * Anthropic OAuth usage client (claude provider).
 *
 * GET https://api.anthropic.com/api/oauth/usage with the Claude Code OAuth
 * token, returning 5-hour / 7-day rate-limit window utilization.
 *
 * Behavior:
 *  - Returns null for API-key users (subscriptionType 'api'/empty), missing or
 *    expired credentials, and custom ANTHROPIC_BASE_URL endpoints.
 *  - Returns { unavailable: true, error } on API failure.
 *  - File cache at ~/.surplus/.usage-cache.json (PER ACCOUNT: non-main claude
 *    accounts use .usage-cache-<key>.json — see usageCacheFile): 5 min TTL on
 *    success, 15 s on
 *    failure. On 429, serves lastGoodData (error 'rate-limited',
 *    unavailable=false) while honoring Retry-After (clamped to the 5-min cap)
 *    / exponential backoff (60s/120s/240s, capped 5 min) before refetching —
 *    but only while lastGoodData is fresh enough to act on (15 min); older
 *    data is reported unavailable so decide() and the reserve watchdog never
 *    run on frozen numbers.
 *
 * SECURITY: the access token is only ever placed in the Authorization header.
 * It is never logged, cached, or embedded in errors.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SURPLUS_DIR_NAME, USAGE_CACHE_FILE } from './types.js';
import type { OAuthCredentials, UsageSnapshot } from './types.js';
import { sanitizeAccountKey } from './config.js';
import { readCredentials } from './credentials.js';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
const USER_AGENT = 'claude-code/2.1';
const FETCH_TIMEOUT_MS = 15_000;

const CACHE_TTL_MS = 5 * 60_000; // success
const CACHE_FAILURE_TTL_MS = 15_000; // failure
const RATE_LIMITED_BASE_MS = 60_000; // 429 backoff base
const RATE_LIMITED_MAX_MS = 5 * 60_000; // 429 backoff cap
/**
 * Max age of lastGoodData served as live (unavailable=false) during a 429
 * backoff. Persisting 429s would otherwise present hours-old utilization as
 * current — decide() would keep burning and the mid-run reserve watchdog
 * would be blind exactly when the account is hot enough to be rate-limited.
 */
const LAST_GOOD_MAX_AGE_MS = 15 * 60_000;

/** Test seams + per-account selectors. Production callers pass nothing or {configDir, accountKey}. */
export interface GetUsageOverrides {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Directory holding the usage cache file(s); default ~/.surplus. */
  cacheDir?: string;
  /** Credential source; default readCredentials() (keychain + file, configDir-aware). */
  readCredentialsImpl?: (now: number, configDir?: string | null) => OAuthCredentials | null;
  env?: NodeJS.ProcessEnv;
  /**
   * Claude Code profile dir of the account whose usage to fetch; forwarded to
   * the credential reader. null/undefined = the default account flow.
   */
  configDir?: string | null;
  /**
   * AccountKey for CACHE ISOLATION: each account caches into its own file
   * (see usageCacheFile) so accounts never serve each other's numbers.
   * Absent (or 'claude', the main account) = the legacy .usage-cache.json.
   */
  accountKey?: string;
  /**
   * Accept cached success data only up to this age (ms) — a manual-refresh
   * hook. Floored at MIN_MAX_AGE_MS (30s) so a refresh button can't hammer
   * the rate-limited endpoint, and NEVER overrides an active 429 backoff.
   */
  maxAgeMs?: number;
}

export const MIN_MAX_AGE_MS = 30_000;

/**
 * Per-account cache filename: the main account ('claude' / absent) keeps the
 * legacy USAGE_CACHE_FILE (existing caches stay valid); every other account
 * key gets `.usage-cache-<sanitized [a-z0-9-] key>.json`.
 */
export function usageCacheFile(accountKey?: string): string {
  if (accountKey === undefined || accountKey === 'claude') return USAGE_CACHE_FILE;
  return `.usage-cache-${sanitizeAccountKey(accountKey)}.json`;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Clamp utilization to 0–100, round; NaN/Infinity/missing -> null. */
export function parseUtilization(value: number | undefined | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(100, value)));
}

/** Parse an ISO date string; invalid/missing -> null. */
export function parseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Parse a Retry-After header: delta-seconds or HTTP-date. */
export function parseRetryAfterSeconds(raw: string | null, nowMs: number): number | undefined {
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const retryAtMs = Date.parse(raw);
  if (!Number.isFinite(retryAtMs)) return undefined;
  const delta = Math.ceil((retryAtMs - nowMs) / 1000);
  return delta > 0 ? delta : undefined;
}

/** Plan display name; 'api' / empty -> null (API users have no usage windows). */
export function getPlanName(subscriptionType: string): string | null {
  const lower = subscriptionType.toLowerCase();
  if (lower.includes('max')) return 'Max';
  if (lower.includes('pro')) return 'Pro';
  if (lower.includes('team')) return 'Team';
  if (!subscriptionType.trim() || lower.includes('api')) return null;
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

/** Exponential 429 backoff: 60s, 120s, 240s, capped at 5 min. */
export function getRateLimitedTtlMs(count: number): number {
  return Math.min(RATE_LIMITED_BASE_MS * 2 ** Math.max(0, count - 1), RATE_LIMITED_MAX_MS);
}

/** True when ANTHROPIC_BASE_URL / ANTHROPIC_API_BASE_URL point off api.anthropic.com. */
export function isCustomEndpoint(env: NodeJS.ProcessEnv): boolean {
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim() || env.ANTHROPIC_API_BASE_URL?.trim();
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).origin !== ANTHROPIC_ORIGIN;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// File cache
// ---------------------------------------------------------------------------

/** UsageSnapshot as it lives in JSON (Dates serialize to ISO strings). */
type StoredSnapshot = Omit<UsageSnapshot, 'fiveHourResetsAt' | 'sevenDayResetsAt'> & {
  fiveHourResetsAt: string | null;
  sevenDayResetsAt: string | null;
};

interface CacheFile {
  data: StoredSnapshot;
  timestamp: number;
  /**
   * Credential-source identity: the resolved configDir that produced this
   * snapshot (null = the default ~/.claude flow). A mismatch with the
   * caller's configDir is a cache MISS — rebinding an account id to a
   * different Claude profile dir (or re-adding a removed id pointing at a
   * new dir) must never serve the previous subscription's numbers to
   * decide() or the reserve watchdog. Absent (legacy files) reads as null.
   */
  configDir?: string | null;
  rateLimitedCount?: number;
  /** ms epoch from a 429 Retry-After header; wins over exponential backoff. */
  retryAfterUntil?: number;
  /** Last successful snapshot, served during rate-limit backoff. */
  lastGoodData?: StoredSnapshot;
}

function serialize(snapshot: UsageSnapshot): StoredSnapshot {
  return {
    ...snapshot,
    fiveHourResetsAt: snapshot.fiveHourResetsAt?.toISOString() ?? null,
    sevenDayResetsAt: snapshot.sevenDayResetsAt?.toISOString() ?? null,
  };
}

function hydrate(stored: StoredSnapshot): UsageSnapshot {
  return {
    ...stored,
    fiveHourResetsAt: stored.fiveHourResetsAt ? new Date(stored.fiveHourResetsAt) : null,
    sevenDayResetsAt: stored.sevenDayResetsAt ? new Date(stored.sevenDayResetsAt) : null,
  };
}

function readCacheFile(cachePath: string): CacheFile | null {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const cache = parsed as CacheFile;
    if (typeof cache.timestamp !== 'number' || typeof cache.data !== 'object' || cache.data === null) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function writeCacheFile(cachePath: string, cache: CacheFile): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
  } catch {
    // Cache is best-effort; never let it break a usage read.
  }
}

/** Rate-limit backoff deadline for a cached 429 failure, or null. */
function getRateLimitedRetryUntil(cache: CacheFile): number | null {
  if (!(cache.data.error === 'rate-limited' && cache.data.unavailable)) return null;
  if (cache.retryAfterUntil && cache.retryAfterUntil > cache.timestamp) {
    // Clamp: a hostile/buggy Retry-After header must not pin the cache past
    // the exponential backoff's own 5-min cap.
    return Math.min(cache.retryAfterUntil, cache.timestamp + RATE_LIMITED_MAX_MS);
  }
  return cache.timestamp + getRateLimitedTtlMs(cache.rateLimitedCount ?? 1);
}

/** True when lastGoodData is recent enough to present as live numbers. */
function isFreshEnough(stored: StoredSnapshot, now: number): boolean {
  return typeof stored.fetchedAt === 'number' && now - stored.fetchedAt < LAST_GOOD_MAX_AGE_MS;
}

/** Snapshot to serve without refetching, or null when a refetch is due. */
function serveFromCache(cache: CacheFile, now: number, maxAgeMs?: number): UsageSnapshot | null {
  const retryUntil = getRateLimitedRetryUntil(cache);
  if (retryUntil !== null) {
    // 429 backoff is non-negotiable — maxAgeMs cannot force through it.
    if (now >= retryUntil) return null; // backoff elapsed -> refetch
    if (cache.lastGoodData && isFreshEnough(cache.lastGoodData, now)) {
      return { ...hydrate(cache.lastGoodData), error: 'rate-limited', unavailable: false };
    }
    // No good data — or it aged out: report unavailable so decide() stops
    // rather than burning on frozen numbers.
    return hydrate(cache.data);
  }
  let ttl = cache.data.unavailable ? CACHE_FAILURE_TTL_MS : CACHE_TTL_MS;
  if (maxAgeMs !== undefined) {
    ttl = Math.min(ttl, Math.max(MIN_MAX_AGE_MS, maxAgeMs));
  }
  return now - cache.timestamp < ttl ? hydrate(cache.data) : null;
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

interface UsageApiBody {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
}

type FetchOutcome =
  | { ok: true; body: UsageApiBody }
  | { ok: false; error: string; retryAfterSec?: number };

async function fetchUsageApi(
  fetchImpl: typeof fetch,
  accessToken: string,
  now: number,
): Promise<FetchOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return {
      ok: false,
      error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      error: 'rate-limited',
      retryAfterSec: parseRetryAfterSeconds(res.headers.get('retry-after'), now),
    };
  }
  if (!res.ok) {
    return { ok: false, error: `http-${res.status}` };
  }
  try {
    const body = (await res.json()) as UsageApiBody;
    if (typeof body !== 'object' || body === null) return { ok: false, error: 'parse' };
    return { ok: true, body };
  } catch {
    return { ok: false, error: 'parse' };
  }
}

// ---------------------------------------------------------------------------
// getUsage
// ---------------------------------------------------------------------------

export async function getUsage(overrides: GetUsageOverrides = {}): Promise<UsageSnapshot | null> {
  const env = overrides.env ?? process.env;
  if (isCustomEndpoint(env)) return null;

  const now = overrides.now ? overrides.now() : Date.now();
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const cacheDir = overrides.cacheDir ?? path.join(os.homedir(), SURPLUS_DIR_NAME);
  const cachePath = path.join(cacheDir, usageCacheFile(overrides.accountKey));
  const sourceDir = overrides.configDir ?? null;

  // Cache identity is (accountKey, configDir), not the key alone: a snapshot
  // produced by a different credential source is discarded outright —
  // including its lastGoodData and 429 backoff state, which belong to the
  // other subscription.
  let cache = readCacheFile(cachePath);
  if (cache && (cache.configDir ?? null) !== sourceDir) cache = null;
  if (cache) {
    const served = serveFromCache(cache, now, overrides.maxAgeMs);
    if (served) return served;
  }

  const readCreds =
    overrides.readCredentialsImpl ??
    ((nowMs: number, configDir?: string | null) => readCredentials(nowMs, { configDir }));
  const credentials = readCreds(now, overrides.configDir ?? null);
  if (!credentials) return null;

  const planName = getPlanName(credentials.subscriptionType);
  if (!planName) return null; // API-key user: no subscription windows

  const result = await fetchUsageApi(fetchImpl, credentials.accessToken, now);

  if (result.ok) {
    const snapshot: UsageSnapshot = {
      provider: 'claude',
      planName,
      fiveHourPct: parseUtilization(result.body.five_hour?.utilization),
      sevenDayPct: parseUtilization(result.body.seven_day?.utilization),
      fiveHourResetsAt: parseDate(result.body.five_hour?.resets_at),
      sevenDayResetsAt: parseDate(result.body.seven_day?.resets_at),
      unavailable: false,
      fetchedAt: now,
    };
    const stored = serialize(snapshot);
    writeCacheFile(cachePath, { data: stored, timestamp: now, configDir: sourceDir, lastGoodData: stored });
    return snapshot;
  }

  const failure: UsageSnapshot = {
    provider: 'claude',
    planName,
    fiveHourPct: null,
    sevenDayPct: null,
    fiveHourResetsAt: null,
    sevenDayResetsAt: null,
    unavailable: true,
    error: result.error,
    fetchedAt: now,
  };

  if (result.error === 'rate-limited') {
    const rateLimitedCount = (cache?.rateLimitedCount ?? 0) + 1;
    const retryAfterUntil =
      result.retryAfterSec !== undefined ? now + result.retryAfterSec * 1000 : undefined;
    const lastGood = cache?.lastGoodData;
    writeCacheFile(cachePath, {
      data: serialize(failure),
      timestamp: now,
      configDir: sourceDir,
      rateLimitedCount,
      ...(retryAfterUntil !== undefined ? { retryAfterUntil } : {}),
      ...(lastGood ? { lastGoodData: lastGood } : {}),
    });
    if (lastGood && isFreshEnough(lastGood, now)) {
      return { ...hydrate(lastGood), error: 'rate-limited', unavailable: false };
    }
    return failure;
  }

  // Other failures: 15s TTL; keep lastGoodData around for future 429s.
  writeCacheFile(cachePath, {
    data: serialize(failure),
    timestamp: now,
    configDir: sourceDir,
    ...(cache?.lastGoodData ? { lastGoodData: cache.lastGoodData } : {}),
  });
  return failure;
}
