import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGoalCondition, parseVision } from '../src/vision.js';
import type { SurplusConfig, TaskRow, Vision } from '../src/types.js';

const TEMPLATE = readFileSync(
  fileURLToPath(new URL('../templates/VISION.md', import.meta.url)),
  'utf8',
);

function makeConfig(maxTurnsHint = 40): SurplusConfig {
  return {
    providers: {
      claude: { enabled: true, defaults: { model: 'sonnet', effort: 'high' } },
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
    reserve: { weeklyPct: 10, fiveHourPct: 25, watchdogIntervalMinutes: 5 },
    dispatcher: { maxConcurrent: 1, maxAttempts: 3, taskTimeoutMinutes: 90, maxTurnsHint },
    judge: { model: 'haiku' },
    board: { port: 4321 },
    judgePassScore: 4,
  };
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 't_test123',
    projectId: 'proj',
    title: 'Implement the widget',
    body: 'Add the widget to the dashboard.',
    status: 'ready',
    priority: 100,
    attempts: 0,
    maxAttempts: 3,
    provider: 'any',
    model: null,
    effort: null,
    judgeFeedback: null,
    parentId: null,
    scheduledAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeVision(overrides: Partial<Vision> = {}): Vision {
  return {
    provider: null,
    model: null,
    effort: null,
    statement: 'A working widget dashboard.',
    criteria: ['Widget renders on the dashboard', 'Widget updates live'],
    verifyCommands: ['npm test', 'npm run build'],
    uiFlows: ['Open /dashboard and confirm the widget shows live data'],
    guardrails: ['Do not modify the auth module'],
    raw: '# Vision\n\nA working widget dashboard.\n',
    ...overrides,
  };
}

const MESSY = `---
provider: claude
model: opus
effort: high
---

# Project Vision

This tool burns leftover quota
on backlog projects automatically.

Second paragraph that should NOT be part of the statement.

## acceptance CRITERIA

- [x] CLI shows usage windows
- [ ] Dispatcher claims ready tasks
* Judge scores runs 1-5

### Verify Commands

\`\`\`sh
# run the suite
pnpm vitest run

pnpm typecheck   # types too
\`\`\`

## UI flows

- Open the board and drag a task to ready

## Guardrails

- Never touch ~/.ssh
- Do not add new dependencies
`;

describe('parseVision', () => {
  it('parses the shipped template without throwing', () => {
    const v = parseVision(TEMPLATE);
    expect(v.provider).toBeNull();
    expect(v.model).toBeNull();
    expect(v.effort).toBeNull();
    // template's vision section is only an HTML comment
    expect(v.statement).toBe('');
    // '...' placeholders are dropped
    expect(v.criteria).toEqual([]);
    expect(v.uiFlows).toEqual([]);
    expect(v.verifyCommands).toEqual(['npm test', 'npm run build']);
    expect(v.guardrails).toEqual([
      'Do not push to any remote. Commit only to the current branch.',
    ]);
    expect(v.raw).toBe(TEMPLATE);
  });

  it('parses a messy real-world vision', () => {
    const v = parseVision(MESSY);
    expect(v.provider).toBe('claude');
    expect(v.model).toBe('opus');
    expect(v.effort).toBe('high');
    expect(v.statement).toBe(
      'This tool burns leftover quota on backlog projects automatically.',
    );
    expect(v.criteria).toEqual([
      'CLI shows usage windows',
      'Dispatcher claims ready tasks',
      'Judge scores runs 1-5',
    ]);
    // comment lines and empties dropped from the fenced block; trailing
    // inline content kept as-is
    expect(v.verifyCommands).toEqual(['pnpm vitest run', 'pnpm typecheck   # types too']);
    expect(v.uiFlows).toEqual(['Open the board and drag a task to ready']);
    expect(v.guardrails).toEqual(['Never touch ~/.ssh', 'Do not add new dependencies']);
    expect(v.raw).toBe(MESSY);
  });

  it('handles missing sections and no headings', () => {
    const v = parseVision('Just a plain paragraph\nthat wraps onto two lines.\n\nMore text.');
    expect(v.statement).toBe('Just a plain paragraph that wraps onto two lines.');
    expect(v.criteria).toEqual([]);
    expect(v.verifyCommands).toEqual([]);
    expect(v.uiFlows).toEqual([]);
    expect(v.guardrails).toEqual([]);
  });

  it('never throws on garbage input', () => {
    expect(() => parseVision('')).not.toThrow();
    expect(() => parseVision('---\n:bad yaml [unclosed\n---\nbody')).not.toThrow();
    expect(() => parseVision('```\nunclosed fence')).not.toThrow();
    const v = parseVision('');
    expect(v.statement).toBe('');
    expect(v.raw).toBe('');
  });

  it('strips checkbox markers from criteria', () => {
    const v = parseVision('## Acceptance criteria\n\n- [ ] open box\n- [x] done box\n- plain');
    expect(v.criteria).toEqual(['open box', 'done box', 'plain']);
  });
});

describe('buildGoalCondition', () => {
  it('includes title, body, criteria, verify, ui flows, guardrails and turn bound', () => {
    const out = buildGoalCondition({
      vision: makeVision(),
      task: makeTask(),
      config: makeConfig(40),
    });
    expect(out).toContain('Implement the widget');
    expect(out).toContain('Add the widget to the dashboard.');
    expect(out).toContain('A working widget dashboard.');
    expect(out).toContain('- Widget renders on the dashboard');
    expect(out).toContain('- Widget updates live');
    expect(out).toContain('all exit 0 with their output shown in the conversation');
    expect(out).toContain('- npm test');
    expect(out).toContain('- npm run build');
    expect(out).toContain('Open /dashboard and confirm the widget shows live data');
    // mandatory guardrails are always present
    expect(out).toContain('Never push to any remote.');
    expect(out).toContain('Commit your work to the current branch with clear messages.');
    expect(out).toContain('- Do not modify the auth module');
    expect(out).toContain('or stop after 40 turns and summarize remaining work');
    // no feedback section when feedback absent
    expect(out).not.toContain('A previous attempt was judged insufficient');
  });

  it('includes the prior-judge feedback section when present', () => {
    const out = buildGoalCondition({
      vision: makeVision(),
      task: makeTask(),
      config: makeConfig(),
      judgeFeedback: 'Tests were never run; the widget does not update.',
    });
    expect(out).toContain(
      'A previous attempt was judged insufficient — address these first: Tests were never run',
    );
  });

  it('respects the 4000-char cap by truncating body first, keeping criteria and verify intact', () => {
    const out = buildGoalCondition({
      vision: makeVision(),
      task: makeTask({ body: 'B'.repeat(10_000) }),
      config: makeConfig(),
    });
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain('…[truncated]');
    expect(out).toContain('- Widget renders on the dashboard');
    expect(out).toContain('- npm test');
    expect(out).toContain('- npm run build');
    expect(out).toContain('Never push to any remote.');
    expect(out).toContain('or stop after 40 turns');
  });

  it('truncates feedback after the body when both are huge', () => {
    const out = buildGoalCondition({
      vision: makeVision(),
      task: makeTask({ body: 'B'.repeat(5_000) }),
      config: makeConfig(),
      judgeFeedback: 'F'.repeat(5_000),
    });
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain('A previous attempt was judged insufficient');
    // criteria + verify survive
    expect(out).toContain('- Widget renders on the dashboard');
    expect(out).toContain('- npm test');
    // feedback got cut
    expect(out).toContain('…[truncated]');
  });

  it('stays under the cap even with empty vision sections', () => {
    const out = buildGoalCondition({
      vision: makeVision({
        statement: '',
        criteria: [],
        verifyCommands: [],
        uiFlows: [],
        guardrails: [],
      }),
      task: makeTask({ body: '' }),
      config: makeConfig(25),
    });
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain('Task: Implement the widget');
    expect(out).toContain('Never push to any remote.');
    expect(out).toContain('or stop after 25 turns');
  });
});
