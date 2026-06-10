import type { DecisionDto, Provider, StateDto, UsageDto } from '../types';
import { fmtCountdown } from '../lib';
import { useNow } from '../useNow';

export function Header({
  state,
  onTogglePause,
  onAddProject,
}: {
  state: StateDto | null;
  onTogglePause: () => void;
  onAddProject: () => void;
}) {
  const paused = state?.paused ?? false;
  const showCodex = state ? 'codex' in state.usage : false;
  return (
    <header className="shrink-0 border-b border-line bg-raised">
      <div className="flex items-stretch gap-6 px-5 py-3">
        <div className="flex flex-col justify-center gap-2 border-r border-line pr-6">
          <h1 className="text-base font-semibold tracking-[0.3em] text-ink">SURPLUS</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={onTogglePause}
              className={`rounded-chip px-2 py-0.5 text-xs font-medium transition-colors ${
                paused
                  ? 'bg-danger/20 text-danger hover:bg-danger/30'
                  : 'bg-overlay text-dim hover:text-ink'
              }`}
            >
              {paused ? 'PAUSED — resume' : 'Pause'}
            </button>
            <button
              onClick={onAddProject}
              className="rounded-chip bg-overlay px-2 py-0.5 text-xs text-dim transition-colors hover:text-ink"
            >
              + Project
            </button>
          </div>
        </div>
        <ProviderPanel
          provider="claude"
          usage={state?.usage.claude ?? null}
          decision={state?.decisions.claude}
        />
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
    <div className="flex min-w-72 flex-col justify-center gap-1.5">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-semibold uppercase tracking-widest ${accent}`}>
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
      </div>
      <Gauge label="5h" pct={usage?.fiveHourPct ?? null} resetsAt={usage?.fiveHourResetsAt ?? null} now={now} />
      <Gauge label="7d" pct={usage?.sevenDayPct ?? null} resetsAt={usage?.sevenDayResetsAt ?? null} now={now} />
    </div>
  );
}

function DecisionBanner({ decision }: { decision?: DecisionDto }) {
  if (!decision) return null;
  const burning = decision.action === 'burn';
  if (burning) {
    return (
      <span className="burn-banner rounded-chip bg-overlay px-2 py-0.5 text-[11px] font-semibold text-ember">
        BURNING — {decision.mode === 'fiveHourBurst' ? '5h burst' : 'weekly surplus'}
      </span>
    );
  }
  return <span className="truncate text-[11px] text-faint">{decision.reason}</span>;
}

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
  const hot = v >= 90;
  return (
    <div className="flex items-center gap-2">
      <span className="w-6 text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <div className="h-1.5 w-40 overflow-hidden rounded-full bg-overlay">
        <div
          className="gauge-fill h-full rounded-full"
          style={{
            width: `${v}%`,
            background: hot
              ? 'linear-gradient(90deg, var(--color-ember), var(--color-burn))'
              : 'linear-gradient(90deg, var(--color-copper), var(--color-ember))',
          }}
        />
      </div>
      <span className="w-9 text-right text-xs text-dim">
        {pct === null ? '—' : `${Math.round(v)}%`}
      </span>
      <span className="text-xs text-faint" title={resetsAt ?? undefined}>
        resets {fmtCountdown(resetsAt, now)}
      </span>
    </div>
  );
}
