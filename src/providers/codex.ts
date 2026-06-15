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
import {
  assertSafeFlagValue,
  finalizeWorktree,
  makeRedactingWriter,
  prepareWorktree,
} from '../runner.js';
import { buildGoalCondition, redactSecrets } from '../vision.js';
import type {
  AccountAdapter,
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

/**
 * CONNECTION-LEVEL transient failures only (lost API connection / network blip /
 * server-unreachable 5xx). Mirrors runner.ts INFRA_RE. NARROW by design: it must
 * not swallow genuine quota/auth (QUOTA_AUTH_RE, tested FIRST) — a wifi hiccup or
 * a 503 storm is the run not completing, not the task failing. The 5xx tokens are
 * HTTP-context-anchored (preceded by status/code/HTTP/error or followed by a
 * gateway/unavailable phrase) so a bare row count / assertion diff like
 * 'Retrieved 502 rows' or 'expected 200 but got 503' in project output does NOT
 * match. Classification reads stderr + the agent's final-message summary only —
 * NEVER the raw `codex exec` transcript (which carries the project's own shell /
 * build / test output and would mask real failures); see classifyExit + runTask.
 */
const INFRA_RE =
  /unable to connect|connection refused|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang ?up|network (error|is unreachable)|client request timed out|(?:status|code|http|error)[^\n]{0,12}\b(?:502|503|504)\b|\b(?:502|503|504)\b\s*(?:bad gateway|service unavailable|gateway time-?out)|temporarily (unavailable|limiting)|service unavailable/i;

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
  /**
   * Last ~16KB of codex's OWN stderr (runtime errors). This is what infra/quota
   * classification reads — NOT the stdout transcript. `codex exec` (no --json)
   * streams the agent transcript on stdout INCLUDING the output of every shell /
   * build / test command the agent runs (the project's OWN output). Scanning that
   * would misclassify a real task failure as 'infra' the moment a legitimate test
   * prints a connection-level token (a 5xx assertion, a row count, ETIMEDOUT in a
   * network test, even a test NAMED 'handles connection refused'), refunding the
   * attempt and looping forever instead of blocking. So we mirror the claude path:
   * classify from stderr + the agent's final-message summary only.
   */
  stderrTail: string;
  /** Final agent message (summary) — the agent's own envelope text, not the transcript. */
  summary: string;
}

/**
 * Pure outcome classification for a finished `codex exec` process.
 *
 * PRECEDENCE (mirrors runner.ts classifyClaudeOutcome):
 *   1. our wall-clock timeout → 'timeout'
 *   2. our-own SIGTERM/SIGKILL → 'killed'
 * (1)–(2) are OUR deliberate stops and outrank infra/quota. On a nonzero exit we
 * read codex's stderr + the agent summary ONLY (never the stdout transcript — see
 * ExitClassification.stderrTail). INFRA_RE and QUOTA_AUTH_RE are NOT disjoint for
 * real strings (providers serve rate-limit/overload/auth-expiry AS HTTP 5xx), so:
 *   3. genuine quota/auth QUOTA_AUTH_RE → 'quota'  (tested FIRST — a message that
 *      names usage-limit/quota/401/not-logged-in/expiry IS quota even when it also
 *      carries a 5xx; it must feed the quota/reset accounting, not be refunded
 *      forever as a transient blip)
 *   4. CONNECTION-LEVEL INFRA_RE → 'infra'  (only when NO quota/auth token is
 *      present — a pure ConnectionRefused / socket hang up / gateway 5xx is a
 *      transient blip; the run did not complete, so the dispatcher refunds the
 *      attempt and never blocks)
 *   5. otherwise → 'error'
 * A clean exit 0 is NEVER infra (HARD_LIMIT_RE → 'quota', else completed-pending-judge).
 */
export function classifyExit(c: ExitClassification): RunOutcome {
  if (c.timedOut) return 'timeout';
  if (c.signal !== null && c.signal !== undefined) return 'killed';
  if (c.exitCode !== 0) {
    if (QUOTA_AUTH_RE.test(c.stderrTail) || QUOTA_AUTH_RE.test(c.summary)) return 'quota';
    if (INFRA_RE.test(c.stderrTail) || INFRA_RE.test(c.summary)) return 'infra';
    return 'error';
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

    // argv-injection guard: the model is untrusted (task row / VISION
    // frontmatter / board PATCH) and `-m` has no reliable `=` form — a
    // leading-dash value could be parsed as a flag of its own. (effort is
    // already constrained by mapCodexEffort below.)
    const model = assertSafeFlagValue('model', args.model);

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
        model,
      ];
      const effort = mapCodexEffort(args.effort);
      if (effort) cliArgs.push('-c', `model_reasoning_effort="${effort}"`);
      cliArgs.push('-'); // read the prompt from stdin (avoids argv length limits)

      const logStream = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
      logStream.on('error', () => {
        /* logging must never crash the run (mirrors runner.ts) */
      });
      // Raw worker output is redacted before it touches disk (see runner.ts).
      const redactedLog = makeRedactingWriter((text) => logStream.write(text));
      logStream.write(
        `[surplus] codex exec start task=${args.task.id} attempt=${attempt} model=${model} effort=${effort ?? 'default'} at=${new Date(startedAt).toISOString()}\n`,
      );

      const child = spawnFn('codex', cliArgs, {
        cwd: worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        // argv array, NO shell — nothing is shell-interpolated.
      });

      // SEPARATE buffers: stdout carries the agent transcript (which streams the
      // project's OWN shell/build/test output) and is used ONLY for the summary
      // fallback; stderr carries codex's runtime errors and is the ONLY stream
      // fed to infra/quota classification (mirrors the claude path's stderrTail).
      // Scanning the combined transcript would mask real task failures as 'infra'.
      let stdoutTail = '';
      let stderrTail = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        redactedLog.write(chunk.toString('utf8'));
        stdoutTail = (stdoutTail + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        redactedLog.write(chunk.toString('utf8'));
        stderrTail = (stderrTail + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
      });
      if (child.stdin) {
        child.stdin.on('error', () => {
          /* EPIPE when codex exits early — outcome handling covers it */
        });
        child.stdin.end(prompt);
      }

      let timedOut = false;
      let watchdogAborted = false;
      let settled = false; // true once the child has exited (or spawn failed)
      let graceTimer: NodeJS.Timeout | undefined;
      const timeoutMs = args.config.dispatcher.taskTimeoutMinutes * 60_000;
      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        graceTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
      }, timeoutMs);

      // Dispatcher usage-watchdog abort (reserve ceiling crossed) → 'quota'.
      // The settled guard stops a LATE abort (an in-flight watchdog poll that
      // resolves after the run finished) from writing to an ended logStream,
      // arming a kill timer against a dead pid, or flipping a completed run
      // to 'quota'.
      const onAbort = (): void => {
        if (settled) return;
        watchdogAborted = true;
        logStream.write('\n[surplus] usage watchdog abort — terminating codex worker\n');
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        graceTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
      };
      if (args.signal !== undefined) {
        if (args.signal.aborted) onAbort();
        else args.signal.addEventListener('abort', onAbort, { once: true });
      }

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
      } catch (err) {
        // spawn-'error' path: close the log stream here too (the success-path
        // end below is skipped), otherwise the fd leaks.
        redactedLog.flush();
        logStream.end();
        throw err;
      } finally {
        settled = true;
        clearTimeout(killTimer);
        if (graceTimer) clearTimeout(graceTimer);
        clearInterval(heartbeat);
        args.signal?.removeEventListener('abort', onAbort);
      }

      const endedAt = now();
      redactedLog.flush();
      await new Promise<void>((resolve) => logStream.end(resolve));

      // finalMessage is the agent's OWN envelope text (--output-last-message);
      // it is the only summary text classification may read. The DISPLAY summary
      // falls back to the stdout transcript when codex wrote no final message, but
      // that transcript carries the project's command output and must NOT reach
      // classifyExit (it would mask real failures as 'infra' — see ExitClassification).
      let finalMessage = '';
      try {
        finalMessage = (await readFile(lastMessagePath, 'utf8')).trim();
      } catch {
        /* codex did not write a final message */
      }
      let summary = finalMessage || stdoutTail.slice(-2000).trim();
      summary = redactSecrets(summary);

      const outcome = watchdogAborted
        ? 'quota' // reserve ceiling crossed mid-run
        : classifyExit({
            timedOut,
            signal: exit.signal,
            exitCode: exit.code,
            // stderr + the agent's own final message ONLY — never the stdout
            // transcript (which carries the project's shell/build/test output).
            stderrTail,
            summary: redactSecrets(finalMessage),
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

/**
 * The codex AccountAdapter — codex is always a single account with key
 * 'codex' (no profile-dir multiplexing; the codex CLI owns its own auth).
 */
export function codexAccountAdapter(config: SurplusConfig, deps: CodexAdapterDeps = {}): AccountAdapter {
  const base = codexAdapter(config, deps);
  return {
    key: 'codex',
    provider: 'codex',
    label: 'codex',
    priority: null,
    configDir: null,
    getUsage: (opts?: { fresh?: boolean }) => {
      void opts; // codex usage is probed from local rollouts — no fresh-vs-cached split
      return base.getUsage();
    },
    runTask: (args: RunTaskArgs) => base.runTask(args),
  };
}
