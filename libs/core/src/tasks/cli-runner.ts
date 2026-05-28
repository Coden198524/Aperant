import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAutocodeProjectDocsReferencePrompt } from '../project/project-docs.js';
import {
  getAutocodeSpecDir,
  listAutocodeTasks,
  type AutocodePlanStatus,
  type AutocodeTask,
} from './spec-store.js';
import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import { loadAutocodeImplementationPlanSync } from './plan-store.js';
import {
  getAutocodeCliPermissionArgs,
  resolveAutocodeCliInvocation,
  type AutocodeCli,
} from './cli-catalog.js';

export type AutocodeTaskRunPhase = 'direct' | 'spec' | 'planning' | 'coding';

export interface CreateAutocodeTaskRunPlanInput {
  projectRoot: string;
  dataDirName: string;
  taskId: string;
  cli: AutocodeCli;
  customCommand?: string;
  bypassPermissions?: boolean;
  phase?: AutocodeTaskRunPhase;
}

export interface AutocodeTaskRunPlan {
  task: AutocodeTask;
  phase: AutocodeTaskRunPhase;
  cwd: string;
  command: string;
  args: string[];
  planStatus: AutocodePlanStatus;
  executionPhase: string;
  promptFilePath: string;
  runnerFilePath: string;
  prompt: string;
}

const PROMPT_FILE_NAME = 'autocode-run-prompt.md';
const RUNNER_FILE_NAME = 'autocode-runner.cjs';

export function createAutocodeTaskRunPlan(input: CreateAutocodeTaskRunPlanInput): AutocodeTaskRunPlan {
  const task = resolveTask(input.projectRoot, input.dataDirName, input.taskId);
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  const specDir = getAutocodeSpecDir({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    specId: task.specId,
  });
  const phase = input.phase ?? resolveRunPhase(specDir);
  const prompt = buildTaskRunPrompt({
    task,
    phase,
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    specDir,
  });
  const promptFilePath = join(specDir, PROMPT_FILE_NAME);
  const runnerFilePath = join(specDir, RUNNER_FILE_NAME);
  const cliInvocation = resolveAutocodeCliInvocation(input.cli, input.customCommand);
  const permissionArgs = getAutocodeCliPermissionArgs(input.cli, input.bypassPermissions === true);
  writeFileSync(promptFilePath, `${prompt}\n`, 'utf8');
  writeFileSync(
    runnerFilePath,
    buildNodeRunnerScript({
      cwd: input.projectRoot,
      command: cliInvocation.command,
      args: [...cliInvocation.args, ...permissionArgs],
      promptFilePath,
      phase,
      specDir,
      taskTitle: task.title,
      taskDescription: task.description,
    }),
    'utf8',
  );

  return {
    task,
    phase,
    cwd: input.projectRoot,
    command: cliInvocation.command,
    args: [...cliInvocation.args, ...permissionArgs],
    planStatus: isCodingRunPhase(phase) ? 'coding' : 'planning',
    executionPhase: isCodingRunPhase(phase) ? 'coding' : 'planning',
    promptFilePath,
    runnerFilePath,
    prompt,
  };
}

export function buildAutocodeTaskRunShellCommand(plan: Pick<AutocodeTaskRunPlan, 'command' | 'args'>): string {
  return [plan.command, ...plan.args].map(quoteShellArg).join(' ');
}

export function buildAutocodeTaskRunnerShellCommand(plan: Pick<AutocodeTaskRunPlan, 'runnerFilePath'>): string {
  return ['node', plan.runnerFilePath].map(quoteShellArg).join(' ');
}

export function mapAutocodeAgentRuntimeModeToTaskRunPhase(
  mode: 'direct' | 'spec' | 'planning' | 'coding',
): AutocodeTaskRunPhase {
  return mode;
}

function resolveTask(projectRoot: string, dataDirName: string, taskId: string): AutocodeTask | null {
  return listAutocodeTasks({ projectRoot, dataDirName })
    .find((task) => task.id === taskId || task.specId === taskId) ?? null;
}

function resolveRunPhase(specDir: string): AutocodeTaskRunPhase {
  const hasSpec = existsSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile));
  const plan = loadAutocodeImplementationPlanSync(specDir) as { phases?: Array<{ subtasks?: unknown[]; chunks?: unknown[] }> } | null;
  const hasSubtasks = plan?.phases?.some((phase) => {
    const subtasks = Array.isArray(phase.subtasks) ? phase.subtasks : Array.isArray(phase.chunks) ? phase.chunks : [];
    return subtasks.length > 0;
  }) === true;

  if (!hasSpec) {
    return 'spec';
  }
  return hasSubtasks ? 'coding' : 'planning';
}

function buildTaskRunPrompt(input: {
  task: AutocodeTask;
  phase: AutocodeTaskRunPhase;
  projectRoot: string;
  dataDirName?: string;
  specDir: string;
}): string {
  const header = [
    '# Autocode Task Run',
    '',
    `Project root: ${input.projectRoot}`,
    `Spec directory: ${input.specDir}`,
    `Task ID: ${input.task.specId}`,
    `Task title: ${input.task.title}`,
    '',
  ].join('\n');
  const projectDocsReference = buildAutocodeProjectDocsReferencePrompt({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
  });
  const contextReference = projectDocsReference ? `${projectDocsReference}\n\n` : '';

  if (input.phase === 'direct') {
    return `${header}${contextReference}${[
      '## Goal',
      '',
      'Implement the requested task directly without creating or waiting for a separate Autocode spec workflow.',
      '',
      '## Task Description',
      '',
      input.task.description || input.task.title,
      '',
      '## Required Workflow',
      '',
      '- Inspect the relevant project files before editing.',
      '- Apply the smallest useful code changes that satisfy the task.',
      '- Run the most relevant validation command for the project.',
      `- Leave a short implementation summary in ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.directSummary}.`,
    ].join('\n')}`;
  }

  if (input.phase === 'spec') {
    return `${header}${contextReference}${[
      '## Goal',
      '',
      'Create the initial task specification artifacts for this task.',
      '',
      '## Task Description',
      '',
      input.task.description || input.task.title,
      '',
      '## Required Output',
      '',
      `- Write ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile} with overview, scope, implementation notes, and success criteria.`,
      `- Update ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements} if the current task description needs structured requirements.`,
      `- Write ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.implementationPlan} as an OpenSpec-style Markdown checklist with concrete phases and subtasks.`,
      '- Use [ ] for pending subtasks and concise metadata bullets for files, dependencies, requirements, and verification.',
    ].join('\n')}`;
  }

  if (input.phase === 'planning') {
    return `${header}${contextReference}${[
      '## Goal',
      '',
      'Create or repair the implementation plan for the existing spec.',
      '',
      '## Required Output',
      '',
      `- Read ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile} and ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements} if needed.`,
      `- Write ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.implementationPlan} as an OpenSpec-style Markdown checklist with concrete phases and subtasks.`,
      '- Keep subtasks small enough to implement and verify independently.',
      '- Set new subtask checkboxes to [ ].',
    ].join('\n')}`;
  }

  return `${header}${contextReference}${[
    '## Goal',
    '',
    'Implement the task according to the existing spec and implementation plan.',
    '',
    '## Required Workflow',
    '',
    `- Read ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.implementationPlan} first.`,
    `- Use ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile} only for missing acceptance details.`,
    '- Work through pending subtasks and mark completed items [x] as work completes.',
    '- Add concise _Completion: ..._ notes to completed subtasks when practical.',
    '- Run the most relevant validation command for the project.',
    `- Leave a short implementation summary in ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.directSummary} or update the plan with completion details.`,
  ].join('\n')}`;
}

function buildNodeRunnerScript(input: {
  cwd: string;
  command: string;
  args: string[];
  promptFilePath: string;
  phase: AutocodeTaskRunPhase;
  specDir: string;
  taskTitle: string;
  taskDescription: string;
}): string {
  return `const { spawn } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const cwd = ${JSON.stringify(input.cwd)};
const command = ${JSON.stringify(input.command)};
const args = ${JSON.stringify(input.args)};
const promptFilePath = ${JSON.stringify(input.promptFilePath)};
const phase = ${JSON.stringify(input.phase)};
const specDir = ${JSON.stringify(input.specDir)};
const taskTitle = ${JSON.stringify(input.taskTitle)};
const taskDescription = ${JSON.stringify(input.taskDescription)};
const artifacts = ${JSON.stringify(AUTOCODE_TASK_ARTIFACTS)};
const prompt = readFileSync(promptFilePath, 'utf8');
const logPhase = phase === 'coding' || phase === 'direct' ? 'coding' : 'planning';

updateTaskLogs(logPhase, 'active', \`Starting Autocode \${phase} phase with \${command}.\`);
const child = spawn(command, args, {
  cwd,
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: process.platform === 'win32',
});

let finalized = false;

child.stdin.end(prompt);
child.on('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  finalize(1, undefined, error instanceof Error ? error.message : String(error));
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(\`Autocode CLI exited by signal: \${signal}\`);
    finalize(1, signal, \`Autocode CLI exited by signal: \${signal}\`);
    return;
  }
  finalize(code ?? 0, undefined);
});

function finalize(exitCode, signal, explicitError) {
  if (finalized) return;
  finalized = true;

  const validationError = exitCode === 0 ? validateExpectedArtifacts() : undefined;
  const failed = exitCode !== 0 || Boolean(explicitError) || Boolean(validationError);
  const now = new Date().toISOString();
  const result = {
    phase,
    command,
    args,
    exitCode,
    signal,
    status: failed ? 'error' : 'success',
    message: explicitError || validationError || 'Autocode CLI run completed.',
    updatedAt: now,
  };

  writeJson(join(specDir, artifacts.runResult), result);
  updatePlanStatus(failed, result.message, now);
  updateTaskLogs(logPhase, failed ? 'failed' : 'completed', result.message);
  process.exit(failed ? 1 : 0);
}

function validateExpectedArtifacts() {
  if (phase === 'spec') {
    if (!existsSync(join(specDir, artifacts.specFile))) {
      return \`CLI finished without creating \${artifacts.specFile}.\`;
    }
    if (!planHasSubtasks()) {
      return \`CLI finished without creating \${artifacts.implementationPlan} subtasks.\`;
    }
  }
  if (phase === 'planning' && !planHasSubtasks()) {
    return \`CLI finished without creating \${artifacts.implementationPlan} subtasks.\`;
  }
  return undefined;
}

function planHasSubtasks() {
  try {
    const content = readFileSync(join(specDir, artifacts.implementationPlan), 'utf8');
    return /^\\s*-\\s+\\[[ xX/!-]\\]\\s+[A-Za-z0-9]+[.-][A-Za-z0-9]+/m.test(content) ||
      /^\\s*-\\s+\\[[ xX/!-]\\]\\s+[A-Za-z0-9]+\\.?\\s+.+/m.test(content);
  } catch {
    return false;
  }
}

function updatePlanStatus(failed, message, now) {
  const planPath = join(specDir, artifacts.implementationPlan);
  let content = '';
  try {
    content = readFileSync(planPath, 'utf8');
  } catch {
    content = [
      '# Implementation Plan',
      '',
      \`Feature: \${taskTitle}\`,
      \`Description: \${taskDescription}\`,
      \`Created: \${now}\`,
      '',
    ].join('\\n');
  }
  content = upsertPlanMetadata(content, 'Status', failed ? 'error' : 'human_review');
  content = upsertPlanMetadata(content, 'Review Reason', failed ? 'errors' : phase === 'coding' || phase === 'direct' ? 'completed' : 'plan_review');
  content = upsertPlanMetadata(content, 'Execution Phase', failed ? 'failed' : phase === 'coding' || phase === 'direct' ? 'complete' : 'planning');
  content = upsertPlanMetadata(content, 'Updated', now);
  writeFileSync(planPath, content.endsWith('\\n') ? content : \`\${content}\\n\`, 'utf8');
}

function upsertPlanMetadata(content, key, value) {
  const line = \`\${key}: \${value}\`;
  const pattern = new RegExp(\`^\${key}:.*$\`, 'm');
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  const lines = content.split(/\\r?\\n/);
  const insertAt = Math.min(lines.findIndex((item, index) => index > 0 && item.trim() === ''), lines.length);
  const safeInsertAt = insertAt < 0 ? lines.length : insertAt;
  lines.splice(safeInsertAt, 0, line);
  return lines.join('\\n');
}

function updateTaskLogs(logPhase, status, message) {
  const now = new Date().toISOString();
  const logsPath = join(specDir, artifacts.taskLogs);
  const logs = readJson(logsPath) || {
    spec_id: specDir.split(/[\\\\/]/).pop() || taskTitle,
    created_at: now,
    updated_at: now,
    phases: {
      planning: { phase: 'planning', status: 'pending', started_at: null, completed_at: null, entries: [] },
      coding: { phase: 'coding', status: 'pending', started_at: null, completed_at: null, entries: [] },
      validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] },
    },
  };
  const phaseLog = logs.phases[logPhase] || { phase: logPhase, status: 'pending', started_at: null, completed_at: null, entries: [] };
  phaseLog.status = status;
  phaseLog.started_at = phaseLog.started_at || now;
  if (status === 'completed' || status === 'failed') {
    phaseLog.completed_at = now;
  }
  phaseLog.entries.push({
    timestamp: now,
    type: status === 'failed' ? 'error' : status === 'completed' ? 'success' : 'info',
    content: message,
    phase: logPhase,
  });
  logs.phases[logPhase] = phaseLog;
  logs.updated_at = now;
  writeJson(logsPath, logs);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, \`\${JSON.stringify(value, null, 2)}\\n\`, 'utf8');
}
`;
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function isCodingRunPhase(phase: AutocodeTaskRunPhase): boolean {
  return phase === 'coding' || phase === 'direct';
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}
