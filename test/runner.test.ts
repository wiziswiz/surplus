/**
 * Tests for runner.ts security guards: the model/effort argv-injection guard
 * and the line-buffered redacting log writer. (The spawn path itself is
 * covered by the end-to-end smoke run.)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeFlagValue, makeRedactingWriter, runTask } from '../src/runner.js';
import type { ProjectRow, RunTaskArgs, TaskRow, Vision } from '../src/types.js';
import { defaultConfig } from '../src/config.js';

describe('assertSafeFlagValue (argv-injection guard)', () => {
  it('accepts plain model/effort tokens', () => {
    expect(assertSafeFlagValue('model', 'opus')).toBe('opus');
    expect(assertSafeFlagValue('model', 'gpt-5.1-codex')).toBe('gpt-5.1-codex');
    expect(assertSafeFlagValue('model', 'claude-opus-4-1-20250805')).toBe(
      'claude-opus-4-1-20250805',
    );
    expect(assertSafeFlagValue('effort', '  high  ')).toBe('high'); // trims
  });

  it('rejects leading-dash values (flag smuggling)', () => {
    expect(() => assertSafeFlagValue('model', '--dangerously-skip-permissions')).toThrow(
      /unsafe model value/,
    );
    expect(() => assertSafeFlagValue('model', '-p')).toThrow(/unsafe model value/);
    expect(() => assertSafeFlagValue('effort', '--permission-mode')).toThrow(
      /unsafe effort value/,
    );
  });

  it('rejects whitespace, shell metacharacters, empties, and oversized values', () => {
    for (const bad of ['', '   ', 'a b', 'a;b', 'a$(x)', 'a\nb', '"quoted"', 'a'.repeat(129)]) {
      expect(() => assertSafeFlagValue('model', bad)).toThrow(/unsafe model value/);
    }
  });
});

describe('makeRedactingWriter', () => {
  function collect(): { out: string[]; writer: ReturnType<typeof makeRedactingWriter> } {
    const out: string[] = [];
    const writer = makeRedactingWriter((text) => out.push(text));
    return { out, writer };
  }

  it('redacts a token split across two chunks (line buffering)', () => {
    const { out, writer } = collect();
    // Neither chunk matches the token pattern on its own — only the
    // recombined line does.
    writer.write('token is sk-an');
    writer.write('t-oat01-AAAABBBBBBBBCCCC\nmore output\n');
    writer.flush();
    const joined = out.join('');
    expect(joined).not.toContain('sk-ant-oat01-AAAABBBBBBBBCCCC');
    expect(joined).toContain('[redacted]');
    expect(joined).toContain('more output');
  });

  it('flush() emits and redacts a trailing partial line', () => {
    const { out, writer } = collect();
    writer.write('Authorization: Bearer abc.def.ghi-secret');
    expect(out.join('')).toBe(''); // buffered — no newline yet
    writer.flush();
    expect(out.join('')).toContain('[redacted]');
    expect(out.join('')).not.toContain('abc.def.ghi-secret');
  });

  it('passes ordinary output through unchanged', () => {
    const { out, writer } = collect();
    writer.write('compiling...\nall 12 tests passed\n');
    writer.flush();
    expect(out.join('')).toBe('compiling...\nall 12 tests passed\n');
  });
});

describe('runTask model/effort validation', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'surplus-runner-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeArgs(over: Partial<RunTaskArgs> = {}): RunTaskArgs {
    const task: TaskRow = {
      id: 't_test1',
      projectId: 'proj1',
      title: 'Test task',
      body: '',
      status: 'running',
      priority: 100,
      attempts: 1,
      maxAttempts: 3,
      provider: 'claude',
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
      path: join(dir, 'repo'),
      visionPath: join(dir, 'repo', 'VISION.md'),
      provider: 'any',
      model: null,
      effort: null,
      createdAt: 0,
    };
    const vision: Vision = {
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
    return {
      task,
      project,
      vision,
      model: 'opus',
      effort: 'high',
      config: defaultConfig(),
      logsDir: join(dir, 'logs'),
      worktreesDir: join(dir, 'worktrees'),
      ...over,
    };
  }

  it('returns an error outcome for a leading-dash model without touching git or spawning', async () => {
    const result = await runTask(makeArgs({ model: '--dangerously-skip-permissions' }));
    expect(result.outcome).toBe('error');
    expect(result.summary).toContain('unsafe model value');
    expect(result.branch).toBeNull(); // never reached prepareWorktree
  });

  it('returns an error outcome for an unsafe effort value', async () => {
    const result = await runTask(makeArgs({ effort: '-x' }));
    expect(result.outcome).toBe('error');
    expect(result.summary).toContain('unsafe effort value');
  });
});
