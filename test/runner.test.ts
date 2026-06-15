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
  classifyClaudeOutcome,
  makeRedactingWriter,
  prepareWorktree,
  runTask,
  symlinkNodeModules,
} from '../src/runner.js';
import type { ClaudeOutcomeInputs } from '../src/runner.js';
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

describe('classifyClaudeOutcome (infra vs quota vs error precedence)', () => {
  const base: ClaudeOutcomeInputs = {
    watchdogAborted: false,
    timedOut: false,
    spawnError: null,
    code: 0,
    signal: null,
    isError: null,
    stderrTail: '',
    summary: '',
  };

  it("a nonzero/is_error run whose result is a lost API connection → 'infra'", () => {
    // The real overnight failure that motivated this change.
    expect(
      classifyClaudeOutcome({
        ...base,
        code: 1,
        summary: 'API Error: Unable to connect to API (ConnectionRefused)',
      }),
    ).toBe('infra');
    // Same via the is_error envelope flag on a clean exit code.
    expect(
      classifyClaudeOutcome({
        ...base,
        code: 0,
        isError: true,
        summary: 'Unable to connect to API (ConnectionRefused)',
      }),
    ).toBe('infra');
    // Other connection-level signals also map to infra.
    for (const text of [
      'request failed: ECONNREFUSED 127.0.0.1:443',
      'getaddrinfo ENOTFOUND api.anthropic.com',
      'socket hang up',
      'upstream error: 503 Service Unavailable',
      'network is unreachable',
    ]) {
      expect(classifyClaudeOutcome({ ...base, code: 1, summary: text })).toBe('infra');
    }
    // Matching in stderr (not just summary) works too.
    expect(
      classifyClaudeOutcome({ ...base, code: 1, stderrTail: 'connection refused', summary: 'x' }),
    ).toBe('infra');
  });

  it("a genuine quota / 401 still classifies as 'quota' (not infra)", () => {
    // The runner's QUOTA_RE (kept as-is to preserve the reserve logic) matches
    // quota / rate-limit / overloaded / 401 / authentication / expired.
    expect(
      classifyClaudeOutcome({ ...base, code: 1, summary: 'quota exhausted for this account' }),
    ).toBe('quota');
    expect(classifyClaudeOutcome({ ...base, code: 1, summary: 'HTTP 401 authentication failed' })).toBe(
      'quota',
    );
    expect(classifyClaudeOutcome({ ...base, code: 1, summary: 'rate limit exceeded' })).toBe('quota');
    expect(classifyClaudeOutcome({ ...base, code: 1, summary: 'your token has expired' })).toBe(
      'quota',
    );
    expect(classifyClaudeOutcome({ ...base, code: 1, summary: 'server overloaded' })).toBe('quota');
  });

  it("quota/auth served AS a 5xx stays 'quota' (QUOTA_RE tested before INFRA_RE)", () => {
    // Providers serve rate-limit/overload/auth-expiry as HTTP 5xx. A message that
    // NAMES the quota/auth condition must feed the quota path (and block on a
    // persistent auth failure), NOT be refunded forever as a transient 'infra'.
    expect(
      classifyClaudeOutcome({ ...base, code: 1, summary: 'HTTP 503: rate limit exceeded, please retry later' }),
    ).toBe('quota');
    expect(
      classifyClaudeOutcome({ ...base, code: 1, summary: 'overloaded_error: 503 service unavailable' }),
    ).toBe('quota');
    expect(
      classifyClaudeOutcome({ ...base, code: 1, summary: 'connection refused: token expired, please re-login' }),
    ).toBe('quota');
  });

  it("bare 5xx-as-DATA stays 'error' (anchored to an HTTP context)", () => {
    // A genuine task failure whose output carries a standalone 5xx number (row
    // count / status assertion) must NOT be refunded + looped as a transient blip.
    expect(classifyClaudeOutcome({ ...base, code: 1, summary: 'Retrieved 502 rows from db' })).toBe('error');
    expect(classifyClaudeOutcome({ ...base, code: 1, summary: 'expected 200 but got 503' })).toBe('error');
    expect(
      classifyClaudeOutcome({ ...base, code: 1, summary: 'processed 504 records, 0 failures' }),
    ).toBe('error');
    // ...but a genuine gateway 5xx (HTTP-anchored / gateway phrase) IS infra.
    expect(
      classifyClaudeOutcome({ ...base, code: 1, summary: 'HTTP 503 Service Unavailable from upstream' }),
    ).toBe('infra');
  });

  it("a clean exit 0 is NEVER infra (completed-pending-judge 'failed')", () => {
    // Even if connection-y text appears in the summary of a successful run.
    expect(
      classifyClaudeOutcome({
        ...base,
        code: 0,
        isError: null,
        summary: 'Done. (earlier I saw a transient connection refused but retried successfully)',
      }),
    ).toBe('failed');
  });

  it("a normal nonzero exit with a plain error stays 'error'", () => {
    expect(
      classifyClaudeOutcome({ ...base, code: 2, summary: 'TypeError: cannot read property of undefined' }),
    ).toBe('error');
  });

  it('our deliberate stops (timeout / watchdog / kill) outrank infra text', () => {
    // A timed-out run whose tail happens to mention a connection blip is still a timeout.
    expect(
      classifyClaudeOutcome({ ...base, timedOut: true, code: null, summary: 'connection refused' }),
    ).toBe('timeout');
    // Watchdog abort stays quota even with infra-looking text.
    expect(
      classifyClaudeOutcome({ ...base, watchdogAborted: true, code: null, summary: 'ECONNREFUSED' }),
    ).toBe('quota');
    // A user-pause SIGTERM with infra text is NOT reclassified to infra (only an
    // 'error' base outcome is) — it stays 'killed'.
    expect(
      classifyClaudeOutcome({ ...base, code: null, signal: 'SIGTERM', summary: 'socket hang up' }),
    ).toBe('killed');
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
