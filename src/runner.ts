/**
 * runner.ts — claude execution engine (worktree + one-shot `/goal` session)
 * plus reusable git-worktree helpers (the codex provider imports these).
 *
 * Contract (types.ts module map):
 *   prepareWorktree(), finalizeWorktree(), runTask()
 *
 * IMPORTANT CONVENTION: runTask returns outcome 'failed' for a clean
 * completed run — meaning "completed, pending judge". The dispatcher
 * overwrites it with 'passed'/'failed' after judging.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import type { RunOutcome, RunnerResult, RunTaskArgs, TaskRow } from './types.js';
import { buildGoalCondition, redactSecrets } from './vision.js';

const QUOTA_RE = /rate.?limit|quota|overloaded|401|authentication|expired/i;
const HEARTBEAT_MS = 3 * 60_000;
const KILL_GRACE_MS = 30_000;
const STDOUT_KEEP = 4 * 1024 * 1024; // tail kept in memory for JSON parsing
const STDERR_KEEP = 16 * 1024;
const RECENT_KEEP = 4 * 1024; // tail used for heartbeat snippets

// ---------------------------------------------------------------------------
// JSON envelope parsing (shared with judge.ts)
// ---------------------------------------------------------------------------

/**
 * Extract the first balanced top-level `{...}` object from text, honoring
 * string literals/escapes. Returns null when none is found.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface ClaudeJsonEnvelope {
  /** `result` field of `claude -p --output-format json`; null when unparseable. */
  result: string | null;
  /** `is_error` field; null when unparseable. */
  isError: boolean | null;
}

/**
 * Parse the single JSON object `claude -p --output-format json` prints.
 * Tolerates hook noise before/after the JSON. Never throws.
 */
export function parseClaudeEnvelope(stdout: string): ClaudeJsonEnvelope {
  const trimmed = stdout.trim();
  const candidates: string[] = [trimmed];
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('{')) candidates.push(t);
  }
  const balanced = extractFirstJsonObject(trimmed);
  if (balanced !== null) candidates.push(balanced);

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed === null || typeof parsed !== 'object') continue;
      const obj = parsed as Record<string, unknown>;
      const result = typeof obj['result'] === 'string' ? (obj['result'] as string) : null;
      const isError = typeof obj['is_error'] === 'boolean' ? (obj['is_error'] as boolean) : null;
      if (result !== null || isError !== null || obj['type'] === 'result') {
        return { result, isError };
      }
    } catch {
      /* try next candidate */
    }
  }
  return { result: null, isError: null };
}

function tail(text: string, n: number): string {
  return text.length > n ? text.slice(-n) : text;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Worktree helpers (reused by providers/codex.ts)
// ---------------------------------------------------------------------------

function git(repoPath: string, args: string[], maxBuffer = 8 * 1024 * 1024): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer,
  });
}

function branchExists(projectPath: string, branch: string): boolean {
  try {
    git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create (or resume) the task's worktree at <worktreesDir>/<task.id> on
 * branch surplus/<task.id>. Cleans up stale worktrees defensively.
 */
export function prepareWorktree(args: {
  task: TaskRow;
  projectPath: string;
  worktreesDir: string;
}): { worktreePath: string; branch: string } {
  const { task, projectPath, worktreesDir } = args;
  const branch = `surplus/${task.id}`;
  const worktreePath = path.join(worktreesDir, task.id);

  mkdirSync(worktreesDir, { recursive: true });

  // Defensive cleanup of a stale worktree dir from a previous crashed run.
  if (existsSync(worktreePath)) {
    try {
      git(projectPath, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  try {
    git(projectPath, ['worktree', 'prune']);
  } catch {
    /* ignore */
  }

  if (branchExists(projectPath, branch)) {
    // Retry attempt: resume the existing branch.
    git(projectPath, ['worktree', 'add', worktreePath, branch]);
  } else {
    // Fresh attempt: new branch from HEAD.
    git(projectPath, ['worktree', 'add', '-b', branch, worktreePath]);
  }

  return { worktreePath, branch };
}

/**
 * Best-effort checkpoint commit of any uncommitted work, then remove the
 * worktree KEEPING the branch. Never throws.
 */
export function finalizeWorktree(args: {
  worktreePath: string;
  projectPath: string;
  taskId: string;
}): void {
  const { worktreePath, projectPath, taskId } = args;
  try {
    if (existsSync(worktreePath)) {
      const message = `surplus: checkpoint ${taskId}`;
      try {
        git(worktreePath, ['add', '-A']);
        try {
          git(worktreePath, ['commit', '-m', message]);
        } catch {
          // Missing identity? Retry with a local fallback; ignore empty commits.
          git(worktreePath, [
            '-c',
            'user.name=surplus',
            '-c',
            'user.email=surplus@localhost',
            'commit',
            '-m',
            message,
          ]);
        }
      } catch {
        /* nothing to commit, or commit impossible — fine */
      }
    }

    try {
      git(projectPath, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        git(projectPath, ['worktree', 'prune']);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* never throw */
  }
}

// ---------------------------------------------------------------------------
// runTask — claude implementation
// ---------------------------------------------------------------------------

/**
 * Run one `/goal` work session for a task inside its worktree.
 * Outcome 'failed' means completed-pending-judge (see file header).
 */
export async function runTask(args: RunTaskArgs): Promise<RunnerResult> {
  const { task, project, vision, model, effort, config, logsDir, worktreesDir } = args;
  const startedAt = Date.now();

  mkdirSync(logsDir, { recursive: true });
  const attempt = (task.attempts ?? 0) + 1;
  const logPath = path.join(logsDir, `${task.id}-attempt${attempt}.log`);

  let worktreePath: string;
  let branch: string;
  try {
    const prepared = prepareWorktree({ task, projectPath: project.path, worktreesDir });
    worktreePath = prepared.worktreePath;
    branch = prepared.branch;
  } catch (err) {
    return {
      outcome: 'error',
      exitCode: null,
      branch: null,
      summary: `worktree setup failed: ${redactSecrets(errMessage(err))}`,
      logPath,
      startedAt,
      endedAt: Date.now(),
    };
  }

  const condition = buildGoalCondition({
    vision,
    task,
    config,
    judgeFeedback: args.judgeFeedback ?? null,
  });

  const argv = [
    '-p',
    '--model',
    model,
    '--effort',
    effort,
    '--permission-mode',
    'auto',
    '--output-format',
    'json',
    `/goal ${condition}`,
  ];

  try {
    return await runClaudeGoal({
      argv,
      cwd: worktreePath,
      branch,
      logPath,
      timeoutMs: config.dispatcher.taskTimeoutMinutes * 60_000,
      onHeartbeat: args.onHeartbeat,
      header:
        `[surplus] task=${task.id} attempt=${attempt} provider=claude ` +
        `model=${model} effort=${effort} branch=${branch} started=${new Date(startedAt).toISOString()}\n`,
      startedAt,
    });
  } finally {
    finalizeWorktree({ worktreePath, projectPath: project.path, taskId: task.id });
  }
}

function runClaudeGoal(opts: {
  argv: string[];
  cwd: string;
  branch: string;
  logPath: string;
  timeoutMs: number;
  onHeartbeat?: (note: string) => void;
  header: string;
  startedAt: number;
}): Promise<RunnerResult> {
  const { argv, cwd, branch, logPath, timeoutMs, onHeartbeat, header, startedAt } = opts;

  return new Promise<RunnerResult>((resolve) => {
    const log = createWriteStream(logPath, { flags: 'a' });
    log.on('error', () => {
      /* logging must never crash the run */
    });
    log.write(header);

    const child = spawn('claude', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    // Keep the Mac awake while the worker runs (best-effort, macOS only).
    try {
      if (child.pid !== undefined) {
        const caffeinate = spawn('caffeinate', ['-w', String(child.pid)], {
          stdio: 'ignore',
        });
        caffeinate.on('error', () => {
          /* caffeinate unavailable — fine */
        });
        caffeinate.unref();
      }
    } catch {
      /* ignore */
    }

    let stdoutBuf = '';
    let stderrTail = '';
    let recent = '';
    let spawnError: Error | null = null;
    let timedOut = false;
    let settled = false;

    const appendRecent = (text: string): void => {
      recent = (recent + text).slice(-RECENT_KEEP);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      log.write(text);
      stdoutBuf = (stdoutBuf + text).slice(-STDOUT_KEEP);
      appendRecent(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      log.write(text);
      stderrTail = (stderrTail + text).slice(-STDERR_KEEP);
      appendRecent(text);
    });

    const lastLineSnippet = (): string => {
      const lines = recent
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '');
      const last = lines.length > 0 ? lines[lines.length - 1]! : '';
      return redactSecrets(last.slice(0, 200));
    };

    let heartbeat: NodeJS.Timeout | null = null;
    if (onHeartbeat) {
      heartbeat = setInterval(() => {
        const mins = Math.round((Date.now() - startedAt) / 60_000);
        const snippet = lastLineSnippet();
        try {
          onHeartbeat(`[${mins}m] ${snippet !== '' ? snippet : 'no output yet'}`);
        } catch {
          /* heartbeat consumers must not crash the run */
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
    }

    let killTimer: NodeJS.Timeout | null = null;
    const wall = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    wall.unref?.();

    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      if (killTimer !== null) clearTimeout(killTimer);
      if (heartbeat !== null) clearInterval(heartbeat);

      const endedAt = Date.now();
      const envelope = parseClaudeEnvelope(stdoutBuf);

      let summary: string;
      if (envelope.result !== null && envelope.result.trim() !== '') {
        summary = envelope.result;
      } else if (timedOut) {
        summary = `timed out after ${Math.round(timeoutMs / 60_000)} minutes; last output: ${lastLineSnippet()}`;
      } else if (spawnError !== null) {
        summary = `claude spawn failed: ${errMessage(spawnError)}`;
      } else if (code !== 0) {
        summary =
          stderrTail.trim() !== ''
            ? tail(stderrTail.trim(), 2000)
            : `claude exited with code ${String(code)}${signal !== null ? ` (signal ${signal})` : ''}`;
      } else {
        // exit 0 but unparseable JSON — fall back to the raw stdout tail
        summary = tail(stdoutBuf.trim(), 2000);
      }
      summary = redactSecrets(summary);

      let outcome: RunOutcome;
      if (timedOut) {
        outcome = 'timeout';
      } else if (spawnError !== null) {
        outcome = 'error';
      } else if (code === 0) {
        // Clean completion = 'failed' (completed, pending judge) by convention,
        // unless the CLI itself flagged an error.
        outcome = envelope.isError === true ? 'error' : 'failed';
      } else if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        outcome = 'killed'; // external stop (user pause / system)
      } else {
        outcome = 'error';
      }

      // Quota/auth exhaustion detection (stderr or result text).
      if (
        (outcome === 'error' || outcome === 'killed') &&
        (QUOTA_RE.test(stderrTail) || QUOTA_RE.test(summary))
      ) {
        outcome = 'quota';
      }

      log.end();
      resolve({
        outcome,
        exitCode: code,
        branch,
        summary,
        logPath,
        startedAt,
        endedAt,
      });
    };

    child.on('error', (err) => {
      spawnError = err;
      settle(null, null);
    });
    child.on('close', (code, signal) => {
      settle(code, signal);
    });
  });
}
