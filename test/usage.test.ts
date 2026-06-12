import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getPlanName,
  getRateLimitedTtlMs,
  getUsage,
  isCustomEndpoint,
  parseDate,
  parseRetryAfterSeconds,
  parseUtilization,
  usageCacheFile,
} from '../src/usage.js';
import {
  getKeychainServiceName,
  getKeychainServiceNames,
  parseCredentialsData,
  readCredentials,
} from '../src/credentials.js';
import type { OAuthCredentials, UsageSnapshot } from '../src/types.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseUtilization', () => {
  it('passes through values in range, rounded', () => {
    expect(parseUtilization(0)).toBe(0);
    expect(parseUtilization(42)).toBe(42);
    expect(parseUtilization(42.4)).toBe(42);
    expect(parseUtilization(42.6)).toBe(43);
    expect(parseUtilization(100)).toBe(100);
  });

  it('clamps out-of-range values to 0-100', () => {
    expect(parseUtilization(150)).toBe(100);
    expect(parseUtilization(-5)).toBe(0);
  });

  it('returns null for missing or non-finite values', () => {
    expect(parseUtilization(undefined)).toBeNull();
    expect(parseUtilization(null)).toBeNull();
    expect(parseUtilization(Number.NaN)).toBeNull();
    expect(parseUtilization(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('parseDate', () => {
  it('parses valid ISO strings', () => {
    const d = parseDate('2026-06-09T12:00:00.000Z');
    expect(d).toBeInstanceOf(Date);
    expect(d?.getTime()).toBe(Date.parse('2026-06-09T12:00:00.000Z'));
  });

  it('returns null for invalid or missing strings', () => {
    expect(parseDate('not-a-date')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});

describe('parseRetryAfterSeconds', () => {
  const now = Date.parse('2026-06-09T12:00:00.000Z');

  it('parses delta-seconds', () => {
    expect(parseRetryAfterSeconds('90', now)).toBe(90);
  });

  it('parses HTTP-dates relative to now', () => {
    const future = new Date(now + 120_000).toUTCString();
    expect(parseRetryAfterSeconds(future, now)).toBe(120);
  });

  it('returns undefined for past dates, garbage, and missing header', () => {
    const past = new Date(now - 60_000).toUTCString();
    expect(parseRetryAfterSeconds(past, now)).toBeUndefined();
    expect(parseRetryAfterSeconds('garbage', now)).toBeUndefined();
    expect(parseRetryAfterSeconds(null, now)).toBeUndefined();
    expect(parseRetryAfterSeconds('0', now)).toBeUndefined();
    expect(parseRetryAfterSeconds('-5', now)).toBeUndefined();
  });
});

describe('getPlanName', () => {
  it('maps known subscription types', () => {
    expect(getPlanName('max')).toBe('Max');
    expect(getPlanName('max_20x')).toBe('Max');
    expect(getPlanName('pro')).toBe('Pro');
    expect(getPlanName('team')).toBe('Team');
  });

  it('returns null for api/empty subscription types', () => {
    expect(getPlanName('api')).toBeNull();
    expect(getPlanName('')).toBeNull();
    expect(getPlanName('   ')).toBeNull();
  });

  it('capitalizes unknown subscription types', () => {
    expect(getPlanName('enterprise')).toBe('Enterprise');
  });
});

describe('getRateLimitedTtlMs', () => {
  it('doubles 60s per attempt, capped at 5 minutes', () => {
    expect(getRateLimitedTtlMs(1)).toBe(60_000);
    expect(getRateLimitedTtlMs(2)).toBe(120_000);
    expect(getRateLimitedTtlMs(3)).toBe(240_000);
    expect(getRateLimitedTtlMs(4)).toBe(300_000);
    expect(getRateLimitedTtlMs(10)).toBe(300_000);
  });
});

describe('isCustomEndpoint', () => {
  it('is false when unset or pointing at api.anthropic.com', () => {
    expect(isCustomEndpoint({})).toBe(false);
    expect(isCustomEndpoint({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe(false);
    expect(isCustomEndpoint({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' })).toBe(false);
  });

  it('is true for other origins and unparseable URLs', () => {
    expect(isCustomEndpoint({ ANTHROPIC_BASE_URL: 'https://proxy.example.com' })).toBe(true);
    expect(isCustomEndpoint({ ANTHROPIC_API_BASE_URL: 'https://other.example.com' })).toBe(true);
    expect(isCustomEndpoint({ ANTHROPIC_BASE_URL: 'not a url' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-06-09T12:00:00.000Z');

function oauthJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claudeAiOauth: {
      accessToken: 'test-token-not-real',
      subscriptionType: 'max',
      expiresAt: NOW + 60 * 60_000,
      ...overrides,
    },
  };
}

describe('parseCredentialsData', () => {
  it('returns credentials for a valid unexpired token', () => {
    expect(parseCredentialsData(oauthJson(), NOW)).toEqual({
      accessToken: 'test-token-not-real',
      subscriptionType: 'max',
    });
  });

  it('returns null when the token is expired (expiresAt <= now)', () => {
    expect(parseCredentialsData(oauthJson({ expiresAt: NOW - 1 }), NOW)).toBeNull();
    expect(parseCredentialsData(oauthJson({ expiresAt: NOW }), NOW)).toBeNull();
  });

  it('treats a missing expiresAt as unexpired', () => {
    expect(parseCredentialsData(oauthJson({ expiresAt: undefined }), NOW)).not.toBeNull();
  });

  it('returns null for missing token or malformed shapes', () => {
    expect(parseCredentialsData(oauthJson({ accessToken: undefined }), NOW)).toBeNull();
    expect(parseCredentialsData(oauthJson({ accessToken: '' }), NOW)).toBeNull();
    expect(parseCredentialsData({}, NOW)).toBeNull();
    expect(parseCredentialsData(null, NOW)).toBeNull();
    expect(parseCredentialsData('nope', NOW)).toBeNull();
  });

  it('defaults subscriptionType to empty string', () => {
    const creds = parseCredentialsData(oauthJson({ subscriptionType: undefined }), NOW);
    expect(creds?.subscriptionType).toBe('');
  });
});

describe('getKeychainServiceNames', () => {
  const home = '/Users/someone';

  it('uses the default service name for ~/.claude', () => {
    expect(getKeychainServiceNames(path.join(home, '.claude'), home, {})).toEqual([
      'Claude Code-credentials',
    ]);
  });

  it('adds a hashed suffix for custom config dirs, plus the legacy fallback', () => {
    const names = getKeychainServiceNames('/custom/claude-config', home, {
      CLAUDE_CONFIG_DIR: '/custom/claude-config',
    });
    expect(names[0]).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(names).toContain('Claude Code-credentials');
  });
});

describe('getKeychainServiceName (per-account)', () => {
  const home = '/Users/someone';

  it('returns the plain service for the default dir and a stable 8-hex suffix otherwise', () => {
    expect(getKeychainServiceName(path.join(home, '.claude'), home)).toBe('Claude Code-credentials');
    const custom = getKeychainServiceName('/custom/claude-work', home);
    expect(custom).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    // Stable: normalization makes equivalent paths hash identically.
    expect(getKeychainServiceName('/custom//claude-work/', home)).toBe(custom);
  });
});

describe('readCredentials', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surplus-creds-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const throwMissing = (): string => {
    throw new Error('could not be found in the keychain');
  };

  it('reads from the keychain when available', () => {
    const creds = readCredentials(NOW, {
      homeDir,
      env: {},
      platform: 'darwin',
      username: 'someone',
      readKeychainItem: () => JSON.stringify(oauthJson()),
    });
    expect(creds).toEqual({ accessToken: 'test-token-not-real', subscriptionType: 'max' });
  });

  it('falls back to the credentials file when the keychain misses', () => {
    const claudeDir = path.join(homeDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify(oauthJson()));
    const creds = readCredentials(NOW, {
      homeDir,
      env: {},
      platform: 'darwin',
      username: 'someone',
      readKeychainItem: throwMissing,
    });
    expect(creds).toEqual({ accessToken: 'test-token-not-real', subscriptionType: 'max' });
  });

  it('skips the keychain entirely off macOS', () => {
    const readKeychainItem = vi.fn(throwMissing);
    const creds = readCredentials(NOW, {
      homeDir,
      env: {},
      platform: 'linux',
      readKeychainItem,
    });
    expect(creds).toBeNull();
    expect(readKeychainItem).not.toHaveBeenCalled();
  });

  it('returns null for an expired token in the credentials file', () => {
    const claudeDir = path.join(homeDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify(oauthJson({ expiresAt: NOW - 1000 })),
    );
    const creds = readCredentials(NOW, {
      homeDir,
      env: {},
      platform: 'darwin',
      username: 'someone',
      readKeychainItem: throwMissing,
    });
    expect(creds).toBeNull();
  });

  it('configDir override: file fallback reads <configDir>/.credentials.json, not ~/.claude', () => {
    // Seed DIFFERENT tokens in the default dir and the account dir.
    const claudeDir = path.join(homeDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify(oauthJson({ accessToken: 'main-token-not-real' })),
    );
    const workDir = path.join(homeDir, 'claude-work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.credentials.json'),
      JSON.stringify(oauthJson({ accessToken: 'work-token-not-real' })),
    );

    const creds = readCredentials(NOW, {
      homeDir,
      env: {},
      platform: 'darwin',
      username: 'someone',
      readKeychainItem: throwMissing,
      configDir: workDir,
    });
    expect(creds?.accessToken).toBe('work-token-not-real');

    // No configDir → the default dir's file wins as before.
    const main = readCredentials(NOW, {
      homeDir,
      env: {},
      platform: 'darwin',
      username: 'someone',
      readKeychainItem: throwMissing,
    });
    expect(main?.accessToken).toBe('main-token-not-real');
  });

  it('configDir override: keychain lookup tries ONLY the hashed per-dir service (no legacy fallback)', () => {
    const workDir = path.join(homeDir, 'claude-work');
    const servicesTried: string[] = [];
    const creds = readCredentials(NOW, {
      homeDir,
      env: { CLAUDE_CONFIG_DIR: '/somewhere/else' }, // must be ignored for explicit dirs
      platform: 'darwin',
      username: 'someone',
      configDir: workDir,
      readKeychainItem: (service) => {
        servicesTried.push(service);
        throw new Error('not found');
      },
    });
    expect(creds).toBeNull();
    const expected = getKeychainServiceName(workDir, homeDir);
    expect(expected).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    // Account-scoped + generic passes both query the SAME single service —
    // never the plain legacy service that would serve the main account.
    expect([...new Set(servicesTried)]).toEqual([expected]);
  });

  it('configDir override pointing at the default dir keeps the plain service name', () => {
    const servicesTried: string[] = [];
    readCredentials(NOW, {
      homeDir,
      env: {},
      platform: 'darwin',
      username: 'someone',
      configDir: path.join(homeDir, '.claude'),
      readKeychainItem: (service) => {
        servicesTried.push(service);
        throw new Error('not found');
      },
    });
    expect([...new Set(servicesTried)]).toEqual(['Claude Code-credentials']);
  });
});

// ---------------------------------------------------------------------------
// getUsage: cache TTL + 429 backoff (mock fetch, injected clock, temp cache dir)
// ---------------------------------------------------------------------------

const CREDS: OAuthCredentials = { accessToken: 'test-token-not-real', subscriptionType: 'max' };
const FIVE_RESET = '2026-06-09T14:00:00.000Z';
const SEVEN_RESET = '2026-06-12T00:00:00.000Z';

function okBody(fiveHour = 42, sevenDay = 17): Record<string, unknown> {
  return {
    five_hour: { utilization: fiveHour, resets_at: FIVE_RESET },
    seven_day: { utilization: sevenDay, resets_at: SEVEN_RESET },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

describe('getUsage', () => {
  let cacheDir: string;
  let clock: number;
  let fetchMock: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

  const callGetUsage = (extra: Record<string, unknown> = {}): Promise<UsageSnapshot | null> =>
    getUsage({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => clock,
      cacheDir,
      readCredentialsImpl: () => CREDS,
      env: {},
      ...extra,
    });

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surplus-usage-'));
    clock = NOW;
    fetchMock = vi.fn(async () => jsonResponse(okBody()));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns a parsed snapshot on success', async () => {
    const snap = await callGetUsage();
    expect(snap).not.toBeNull();
    expect(snap?.provider).toBe('claude');
    expect(snap?.planName).toBe('Max');
    expect(snap?.fiveHourPct).toBe(42);
    expect(snap?.sevenDayPct).toBe(17);
    expect(snap?.fiveHourResetsAt?.toISOString()).toBe(FIVE_RESET);
    expect(snap?.sevenDayResetsAt?.toISOString()).toBe(SEVEN_RESET);
    expect(snap?.unavailable).toBe(false);
    expect(snap?.fetchedAt).toBe(NOW);
  });

  it('sends the OAuth headers', async () => {
    await callGetUsage();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token-not-real');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['User-Agent']).toBe('claude-code/2.1');
  });

  it('clamps out-of-range utilization from the API', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(okBody(150, -5)));
    const snap = await callGetUsage();
    expect(snap?.fiveHourPct).toBe(100);
    expect(snap?.sevenDayPct).toBe(0);
  });

  it('returns null for custom endpoints without fetching', async () => {
    const snap = await callGetUsage({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } });
    expect(snap).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when credentials are missing', async () => {
    const snap = await callGetUsage({ readCredentialsImpl: () => null });
    expect(snap).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for API-key users (subscriptionType api)', async () => {
    const snap = await callGetUsage({
      readCredentialsImpl: () => ({ accessToken: 'test-token-not-real', subscriptionType: 'api' }),
    });
    expect(snap).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves the success cache for 5 minutes, then refetches', async () => {
    await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock = NOW + 4 * 60_000;
    const cached = await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cached?.fiveHourPct).toBe(42);
    expect(cached?.fetchedAt).toBe(NOW);
    expect(cached?.fiveHourResetsAt).toBeInstanceOf(Date);

    clock = NOW + 5 * 60_000 + 1;
    await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maxAgeMs narrows the success cache window, floored at 30s', async () => {
    await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 10s-old cache: maxAgeMs 0 is floored to 30s -> still served.
    clock = NOW + 10_000;
    const served = await callGetUsage({ maxAgeMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(served?.fetchedAt).toBe(NOW);

    // 31s-old cache: past the floor -> refetches even though 5min TTL remains.
    clock = NOW + 31_000;
    const fresh = await callGetUsage({ maxAgeMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fresh?.fetchedAt).toBe(NOW + 31_000);
  });

  it('maxAgeMs never overrides an active 429 backoff', async () => {
    await callGetUsage(); // seed lastGoodData
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 429 }));
    clock = NOW + 6 * 60_000;
    await callGetUsage(); // trips backoff (60s)
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Inside the backoff window a forced refresh must NOT hit the API again.
    clock = NOW + 6 * 60_000 + 31_000;
    await callGetUsage({ maxAgeMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches failures for 15 seconds with an http error tag', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 500 }));

    const snap = await callGetUsage();
    expect(snap?.unavailable).toBe(true);
    expect(snap?.error).toBe('http-500');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock = NOW + 10_000;
    const cached = await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cached?.unavailable).toBe(true);

    clock = NOW + 15_001;
    await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tags network errors and timeouts', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await callGetUsage())?.error).toBe('network');

    fs.rmSync(path.join(cacheDir, '.usage-cache.json'), { force: true });
    const timeoutError = new Error('timed out');
    timeoutError.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(timeoutError);
    expect((await callGetUsage())?.error).toBe('timeout');
  });

  it('on 429 serves lastGoodData with error rate-limited and unavailable=false', async () => {
    await callGetUsage(); // success -> lastGoodData stored
    clock = NOW + 6 * 60_000; // past success TTL
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429 }));

    const snap = await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(snap?.unavailable).toBe(false);
    expect(snap?.error).toBe('rate-limited');
    expect(snap?.fiveHourPct).toBe(42); // last good values
    expect(snap?.fiveHourResetsAt?.toISOString()).toBe(FIVE_RESET);
  });

  it('on 429 without lastGoodData returns unavailable=true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429 }));
    const snap = await callGetUsage();
    expect(snap?.unavailable).toBe(true);
    expect(snap?.error).toBe('rate-limited');
  });

  it('respects exponential backoff between 429 refetch attempts', async () => {
    await callGetUsage(); // 1: success
    const t429 = NOW + 6 * 60_000;
    clock = t429;
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429 }));
    await callGetUsage(); // 2: 429 -> count=1, backoff 60s

    clock = t429 + 30_000; // inside backoff window
    const held = await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(held?.error).toBe('rate-limited');
    expect(held?.unavailable).toBe(false);
    expect(held?.fiveHourPct).toBe(42);

    clock = t429 + 60_001; // backoff elapsed
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429 }));
    await callGetUsage(); // 3: 429 -> count=2, backoff 120s

    clock = t429 + 60_001 + 119_000; // inside 120s window
    await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    clock = t429 + 60_001 + 120_001; // 120s elapsed -> refetch (success clears state)
    await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const recovered = await callGetUsage();
    expect(recovered?.unavailable).toBe(false);
    expect(recovered?.error).toBeUndefined();
  });

  it('honors a Retry-After header over the exponential default', async () => {
    await callGetUsage(); // success
    const t429 = NOW + 6 * 60_000;
    clock = t429;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({}, { status: 429, headers: { 'retry-after': '90' } }),
    );
    await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clock = t429 + 61_000; // past 60s exponential default, inside Retry-After
    await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clock = t429 + 90_001;
    await callGetUsage();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('tags unparseable success bodies as parse errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const snap = await callGetUsage();
    expect(snap?.unavailable).toBe(true);
    expect(snap?.error).toBe('parse');
  });

  it('creates the cache directory lazily', async () => {
    const nested = path.join(cacheDir, 'does', 'not', 'exist');
    const snap = await getUsage({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => clock,
      cacheDir: nested,
      readCredentialsImpl: () => CREDS,
      env: {},
    });
    expect(snap?.fiveHourPct).toBe(42);
    expect(fs.existsSync(path.join(nested, '.usage-cache.json'))).toBe(true);
  });

  it('never writes the access token into the cache file', async () => {
    await callGetUsage();
    const raw = fs.readFileSync(path.join(cacheDir, '.usage-cache.json'), 'utf8');
    expect(raw).not.toContain('test-token-not-real');
  });

  it('forwards the account configDir to the credential reader', async () => {
    const dirsSeen: Array<string | null | undefined> = [];
    await callGetUsage({
      accountKey: 'claude:work',
      configDir: '/opt/claude-work',
      readCredentialsImpl: (_now: number, configDir?: string | null) => {
        dirsSeen.push(configDir);
        return CREDS;
      },
    });
    expect(dirsSeen).toEqual(['/opt/claude-work']);
  });

  it('isolates the cache per accountKey — accounts never serve each other numbers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(okBody(11, 11)));
    const main = await callGetUsage(); // accountKey absent = main
    expect(main?.fiveHourPct).toBe(11);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same cacheDir, fresh main cache — a different account must NOT be
    // served from it: it fetches its own numbers into its own file.
    fetchMock.mockResolvedValueOnce(jsonResponse(okBody(77, 88)));
    const work = await callGetUsage({ accountKey: 'claude:work' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(work?.fiveHourPct).toBe(77);
    expect(fs.existsSync(path.join(cacheDir, '.usage-cache.json'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, '.usage-cache-claude-work.json'))).toBe(true);

    // Each account is now served from its OWN cache without refetching.
    expect((await callGetUsage())?.fiveHourPct).toBe(11);
    expect((await callGetUsage({ accountKey: 'claude:work' }))?.fiveHourPct).toBe(77);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accountKey 'claude' (main) keeps the legacy cache file (back-compat)", async () => {
    await callGetUsage({ accountKey: 'claude' });
    expect(fs.existsSync(path.join(cacheDir, '.usage-cache.json'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, '.usage-cache-claude.json'))).toBe(false);
  });

  it('cache identity includes the configDir — rebinding an account to a new profile dir is a MISS', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(okBody(11, 11)));
    const before = await callGetUsage({ accountKey: 'claude:work', configDir: '/opt/profile-a' });
    expect(before?.fiveHourPct).toBe(11);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same account key, fresh cache, DIFFERENT credential source: the old
    // subscription's snapshot must not be served to decide()/the watchdog.
    fetchMock.mockResolvedValueOnce(jsonResponse(okBody(93, 94)));
    const after = await callGetUsage({ accountKey: 'claude:work', configDir: '/opt/profile-b' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(after?.fiveHourPct).toBe(93);

    // Same key + same dir again: served from cache, no refetch.
    const cached = await callGetUsage({ accountKey: 'claude:work', configDir: '/opt/profile-b' });
    expect(cached?.fiveHourPct).toBe(93);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rebinding also discards lastGoodData/429 backoff from the previous credential source', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(okBody(11, 11)));
    await callGetUsage({ accountKey: 'claude:work', configDir: '/opt/profile-a' });
    clock = NOW + 6 * 60_000; // success TTL elapsed
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429 }));
    const limited = await callGetUsage({ accountKey: 'claude:work', configDir: '/opt/profile-a' });
    expect(limited?.error).toBe('rate-limited');
    expect(limited?.fiveHourPct).toBe(11); // profile-a's lastGoodData

    // Rebind to profile-b inside profile-a's backoff window: profile-a's
    // backoff and lastGoodData must not gate or feed the new subscription.
    fetchMock.mockResolvedValueOnce(jsonResponse(okBody(55, 56)));
    const rebound = await callGetUsage({ accountKey: 'claude:work', configDir: '/opt/profile-b' });
    expect(rebound?.unavailable).toBe(false);
    expect(rebound?.error).toBeUndefined();
    expect(rebound?.fiveHourPct).toBe(55);
  });

  it('legacy main cache files without a configDir field stay valid (read as null)', async () => {
    await callGetUsage(); // writes the main cache
    const cachePath = path.join(cacheDir, '.usage-cache.json');
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
    expect(raw.configDir).toBeNull();
    delete raw.configDir; // simulate a pre-feature cache file
    fs.writeFileSync(cachePath, JSON.stringify(raw));
    const served = await callGetUsage();
    expect(served?.fiveHourPct).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still a cache HIT
  });
});

describe('usageCacheFile', () => {
  it('maps main/absent to the legacy file and other keys to sanitized per-account files', () => {
    expect(usageCacheFile()).toBe('.usage-cache.json');
    expect(usageCacheFile('claude')).toBe('.usage-cache.json');
    expect(usageCacheFile('claude:work')).toBe('.usage-cache-claude-work.json');
    expect(usageCacheFile('codex')).toBe('.usage-cache-codex.json');
    expect(usageCacheFile('Claude:Work!!')).toBe('.usage-cache-claude-work.json');
  });
});
