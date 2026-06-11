/**
 * ANTI-SLOP GATE (declared before the polish pass, per the design playbook):
 *  - Font: Instrument Sans 400/500/600/700 — never Inter/Roboto/system-ui.
 *  - Accent: warm amber/copper OKLCH family (ember/copper/burn, hue 35–70),
 *    codex secondary = jade/teal oklch(0.76 0.115 175). One accent moment per surface.
 *  - Layout: left-aligned header KPIs, asymmetric kanban (Running column elevated,
 *    other wells transparent), 16px column gutters / 8px card gaps (2:1 gestalt).
 *  - Memorable detail: the BURNING banner's breathing underglow + live tabular-nums
 *    countdowns. Hovers are surface shifts, never lifts.
 *  - Rejected: purple/indigo, per-card colored borders, icon-in-colored-circle,
 *    uniform radii, transition:all, toasts-for-errors, stagger-on-static.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createTask,
  getProjects,
  getState,
  getTasks,
  patchTask,
  setArmedApi,
  setPausedApi,
} from './api';
import type { ConfigDto, EventDto, ProjectDto, StateDto, TaskDto, TaskStatus } from './types';
import { Header } from './components/Header';
import { Board } from './components/Board';
import { Drawer } from './components/Drawer';
import { AddProjectModal } from './components/AddProjectModal';
import { SettingsPanel } from './components/SettingsPanel';

export default function App() {
  const [state, setState] = useState<StateDto | null>(null);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [heartbeats, setHeartbeats] = useState<Record<string, string>>({});
  const [scores, setScores] = useState<Record<string, number>>({});
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerVersion, setDrawerVersion] = useState(0);
  const [connected, setConnected] = useState(true);
  const disconnectTimer = useRef<number | null>(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

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

  // Manual usage refresh: bypasses the server's 5-min usage cache (30s floor;
  // never overrides 429 backoff). Cooldown mirrors that floor client-side.
  const [refreshState, setRefreshState] = useState<'idle' | 'busy' | 'cooldown'>('idle');
  const refreshUsage = useCallback(async () => {
    setRefreshState('busy');
    try {
      const s = await getState(true);
      setState(s);
      setRefreshState('cooldown');
      window.setTimeout(() => setRefreshState('idle'), 30_000);
    } catch {
      setRefreshState('idle');
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
    // Connection health: EventSource auto-reconnects; debounce the banner so
    // a single blip doesn't flash it. onopen clears it immediately.
    es.onopen = () => {
      if (disconnectTimer.current !== null) {
        window.clearTimeout(disconnectTimer.current);
        disconnectTimer.current = null;
      }
      setConnected(true);
      void refreshAll(); // resync after an outage
    };
    es.onerror = () => {
      if (disconnectTimer.current !== null) return;
      disconnectTimer.current = window.setTimeout(() => {
        disconnectTimer.current = null;
        setConnected(false);
      }, 3000);
    };
    return () => {
      if (disconnectTimer.current !== null) window.clearTimeout(disconnectTimer.current);
      es.close();
    };
  }, [refetchTasks, refreshAll]);

  const togglePause = useCallback(async () => {
    const current = state?.paused ?? false;
    try {
      const r = await setPausedApi(!current);
      setState((s) => (s ? { ...s, paused: r.paused } : s));
    } catch {
      /* leave as-is */
    }
  }, [state?.paused]);

  const toggleArmed = useCallback(async () => {
    const current = state?.armed ?? false;
    try {
      const r = await setArmedApi(!current);
      setState((s) => (s ? { ...s, armed: r.armed } : s));
    } catch {
      /* leave as-is */
    }
  }, [state?.armed]);

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

  const onConfigSaved = useCallback((cfg: ConfigDto) => {
    setState((s) => (s ? { ...s, config: cfg } : s));
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <Header
        state={state}
        onTogglePause={togglePause}
        onToggleArmed={toggleArmed}
        onAddProject={() => setShowAddProject(true)}
        onOpenSettings={() => setShowSettings(true)}
        onRefreshUsage={() => void refreshUsage()}
        refreshState={refreshState}
      />
      {!connected && (
        <div
          role="alert"
          className="shrink-0 border-b border-danger/30 bg-danger/10 px-6 py-2 text-xs text-danger"
        >
          Can&rsquo;t reach surplus — the server may have stopped. Run{' '}
          <code className="rounded-chip bg-overlay px-1.5 py-0.5">surplus board</code> in
          Terminal; this page will reconnect automatically.
        </div>
      )}
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
        onAddProject={() => setShowAddProject(true)}
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
      {showSettings && state && (
        <SettingsPanel
          config={state.config}
          onClose={() => setShowSettings(false)}
          onSaved={onConfigSaved}
        />
      )}
    </div>
  );
}
