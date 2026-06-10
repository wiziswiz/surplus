/**
 * Tests for providers/codex.ts. All subprocess calls are mocked via the
 * adapter's injectable deps (checkCliInstalled / spawn); session rollout
 * probing runs against temp directories.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyExit,
  codexAdapter,
  mapCodexEffort,
  parseWeeklyResetFallback,
} from '../src/providers/codex.js';
import type {
  ProjectRow,
  RunTaskArgs,
  SurplusConfig,
  TaskRow,
  Vision,
} from '../src/types.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function makeConfig(codexOverrides: Partial<SurplusConfig['providers']['codex']> = {}): SurplusConfig {
  return {
    providers: {
      claude: { enabled: true, defaults: { model: 'sonnet', effort: 'medium' } },
      codex: {
        enabled: true,
        defaults: { model: 'gpt-5.4', effort: 'medium' },
        weeklyResetFallback: null,
        ...codexOverrides,
      },
    },
    modes: {
      weeklySurplus: { enabled: true, burnWindowHours: 12, stopAtPct: 95 },
      fiveHourBurst: { enabled: false, triggerMinutesBeforeReset: 30, weeklyGuardPct: 70 },
    },
    pacing: { fiveHourPausePct: 90 },
    reserve: { weeklyPct: 10, fiveHourPct: 25, watchdogIntervalMinutes: 5 },
    discovery: { roots: ['~/Projects'] },
    dispatcher: { maxConcurrent: 1, maxAttempts: 3, taskTimeoutMinutes: 90, maxTurnsHint: 40 },
    judge: { model: 'haiku' },
    board: { port: 4242 },
    judgePassScore: 4,
  };
}

// Jan 1 2026 is a Thursday (local-time fixtures below rely on this).
const THU_NOON = new Date(2026, 0, 1, 12, 0, 0, 0).getTime();

describe('parseWeeklyResetFallback — weekday-time specs', () => {
  it('rolls to later today when the time has not passed yet', () => {
    expect(parseWeeklyResetFallback('Thu 21:00', THU_NOON)).toBe(
      new Date(2026, 0, 1, 21, 0, 0, 0).getTime(),
    );
  });

  it('rolls forward across the week boundary when the time already passed', () => {
    const thuLate = new Date(2026, 0, 1, 22, 0, 0, 0).getTime();
    expect(parseWeeklyResetFallback('Thu 21:00', thuLate)).toBe(
      new Date(2026, 0, 8, 21, 0, 0, 0).getTime(),
    );
  });

  it('an occurrence exactly at now rolls a full week forward (strictly future)', () => {
    const exactly = new Date(2026, 0, 1, 21, 0, 0, 0).getTime();
    expect(parseWeeklyResetFallback('Thu 21:00', exactly)).toBe(
      new Date(2026, 0, 8, 21, 0, 0, 0).getTime(),
    );
  });

  it('handles other weekdays, including wrapping past the weekend', () => {
    expect(parseWeeklyResetFallback('Fri 09:30', THU_NOON)).toBe(
      new Date(2026, 0, 2, 9, 30, 0, 0).getTime(),
    );
    expect(parseWeeklyResetFallback('Wed 08:00', THU_NOON)).toBe(
      new Date(2026, 0, 7, 8, 0, 0, 0).getTime(),
    );
  });

  it('accepts full weekday names and is case-insensitive', () => {
    const expected = new Date(2026, 0, 1, 21, 0, 0, 0).getTime();
    expect(parseWeeklyResetFallback('thursday 21:00', THU_NOON)).toBe(expected);
    expect(parseWeeklyResetFallback('THU 21:00', THU_NOON)).toBe(expected);
  });

  it('rejects invalid weekday-time specs', () => {
    expect(parseWeeklyResetFallback('Xyz 21:00', THU_NOON)).toBeNull();
    expect(parseWeeklyResetFallback('Thu 25:00', THU_NOON)).toBeNull();
    expect(parseWeeklyResetFallback('Thu 21:99', THU_NOON)).toBeNull();
    expect(parseWeeklyResetFallback('', THU_NOON)).toBeNull();
    expect(parseWeeklyResetFallback('complete garbage', THU_NOON)).toBeNull();
  });
});

describe('parseWeeklyResetFallback — ISO specs', () => {
  const anchor = Date.parse('2026-01-01T21:00:00.000Z');

  it('rolls a past anchor forward to the next weekly occurrence after now', () => {
    const now = Date.UTC(2026, 5, 9, 12, 0, 0);
    const next = parseWeeklyResetFallback('2026-01-01T21:00:00.000Z', now);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(now);
    expect(next! - now).toBeLessThanOrEqual(WEEK_MS);
    expect((next! - anchor) % WEEK_MS).toBe(0);
  });

  it('an anchor several weeks in the future still yields the NEXT occurrence', () => {
    const now = anchor - 3 * WEEK_MS + 1000;
    expect(parseWeeklyResetFallback('2026-01-01T21:00:00.000Z', now)).toBe(anchor - 2 * WEEK_MS);
  });

  it('an anchor exactly at now rolls one week forward', () => {
    expect(parseWeeklyResetFallback('2026-01-01T21:00:00.000Z', anchor)).toBe(anchor + WEEK_MS);
  });

  it('rejects unparseable strings', () => {
    expect(parseWeeklyResetFallback('not-a-date', THU_NOON)).toBeNull();
  });
});

describe('mapCodexEffort', () => {
  it('maps the surplus levels onto codex reasoning efforts', () => {
    expect(mapCodexEffort('low')).toBe('low');
    expect(mapCodexEffort('medium')).toBe('medium');
    expect(mapCodexEffort('high')).toBe('high');
    expect(mapCodexEffort('xhigh')).toBe('xhigh');
    expect(mapCodexEffort('max')).toBe('xhigh');
  });

  it('is case/whitespace tolerant', () => {
    expect(mapCodexEffort(' High ')).toBe('high');
    expect(mapCodexEffort('MAX')).toBe('xhigh');
  });

  it('returns null (omit the flag) for unknown levels', () => {
    expect(mapCodexEffort('minimal')).toBeNull();
    expect(mapCodexEffort('')).toBeNull();
    expect(mapCodexEffort('ultra')).toBeNull();
  });
});

describe('classifyExit', () => {
  const base = { timedOut: false, signal: null, exitCode: 0, outputTail: '', summary: 'done' };

  it('timeout wins over everything', () => {
    expect(classifyExit({ ...base, timedOut: true, exitCode: 1 })).toBe('timeout');
  });

  it('an external signal (not our timeout) means killed', () => {
    expect(classifyExit({ ...base, signal: 'SIGTERM', exitCode: null })).toBe('killed');
  });

  it('nonzero exit with quota/auth text in the tail → quota', () => {
    expect(
      classifyExit({ ...base, exitCode: 1, outputTail: 'ERROR: you have hit your usage limit' }),
    ).toBe('quota');
    expect(classifyExit({ ...base, exitCode: 1, outputTail: 'HTTP 401 Unauthorized' })).toBe('quota');
    expect(
      classifyExit({ ...base, exitCode: 1, outputTail: 'Not logged in. Please run `codex login`.' }),
    ).toBe('quota');
  });

  it('nonzero exit without quota text → error', () => {
    expect(classifyExit({ ...base, exitCode: 2, outputTail: 'panicked at main.rs' })).toBe('error');
  });

  it('clean completion → failed (completed-pending-judge convention)', () => {
    expect(classifyExit({ ...base, exitCode: 0, summary: 'All criteria satisfied.' })).toBe('failed');
  });

  it('clean exit whose summary admits hitting the limit → quota', () => {
    expect(
      classifyExit({ ...base, exitCode: 0, summary: 'I reached the usage limit and had to stop.' }),
    ).toBe('quota');
  });
});

// ---------------------------------------------------------------------------
// getUsage
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 5, 9, 12, 0, 0);
const cliPresent = async () => true;
const cliAbsent = async () => false;

const tmpDirs: string[] = [];
async function makeCodexHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'surplus-codex-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function rolloutLine(opts: {
  primaryResetSec: number;
  secondaryResetSec: number;
  primaryPct?: number;
  secondaryPct?: number;
  planType?: string;
}): string {
  return JSON.stringify({
    timestamp: '2026-06-08T10:00:05.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { model_context_window: 258400 },
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        primary: {
          used_percent: opts.primaryPct ?? 28,
          window_minutes: 300,
          resets_at: opts.primaryResetSec,
        },
        secondary: {
          used_percent: opts.secondaryPct ?? 6,
          window_minutes: 10080,
          resets_at: opts.secondaryResetSec,
        },
        credits: null,
        plan_type: opts.planType ?? 'plus',
        rate_limit_reached_type: null,
      },
    },
  });
}

async function writeRollout(codexHome: string, lines: string[]): Promise<void> {
  const dayDir = join(codexHome, 'sessions', '2026', '06', '08');
  await mkdir(dayDir, { recursive: true });
  await writeFile(join(dayDir, 'rollout-2026-06-08T10-00-00-abcdef.jsonl'), lines.join('\n') + '\n');
}

describe('codexAdapter.getUsage', () => {
  it('returns null when the codex CLI is not installed — even with a fallback configured', async () => {
    const adapter = codexAdapter(makeConfig({ weeklyResetFallback: 'Thu 21:00' }), {
      checkCliInstalled: cliAbsent,
      now: () => NOW,
      codexHome: await makeCodexHome(),
    });
    expect(await adapter.getUsage()).toBeNull();
  });

  it('parses a fresh rate_limits event from the newest session rollout', async () => {
    const codexHome = await makeCodexHome();
    const primaryResetSec = Math.floor(NOW / 1000) + 3600;
    const secondaryResetSec = Math.floor(NOW / 1000) + 4 * 86400;
    await writeRollout(codexHome, [
      JSON.stringify({ timestamp: '2026-06-08T10:00:00.000Z', type: 'session_meta', payload: { type: 'session_meta' } }),
      rolloutLine({ primaryResetSec, secondaryResetSec }),
    ]);

    const adapter = codexAdapter(makeConfig(), {
      checkCliInstalled: cliPresent,
      now: () => NOW,
      codexHome,
    });
    const snap = await adapter.getUsage();
    expect(snap).not.toBeNull();
    expect(snap!.provider).toBe('codex');
    expect(snap!.planName).toBe('ChatGPT Plus');
    expect(snap!.fiveHourPct).toBe(28);
    expect(snap!.sevenDayPct).toBe(6);
    expect(snap!.fiveHourResetsAt!.getTime()).toBe(primaryResetSec * 1000);
    expect(snap!.sevenDayResetsAt!.getTime()).toBe(secondaryResetSec * 1000);
    expect(snap!.unavailable).toBe(false);
    expect(snap!.fetchedAt).toBe(NOW);
  });

  it('nulls the 5h fields when only the 5h window has already reset', async () => {
    const codexHome = await makeCodexHome();
    await writeRollout(codexHome, [
      rolloutLine({
        primaryResetSec: Math.floor(NOW / 1000) - 600, // expired
        secondaryResetSec: Math.floor(NOW / 1000) + 2 * 86400,
      }),
    ]);
    const adapter = codexAdapter(makeConfig(), {
      checkCliInstalled: cliPresent,
      now: () => NOW,
      codexHome,
    });
    const snap = await adapter.getUsage();
    expect(snap).not.toBeNull();
    expect(snap!.fiveHourPct).toBeNull();
    expect(snap!.fiveHourResetsAt).toBeNull();
    expect(snap!.sevenDayPct).toBe(6);
  });

  it('ignores a stale recording (7-day window already reset) and uses the fallback', async () => {
    const codexHome = await makeCodexHome();
    await writeRollout(codexHome, [
      rolloutLine({
        primaryResetSec: Math.floor(NOW / 1000) - 7200,
        secondaryResetSec: Math.floor(NOW / 1000) - 86400, // weekly window in the past
      }),
    ]);
    const adapter = codexAdapter(makeConfig({ weeklyResetFallback: '2026-01-01T21:00:00.000Z' }), {
      checkCliInstalled: cliPresent,
      now: () => NOW,
      codexHome,
    });
    const snap = await adapter.getUsage();
    expect(snap).not.toBeNull();
    expect(snap!.planName).toBe('ChatGPT');
    expect(snap!.fiveHourPct).toBeNull();
    expect(snap!.sevenDayPct).toBeNull();
    expect(snap!.fiveHourResetsAt).toBeNull();
    expect(snap!.sevenDayResetsAt!.getTime()).toBe(
      parseWeeklyResetFallback('2026-01-01T21:00:00.000Z', NOW)!,
    );
    expect(snap!.unavailable).toBe(false);
    expect(snap!.fetchedAt).toBe(NOW);
  });

  it('synthesizes from a weekday-time fallback when no session data exists', async () => {
    const adapter = codexAdapter(makeConfig({ weeklyResetFallback: 'Thu 21:00' }), {
      checkCliInstalled: cliPresent,
      now: () => THU_NOON,
      codexHome: await makeCodexHome(),
    });
    const snap = await adapter.getUsage();
    expect(snap).not.toBeNull();
    expect(snap!.provider).toBe('codex');
    expect(snap!.planName).toBe('ChatGPT');
    expect(snap!.sevenDayResetsAt!.getTime()).toBe(new Date(2026, 0, 1, 21, 0, 0, 0).getTime());
    expect(snap!.fiveHourResetsAt).toBeNull();
    expect(snap!.fetchedAt).toBe(THU_NOON);
  });

  it('returns null with no live surface, no fallback', async () => {
    const adapter = codexAdapter(makeConfig(), {
      checkCliInstalled: cliPresent,
      now: () => NOW,
      codexHome: await makeCodexHome(),
    });
    expect(await adapter.getUsage()).toBeNull();
  });

  it('returns null when the fallback string is unparseable', async () => {
    const adapter = codexAdapter(makeConfig({ weeklyResetFallback: 'whenever feels right' }), {
      checkCliInstalled: cliPresent,
      now: () => NOW,
      codexHome: await makeCodexHome(),
    });
    expect(await adapter.getUsage()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runTask — CLI missing
// ---------------------------------------------------------------------------

function makeRunTaskArgs(config: SurplusConfig): RunTaskArgs {
  const task: TaskRow = {
    id: 't_test1',
    projectId: 'proj1',
    title: 'Test task',
    body: '',
    status: 'running',
    priority: 100,
    attempts: 0,
    maxAttempts: 3,
    provider: 'codex',
    model: null,
    effort: null,
    judgeFeedback: null,
    parentId: null,
    scheduledAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
  const project: ProjectRow = {
    id: 'proj1',
    name: 'Project',
    path: '/tmp/does-not-matter',
    visionPath: '/tmp/does-not-matter/VISION.md',
    provider: 'any',
    model: null,
    effort: null,
    createdAt: 0,
  };
  const vision: Vision = {
    provider: null,
    model: null,
    effort: null,
    statement: 'Test vision',
    criteria: [],
    verifyCommands: [],
    uiFlows: [],
    guardrails: [],
    raw: '# VISION',
  };
  return {
    task,
    project,
    vision,
    model: 'gpt-5.4',
    effort: 'medium',
    config,
    logsDir: '/tmp/surplus-test-logs',
    worktreesDir: '/tmp/surplus-test-worktrees',
  };
}

describe('codexAdapter.runTask', () => {
  it('throws a clear error when the codex CLI is not installed (before any subprocess/worktree work)', async () => {
    const spawnSpy = vi.fn(() => {
      throw new Error('spawn must not be called');
    });
    const adapter = codexAdapter(makeConfig(), {
      checkCliInstalled: cliAbsent,
      now: () => NOW,
      codexHome: '/tmp/nonexistent-codex-home',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawn: spawnSpy as any,
    });
    await expect(adapter.runTask(makeRunTaskArgs(makeConfig()))).rejects.toThrow(
      'codex CLI not installed',
    );
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('rejects a leading-dash model before any worktree/subprocess work (argv-injection guard)', async () => {
    const spawnSpy = vi.fn(() => {
      throw new Error('spawn must not be called');
    });
    const adapter = codexAdapter(makeConfig(), {
      checkCliInstalled: cliPresent,
      now: () => NOW,
      codexHome: '/tmp/nonexistent-codex-home',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawn: spawnSpy as any,
    });
    const args = { ...makeRunTaskArgs(makeConfig()), model: '--dangerously-evil' };
    await expect(adapter.runTask(args)).rejects.toThrow(/unsafe model value/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
