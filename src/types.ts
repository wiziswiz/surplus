/**
 * surplus — shared type contracts.
 *
 * Every module imports from this file. Module owners: implement EXACTLY these
 * signatures (exported from the named file) so modules integrate without edits.
 *
 * Module map:
 *   usage.ts            → getUsage() (claude OAuth endpoint), readCredentials() via credentials.ts
 *   providers/claude.ts → ProviderAdapter for claude (wraps usage.ts + runner.ts)
 *   providers/codex.ts  → ProviderAdapter for codex (codex CLI usage probe + `codex exec` runner)
 *   config.ts           → loadConfig(), defaultConfig(), path helpers, isPaused()
 *   decide.ts           → decide() — pure, called once per enabled provider
 *   db.ts               → openDb(), all row CRUD + event append
 *   dispatcher.ts       → dispatchTick() — provider-aware claim + run + judge orchestration
 *   runner.ts           → runTask() claude implementation (worktree + /goal session)
 *   judge.ts            → judgeRun() — always claude, judges either provider's work
 *   vision.ts           → parseVision(), buildGoalCondition(), draftVision(), scaffoldProject()
 *   server.ts           → startServer()
 *   cli.ts              → commander program (entry via bin/surplus.js)
 */

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Subscription providers surplus can burn. Both expose 5h + weekly windows.
 *  - 'claude': Claude Pro/Max via Claude Code. Usage from the OAuth endpoint;
 *              runs via `claude -p "/goal ..."`.
 *  - 'codex':  ChatGPT Plus/Pro via Codex CLI. Usage probed from the local
 *              codex CLI when discoverable, else a config-declared weekly
 *              reset schedule (time-gated burn without utilization feedback);
 *              runs via `codex exec`. The judge→requeue loop supplies the
 *              outer iteration that /goal provides on the claude side.
 */
export type Provider = 'claude' | 'codex';

/** Task affinity: a specific provider, or 'any' = whichever provider is burning. */
export type ProviderPref = Provider | 'any';

// ---------------------------------------------------------------------------
// Usage (per-provider rate-limit windows)
// ---------------------------------------------------------------------------

/** Snapshot of subscription rate-limit windows (claude: GET /api/oauth/usage). */
export interface UsageSnapshot {
  provider: Provider;
  /** Plan display name, e.g. "Max" | "Pro" | "Team". */
  planName: string | null;
  /** 0–100 utilization of the 5-hour window; null if unknown. */
  fiveHourPct: number | null;
  /** 0–100 utilization of the 7-day window; null if unknown. */
  sevenDayPct: number | null;
  fiveHourResetsAt: Date | null;
  sevenDayResetsAt: Date | null;
  /** True when the API call failed and this snapshot is unusable for decisions. */
  unavailable: boolean;
  /** Error tag when unavailable: 'rate-limited' | 'network' | 'timeout' | 'http-401' | ... */
  error?: string;
  /** When this snapshot was fetched (ms epoch). */
  fetchedAt: number;
}

export interface OAuthCredentials {
  accessToken: string;
  subscriptionType: string;
}

// ---------------------------------------------------------------------------
// Config (~/.surplus/config.json)
// ---------------------------------------------------------------------------

export type ModelChoice = 'opus' | 'sonnet' | 'haiku' | (string & {});
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ProviderConfig {
  enabled: boolean;
  defaults: {
    /** claude: opus|sonnet|haiku. codex: e.g. 'gpt-5.1-codex'. */
    model: string;
    /** claude: EffortLevel. codex: reasoning effort string. */
    effort: string;
  };
  /**
   * codex only: when live usage isn't discoverable from the CLI, an ISO
   * timestamp (or 'Thu 21:00' style weekday-time) of a known weekly reset;
   * surplus extrapolates 7-day windows from it and burns time-gated with
   * utilization treated as 0/unknown. null = provider usage unavailable.
   */
  weeklyResetFallback?: string | null;
}

export interface SurplusConfig {
  providers: Record<Provider, ProviderConfig>;
  modes: {
    /** Burn leftover weekly quota in the hours before the 7-day reset. Default ON. */
    weeklySurplus: {
      enabled: boolean;
      /** Enter burn mode when now >= sevenDayResetsAt - burnWindowHours. Default 12. */
      burnWindowHours: number;
      /** Stop burning when 7-day utilization reaches this. Default 95. */
      stopAtPct: number;
    };
    /** aaron-style end-of-5h-window bursts. Default OFF. */
    fiveHourBurst: {
      enabled: boolean;
      /** Trigger when <= this many minutes remain in the 5h window. Default 30. */
      triggerMinutesBeforeReset: number;
      /** Never burst when 7-day utilization is at/above this guard. Default 70. */
      weeklyGuardPct: number;
    };
  };
  pacing: {
    /** Between task launches, wait for 5h reset when 5h utilization >= this. Default 90. */
    fiveHourPausePct: number;
  };
  /**
   * Protected quota floor for OTHER agents sharing the same subscriptions
   * (OpenClaw/Hermes crons, interactive use). surplus treats reserved quota
   * as untouchable: effective weekly stop = min(stopAtPct, 100 - weeklyPct);
   * effective 5h pause = min(fiveHourPausePct, 100 - fiveHourPct). A mid-run
   * watchdog polls usage every watchdogIntervalMinutes and kills the worker
   * (outcome 'quota') if a ceiling is crossed mid-run.
   */
  reserve: {
    /** % of the weekly window always left for other tools. Default 10. */
    weeklyPct: number;
    /** % of the 5h window always left for other tools. Default 25. */
    fiveHourPct: number;
    /** Mid-run usage poll cadence, minutes. Default 5 (matches usage cache TTL). */
    watchdogIntervalMinutes: number;
  };
  dispatcher: {
    /** Max simultaneous running tasks. Default 1. */
    maxConcurrent: number;
    /** Attempts before a task is auto-blocked. Default 3. */
    maxAttempts: number;
    /** Hard wall-clock cap per run, minutes. Default 90. */
    taskTimeoutMinutes: number;
    /** Suggested turn bound embedded in the /goal condition. Default 40. */
    maxTurnsHint: number;
  };
  /** Judge always runs on claude (cheap + reliable JSON). */
  judge: {
    model: ModelChoice;
  };
  board: {
    port: number;
  };
  /** Judge score (1–5) at/above which a run counts as done. Default 4. */
  judgePassScore: number;
}

// ---------------------------------------------------------------------------
// Decision engine
// ---------------------------------------------------------------------------

export type DecisionAction =
  /** Nothing to do; outside burn windows or no quota condition met. */
  | 'idle'
  /** Conditions met: dispatcher may claim and run ready tasks. */
  | 'burn'
  /** In a burn window but 5h window is hot; wait for 5h reset. */
  | 'pace-wait'
  /** Hard stop: weekly target hit, paused, or usage unavailable. */
  | 'stop';

export interface Decision {
  action: DecisionAction;
  /** Human-readable reason, shown in `surplus status` and the board banner. */
  reason: string;
  /** Which mode produced a 'burn' (when action === 'burn'). */
  mode?: 'weeklySurplus' | 'fiveHourBurst';
  /** Suggested next evaluation time (ms epoch), e.g. 5h reset for pace-wait. */
  nextCheckAt?: number;
}

export interface DecideInput {
  /** One provider's snapshot — decide() is called once per enabled provider. */
  usage: UsageSnapshot;
  config: SurplusConfig;
  /** Current time, ms epoch (injected for testability — decide() never reads the system clock). */
  now: number;
  /** True when ~/.surplus/PAUSED exists. */
  paused: boolean;
}

// ---------------------------------------------------------------------------
// Queue: projects, tasks, runs, events (SQLite at ~/.surplus/surplus.db)
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'triage'   // rough idea, not yet specified
  | 'todo'     // specified, not ready to dispatch
  | 'ready'    // dispatcher may claim
  | 'running'  // claimed, a run is in flight
  | 'blocked'  // failed maxAttempts or needs human input
  | 'done'     // judge-passed
  | 'archived';

export interface ProjectRow {
  id: string;            // slug, alphanumeric + dashes ONLY (sanitized at creation)
  name: string;
  path: string;          // absolute path to the git repo
  visionPath: string;    // absolute path to VISION.md within the project
  provider: ProviderPref;      // default 'any'
  model: string | null;        // per-project override (provider-appropriate)
  effort: string | null;       // per-project override
  createdAt: number;
}

export interface TaskRow {
  id: string;            // e.g. 't_<nanoid>' — alphanumeric + underscore ONLY
  projectId: string;
  title: string;
  /** Markdown body: extra context appended to the goal condition. */
  body: string;
  status: TaskStatus;
  /** Lower number = claimed first. Default 100. */
  priority: number;
  attempts: number;
  maxAttempts: number;
  provider: ProviderPref;      // default 'any'; dispatcher matches against the burning provider
  model: string | null;        // per-task override (wins over project & global)
  effort: string | null;
  /** Accumulated judge feedback from failed attempts, prepended to next attempt. */
  judgeFeedback: string | null;
  parentId: string | null;     // promoted to ready only when parent is done
  scheduledAt: number | null;  // skip until this ms epoch
  createdAt: number;
  updatedAt: number;
}

export type RunOutcome =
  | 'passed'        // judge score >= judgePassScore
  | 'failed'        // judge score below pass — will retry or block
  | 'error'         // claude exited non-zero / crashed
  | 'timeout'       // hit taskTimeoutMinutes wall
  | 'quota'         // stopped because usage hit limits mid-run
  | 'killed';       // user paused / SIGTERM

export interface TaskRunRow {
  id: string;
  taskId: string;
  provider: Provider | null;
  startedAt: number;
  endedAt: number | null;
  outcome: RunOutcome | null;
  exitCode: number | null;
  /** Git branch the run committed to, e.g. 'surplus/t_abc123'. */
  branch: string | null;
  /** Worker's final summary text (claude -p result). */
  summary: string | null;
  judgeScore: number | null;        // 1–5
  judgeReasons: string | null;      // judge's reasons text
  judgeMissing: string | null;      // what the judge says is missing
  model: string | null;
  effort: string | null;
  logPath: string | null;           // ~/.surplus/logs/<run-id>.log
}

export type TaskEventType =
  | 'task-created' | 'task-updated' | 'status-changed'
  | 'run-started' | 'run-heartbeat' | 'run-finished'
  | 'judge-verdict' | 'decision' | 'usage';

export interface TaskEventRow {
  id: number;            // autoincrement — SSE clients resume from last seen id
  ts: number;
  taskId: string | null; // null for global events (decision/usage)
  type: TaskEventType;
  /** JSON payload, shape depends on type. */
  data: string;
}

// ---------------------------------------------------------------------------
// Runner & judge
// ---------------------------------------------------------------------------

export interface RunnerResult {
  outcome: RunOutcome;
  exitCode: number | null;
  branch: string | null;
  /** Final text from claude -p (result of the /goal loop). */
  summary: string;
  logPath: string;
  startedAt: number;
  endedAt: number;
}

export interface JudgeVerdict {
  /** 1–5; 0 when the judge itself failed (treated as 'failed', not 'passed'). */
  score: number;
  reasons: string;
  missing: string;
}

// ---------------------------------------------------------------------------
// VISION.md (parsed per-project "research org code" — autoresearch pattern)
// ---------------------------------------------------------------------------

export interface Vision {
  /** Frontmatter overrides. */
  provider: ProviderPref | null;
  model: string | null;
  effort: string | null;
  /** One-paragraph vision statement. */
  statement: string;
  /** Measurable acceptance criteria (markdown list items). */
  criteria: string[];
  /** Shell commands whose success demonstrates the criteria (run by the worker). */
  verifyCommands: string[];
  /** UI flows to walk through (drives agent-browser instructions). */
  uiFlows: string[];
  /** Hard constraints: files/dirs the worker must not touch, behaviors to preserve. */
  guardrails: string[];
  /** Raw markdown (everything), used verbatim in the goal condition. */
  raw: string;
}

// ---------------------------------------------------------------------------
// Board REST/SSE API (server.ts ⇄ board/) — all JSON
// ---------------------------------------------------------------------------
//
//   GET  /api/state                  → ApiState
//   GET  /api/projects               → ProjectRow[]
//   POST /api/projects               → body {path} (existing) | {name} (new) → ProjectRow
//   GET  /api/tasks?status=...       → TaskRow[] (all non-archived when no filter)
//   POST /api/tasks                  → body Partial<TaskRow> & {projectId,title} → TaskRow
//   GET  /api/tasks/:id              → {task: TaskRow, runs: TaskRunRow[], events: TaskEventRow[]}
//   PATCH /api/tasks/:id             → body Partial<Pick<TaskRow,'status'|'priority'|'title'|'body'|'model'|'effort'|'scheduledAt'|'provider'>> → TaskRow ('running' is dispatcher-only)
//   PATCH /api/config                → body deep-partial SurplusConfig (validated by server.ts buildConfigPatch:
//                                      booleans, integer percents 0–100, positive-integer minutes/hours,
//                                      port 1024–65535, non-empty model/effort, provider keys claude|codex)
//                                      → effective SurplusConfig (persisted via the cli-injected updateConfig dep)
//   POST /api/pause | /api/resume    → {paused: boolean}
//   POST /api/burn                   → body {taskId?: string, provider?: Provider} → manual one-shot dispatch (ignores windows, respects pacing)
//   GET  /api/events?after=<id>      → SSE stream of TaskEventRow (named event: 'ev') + periodic 'state' frames (ApiState)
//
export interface ApiState {
  /** Per-provider snapshots; key absent when the provider is disabled. */
  usage: Partial<Record<Provider, UsageSnapshot | null>>;
  /** Per-provider decisions; key absent when the provider is disabled. */
  decisions: Partial<Record<Provider, Decision>>;
  paused: boolean;
  config: SurplusConfig;
  /** Running tasks' ids for the board's live indicators. */
  running: string[];
}

// ---------------------------------------------------------------------------
// Provider adapter (providers/claude.ts, providers/codex.ts)
// ---------------------------------------------------------------------------

export interface RunTaskArgs {
  task: TaskRow;
  project: ProjectRow;
  vision: Vision;
  model: string;
  effort: string;
  config: SurplusConfig;
  judgeFeedback?: string | null;
  onHeartbeat?: (note: string) => void;
  logsDir: string;
  worktreesDir: string;
  /**
   * Aborted by the dispatcher's usage watchdog when a reserve ceiling is
   * crossed mid-run. Runners SIGTERM the worker and return outcome 'quota'
   * (which also trips the dispatch respawn guard).
   */
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  provider: Provider;
  /**
   * Live usage snapshot; null when this provider has no credentials/CLI.
   * `fresh: true` (manual refresh) narrows the success-cache window to a
   * 30s floor — it never overrides an active 429 backoff.
   */
  getUsage(opts?: { fresh?: boolean }): Promise<UsageSnapshot | null>;
  /** Execute one work session in a worktree; outcome 'failed' = completed-pending-judge. */
  runTask(args: RunTaskArgs): Promise<RunnerResult>;
}

// ---------------------------------------------------------------------------
// Paths (single source of truth — config.ts exports helpers built on these)
// ---------------------------------------------------------------------------

export const SURPLUS_DIR_NAME = '.surplus';      // ~/.surplus
export const DB_FILE = 'surplus.db';             // ~/.surplus/surplus.db
export const CONFIG_FILE = 'config.json';        // ~/.surplus/config.json
export const PAUSED_FILE = 'PAUSED';             // ~/.surplus/PAUSED (kill switch)
export const LOGS_DIR = 'logs';                  // ~/.surplus/logs/
export const WORKTREES_DIR = 'worktrees';        // ~/.surplus/worktrees/<task-id>
export const USAGE_CACHE_FILE = '.usage-cache.json';
