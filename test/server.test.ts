import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  applyConfigPatch,
  buildConfigPatch,
  buildTaskPatch,
  redact,
  slugifyProjectId,
  startServer,
  type ServerDb,
} from '../src/server.js';
import type {
  AccountAdapter,
  ProjectRow,
  Provider,
  SurplusConfig,
  TaskEventRow,
  TaskEventType,
  TaskRow,
  UsageSnapshot,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeDb extends ServerDb {
  events: TaskEventRow[];
  tasks: Map<string, TaskRow>;
  projects: Map<string, ProjectRow>;
}

function makeDb(): FakeDb {
  const projects = new Map<string, ProjectRow>();
  const tasks = new Map<string, TaskRow>();
  const events: TaskEventRow[] = [];
  let nextId = 1;
  return {
    projects,
    tasks,
    events,
    listProjects: () => [...projects.values()],
    getProject: (id) => projects.get(id),
    insertProject: (r) => void projects.set(r.id, r),
    updateProject: (id, patch) => {
      const p = projects.get(id);
      if (!p) return undefined;
      const u = { ...p, ...patch };
      projects.set(id, u);
      return u;
    },
    deleteProject: (id) => {
      const live = [...tasks.values()].filter(
        (t) => t.projectId === id && t.status !== 'archived',
      );
      if (live.length > 0) {
        throw new Error(`project '${id}' has ${live.length} non-archived task(s)`);
      }
      for (const [tid, t] of tasks) if (t.projectId === id) tasks.delete(tid);
      return projects.delete(id);
    },
    listTasks: (status) =>
      [...tasks.values()].filter((t) => (status ? t.status === status : t.status !== 'archived')),
    getTask: (id) => tasks.get(id),
    insertTask: (t) => void tasks.set(t.id, t),
    updateTask: (id, patch) => {
      const t = tasks.get(id);
      if (!t) return undefined;
      const u = { ...t, ...patch };
      tasks.set(id, u);
      return u;
    },
    listRuns: () => [],
    listEventsForTask: (taskId, limit = 200) =>
      events.filter((e) => e.taskId === taskId).slice(-limit),
    eventsAfter: (after, limit = 500) => events.filter((e) => e.id > after).slice(0, limit),
    lastEvents: (limit) => events.slice(-limit),
    appendEvent: (type: TaskEventType, taskId, data) => {
      const row: TaskEventRow = {
        id: nextId++,
        ts: Date.now(),
        taskId,
        type,
        data: JSON.stringify(data),
      };
      events.push(row);
      return row;
    },
  };
}

function makeConfig(): SurplusConfig {
  return {
    providers: {
      claude: { enabled: true, defaults: { model: 'opus', effort: 'high' } },
      codex: { enabled: false, defaults: { model: 'gpt-5.1-codex', effort: 'high' } },
    },
    modes: {
      weeklySurplus: { enabled: true, burnWindowHours: 12, stopAtPct: 95 },
      fiveHourBurst: { enabled: false, triggerMinutesBeforeReset: 30, weeklyGuardPct: 70 },
    },
    pacing: { fiveHourPausePct: 90 },
    reserve: { weeklyPct: 10, fiveHourPct: 25, watchdogIntervalMinutes: 5 },
    discovery: { roots: ['~/Projects'] },
    dispatcher: { maxConcurrent: 1, maxAttempts: 3, taskTimeoutMinutes: 90, maxTurnsHint: 40 },
    judge: { model: 'sonnet' },
    board: { port: 4242 },
    judgePassScore: 4,
  };
}

function makeAccount(provider: Provider, key: string = provider): AccountAdapter {
  const snap: UsageSnapshot = {
    provider,
    planName: 'Max',
    fiveHourPct: 12,
    sevenDayPct: 55,
    fiveHourResetsAt: new Date(Date.now() + 3_600_000),
    sevenDayResetsAt: new Date(Date.now() + 86_400_000),
    unavailable: false,
    fetchedAt: Date.now(),
  };
  return {
    key,
    provider,
    label: key,
    priority: null,
    configDir: null,
    getUsage: async () => snap,
    runTask: async () => {
      throw new Error('runTask is not used by the server');
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('slugifyProjectId', () => {
  it('produces alphanumeric+dash slugs', () => {
    expect(slugifyProjectId('My Cool_Project!!')).toBe('my-cool-project');
    expect(slugifyProjectId('---')).toBe('');
  });
});

describe('redact', () => {
  it('strips token-looking strings', () => {
    expect(redact('failed with sk-ant-abc123def456')).not.toContain('sk-ant-abc123def456');
    expect(redact('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
    expect(redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).not.toContain('eyJhbGci');
  });
});

describe('buildTaskPatch', () => {
  it('rejects status running', () => {
    const r = buildTaskPatch({ status: 'running' });
    expect(r.ok).toBe(false);
  });
  it('rejects unknown status', () => {
    expect(buildTaskPatch({ status: 'doing' }).ok).toBe(false);
  });
  it('accepts allowed fields and drops unknown ones', () => {
    const r = buildTaskPatch({ status: 'done', priority: 5, attempts: 99, id: 'hax' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch).toEqual({ status: 'done', priority: 5 });
    }
  });
  it('rejects empty patch', () => {
    expect(buildTaskPatch({}).ok).toBe(false);
  });
  it('validates provider pref', () => {
    expect(buildTaskPatch({ provider: 'gpt' }).ok).toBe(false);
    expect(buildTaskPatch({ provider: 'any' }).ok).toBe(true);
  });
});

describe('buildConfigPatch', () => {
  it('accepts a valid nested partial', () => {
    const r = buildConfigPatch({ reserve: { weeklyPct: 20 }, board: { port: 8080 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch).toEqual({ reserve: { weeklyPct: 20 }, board: { port: 8080 } });
    }
  });
  it('rejects out-of-range percents and ports', () => {
    expect(buildConfigPatch({ modes: { weeklySurplus: { stopAtPct: 120 } } }).ok).toBe(false);
    expect(buildConfigPatch({ reserve: { weeklyPct: -1 } }).ok).toBe(false);
    expect(buildConfigPatch({ reserve: { weeklyPct: 12.5 } }).ok).toBe(false);
    expect(buildConfigPatch({ board: { port: 80 } }).ok).toBe(false);
  });
  it('rejects wrong types, non-positive ints, and unknown keys', () => {
    expect(buildConfigPatch({ modes: { weeklySurplus: { enabled: 'yes' } } }).ok).toBe(false);
    expect(buildConfigPatch({ dispatcher: { maxConcurrent: 0 } }).ok).toBe(false);
    expect(buildConfigPatch({ judgePassScore: 9 }).ok).toBe(false);
    expect(buildConfigPatch({ nope: 1 }).ok).toBe(false);
    expect(buildConfigPatch({ dispatcher: { hax: 1 } }).ok).toBe(false);
  });
  it('rejects unknown providers and empty model strings', () => {
    expect(buildConfigPatch({ providers: { gpt: { enabled: true } } }).ok).toBe(false);
    expect(buildConfigPatch({ providers: { claude: { defaults: { model: '' } } } }).ok).toBe(false);
  });
  it('allows weeklyResetFallback as string or null only', () => {
    expect(buildConfigPatch({ providers: { codex: { weeklyResetFallback: 'Thu 21:00' } } }).ok).toBe(true);
    expect(buildConfigPatch({ providers: { codex: { weeklyResetFallback: null } } }).ok).toBe(true);
    expect(buildConfigPatch({ providers: { codex: { weeklyResetFallback: 5 } } }).ok).toBe(false);
  });
  it('rejects an empty patch', () => {
    expect(buildConfigPatch({}).ok).toBe(false);
  });
});

describe('buildConfigPatch — providers.claude.accounts', () => {
  const acct = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'work',
    label: 'Work Max',
    configDir: '~/.surplus/profiles/work',
    priority: 1,
    ...over,
  });
  const patch = (accounts: unknown) => buildConfigPatch({ providers: { claude: { accounts } } });

  it('accepts a valid account list (main keeps configDir null; ~ and absolute dirs ok)', () => {
    const r = patch([
      { id: 'main', label: 'personal', configDir: null, priority: null },
      acct(),
      acct({ id: 'ci', label: 'ci', configDir: '/opt/claude-profiles/ci', priority: null }),
    ]);
    expect(r.ok).toBe(true);
  });

  it('accepts missing configDir/priority on main (read as null) and an empty list', () => {
    expect(patch([{ id: 'main', label: 'personal' }]).ok).toBe(true);
    expect(patch([]).ok).toBe(true);
  });

  it('rejects non-arrays and more than 6 accounts', () => {
    expect(patch('main').ok).toBe(false);
    expect(patch({ id: 'main' }).ok).toBe(false);
    const seven = Array.from({ length: 7 }, (_, i) =>
      acct({ id: `a${i}`, configDir: `~/p/a${i}` }),
    );
    expect(patch(seven).ok).toBe(false);
  });

  it('rejects bad id slugs and duplicates', () => {
    expect(patch([acct({ id: 'Work' })]).ok).toBe(false);
    expect(patch([acct({ id: '' })]).ok).toBe(false);
    expect(patch([acct({ id: 'a'.repeat(25) })]).ok).toBe(false);
    expect(patch([acct({ id: 'a_b' })]).ok).toBe(false);
    expect(patch([acct(), acct({ label: 'other' })]).ok).toBe(false); // duplicate 'work'
  });

  it("rejects main with a configDir and non-main without an absolute/~ configDir", () => {
    expect(patch([{ id: 'main', label: 'p', configDir: '~/elsewhere', priority: null }]).ok).toBe(
      false,
    );
    expect(patch([acct({ configDir: null })]).ok).toBe(false);
    expect(patch([acct({ configDir: undefined })]).ok).toBe(false);
    expect(patch([acct({ configDir: 'profiles/work' })]).ok).toBe(false);
  });

  it("rejects a non-main configDir resolving to the default ~/.claude (that's the main account)", () => {
    expect(patch([acct({ configDir: '~/.claude' })]).ok).toBe(false);
    expect(patch([acct({ configDir: '~/.claude/' })]).ok).toBe(false);
    expect(patch([acct({ configDir: path.join(homedir(), '.claude') })]).ok).toBe(false);
  });

  it('rejects two accounts resolving to the same profile dir (one login enumerated twice)', () => {
    expect(
      patch([acct(), acct({ id: 'work2', configDir: path.join(homedir(), '.surplus/profiles/work') })])
        .ok,
    ).toBe(false);
    expect(
      patch([acct(), acct({ id: 'work2', configDir: '~/.surplus/profiles/work2' })]).ok,
    ).toBe(true);
  });

  it('rejects bad labels and priorities', () => {
    expect(patch([acct({ label: '' })]).ok).toBe(false);
    expect(patch([acct({ label: '   ' })]).ok).toBe(false);
    expect(patch([acct({ label: 'x'.repeat(41) })]).ok).toBe(false);
    expect(patch([acct({ label: 42 })]).ok).toBe(false);
    expect(patch([acct({ priority: 100 })]).ok).toBe(false);
    expect(patch([acct({ priority: -1 })]).ok).toBe(false);
    expect(patch([acct({ priority: 1.5 })]).ok).toBe(false);
    expect(patch([acct({ priority: 'high' })]).ok).toBe(false);
  });

  it('rejects unknown account keys and accounts on codex', () => {
    expect(patch([acct({ hax: true })]).ok).toBe(false);
    expect(
      buildConfigPatch({ providers: { codex: { accounts: [acct()] } } }).ok,
    ).toBe(false);
  });
});

describe('applyConfigPatch', () => {
  it('merges nested values without dropping siblings', () => {
    const next = applyConfigPatch(makeConfig(), { reserve: { weeklyPct: 30 } });
    expect(next.reserve).toEqual({ weeklyPct: 30, fiveHourPct: 25, watchdogIntervalMinutes: 5 });
    expect(next.modes.weeklySurplus.stopAtPct).toBe(95);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration
// ---------------------------------------------------------------------------

const PORT = 43200 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const ac = new AbortController();
const db = makeDb();
let pausedFlag = false;
const burnCalls: Array<[string | undefined, string | undefined]> = [];
const serverConfig = makeConfig();
const configPatches: unknown[] = [];
let tmpRepo: string;
let tmpVision: string;

beforeAll(async () => {
  tmpRepo = mkdtempSync(path.join(tmpdir(), 'surplus-board-test-'));
  mkdirSync(path.join(tmpRepo, '.git'));
  tmpVision = mkdtempSync(path.join(tmpdir(), 'surplus-vision-test-'));
  db.insertProject({
    id: 'demo',
    name: 'demo',
    path: '/tmp/demo',
    visionPath: '/tmp/demo/VISION.md',
    provider: 'any',
    model: null,
    effort: null,
    createdAt: Date.now(),
  });
  db.insertProject({
    id: 'visproj',
    name: 'visproj',
    path: tmpVision,
    visionPath: path.join(tmpVision, 'VISION.md'),
    provider: 'any',
    model: null,
    effort: null,
    createdAt: Date.now(),
  });
  db.appendEvent('decision', null, { seeded: true });
  await startServer({
    port: PORT,
    db,
    config: serverConfig,
    accounts: [makeAccount('claude')],
    decideFn: (input) => ({ action: 'idle', reason: `test:${input.usage.provider}` }),
    paused: () => pausedFlag,
    setPaused: (b) => {
      pausedFlag = b;
    },
    deps: {
      triggerBurn: async (taskId, provider) => {
        burnCalls.push([taskId, provider]);
        return { dispatched: true };
      },
      updateConfig: (patch) => {
        configPatches.push(patch);
        return applyConfigPatch(serverConfig, patch);
      },
    },
    signal: ac.signal,
  });
});

afterAll(() => {
  ac.abort();
  rmSync(tmpRepo, { recursive: true, force: true });
  rmSync(tmpVision, { recursive: true, force: true });
});

describe('GET /api/state', () => {
  it('returns per-provider usage + decisions for enabled adapters only', async () => {
    const res = await fetch(`${BASE}/api/state`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as Record<string, unknown>;
    const usage = state.usage as Record<string, { planName: string }>;
    const decisions = state.decisions as Record<string, { action: string; reason: string }>;
    expect(usage.claude?.planName).toBe('Max');
    expect(usage.codex).toBeUndefined();
    expect(decisions.claude?.reason).toBe('test:claude');
    expect(decisions.codex).toBeUndefined();
    expect(state.paused).toBe(false);
    expect(state.running).toEqual([]);
  });
});

describe('tasks', () => {
  let taskId = '';

  it('POST /api/tasks creates a task with defaults', async () => {
    const res = await fetch(`${BASE}/api/tasks`, {
      method: 'POST',
      body: JSON.stringify({ projectId: 'demo', title: '  Ship it  ', status: 'ready' }),
    });
    expect(res.status).toBe(201);
    const task = (await res.json()) as TaskRow;
    taskId = task.id;
    expect(task.id).toMatch(/^t_[a-z0-9]+$/);
    expect(task.title).toBe('Ship it');
    expect(task.status).toBe('ready');
    expect(task.priority).toBe(100);
    expect(task.maxAttempts).toBe(3);
    expect(task.provider).toBe('any');
  });

  it('POST /api/tasks rejects bad project ids before any use', async () => {
    for (const projectId of ['../etc', 'a b', 'x/../y', '']) {
      const res = await fetch(`${BASE}/api/tasks`, {
        method: 'POST',
        body: JSON.stringify({ projectId, title: 'x' }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('POST /api/tasks rejects initial status running', async () => {
    const res = await fetch(`${BASE}/api/tasks`, {
      method: 'POST',
      body: JSON.stringify({ projectId: 'demo', title: 'x', status: 'running' }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a 'claude:<id>' affinity that names no configured account (silent starvation)", async () => {
    const post = await fetch(`${BASE}/api/tasks`, {
      method: 'POST',
      body: JSON.stringify({ projectId: 'demo', title: 'pinned', provider: 'claude:ghost' }),
    });
    expect(post.status).toBe(400);

    const taskPatch = await fetch(`${BASE}/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'claude:ghost' }),
    });
    expect(taskPatch.status).toBe(400);

    const projPatch = await fetch(`${BASE}/api/projects/demo`, {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'claude:ghost' }),
    });
    expect(projPatch.status).toBe(400);
  });

  it('GET /api/tasks filters by status and validates the filter', async () => {
    const ok = await fetch(`${BASE}/api/tasks?status=ready`);
    expect(ok.status).toBe(200);
    const rows = (await ok.json()) as TaskRow[];
    expect(rows.some((t) => t.id === taskId)).toBe(true);
    const bad = await fetch(`${BASE}/api/tasks?status=nope`);
    expect(bad.status).toBe(400);
  });

  it('PATCH /api/tasks/:id blocks transitions into running', async () => {
    const res = await fetch(`${BASE}/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running' }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/tasks/:id applies allowed fields and appends an event', async () => {
    const res = await fetch(`${BASE}/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'blocked', priority: 7 }),
    });
    expect(res.status).toBe(200);
    const task = (await res.json()) as TaskRow;
    expect(task.status).toBe('blocked');
    expect(task.priority).toBe(7);
    expect(
      db.events.some((e) => e.type === 'status-changed' && e.taskId === taskId),
    ).toBe(true);
  });

  it('PATCH rejects invalid ids with 400', async () => {
    const res = await fetch(`${BASE}/api/tasks/a.b`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/tasks/:id returns task + runs + events', async () => {
    const res = await fetch(`${BASE}/api/tasks/${taskId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: TaskRow; runs: unknown[]; events: unknown[] };
    expect(body.task.id).toBe(taskId);
    expect(Array.isArray(body.runs)).toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
  });
});

describe('projects', () => {
  it('rejects relative and non-git paths', async () => {
    const rel = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({ path: 'relative/dir' }),
    });
    expect(rel.status).toBe(400);
    const nonGit = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({ path: tmpdir() }),
    });
    expect(nonGit.status).toBe(400);
  });

  it('accepts an existing git repo dir', async () => {
    const res = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({ path: tmpRepo }),
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as ProjectRow;
    expect(row.id).toMatch(/^[a-z0-9-]+$/);
    expect(row.visionPath).toBe(path.join(tmpRepo, 'VISION.md'));
  });

  it('returns 501 for {name} when scaffoldProject is absent', async () => {
    const res = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({ name: 'fresh-idea' }),
    });
    expect(res.status).toBe(501);
  });
});

describe('project vision', () => {
  it('GET returns empty markdown when VISION.md is missing, 404 for unknown projects', async () => {
    const missing = await fetch(`${BASE}/api/projects/visproj/vision`);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ markdown: '' });
    const unknown = await fetch(`${BASE}/api/projects/nope/vision`);
    expect(unknown.status).toBe(404);
    const badId = await fetch(`${BASE}/api/projects/a.b/vision`);
    expect(badId.status).toBe(400);
  });

  it('PUT writes the file and GET round-trips it', async () => {
    const markdown = '# Vision\n\n- ship the thing\n';
    const put = await fetch(`${BASE}/api/projects/visproj/vision`, {
      method: 'PUT',
      body: JSON.stringify({ markdown }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });
    expect(readFileSync(path.join(tmpVision, 'VISION.md'), 'utf8')).toBe(markdown);
    const get = await fetch(`${BASE}/api/projects/visproj/vision`);
    expect(((await get.json()) as { markdown: string }).markdown).toBe(markdown);
  });

  it('PUT rejects oversized and non-string markdown with 400', async () => {
    const big = await fetch(`${BASE}/api/projects/visproj/vision`, {
      method: 'PUT',
      body: JSON.stringify({ markdown: 'x'.repeat(64_001) }),
    });
    expect(big.status).toBe(400);
    const nonString = await fetch(`${BASE}/api/projects/visproj/vision`, {
      method: 'PUT',
      body: JSON.stringify({ markdown: 42 }),
    });
    expect(nonString.status).toBe(400);
  });
});

describe('PATCH /api/projects/:id', () => {
  it('applies allowed fields (model/effort accept null = inherit)', async () => {
    const res = await fetch(`${BASE}/api/projects/visproj`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Vision Proj', provider: 'claude', model: 'opus', effort: null }),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()) as ProjectRow;
    expect(row.name).toBe('Vision Proj');
    expect(row.provider).toBe('claude');
    expect(row.model).toBe('opus');
    expect(row.effort).toBeNull();
  });

  it('rejects bad fields, empty patches, and unknown projects', async () => {
    const bads = [
      { name: '   ' },
      { provider: 'gpt' },
      { model: '' },
      { effort: 42 },
      { path: '/etc' }, // not patchable → empty patch
      {},
    ];
    for (const body of bads) {
      const res = await fetch(`${BASE}/api/projects/visproj`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    const unknown = await fetch(`${BASE}/api/projects/nope`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'x' }),
    });
    expect(unknown.status).toBe(404);
  });
});

describe('DELETE /api/projects/:id', () => {
  function seedTask(id: string, projectId: string, status: TaskRow['status']): void {
    const now = Date.now();
    db.insertTask({
      id,
      projectId,
      title: 'doomed',
      body: '',
      status,
      priority: 100,
      attempts: 0,
      maxAttempts: 3,
      provider: 'any',
      model: null,
      effort: null,
      judgeFeedback: null,
      parentId: null,
      scheduledAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  it('refuses with 400 while non-archived tasks exist, succeeds after archiving', async () => {
    db.insertProject({
      id: 'delme',
      name: 'delme',
      path: '/tmp/delme',
      visionPath: '/tmp/delme/VISION.md',
      provider: 'any',
      model: null,
      effort: null,
      createdAt: Date.now(),
    });
    seedTask('t_del1', 'delme', 'ready');
    const refused = await fetch(`${BASE}/api/projects/delme`, { method: 'DELETE' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain('non-archived');
    expect(db.projects.has('delme')).toBe(true);

    db.updateTask('t_del1', { status: 'archived' });
    const ok = await fetch(`${BASE}/api/projects/delme`, { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(db.projects.has('delme')).toBe(false);
    expect(db.tasks.has('t_del1')).toBe(false);
  });

  it('validates ids and 404s unknown projects', async () => {
    const badId = await fetch(`${BASE}/api/projects/a.b`, { method: 'DELETE' });
    expect(badId.status).toBe(400);
    const unknown = await fetch(`${BASE}/api/projects/nope`, { method: 'DELETE' });
    expect(unknown.status).toBe(404);
  });
});

describe('board service', () => {
  it('reports available:false and 503s POST when the dep is absent', async () => {
    const get = await fetch(`${BASE}/api/board-service`);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ installed: false, available: false });
    const post = await fetch(`${BASE}/api/board-service`, { method: 'POST' });
    expect(post.status).toBe(503);
  });
});

describe('board service (with dep)', () => {
  const PORT2 = PORT + 997;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const ac2 = new AbortController();
  let installed = false;

  beforeAll(async () => {
    await startServer({
      port: PORT2,
      db: makeDb(),
      config: makeConfig(),
      accounts: [],
      decideFn: () => ({ action: 'idle', reason: 'test' }),
      paused: () => false,
      setPaused: () => undefined,
      deps: {
        boardService: {
          status: () => installed,
          install: () => {
            installed = true;
          },
        },
      },
      signal: ac2.signal,
    });
  });

  afterAll(() => ac2.abort());

  it('GET reflects launchd status and POST installs', async () => {
    const before = await fetch(`${BASE2}/api/board-service`);
    expect(await before.json()).toEqual({ installed: false, available: true });
    const post = await fetch(`${BASE2}/api/board-service`, { method: 'POST' });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ installed: true });
    const after = await fetch(`${BASE2}/api/board-service`);
    expect(await after.json()).toEqual({ installed: true, available: true });
  });
});

describe('pause / resume / burn', () => {
  it('toggles paused', async () => {
    const p = await fetch(`${BASE}/api/pause`, { method: 'POST' });
    expect(await p.json()).toEqual({ paused: true });
    expect(pausedFlag).toBe(true);
    const r = await fetch(`${BASE}/api/resume`, { method: 'POST' });
    expect(await r.json()).toEqual({ paused: false });
    expect(pausedFlag).toBe(false);
  });

  it('POST /api/burn forwards taskId + provider to triggerBurn', async () => {
    const res = await fetch(`${BASE}/api/burn`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 't_abc123', provider: 'claude' }),
    });
    expect(res.status).toBe(200);
    expect(burnCalls.at(-1)).toEqual(['t_abc123', 'claude']);
  });

  it('POST /api/burn validates ids and provider', async () => {
    const badId = await fetch(`${BASE}/api/burn`, {
      method: 'POST',
      body: JSON.stringify({ taskId: '../../etc/passwd' }),
    });
    expect(badId.status).toBe(400);
    const badProv = await fetch(`${BASE}/api/burn`, {
      method: 'POST',
      body: JSON.stringify({ provider: 'gpt' }),
    });
    expect(badProv.status).toBe(400);
  });
});

describe('PATCH /api/config', () => {
  it('rejects invalid patches with 400', async () => {
    const bads = [
      { modes: { weeklySurplus: { stopAtPct: 120 } } },
      { board: { port: 80 } },
      { providers: { gpt: { enabled: true } } },
      { providers: { claude: { defaults: { model: '' } } } },
      { judgePassScore: 9 },
      { reserve: { watchdogIntervalMinutes: 0 } },
      { hax: true },
      {},
    ];
    for (const body of bads) {
      const res = await fetch(`${BASE}/api/config`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('deep-merges, persists via updateConfig, and reflects in /api/state', async () => {
    const patch = {
      reserve: { weeklyPct: 20 },
      modes: { weeklySurplus: { stopAtPct: 90 } },
      providers: { codex: { enabled: true, weeklyResetFallback: 'Thu 21:00' } },
    };
    const res = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as SurplusConfig;
    expect(cfg.reserve.weeklyPct).toBe(20);
    expect(cfg.reserve.fiveHourPct).toBe(25); // untouched sibling survives
    expect(cfg.modes.weeklySurplus.stopAtPct).toBe(90);
    expect(cfg.modes.weeklySurplus.burnWindowHours).toBe(12); // untouched
    expect(cfg.providers.codex.enabled).toBe(true);
    expect(cfg.providers.codex.weeklyResetFallback).toBe('Thu 21:00');
    expect(cfg.providers.codex.defaults.model).toBe('gpt-5.1-codex'); // untouched
    expect(configPatches.at(-1)).toEqual(patch);
    const state = (await (await fetch(`${BASE}/api/state`)).json()) as { config: SurplusConfig };
    expect(state.config.reserve.weeklyPct).toBe(20);
  });
});

describe('multi-account /api/state + /api/burn', () => {
  const PORT3 = PORT + 421;
  const BASE3 = `http://127.0.0.1:${PORT3}`;
  const ac3 = new AbortController();
  const burn3: Array<[string | undefined, string | undefined]> = [];

  beforeAll(async () => {
    const cfg = makeConfig();
    cfg.providers.codex.enabled = true;
    cfg.providers.claude.accounts = [
      { id: 'main', label: 'personal', configDir: null, priority: null },
      { id: 'work', label: 'work', configDir: '~/.surplus/profiles/work', priority: 1 },
    ];
    await startServer({
      port: PORT3,
      db: makeDb(),
      config: cfg,
      accounts: [
        makeAccount('claude'),
        { ...makeAccount('claude', 'claude:work'), label: 'work', priority: 1 },
        makeAccount('codex'),
      ],
      decideFn: (input) => ({ action: 'idle', reason: `test:${input.usage.provider}` }),
      paused: () => false,
      setPaused: () => undefined,
      deps: {
        triggerBurn: async (taskId, provider) => {
          burn3.push([taskId, provider]);
          return { launched: 0 };
        },
      },
      signal: ac3.signal,
    });
  });

  afterAll(() => ac3.abort());

  it('keys usage + decisions by ACCOUNT key and lists accounts metadata', async () => {
    const res = await fetch(`${BASE3}/api/state`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as {
      usage: Record<string, { provider: string; planName: string } | null>;
      decisions: Record<string, { reason: string }>;
      accounts: Array<{ key: string; provider: string; label: string; priority: number | null }>;
    };
    expect(Object.keys(state.usage).sort()).toEqual(['claude', 'claude:work', 'codex']);
    expect(state.usage['claude:work']?.planName).toBe('Max');
    expect(state.usage['claude:work']?.provider).toBe('claude');
    expect(state.decisions['claude:work']?.reason).toBe('test:claude');
    expect(state.decisions.codex?.reason).toBe('test:codex');
    expect(state.accounts).toEqual([
      { key: 'claude', provider: 'claude', label: 'claude', priority: null },
      { key: 'claude:work', provider: 'claude', label: 'work', priority: 1 },
      { key: 'codex', provider: 'codex', label: 'codex', priority: null },
    ]);
  });

  it('accepts burn provider as an account key or a provider name; rejects unknown keys', async () => {
    const byKey = await fetch(`${BASE3}/api/burn`, {
      method: 'POST',
      body: JSON.stringify({ provider: 'claude:work' }),
    });
    expect(byKey.status).toBe(200);
    expect(burn3.at(-1)).toEqual([undefined, 'claude:work']);

    const byProvider = await fetch(`${BASE3}/api/burn`, {
      method: 'POST',
      body: JSON.stringify({ provider: 'claude' }),
    });
    expect(byProvider.status).toBe(200);
    expect(burn3.at(-1)).toEqual([undefined, 'claude']);

    for (const provider of ['claude:nope', 'codex:x', 'gpt', 'CLAUDE:WORK']) {
      const bad = await fetch(`${BASE3}/api/burn`, {
        method: 'POST',
        body: JSON.stringify({ provider }),
      });
      expect(bad.status).toBe(400);
    }
  });
});

describe('accounts PATCHed since boot', () => {
  it('persists providers.claude.accounts and lets /api/burn target the new key', async () => {
    // The main test server booted with a single live 'claude' adapter and no
    // accounts in config — PATCH the config (validated whole-array replace),
    // then burn against the new key: validation falls through the live
    // adapters to resolveAccounts(config).
    const res = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      body: JSON.stringify({
        providers: {
          claude: {
            accounts: [
              { id: 'main', label: 'personal', configDir: null, priority: null },
              { id: 'beta', label: 'beta', configDir: '~/.surplus/profiles/beta', priority: null },
            ],
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as SurplusConfig;
    expect(cfg.providers.claude.accounts).toHaveLength(2);
    expect(cfg.providers.claude.defaults.model).toBe('opus'); // siblings survive

    const burn = await fetch(`${BASE}/api/burn`, {
      method: 'POST',
      body: JSON.stringify({ provider: 'claude:beta' }),
    });
    expect(burn.status).toBe(200);
    expect(burnCalls.at(-1)).toEqual([undefined, 'claude:beta']);

    const unknown = await fetch(`${BASE}/api/burn`, {
      method: 'POST',
      body: JSON.stringify({ provider: 'claude:gone' }),
    });
    expect(unknown.status).toBe(400);
  });

  it('account removal rewrites pinned task/project affinities to claude and records events', async () => {
    // 'beta' is configured by the previous test — pin a task and a project to it.
    const created = await fetch(`${BASE}/api/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'demo',
        title: 'pinned to beta',
        provider: 'claude:beta',
        status: 'ready',
      }),
    });
    expect(created.status).toBe(201);
    const pinned = (await created.json()) as TaskRow;
    expect(pinned.provider).toBe('claude:beta');
    const projRes = await fetch(`${BASE}/api/projects/demo`, {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'claude:beta' }),
    });
    expect(projRes.status).toBe(200);

    // Remove 'beta'. The pinned rows would never match the claim predicate
    // again — they must be rewritten, not left to starve silently in 'ready'.
    const res = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      body: JSON.stringify({
        providers: {
          claude: {
            accounts: [{ id: 'main', label: 'personal', configDir: null, priority: null }],
          },
        },
      }),
    });
    expect(res.status).toBe(200);

    const detail = (await (await fetch(`${BASE}/api/tasks/${pinned.id}`)).json()) as {
      task: TaskRow;
    };
    expect(detail.task.provider).toBe('claude');
    const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as ProjectRow[];
    expect(projects.find((p) => p.id === 'demo')?.provider).toBe('claude');
    const rewrites = db.events.filter(
      (e) => e.type === 'task-updated' && e.data.includes('affinity reset to claude'),
    );
    expect(rewrites.length).toBeGreaterThanOrEqual(2);
  });
});

describe('SSE /api/events', () => {
  it('replays history as ev events and sends a state event', async () => {
    const sseAc = new AbortController();
    const res = await fetch(`${BASE}/api/events?after=0`, {
      signal: sseAc.signal,
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(buf.includes('event: state') && buf.includes('event: ev'))) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (chunk.done) break;
      buf += decoder.decode(chunk.value);
    }
    sseAc.abort();
    expect(buf).toContain('event: ev');
    expect(buf).toContain('"type":"decision"');
    expect(buf).toContain('event: state');
    expect(buf).not.toContain('accessToken');
  });
});
