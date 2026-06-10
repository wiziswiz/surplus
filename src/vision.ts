/**
 * vision.ts — VISION.md parsing, /goal condition assembly, vision drafting,
 * and new-project scaffolding.
 *
 * Contract (types.ts module map):
 *   parseVision(), buildGoalCondition(), draftVision(), scaffoldProject()
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import matter from 'gray-matter';
import type { ProviderPref, SurplusConfig, TaskRow, Vision } from './types.js';

// ---------------------------------------------------------------------------
// Shared util: secret redaction (also imported by runner.ts / judge.ts)
// ---------------------------------------------------------------------------

/** Strip anything that looks like a token/credential from text destined for logs or errors. */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)\b(["']?\s*[:=]\s*)["']?[^\s"',;}{]+/gi,
      '$1$2[redacted]',
    );
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const FALLBACK_TEMPLATE = `---
# Optional per-project overrides (win over ~/.surplus/config.json defaults;
# per-task settings win over these):
# model: opus        # opus | sonnet | haiku
# effort: high       # low | medium | high | xhigh | max
---

# Vision

<!-- One paragraph: what does "this project is finished" look like?
     The /goal evaluator and the judge both read this — write it as a
     verifiable end state, not a wish. -->

## Acceptance criteria

<!-- Measurable, checkable items. Each should be demonstrable from command
     output or a UI walkthrough. -->

- [ ] ...
- [ ] ...

## Verify commands

<!-- Shell commands whose exit code / output proves the criteria. The worker
     runs these and the /goal evaluator reads the results in the transcript. -->

\`\`\`sh
npm test
npm run build
\`\`\`

## UI flows

<!-- Only for projects with a UI: flows the worker must walk through with
     agent-browser as if a real user, before claiming done. -->

- ...

## Guardrails

<!-- Hard constraints. Files/dirs not to touch, behavior to preserve,
     dependencies not to add. -->

- Do not push to any remote. Commit only to the current branch.
- ...
`;

/** Read templates/VISION.md relative to this module; fall back to the embedded copy. */
function readVisionTemplate(): string {
  try {
    // src/vision.ts → ../templates/VISION.md ; dist/vision.js → ../templates/VISION.md
    const p = fileURLToPath(new URL('../templates/VISION.md', import.meta.url));
    return readFileSync(p, 'utf8');
  } catch {
    return FALLBACK_TEMPLATE;
  }
}

// ---------------------------------------------------------------------------
// parseVision
// ---------------------------------------------------------------------------

function normalizeProviderPref(v: unknown): ProviderPref | null {
  return v === 'claude' || v === 'codex' || v === 'any' ? v : null;
}

function normalizeString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

type SectionKind = 'preamble' | 'vision' | 'criteria' | 'verify' | 'uiflows' | 'guardrails' | 'other';

function classifyHeading(text: string): SectionKind {
  const h = text.toLowerCase();
  if (h.includes('acceptance') || h === 'criteria') return 'criteria';
  if (h.includes('verify')) return 'verify';
  if (h.includes('ui flow')) return 'uiflows';
  if (h.includes('guardrail')) return 'guardrails';
  if (h.includes('vision')) return 'vision';
  return 'other';
}

/** Strip a leading markdown checkbox marker ("[ ]", "[x]") from a list item. */
function stripCheckbox(item: string): string {
  return item.replace(/^\[[ xX]\]\s*/, '').trim();
}

/** Placeholder list items the template ships with. */
function isPlaceholder(item: string): boolean {
  return item === '' || item === '...' || item === '…';
}

/**
 * Tolerant VISION.md parser. Never throws; missing sections yield empty
 * arrays / empty statement. `raw` is the full original markdown.
 */
export function parseVision(markdown: string): Vision {
  const input = typeof markdown === 'string' ? markdown : '';
  let content = input;
  let provider: ProviderPref | null = null;
  let model: string | null = null;
  let effort: string | null = null;

  try {
    const fm = matter(input);
    content = fm.content;
    const data: Record<string, unknown> = (fm.data ?? {}) as Record<string, unknown>;
    provider = normalizeProviderPref(data['provider']);
    model = normalizeString(data['model']);
    effort = normalizeString(data['effort']);
  } catch {
    // malformed frontmatter — treat everything as body
    content = input;
  }

  // HTML comments are template scaffolding, not content.
  const stripped = content.replace(/<!--[\s\S]*?-->/g, '');
  const lines = stripped.split(/\r?\n/);

  const criteria: string[] = [];
  const verifyCommands: string[] = [];
  const uiFlows: string[] = [];
  const guardrails: string[] = [];

  let section: SectionKind = 'preamble';
  let inFence = false;

  const visionPara: string[] = [];
  let visionParaDone = false;
  const firstPara: string[] = [];
  let firstParaDone = false;

  const flushParas = (): void => {
    if (visionPara.length > 0) visionParaDone = true;
    if (firstPara.length > 0) firstParaDone = true;
  };

  for (const rawLine of lines) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      flushParas();
      continue;
    }
    if (inFence) {
      if (section === 'verify') {
        const cmd = rawLine.trim();
        if (cmd !== '' && !cmd.startsWith('#')) verifyCommands.push(cmd);
      }
      continue;
    }

    const heading = rawLine.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      flushParas();
      section = classifyHeading(heading[1]!);
      continue;
    }

    const li = rawLine.match(/^\s*[-*+]\s+(.*)$/);
    if (li) {
      flushParas();
      const item = stripCheckbox(li[1]!);
      if (isPlaceholder(item)) continue;
      if (section === 'criteria') criteria.push(item);
      else if (section === 'uiflows') uiFlows.push(item);
      else if (section === 'guardrails') guardrails.push(item);
      continue;
    }

    const text = rawLine.trim();
    if (text === '') {
      flushParas();
      continue;
    }

    if (section === 'vision' && !visionParaDone) visionPara.push(text);
    if (!firstParaDone && section !== 'verify') firstPara.push(text);
  }

  return {
    provider,
    model,
    effort,
    statement: visionPara.length > 0 ? visionPara.join(' ') : firstPara.join(' '),
    criteria,
    verifyCommands,
    uiFlows,
    guardrails,
    raw: input,
  };
}

// ---------------------------------------------------------------------------
// buildGoalCondition
// ---------------------------------------------------------------------------

const GOAL_CONDITION_CAP = 4000;
const TRUNCATION_MARKER = ' …[truncated]';

/**
 * Assemble the /goal completion condition. Hard-capped at 4000 chars:
 * the task body is truncated first, then judge feedback; acceptance
 * criteria and verify commands are kept intact.
 */
export function buildGoalCondition(args: {
  vision: Vision;
  task: TaskRow;
  config: SurplusConfig;
  judgeFeedback?: string | null;
}): string {
  const { vision, task, config } = args;
  const feedback = args.judgeFeedback ?? null;
  const maxTurns = config.dispatcher.maxTurnsHint;

  const build = (body: string, fb: string | null): string => {
    const parts: string[] = [];
    parts.push(`Task: ${task.title}`);
    if (body.trim() !== '') parts.push(body.trim());
    if (vision.statement !== '') {
      parts.push(`Project vision (the end state to reach): ${vision.statement}`);
    }
    if (vision.criteria.length > 0) {
      parts.push(
        'Acceptance criteria — ALL must be demonstrably satisfied:\n' +
          vision.criteria.map((c) => `- ${c}`).join('\n'),
      );
    }
    if (vision.verifyCommands.length > 0) {
      parts.push(
        'Completion is proven when these commands all exit 0 with their output shown in the conversation:\n' +
          vision.verifyCommands.map((c) => `- ${c}`).join('\n'),
      );
    }
    if (vision.uiFlows.length > 0) {
      parts.push(
        'Required browser walkthroughs — perform each flow as a real user and show the results in the conversation:\n' +
          vision.uiFlows.map((f) => `- ${f}`).join('\n'),
      );
    }
    const allGuardrails = [
      'Never push to any remote.',
      'Commit your work to the current branch with clear messages.',
      ...vision.guardrails,
    ];
    parts.push('Hard constraints:\n' + allGuardrails.map((g) => `- ${g}`).join('\n'));
    if (fb !== null && fb.trim() !== '') {
      parts.push(`A previous attempt was judged insufficient — address these first: ${fb.trim()}`);
    }
    parts.push(
      `The goal is complete when everything above is satisfied and proven in the conversation, ` +
        `or stop after ${maxTurns} turns and summarize remaining work.`,
    );
    return parts.join('\n\n');
  };

  const body = task.body ?? '';
  let out = build(body, feedback);
  if (out.length <= GOAL_CONDITION_CAP) return out;

  // 1) truncate the task body
  let over = out.length - GOAL_CONDITION_CAP;
  const newBodyLen = Math.max(0, body.length - over - TRUNCATION_MARKER.length);
  const truncatedBody = newBodyLen > 0 ? body.slice(0, newBodyLen) + TRUNCATION_MARKER : '';
  out = build(truncatedBody, feedback);
  if (out.length <= GOAL_CONDITION_CAP) return out;

  // 2) then truncate judge feedback
  if (feedback !== null && feedback.length > 0) {
    over = out.length - GOAL_CONDITION_CAP;
    const newFbLen = Math.max(0, feedback.length - over - TRUNCATION_MARKER.length);
    const truncatedFb = newFbLen > 0 ? feedback.slice(0, newFbLen) + TRUNCATION_MARKER : null;
    out = build(truncatedBody, truncatedFb);
    if (out.length <= GOAL_CONDITION_CAP) return out;
  }

  // Last resort (criteria/verify alone exceed the cap): hard slice.
  return out.slice(0, GOAL_CONDITION_CAP);
}

// ---------------------------------------------------------------------------
// draftVision
// ---------------------------------------------------------------------------

const DRAFT_TIMEOUT_MS = 5 * 60_000;

/** Strip a single wrapping code fence if the model emitted one around the whole doc. */
function unfence(text: string): string {
  const m = text.match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  return m ? m[1]! : text;
}

function runClaudeCapture(argv: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('claude', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errTail = '';
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
    }, timeoutMs);
    wall.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errTail = (errTail + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(wall);
      reject(new Error(`claude spawn failed: ${redactSecrets(err.message)}`));
    });
    child.on('close', (code) => {
      clearTimeout(wall);
      if (timedOut) {
        reject(new Error(`claude timed out after ${Math.round(timeoutMs / 60_000)} minutes`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`claude exited ${String(code)}: ${redactSecrets(errTail.trim())}`));
        return;
      }
      resolve(out);
    });
  });
}

/**
 * Ask claude (sonnet, medium effort, read-only default permissions) to read
 * the repo at projectPath and emit a filled-in VISION.md. Returns markdown.
 */
export async function draftVision(projectPath: string): Promise<string> {
  const template = readVisionTemplate();
  const prompt = [
    'Read this repository — its README, docs, package manifests, and source layout — and write a VISION.md for it.',
    '',
    'Rules:',
    '- Output ONLY the completed VISION.md markdown. No preamble, no explanation, no code fence wrapping the whole document.',
    '- Follow the template below exactly: keep its frontmatter block and section headings.',
    '- The Vision paragraph must describe a verifiable finished state, not a wish.',
    '- Acceptance criteria must be measurable and demonstrable from command output or a UI walkthrough.',
    '- Verify commands must be real commands that work in THIS repo (check package.json / Makefile / etc).',
    '- Omit UI flows content (keep the heading) if the project has no UI.',
    '- Keep the guardrail "Do not push to any remote. Commit only to the current branch." and add project-specific ones.',
    '',
    'Template:',
    '',
    template,
  ].join('\n');

  const out = await runClaudeCapture(
    ['-p', '--model', 'sonnet', '--effort', 'medium', '--permission-mode', 'default', prompt],
    projectPath,
    DRAFT_TIMEOUT_MS,
  );
  return unfence(out.trim());
}

// ---------------------------------------------------------------------------
// scaffoldProject
// ---------------------------------------------------------------------------

function gitIn(cwd: string, gitArgs: string[]): void {
  execFileSync('git', gitArgs, { cwd, stdio: 'ignore' });
}

/**
 * Create a fresh project directory: git init on branch `main`, template
 * VISION.md, minimal README, and an initial commit.
 */
export function scaffoldProject(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });

  if (!existsSync(path.join(dir, '.git'))) {
    gitIn(dir, ['init', '-b', 'main']);
  }

  const visionPath = path.join(dir, 'VISION.md');
  if (!existsSync(visionPath)) {
    writeFileSync(visionPath, readVisionTemplate(), 'utf8');
  }

  const readmePath = path.join(dir, 'README.md');
  if (!existsSync(readmePath)) {
    writeFileSync(
      readmePath,
      `# ${name}\n\nScaffolded by surplus. See VISION.md for the project goal and acceptance criteria.\n`,
      'utf8',
    );
  }

  gitIn(dir, ['add', '-A']);
  try {
    gitIn(dir, ['commit', '-m', `surplus: scaffold ${name}`]);
  } catch {
    // Likely a missing git identity (or nothing to commit). Retry with a
    // local fallback identity; swallow "nothing to commit".
    try {
      gitIn(dir, [
        '-c',
        'user.name=surplus',
        '-c',
        'user.email=surplus@localhost',
        'commit',
        '-m',
        `surplus: scaffold ${name}`,
      ]);
    } catch {
      /* nothing to commit */
    }
  }
}
