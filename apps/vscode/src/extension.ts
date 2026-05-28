import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  CORE_PACKAGE_VERSION,
  DEFAULT_PHASE_MODELS,
  SupportedProvider,
  type AutocodeCli,
  type AutocodeTask,
  type AutocodeTaskLogEntry,
  type AutocodeTaskLogs,
  type ProjectIndex,
  type WorkspaceSummary,
} from '@autocode/core';
import { createNotificationAdapter } from './adapters/notification-adapter.js';
import { bindTerminalLifecycle, createTerminalAdapter } from './adapters/terminal-adapter.js';
import { createWorkspaceAdapter, getConfiguredDataDirName } from './adapters/workspace-adapter.js';
import {
  buildRunCommand,
  createManualTask,
  createRunPlan,
  listState,
  markTaskLogFailed,
  markTaskStatus,
} from './services/task-service.js';

const VIEW_TYPE = 'autocode.panel';
const SIDEBAR_VIEW_ID = 'autocode.sidebar';

const workspaceAdapter = createWorkspaceAdapter();
const terminalAdapter = createTerminalAdapter();
const notificationAdapter = createNotificationAdapter();

export function activate(context: vscode.ExtensionContext): void {
  const sidebarProvider = new AutocodeSidebarProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('autocode.openPanel', () => {
      openAutocodePanel(context.extensionUri);
    }),
    vscode.commands.registerCommand('autocode.showCoreInfo', async () => {
      await notificationAdapter.info(getCoreInfoMessage());
    }),
    vscode.commands.registerCommand('autocode.refreshWorkspace', async () => {
      sidebarProvider.refresh('Workspace refreshed');
    }),
    vscode.commands.registerCommand('autocode.createTask', async () => {
      await createTaskFromInput(sidebarProvider);
    }),
    vscode.commands.registerCommand('autocode.openTaskFolder', async (taskId?: unknown) => {
      await openTaskFolder(typeof taskId === 'string' ? taskId : undefined);
    }),
    vscode.commands.registerCommand('autocode.openPlanFile', async (taskId?: unknown) => {
      await openPlanFile(typeof taskId === 'string' ? taskId : undefined);
    }),
    vscode.commands.registerCommand('autocode.openLogFile', async (taskId?: unknown) => {
      await openTaskArtifact(typeof taskId === 'string' ? taskId : undefined, 'task_logs.json', false);
    }),
    vscode.commands.registerCommand('autocode.openRunResult', async (taskId?: unknown) => {
      await openTaskArtifact(typeof taskId === 'string' ? taskId : undefined, 'autocode-run-result.json', true);
    }),
    vscode.commands.registerCommand('autocode.startTask', async (taskId?: unknown) => {
      await startTaskInTerminal(typeof taskId === 'string' ? taskId : undefined, sidebarProvider);
    }),
    vscode.commands.registerCommand('autocode.stopTask', async (taskId?: unknown) => {
      await stopTask(typeof taskId === 'string' ? taskId : undefined, sidebarProvider);
    }),
    vscode.commands.registerCommand('autocode.markTaskDone', async (taskId?: unknown) => {
      await markTaskDone(typeof taskId === 'string' ? taskId : undefined, sidebarProvider);
    }),
    vscode.commands.registerCommand('autocode.requestTaskChanges', async (taskId?: unknown) => {
      await requestTaskChanges(typeof taskId === 'string' ? taskId : undefined, sidebarProvider);
    }),
    bindTerminalLifecycle((name: string) => {
      sidebarProvider.refresh(`Terminal closed: ${name.replace(/^Autocode:\s*/, '')}`);
    }),
  );

  void workspaceAdapter.watchProjectData(() => {
    sidebarProvider.refresh('Task files changed');
  }).then((dispose: () => void) => context.subscriptions.push({ dispose }));
}

export function deactivate(): void {}

class AutocodeSidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private messageSubscription: vscode.Disposable | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = getWebviewOptions(this.extensionUri);
    this.messageSubscription?.dispose();
    this.messageSubscription = webviewView.webview.onDidReceiveMessage((message) => {
      void handleWebviewMessage(message, this);
    });
    this.render('Ready inside VS Code');
  }

  refresh(status = 'Workspace refreshed'): void {
    this.render(status);
  }

  private render(status: string): void {
    if (!this.view) {
      return;
    }

    const state = getActiveAutocodeState();
    this.view.webview.html = renderAutocodeHtml({
      title: 'Autocode',
      status,
      state,
      commandHint: 'Tasks are stored in the project data directory and are visible to the desktop app.',
    });
  }
}

function openAutocodePanel(extensionUri: vscode.Uri): void {
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    'Autocode',
    vscode.ViewColumn.One,
    getWebviewOptions(extensionUri),
  );

  panel.webview.onDidReceiveMessage((message) => {
    void handleWebviewMessage(message);
  });
  panel.webview.html = renderAutocodeHtml({
    title: 'Autocode',
    status: 'VS Code extension host is connected',
    state: getActiveAutocodeState(),
    commandHint: 'Use the Autocode sidebar for the persistent workspace view.',
  });
}

function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
  };
}

async function handleWebviewMessage(message: unknown, sidebarProvider?: AutocodeSidebarProvider): Promise<void> {
  if (!message || typeof message !== 'object') {
    return;
  }

  const command = (message as { command?: unknown }).command;
  const taskId = (message as { taskId?: unknown }).taskId;
  switch (command) {
    case 'createTask':
      await createTaskFromInput(sidebarProvider);
      break;
    case 'refreshWorkspace':
      sidebarProvider?.refresh('Workspace refreshed');
      break;
    case 'openPanel':
      await vscode.commands.executeCommand('autocode.openPanel');
      break;
    case 'openTaskFolder':
      await openTaskFolder(typeof taskId === 'string' ? taskId : undefined);
      break;
    case 'openPlanFile':
      await openPlanFile(typeof taskId === 'string' ? taskId : undefined);
      break;
    case 'openLogFile':
      await openTaskArtifact(typeof taskId === 'string' ? taskId : undefined, 'task_logs.json', false);
      break;
    case 'openRunResult':
      await openTaskArtifact(typeof taskId === 'string' ? taskId : undefined, 'autocode-run-result.json', true);
      break;
    case 'startTask':
      await startTaskInTerminal(typeof taskId === 'string' ? taskId : undefined, sidebarProvider);
      break;
    case 'stopTask':
      await stopTask(typeof taskId === 'string' ? taskId : undefined, sidebarProvider);
      break;
    case 'markTaskDone':
      await markTaskDone(typeof taskId === 'string' ? taskId : undefined, sidebarProvider);
      break;
    case 'requestTaskChanges':
      await requestTaskChanges(typeof taskId === 'string' ? taskId : undefined, sidebarProvider);
      break;
  }
}

function getCoreInfoMessage(): string {
  const providers = Object.values(SupportedProvider).join(', ');
  return `Autocode core ${CORE_PACKAGE_VERSION}; default coding model ${DEFAULT_PHASE_MODELS.coding}; providers: ${providers}`;
}

interface ActiveAutocodeState {
  projectRoot: string | null;
  dataDirName: string;
  summary: WorkspaceSummary | null;
  projectIndex: ProjectIndex | null;
  tasks: AutocodeTask[];
  logsByTaskId: Record<string, AutocodeTaskLogs | null>;
}

function getActiveAutocodeState(): ActiveAutocodeState {
  const projectRoot = getActiveProjectRootSync();
  if (!projectRoot) {
    return {
      projectRoot: null,
      dataDirName: getConfiguredDataDirName(),
      summary: null,
      projectIndex: null,
      tasks: [],
      logsByTaskId: {},
    };
  }

  return listState(projectRoot);
}

function getActiveProjectRootSync(): string | null {
  const configuredPath = vscode.workspace
    .getConfiguration('autocode')
    .get<string>('projectPath', '')
    ?.trim();
  return configuredPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

function getConfiguredCli(): AutocodeCli {
  const configured = vscode.workspace
    .getConfiguration('autocode')
    .get<string>('preferredCLI', 'claude-code');
  return isAutocodeCli(configured) ? configured : 'claude-code';
}

function getConfiguredBypassPermissions(): boolean {
  return vscode.workspace
    .getConfiguration('autocode')
    .get<boolean>('bypassPermissions', false) === true;
}

function getConfiguredCustomCliCommand(): string | undefined {
  return vscode.workspace
    .getConfiguration('autocode')
    .get<string>('customCLICommand', '')
    ?.trim() || undefined;
}

async function createTaskFromInput(sidebarProvider?: AutocodeSidebarProvider): Promise<void> {
  const projectRoot = getActiveProjectRootSync();
  if (!projectRoot) {
    await notificationAdapter.error('Open a workspace folder before creating an Autocode task.');
    return;
  }

  const title = await vscode.window.showInputBox({
    title: 'Create Autocode Task',
    prompt: 'Task title. Leave blank to use the first line of the description.',
    placeHolder: 'Example: Add provider profile settings',
    ignoreFocusOut: true,
  });

  if (title === undefined) {
    return;
  }

  const description = await vscode.window.showInputBox({
    title: 'Task Description',
    prompt: 'Describe the task, acceptance criteria, files, or constraints.',
    placeHolder: 'Implement the settings screen and add focused tests.',
    ignoreFocusOut: true,
  });

  if (!description?.trim()) {
    return;
  }

  try {
    const task = createManualTask(projectRoot, title, description);
    sidebarProvider?.refresh(`Created ${task.specId}`);
    await notificationAdapter.info(`Autocode task created: ${task.title}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create Autocode task.';
    await notificationAdapter.error(message);
  }
}

async function openTaskFolder(taskId?: string): Promise<void> {
  const task = resolveTask(taskId);
  if (!task) {
    await notificationAdapter.error('Select or create an Autocode task first.');
    return;
  }

  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(task.specsPath));
}

async function openPlanFile(taskId?: string): Promise<void> {
  await openTaskArtifact(taskId, 'implementation_plan.json', false);
}

async function openTaskArtifact(taskId: string | undefined, fileName: string, optional: boolean): Promise<void> {
  const task = resolveTask(taskId);
  if (!task) {
    await notificationAdapter.error('Select or create an Autocode task first.');
    return;
  }

  const filePath = path.join(task.specsPath, fileName);
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document, { preview: false });
  } catch (error) {
    if (optional) {
      await notificationAdapter.info(`${fileName} has not been created for this task yet.`);
      return;
    }
    const message = error instanceof Error ? error.message : `Failed to open ${fileName}.`;
    await notificationAdapter.error(message);
  }
}

async function startTaskInTerminal(taskId: string | undefined, sidebarProvider?: AutocodeSidebarProvider): Promise<void> {
  const projectRoot = getActiveProjectRootSync();
  if (!projectRoot) {
    await notificationAdapter.error('Open a workspace folder before starting an Autocode task.');
    return;
  }

  const task = resolveTask(taskId);
  if (!task) {
    await notificationAdapter.error('Select or create an Autocode task first.');
    return;
  }

  try {
    const plan = createRunPlan(projectRoot, task.id, {
      cli: getConfiguredCli(),
      customCommand: getConfiguredCustomCliCommand(),
      bypassPermissions: getConfiguredBypassPermissions(),
    });
    markTaskStatus(projectRoot, task.id, {
      planStatus: plan.planStatus,
      executionPhase: plan.executionPhase,
    });
    await terminalAdapter.runCommand({
      name: `Autocode: ${plan.task.specId}`,
      cwd: plan.cwd,
      command: buildRunCommand(plan),
    });
    sidebarProvider?.refresh(`Started ${plan.task.specId} (${plan.phase})`);
    await notificationAdapter.info(`Started Autocode task in terminal: ${plan.task.title}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start Autocode task.';
    await notificationAdapter.error(message);
  }
}

async function stopTask(taskId: string | undefined, sidebarProvider?: AutocodeSidebarProvider): Promise<void> {
  const projectRoot = getActiveProjectRootSync();
  const task = resolveTask(taskId);
  if (!projectRoot || !task) {
    await notificationAdapter.error('Select or create an Autocode task first.');
    return;
  }

  await terminalAdapter.dispose?.(`Autocode: ${task.specId}`);

  try {
    markTaskStatus(projectRoot, task.id, {
      planStatus: 'human_review',
      reviewReason: 'stopped',
      executionPhase: 'stopped',
    });
    markTaskLogFailed(projectRoot, task.id, task.executionPhase === 'coding' ? 'coding' : 'planning');
    sidebarProvider?.refresh(`Stopped ${task.specId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to stop task.';
    await notificationAdapter.error(message);
  }
}

async function markTaskDone(taskId: string | undefined, sidebarProvider?: AutocodeSidebarProvider): Promise<void> {
  const projectRoot = getActiveProjectRootSync();
  const task = resolveTask(taskId);
  if (!projectRoot || !task) {
    await notificationAdapter.error('Select or create an Autocode task first.');
    return;
  }

  try {
    const updated = markTaskStatus(projectRoot, task.id, {
      planStatus: 'done',
      executionPhase: 'complete',
    });
    sidebarProvider?.refresh(`Marked done: ${updated.specId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to mark task done.';
    await notificationAdapter.error(message);
  }
}

async function requestTaskChanges(taskId: string | undefined, sidebarProvider?: AutocodeSidebarProvider): Promise<void> {
  const projectRoot = getActiveProjectRootSync();
  const task = resolveTask(taskId);
  if (!projectRoot || !task) {
    await notificationAdapter.error('Select or create an Autocode task first.');
    return;
  }

  try {
    const updated = markTaskStatus(projectRoot, task.id, {
      planStatus: 'human_review',
      reviewReason: 'qa_rejected',
      executionPhase: 'review',
    });
    sidebarProvider?.refresh(`Requested changes: ${updated.specId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to request task changes.';
    await notificationAdapter.error(message);
  }
}

function resolveTask(taskId?: string): AutocodeTask | null {
  const state = getActiveAutocodeState();
  if (state.tasks.length === 0) {
    return null;
  }
  return taskId ? state.tasks.find((task) => task.id === taskId || task.specId === taskId) ?? null : state.tasks[0];
}

function isAutocodeCli(value: unknown): value is AutocodeCli {
  return (
    value === 'claude-code' ||
    value === 'gemini' ||
    value === 'opencode' ||
    value === 'kilocode' ||
    value === 'codex' ||
    value === 'deepseek' ||
    value === 'custom'
  );
}

function renderAutocodeHtml(input: {
  title: string;
  status: string;
  state: ActiveAutocodeState;
  commandHint: string;
}): string {
  const providers = Object.values(SupportedProvider);
  const providerItems = providers.map((provider) => `<li>${escapeHtml(provider)}</li>`).join('');
  const workspaceHtml = input.state.summary ? renderWorkspaceSummary(input.state.summary, input.state.projectIndex) : renderNoWorkspace();
  const tasksHtml = renderTasks(input.state);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }

    body {
      margin: 0;
      padding: 16px;
    }

    h1 {
      margin: 0 0 10px;
      font-size: 18px;
      font-weight: 600;
    }

    h2 {
      margin: 0 0 8px;
      font-size: 13px;
      font-weight: 700;
      color: var(--vscode-foreground);
    }

    .status {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }

    .section {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 12px 0 16px;
    }

    button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      padding: 5px 9px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
      font: inherit;
    }

    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    button.link {
      padding: 0;
      border: 0;
      color: var(--vscode-textLink-foreground);
      background: transparent;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button.link:hover {
      background: transparent;
      text-decoration: underline;
    }

    .label {
      margin: 0 0 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }

    .grid {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 6px 10px;
    }

    .key {
      color: var(--vscode-descriptionForeground);
    }

    .value {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .task {
      padding: 9px 0;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .task:first-child {
      border-top: 0;
    }

    .task-title {
      margin: 0 0 5px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }

    .task-meta,
    .task-desc,
    .hint {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .task-desc {
      margin: 6px 0;
      line-height: 1.4;
    }

    .task-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 7px;
    }

    .task-log,
    .task-log-empty {
      margin-top: 7px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .task-log ul {
      margin-top: 4px;
    }

    code {
      color: var(--vscode-textLink-foreground);
    }

    ul {
      margin: 6px 0 0;
      padding-left: 18px;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(input.title)}</h1>
  <p class="status">${escapeHtml(input.status)}</p>

  <div class="actions">
    <button type="button" data-command="createTask">Create Task</button>
    <button type="button" class="secondary" data-command="startTask">Start Latest</button>
    <button type="button" class="secondary" data-command="stopTask">Stop Latest</button>
    <button type="button" class="secondary" data-command="refreshWorkspace">Refresh</button>
    <button type="button" class="secondary" data-command="openPanel">Open Panel</button>
  </div>

  ${workspaceHtml}
  ${tasksHtml}

  <div class="section">
    <p class="label">Shared Core</p>
    <div><code>@autocode/core</code> ${escapeHtml(CORE_PACKAGE_VERSION)}</div>
  </div>

  <div class="section">
    <p class="label">Default Phase Models</p>
    <div class="grid">
      <span class="key">Spec</span><code class="value">${escapeHtml(DEFAULT_PHASE_MODELS.spec)}</code>
      <span class="key">Planning</span><code class="value">${escapeHtml(DEFAULT_PHASE_MODELS.planning)}</code>
      <span class="key">Coding</span><code class="value">${escapeHtml(DEFAULT_PHASE_MODELS.coding)}</code>
      <span class="key">QA</span><code class="value">${escapeHtml(DEFAULT_PHASE_MODELS.qa)}</code>
    </div>
  </div>

  <div class="section">
    <p class="label">Providers</p>
    <ul>${providerItems}</ul>
  </div>

  <div class="section">
    <p class="hint">${escapeHtml(input.commandHint)}</p>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({
          command: button.getAttribute('data-command'),
          taskId: button.getAttribute('data-task-id')
        });
      });
    });
  </script>
</body>
</html>`;
}

function renderWorkspaceSummary(summary: WorkspaceSummary, projectIndex: ProjectIndex | null): string {
  const sourceFiles = projectIndex?.source_summary?.source_file_count;
  const services = projectIndex ? Object.values(projectIndex.services) : [];
  return `<div class="section">
    <p class="label">Workspace</p>
    <div class="grid">
      <span class="key">Name</span><strong class="value">${escapeHtml(summary.name)}</strong>
      <span class="key">Path</span><code class="value">${escapeHtml(summary.rootPath)}</code>
      <span class="key">Package</span><span class="value">${escapeHtml(summary.packageName ?? 'Not detected')}</span>
      <span class="key">Manager</span><span class="value">${escapeHtml(summary.packageManager ?? 'Not detected')}</span>
      <span class="key">Git</span><span class="value">${summary.hasGit ? 'Yes' : 'No'}</span>
      <span class="key">Languages</span><span class="value">${escapeHtml(formatList(summary.detectedLanguages))}</span>
      <span class="key">Frameworks</span><span class="value">${escapeHtml(formatList(summary.detectedFrameworks))}</span>
      <span class="key">Scripts</span><span class="value">${escapeHtml(formatList(summary.scripts.slice(0, 8)))}</span>
      <span class="key">Sampled</span><span class="value">${summary.totalFilesSampled} files</span>
      <span class="key">Project</span><span class="value">${escapeHtml(projectIndex?.project_type ?? 'Not detected')}</span>
      <span class="key">Services</span><span class="value">${escapeHtml(formatServiceList(services))}</span>
      <span class="key">Source</span><span class="value">${sourceFiles ?? 'Not detected'} files</span>
    </div>
  </div>`;
}

function renderNoWorkspace(): string {
  return `<div class="section">
    <p class="label">Workspace</p>
    <p class="status">Open a folder in VS Code or set <code>autocode.projectPath</code>.</p>
  </div>`;
}

function renderTasks(state: ActiveAutocodeState): string {
  if (!state.projectRoot) {
    return '';
  }

  const header = `<p class="label">Tasks</p>
    <div class="hint"><code>${escapeHtml(path.join(state.dataDirName, 'specs'))}</code></div>`;
  const body = state.tasks.length > 0
    ? state.tasks.map((task) => renderTask(task, state.logsByTaskId[task.id] ?? null)).join('')
    : '<p class="status">No Autocode tasks yet. Create one to write the shared task files.</p>';

  return `<div class="section">
    ${header}
    ${body}
  </div>`;
}

function renderTask(task: AutocodeTask, logs: AutocodeTaskLogs | null): string {
  const meta = [
    task.specId,
    task.status,
    task.reviewReason,
    `${task.subtasks.length} subtasks`,
    formatDate(task.updatedAt),
  ].filter(Boolean).join(' | ');
  const description = task.description ? `<p class="task-desc">${escapeHtml(truncate(task.description, 180))}</p>` : '';
  const logsHtml = renderTaskLogs(logs);

  return `<div class="task">
    <p class="task-title">${escapeHtml(task.title)}</p>
    <div class="task-meta">${escapeHtml(meta)}</div>
    ${description}
    ${logsHtml}
    <div class="task-actions">
      <button type="button" class="link" data-command="startTask" data-task-id="${escapeHtml(task.id)}">Start</button>
      <button type="button" class="link" data-command="stopTask" data-task-id="${escapeHtml(task.id)}">Stop</button>
      <button type="button" class="link" data-command="openPlanFile" data-task-id="${escapeHtml(task.id)}">Open plan</button>
      <button type="button" class="link" data-command="openLogFile" data-task-id="${escapeHtml(task.id)}">Open logs</button>
      <button type="button" class="link" data-command="openRunResult" data-task-id="${escapeHtml(task.id)}">Open result</button>
      <button type="button" class="link" data-command="openTaskFolder" data-task-id="${escapeHtml(task.id)}">Reveal folder</button>
      <button type="button" class="link" data-command="markTaskDone" data-task-id="${escapeHtml(task.id)}">Mark done</button>
      <button type="button" class="link" data-command="requestTaskChanges" data-task-id="${escapeHtml(task.id)}">Request changes</button>
    </div>
  </div>`;
}

function renderTaskLogs(logs: AutocodeTaskLogs | null): string {
  if (!logs) {
    return '<div class="task-log-empty">No task logs yet.</div>';
  }

  const phaseMeta = (['planning', 'coding', 'validation'] as const)
    .map((phase) => `${phase}: ${logs.phases[phase].status}`)
    .join(' | ');
  const latestEntries = collectLatestLogEntries(logs, 3);
  const entriesHtml = latestEntries.length > 0
    ? latestEntries.map((entry) => `<li><span>${escapeHtml(formatDate(entry.timestamp))}</span> <strong>${escapeHtml(entry.phase)}</strong> ${escapeHtml(truncate(entry.content, 140))}</li>`).join('')
    : '<li>No entries yet.</li>';

  return `<div class="task-log">
    <div class="task-meta">${escapeHtml(phaseMeta)}</div>
    <ul>${entriesHtml}</ul>
  </div>`;
}

function collectLatestLogEntries(logs: AutocodeTaskLogs, maxEntries: number): AutocodeTaskLogEntry[] {
  return Object.values(logs.phases)
    .flatMap((phase) => phase.entries)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, maxEntries);
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'Not detected';
}

function formatServiceList(services: ProjectIndex['services'][string][]): string {
  if (services.length === 0) {
    return 'Not detected';
  }
  return services
    .slice(0, 5)
    .map((service) => service.language ? `${service.name} (${service.language})` : service.name)
    .join(', ');
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
