/**
 * judge.ts — RULER-style impartial scoring of a finished run.
 *
 * Always runs on claude (cheap + reliable JSON), regardless of which
 * provider produced the work. Contract (types.ts module map): judgeRun().
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { JudgeVerdict, ProjectRow, TaskRow, Vision } from './types.js';
import { SURPLUS_DIR_NAME, WORKTREES_DIR } from './types.js';
import {
  assertSafeFlagValue,
  extractFirstJsonObject,
  parseClaudeEnvelope,
  symlinkNodeModules,
} from './runner.js';
import { redactSecrets } from './vision.js';

const JUDGE_TIMEOUT_MS = 10 * 60_000;
const PATCH_CAP = 30 * 1024;
const LOG_TAIL_LINES = 200;
const LOG_TAIL_CAP = 20 * 1024;
const SUMMARY_CAP = 4000;
const VISION_CAP = 6000;

/** Verify-command execution bounds (the judge runs these itself). */
const VERIFY_MAX_COMMANDS = 8;
const VERIFY_TIMEOUT_MS = 8 * 60_000;
const VERIFY_KILL_GRACE_MS = 10_000;
const VERIFY_OUTPUT_TAIL = 4 * 1024;

/**
 * Per-command wall timeout + kill grace, in ms. Defaults to the production
 * bounds above; tests may shrink them via the SURPLUS_VERIFY_TIMEOUT_MS /
 * SURPLUS_VERIFY_KILL_GRACE_MS env vars so the (real) timeout + process-group
 * kill + settle path can be exercised in seconds rather than minutes. Read at
 * call time (not module load) so a test can set them before invoking.
 */
function verifyBounds(): { timeoutMs: number; killGraceMs: number } {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    timeoutMs: num(process.env.SURPLUS_VERIFY_TIMEOUT_MS, VERIFY_TIMEOUT_MS),
    killGraceMs: num(process.env.SURPLUS_VERIFY_KILL_GRACE_MS, VERIFY_KILL_GRACE_MS),
  };
}

export interface JudgeRunArgs {
  task: TaskRow;
  project: ProjectRow;
  vision: Vision;
  run: {
    branch: string | null;
    summary: string | null;
    logPath: string | null;
  };
  judgeModel: string;
  projectPath: string;
  /**
   * Where the judge creates its ephemeral verify worktree (judge-<taskId>).
   * Threaded from config (~/.surplus/worktrees); defaults to it when absent so
   * a missing arg never collides with a live run's worktree under <task.id>.
   */
  worktreesDir?: string;
}

/** One executed verify command + its captured result. */
export interface VerifyResult {
  cmd: string;
  /** Process exit code; null when it never ran (spawn error / timeout / setup failure). */
  exitCode: number | null;
  /** Redacted tail of combined stdout+stderr (or a '(…)' status note). */
  outputTail: string;
  /**
   * True for SYNTHETIC results produced when verify could not even run (skipped
   * branch / worktree-add error / catch-all). These represent JUDGE-side infra
   * failures, NOT real command output — so grading must NOT switch to the
   * "trust the verify output" branch on them (that would down-score good work
   * against an error the judge itself caused). Real executed commands omit it.
   */
  setupFailed?: boolean;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cap(text: string, max: number, marker: string): string {
  return text.length > max ? text.slice(0, max) + marker : text;
}

function capTail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text;
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Branch names we generate are 'surplus/<task-id>'; reject anything odd. */
function isSafeBranch(branch: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/.test(branch);
}

// ---------------------------------------------------------------------------
// Verify-command execution (the judge runs the VISION's verify commands itself
// against the branch, and grades primarily on the REAL output it produced).
// ---------------------------------------------------------------------------

/** Default judge worktrees dir (~/.surplus/worktrees) when the arg is absent. */
function defaultWorktreesDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return path.join(home, SURPLUS_DIR_NAME, WORKTREES_DIR);
}

/**
 * Run ONE verify command in `cwd` with a bounded wall-clock timeout. The cmd
 * string comes from the user's VISION.md (trusted authoring input, same trust
 * level as the worker) and is passed as a SINGLE argv entry to `bash -lc` —
 * never concatenated into a larger shell string. Resolves (never rejects) with
 * the exit code + a redacted tail of combined stdout+stderr.
 */
function runOneVerify(cmd: string, cwd: string): Promise<{ exitCode: number | null; tail: string }> {
  return new Promise((resolve) => {
    // `detached: true` puts the child (bash) into its OWN process group so we
    // can signal the WHOLE tree (bash + any grandchildren it forks/backgrounds
    // — test watchers, `&` helpers, vitest/jest worker pools) via the negative
    // PID. Killing just the bash PID leaves orphaned grandchildren alive; those
    // grandchildren inherit our stdout/stderr pipes and keep them open, so the
    // child 'close' event would NEVER fire and this promise would hang forever.
    const child = spawn('bash', ['-lc', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const { timeoutMs, killGraceMs } = verifyBounds();
    let combined = '';
    let timedOut = false;
    let settled = false;

    const append = (text: string): void => {
      combined = (combined + text).slice(-(VERIFY_OUTPUT_TAIL * 2));
    };

    const finish = (exitCode: number | null, note?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      const body = combined.trim() === '' ? '(no output)' : capTail(combined.trim(), VERIFY_OUTPUT_TAIL);
      const tail = redactSecrets(note != null ? `${note}\n${body}` : body);
      resolve({ exitCode, tail });
    };

    // Signal the child's entire process GROUP (negative PID), so grandchildren
    // die too and release the inherited stdout/stderr pipes. Falls back to the
    // single child PID if the group signal is unavailable.
    const killGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* ignore */
        }
      }
    };

    const wall = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      const hard = setTimeout(() => {
        killGroup('SIGKILL');
        // The grace timer is AUTHORITATIVE: even if a stuck grandchild keeps a
        // pipe open and 'close' never fires, we settle here so the per-command
        // await (and thus judgeRun + worktree cleanup) is always bounded.
        finish(null, `(timed out after ${Math.round(timeoutMs / 60_000)} minutes / killed)`);
      }, killGraceMs);
      hard.unref?.();
    }, timeoutMs);
    wall.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => append(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk.toString('utf8')));
    child.on('error', (err) => {
      finish(null, `(spawn failed: ${errMessage(err)})`);
    });
    child.on('close', (code) => {
      finish(
        timedOut ? null : code,
        timedOut ? `(timed out after ${Math.round(timeoutMs / 60_000)} minutes)` : undefined,
      );
    });
  });
}

/**
 * Execute the VISION's verify commands against `run.branch` in an EPHEMERAL
 * worktree the judge creates and always tears down. Returns one result per
 * command (capped at VERIFY_MAX_COMMANDS). Never throws — on any setup failure
 * it returns a single synthetic result describing the failure, so judgeRun can
 * fall back to evidence-only grading.
 *
 * The ephemeral worktree lives at <worktreesDir>/judge-<taskId>, a path that
 * cannot collide with a live run's worktree (those are <worktreesDir>/<taskId>).
 * node_modules is symlinked in (shared helper with the worker side) so the
 * commands can actually resolve project deps.
 */
export async function runVerifyCommands(args: JudgeRunArgs): Promise<VerifyResult[]> {
  const { vision, run, projectPath, task } = args;
  const commands = vision.verifyCommands.slice(0, VERIFY_MAX_COMMANDS);
  if (commands.length === 0) return [];

  if (run.branch === null || run.branch === '' || !isSafeBranch(run.branch)) {
    return [
      {
        cmd: '(verify skipped)',
        exitCode: null,
        outputTail: 'verify execution failed: no usable branch to check out',
        setupFailed: true,
      },
    ];
  }

  const worktreesDir = args.worktreesDir ?? defaultWorktreesDir();
  // Distinct 'judge-' prefix guarantees no collision with the live run worktree
  // at <worktreesDir>/<task.id>.
  const judgePath = path.join(worktreesDir, `judge-${task.id}`);

  const removeWorktree = (): void => {
    try {
      git(projectPath, ['worktree', 'remove', '--force', judgePath]);
    } catch {
      try {
        rmSync(judgePath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      git(projectPath, ['worktree', 'prune']);
    } catch {
      /* ignore */
    }
  };

  try {
    // Defensive cleanup of a stale judge worktree from a crashed prior judge.
    removeWorktree();
    git(projectPath, ['worktree', 'add', '--force', '--detach', judgePath, run.branch]);
  } catch (err) {
    // Setup failed — make sure nothing is left behind, then signal fall-back.
    removeWorktree();
    return [
      {
        cmd: '(verify setup)',
        exitCode: null,
        outputTail: `verify execution failed: ${redactSecrets(errMessage(err))}`,
        setupFailed: true,
      },
    ];
  }

  try {
    symlinkNodeModules(judgePath, projectPath);
    const results: VerifyResult[] = [];
    for (const cmd of commands) {
      const { exitCode, tail } = await runOneVerify(cmd, judgePath);
      results.push({ cmd, exitCode, outputTail: tail });
    }
    return results;
  } catch (err) {
    // Should not happen (runOneVerify never rejects), but stay defensive.
    return [
      {
        cmd: '(verify run)',
        exitCode: null,
        outputTail: `verify execution failed: ${redactSecrets(errMessage(err))}`,
        setupFailed: true,
      },
    ];
  } finally {
    removeWorktree();
  }
}

/** True when at least one REAL verify command actually executed (vs. only a
 * synthetic setup-failure result the judge produced when verify couldn't run). */
function hasRealVerify(results: VerifyResult[]): boolean {
  return results.some((r) => r.setupFailed !== true);
}

/** Render verify results as the judge-prompt section (caller supplies branch). */
function formatVerifySection(results: VerifyResult[], branch: string | null): string {
  const heading = `## Verify-command results (executed by the judge against the branch ${branch ?? '(unknown)'})`;
  if (results.length === 0) {
    return [
      heading,
      '(VISION declares no verify commands — graded on diff/summary/logs only.)',
    ].join('\n');
  }
  // Setup-failure-only: the judge could not run the commands at all (infra
  // problem on the JUDGE side, not the worker's). Say so plainly so the judge
  // does not mistake it for failing command output.
  if (!hasRealVerify(results)) {
    const reason = results.map((r) => r.outputTail).join('; ');
    return [
      heading,
      '(The judge could NOT execute the verify commands this run — infrastructure issue on the',
      "judge's side, not a result of the worker's work. Ignore this section and grade on the diff,",
      'worker summary, and logs below.)',
      `note: ${reason}`,
    ].join('\n');
  }
  const blocks = results.map((r) => {
    const code = r.exitCode === null ? 'exit (did not complete)' : `exit ${r.exitCode}`;
    return [`$ ${r.cmd}`, code, r.outputTail].join('\n');
  });
  return [heading, ...blocks].join('\n\n');
}

/**
 * Diff base for judging. surplus-scaffolded repos use 'main', but
 * `surplus add` accepts arbitrary repos (master/develop/trunk default
 * branches) — hardcoding 'main' there made both diffs fail and the judge
 * score ~1 on complete work. Resolve the repo's default branch instead.
 */
function resolveDiffBase(projectPath: string): string {
  try {
    const head = git(projectPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
    if (head !== '') return head; // e.g. 'origin/main'
  } catch {
    /* no remote HEAD — local-only repo */
  }
  for (const candidate of ['main', 'master']) {
    try {
      git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
      return candidate;
    } catch {
      /* try next */
    }
  }
  // Last resort: the checkout's HEAD. The triple-dot diff below uses the
  // merge-base, so this still isolates the branch's own work.
  return 'HEAD';
}

function gatherEvidence(args: JudgeRunArgs): {
  diffBase: string;
  diffStat: string;
  patch: string;
  logTail: string;
  summary: string;
} {
  const { run, projectPath } = args;

  let diffBase = 'main';
  let diffStat = '(no branch — no diff available)';
  let patch = '';
  if (run.branch !== null && run.branch !== '' && isSafeBranch(run.branch)) {
    diffBase = resolveDiffBase(projectPath);
    try {
      diffStat = git(projectPath, ['diff', `${diffBase}...${run.branch}`, '--stat']).trim();
      if (diffStat === '') diffStat = '(empty diff — no changes on the branch)';
    } catch (err) {
      diffStat = `(diff --stat failed: ${redactSecrets(errMessage(err))})`;
    }
    try {
      patch = git(projectPath, ['diff', `${diffBase}...${run.branch}`]);
      patch = cap(patch, PATCH_CAP, '\n…[diff truncated at 30KB]');
    } catch (err) {
      patch = `(diff failed: ${redactSecrets(errMessage(err))})`;
    }
  }

  let logTail = '(no log available)';
  if (run.logPath !== null && run.logPath !== '') {
    try {
      const lines = readFileSync(run.logPath, 'utf8').split(/\r?\n/);
      logTail = capTail(lines.slice(-LOG_TAIL_LINES).join('\n'), LOG_TAIL_CAP);
    } catch {
      /* keep placeholder */
    }
  }

  const summary =
    run.summary !== null && run.summary.trim() !== ''
      ? cap(run.summary, SUMMARY_CAP, ' …[truncated]')
      : '(worker produced no summary)';

  return {
    diffBase,
    diffStat,
    patch,
    logTail: redactSecrets(logTail),
    summary: redactSecrets(summary),
  };
}

function buildJudgePrompt(args: JudgeRunArgs, verifyResults: VerifyResult[]): string {
  const { task, vision, run } = args;
  const evidence = gatherEvidence(args);
  // Only switch to the aggressive "trust the verify output" grading branch when
  // at least one REAL command executed. A length-1 synthetic setup-failure
  // array (skipped branch / worktree-add error) must degrade gracefully to
  // evidence-only grading — never poison a passing run with the judge's own
  // infra error.
  const haveVerify = hasRealVerify(verifyResults);

  return [
    'You are an impartial judge evaluating one autonomous coding session (RULER pattern).',
    'Judge the evidence below against the project VISION and its acceptance criteria.',
    '',
    'EXECUTION MODEL (do not penalize it): the worker ran inside an isolated git worktree',
    'on a dedicated branch (surplus/<task-id>). That worktree directory is deleted after the',
    'run — the BRANCH DIFF below is the complete and only artifact of the work. Working in a',
    'worktree instead of the main checkout is correct by design. Score solely whether the',
    'branch demonstrates the acceptance criteria, not where the files were edited.',
    '',
    haveVerify
      ? 'GRADING: Grade PRIMARILY on the "Verify-command results" section — that is REAL output the' +
        ' judge executed by running the VISION\'s verify commands against the branch itself, not the' +
        " worker's claims. If the worker's narrative contradicts the verify output, TRUST THE VERIFY" +
        ' OUTPUT. An acceptance criterion that maps to a verify command is satisfied ONLY if that' +
        " command's exit code / output matches what the VISION requires (exit 0 unless the VISION" +
        ' says otherwise). The diff, worker summary, and logs are SECONDARY evidence. Do NOT penalize' +
        ' a run merely because the worker did not paste test output into its summary — the judge ran' +
        ' the tests itself; rely on those real results.'
      : 'GRADING: The VISION declares no verify commands (or they could not be executed), so grade on' +
        ' the branch diff, worker summary, and logs. Be strict: claims in the worker summary count' +
        ' only when the diff or logs demonstrate them.',
    '',
    'Score 1-5:',
    '1 = no meaningful progress or harmful changes',
    '2 = some progress, but core criteria untouched',
    '3 = real progress, several criteria still unmet or unproven',
    '4 = criteria essentially met with minor gaps',
    haveVerify
      ? '5 = all acceptance criteria demonstrably met (verify commands the judge ran exited cleanly)'
      : '5 = all acceptance criteria demonstrably met',
    '',
    'Respond with ONLY this JSON object and nothing else (no prose, no code fences):',
    '{"score": n, "reasons": "...", "missing": "..."}',
    '"reasons" = why this score. "missing" = concrete items the next attempt must address (empty string if none).',
    '',
    '## Task',
    `Title: ${task.title}`,
    task.body.trim() !== '' ? cap(task.body, 2000, ' …[truncated]') : '(no body)',
    '',
    '## VISION (acceptance criteria source of truth)',
    cap(vision.raw, VISION_CAP, '\n…[vision truncated]'),
    '',
    formatVerifySection(verifyResults, run.branch),
    '',
    `## Diff stat (${evidence.diffBase}...branch)`,
    evidence.diffStat,
    '',
    '## Patch (capped at 30KB)',
    evidence.patch !== '' ? evidence.patch : '(no patch)',
    '',
    '## Worker summary',
    evidence.summary,
    `\n## Log tail (last ${LOG_TAIL_LINES} lines)`,
    evidence.logTail,
  ].join('\n');
}

function runJudgeProcess(prompt: string, judgeModel: string, cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const argv = [
      '-p',
      '--model',
      judgeModel,
      '--effort',
      'low',
      '--permission-mode',
      'default',
      '--output-format',
      'json',
      prompt,
    ];
    const child = spawn('claude', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderrTail = '';
    let timedOut = false;

    const wall = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      const hardKill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 10_000);
      hardKill.unref?.();
    }, JUDGE_TIMEOUT_MS);
    wall.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(wall);
      reject(new Error(`spawn failed: ${redactSecrets(err.message)}`));
    });
    child.on('close', (code) => {
      clearTimeout(wall);
      if (timedOut) {
        reject(new Error('judge timed out after 10 minutes'));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(`judge claude exited ${String(code)}: ${redactSecrets(stderrTail.trim())}`),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

/** Pull {"score":n,...} out of the judge's result text. Throws on failure. */
function parseVerdict(resultText: string): JudgeVerdict {
  let jsonText = extractFirstJsonObject(resultText);

  // The first object may be prose-wrapped junk; fall back to scanning from
  // the position of a "score" key.
  if (jsonText === null || !jsonText.includes('"score"')) {
    const at = resultText.indexOf('"score"');
    if (at !== -1) {
      const open = resultText.lastIndexOf('{', at);
      if (open !== -1) {
        jsonText = extractFirstJsonObject(resultText.slice(open));
      }
    }
  }
  if (jsonText === null) throw new Error('no JSON object in judge output');

  const parsed: unknown = JSON.parse(jsonText);
  if (parsed === null || typeof parsed !== 'object') throw new Error('judge JSON is not an object');
  const obj = parsed as Record<string, unknown>;

  const rawScore = obj['score'];
  const score = typeof rawScore === 'number' ? rawScore : Number(rawScore);
  if (!Number.isFinite(score)) throw new Error('judge JSON has no numeric score');

  return {
    score: Math.min(5, Math.max(0, Math.round(score))),
    reasons: typeof obj['reasons'] === 'string' ? obj['reasons'] : String(obj['reasons'] ?? ''),
    missing: typeof obj['missing'] === 'string' ? obj['missing'] : String(obj['missing'] ?? ''),
  };
}

/**
 * Score a finished run 1-5 against the project's VISION criteria.
 * Any judge-side failure yields {score: 0, reasons: 'judge-error: ...'} —
 * score 0 is treated as 'failed', never 'passed'.
 */
export async function judgeRun(args: JudgeRunArgs): Promise<JudgeVerdict> {
  try {
    // Same argv-injection guard as the workers: judgeModel becomes a
    // `--model <value>` argv value (config-sourced, but guarded anyway).
    const judgeModel = assertSafeFlagValue('judge model', args.judgeModel);
    // Run the VISION's verify commands ourselves against the branch (in an
    // ephemeral worktree that's always torn down) and grade on the REAL output.
    // runVerifyCommands never throws; empty when no verify commands are declared.
    const verifyResults = await runVerifyCommands(args);
    const prompt = buildJudgePrompt(args, verifyResults);
    const stdout = await runJudgeProcess(prompt, judgeModel, args.projectPath);
    const envelope = parseClaudeEnvelope(stdout);
    const resultText = envelope.result ?? stdout;
    return parseVerdict(resultText);
  } catch (err) {
    return {
      score: 0,
      reasons: `judge-error: ${redactSecrets(errMessage(err)).slice(0, 500)}`,
      missing: '',
    };
  }
}
