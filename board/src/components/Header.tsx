import type { DecisionDto, Provider, StateDto, UsageDto } from '../types';
import { fmtCountdown, fmtRel } from '../lib';
import { useNow } from '../useNow';

export function Header({
  state,
  onTogglePause,
  onAddProject,
  onOpenSettings,
}: {
  state: StateDto | null;
  onTogglePause: () => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
}) {
  const paused = state?.paused ?? false;
  // ApiState contract: a provider's usage key is ABSENT when it is disabled —
  // omit its panel instead of rendering empty gauges. (claude defaults to
  // shown while state is still loading, since it is enabled by default.)
  const showClaude = state ? 'claude' in state.usage : true;
  const showCodex = state ? 'codex' in state.usage : false;
  return (
    <header className="shrink-0 border-b border-line bg-raised shadow-sm">
      <div className="flex flex-wrap items-stretch gap-x-8 gap-y-4 px-6 py-4">
        <div className="flex flex-col justify-center gap-2.5 border-r border-line pr-8">
          <h1 className="text-base font-bold tracking-[0.3em] text-ink">SURPLUS</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={onTogglePause}
              className={`rounded-chip px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${
                paused
                  ? 'bg-danger/20 text-danger hover:bg-danger/30'
                  : 'bg-overlay text-dim hover:bg-active hover:text-ink'
              }`}
            >
              {paused ? 'PAUSED — resume' : 'Pause'}
            </button>
            <button
              onClick={onAddProject}
              className="rounded-chip bg-overlay px-2.5 py-1 text-xs text-dim transition-colors duration-150 hover:bg-active hover:text-ink"
            >
              + Project
            </button>
            <button
              onClick={onOpenSettings}
              disabled={!state}
              aria-label="Settings"
              title="Settings"
              className="rounded-chip bg-overlay p-1.5 text-dim transition-colors duration-150 hover:bg-active hover:text-ink disabled:opacity-50"
            >
              <GearIcon />
            </button>
          </div>
        </div>
        {showClaude && (
          <ProviderPanel
            provider="claude"
            usage={state?.usage.claude ?? null}
            decision={state?.decisions.claude}
          />
        )}
        {showCodex && (
          <ProviderPanel
            provider="codex"
            usage={state?.usage.codex ?? null}
            decision={state?.decisions.codex}
          />
        )}
      </div>
    </header>
  );
}

function GearIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
    </svg>
  );
}

/** claude = amber accent, codex = teal — identical structure, tint differs. */
function ProviderPanel({
  provider,
  usage,
  decision,
}: {
  provider: Provider;
  usage: UsageDto | null;
  decision?: DecisionDto;
}) {
  const now = useNow(1000);
  const accent = provider === 'claude' ? 'text-ember' : 'text-jade';
  return (
    <div className="flex min-w-96 max-w-xl flex-1 flex-col justify-center gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`text-xs font-semibold uppercase tracking-[0.15em] ${accent}`}>
          {provider}
        </span>
        {usage?.planName && (
          <span className="rounded-chip bg-overlay px-1.5 py-0.5 text-[10px] font-medium text-dim">
            {usage.planName}
          </span>
        )}
        {usage?.unavailable && (
          <span className="rounded-chip bg-danger/15 px-1.5 py-0.5 text-[10px] text-danger">
            usage unavailable{usage.error ? ` · ${usage.error}` : ''}
          </span>
        )}
        <DecisionBanner decision={decision} />
        {usage && !usage.unavailable && (
          <span className="ml-auto shrink-0 text-xs text-faint">
            updated {fmtRel(usage.fetchedAt, now)}
          </span>
        )}
      </div>
      <Gauge
        label="5h"
        pct={usage?.fiveHourPct ?? null}
        resetsAt={usage?.fiveHourResetsAt ?? null}
        now={now}
      />
      <Gauge
        label="7d"
        pct={usage?.sevenDayPct ?? null}
        resetsAt={usage?.sevenDayResetsAt ?? null}
        now={now}
      />
    </div>
  );
}

function DecisionBanner({ decision }: { decision?: DecisionDto }) {
  if (!decision) return null;
  if (decision.action === 'burn') {
    return (
      <span className="burn-banner rounded-chip bg-overlay px-2 py-0.5 text-[11px] font-semibold text-ember">
        BURNING — {decision.mode === 'fiveHourBurst' ? '5h burst' : 'weekly surplus'}
      </span>
    );
  }
  return (
    <span className="min-w-0 truncate text-[11px] text-faint" title={decision.reason}>
      {decision.reason}
    </span>
  );
}

/**
 * Playbook §9 gauge: 6px recessed track, warm gradient fill (300ms ease-out
 * width), error-tint layer fading in past 90%, big tabular % + live countdown.
 */
function Gauge({
  label,
  pct,
  resetsAt,
  now,
}: {
  label: string;
  pct: number | null;
  resetsAt: string | null;
  now: number;
}) {
  const v = Math.min(100, Math.max(0, pct ?? 0));
  const hot = pct !== null && v >= 90;
  return (
    <div className="flex items-center gap-3">
      <span className="w-7 shrink-0 text-[11px] uppercase tracking-[0.12em] text-faint">
        {label}
      </span>
      <span className="w-16 shrink-0 text-right text-[25px] font-semibold leading-none text-ink">
        {pct === null ? '—' : `${Math.round(v)}%`}
      </span>
      <div
        className={`gauge-track min-w-24 flex-1 ${hot ? 'gauge-hot' : ''}`}
        role="meter"
        aria-label={`${label} window utilization`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(v)}
        aria-valuetext={pct === null ? 'unknown' : `${Math.round(v)}%`}
      >
        <div className="gauge-fill" style={{ width: `${v}%` }} />
        <div className="gauge-fill-hot" style={{ width: `${v}%` }} />
      </div>
      <span className="w-26 shrink-0 text-xs text-faint" title={resetsAt ?? undefined}>
        resets {fmtCountdown(resetsAt, now)}
      </span>
    </div>
  );
}
