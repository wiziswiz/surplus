/**
 * judge.ts — RULER-style impartial scoring of a finished run.
 *
 * Always runs on claude (cheap + reliable JSON), regardless of which
 * provider produced the work. Contract (types.ts module map): judgeRun().
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { JudgeVerdict, ProjectRow, TaskRow, Vision } from './types.js';
import { extractFirstJsonObject, parseClaudeEnvelope } from './runner.js';
import { redactSecrets } from './vision.js';

const JUDGE_TIMEOUT_MS = 10 * 60_000;
const PATCH_CAP = 30 * 1024;
const LOG_TAIL_LINES = 200;
const LOG_TAIL_CAP = 20 * 1024;
const SUMMARY_CAP = 4000;
const VISION_CAP = 6000;

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

function gatherEvidence(args: JudgeRunArgs): {
  diffStat: string;
  patch: string;
  logTail: string;
  summary: string;
} {
  const { run, projectPath } = args;

  let diffStat = '(no branch — no diff available)';
  let patch = '';
  if (run.branch !== null && run.branch !== '' && isSafeBranch(run.branch)) {
    try {
      diffStat = git(projectPath, ['diff', `main...${run.branch}`, '--stat']).trim();
      if (diffStat === '') diffStat = '(empty diff — no changes on the branch)';
    } catch (err) {
      diffStat = `(diff --stat failed: ${redactSecrets(errMessage(err))})`;
    }
    try {
      patch = git(projectPath, ['diff', `main...${run.branch}`]);
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
    diffStat,
    patch,
    logTail: redactSecrets(logTail),
    summary: redactSecrets(summary),
  };
}

function buildJudgePrompt(args: JudgeRunArgs): string {
  const { task, vision } = args;
  const evidence = gatherEvidence(args);

  return [
    'You are an impartial judge evaluating one autonomous coding session (RULER pattern).',
    'Judge ONLY the evidence below against the project VISION and its acceptance criteria.',
    'Be strict: claims in the worker summary count only when the diff or logs demonstrate them.',
    '',
    'EXECUTION MODEL (do not penalize it): the worker ran inside an isolated git worktree',
    'on a dedicated branch (surplus/<task-id>). That worktree directory is deleted after the',
    'run — the BRANCH DIFF below is the complete and only artifact of the work. Working in a',
    'worktree instead of the main checkout is correct by design. Score solely whether the',
    'branch diff + logs demonstrate the acceptance criteria, not where the files were edited.',
    '',
    'Score 1-5:',
    '1 = no meaningful progress or harmful changes',
    '2 = some progress, but core criteria untouched',
    '3 = real progress, several criteria still unmet or unproven',
    '4 = criteria essentially met with minor gaps',
    '5 = all acceptance criteria demonstrably met (verify commands shown passing)',
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
    '## Diff stat (main...branch)',
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
    const prompt = buildJudgePrompt(args);
    const stdout = await runJudgeProcess(prompt, args.judgeModel, args.projectPath);
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
