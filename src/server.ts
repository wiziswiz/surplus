/**
 * surplus — board HTTP server.
 *
 * Hono + @hono/node-server implementing the REST/SSE contract at the bottom
 * of types.ts, plus static serving of board/dist.
 *
 * SECURITY:
 *  - Binds 127.0.0.1 ONLY. This server can trigger code execution (burn).
 *  - Every id from the wire is validated against /^[a-z0-9_-]+$/i before ANY use.
 *  - No credentials/tokens ever appear in responses; error text is redacted.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AccountAdapter,
  ApiState,
  ClaudeAccountConfig,
  DecideInput,
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
} from './types.js';
import { defaultClaudeDir, expandTilde, MAX_CLAUDE_ACCOUNTS, resolveAccounts } from './config.js';
import { discoverRepos } from './discover.js';

// ---------------------------------------------------------------------------
// Structural db interface (subset of db.ts the server needs)
// ---------------------------------------------------------------------------

export interface ServerDb {
  listProjects(): ProjectRow[];
  getProject(id: string): ProjectRow | undefined | null;
  insertProject(row: ProjectRow): void;
  updateProject(
    id: string,
    patch: Partial<Pick<ProjectRow, 'name' | 'provider' | 'model' | 'effort'>>,
  ): ProjectRow | undefined | null;
  /** Throws when the project still has non-archived tasks; false when unknown. */
  deleteProject(id: string): boolean;
  /** No arg → all non-archived tasks. */
  listTasks(status?: TaskStatus): TaskRow[];
  getTask(id: string): TaskRow | undefined | null;
  insertTask(row: TaskRow): void;
  updateTask(id: string, patch: Partial<TaskRow>): TaskRow | undefined | null;
  listRuns(taskId: string): TaskRunRow[];
  listEventsForTask(taskId: string, limit?: number): TaskEventRow[];
  /** Rows with id > afterId, ascending. */
  eventsAfter(afterId: number, limit?: number): TaskEventRow[];
  /** Most recent `limit` rows, ascending by id. */
  lastEvents(limit: number): TaskEventRow[];
  appendEvent(type: TaskEventType, taskId: string | null, data: unknown): TaskEventRow;
}

export interface ServerDeps {
  /** Draft VISION.md for an existing repo that lacks one. */
  draftVision?: (project: ProjectRow) => Promise<unknown>;
  /** Create a brand-new project (dir + git init + VISION.md); returns the row. */
  scaffoldProject?: (name: string) => Promise<ProjectRow>;
  /**
   * Manual one-shot dispatch (ignores windows, respects pacing). `provider`
   * accepts a provider name or an AccountKey ('claude:<id>').
   */
  triggerBurn?: (taskId?: string, provider?: string) => Promise<unknown>;
  /**
   * Persist a validated config patch (deep-merge over the loaded config and
   * save); returns the new effective config. Injected by cli.ts using
   * loadConfig/saveConfig — PATCH /api/config is 503 without it.
   */
  updateConfig?: (patch: ConfigPatch) => SurplusConfig | Promise<SurplusConfig>;
  /**
   * The master switch: query/toggle the launchd tick scheduler. Injected by
   * cli.ts using install.ts — POST /api/scheduler is 503 without it, and
   * ApiState.armed is false.
   */
  scheduler?: {
    status: () => boolean;
    setArmed: (on: boolean) => boolean;
  };
  /**
   * Always-on board service (launchd KeepAlive + Dock app). Injected by
   * cli.ts using install.ts — POST /api/board-service is 503 without it.
   * Install-only by design: removing the service from inside the service it
   * keeps alive is a footgun, so uninstall stays CLI-only.
   */
  boardService?: {
    status: () => boolean;
    install: () => void;
  };
}

export interface StartServerOptions {
  port: number;
  db: ServerDb;
  config: SurplusConfig;
  /** Burnable accounts (one AccountAdapter per claude account + codex). */
  accounts: AccountAdapter[];
  decideFn: (input: DecideInput) => Decision;
  paused: () => boolean;
  setPaused: (b: boolean) => void;
  deps?: ServerDeps;
  /** Optional: abort to shut the server down (tests / cli graceful exit). */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Validation & helpers
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9_-]+$/i;
const PROVIDERS: readonly Provider[] = ['claude', 'codex'];
const PROVIDER_PREFS: readonly ProviderPref[] = ['claude', 'codex', 'any'];
/** Account id slug ('main' reserved for the default claude account). */
const ACCOUNT_ID_RE = /^[a-z0-9-]{1,24}$/;
/** Non-main claude account affinity: 'claude:<id>'. */
const CLAUDE_ACCOUNT_KEY_RE = /^claude:[a-z0-9-]{1,24}$/;
const TASK_STATUSES: readonly TaskStatus[] = [
  'triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived',
];

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && ID_RE.test(id);
}

function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);
}

/** Affinity grammar: claude | codex | any | claude:<id>. */
function isProviderPref(v: unknown): v is ProviderPref {
  return (
    typeof v === 'string' &&
    ((PROVIDER_PREFS as readonly string[]).includes(v) || CLAUDE_ACCOUNT_KEY_RE.test(v))
  );
}

function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True when a Host header ('127.0.0.1:4242', 'localhost', '[::1]:4242') is loopback. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  return LOOPBACK_HOSTNAMES.has(name);
}

/** True when an Origin header ('http://localhost:4242') resolves to a loopback host. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Strip anything that looks like a credential from error text. */
export function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.?[A-Za-z0-9_-]*/g, '[redacted]')
    .replace(/(accessToken|access_token|refresh_token|authorization)["':\s=]+\S+/gi, '$1=[redacted]');
}

function errMsg(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e));
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const text = await c.req.text();
    if (!text.trim()) return {};
    const v: unknown = JSON.parse(text);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function genTaskId(): string {
  return `t_${randomBytes(8).toString('hex')}`; // alphanumeric + underscore only
}

/** Project id: alphanumeric + dashes only (per ProjectRow contract). */
export function slugifyProjectId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Fields the board may PATCH. 'running' transitions are dispatcher-only. */
export function buildTaskPatch(
  body: Record<string, unknown>,
): { ok: true; patch: Partial<TaskRow> } | { ok: false; error: string } {
  const patch: Partial<TaskRow> = {};
  if ('status' in body) {
    if (!isTaskStatus(body.status)) return { ok: false, error: 'invalid status' };
    if (body.status === 'running') {
      return { ok: false, error: "cannot set status to 'running' (dispatcher-only)" };
    }
    patch.status = body.status;
  }
  if ('priority' in body) {
    if (typeof body.priority !== 'number' || !Number.isFinite(body.priority)) {
      return { ok: false, error: 'priority must be a number' };
    }
    patch.priority = Math.round(body.priority);
  }
  if ('title' in body) {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return { ok: false, error: 'title must be a non-empty string' };
    }
    patch.title = body.title.trim();
  }
  if ('body' in body) {
    if (typeof body.body !== 'string') return { ok: false, error: 'body must be a string' };
    patch.body = body.body;
  }
  if ('model' in body) {
    if (body.model !== null && typeof body.model !== 'string') {
      return { ok: false, error: 'model must be a string or null' };
    }
    patch.model = body.model;
  }
  if ('effort' in body) {
    if (body.effort !== null && typeof body.effort !== 'string') {
      return { ok: false, error: 'effort must be a string or null' };
    }
    patch.effort = body.effort;
  }
  if ('scheduledAt' in body) {
    if (body.scheduledAt !== null && typeof body.scheduledAt !== 'number') {
      return { ok: false, error: 'scheduledAt must be a number or null' };
    }
    patch.scheduledAt = body.scheduledAt;
  }
  if ('provider' in body) {
    if (!isProviderPref(body.provider)) return { ok: false, error: 'invalid provider' };
    patch.provider = body.provider;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'no patchable fields' };
  return { ok: true, patch };
}

/** Max bytes accepted for PUT /api/projects/:id/vision. */
export const VISION_MAX_CHARS = 64_000;

type ProjectPatchFields = Partial<Pick<ProjectRow, 'name' | 'provider' | 'model' | 'effort'>>;

/** Fields the board may PATCH on a project (path/visionPath are immutable). */
export function buildProjectPatch(
  body: Record<string, unknown>,
): { ok: true; patch: ProjectPatchFields } | { ok: false; error: string } {
  const patch: ProjectPatchFields = {};
  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return { ok: false, error: 'name must be a non-empty string' };
    }
    patch.name = body.name.trim();
  }
  if ('provider' in body) {
    if (!isProviderPref(body.provider)) return { ok: false, error: 'invalid provider' };
    patch.provider = body.provider;
  }
  if ('model' in body) {
    if (body.model !== null && (typeof body.model !== 'string' || !body.model.trim())) {
      return { ok: false, error: 'model must be a non-empty string or null' };
    }
    patch.model = body.model === null ? null : body.model.trim();
  }
  if ('effort' in body) {
    if (body.effort !== null && (typeof body.effort !== 'string' || !body.effort.trim())) {
      return { ok: false, error: 'effort must be a non-empty string or null' };
    }
    patch.effort = body.effort === null ? null : body.effort.trim();
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'no patchable fields' };
  return { ok: true, patch };
}

// ---------------------------------------------------------------------------
// PATCH /api/config — validation + deep merge
// ---------------------------------------------------------------------------

/** Deep partial of SurplusConfig accepted by PATCH /api/config. */
export interface ConfigPatch {
  providers?: Partial<
    Record<
      Provider,
      {
        enabled?: boolean;
        defaults?: { model?: string; effort?: string };
        weeklyResetFallback?: string | null;
        /** claude only (rejected for codex). Whole-array replace, max 6. */
        accounts?: ClaudeAccountConfig[];
      }
    >
  >;
  modes?: {
    weeklySurplus?: { enabled?: boolean; burnWindowHours?: number; stopAtPct?: number };
    fiveHourBurst?: { enabled?: boolean; triggerMinutesBeforeReset?: number; weeklyGuardPct?: number };
  };
  pacing?: { fiveHourPausePct?: number };
  reserve?: { weeklyPct?: number; fiveHourPct?: number; watchdogIntervalMinutes?: number };
  dispatcher?: {
    maxConcurrent?: number;
    maxAttempts?: number;
    taskTimeoutMinutes?: number;
    maxTurnsHint?: number;
  };
  discovery?: { roots?: string[] };
  judge?: { model?: string };
  board?: { port?: number };
  judgePassScore?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type FieldCheck = (v: unknown, path: string) => string | null;
interface SpecNode {
  [key: string]: FieldCheck | SpecNode;
}

const wantBool: FieldCheck = (v, p) => (typeof v === 'boolean' ? null : `${p} must be a boolean`);
const wantPct: FieldCheck = (v, p) =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100
    ? null
    : `${p} must be an integer 0–100`;
const wantPosInt: FieldCheck = (v, p) =>
  Number.isInteger(v) && (v as number) > 0 ? null : `${p} must be a positive integer`;
const wantPort: FieldCheck = (v, p) =>
  Number.isInteger(v) && (v as number) >= 1024 && (v as number) <= 65535
    ? null
    : `${p} must be an integer 1024–65535`;
const wantStr: FieldCheck = (v, p) =>
  typeof v === 'string' && v.trim().length > 0 ? null : `${p} must be a non-empty string`;
const wantScore: FieldCheck = (v, p) =>
  Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5
    ? null
    : `${p} must be an integer 1–5`;
const wantResetFallback: FieldCheck = (v, p) =>
  v === null || (typeof v === 'string' && v.trim().length > 0)
    ? null
    : `${p} must be a non-empty string or null`;
const wantStrArray: FieldCheck = (v, p) =>
  Array.isArray(v) &&
  v.length <= 20 &&
  v.every((x) => typeof x === 'string' && x.trim().length > 0)
    ? null
    : `${p} must be an array of up to 20 non-empty strings`;

/**
 * providers.claude.accounts — whole-array replace. Each entry is one
 * ClaudeAccountConfig: id slug 1–24 lowercase [a-z0-9-] (unique; 'main' is the
 * default account and must keep configDir null), label non-empty ≤40 chars,
 * configDir an absolute-or-~ path string (null only for main), priority an
 * integer 0–99 or null (auto). Missing configDir/priority read as null.
 * configDir values must also be INDEPENDENT credential sources: a non-main
 * dir resolving to the default ~/.claude (that is the main account — its
 * derived keychain service is main's), or two entries resolving to the same
 * dir, would enumerate one subscription as several 'independent' accounts
 * (multiplied claim slots within the usage-cache window) — rejected.
 */
const wantClaudeAccounts: FieldCheck = (v, p) => {
  if (!Array.isArray(v)) return `${p} must be an array of accounts`;
  if (v.length > MAX_CLAUDE_ACCOUNTS) {
    return `${p} must contain at most ${MAX_CLAUDE_ACCOUNTS} accounts`;
  }
  const seen = new Set<string>();
  const seenDirs = new Set<string>();
  const defaultDir = defaultClaudeDir();
  for (let i = 0; i < v.length; i++) {
    const entry: unknown = v[i];
    const ep = `${p}[${i}]`;
    if (!isPlainObject(entry)) return `${ep} must be an object`;
    for (const key of Object.keys(entry)) {
      if (!['id', 'label', 'configDir', 'priority'].includes(key)) {
        return `unknown account key '${ep}.${key}'`;
      }
    }
    const { id, label } = entry;
    if (typeof id !== 'string' || !ACCOUNT_ID_RE.test(id)) {
      return `${ep}.id must be a slug of 1–24 lowercase [a-z0-9-] characters`;
    }
    if (seen.has(id)) return `${ep}.id duplicates account id '${id}'`;
    seen.add(id);
    if (typeof label !== 'string' || label.trim().length === 0 || label.trim().length > 40) {
      return `${ep}.label must be a non-empty string of at most 40 characters`;
    }
    const configDir = entry.configDir ?? null;
    if (id === 'main') {
      if (configDir !== null) return `${ep}.configDir must be null for the main account`;
    } else {
      if (
        typeof configDir !== 'string' ||
        !(configDir === '~' || configDir.startsWith('~/') || path.isAbsolute(configDir))
      ) {
        return `${ep}.configDir must be an absolute or ~-prefixed path`;
      }
      const resolvedDir = path.resolve(expandTilde(configDir));
      if (resolvedDir === defaultDir) {
        return `${ep}.configDir resolves to the default ~/.claude — that is the main account`;
      }
      if (seenDirs.has(resolvedDir)) {
        return `${ep}.configDir duplicates another account's profile dir`;
      }
      seenDirs.add(resolvedDir);
    }
    const priority = entry.priority ?? null;
    if (
      priority !== null &&
      !(Number.isInteger(priority) && (priority as number) >= 0 && (priority as number) <= 99)
    ) {
      return `${ep}.priority must be an integer 0–99 or null`;
    }
  }
  return null;
};

const PROVIDER_SPEC: SpecNode = {
  enabled: wantBool,
  defaults: { model: wantStr, effort: wantStr },
  weeklyResetFallback: wantResetFallback,
};

/** claude additionally accepts the multi-account list. */
const CLAUDE_PROVIDER_SPEC: SpecNode = {
  ...PROVIDER_SPEC,
  accounts: wantClaudeAccounts,
};

const CONFIG_SPEC: SpecNode = {
  modes: {
    weeklySurplus: { enabled: wantBool, burnWindowHours: wantPosInt, stopAtPct: wantPct },
    fiveHourBurst: { enabled: wantBool, triggerMinutesBeforeReset: wantPosInt, weeklyGuardPct: wantPct },
  },
  pacing: { fiveHourPausePct: wantPct },
  reserve: { weeklyPct: wantPct, fiveHourPct: wantPct, watchdogIntervalMinutes: wantPosInt },
  dispatcher: {
    maxConcurrent: wantPosInt,
    maxAttempts: wantPosInt,
    taskTimeoutMinutes: wantPosInt,
    maxTurnsHint: wantPosInt,
  },
  discovery: { roots: wantStrArray },
  judge: { model: wantStr },
  board: { port: wantPort },
  judgePassScore: wantScore,
};

function walkSpec(
  value: unknown,
  spec: FieldCheck | SpecNode,
  path: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof spec === 'function') {
    const issue = spec(value, path);
    return issue ? { ok: false, error: issue } : { ok: true, value };
  }
  if (!isPlainObject(value)) return { ok: false, error: `${path} must be an object` };
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const sub = spec[key];
    const subPath = `${path}.${key}`;
    if (!sub) return { ok: false, error: `unknown config key '${subPath}'` };
    const r = walkSpec(v, sub, subPath);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  return { ok: true, value: out };
}

/** Validate an untrusted body into a ConfigPatch; unknown keys/bad types reject. */
export function buildConfigPatch(
  body: Record<string, unknown>,
): { ok: true; patch: ConfigPatch } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (key === 'providers') {
      if (!isPlainObject(value)) return { ok: false, error: 'providers must be an object' };
      const provs: Record<string, unknown> = {};
      for (const [prov, pv] of Object.entries(value)) {
        if (!isProvider(prov)) {
          return { ok: false, error: `unknown provider '${prov}' (claude|codex)` };
        }
        const r = walkSpec(
          pv,
          prov === 'claude' ? CLAUDE_PROVIDER_SPEC : PROVIDER_SPEC,
          `providers.${prov}`,
        );
        if (!r.ok) return r;
        provs[prov] = r.value;
      }
      out.providers = provs;
      continue;
    }
    const spec = CONFIG_SPEC[key];
    if (!spec) return { ok: false, error: `unknown config key '${key}'` };
    const r = walkSpec(value, spec, key);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  if (Object.keys(out).length === 0) return { ok: false, error: 'no config fields to update' };
  return { ok: true, patch: out as ConfigPatch };
}

/**
 * Deep-merge a validated patch over a full config. Plain objects merge
 * key-by-key; primitives/null replace. Pure — returns a new object.
 */
export function applyConfigPatch(base: SurplusConfig, patch: ConfigPatch): SurplusConfig {
  function merge<T>(b: T, o: unknown): T {
    if (!isPlainObject(b) || !isPlainObject(o)) return o === undefined ? b : (o as T);
    const out: Record<string, unknown> = { ...b };
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      const bv = (b as Record<string, unknown>)[k];
      out[k] = isPlainObject(bv) && isPlainObject(v) ? merge(bv, v) : v;
    }
    return out as T;
  }
  return merge(base, patch);
}

// ---------------------------------------------------------------------------
// startServer
// ---------------------------------------------------------------------------

export async function startServer(opts: StartServerOptions): Promise<void> {
  const { db, config, accounts, decideFn, paused, setPaused, deps } = opts;
  const app = new Hono();

  // --- localhost trust boundary: CSRF + DNS-rebinding defense ----------------
  // This server has no auth and CAN trigger code execution (burn). Its only
  // boundary is the 127.0.0.1 bind, which a browser can still cross two ways:
  //   1. CSRF — a page the user visits can POST here; CORS "simple requests"
  //      (form / text-plain fetch) send NO preflight, so the side effect fires
  //      even though the response is unreadable.
  //   2. DNS rebinding — an attacker domain re-pointed at 127.0.0.1 becomes
  //      "same-origin", unlocking the PATCH/PUT/DELETE routes and readable data.
  // Defense (no impact on the board or non-browser clients):
  //   - Reject any request whose Host header is not loopback  → kills rebinding.
  //   - Reject any state-changing (non-GET) request that carries a non-loopback
  //     Origin → kills cross-site CSRF. Browsers always send Origin on non-GET
  //     cross-origin requests; the CLI / tray / tests omit it and pass through.
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (host !== undefined && !isLoopbackHost(host)) {
      return c.json({ error: 'forbidden: non-loopback Host header' }, 403);
    }
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const origin = c.req.header('origin');
      if (origin !== undefined && !isLoopbackOrigin(origin)) {
        return c.json({ error: 'forbidden: cross-origin request refused' }, 403);
      }
    }
    return next();
  });

  /**
   * Error text when a 'claude:<id>' affinity names no configured account
   * (checked against both the live adapters and the possibly-PATCHed-since-
   * boot config), else null. A task/project pinned to an unknown key would
   * sit in 'ready' forever — claimNextReadyTask's predicate never matches it
   * and nothing warns — so it is rejected at the door.
   */
  function unknownAccountPrefError(pref: unknown): string | null {
    if (typeof pref !== 'string' || !CLAUDE_ACCOUNT_KEY_RE.test(pref)) return null;
    const known =
      accounts.some((a) => a.key === pref) || resolveAccounts(config).some((a) => a.key === pref);
    return known ? null : `unknown claude account '${pref}' — not in providers.claude.accounts`;
  }

  // --- shared state builders ------------------------------------------------

  async function buildState(opts?: { fresh?: boolean }): Promise<ApiState> {
    const usage: ApiState['usage'] = {};
    const decisions: ApiState['decisions'] = {};
    const now = Date.now();
    const isPaused = paused();
    for (const account of accounts) {
      let snap: UsageSnapshot | null = null;
      try {
        // Adapter caches internally (per account); fresh narrows the cache
        // window to a 30s floor (never overrides 429 backoff) for the board's
        // refresh button.
        snap = await account.getUsage(opts?.fresh ? { fresh: true } : undefined);
      } catch {
        snap = null;
      }
      usage[account.key] = snap;
      const effective: UsageSnapshot = snap ?? {
        provider: account.provider,
        planName: null,
        fiveHourPct: null,
        sevenDayPct: null,
        fiveHourResetsAt: null,
        sevenDayResetsAt: null,
        unavailable: true,
        error: 'unavailable',
        fetchedAt: now,
      };
      try {
        decisions[account.key] = decideFn({ usage: effective, config, now, paused: isPaused });
      } catch (e) {
        decisions[account.key] = { action: 'stop', reason: `decision error: ${errMsg(e)}` };
      }
    }
    let armed = false;
    try {
      armed = deps?.scheduler ? deps.scheduler.status() : false;
    } catch {
      /* status probe failed — report disarmed rather than crash state */
    }
    return {
      usage,
      decisions,
      accounts: accounts.map((a) => ({
        key: a.key,
        provider: a.provider,
        label: a.label,
        priority: a.priority,
      })),
      paused: isPaused,
      armed,
      config,
      running: db.listTasks('running').map((t) => t.id),
    };
  }

  // --- error / 404 ----------------------------------------------------------

  app.onError((e, c) => c.json({ error: errMsg(e) }, 500));

  // --- state ------------------------------------------------------------------

  app.get('/api/state', async (c) =>
    c.json(await buildState({ fresh: c.req.query('fresh') === '1' })),
  );

  // --- projects ---------------------------------------------------------------

  app.get('/api/projects', (c) => c.json(db.listProjects()));

  // Local git-repo discovery for the Add-Project picker (localhost-only
  // server; scans config.discovery.roots one level deep, never leaves the
  // machine, returns no file contents — just repo names/paths/recency).
  app.get('/api/discover', (c) => {
    const registeredPaths = new Set(db.listProjects().map((p) => p.path));
    return c.json(discoverRepos({ roots: config.discovery.roots, registeredPaths }));
  });

  app.post('/api/projects', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    // Existing repo: {path}
    if (typeof body.path === 'string' && body.path.length > 0) {
      const p = body.path;
      if (!path.isAbsolute(p)) return c.json({ error: 'path must be absolute' }, 400);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) return c.json({ error: 'path is not an existing directory' }, 400);
      if (!existsSync(path.join(p, '.git'))) {
        return c.json({ error: 'directory is not a git repository' }, 400);
      }
      const name = path.basename(p);
      const id = slugifyProjectId(name);
      if (!id) return c.json({ error: 'cannot derive a project id from path' }, 400);
      if (db.getProject(id)) return c.json({ error: `project '${id}' already exists` }, 409);
      const row: ProjectRow = {
        id,
        name,
        path: p,
        visionPath: path.join(p, 'VISION.md'),
        provider: 'any',
        model: null,
        effort: null,
        createdAt: Date.now(),
      };
      if (!existsSync(row.visionPath) && deps?.draftVision) {
        try {
          await deps.draftVision(row);
        } catch (e) {
          return c.json({ error: `failed to draft VISION.md: ${errMsg(e)}` }, 502);
        }
      }
      db.insertProject(row);
      return c.json(row, 201);
    }

    // New project: {name}
    if (typeof body.name === 'string' && body.name.trim().length > 0) {
      if (!deps?.scaffoldProject) {
        return c.json({ error: 'project scaffolding not available' }, 501);
      }
      const name = body.name.trim();
      if (!slugifyProjectId(name)) return c.json({ error: 'invalid project name' }, 400);
      let row: ProjectRow;
      try {
        row = await deps.scaffoldProject(name);
      } catch (e) {
        return c.json({ error: `scaffold failed: ${errMsg(e)}` }, 502);
      }
      if (!db.getProject(row.id)) db.insertProject(row);
      return c.json(row, 201);
    }

    return c.json({ error: 'body must be {path} or {name}' }, 400);
  });

  // Project VISION.md — the contract the worker and judge are graded against.
  app.get('/api/projects/:id/vision', (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'invalid project id' }, 400);
    const project = db.getProject(id);
    if (!project) return c.json({ error: 'project not found' }, 404);
    let markdown = '';
    try {
      markdown = readFileSync(project.visionPath, 'utf8');
    } catch {
      // Missing file → empty editor, not an error.
    }
    return c.json({ markdown });
  });

  app.put('/api/projects/:id/vision', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'invalid project id' }, 400);
    const project = db.getProject(id);
    if (!project) return c.json({ error: 'project not found' }, 404);
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    if (typeof body.markdown !== 'string') {
      return c.json({ error: 'body must be {markdown: string}' }, 400);
    }
    if (body.markdown.length > VISION_MAX_CHARS) {
      return c.json({ error: `markdown exceeds ${VISION_MAX_CHARS} characters` }, 400);
    }
    try {
      writeFileSync(project.visionPath, body.markdown, 'utf8');
    } catch (e) {
      return c.json({ error: `failed to write VISION.md: ${errMsg(e)}` }, 500);
    }
    return c.json({ ok: true });
  });

  app.patch('/api/projects/:id', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'invalid project id' }, 400);
    const project = db.getProject(id);
    if (!project) return c.json({ error: 'project not found' }, 404);
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const built = buildProjectPatch(body);
    if (!built.ok) return c.json({ error: built.error }, 400);
    const unknownPref = unknownAccountPrefError(built.patch.provider);
    if (unknownPref) return c.json({ error: unknownPref }, 400);
    const updated = db.updateProject(id, built.patch) ?? db.getProject(id);
    if (!updated) return c.json({ error: 'project not found' }, 404);
    return c.json(updated);
  });

  app.delete('/api/projects/:id', (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'invalid project id' }, 400);
    if (!db.getProject(id)) return c.json({ error: 'project not found' }, 404);
    try {
      db.deleteProject(id);
    } catch (e) {
      // db refuses while non-archived tasks exist — surface why.
      return c.json({ error: errMsg(e) }, 400);
    }
    return c.json({ ok: true });
  });

  // --- tasks ------------------------------------------------------------------

  app.get('/api/tasks', (c) => {
    const status = c.req.query('status');
    if (status !== undefined) {
      if (!isTaskStatus(status)) return c.json({ error: 'invalid status filter' }, 400);
      return c.json(db.listTasks(status));
    }
    return c.json(db.listTasks()); // all non-archived
  });

  app.post('/api/tasks', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    if (!validId(body.projectId)) return c.json({ error: 'invalid projectId' }, 400);
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return c.json({ error: 'title is required' }, 400);
    }
    const project = db.getProject(body.projectId);
    if (!project) return c.json({ error: 'unknown project' }, 404);

    let status: TaskStatus = 'triage';
    if ('status' in body) {
      if (!isTaskStatus(body.status) || body.status === 'running') {
        return c.json({ error: 'invalid initial status' }, 400);
      }
      status = body.status;
    }
    if ('parentId' in body && body.parentId !== null && !validId(body.parentId)) {
      return c.json({ error: 'invalid parentId' }, 400);
    }
    const unknownPref = unknownAccountPrefError(body.provider);
    if (unknownPref) return c.json({ error: unknownPref }, 400);
    const now = Date.now();
    const task: TaskRow = {
      id: genTaskId(),
      projectId: body.projectId,
      title: body.title.trim(),
      body: typeof body.body === 'string' ? body.body : '',
      status,
      priority:
        typeof body.priority === 'number' && Number.isFinite(body.priority)
          ? Math.round(body.priority)
          : 100,
      attempts: 0,
      maxAttempts: config.dispatcher.maxAttempts,
      provider: isProviderPref(body.provider) ? body.provider : 'any',
      model: typeof body.model === 'string' ? body.model : null,
      effort: typeof body.effort === 'string' ? body.effort : null,
      judgeFeedback: null,
      parentId: validId(body.parentId) ? body.parentId : null,
      scheduledAt: typeof body.scheduledAt === 'number' ? body.scheduledAt : null,
      createdAt: now,
      updatedAt: now,
    };
    db.insertTask(task);
    db.appendEvent('task-created', task.id, { task });
    return c.json(task, 201);
  });

  app.get('/api/tasks/:id', (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'invalid task id' }, 400);
    const task = db.getTask(id);
    if (!task) return c.json({ error: 'task not found' }, 404);
    return c.json({
      task,
      runs: db.listRuns(id),
      events: db.listEventsForTask(id, 200),
    });
  });

  app.patch('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'invalid task id' }, 400);
    const task = db.getTask(id);
    if (!task) return c.json({ error: 'task not found' }, 404);
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const built = buildTaskPatch(body);
    if (!built.ok) return c.json({ error: built.error }, 400);
    const unknownPref = unknownAccountPrefError(built.patch.provider);
    if (unknownPref) return c.json({ error: unknownPref }, 400);
    const patch = { ...built.patch, updatedAt: Date.now() };
    const updated = db.updateTask(id, patch) ?? db.getTask(id);
    if (!updated) return c.json({ error: 'task not found' }, 404);
    if (built.patch.status && built.patch.status !== task.status) {
      db.appendEvent('status-changed', id, { from: task.status, to: built.patch.status });
    } else {
      db.appendEvent('task-updated', id, { fields: Object.keys(built.patch) });
    }
    return c.json(updated);
  });

  // --- pause / resume / burn ---------------------------------------------------

  app.post('/api/pause', (c) => {
    setPaused(true);
    return c.json({ paused: true });
  });

  app.post('/api/resume', (c) => {
    setPaused(false);
    return c.json({ paused: false });
  });

  // Master switch: install/remove the launchd tick scheduler.
  app.post('/api/scheduler', async (c) => {
    if (!deps?.scheduler) return c.json({ error: 'scheduler control not available' }, 503);
    const body = await readJson(c);
    if (!body || typeof body.armed !== 'boolean') {
      return c.json({ error: 'body must be {armed: boolean}' }, 400);
    }
    try {
      deps.scheduler.setArmed(body.armed);
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
    const armed = deps.scheduler.status();
    db.appendEvent('decision', null, {
      action: armed ? 'armed' : 'disarmed',
      reason: armed ? 'tick scheduler installed via API' : 'tick scheduler removed via API',
    });
    return c.json({ armed });
  });

  // Always-on board service (launchd KeepAlive + Dock app). Install-only:
  // uninstalling the service that keeps THIS process alive stays CLI-only.
  app.get('/api/board-service', (c) => {
    if (!deps?.boardService) return c.json({ installed: false, available: false });
    let installed = false;
    try {
      installed = deps.boardService.status();
    } catch {
      /* status probe failed — report not-installed rather than crash */
    }
    return c.json({ installed, available: true });
  });

  app.post('/api/board-service', (c) => {
    if (!deps?.boardService) {
      return c.json({ error: 'board service control not available' }, 503);
    }
    try {
      deps.boardService.install();
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
    db.appendEvent('decision', null, {
      action: 'board-service-installed',
      reason: 'always-on board service installed via API',
    });
    return c.json({ installed: deps.boardService.status() });
  });

  app.post('/api/burn', async (c) => {
    if (!deps?.triggerBurn) return c.json({ error: 'burn trigger not available' }, 503);
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    let taskId: string | undefined;
    if (body.taskId !== undefined && body.taskId !== null) {
      if (!validId(body.taskId)) return c.json({ error: 'invalid taskId' }, 400);
      taskId = body.taskId;
    }
    // `provider` accepts a plain provider name (any account of that provider,
    // AUTO burn order) or an AccountKey ('claude:<id>') matching a configured
    // account — checked against both the live adapters and the (possibly
    // PATCHed-since-boot) config.
    let provider: string | undefined;
    if (body.provider !== undefined && body.provider !== null) {
      const v = body.provider;
      const known =
        typeof v === 'string' &&
        (isProvider(v) ||
          accounts.some((a) => a.key === v) ||
          resolveAccounts(config).some((a) => a.key === v));
      if (!known) {
        return c.json(
          { error: 'invalid provider — expected claude|codex or a configured account key' },
          400,
        );
      }
      provider = v;
    }
    try {
      const result = await deps.triggerBurn(taskId, provider);
      return c.json({ ok: true, result: result ?? null });
    } catch (e) {
      return c.json({ ok: false, error: errMsg(e) }, 500);
    }
  });

  // --- config -----------------------------------------------------------------

  app.patch('/api/config', async (c) => {
    if (!deps?.updateConfig) return c.json({ error: 'config updates not available' }, 503);
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const built = buildConfigPatch(body);
    if (!built.ok) return c.json({ error: built.error }, 400);
    let effective: SurplusConfig;
    try {
      effective = await deps.updateConfig(built.patch);
    } catch (e) {
      return c.json({ error: `config update failed: ${errMsg(e)}` }, 500);
    }
    // Mutate the shared config object so /api/state and decide() see the new
    // values immediately (cli passes the same reference to the dispatcher).
    Object.assign(config, effective);
    // Account removal: a task/project pinned to a 'claude:<id>' key that no
    // longer exists would starve silently in 'ready' (the claim predicate
    // never matches it). Rewrite stale affinities to the 'claude' provider
    // and record an event so the change is visible on the board.
    if (built.patch.providers?.claude?.accounts) {
      const knownKeys = new Set(resolveAccounts(effective).map((a) => a.key));
      for (const t of db.listTasks()) {
        if (CLAUDE_ACCOUNT_KEY_RE.test(t.provider) && !knownKeys.has(t.provider)) {
          db.updateTask(t.id, { provider: 'claude', updatedAt: Date.now() });
          db.appendEvent('task-updated', t.id, {
            fields: ['provider'],
            reason: `account '${t.provider}' removed — affinity reset to claude`,
          });
        }
      }
      for (const p of db.listProjects()) {
        if (CLAUDE_ACCOUNT_KEY_RE.test(p.provider) && !knownKeys.has(p.provider)) {
          db.updateProject(p.id, { provider: 'claude' });
          db.appendEvent('task-updated', null, {
            fields: ['provider'],
            projectId: p.id,
            reason: `account '${p.provider}' removed — project affinity reset to claude`,
          });
        }
      }
    }
    return c.json(effective);
  });

  // --- SSE -----------------------------------------------------------------

  const sseAborts = new Set<() => void>();
  const HISTORY_DEFAULT = 200;
  const POLL_BATCH = 500;

  // Plain-JSON event poll for non-SSE clients (the menu-bar app): rows with
  // id > after, oldest first, capped at one batch.
  app.get('/api/events/poll', (c) => {
    const afterRaw = c.req.query('after') ?? '0';
    const after = Number.parseInt(afterRaw, 10);
    if (!Number.isFinite(after) || after < 0) return c.json({ error: 'invalid after id' }, 400);
    return c.json(db.eventsAfter(after, POLL_BATCH));
  });

  app.get('/api/events', (c) => {
    const afterRaw = c.req.query('after') ?? c.req.header('Last-Event-ID');
    let after: number | null = null;
    if (afterRaw !== undefined && afterRaw !== '') {
      const n = Number.parseInt(afterRaw, 10);
      if (!Number.isFinite(n) || n < 0) return c.json({ error: 'invalid after id' }, 400);
      after = n;
    }
    return streamSSE(c, async (stream) => {
      let stopped = false;
      const stop = () => {
        stopped = true;
      };
      stream.onAbort(stop);
      sseAborts.add(stop);
      try {
        const history =
          after !== null ? db.eventsAfter(after, POLL_BATCH) : db.lastEvents(HISTORY_DEFAULT);
        let last = after ?? 0;
        const writeEv = async (row: TaskEventRow) => {
          await stream.writeSSE({ event: 'ev', id: String(row.id), data: JSON.stringify(row) });
          if (row.id > last) last = row.id;
        };
        for (const row of history) {
          if (stopped) return;
          await writeEv(row);
        }
        const writeState = async () => {
          await stream.writeSSE({ event: 'state', data: JSON.stringify(await buildState()) });
        };
        await writeState();
        let nextStateAt = Date.now() + 15_000;
        while (!stopped && !stream.aborted && !stream.closed) {
          await stream.sleep(1_000);
          if (stopped || stream.aborted || stream.closed) break;
          for (const row of db.eventsAfter(last, POLL_BATCH)) {
            if (stopped) return;
            await writeEv(row);
          }
          if (Date.now() >= nextStateAt) {
            await writeState();
            nextStateAt = Date.now() + 15_000;
          }
        }
      } finally {
        sseAborts.delete(stop);
      }
    });
  });

  // --- static board (board/dist) ---------------------------------------------

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(moduleDir, '..', 'board', 'dist');
  if (existsSync(distDir)) {
    // @hono/node-server serveStatic resolves root relative to cwd.
    const relRoot = path.relative(process.cwd(), distDir) || '.';
    app.get('*', serveStatic({ root: relRoot }));
    const spa = serveStatic({ root: relRoot, path: 'index.html' });
    app.get('*', (c, next) => (c.req.path.startsWith('/api') ? next() : spa(c, next)));
  } else {
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api')) return c.notFound();
      return c.text('surplus board not built — run: cd board && pnpm install && pnpm build', 503);
    });
  }

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  // --- listen (127.0.0.1 ONLY) -------------------------------------------------

  let server: ServerType;
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: opts.port, hostname: '127.0.0.1' }, () => resolve());
  });

  opts.signal?.addEventListener(
    'abort',
    () => {
      for (const stop of [...sseAborts]) stop();
      const s = server as ServerType & { closeAllConnections?: () => void };
      s.closeAllConnections?.();
      server.close();
    },
    { once: true },
  );
}
