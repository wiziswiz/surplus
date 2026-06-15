/**
 * Tests for runner.ts security guards: the model/effort argv-injection guard
 * and the line-buffered redacting log writer. (The spawn path itself is
 * covered by the end-to-end smoke run.)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSafeFlagValue,
  makeRedactingWriter,
  prepareWorktree,
  runTask,
  symlinkNodeModules,
} from '../src/runner.js';
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

describe('prepareWorktree node_modules symlink', () => {
  let dir: string;
  let repo: string;

  function initRepo(): void {
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'README.md'), 'hi');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', [
      '-C', repo,
      '-c', 'user.name=t',
      '-c', 'user.email=t@t',
      '-c', 'commit.gpgsign=false',
      'commit', '-qm', 'init',
    ]);
  }

  function makeTask(id: string): TaskRow {
    return {
      id,
      projectId: 'p',
      title: 't',
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
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'surplus-symlink-'));
    repo = join(dir, 'repo');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('symlinks node_modules into a fresh worktree when the project has it', () => {
    initRepo();
    // Fake installed deps: a node_modules dir with a marker file.
    mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;');

    const { worktreePath } = prepareWorktree({
      task: makeTask('t_sym1'),
      projectPath: repo,
      worktreesDir: join(dir, 'worktrees'),
    });

    const link = join(worktreePath, 'node_modules');
    expect(existsSync(link)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(repo, 'node_modules'));
    // The link resolves to the real dep file.
    expect(existsSync(join(link, 'left-pad', 'index.js'))).toBe(true);
  });

  it('does not create a node_modules link when the project has none', () => {
    initRepo();
    const { worktreePath } = prepareWorktree({
      task: makeTask('t_sym2'),
      projectPath: repo,
      worktreesDir: join(dir, 'worktrees'),
    });
    expect(existsSync(join(worktreePath, 'node_modules'))).toBe(false);
  });

  it('symlinkNodeModules is a no-op (never throws) when a node_modules already exists in the worktree', () => {
    initRepo();
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    const wt = join(dir, 'wt');
    mkdirSync(join(wt, 'node_modules'), { recursive: true }); // real dir already present
    expect(() => symlinkNodeModules(wt, repo)).not.toThrow();
    // Existing dir is left as a real directory, not replaced by a link.
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(false);
  });
});
