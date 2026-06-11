import { useCallback, useEffect, useRef, useState } from 'react';
import { burnNow, getTaskDetail, patchTask } from '../api';
import type { ConfigDto, ProjectDto, ProviderPref, RunDto, TaskDetailDto } from '../types';
import { EFFORT_OPTIONS, effectiveModelEffort, fmtDuration, fmtRel, MODEL_OPTIONS } from '../lib';
import { AttemptDots, ProviderBadge, ScoreRing } from './TaskCard';
import { SlideOver } from './SlideOver';
import { useNow } from '../useNow';

const SELECT_CLS =
  'rounded-chip border border-line bg-overlay px-2 py-1.5 text-xs text-ink outline-none transition-colors duration-150 hover:border-line-strong focus:border-ember';

export function Drawer({
  taskId,
  version,
  projects,
  config,
  onClose,
  onChanged,
}: {
  taskId: string;
  version: number;
  projects: ProjectDto[];
  config: ConfigDto | undefined;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<TaskDetailDto | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const load = useCallback(async () => {
    try {
      const d = await getTaskDetail(taskId);
      setDetail(d);
      if (!dirtyRef.current) {
        setTitle(d.task.title);
        setBody(d.task.body);
      }
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load task');
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const apply = useCallback(
    async (patch: Record<string, unknown>) => {
      setErr(null);
      try {
        const t = await patchTask(taskId, patch);
        setDetail((d) => (d ? { ...d, task: t } : d));
        onChanged();
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'update failed');
      }
    },
    [taskId, onChanged],
  );

  const task = detail?.task;
  const project = task ? projects.find((p) => p.id === task.projectId) : undefined;
  const defaults = task
    ? effectiveModelEffort({ ...task, model: null, effort: null }, config)
    : null;

  return (
    <SlideOver label={task ? `Task: ${task.title}` : 'Task details'} onClose={onClose}>
      {(close) => (
        <div className="flex flex-col gap-4 p-6">
          {!task ? (
            <p className="text-sm text-dim">{err ?? 'Loading…'}</p>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3">
                <input
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setDirty(true);
                  }}
                  aria-label="Task title"
                  className="w-full border-b border-transparent bg-transparent text-base font-semibold text-ink outline-none transition-colors duration-150 focus:border-line-strong"
                />
                <button
                  onClick={close}
                  aria-label="Close task details"
                  className="rounded-chip px-2 py-1 text-dim transition-colors duration-150 hover:bg-overlay hover:text-ink"
                >
                  ✕
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {project && (
                  <span className="rounded-chip bg-overlay px-1.5 py-0.5 text-dim">
                    {project.name}
                  </span>
                )}
                <span className="rounded-chip bg-overlay px-1.5 py-0.5 uppercase tracking-[0.08em] text-faint">
                  {task.status}
                </span>
                <AttemptDots attempts={task.attempts} max={task.maxAttempts} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-[11px] text-faint">
                  provider
                  <select
                    value={task.provider}
                    onChange={(e) => void apply({ provider: e.target.value as ProviderPref })}
                    className={SELECT_CLS}
                  >
                    <option value="any">any</option>
                    <option value="claude">claude</option>
                    <option value="codex">codex</option>
                  </select>
                </label>
                <div className="flex flex-col gap-1 text-[11px] text-faint">
                  priority (lower = sooner)
                  <span className="flex items-center gap-1">
                    <button
                      onClick={() => void apply({ priority: task.priority - 10 })}
                      aria-label="Raise priority"
                      className="rounded-chip bg-overlay px-2.5 py-1.5 text-xs text-dim transition-colors duration-150 hover:bg-active hover:text-ink"
                    >
                      −
                    </button>
                    <span className="w-10 text-center text-xs text-ink">{task.priority}</span>
                    <button
                      onClick={() => void apply({ priority: task.priority + 10 })}
                      aria-label="Lower priority"
                      className="rounded-chip bg-overlay px-2.5 py-1.5 text-xs text-dim transition-colors duration-150 hover:bg-active hover:text-ink"
                    >
                      +
                    </button>
                  </span>
                </div>
                <label className="flex flex-col gap-1 text-[11px] text-faint">
                  model
                  <select
                    value={task.model ?? ''}
                    onChange={(e) => void apply({ model: e.target.value || null })}
                    className={SELECT_CLS}
                  >
                    <option value="">default{defaults ? ` (${defaults.model})` : ''}</option>
                    {MODEL_OPTIONS[task.provider].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-faint">
                  effort
                  <select
                    value={task.effort ?? ''}
                    onChange={(e) => void apply({ effort: e.target.value || null })}
                    className={SELECT_CLS}
                  >
                    <option value="">default{defaults ? ` (${defaults.effort})` : ''}</option>
                    {EFFORT_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="flex flex-col gap-1 text-[11px] text-faint">
                body (appended to the goal condition)
                <textarea
                  value={body}
                  onChange={(e) => {
                    setBody(e.target.value);
                    setDirty(true);
                  }}
                  rows={7}
                  className="field-input resize-y text-sm leading-relaxed"
                />
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    void apply({ title: title.trim() || task.title, body }).then(() =>
                      setDirty(false),
                    );
                  }}
                  disabled={!dirty}
                  className="rounded-chip bg-overlay px-3 py-1.5 text-xs font-medium text-ink transition-colors duration-150 hover:bg-active disabled:text-faint disabled:hover:bg-overlay"
                >
                  Save
                </button>
                <button
                  onClick={async () => {
                    setBusy(true);
                    setErr(null);
                    try {
                      // The server replies 200 even when nothing was claimed
                      // (non-ready task, pacing, pause race) — surface it.
                      const res = await burnNow(task.id);
                      if ((res.result?.launched ?? 0) === 0) {
                        setErr(
                          "nothing dispatched — task must be 'ready' and the provider available (not paused or pacing)",
                        );
                      }
                    } catch (e) {
                      setErr(e instanceof Error ? e.message : 'burn failed');
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy || task.status !== 'ready'}
                  title={
                    task.status !== 'ready'
                      ? `only 'ready' tasks can be burned (this one is '${task.status}')`
                      : undefined
                  }
                  className="burn-banner rounded-chip bg-ember/20 px-3 py-1.5 text-xs font-semibold text-ember transition-colors duration-150 hover:bg-ember/30 disabled:opacity-50"
                >
                  {busy ? 'Igniting…' : 'Burn now'}
                </button>
                <span className="flex-1" />
                <button
                  onClick={() => {
                    void apply({ status: 'archived' }).then(close);
                  }}
                  className="rounded-chip px-2 py-1.5 text-xs text-faint transition-colors duration-150 hover:text-danger"
                >
                  Archive
                </button>
              </div>
              {err && (
                <p role="alert" className="text-xs text-danger">
                  {err}
                </p>
              )}

              {task.judgeFeedback && (
                <section className="flex flex-col gap-1">
                  <h2 className="text-[11px] uppercase tracking-[0.12em] text-faint">
                    judge feedback
                  </h2>
                  <pre className="whitespace-pre-wrap rounded-card bg-overlay p-3 font-sans text-xs leading-relaxed text-dim">
                    {task.judgeFeedback}
                  </pre>
                </section>
              )}

              <section className="flex flex-col gap-2">
                <h2 className="text-[11px] uppercase tracking-[0.12em] text-faint">
                  run history ({detail.runs.length})
                </h2>
                {detail.runs.length === 0 && (
                  <p className="rounded-card border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
                    no runs yet — "Burn now" dispatches outside the schedule
                  </p>
                )}
                {[...detail.runs]
                  .sort((a, b) => b.startedAt - a.startedAt)
                  .map((run) => (
                    <RunItem key={run.id} run={run} />
                  ))}
              </section>
            </>
          )}
        </div>
      )}
    </SlideOver>
  );
}

const OUTCOME_TINT: Record<string, string> = {
  passed: 'bg-jade/15 text-jade',
  failed: 'bg-ember/15 text-ember',
  error: 'bg-danger/15 text-danger',
  timeout: 'bg-danger/15 text-danger',
  quota: 'bg-raised text-dim', // raised, not overlay — chip sits ON an overlay row
  killed: 'bg-raised text-dim',
};

function RunItem({ run }: { run: RunDto }) {
  const now = useNow(30_000);
  const [copied, setCopied] = useState(false);
  return (
    <details className="rounded-card bg-overlay px-3 py-2 shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-chip text-xs">
        {run.provider && <ProviderBadge pref={run.provider} />}
        <span
          className={`rounded-chip px-1.5 py-0.5 text-[10px] font-medium ${
            OUTCOME_TINT[run.outcome ?? ''] ?? 'bg-overlay text-dim'
          }`}
        >
          {run.outcome ?? 'in flight'}
        </span>
        {run.judgeScore !== null && <ScoreRing score={run.judgeScore} />}
        <span className="text-faint">{fmtDuration(run.startedAt, run.endedAt)}</span>
        <span className="ml-auto text-[10px] text-faint">{fmtRel(run.startedAt, now)}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-xs text-dim">
        <p className="text-faint">
          {run.model ?? '—'} · {run.effort ?? '—'}
          {run.exitCode !== null ? ` · exit ${run.exitCode}` : ''}
        </p>
        {run.branch && (
          <p className="flex items-center gap-2">
            <code className="rounded-chip bg-raised px-1.5 py-0.5 text-[11px]">{run.branch}</code>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(run.branch ?? '').then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
              aria-live="polite"
              className="inline-flex min-h-6 items-center rounded-chip px-1.5 py-0.5 text-[10px] text-faint transition-colors duration-150 hover:text-ink"
            >
              {copied ? 'copied' : 'copy'}
            </button>
          </p>
        )}
        {run.summary && <p className="whitespace-pre-wrap leading-relaxed">{run.summary}</p>}
        {run.judgeReasons && (
          <div>
            <h3 className="text-[10px] uppercase tracking-[0.12em] text-faint">judge reasons</h3>
            <p className="whitespace-pre-wrap leading-relaxed">{run.judgeReasons}</p>
          </div>
        )}
        {run.judgeMissing && (
          <div>
            <h3 className="text-[10px] uppercase tracking-[0.12em] text-faint">missing</h3>
            <p className="whitespace-pre-wrap leading-relaxed">{run.judgeMissing}</p>
          </div>
        )}
      </div>
    </details>
  );
}
