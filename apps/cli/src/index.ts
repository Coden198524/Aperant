#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  CORE_PACKAGE_VERSION,
  AUTOCODE_PROJECT_DATA_DIR_NAME,
  DEFAULT_AUTOCODE_CLI,
  DEFAULT_PHASE_MODELS,
  SUPPORTED_AUTOCODE_CLIS,
  SupportedProvider,
  buildAutocodeWorkspaceState,
  buildAutocodeTaskCardViewModel,
  buildAutocodeTaskLogEntryViewModel,
  buildAutocodeWorkspaceSummaryViewModel,
  buildProjectIndex,
  createProcessAgentRuntimeAdapter,
  createAutocodeTaskFromOpenSpecChange,
  createAutocodeProjectDocumentationTask,
  createManualAutocodeTask,
  createStartedAutocodeAgentRuntime,
  createStartedAutocodeTaskRun,
  formatAutocodeProjectDocTypeList,
  getAutocodeBooleanOption,
  getAutocodeStringOption,
  hasAutocodeJsonOption,
  isAutocodeProjectDocType,
  isAutocodeTaskDevelopmentMode,
  isAutocodeCli,
  listOpenSpecChanges,
  markAutocodeTaskDone,
  parseAutocodeCommandArgs,
  readAutocodeTaskLogs,
  requestAutocodeTaskChanges,
  summarizeWorkspace,
  startAutocodeAgentRuntime,
  type AutocodeCli,
  type NotificationAdapter,
  type ProcessAdapter,
  type AutocodeTask,
  type AutocodeTaskDevelopmentMode,
  type AutocodeProjectDocType,
  type AutocodeTaskLogEntry,
  type AutocodeTaskLogs,
  type ParsedAutocodeCommandArgs,
} from '@autocode/core';

const DEFAULT_DATA_DIR = AUTOCODE_PROJECT_DATA_DIR_NAME;
const DEFAULT_CLI: AutocodeCli = DEFAULT_AUTOCODE_CLI;

async function main(): Promise<void> {
  const parsed = parseAutocodeCommandArgs(process.argv.slice(2));

  switch (parsed.command) {
    case 'help':
      printHelp();
      return;
    case 'info':
    case 'status':
      showInfo(parsed);
      return;
    case 'tasks':
    case 'list':
      listTasks(parsed);
      return;
    case 'create':
    case 'create-task':
      createTask(parsed);
      return;
    case 'docs':
    case 'project-docs':
      createProjectDocsTask(parsed);
      return;
    case 'openspec':
    case 'open-spec':
      createOpenSpecTaskOrList(parsed);
      return;
    case 'run':
    case 'start':
      await runTask(parsed);
      return;
    case 'done':
      markDone(parsed);
      return;
    case 'changes':
    case 'request-changes':
      requestChanges(parsed);
      return;
    case 'logs':
      showLogs(parsed);
      return;
    default:
      throw new Error(`Unknown command: ${parsed.command}. Run "autocode help" for usage.`);
  }
}

function showInfo(parsed: ParsedAutocodeCommandArgs): void {
  const context = resolveContext(parsed);
  const state = buildAutocodeWorkspaceState(context);
  const summary = state.summary ?? summarizeWorkspace(context.projectRoot);
  const projectIndex = state.projectIndex ?? buildProjectIndex(context.projectRoot);
  const providers = Object.values(SupportedProvider);
  const payload = {
    coreVersion: CORE_PACKAGE_VERSION,
    projectRoot: context.projectRoot,
    dataDirName: context.dataDirName,
    defaultPhaseModels: DEFAULT_PHASE_MODELS,
    providers,
    summary,
    projectIndex,
  };

  if (isJson(parsed)) {
    writeJson(payload);
    return;
  }

  const workspaceView = buildAutocodeWorkspaceSummaryViewModel(summary, projectIndex);
  console.log(`Autocode core: ${CORE_PACKAGE_VERSION}`);
  console.log(`Project root: ${context.projectRoot}`);
  console.log(`Data dir: ${context.dataDirName}`);
  console.log(`Workspace: ${workspaceView.name}`);
  console.log(`Package manager: ${workspaceView.packageManagerLabel}`);
  console.log(`Languages: ${workspaceView.languagesLabel}`);
  console.log(`Frameworks: ${workspaceView.frameworksLabel}`);
  console.log(`Project type: ${workspaceView.projectTypeLabel}`);
  console.log(`Services: ${workspaceView.servicesLabel}`);
  console.log(`Source files: ${workspaceView.sourceFilesLabel}`);
  console.log(`Default coding model: ${DEFAULT_PHASE_MODELS.coding}`);
  console.log(`Providers: ${providers.join(', ')}`);
}

function listTasks(parsed: ParsedAutocodeCommandArgs): void {
  const context = resolveContext(parsed);
  const tasks = buildAutocodeWorkspaceState({ ...context, includeLogs: false }).tasks;

  if (isJson(parsed)) {
    writeJson({ ...context, tasks });
    return;
  }

  if (tasks.length === 0) {
    console.log(`No Autocode tasks found in ${path.join(context.dataDirName, 'specs')}.`);
    return;
  }

  for (const task of tasks) {
    const taskView = buildAutocodeTaskCardViewModel(task, null, { descriptionMaxLength: 140 });
    console.log(`[${taskView.status}] ${taskView.specId} - ${taskView.title}`);
    if (taskView.reviewReason) {
      console.log(`  review: ${taskView.reviewReason}`);
    }
    console.log(`  subtasks: ${taskView.subtaskCount}; updated: ${taskView.updatedAtLabel}`);
    if (taskView.descriptionPreview) {
      console.log(`  ${taskView.descriptionPreview}`);
    }
  }
}

function createTask(parsed: ParsedAutocodeCommandArgs): void {
  const context = resolveContext(parsed);
  const titleFromOption = getStringOption(parsed, 'title');
  const title = titleFromOption ?? parsed.positionals[0] ?? '';
  const description = getStringOption(parsed, 'description')
    ?? getStringOption(parsed, 'desc')
    ?? (titleFromOption ? parsed.positionals.join(' ') : parsed.positionals.slice(1).join(' '));

  if (!description.trim()) {
    throw new Error('Task description is required. Pass --description or a second positional argument.');
  }

  const developmentMode = getDevelopmentModeOption(parsed);
  const task = createManualAutocodeTask({
    ...context,
    title,
    description,
    metadata: { developmentMode },
  });

  if (isJson(parsed)) {
    writeJson(task);
    return;
  }

  console.log(`Created ${task.specId}: ${task.title}`);
  console.log(`Mode: ${task.metadata?.developmentMode ?? developmentMode}`);
  if (task.metadata?.openSpecChangeDir) {
    console.log(`OpenSpec: ${task.metadata.openSpecChangeDir}`);
  }
  console.log(`Autocode spec dir: ${task.specsPath}`);
}

function createProjectDocsTask(parsed: ParsedAutocodeCommandArgs): void {
  const context = resolveContext(parsed);
  const action = parsed.positionals[0] ?? 'generate';
  if (action === 'list-types' || action === 'types') {
    if (isJson(parsed)) {
      writeJson({ types: formatAutocodeProjectDocTypeList().split(', ') });
      return;
    }
    console.log(`Project document types: ${formatAutocodeProjectDocTypeList()}`);
    return;
  }
  if (action !== 'generate' && action !== 'create') {
    throw new Error('Unsupported docs command. Use "autocode docs generate" or "autocode docs types".');
  }

  const rawType = getStringOption(parsed, 'type')
    ?? getStringOption(parsed, 'doc-type')
    ?? parsed.positionals[1]
    ?? 'full';
  if (!isAutocodeProjectDocType(rawType)) {
    throw new Error(`Unsupported project document type "${rawType}". Supported values: ${formatAutocodeProjectDocTypeList()}.`);
  }
  const documentType: AutocodeProjectDocType = rawType;
  const outputDir = getStringOption(parsed, 'output-dir') ?? getStringOption(parsed, 'output');
  const result = createAutocodeProjectDocumentationTask({
    ...context,
    documentType,
    outputDir,
    title: getStringOption(parsed, 'title'),
  });

  if (isJson(parsed)) {
    writeJson({
      ...context,
      task: result.task,
      documentType,
      outputDir: result.plan.outputDir,
      outputs: result.plan.outputs,
    });
    return;
  }

  console.log(`Created project documentation task ${result.task.specId}: ${result.task.title}`);
  console.log(`Spec dir: ${result.task.specsPath}`);
  console.log('Outputs:');
  for (const output of result.plan.outputs) {
    console.log(`  - ${output.relativePath}`);
  }
  console.log(`Run: autocode run ${result.task.specId} --runtime agent --execute`);
}

function createOpenSpecTaskOrList(parsed: ParsedAutocodeCommandArgs): void {
  const context = resolveContext(parsed);
  const action = parsed.positionals[0] ?? 'list';
  if (action === 'list' || action === 'changes') {
    const changes = listOpenSpecChanges(context.projectRoot);
    if (isJson(parsed)) {
      writeJson({ ...context, changes });
      return;
    }
    if (changes.length === 0) {
      console.log('No OpenSpec changes found in openspec/changes.');
      return;
    }
    console.log('OpenSpec changes:');
    for (const change of changes) {
      console.log(`  - ${change}`);
    }
    return;
  }

  if (action !== 'import' && action !== 'create' && action !== 'create-task') {
    throw new Error('Unsupported openspec command. Use "autocode openspec list" or "autocode openspec import <change-id>".');
  }

  const changeId = getStringOption(parsed, 'change')
    ?? getStringOption(parsed, 'change-id')
    ?? parsed.positionals[1];
  const changeDir = getStringOption(parsed, 'change-dir')
    ?? getStringOption(parsed, 'dir');
  if (!changeId?.trim() && !changeDir?.trim()) {
    throw new Error('OpenSpec change id is required. Use "autocode openspec import <change-id>".');
  }

  const result = createAutocodeTaskFromOpenSpecChange({
    ...context,
    changeId,
    changeDir,
    title: getStringOption(parsed, 'title'),
    specId: getStringOption(parsed, 'spec-id') ?? getStringOption(parsed, 'specId'),
    overwrite: getBooleanOption(parsed, 'overwrite'),
  });

  if (isJson(parsed)) {
    writeJson({
      ...context,
      task: result.task,
      change: {
        changeId: result.change.changeId,
        changeDir: result.change.relativeChangeDir,
        proposal: result.change.proposal?.relativePath,
        design: result.change.design?.relativePath,
        tasks: result.change.tasks?.relativePath,
        specDeltas: result.change.specDeltas.map((delta) => ({
          capability: delta.capability,
          path: delta.relativePath,
        })),
      },
    });
    return;
  }

  console.log(`Created OpenSpec execution task ${result.task.specId}: ${result.task.title}`);
  console.log(`Upstream change: ${result.change.relativeChangeDir}`);
  console.log(`Spec dir: ${result.task.specsPath}`);
  console.log(`Run: autocode run ${result.task.specId} --runtime agent --execute`);
}

async function runTask(parsed: ParsedAutocodeCommandArgs): Promise<void> {
  const context = resolveContext(parsed);
  const taskId = resolveTaskId(parsed);
  const runtime = getStringOption(parsed, 'runtime') ?? 'file';
  if (runtime === 'agent') {
    const cli = resolveCli(getStringOption(parsed, 'cli') ?? DEFAULT_CLI);
    const customCommand = getStringOption(parsed, 'custom-command') ?? getStringOption(parsed, 'custom');
    const started = createStartedAutocodeAgentRuntime({
      ...context,
      taskId,
      cli,
      customCommand,
      bypassPermissions: getBooleanOption(parsed, 'bypass-permissions'),
    });
    const runtimePlan = started.runtimePlan;
    const request = started.request;
    const payload = {
      ...context,
      runtime: 'agent',
      runtimePlan,
      task: started.task,
      phase: started.taskRunPlan.phase,
      command: started.command,
      request,
      plan: started.taskRunPlan,
    };

    if (isJson(parsed)) {
      writeJson(payload);
    } else {
      console.log(request.messages.prepared);
      console.log(`Spec dir: ${runtimePlan.specDir}`);
      console.log(`Prompt: ${started.taskRunPlan.promptFilePath}`);
      console.log(`Runner: ${started.taskRunPlan.runnerFilePath}`);
      console.log(`Command: ${started.command}`);
    }

    if (getBooleanOption(parsed, 'execute')) {
      const adapter = createProcessAgentRuntimeAdapter({
        process: createCliProcessAdapter(),
        notification: isJson(parsed) ? undefined : createCliNotificationAdapter(),
      });
      await startAutocodeAgentRuntime(request, adapter);
    }
    return;
  }
  if (runtime !== 'file') {
    throw new Error(`Unsupported runtime "${runtime}". Supported values: file, agent.`);
  }

  const cli = resolveCli(getStringOption(parsed, 'cli') ?? DEFAULT_CLI);
  const customCommand = getStringOption(parsed, 'custom-command') ?? getStringOption(parsed, 'custom');
  const started = createStartedAutocodeTaskRun({
    ...context,
    taskId,
    cli,
    customCommand,
    bypassPermissions: getBooleanOption(parsed, 'bypass-permissions'),
  });
  const plan = started.plan;
  const updated = started.task;
  const command = started.command;
  const payload = { ...context, task: updated, phase: plan.phase, command, plan };

  if (isJson(parsed)) {
    writeJson(payload);
  } else {
    console.log(`Prepared ${plan.task.specId} (${plan.phase}).`);
    console.log(`Prompt: ${plan.promptFilePath}`);
    console.log(`Runner: ${plan.runnerFilePath}`);
    console.log(`Command: ${command}`);
  }

  if (getBooleanOption(parsed, 'execute')) {
    const result = spawnSync('node', [plan.runnerFilePath], {
      cwd: plan.cwd,
      stdio: 'inherit',
    });
    process.exitCode = result.status ?? 1;
  }
}

function markDone(parsed: ParsedAutocodeCommandArgs): void {
  const context = resolveContext(parsed);
  const task = markAutocodeTaskDone({
    ...context,
    taskId: resolveTaskId(parsed),
  });
  printTaskUpdate(parsed, 'Marked done', task);
}

function requestChanges(parsed: ParsedAutocodeCommandArgs): void {
  const context = resolveContext(parsed);
  const task = requestAutocodeTaskChanges({
    ...context,
    taskId: resolveTaskId(parsed),
  });
  printTaskUpdate(parsed, 'Requested changes', task);
}

function showLogs(parsed: ParsedAutocodeCommandArgs): void {
  const context = resolveContext(parsed);
  const taskId = resolveTaskId(parsed);
  const logs = readAutocodeTaskLogs({ ...context, taskId });

  if (isJson(parsed)) {
    writeJson({ ...context, taskId, logs });
    return;
  }

  if (!logs) {
    console.log(`No logs found for ${taskId}.`);
    return;
  }

  printLogs(logs);
}

function printTaskUpdate(parsed: ParsedAutocodeCommandArgs, label: string, task: AutocodeTask): void {
  if (isJson(parsed)) {
    writeJson(task);
    return;
  }
  console.log(`${label}: ${task.specId} (${task.status})`);
}

function printLogs(logs: AutocodeTaskLogs): void {
  console.log(`Logs for ${logs.spec_id}`);
  for (const phase of ['planning', 'coding', 'validation'] as const) {
    const phaseLog = logs.phases[phase];
    console.log(`[${phaseLog.status}] ${phase}`);
    for (const entry of phaseLog.entries.slice(-5)) {
      printLogEntry(entry);
    }
  }
}

function printLogEntry(entry: AutocodeTaskLogEntry): void {
  const entryView = buildAutocodeTaskLogEntryViewModel(entry, { logContentMaxLength: 160 });
  console.log(`  ${entryView.timestampLabel} ${entryView.type}: ${entryView.contentPreview}`);
}

function resolveContext(parsed: ParsedAutocodeCommandArgs): { projectRoot: string; dataDirName: string } {
  return {
    projectRoot: path.resolve(getStringOption(parsed, 'cwd') ?? process.cwd()),
    dataDirName: getStringOption(parsed, 'data-dir') ?? getStringOption(parsed, 'dataDir') ?? DEFAULT_DATA_DIR,
  };
}

function resolveTaskId(parsed: ParsedAutocodeCommandArgs): string {
  const taskId = getStringOption(parsed, 'task') ?? parsed.positionals[0];
  if (!taskId?.trim()) {
    throw new Error('Task id is required.');
  }
  return taskId.trim();
}

function resolveCli(value: string): AutocodeCli {
  if (isAutocodeCli(value)) {
    return value;
  }
  throw new Error(`Unsupported CLI "${value}". Supported values: ${SUPPORTED_AUTOCODE_CLIS.join(', ')}.`);
}

function getDevelopmentModeOption(parsed: ParsedAutocodeCommandArgs): AutocodeTaskDevelopmentMode {
  const mode = getStringOption(parsed, 'mode') ?? getStringOption(parsed, 'development-mode') ?? 'standard';
  if (mode === 'fast') {
    return 'direct';
  }
  if (isAutocodeTaskDevelopmentMode(mode)) {
    return mode;
  }
  throw new Error(`Unsupported task mode "${mode}". Supported values: direct, standard, spec.`);
}

function getStringOption(parsed: ParsedAutocodeCommandArgs, key: string): string | undefined {
  return getAutocodeStringOption(parsed, key);
}

function getBooleanOption(parsed: ParsedAutocodeCommandArgs, key: string): boolean {
  return getAutocodeBooleanOption(parsed, key);
}

function isJson(parsed: ParsedAutocodeCommandArgs): boolean {
  return hasAutocodeJsonOption(parsed);
}

function createCliProcessAdapter(): ProcessAdapter {
  return {
    startProcess(options) {
      const result = spawnSync(options.command, options.args, {
        cwd: options.cwd,
        stdio: 'inherit',
        shell: options.shell,
      });
      const exitCode = result.status ?? (result.error ? 1 : 0);
      process.exitCode = exitCode;

      return {
        status: exitCode === 0 ? 'completed' : 'failed',
        exitCode,
        signal: result.signal,
        message: result.error?.message,
      };
    },
  };
}

function createCliNotificationAdapter(): NotificationAdapter {
  return {
    async info(message: string) {
      console.log(message);
    },
    async warn(message: string) {
      console.warn(message);
    },
    async error(message: string) {
      console.error(message);
    },
  };
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Autocode CLI

Usage:
  autocode info [--cwd <path>] [--data-dir ${DEFAULT_DATA_DIR}] [--json]
  autocode tasks [--cwd <path>] [--data-dir ${DEFAULT_DATA_DIR}] [--json]
  autocode create --title <title> --description <text> [--mode direct|standard|spec]
  autocode docs generate [--type full|product|architecture|technical]
  autocode openspec list
  autocode openspec import <change-id>
  autocode run <task-id> [--cli claude-code|codex|gemini|opencode|kilocode|deepseek|custom]
  autocode run <task-id> --runtime agent [--execute] [--json]
  autocode run <task-id> --cli custom --custom-command "<command>"
  autocode run <task-id> --execute
  autocode logs <task-id> [--json]
  autocode done <task-id>
  autocode changes <task-id>

Commands:
  info       Print workspace and shared core information.
  tasks      List shared Autocode task files.
  create     Create an Autocode task. Default mode is standard; use --mode direct for direct LLM execution.
  docs       Create a project documentation task used as context by future spec and coding phases.
  openspec   Import an OpenSpec change as a downstream Autocode execution task.
  run        Write a task prompt and runner using @autocode/core.
  logs       Show recent task log entries.
  done       Mark a task complete in the shared plan file.
  changes    Move a task back to human review.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
