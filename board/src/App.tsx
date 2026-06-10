import { useCallback, useEffect, useRef, useState } from 'react';
import { createTask, getProjects, getState, getTasks, patchTask, setPausedApi } from './api';
import type { EventDto, ProjectDto, StateDto, TaskDto, TaskStatus } from './types';
import { Header } from './components/Header';
import { Board } from './components/Board';
import { Drawer } from './components/Drawer';
import { AddProjectModal } from './components/AddProjectModal';

export default function App() {
  const [state, setState] = useState<StateDto | null>(null);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [heartbeats, setHeartbeats] = useState<Record<string, string>>({});
  const [scores, setScores] = useState<Record<string, number>>({});
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerVersion, setDrawerVersion] = useState(0);
  const [showAddProject, setShowAddProject] = useState(false);

  const refetchTimer = useRef<number | null>(null);
  const drawerIdRef = useRef<string | null>(null);
  useEffect(() => {
    drawerIdRef.current = drawerId;
  }, [drawerId]);

  const refetchTasks = useCallback(() => {
    if (refetchTimer.current !== null) return;
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      getTasks().then(setTasks).catch(() => undefined);
    }, 250);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [s, p, t] = await Promise.all([getState(), getProjects(), getTasks()]);
      setState(s);
      setProjects(p);
      setTasks(t);
    } catch {
      /* server unreachable; SSE reconnect will recover */
    }
  }, []);

  // Initial load + periodic state fallback.
  useEffect(() => {
    void refreshAll();
    const iv = window.setInterval(() => {
      getState().then(setState).catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(iv);
  }, [refreshAll]);

  // Live updates: SSE drives everything.
  useEffect(() => {
    const es = new EventSource('/api/events');
    const onEv = (e: MessageEvent<string>) => {
      let row: EventDto;
      try {
        row = JSON.parse(e.data) as EventDto;
      } catch {
        return;
      }
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        /* opaque payload */
      }
      switch (row.type) {
        case 'run-heartbeat': {
          if (row.taskId) {
            const note =
              typeof data.note === 'string'
                ? data.note
                : typeof data.message === 'string'
                  ? data.message
                  : row.data.slice(0, 140);
            const taskId = row.taskId;
            setHeartbeats((prev) => ({ ...prev, [taskId]: note }));
          }
          break;
        }
        case 'judge-verdict': {
          if (row.taskId && typeof data.score === 'number') {
            const taskId = row.taskId;
            const score = data.score;
            setScores((prev) => ({ ...prev, [taskId]: score }));
          }
          refetchTasks();
          break;
        }
        case 'task-created':
        case 'task-updated':
        case 'status-changed':
        case 'run-started':
        case 'run-finished':
          refetchTasks();
          break;
        default:
          break;
      }
      if (
        row.taskId &&
        row.taskId === drawerIdRef.current &&
        (row.type === 'run-started' ||
          row.type === 'run-finished' ||
          row.type === 'judge-verdict' ||
          row.type === 'status-changed')
      ) {
        setDrawerVersion((v) => v + 1);
      }
    };
    const onState = (e: MessageEvent<string>) => {
      try {
        setState(JSON.parse(e.data) as StateDto);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.addEventListener('ev', onEv);
    es.addEventListener('state', onState);
    return () => es.close();
  }, [refetchTasks]);

  const togglePause = useCallback(async () => {
    const current = state?.paused ?? false;
    try {
      const r = await setPausedApi(!current);
      setState((s) => (s ? { ...s, paused: r.paused } : s));
    } catch {
      /* leave as-is */
    }
  }, [state?.paused]);

  const moveTask = useCallback(
    async (id: string, status: TaskStatus) => {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
      try {
        await patchTask(id, { status });
      } catch {
        refetchTasks(); // revert optimistic move
      }
    },
    [refetchTasks],
  );

  const addTask = useCallback(
    async (projectId: string, title: string, status: TaskStatus) => {
      await createTask({ projectId, title, status });
      refetchTasks();
    },
    [refetchTasks],
  );

  return (
    <div className="flex h-screen flex-col">
      <Header
        state={state}
        onTogglePause={togglePause}
        onAddProject={() => setShowAddProject(true)}
      />
      <Board
        tasks={tasks}
        projects={projects}
        config={state?.config}
        scores={scores}
        heartbeats={heartbeats}
        onOpen={setDrawerId}
        onMove={moveTask}
        onAddTask={addTask}
        onArchive={(id) => void moveTask(id, 'archived')}
      />
      {drawerId && (
        <Drawer
          key={drawerId}
          taskId={drawerId}
          version={drawerVersion}
          projects={projects}
          config={state?.config}
          onClose={() => setDrawerId(null)}
          onChanged={refetchTasks}
        />
      )}
      {showAddProject && (
        <AddProjectModal
          onClose={() => setShowAddProject(false)}
          onCreated={() => {
            setShowAddProject(false);
            void refreshAll();
          }}
        />
      )}
    </div>
  );
}
