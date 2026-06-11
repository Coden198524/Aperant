import type {
  AutocodeProjectPromptProfile,
  AutocodeTask,
  AutocodeTaskCategory,
  AutocodeTaskComplexity,
  AutocodeTaskDevelopmentMode,
  AutocodeExecutionPhase,
  AutocodeTaskLogs,
  AutocodeTaskImpact,
  AutocodeTaskPriority,
  AutocodeTaskStatus,
  AutocodeReviewReason,
  AutocodeCli,
  ProjectIndex,
  WorkspaceSummary,
} from '@autocode/core';

export interface WebHealthResponse {
  ok: true;
  service: 'autocode-web-local-service';
  version: string;
  startedAt: string;
  dataDir: string;
}

export interface WebToolDetectionResult {
  found: boolean;
  path?: string;
  version?: string;
  source: 'user-config' | 'venv' | 'homebrew' | 'nvm' | 'system-path' | 'bundled' | 'fallback';
  message: string;
}

export interface WebCodexCliVersionInfo {
  installed: string | null;
  path?: string;
  detectionResult: WebToolDetectionResult;
}

export interface WebCodexCliVersionResponse {
  info: WebCodexCliVersionInfo;
}

export interface WebCodexAuthResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email?: string;
}

export interface WebCodexAuthState {
  isAuthenticated: boolean;
  expiresAt?: number;
}

export interface WebCodexAuthLoginResponse {
  auth: WebCodexAuthResult;
}

export interface WebCodexAuthStatusResponse {
  auth: WebCodexAuthState;
}

export interface WebPlatformAccount {
  id: string;
  username: string;
  createdAt: string;
  lastLoginAt?: string;
}

export interface WebPlatformAuthStatus {
  configured: boolean;
  authenticated: boolean;
  account?: WebPlatformAccount;
}

export interface WebPlatformAuthStatusResponse {
  auth: WebPlatformAuthStatus;
}

export interface WebPlatformAuthSetupRequest {
  username: string;
  password: string;
}

export interface WebPlatformAuthLoginRequest {
  username: string;
  password: string;
}

export interface WebPlatformAuthResponse {
  auth: WebPlatformAuthStatus;
}

export interface WebProject {
  id: string;
  name: string;
  path: string;
  addedAt: string;
  updatedAt: string;
  settings?: Record<string, unknown>;
  env?: Record<string, unknown>;
  kanbanPreferences?: unknown;
  promptProfile?: AutocodeProjectPromptProfile;
  promptProfilePath?: string;
  promptProfileUpdatedAt?: string;
}

export interface WebProjectListResponse {
  projects: WebProject[];
}

export interface AddWebProjectRequest {
  path: string;
}

export interface WebProjectResponse {
  project: WebProject;
}

export interface UpdateWebProjectSettingsRequest {
  settings: Record<string, unknown>;
}

export interface WebProjectSettingsResponse {
  settings: Record<string, unknown>;
}

export interface UpdateWebProjectEnvRequest {
  env: Record<string, unknown>;
}

export interface WebProjectEnvResponse {
  env: Record<string, unknown>;
}

export interface UpdateWebKanbanPreferencesRequest {
  preferences: unknown;
}

export interface WebKanbanPreferencesResponse {
  preferences: unknown | null;
}

export interface WebSelectDirectoryRequest {
  title?: string;
  defaultPath?: string;
}

export interface WebPathResponse {
  path: string | null;
}

export interface CreateWebProjectFolderRequest {
  location: string;
  name: string;
  initGit: boolean;
}

export interface WebProjectFolderResponse {
  path: string;
  name: string;
  gitInitialized: boolean;
}

export interface WebGitPathRequest {
  path: string;
}

export interface WebGitBranchResponse {
  branch: string | null;
}

export interface WebGitStatusResponse {
  status: {
    isGitRepo: boolean;
    hasCommits: boolean;
    currentBranch: string | null;
    error?: string;
  };
}

export interface WebGitBranchesResponse {
  branches: string[];
}

export interface WebGitBranchDetail {
  name: string;
  type: 'local' | 'remote';
  displayName: string;
  isCurrent?: boolean;
}

export interface WebGitBranchDetailsResponse {
  branches: WebGitBranchDetail[];
}

export interface WebRemoteProviderResponse {
  provider: {
    provider: 'github' | 'gitlab' | 'gitblit' | 'unknown';
    remoteUrl: string;
    host: string;
    baseUrl: string;
    path: string;
    repoPath: string;
  } | null;
}

export interface WebFilePathRequest {
  path: string;
}

export interface WebListDirectoryResponse {
  files: Array<{
    path: string;
    name: string;
    isDirectory: boolean;
  }>;
}

export interface WebReadFileResponse {
  content: string;
}

export interface WebReadImageFileResponse {
  dataUrl: string;
  mimeType: string;
  size: number;
}

export interface WebWriteFileRequest {
  path: string;
  content: string;
}

export interface WebChangedFilesResponse {
  files: string[];
}

export interface WebFileDiffRequest {
  projectPath: string;
  filePath: string;
}

export interface WebFileDiffResponse {
  diff: string;
}

export interface CreateWebTerminalRequest {
  id: string;
  cwd?: string;
  projectPath?: string;
  cols?: number;
  rows?: number;
}

export interface WebTerminalResponse {
  id: string;
}

export interface WebTerminalInputRequest {
  data: string;
}

export interface WebTerminalEvent {
  type: 'output' | 'exit' | 'title';
  id: string;
  data?: string;
  exitCode?: number;
  title?: string;
}

export interface UpdateWebTaskRequest {
  title?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface WebPromptProfileResponse {
  project: WebProject;
  profile: AutocodeProjectPromptProfile;
  profilePath: string;
  promptsDir: string;
}

export interface WebWorkspaceStateResponse {
  project: WebProject;
  summary: WorkspaceSummary | null;
  projectIndex: ProjectIndex | null;
  tasks: AutocodeTask[];
}

export interface WebTaskListResponse {
  project: WebProject;
  tasks: AutocodeTask[];
}

export interface CreateWebTaskRequest {
  title?: string;
  description: string;
  developmentMode?: AutocodeTaskDevelopmentMode;
  category?: AutocodeTaskCategory;
  complexity?: AutocodeTaskComplexity;
  impact?: AutocodeTaskImpact;
  priority?: AutocodeTaskPriority;
  model?: string;
  provider?: string;
  thinkingLevel?: string;
  language?: string;
  useWorktree?: boolean;
  pushNewBranches?: boolean;
}

export interface UpdateWebTaskStatusRequest {
  status: AutocodeTaskStatus;
  reviewReason?: AutocodeReviewReason;
  executionPhase?: AutocodeExecutionPhase | string;
}

export interface StartWebTaskRequest {
  cli?: AutocodeCli;
  customCommand?: string;
  model?: string;
  bypassPermissions?: boolean;
  language?: string;
}

export interface WebTaskResponse {
  project: WebProject;
  task: AutocodeTask;
  tasks: AutocodeTask[];
}

export interface WebTaskLogsResponse {
  project: WebProject;
  task: AutocodeTask;
  logs: AutocodeTaskLogs | null;
}

export interface WebApiErrorResponse {
  error: string;
  details?: string;
}
