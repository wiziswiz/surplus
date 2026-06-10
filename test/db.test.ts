import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type SurplusDb } from '../src/db.js';
import { dispatchTick, type DispatchDeps, type JudgeRunArgs } from '../src/dispatcher.js';
import type {
  DecideInput,
  Decision,
  JudgeVerdict,
  Provider,
  ProviderAdapter,
  RunTaskArgs,
  RunnerResult,
  SurplusConfig,
  UsageSnapshot,
  Vision,
} from '../src/types.js';

let dir: string;
let db: SurplusDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'surplus-db-test-'));
  db = openDb(join(dir, 'surplus.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeProject(id = 'proj-a') {
  return db.createProject({
    id,
    name: id,
    path: join(dir, id),
    visionPath: join(dir, id, 'VISION.md'),
  });
}

// ---------------------------------------------------------------------------
// db basics
// ---------------------------------------------------------------------------

describe('openDb', () => {
  it('enables WAL and foreign keys', () => {
    expect(db.raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(Number(db.raw.pragma('user_version', { simple: true }))).toBeGreaterThan(0);
  });

  it('rejects tasks pointing at missing projects (FK enforced)', () => {
    expect(() => db.createTask({ projectId: 'nope', title: 'x' })).toThrow();
  });
});

describe('projects and tasks', () => {
  it('round-trips a project with camelCase mapping', () => {
    const p = makeProject('my-proj');
    expect(p.id).toBe('my-proj');
    expect(p.visionPath).toBe(join(dir, 'my-proj', 'VISION.md'));
    expect(p.provider).toBe('any');
    expect(db.getProject('my-proj')).toEqual(p);
    expect(db.listProjects()).toHaveLength(1);
  });

  it('generates prefixed base36 ids safe for branches and paths', () => {
    const p = db.createProject({ name: 'n', path: '/tmp/n', visionPath: '/tmp/n/VISION.md' });
    expect(p.id).toMatch(/^p_[0-9a-z]{12}$/);
    const t = db.createTask({ projectId: p.id, title: 't' });
    expect(t.id).toMatch(/^t_[0-9a-z]{12}$/);
    const r = db.createRun({ taskId: t.id, provider: 'claude' });
    expect(r.id).toMatch(/^r_[0-9a-z]{12}$/);
  });

  it('creates tasks with defaults and a task-created event', () => {
    const p = makeProject();
    const t = db.createTask({ projectId: p.id, title: 'hello' });
    expect(t.status).toBe('triage');
    expect(t.priority).toBe(100);
    expect(t.attempts).toBe(0);
    expect(t.maxAttempts).toBe(3);
    expect(t.provider).toBe('any');
    expect(t.judgeFeedback).toBeNull();
    const events = db.listEventsAfter(0);
    const created = events.filter((e) => e.type === 'task-created');
    expect(created).toHaveLength(1);
    expect(created[0]!.taskId).toBe(t.id);
  });

  it('updateTask bumps updated_at and appends task-updated vs status-changed', () => {
    const p = makeProject();
    const t = db.createTask({ projectId: p.id, title: 'a', createdAt: 1000 });
    expect(t.updatedAt).toBe(1000);

    const renamed = db.updateTask(t.id, { title: 'b', priority: 5 });
    expect(renamed.title).toBe('b');
    expect(renamed.priority).toBe(5);
    expect(renamed.updatedAt).toBeGreaterThan(1000);

    const moved = db.updateTask(t.id, { status: 'ready' });
    expect(moved.status).toBe('ready');

    const events = db.listEventsAfter(0);
    const updated = events.filter((e) => e.type === 'task-updated');
    const statusChanged = events.filter((e) => e.type === 'status-changed');
    expect(updated).toHaveLength(1);
    expect(JSON.parse(updated[0]!.data).changed).toEqual(['title', 'priority']);
    expect(statusChanged).toHaveLength(1);
    expect(JSON.parse(statusChanged[0]!.data)).toMatchObject({ from: 'triage', to: 'ready' });
  });

  it('listTasks excludes archived by default and filters by status/project', () => {
    const p = makeProject();
    db.createTask({ projectId: p.id, title: 'r', status: 'ready' });
    db.createTask({ projectId: p.id, title: 'x', status: 'archived' });
    expect(db.listTasks()).toHaveLength(1);
    expect(db.listTasks({ status: 'archived' })).toHaveLength(1);
    expect(db.listTasks({ projectId: 'other' })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// claim semantics
// ---------------------------------------------------------------------------

describe('claimNextReadyTask', () => {
  it('claims lowest priority number first, then oldest', () => {
    const p = makeProject('pa');
    const q = makeProject('pb');
    db.createTask({ projectId: p.id, title: 'low', status: 'ready', priority: 100, createdAt: 1 });
    const urgent = db.createTask({
      projectId: q.id,
      title: 'urgent',
      status: 'ready',
      priority: 1,
      createdAt: 2,
    });
    const claimed = db.claimNextReadyTask(Date.now(), 'claude');
    expect(claimed?.id).toBe(urgent.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
  });

  it('breaks priority ties by created_at (oldest first)', () => {
    const p = makeProject('pa');
    const q = makeProject('pb');
    const older = db.createTask({
      projectId: p.id,
      title: 'older',
      status: 'ready',
      createdAt: 1000,
    });
    db.createTask({ projectId: q.id, title: 'newer', status: 'ready', createdAt: 2000 });
    expect(db.claimNextReadyTask(Date.now(), 'claude')?.id).toBe(older.id);
  });

  it("matches the burning provider, with 'any' claimable by either", () => {
    const p = makeProject('pa');
    const q = makeProject('pb');
    const codexOnly = db.createTask({
      projectId: p.id,
      title: 'codex-only',
      status: 'ready',
      provider: 'codex',
      priority: 1,
    });
    const anyTask = db.createTask({
      projectId: q.id,
      title: 'any',
      status: 'ready',
      provider: 'any',
      priority: 2,
    });
    // claude must skip the codex-only task even though it has better priority.
    expect(db.claimNextReadyTask(Date.now(), 'claude')?.id).toBe(anyTask.id);
    expect(db.claimNextReadyTask(Date.now(), 'codex')?.id).toBe(codexOnly.id);
  });

  it('skips projects that already have a running task', () => {
    const p = makeProject('pa');
    const q = makeProject('pb');
    db.createTask({ projectId: p.id, title: 'first', status: 'ready', priority: 1 });
    db.createTask({ projectId: p.id, title: 'second', status: 'ready', priority: 2 });
    const other = db.createTask({ projectId: q.id, title: 'other', status: 'ready', priority: 3 });

    const first = db.claimNextReadyTask(Date.now(), 'claude');
    expect(first?.title).toBe('first');
    // project pa now has a running task — its second task is not claimable.
    const next = db.claimNextReadyTask(Date.now(), 'claude');
    expect(next?.id).toBe(other.id);
    expect(db.claimNextReadyTask(Date.now(), 'claude')).toBeNull();
  });

  it('gates children on parent done', () => {
    const p = makeProject();
    const parent = db.createTask({ projectId: p.id, title: 'parent', status: 'todo' });
    const child = db.createTask({
      projectId: p.id,
      title: 'child',
      status: 'ready',
      parentId: parent.id,
    });
    expect(db.claimNextReadyTask(Date.now(), 'claude')).toBeNull();
    db.updateTask(parent.id, { status: 'done' });
    expect(db.claimNextReadyTask(Date.now(), 'claude')?.id).toBe(child.id);
  });

  it('honors scheduled_at', () => {
    const p = makeProject();
    const t = db.createTask({
      projectId: p.id,
      title: 'later',
      status: 'ready',
      scheduledAt: 50_000,
    });
    expect(db.claimNextReadyTask(40_000, 'claude')).toBeNull();
    expect(db.claimNextReadyTask(60_000, 'claude')?.id).toBe(t.id);
  });
});

// ---------------------------------------------------------------------------
// events + countRunning
// ---------------------------------------------------------------------------

describe('events', () => {
  it('appends and lists events after an id, with limit', () => {
    const e1 = db.appendEvent('decision', null, { action: 'idle' });
    const e2 = db.appendEvent('usage', null, { provider: 'claude' });
    const e3 = db.appendEvent('decision', null, { action: 'burn' });
    expect(e1.id).toBeLessThan(e2.id);

    const all = db.listEventsAfter(0);
    expect(all.map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);

    const afterFirst = db.listEventsAfter(e1.id);
    expect(afterFirst.map((e) => e.id)).toEqual([e2.id, e3.id]);

    expect(db.listEventsAfter(0, 2)).toHaveLength(2);
    expect(JSON.parse(e3.data)).toEqual({ action: 'burn' });
  });

  it('countRunning reflects claimed tasks', () => {
    const p = makeProject();
    db.createTask({ projectId: p.id, title: 't', status: 'ready' });
    expect(db.countRunning()).toBe(0);
    db.claimNextReadyTask(Date.now(), 'claude');
    expect(db.countRunning()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// dispatcher flow (fake adapters)
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<SurplusConfig>): SurplusConfig {
  return {
    providers: {
      claude: { enabled: true, defaults: { model: 'sonnet', effort: 'medium' } },
      codex: {
        enabled: false,
        defaults: { model: 'gpt-5.1-codex', effort: 'medium' },
        weeklyResetFallback: null,
      },
    },
    modes: {
      weeklySurplus: { enabled: true, burnWindowHours: 12, stopAtPct: 95 },
      fiveHourBurst: { enabled: false, triggerMinutesBeforeReset: 30, weeklyGuardPct: 70 },
    },
    pacing: { fiveHourPausePct: 90 },
    dispatcher: { maxConcurrent: 1, maxAttempts: 3, taskTimeoutMinutes: 90, maxTurnsHint: 40 },
    judge: { model: 'haiku' },
    board: { port: 4567 },
    judgePassScore: 4,
    ...overrides,
  };
}

function healthyUsage(provider: Provider): UsageSnapshot {
  return {
    provider,
    planName: 'Max',
    fiveHourPct: 10,
    sevenDayPct: 50,
    fiveHourResetsAt: null,
    sevenDayResetsAt: null,
    unavailable: false,
    fetchedAt: Date.now(),
  };
}

function emptyVision(): Vision {
  return {
    provider: null,
    model: null,
    effort: null,
    statement: 'test vision',
    criteria: [],
    verifyCommands: [],
    uiFlows: [],
    guardrails: [],
    raw: '# VISION',
  };
}

function makeRunnerResult(p?: Partial<RunnerResult>): RunnerResult {
  const now = Date.now();
  return {
    outcome: 'failed', // completed-pending-judge
    exitCode: 0,
    branch: 'surplus/test',
    summary: 'work summary',
    logPath: '/tmp/test.log',
    startedAt: now,
    endedAt: now + 1000,
    ...p,
  };
}

function fakeAdapter(
  provider: Provider,
  run: (args: RunTaskArgs) => RunnerResult,
): ProviderAdapter {
  return {
    provider,
    async getUsage() {
      return healthyUsage(provider);
    },
    async runTask(args: RunTaskArgs) {
      return run(args);
    },
  };
}

const burnDecide = (input: DecideInput): Decision =>
  input.paused
    ? { action: 'stop', reason: 'paused' }
    : { action: 'burn', reason: 'test burn', mode: 'weeklySurplus' };

function makeDeps(partial: Partial<DispatchDeps>): DispatchDeps {
  return {
    db,
    config: makeConfig(),
    adapters: {},
    decideFn: burnDecide,
    judgeRun: async () => ({ score: 5, reasons: 'ok', missing: '' }),
    loadVision: () => emptyVision(),
    paused: () => false,
    logsDir: join(dir, 'logs'),
    worktreesDir: join(dir, 'worktrees'),
    ...partial,
  };
}

describe('dispatchTick', () => {
  it('runs a ready task, judge passes, task goes done with feedback cleared', async () => {
    const p = makeProject();
    const task = db.createTask({
      projectId: p.id,
      title: 'ship it',
      status: 'ready',
      judgeFeedback: 'stale feedback from before',
    });
    const judgeCalls: JudgeRunArgs[] = [];
    const deps = makeDeps({
      adapters: { claude: fakeAdapter('claude', () => makeRunnerResult()) },
      judgeRun: async (args) => {
        judgeCalls.push(args);
        return { score: 5, reasons: 'all criteria met', missing: '' };
      },
    });

    const res = await dispatchTick(deps);

    expect(res.launched).toBe(1);
    expect(res.results).toEqual([{ taskId: task.id, provider: 'claude', outcome: 'passed' }]);
    expect(judgeCalls).toHaveLength(1);

    const after = db.getTask(task.id)!;
    expect(after.status).toBe('done');
    expect(after.judgeFeedback).toBeNull();
    expect(after.attempts).toBe(1);

    const runs = db.listRunsForTask(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('passed');
    expect(runs[0]!.judgeScore).toBe(5);
    expect(runs[0]!.provider).toBe('claude');
    expect(runs[0]!.model).toBe('sonnet'); // config default via precedence chain
    expect(runs[0]!.endedAt).not.toBeNull();

    const types = db.listEventsAfter(0).map((e) => e.type);
    expect(types).toContain('usage');
    expect(types).toContain('decision');
    expect(types).toContain('run-started');
    expect(types).toContain('judge-verdict');
    expect(types).toContain('run-finished');
  });

  it('requeues failed tasks with accumulated feedback, then blocks at maxAttempts', async () => {
    const p = makeProject();
    const task = db.createTask({
      projectId: p.id,
      title: 'hard task',
      status: 'ready',
      maxAttempts: 2,
      model: 'opus', // task override beats config default
    });
    const verdicts: JudgeVerdict[] = [
      { score: 1, reasons: 'missing tests', missing: 'unit tests' },
      { score: 2, reasons: 'still failing', missing: 'edge cases' },
    ];
    let judgeIdx = 0;
    const feedbackSeenByRunner: Array<string | null | undefined> = [];
    const deps = makeDeps({
      adapters: {
        claude: fakeAdapter('claude', (args) => {
          feedbackSeenByRunner.push(args.judgeFeedback);
          expect(args.model).toBe('opus');
          return makeRunnerResult();
        }),
      },
      judgeRun: async () => verdicts[Math.min(judgeIdx++, verdicts.length - 1)]!,
    });

    // One tick retries within the loop until the task blocks (maxConcurrent=1).
    const res = await dispatchTick(deps);

    expect(res.launched).toBe(2);
    expect(res.results.map((r) => r.outcome)).toEqual(['failed', 'failed']);

    // Second attempt received the first attempt's feedback.
    expect(feedbackSeenByRunner[0]).toBeNull();
    expect(feedbackSeenByRunner[1]).toContain('missing tests');
    expect(feedbackSeenByRunner[1]).toContain('Missing: unit tests');

    const after = db.getTask(task.id)!;
    expect(after.status).toBe('blocked');
    expect(after.attempts).toBe(2);
    // Newest feedback first, previous appended after, capped at 4000.
    expect(after.judgeFeedback).toContain('still failing');
    expect(after.judgeFeedback).toContain('missing tests');
    expect(after.judgeFeedback!.indexOf('still failing')).toBeLessThan(
      after.judgeFeedback!.indexOf('missing tests'),
    );
    expect(after.judgeFeedback!.length).toBeLessThanOrEqual(4000);

    expect(db.listRunsForTask(task.id)).toHaveLength(2);
  });

  it('quota outcome skips the judge, requeues the task, and trips the respawn guard', async () => {
    const p = makeProject('pa');
    const q = makeProject('pb');
    const t1 = db.createTask({ projectId: p.id, title: 'first', status: 'ready', priority: 1 });
    const t2 = db.createTask({ projectId: q.id, title: 'second', status: 'ready', priority: 2 });
    let judgeCalls = 0;
    const deps = makeDeps({
      adapters: {
        claude: fakeAdapter('claude', () =>
          makeRunnerResult({ outcome: 'quota', summary: 'usage limit reached', exitCode: 1 }),
        ),
      },
      judgeRun: async () => {
        judgeCalls += 1;
        return { score: 5, reasons: '', missing: '' };
      },
    });

    const res = await dispatchTick(deps);

    // Stopped after the first run even though t2 (and t1 again) were claimable.
    expect(res.launched).toBe(1);
    expect(res.results).toEqual([{ taskId: t1.id, provider: 'claude', outcome: 'quota' }]);
    expect(judgeCalls).toBe(0);

    const after1 = db.getTask(t1.id)!;
    expect(after1.status).toBe('ready'); // attempts 1 < maxAttempts 3
    expect(after1.attempts).toBe(1);
    expect(after1.judgeFeedback).toContain('quota');

    const after2 = db.getTask(t2.id)!;
    expect(after2.status).toBe('ready');
    expect(after2.attempts).toBe(0); // never claimed

    const run = db.listRunsForTask(t1.id)[0]!;
    expect(run.outcome).toBe('quota');
    expect(run.judgeScore).toBeNull();

    // Last decision event is the respawn-guard stop.
    const decisions = db
      .listEventsAfter(0, 1000)
      .filter((e) => e.type === 'decision')
      .map((e) => JSON.parse(e.data) as { action: string; reason: string });
    const last = decisions[decisions.length - 1]!;
    expect(last.action).toBe('stop');
    expect(last.reason).toContain('respawn guard: claude');
  });
});
