import { useEffect, useRef, useState } from 'react';
import { createProject } from '../api';
import { trapTab } from './SlideOver';

export function AddProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [tab, setTab] = useState<'existing' | 'new'>('existing');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Tab') trapTab(e, panelRef.current);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  const submit = async () => {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await createProject(tab === 'existing' ? { path: v } : { name: v });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        aria-hidden="true"
        className="overlay-enter fixed inset-0 z-(--z-modal) bg-black/40"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-title"
        className="modal-enter fixed left-1/2 top-28 z-(--z-modal) w-md max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-panel bg-overlay p-5 shadow-xl ring-1 ring-line"
      >
        <h2 id="add-project-title" className="text-sm font-semibold text-ink">
          Add project
        </h2>
        <div className="mt-3 flex gap-1" role="tablist" aria-label="Project source">
          {(['existing', 'new'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => {
                setTab(t);
                setErr(null);
              }}
              className={`rounded-chip px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${
                tab === t ? 'bg-ember/20 text-ember' : 'text-dim hover:text-ink'
              }`}
            >
              {t === 'existing' ? 'Existing repo' : 'New project'}
            </button>
          ))}
        </div>
        <label className="mt-3 flex flex-col gap-1 text-[11px] text-faint">
          {tab === 'existing' ? 'absolute path to a git repo' : 'project name'}
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder={tab === 'existing' ? '/Users/you/Projects/thing' : 'my-next-thing'}
            className="field-input w-full text-sm"
          />
        </label>
        {tab === 'existing' && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
            Must exist and contain .git — a VISION.md will be drafted if missing.
          </p>
        )}
        {err && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {err}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-chip px-2.5 py-1 text-xs text-dim transition-colors duration-150 hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !value.trim()}
            className="rounded-chip bg-ember/20 px-3 py-1 text-xs font-semibold text-ember transition-colors duration-150 hover:bg-ember/30 disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </>
  );
}
