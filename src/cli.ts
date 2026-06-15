/**
 * surplus — commander composition root. Entry via bin/surplus.js → dist/cli.js.
 *
 * Wires every module per the types.ts module map. Nothing is written to
 * ~/.surplus at import time — side effects happen only inside command actions
 * (so `surplus --help` stays pure).
 */
import { Command, InvalidArgumentError, Option } from 'commander';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import type {
  AccountAdapter,
  Decision,
  ProjectRow,
  Provider,
  ProviderPref,
  SurplusConfig,
  TaskEventRow,
  TaskEventType,
  TaskRow,
  TaskRunRow,
  TaskStatus,
  UsageSnapshot,
  Vision,
} from './types.js';

import {
  loadConfig,
  saveConfig,
  ensureDirs,
  isPaused,
  setPaused,
  configPath,
  worktreesDir as worktreesDirPath,
} from './config.js';
import { decide } from './decide.js';
import { openDb } from './db.js';
import type { SurplusDb, TaskPatch } from './db.js';
import { dispatchTick } from './dispatcher.js';
import type { DispatchDeps, DispatchResult } from './dispatcher.js';
import { claudeAccountAdapters } from './providers/claude.js';
import { codexAccountAdapter } from './providers/codex.js';
import { parseVision, draftVision, scaffoldProject as scaffoldProjectDir } from './vision.js';
import { judgeRun } from './judge.js';
import { startServer, applyConfigPatch } from './server.js';
import type { ServerDb, ConfigPatch } from './server.js';
import {
  boardPlistPath,
  installBoardLaunchd,
  installDockApp,
  installLaunchd,
  launchdPlistPath,
  uninstallBoardLaunchd,
  uninstallDockApp,
  uninstallLaunchd,
} from './install.js';

const VERSION = '0.1.0';
const TASK_STATUSES: TaskStatus[] = ['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived'];

/** Task/project affinity grammar: provider, 'any', or a claude account key. */
const PROVIDER_PREF_RE = /^(claude|codex|any|claude:[a-z0-9-]{1,24})$/;

// ---------------------------------------------------------------------------
// Shared deps (built once per action, never at import time)
// ---------------------------------------------------------------------------

export type CliDeps = DispatchDeps & { now: () => number };

function emptyVision(): Vision {
  return {
    provider: null,
    model: null,
    effort: null,
    statement: '',
    criteria: [],
    verifyCommands: [],
    uiFlows: [],
    guardrails: [],
    raw: '',
  };
}

function buildDeps(nowFn: () => number = () => Date.now()): CliDeps {
  ensureDirs();
  const config: SurplusConfig = loadConfig();
  const db: SurplusDb = openDb();
  // One adapter per burnable account: every enabled claude account (main
  // keeps key 'claude'), plus the single codex account when enabled.
  const accounts: AccountAdapter[] = [
    ...claudeAccountAdapters(config),
    ...(config.providers.codex.enabled ? [codexAccountAdapter(config)] : []),
  ];
  return {
    db,
    config,
    accounts,
    decideFn: decide,
    judgeRun: (args) =>
      judgeRun({
        task: args.task,
        project: args.project,
        vision: args.vision,
        run: {
          branch: args.result.branch,
          summary: args.result.summary,
          logPath: args.result.logPath,
        },
        judgeModel: config.judge.model,
        projectPath: args.project.path,
        // Ephemeral judge worktree lives under ~/.surplus/worktrees as
        // judge-<taskId> (distinct from the live run's <taskId> worktree).
        worktreesDir: worktreesDirPath(),
      }),
    loadVision: (project: ProjectRow): Vision => {
      try {
        return parseVision(readFileSync(project.visionPath, 'utf8'));
      } catch {
        return emptyVision();
      }
    },
    now: nowFn,
    paused: () => isPaused(),
    log: (msg: string) => console.log(redact(msg)),
  };
}

/**
 * Reject a 'claude:<id>' affinity that names no configured account — a task
 * or project pinned to it would sit in 'ready' forever (the claim predicate
 * never matches an unknown key, and nothing warns).
 */
function assertKnownProviderPref(deps: CliDeps, pref: ProviderPref): void {
  if (!pref.startsWith('claude:')) return;
  if (!deps.accounts.some((a) => a.key === pref)) {
    throw new Error(`unknown claude account '${pref}' — add it to providers.claude.accounts first`);
  }
}

/** True when `target` (an account key or provider name) matches a configured account. */
function matchesAccount(deps: CliDeps, target: string): boolean {
  return deps.accounts.some((a) => a.key === target || a.provider === target);
}

/**
 * Account key / provider name to force for a manual burn: explicit flag wins,
 * then the task's own affinity (when specific + matching a configured
 * account), then the first configured account's key.
 */
function pickForcedProvider(deps: CliDeps, taskId?: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (taskId) {
    const t = deps.db.getTask(taskId);
    if (t && t.provider !== 'any' && matchesAccount(deps, t.provider)) return t.provider;
  }
  return deps.accounts[0]?.key;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Scrub anything token-shaped from error text before it reaches a terminal/log. */
export function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/("?(?:access|refresh)_?token"?\s*[:=]\s*)"[^"]*"/gi, '$1"[redacted]"');
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`cannot derive a project id from name "${name}"`);
  return slug;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function fmtPct(pct: number | null): string {
  return pct === null ? '—' : `${Math.round(pct)}%`;
}

function fmtCountdown(at: Date | null, nowMs: number): string {
  if (!at) return '—';
  const ms = at.getTime() - nowMs;
  if (ms <= 0) return 'now';
  const totalMin = Math.round(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function fmtTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function usageLine(u: UsageSnapshot, nowMs: number): string {
  if (u.unavailable) return `usage unavailable (${u.error ?? 'unknown'})`;
  const plan = u.planName ?? '?';
  return (
    `${plan} · 5h ${fmtPct(u.fiveHourPct)} (reset ${fmtCountdown(u.fiveHourResetsAt, nowMs)})` +
    ` · 7d ${fmtPct(u.sevenDayPct)} (reset ${fmtCountdown(u.sevenDayResetsAt, nowMs)})`
  );
}

function decisionLine(d: Decision): string {
  return `${d.action}${d.mode ? ` [${d.mode}]` : ''} — ${d.reason}`;
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(headers));
  for (const r of rows) console.log(line(r));
}

function printDispatchResult(result: DispatchResult): void {
  if (result.launched === 0) {
    console.log('nothing dispatched (no claimable task for any burning provider).');
    return;
  }
  console.log(`dispatched ${result.launched} task(s):`);
  for (const r of result.results) console.log(`  ${r.taskId} [${r.provider}] → ${r.outcome}`);
}

function unavailableSnapshot(provider: Provider, nowMs: number, error: string): UsageSnapshot {
  return {
    provider,
    planName: null,
    fiveHourPct: null,
    sevenDayPct: null,
    fiveHourResetsAt: null,
    sevenDayResetsAt: null,
    unavailable: true,
    error,
    fetchedAt: nowMs,
  };
}

/** Per-ACCOUNT usage snapshots keyed by account key. */
async function fetchUsage(
  deps: CliDeps,
  accounts: AccountAdapter[],
): Promise<Record<string, UsageSnapshot>> {
  const out: Record<string, UsageSnapshot> = {};
  await Promise.all(
    accounts.map(async (account) => {
      let snap: UsageSnapshot | null = null;
      try {
        snap = await account.getUsage();
      } catch {
        out[account.key] = unavailableSnapshot(account.provider, deps.now(), 'adapter-error');
        return;
      }
      out[account.key] = snap ?? unavailableSnapshot(account.provider, deps.now(), 'no-credentials');
    }),
  );
  return out;
}

/**
 * What the dispatcher would claim next for an account (display only — the
 * real claim is db.claimNextReadyTask). Mirrors its exclusions: ready,
 * affinity-compatible ('any' | provider | account key), not scheduled into
 * the future, parent done when set, project has no running task; lowest
 * priority number then oldest first.
 */
function nextClaimable(deps: CliDeps, account: AccountAdapter, nowMs: number): TaskRow | null {
  const ready = deps.db.listTasks({ status: 'ready' });
  const doneIds = new Set(deps.db.listTasks({ status: 'done' }).map((t) => t.id));
  const runningProjects = new Set(deps.db.listTasks({ status: 'running' }).map((t) => t.projectId));
  const eligible = ready.filter(
    (t) =>
      (t.provider === 'any' || t.provider === account.provider || t.provider === account.key) &&
      (t.scheduledAt === null || t.scheduledAt <= nowMs) &&
      (t.parentId === null || doneIds.has(t.parentId)) &&
      !runningProjects.has(t.projectId),
  );
  eligible.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  return eligible[0] ?? null;
}

function wrap<A extends unknown[]>(
  fn: (...args: A) => void | Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`error: ${redact(err instanceof Error ? err.message : String(err))}`);
      process.exitCode = 1;
    }
  };
}

/** Affinity option validating the extended grammar (claude|codex|any|claude:<id>). */
const providerPrefOption = (description: string) =>
  new Option('--provider <provider>', `${description} (claude|codex|any|claude:<account-id>)`)
    .argParser((value: string): ProviderPref => {
      if (!PROVIDER_PREF_RE.test(value)) {
        throw new InvalidArgumentError('must be claude, codex, any, or claude:<account-id>');
      }
      return value as ProviderPref;
    })
    .default('any');

// ---------------------------------------------------------------------------
// ServerDb adapter (SurplusDb → the structural interface server.ts expects)
// ---------------------------------------------------------------------------

interface RawEventRow {
  id: number;
  ts: number;
  task_id: string | null;
  type: string;
  data: string;
}

function toEventRow(r: RawEventRow): TaskEventRow {
  return { id: r.id, ts: r.ts, taskId: r.task_id, type: r.type as TaskEventType, data: r.data };
}

function toServerDb(db: SurplusDb): ServerDb {
  return {
    listProjects: () => db.listProjects(),
    getProject: (id) => db.getProject(id),
    insertProject: (row) => {
      db.createProject({
        id: row.id,
        name: row.name,
        path: row.path,
        visionPath: row.visionPath,
        provider: row.provider,
        model: row.model,
        effort: row.effort,
        createdAt: row.createdAt,
      });
    },
    listTasks: (status?: TaskStatus) => db.listTasks(status ? { status } : undefined),
    getTask: (id) => db.getTask(id),
    insertTask: (row) => {
      db.createTask({
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        body: row.body,
        status: row.status,
        priority: row.priority,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        provider: row.provider,
        model: row.model,
        effort: row.effort,
        judgeFeedback: row.judgeFeedback,
        parentId: row.parentId,
        scheduledAt: row.scheduledAt,
        createdAt: row.createdAt,
      });
    },
    updateProject: (id, patch) => db.updateProject(id, patch),
    deleteProject: (id) => db.deleteProject(id),
    updateTask: (id, patch) => db.updateTask(id, patch as TaskPatch),
    listRuns: (taskId) => db.listRunsForTask(taskId),
    listEventsForTask: (taskId, limit = 200) => {
      const rows = db.raw
        .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?')
        .all(taskId, limit) as RawEventRow[];
      return rows.reverse().map(toEventRow);
    },
    eventsAfter: (afterId, limit) => db.listEventsAfter(afterId, limit),
    lastEvents: (limit) => {
      const rows = db.raw
        .prepare('SELECT * FROM task_events ORDER BY id DESC LIMIT ?')
        .all(limit) as RawEventRow[];
      return rows.reverse().map(toEventRow);
    },
    appendEvent: (type, taskId, data) => db.appendEvent(type, taskId, (data ?? {}) as object),
  };
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name('surplus')
  .description('Burn expiring AI-subscription quota (Claude Code, Codex CLI) on backlog projects')
  .version(VERSION);

// --- tick -------------------------------------------------------------------

program
  .command('tick')
  .description('Evaluate burn windows per provider and dispatch ready tasks')
  .option('--dry-run', 'print decisions and the next claimable task without running anything')
  .option('--simulate-time <iso>', 'evaluate as if the clock read this ISO timestamp')
  .action(
    wrap(async (opts: { dryRun?: boolean; simulateTime?: string }) => {
      let nowFn = () => Date.now();
      if (opts.simulateTime) {
        const t = Date.parse(opts.simulateTime);
        if (Number.isNaN(t)) throw new Error(`invalid --simulate-time: ${opts.simulateTime}`);
        nowFn = () => t;
      }
      const deps = buildDeps(nowFn);
      const paused = isPaused();
      if (deps.accounts.length === 0) {
        console.log('no providers enabled — see `surplus config`');
        return;
      }
      const usage = await fetchUsage(deps, deps.accounts);
      const burning: AccountAdapter[] = [];
      const pad = Math.max(7, ...deps.accounts.map((a) => a.key.length));
      for (const account of deps.accounts) {
        const u = usage[account.key]!;
        const d: Decision = decide({ usage: u, config: deps.config, now: deps.now(), paused });
        console.log(`${account.key.padEnd(pad)} ${usageLine(u, deps.now())}`);
        console.log(`${' '.repeat(pad)} → ${decisionLine(d)}`);
        if (d.action === 'burn') burning.push(account);
      }
      if (paused) console.log('paused: yes (~/.surplus/PAUSED)');
      if (burning.length === 0) {
        console.log('nothing to do.');
        return;
      }
      if (opts.dryRun) {
        const projects = new Map(deps.db.listProjects().map((pr) => [pr.id, pr.name] as const));
        for (const account of burning) {
          const next = nextClaimable(deps, account, deps.now());
          console.log(
            next
              ? `${account.key}: would claim ${next.id} "${truncate(next.title, 60)}" ` +
                  `(priority ${next.priority}, project ${projects.get(next.projectId) ?? next.projectId})`
              : `${account.key}: burn window open but no claimable task`,
          );
        }
        return;
      }
      console.log(`dispatching (${burning.map((a) => a.key).join(', ')})…`);
      printDispatchResult(await dispatchTick(deps));
    }),
  );

// --- status ------------------------------------------------------------------

program
  .command('status')
  .description('Provider usage, decisions, queue counts, running task, recent runs')
  .action(
    wrap(async () => {
      const deps = buildDeps();
      const paused = isPaused();
      if (deps.accounts.length === 0) {
        console.log('no providers enabled — see `surplus config`');
      } else {
        const usage = await fetchUsage(deps, deps.accounts);
        printTable(
          ['ACCOUNT', 'LABEL', 'PLAN', '5H', 'RESET', '7D', 'RESET', 'DECISION'],
          deps.accounts.map((account) => {
            const u = usage[account.key]!;
            const d = decide({ usage: u, config: deps.config, now: deps.now(), paused });
            return [
              account.key,
              account.label,
              u.planName ?? '—',
              u.unavailable ? '!' : fmtPct(u.fiveHourPct),
              fmtCountdown(u.fiveHourResetsAt, deps.now()),
              u.unavailable ? '!' : fmtPct(u.sevenDayPct),
              fmtCountdown(u.sevenDayResetsAt, deps.now()),
              decisionLine(d),
            ];
          }),
        );
      }
      console.log('');
      console.log(`paused:  ${paused ? 'yes (~/.surplus/PAUSED — `surplus resume` to clear)' : 'no'}`);
      const counts = TASK_STATUSES.map((s) => `${s} ${deps.db.listTasks({ status: s }).length}`).join(' · ');
      console.log(`queue:   ${counts}`);
      const running = deps.db.listTasks({ status: 'running' });
      console.log(
        running.length
          ? `running: ${running.map((t) => `${t.id} "${truncate(t.title, 48)}"`).join(', ')}`
          : 'running: —',
      );
      const recentRuns: TaskRunRow[] = deps.db
        .listTasks()
        .flatMap((t) => deps.db.listRunsForTask(t.id))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 3);
      if (recentRuns.length > 0) {
        console.log('last runs:');
        for (const r of recentRuns) {
          console.log(
            `  ${fmtTs(r.startedAt)}  ${(r.provider ?? '?').padEnd(6)} ` +
              `${(r.outcome ?? 'running').padEnd(7)} judge ${r.judgeScore ?? '—'}  ${r.taskId}`,
          );
        }
      }
    }),
  );

// --- pause / resume -----------------------------------------------------------

program
  .command('pause')
  .description('Stop launching new tasks (kill switch: ~/.surplus/PAUSED)')
  .action(
    wrap(() => {
      ensureDirs();
      setPaused(true);
      console.log('Paused. A running task will finish its current run; nothing new will start.');
      console.log('`surplus resume` to continue.');
    }),
  );

program
  .command('resume')
  .description('Clear the pause kill switch')
  .action(
    wrap(() => {
      ensureDirs();
      setPaused(false);
      console.log('Resumed. The next tick may dispatch tasks again.');
    }),
  );

// --- add / new ----------------------------------------------------------------

program
  .command('add <path>')
  .description('Register an existing git repo as a surplus project')
  .option('--name <name>', 'project name (default: directory basename)')
  .addOption(providerPrefOption('default provider affinity for this project'))
  .option('--model <model>', 'per-project model override (stored on the project row)')
  .option('--effort <effort>', 'per-project effort override (stored on the project row)')
  .action(
    wrap(async (
      pathArg: string,
      opts: { name?: string; provider: ProviderPref; model?: string; effort?: string },
    ) => {
      const projPath = resolve(pathArg);
      if (!existsSync(projPath) || !statSync(projPath).isDirectory()) {
        throw new Error(`not a directory: ${projPath}`);
      }
      if (!existsSync(join(projPath, '.git'))) {
        throw new Error(`not a git repository: ${projPath} (run \`git init\` first)`);
      }
      const deps = buildDeps();
      assertKnownProviderPref(deps, opts.provider);
      const name = opts.name ?? basename(projPath);
      const id = slugify(name);
      const visionPath = join(projPath, 'VISION.md');
      let drafted = false;
      if (!existsSync(visionPath)) {
        console.log('No VISION.md found — drafting one…');
        const markdown = await draftVision(projPath);
        writeFileSync(visionPath, markdown);
        drafted = true;
      }
      const project = deps.db.createProject({
        id,
        name,
        path: projPath,
        visionPath,
        provider: opts.provider,
        model: opts.model ?? null,
        effort: opts.effort ?? null,
      });
      console.log(`Added project ${project.id} → ${project.path}`);
      if (drafted) {
        console.log(`Drafted ${visionPath} — review and edit it before burning quota on this project.`);
      }
      console.log('Next steps:');
      console.log(`  surplus task create ${project.id} "Your first task"`);
      console.log('  surplus tick --dry-run');
    }),
  );

program
  .command('new <name>')
  .description('Scaffold a fresh project under ~/Projects/<slug> and register it')
  .addOption(providerPrefOption('default provider affinity for this project'))
  .option('--model <model>', 'per-project model override (stored on the project row)')
  .option('--effort <effort>', 'per-project effort override (stored on the project row)')
  .action(
    wrap(async (name: string, opts: { provider: ProviderPref; model?: string; effort?: string }) => {
      const deps = buildDeps();
      assertKnownProviderPref(deps, opts.provider);
      const slug = slugify(name);
      const dir = join(homedir(), 'Projects', slug);
      if (existsSync(dir)) {
        throw new Error(`already exists: ${dir} — use \`surplus add ${dir}\` instead`);
      }
      scaffoldProjectDir(dir, name);
      console.log(`Scaffolded ${dir}`);
      const visionPath = join(dir, 'VISION.md');
      let drafted = false;
      if (!existsSync(visionPath)) {
        console.log('Scaffold has no VISION.md — drafting one…');
        const markdown = await draftVision(dir);
        writeFileSync(visionPath, markdown);
        drafted = true;
      }
      const project = deps.db.createProject({
        id: slug,
        name,
        path: dir,
        visionPath,
        provider: opts.provider,
        model: opts.model ?? null,
        effort: opts.effort ?? null,
      });
      console.log(`Added project ${project.id} → ${project.path}`);
      console.log(`${drafted ? 'Drafted' : 'Review'} ${visionPath} — edit it before burning.`);
      console.log('Next steps:');
      console.log(`  surplus task create ${project.id} "Your first task"`);
      console.log('  surplus tick --dry-run');
    }),
  );

// --- task ----------------------------------------------------------------------

const taskCmd = program.command('task').description('Manage queue tasks');

taskCmd
  .command('create <projectId> <title>')
  .description('Create a task (defaults: status ready, priority 100, provider any)')
  .option('--body <markdown>', 'extra context appended to the goal condition', '')
  .option('--priority <n>', 'lower = claimed first', '100')
  .addOption(providerPrefOption('provider affinity'))
  .option('--model <model>', 'per-task model override')
  .option('--effort <effort>', 'per-task effort override')
  .addOption(
    new Option('--status <status>', 'initial status').choices(['ready', 'todo', 'triage']).default('ready'),
  )
  .action(
    wrap(
      async (
        projectId: string,
        title: string,
        opts: {
          body: string;
          priority: string;
          provider: ProviderPref;
          model?: string;
          effort?: string;
          status: TaskStatus;
        },
      ) => {
        const deps = buildDeps();
        assertKnownProviderPref(deps, opts.provider);
        const project = deps.db.getProject(projectId);
        if (!project) {
          throw new Error(`unknown project: ${projectId} (register it with \`surplus add\` first)`);
        }
        const priority = Number.parseInt(opts.priority, 10);
        if (Number.isNaN(priority)) throw new Error(`invalid --priority: ${opts.priority}`);
        const task = deps.db.createTask({
          projectId: project.id,
          title,
          body: opts.body ?? '',
          status: opts.status,
          priority,
          provider: opts.provider,
          model: opts.model ?? null,
          effort: opts.effort ?? null,
        });
        console.log(`Created ${task.id} [${task.status}] "${truncate(task.title, 60)}" → ${project.id}`);
      },
    ),
  );

taskCmd
  .command('list')
  .description('List tasks')
  .addOption(new Option('--status <status>', 'filter by status').choices([...TASK_STATUSES]))
  .action(
    wrap(async (opts: { status?: TaskStatus }) => {
      const deps = buildDeps();
      const tasks = deps.db.listTasks(opts.status ? { status: opts.status } : undefined);
      if (tasks.length === 0) {
        console.log('no tasks.');
        return;
      }
      const projects = new Map(deps.db.listProjects().map((p) => [p.id, p.name] as const));
      printTable(
        ['ID', 'STATUS', 'PRIO', 'PROVIDER', 'PROJECT', 'ATT', 'TITLE'],
        tasks.map((t) => [
          t.id,
          t.status,
          String(t.priority),
          t.provider,
          projects.get(t.projectId) ?? t.projectId,
          String(t.attempts),
          truncate(t.title, 56),
        ]),
      );
    }),
  );

// --- burn -----------------------------------------------------------------------

program
  .command('burn')
  .description('Manual one-shot dispatch, outside the launchd schedule')
  .option('--task <id>', 'run this specific ready task')
  .option(
    '--provider <providerOrAccount>',
    'force this provider or account key (claude|codex|claude:<account-id>)',
  )
  .option('--force', 'bypass burn-window checks (never bypasses pause)')
  .action(
    wrap(async (opts: { task?: string; provider?: string; force?: boolean }) => {
      const deps = buildDeps();
      if (isPaused()) {
        throw new Error('surplus is paused (~/.surplus/PAUSED) — run `surplus resume` first');
      }
      if (opts.provider && !matchesAccount(deps, opts.provider)) {
        throw new Error(
          `provider/account ${opts.provider} is not configured — ` +
            `expected one of: ${deps.accounts.map((a) => a.key).join(', ') || '(none enabled)'}`,
        );
      }
      if (opts.task) {
        const t = deps.db.getTask(opts.task);
        if (!t) throw new Error(`unknown task: ${opts.task} (see \`surplus task list\`)`);
        if (t.status !== 'ready') {
          console.error(`warning: task ${opts.task} is '${t.status}', not 'ready' — the claim may fail`);
        }
      }
      const targets = opts.provider
        ? deps.accounts.filter((a) => a.key === opts.provider || a.provider === opts.provider)
        : deps.accounts;
      if (targets.length === 0) throw new Error('no providers enabled — see `surplus config`');
      const usage = await fetchUsage(deps, targets);
      for (const account of targets) {
        const u = usage[account.key];
        if (u?.unavailable) {
          const timeGated =
            account.provider === 'codex' && deps.config.providers.codex.weeklyResetFallback != null;
          console.error(
            `warning: ${account.key} usage unavailable (${u.error ?? 'unknown'})` +
              `${timeGated ? ' — time-gated via weeklyResetFallback' : ''}, proceeding` +
              `${opts.force ? ' (--force)' : ''}`,
          );
        }
      }
      // --provider or --force skips decide() gating (forceProvider accepts an
      // account key or a provider name); plain `burn --task X` still respects
      // burn windows, only the claim is pinned.
      const forceProvider =
        opts.provider ?? (opts.force ? pickForcedProvider(deps, opts.task) : undefined);
      if (forceProvider && !opts.provider) console.log(`forcing provider: ${forceProvider}`);
      printDispatchResult(
        await dispatchTick({ ...deps, forceTaskId: opts.task, forceProvider }),
      );
    }),
  );

// --- board ------------------------------------------------------------------------

program
  .command('board')
  .description('Serve the local kanban board (blocks)')
  .option('--port <port>', 'listen port (default: config board.port)')
  .action(
    wrap(async (opts: { port?: string }) => {
      const deps = buildDeps();
      const port = opts.port ? Number.parseInt(opts.port, 10) : deps.config.board.port;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`invalid --port: ${opts.port}`);
      }
      const triggerBurn = (taskId?: string, provider?: string): Promise<DispatchResult> =>
        dispatchTick({
          ...deps,
          forceTaskId: taskId,
          forceProvider: pickForcedProvider(deps, taskId, provider),
        });
      console.log(`surplus board → http://localhost:${port}`);
      await startServer({
        port,
        db: toServerDb(deps.db),
        config: deps.config,
        accounts: deps.accounts,
        decideFn: decide,
        paused: () => isPaused(),
        setPaused: (b: boolean) => setPaused(b),
        deps: {
          draftVision: async (project: ProjectRow) => {
            const markdown = await draftVision(project.path);
            writeFileSync(project.visionPath, markdown);
            return markdown;
          },
          scaffoldProject: async (name: string) => {
            const slug = slugify(name);
            const dir = join(homedir(), 'Projects', slug);
            if (existsSync(dir)) throw new Error(`already exists: ${dir}`);
            scaffoldProjectDir(dir, name);
            return deps.db.createProject({
              id: slug,
              name,
              path: dir,
              visionPath: join(dir, 'VISION.md'),
              provider: 'any',
              model: null,
              effort: null,
            });
          },
          triggerBurn,
          updateConfig: (patch: ConfigPatch) => {
            const next = applyConfigPatch(loadConfig(), patch);
            saveConfig(next);
            // Rebuild the live account adapters IN PLACE (the array reference
            // is shared with startServer and triggerBurn) so account
            // add/remove/priority edits show up in /api/state — and are
            // burnable — without restarting the board. Adapters are stateless
            // wrappers (usage caches live on disk, keyed per account), so
            // rebuilding them is free.
            deps.accounts.splice(
              0,
              deps.accounts.length,
              ...claudeAccountAdapters(next),
              ...(next.providers.codex.enabled ? [codexAccountAdapter(next)] : []),
            );
            return next;
          },
          scheduler: {
            status: () => existsSync(launchdPlistPath()),
            setArmed: (on: boolean) =>
              on ? (installLaunchd({ intervalMinutes: 15 }), true) : uninstallLaunchd(),
          },
          boardService: {
            status: () => existsSync(boardPlistPath()),
            install: () => {
              installBoardLaunchd({ port: deps.config.board.port });
              installDockApp({ port: deps.config.board.port });
            },
          },
        },
      });
    }),
  );

// --- install / uninstall / config ----------------------------------------------------

program
  .command('install')
  .description('Install launchd agents: the tick scheduler, and optionally the always-on board + Dock app')
  .option('--interval <min>', 'tick interval in minutes', '15')
  .option('--board', 'also install the always-on board service (KeepAlive) and /Applications/Surplus.app')
  .option('--board-only', 'install only the board service + Dock app, not the tick scheduler')
  .action(
    wrap((opts: { interval: string; board?: boolean; boardOnly?: boolean }) => {
      const minutes = Number.parseInt(opts.interval, 10);
      if (Number.isNaN(minutes) || minutes <= 0) throw new Error(`invalid --interval: ${opts.interval}`);
      ensureDirs();
      if (!opts.boardOnly) {
        const plist = installLaunchd({ intervalMinutes: minutes });
        console.log(`Installed tick agent: ${plist} (every ${minutes}m)`);
        console.log('Logs: ~/.surplus/logs/launchd.log');
      }
      if (opts.board || opts.boardOnly) {
        const config = loadConfig();
        const boardPlist = installBoardLaunchd({ port: config.board.port });
        console.log(`Installed always-on board service: ${boardPlist}`);
        console.log(`Dashboard: http://localhost:${config.board.port} (starts at login, restarts if it dies)`);
        const app = installDockApp({ port: config.board.port });
        console.log(`Installed Dock app: ${app}`);
      }
      console.log('`surplus uninstall` removes everything.');
    }),
  );

program
  .command('uninstall')
  .description('Unload and remove the launchd agents and the Dock app')
  .action(
    wrap(() => {
      const tick = uninstallLaunchd();
      const board = uninstallBoardLaunchd();
      const app = uninstallDockApp();
      console.log(
        [
          tick ? 'Removed tick agent.' : 'No tick agent was installed.',
          board ? 'Removed board service.' : 'No board service was installed.',
          app ? 'Removed Dock app.' : 'No Dock app was installed.',
        ].join(' '),
      );
    }),
  );

program
  .command('config')
  .description('Print the effective config and its path')
  .action(
    wrap(() => {
      console.log(`# ${configPath()}`);
      console.log(JSON.stringify(loadConfig(), null, 2));
    }),
  );

// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`error: ${redact(err instanceof Error ? err.message : String(err))}`);
  process.exitCode = 1;
});
