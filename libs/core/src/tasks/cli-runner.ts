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
import type { AutocodeAgentLanguage } from '../runtime/agent-messages.js';

export type AutocodeTaskRunPhase = 'direct' | 'spec' | 'planning' | 'coding';

export interface CreateAutocodeTaskRunPlanInput {
  projectRoot: string;
  dataDirName: string;
  taskId: string;
  cli: AutocodeCli;
  customCommand?: string;
  model?: string;
  bypassPermissions?: boolean;
  phase?: AutocodeTaskRunPhase;
  language?: AutocodeAgentLanguage;
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
    language: input.language,
  });
  const promptFilePath = join(specDir, PROMPT_FILE_NAME);
  const runnerFilePath = join(specDir, RUNNER_FILE_NAME);
  const cliInvocation = resolveTaskRunnerCliInvocation({
    cli: input.cli,
    customCommand: input.customCommand,
    model: input.model,
    bypassPermissions: input.bypassPermissions === true,
  });
  writeFileSync(promptFilePath, `${prompt}\n`, 'utf8');
  writeFileSync(
    runnerFilePath,
    buildNodeRunnerScript({
      cwd: input.projectRoot,
      command: cliInvocation.command,
      args: cliInvocation.args,
      promptFilePath,
      phase,
      specDir,
      taskTitle: task.title,
      taskDescription: task.description,
      language: input.language,
    }),
    'utf8',
  );

  return {
    task,
    phase,
    cwd: input.projectRoot,
    command: cliInvocation.command,
    args: cliInvocation.args,
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

function resolveTaskRunnerCliInvocation(input: {
  cli: AutocodeCli;
  customCommand?: string;
  model?: string;
  bypassPermissions: boolean;
}): { command: string; args: string[] } {
  const invocation = resolveAutocodeCliInvocation(input.cli, input.customCommand);
  const permissionArgs = getAutocodeCliPermissionArgs(input.cli, input.bypassPermissions);

  if (input.cli === 'codex') {
    const modelArgs = input.model ? ['-m', input.model] : [];
    return {
      command: invocation.command,
      args: ['exec', '--json', ...modelArgs, ...permissionArgs, '-'],
    };
  }

  return {
    command: invocation.command,
    args: [...invocation.args, ...permissionArgs],
  };
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
  language?: AutocodeAgentLanguage;
}): string {
  const languageInstruction = buildTaskRunLanguageInstruction(input.language);
  const header = [
    '# Autocode Task Run',
    '',
    `Project root: ${input.projectRoot}`,
    `Spec directory: ${input.specDir}`,
    `Task ID: ${input.task.specId}`,
    `Task title: ${input.task.title}`,
    '',
    ...(languageInstruction ? ['## Language', '', languageInstruction, ''] : []),
  ].join('\n');
  const projectDocsReference = buildAutocodeProjectDocsReferencePrompt({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
  });
  const contextReference = projectDocsReference ? `${projectDocsReference}\n\n` : '';
  const humanInputReference = buildTaskHumanInputReference(input.specDir);

  if (input.phase === 'direct') {
    return `${header}${contextReference}${humanInputReference}${[
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
    return `${header}${contextReference}${humanInputReference}${[
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
    return `${header}${contextReference}${humanInputReference}${[
      '## Goal',
      '',
      'Create or repair the implementation plan for the existing spec.',
      '',
      '## Required Output',
      '',
      `- Read ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile} and ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements} if needed.`,
      `- If ${input.specDir}/HUMAN_INPUT.md exists, treat it as required plan-review feedback and regenerate the plan to address it.`,
      `- Write ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.implementationPlan} as an OpenSpec-style Markdown checklist with concrete phases and subtasks.`,
      '- Keep subtasks small enough to implement and verify independently.',
      '- Set new subtask checkboxes to [ ].',
    ].join('\n')}`;
  }

  return `${header}${contextReference}${humanInputReference}${[
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

function buildTaskHumanInputReference(specDir: string): string {
  const humanInputPath = join(specDir, 'HUMAN_INPUT.md');
  if (!existsSync(humanInputPath)) {
    return '';
  }
  try {
    const content = readFileSync(humanInputPath, 'utf8').trim();
    if (!content) {
      return '';
    }
    return [
      '## Human Input',
      '',
      `The user submitted follow-up feedback in ${humanInputPath}. Treat this feedback as required context for the next run.`,
      '',
      '```markdown',
      content,
      '```',
      '',
    ].join('\n');
  } catch {
    return '';
  }
}

function buildTaskRunLanguageInstruction(language: AutocodeAgentLanguage): string {
  if (language === 'zh-CN') {
    return [
      'Write all non-code prose, progress updates, task titles, plan descriptions, spec content, completion notes, review notes, and final summary in Simplified Chinese.',
      'Keep code identifiers, commands, file paths, API names, package names, and existing source text unchanged unless the task explicitly asks to translate them.',
      'When writing spec.md, requirements text, implementation_plan.md tasks, direct summaries, and review notes, prefer natural Simplified Chinese.',
      'Final answer must be a concise markdown table in Simplified Chinese with localized rows for changes, verification, and review notes.',
    ].join(' ');
  }

  if (language === 'fr') {
    return [
      'Write all non-code prose, progress updates, task titles, plan descriptions, spec content, completion notes, review notes, and final summary in French.',
      'Keep code identifiers, commands, file paths, API names, package names, and existing source text unchanged unless the task explicitly asks to translate them.',
      'When writing spec.md, requirements text, implementation_plan.md tasks, direct summaries, and review notes, prefer natural French.',
      'Final answer must be a concise markdown table in French with localized rows for changes, verification, and review notes.',
    ].join(' ');
  }

  return '';
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
  language?: AutocodeAgentLanguage;
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
const language = ${JSON.stringify(input.language)};
const artifacts = ${JSON.stringify(AUTOCODE_TASK_ARTIFACTS)};
const prompt = readFileSync(promptFilePath, 'utf8');
const logPhase = phase === 'coding' || phase === 'direct' ? 'coding' : 'planning';
const executionPhase = logPhase === 'coding' ? 'coding' : 'planning';
const codexJsonMode = isCodexJsonInvocation(command, args);
const maxValidationRetries = phase === 'spec' || phase === 'planning' ? 2 : 0;
let validationRetryCount = 0;
let attemptId = 0;
const startMessage = logPhase === 'coding'
  ? localizeMessage('startCoding', \`Starting Autocode \${phase} coding session with \${command}.\`, { phase, command })
  : localizeMessage('startPlanning', \`Starting Autocode \${phase} planning session with \${command}.\`, { phase, command });

emitPhase(executionPhase, startMessage, 0);
updatePlanRunningState();
updateTaskLogs(logPhase, 'active', startMessage);

let finalized = false;
let pendingModelOutput = '';
let modelOutputFlushTimer = null;
let codexJsonLineBuffer = '';
let tokenUsageEventCount = 0;
let lastTokenUsageLogTotal = 0;
let lastCodexMessageText = '';
const MODEL_OUTPUT_FLUSH_MS = 750;
const MODEL_OUTPUT_MAX_CHARS = 3500;

startAttempt(prompt);

function startAttempt(attemptPrompt) {
  const currentAttemptId = ++attemptId;
  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  child.stdin.end(attemptPrompt);
  child.stdout.on('data', (data) => {
    handleChildOutput('stdout', data);
  });
  child.stderr.on('data', (data) => {
    handleChildOutput('stderr', data);
  });
  child.on('error', (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    finalize(currentAttemptId, 1, undefined, error instanceof Error ? error.message : String(error));
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(\`Autocode CLI exited by signal: \${signal}\`);
      finalize(currentAttemptId, 1, signal, \`Autocode CLI exited by signal: \${signal}\`);
      return;
    }
    finalize(currentAttemptId, code ?? 0, undefined);
  });
}

function finalize(currentAttemptId, exitCode, signal, explicitError) {
  if (finalized || currentAttemptId !== attemptId) return;
  flushCodexJsonOutput();
  flushModelOutput();

  const validationError = exitCode === 0 ? validateExpectedArtifacts() : undefined;
  if (validationError && validationRetryCount < maxValidationRetries) {
    validationRetryCount += 1;
    const retryMessage = localizeMessage(
      'validationRetry',
      \`Autocode CLI output failed validation: \${validationError} Retrying \${validationRetryCount}/\${maxValidationRetries}...\`,
      { validationError, retry: validationRetryCount, maxRetries: maxValidationRetries },
    );
    appendTaskLogEntry(logPhase, 'info', retryMessage);
    updateTaskLogs(logPhase, 'active', retryMessage);
    updatePlanRunningState();
    emitPhase(executionPhase, retryMessage, 0);
    lastCodexMessageText = '';
    startAttempt(buildArtifactValidationRetryPrompt(validationError));
    return;
  }

  finalized = true;
  const failed = exitCode !== 0 || Boolean(explicitError) || Boolean(validationError);
  const now = new Date().toISOString();
  const result = {
    phase,
    command,
    args,
    exitCode,
    signal,
    status: failed ? 'error' : 'success',
    message: explicitError || validationError || localizeMessage('completed', 'Autocode CLI run completed.'),
    updatedAt: now,
  };

  writeJson(join(specDir, artifacts.runResult), result);
  updatePlanStatus(failed, result.message, now);
  updateTaskLogs(logPhase, failed ? 'failed' : 'completed', result.message);
  emitPhase(failed ? 'failed' : phase === 'coding' || phase === 'direct' ? 'complete' : executionPhase, result.message, failed ? 0 : 100);
  process.exit(failed ? 1 : 0);
}

function handleChildOutput(stream, data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  if (!text) return;
  if (codexJsonMode && stream === 'stdout') {
    processCodexJsonOutput(text);
    return;
  }
  if (stream === 'stderr') {
    process.stderr.write(text);
  } else {
    process.stdout.write(text);
  }
  queueModelOutput(text);
}

function queueModelOutput(text) {
  const cleaned = cleanLogText(text);
  if (!cleaned.trim()) {
    return;
  }

  pendingModelOutput += cleaned;
  if (pendingModelOutput.length >= MODEL_OUTPUT_MAX_CHARS || cleaned.includes('\\n')) {
    flushModelOutput();
    return;
  }

  if (!modelOutputFlushTimer) {
    modelOutputFlushTimer = setTimeout(flushModelOutput, MODEL_OUTPUT_FLUSH_MS);
  }
}

function flushModelOutput() {
  if (modelOutputFlushTimer) {
    clearTimeout(modelOutputFlushTimer);
    modelOutputFlushTimer = null;
  }

  const text = pendingModelOutput.trim();
  pendingModelOutput = '';
  if (!text) {
    return;
  }

  const content = text.length > MODEL_OUTPUT_MAX_CHARS
    ? text.slice(0, MODEL_OUTPUT_MAX_CHARS - 3) + '...'
    : text;
  const detail = text.length > MODEL_OUTPUT_MAX_CHARS ? text : undefined;
  appendTaskLogEntry(logPhase, 'text', content, detail);
}

function processCodexJsonOutput(text) {
  codexJsonLineBuffer += text.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
  const lines = codexJsonLineBuffer.split('\\n');
  codexJsonLineBuffer = lines.pop() || '';

  for (const line of lines) {
    processCodexJsonLine(line);
  }
}

function flushCodexJsonOutput() {
  if (!codexJsonLineBuffer.trim()) {
    codexJsonLineBuffer = '';
    return;
  }
  processCodexJsonLine(codexJsonLineBuffer);
  codexJsonLineBuffer = '';
}

function processCodexJsonLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) {
    return;
  }

  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    process.stdout.write(trimmed + '\\n');
    queueModelOutput(trimmed + '\\n');
    return;
  }

  if (!handleCodexJsonEvent(event)) {
    if (process.env.AUTOCODE_DEBUG_CLI_JSON === '1') {
      appendTaskLogEntry(logPhase, 'info', 'Unhandled Codex JSON event: ' + limitLogText(trimmed, 800), trimmed);
    }
  }
}

function handleCodexJsonEvent(event) {
  const envelope = asRecord(event);
  const payload = getCodexPayload(envelope);
  const payloadType = getFirstString(payload, ['type', 'event_type', 'kind']) || getFirstString(envelope, ['type', 'event_type', 'kind']);
  const sessionId = getFirstString(payload, ['session_id', 'sessionId', 'conversation_id']) ||
    getFirstString(envelope, ['session_id', 'sessionId', 'conversation_id']);
  const tokenUsage = extractCodexTokenUsage(envelope, payload, sessionId);
  let tokenUsageHandled = false;
  const handleTokenUsage = () => {
    if (!tokenUsage || tokenUsageHandled) {
      return false;
    }
    updatePlanTokenUsage(tokenUsage);
    tokenUsageHandled = true;
    return true;
  };

  if (payloadType === 'token_count' || payloadType === 'usage' || payloadType === 'usage_update') {
    handleTokenUsage();
    return true;
  }

  if (payloadType === 'agent_message') {
    handleTokenUsage();
    const message = stringifyCodexText(payload.message ?? payload.content ?? payload.text);
    if (message.trim()) {
      appendCodexMessageLog(message);
      return true;
    }
  }

  if (payloadType === 'message') {
    handleTokenUsage();
    const message = stringifyCodexText(payload.message ?? payload.content ?? payload.text);
    if (message.trim()) {
      appendCodexMessageLog(message);
      return true;
    }
  }

  if (payloadType === 'agent_message_delta' || payloadType === 'message_delta') {
    return true;
  }

  if (payloadType === 'function_call' || payloadType === 'tool_call') {
    handleTokenUsage();
    const toolName = getFirstString(payload, ['name', 'tool_name', 'toolName']) || 'tool';
    const toolInput = stringifyCodexText(payload.arguments ?? payload.input ?? payload.args);
    appendTaskLogEntry(
      logPhase,
      'tool_start',
      'Tool started: ' + toolName,
      toolInput,
      {
        tool_name: toolName,
        tool_input: toolInput ? limitLogText(toolInput, 1000) : undefined,
        tool_call_id: getFirstString(payload, ['call_id', 'callId', 'id']),
      },
    );
    return true;
  }

  if (payloadType === 'function_call_output' || payloadType === 'tool_result') {
    handleTokenUsage();
    const output = stringifyCodexText(payload.output ?? payload.content ?? payload.result);
    const toolName = getFirstString(payload, ['name', 'tool_name', 'toolName']) || undefined;
    const success = payload.success === undefined ? undefined : Boolean(payload.success);
    const summary = output.trim()
      ? 'Tool output' + (toolName ? ': ' + toolName : '') + '\\n' + limitLogText(output, 1200)
      : 'Tool output' + (toolName ? ': ' + toolName : '');
    appendTaskLogEntry(
      logPhase,
      'tool_end',
      summary,
      output.length > 1200 ? output : undefined,
      {
        tool_name: toolName,
        tool_success: success,
        tool_call_id: getFirstString(payload, ['call_id', 'callId', 'id']),
      },
    );
    return true;
  }

  if (payloadType && /reasoning|analysis|encrypted/i.test(payloadType)) {
    return true;
  }

  const usageOnlyEvent = handleTokenUsage();
  const message = stringifyCodexText(payload.message ?? payload.content ?? payload.text ?? envelope.message);
  if (message.trim()) {
    appendTaskLogEntry(logPhase, 'info', limitLogText(message, 1600), message.length > 1600 ? message : undefined);
    return true;
  }

  return payloadType === 'turn_started' ||
    payloadType === 'turn_completed' ||
    payloadType === 'session_configured' ||
    payloadType === 'response_started' ||
    payloadType === 'response_completed' ||
    usageOnlyEvent;
}

function appendCodexMessageLog(message) {
  const cleanMessage = cleanLogText(message).trim();
  if (!cleanMessage || cleanMessage === lastCodexMessageText) {
    return;
  }
  lastCodexMessageText = cleanMessage;
  const content = limitLogText(cleanMessage, MODEL_OUTPUT_MAX_CHARS);
  process.stdout.write(content + '\\n');
  appendTaskLogEntry(logPhase, 'text', content, cleanMessage.length > MODEL_OUTPUT_MAX_CHARS ? cleanMessage : undefined);
}

function getCodexPayload(envelope) {
  const candidates = [
    envelope.payload,
    asRecord(envelope.msg)?.payload,
    envelope.msg,
    envelope.item,
    envelope.response_item,
    envelope.event,
  ];

  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (record) {
      return record;
    }
  }

  return envelope;
}

function normalizeCodexTokenUsage(raw, sessionId) {
  const source = asRecord(raw);
  if (!source) {
    return null;
  }
  const totalUsage = asRecord(source.total_token_usage) ||
    asRecord(source.totalTokenUsage) ||
    asRecord(source.total_usage) ||
    asRecord(source.totalUsage) ||
    asRecord(source.last_token_usage) ||
    asRecord(source.lastTokenUsage) ||
    source;
  const promptTokens = readNumber(totalUsage.input_tokens ?? totalUsage.inputTokens ?? totalUsage.prompt_tokens ?? totalUsage.promptTokens);
  const completionTokens = readNumber(totalUsage.output_tokens ?? totalUsage.outputTokens ?? totalUsage.completion_tokens ?? totalUsage.completionTokens);
  const totalTokens = readNumber(totalUsage.total_tokens ?? totalUsage.totalTokens) ||
    (promptTokens || completionTokens ? promptTokens + completionTokens : 0);
  if (!promptTokens && !completionTokens && !totalTokens) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    thinkingTokens: readOptionalNumber(totalUsage.reasoning_output_tokens ?? totalUsage.reasoningOutputTokens ?? totalUsage.reasoningTokens ?? totalUsage.thinkingTokens),
    cacheReadTokens: readOptionalNumber(totalUsage.cached_input_tokens ?? totalUsage.cachedInputTokens ?? totalUsage.cache_read_tokens ?? totalUsage.cacheReadTokens),
    cacheCreationTokens: readOptionalNumber(totalUsage.cache_creation_input_tokens ?? totalUsage.cacheCreationInputTokens ?? totalUsage.cache_creation_tokens ?? totalUsage.cacheCreationTokens),
    sessionId,
  };
}

function extractCodexTokenUsage(envelope, payload, sessionId) {
  const payloadResponse = asRecord(payload.response);
  const envelopeResponse = asRecord(envelope.response);
  const candidates = [
    payload.info,
    payload.usage,
    payload.token_usage,
    payload.tokenUsage,
    payload.total_token_usage,
    payload.totalTokenUsage,
    payload.last_token_usage,
    payload.lastTokenUsage,
    payloadResponse?.usage,
    payloadResponse?.token_usage,
    payloadResponse?.tokenUsage,
    envelope.info,
    envelope.usage,
    envelope.token_usage,
    envelope.tokenUsage,
    envelope.total_token_usage,
    envelope.totalTokenUsage,
    envelope.last_token_usage,
    envelope.lastTokenUsage,
    envelopeResponse?.usage,
    envelopeResponse?.token_usage,
    envelopeResponse?.tokenUsage,
  ];

  for (const candidate of candidates) {
    const usage = normalizeCodexTokenUsage(candidate, sessionId);
    if (usage) {
      return usage;
    }
  }
  return null;
}

function updatePlanTokenUsage(usage) {
  const now = new Date().toISOString();
  const planPath = join(specDir, artifacts.implementationPlan);
  let content = '';
  try {
    content = readFileSync(planPath, 'utf8');
  } catch {
    content = [
      '# Implementation Plan',
      '',
      'Feature: ' + taskTitle,
      'Description: ' + taskDescription,
      'Created: ' + now,
      '',
    ].join('\\n');
  }

  const currentMetadata = readPlanMachineMetadata(content);
  const previousUsage = normalizePersistedTokenUsage(currentMetadata.tokenUsage);
  tokenUsageEventCount += 1;
  const incoming = {
    ...usage,
    stepsExecuted: Math.max((previousUsage?.stepsExecuted ?? 0) + 1, tokenUsageEventCount),
    sessionId: usage.sessionId || previousUsage?.sessionId,
  };
  const merged = mergeTokenUsage(previousUsage, incoming);

  content = upsertPlanMetadata(content, 'Updated', now);
  content = upsertPlanMachineMetadata(content, {
    tokenUsage: merged,
    last_updated: now,
  });
  writeFileSync(planPath, content.endsWith('\\n') ? content : content + '\\n', 'utf8');
  emitTokenUsage(merged);

  if ((merged.totalTokens ?? 0) !== lastTokenUsageLogTotal) {
    lastTokenUsageLogTotal = merged.totalTokens ?? 0;
    appendTaskLogEntry(logPhase, 'info', formatTokenUsageMessage(merged));
  }
}

function readPlanMachineMetadata(content) {
  const match = /^<!--\\s*autocode-plan-meta:\\s*(\\{.*\\})\\s*-->\\s*$/m.exec(content);
  if (!match) {
    return {};
  }
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizePersistedTokenUsage(value) {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return {
    promptTokens: readNumber(record.promptTokens),
    completionTokens: readNumber(record.completionTokens),
    totalTokens: readNumber(record.totalTokens),
    thinkingTokens: readOptionalNumber(record.thinkingTokens),
    cacheReadTokens: readOptionalNumber(record.cacheReadTokens),
    cacheCreationTokens: readOptionalNumber(record.cacheCreationTokens),
    stepsExecuted: readOptionalNumber(record.stepsExecuted),
    estimated: record.estimated === true ? true : undefined,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
  };
}

function mergeTokenUsage(previous, incoming) {
  if (!previous) {
    return dropUndefinedTokenUsage(incoming);
  }
  const preferIncomingTokens = incoming.estimated !== true || previous.estimated === true;
  return dropUndefinedTokenUsage({
    promptTokens: preferIncomingTokens
      ? Math.max(previous.promptTokens ?? 0, incoming.promptTokens ?? 0)
      : previous.promptTokens,
    completionTokens: preferIncomingTokens
      ? Math.max(previous.completionTokens ?? 0, incoming.completionTokens ?? 0)
      : previous.completionTokens,
    totalTokens: preferIncomingTokens
      ? Math.max(previous.totalTokens ?? 0, incoming.totalTokens ?? 0)
      : previous.totalTokens,
    thinkingTokens: Math.max(previous.thinkingTokens ?? 0, incoming.thinkingTokens ?? 0) || undefined,
    cacheReadTokens: Math.max(previous.cacheReadTokens ?? 0, incoming.cacheReadTokens ?? 0) || undefined,
    cacheCreationTokens: Math.max(previous.cacheCreationTokens ?? 0, incoming.cacheCreationTokens ?? 0) || undefined,
    stepsExecuted: Math.max(previous.stepsExecuted ?? 0, incoming.stepsExecuted ?? 0) || undefined,
    estimated: previous.estimated === true && incoming.estimated === true ? true : undefined,
    sessionId: incoming.sessionId || previous.sessionId,
  });
}

function dropUndefinedTokenUsage(value) {
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null && item !== '') {
      result[key] = item;
    }
  }
  return result;
}

function formatTokenUsageMessage(usage) {
  if (language === 'zh-CN') {
    return '模型用量更新：请求 ' + (usage.stepsExecuted ?? 0) +
      ' 次，输入 ' + (usage.promptTokens ?? 0) +
      '，输出 ' + (usage.completionTokens ?? 0) +
      '，总计 ' + (usage.totalTokens ?? 0) + ' tokens。';
  }
  if (language === 'fr') {
    return 'Utilisation du modele : ' + (usage.stepsExecuted ?? 0) +
      ' requetes, entree ' + (usage.promptTokens ?? 0) +
      ', sortie ' + (usage.completionTokens ?? 0) +
      ', total ' + (usage.totalTokens ?? 0) + ' tokens.';
  }
  return 'Model usage updated: ' + (usage.stepsExecuted ?? 0) +
    ' requests, input ' + (usage.promptTokens ?? 0) +
    ', output ' + (usage.completionTokens ?? 0) +
    ', total ' + (usage.totalTokens ?? 0) + ' tokens.';
}

function emitTokenUsage(usage) {
  process.stdout.write('__TASK_TOKEN_USAGE__:' + JSON.stringify(usage) + '\\n');
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

function buildArtifactValidationRetryPrompt(validationError) {
  const requiredOutputs = phase === 'spec'
    ? [
        \`- Write or repair \${specDir}/\${artifacts.specFile}.\`,
        \`- Write or repair \${specDir}/\${artifacts.implementationPlan}.\`,
      ]
    : [
        \`- Write or repair \${specDir}/\${artifacts.implementationPlan}.\`,
      ];

  const retryIntro = [
    '## Retry Required',
    '',
    \`The previous CLI attempt exited successfully, but artifact validation failed: \${validationError}\`,
    '',
    'Repair the missing or invalid Autocode artifact now. Do not only describe the plan; actually write the file.',
  ];

  const planRules = [
    '## implementation_plan.md Requirements',
    '',
    '- It must be a single OpenSpec-style Markdown checklist.',
    '- It must include at least one executable subtask numbered like 1.1, 1.2, or 2.1.',
    '- A top-level phase such as "- [ ] 1. Implementation" is not enough by itself.',
    '- Each subtask should be small enough to implement and verify independently.',
  ];

  return [
    prompt,
    '',
    '---',
    '',
    ...retryIntro,
    '',
    '## Required Output',
    '',
    ...requiredOutputs,
    '',
    ...planRules,
    '',
    '~~~md',
    '# Implementation Plan',
    '',
    'Feature: <task title>',
    'Workflow: feature',
    'Status: pending',
    '',
    '- [ ] 1. Implementation',
    '',
    '  - [ ] 1.1 Implement the first concrete change',
    '    - Describe the implementation step.',
    '    - _Files to modify: path/to/file.ts_',
    '    - _Verification: npm test_',
    '~~~',
  ].join('\\n');
}

function planHasSubtasks() {
  try {
    const content = readFileSync(join(specDir, artifacts.implementationPlan), 'utf8');
    return /^\\s*-\\s+\\[[ xX/!-]\\]\\s+[A-Za-z0-9]+[.-][A-Za-z0-9]+(?:[.)])?\\s+.+/m.test(content);
  } catch {
    return false;
  }
}

function updatePlanRunningState() {
  const now = new Date().toISOString();
  const status = phase === 'coding' || phase === 'direct' ? 'coding' : 'planning';
  const phaseValue = phase === 'coding' || phase === 'direct' ? 'coding' : 'planning';
  updatePlanMetadata({
    status,
    planStatus: status,
    xstateState: phaseValue,
    reviewReason: undefined,
    executionPhase: phaseValue,
    updatedAt: now,
  });
}

function updatePlanStatus(failed, message, now) {
  const isCodingPhase = phase === 'coding' || phase === 'direct';
  updatePlanMetadata({
    status: failed ? 'error' : 'human_review',
    planStatus: failed ? 'error' : 'review',
    xstateState: failed ? 'error' : isCodingPhase ? 'human_review' : 'plan_review',
    reviewReason: failed ? 'errors' : isCodingPhase ? 'completed' : 'plan_review',
    executionPhase: failed ? 'failed' : isCodingPhase ? 'complete' : 'planning',
    updatedAt: now,
  });
}

function updatePlanMetadata(input) {
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
      \`Created: \${input.updatedAt}\`,
      '',
    ].join('\\n');
  }
  content = upsertPlanMetadata(content, 'Status', input.status);
  if (input.reviewReason) {
    content = upsertPlanMetadata(content, 'Review Reason', input.reviewReason);
  } else {
    content = removePlanMetadata(content, 'Review Reason');
  }
  content = upsertPlanMetadata(content, 'Execution Phase', input.executionPhase);
  content = upsertPlanMetadata(content, 'Updated', input.updatedAt);
  content = upsertPlanMachineMetadata(content, {
    planStatus: input.planStatus,
    xstateState: input.xstateState,
    last_updated: input.updatedAt,
  });
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

function removePlanMetadata(content, key) {
  const pattern = new RegExp(\`^\${key}:.*(?:\\r?\\n)?\`, 'm');
  return content.replace(pattern, '');
}

function upsertPlanMachineMetadata(content, updates) {
  const pattern = /^<!--\\s*autocode-plan-meta:\\s*(\\{.*\\})\\s*-->\\s*$/m;
  const existingMatch = pattern.exec(content);
  let metadata = {};
  if (existingMatch) {
    try {
      const parsed = JSON.parse(existingMatch[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed;
      }
    } catch {
      metadata = {};
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null || value === '') {
      delete metadata[key];
    } else {
      metadata[key] = value;
    }
  }

  const line = \`<!-- autocode-plan-meta: \${JSON.stringify(metadata)} -->\`;
  if (existingMatch) {
    return content.replace(pattern, line);
  }

  const lines = content.split(/\\r?\\n/);
  const insertAt = lines.findIndex((item, index) => index > 0 && item.trim() === '');
  const safeInsertAt = insertAt < 0 ? lines.length : insertAt;
  lines.splice(safeInsertAt, 0, line);
  return lines.join('\\n');
}

function appendTaskLogEntry(logPhase, type, message, detail, extra) {
  const now = new Date().toISOString();
  const logsPath = join(specDir, artifacts.taskLogs);
  const logs = readJson(logsPath) || createEmptyLogs(now);
  const phaseLog = logs.phases[logPhase] || { phase: logPhase, status: 'pending', started_at: null, completed_at: null, entries: [] };
  if (phaseLog.status === 'pending') {
    phaseLog.status = 'active';
  }
  phaseLog.started_at = phaseLog.started_at || now;
  phaseLog.entries.push({
    timestamp: now,
    type,
    content: limitLogText(message, 4000),
    phase: logPhase,
    ...(detail ? { detail: limitLogText(detail, 12000), collapsed: true } : {}),
    ...(extra ? dropUndefinedTokenUsage(extra) : {}),
  });
  logs.phases[logPhase] = phaseLog;
  logs.updated_at = now;
  writeJson(logsPath, logs);
}

function updateTaskLogs(logPhase, status, message) {
  const now = new Date().toISOString();
  const logsPath = join(specDir, artifacts.taskLogs);
  const logs = readJson(logsPath) || createEmptyLogs(now);
  const phaseLog = logs.phases[logPhase] || { phase: logPhase, status: 'pending', started_at: null, completed_at: null, entries: [] };
  phaseLog.status = status;
  phaseLog.started_at = phaseLog.started_at || now;
  if (status === 'active') {
    phaseLog.completed_at = null;
  } else if (status === 'completed' || status === 'failed') {
    phaseLog.completed_at = now;
  }
  phaseLog.entries.push({
    timestamp: now,
    type: status === 'failed' ? 'error' : status === 'completed' ? 'success' : 'info',
    content: limitLogText(message, 4000),
    phase: logPhase,
  });
  logs.phases[logPhase] = phaseLog;
  logs.updated_at = now;
  writeJson(logsPath, logs);
}

function createEmptyLogs(now) {
  return {
    spec_id: specDir.split(/[\\\\/]/).pop() || taskTitle,
    created_at: now,
    updated_at: now,
    phases: {
      planning: { phase: 'planning', status: 'pending', started_at: null, completed_at: null, entries: [] },
      coding: { phase: 'coding', status: 'pending', started_at: null, completed_at: null, entries: [] },
      validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] },
    },
  };
}

function isCodexJsonInvocation(command, args) {
  const commandName = String(command || '').split(/[\\\\/]/).pop().toLowerCase().replace(/\\.cmd$|\\.exe$/, '');
  return commandName === 'codex' && Array.isArray(args) && args.includes('--json');
}

function localizeMessage(key, fallback, values) {
  if (language !== 'zh-CN') {
    return fallback;
  }
  const phaseText = values?.phase || phase;
  const commandText = values?.command || command;
  switch (key) {
    case 'startCoding':
      return '开始使用 ' + commandText + ' 执行 Autocode ' + phaseText + ' 编码任务。';
    case 'startPlanning':
      return '开始使用 ' + commandText + ' 执行 Autocode ' + phaseText + ' 规划任务。';
    case 'completed':
      return 'Autocode CLI 运行完成。';
    default:
      return fallback;
  }
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function getFirstString(record, keys) {
  const source = asRecord(record);
  if (!source) {
    return undefined;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function stringifyCodexText(value) {
  if (typeof value === 'string') {
    return cleanLogText(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringifyCodexText(item)).filter(Boolean).join('\\n');
  }
  const record = asRecord(value);
  if (record) {
    for (const key of ['text', 'content', 'message', 'output']) {
      if (record[key] !== undefined) {
        const text = stringifyCodexText(record[key]);
        if (text) {
          return text;
        }
      }
    }
  }
  try {
    return cleanLogText(JSON.stringify(value));
  } catch {
    return cleanLogText(String(value));
  }
}

function readNumber(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function readOptionalNumber(value) {
  const number = readNumber(value);
  return number > 0 ? number : undefined;
}

function cleanLogText(value) {
  return String(value ?? '')
    .replace(/\\r\\n/g, '\\n')
    .replace(/\\r/g, '\\n')
    .replace(/\\x1B\\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]/g, '');
}

function limitLogText(value, maxLength) {
  const text = cleanLogText(value);
  return text.length > maxLength ? text.slice(0, maxLength - 3) + '...' : text;
}

function emitPhase(phase, message, progress) {
  process.stdout.write('__EXEC_PHASE__:' + JSON.stringify({ phase, message, progress }) + '\\n');
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
