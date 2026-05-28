#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  CORE_PACKAGE_VERSION,
  DEFAULT_AUTOCODE_CLI,
  DEFAULT_PHASE_MODELS,
  SUPPORTED_AUTOCODE_CLIS,
  SupportedProvider,
  buildAutocodeWorkspaceState,
  buildAutocodeTaskCardViewModel,
  buildAutocodeTaskLogEntryViewModel,
  buildAutocodeWorkspaceSummaryViewModel,
  buildProjectIndex,
  createAutocodeAgentRuntimeStartPlan,
  createManualAutocodeTask,
  createStartedAutocodeTaskRun,
  getAutocodeAgentRuntimeModeLabel,
  getAutocodeBooleanOption,
  getAutocodeStringOption,
  hasAutocodeJsonOption,
  isAutocodeCli,
  markAutocodeTaskDone,
  parseAutocodeCommandArgs,
  readAutocodeTaskLogs,
  requestAutocodeTaskChanges,
  summarizeWorkspace,
  type AutocodeCli,
  type AutocodeTask,
  type AutocodeTaskLogEntry,
  type AutocodeTaskLogs,
  type ParsedAutocodeCommandArgs,
} from '@autocode/core';

const DEFAULT_DATA_DIR = '.autocode';
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
    case 'run':
    case 'start':
      runTask(parsed);
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

  const task = createManualAutocodeTask({
    ...context,
    title,
    description,
  });

  if (isJson(parsed)) {
    writeJson(task);
    return;
  }

  console.log(`Created ${task.specId}: ${task.title}`);
  console.log(task.specsPath);
}

function runTask(parsed: ParsedAutocodeCommandArgs): void {
  const context = resolveContext(parsed);
  const taskId = resolveTaskId(parsed);
  const runtime = getStringOption(parsed, 'runtime') ?? 'file';
  if (runtime === 'agent') {
    if (getBooleanOption(parsed, 'execute')) {
      throw new Error('Agent runtime execution is not enabled in the CLI adapter yet. Use --runtime file --execute.');
    }
    const runtimePlan = createAutocodeAgentRuntimeStartPlan({
      ...context,
      taskId,
    });
    if (isJson(parsed)) {
      writeJson({ ...context, runtime: 'agent', runtimePlan });
    } else {
      console.log(
        `Prepared agent runtime plan for ${runtimePlan.specId}: ${getAutocodeAgentRuntimeModeLabel(runtimePlan.mode)} (${runtimePlan.mode}).`,
      );
      console.log(`Spec dir: ${runtimePlan.specDir}`);
      console.log('Agent runtime execution is adapter-driven; this CLI build only prints the shared plan.');
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

function getStringOption(parsed: ParsedAutocodeCommandArgs, key: string): string | undefined {
  return getAutocodeStringOption(parsed, key);
}

function getBooleanOption(parsed: ParsedAutocodeCommandArgs, key: string): boolean {
  return getAutocodeBooleanOption(parsed, key);
}

function isJson(parsed: ParsedAutocodeCommandArgs): boolean {
  return hasAutocodeJsonOption(parsed);
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Autocode CLI

Usage:
  autocode info [--cwd <path>] [--data-dir .autocode] [--json]
  autocode tasks [--cwd <path>] [--data-dir .autocode] [--json]
  autocode create --title <title> --description <text>
  autocode run <task-id> [--cli claude-code|codex|gemini|opencode|kilocode|deepseek|custom]
  autocode run <task-id> --runtime agent [--json]
  autocode run <task-id> --cli custom --custom-command "<command>"
  autocode run <task-id> --execute
  autocode logs <task-id> [--json]
  autocode done <task-id>
  autocode changes <task-id>

Commands:
  info       Print workspace and shared core information.
  tasks      List shared Autocode task files.
  create     Create a task under .autocode/specs.
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
