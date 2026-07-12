/**
 * roles.ts — EXPERIMENTAL orchestrator/executor delegation (managed-agents).
 *
 * When config.roles is set, the claude worker runs as an ORCHESTRATOR (a smart
 * model) that delegates heavy implementation to an EXECUTOR subagent (a cheaper
 * model) via Claude Code's Task tool — the "lead agent + workers" pattern from
 * Anthropic's managed-agents guide — to cut token cost on long sessions.
 *
 * STATUS: experimental. Whether headless `claude -p "/goal"` honors project
 * subagents + the Task tool is NOT verified end-to-end here. Failure mode is
 * benign: if the Task tool is unavailable, the orchestrator just does the work
 * itself (a no-op, not a break). Everything is gated behind config.roles being
 * present — absent = the standard single-model path, byte-for-byte unchanged.
 */

/** The `.claude/agents/executor.md` written into the worktree when roles are active. */
export function executorAgentMarkdown(executorModel: string): string {
  return `---
name: executor
description: Implements changes delegated by the orchestrator — writes code, runs commands, edits files. Use for all heavy implementation work.
model: ${executorModel}
tools: Bash, Edit, Write, Read, Grep, Glob, WebFetch, WebSearch
---

You are the executor. The orchestrator delegates concrete implementation tasks to
you: write and edit files, run commands, and make the change actually work. Do the
work fully and report what you changed plus any test/verify output. Never run
\`git push\`.
`;
}

/** Guidance prepended to the /goal condition when roles are active. */
export function rolesGoalPreamble(executorModel: string): string {
  return (
    `Work as the ORCHESTRATOR: plan the change, then delegate implementation to the ` +
    `\`executor\` subagent (model ${executorModel}) via the Task tool — one focused task ` +
    `at a time — and review its output. Keep your own token use to planning, review, and ` +
    `integration; let the executor do the bulk edits. If the Task tool is unavailable, do ` +
    `the work yourself.`
  );
}

export interface RolesPlan {
  /** Session model: the orchestrator when roles are active, else the base model. */
  model: string;
  /** allowedTools string, with `Task` added when roles are active. */
  allowedTools: string;
  /** /goal condition, with the orchestration preamble when roles are active. */
  goalText: string;
  /** Executor subagent file to write into the worktree, or null when inactive. */
  executorAgent: { relPath: string; content: string } | null;
}

/**
 * PURE: given the base run parameters and (already-validated) orchestrator/executor
 * models, produce the run plan. When either role model is null/empty, returns the
 * base parameters untouched (roles disabled).
 */
export function resolveRolesPlan(args: {
  baseModel: string;
  baseAllowedTools: string;
  condition: string;
  orchestrator: string | null;
  executor: string | null;
}): RolesPlan {
  const { baseModel, baseAllowedTools, condition, orchestrator, executor } = args;
  if (!orchestrator || !executor) {
    return {
      model: baseModel,
      allowedTools: baseAllowedTools,
      goalText: condition,
      executorAgent: null,
    };
  }
  return {
    model: orchestrator,
    allowedTools: baseAllowedTools.includes('Task') ? baseAllowedTools : `${baseAllowedTools} Task`,
    goalText: `${rolesGoalPreamble(executor)}\n\n${condition}`,
    executorAgent: { relPath: '.claude/agents/executor.md', content: executorAgentMarkdown(executor) },
  };
}
