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
import { createWriteStream, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { RunOutcome, RunnerResult, RunTaskArgs, TaskRow } from './types.js';
import { sanitizeAccountKey } from './config.js';
import { buildGoalCondition, redactSecrets } from './vision.js';
import { resolveRolesPlan } from './roles.js';

const QUOTA_RE = /rate.?limit|quota|overloaded|\b429\b|401|authentication|expired/i;
// CONNECTION-LEVEL transient failures only (lost API connection / network blip /
// server-unreachable 5xx). Deliberately NARROW: it must NOT swallow genuine
// quota/auth (handled by QUOTA_RE) — see classifyClaudeOutcome's commented
// precedence (QUOTA_RE is tested FIRST so a 5xx that NAMES rate-limit/quota/auth
// stays 'quota'). A lost wifi link or a 503 storm is the run not completing.
// The 5xx tokens are HTTP-context-anchored (preceded by status/code/HTTP/error or
// followed by a gateway/unavailable phrase) so a bare row count / assertion diff
// like 'Retrieved 502 rows' or 'expected 200 but got 503' does NOT match.
const INFRA_RE =
  /unable to connect|connection refused|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang ?up|network (error|is unreachable)|client request timed out|(?:status|code|http|error)[^\n]{0,12}\b(?:502|503|504)\b|\b(?:502|503|504)\b\s*(?:bad gateway|service unavailable|gateway time-?out)|temporarily (unavailable|limiting)|service unavailable/i;
// The claude CLI reports its OWN transport failures in the result envelope with a
// recognizable "API Error: … connect/network/5xx" or "unable to connect to … api"
// shape. Only THAT narrow envelope is matched against `summary` (which is
// otherwise WORKER-authored) — so a worker narrating a project's own ECONNREFUSED
// (a Postgres/HTTP client in its tests) is NOT misread as 'infra' and refunded
// forever. Raw errno tokens are trusted only from the CLI-owned stderr (INFRA_RE).
const INFRA_ENVELOPE_RE =
  /api (?:error|request)[^\n]{0,60}(?:unable to connect|connection (?:refused|error|reset)|econnrefused|enotfound|etimedout|network|timed out|502|503|504)|unable to connect to (?:the )?(?:anthropic )?api/i;
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
  /** `num_turns` field; null when absent. */
  numTurns: number | null;
  /** Count of `permission_denials`; null when absent. */
  denials: number | null;
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
      const numTurns = typeof obj['num_turns'] === 'number' ? (obj['num_turns'] as number) : null;
      const denials = Array.isArray(obj['permission_denials'])
        ? (obj['permission_denials'] as unknown[]).length
        : null;
      if (result !== null || isError !== null || obj['type'] === 'result') {
        return { result, isError, numTurns, denials };
      }
    } catch {
      /* try next candidate */
    }
  }
  return { result: null, isError: null, numTurns: null, denials: null };
}

function tail(text: string, n: number): string {
  return text.length > n ? text.slice(-n) : text;
}

export interface ClaudeOutcomeInputs {
  /** True when the reserve usage-watchdog SIGTERM'd the worker. */
  watchdogAborted: boolean;
  /** True when our wall-clock timeout SIGTERM'd the worker. */
  timedOut: boolean;
  /** Non-null when the child failed to spawn at all. */
  spawnError: Error | null;
  /** Process exit code (null on spawn error / signal kill). */
  code: number | null;
  /** Terminating signal, if any (e.g. our own SIGTERM/SIGKILL on pause). */
  signal: NodeJS.Signals | null;
  /** `is_error` flag from the claude JSON envelope (null when absent). */
  isError: boolean | null;
  /** Last ~16KB of stderr. */
  stderrTail: string;
  /** The computed run summary (result text / diagnostics). */
  summary: string;
}

/**
 * Pure outcome classification for a finished `claude -p` run (exported for tests;
 * mirrors providers/codex.ts classifyExit). PRECEDENCE, explicit & ordered:
 *   1. watchdogAborted → 'quota'   (our reserve watchdog SIGTERM)
 *   2. timedOut        → 'timeout' (our wall-clock SIGTERM)
 *   3. our-own SIGTERM/SIGKILL (no wall/watchdog) → 'killed' (user pause)
 * (1)–(3) are OUR deliberate stops and outrank both infra and quota: a run we
 * killed didn't "fail to connect". A clean exit 0 is NEVER infra (it's
 * completed-pending-judge 'failed', or 'error' when the CLI flagged is_error).
 * Only when the run would OTHERWISE be 'error' (spawn failure / nonzero exit /
 * is_error) do we read the text. INFRA_RE and QUOTA_RE are NOT disjoint for real
 * strings (providers serve rate-limit/overload/auth-expiry AS HTTP 5xx), so:
 *   4. genuine quota/auth QUOTA_RE → 'quota'  (tested FIRST — a message that names
 *      rate-limit/quota/401/auth/expiry IS quota even when it also carries a 5xx;
 *      it must feed the quota/reset accounting and block on persistent auth,
 *      not be refunded forever as a transient blip)
 *   5. CONNECTION-LEVEL INFRA_RE → 'infra'  (only when NO quota/auth token is
 *      present — a pure ConnectionRefused / socket hang up / gateway 5xx is a
 *      transient blip; the run did not complete, so the dispatcher refunds the
 *      attempt and never blocks)
 *   6. otherwise → 'error'
 */
export function classifyClaudeOutcome(c: ClaudeOutcomeInputs): RunOutcome {
  let outcome: RunOutcome;
  if (c.watchdogAborted) {
    outcome = 'quota'; // reserve ceiling crossed mid-run
  } else if (c.timedOut) {
    outcome = 'timeout';
  } else if (c.spawnError !== null) {
    outcome = 'error';
  } else if (c.code === 0) {
    outcome = c.isError === true ? 'error' : 'failed';
  } else if (c.signal === 'SIGTERM' || c.signal === 'SIGKILL') {
    outcome = 'killed'; // external stop (user pause / system)
  } else {
    outcome = 'error';
  }

  // PRECEDENCE on the text (see doc comment): QUOTA_RE is tested BEFORE INFRA_RE.
  // The two are NOT disjoint for realistic strings — providers serve rate-limit /
  // overload / auth-expiry as HTTP 5xx ("HTTP 503: rate limit exceeded",
  // "overloaded_error: 503"). A message that NAMES rate-limit/quota/401/auth/expiry
  // is genuine quota even when it also carries a 5xx, so it must feed the quota /
  // reset accounting (and BLOCK on a persistent auth failure) rather than being
  // refunded forever as 'infra'. INFRA only fires when NO quota/auth token is
  // present — a pure connection blip.
  const quotaText = QUOTA_RE.test(c.stderrTail) || QUOTA_RE.test(c.summary);
  if ((outcome === 'error' || outcome === 'killed') && quotaText) {
    outcome = 'quota';
  } else if (outcome === 'error' && (INFRA_RE.test(c.stderrTail) || INFRA_ENVELOPE_RE.test(c.summary))) {
    outcome = 'infra';
  }
  return outcome;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// CLI flag-value guard & redacting log writer (shared with providers/codex.ts
// and judge.ts)
// ---------------------------------------------------------------------------

/**
 * Guard a model/effort string before it becomes a CLI flag VALUE
 * (`--model <value>` / `-m <value>`). These values flow in from
 * attacker-influenceable sources — VISION.md frontmatter (including
 * LLM-drafted ones), board PATCHes, and task rows — and a leading '-' could
 * be parsed by the downstream claude/codex CLI as a flag of its own,
 * subverting the load-bearing permission recipe. Throws on anything that
 * isn't a plain model/effort token.
 */
export function assertSafeFlagValue(kind: string, value: string): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v === '' || v.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._/:-]*$/.test(v)) {
    throw new Error(`unsafe ${kind} value rejected: ${JSON.stringify(String(value).slice(0, 64))}`);
  }
  return v;
}

const REDACT_BUFFER_CAP = 64 * 1024;

/**
 * Line-buffered redacting writer for raw worker output. The worker runs with
 * Bash(*) and full repo/network access, so its stdout/stderr can trivially
 * surface credentials (`env`, ~/.claude, .env files) — every chunk is passed
 * through redactSecrets before it reaches the on-disk log. Buffering to line
 * boundaries keeps a token split across chunks detectable.
 */
export function makeRedactingWriter(write: (text: string) => void): {
  write: (chunk: string) => void;
  flush: () => void;
} {
  let buf = '';
  return {
    write(chunk: string): void {
      buf += chunk;
      const idx = buf.lastIndexOf('\n');
      if (idx === -1) {
        // Pathologically long line: flush anyway so memory stays bounded.
        if (buf.length > REDACT_BUFFER_CAP) {
          write(redactSecrets(buf));
          buf = '';
        }
        return;
      }
      write(redactSecrets(buf.slice(0, idx + 1)));
      buf = buf.slice(idx + 1);
    },
    flush(): void {
      if (buf !== '') {
        write(redactSecrets(buf));
        buf = '';
      }
    },
  };
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
 * Best-effort: link the project's node_modules into a fresh worktree.
 *
 * `git worktree add` checks out tracked files only — node_modules is gitignored,
 * so a worktree under ~/.surplus/worktrees has no deps and `npm test` / `npx tsc`
 * cannot resolve them (node won't walk up that path to the real project). A
 * symlink <worktree>/node_modules → <project>/node_modules lets the worker (and
 * the judge's verify step) actually run the project's commands.
 *
 * Shared by prepareWorktree (worker side) and the judge's ephemeral worktree so
 * both run against the same installed deps. Never throws — a missing or
 * unsymlinkable node_modules just means commands fall back to "no deps".
 *
 * Scope note: deliberately limited to node_modules. A future extension could
 * also link a top-level '.venv' for Python projects; out of scope for now.
 */
export function symlinkNodeModules(worktreePath: string, projectPath: string): void {
  try {
    const src = path.join(projectPath, 'node_modules');
    const dest = path.join(worktreePath, 'node_modules');
    if (existsSync(src) && !existsSync(dest)) {
      symlinkSync(src, dest, 'dir');
    }
  } catch {
    /* best-effort: never block a run on missing/unsymlinkable deps */
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

  // Link in node_modules so the worker can actually run `npm test` etc. in the
  // fresh worktree (gitignored deps are absent from `git worktree add`).
  symlinkNodeModules(worktreePath, projectPath);

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
  const { task, project, vision, config, logsDir, worktreesDir } = args;
  const startedAt = Date.now();

  mkdirSync(logsDir, { recursive: true });
  // claimNextReadyTask increments attempts atomically at claim time, so the
  // row we receive already reflects THIS attempt's number. The account-key
  // suffix keeps two accounts retrying the same task (e.g. after a refunded
  // quota clip reuses an attempt number) from clobbering each other's logs.
  const attempt = Math.max(1, task.attempts ?? 1);
  const accountKey = args.accountKey ?? null;
  const accountSuffix = accountKey === null ? '' : `-${sanitizeAccountKey(accountKey)}`;
  const logPath = path.join(logsDir, `${task.id}-attempt${attempt}${accountSuffix}.log`);

  // argv-injection guard: model/effort are untrusted (task row / VISION
  // frontmatter / board PATCH) and become `--model <v> --effort <v>` argv
  // values below.
  let model: string;
  let effort: string;
  try {
    model = assertSafeFlagValue('model', args.model);
    effort = assertSafeFlagValue('effort', args.effort);
  } catch (err) {
    return {
      outcome: 'error',
      exitCode: null,
      branch: null,
      summary: redactSecrets(errMessage(err)),
      logPath,
      startedAt,
      endedAt: Date.now(),
    };
  }

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

  // EXPERIMENTAL model roles (config.roles): run as a smart orchestrator that
  // delegates to a cheaper executor subagent. Absent/invalid roles → the plan is
  // the base model + tools + condition, byte-for-byte the standard path. Model
  // strings pass the same argv-injection guard as args.model above.
  let orchestrator: string | null = null;
  let executor: string | null = null;
  if (config.roles?.orchestrator && config.roles?.executor) {
    try {
      orchestrator = assertSafeFlagValue('model', config.roles.orchestrator);
      executor = assertSafeFlagValue('model', config.roles.executor);
    } catch {
      orchestrator = null;
      executor = null; // invalid role model → disable roles, never break the run
    }
  }
  const plan = resolveRolesPlan({
    baseModel: model,
    baseAllowedTools: 'Bash(*) Edit Write WebFetch WebSearch',
    condition,
    orchestrator,
    executor,
  });
  if (plan.executorAgent) {
    try {
      const agentPath = path.join(worktreePath, plan.executorAgent.relPath);
      mkdirSync(path.dirname(agentPath), { recursive: true });
      writeFileSync(agentPath, plan.executorAgent.content);
    } catch {
      // best-effort: if the subagent file can't be written, the orchestrator
      // simply does the work itself (no delegation, but no failure).
    }
  }

  // Permission recipe verified empirically: 'auto'/'acceptEdits' alone deny
  // Bash in headless -p (no human to approve -> denial storm, 36 denials in
  // the first smoke run). acceptEdits + an explicit Bash/Edit/Write allowlist
  // runs unattended with zero denials, while git push stays blocked both by
  // the disallow rule and the goal-condition guardrail.
  const argv = [
    '-p',
    '--model',
    plan.model,
    '--effort',
    effort,
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    plan.allowedTools,
    '--disallowedTools',
    'Bash(git push*)',
    '--output-format',
    'json',
    `/goal ${plan.goalText}`,
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
        `account=${accountKey ?? 'claude'} ` +
        `model=${model} effort=${effort} branch=${branch} started=${new Date(startedAt).toISOString()}\n`,
      startedAt,
      signal: args.signal,
      configDir: args.configDir ?? null,
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
  /** Dispatcher usage-watchdog abort: SIGTERM the worker, outcome 'quota'. */
  signal?: AbortSignal;
  /** Non-null = export CLAUDE_CONFIG_DIR for the worker (multi-account). */
  configDir?: string | null;
}): Promise<RunnerResult> {
  const { argv, cwd, branch, logPath, timeoutMs, onHeartbeat, header, startedAt, signal, configDir } =
    opts;

  return new Promise<RunnerResult>((resolve) => {
    const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    log.on('error', () => {
      /* logging must never crash the run */
    });
    // Raw child output is redacted before it touches disk — the worker holds
    // Bash(*) and could surface credentials in its own output.
    const redactedLog = makeRedactingWriter((text) => log.write(text));
    log.write(header);

    // Non-null configDir = run as that claude account: spread process.env and
    // override only CLAUDE_CONFIG_DIR (the value never contains secrets).
    const child = spawn('claude', argv, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(configDir != null ? { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } } : {}),
    });

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
    let watchdogAborted = false;

    const onAbort = (): void => {
      if (settled) return;
      watchdogAborted = true;
      log.write('\n[surplus] usage watchdog abort — terminating worker\n');
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const appendRecent = (text: string): void => {
      recent = (recent + text).slice(-RECENT_KEEP);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      redactedLog.write(text);
      stdoutBuf = (stdoutBuf + text).slice(-STDOUT_KEEP);
      appendRecent(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      redactedLog.write(text);
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
        // exit 0 but no usable result text — summarize the session diagnostics
        // instead of dumping the raw JSON envelope (which reads as garbage to
        // the judge and the board).
        const parts: string[] = ['session completed without final result text'];
        if (envelope.numTurns !== null) parts.push(`${envelope.numTurns} turns`);
        if (envelope.denials !== null && envelope.denials > 0) {
          parts.push(`${envelope.denials} permission denials (check runner allowlist flags)`);
        }
        summary = `${parts.join('; ')}; last output: ${lastLineSnippet()}`;
      }
      if (envelope.denials !== null && envelope.denials > 0 && envelope.result !== null) {
        summary += `\n[surplus] note: ${envelope.denials} tool calls were permission-denied this session.`;
      }
      summary = redactSecrets(summary);

      // See classifyClaudeOutcome for the full, commented precedence
      // (our-stops > infra(connection-level) > quota(auth) > error; exit 0 never infra).
      const outcome = classifyClaudeOutcome({
        watchdogAborted,
        timedOut,
        spawnError,
        code,
        signal,
        isError: envelope.isError,
        stderrTail,
        summary,
      });

      redactedLog.flush();
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
