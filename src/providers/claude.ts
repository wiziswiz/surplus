/**
 * providers/claude.ts — ProviderAdapter for Claude Pro/Max via Claude Code.
 *
 * Thin wrapper: usage from usage.ts (OAuth endpoint), execution from
 * runner.ts (worktree + one-shot /goal session).
 */

import type {
  ProviderAdapter,
  RunnerResult,
  RunTaskArgs,
  SurplusConfig,
  UsageSnapshot,
} from '../types.js';
import { getUsage } from '../usage.js';
import { runTask } from '../runner.js';

export function claudeAdapter(config: SurplusConfig): ProviderAdapter {
  void config; // adapter is config-shaped for symmetry with codex; runner gets config via RunTaskArgs
  return {
    provider: 'claude',
    getUsage: async (): Promise<UsageSnapshot | null> => getUsage(),
    runTask: (args: RunTaskArgs): Promise<RunnerResult> => runTask(args),
  };
}
