import type {
  BoardServiceDto,
  ConfigDto,
  ConfigPatchDto,
  DiscoveredRepoDto,
  ProjectDto,
  ProjectPatchDto,
  Provider,
  StateDto,
  TaskDetailDto,
  TaskDto,
  TaskStatus,
} from './types';

/** Thrown when the surplus server itself is unreachable (process stopped). */
export class ServerUnreachableError extends Error {
  constructor() {
    super('Can’t reach surplus — is `surplus board` running?');
    this.name = 'ServerUnreachableError';
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  } catch {
    // fetch rejects (TypeError) only on network failure — server is gone.
    throw new ServerUnreachableError();
  }
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

export const getState = (fresh = false) =>
  api<StateDto>(fresh ? '/api/state?fresh=1' : '/api/state');
export const getProjects = () => api<ProjectDto[]>('/api/projects');
export const getTasks = () => api<TaskDto[]>('/api/tasks');
export const getTaskDetail = (id: string) => api<TaskDetailDto>(`/api/tasks/${id}`);

export const patchTask = (id: string, patch: Record<string, unknown>) =>
  api<TaskDto>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const createTask = (body: { projectId: string; title: string; status?: TaskStatus }) =>
  api<TaskDto>('/api/tasks', { method: 'POST', body: JSON.stringify(body) });

export const createProject = (body: { path: string } | { name: string }) =>
  api<ProjectDto>('/api/projects', { method: 'POST', body: JSON.stringify(body) });

export const getDiscover = () => api<DiscoveredRepoDto[]>('/api/discover');

export const getProjectVision = (id: string) =>
  api<{ markdown: string }>(`/api/projects/${id}/vision`);

export const putProjectVision = (id: string, markdown: string) =>
  api<{ ok: boolean }>(`/api/projects/${id}/vision`, {
    method: 'PUT',
    body: JSON.stringify({ markdown }),
  });

export const patchProject = (id: string, patch: ProjectPatchDto) =>
  api<ProjectDto>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteProject = (id: string) =>
  api<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' });

export const getBoardService = () => api<BoardServiceDto>('/api/board-service');

export const installBoardService = () =>
  api<{ installed: boolean }>('/api/board-service', { method: 'POST' });

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

export const setArmedApi = (armed: boolean) =>
  api<{ armed: boolean }>('/api/scheduler', { method: 'POST', body: JSON.stringify({ armed }) });

export const patchConfig = (patch: ConfigPatchDto) =>
  api<ConfigDto>('/api/config', { method: 'PATCH', body: JSON.stringify(patch) });
