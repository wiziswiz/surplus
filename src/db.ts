/**
 * surplus — SQLite persistence (queue: projects, tasks, runs, events).
 *
 * better-sqlite3, WAL mode, foreign keys ON. All snake_case columns are mapped
 * to the camelCase row interfaces declared in types.ts.
 */
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DB_FILE,
  SURPLUS_DIR_NAME,
  type Provider,
  type ProviderPref,
  type ProjectRow,
  type RunOutcome,
  type TaskEventRow,
  type TaskEventType,
  type TaskRow,
  type TaskRunRow,
  type TaskStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface CreateProjectInput {
  /** Optional explicit slug; sanitized to [A-Za-z0-9_-]. Generated ('p_…') when omitted. */
  id?: string;
  name: string;
  path: string;
  visionPath: string;
  provider?: ProviderPref;
  model?: string | null;
  effort?: string | null;
  createdAt?: number;
}

export interface CreateTaskInput {
  id?: string;
  projectId: string;
  title: string;
  body?: string;
  status?: TaskStatus;
  priority?: number;
  attempts?: number;
  maxAttempts?: number;
  provider?: ProviderPref;
  model?: string | null;
  effort?: string | null;
  judgeFeedback?: string | null;
  parentId?: string | null;
  scheduledAt?: number | null;
  createdAt?: number;
}

export type ProjectPatch = Partial<Pick<ProjectRow, 'name' | 'provider' | 'model' | 'effort'>>;

export type TaskPatch = Partial<
  Pick<
    TaskRow,
    | 'title'
    | 'body'
    | 'status'
    | 'priority'
    | 'attempts'
    | 'maxAttempts'
    | 'provider'
    | 'model'
    | 'effort'
    | 'judgeFeedback'
    | 'parentId'
    | 'scheduledAt'
    | 'consecutiveInfra'
  >
>;

export interface TaskFilter {
  status?: TaskStatus;
  projectId?: string;
}

export interface CreateRunInput {
  id?: string;
  taskId: string;
  provider?: Provider | null;
  startedAt?: number;
  model?: string | null;
  effort?: string | null;
  branch?: string | null;
  logPath?: string | null;
}

export type RunPatch = Partial<
  Pick<
    TaskRunRow,
    | 'provider'
    | 'startedAt'
    | 'endedAt'
    | 'outcome'
    | 'exitCode'
    | 'branch'
    | 'summary'
    | 'judgeScore'
    | 'judgeReasons'
    | 'judgeMissing'
    | 'model'
    | 'effort'
    | 'logPath'
  >
>;

export interface SurplusDb {
  /** Underlying handle (server.ts may need pragmas/checkpoints; avoid raw SQL elsewhere). */
  readonly raw: Database.Database;

  createProject(input: CreateProjectInput): ProjectRow;
  getProject(id: string): ProjectRow | null;
  listProjects(): ProjectRow[];
  /** Appends a 'task-updated' event (taskId null) with {projectId, changed}. */
  updateProject(id: string, patch: ProjectPatch): ProjectRow;
  /**
   * Delete a project and its ARCHIVED tasks (runs first — FK order). Throws
   * when any task is not 'archived'; returns false when the project is unknown.
   */
  deleteProject(id: string): boolean;

  createTask(input: CreateTaskInput): TaskRow;
  getTask(id: string): TaskRow | null;
  /** Auto-updates updated_at; appends a 'status-changed' (when status changes) or 'task-updated' event. */
  updateTask(id: string, patch: TaskPatch): TaskRow;
  /** No filter → all non-archived tasks. */
  listTasks(filter?: TaskFilter): TaskRow[];

  /**
   * Atomically claim the next dispatchable 'ready' task for an account:
   * lowest priority number first, then oldest. A task's affinity matches when
   * it is 'any', the account's provider name, or the account's key
   * ('claude:<id>'); `accountKey` defaults to `provider` (the pre-account
   * back-compat: the main claude account's key IS 'claude'). Excludes tasks
   * scheduled in the future, tasks whose parent isn't done, and any task in a
   * project that already has a 'running' task. Sets status='running' and
   * increments attempts in one BEGIN IMMEDIATE transaction (concurrent
   * processes wait on the busy timeout instead of throwing
   * SQLITE_BUSY_SNAPSHOT). When `maxConcurrent` is given, the claim also
   * refuses atomically once that many tasks are 'running' globally. Returns
   * the updated row or null.
   */
  claimNextReadyTask(
    now: number,
    provider: Provider,
    maxConcurrent?: number,
    accountKey?: string,
  ): TaskRow | null;

  /**
   * Atomically claim a SPECIFIC task for a manual one-shot burn: a single
   * status-guarded UPDATE (status='ready' + affinity-compatible with the
   * provider/accountKey pair), so a concurrent tick in another process can
   * never double-claim it. Returns the updated row, or null when the guard
   * failed.
   */
  claimTaskById(id: string, now: number, provider: Provider, accountKey?: string): TaskRow | null;

  createRun(input: CreateRunInput): TaskRunRow;
  updateRun(id: string, patch: RunPatch): TaskRunRow;
  listRunsForTask(taskId: string): TaskRunRow[];

  appendEvent(type: TaskEventType, taskId: string | null, data: object): TaskEventRow;
  listEventsAfter(id: number, limit?: number): TaskEventRow[];

  countRunning(): number;
  close(): void;
}

// ---------------------------------------------------------------------------
// Id generation: 'p_'/'t_'/'r_' + 12 random base36 chars.
// Alphanumeric + underscore only — ids appear in branch names and file paths.
// ---------------------------------------------------------------------------

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

export function generateId(prefix: 'p' | 't' | 'r'): string {
  const bytes = randomBytes(12);
  let suffix = '';
  for (let i = 0; i < 12; i++) suffix += BASE36[bytes[i]! % 36];
  return `${prefix}_${suffix}`;
}

function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-]+|[-]+$/g, '');
  if (!cleaned) throw new Error('id is empty after sanitization');
  return cleaned;
}

// ---------------------------------------------------------------------------
// Schema (single-statement DDL run individually; user_version migration guard)
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 2;

const DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,
    vision_path TEXT NOT NULL,
    provider    TEXT NOT NULL DEFAULT 'any',
    model       TEXT,
    effort      TEXT,
    created_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id),
    title          TEXT NOT NULL,
    body           TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'triage',
    priority       INTEGER NOT NULL DEFAULT 100,
    attempts       INTEGER NOT NULL DEFAULT 0,
    max_attempts   INTEGER NOT NULL DEFAULT 3,
    provider       TEXT NOT NULL DEFAULT 'any',
    model          TEXT,
    effort         TEXT,
    judge_feedback TEXT,
    parent_id      TEXT,
    scheduled_at   INTEGER,
    consecutive_infra INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`,
  `CREATE TABLE IF NOT EXISTS task_runs (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL REFERENCES tasks(id),
    provider      TEXT,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    outcome       TEXT,
    exit_code     INTEGER,
    branch        TEXT,
    summary       TEXT,
    judge_score   INTEGER,
    judge_reasons TEXT,
    judge_missing TEXT,
    model         TEXT,
    effort        TEXT,
    log_path      TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id)`,
  `CREATE TABLE IF NOT EXISTS task_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    task_id TEXT,
    type    TEXT NOT NULL,
    data    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id)`,
];

function migrate(db: Database.Database): void {
  const current = Number(db.pragma('user_version', { simple: true }));
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `surplus.db schema version ${current} is newer than this build supports (${SCHEMA_VERSION}); upgrade surplus.`,
    );
  }
  for (const stmt of DDL_STATEMENTS) db.prepare(stmt).run();
  if (current < SCHEMA_VERSION) {
    // v2: consecutive-infra counter (bounds transient-error retry churn). Added
    // idempotently — CREATE TABLE above already includes it for fresh DBs, so we
    // only ALTER a pre-existing table that lacks the column.
    addColumnIfMissing(db, 'tasks', 'consecutive_infra', 'INTEGER NOT NULL DEFAULT 0');
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

/** ALTER TABLE … ADD COLUMN only when the column is absent (fresh DBs already have it). */
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  }
}

// ---------------------------------------------------------------------------
// Row mapping (snake_case DB → camelCase contracts)
// ---------------------------------------------------------------------------

interface ProjectDbRow {
  id: string;
  name: string;
  path: string;
  vision_path: string;
  provider: string;
  model: string | null;
  effort: string | null;
  created_at: number;
}

interface TaskDbRow {
  id: string;
  project_id: string;
  title: string;
  body: string;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  provider: string;
  model: string | null;
  effort: string | null;
  judge_feedback: string | null;
  parent_id: string | null;
  scheduled_at: number | null;
  consecutive_infra: number;
  created_at: number;
  updated_at: number;
}

interface RunDbRow {
  id: string;
  task_id: string;
  provider: string | null;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  exit_code: number | null;
  branch: string | null;
  summary: string | null;
  judge_score: number | null;
  judge_reasons: string | null;
  judge_missing: string | null;
  model: string | null;
  effort: string | null;
  log_path: string | null;
}

interface EventDbRow {
  id: number;
  ts: number;
  task_id: string | null;
  type: string;
  data: string;
}

function mapProject(r: ProjectDbRow): ProjectRow {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    visionPath: r.vision_path,
    provider: r.provider as ProviderPref,
    model: r.model,
    effort: r.effort,
    createdAt: r.created_at,
  };
}

function mapTask(r: TaskDbRow): TaskRow {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    body: r.body,
    status: r.status as TaskStatus,
    priority: r.priority,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    provider: r.provider as ProviderPref,
    model: r.model,
    effort: r.effort,
    judgeFeedback: r.judge_feedback,
    parentId: r.parent_id,
    scheduledAt: r.scheduled_at,
    consecutiveInfra: r.consecutive_infra,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapRun(r: RunDbRow): TaskRunRow {
  return {
    id: r.id,
    taskId: r.task_id,
    provider: r.provider as Provider | null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outcome: r.outcome as RunOutcome | null,
    exitCode: r.exit_code,
    branch: r.branch,
    summary: r.summary,
    judgeScore: r.judge_score,
    judgeReasons: r.judge_reasons,
    judgeMissing: r.judge_missing,
    model: r.model,
    effort: r.effort,
    logPath: r.log_path,
  };
}

function mapEvent(r: EventDbRow): TaskEventRow {
  return {
    id: r.id,
    ts: r.ts,
    taskId: r.task_id,
    type: r.type as TaskEventType,
    data: r.data,
  };
}

/** camelCase patch key → snake_case column, for dynamic UPDATEs. */
const PROJECT_PATCH_COLUMNS: Record<keyof ProjectPatch & string, string> = {
  name: 'name',
  provider: 'provider',
  model: 'model',
  effort: 'effort',
};

const TASK_PATCH_COLUMNS: Record<keyof TaskPatch & string, string> = {
  title: 'title',
  body: 'body',
  status: 'status',
  priority: 'priority',
  attempts: 'attempts',
  maxAttempts: 'max_attempts',
  provider: 'provider',
  model: 'model',
  effort: 'effort',
  judgeFeedback: 'judge_feedback',
  parentId: 'parent_id',
  scheduledAt: 'scheduled_at',
  consecutiveInfra: 'consecutive_infra',
};

const RUN_PATCH_COLUMNS: Record<keyof RunPatch & string, string> = {
  provider: 'provider',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  outcome: 'outcome',
  exitCode: 'exit_code',
  branch: 'branch',
  summary: 'summary',
  judgeScore: 'judge_score',
  judgeReasons: 'judge_reasons',
  judgeMissing: 'judge_missing',
  model: 'model',
  effort: 'effort',
  logPath: 'log_path',
};

interface TaskInsertParams {
  id: string;
  projectId: string;
  title: string;
  body: string;
  status: TaskStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  provider: ProviderPref;
  model: string | null;
  effort: string | null;
  judgeFeedback: string | null;
  parentId: string | null;
  scheduledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// openDb
// ---------------------------------------------------------------------------

export function openDb(dbFilePath?: string): SurplusDb {
  const filePath = dbFilePath ?? join(homedir(), SURPLUS_DIR_NAME, DB_FILE);
  mkdirSync(dirname(filePath), { recursive: true });

  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);

  // -- prepared statements ----------------------------------------------------

  const insertProject = db.prepare(
    `INSERT INTO projects (id, name, path, vision_path, provider, model, effort, created_at)
     VALUES (@id, @name, @path, @visionPath, @provider, @model, @effort, @createdAt)`,
  );
  const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');
  const selectProjects = db.prepare('SELECT * FROM projects ORDER BY created_at ASC');

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, project_id, title, body, status, priority, attempts, max_attempts,
                        provider, model, effort, judge_feedback, parent_id, scheduled_at,
                        created_at, updated_at)
     VALUES (@id, @projectId, @title, @body, @status, @priority, @attempts, @maxAttempts,
             @provider, @model, @effort, @judgeFeedback, @parentId, @scheduledAt,
             @createdAt, @updatedAt)`,
  );
  const selectTask = db.prepare('SELECT * FROM tasks WHERE id = ?');

  const insertRun = db.prepare(
    `INSERT INTO task_runs (id, task_id, provider, started_at, model, effort, branch, log_path)
     VALUES (@id, @taskId, @provider, @startedAt, @model, @effort, @branch, @logPath)`,
  );
  const selectRun = db.prepare('SELECT * FROM task_runs WHERE id = ?');
  const selectRunsForTask = db.prepare(
    'SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at ASC, id ASC',
  );

  const insertEvent = db.prepare(
    'INSERT INTO task_events (ts, task_id, type, data) VALUES (?, ?, ?, ?)',
  );
  const selectEventsAfter = db.prepare(
    'SELECT * FROM task_events WHERE id > ? ORDER BY id ASC LIMIT ?',
  );

  const selectClaimable = db.prepare(
    `SELECT id FROM tasks t
     WHERE t.status = 'ready'
       AND (t.provider = @provider OR t.provider = @accountKey OR t.provider = 'any')
       AND (t.scheduled_at IS NULL OR t.scheduled_at <= @now)
       AND (t.parent_id IS NULL
            OR EXISTS (SELECT 1 FROM tasks p WHERE p.id = t.parent_id AND p.status = 'done'))
       AND NOT EXISTS (SELECT 1 FROM tasks r
                       WHERE r.project_id = t.project_id AND r.status = 'running')
       AND (@maxConcurrent IS NULL
            OR (SELECT COUNT(*) FROM tasks g WHERE g.status = 'running') < @maxConcurrent)
     ORDER BY t.priority ASC, t.created_at ASC, t.id ASC
     LIMIT 1`,
  );
  const updateClaim = db.prepare(
    `UPDATE tasks SET status = 'running', attempts = attempts + 1, updated_at = @now WHERE id = @id`,
  );
  // Forced claim: the status/provider guard lives in the UPDATE itself so the
  // claim is atomic across processes (no read-then-write window).
  const updateClaimById = db.prepare(
    `UPDATE tasks SET status = 'running', attempts = attempts + 1, updated_at = @now
     WHERE id = @id AND status = 'ready'
       AND (provider = @provider OR provider = @accountKey OR provider = 'any')`,
  );

  const countRunningStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'`,
  );

  // -- helpers ------------------------------------------------------------------

  function appendEvent(type: TaskEventType, taskId: string | null, data: object): TaskEventRow {
    const ts = Date.now();
    const json = JSON.stringify(data ?? {});
    const info = insertEvent.run(ts, taskId, type, json);
    return { id: Number(info.lastInsertRowid), ts, taskId, type, data: json };
  }

  function getTask(id: string): TaskRow | null {
    const row = selectTask.get(id) as TaskDbRow | undefined;
    return row ? mapTask(row) : null;
  }

  function getRun(id: string): TaskRunRow | null {
    const row = selectRun.get(id) as RunDbRow | undefined;
    return row ? mapRun(row) : null;
  }

  const createTaskTx = db.transaction((params: TaskInsertParams): void => {
    insertTask.run(params);
    appendEvent('task-created', params.id, {
      projectId: params.projectId,
      title: params.title,
      status: params.status,
      priority: params.priority,
    });
  });

  const updateProjectTx = db.transaction((id: string, patch: ProjectPatch): void => {
    const sets: string[] = [];
    const values: unknown[] = [];
    const changed: string[] = [];
    for (const [key, col] of Object.entries(PROJECT_PATCH_COLUMNS)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      sets.push(`${col} = ?`);
      values.push(value);
      changed.push(key);
    }
    if (sets.length === 0) return;
    values.push(id);
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    // No project event type exists — reuse 'task-updated' (taskId null) so SSE
    // clients refetch without a schema change.
    appendEvent('task-updated', null, { projectId: id, changed });
  });

  // FK order: task_runs → tasks → projects. Refuse while any task is live.
  const deleteProjectTx = db.transaction((id: string): boolean => {
    const exists = selectProject.get(id) as ProjectDbRow | undefined;
    if (!exists) return false;
    const live = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status != 'archived'`)
      .get(id) as { n: number };
    if (live.n > 0) {
      throw new Error(
        `project '${id}' has ${live.n} non-archived task(s) — archive them before deleting`,
      );
    }
    db.prepare(
      `DELETE FROM task_runs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
    ).run(id);
    db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return true;
  });

  const updateTaskTx = db.transaction((id: string, patch: TaskPatch, existing: TaskRow): void => {
    const sets: string[] = [];
    const values: unknown[] = [];
    const changed: string[] = [];
    for (const [key, col] of Object.entries(TASK_PATCH_COLUMNS)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      sets.push(`${col} = ?`);
      values.push(value);
      changed.push(key);
    }
    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    const statusChanged = patch.status !== undefined && patch.status !== existing.status;
    if (statusChanged) {
      appendEvent('status-changed', id, { from: existing.status, to: patch.status, changed });
    } else {
      appendEvent('task-updated', id, { changed });
    }
  });

  // Invoked via .immediate(): BEGIN IMMEDIATE takes the write lock up front,
  // so the SELECT sees the latest committed state and a concurrent claimer
  // waits on the busy timeout instead of throwing SQLITE_BUSY_SNAPSHOT on
  // the read→write upgrade (which would abort the whole tick).
  const claimTx = db.transaction(
    (
      nowMs: number,
      provider: Provider,
      maxConcurrent: number | null,
      accountKey: string,
    ): string | null => {
      const row = selectClaimable.get({ provider, accountKey, now: nowMs, maxConcurrent }) as
        | { id: string }
        | undefined;
      if (!row) return null;
      updateClaim.run({ now: nowMs, id: row.id });
      appendEvent('status-changed', row.id, {
        from: 'ready',
        to: 'running',
        provider,
        account: accountKey,
        via: 'claim',
      });
      return row.id;
    },
  );

  const claimByIdTx = db.transaction(
    (id: string, nowMs: number, provider: Provider, accountKey: string): boolean => {
      const info = updateClaimById.run({ id, now: nowMs, provider, accountKey });
      if (info.changes !== 1) return false;
      appendEvent('status-changed', id, {
        from: 'ready',
        to: 'running',
        provider,
        account: accountKey,
        via: 'forced-claim',
      });
      return true;
    },
  );

  // -- public API -----------------------------------------------------------------

  const api: SurplusDb = {
    raw: db,

    createProject(input: CreateProjectInput): ProjectRow {
      const id = input.id !== undefined ? sanitizeId(input.id) : generateId('p');
      const createdAt = input.createdAt ?? Date.now();
      insertProject.run({
        id,
        name: input.name,
        path: input.path,
        visionPath: input.visionPath,
        provider: input.provider ?? 'any',
        model: input.model ?? null,
        effort: input.effort ?? null,
        createdAt,
      });
      const row = selectProject.get(id) as ProjectDbRow;
      return mapProject(row);
    },

    getProject(id: string): ProjectRow | null {
      const row = selectProject.get(id) as ProjectDbRow | undefined;
      return row ? mapProject(row) : null;
    },

    listProjects(): ProjectRow[] {
      return (selectProjects.all() as ProjectDbRow[]).map(mapProject);
    },

    updateProject(id: string, patch: ProjectPatch): ProjectRow {
      const existing = selectProject.get(id) as ProjectDbRow | undefined;
      if (!existing) throw new Error(`project not found: ${id}`);
      updateProjectTx(id, patch);
      const updated = selectProject.get(id) as ProjectDbRow | undefined;
      if (!updated) throw new Error(`project vanished during update: ${id}`);
      return mapProject(updated);
    },

    deleteProject(id: string): boolean {
      return deleteProjectTx.immediate(id) === true;
    },

    createTask(input: CreateTaskInput): TaskRow {
      const id = input.id !== undefined ? sanitizeId(input.id) : generateId('t');
      const createdAt = input.createdAt ?? Date.now();
      createTaskTx({
        id,
        projectId: input.projectId,
        title: input.title,
        body: input.body ?? '',
        status: input.status ?? 'triage',
        priority: input.priority ?? 100,
        attempts: input.attempts ?? 0,
        maxAttempts: input.maxAttempts ?? 3,
        provider: input.provider ?? 'any',
        model: input.model ?? null,
        effort: input.effort ?? null,
        judgeFeedback: input.judgeFeedback ?? null,
        parentId: input.parentId ?? null,
        scheduledAt: input.scheduledAt ?? null,
        createdAt,
        updatedAt: createdAt,
      });
      const task = getTask(id);
      if (!task) throw new Error(`task insert failed: ${id}`);
      return task;
    },

    getTask,

    updateTask(id: string, patch: TaskPatch): TaskRow {
      const existing = getTask(id);
      if (!existing) throw new Error(`task not found: ${id}`);
      updateTaskTx(id, patch, existing);
      const updated = getTask(id);
      if (!updated) throw new Error(`task vanished during update: ${id}`);
      return updated;
    },

    listTasks(filter?: TaskFilter): TaskRow[] {
      const where: string[] = [];
      const values: unknown[] = [];
      if (filter?.status !== undefined) {
        where.push('status = ?');
        values.push(filter.status);
      } else {
        where.push(`status != 'archived'`);
      }
      if (filter?.projectId !== undefined) {
        where.push('project_id = ?');
        values.push(filter.projectId);
      }
      const sql = `SELECT * FROM tasks WHERE ${where.join(' AND ')}
                   ORDER BY priority ASC, created_at ASC, id ASC`;
      return (db.prepare(sql).all(...values) as TaskDbRow[]).map(mapTask);
    },

    claimNextReadyTask(
      now: number,
      provider: Provider,
      maxConcurrent?: number,
      accountKey?: string,
    ): TaskRow | null {
      const id = claimTx.immediate(now, provider, maxConcurrent ?? null, accountKey ?? provider);
      return id === null || id === undefined ? null : getTask(id);
    },

    claimTaskById(id: string, now: number, provider: Provider, accountKey?: string): TaskRow | null {
      return claimByIdTx.immediate(id, now, provider, accountKey ?? provider) ? getTask(id) : null;
    },

    createRun(input: CreateRunInput): TaskRunRow {
      const id = input.id !== undefined ? sanitizeId(input.id) : generateId('r');
      insertRun.run({
        id,
        taskId: input.taskId,
        provider: input.provider ?? null,
        startedAt: input.startedAt ?? Date.now(),
        model: input.model ?? null,
        effort: input.effort ?? null,
        branch: input.branch ?? null,
        logPath: input.logPath ?? null,
      });
      const run = getRun(id);
      if (!run) throw new Error(`run insert failed: ${id}`);
      return run;
    },

    updateRun(id: string, patch: RunPatch): TaskRunRow {
      const existing = getRun(id);
      if (!existing) throw new Error(`run not found: ${id}`);
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [key, col] of Object.entries(RUN_PATCH_COLUMNS)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value === undefined) continue;
        sets.push(`${col} = ?`);
        values.push(value);
      }
      if (sets.length > 0) {
        values.push(id);
        db.prepare(`UPDATE task_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      }
      const updated = getRun(id);
      if (!updated) throw new Error(`run vanished during update: ${id}`);
      return updated;
    },

    listRunsForTask(taskId: string): TaskRunRow[] {
      return (selectRunsForTask.all(taskId) as RunDbRow[]).map(mapRun);
    },

    appendEvent,

    listEventsAfter(id: number, limit = 500): TaskEventRow[] {
      return (selectEventsAfter.all(id, limit) as EventDbRow[]).map(mapEvent);
    },

    countRunning(): number {
      const row = countRunningStmt.get() as { n: number };
      return row.n;
    },

    close(): void {
      db.close();
    },
  };

  return api;
}
