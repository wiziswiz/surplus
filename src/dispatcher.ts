/**
 * surplus — dispatcher: account-aware claim + run + judge orchestration.
 *
 * Fully dependency-injected: imports only contracts from types.js (plus the
 * type-only SurplusDb shape from db.js), so it unit-tests with fakes.
 */
import {
  LOGS_DIR,
  SURPLUS_DIR_NAME,
  WORKTREES_DIR,
  type AccountAdapter,
  type DecideInput,
  type Decision,
  type JudgeVerdict,
  type ProjectRow,
  type Provider,
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
  /** Burnable accounts (claudeAccountAdapters + codexAccountAdapter), config order. */
  accounts: AccountAdapter[];
  decideFn: (input: DecideInput) => Decision;
  /** Judge ALWAYS runs on the main claude account, regardless of which account did the work. */
  judgeRun: (args: JudgeRunArgs) => Promise<JudgeVerdict>;
  loadVision: (project: ProjectRow) => Vision;
  now?: () => number;
  /** True when ~/.surplus/PAUSED exists. Checked live (kill switch). */
  paused: () => boolean;
  log?: (msg: string) => void;
  /**
   * Manual burn: skip decide() window gating ('idle'/'stop') for the matching
   * accounts. Accepts an AccountKey ('claude', 'claude:work', 'codex') to pin
   * one account, OR a provider name ('claude'|'codex') = every account of
   * that provider in AUTO burn order. Never overrides pause or 'pace-wait'.
   * (NOTE: 'claude' is both the provider name and the main account's key —
   * matching by key-or-provider makes the two readings equivalent.)
   */
  forceProvider?: string;
  /** Manual burn: claim exactly this task (must be 'ready' and account-compatible). */
  forceTaskId?: string;
  /** Defaults to ~/.surplus/logs and ~/.surplus/worktrees. */
  logsDir?: string;
  worktreesDir?: string;
}

export interface DispatchResult {
  launched: number;
  /** `provider` carries the claiming ACCOUNT key ('claude' | 'claude:<id>' | 'codex'). */
  results: Array<{ taskId: string; provider: string; outcome: string }>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Outcomes where judging is pointless — the work session never completed. */
const JUDGE_SKIP: ReadonlySet<RunOutcome> = new Set([
  'error',
  'timeout',
  'killed',
  'quota',
  'infra', // transient API-unreachable blip — there is nothing to judge
]);

/**
 * Max CONSECUTIVE 'infra' outcomes that get the attempt refunded before we stop
 * refunding and let the run count toward maxAttempts. Bounds token/churn cost: a
 * genuinely-unreachable API fails fast (~0 tokens), but a persistently broken
 * network — or a misclassified failure — must not retry-zombie a full session
 * every tick forever, never blocking. Reset to 0 on any non-infra outcome.
 */
const INFRA_STREAK_CAP = 3;

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

interface AccountEval {
  account: AccountAdapter;
  usage: UsageSnapshot;
  decision: Decision;
}

/**
 * Step 1: per account of an enabled provider, fetch usage (adapters cache
 * PER ACCOUNT), run decide(), and append 'usage' + 'decision' events tagged
 * with both the provider and the account key.
 */
async function evaluateAccounts(deps: DispatchDeps, nowFn: () => number): Promise<AccountEval[]> {
  const evals: AccountEval[] = [];
  for (const account of deps.accounts) {
    if (!deps.config.providers[account.provider]?.enabled) continue;

    let usage: UsageSnapshot | null = null;
    let usageError = 'usage-unavailable';
    try {
      usage = await account.getUsage();
    } catch (err) {
      usageError = redact(errMessage(err));
      usage = null;
    }
    const snapshot = usage ?? unavailableSnapshot(account.provider, nowFn(), usageError);
    const decision = deps.decideFn({
      usage: snapshot,
      config: deps.config,
      now: nowFn(),
      paused: deps.paused(),
    });
    deps.db.appendEvent('usage', null, {
      ...snapshot,
      provider: account.provider,
      account: account.key,
    });
    deps.db.appendEvent('decision', null, {
      provider: account.provider,
      account: account.key,
      ...decision,
    });
    evals.push({ account, usage: snapshot, decision });
  }
  return evals;
}

/**
 * AUTO burn order among burn-eligible accounts (pure, exported for tests):
 *   1. manual priority asc (null = +Infinity, i.e. manual always wins);
 *   2. sevenDayResetsAt asc — the soonest-expiring quota burns first
 *      (unknown reset sorts last);
 *   3. sevenDayPct asc — most weekly surplus left burns first (unknown
 *      utilization sorts last).
 * Manual priority only REORDERS eligible accounts — windows/reserves still
 * gate each account independently via its own decide() call.
 */
export function orderBurning(
  candidates: Array<{ account: AccountAdapter; usage: UsageSnapshot | null }>,
): AccountAdapter[] {
  const resetAt = (u: UsageSnapshot | null): number =>
    u?.sevenDayResetsAt ? u.sevenDayResetsAt.getTime() : Number.POSITIVE_INFINITY;
  const usedPct = (u: UsageSnapshot | null): number => u?.sevenDayPct ?? Number.POSITIVE_INFINITY;
  return [...candidates]
    .sort(
      (a, b) =>
        (a.account.priority ?? Number.POSITIVE_INFINITY) -
          (b.account.priority ?? Number.POSITIVE_INFINITY) ||
        resetAt(a.usage) - resetAt(b.usage) ||
        usedPct(a.usage) - usedPct(b.usage),
    )
    .map((c) => c.account);
}

/** Step 2: accounts allowed to burn this tick, in AUTO burn order. */
function computeBurning(deps: DispatchDeps, evals: AccountEval[]): AccountAdapter[] {
  if (deps.forceProvider) {
    // Force overrides decide() window gating ('idle'/'stop'), but never the
    // kill switch, and — per the /api/burn contract "ignores windows,
    // respects pacing" — never a 'pace-wait' (which already folds in the
    // reserve 5h floor). An AccountKey pins one account; a provider name
    // matches every account of that provider.
    if (deps.paused()) return [];
    const matched = evals.filter(
      (e) => e.account.key === deps.forceProvider || e.account.provider === deps.forceProvider,
    );
    return orderBurning(matched.filter((e) => e.decision.action !== 'pace-wait'));
  }
  return orderBurning(evals.filter((e) => e.decision.action === 'burn'));
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
  account: AccountAdapter,
  nowFn: () => number,
  log: (msg: string) => void,
  logsDir: string,
  worktreesDir: string,
): Promise<RunOneOutcome> {
  const db = deps.db;
  const provider = account.provider;

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
  db.appendEvent('run-started', task.id, {
    runId: run.id,
    provider,
    account: account.key,
    model,
    effort,
  });
  log(`dispatch: run ${run.id} started for task ${task.id} on ${account.key} (${model}/${effort})`);

  // Mid-run usage watchdog: polls the CLAIMING ACCOUNT's usage on a cadence
  // and aborts the worker when a reserve ceiling is crossed, so a long run
  // can't starve other agents (OpenClaw/Hermes crons) sharing that account's
  // subscription. Reserve floors apply PER ACCOUNT: each account's own
  // getUsage feeds its own ceilings.
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
    void account
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
    // The account adapter injects its own configDir/accountKey into the
    // runner args (see providers/claude.ts) — nothing account-specific to
    // pass here.
    result = await account.runTask({
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
    db.updateTask(task.id, { status: 'done', judgeFeedback: null, consecutiveInfra: 0 });
    log(`dispatch: task ${task.id} done (judge ${verdict!.score}/5)`);
  } else if (result.outcome === 'infra') {
    // Transient infra error (lost API connection / network blip / server 5xx):
    // the run DID NOT COMPLETE — this is not the task failing. Refund the
    // claim-time attempt increment and requeue to 'ready' so a single wifi hiccup
    // never permanently blocks good work. The tick also halts below (respawn-guard
    // style), so retries are rate-limited to one per tick (~15 min).
    //
    // BUT bound the churn: after INFRA_STREAK_CAP consecutive infra outcomes, stop
    // refunding and let the attempt stand so maxAttempts eventually blocks —
    // otherwise a persistently broken network (or a misclassified failure) would
    // retry-zombie a full session every tick forever.
    const reason = redact((result.summary ?? '').split('\n')[0] ?? '').slice(0, 160) || 'API unreachable';
    const streak = (fresh.consecutiveInfra ?? 0) + 1;
    if (streak >= INFRA_STREAK_CAP) {
      const blocked = fresh.attempts >= fresh.maxAttempts;
      db.updateTask(task.id, {
        status: blocked ? 'blocked' : 'ready',
        consecutiveInfra: streak,
        judgeFeedback: buildFeedback(verdict, result, fresh.judgeFeedback),
      });
      log(
        `dispatch: task ${task.id} ${blocked ? 'blocked' : 'requeued'} (infra streak ${streak} ` +
          `≥ cap ${INFRA_STREAK_CAP} — attempt now counted ${fresh.attempts}/${fresh.maxAttempts}; reason: ${reason})`,
      );
    } else {
      db.updateTask(task.id, {
        status: 'ready',
        attempts: Math.max(0, fresh.attempts - 1),
        consecutiveInfra: streak,
        judgeFeedback: buildFeedback(verdict, result, fresh.judgeFeedback),
      });
      log(
        `dispatch: task ${task.id} requeued (infra error, attempt refunded — run did not ` +
          `complete; streak ${streak}/${INFRA_STREAK_CAP}; reason: ${reason})`,
      );
    }
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
      consecutiveInfra: 0,
      judgeFeedback: buildFeedback(verdict, result, fresh.judgeFeedback),
    });
    log(
      `dispatch: task ${task.id} ${blocked ? 'blocked' : 'requeued'} ` +
        `(attempt ${fresh.attempts}/${fresh.maxAttempts}${interrupted ? ', refunded' : ''}, ` +
        `outcome ${finalOutcome})`,
    );
  }

  // Respawn guard: quota outcomes, transient infra errors, or auth-looking
  // errors stop the entire tick. For 'infra' it's pointless to immediately
  // re-run into an unreachable API — the next 15-min tick (or next manual burn)
  // retries naturally, which also bounds churn to one infra retry per tick.
  const respawnGuard =
    result.outcome === 'quota' ||
    result.outcome === 'infra' ||
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

  // Step 1+2: evaluate every account, compute the AUTO-ordered burning set.
  let burning = computeBurning(deps, await evaluateAccounts(deps, nowFn));
  if (burning.length === 0) {
    log('dispatch: no account in burn mode');
    return { launched, results };
  }

  let forcedClaimed = false;

  // Step 3: claim/run loop, bounded by maxConcurrent. Accounts are tried in
  // burn order — the most-preferred burning account claims first every cycle.
  while (db.countRunning() < deps.config.dispatcher.maxConcurrent) {
    if (deps.paused()) {
      log('dispatch: paused — stopping tick');
      break;
    }

    let claimedTask: TaskRow | null = null;
    let claimedAccount: AccountAdapter | null = null;
    for (const account of burning) {
      let task: TaskRow | null = null;
      if (deps.forceTaskId) {
        if (!forcedClaimed) {
          // Single guarded UPDATE in the db — atomic against a concurrent
          // tick's claim, so two processes can never run the same task.
          task = db.claimTaskById(deps.forceTaskId, nowFn(), account.provider, account.key);
          if (task) forcedClaimed = true;
        }
      } else {
        // maxConcurrent rides inside the claim transaction so the global
        // concurrency cap holds across processes, not just within this loop.
        // Affinity match: task 'any' | account.provider | account.key.
        task = db.claimNextReadyTask(
          nowFn(),
          account.provider,
          deps.config.dispatcher.maxConcurrent,
          account.key,
        );
      }
      if (task) {
        claimedTask = task;
        claimedAccount = account;
        break;
      }
    }
    if (!claimedTask || !claimedAccount) break; // nothing claimable for any burning account

    const { outcome, respawnGuard } = await runOne(
      deps,
      claimedTask,
      claimedAccount,
      nowFn,
      log,
      logsDir,
      worktreesDir,
    );
    launched += 1;
    results.push({ taskId: claimedTask.id, provider: claimedAccount.key, outcome });

    if (respawnGuard) {
      // 'infra' gets a distinct, accurate stop reason: the API was unreachable,
      // so we halt this tick and let the next 15-min tick / next manual burn
      // retry naturally (the attempt was refunded, the task is back to 'ready').
      const reason =
        outcome === 'infra'
          ? `infra error: ${claimedAccount.provider} API unreachable — will retry next tick`
          : `respawn guard: ${claimedAccount.key} auth/quota error`;
      db.appendEvent('decision', null, { action: 'stop', reason });
      log(
        outcome === 'infra'
          ? `dispatch: infra error on ${claimedAccount.key} (API unreachable) — stopping tick, will retry next tick`
          : `dispatch: respawn guard tripped on ${claimedAccount.key} — stopping tick`,
      );
      break;
    }

    // Manual burns are one-shot (the /api/burn contract): a forced account
    // without a taskId must not drain the entire ready queue.
    if (deps.forceTaskId || deps.forceProvider) break;

    // Step 6: re-evaluate cheaply (usage cached per account); drop accounts
    // that stopped burning and adopt the fresh AUTO order (quota shifts as we
    // burn) — but never ADD accounts that were not burning at tick start.
    const stillBurning = computeBurning(deps, await evaluateAccounts(deps, nowFn));
    const startKeys = new Set(burning.map((a) => a.key));
    burning = stillBurning.filter((a) => startKeys.has(a.key));
    if (burning.length === 0) {
      log('dispatch: no account still burning — stopping tick');
      break;
    }
  }

  return { launched, results };
}
