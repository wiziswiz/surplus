import { useEffect, useMemo, useRef, useState } from 'react';
import { createProject, getDiscover } from '../api';
import type { DiscoveredRepoDto } from '../types';
import { fmtRel } from '../lib';
import { trapTab } from './SlideOver';

/**
 * Add-Project picker. The primary flow is zero-typing: /api/discover scans
 * the configured roots for git repos, ranked by recent activity, and one
 * click registers a repo. Manual path entry survives as an "advanced"
 * fallback for repos outside the scan roots; the New tab scaffolds from
 * scratch.
 */
export function AddProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [tab, setTab] = useState<'pick' | 'path' | 'new'>('pick');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [repos, setRepos] = useState<DiscoveredRepoDto[] | null>(null);
  const [discoverErr, setDiscoverErr] = useState(false);
  const [query, setQuery] = useState('');
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

  useEffect(() => {
    getDiscover()
      .then(setRepos)
      .catch(() => {
        setDiscoverErr(true);
        setRepos([]);
      });
  }, []);

  const filtered = useMemo(() => {
    if (repos === null) return [];
    const q = query.trim().toLowerCase();
    if (q === '') return repos;
    return repos.filter(
      (r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q),
    );
  }, [repos, query]);

  const addRepo = async (repo: DiscoveredRepoDto) => {
    if (busyPath !== null || repo.registered) return;
    setBusyPath(repo.path);
    setErr(null);
    try {
      await createProject({ path: repo.path });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusyPath(null);
    }
  };

  const submit = async () => {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await createProject(tab === 'path' ? { path: v } : { name: v });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const now = Date.now();

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
        className="modal-enter fixed left-1/2 top-24 z-(--z-modal) w-xl max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-panel bg-overlay p-5 shadow-xl ring-1 ring-line"
      >
        <h2 id="add-project-title" className="text-sm font-semibold text-ink">
          Add project
        </h2>
        <div className="mt-3 flex gap-1" role="tablist" aria-label="Project source">
          {(
            [
              ['pick', 'Your repos'],
              ['new', 'New project'],
              ['path', 'Paste a path'],
            ] as const
          ).map(([t, label]) => (
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
              {label}
            </button>
          ))}
        </div>

        {tab === 'pick' && (
          <div className="mt-3">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search your repos…"
              aria-label="Search discovered repos"
              className="field-input w-full text-sm"
            />
            <div
              className="mt-2 max-h-80 overflow-y-auto rounded-panel ring-1 ring-line"
              role="listbox"
              aria-label="Discovered git repos"
            >
              {repos === null && (
                <p className="px-3 py-4 text-xs text-faint">scanning your projects…</p>
              )}
              {repos !== null && filtered.length === 0 && (
                <p className="px-3 py-4 text-xs leading-relaxed text-faint">
                  {discoverErr
                    ? 'Discovery failed — use the “Paste a path” tab.'
                    : query.trim() !== ''
                      ? 'No repos match that search.'
                      : 'No git repos found under your scan roots (Settings → Discovery). Use “New project” or “Paste a path”.'}
                </p>
              )}
              {filtered.map((r) => (
                <button
                  key={r.path}
                  role="option"
                  aria-selected={false}
                  disabled={r.registered || busyPath !== null}
                  onClick={() => void addRepo(r)}
                  title={r.path}
                  className="flex w-full items-center gap-2.5 border-b border-line/50 px-3 py-2 text-left transition-colors duration-150 last:border-b-0 enabled:hover:bg-active disabled:cursor-default"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`truncate text-sm font-medium ${r.registered ? 'text-faint' : 'text-ink'}`}
                      >
                        {r.name}
                      </span>
                      {r.claudeRecent && !r.registered && (
                        <span
                          className="rounded-chip bg-ember/15 px-1.5 py-0.5 text-[10px] font-medium text-ember"
                          title="Recently opened in Claude Code"
                        >
                          recent
                        </span>
                      )}
                      {r.dirty && !r.registered && (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-copper"
                          title="Has uncommitted changes"
                        />
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-faint">{r.path}</span>
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-faint">
                    {r.registered
                      ? 'added ✓'
                      : busyPath === r.path
                        ? 'adding…'
                        : r.lastCommitAt !== null
                          ? fmtRel(r.lastCommitAt, now)
                          : 'no commits'}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-faint">
              Sorted by recent git activity. Picking a repo registers it and drafts a VISION.md
              you can edit. Scan locations: Settings → Discovery.
            </p>
          </div>
        )}

        {tab !== 'pick' && (
          <>
            <label className="mt-3 flex flex-col gap-1 text-[11px] text-faint">
              {tab === 'path' ? 'absolute path to a git repo' : 'project name'}
              <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                }}
                placeholder={tab === 'path' ? '/Users/you/Projects/thing' : 'my-next-thing'}
                className="field-input w-full text-sm"
              />
            </label>
            {tab === 'path' && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                For repos outside your scan roots. Must exist and contain .git — a VISION.md will
                be drafted if missing.
              </p>
            )}
            {tab === 'new' && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                Creates a fresh git repo under ~/Projects with a VISION.md template.
              </p>
            )}
          </>
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
          {tab !== 'pick' && (
            <button
              onClick={() => void submit()}
              disabled={busy || !value.trim()}
              className="rounded-chip bg-ember/20 px-3 py-1 text-xs font-semibold text-ember transition-colors duration-150 hover:bg-ember/30 disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
