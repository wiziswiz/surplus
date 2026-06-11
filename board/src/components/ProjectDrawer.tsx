import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteProject, getProjectVision, patchProject, putProjectVision } from '../api';
import type { ConfigDto, ProjectDto, ProjectPatchDto, ProviderPref, TaskDto } from '../types';
import { SlideOver } from './SlideOver';

const SELECT_CLS =
  'rounded-chip border border-line bg-overlay px-2 py-1.5 text-xs text-ink outline-none transition-colors duration-150 hover:border-line-strong focus:border-ember';

const VISION_MAX_CHARS = 64_000;

/**
 * Project slide-over: name/provider/model/effort overrides, the VISION.md
 * editor (the contract the worker and judge are graded against), and a
 * guarded two-click delete. Mount with key={project.id}.
 */
export function ProjectDrawer({
  project,
  tasks,
  config,
  onClose,
  onChanged,
  onDeleted,
}: {
  project: ProjectDto;
  /** App's task list (non-archived) — used to guard deletion. */
  tasks: TaskDto[];
  config: ConfigDto | undefined;
  onClose: () => void;
  /** Server confirmed a PATCH; sync App's projects state. */
  onChanged: (p: ProjectDto) => void;
  /** Project deleted; refetch projects + tasks and close. */
  onDeleted: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [model, setModel] = useState(project.model ?? '');
  const [effort, setEffort] = useState(project.effort ?? '');
  const [err, setErr] = useState<string | null>(null);

  // VISION.md editor state.
  const [vision, setVision] = useState<string | null>(null); // null = loading
  const [visionDirty, setVisionDirty] = useState(false);
  const [visionBusy, setVisionBusy] = useState(false);
  const [visionSaved, setVisionSaved] = useState(false);
  const [visionErr, setVisionErr] = useState<string | null>(null);

  // Two-click delete.
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmTimer = useRef<number | null>(null);

  const liveTasks = tasks.filter((t) => t.projectId === project.id && t.status !== 'archived');
  const provider = project.provider === 'codex' ? 'codex' : 'claude';
  const defaults = config?.providers?.[provider]?.defaults;

  useEffect(() => {
    let cancelled = false;
    getProjectVision(project.id)
      .then((v) => {
        if (!cancelled) setVision(v.markdown);
      })
      .catch((e: unknown) => {
        if (!cancelled) setVisionErr(e instanceof Error ? e.message : 'failed to load VISION.md');
      });
    return () => {
      cancelled = true;
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    };
  }, [project.id]);

  const apply = useCallback(
    async (patch: ProjectPatchDto) => {
      setErr(null);
      try {
        const updated = await patchProject(project.id, patch);
        onChanged(updated);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'update failed');
      }
    },
    [project.id, onChanged],
  );

  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(project.name); // empty reverts
      return;
    }
    if (trimmed !== project.name) void apply({ name: trimmed });
  };

  const commitOverride = (field: 'model' | 'effort', raw: string) => {
    const next = raw.trim() || null;
    if (next === project[field]) return;
    void apply({ [field]: next });
  };

  const saveVision = async () => {
    if (vision === null) return;
    setVisionBusy(true);
    setVisionErr(null);
    try {
      await putProjectVision(project.id, vision);
      setVisionDirty(false);
      setVisionSaved(true);
    } catch (e) {
      setVisionErr(e instanceof Error ? e.message : 'save failed');
    } finally {
      setVisionBusy(false);
    }
  };

  const onDelete = async (close: () => void) => {
    if (!confirming) {
      setConfirming(true);
      // Arm for 5s, then stand down — a stale confirm button is a footgun.
      confirmTimer.current = window.setTimeout(() => setConfirming(false), 5000);
      return;
    }
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    setDeleting(true);
    setErr(null);
    try {
      await deleteProject(project.id);
      onDeleted();
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete failed');
      setConfirming(false);
      setDeleting(false);
    }
  };

  return (
    <SlideOver label={`Project: ${project.name}`} onClose={onClose} widthClass="w-lg">
      {(close) => (
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-start justify-between gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              aria-label="Project name"
              className="w-full border-b border-transparent bg-transparent text-base font-semibold text-ink outline-none transition-colors duration-150 focus:border-line-strong"
            />
            <button
              onClick={close}
              aria-label="Close project details"
              className="rounded-chip px-2 py-1 text-dim transition-colors duration-150 hover:bg-overlay hover:text-ink"
            >
              ✕
            </button>
          </div>

          <p className="-mt-3 truncate text-xs text-dim" title={project.path}>
            {project.path}
          </p>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-faint">
              provider preference
              <select
                value={project.provider}
                onChange={(e) => void apply({ provider: e.target.value as ProviderPref })}
                className={SELECT_CLS}
              >
                <option value="any">any</option>
                <option value="claude">claude</option>
                <option value="codex">codex</option>
              </select>
            </label>
            <span aria-hidden="true" />
            <label className="flex flex-col gap-1 text-[11px] text-faint">
              model override
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => commitOverride('model', model)}
                placeholder={defaults ? `inherit (${defaults.model})` : 'inherit'}
                className="field-input w-full text-xs"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-faint">
              effort override
              <input
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                onBlur={() => commitOverride('effort', effort)}
                placeholder={defaults ? `inherit (${defaults.effort})` : 'inherit'}
                className="field-input w-full text-xs"
              />
            </label>
          </div>
          <p className="-mt-3 max-w-sm text-xs leading-relaxed text-faint">
            Empty = inherit the provider default. Task-level overrides still win.
          </p>
          {err && (
            <p role="alert" className="text-xs text-danger">
              {err}
            </p>
          )}

          <section className="flex flex-col gap-2">
            <h2 className="text-[11px] uppercase tracking-[0.12em] text-faint">VISION.md</h2>
            {vision === null && !visionErr ? (
              <p className="text-sm text-dim">Loading…</p>
            ) : (
              <textarea
                value={vision ?? ''}
                onChange={(e) => {
                  setVision(e.target.value);
                  setVisionDirty(true);
                  setVisionSaved(false);
                }}
                maxLength={VISION_MAX_CHARS}
                aria-label="VISION.md markdown"
                spellCheck={false}
                style={{ tabSize: 2 }}
                className="field-input min-h-[360px] w-full resize-y font-mono text-[13px] leading-relaxed"
              />
            )}
            <p className="text-xs leading-relaxed text-faint">
              This is the contract the worker and judge are graded against.
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => void saveVision()}
                disabled={!visionDirty || visionBusy || vision === null}
                className="rounded-chip bg-ember/20 px-3 py-1.5 text-xs font-semibold text-ember transition-colors duration-150 hover:bg-ember/30 disabled:opacity-50"
              >
                {visionBusy ? 'Saving…' : 'Save VISION.md'}
              </button>
              <span
                aria-live="polite"
                className={`text-xs text-jade transition-opacity duration-300 ${
                  visionSaved ? 'opacity-100' : 'opacity-0'
                }`}
              >
                Saved
              </span>
              {visionErr && (
                <p role="alert" className="text-xs text-danger">
                  {visionErr}
                </p>
              )}
            </div>
          </section>

          <div className="mt-2 flex items-center gap-3 border-t border-line pt-4">
            <button
              onClick={() => void onDelete(close)}
              disabled={deleting || liveTasks.length > 0}
              title={
                liveTasks.length > 0
                  ? `${liveTasks.length} task(s) are not archived — archive them first`
                  : undefined
              }
              className={`rounded-chip px-3 py-1.5 text-xs font-medium transition-colors duration-150 disabled:opacity-50 ${
                confirming
                  ? 'bg-danger/20 text-danger hover:bg-danger/25'
                  : 'text-faint hover:bg-danger/10 hover:text-danger'
              }`}
            >
              {deleting ? 'Deleting…' : confirming ? 'Click again to confirm' : 'Delete project'}
            </button>
            {liveTasks.length > 0 && (
              <span className="text-xs text-faint">
                {liveTasks.length} task{liveTasks.length === 1 ? '' : 's'} must be archived first
              </span>
            )}
          </div>
        </div>
      )}
    </SlideOver>
  );
}
