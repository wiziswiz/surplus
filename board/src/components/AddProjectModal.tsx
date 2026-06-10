import { useState } from 'react';
import { createProject } from '../api';

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
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div className="fixed left-1/2 top-28 z-50 w-[440px] -translate-x-1/2 rounded-card bg-overlay p-5 ring-1 ring-line">
        <h2 className="text-sm font-semibold text-ink">Add project</h2>
        <div className="mt-3 flex gap-1">
          {(['existing', 'new'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setErr(null);
              }}
              className={`rounded-chip px-2.5 py-1 text-xs font-medium ${
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
              if (e.key === 'Escape') onClose();
            }}
            placeholder={tab === 'existing' ? '/Users/you/Projects/thing' : 'my-next-thing'}
            className="rounded-chip bg-raised px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-faint focus:ring-1 focus:ring-ember/40"
          />
        </label>
        {tab === 'existing' && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
            Must exist and contain .git — a VISION.md will be drafted if missing.
          </p>
        )}
        {err && <p className="mt-2 text-xs text-danger">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-chip px-2.5 py-1 text-xs text-dim hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !value.trim()}
            className="rounded-chip bg-ember/20 px-3 py-1 text-xs font-semibold text-ember hover:bg-ember/30 disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </>
  );
}
