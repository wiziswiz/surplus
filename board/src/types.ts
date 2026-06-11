// DTO mirrors of src/types.ts shapes as they arrive over JSON
// (Dates become ISO strings; everything else is structural).

export type Provider = 'claude' | 'codex';
export type ProviderPref = Provider | 'any';

export type TaskStatus =
  | 'triage'
  | 'todo'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'done'
  | 'archived';

export interface UsageDto {
  provider: Provider;
  planName: string | null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  fiveHourResetsAt: string | null;
  sevenDayResetsAt: string | null;
  unavailable: boolean;
  error?: string;
  fetchedAt: number;
}

export type DecisionAction = 'idle' | 'burn' | 'pace-wait' | 'stop';

export interface DecisionDto {
  action: DecisionAction;
  reason: string;
  mode?: 'weeklySurplus' | 'fiveHourBurst';
  nextCheckAt?: number;
}

export interface ProviderConfigDto {
  enabled: boolean;
  defaults: { model: string; effort: string };
  weeklyResetFallback?: string | null;
}

export interface ConfigDto {
  providers: Record<Provider, ProviderConfigDto>;
  modes: {
    weeklySurplus: { enabled: boolean; burnWindowHours: number; stopAtPct: number };
    fiveHourBurst: { enabled: boolean; triggerMinutesBeforeReset: number; weeklyGuardPct: number };
  };
  pacing: { fiveHourPausePct: number };
  reserve: { weeklyPct: number; fiveHourPct: number; watchdogIntervalMinutes: number };
  dispatcher: {
    maxConcurrent: number;
    maxAttempts: number;
    taskTimeoutMinutes: number;
    maxTurnsHint: number;
  };
  discovery: { roots: string[] };
  judge: { model: string };
  board: { port: number };
  judgePassScore: number;
}

/** Deep partial of ConfigDto sent to PATCH /api/config. */
export interface ConfigPatchDto {
  providers?: Partial<
    Record<
      Provider,
      {
        enabled?: boolean;
        defaults?: { model?: string; effort?: string };
        weeklyResetFallback?: string | null;
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

export interface StateDto {
  usage: Partial<Record<Provider, UsageDto | null>>;
  decisions: Partial<Record<Provider, DecisionDto>>;
  paused: boolean;
  /** True when the launchd tick scheduler is installed (the master switch). */
  armed: boolean;
  config: ConfigDto;
  running: string[];
}

export interface ProjectDto {
  id: string;
  name: string;
  path: string;
  visionPath: string;
  provider: ProviderPref;
  model: string | null;
  effort: string | null;
  createdAt: number;
}

/** PATCH /api/projects/:id — name/provider plus model/effort (null = inherit). */
export interface ProjectPatchDto {
  name?: string;
  provider?: ProviderPref;
  model?: string | null;
  effort?: string | null;
}

/** GET /api/board-service — the always-on dashboard launchd agent. */
export interface BoardServiceDto {
  installed: boolean;
  /** False when the server runs without install capability (e.g. tests). */
  available: boolean;
}

/** GET /api/discover — local git repos found under config.discovery.roots. */
export interface DiscoveredRepoDto {
  name: string;
  path: string;
  branch: string | null;
  lastCommitAt: number | null;
  dirty: boolean;
  registered: boolean;
  claudeRecent: boolean;
}

export interface TaskDto {
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

export interface RunDto {
  id: string;
  taskId: string;
  provider: Provider | null;
  startedAt: number;
  endedAt: number | null;
  outcome: 'passed' | 'failed' | 'error' | 'timeout' | 'quota' | 'killed' | null;
  exitCode: number | null;
  branch: string | null;
  summary: string | null;
  judgeScore: number | null;
  judgeReasons: string | null;
  judgeMissing: string | null;
  model: string | null;
  effort: string | null;
  logPath: string | null;
}

export type EventType =
  | 'task-created'
  | 'task-updated'
  | 'status-changed'
  | 'run-started'
  | 'run-heartbeat'
  | 'run-finished'
  | 'judge-verdict'
  | 'decision'
  | 'usage';

export interface EventDto {
  id: number;
  ts: number;
  taskId: string | null;
  type: EventType;
  data: string;
}

export interface TaskDetailDto {
  task: TaskDto;
  runs: RunDto[];
  events: EventDto[];
}
