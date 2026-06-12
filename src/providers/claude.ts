/**
 * providers/claude.ts — AccountAdapters for Claude Pro/Max via Claude Code.
 *
 * One adapter per configured account (config.providers.claude.accounts,
 * enumerated through config.ts resolveAccounts). Thin wrappers: usage from
 * usage.ts (OAuth endpoint, per-account credentials + cache), execution from
 * runner.ts (worktree + one-shot /goal session with CLAUDE_CONFIG_DIR set for
 * non-default accounts). NEVER stores or logs token material.
 */

import type {
  AccountAdapter,
  RunnerResult,
  RunTaskArgs,
  SurplusConfig,
  UsageSnapshot,
} from '../types.js';
import { resolveAccounts } from '../config.js';
import { getUsage } from '../usage.js';
import { runTask } from '../runner.js';

interface ClaudeAccountShape {
  key: string;
  label: string;
  priority: number | null;
  configDir: string | null;
}

function accountAdapter(account: ClaudeAccountShape): AccountAdapter {
  return {
    key: account.key,
    provider: 'claude',
    label: account.label,
    priority: account.priority,
    configDir: account.configDir,
    getUsage: async (opts?: { fresh?: boolean }): Promise<UsageSnapshot | null> =>
      getUsage({
        ...(opts?.fresh ? { maxAgeMs: 0 } : {}),
        configDir: account.configDir,
        accountKey: account.key,
      }),
    runTask: (args: RunTaskArgs): Promise<RunnerResult> =>
      runTask({ ...args, configDir: account.configDir, accountKey: account.key }),
  };
}

/**
 * One AccountAdapter per resolved claude account (empty when the claude
 * provider is disabled). The main account keeps key 'claude' (back-compat).
 */
export function claudeAccountAdapters(config: SurplusConfig): AccountAdapter[] {
  return resolveAccounts(config)
    .filter((account) => account.provider === 'claude')
    .map(accountAdapter);
}

/** @deprecated Adapter for the main/default account only — use claudeAccountAdapters. */
export function claudeAdapter(config: SurplusConfig): AccountAdapter {
  void config; // kept config-shaped for call-site compatibility
  return accountAdapter({ key: 'claude', label: 'personal', priority: null, configDir: null });
}
