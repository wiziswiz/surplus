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
 *  - File cache at ~/.surplus/.usage-cache.json: 5 min TTL on success, 15 s on
 *    failure. On 429, serves lastGoodData (error 'rate-limited',
 *    unavailable=false) while honoring Retry-After / exponential backoff
 *    (60s/120s/240s, capped 5 min) before refetching.
 *
 * SECURITY: the access token is only ever placed in the Authorization header.
 * It is never logged, cached, or embedded in errors.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SURPLUS_DIR_NAME, USAGE_CACHE_FILE } from './types.js';
import type { OAuthCredentials, UsageSnapshot } from './types.js';
import { readCredentials } from './credentials.js';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
const USER_AGENT = 'claude-code/2.1';
const FETCH_TIMEOUT_MS = 15_000;

const CACHE_TTL_MS = 5 * 60_000; // success
const CACHE_FAILURE_TTL_MS = 15_000; // failure
const RATE_LIMITED_BASE_MS = 60_000; // 429 backoff base
const RATE_LIMITED_MAX_MS = 5 * 60_000; // 429 backoff cap

/** Test seams. Production callers pass nothing. */
export interface GetUsageOverrides {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Directory holding .usage-cache.json; default ~/.surplus. */
  cacheDir?: string;
  /** Credential source; default readCredentials() (keychain + file). */
  readCredentialsImpl?: (now: number) => OAuthCredentials | null;
  env?: NodeJS.ProcessEnv;
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
  if (cache.retryAfterUntil && cache.retryAfterUntil > cache.timestamp) return cache.retryAfterUntil;
  return cache.timestamp + getRateLimitedTtlMs(cache.rateLimitedCount ?? 1);
}

/** Snapshot to serve without refetching, or null when a refetch is due. */
function serveFromCache(cache: CacheFile, now: number): UsageSnapshot | null {
  const retryUntil = getRateLimitedRetryUntil(cache);
  if (retryUntil !== null) {
    if (now >= retryUntil) return null; // backoff elapsed -> refetch
    if (cache.lastGoodData) {
      return { ...hydrate(cache.lastGoodData), error: 'rate-limited', unavailable: false };
    }
    return hydrate(cache.data); // no good data to fall back on
  }
  const ttl = cache.data.unavailable ? CACHE_FAILURE_TTL_MS : CACHE_TTL_MS;
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
  const cachePath = path.join(cacheDir, USAGE_CACHE_FILE);

  const cache = readCacheFile(cachePath);
  if (cache) {
    const served = serveFromCache(cache, now);
    if (served) return served;
  }

  const readCreds = overrides.readCredentialsImpl ?? readCredentials;
  const credentials = readCreds(now);
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
    writeCacheFile(cachePath, { data: stored, timestamp: now, lastGoodData: stored });
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
      rateLimitedCount,
      ...(retryAfterUntil !== undefined ? { retryAfterUntil } : {}),
      ...(lastGood ? { lastGoodData: lastGood } : {}),
    });
    if (lastGood) {
      return { ...hydrate(lastGood), error: 'rate-limited', unavailable: false };
    }
    return failure;
  }

  // Other failures: 15s TTL; keep lastGoodData around for future 429s.
  writeCacheFile(cachePath, {
    data: serialize(failure),
    timestamp: now,
    ...(cache?.lastGoodData ? { lastGoodData: cache.lastGoodData } : {}),
  });
  return failure;
}
