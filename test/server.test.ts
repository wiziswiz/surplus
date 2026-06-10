import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  ProjectRow,
  Provider,
  ProviderAdapter,
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

function makeAdapter(provider: Provider): ProviderAdapter {
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
    provider,
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
const burnCalls: Array<[string | undefined, Provider | undefined]> = [];
const serverConfig = makeConfig();
const configPatches: unknown[] = [];
let tmpRepo: string;

beforeAll(async () => {
  tmpRepo = mkdtempSync(path.join(tmpdir(), 'surplus-board-test-'));
  mkdirSync(path.join(tmpRepo, '.git'));
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
  db.appendEvent('decision', null, { seeded: true });
  await startServer({
    port: PORT,
    db,
    config: serverConfig,
    adapters: { claude: makeAdapter('claude') },
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
