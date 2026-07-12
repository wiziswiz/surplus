import { describe, expect, it } from 'vitest';
import {
  executorAgentMarkdown,
  resolveRolesPlan,
  rolesGoalPreamble,
} from '../src/roles.js';

const BASE = {
  baseModel: 'opus',
  baseAllowedTools: 'Bash(*) Edit Write WebFetch WebSearch',
  condition: 'DO THE THING.',
};

describe('resolveRolesPlan', () => {
  it('is a no-op when roles are disabled (null models) — hardened path unchanged', () => {
    const plan = resolveRolesPlan({ ...BASE, orchestrator: null, executor: null });
    expect(plan).toEqual({
      model: 'opus',
      allowedTools: 'Bash(*) Edit Write WebFetch WebSearch',
      goalText: 'DO THE THING.',
      executorAgent: null,
    });
  });

  it('is a no-op when only one role is set', () => {
    expect(resolveRolesPlan({ ...BASE, orchestrator: 'fable', executor: null }).executorAgent).toBeNull();
    expect(resolveRolesPlan({ ...BASE, orchestrator: null, executor: 'sonnet' }).model).toBe('opus');
  });

  it('when active: runs as orchestrator, adds Task, prepends preamble, writes executor agent', () => {
    const plan = resolveRolesPlan({ ...BASE, orchestrator: 'fable', executor: 'sonnet' });
    expect(plan.model).toBe('fable');
    expect(plan.allowedTools).toBe('Bash(*) Edit Write WebFetch WebSearch Task');
    expect(plan.goalText.startsWith(rolesGoalPreamble('sonnet'))).toBe(true);
    expect(plan.goalText).toContain('DO THE THING.');
    expect(plan.executorAgent).not.toBeNull();
    expect(plan.executorAgent!.relPath).toBe('.claude/agents/executor.md');
    expect(plan.executorAgent!.content).toContain('model: sonnet');
  });

  it('does not duplicate the Task tool if already present', () => {
    const plan = resolveRolesPlan({
      ...BASE,
      baseAllowedTools: 'Bash(*) Edit Write Task',
      orchestrator: 'fable',
      executor: 'sonnet',
    });
    expect(plan.allowedTools).toBe('Bash(*) Edit Write Task');
  });
});

describe('executorAgentMarkdown', () => {
  it('pins the executor model and never allows git push', () => {
    const md = executorAgentMarkdown('sonnet');
    expect(md).toContain('name: executor');
    expect(md).toContain('model: sonnet');
    expect(md).toContain('git push');
  });
});
