/**
 * surplus — dispatcher: provider-aware claim + run + judge orchestration.
 *
 * Fully dependency-injected: imports only contracts from types.js (plus the
 * type-only SurplusDb shape from db.js), so it unit-tests with fakes.
 */
import {
  LOGS_DIR,
  SURPLUS_DIR_NAME,
  WORKTREES_DIR,
  type DecideInput,
  type Decision,
  type JudgeVerdict,
  type ProjectRow,
  type Provider,
  type ProviderAdapter,
  type RunOutcome,
  type RunnerResult,
  type SurplusConfig,
  type TaskRow,
  type UsageSnapshot,
  type Vision,
} from './types.js';
import type { SurplusDb } from './db.js';

// ---------------------------------------------------------------------------
// Deps & result shapes
// ---------------------------------------------------------------------------

export interface JudgeRunArgs {
  task: TaskRow;
  project: ProjectRow;
  vision: Vision;
  result: RunnerResult;
  config: SurplusConfig;
}

export interface DispatchDeps {
  db: SurplusDb;
  config: SurplusConfig;
  adapters: Partial<Record<Provider, ProviderAdapter>>;
  decideFn: (input: DecideInput) => Decision;
  /** Judge always runs claude-side, regardless of which provider did the work. */
  judgeRun: (args: JudgeRunArgs) => Promise<JudgeVerdict>;
  loadVision: (project: ProjectRow) => Vision;
  now?: () => number;
  /** True when ~/.surplus/PAUSED exists. Checked live (kill switch). */
  paused: () => boolean;
  log?: (msg: string) => void;
  /** Manual burn: skip decide() gating for this provider. Still refuses when paused. */
  forceProvider?: Provider;
  /** Manual burn: claim exactly this task (must be 'ready' and provider-compatible). */
  forceTaskId?: string;
  /** Defaults to ~/.surplus/logs and ~/.surplus/worktrees. */
  logsDir?: string;
  worktreesDir?: string;
}

export interface DispatchResult {
  launched: number;
  results: Array<{ taskId: string; provider: string; outcome: string }>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const PROVIDERS: readonly Provider[] = ['claude', 'codex'];

/** Outcomes where judging is pointless — the work session never completed. */
const JUDGE_SKIP: ReadonlySet<RunOutcome> = new Set(['error', 'timeout', 'killed', 'quota']);

const AUTH_ERROR_RE = /quota|rate.?limit|401|authentication|expired/i;

const FEEDBACK_CAP = 4000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strip token-looking substrings so credentials never reach the db or logs. */
function redact(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '[redacted]');
}

function unavailableSnapshot(provider: Provider, now: number, error: string): UsageSnapshot {
  return {
    provider,
    planName: null,
    fiveHourPct: null,
    sevenDayPct: null,
    fiveHourResetsAt: null,
    sevenDayResetsAt: null,
    unavailable: true,
    error,
    fetchedAt: now,
  };
}

/**
 * Step 1: per enabled provider with an adapter, fetch usage (adapters cache),
 * run decide(), and append 'usage' + 'decision' events tagged with the provider.
 */
async function evaluateProviders(
  deps: DispatchDeps,
  nowFn: () => number,
): Promise<Partial<Record<Provider, Decision>>> {
  const decisions: Partial<Record<Provider, Decision>> = {};
  for (const provider of PROVIDERS) {
    if (!deps.config.providers[provider]?.enabled) continue;
    const adapter = deps.adapters[provider];
    if (!adapter) continue;

    let usage: UsageSnapshot | null = null;
    let usageError = 'usage-unavailable';
    try {
      usage = await adapter.getUsage();
    } catch (err) {
      usageError = redact(errMessage(err));
      usage = null;
    }
    const snapshot = usage ?? unavailableSnapshot(provider, nowFn(), usageError);
    const decision = deps.decideFn({
      usage: snapshot,
      config: deps.config,
      now: nowFn(),
      paused: deps.paused(),
    });
    deps.db.appendEvent('usage', null, { ...snapshot, provider });
    deps.db.appendEvent('decision', null, { provider, ...decision });
    decisions[provider] = decision;
  }
  return decisions;
}

/** Step 2: providers allowed to burn this tick. */
function computeBurning(
  deps: DispatchDeps,
  decisions: Partial<Record<Provider, Decision>>,
): Provider[] {
  if (deps.forceProvider) {
    // Force overrides decide() window gating ('idle'/'stop'), but never the
    // kill switch, and — per the /api/burn contract "ignores windows,
    // respects pacing" — never a 'pace-wait' (which already folds in the
    // reserve 5h floor).
    if (deps.paused()) return [];
    if (decisions[deps.forceProvider]?.action === 'pace-wait') return [];
    return deps.adapters[deps.forceProvider] ? [deps.forceProvider] : [];
  }
  return PROVIDERS.filter((p) => decisions[p]?.action === 'burn');
}

function buildFeedback(
  verdict: JudgeVerdict | null,
  result: RunnerResult,
  previous: string | null,
): string {
  const parts: string[] = [];
  if (verdict) {
    if (verdict.reasons) parts.push(verdict.reasons);
    if (verdict.missing) parts.push(`Missing: ${verdict.missing}`);
    if (parts.length === 0) parts.push('Judge gave no reasons.');
  } else {
    parts.push(`Previous run ended without a verdict (outcome: ${result.outcome}).`);
  }
  let feedback = parts.join('\n');
  if (previous) feedback = `${feedback}\n---\n${previous}`;
  return feedback.slice(0, FEEDBACK_CAP);
}

interface RunOneOutcome {
  outcome: string;
  /** True when the tick must stop entirely (auth/quota failure). */
  respawnGuard: boolean;
}

/** Steps 4–5 for a single claimed task. */
async function runOne(
  deps: DispatchDeps,
  task: TaskRow,
  provider: Provider,
  adapter: ProviderAdapter,
  nowFn: () => number,
  log: (msg: string) => void,
  logsDir: string,
  worktreesDir: string,
): Promise<RunOneOutcome> {
  const db = deps.db;

  const project = db.getProject(task.projectId);
  if (!project) {
    db.updateTask(task.id, {
      status: 'blocked',
      judgeFeedback: `project not found: ${task.projectId}`,
    });
    log(`dispatch: task ${task.id} blocked — project ${task.projectId} missing`);
    return { outcome: 'error', respawnGuard: false };
  }

  let vision: Vision;
  try {
    vision = deps.loadVision(project);
  } catch (err) {
    db.updateTask(task.id, {
      status: 'blocked',
      judgeFeedback: `VISION load failed: ${redact(errMessage(err))}`,
    });
    log(`dispatch: task ${task.id} blocked — vision load failed`);
    return { outcome: 'error', respawnGuard: false };
  }

  // Model/effort precedence: task > vision frontmatter > project row > provider defaults.
  const defaults = deps.config.providers[provider].defaults;
  const model = task.model ?? vision.model ?? project.model ?? defaults.model;
  const effort = task.effort ?? vision.effort ?? project.effort ?? defaults.effort;

  const run = db.createRun({ taskId: task.id, provider, startedAt: nowFn(), model, effort });
  db.appendEvent('run-started', task.id, { runId: run.id, provider, model, effort });
  log(`dispatch: run ${run.id} started for task ${task.id} on ${provider} (${model}/${effort})`);

  // Mid-run usage watchdog: polls this provider's usage on a cadence and
  // aborts the worker when a reserve ceiling is crossed, so a long run can't
  // starve other agents (OpenClaw/Hermes crons) sharing the subscription.
  // Ceilings get +5pct slack over the launch thresholds (capped at 95) so a
  // run isn't killed for the last request that tipped the launch check.
  const reserve = deps.config.reserve;
  const weeklyCeil = Math.min(
    95,
    Math.min(deps.config.modes.weeklySurplus.stopAtPct, 100 - reserve.weeklyPct) + 5,
  );
  const fiveHourCeil = Math.min(
    95,
    Math.min(deps.config.pacing.fiveHourPausePct, 100 - reserve.fiveHourPct) + 5,
  );
  const watchdogMs = Math.max(1, reserve.watchdogIntervalMinutes) * 60_000;
  const abort = new AbortController();
  // clearInterval cannot cancel an in-flight getUsage() poll; runDone stops a
  // late-resolving poll from aborting after the run already finished.
  let runDone = false;
  const watchdog = setInterval(() => {
    void adapter
      .getUsage()
      .then((u) => {
        if (runDone || u == null || u.unavailable || abort.signal.aborted) return;
        const fiveHot = u.fiveHourPct != null && u.fiveHourPct >= fiveHourCeil;
        const weeklyHot = u.sevenDayPct != null && u.sevenDayPct >= weeklyCeil;
        if (fiveHot || weeklyHot) {
          const why = fiveHot
            ? `5h window ${u.fiveHourPct}% >= ceiling ${fiveHourCeil}%`
            : `7-day window ${u.sevenDayPct}% >= ceiling ${weeklyCeil}%`;
          db.appendEvent('run-heartbeat', task.id, {
            runId: run.id,
            note: `usage watchdog aborting run: ${why} (reserve protects other agents)`,
          });
          log(`dispatch: watchdog aborting run ${run.id} — ${why}`);
          abort.abort(new Error(`usage watchdog: ${why}`));
        }
      })
      .catch(() => {
        /* watchdog polling must never crash a run */
      });
  }, watchdogMs);
  watchdog.unref?.();

  let result: RunnerResult;
  try {
    result = await adapter.runTask({
      task,
      project,
      vision,
      model,
      effort,
      config: deps.config,
      judgeFeedback: task.judgeFeedback,
      onHeartbeat: (note: string) => {
        db.appendEvent('run-heartbeat', task.id, { runId: run.id, note });
      },
      logsDir,
      worktreesDir,
      signal: abort.signal,
    });
  } catch (err) {
    result = {
      outcome: 'error',
      exitCode: null,
      branch: null,
      summary: redact(errMessage(err)),
      logPath: '',
      startedAt: run.startedAt,
      endedAt: nowFn(),
    };
  } finally {
    runDone = true;
    clearInterval(watchdog);
  }
  // A watchdog abort is a quota stop regardless of how the runner reported it.
  if (abort.signal.aborted && result.outcome !== 'quota') {
    result = { ...result, outcome: 'quota', summary: `${result.summary}\n[surplus] aborted by usage watchdog.` };
  }

  // Judge — skipped for sessions that never completed (error/timeout/killed/quota).
  let verdict: JudgeVerdict | null = null;
  if (!JUDGE_SKIP.has(result.outcome)) {
    try {
      verdict = await deps.judgeRun({ task, project, vision, result, config: deps.config });
    } catch (err) {
      verdict = { score: 0, reasons: `judge failed: ${redact(errMessage(err))}`, missing: '' };
    }
  }

  const passed = verdict !== null && verdict.score >= deps.config.judgePassScore;
  const finalOutcome: RunOutcome = verdict === null ? result.outcome : passed ? 'passed' : 'failed';

  db.updateRun(run.id, {
    endedAt: result.endedAt,
    outcome: finalOutcome,
    exitCode: result.exitCode,
    branch: result.branch,
    summary: result.summary,
    logPath: result.logPath ? result.logPath : null,
    judgeScore: verdict ? verdict.score : null,
    judgeReasons: verdict ? verdict.reasons : null,
    judgeMissing: verdict ? verdict.missing : null,
  });
  if (verdict) {
    db.appendEvent('judge-verdict', task.id, {
      runId: run.id,
      score: verdict.score,
      reasons: verdict.reasons,
      missing: verdict.missing,
      pass: passed,
    });
  }
  db.appendEvent('run-finished', task.id, {
    runId: run.id,
    outcome: finalOutcome,
    exitCode: result.exitCode,
    branch: result.branch,
  });

  // Status transition.
  const fresh = db.getTask(task.id) ?? task;
  if (passed) {
    db.updateTask(task.id, { status: 'done', judgeFeedback: null });
    log(`dispatch: task ${task.id} done (judge ${verdict!.score}/5)`);
  } else {
    // Non-merit interruptions (reserve-watchdog/quota stops, user pause)
    // refund the claim-time attempt increment: the watchdog is DESIGNED to
    // fire near ceilings, and three routine clips must not permanently block
    // a task that never failed on the merits.
    const interrupted =
      verdict === null && (result.outcome === 'quota' || result.outcome === 'killed');
    const blocked = !interrupted && fresh.attempts >= fresh.maxAttempts;
    db.updateTask(task.id, {
      status: blocked ? 'blocked' : 'ready',
      ...(interrupted ? { attempts: Math.max(0, fresh.attempts - 1) } : {}),
      judgeFeedback: buildFeedback(verdict, result, fresh.judgeFeedback),
    });
    log(
      `dispatch: task ${task.id} ${blocked ? 'blocked' : 'requeued'} ` +
        `(attempt ${fresh.attempts}/${fresh.maxAttempts}${interrupted ? ', refunded' : ''}, ` +
        `outcome ${finalOutcome})`,
    );
  }

  // Respawn guard: quota outcomes or auth-looking errors stop the entire tick.
  const respawnGuard =
    result.outcome === 'quota' ||
    (result.outcome === 'error' && AUTH_ERROR_RE.test(result.summary ?? ''));

  return { outcome: finalOutcome, respawnGuard };
}

// ---------------------------------------------------------------------------
// dispatchTick
// ---------------------------------------------------------------------------

export async function dispatchTick(deps: DispatchDeps): Promise<DispatchResult> {
  const nowFn = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const db = deps.db;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const logsDir = deps.logsDir ?? `${home}/${SURPLUS_DIR_NAME}/${LOGS_DIR}`;
  const worktreesDir = deps.worktreesDir ?? `${home}/${SURPLUS_DIR_NAME}/${WORKTREES_DIR}`;

  const results: DispatchResult['results'] = [];
  let launched = 0;

  // Step 1+2: evaluate every enabled provider, compute the burning set.
  let decisions = await evaluateProviders(deps, nowFn);
  let burning = computeBurning(deps, decisions);
  if (burning.length === 0) {
    log('dispatch: no provider in burn mode');
    return { launched, results };
  }

  let rr = 0; // round-robin cursor into `burning`
  let forcedClaimed = false;

  // Step 3: claim/run loop, bounded by maxConcurrent.
  while (db.countRunning() < deps.config.dispatcher.maxConcurrent) {
    if (deps.paused()) {
      log('dispatch: paused — stopping tick');
      break;
    }

    let claimedTask: TaskRow | null = null;
    let claimedProvider: Provider | null = null;
    for (let i = 0; i < burning.length; i++) {
      const provider = burning[(rr + i) % burning.length]!;
      let task: TaskRow | null = null;
      if (deps.forceTaskId) {
        if (!forcedClaimed) {
          // Single guarded UPDATE in the db — atomic against a concurrent
          // tick's claim, so two processes can never run the same task.
          task = db.claimTaskById(deps.forceTaskId, nowFn(), provider);
          if (task) forcedClaimed = true;
        }
      } else {
        // maxConcurrent rides inside the claim transaction so the global
        // concurrency cap holds across processes, not just within this loop.
        task = db.claimNextReadyTask(nowFn(), provider, deps.config.dispatcher.maxConcurrent);
      }
      if (task) {
        claimedTask = task;
        claimedProvider = provider;
        rr = (rr + i + 1) % burning.length;
        break;
      }
    }
    if (!claimedTask || !claimedProvider) break; // nothing claimable for any burning provider

    const adapter = deps.adapters[claimedProvider]!;
    const { outcome, respawnGuard } = await runOne(
      deps,
      claimedTask,
      claimedProvider,
      adapter,
      nowFn,
      log,
      logsDir,
      worktreesDir,
    );
    launched += 1;
    results.push({ taskId: claimedTask.id, provider: claimedProvider, outcome });

    if (respawnGuard) {
      db.appendEvent('decision', null, {
        action: 'stop',
        reason: `respawn guard: ${claimedProvider} auth/quota error`,
      });
      log(`dispatch: respawn guard tripped on ${claimedProvider} — stopping tick`);
      break;
    }

    // Manual burns are one-shot (the /api/burn contract): a forced provider
    // without a taskId must not drain the entire ready queue.
    if (deps.forceTaskId || deps.forceProvider) break;

    // Step 6: re-evaluate cheaply (usage cached by adapters); drop non-burners.
    decisions = await evaluateProviders(deps, nowFn);
    const stillBurning = computeBurning(deps, decisions);
    burning = burning.filter((p) => stillBurning.includes(p));
    if (burning.length === 0) {
      log('dispatch: no provider still burning — stopping tick');
      break;
    }
    rr = rr % burning.length;
  }

  return { launched, results };
}
