/**
 * Claude Code OAuth credential discovery.
 *
 * Tries the macOS Keychain first (Claude Code 2.x stores credentials there),
 * then falls back to <claude-config-dir>/.credentials.json (older versions /
 * non-macOS). Both sources hold JSON of the shape:
 *
 *   { claudeAiOauth: { accessToken, subscriptionType, expiresAt (ms epoch) } }
 *
 * SECURITY: never log, throw, or otherwise surface token material. All errors
 * are swallowed and collapse to `null`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OAuthCredentials } from './types.js';

const KEYCHAIN_SERVICE_NAME = 'Claude Code-credentials';
const KEYCHAIN_TIMEOUT_MS = 3_000;

/** Test seams + the per-account configDir selector. Production callers pass nothing or {configDir}. */
export interface CredentialOverrides {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Raw keychain item lookup; must throw when the item is missing. */
  readKeychainItem?: (service: string, account?: string) => string;
  /** Account name to try first; null disables the account-scoped pass. */
  username?: string | null;
  /**
   * Explicit Claude Code profile dir for a specific account. When set
   * (non-null), credentials are read ONLY from this dir's sources: the
   * keychain service derived from it (hashed for custom dirs — no legacy
   * fallback, so accounts never bleed into each other) and
   * <configDir>/.credentials.json. null/undefined = the default flow
   * ($CLAUDE_CONFIG_DIR / ~/.claude with legacy fallbacks).
   */
  configDir?: string | null;
}

/** Claude Code config dir: $CLAUDE_CONFIG_DIR or ~/.claude. */
export function getClaudeConfigDir(homeDir: string, env: NodeJS.ProcessEnv): string {
  const envDir = env.CLAUDE_CONFIG_DIR?.trim();
  return envDir ? envDir : path.join(homeDir, '.claude');
}

/**
 * The single keychain service name for a config dir: the default service for
 * ~/.claude, `<service>-<sha256(normalized absolute dir)[:8]>` for custom
 * dirs (matches Claude Code's own derivation).
 */
export function getKeychainServiceName(configDir: string, homeDir: string): string {
  const normalizedConfigDir = path.normalize(path.resolve(configDir));
  const normalizedDefaultDir = path.normalize(path.resolve(path.join(homeDir, '.claude')));
  if (normalizedConfigDir === normalizedDefaultDir) return KEYCHAIN_SERVICE_NAME;
  const hash = createHash('sha256').update(normalizedConfigDir).digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE_NAME}-${hash}`;
}

/**
 * Keychain service names to try, in order. Claude Code uses the default
 * service for ~/.claude and `<service>-<sha256(configDir)[:8]>` for custom
 * CLAUDE_CONFIG_DIR locations.
 */
export function getKeychainServiceNames(
  configDir: string,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const defaultDir = path.normalize(path.resolve(path.join(homeDir, '.claude')));
  const names: string[] = [getKeychainServiceName(configDir, homeDir)];

  const envConfigDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (envConfigDir) {
    const normalizedEnvDir = path.normalize(path.resolve(envConfigDir));
    if (normalizedEnvDir === defaultDir) {
      names.push(KEYCHAIN_SERVICE_NAME);
    } else {
      const envHash = createHash('sha256').update(envConfigDir).digest('hex').slice(0, 8);
      names.push(`${KEYCHAIN_SERVICE_NAME}-${envHash}`);
    }
  }

  names.push(KEYCHAIN_SERVICE_NAME);
  return [...new Set(names)];
}

/**
 * Validate and extract credentials from parsed keychain/file JSON.
 * expiresAt is a ms-epoch timestamp; expiresAt <= now means expired -> null.
 */
export function parseCredentialsData(data: unknown, now: number): OAuthCredentials | null {
  if (typeof data !== 'object' || data === null) return null;
  const oauth = (data as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (typeof oauth !== 'object' || oauth === null) return null;
  const { accessToken, subscriptionType, expiresAt } = oauth as {
    accessToken?: unknown;
    subscriptionType?: unknown;
    expiresAt?: unknown;
  };
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  if (typeof expiresAt === 'number' && expiresAt <= now) return null;
  return {
    accessToken,
    subscriptionType: typeof subscriptionType === 'string' ? subscriptionType : '',
  };
}

function defaultReadKeychainItem(service: string, account?: string): string {
  // execFileSync with an absolute path: no shell, no PATH hijacking.
  return execFileSync(
    '/usr/bin/security',
    account
      ? ['find-generic-password', '-s', service, '-a', account, '-w']
      : ['find-generic-password', '-s', service, '-w'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: KEYCHAIN_TIMEOUT_MS },
  );
}

function defaultUsername(): string | null {
  try {
    const name = os.userInfo().username.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

function readKeychainCredentials(now: number, overrides: CredentialOverrides): OAuthCredentials | null {
  const platform = overrides.platform ?? process.platform;
  if (platform !== 'darwin') return null;

  const homeDir = overrides.homeDir ?? os.homedir();
  const env = overrides.env ?? process.env;
  const readItem = overrides.readKeychainItem ?? defaultReadKeychainItem;
  const username = overrides.username !== undefined ? overrides.username : defaultUsername();

  // An explicit per-account configDir pins the lookup to that dir's derived
  // service ONLY — no legacy fallback, or a custom account with a locked/empty
  // keychain item would silently serve the main account's credentials.
  const serviceNames = overrides.configDir
    ? [getKeychainServiceName(overrides.configDir, homeDir)]
    : getKeychainServiceNames(getClaudeConfigDir(homeDir, env), homeDir, env);

  // Pass 1: account-scoped lookups; pass 2: generic fallback without -a.
  const accountVariants: Array<string | undefined> = username ? [username, undefined] : [undefined];
  for (const account of accountVariants) {
    for (const service of serviceNames) {
      try {
        const raw = readItem(service, account).trim();
        if (!raw) continue;
        const credentials = parseCredentialsData(JSON.parse(raw), now);
        if (credentials) return credentials;
      } catch {
        // Missing item, keychain locked, timeout, bad JSON — try the next variant.
        // Never inspect/log the error: stderr/stdout may carry secret material.
      }
    }
  }
  return null;
}

function readFileCredentials(now: number, overrides: CredentialOverrides): OAuthCredentials | null {
  const homeDir = overrides.homeDir ?? os.homedir();
  const env = overrides.env ?? process.env;
  const configDir = overrides.configDir ?? getClaudeConfigDir(homeDir, env);
  const credentialsPath = path.join(configDir, '.credentials.json');
  try {
    if (!fs.existsSync(credentialsPath)) return null;
    const content = fs.readFileSync(credentialsPath, 'utf8');
    return parseCredentialsData(JSON.parse(content), now);
  } catch {
    return null;
  }
}

/**
 * Read Claude Code OAuth credentials: Keychain first, then the credentials
 * file. Pass overrides.configDir for a specific account's profile dir
 * (hashed keychain service + <configDir>/.credentials.json fallback).
 * Returns null when nothing valid/unexpired is found.
 */
export function readCredentials(now: number, overrides: CredentialOverrides = {}): OAuthCredentials | null {
  return readKeychainCredentials(now, overrides) ?? readFileCredentials(now, overrides);
}
