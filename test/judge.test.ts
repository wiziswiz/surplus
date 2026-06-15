/**
 * Tests for judge.ts verify-command execution (the judge runs the VISION's
 * verify commands itself against the branch and grades on the REAL output).
 *
 * These exercise the real worktree + verify-run + cleanup path against a tmp
 * git repo with a committed branch. The actual claude judge subprocess is
 * mocked at the node:child_process.spawn boundary (only `claude` invocations
 * are intercepted) so NO network/LLM call happens — bash verify commands and
 * git worktree operations still run for real.
 */
import { execFileSync, spawn as realSpawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy that captures the prompt the mocked judge receives, and the canned
// JSON envelope it returns.
const judgeCalls: { argv: string[]; cwd: string | undefined }[] = [];
let cannedEnvelope = JSON.stringify({
  type: 'result',
  result: JSON.stringify({ score: 5, reasons: 'verify passed', missing: '' }),
  is_error: false,
});

/**
 * Mock node:child_process: intercept only `spawn('claude', ...)` (the judge LLM
 * call) and return a fake child that emits the canned envelope on stdout, then
 * closes 0. Every other spawn (bash verify commands) AND execFileSync (git)
 * delegate to the real implementation so the worktree path runs for real.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (cmd: string, args: readonly string[], opts?: unknown) => {
      if (cmd === 'claude') {
        judgeCalls.push({ argv: [...args], cwd: (opts as { cwd?: string } | undefined)?.cwd });
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: () => void;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => undefined;
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(cannedEnvelope));
          child.emit('close', 0, null);
        });
        return child as unknown as ReturnType<typeof actual.spawn>;
      }
      return actual.spawn(cmd, args as string[], opts as never);
    },
  };
});

// Import AFTER the mock is registered.
const { judgeRun, runVerifyCommands } = await import('../src/judge.js');
import type { JudgeRunArgs } from '../src/judge.js';
import type { ProjectRow, TaskRow, Vision } from '../src/types.js';

let dir: string;
let repo: string;
let worktreesDir: string;

/** Init a git repo with a committed surplus/<id> branch carrying a marker. */
function initRepoWithBranch(branch: string): void {
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), 'base');
  const commit = (msg: string) =>
    execFileSync('git', [
      '-C', repo,
      '-c', 'user.name=t',
      '-c', 'user.email=t@t',
      '-c', 'commit.gpgsign=false',
      'commit', '-qm', msg,
    ]);
  execFileSync('git', ['-C', repo, 'add', '-A']);
  commit('init');
  // Branch with the worker's change.
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', branch]);
  writeFileSync(join(repo, 'marker.txt'), 'done');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  commit('work');
  execFileSync('git', ['-C', repo, 'checkout', '-q', 'main']);
}

function makeTask(id: string): TaskRow {
  return {
    id,
    projectId: 'p',
    title: 'Fix the thing',
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

function makeVision(verifyCommands: string[]): Vision {
  return {
    provider: null,
    model: null,
    effort: null,
    statement: 'do the thing',
    criteria: ['it works'],
    verifyCommands,
    uiFlows: [],
    guardrails: [],
    raw: '# Vision\n\nit works\n\n## Verify commands\n' + verifyCommands.map((c) => `- ${c}`).join('\n'),
  };
}

function makeArgs(over: Partial<JudgeRunArgs> & { verifyCommands: string[]; branch: string }): JudgeRunArgs {
  const project: ProjectRow = {
    id: 'p',
    name: 'P',
    path: repo,
    visionPath: join(repo, 'VISION.md'),
    provider: 'any',
    model: null,
    effort: null,
    createdAt: 0,
  };
  return {
    task: makeTask('t_judge1'),
    project,
    vision: makeVision(over.verifyCommands),
    run: { branch: over.branch, summary: 'I did the work', logPath: null },
    judgeModel: 'haiku',
    projectPath: repo,
    worktreesDir,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'surplus-judge-'));
  repo = join(dir, 'repo');
  worktreesDir = join(dir, 'worktrees');
  judgeCalls.length = 0;
  cannedEnvelope = JSON.stringify({
    type: 'result',
    result: JSON.stringify({ score: 5, reasons: 'verify passed', missing: '' }),
    is_error: false,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runVerifyCommands', () => {
  it('runs a passing verify command in an ephemeral worktree and captures exit 0 + output', async () => {
    const branch = 'surplus/t_judge1';
    initRepoWithBranch(branch);
    const results = await runVerifyCommands(
      makeArgs({ verifyCommands: ['echo VERIFY_OK; node -e "process.exit(0)"'], branch }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.exitCode).toBe(0);
    expect(results[0]!.outputTail).toContain('VERIFY_OK');
  });

  it('captures a NON-zero exit code from a failing verify command', async () => {
    const branch = 'surplus/t_judge1';
    initRepoWithBranch(branch);
    const results = await runVerifyCommands(
      makeArgs({ verifyCommands: ['node -e "process.exit(3)"'], branch }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.exitCode).toBe(3);
  });

  it('checks out the BRANCH (the worker change is present in the ephemeral worktree)', async () => {
    const branch = 'surplus/t_judge1';
    initRepoWithBranch(branch);
    // The marker file only exists on the branch, not on main. `cat` it.
    const results = await runVerifyCommands(
      makeArgs({ verifyCommands: ['cat marker.txt'], branch }),
    );
    expect(results[0]!.exitCode).toBe(0);
    expect(results[0]!.outputTail).toContain('done');
  });

  it('removes the ephemeral judge worktree afterward (always cleans up)', async () => {
    const branch = 'surplus/t_judge1';
    initRepoWithBranch(branch);
    await runVerifyCommands(makeArgs({ verifyCommands: ['true'], branch }));
    // No judge-* worktree dir left behind.
    const left = existsSync(worktreesDir) ? readdirSync(worktreesDir) : [];
    expect(left.filter((n) => n.startsWith('judge-'))).toEqual([]);
    // git no longer tracks a judge worktree (the only listed worktree is the
    // main repo checkout itself).
    const wt = execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/);
    expect(wt).toHaveLength(1);
    expect(wt[0]).not.toContain(join(worktreesDir, 'judge-'));
  });

  it('caps at the first 8 verify commands', async () => {
    const branch = 'surplus/t_judge1';
    initRepoWithBranch(branch);
    const cmds = Array.from({ length: 12 }, (_, i) => `echo cmd${i}`);
    const results = await runVerifyCommands(makeArgs({ verifyCommands: cmds, branch }));
    expect(results).toHaveLength(8);
  });

  it('returns [] when the VISION declares no verify commands', async () => {
    const branch = 'surplus/t_judge1';
    initRepoWithBranch(branch);
    const results = await runVerifyCommands(makeArgs({ verifyCommands: [], branch }));
    expect(results).toEqual([]);
  });

  it('records a verify-execution failure (and leaves no worktree) for a bogus branch', async () => {
    const branch = 'surplus/t_judge1';
    initRepoWithBranch(branch);
    const results = await runVerifyCommands(
      makeArgs({ verifyCommands: ['true'], branch: 'surplus/does-not-exist' }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.exitCode).toBeNull();
    expect(results[0]!.outputTail).toContain('verify execution failed');
    expect(results[0]!.setupFailed).toBe(true);
    const left = existsSync(worktreesDir) ? readdirSync(worktreesDir) : [];
    expect(left.filter((n) => n.startsWith('judge-'))).toEqual([]);
  });

  it('resolves (and removes the worktree) within the bound when a verify command BACKGROUNDS a long-lived grandchild', async () => {
    // Regression: a verify cmd that backgrounds a grandchild which inherits the
    // stdout/stderr pipe would keep that pipe open, so the child 'close' event
    // never fires. With detached:true + process-GROUP kill + an authoritative
    // grace-timer settle, runVerifyCommands must still resolve and clean up
    // within the (env-shrunk) timeout bound rather than hanging forever.
    process.env.SURPLUS_VERIFY_TIMEOUT_MS = '1000';
    process.env.SURPLUS_VERIFY_KILL_GRACE_MS = '500';
    try {
      const branch = 'surplus/t_judge1';
      initRepoWithBranch(branch);
      const started = Date.now();
      // Background a long sleep that inherits this shell's stdout/stderr, then
      // let bash exit. Without the fix this hangs until the test timeout.
      const results = await runVerifyCommands(
        makeArgs({ verifyCommands: ['sleep 60 & echo parent-done'], branch }),
      );
      const elapsed = Date.now() - started;
      expect(results).toHaveLength(1);
      // Timed out -> killed -> settled with a null exit code and a timeout note.
      expect(results[0]!.exitCode).toBeNull();
      expect(results[0]!.outputTail).toMatch(/timed out/);
      // Bounded: timeout (1s) + grace (0.5s) + slack, far under any hang.
      expect(elapsed).toBeLessThan(8000);
      // Cleanup still happened.
      const left = existsSync(worktreesDir) ? readdirSync(worktreesDir) : [];
      expect(left.filter((n) => n.startsWith('judge-'))).toEqual([]);
    } finally {
      delete process.env.SURPLUS_VERIFY_TIMEOUT_MS;
      delete process.env.SURPLUS_VERIFY_KILL_GRACE_MS;
    }
  }, 15000);
});

describe('judgeRun (verify execution wired into the prompt, judge subprocess mocked)', () => {
  it('executes verify commands, feeds their real output into the judge prompt, and cleans up', async () => {
    const branch = 'surplus/t_judge1';
    initRepoWithBranch(branch);

    const verdict = await judgeRun(
      makeArgs({ verifyCommands: ['echo JUDGE_RAN_THIS; node -e "process.exit(0)"'], branch }),
    );

    // Mocked judge returned score 5.
    expect(verdict.score).toBe(5);

    // The judge subprocess was invoked exactly once, and the prompt (last argv
    // entry) carries the verify-results section with REAL command output.
    expect(judgeCalls).toHaveLength(1);
    const prompt = judgeCalls[0]!.argv[judgeCalls[0]!.argv.length - 1]!;
    expect(prompt).toContain('## Verify-command results (executed by the judge against the branch surplus/t_judge1)');
    expect(prompt).toContain('$ echo JUDGE_RAN_THIS; node -e "process.exit(0)"');
    expect(prompt).toContain('exit 0');
    expect(prompt).toContain('JUDGE_RAN_THIS');
    expect(prompt).toContain('Grade PRIMARILY');

    // Ephemeral worktree torn down.
    const left = existsSync(worktreesDir) ? readdirSync(worktreesDir) : [];
    expect(left.filter((n) => n.startsWith('judge-'))).toEqual([]);
  });

  it('falls back to evidence-only grading (no verify section run) when VISION has no verify commands', async () => {
    const branch = 'surplus/t_judge1';
    initRepoWithBranch(branch);
    const verdict = await judgeRun(makeArgs({ verifyCommands: [], branch }));
    expect(verdict.score).toBe(5);
    const prompt = judgeCalls[0]!.argv[judgeCalls[0]!.argv.length - 1]!;
    expect(prompt).toContain('VISION declares no verify commands');
    expect(prompt).not.toContain('Grade PRIMARILY');
  });

  it('still returns a verdict (and trusts verify output) when a verify command FAILS', async () => {
    const branch = 'surplus/t_judge1';
    initRepoWithBranch(branch);
    // Judge would mark it down — but here we only assert the failing exit code
    // reaches the prompt and the call still completes.
    cannedEnvelope = JSON.stringify({
      type: 'result',
      result: JSON.stringify({ score: 2, reasons: 'verify failed', missing: 'tests' }),
      is_error: false,
    });
    const verdict = await judgeRun(
      makeArgs({ verifyCommands: ['node -e "process.exit(1)"'], branch }),
    );
    expect(verdict.score).toBe(2);
    const prompt = judgeCalls[0]!.argv[judgeCalls[0]!.argv.length - 1]!;
    expect(prompt).toContain('exit 1');
  });

  it('falls back to EVIDENCE-ONLY grading (not "trust the verify output") on a verify SETUP failure', async () => {
    // VISION declares verify commands, but the judge cannot run them (bogus
    // branch => worktree checkout fails => a synthetic setupFailed result). The
    // prompt must NOT switch to the aggressive "Grade PRIMARILY / TRUST THE
    // VERIFY OUTPUT" branch against the judge's own infra error — it must
    // degrade to the strict-but-evidence-only branch, while still surfacing the
    // failure note honestly.
    initRepoWithBranch('surplus/t_judge1');
    const verdict = await judgeRun(
      makeArgs({ verifyCommands: ['npm test'], branch: 'surplus/does-not-exist' }),
    );
    expect(verdict.score).toBe(5);
    const prompt = judgeCalls[0]!.argv[judgeCalls[0]!.argv.length - 1]!;
    // Aggressive grading must NOT be selected.
    expect(prompt).not.toContain('Grade PRIMARILY');
    expect(prompt).not.toContain('TRUST THE VERIFY OUTPUT');
    // Evidence-only branch IS selected.
    expect(prompt).toContain('grade on');
    // The infra failure is surfaced honestly (not as failing command output).
    expect(prompt).toContain('could NOT execute the verify commands');
    expect(prompt).toContain('verify execution failed');
  });
});
