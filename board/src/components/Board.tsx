import { useState } from 'react';
import type { ConfigDto, ProjectDto, TaskDto, TaskStatus } from '../types';
import { TaskCard } from './TaskCard';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'triage', label: 'Triage' },
  { status: 'todo', label: 'Todo' },
  { status: 'ready', label: 'Ready' },
  { status: 'running', label: 'Running' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
];

export function Board({
  tasks,
  projects,
  config,
  scores,
  heartbeats,
  onOpen,
  onMove,
  onAddTask,
  onArchive,
}: {
  tasks: TaskDto[];
  projects: ProjectDto[];
  config: ConfigDto | undefined;
  scores: Record<string, number>;
  heartbeats: Record<string, string>;
  onOpen: (id: string) => void;
  onMove: (id: string, status: TaskStatus) => void;
  onAddTask: (projectId: string, title: string, status: TaskStatus) => Promise<void>;
  onArchive: (id: string) => void;
}) {
  return (
    <main className="flex min-h-0 flex-1 gap-5 overflow-x-auto px-5 py-5">
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
  onMove: (id: string, status: TaskStatus) => void;
  onAddTask: (projectId: string, title: string, status: TaskStatus) => Promise<void>;
  onArchive: (id: string) => void;
}) {
  const [over, setOver] = useState(false);
  const running = status === 'running';
  const droppable = !running; // dropping into Running is dispatcher-only
  return (
    <section
      className={`flex shrink-0 flex-col rounded-card ${
        running
          ? 'w-76 bg-raised ring-1 ring-ember/25'
          : `w-64 bg-raised/60 ${over ? 'ring-1 ring-ember/40' : ''}`
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
          className={`text-xs font-semibold uppercase tracking-widest ${
            running ? 'text-ember' : 'text-dim'
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
            onArchive={onArchive}
          />
        ))}
        {droppable && <AddTaskInline status={status} projects={projects} onAddTask={onAddTask} />}
      </div>
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

  if (!open) {
    return (
      <button
        onClick={() => {
          setOpen(true);
          setErr(null);
          if (!projectId && projects[0]) setProjectId(projects[0].id);
        }}
        className="rounded-card px-3 py-1.5 text-left text-xs text-faint transition-colors hover:bg-overlay hover:text-dim"
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
    <div className="flex flex-col gap-1.5 rounded-card bg-overlay p-2">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Task title…"
        className="rounded-chip bg-raised px-2 py-1 text-sm text-ink outline-none placeholder:text-faint focus:ring-1 focus:ring-ember/40"
      />
      <select
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
        className="rounded-chip bg-raised px-2 py-1 text-xs text-dim outline-none"
      >
        {projects.length === 0 && <option value="">no projects yet</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {err && <p className="text-[11px] text-danger">{err}</p>}
      <div className="flex gap-1.5">
        <button
          onClick={() => void submit()}
          className="rounded-chip bg-ember/20 px-2 py-0.5 text-xs font-medium text-ember hover:bg-ember/30"
        >
          Add
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-chip px-2 py-0.5 text-xs text-faint hover:text-dim"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
