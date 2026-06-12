import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTOCODE_TASK_ARTIFACTS,
  buildAutocodeWorkspaceState,
  createEmptyAutocodeTaskLogs,
  createManualAutocodeTask,
  createStartedAutocodeAgentRuntime,
  getAutocodeSpecDir,
  getAutocodeTaskWorktreeCandidatePaths,
  isAutocodePathWithinBase,
  listAutocodeTasks,
  loadAutocodeImplementationPlanSync,
  mergeAutocodeTaskLogs,
  readAutocodeTaskLogsFromSpecDir,
  resolveAutocodeCli,
  saveAutocodeImplementationPlanSync,
  serializeAutocodeTaskLogs,
  markAutocodeTaskStopped,
  updateAutocodeTaskLogPhase,
  updateAutocodeTaskPlanStatus,
  type AutocodeCli,
  type AutocodeTask,
  type AutocodeTaskCategory,
  type AutocodeTaskComplexity,
  type AutocodeTaskDevelopmentMode,
  type AutocodeTaskImpact,
  type AutocodeTaskLogs,
  type AutocodeTaskMetadata,
  type AutocodeTaskPriority,
  type AutocodeTaskStatus,
  type AgentRuntimeAdapter,
  type AutocodeAgentRuntimeStartRequest,
  type AutocodeAgentRuntimeStartResult,
} from '@autocode/core';
import type {
  AddWebProjectRequest,
  StartWebTaskRequest,
  UpdateWebKanbanPreferencesRequest,
  UpdateWebProjectEnvRequest,
  UpdateWebProjectSettingsRequest,
  CreateWebTaskRequest,
  CreateWebProjectFolderRequest,
  UpdateWebTaskStatusRequest,
  UpdateWebTaskRequest,
  CreateWebTerminalRequest,
  WebGitBranchResponse,
  WebGitBranchesResponse,
  WebGitBranchDetailsResponse,
  WebGitPathRequest,
  WebGitStatusResponse,
  WebChangedFilesResponse,
  WebCodexAuthLoginResponse,
  WebCodexAuthStatusResponse,
  WebCodexCliVersionResponse,
  WebFileDiffRequest,
  WebFileDiffResponse,
  WebFilePathRequest,
  WebKanbanPreferencesResponse,
  WebListDirectoryResponse,
  WebProjectEnvResponse,
  WebProjectSettingsResponse,
  WebApiErrorResponse,
  WebHealthResponse,
  WebPathResponse,
  WebPlatformAuthLoginRequest,
  WebPlatformAuthResponse,
  WebPlatformAuthSetupRequest,
  WebPlatformAuthStatusResponse,
  WebProjectListResponse,
  WebProjectFolderResponse,
  WebProject,
  WebProjectResponse,
  WebPromptProfileResponse,
  WebReadFileResponse,
  WebReadImageFileResponse,
  WebRemoteProviderResponse,
  WebWriteFileRequest,
  WebSelectDirectoryRequest,
  WebTaskListResponse,
  WebTaskLogsResponse,
  WebTaskResponse,
  WebTerminalEvent,
  WebTerminalInputRequest,
  WebTerminalResponse,
  WebWorkspaceStateResponse,
} from '../shared/api.js';
import {
  clearWebCodexAuth,
  getWebCodexAuthState,
  getWebCodexCliVersion,
  startWebCodexOAuthFlow,
} from './codex-auth.js';
import { selectLocalDirectory } from './local-dialogs.js';
import {
  buildExpiredPlatformSessionCookie,
  buildPlatformSessionCookie,
  PlatformAuthError,
  readPlatformSessionToken,
  WebPlatformAuthStore,
} from './platform-auth.js';
import { assertProjectDirectory, initializeWebProjectPromptProfile } from './project-prompts.js';
import { WebProjectStore } from './project-store.js';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const WEB_TASK_DEVELOPMENT_MODES = new Set<AutocodeTaskDevelopmentMode>(['direct', 'standard', 'spec']);
const WEB_TASK_CATEGORIES = new Set<AutocodeTaskCategory>([
  'feature',
  'bug_fix',
  'refactoring',
  'documentation',
  'security',
  'performance',
  'ui_ux',
  'infrastructure',
  'testing',
]);
const WEB_TASK_COMPLEXITIES = new Set<AutocodeTaskComplexity>(['trivial', 'small', 'medium', 'large', 'complex']);
const WEB_TASK_IMPACTS = new Set<AutocodeTaskImpact>(['low', 'medium', 'high', 'critical']);
const WEB_TASK_PRIORITIES = new Set<AutocodeTaskPriority>(['low', 'medium', 'high', 'urgent']);
const WEB_TASK_STATUSES = new Set<AutocodeTaskStatus>([
  'backlog',
  'queue',
  'in_progress',
  'ai_review',
  'human_review',
  'done',
  'pr_created',
  'error',
]);

export interface WebLocalServiceOptions {
  host: string;
  port: number;
  staticDir: string;
  projectStore: WebProjectStore;
}

export class WebLocalService {
  private server: Server | null = null;
  private readonly platformAuth: WebPlatformAuthStore;
  private readonly startedAt = new Date().toISOString();
  private readonly terminalProcesses = new Map<string, ReturnType<typeof spawn>>();
  private readonly terminalClients = new Set<ServerResponse>();
  private readonly runtimeProcesses = new Map<string, ReturnType<typeof spawn>>();
  private readonly runtimeIdsByTask = new Map<string, string>();
  private readonly runtimeAdapter: AgentRuntimeAdapter = {
    startRuntime: (request) => this.startRuntimeProcess(request),
    stopRuntime: (taskId) => this.stopRuntimeByTask(taskId),
    isRuntimeRunning: (taskId) => {
      const runtimeId = this.runtimeIdsByTask.get(taskId);
      return runtimeId ? this.isRuntimeProcessRunning(runtimeId) : false;
    },
  };

  constructor(private readonly options: WebLocalServiceOptions) {
    this.platformAuth = new WebPlatformAuthStore(options.projectStore.getDataDir());
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        this.sendError(response, 500, error instanceof Error ? error.message : 'Internal server error');
      });
    });

    await new Promise<void>((resolveStart, rejectStart) => {
      this.server?.once('error', rejectStart);
      this.server?.listen(this.options.port, this.options.host, () => {
        this.server?.off('error', rejectStart);
        resolveStart();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const runtimeId of this.runtimeProcesses.keys()) {
      this.stopRuntimeProcess(runtimeId);
    }
    await new Promise<void>((resolveStop, rejectStop) => {
      this.server?.close((error) => {
        if (error) rejectStop(error);
        else resolveStop();
      });
    });
    this.server = null;
  }

  private async startTaskRuntime(
    project: WebProject,
    taskId: string,
    request: StartWebTaskRequest,
  ): Promise<AutocodeTask> {
    await assertProjectDirectory(project.path);

    if (this.runtimeAdapter.isRuntimeRunning?.(taskId)) {
      throw new Error(`Task is already running: ${taskId}`);
    }

    const task = findTask(project.path, taskId);
    const cli = resolveWebTaskCli(request.cli);

    try {
      const started = createStartedAutocodeAgentRuntime({
        projectRoot: project.path,
        taskId: task.specId,
        projectId: project.id,
        cli,
        ...(request.customCommand ? { customCommand: request.customCommand } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(typeof request.bypassPermissions === 'boolean'
          ? { bypassPermissions: request.bypassPermissions }
          : {}),
        ...(request.language ? { language: request.language as never } : {}),
        ...(request.forcePlanning === true ? { forcePlanning: true } : {}),
        ...(typeof project.settings?.mainBranch === 'string'
          ? { baseBranch: project.settings.mainBranch }
          : {}),
      });

      await this.runtimeAdapter.startRuntime(started.request);
      return findTask(project.path, task.specId);
    } catch (error) {
      updateAutocodeTaskLogPhase({
        projectRoot: project.path,
        taskId: task.specId,
        phase: 'planning',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
      updateAutocodeTaskPlanStatus({
        projectRoot: project.path,
        taskId: task.specId,
        planStatus: 'error',
        reviewReason: 'errors',
        executionPhase: 'failed',
      });
      throw error;
    }
  }

  private async stopTaskRuntime(project: WebProject, taskId: string): Promise<AutocodeTask> {
    await assertProjectDirectory(project.path);
    const task = findTask(project.path, taskId);
    await this.runtimeAdapter.stopRuntime?.(task.specId);

    return markAutocodeTaskStopped({
      projectRoot: project.path,
      taskId: task.specId,
      message: 'Task stopped from Web.',
    });
  }

  private startRuntimeProcess(request: AutocodeAgentRuntimeStartRequest): Promise<AutocodeAgentRuntimeStartResult> {
    const processCommand = request.runner?.process;
    if (!processCommand) {
      throw new Error('Agent runtime start request does not include a process command.');
    }

    return new Promise((resolveStart) => {
      let resolved = false;
      const child = spawn(processCommand.command, processCommand.args, {
        cwd: processCommand.cwd,
        shell: processCommand.shell ?? false,
        stdio: 'ignore',
        windowsHide: true,
      });

      const resolveOnce = (result: AutocodeAgentRuntimeStartResult) => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolveStart(result);
      };

      child.once('spawn', () => {
        this.runtimeProcesses.set(request.runtimeId, child);
        this.runtimeIdsByTask.set(request.plan.taskId, request.runtimeId);
        this.runtimeIdsByTask.set(request.plan.specId, request.runtimeId);
        resolveOnce({
          runtimeId: request.runtimeId,
          status: 'started',
          message: request.messages.started,
          process: {
            status: 'started',
          },
        });
      });

      child.once('error', (error) => {
        this.deleteRuntimeIndex(request);
        resolveOnce({
          runtimeId: request.runtimeId,
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
          process: {
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });

      child.once('exit', () => {
        this.deleteRuntimeIndex(request);
      });
    });
  }

  private stopRuntimeByTask(taskId: string): void {
    const runtimeId = this.runtimeIdsByTask.get(taskId);
    if (!runtimeId) {
      return;
    }

    this.stopRuntimeProcess(runtimeId);
  }

  private stopRuntimeProcess(runtimeId: string): void {
    const child = this.runtimeProcesses.get(runtimeId);
    if (!child) {
      return;
    }

    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      child.kill('SIGTERM');
    }

    this.runtimeProcesses.delete(runtimeId);
    deleteMapEntriesByValue(this.runtimeIdsByTask, runtimeId);
  }

  private isRuntimeProcessRunning(runtimeId: string): boolean {
    const child = this.runtimeProcesses.get(runtimeId);
    return Boolean(child && child.exitCode === null && !child.killed);
  }

  private deleteRuntimeIndex(request: AutocodeAgentRuntimeStartRequest): void {
    this.runtimeProcesses.delete(request.runtimeId);
    this.runtimeIdsByTask.delete(request.plan.taskId);
    this.runtimeIdsByTask.delete(request.plan.specId);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const corsAllowed = this.applyCors(request, response);

    if (request.method === 'OPTIONS') {
      response.writeHead(corsAllowed ? 204 : 403);
      response.end();
      return;
    }

    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (requestUrl.pathname.startsWith('/api/')) {
      await this.handleApiRequest(request, response, requestUrl);
      return;
    }

    await this.serveStatic(response, requestUrl.pathname);
  }

  private async handleApiRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    const pathParts = requestUrl.pathname.split('/').filter(Boolean);

    if (requestUrl.pathname.startsWith('/api/platform-auth/')) {
      if (await this.handlePlatformAuthRequest(request, response, requestUrl)) {
        return;
      }
    }

    if (!(await this.authenticateApiRequest(request, response))) {
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
      this.sendJson<WebHealthResponse>(response, 200, {
        ok: true,
        service: 'autocode-web-local-service',
        version: '0.1.0',
        startedAt: this.startedAt,
        dataDir: this.options.projectStore.getDataDir(),
      });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/cli/codex/version') {
      this.sendJson<WebCodexCliVersionResponse>(response, 200, {
        info: await getWebCodexCliVersion(),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/auth/codex/login') {
      this.sendJson<WebCodexAuthLoginResponse>(response, 200, {
        auth: await startWebCodexOAuthFlow(this.options.projectStore.getDataDir()),
      });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/auth/codex/status') {
      this.sendJson<WebCodexAuthStatusResponse>(response, 200, {
        auth: getWebCodexAuthState(this.options.projectStore.getDataDir()),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/auth/codex/logout') {
      await clearWebCodexAuth(this.options.projectStore.getDataDir());
      this.sendJson(response, 200, { loggedOut: true });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/terminals/events') {
      this.handleTerminalEvents(response);
      request.on('close', () => {
        this.terminalClients.delete(response);
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/terminals') {
      const body = await this.readJsonBody<CreateWebTerminalRequest>(request);
      const terminalId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : '';
      if (!terminalId) {
        this.sendError(response, 400, 'Terminal id is required.');
        return;
      }

      const cwd = await this.resolveProjectFilePathOrSendError(response, body.cwd || body.projectPath || process.cwd());
      if (!cwd) return;
      const terminal = this.createTerminalProcess(terminalId, cwd);
      this.sendJson<WebTerminalResponse>(response, 201, { id: terminal });
      return;
    }

    if (
      request.method === 'POST'
      && pathParts.length === 4
      && pathParts[0] === 'api'
      && pathParts[1] === 'terminals'
      && pathParts[3] === 'input'
    ) {
      const terminal = this.terminalProcesses.get(pathParts[2]);
      if (!terminal) {
        this.sendError(response, 404, 'Terminal not found.');
        return;
      }
      const body = await this.readJsonBody<WebTerminalInputRequest>(request);
      terminal.stdin?.write(typeof body.data === 'string' ? body.data : '');
      this.sendJson(response, 200, { written: true });
      return;
    }

    if (
      request.method === 'DELETE'
      && pathParts.length === 3
      && pathParts[0] === 'api'
      && pathParts[1] === 'terminals'
    ) {
      const terminal = this.terminalProcesses.get(pathParts[2]);
      terminal?.kill();
      this.terminalProcesses.delete(pathParts[2]);
      this.sendJson(response, 200, { destroyed: true });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/dialog/select-directory') {
      const body = await this.readJsonBody<WebSelectDirectoryRequest>(request);
      const defaultPath = typeof body.defaultPath === 'string'
        ? body.defaultPath
        : getDefaultProjectLocation() ?? undefined;
      const path = await selectLocalDirectory({
        title: typeof body.title === 'string' ? body.title : 'Select Project Directory',
        defaultPath,
      });
      this.sendJson<WebPathResponse>(response, 200, { path });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/dialog/default-project-location') {
      this.sendJson<WebPathResponse>(response, 200, { path: getDefaultProjectLocation() });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/dialog/create-project-folder') {
      const body = await this.readJsonBody<CreateWebProjectFolderRequest>(request);
      if (!body.location || typeof body.location !== 'string' || !body.name || typeof body.name !== 'string') {
        this.sendError(response, 400, 'Location and name are required.');
        return;
      }

      try {
        const result = createProjectFolder({
          ...body,
          initGit: body.initGit === true,
        });
        this.sendJson<WebProjectFolderResponse>(response, 201, result);
      } catch (error) {
        this.sendError(response, 400, error instanceof Error ? error.message : 'Failed to create project folder.');
      }
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/git/branches') {
      const projectPath = await this.readProjectPathBodyOrSendError<WebGitPathRequest>(request, response);
      if (!projectPath) return;
      this.sendJson<WebGitBranchesResponse>(response, 200, {
        branches: getGitBranches(projectPath),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/git/branches-with-info') {
      const projectPath = await this.readProjectPathBodyOrSendError<WebGitPathRequest>(request, response);
      if (!projectPath) return;
      this.sendJson<WebGitBranchDetailsResponse>(response, 200, {
        branches: getGitBranchesWithInfo(projectPath),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/git/current-branch') {
      const projectPath = await this.readProjectPathBodyOrSendError<WebGitPathRequest>(request, response);
      if (!projectPath) return;
      this.sendJson<WebGitBranchResponse>(response, 200, {
        branch: getCurrentGitBranch(projectPath),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/git/detect-main-branch') {
      const projectPath = await this.readProjectPathBodyOrSendError<WebGitPathRequest>(request, response);
      if (!projectPath) return;
      this.sendJson<WebGitBranchResponse>(response, 200, {
        branch: detectMainBranch(projectPath),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/git/status') {
      const projectPath = await this.readProjectPathBodyOrSendError<WebGitPathRequest>(request, response);
      if (!projectPath) return;
      this.sendJson<WebGitStatusResponse>(response, 200, {
        status: checkGitStatus(projectPath),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/git/initialize') {
      const projectPath = await this.readProjectPathBodyOrSendError<WebGitPathRequest>(request, response);
      if (!projectPath) return;
      this.sendJson(response, 200, initializeGit(projectPath));
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/git/remote-provider') {
      const projectPath = await this.readProjectPathBodyOrSendError<WebGitPathRequest>(request, response);
      if (!projectPath) return;
      this.sendJson<WebRemoteProviderResponse>(response, 200, {
        provider: detectRemoteProvider(projectPath),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/files/list') {
      const dirPath = await this.readProjectFilePathBodyOrSendError<WebFilePathRequest>(request, response);
      if (!dirPath) return;
      const entries = await readdir(dirPath, { withFileTypes: true });
      this.sendJson<WebListDirectoryResponse>(response, 200, {
        files: entries
          .filter((entry) => !shouldHideFileEntry(entry.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((entry) => ({
            path: join(dirPath, entry.name),
            name: entry.name,
            isDirectory: entry.isDirectory(),
          })),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/files/read') {
      const filePath = await this.readProjectFilePathBodyOrSendError<WebFilePathRequest>(request, response);
      if (!filePath) return;
      this.sendJson<WebReadFileResponse>(response, 200, {
        content: await readFile(filePath, 'utf-8'),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/files/read-image') {
      const filePath = await this.readProjectFilePathBodyOrSendError<WebFilePathRequest>(request, response);
      if (!filePath) return;
      const file = await readFile(filePath);
      this.sendJson<WebReadImageFileResponse>(response, 200, {
        dataUrl: `data:${getMimeType(filePath)};base64,${file.toString('base64')}`,
        mimeType: getMimeType(filePath),
        size: file.byteLength,
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/files/write') {
      const body = await this.readJsonBody<WebWriteFileRequest>(request);
      const filePath = await this.resolveProjectFilePathOrSendError(response, body.path);
      if (!filePath) return;
      await writeFile(filePath, typeof body.content === 'string' ? body.content : '', 'utf-8');
      this.sendJson(response, 200, { written: true });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/files/changed') {
      const projectPath = await this.readProjectPathBodyOrSendError<WebGitPathRequest>(request, response);
      if (!projectPath) return;
      this.sendJson<WebChangedFilesResponse>(response, 200, {
        files: getChangedFiles(projectPath),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/files/diff') {
      const body = await this.readJsonBody<WebFileDiffRequest>(request);
      const projectPath = await this.resolveProjectPathOrSendError(response, body.projectPath);
      if (!projectPath) return;
      const filePath = await this.resolveProjectFilePathOrSendError(response, body.filePath, projectPath);
      if (!filePath) return;
      this.sendJson<WebFileDiffResponse>(response, 200, {
        diff: getFileDiff(projectPath, filePath),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/files/show-item') {
      const filePath = await this.readProjectFilePathBodyOrSendError<WebFilePathRequest>(request, response);
      if (!filePath) return;
      openInSystemFileManager(filePath);
      this.sendJson(response, 200, { opened: true });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/projects') {
      this.sendJson<WebProjectListResponse>(response, 200, {
        projects: await this.options.projectStore.listProjects(),
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/projects') {
      const body = await this.readJsonBody<AddWebProjectRequest>(request);
      if (!body.path || typeof body.path !== 'string') {
        this.sendError(response, 400, 'Project path is required.');
        return;
      }

      const projectPath = resolve(body.path);
      await assertProjectDirectory(projectPath);
      const project = await this.options.projectStore.upsertProject(projectPath);
      this.sendJson<WebProjectResponse>(response, 201, { project });
      return;
    }

    if (
      request.method === 'DELETE'
      && pathParts.length === 3
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
    ) {
      const removed = await this.options.projectStore.removeProject(pathParts[2]);
      if (!removed) {
        this.sendError(response, 404, 'Project not found.');
        return;
      }

      this.sendJson(response, 200, { removed: true });
      return;
    }

    if (
      request.method === 'PATCH'
      && pathParts.length === 4
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'settings'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;
      const body = await this.readJsonBody<UpdateWebProjectSettingsRequest>(request);
      const updatedProject = await this.options.projectStore.updateProject({
        ...project,
        settings: {
          ...(project.settings ?? {}),
          ...(isPlainRecord(body.settings) ? body.settings : {}),
        },
      });
      this.sendJson<WebProjectSettingsResponse>(response, 200, { settings: updatedProject.settings ?? {} });
      return;
    }

    if (
      request.method === 'GET'
      && pathParts.length === 4
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'env'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;
      this.sendJson<WebProjectEnvResponse>(response, 200, { env: project.env ?? {} });
      return;
    }

    if (
      request.method === 'PATCH'
      && pathParts.length === 4
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'env'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;
      const body = await this.readJsonBody<UpdateWebProjectEnvRequest>(request);
      const updatedProject = await this.options.projectStore.updateProject({
        ...project,
        env: {
          ...(project.env ?? {}),
          ...(isPlainRecord(body.env) ? body.env : {}),
        },
      });
      this.sendJson<WebProjectEnvResponse>(response, 200, { env: updatedProject.env ?? {} });
      return;
    }

    if (
      request.method === 'GET'
      && pathParts.length === 4
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'kanban-preferences'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;
      this.sendJson<WebKanbanPreferencesResponse>(response, 200, {
        preferences: project.kanbanPreferences ?? null,
      });
      return;
    }

    if (
      request.method === 'PUT'
      && pathParts.length === 4
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'kanban-preferences'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;
      const body = await this.readJsonBody<UpdateWebKanbanPreferencesRequest>(request);
      const updatedProject = await this.options.projectStore.updateProject({
        ...project,
        kanbanPreferences: body.preferences ?? null,
      });
      this.sendJson<WebKanbanPreferencesResponse>(response, 200, {
        preferences: updatedProject.kanbanPreferences ?? null,
      });
      return;
    }

    if (
      request.method === 'GET'
      && pathParts.length === 3
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[2]
      && requestUrl.pathname.endsWith('/workspace') === false
    ) {
      this.sendError(response, 404, 'API route not found.');
      return;
    }

    if (
      request.method === 'GET'
      && pathParts.length === 4
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'workspace'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;

      await assertProjectDirectory(project.path);
      const workspaceState = buildAutocodeWorkspaceState({
        projectRoot: project.path,
        includeLogs: false,
      });

      this.sendJson<WebWorkspaceStateResponse>(response, 200, {
        project,
        summary: workspaceState.summary,
        projectIndex: workspaceState.projectIndex,
        tasks: workspaceState.tasks,
      });
      return;
    }

    if (
      request.method === 'GET'
      && pathParts.length === 4
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'tasks'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;

      await assertProjectDirectory(project.path);
      this.sendJson<WebTaskListResponse>(response, 200, {
        project,
        tasks: listAutocodeTasks({ projectRoot: project.path }),
      });
      return;
    }

    if (
      request.method === 'POST'
      && pathParts.length === 4
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'tasks'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;

      const body = await this.readJsonBody<CreateWebTaskRequest>(request);
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      if (!description) {
        this.sendError(response, 400, 'Task description is required.');
        return;
      }

      await assertProjectDirectory(project.path);
      const task = createManualAutocodeTask({
        projectRoot: project.path,
        title: typeof body.title === 'string' ? body.title.trim() : '',
        description,
        metadata: createTaskMetadata(body),
      });

      this.sendJson<WebTaskResponse>(response, 201, {
        project,
        task,
        tasks: listAutocodeTasks({ projectRoot: project.path }),
      });
      return;
    }

    if (
      request.method === 'POST'
      && pathParts.length === 6
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'tasks'
      && pathParts[5] === 'start'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;

      const body = await this.readJsonBody<StartWebTaskRequest>(request);
      const task = await this.startTaskRuntime(project, pathParts[4], body);

      this.sendJson<WebTaskResponse>(response, 200, {
        project,
        task,
        tasks: listAutocodeTasks({ projectRoot: project.path }),
      });
      return;
    }

    if (
      request.method === 'POST'
      && pathParts.length === 6
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'tasks'
      && pathParts[5] === 'stop'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;

      const task = await this.stopTaskRuntime(project, pathParts[4]);

      this.sendJson<WebTaskResponse>(response, 200, {
        project,
        task,
        tasks: listAutocodeTasks({ projectRoot: project.path }),
      });
      return;
    }

    if (
      request.method === 'PATCH'
      && pathParts.length === 6
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'tasks'
      && pathParts[5] === 'status'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;

      const body = await this.readJsonBody<UpdateWebTaskStatusRequest>(request);
      if (!isSetValue(body.status, WEB_TASK_STATUSES)) {
        this.sendError(response, 400, 'Valid task status is required.');
        return;
      }

      await assertProjectDirectory(project.path);
      const task = updateAutocodeTaskPlanStatus({
        projectRoot: project.path,
        taskId: pathParts[4],
        planStatus: body.status,
        reviewReason: body.reviewReason,
        executionPhase: body.executionPhase,
      });

      this.sendJson<WebTaskResponse>(response, 200, {
        project,
        task,
        tasks: listAutocodeTasks({ projectRoot: project.path }),
      });
      return;
    }

    if (
      request.method === 'GET'
      && pathParts.length === 6
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'tasks'
      && pathParts[5] === 'logs'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;

      await assertProjectDirectory(project.path);
      const task = findTask(project.path, pathParts[4]);
      const logs = loadTaskLogs(project.path, task.specId);

      this.sendJson<WebTaskLogsResponse>(response, 200, {
        project,
        task,
        logs,
      });
      return;
    }

    if (
      request.method === 'DELETE'
      && pathParts.length === 6
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'tasks'
      && pathParts[5] === 'logs'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;

      await assertProjectDirectory(project.path);
      const task = findTask(project.path, pathParts[4]);
      const logs = clearTaskLogs(project.path, task.specId);

      this.sendJson<WebTaskLogsResponse>(response, 200, {
        project,
        task: findTask(project.path, task.specId),
        logs,
      });
      return;
    }

    if (
      request.method === 'PATCH'
      && pathParts.length === 5
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'tasks'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;
      const body = await this.readJsonBody<UpdateWebTaskRequest>(request);
      await assertProjectDirectory(project.path);
      const task = updateTask(project.path, pathParts[4], body);
      this.sendJson<WebTaskResponse>(response, 200, {
        project,
        task,
        tasks: listAutocodeTasks({ projectRoot: project.path }),
      });
      return;
    }

    if (
      request.method === 'DELETE'
      && pathParts.length === 5
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'tasks'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;
      await assertProjectDirectory(project.path);
      await deleteTask(project.path, pathParts[4]);
      this.sendJson(response, 200, { deleted: true });
      return;
    }

    if (
      request.method === 'DELETE'
      && pathParts.length === 7
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'tasks'
      && pathParts[5] === 'subtasks'
    ) {
      const project = await this.getProjectOrSendError(response, pathParts[2]);
      if (!project) return;
      await assertProjectDirectory(project.path);
      const task = deleteSubtask(project.path, pathParts[4], pathParts[6]);
      this.sendJson<WebTaskResponse>(response, 200, {
        project,
        task,
        tasks: listAutocodeTasks({ projectRoot: project.path }),
      });
      return;
    }

    if (
      request.method === 'POST'
      && pathParts.length === 4
      && pathParts[0] === 'api'
      && pathParts[1] === 'projects'
      && pathParts[3] === 'prompt-profile'
    ) {
      const projectId = pathParts[2];
      const project = await this.options.projectStore.getProject(projectId);
      if (!project) {
        this.sendError(response, 404, 'Project not found.');
        return;
      }

      await assertProjectDirectory(project.path);
      const result = await initializeWebProjectPromptProfile(project.path, { overwrite: true });
      const updatedProject = await this.options.projectStore.updateProject({
        ...project,
        promptProfile: result.profile,
        promptProfilePath: result.profilePath,
        promptProfileUpdatedAt: new Date().toISOString(),
      });

      this.sendJson<WebPromptProfileResponse>(response, 200, {
        project: updatedProject,
        profile: result.profile,
        profilePath: result.profilePath,
        promptsDir: result.promptsDir,
      });
      return;
    }

    this.sendError(response, 404, 'API route not found.');
  }

  private async handlePlatformAuthRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
  ): Promise<boolean> {
    const sessionToken = readPlatformSessionToken(request);

    if (request.method === 'GET' && requestUrl.pathname === '/api/platform-auth/status') {
      this.sendJson<WebPlatformAuthStatusResponse>(response, 200, {
        auth: await this.platformAuth.getStatus(sessionToken),
      });
      return true;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/platform-auth/setup') {
      try {
        const body = await this.readJsonBody<WebPlatformAuthSetupRequest>(request);
        const result = await this.platformAuth.createFirstAccount(body);
        response.setHeader('Set-Cookie', buildPlatformSessionCookie(result.sessionToken));
        this.sendJson<WebPlatformAuthResponse>(response, 201, { auth: result.status });
      } catch (error) {
        this.sendPlatformAuthError(response, error);
      }
      return true;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/platform-auth/login') {
      try {
        const body = await this.readJsonBody<WebPlatformAuthLoginRequest>(request);
        const result = await this.platformAuth.login(body);
        response.setHeader('Set-Cookie', buildPlatformSessionCookie(result.sessionToken));
        this.sendJson<WebPlatformAuthResponse>(response, 200, { auth: result.status });
      } catch (error) {
        this.sendPlatformAuthError(response, error);
      }
      return true;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/platform-auth/logout') {
      await this.platformAuth.logout(sessionToken);
      response.setHeader('Set-Cookie', buildExpiredPlatformSessionCookie());
      this.sendJson(response, 200, { loggedOut: true });
      return true;
    }

    this.sendError(response, 404, 'Platform auth route not found.');
    return true;
  }

  private async authenticateApiRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const status = await this.platformAuth.getStatus(readPlatformSessionToken(request));
    if (status.authenticated) {
      return true;
    }

    this.sendError(response, 401, 'Platform authentication required.');
    return false;
  }

  private sendPlatformAuthError(response: ServerResponse, error: unknown): void {
    if (error instanceof PlatformAuthError) {
      this.sendError(response, error.statusCode, error.message);
      return;
    }
    this.sendError(response, 500, error instanceof Error ? error.message : 'Platform authentication failed.');
  }

  private async getProjectOrSendError(
    response: ServerResponse,
    projectId: string,
  ): Promise<Awaited<ReturnType<WebProjectStore['getProject']>>> {
    const project = await this.options.projectStore.getProject(projectId);
    if (!project) {
      this.sendError(response, 404, 'Project not found.');
      return null;
    }
    return project;
  }

  private async readJsonBody<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let totalLength = 0;

    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalLength += buffer.length;
      if (totalLength > 1024 * 1024) {
        throw new Error('Request body is too large.');
      }
      chunks.push(buffer);
    }

    if (chunks.length === 0) return {} as T;
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T;
  }

  private async readProjectPathBodyOrSendError<T extends { path?: unknown }>(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<string | null> {
    const body = await this.readJsonBody<T>(request);
    return await this.resolveProjectPathOrSendError(response, body.path);
  }

  private async readProjectFilePathBodyOrSendError<T extends { path?: unknown }>(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<string | null> {
    const body = await this.readJsonBody<T>(request);
    return await this.resolveProjectFilePathOrSendError(response, body.path);
  }

  private async resolveProjectPathOrSendError(
    response: ServerResponse,
    value: unknown,
  ): Promise<string | null> {
    if (!value || typeof value !== 'string') {
      this.sendError(response, 400, 'Project path is required.');
      return null;
    }

    const projectPath = resolve(value);
    await assertProjectDirectory(projectPath);
    const projects = await this.options.projectStore.listProjects();
    if (!projects.some((project) => resolve(project.path) === projectPath)) {
      this.sendError(response, 403, 'Project path is not registered with the Web local service.');
      return null;
    }

    return projectPath;
  }

  private async resolveProjectFilePathOrSendError(
    response: ServerResponse,
    value: unknown,
    explicitProjectPath?: string,
  ): Promise<string | null> {
    if (!value || typeof value !== 'string') {
      this.sendError(response, 400, 'File path is required.');
      return null;
    }

    const filePath = resolve(value);
    const projects = explicitProjectPath
      ? [{ path: explicitProjectPath }]
      : await this.options.projectStore.listProjects();

    if (!projects.some((project) => isPathInside(filePath, resolve(project.path)))) {
      this.sendError(response, 403, 'File path is outside registered project directories.');
      return null;
    }

    return filePath;
  }

  private handleTerminalEvents(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write('\n');
    this.terminalClients.add(response);
  }

  private createTerminalProcess(terminalId: string, cwd: string): string {
    this.terminalProcesses.get(terminalId)?.kill();
    const shell = getSystemShell();
    const child = spawn(shell.command, shell.args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.terminalProcesses.set(terminalId, child);
    this.broadcastTerminalEvent({
      type: 'title',
      id: terminalId,
      title: basename(cwd),
    });
    this.broadcastTerminalEvent({
      type: 'output',
      id: terminalId,
      data: `Autocode Web shell started in ${cwd}\r\n`,
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      this.broadcastTerminalEvent({
        type: 'output',
        id: terminalId,
        data: chunk.toString('utf8'),
      });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.broadcastTerminalEvent({
        type: 'output',
        id: terminalId,
        data: chunk.toString('utf8'),
      });
    });
    child.on('exit', (code) => {
      this.terminalProcesses.delete(terminalId);
      this.broadcastTerminalEvent({
        type: 'exit',
        id: terminalId,
        exitCode: code ?? 0,
      });
    });

    return terminalId;
  }

  private broadcastTerminalEvent(event: WebTerminalEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of [...this.terminalClients]) {
      if (client.destroyed) {
        this.terminalClients.delete(client);
        continue;
      }
      client.write(payload);
    }
  }

  private async serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    const normalizedPath = pathname === '/' ? '/index.html' : pathname;
    const staticPath = resolve(this.options.staticDir, `.${decodeURIComponent(normalizedPath)}`);
    const staticRoot = resolve(this.options.staticDir);

    if (!isPathInside(staticPath, staticRoot)) {
      this.sendError(response, 403, 'Forbidden.');
      return;
    }

    try {
      const fileStat = await stat(staticPath);
      if (!fileStat.isFile()) throw new Error('Not a file');
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(staticPath)] ?? 'application/octet-stream',
      });
      createReadStream(staticPath).pipe(response);
      return;
    } catch {
      const indexPath = join(staticRoot, 'index.html');
      try {
        const indexHtml = await readFile(indexPath);
        response.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'] });
        response.end(indexHtml);
      } catch {
        this.sendJson(response, 200, {
          ok: true,
          message: 'Autocode Web local service is running. Build the Web client or use npm run dev:web.',
        });
      }
    }
  }

  private applyCors(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    const allowed = isAllowedCorsOrigin(origin, request.headers.host, this.options.host);
    if (origin && allowed) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Credentials', 'true');
    } else if (!origin) {
      response.setHeader('Access-Control-Allow-Origin', '*');
    }
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return allowed;
  }

  private sendJson<T>(response: ServerResponse, statusCode: number, payload: T): void {
    response.writeHead(statusCode, { 'Content-Type': JSON_CONTENT_TYPE });
    response.end(JSON.stringify(payload));
  }

  private sendError(response: ServerResponse, statusCode: number, error: string, details?: string): void {
    this.sendJson<WebApiErrorResponse>(response, statusCode, { error, details });
  }
}

function getDefaultProjectLocation(): string | null {
  try {
    const homeDir = homedir();
    const commonPaths = [
      join(homeDir, 'Projects'),
      join(homeDir, 'Developer'),
      join(homeDir, 'Code'),
      join(homeDir, 'Documents'),
    ];

    for (const candidate of commonPaths) {
      if (existsSync(candidate)) return candidate;
    }

    return join(homeDir, 'Documents');
  } catch {
    return null;
  }
}

function isAllowedCorsOrigin(
  origin: string | undefined,
  requestHost: string | undefined,
  serviceHost: string,
): boolean {
  if (!origin) {
    return true;
  }

  try {
    const originUrl = new URL(origin);
    const hostname = originUrl.hostname.toLowerCase();
    const requestHostname = (requestHost ?? '').split(':')[0]?.toLowerCase();
    const configuredHost = serviceHost.toLowerCase();
    return (
      hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '::1'
      || hostname === '[::1]'
      || hostname === requestHostname
      || hostname === configuredHost
    );
  } catch {
    return false;
  }
}

function getSystemShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/Q', '/K', 'chcp 65001>nul'],
    };
  }

  return {
    command: process.env.SHELL || '/bin/sh',
    args: ['-i'],
  };
}

function createProjectFolder(body: CreateWebProjectFolderRequest): WebProjectFolderResponse {
  const sanitizedName = sanitizeProjectName(body.name);
  if (!sanitizedName) {
    throw new Error('Invalid project name.');
  }

  const projectPath = join(body.location, sanitizedName);
  if (existsSync(projectPath)) {
    throw new Error(`Folder "${sanitizedName}" already exists at this location.`);
  }

  mkdirSync(projectPath, { recursive: true });

  let gitInitialized = false;
  if (body.initGit) {
    try {
      execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
      gitInitialized = true;
    } catch {
      gitInitialized = false;
    }
  }

  return {
    path: projectPath,
    name: sanitizedName,
    gitInitialized,
  };
}

function sanitizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function detectMainBranch(projectPath: string): string | null {
  const branches = getGitBranches(projectPath);
  if (branches.length === 0) return null;

  const mainBranchCandidates = ['main', 'master', 'develop', 'dev', 'trunk'];
  for (const candidate of mainBranchCandidates) {
    if (branches.includes(candidate)) return candidate;
  }

  try {
    const result = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const match = result.trim().match(/refs\/remotes\/origin\/(.+)/);
    if (match && branches.includes(match[1])) return match[1];
  } catch {
    // Ignore missing origin/HEAD and fall back to the first detected branch.
  }

  return branches[0] ?? null;
}

function getGitBranches(projectPath: string): string[] {
  try {
    const result = execFileSync('git', ['branch', '--all', '--format=%(refname:short)'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const branches = result
      .trim()
      .split('\n')
      .map((branch) => branch.trim())
      .filter(Boolean)
      .filter((branch) => !branch.endsWith('/HEAD'))
      .filter((branch, index, self) => {
        if (branch.startsWith('origin/')) {
          const localName = branch.replace('origin/', '');
          return !self.includes(localName);
        }
        return self.indexOf(branch) === index;
      });

    return branches.sort((a, b) => {
      const aIsRemote = a.startsWith('origin/');
      const bIsRemote = b.startsWith('origin/');
      if (aIsRemote && !bIsRemote) return 1;
      if (!aIsRemote && bIsRemote) return -1;
      return a.localeCompare(b);
    });
  } catch {
    return [];
  }
}

function checkGitStatus(projectPath: string): WebGitStatusResponse['status'] {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return {
      isGitRepo: false,
      hasCommits: false,
      currentBranch: null,
      error: 'Not a git repository. Please run "git init" to initialize git.',
    };
  }

  let hasCommits = false;
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    hasCommits = true;
  } catch {
    hasCommits = false;
  }

  let currentBranch: string | null = null;
  try {
    currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    currentBranch = null;
  }

  if (!hasCommits) {
    return {
      isGitRepo: true,
      hasCommits: false,
      currentBranch,
      error: 'Git repository has no commits. Please make an initial commit first.',
    };
  }

  return {
    isGitRepo: true,
    hasCommits: true,
    currentBranch,
  };
}

function getGitBranchesWithInfo(projectPath: string): WebGitBranchDetailsResponse['branches'] {
  const currentBranch = getCurrentGitBranch(projectPath);
  const localBranches = getGitBranchList(projectPath, ['branch', '--format=%(refname:short)'])
    .map((name) => ({
      name,
      type: 'local' as const,
      displayName: name,
      isCurrent: name === currentBranch,
    }));
  const localNames = new Set(localBranches.map((branch) => branch.name));
  const remoteBranches = getGitBranchList(projectPath, ['branch', '-r', '--format=%(refname:short)'])
    .filter((name) => !name.endsWith('/HEAD'))
    .map((fullName) => {
      const name = fullName.replace(/^origin\//, '');
      return {
        name,
        type: 'remote' as const,
        displayName: name,
        isCurrent: false,
      };
    })
    .filter((branch) => !localNames.has(branch.name));

  return [...localBranches, ...remoteBranches].sort((a, b) => {
    if (a.type === 'local' && b.type === 'remote') return -1;
    if (a.type === 'remote' && b.type === 'local') return 1;
    return a.name.localeCompare(b.name);
  });
}

function getGitBranchList(projectPath: string, args: string[]): string[] {
  try {
    const output = execFileSync('git', args, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .trim()
      .split('\n')
      .map((branch) => branch.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getCurrentGitBranch(projectPath: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function initializeGit(projectPath: string): { success: boolean; error?: string } {
  try {
    if (!checkGitStatus(projectPath).isGitRepo) {
      execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
    }
    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (statusOutput || !checkGitStatus(projectPath).hasCommits) {
      execFileSync('git', ['add', '-A'], { cwd: projectPath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'Initial commit', '--allow-empty'], {
        cwd: projectPath,
        stdio: 'ignore',
      });
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to initialize git.',
    };
  }
}

function detectRemoteProvider(projectPath: string): WebRemoteProviderResponse['provider'] {
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const parsed = parseGitRemoteUrl(remoteUrl);
    if (!parsed) {
      return {
        provider: 'unknown',
        remoteUrl,
        host: '',
        baseUrl: '',
        path: '',
        repoPath: '',
      };
    }

    const provider = parsed.host.includes('github.com')
      ? 'github'
      : parsed.host.includes('gitlab')
        ? 'gitlab'
        : parsed.host.includes('gitblit')
          ? 'gitblit'
          : 'unknown';

    return {
      provider,
      remoteUrl,
      host: parsed.host,
      baseUrl: `${parsed.protocol}://${parsed.host}`,
      path: parsed.path,
      repoPath: parsed.path.replace(/\.git$/i, ''),
    };
  } catch {
    return null;
  }
}

function parseGitRemoteUrl(remoteUrl: string): { protocol: string; host: string; path: string } | null {
  try {
    const url = new URL(remoteUrl);
    return {
      protocol: url.protocol.replace(/:$/, '') || 'https',
      host: url.host,
      path: url.pathname.replace(/^\/+/, ''),
    };
  } catch {
    const match = remoteUrl.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (!match) return null;
    return {
      protocol: 'https',
      host: match[1],
      path: match[2],
    };
  }
}

function getChangedFiles(projectPath: string): string[] {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^..?\s+/, '').replace(/^"|"$/g, ''));
  } catch {
    return [];
  }
}

function getFileDiff(projectPath: string, filePath: string): string {
  const relativePath = relative(projectPath, filePath);
  try {
    return execFileSync('git', ['diff', '--', relativePath], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

function updateTask(projectRoot: string, taskId: string, updates: UpdateWebTaskRequest): AutocodeTask {
  const task = findTask(projectRoot, taskId);
  const specDir = getAutocodeSpecDir({ projectRoot, specId: task.specId });
  const plan = loadAutocodeImplementationPlanSync(specDir) as Record<string, unknown> | null ?? {};
  const now = new Date().toISOString();

  if (typeof updates.title === 'string' && updates.title.trim()) {
    plan.feature = updates.title.trim();
    plan.title = updates.title.trim();
  }
  if (typeof updates.description === 'string') {
    plan.description = updates.description;
  }
  plan.updated_at = now;
  saveAutocodeImplementationPlanSync(specDir, plan as never);

  if (isPlainRecord(updates.metadata)) {
    const nextMetadata = {
      ...(task.metadata ?? {}),
      ...updates.metadata,
      taskTitle: typeof updates.title === 'string' && updates.title.trim()
        ? updates.title.trim()
        : task.metadata?.taskTitle ?? task.title,
    };
    writeFileSync(
      join(specDir, AUTOCODE_TASK_ARTIFACTS.taskMetadata),
      `${JSON.stringify(nextMetadata, null, 2)}\n`,
      'utf-8',
    );
  }

  return findTask(projectRoot, taskId);
}

function clearTaskLogs(projectRoot: string, taskId: string) {
  const task = findTask(projectRoot, taskId);
  const existingLogs = loadTaskLogs(projectRoot, task.specId);
  const now = new Date().toISOString();
  const logs = createEmptyAutocodeTaskLogs(task.specId, existingLogs?.created_at ?? now);
  logs.updated_at = now;

  const specDir = getAutocodeSpecDir({ projectRoot, specId: task.specId });
  writeTaskLogsToSpecDir(specDir, logs);

  const worktreePath = findTaskWorktree(projectRoot, task.specId);
  if (worktreePath) {
    writeTaskLogsToSpecDir(getAutocodeSpecDir({ projectRoot: worktreePath, specId: task.specId }), logs);
  }

  return logs;
}

function loadTaskLogs(projectRoot: string, taskId: string): AutocodeTaskLogs | null {
  const task = findTask(projectRoot, taskId);
  const mainSpecDir = getAutocodeSpecDir({ projectRoot, specId: task.specId });
  const mainLogs = readAutocodeTaskLogsFromSpecDir(mainSpecDir, task.specId);

  const worktreePath = findTaskWorktree(projectRoot, task.specId);
  if (!worktreePath) {
    return mainLogs;
  }

  const worktreeLogs = readAutocodeTaskLogsFromSpecDir(
    getAutocodeSpecDir({ projectRoot: worktreePath, specId: task.specId }),
    task.specId,
  );

  return mergeAutocodeTaskLogs(mainLogs, worktreeLogs);
}

function writeTaskLogsToSpecDir(specDir: string, logs: AutocodeTaskLogs): void {
  mkdirSync(specDir, { recursive: true });
  writeFileSync(
    join(specDir, AUTOCODE_TASK_ARTIFACTS.taskLogs),
    serializeAutocodeTaskLogs(logs),
    'utf-8',
  );
}

function findTaskWorktree(projectRoot: string, specId: string): string | null {
  const normalizedProject = resolve(projectRoot);
  for (const candidatePath of getAutocodeTaskWorktreeCandidatePaths(projectRoot, specId)) {
    const resolvedCandidate = resolve(candidatePath);
    if (!isAutocodePathWithinBase(resolvedCandidate, normalizedProject)) {
      return null;
    }
    if (existsSync(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }
  return null;
}

async function deleteTask(projectRoot: string, taskId: string): Promise<void> {
  const task = findTask(projectRoot, taskId);
  const specDir = getAutocodeSpecDir({ projectRoot, specId: task.specId });
  await rm(specDir, { recursive: true, force: true });
}

function deleteSubtask(projectRoot: string, taskId: string, subtaskId: string): AutocodeTask {
  const task = findTask(projectRoot, taskId);
  const specDir = getAutocodeSpecDir({ projectRoot, specId: task.specId });
  const plan = loadAutocodeImplementationPlanSync(specDir) as {
    phases?: Array<{ subtasks?: unknown[]; chunks?: unknown[] }>;
    updated_at?: string;
  } | null ?? {};

  if (Array.isArray(plan.phases)) {
    for (const phase of plan.phases) {
      if (Array.isArray(phase.subtasks)) {
        phase.subtasks = phase.subtasks.filter((subtask) => !hasSubtaskId(subtask, subtaskId));
      }
      if (Array.isArray(phase.chunks)) {
        phase.chunks = phase.chunks.filter((subtask) => !hasSubtaskId(subtask, subtaskId));
      }
    }
  }

  plan.updated_at = new Date().toISOString();
  saveAutocodeImplementationPlanSync(specDir, plan as never);
  return findTask(projectRoot, taskId);
}

function findTask(projectRoot: string, taskId: string): AutocodeTask {
  const task = listAutocodeTasks({ projectRoot })
    .find((candidate) => candidate.id === taskId || candidate.specId === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

function resolveWebTaskCli(cli: StartWebTaskRequest['cli']): AutocodeCli {
  return typeof cli === 'string' && cli.trim()
    ? resolveAutocodeCli(cli, 'codex')
    : 'codex';
}

function deleteMapEntriesByValue(map: Map<string, string>, value: string): void {
  for (const [key, entryValue] of map.entries()) {
    if (entryValue === value) {
      map.delete(key);
    }
  }
}

function hasSubtaskId(value: unknown, subtaskId: string): boolean {
  return isPlainRecord(value) && value.id === subtaskId;
}

function shouldHideFileEntry(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === 'dist' || name === 'out';
}

function getMimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function openInSystemFileManager(filePath: string): void {
  const targetPath = existsSync(filePath) ? filePath : dirname(filePath);
  if (process.platform === 'win32') {
    spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = resolve(candidate);
  const normalizedRoot = resolve(root);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

export function getDistClientDir(importMetaUrl: string): string {
  return resolve(fileURLToPath(new URL('.', importMetaUrl)), '..', 'client');
}

function createTaskMetadata(body: CreateWebTaskRequest): AutocodeTaskMetadata {
  const metadata: AutocodeTaskMetadata = {
    sourceType: body.sourceType === 'project_docs' ? 'project_docs' : 'manual',
    developmentMode: normalizeDevelopmentMode(body.developmentMode),
  };

  if (isSetValue(body.category, WEB_TASK_CATEGORIES)) metadata.category = body.category;
  if (isSetValue(body.complexity, WEB_TASK_COMPLEXITIES)) metadata.complexity = body.complexity;
  if (isSetValue(body.impact, WEB_TASK_IMPACTS)) metadata.impact = body.impact;
  if (isSetValue(body.priority, WEB_TASK_PRIORITIES)) metadata.priority = body.priority;
  if (typeof body.model === 'string' && body.model.trim()) metadata.model = body.model.trim();
  if (typeof body.provider === 'string' && body.provider.trim()) metadata.provider = body.provider.trim();
  if (typeof body.thinkingLevel === 'string' && body.thinkingLevel.trim()) {
    metadata.thinkingLevel = body.thinkingLevel.trim();
  }
  if (typeof body.language === 'string' && body.language.trim()) metadata.language = body.language.trim();
  if (isSetValue(body.projectDocumentType, new Set(['full', 'product', 'architecture', 'technical']))) {
    metadata.projectDocumentType = body.projectDocumentType;
  }
  if (typeof body.projectDocumentOutputDir === 'string' && body.projectDocumentOutputDir.trim()) {
    metadata.projectDocumentOutputDir = body.projectDocumentOutputDir.trim();
  }
  if (Array.isArray(body.projectDocumentOutputs)) {
    metadata.projectDocumentOutputs = body.projectDocumentOutputs.filter((item) => typeof item === 'string' && item.trim());
  }
  if (typeof body.useWorktree === 'boolean') metadata.useWorktree = body.useWorktree;
  if (typeof body.pushNewBranches === 'boolean') metadata.pushNewBranches = body.pushNewBranches;

  return metadata;
}

function normalizeDevelopmentMode(value: unknown): AutocodeTaskDevelopmentMode {
  return WEB_TASK_DEVELOPMENT_MODES.has(value as AutocodeTaskDevelopmentMode)
    ? value as AutocodeTaskDevelopmentMode
    : 'direct';
}

function isSetValue<T extends string>(value: unknown, allowedValues: Set<T>): value is T {
  return typeof value === 'string' && allowedValues.has(value as T);
}
