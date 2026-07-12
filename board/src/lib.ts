import type { ConfigDto, Provider, ProviderPref, TaskDto } from './types';

/** Provider behind an affinity pref ('claude:<id>' → 'claude'; 'any' falls back to claude). */
export function providerOfPref(pref: ProviderPref): Provider {
  return pref === 'codex' ? 'codex' : 'claude';
}

/**
 * Affinity picker options for the task/project drawers: any + plain providers
 * + one entry per extra claude account (label shown, key submitted). The main
 * account's key IS 'claude', so it never appears twice.
 */
export function affinityOptions(
  config: ConfigDto | undefined,
): Array<{ value: ProviderPref; text: string }> {
  const extras = (config?.providers?.claude?.accounts ?? [])
    .filter((a) => a.id !== 'main')
    .map((a) => ({
      value: `claude:${a.id}` as ProviderPref,
      text: `claude · ${a.label || a.id}`,
    }));
  return [
    { value: 'any', text: 'any' },
    { value: 'claude', text: 'claude' },
    ...extras,
    { value: 'codex', text: 'codex' },
  ];
}

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
  const defaults = config?.providers?.[providerOfPref(task.provider)]?.defaults;
  return {
    model: task.model ?? defaults?.model ?? '—',
    effort: task.effort ?? defaults?.effort ?? '—',
  };
}

const TINT: Record<Provider | 'any', string> = {
  claude: 'bg-ember/15 text-ember',
  codex: 'bg-jade/15 text-jade',
  any: 'bg-raised text-dim', // raised, not overlay — badge sits ON overlay cards
};

/** Badge tint for any affinity pref — account keys take their provider's tint. */
export function providerTint(pref: ProviderPref): string {
  return pref === 'any' ? TINT.any : TINT[providerOfPref(pref)];
}

// Claude models are stable aliases (never rot). Codex slugs are STATIC FALLBACK
// only — the live list comes from the server (`codex debug models`, cached) via
// StateDto.codexModels and is installed with setCodexModels() so a new model
// (e.g. gpt-5.6-*) shows up in the pickers automatically.
const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const CODEX_FALLBACK = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];

let liveCodexModels: string[] | null = null;

/** Install the server's live Codex model list (call on every state update). */
export function setCodexModels(list: string[] | null | undefined): void {
  liveCodexModels = Array.isArray(list) && list.length > 0 ? list : null;
}

/** Current Codex model options: the live list when known, else the static fallback. */
export function codexModelOptions(): string[] {
  return liveCodexModels ?? CODEX_FALLBACK;
}

export const MODEL_OPTIONS: Record<'claude', string[]> = { claude: CLAUDE_MODELS };

/** Model picker options for any affinity pref ('claude:<id>' → claude models). */
export function modelOptionsFor(pref: ProviderPref): string[] {
  if (pref === 'any') return [...CLAUDE_MODELS, ...codexModelOptions()];
  return providerOfPref(pref) === 'codex' ? codexModelOptions() : CLAUDE_MODELS;
}

export const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Effort picker with a human-friendly label on the top level ('max' = highest). */
export const EFFORT_SELECT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max (highest)' },
];

export function scoreColor(score: number): string {
  if (score >= 4) return 'var(--color-jade)';
  if (score >= 3) return 'var(--color-ember)';
  return 'var(--color-danger)';
}
