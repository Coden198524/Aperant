import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAutocodeSpecDir,
  listAutocodeTasks,
  type AutocodePlanStatus,
  type AutocodeTask,
} from './spec-store.js';

export type AutocodeCli = 'claude-code' | 'gemini' | 'opencode' | 'kilocode' | 'codex' | 'deepseek' | 'custom';
export type AutocodeTaskRunPhase = 'spec' | 'planning' | 'coding';

export interface CreateAutocodeTaskRunPlanInput {
  projectRoot: string;
  dataDirName: string;
  taskId: string;
  cli: AutocodeCli;
  customCommand?: string;
  bypassPermissions?: boolean;
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
  const phase = resolveRunPhase(specDir);
  const prompt = buildTaskRunPrompt({
    task,
    phase,
    projectRoot: input.projectRoot,
    specDir,
  });
  const promptFilePath = join(specDir, PROMPT_FILE_NAME);
  const runnerFilePath = join(specDir, RUNNER_FILE_NAME);
  const cliInvocation = resolveCliInvocation(input.cli, input.customCommand);
  const permissionArgs = getCliPermissionArgs(input.cli, input.bypassPermissions === true);
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
    planStatus: phase === 'coding' ? 'coding' : 'planning',
    executionPhase: phase === 'coding' ? 'coding' : 'planning',
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

function resolveTask(projectRoot: string, dataDirName: string, taskId: string): AutocodeTask | null {
  return listAutocodeTasks({ projectRoot, dataDirName })
    .find((task) => task.id === taskId || task.specId === taskId) ?? null;
}

function resolveRunPhase(specDir: string): AutocodeTaskRunPhase {
  const hasSpec = existsSync(join(specDir, 'spec.md'));
  const plan = readJson<{ phases?: Array<{ subtasks?: unknown[]; chunks?: unknown[] }> }>(join(specDir, 'implementation_plan.json'));
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

  if (input.phase === 'spec') {
    return `${header}${[
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
      `- Write ${input.specDir}/spec.md with overview, scope, implementation notes, and success criteria.`,
      `- Update ${input.specDir}/requirements.json if the current task description needs structured requirements.`,
      `- Write ${input.specDir}/implementation_plan.json with concrete phases and subtasks.`,
      '- Keep the plan compatible with Autocode: phases[].subtasks[] should include id, title, description, and status.',
      '- Set new subtask statuses to "pending".',
    ].join('\n')}`;
  }

  if (input.phase === 'planning') {
    return `${header}${[
      '## Goal',
      '',
      'Create or repair the implementation plan for the existing spec.',
      '',
      '## Required Output',
      '',
      `- Read ${input.specDir}/spec.md and ${input.specDir}/requirements.json if needed.`,
      `- Write ${input.specDir}/implementation_plan.json with concrete phases and subtasks.`,
      '- Keep subtasks small enough to implement and verify independently.',
      '- Set new subtask statuses to "pending".',
    ].join('\n')}`;
  }

  return `${header}${[
    '## Goal',
    '',
    'Implement the task according to the existing spec and implementation plan.',
    '',
    '## Required Workflow',
    '',
    `- Read ${input.specDir}/implementation_plan.json first.`,
    `- Use ${input.specDir}/spec.md only for missing acceptance details.`,
    '- Work through pending subtasks and update their statuses as work completes.',
    '- Add concise completion summaries to completed subtasks when practical.',
    '- Run the most relevant validation command for the project.',
    `- Leave a short implementation summary in ${input.specDir}/direct_summary.md or update the plan with completion details.`,
  ].join('\n')}`;
}

function resolveCliInvocation(cli: AutocodeCli, customCommand: string | undefined): { command: string; args: string[] } {
  if (cli === 'custom') {
    const parts = splitCommandLine(customCommand?.trim() ?? '');
    if (parts.length === 0) {
      throw new Error('customCommand is required when cli is custom.');
    }
    return { command: parts[0], args: parts.slice(1) };
  }

  const commands: Record<Exclude<AutocodeCli, 'custom'>, string> = {
    'claude-code': 'claude',
    gemini: 'gemini',
    opencode: 'opencode',
    kilocode: 'kilocode',
    codex: 'codex',
    deepseek: 'deepseek',
  };
  return { command: commands[cli], args: [] };
}

function getCliPermissionArgs(cli: AutocodeCli, bypassPermissions: boolean): string[] {
  if (!bypassPermissions) {
    return [];
  }
  if (cli === 'claude-code') {
    return ['--dangerously-skip-permissions'];
  }
  if (cli === 'codex') {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }
  return [];
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
const prompt = readFileSync(promptFilePath, 'utf8');
const logPhase = phase === 'coding' ? 'coding' : 'planning';

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

  writeJson(join(specDir, 'autocode-run-result.json'), result);
  updatePlanStatus(failed, result.message, now);
  updateTaskLogs(logPhase, failed ? 'failed' : 'completed', result.message);
  process.exit(failed ? 1 : 0);
}

function validateExpectedArtifacts() {
  if (phase === 'spec') {
    if (!existsSync(join(specDir, 'spec.md'))) {
      return 'CLI finished without creating spec.md.';
    }
    if (!planHasSubtasks()) {
      return 'CLI finished without creating implementation_plan.json subtasks.';
    }
  }
  if (phase === 'planning' && !planHasSubtasks()) {
    return 'CLI finished without creating implementation_plan.json subtasks.';
  }
  return undefined;
}

function planHasSubtasks() {
  const plan = readJson(join(specDir, 'implementation_plan.json'));
  return plan?.phases?.some((phase) => {
    const subtasks = Array.isArray(phase.subtasks) ? phase.subtasks : Array.isArray(phase.chunks) ? phase.chunks : [];
    return subtasks.length > 0;
  }) === true;
}

function updatePlanStatus(failed, message, now) {
  const planPath = join(specDir, 'implementation_plan.json');
  const plan = readJson(planPath) || {
    feature: taskTitle,
    description: taskDescription,
    created_at: now,
    phases: [],
  };

  plan.status = failed ? 'error' : 'human_review';
  plan.reviewReason = failed ? 'errors' : phase === 'coding' ? 'completed' : 'plan_review';
  plan.executionPhase = failed ? 'failed' : phase === 'coding' ? 'complete' : 'planning';
  plan.updated_at = now;
  if (!plan.created_at) plan.created_at = now;
  writeJson(planPath, plan);
}

function updateTaskLogs(logPhase, status, message) {
  const now = new Date().toISOString();
  const logsPath = join(specDir, 'task_logs.json');
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

function splitCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += '\\';
  }
  if (quote) {
    throw new Error('customCommand has an unterminated quote.');
  }
  if (current) {
    parts.push(current);
  }
  return parts;
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
