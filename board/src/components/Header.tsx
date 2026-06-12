import { useRef, useState } from 'react';
import type {
  AccountInfoDto,
  DecisionDto,
  ProjectDto,
  StateDto,
  TaskDto,
  UsageDto,
} from '../types';
import { fmtCountdown, fmtRel } from '../lib';
import { useNow } from '../useNow';

/** Placeholder while /api/state is still loading (claude is enabled by default). */
const LOADING_ACCOUNTS: AccountInfoDto[] = [
  { key: 'claude', provider: 'claude', label: 'personal', priority: null },
];

export type RefreshState = 'idle' | 'busy' | 'cooldown';

export function Header({
  state,
  projects,
  tasks,
  onTogglePause,
  onToggleArmed,
  onAddProject,
  onOpenProject,
  onOpenSettings,
  onRefreshUsage,
  refreshState,
}: {
  state: StateDto | null;
  projects: ProjectDto[];
  tasks: TaskDto[];
  onTogglePause: () => void;
  onToggleArmed: () => void;
  onAddProject: () => void;
  onOpenProject: (id: string) => void;
  onOpenSettings: () => void;
  onRefreshUsage: () => void;
  refreshState: RefreshState;
}) {
  const paused = state?.paused ?? false;
  const armed = state?.armed ?? false;
  // ApiState contract: accounts[] lists every burnable account of the ENABLED
  // providers — one panel each, keyed by AccountKey into usage/decisions.
  // Panels wrap when more than two accounts are configured.
  const accounts = state?.accounts ?? LOADING_ACCOUNTS;
  const claudeCount = accounts.filter((a) => a.provider === 'claude').length;
  return (
    <header className="shrink-0 border-b border-line bg-raised shadow-sm">
      <div className="flex flex-wrap items-stretch gap-x-8 gap-y-4 px-6 py-4">
        <div className="flex flex-col justify-center gap-2.5 border-r border-line pr-8">
          <h1 className="text-base font-bold tracking-[0.3em] text-ink">SURPLUS</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleArmed}
              disabled={!state}
              title={
                armed
                  ? 'Scheduler armed: surplus checks usage every 15 min and burns in pre-reset windows. Click to disarm.'
                  : 'Arm the scheduler: installs the background agent that burns expiring quota automatically.'
              }
              className={`rounded-chip px-2.5 py-1 text-xs font-semibold transition-colors duration-150 disabled:opacity-50 ${
                armed
                  ? 'bg-jade/20 text-jade hover:bg-jade/30'
                  : 'bg-ember/20 text-ember hover:bg-ember/30'
              }`}
            >
              {armed ? '⏻ Armed' : 'Arm schedule'}
            </button>
            <button
              onClick={onTogglePause}
              className={`rounded-chip px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${
                paused
                  ? 'bg-danger/20 text-danger hover:bg-danger/25'
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
            <ProjectsPopover projects={projects} tasks={tasks} onOpenProject={onOpenProject} />
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
        {accounts.map((account) => (
          <ProviderPanel
            key={account.key}
            account={account}
            // Show the account label only when claude has siblings — a lone
            // main account reads exactly as it did pre-multi-account.
            showLabel={account.provider === 'claude' && claudeCount > 1}
            usage={state?.usage[account.key] ?? null}
            decision={state?.decisions[account.key]}
            onRefreshUsage={onRefreshUsage}
            refreshState={refreshState}
          />
        ))}
      </div>
    </header>
  );
}

/** Lightweight project list (name + path + task count) → opens the ProjectDrawer. */
function ProjectsPopover({
  projects,
  tasks,
  onOpenProject,
}: {
  projects: ProjectDto[];
  tasks: TaskDto[];
  onOpenProject: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-chip bg-overlay px-2.5 py-1 text-xs text-dim transition-colors duration-150 hover:bg-active hover:text-ink"
      >
        Projects
      </button>
      {open && (
        <>
          <div
            aria-hidden="true"
            className="fixed inset-0 z-(--z-dropdown)"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            aria-label="Projects"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
                btnRef.current?.focus();
              }
            }}
            className="absolute left-0 top-8 z-(--z-dropdown) max-h-80 w-72 overflow-y-auto rounded-card bg-raised p-1 shadow-lg ring-1 ring-line"
          >
            {projects.length === 0 && (
              <p className="px-2 py-2 text-xs text-faint">no projects yet</p>
            )}
            {projects.map((p) => {
              const count = tasks.filter((t) => t.projectId === p.id).length;
              return (
                <button
                  key={p.id}
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onOpenProject(p.id);
                  }}
                  className="flex w-full items-center gap-2 rounded-chip px-2 py-1.5 text-left transition-colors duration-150 hover:bg-overlay"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-ink">{p.name}</span>
                    <span className="block truncate text-[10px] text-faint" title={p.path}>
                      {p.path}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-chip bg-overlay px-1.5 py-0.5 text-[10px] text-dim">
                    {count} task{count === 1 ? '' : 's'}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={spinning ? 'animate-spin' : undefined}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
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
  account,
  showLabel,
  usage,
  decision,
  onRefreshUsage,
  refreshState,
}: {
  account: AccountInfoDto;
  /** Render the 'claude · work' label chip (multi-account setups only). */
  showLabel: boolean;
  usage: UsageDto | null;
  decision?: DecisionDto;
  onRefreshUsage: () => void;
  refreshState: RefreshState;
}) {
  const now = useNow(1000);
  const accent = account.provider === 'claude' ? 'text-ember' : 'text-jade';
  return (
    <div className="flex min-w-96 max-w-xl flex-1 flex-col justify-center gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`text-xs font-semibold uppercase tracking-[0.15em] ${accent}`}>
          {account.provider}
          {showLabel && (
            <span className="normal-case tracking-normal text-dim"> · {account.label}</span>
          )}
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
        {/* Persistent live region: SSE flips burn/idle without a page action */}
        <span role="status" className="flex min-w-0 items-center">
          <DecisionBanner decision={decision} />
        </span>
        {usage && !usage.unavailable && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-faint">
            updated {fmtRel(usage.fetchedAt, now)}
            <button
              onClick={onRefreshUsage}
              disabled={refreshState !== 'idle'}
              aria-label="Refresh usage now"
              title={
                refreshState === 'cooldown'
                  ? 'Refreshed — available again in a moment'
                  : 'Refresh usage now'
              }
              className="rounded-chip p-1.5 text-faint transition-colors duration-150 hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-40"
            >
              <RefreshIcon spinning={refreshState === 'busy'} />
            </button>
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
