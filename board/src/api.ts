import type {
  ConfigDto,
  ConfigPatchDto,
  ProjectDto,
  Provider,
  StateDto,
  TaskDetailDto,
  TaskDto,
  TaskStatus,
} from './types';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* keep status message */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const getState = () => api<StateDto>('/api/state');
export const getProjects = () => api<ProjectDto[]>('/api/projects');
export const getTasks = () => api<TaskDto[]>('/api/tasks');
export const getTaskDetail = (id: string) => api<TaskDetailDto>(`/api/tasks/${id}`);

export const patchTask = (id: string, patch: Record<string, unknown>) =>
  api<TaskDto>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const createTask = (body: { projectId: string; title: string; status?: TaskStatus }) =>
  api<TaskDto>('/api/tasks', { method: 'POST', body: JSON.stringify(body) });

export const createProject = (body: { path: string } | { name: string }) =>
  api<ProjectDto>('/api/projects', { method: 'POST', body: JSON.stringify(body) });

/** Mirrors the dispatcher's DispatchResult (returned in the burn response). */
export interface BurnResultDto {
  launched: number;
  results: Array<{ taskId: string; provider: string; outcome: string }>;
}

export const burnNow = (taskId?: string, provider?: Provider) =>
  api<{ ok: boolean; result: BurnResultDto | null }>('/api/burn', {
    method: 'POST',
    body: JSON.stringify({ taskId, provider }),
  });

export const setPausedApi = (paused: boolean) =>
  api<{ paused: boolean }>(`/api/${paused ? 'pause' : 'resume'}`, { method: 'POST' });

export const patchConfig = (patch: ConfigPatchDto) =>
  api<ConfigDto>('/api/config', { method: 'PATCH', body: JSON.stringify(patch) });
