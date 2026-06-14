import { useRef, useState } from 'react';
import type { ConfigDto, ProjectDto, TaskDto, TaskStatus } from '../types';
import { TaskCard } from './TaskCard';
import { BorderBeam } from './BorderBeam';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'triage', label: 'Triage' },
  { status: 'todo', label: 'Todo' },
  { status: 'ready', label: 'Ready' },
  { status: 'running', label: 'Running' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
];

const EMPTY_HINT: Partial<Record<TaskStatus, string>> = {
  triage: 'rough ideas land here',
  todo: 'specified but not yet ready',
  ready: 'the queue for the next burn window',
  running: 'the dispatcher launches work here',
  blocked: 'nothing needs a human right now',
  done: 'judge-passed work shows up here',
};

export function Board({
  tasks,
  projects,
  config,
  scores,
  heartbeats,
  onOpen,
  onOpenProject,
  onMove,
  onAddTask,
  onArchive,
  onAddProject,
}: {
  tasks: TaskDto[];
  projects: ProjectDto[];
  config: ConfigDto | undefined;
  scores: Record<string, number>;
  heartbeats: Record<string, string>;
  onOpen: (id: string) => void;
  onOpenProject: (id: string) => void;
  onMove: (id: string, status: TaskStatus) => void;
  onAddTask: (projectId: string, title: string, status: TaskStatus) => Promise<void>;
  onArchive: (id: string) => void;
  onAddProject: () => void;
}) {
  // First-run: nothing registered yet — point at the one action that matters.
  if (projects.length === 0) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="flex max-w-sm flex-col items-start gap-3 rounded-card bg-raised p-8 shadow-md">
          <h2 className="text-xl font-semibold text-ink">No projects yet</h2>
          <p className="text-sm leading-relaxed text-dim">
            surplus burns leftover subscription quota on your backlog. Register a git repo — or
            scaffold a fresh one — to give it something to build while you sleep.
          </p>
          <button
            onClick={onAddProject}
            className="mt-1 rounded-chip bg-ember/20 px-3.5 py-1.5 text-sm font-semibold text-ember transition-colors duration-150 hover:bg-ember/30"
          >
            + Add a project
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 gap-4 overflow-x-auto px-4 py-4">
      {COLUMNS.map((col) => (
        <Column
          key={col.status}
          status={col.status}
          label={col.label}
          tasks={tasks
            .filter((t) => t.status === col.status)
            .sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt)}
          projects={projects}
          config={config}
          scores={scores}
          heartbeats={heartbeats}
          onOpen={onOpen}
          onOpenProject={onOpenProject}
          onMove={onMove}
          onAddTask={onAddTask}
          onArchive={onArchive}
        />
      ))}
    </main>
  );
}

function Column({
  status,
  label,
  tasks,
  projects,
  config,
  scores,
  heartbeats,
  onOpen,
  onOpenProject,
  onMove,
  onAddTask,
  onArchive,
}: {
  status: TaskStatus;
  label: string;
  tasks: TaskDto[];
  projects: ProjectDto[];
  config: ConfigDto | undefined;
  scores: Record<string, number>;
  heartbeats: Record<string, string>;
  onOpen: (id: string) => void;
  onOpenProject: (id: string) => void;
  onMove: (id: string, status: TaskStatus) => void;
  onAddTask: (projectId: string, title: string, status: TaskStatus) => Promise<void>;
  onArchive: (id: string) => void;
}) {
  const [over, setOver] = useState(false);
  const running = status === 'running';
  const droppable = !running; // dropping into Running is dispatcher-only
  return (
    <section
      aria-label={`${label} column`}
      className={`relative flex shrink-0 flex-col overflow-hidden rounded-card transition-[background-color,box-shadow] duration-200 ${
        running
          ? 'w-80 bg-raised shadow-md ring-1 ring-ember/20'
          : `w-72 ${over ? 'bg-ember/5 ring-1 ring-ember/50' : ''}`
      }`}
      onDragOver={(e) => {
        if (droppable) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!droppable) return;
        const id = e.dataTransfer.getData('text/plain');
        if (id) onMove(id, status);
      }}
    >
      <header className="flex items-baseline justify-between px-3 pb-2 pt-3">
        <h2
          className={`text-xs font-medium uppercase tracking-[0.12em] ${
            running ? 'text-ember' : 'text-faint'
          }`}
        >
          {label}
        </h2>
        <span className="text-xs text-faint">{tasks.length}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            project={projects.find((p) => p.id === t.projectId)}
            config={config}
            score={scores[t.id]}
            heartbeat={heartbeats[t.id]}
            onOpen={onOpen}
            onOpenProject={onOpenProject}
            onMove={onMove}
            onArchive={onArchive}
          />
        ))}
        {tasks.length === 0 && (
          <p className="rounded-card border border-dashed border-line px-3 py-5 text-center text-xs leading-relaxed text-faint">
            {EMPTY_HINT[status]}
          </p>
        )}
        {droppable && <AddTaskInline status={status} projects={projects} onAddTask={onAddTask} />}
      </div>
      {/* A live task is running — a slow ember beam signals the column is hot. */}
      {running && tasks.length > 0 && <BorderBeam durationSec={8} widthPx={1.5} />}
    </section>
  );
}

function AddTaskInline({
  status,
  projects,
  onAddTask,
}: {
  status: TaskStatus;
  projects: ProjectDto[];
  onAddTask: (projectId: string, title: string, status: TaskStatus) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  const dismiss = () => {
    setOpen(false);
    // The "+ Add task" button re-mounts in this form's place; return focus there.
    window.setTimeout(() => addBtnRef.current?.focus(), 0);
  };

  if (!open) {
    return (
      <button
        ref={addBtnRef}
        onClick={() => {
          setOpen(true);
          setErr(null);
          if (!projectId && projects[0]) setProjectId(projects[0].id);
        }}
        className="rounded-card px-3 py-1.5 text-left text-xs text-faint transition-colors duration-150 hover:bg-overlay hover:text-dim"
      >
        + Add task
      </button>
    );
  }

  const submit = async () => {
    if (!title.trim() || !projectId) return;
    try {
      await onAddTask(projectId, title.trim(), status);
      setTitle('');
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    }
  };

  return (
    <div
      className="flex flex-col gap-1.5 rounded-card bg-overlay p-2 shadow-sm"
      onKeyDown={(e) => {
        // Escape works from the select / buttons too, not just the title input.
        if (e.key === 'Escape') dismiss();
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        aria-label="Task title"
        placeholder="Task title…"
        className="rounded-chip border border-line bg-raised px-2 py-1 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-faint hover:border-line-strong focus:border-ember"
      />
      <select
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
        aria-label="Project"
        className="rounded-chip border border-line bg-raised px-2 py-1 text-xs text-dim outline-none transition-colors duration-150 hover:border-line-strong focus:border-ember"
      >
        {projects.length === 0 && <option value="">no projects yet</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {err && (
        <p role="alert" className="text-[11px] text-danger">
          {err}
        </p>
      )}
      <div className="flex gap-1.5">
        <button
          onClick={() => void submit()}
          className="rounded-chip bg-ember/20 px-2.5 py-1 text-xs font-medium text-ember transition-colors duration-150 hover:bg-ember/30"
        >
          Add
        </button>
        <button
          onClick={dismiss}
          className="rounded-chip px-2.5 py-1 text-xs text-faint transition-colors duration-150 hover:text-dim"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
