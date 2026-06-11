import type { ConfigDto, Provider, ProviderPref, TaskDto } from './types';

/** '2d 14h' / '1h 04m' / '12m 30s' countdown to an ISO timestamp. */
export function fmtCountdown(targetIso: string | null, now: number): string {
  if (!targetIso) return '—';
  const ms = new Date(targetIso).getTime() - now;
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

/** Relative '3m ago' style time. */
export function fmtRel(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function fmtDuration(startedAt: number, endedAt: number | null): string {
  if (!endedAt) return 'running';
  const s = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Resolve the model/effort a task will actually run with. */
export function effectiveModelEffort(
  task: TaskDto,
  config: ConfigDto | undefined,
): { model: string; effort: string } {
  const prov: Provider = task.provider === 'codex' ? 'codex' : 'claude';
  const defaults = config?.providers?.[prov]?.defaults;
  return {
    model: task.model ?? defaults?.model ?? '—',
    effort: task.effort ?? defaults?.effort ?? '—',
  };
}

export const PROVIDER_TINT: Record<ProviderPref, string> = {
  claude: 'bg-ember/15 text-ember',
  codex: 'bg-jade/15 text-jade',
  any: 'bg-raised text-dim', // raised, not overlay — badge sits ON overlay cards
};

export const MODEL_OPTIONS: Record<ProviderPref, string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1'],
  any: ['opus', 'sonnet', 'haiku', 'gpt-5.1-codex', 'gpt-5.1-codex-mini'],
};

export const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function scoreColor(score: number): string {
  if (score >= 4) return 'var(--color-jade)';
  if (score >= 3) return 'var(--color-ember)';
  return 'var(--color-danger)';
}
