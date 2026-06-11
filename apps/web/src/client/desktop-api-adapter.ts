import type {
  ElectronAPI,
  ExecutionProgress,
  ExecutionPhase,
  CreateProjectFolderResult,
  FileNode,
  GitBranchDetail,
  GitStatus,
  IPCResult,
  KanbanPreferences,
  Project,
  ProjectEnvConfig,
  ProjectDocumentType,
  ProjectSettings,
  PromptProfileRefreshResult,
  ReviewReason,
  TabState,
  Task,
  TaskLogs,
  TaskMetadata,
  TaskStartOptions,
  TaskStatus,
} from '../../../desktop/src/shared/types';
import type { ProviderAccount } from '../../../desktop/src/shared/types/provider-account';
import { DEFAULT_APP_SETTINGS, DEFAULT_PROJECT_SETTINGS } from '../../../desktop/src/shared/constants';
import type {
  CreateWebProjectFolderRequest,
  CreateWebTaskRequest,
  UpdateWebKanbanPreferencesRequest,
  UpdateWebProjectEnvRequest,
  UpdateWebProjectSettingsRequest,
  UpdateWebTaskRequest,
  UpdateWebTaskStatusRequest,
  WebApiErrorResponse,
  WebChangedFilesResponse,
  WebCodexAuthLoginResponse,
  WebCodexAuthStatusResponse,
  WebCodexCliVersionResponse,
  WebFileDiffRequest,
  WebFileDiffResponse,
  WebFilePathRequest,
  WebGitBranchResponse,
  WebGitBranchesResponse,
  WebGitBranchDetailsResponse,
  WebGitPathRequest,
  WebGitStatusResponse,
  WebKanbanPreferencesResponse,
  WebListDirectoryResponse,
  WebPathResponse,
  WebProjectEnvResponse,
  WebProjectFolderResponse,
  WebProjectSettingsResponse,
  WebProject,
  WebProjectListResponse,
  WebProjectResponse,
  WebPromptProfileResponse,
  WebReadFileResponse,
  WebReadImageFileResponse,
  WebRemoteProviderResponse,
  WebSelectDirectoryRequest,
  StartWebTaskRequest,
  WebTaskListResponse,
  WebTaskLogsResponse,
  WebTaskResponse,
  CreateWebTerminalRequest,
  WebTerminalEvent,
  WebTerminalInputRequest,
  WebTerminalResponse,
  WebWorkspaceStateResponse,
  WebWriteFileRequest,
} from '../shared/api';

const AUTOCODE_PROJECT_DATA_DIR_NAME = '.autocode';
const SERVICE_BASE_URL = (import.meta.env.VITE_AUTOCODE_SERVICE_URL ?? '').replace(/\/+$/, '');
const TAB_STATE_STORAGE_KEY = 'autocode-web-tab-state';
const APP_SETTINGS_STORAGE_KEY = 'autocode-web-app-settings';
const DEFAULT_PROJECT_ENV: ProjectEnvConfig = {
  linearEnabled: false,
  githubEnabled: false,
  gitlabEnabled: false,
  gitblitEnabled: false,
  memoryEnabled: false,
  enableFancyUi: true,
};
const EXECUTION_PHASES = new Set<ExecutionPhase>([
  'idle',
  'planning',
  'coding',
  'rate_limit_paused',
  'auth_failure_paused',
  'qa_review',
  'qa_fixing',
  'complete',
  'failed',
]);

type TaskStatusListener = (
  taskId: string,
  status: TaskStatus,
  projectId?: string,
  reviewReason?: ReviewReason,
) => void;
type TaskLogsChangedListener = (specId: string, logs: TaskLogs) => void;
type TaskExecutionProgressListener = (
  taskId: string,
  progress: ExecutionProgress,
  projectId?: string,
) => void;
type TerminalOutputListener = (id: string, data: string) => void;
type TerminalExitListener = (id: string, exitCode: number) => void;
type TerminalTitleListener = (id: string, title: string) => void;
interface TaskLogsWatcher {
  projectId: string;
  specId: string;
  intervalId?: number;
  lastSignature?: string | null;
  isPolling: boolean;
  refCount: number;
}

const taskStatusListeners = new Set<TaskStatusListener>();
const taskLogsChangedListeners = new Set<TaskLogsChangedListener>();
const taskExecutionProgressListeners = new Set<TaskExecutionProgressListener>();
const taskLogsWatchers = new Map<string, TaskLogsWatcher>();
const taskProjectIds = new Map<string, string>();
const terminalOutputListeners = new Set<TerminalOutputListener>();
const terminalExitListeners = new Set<TerminalExitListener>();
const terminalTitleListeners = new Set<TerminalTitleListener>();
let terminalEventSource: EventSource | null = null;

export function installWebDesktopApiAdapter(): void {
  const api = window.electronAPI;
  if (!api) {
    throw new Error('window.electronAPI must be initialized before installing the Web adapter.');
  }

  window.DEBUG = window.DEBUG ?? false;
  window.platform = window.platform ?? getBrowserPlatform();

  installProjectApi(api);
  installTaskApi(api);
  installTerminalApi(api);
  installSettingsApi(api);
}

function installProjectApi(api: ElectronAPI): void {
  api.getProjects = async () => withIpcResult(async () => {
    const response = await apiRequest<WebProjectListResponse>('/api/projects');
    return response.projects.map(toDesktopProject);
  });

  api.addProject = async (projectPath: string) => withIpcResult(async () => {
    const response = await apiRequest<WebProjectResponse>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: projectPath }),
    });
    return toDesktopProject(response.project);
  });

  api.removeProject = async (projectId: string) => withIpcResult(async () => {
    await apiRequest<{ removed: true }>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    });
  });

  api.updateProjectSettings = async (
    projectId: string,
    settings: Partial<ProjectSettings>,
  ) => withIpcResult(async () => {
    const body: UpdateWebProjectSettingsRequest = { settings };
    await apiRequest<WebProjectSettingsResponse>(`/api/projects/${encodeURIComponent(projectId)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  });

  api.initializeProject = async (projectId: string) => withIpcResult(async () => {
    await refreshPromptProfile(projectId);
    return {
      success: true,
      version: 'web',
      wasUpdate: false,
    };
  });

  api.initializeGraphDatabase = async () => ({
    success: true,
    data: { initialized: false },
  });

  api.checkProjectVersion = async () => ({
    success: true,
    data: {
      isInitialized: true,
      currentVersion: 'web',
      sourceVersion: 'web',
      updateAvailable: false,
    },
  });

  api.refreshProjectPrompts = async (projectId: string) => withIpcResult(async () => refreshPromptProfile(projectId));
  api.getProjectContext = async (projectId: string) => withIpcResult(async () => {
    const response = await apiRequest<WebWorkspaceStateResponse>(`/api/projects/${encodeURIComponent(projectId)}/workspace`);
    return {
      projectIndex: response.projectIndex,
      memoryStatus: {
        enabled: false,
        available: false,
        reason: 'Memory database is not enabled in Web local service yet.',
      },
      memoryState: null,
      recentMemories: [],
      isLoading: false,
    };
  });

  api.refreshProjectIndex = async (projectId: string) => withIpcResult(async () => {
    const response = await apiRequest<WebWorkspaceStateResponse>(`/api/projects/${encodeURIComponent(projectId)}/workspace`);
    if (!response.projectIndex) {
      throw new Error('Project index is not available.');
    }
    return response.projectIndex;
  });
  api.getMemoryStatus = async () => ({
    success: true,
    data: {
      enabled: false,
      available: false,
      reason: 'Memory database is not enabled in Web local service yet.',
    },
  });
  api.searchMemories = async () => ({ success: true, data: [] });
  api.getRecentMemories = async () => ({ success: true, data: [] });
  api.verifyMemory = async () => ({ success: true });
  api.pinMemory = async () => ({ success: true });
  api.deprecateMemory = async () => ({ success: true });
  api.deleteMemory = async () => ({ success: true });
  api.detectProjectRemoteProvider = async (projectPath: string) => withIpcResult(async () => {
    const body: WebGitPathRequest = { path: projectPath };
    const response = await apiRequest<WebRemoteProviderResponse>('/api/git/remote-provider', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.provider;
  });

  api.getTabState = async () => withIpcResult(async () => readTabState());
  api.saveTabState = async (tabState: TabState) => withIpcResult(async () => {
    localStorage.setItem(TAB_STATE_STORAGE_KEY, JSON.stringify(tabState));
  });

  api.getKanbanPreferences = async (projectId: string) => withIpcResult(async () => {
    const response = await apiRequest<WebKanbanPreferencesResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/kanban-preferences`,
    );
    return (response.preferences ?? null) as KanbanPreferences | null;
  });

  api.saveKanbanPreferences = async (projectId: string, preferences) => withIpcResult(async () => {
    const body: UpdateWebKanbanPreferencesRequest = { preferences };
    await apiRequest<WebKanbanPreferencesResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/kanban-preferences`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
    );
  });

  api.getProjectEnv = async (projectId: string) => withIpcResult(async () => {
    const response = await apiRequest<WebProjectEnvResponse>(`/api/projects/${encodeURIComponent(projectId)}/env`);
    return {
      ...DEFAULT_PROJECT_ENV,
      ...response.env,
    } as ProjectEnvConfig;
  });

  api.updateProjectEnv = async (projectId: string, config: Partial<ProjectEnvConfig>) => withIpcResult(async () => {
    const body: UpdateWebProjectEnvRequest = { env: config as Record<string, unknown> };
    await apiRequest<WebProjectEnvResponse>(`/api/projects/${encodeURIComponent(projectId)}/env`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  });

  api.getDefaultProjectLocation = async () => {
    const response = await apiRequest<WebPathResponse>('/api/dialog/default-project-location');
    return response.path;
  };

  api.selectDirectory = async () => {
    const defaultPath = await api.getDefaultProjectLocation();
    const body: WebSelectDirectoryRequest = {
      title: 'Select Project Directory',
      defaultPath: defaultPath ?? undefined,
    };
    const response = await apiRequest<WebPathResponse>('/api/dialog/select-directory', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.path;
  };

  api.createProjectFolder = async (
    location: string,
    name: string,
    initGit: boolean,
  ) => withIpcResult<CreateProjectFolderResult>(async () => {
    const body: CreateWebProjectFolderRequest = { location, name, initGit };
    return await apiRequest<WebProjectFolderResponse>('/api/dialog/create-project-folder', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  api.detectMainBranch = async (projectPath: string) => withIpcResult<string | null>(async () => {
    const body: WebGitPathRequest = { path: projectPath };
    const response = await apiRequest<WebGitBranchResponse>('/api/git/detect-main-branch', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.branch;
  });

  api.checkGitStatus = async (projectPath: string) => withIpcResult<GitStatus>(async () => {
    const body: WebGitPathRequest = { path: projectPath };
    const response = await apiRequest<WebGitStatusResponse>('/api/git/status', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.status;
  });

  api.getGitBranches = async (projectPath: string) => withIpcResult<string[]>(async () => {
    const body: WebGitPathRequest = { path: projectPath };
    const response = await apiRequest<WebGitBranchesResponse>('/api/git/branches', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.branches;
  });

  api.getGitBranchesWithInfo = async (projectPath: string) => withIpcResult<GitBranchDetail[]>(async () => {
    const body: WebGitPathRequest = { path: projectPath };
    const response = await apiRequest<WebGitBranchDetailsResponse>('/api/git/branches-with-info', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.branches;
  });

  api.getCurrentGitBranch = async (projectPath: string) => withIpcResult<string | null>(async () => {
    const body: WebGitPathRequest = { path: projectPath };
    const response = await apiRequest<WebGitBranchResponse>('/api/git/current-branch', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.branch;
  });

  api.initializeGit = async (projectPath: string) => {
    const body: WebGitPathRequest = { path: projectPath };
    return await apiRequest<IPCResult<{ success: boolean }>>('/api/git/initialize', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  };

  api.listDirectory = async (dirPath: string) => withIpcResult<FileNode[]>(async () => {
    const body: WebFilePathRequest = { path: dirPath };
    const response = await apiRequest<WebListDirectoryResponse>('/api/files/list', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.files;
  });

  api.readFile = async (filePath: string) => withIpcResult<string>(async () => {
    const body: WebFilePathRequest = { path: filePath };
    const response = await apiRequest<WebReadFileResponse>('/api/files/read', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.content;
  });

  api.readImageFile = async (filePath: string) => withIpcResult(async () => {
    const body: WebFilePathRequest = { path: filePath };
    return await apiRequest<WebReadImageFileResponse>('/api/files/read-image', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  api.writeFile = async (filePath: string, content: string) => withIpcResult(async () => {
    const body: WebWriteFileRequest = { path: filePath, content };
    await apiRequest<{ written: true }>('/api/files/write', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  api.getChangedFiles = async (projectPath: string) => withIpcResult<string[]>(async () => {
    const body: WebGitPathRequest = { path: projectPath };
    const response = await apiRequest<WebChangedFilesResponse>('/api/files/changed', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.files;
  });

  api.getFileDiff = async (projectPath: string, filePath: string) => withIpcResult<string>(async () => {
    const body: WebFileDiffRequest = { projectPath, filePath };
    const response = await apiRequest<WebFileDiffResponse>('/api/files/diff', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.diff;
  });

  api.showItemInFolder = async (filePath: string) => withIpcResult(async () => {
    const body: WebFilePathRequest = { path: filePath };
    await apiRequest<{ opened: true }>('/api/files/show-item', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  api.getPathForFile = () => '';
}

function installTaskApi(api: ElectronAPI): void {
  api.getTasks = async (projectId: string) => withIpcResult(async () => {
    const response = await apiRequest<WebTaskListResponse>(`/api/projects/${encodeURIComponent(projectId)}/tasks`);
    return response.tasks.map((task) => toDesktopTask(projectId, task));
  });

  api.createTask = async (
    projectId: string,
    title: string,
    description: string,
    metadata?: TaskMetadata,
  ) => withIpcResult(async () => {
    const response = await apiRequest<WebTaskResponse>(`/api/projects/${encodeURIComponent(projectId)}/tasks`, {
      method: 'POST',
      body: JSON.stringify(toCreateTaskRequest(title, description, metadata)),
    });
    return toDesktopTask(projectId, response.task);
  });

  api.createProjectDocumentationTask = async (
    projectId: string,
    options: { documentType?: ProjectDocumentType; outputDir?: string } = {},
  ) => withIpcResult(async () => {
    const documentType = options.documentType ?? 'full';
    const response = await apiRequest<WebTaskResponse>(`/api/projects/${encodeURIComponent(projectId)}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Generate project documentation',
        description: `Generate ${documentType} project documentation for this repository.`,
        developmentMode: 'standard',
        category: 'documentation',
        priority: 'medium',
        projectDocumentType: documentType,
        projectDocumentOutputDir: options.outputDir,
      }),
    });
    return toDesktopTask(projectId, response.task);
  });

  api.updateTask = async (
    taskId: string,
    updates: { title?: string; description?: string; metadata?: Partial<TaskMetadata> },
  ) => withIpcResult(async () => {
    const projectId = findProjectIdForTask(taskId);
    if (!projectId) throw new Error('projectId is required when updating a Web task.');
    const body: UpdateWebTaskRequest = {
      title: updates.title,
      description: updates.description,
      metadata: updates.metadata as Record<string, unknown> | undefined,
    };
    const response = await apiRequest<WebTaskResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    );
    return toDesktopTask(projectId, response.task);
  });

  api.deleteTask = async (taskId: string) => withIpcResult(async () => {
    const projectId = findProjectIdForTask(taskId);
    if (!projectId) throw new Error('projectId is required when deleting a Web task.');
    await apiRequest<{ deleted: true }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: 'DELETE' },
    );
  });

  api.deleteSubtask = async (
    taskId: string,
    subtaskId: string,
    projectId?: string,
  ) => withIpcResult(async () => {
    const resolvedProjectId = projectId ?? findProjectIdForTask(taskId);
    if (!resolvedProjectId) throw new Error('projectId is required when deleting a Web subtask.');
    const response = await apiRequest<WebTaskResponse>(
      `/api/projects/${encodeURIComponent(resolvedProjectId)}/tasks/${encodeURIComponent(taskId)}/subtasks/${encodeURIComponent(subtaskId)}`,
      { method: 'DELETE' },
    );
    return toDesktopTask(resolvedProjectId, response.task);
  });

  api.getTaskLogs = async (projectId: string, specId: string) => withIpcResult(async () => (
    await loadTaskLogs(projectId, specId)
  ));

  api.clearTaskLogs = async (projectId: string, specId: string) => withIpcResult(async () => {
    const response = await apiRequest<WebTaskLogsResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(specId)}/logs`,
      { method: 'DELETE' },
    );
    if (!response.logs) {
      throw new Error('Failed to clear task logs.');
    }
    const logs = response.logs as TaskLogs;
    emitTaskLogsChanged(response.task.specId, logs);
    return logs;
  });

  api.watchTaskLogs = async (projectId: string, specId: string) => withIpcResult(async () => {
    startTaskLogsWatcher(projectId, specId);
  });

  api.unwatchTaskLogs = async (specId: string) => withIpcResult(async () => {
    stopTaskLogsWatcher(specId);
  });

  api.onTaskLogsChanged = (callback: TaskLogsChangedListener) => {
    taskLogsChangedListeners.add(callback);
    return () => taskLogsChangedListeners.delete(callback);
  };

  api.onTaskLogsStream = () => () => {};

  api.updateTaskStatus = async (
    taskId: string,
    status: TaskStatus,
    options?: { forceCleanup?: boolean; keepWorktree?: boolean; projectId?: string },
  ) => withIpcResult(async () => {
    if (!options?.projectId) {
      throw new Error('projectId is required when updating a Web task status.');
    }

    await updateTaskStatus(options.projectId, taskId, status);
    return {};
  });

  api.checkTaskRunning = async (taskId: string, projectId?: string) => withIpcResult(async () => {
    const resolvedProjectId = projectId ?? findProjectIdForTask(taskId);
    if (!resolvedProjectId) {
      return false;
    }

    return false;
  });
  api.resumePausedTask = async (taskId: string, projectId?: string) => withIpcResult(async () => {
    await startOrResumeTaskRuntime(taskId, projectId);
  });
  api.improveDescription = async (payload: { description: string; title?: string }) => ({
    success: true,
    data: {
      improved: payload.description,
      original: payload.description,
    },
  });

  api.archiveTasks = async (projectId: string, taskIds: string[], version?: string) => withIpcResult(async () => {
    for (const taskId of taskIds) {
      const task = await updateTaskStatus(projectId, taskId, 'done');
      await api.updateTask(task.id, {
        metadata: {
          ...(task.metadata ?? {}),
          archivedAt: new Date().toISOString(),
          archivedInVersion: version,
        },
      });
    }
    return true;
  });

  api.unarchiveTasks = async (projectId: string, taskIds: string[]) => withIpcResult(async () => {
    for (const taskId of taskIds) {
      const task = await updateTaskStatus(projectId, taskId, 'done');
      await api.updateTask(task.id, {
        metadata: {
          ...(task.metadata ?? {}),
          archivedAt: undefined,
          archivedInVersion: undefined,
        },
      });
    }
    return true;
  });

  api.startTask = (taskId: string, options?: TaskStartOptions) => {
    void startOrResumeTaskRuntime(taskId, options?.projectId).catch((error) => {
      console.warn('[WebDesktopApiAdapter] Failed to start task:', error);
    });
  };

  api.stopTask = (taskId: string, projectId?: string) => {
    if (!projectId) return;

    emitTaskStatus(taskId, 'human_review', projectId, 'stopped');
    void stopTaskRuntime(projectId, taskId)
      .then((task) => {
        emitTaskStatus(task.id, task.status, projectId, task.reviewReason);
        if (task.executionProgress) {
          emitTaskExecutionProgress(task.id, task.executionProgress, projectId);
        }
        if (task.specId !== task.id) {
          emitTaskStatus(task.specId, task.status, projectId, task.reviewReason);
          if (task.executionProgress) {
            emitTaskExecutionProgress(task.specId, task.executionProgress, projectId);
          }
        }
      })
      .catch((error) => {
        console.warn('[WebDesktopApiAdapter] Failed to stop task:', error);
        emitTaskStatus(taskId, 'error', projectId);
      });
  };

  api.submitReview = async (
    taskId: string,
    approved: boolean,
    _feedback?: string,
    _images?: unknown[],
    projectId?: string,
  ) => withIpcResult(async () => {
    if (!projectId) {
      throw new Error('projectId is required when submitting a Web task review.');
    }

    const nextStatus: TaskStatus = approved ? 'done' : 'human_review';
    const reviewReason: ReviewReason | undefined = approved ? undefined : 'qa_rejected';
    await updateTaskStatus(projectId, taskId, nextStatus, reviewReason, approved ? 'complete' : 'qa_review');
    emitTaskStatus(taskId, nextStatus, projectId, reviewReason);
  });

  api.recoverStuckTask = async (taskId: string, options) => withIpcResult(async () => {
    const projectId = options?.projectId;
    const nextStatus = options?.targetStatus ?? 'backlog';
    if (projectId) {
      await updateTaskStatus(projectId, taskId, nextStatus);
      emitTaskStatus(taskId, nextStatus, projectId);
    }

    return {
      taskId,
      recovered: true,
      newStatus: nextStatus,
      message: 'Task status recovered in Web local service.',
      autoRestarted: false,
    };
  });

  api.onTaskStatusChange = (callback: TaskStatusListener) => {
    taskStatusListeners.add(callback);
    return () => taskStatusListeners.delete(callback);
  };

  api.onTaskProgress = () => () => {};
  api.onTaskError = () => () => {};
  api.onTaskLog = () => () => {};
  api.onTaskExecutionProgress = (callback: TaskExecutionProgressListener) => {
    taskExecutionProgressListeners.add(callback);
    return () => taskExecutionProgressListeners.delete(callback);
  };
  api.onTaskTokenUsage = () => () => {};
}

function installTerminalApi(api: ElectronAPI): void {
  api.createTerminal = async (options) => withIpcResult(async () => {
    ensureTerminalEventSource();
    const body: CreateWebTerminalRequest = {
      id: options.id,
      cwd: options.cwd,
      projectPath: options.projectPath,
      cols: options.cols,
      rows: options.rows,
    };
    await apiRequest<WebTerminalResponse>('/api/terminals', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  api.destroyTerminal = async (id: string) => withIpcResult(async () => {
    await apiRequest<{ destroyed: true }>(`/api/terminals/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  });

  api.sendTerminalInput = (id: string, data: string) => {
    const body: WebTerminalInputRequest = { data };
    void apiRequest<{ written: true }>(`/api/terminals/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).catch((error) => {
      console.warn('[WebDesktopApiAdapter] Failed to send terminal input:', error);
    });
  };

  api.resizeTerminal = async () => ({ success: true, data: { success: true } });
  api.invokeCLIInTerminal = (id: string, cwd?: string, cli?: string) => {
    const command = cli && cli !== 'system' ? `${cli}\r` : '';
    if (cwd) api.sendTerminalInput(id, `cd /d \"${cwd}\"\r`);
    if (command) api.sendTerminalInput(id, command);
  };
  api.generateTerminalName = async (_command: string, cwd?: string) => ({
    success: true,
    data: cwd ? `Shell: ${cwd.split(/[\\/]/).pop() || cwd}` : 'Web Shell',
  });
  api.setTerminalTitle = () => {};
  api.setTerminalWorktreeConfig = () => {};
  api.getTerminalSessions = async () => ({ success: true, data: [] });
  api.restoreTerminalSession = async (session, cols, rows) => withIpcResult(async () => {
    const createResult = await api.createTerminal({
      id: session.id,
      cwd: session.cwd,
      projectPath: session.projectPath,
      cols,
      rows,
    });
    if (!createResult.success) {
      return {
        success: false,
        terminalId: session.id,
        error: createResult.error,
      };
    }
    return {
      success: true,
      terminalId: session.id,
    };
  });
  api.clearTerminalSessions = async () => ({ success: true });
  api.resumeClaudeInTerminal = () => {};
  api.activateDeferredClaudeResume = () => {};
  api.getTerminalSessionDates = async () => ({ success: true, data: [] });
  api.getTerminalSessionsForDate = async () => ({ success: true, data: [] });
  api.restoreTerminalSessionsFromDate = async () => ({
    success: true,
    data: { restored: 0, failed: 0, sessions: [] },
  });
  api.getNativeCliHistory = async () => ({ success: true, data: [] });
  api.resumeNativeCliSession = async () => ({ success: true, data: {} });
  api.saveTerminalBuffer = async () => {};
  api.checkTerminalPtyAlive = async () => ({ success: true, data: { alive: false } });
  api.updateTerminalDisplayOrders = async () => ({ success: true });

  api.onTerminalOutput = (callback: TerminalOutputListener) => {
    ensureTerminalEventSource();
    terminalOutputListeners.add(callback);
    return () => terminalOutputListeners.delete(callback);
  };
  api.onTerminalExit = (callback: TerminalExitListener) => {
    ensureTerminalEventSource();
    terminalExitListeners.add(callback);
    return () => terminalExitListeners.delete(callback);
  };
  api.onTerminalTitleChange = (callback: TerminalTitleListener) => {
    ensureTerminalEventSource();
    terminalTitleListeners.add(callback);
    return () => terminalTitleListeners.delete(callback);
  };
  api.onTerminalWorktreeConfigChange = () => () => {};
  api.onTerminalClaudeSession = () => () => {};
  api.onTerminalRateLimit = () => () => {};
  api.onTerminalOAuthToken = () => () => {};
  api.onTerminalAuthCreated = () => () => {};
  api.onTerminalClaudeBusy = () => () => {};
  api.onTerminalClaudeExit = () => () => {};
  api.onTerminalPendingResume = () => () => {};
  api.onTerminalProfileChanged = () => () => {};
  api.onTerminalOAuthCodeNeeded = () => () => {};
  api.submitOAuthCode = async () => ({ success: true });
}

function installSettingsApi(api: ElectronAPI): void {
  api.getSettings = async () => withIpcResult(async () => {
    const storedSettings = readStoredAppSettings();
    return {
      ...DEFAULT_APP_SETTINGS,
      autoBuildPath: AUTOCODE_PROJECT_DATA_DIR_NAME,
      onboardingCompleted: true,
      ...storedSettings,
    };
  });

  api.saveSettings = async (updates) => withIpcResult(async () => {
    const current = {
      ...DEFAULT_APP_SETTINGS,
      autoBuildPath: AUTOCODE_PROJECT_DATA_DIR_NAME,
      onboardingCompleted: true,
      ...readStoredAppSettings(),
    };
    writeStoredAppSettings({ ...current, ...updates });
  });

  api.openExternal = async (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  api.checkCodexCliVersion = async () => withIpcResult(async () => {
    const response = await apiRequest<WebCodexCliVersionResponse>('/api/cli/codex/version');
    return response.info;
  });

  api.codexAuthLogin = async () => withIpcResult(async () => {
    const response = await apiRequest<WebCodexAuthLoginResponse>('/api/auth/codex/login', { method: 'POST' });
    return response.auth;
  });

  api.codexAuthStatus = async () => withIpcResult(async () => {
    const response = await apiRequest<WebCodexAuthStatusResponse>('/api/auth/codex/status');
    return response.auth;
  });

  api.codexAuthLogout = async () => withIpcResult(async () => {
    await apiRequest<{ loggedOut: true }>('/api/auth/codex/logout', { method: 'POST' });
  });

  api.getProviderAccounts = async () => withIpcResult(async () => ({
    accounts: readProviderAccounts(),
  }));

  api.saveProviderAccount = async (account) => withIpcResult(async () => {
    const settings = readStoredAppSettings();
    const accounts = readProviderAccountsFromSettings(settings);
    const duplicate = findDuplicateProviderAccount(accounts, account);
    if (duplicate) {
      throw new Error(`DUPLICATE_EMAIL:${duplicate.name}`);
    }

    const now = Date.now();
    const newAccount: ProviderAccount = {
      ...account,
      id: createProviderAccountId(),
      createdAt: now,
      updatedAt: now,
    };
    const nextAccounts = [...accounts, newAccount];
    writeStoredAppSettings({
      ...settings,
      providerAccounts: nextAccounts,
      globalPriorityOrder: [newAccount.id, ...readStringArray(settings.globalPriorityOrder)],
      crossProviderPriorityOrder: Array.isArray(settings.crossProviderPriorityOrder)
        ? [newAccount.id, ...readStringArray(settings.crossProviderPriorityOrder)]
        : undefined,
    });
    return newAccount;
  });

  api.updateProviderAccount = async (id, updates) => withIpcResult(async () => {
    const settings = readStoredAppSettings();
    const accounts = readProviderAccountsFromSettings(settings);
    const index = accounts.findIndex((account) => account.id === id);
    if (index < 0) {
      throw new Error(`Account not found: ${id}`);
    }

    const updatedAccount: ProviderAccount = {
      ...accounts[index],
      ...updates,
      id,
      createdAt: accounts[index].createdAt,
      updatedAt: Date.now(),
    };
    const nextAccounts = [...accounts];
    nextAccounts[index] = updatedAccount;
    writeStoredAppSettings({
      ...settings,
      providerAccounts: nextAccounts,
    });
    return updatedAccount;
  });

  api.deleteProviderAccount = async (id) => withIpcResult(async () => {
    const settings = readStoredAppSettings();
    const accounts = readProviderAccountsFromSettings(settings);
    const nextAccounts = accounts.filter((account) => account.id !== id);
    if (nextAccounts.length === accounts.length) {
      throw new Error(`Account not found: ${id}`);
    }

    writeStoredAppSettings({
      ...settings,
      providerAccounts: nextAccounts,
      globalPriorityOrder: readStringArray(settings.globalPriorityOrder).filter((accountId) => accountId !== id),
      crossProviderPriorityOrder: readStringArray(settings.crossProviderPriorityOrder).filter((accountId) => accountId !== id),
    });
  });

  api.setProviderAccountQueueOrder = async (order) => withIpcResult(async () => {
    writeStoredAppSettings({
      ...readStoredAppSettings(),
      globalPriorityOrder: order,
    });
  });

  api.setCrossProviderQueueOrder = async (order) => withIpcResult(async () => {
    writeStoredAppSettings({
      ...readStoredAppSettings(),
      crossProviderPriorityOrder: order,
    });
  });

  api.saveModelOverrides = async (overrides) => withIpcResult(async () => {
    writeStoredAppSettings({
      ...readStoredAppSettings(),
      modelOverrides: overrides,
    });
  });

  api.testConnection = async () => ({
    success: true,
    data: {
      success: true,
      message: 'Connection checks run through the Web local service.',
    },
  });

  api.checkEnvCredentials = async () => ({
    success: true,
    data: {},
  });
}

async function refreshPromptProfile(projectId: string): Promise<PromptProfileRefreshResult> {
  const response = await apiRequest<WebPromptProfileResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/prompt-profile`,
    { method: 'POST' },
  );
  const { profile } = response;

  return {
    updatedAt: response.project.promptProfileUpdatedAt ?? profile.generatedAt,
    projectSize: profile.project.size,
    promptIntensity: profile.workflow.promptIntensity,
    specStyle: profile.workflow.specStyle,
    sourceFileCount: profile.project.sourceFileCount,
    generatedPrompts: profile.promptOverrides.generated,
    languages: profile.project.languages,
    frameworks: profile.project.frameworks,
  };
}

async function updateTaskStatus(
  projectId: string,
  taskId: string,
  status: TaskStatus,
  reviewReason?: ReviewReason,
  executionPhase?: ExecutionPhase | string,
): Promise<Task> {
  const body: UpdateWebTaskStatusRequest = {
    status,
    reviewReason,
    executionPhase,
  };
  const response = await apiRequest<WebTaskResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/status`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    },
  );
  return toDesktopTask(projectId, response.task);
}

async function startTaskRuntime(projectId: string, taskId: string): Promise<Task> {
  const settings = readStoredAppSettings();
  const task = await findTaskForStart(projectId, taskId);
  const body: StartWebTaskRequest = {
    cli: normalizePreferredCli(settings.preferredCLI),
    ...(typeof settings.customCLIPath === 'string' && settings.customCLIPath.trim()
      ? { customCommand: settings.customCLIPath.trim() }
      : {}),
    ...(typeof task?.metadata?.model === 'string' && task.metadata.model.trim()
      ? { model: task.metadata.model.trim() }
      : {}),
    ...(typeof settings.dangerouslySkipPermissions === 'boolean'
      ? { bypassPermissions: settings.dangerouslySkipPermissions }
      : {}),
    ...(typeof settings.language === 'string' && settings.language.trim()
      ? { language: settings.language.trim() }
      : typeof task?.metadata?.language === 'string' && task.metadata.language.trim()
        ? { language: task.metadata.language.trim() }
      : {}),
  };
  const response = await apiRequest<WebTaskResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/start`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
  return toDesktopTask(projectId, response.task);
}

async function findTaskForStart(projectId: string, taskId: string): Promise<Task | undefined> {
  try {
    const response = await apiRequest<WebTaskListResponse>(`/api/projects/${encodeURIComponent(projectId)}/tasks`);
    return response.tasks
      .map((task) => toDesktopTask(projectId, task))
      .find((task) => task.id === taskId || task.specId === taskId);
  } catch {
    return undefined;
  }
}

async function startOrResumeTaskRuntime(taskId: string, projectId?: string): Promise<Task> {
  const resolvedProjectId = projectId ?? findProjectIdForTask(taskId);
  if (!resolvedProjectId) {
    throw new Error('projectId is required when starting a Web task.');
  }

  emitTaskStatus(taskId, 'in_progress', resolvedProjectId);

  try {
    const task = await startTaskRuntime(resolvedProjectId, taskId);
    emitTaskStatus(task.id, task.status, resolvedProjectId, task.reviewReason);
    if (task.executionProgress) {
      emitTaskExecutionProgress(task.id, task.executionProgress, resolvedProjectId);
    }
    if (task.specId !== task.id) {
      emitTaskStatus(task.specId, task.status, resolvedProjectId, task.reviewReason);
      if (task.executionProgress) {
        emitTaskExecutionProgress(task.specId, task.executionProgress, resolvedProjectId);
      }
    }
    return task;
  } catch (error) {
    emitTaskStatus(taskId, 'error', resolvedProjectId, 'errors');
    throw error;
  }
}

async function stopTaskRuntime(projectId: string, taskId: string): Promise<Task> {
  const response = await apiRequest<WebTaskResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/stop`,
    {
      method: 'POST',
    },
  );
  return toDesktopTask(projectId, response.task);
}

async function loadTaskLogs(projectId: string, specId: string): Promise<TaskLogs | null> {
  const response = await apiRequest<WebTaskLogsResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(specId)}/logs`,
  );
  return response.logs as TaskLogs | null;
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${SERVICE_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('autocode-web-auth-expired'));
    }
    let details = response.statusText;
    try {
      const errorBody = await response.json() as WebApiErrorResponse;
      details = errorBody.details ?? errorBody.error ?? details;
    } catch {
      details = await response.text();
    }
    throw new Error(details || `HTTP ${response.status}`);
  }

  return await response.json() as T;
}

async function withIpcResult<T>(operation: () => Promise<T>): Promise<IPCResult<T>> {
  try {
    const data = await operation();
    return data === undefined
      ? { success: true }
      : { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function toDesktopProject(project: WebProject): Project {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    autoBuildPath: AUTOCODE_PROJECT_DATA_DIR_NAME,
    settings: {
      ...DEFAULT_PROJECT_SETTINGS,
      ...(project.settings ?? {}),
    } as ProjectSettings,
    createdAt: new Date(project.addedAt),
    updatedAt: new Date(project.updatedAt),
  };
}

function toDesktopTask(projectId: string, task: WebTaskResponse['task'] | WebTaskListResponse['tasks'][number]): Task {
  const desktopTask: Task = {
    id: task.id,
    specId: task.specId,
    projectId,
    title: task.title,
    description: task.description,
    status: task.status as TaskStatus,
    reviewReason: task.reviewReason as ReviewReason | undefined,
    subtasks: task.subtasks,
    logs: [],
    metadata: task.metadata as TaskMetadata | undefined,
    specsPath: task.specsPath,
    executionProgress: task.executionPhase
      ? {
          phase: normalizeExecutionPhase(task.executionPhase),
          phaseProgress: 0,
          overallProgress: 0,
        }
      : undefined,
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
  };
  taskProjectIds.set(desktopTask.id, projectId);
  taskProjectIds.set(desktopTask.specId, projectId);
  return desktopTask;
}

function toCreateTaskRequest(
  title: string,
  description: string,
  metadata?: TaskMetadata,
): CreateWebTaskRequest {
  return {
    title,
    description,
    developmentMode: normalizeDevelopmentMode(metadata?.developmentMode),
    category: metadata?.category,
    complexity: metadata?.complexity,
    impact: metadata?.impact,
    priority: metadata?.priority,
    model: metadata?.model,
    provider: metadata?.provider,
    thinkingLevel: metadata?.thinkingLevel,
    language: metadata?.language,
    useWorktree: metadata?.useWorktree,
    pushNewBranches: metadata?.pushNewBranches,
  };
}

function normalizeDevelopmentMode(value: TaskMetadata['developmentMode'] | undefined): CreateWebTaskRequest['developmentMode'] {
  if (value === 'direct' || value === 'standard' || value === 'spec') return value;
  return 'direct';
}

function normalizePreferredCli(value: unknown): StartWebTaskRequest['cli'] {
  if (
    value === 'claude-code'
    || value === 'gemini'
    || value === 'opencode'
    || value === 'kilocode'
    || value === 'codex'
    || value === 'deepseek'
    || value === 'custom'
  ) {
    return value;
  }
  return 'codex';
}

function normalizeExecutionPhase(value: string): ExecutionPhase {
  if (EXECUTION_PHASES.has(value as ExecutionPhase)) return value as ExecutionPhase;
  if (value === 'review') return 'qa_review';
  if (value === 'complete') return 'complete';
  if (value === 'failed') return 'failed';
  if (value === 'stopped') return 'idle';
  return 'idle';
}

function readTabState(): TabState {
  const parsed = readJsonRecord(TAB_STATE_STORAGE_KEY);
  return {
    openProjectIds: Array.isArray(parsed.openProjectIds) ? parsed.openProjectIds.filter(isString) : [],
    activeProjectId: typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : null,
    tabOrder: Array.isArray(parsed.tabOrder) ? parsed.tabOrder.filter(isString) : [],
  };
}

function readJsonRecord(storageKey: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readStoredAppSettings(): Record<string, unknown> {
  return readJsonRecord(APP_SETTINGS_STORAGE_KEY);
}

function writeStoredAppSettings(settings: Record<string, unknown>): void {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function readProviderAccounts(): ProviderAccount[] {
  return readProviderAccountsFromSettings(readStoredAppSettings());
}

function readProviderAccountsFromSettings(settings: Record<string, unknown>): ProviderAccount[] {
  return Array.isArray(settings.providerAccounts)
    ? settings.providerAccounts.filter(isProviderAccount)
    : [];
}

function findDuplicateProviderAccount(
  accounts: ProviderAccount[],
  account: Omit<ProviderAccount, 'id' | 'createdAt' | 'updatedAt'>,
): ProviderAccount | undefined {
  if (!account.email) return undefined;
  return accounts.find((candidate) =>
    candidate.provider === account.provider
    && candidate.email?.toLowerCase() === account.email?.toLowerCase()
  );
}

function createProviderAccountId(): string {
  return `pa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isProviderAccount(value: unknown): value is ProviderAccount {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as ProviderAccount).id === 'string'
    && typeof (value as ProviderAccount).provider === 'string'
    && typeof (value as ProviderAccount).name === 'string'
    && typeof (value as ProviderAccount).authType === 'string'
    && typeof (value as ProviderAccount).billingModel === 'string'
    && typeof (value as ProviderAccount).createdAt === 'number'
    && typeof (value as ProviderAccount).updatedAt === 'number',
  );
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function emitTaskStatus(
  taskId: string,
  status: TaskStatus,
  projectId?: string,
  reviewReason?: ReviewReason,
): void {
  for (const listener of taskStatusListeners) {
    listener(taskId, status, projectId, reviewReason);
  }
}

function emitTaskExecutionProgress(
  taskId: string,
  progress: ExecutionProgress,
  projectId?: string,
): void {
  for (const listener of taskExecutionProgressListeners) {
    listener(taskId, progress, projectId);
  }
}

function emitTaskLogsChanged(specId: string, logs: TaskLogs): void {
  for (const listener of taskLogsChangedListeners) {
    listener(specId, logs);
  }
}

function startTaskLogsWatcher(projectId: string, specId: string): void {
  const existingWatcher = taskLogsWatchers.get(specId);
  if (existingWatcher) {
    existingWatcher.projectId = projectId;
    existingWatcher.refCount += 1;
    return;
  }

  const watcher: TaskLogsWatcher = {
    projectId,
    specId,
    isPolling: false,
    refCount: 1,
  };

  const poll = async () => {
    const currentWatcher = taskLogsWatchers.get(specId);
    if (currentWatcher !== watcher || watcher.isPolling) return;

    watcher.isPolling = true;
    try {
      const logs = await loadTaskLogs(watcher.projectId, watcher.specId);
      const signature = getTaskLogsSignature(logs);
      if (logs && signature !== watcher.lastSignature) {
        emitTaskLogsChanged(watcher.specId, logs);
      }
      watcher.lastSignature = signature;
    } catch (error) {
      console.warn('[WebDesktopApiAdapter] Failed to poll task logs:', error);
    } finally {
      watcher.isPolling = false;
    }
  };

  watcher.intervalId = window.setInterval(poll, 1500);
  taskLogsWatchers.set(specId, watcher);
  void poll();
}

function stopTaskLogsWatcher(specId: string): void {
  const watcher = taskLogsWatchers.get(specId);
  if (!watcher) return;
  watcher.refCount -= 1;
  if (watcher.refCount > 0) return;

  if (watcher.intervalId !== undefined) {
    window.clearInterval(watcher.intervalId);
  }
  taskLogsWatchers.delete(specId);
}

function getTaskLogsSignature(logs: TaskLogs | null): string | null {
  if (!logs) return null;
  const phases = ['planning', 'coding', 'validation'] as const;
  return JSON.stringify({
    updatedAt: logs.updated_at,
    phases: phases.map((phase) => ({
      phase,
      status: logs.phases[phase]?.status,
      startedAt: logs.phases[phase]?.started_at,
      completedAt: logs.phases[phase]?.completed_at,
      entryCount: logs.phases[phase]?.entries?.length ?? 0,
    })),
  });
}

function findProjectIdForTask(taskId: string): string | undefined {
  return taskProjectIds.get(taskId);
}

function ensureTerminalEventSource(): void {
  if (terminalEventSource) return;

  terminalEventSource = new EventSource(`${SERVICE_BASE_URL}/api/terminals/events`, { withCredentials: true });
  terminalEventSource.onmessage = (event) => {
    let payload: WebTerminalEvent;
    try {
      payload = JSON.parse(event.data) as WebTerminalEvent;
    } catch {
      return;
    }

    if (payload.type === 'output' && typeof payload.data === 'string') {
      for (const listener of terminalOutputListeners) listener(payload.id, payload.data);
      return;
    }

    if (payload.type === 'exit') {
      for (const listener of terminalExitListeners) listener(payload.id, payload.exitCode ?? 0);
      return;
    }

    if (payload.type === 'title' && typeof payload.title === 'string') {
      for (const listener of terminalTitleListeners) listener(payload.id, payload.title);
    }
  };
  terminalEventSource.onerror = () => {
    terminalEventSource?.close();
    terminalEventSource = null;
  };
}

function getBrowserPlatform() {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  const isWindows = platform.includes('win') || userAgent.includes('windows');
  const isMacOS = platform.includes('mac');
  const isLinux = platform.includes('linux');

  return {
    isWindows,
    isMacOS,
    isLinux,
    isUnix: !isWindows,
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
