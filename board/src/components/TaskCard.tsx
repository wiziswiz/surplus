import { useState } from 'react';
import type { ConfigDto, ProjectDto, ProviderPref, TaskDto } from '../types';
import { effectiveModelEffort, fmtRel, PROVIDER_TINT, scoreColor } from '../lib';
import { useNow } from '../useNow';

export function ProviderBadge({ pref }: { pref: ProviderPref }) {
  return (
    <span className={`rounded-chip px-1.5 py-0.5 text-[10px] font-medium ${PROVIDER_TINT[pref]}`}>
      {pref}
    </span>
  );
}

export function ScoreRing({ score }: { score: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <span className="inline-flex items-center gap-1" title={`judge ${score}/5`}>
      <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
        <circle cx="8" cy="8" r={r} fill="none" stroke="var(--color-line)" strokeWidth="2.5" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke={scoreColor(score)}
          strokeWidth="2.5"
          strokeDasharray={`${(c * Math.min(5, Math.max(0, score))) / 5} ${c}`}
          strokeLinecap="round"
        />
      </svg>
      <span className="text-[11px] text-dim">{score}</span>
    </span>
  );
}

export function AttemptDots({ attempts, max }: { attempts: number; max: number }) {
  const total = Math.min(6, Math.max(max, attempts, 1));
  return (
    <span className="flex items-center gap-0.5" title={`${attempts}/${max} attempts`}>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`h-1.5 w-1.5 rounded-full ${i < attempts ? 'bg-ember' : 'bg-line'}`}
        />
      ))}
    </span>
  );
}

export function TaskCard({
  task,
  project,
  config,
  score,
  heartbeat,
  onOpen,
  onArchive,
}: {
  task: TaskDto;
  project: ProjectDto | undefined;
  config: ConfigDto | undefined;
  score: number | undefined;
  heartbeat: string | undefined;
  onOpen: (id: string) => void;
  onArchive: (id: string) => void;
}) {
  const now = useNow(30_000);
  const running = task.status === 'running';
  const { model, effort } = effectiveModelEffort(task, config);
  const [menu, setMenu] = useState(false);

  return (
    <article
      draggable={!running}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
      onClick={() => onOpen(task.id)}
      className={`group relative cursor-pointer rounded-card bg-overlay px-3 py-2.5 ${
        running ? 'run-pulse ring-1 ring-ember/30' : 'transition-colors hover:bg-overlay/70'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium leading-snug text-ink">{task.title}</h3>
        <div className="relative shrink-0">
          <button
            aria-label="card menu"
            onClick={(e) => {
              e.stopPropagation();
              setMenu((m) => !m);
            }}
            className="rounded-chip px-1 text-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
          >
            ⋯
          </button>
          {menu && (
            <div
              className="absolute right-0 top-5 z-10 rounded-chip bg-raised px-1 py-1 ring-1 ring-line"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  setMenu(false);
                  onArchive(task.id);
                }}
                className="block w-full rounded-chip px-2 py-1 text-left text-xs text-dim hover:bg-overlay hover:text-ink"
              >
                Archive
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {project && (
          <span className="rounded-chip bg-raised px-1.5 py-0.5 text-[10px] text-dim">
            {project.name}
          </span>
        )}
        <ProviderBadge pref={task.provider} />
        <span className="rounded-chip bg-raised px-1.5 py-0.5 text-[10px] text-faint">
          {model} · {effort}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AttemptDots attempts={task.attempts} max={task.maxAttempts} />
          {score !== undefined && <ScoreRing score={score} />}
        </div>
        <span className="text-[10px] text-faint">{fmtRel(task.updatedAt, now)}</span>
      </div>

      {running && heartbeat && (
        <p className="mt-1.5 truncate text-[11px] text-ember/80" title={heartbeat}>
          {heartbeat}
        </p>
      )}
    </article>
  );
}
