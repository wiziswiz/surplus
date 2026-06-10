/**
 * providers/codex.ts — ProviderAdapter for the Codex CLI (ChatGPT Plus/Pro).
 *
 * Usage probing (in priority order):
 *   1. Passive "live" surface: the codex CLI persists a `token_count` event —
 *      including a `rate_limits` block (primary = 5h window, secondary = 7-day
 *      window, used_percent + resets_at epoch-seconds, plan_type) — into every
 *      session rollout file under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 *      Verified against codex-cli 0.137.0. We read the newest such event and use
 *      it when its 7-day window is still current (resets_at > now). Our own
 *      `codex exec` runs write fresh rollouts, so this self-refreshes while
 *      burning (we deliberately do NOT pass --ephemeral).
 *   2. config.providers.codex.weeklyResetFallback — ISO timestamp or
 *      'Thu 21:00' weekday-time, rolled forward to the next weekly occurrence.
 *   3. null (provider unusable; dispatcher skips it).
 *
 * Runs via `codex exec` (verified flags for 0.137.0):
 *   --sandbox workspace-write          sandboxed writes inside the worktree
 *   -c sandbox_workspace_write.network_access=true   network for installs/tests
 *   -c approval_policy=never           fully unattended (exec has no -a flag)
 *   --skip-git-repo-check              robust inside git worktrees
 *   --color never                      clean log files
 *   -m <model>                         model slug (e.g. gpt-5.4)
 *   -c model_reasoning_effort="..."    low|medium|high|xhigh (verified via
 *                                      `codex debug models`)
 *   --output-last-message <file>       final agent message → RunnerResult.summary
 *   '-' + prompt on stdin              avoids argv length limits
 *
 * Subprocesses are spawned via node:child_process.spawn with an argv array and
 * NO shell — nothing is ever interpolated into a shell string. NEVER logs or
 * persists token material; only file names under ~/.codex are touched, plus
 * the non-secret session rollout JSONL (usage numbers only).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { finalizeWorktree, prepareWorktree } from '../runner.js';
import { buildGoalCondition, redactSecrets } from '../vision.js';
import type {
  ProviderAdapter,
  RunnerResult,
  RunOutcome,
  RunTaskArgs,
  SurplusConfig,
  UsageSnapshot,
} from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 3 * 60 * 1000;
const SIGKILL_GRACE_MS = 15_000;
const CLI_CHECK_TIMEOUT_MS = 10_000;
const OUTPUT_TAIL_BYTES = 16 * 1024;
const ROLLOUT_TAIL_BYTES = 512 * 1024;
const MAX_ROLLOUT_FILES_SCANNED = 20;

export const PROMPT_PREFACE =
  'Work autonomously until the following completion condition is fully satisfied. ' +
  'Run the verify commands yourself and show their output. ' +
  'If you cannot finish, end with a precise summary of remaining work.';

/** Broad quota/auth failure patterns — applied to the output tail on nonzero exit. */
const QUOTA_AUTH_RE =
  /(rate.?limit|usage.?limit|quota|too many requests|\b429\b|\b401\b|unauthorized|not logged in|login required|please (run )?['"`]?codex login|session expired|reauthenticat|token (has )?expired)/i;

/** Narrow "we actually hit the limit" patterns — applied to the summary on clean exit. */
const HARD_LIMIT_RE =
  /((hit|reached|exceeded)[^.\n]{0,60}(usage|rate).?limit|(usage|rate).?limit (reached|exceeded|hit)|out of (quota|credits)|upgrade to continue)/i;

// ---------------------------------------------------------------------------
// Injectable deps (defaults touch the real system; tests override everything)
// ---------------------------------------------------------------------------

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface CodexAdapterDeps {
  /** Clock, ms epoch. Default Date.now. */
  now?: () => number;
  /** Codex home dir (session rollouts live under <codexHome>/sessions). Default ~/.codex. */
  codexHome?: string;
  /** Subprocess spawner for `codex exec`. Default node:child_process.spawn (argv array, no shell). */
  spawn?: SpawnFn;
  /** CLI presence probe. Default spawns `codex --version`. */
  checkCliInstalled?: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Parse weeklyResetFallback — an ISO timestamp or a 'Thu 21:00' weekday-time
 * (local time) — and return the next weekly occurrence STRICTLY after `now`
 * (ms epoch). Returns null when unparseable.
 */
export function parseWeeklyResetFallback(spec: string, now: number): number | null {
  const trimmed = spec.trim();
  if (trimmed === '') return null;

  const m = /^([a-zA-Z]+)\.?\s+(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (m) {
    const token = m[1]!.toLowerCase();
    const idx = token.length >= 3 ? WEEKDAYS.findIndex((w) => w.startsWith(token)) : -1;
    const hours = Number(m[2]);
    const minutes = Number(m[3]);
    if (idx < 0 || hours > 23 || minutes > 59) return null;
    const d = new Date(now);
    d.setHours(hours, minutes, 0, 0);
    const delta = (idx - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + delta);
    if (d.getTime() <= now) d.setDate(d.getDate() + 7);
    return d.getTime();
  }

  const anchor = Date.parse(trimmed);
  if (Number.isNaN(anchor)) return null;
  // Occurrences exist at anchor + k*WEEK for all integers k; pick the smallest > now.
  const k = Math.floor((now - anchor) / WEEK_MS) + 1;
  return anchor + k * WEEK_MS;
}

/** Map surplus effort levels onto codex reasoning efforts; null = omit the flag. */
export function mapCodexEffort(effort: string): 'low' | 'medium' | 'high' | 'xhigh' | null {
  switch (effort.trim().toLowerCase()) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'xhigh';
    default:
      return null;
  }
}

export interface ExitClassification {
  timedOut: boolean;
  signal: NodeJS.Signals | string | null;
  exitCode: number | null;
  /** Last ~16KB of combined stdout+stderr. */
  outputTail: string;
  /** Final agent message (summary). */
  summary: string;
}

/** Pure outcome classification for a finished `codex exec` process. */
export function classifyExit(c: ExitClassification): RunOutcome {
  if (c.timedOut) return 'timeout';
  if (c.signal !== null && c.signal !== undefined) return 'killed';
  if (c.exitCode !== 0) {
    return QUOTA_AUTH_RE.test(c.outputTail) || QUOTA_AUTH_RE.test(c.summary) ? 'quota' : 'error';
  }
  if (HARD_LIMIT_RE.test(c.summary)) return 'quota';
  // Clean completion = completed-pending-judge; the claude-side judge promotes to 'passed'.
  return 'failed';
}

// ---------------------------------------------------------------------------
// Session rollout rate-limit probing
// ---------------------------------------------------------------------------

interface CodexRateLimitWindow {
  used_percent?: number | null;
  window_minutes?: number | null;
  /** Epoch SECONDS. */
  resets_at?: number | null;
}

interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  plan_type?: string | null;
}

const PLAN_NAMES: Record<string, string> = {
  plus: 'ChatGPT Plus',
  pro: 'ChatGPT Pro',
  team: 'ChatGPT Team',
  business: 'ChatGPT Business',
  enterprise: 'ChatGPT Enterprise',
  edu: 'ChatGPT Edu',
  free: 'ChatGPT Free',
};

function planNameFrom(planType: string | null | undefined): string {
  if (!planType) return 'ChatGPT';
  const known = PLAN_NAMES[planType.toLowerCase()];
  if (known) return known;
  return `ChatGPT ${planType.charAt(0).toUpperCase()}${planType.slice(1)}`;
}

async function listRecentRolloutFiles(sessionsDir: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const sortedDirs = async (dir: string, pattern: RegExp): Promise<string[]> => {
    try {
      return (await readdir(dir)).filter((e) => pattern.test(e)).sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  };
  for (const year of await sortedDirs(sessionsDir, /^\d{4}$/)) {
    for (const month of await sortedDirs(join(sessionsDir, year), /^\d{2}$/)) {
      for (const day of await sortedDirs(join(sessionsDir, year, month), /^\d{2}$/)) {
        const dayDir = join(sessionsDir, year, month, day);
        const files = await sortedDirs(dayDir, /^rollout-.*\.jsonl$/);
        for (const f of files) {
          out.push(join(dayDir, f));
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

async function readFileTail(file: string, maxBytes: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size <= 0) return '';
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Find the newest token_count rate_limits payload in a rollout JSONL tail. */
function extractRateLimits(jsonlTail: string): CodexRateLimits | null {
  const lines = jsonlTail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"rate_limits"')) continue;
    try {
      const obj = JSON.parse(line) as {
        payload?: { type?: string; rate_limits?: CodexRateLimits | null };
      };
      const payload = obj.payload;
      if (payload?.type === 'token_count' && payload.rate_limits) return payload.rate_limits;
    } catch {
      // Partial first line of the tail window, or a non-JSON line — skip.
    }
  }
  return null;
}

/**
 * Convert a recorded rate_limits block into a UsageSnapshot, or null when the
 * recording is too stale (its 7-day window already reset, so utilization and
 * reset time would both be wrong).
 */
function rateLimitsToSnapshot(rl: CodexRateLimits, nowMs: number): UsageSnapshot | null {
  let five: CodexRateLimitWindow | null = null;
  let seven: CodexRateLimitWindow | null = null;
  for (const w of [rl.primary, rl.secondary]) {
    if (!w) continue;
    const mins = w.window_minutes ?? null;
    if (mins !== null && mins <= 24 * 60) five ??= w;
    else seven ??= w;
  }
  const sevenResetMs = typeof seven?.resets_at === 'number' ? seven.resets_at * 1000 : null;
  if (sevenResetMs === null || sevenResetMs <= nowMs) return null;

  const fiveResetMs = typeof five?.resets_at === 'number' ? five.resets_at * 1000 : null;
  const fiveValid = fiveResetMs !== null && fiveResetMs > nowMs;

  return {
    provider: 'codex',
    planName: planNameFrom(rl.plan_type),
    fiveHourPct: fiveValid && typeof five?.used_percent === 'number' ? five.used_percent : null,
    fiveHourResetsAt: fiveValid ? new Date(fiveResetMs) : null,
    sevenDayPct: typeof seven?.used_percent === 'number' ? seven.used_percent : null,
    sevenDayResetsAt: new Date(sevenResetMs),
    unavailable: false,
    fetchedAt: nowMs,
  };
}

// ---------------------------------------------------------------------------
// CLI presence
// ---------------------------------------------------------------------------

function makeDefaultCliCheck(spawnFn: SpawnFn): () => Promise<boolean> {
  return () =>
    new Promise<boolean>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnFn('codex', ['--version'], { stdio: 'ignore' });
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, CLI_CHECK_TIMEOUT_MS);
      timer.unref?.();
      child.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function codexAdapter(config: SurplusConfig, deps: CodexAdapterDeps = {}): ProviderAdapter {
  const now = deps.now ?? Date.now;
  const codexHome = deps.codexHome ?? join(homedir(), '.codex');
  const spawnFn: SpawnFn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const cliInstalled = deps.checkCliInstalled ?? makeDefaultCliCheck(spawnFn);

  async function getUsage(): Promise<UsageSnapshot | null> {
    if (!(await cliInstalled())) return null;
    const nowMs = now();

    // (1) Passive live surface: newest rate_limits event in session rollouts.
    try {
      const files = await listRecentRolloutFiles(join(codexHome, 'sessions'), MAX_ROLLOUT_FILES_SCANNED);
      for (const file of files) {
        const tail = await readFileTail(file, ROLLOUT_TAIL_BYTES);
        const rl = extractRateLimits(tail);
        if (!rl) continue;
        const snap = rateLimitsToSnapshot(rl, nowMs);
        if (snap) return snap;
        break; // Newest recording is stale → newer truth does not exist on disk.
      }
    } catch {
      // Probing must never break burning — fall through to the fallback.
    }

    // (2) Config-declared weekly reset schedule (time-gated, utilization unknown).
    const fallback = config.providers.codex?.weeklyResetFallback;
    if (fallback) {
      const next = parseWeeklyResetFallback(fallback, nowMs);
      if (next !== null) {
        return {
          provider: 'codex',
          planName: 'ChatGPT',
          fiveHourPct: null,
          sevenDayPct: null,
          fiveHourResetsAt: null,
          sevenDayResetsAt: new Date(next),
          unavailable: false,
          fetchedAt: nowMs,
        };
      }
    }

    // (3) No usage surface at all.
    return null;
  }

  async function runTask(args: RunTaskArgs): Promise<RunnerResult> {
    if (!(await cliInstalled())) {
      throw new Error('codex CLI not installed');
    }

    const startedAt = now();
    const attempt = Math.max(1, args.task.attempts ?? 1); // claim pre-increments
    await mkdir(args.logsDir, { recursive: true });
    const logPath = join(args.logsDir, `${args.task.id}-attempt${attempt}-codex.log`);
    const lastMessagePath = join(args.logsDir, `${args.task.id}-attempt${attempt}-codex.last.txt`);

    const { worktreePath, branch } = prepareWorktree({
      task: args.task,
      projectPath: args.project.path,
      worktreesDir: args.worktreesDir,
    });

    try {
      const condition = buildGoalCondition({
        vision: args.vision,
        task: args.task,
        config: args.config,
        judgeFeedback: args.judgeFeedback ?? args.task.judgeFeedback ?? null,
      }).replace(/^\s*\/goal\s+/i, '');
      const prompt = `${PROMPT_PREFACE}\n\n${condition}`;

      const cliArgs: string[] = [
        'exec',
        '--sandbox',
        'workspace-write',
        '-c',
        'sandbox_workspace_write.network_access=true',
        '-c',
        'approval_policy=never',
        '--skip-git-repo-check',
        '--color',
        'never',
        '--output-last-message',
        lastMessagePath,
        '-m',
        args.model,
      ];
      const effort = mapCodexEffort(args.effort);
      if (effort) cliArgs.push('-c', `model_reasoning_effort="${effort}"`);
      cliArgs.push('-'); // read the prompt from stdin (avoids argv length limits)

      const logStream = createWriteStream(logPath, { flags: 'a' });
      logStream.write(
        `[surplus] codex exec start task=${args.task.id} attempt=${attempt} model=${args.model} effort=${effort ?? 'default'} at=${new Date(startedAt).toISOString()}\n`,
      );

      const child = spawnFn('codex', cliArgs, {
        cwd: worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        // argv array, NO shell — nothing is shell-interpolated.
      });

      let outputTail = '';
      const appendTail = (chunk: Buffer | string): void => {
        outputTail = (outputTail + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        logStream.write(chunk);
        appendTail(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        logStream.write(chunk);
        appendTail(chunk);
      });
      if (child.stdin) {
        child.stdin.on('error', () => {
          /* EPIPE when codex exits early — outcome handling covers it */
        });
        child.stdin.end(prompt);
      }

      let timedOut = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const timeoutMs = args.config.dispatcher.taskTimeoutMinutes * 60_000;
      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        graceTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
      }, timeoutMs);

      const heartbeat = setInterval(() => {
        const elapsedMin = Math.round((now() - startedAt) / 60_000);
        args.onHeartbeat?.(`codex exec running ${elapsedMin}m (task ${args.task.id}, attempt ${attempt})`);
      }, HEARTBEAT_MS);

      let exit: { code: number | null; signal: NodeJS.Signals | null };
      try {
        exit = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
      } finally {
        clearTimeout(killTimer);
        if (graceTimer) clearTimeout(graceTimer);
        clearInterval(heartbeat);
      }

      const endedAt = now();
      await new Promise<void>((resolve) => logStream.end(resolve));

      let summary = '';
      try {
        summary = (await readFile(lastMessagePath, 'utf8')).trim();
      } catch {
        /* codex did not write a final message */
      }
      if (!summary) summary = outputTail.slice(-2000).trim();
      summary = redactSecrets(summary);

      const outcome = classifyExit({
        timedOut,
        signal: exit.signal,
        exitCode: exit.code,
        outputTail,
        summary,
      });

      return {
        outcome,
        exitCode: exit.code,
        branch,
        summary,
        logPath,
        startedAt,
        endedAt,
      };
    } finally {
      // Checkpoint-commits uncommitted work and removes the worktree,
      // keeping the branch. Contract: never throws.
      finalizeWorktree({
        worktreePath,
        projectPath: args.project.path,
        taskId: args.task.id,
      });
    }
  }

  return { provider: 'codex', getUsage, runTask };
}
