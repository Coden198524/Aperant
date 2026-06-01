import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { buildAutocodeProjectDocsReferencePrompt } from '../project/project-docs.js';
import {
  getAutocodeSpecDir,
  listAutocodeTasks,
  resolveAutocodeTaskDevelopmentMode,
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
import {
  resolveAutocodeTaskRuntimeConcurrency,
  type AutocodeTaskRuntimeConcurrencyResolved,
} from '../runtime/concurrency.js';

export type AutocodeTaskRunPhase = 'direct' | 'spec' | 'planning' | 'coding';

export interface CreateAutocodeTaskRunPlanInput {
  projectRoot: string;
  dataDirName: string;
  taskId: string;
  projectId?: string;
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
const OPENSPEC_ARTIFACT_PROMPT_LIMIT = 12000;
const requireFromCore = createRequire(import.meta.url);

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
  const phase = input.phase ?? resolveRunPhase(specDir, task);
  const runtimeConcurrency = resolveAutocodeTaskRuntimeConcurrency(task.metadata);
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
      taskMetadata: task.metadata,
      projectId: input.projectId,
      language: input.language,
      runtimeConcurrency,
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

function resolveRunPhase(specDir: string, task: AutocodeTask): AutocodeTaskRunPhase {
  if (resolveAutocodeTaskDevelopmentMode(task.metadata) === 'fast' || task.metadata?.workflowMode === 'off') {
    return 'direct';
  }

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
  const isOpenSpecTask = input.task.metadata?.sourceType === 'openspec';
  const openSpecExecutionReference = buildTaskOpenSpecCompactContextReference({
    task: input.task,
    specDir: input.specDir,
    forcePlanning: false,
  });

  if (input.phase === 'direct') {
    return `${header}${contextReference}${humanInputReference}${[
      '## Goal',
      '',
      'Implement the task directly; no separate spec workflow.',
      '',
      '## Task Description',
      '',
      input.task.description || input.task.title,
      '',
      '## Required Workflow',
      '',
      '- Inspect the relevant project files before editing.',
      '- Make the smallest useful change.',
      '- Run the most relevant validation.',
      '- On Node 24+, do not mix require(...) with top-level await in node -e, stdin, or eval scripts; use an async IIFE or ESM import with node --input-type=module.',
      '- Avoid brittle smoke assertions against initial or transient task status; retries and resume can advance state. Verify final behavior or durable files unless the task explicitly changes state-machine code.',
      buildCliMemoryNotesInstruction(),
      `- Leave a short implementation summary in ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.directSummary}.`,
    ].join('\n')}`;
  }

  if (input.phase === 'spec') {
    return `${header}${contextReference}${humanInputReference}${[
      '## Goal',
      '',
      'Create initial spec artifacts.',
      '',
      '## Task Description',
      '',
      input.task.description || input.task.title,
      '',
      '## Required Output',
      '',
      `- Write ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile} with overview, scope, implementation notes, and success criteria.`,
      `- Update ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements} if the current task description needs structured requirements.`,
      `- Write ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.tasks} as an Autocode Markdown checklist with concrete phases and tasks.`,
      `- Do not write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}; the runner derives runtime work packages from ${AUTOCODE_TASK_ARTIFACTS.tasks}.`,
      '- Use [ ] for pending subtasks and concise metadata bullets: _Depends on_, _Requirements_, and _Verification_. Include _Files to create/modify_ when write intent is known.',
    ].join('\n')}`;
  }

  if (input.phase === 'planning') {
    const openSpecReference = buildTaskOpenSpecCompactContextReference({
      task: input.task,
      specDir: input.specDir,
      forcePlanning: true,
    });
    return `${header}${contextReference}${humanInputReference}${[
      ...(openSpecReference ? [openSpecReference, ''] : []),
      '## Goal',
      '',
      'Create or repair the implementation plan.',
      '',
      '## Required Output',
      '',
      `- Read ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile} and ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements} if needed.`,
      `- If ${input.specDir}/HUMAN_INPUT.md exists, address it as plan-review feedback.`,
      ...(isOpenSpecTask
        ? ['- Apply plan-review feedback to upstream OpenSpec artifacts first, then derive the downstream implementation plan.']
        : ['- Do not read or edit openspec/ artifacts for this Standard task.']),
      ...(isOpenSpecTask
        ? [`- Regenerate ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.implementationPlan} only from updated OpenSpec artifacts.`]
        : [
            `- Write ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.tasks} as the upstream Autocode task list.`,
            `- Do not write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}; the runner derives runtime work packages from ${AUTOCODE_TASK_ARTIFACTS.tasks}.`,
          ]),
      '- Keep tasks independently implementable and verifiable.',
      '- Every executable task must include _Depends on_ and _Verification_. Use _Depends on: none_ only for root work. Include _Files to create/modify_ when write intent is known.',
      '- Set new task checkboxes to [ ].',
    ].join('\n')}`;
  }

  return `${header}${contextReference}${humanInputReference}${openSpecExecutionReference ? `${openSpecExecutionReference}\n\n` : ''}${[
    '## Goal',
    '',
    'Implement the task from the existing spec and runtime work plan.',
    '',
    '## Required Workflow',
    '',
    `- Read ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.implementationPlan} first.`,
    ...(isOpenSpecTask
      ? [`- If ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.openSpecContext} exists, use it as the OpenSpec context and open full OpenSpec artifacts only for exact wording.`]
      : ['- Do not read openspec/ artifacts unless the current work item explicitly references them.']),
    `- Use ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile} only for missing acceptance details.`,
    '- The runner invokes you once per runtime work package. In each invocation, implement only the Current Work Item section.',
    '- Do not start later work packages early, even if they look related.',
    '- Do not edit implementation_plan.md or OpenSpec tasks.md status checkboxes during coding; the runner owns status updates after this invocation.',
    '- Put completion details in your final response or the implementation summary, not by editing plan status.',
    '- Run the most relevant validation command for the project.',
    '- On Node 24+, do not mix require(...) with top-level await in node -e, stdin, or eval scripts; use an async IIFE or ESM import with node --input-type=module.',
    '- Avoid brittle smoke assertions against initial or transient task status; retries and resume can advance state. Verify final behavior or durable files unless the task explicitly changes state-machine code.',
    buildCliMemoryNotesInstruction(),
    `- Leave a short implementation summary in ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.directSummary} or include completion details in your final response.`,
  ].join('\n')}`;
}

function buildCliMemoryNotesInstruction(): string {
  return [
    '- If you discover durable project knowledge, add a final "Memory Notes" section.',
    '- Memory Notes format: "- [gotcha|decision|pattern|error_pattern|module_insight] concise reusable note".',
    '- Omit Memory Notes when there is nothing durable to remember.',
  ].join('\n');
}

function buildTaskOpenSpecCompactContextReference(input: {
  task: AutocodeTask;
  specDir: string;
  forcePlanning: boolean;
}): string {
  const metadata = input.task.metadata ?? {};
  if (metadata.sourceType !== 'openspec') {
    return '';
  }

  const contextPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.openSpecContext);
  const artifacts = [
    { label: 'proposal.md', path: stringFrom(metadata.openSpecProposalPath) },
    { label: 'design.md', path: stringFrom(metadata.openSpecDesignPath) },
    { label: 'tasks.md', path: stringFrom(metadata.openSpecTasksPath) },
    ...toStringArray(metadata.openSpecSpecDeltaPaths).map((pathValue, index) => ({
      label: index === 0 ? 'spec delta' : `spec delta ${index + 1}`,
      path: pathValue,
    })),
  ].filter((artifact) => artifact.path);

  const lines = [
    '## OpenSpec Compact Context',
    '',
    'OpenSpec is the upstream specification layer. Autocode files are downstream runtime state.',
    stringFrom(metadata.openSpecChangeId) ? `Change ID: ${stringFrom(metadata.openSpecChangeId)}` : '',
    stringFrom(metadata.openSpecChangeDir) ? `Change directory: ${stringFrom(metadata.openSpecChangeDir)}` : '',
    `Compact context: ${contextPath}`,
    '',
    input.forcePlanning ? 'Request Changes rule:' : 'Execution rule:',
    input.forcePlanning
      ? '- If HUMAN_INPUT.md exists, update the relevant upstream OpenSpec Markdown files first: proposal.md, design.md, tasks.md, and/or specs/<capability>/spec.md.'
      : `- Read ${AUTOCODE_TASK_ARTIFACTS.openSpecContext} first and open full OpenSpec artifacts only for exact wording.`,
    input.forcePlanning
      ? `- Then regenerate ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.implementationPlan} from the updated OpenSpec artifacts.`
      : '- Treat implementation_plan.md as downstream runtime state, not product truth.',
    input.forcePlanning
      ? `- Do not make ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} the only changed planning artifact when feedback changes product behavior, requirements, design, or task scope.`
      : '- Complete the current runtime work package and update downstream status only.',
    input.forcePlanning ? '- Do not implement code in this planning pass.' : '',
    '',
    'OpenSpec artifact paths:',
    ...artifacts.map((artifact) => `- ${artifact.label}: ${artifact.path}`),
    '',
  ].filter(Boolean);

  if (existsSync(contextPath)) {
    try {
      lines.push('```markdown');
      lines.push(limitPromptText(readFileSync(contextPath, 'utf8'), OPENSPEC_ARTIFACT_PROMPT_LIMIT));
      lines.push('```');
    } catch {
      // Keep the path references even if the compact context cannot be read.
    }
  }

  return lines.join('\n');
}

function stringFrom(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => stringFrom(item)).filter(Boolean)
    : [];
}

function limitPromptText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
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
      'Write all non-code prose in Simplified Chinese, including plans, specs, summaries, and review notes.',
      'Keep code identifiers, commands, paths, API names, package names, and source text unchanged unless translation is requested.',
      'Final answer: concise Chinese markdown table with rows for changes, verification, and review notes.',
    ].join(' ');
  }

  if (language === 'fr') {
    return [
      'Write all non-code prose in French, including plans, specs, summaries, and review notes.',
      'Keep code identifiers, commands, paths, API names, package names, and source text unchanged unless translation is requested.',
      'Final answer: concise French markdown table with rows for changes, verification, and review notes.',
    ].join(' ');
  }

  return '';
}

function resolveOptionalRunnerDependency(moduleName: string): string | undefined {
  try {
    return requireFromCore.resolve(moduleName);
  } catch {
    return undefined;
  }
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
  taskMetadata?: unknown;
  projectId?: string;
  language?: AutocodeAgentLanguage;
  runtimeConcurrency: AutocodeTaskRuntimeConcurrencyResolved;
}): string {
  return `const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { TextDecoder } = require('node:util');

const cwd = ${JSON.stringify(input.cwd)};
const command = ${JSON.stringify(input.command)};
const args = ${JSON.stringify(input.args)};
const iconvLiteModulePath = ${JSON.stringify(resolveOptionalRunnerDependency('iconv-lite'))};
const workPackagesModulePath = ${JSON.stringify(resolveOptionalRunnerDependency('@autocode/core/tasks/work-packages') ?? resolveOptionalRunnerDependency('./work-packages.js'))};
const libsqlSqlite3ModulePath = ${JSON.stringify(resolveOptionalRunnerDependency('@libsql/client/sqlite3'))};
const promptFilePath = ${JSON.stringify(input.promptFilePath)};
const phase = ${JSON.stringify(input.phase)};
const specDir = ${JSON.stringify(input.specDir)};
const taskTitle = ${JSON.stringify(input.taskTitle)};
const taskDescription = ${JSON.stringify(input.taskDescription)};
const taskMetadata = ${JSON.stringify(input.taskMetadata ?? {})};
const projectId = ${JSON.stringify(input.projectId)};
const language = ${JSON.stringify(input.language)};
const runtimeConcurrency = ${JSON.stringify(input.runtimeConcurrency)};
const artifacts = ${JSON.stringify(AUTOCODE_TASK_ARTIFACTS)};
const fileWriteLockScope = inferFileWriteLockScope();
const iconvLite = loadIconvLite();
const prompt = readFileSync(promptFilePath, 'utf8');
const logPhase = phase === 'coding' || phase === 'direct' ? 'coding' : 'planning';
const executionPhase = logPhase === 'coding' ? 'coding' : 'planning';
const codexJsonMode = isCodexJsonInvocation(command, args);
const activeFileWriteLockDirs = new Set();
const maxValidationRetries = phase === 'spec' || phase === 'planning' ? 2 : 0;
let validationRetryCount = 0;
let attemptId = 0;
let memoryContextBlock = '';
const pendingMemoryWrites = [];
const startMessage = logPhase === 'coding'
  ? localizeMessage('startCoding', \`Starting Autocode \${phase} coding session with \${command}.\`, { phase, command })
  : localizeMessage('startPlanning', \`Starting Autocode \${phase} planning session with \${command}.\`, { phase, command });

emitPhase(executionPhase, startMessage, 0);
updatePlanRunningState();
updateTaskLogs(logPhase, 'active', startMessage);

let finalized = false;
let tokenUsageEventCount = 0;
let lastTokenUsageLogTotal = 0;
let gb18030Decoder = undefined;
const defaultAttemptState = createAttemptState('main');
const codingWorkerLimit = phase === 'coding' && runtimeConcurrency.mode === 'concurrent'
  ? Math.max(1, Math.floor(runtimeConcurrency.workers || 1))
  : 1;
const activeCodingAttempts = new Map();
const activeCodingSubtaskIds = new Set();
const completedCodingSubtaskIds = new Set();
const failedCodingSubtaskIds = new Set();
const codingFailures = [];
let nextCodingWorkerId = 0;
const MODEL_OUTPUT_FLUSH_MS = 750;
const MODEL_OUTPUT_MAX_CHARS = 3500;
const CODING_WORKER_INACTIVITY_TIMEOUT_MS = readPositiveInteger(
  process.env.AUTOCODE_WORKER_INACTIVITY_TIMEOUT_MS,
  10 * 60 * 1000,
);
const CODING_WORKER_COMPLETION_GRACE_MS = readPositiveInteger(
  process.env.AUTOCODE_WORKER_COMPLETION_GRACE_MS,
  45 * 1000,
);

initializeCliMemoryRuntime()
  .then((contextBlock) => {
    memoryContextBlock = contextBlock;
    if (phase === 'coding') {
      startCodingWorkQueue();
    } else {
      startAttempt(buildPromptWithMemoryContext(prompt));
    }
  })
  .catch((error) => {
    appendTaskLogEntry(logPhase, 'info', 'Memory context unavailable: ' + (error instanceof Error ? error.message : String(error)));
    if (phase === 'coding') {
      startCodingWorkQueue();
    } else {
      startAttempt(prompt);
    }
  });

async function initializeCliMemoryRuntime() {
  if (!isCliMemoryEnabled()) {
    return '';
  }
  const memories = [
    ...loadCliLocalSessionMemories(4),
    ...await searchCliMemoryDatabase(taskDescription || taskTitle, 8),
  ];
  const deduped = dedupeCliMemories(memories).slice(0, 8);
  if (deduped.length === 0) {
    return '';
  }
  const lines = [
    '## Project Memory',
    '',
    'Use these prior outcomes, gotchas, and decisions when relevant. Do not repeat failed approaches.',
    '',
  ];
  for (const memory of deduped) {
    const files = memory.relatedFiles && memory.relatedFiles.length > 0
      ? ' Files: ' + memory.relatedFiles.join(', ') + '.'
      : '';
    lines.push('- [' + memory.type + '] ' + limitLogText(memory.content, 900) + files);
  }
  return lines.join('\\n');
}

function buildPromptWithMemoryContext(basePrompt) {
  if (!memoryContextBlock) {
    return basePrompt;
  }
  return [basePrompt, '', '---', '', memoryContextBlock].join('\\n');
}

function isCliMemoryEnabled() {
  return String(process.env.GRAPHITI_ENABLED || 'true').toLowerCase() !== 'false';
}

function getCliMemoryProjectId() {
  return projectId ||
    (taskMetadata && typeof taskMetadata.projectId === 'string' && taskMetadata.projectId.trim()) ||
    (taskMetadata && typeof taskMetadata.project_id === 'string' && taskMetadata.project_id.trim()) ||
    cwd;
}

function getCliMemorySessionId(workUnitId) {
  return 'cli:' + (specDir.split(/[\\\\/]/).pop() || taskTitle) + ':' + workUnitId + ':' + Date.now();
}

function loadCliLocalSessionMemories(limit) {
  const dir = join(specDir, 'memory', 'session_insights');
  if (!existsSync(dir)) {
    return [];
  }
  try {
    return readdirSync(dir)
      .filter((name) => /^session_.+\\.json$/i.test(name))
      .map((name) => {
        const filePath = join(dir, name);
        return { filePath, stat: statSync(filePath) };
      })
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, limit)
      .map(({ filePath }) => {
        const insight = readJson(filePath);
        if (!insight) return null;
        return {
          id: insight.sessionId || filePath,
          type: 'work_unit_outcome',
          content: Array.isArray(insight.insights)
            ? insight.insights.filter(Boolean).join('\\n')
            : JSON.stringify(insight),
          confidence: 0.7,
          relatedFiles: Array.isArray(insight.keyFiles) ? insight.keyFiles : [],
          createdAt: insight.timestamp || new Date().toISOString(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function searchCliMemoryDatabase(query, limit) {
  if (!libsqlSqlite3ModulePath) {
    return [];
  }
  let client = null;
  try {
    const mod = require(libsqlSqlite3ModulePath);
    client = mod.createClient({ url: 'file:' + resolveCliMemoryDatabasePath() });
    await ensureCliMemorySchema(client);
    const projectFilter = getCliMemoryProjectId();
    const ftsRows = query
      ? await client.execute({
          sql:
            'SELECT m.id, m.type, m.content, m.confidence, m.related_files, m.tags, m.created_at ' +
            'FROM memories_fts f JOIN memories m ON m.id = f.memory_id ' +
            'WHERE memories_fts MATCH ? AND m.project_id = ? AND m.deprecated = 0 ' +
            'ORDER BY bm25(memories_fts) LIMIT ?',
          args: [sanitizeCliFtsQuery(query), projectFilter, limit],
        }).catch(() => ({ rows: [] }))
      : { rows: [] };
    const rows = ftsRows.rows.length > 0
      ? ftsRows
      : await client.execute({
          sql:
            'SELECT id, type, content, confidence, related_files, tags, created_at ' +
            'FROM memories WHERE project_id = ? AND deprecated = 0 ' +
            'ORDER BY created_at DESC LIMIT ?',
          args: [projectFilter, limit],
        });
    return rows.rows.map(cliMemoryRowToContextMemory);
  } catch {
    return [];
  } finally {
    try {
      client?.close();
    } catch {
      // Ignore close failures.
    }
  }
}

function recordCliWorkItemMemory(subtask, outcome, summary, explicitNotes) {
  if (!isCliMemoryEnabled()) {
    return null;
  }
  const now = new Date().toISOString();
  const files = getWorkItemFiles(subtask || {});
  const sessionId = getCliMemorySessionId(subtask.id || 'task');
  const memoryNotes = Array.isArray(explicitNotes) ? explicitNotes : [];
  const content = buildCliWorkUnitOutcomeContent(subtask, outcome, summary, files, now);
  const insight = {
    sessionId,
    subtaskId: subtask.id || 'task',
    timestamp: now,
    outcome,
    insights: [
      summary || content,
      ...memoryNotes.map((note) => note.content),
    ].filter(Boolean),
    keyFiles: files,
    source: 'cli-runner',
    workUnit: {
      id: subtask.id || 'task',
      title: subtask.title || taskTitle,
      description: Array.isArray(subtask.details) && subtask.details.length > 0 ? subtask.details.join('\\n') : taskDescription,
      upstreamTaskIds: Array.isArray(subtask.upstreamTaskIds) ? subtask.upstreamTaskIds : [],
    },
  };
  writeCliSessionInsight(sessionId, insight);
  pendingMemoryWrites.push(storeCliMemoryDatabaseEntry({
    id: randomUUID(),
    type: 'work_unit_outcome',
    content,
    confidence: outcome === 'success' ? 0.82 : 0.72,
    tags: ['work_unit', outcome, 'cli-runner', phase].filter(Boolean),
    relatedFiles: files,
    relatedModules: [],
    createdAt: now,
    sessionId,
    scope: 'work_unit',
    source: 'agent_explicit',
    projectId: getCliMemoryProjectId(),
    workUnitRef: {
      methodology: 'autocode',
      hierarchy: [phase, subtask.id || 'task'],
      label: (subtask.id || 'task') + (subtask.title ? ': ' + subtask.title : ''),
    },
    citationText: summary,
  }));
  for (const note of memoryNotes) {
    pendingMemoryWrites.push(storeCliMemoryDatabaseEntry({
      id: randomUUID(),
      type: note.type,
      content: note.content,
      confidence: 0.78,
      tags: ['cli-runner', 'explicit_memory', phase, note.type].filter(Boolean),
      relatedFiles: files,
      relatedModules: [],
      createdAt: now,
      sessionId,
      scope: files.length > 0 ? 'module' : 'session',
      source: 'agent_explicit',
      projectId: getCliMemoryProjectId(),
      workUnitRef: {
        methodology: 'autocode',
        hierarchy: [phase, subtask.id || 'task', 'memory_notes'],
        label: (subtask.id || 'task') + ' memory note',
      },
      citationText: note.content,
    }));
  }
  return sessionId;
}

function writeCliSessionInsight(sessionId, insight) {
  try {
    const dir = join(specDir, 'memory', 'session_insights');
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'session_' + safeFileSegment(sessionId) + '.json'), insight);
  } catch (error) {
    appendTaskLogEntry('coding', 'info', 'Failed to write session memory: ' + (error instanceof Error ? error.message : String(error)));
  }
}

async function storeCliMemoryDatabaseEntry(entry) {
  if (!libsqlSqlite3ModulePath) {
    return;
  }
  let client = null;
  try {
    const mod = require(libsqlSqlite3ModulePath);
    client = mod.createClient({ url: 'file:' + resolveCliMemoryDatabasePath() });
    await ensureCliMemorySchema(client);
    await client.batch([
      {
        sql:
          'INSERT OR REPLACE INTO memories (' +
          'id, type, content, confidence, tags, related_files, related_modules, created_at, last_accessed_at, access_count, ' +
          'session_id, scope, work_unit_ref, methodology, source, relations, provenance_session_ids, needs_review, pinned, citation_text, project_id, trust_level_scope, deprecated' +
          ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0)',
        args: [
          entry.id,
          entry.type,
          entry.content,
          entry.confidence,
          JSON.stringify(entry.tags || []),
          JSON.stringify(entry.relatedFiles || []),
          JSON.stringify(entry.relatedModules || []),
          entry.createdAt,
          entry.createdAt,
          entry.sessionId,
          entry.scope,
          JSON.stringify(entry.workUnitRef || null),
          'autocode',
          entry.source,
          '[]',
          '[]',
          entry.citationText || null,
          entry.projectId,
          'personal',
        ],
      },
      {
        sql: 'INSERT INTO memories_fts (memory_id, content, tags, related_files) VALUES (?, ?, ?, ?)',
        args: [
          entry.id,
          entry.content,
          (entry.tags || []).join(' '),
          (entry.relatedFiles || []).join(' '),
        ],
      },
    ]);
  } catch (error) {
    appendTaskLogEntry('coding', 'info', 'Memory DB write skipped: ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    try {
      client?.close();
    } catch {
      // Ignore close failures.
    }
  }
}

async function flushCliMemoryWrites() {
  if (pendingMemoryWrites.length === 0) {
    return;
  }
  const writes = pendingMemoryWrites.splice(0, pendingMemoryWrites.length);
  await Promise.allSettled(writes);
}

async function ensureCliMemorySchema(client) {
  await client.execute(
    'CREATE TABLE IF NOT EXISTS memories (' +
    'id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.8, ' +
    'tags TEXT NOT NULL DEFAULT \\'[]\\', related_files TEXT NOT NULL DEFAULT \\'[]\\', related_modules TEXT NOT NULL DEFAULT \\'[]\\', ' +
    'created_at TEXT NOT NULL, last_accessed_at TEXT NOT NULL, access_count INTEGER NOT NULL DEFAULT 0, session_id TEXT, commit_sha TEXT, ' +
    'scope TEXT NOT NULL DEFAULT \\'global\\', work_unit_ref TEXT, methodology TEXT, source TEXT NOT NULL DEFAULT \\'agent_explicit\\', ' +
    'target_node_id TEXT, impacted_node_ids TEXT DEFAULT \\'[]\\', relations TEXT NOT NULL DEFAULT \\'[]\\', decay_half_life_days REAL, ' +
    'provenance_session_ids TEXT DEFAULT \\'[]\\', needs_review INTEGER NOT NULL DEFAULT 0, user_verified INTEGER NOT NULL DEFAULT 0, ' +
    'citation_text TEXT, pinned INTEGER NOT NULL DEFAULT 0, deprecated INTEGER NOT NULL DEFAULT 0, deprecated_at TEXT, stale_at TEXT, ' +
    'project_id TEXT NOT NULL, trust_level_scope TEXT DEFAULT \\'personal\\', chunk_type TEXT, chunk_start_line INTEGER, chunk_end_line INTEGER, ' +
    'context_prefix TEXT, embedding_model_id TEXT)'
  );
  await client.execute(
    'CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, content, tags, related_files, tokenize=\\'porter unicode61\\')'
  );
}

function buildCliWorkUnitOutcomeContent(subtask, outcome, summary, files, completedAt) {
  const title = subtask.title ? ' (' + subtask.title + ')' : '';
  const upstream = Array.isArray(subtask.upstreamTaskIds) && subtask.upstreamTaskIds.length > 0
    ? 'Upstream tasks: ' + subtask.upstreamTaskIds.join(', ')
    : '';
  return [
    'Work unit ' + (subtask.id || 'task') + title + ' finished with outcome: ' + outcome + '.',
    Array.isArray(subtask.details) && subtask.details.length > 0 ? 'Task: ' + subtask.details.join('\\n') : '',
    summary ? 'Summary: ' + summary : '',
    upstream,
    files.length > 0 ? 'Files: ' + files.join(', ') : '',
    'Completed at: ' + completedAt,
  ].filter(Boolean).join('\\n');
}

function resolveCliMemoryDatabasePath() {
  const database = normalizeCliDatabaseFilename(process.env.GRAPHITI_DATABASE || 'auto_claude_memory');
  const configuredPath = process.env.GRAPHITI_DB_PATH || join(getCliHomeDir(), '.autocode', 'memories');
  const expanded = expandCliHomePath(configuredPath);
  const basePath = resolve(expanded);
  mkdirSync(basePath, { recursive: true });
  return join(basePath, database);
}

function getCliHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || cwd;
}

function expandCliHomePath(value) {
  const text = String(value || '').trim();
  if (text === '~') return getCliHomeDir();
  if (text.startsWith('~/') || text.startsWith('~\\\\')) {
    return join(getCliHomeDir(), text.slice(2));
  }
  return text;
}

function normalizeCliDatabaseFilename(value) {
  const name = String(value || 'auto_claude_memory').trim() || 'auto_claude_memory';
  return name.toLowerCase().endsWith('.db') ? name : name + '.db';
}

function cliMemoryRowToContextMemory(row) {
  return {
    id: String(row.id || ''),
    type: String(row.type || 'work_unit_outcome'),
    content: String(row.content || ''),
    confidence: Number(row.confidence || 0.7),
    relatedFiles: parseJsonArray(row.related_files),
    createdAt: String(row.created_at || ''),
  };
}

function dedupeCliMemories(memories) {
  const seen = new Set();
  const result = [];
  for (const memory of memories) {
    if (!memory || !memory.content) continue;
    const key = memory.id || memory.content;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(memory);
  }
  return result;
}

function sanitizeCliFtsQuery(value) {
  const words = String(value || '')
    .replace(/["'\\x60*()[\\]{}:]/g, ' ')
    .split(/\\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2)
    .slice(0, 12);
  return words.length > 0 ? words.join(' OR ') : 'Autocode';
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeFileSegment(value) {
  return String(value || 'memory').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 160);
}

function extractCliMemoryNotes(text) {
  const normalized = String(text || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
  const match = /^#{1,6}\\s*Memory Notes\\s*$/im.exec(normalized);
  if (!match) {
    return [];
  }
  const section = normalized.slice(match.index + match[0].length);
  const nextHeading = /\\n#{1,6}\\s+\\S/.exec(section);
  const body = (nextHeading ? section.slice(0, nextHeading.index) : section).trim();
  const notes = [];
  for (const line of body.split('\\n')) {
    const bullet = /^\\s*(?:[-*]|\\d+[.)])\\s+(.*)$/.exec(line);
    if (!bullet) continue;
    let content = bullet[1].trim();
    let type = 'module_insight';
    const typed = /^\\[([a-z_]+)\\]\\s*(.*)$/.exec(content);
    if (typed) {
      type = normalizeCliMemoryNoteType(typed[1]);
      content = typed[2].trim();
    }
    if (content.length >= 10) {
      notes.push({ type, content: limitLogText(content, 500) });
    }
  }
  return notes.slice(0, 5);
}

function normalizeCliMemoryNoteType(value) {
  const type = String(value || '').trim().toLowerCase();
  if ([
    'gotcha',
    'decision',
    'pattern',
    'error_pattern',
    'module_insight',
    'dead_end',
    'causal_dependency',
    'requirement',
  ].includes(type)) {
    return type;
  }
  return 'module_insight';
}

function startAttempt(attemptPrompt, subtaskId) {
  const currentAttemptId = ++attemptId;
  const state = defaultAttemptState;
  state.attemptId = currentAttemptId;
  state.subtaskId = subtaskId;
  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  child.stdin.end(attemptPrompt);
  child.stdout.on('data', (data) => {
    handleChildOutput('stdout', data, state);
  });
  child.stderr.on('data', (data) => {
    handleChildOutput('stderr', data, state);
  });
  child.on('error', (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    finalize(currentAttemptId, 1, undefined, error instanceof Error ? error.message : String(error))
      .catch((finalizeError) => finishRun(1, undefined, finalizeError instanceof Error ? finalizeError.message : String(finalizeError), undefined));
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(\`Autocode CLI exited by signal: \${signal}\`);
      finalize(currentAttemptId, 1, signal, \`Autocode CLI exited by signal: \${signal}\`)
        .catch((finalizeError) => finishRun(1, signal, finalizeError instanceof Error ? finalizeError.message : String(finalizeError), undefined));
      return;
    }
    finalize(currentAttemptId, code ?? 0, undefined)
      .catch((finalizeError) => finishRun(1, undefined, finalizeError instanceof Error ? finalizeError.message : String(finalizeError), undefined));
  });
}

async function finalize(currentAttemptId, exitCode, signal, explicitError) {
  if (finalized || currentAttemptId !== attemptId) return;
  flushCodexJsonOutput(defaultAttemptState);
  flushModelOutput(defaultAttemptState);

  const validationError = exitCode === 0 ? await validateExpectedArtifacts() : undefined;
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
    defaultAttemptState.lastCodexMessageText = '';
    startAttempt(buildPromptWithMemoryContext(buildArtifactValidationRetryPrompt(validationError)));
    return;
  }

  finishRun(exitCode, signal, explicitError, validationError);
}

async function finishRun(exitCode, signal, explicitError, validationError) {
  if (finalized) return;
  finalized = true;
  syncOpenSpecTasksFromPlan();
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

  if (phase === 'direct' || (!failed && phase === 'coding')) {
    const finalText = defaultAttemptState.lastCodexMessageText || result.message;
    const memoryNotes = extractCliMemoryNotes(finalText);
    recordCliWorkItemMemory({
      id: phase === 'direct' ? 'direct-implementation' : 'task-execution',
      title: taskTitle,
      details: [taskDescription],
      filesToModify: [],
      filesToCreate: [],
      patternFiles: [],
      upstreamTaskIds: [],
    }, failed ? 'failure' : 'success', result.message, memoryNotes);
  }

  writeJson(join(specDir, artifacts.runResult), result);
  updatePlanStatus(failed, result.message, now);
  updateTaskLogs(logPhase, failed ? 'failed' : 'completed', result.message);
  await flushCliMemoryWrites();
  emitPhase(failed ? 'failed' : phase === 'coding' || phase === 'direct' ? 'complete' : executionPhase, result.message, failed ? 0 : 100);
  process.exit(failed ? 1 : 0);
}

function createAttemptState(label, subtaskId) {
  return {
    label,
    subtaskId,
    attemptId: 0,
    child: null,
    lastOutputAt: Date.now(),
    pendingModelOutput: '',
    modelOutputFlushTimer: null,
    inactivityTimer: null,
    completionGraceTimer: null,
    codexJsonLineBuffer: '',
    lastCodexMessageText: '',
    finalizing: false,
  };
}

function isCodingWorkerAttempt(state) {
  return Boolean(state?.subtaskId && activeCodingAttempts.has(state.attemptId));
}

function shouldAttachAttemptSubtaskId(state) {
  return Boolean(
    state?.subtaskId &&
    phase === 'coding' &&
    runtimeConcurrency.mode === 'concurrent' &&
    codingWorkerLimit > 1
  );
}

function buildAttemptLogExtra(state, extra) {
  return {
    ...(extra || {}),
    ...(shouldAttachAttemptSubtaskId(state) ? { subtask_id: state.subtaskId } : {}),
  };
}

function refreshAttemptActivity(state) {
  if (!state) {
    return;
  }
  state.lastOutputAt = Date.now();
  if (state.completionGraceTimer) {
    clearTimeout(state.completionGraceTimer);
    state.completionGraceTimer = null;
  }
  scheduleAttemptInactivityWatchdog(state);
}

function scheduleAttemptInactivityWatchdog(state) {
  if (!isCodingWorkerAttempt(state) || CODING_WORKER_INACTIVITY_TIMEOUT_MS <= 0) {
    return;
  }
  if (state.inactivityTimer) {
    clearTimeout(state.inactivityTimer);
  }
  state.inactivityTimer = setTimeout(() => {
    if (!isCodingWorkerAttempt(state) || state.finalizing) {
      return;
    }
    const idleMs = Date.now() - (state.lastOutputAt || 0);
    if (idleMs < CODING_WORKER_INACTIVITY_TIMEOUT_MS) {
      scheduleAttemptInactivityWatchdog(state);
      return;
    }
    const message = 'Coding worker ' + state.label + ' for ' + state.subtaskId +
      ' produced no output for ' + formatDuration(CODING_WORKER_INACTIVITY_TIMEOUT_MS) + '; marking it failed.';
    appendTaskLogEntry('coding', 'error', message, undefined, buildAttemptLogExtra(state));
    terminateAttemptChild(state, 'inactivity timeout');
    finalizeCodingAttempt(state.attemptId, 1, undefined, message);
  }, CODING_WORKER_INACTIVITY_TIMEOUT_MS);
}

function scheduleAttemptCompletionGrace(state) {
  if (!isCodingWorkerAttempt(state) || state.completionGraceTimer || state.finalizing || !state.lastCodexMessageText) {
    return;
  }
  state.completionGraceTimer = setTimeout(() => {
    if (!isCodingWorkerAttempt(state) || state.finalizing) {
      return;
    }
    const message = 'Coding worker ' + state.label + ' for ' + state.subtaskId +
      ' finished model output but the CLI process did not exit; finalizing the work item.';
    appendTaskLogEntry('coding', 'info', message, undefined, buildAttemptLogExtra(state));
    terminateAttemptChild(state, 'model completed');
    finalizeCodingAttempt(state.attemptId, 0, undefined);
  }, CODING_WORKER_COMPLETION_GRACE_MS);
}

function clearAttemptTimers(state) {
  if (!state) {
    return;
  }
  if (state.modelOutputFlushTimer) {
    clearTimeout(state.modelOutputFlushTimer);
    state.modelOutputFlushTimer = null;
  }
  if (state.inactivityTimer) {
    clearTimeout(state.inactivityTimer);
    state.inactivityTimer = null;
  }
  if (state.completionGraceTimer) {
    clearTimeout(state.completionGraceTimer);
    state.completionGraceTimer = null;
  }
}

function terminateAttemptChild(state, reason) {
  const child = state?.child;
  if (!child || child.killed) {
    return;
  }
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => {
        try {
          child.kill();
        } catch {
          // Ignore best-effort cleanup failures.
        }
      });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // The process may already have exited.
  }
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds >= 60) {
    return Math.round(seconds / 60) + 'm';
  }
  return seconds + 's';
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function startCodingWorkQueue() {
  resetInProgressCodingSubtasks();
  const progress = getCodingProgress();
  if (progress.total === 0 || !hasPendingCodingWork()) {
    finishRun(0, undefined, undefined, undefined);
    return;
  }

  const workerCount = Math.min(codingWorkerLimit, Math.max(1, progress.total));
  appendTaskLogEntry('coding', 'info', 'Starting ' + workerCount + ' coding worker(s).');
  fillCodingWorkers();
}

function fillCodingWorkers() {
  if (finalized) return;

  while (activeCodingAttempts.size < codingWorkerLimit) {
    const subtask = findNextRunnableSubtask();
    if (!subtask) {
      break;
    }
    startCodingWorkerAttempt(subtask);
  }

  if (activeCodingAttempts.size === 0) {
    finishCodingWorkQueue();
  }
}

function startCodingWorkerAttempt(subtask) {
  const workerId = ++nextCodingWorkerId;
  const currentAttemptId = ++attemptId;
  const state = createAttemptState('worker-' + workerId, subtask.id);
  state.attemptId = currentAttemptId;
  activeCodingSubtaskIds.add(subtask.id);
  activeCodingAttempts.set(currentAttemptId, { state, subtask, workerId });
  markPlanSubtaskStatus(subtask.id, 'in_progress');
  restoreKnownCodingStatuses(subtask.id);
  syncOpenSpecTasksFromPlan();

  const progress = getCodingProgress();
  const workLabel = subtask.workPackage ? 'work package' : 'subtask';
  const message = 'Worker ' + workerId + ' coding ' + workLabel + ' ' + subtask.id + ': ' + subtask.title;
  updateTaskLogs('coding', 'active', message);
  appendTaskLogEntry('coding', 'info', message, undefined, buildAttemptLogExtra(state));
  emitPhase('coding', message, progress.percent);

  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  state.child = child;
  state.lastOutputAt = Date.now();
  scheduleAttemptInactivityWatchdog(state);

  child.stdin.end(buildFocusedSubtaskPrompt(subtask));
  child.stdout.on('data', (data) => {
    handleChildOutput('stdout', data, state);
  });
  child.stderr.on('data', (data) => {
    handleChildOutput('stderr', data, state);
  });
  child.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    finalizeCodingAttempt(currentAttemptId, 1, undefined, message);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      const message = 'Autocode CLI exited by signal: ' + signal;
      console.error(message);
      finalizeCodingAttempt(currentAttemptId, 1, signal, message);
      return;
    }
    finalizeCodingAttempt(currentAttemptId, code ?? 0, undefined);
  });
}

function finalizeCodingAttempt(currentAttemptId, exitCode, signal, explicitError) {
  if (finalized) return;
  const attempt = activeCodingAttempts.get(currentAttemptId);
  if (!attempt) return;

  attempt.state.finalizing = true;
  clearAttemptTimers(attempt.state);
  activeCodingAttempts.delete(currentAttemptId);
  activeCodingSubtaskIds.delete(attempt.subtask.id);
  flushCodexJsonOutput(attempt.state);
  flushModelOutput(attempt.state);

  if (exitCode !== 0 || explicitError) {
    const reason = explicitError || signal || 'CLI work item run failed.';
    const memoryNotes = extractCliMemoryNotes(attempt.state.lastCodexMessageText);
    failedCodingSubtaskIds.add(attempt.subtask.id);
    codingFailures.push(attempt.subtask.id + ': ' + reason);
    appendTaskLogEntry(
      'coding',
      'error',
      'Work item ' + attempt.subtask.id + ' failed: ' + reason,
      undefined,
      buildAttemptLogExtra(attempt.state),
    );
    markPlanSubtaskStatus(attempt.subtask.id, 'failed', reason);
    recordCliWorkItemMemory(attempt.subtask, 'failure', reason, memoryNotes);
  } else {
    const memoryNotes = extractCliMemoryNotes(attempt.state.lastCodexMessageText);
    completedCodingSubtaskIds.add(attempt.subtask.id);
    appendTaskLogEntry(
      'coding',
      'success',
      'Work item ' + attempt.subtask.id + ' completed.',
      undefined,
      buildAttemptLogExtra(attempt.state),
    );
    markPlanSubtaskStatus(attempt.subtask.id, 'completed', 'Completed by Autocode CLI runner.');
    recordCliWorkItemMemory(attempt.subtask, 'success', 'Completed by Autocode CLI runner.', memoryNotes);
  }

  restoreKnownCodingStatuses(attempt.subtask.id);
  syncOpenSpecTasksFromPlan();
  fillCodingWorkers();
}

function finishCodingWorkQueue() {
  const progress = getCodingProgress();
  const planItems = readPlanItems();
  const pendingCount = planItems
    .filter((item) => item.isSubtask && item.status === 'pending')
    .length;
  const dependencyBlockedItems = getDependencyBlockedPlanItems(planItems);
  if (codingFailures.length > 0 || failedCodingSubtaskIds.size > 0) {
    finishRun(1, undefined, codingFailures.join('; ') || 'One or more coding work items failed.', undefined);
    return;
  }
  if (dependencyBlockedItems.length > 0) {
    for (const item of dependencyBlockedItems) {
      markPlanSubtaskStatus(item.id, 'blocked', formatRunnerDependencyBlocker(item));
    }
    syncOpenSpecTasksFromPlan();
    finishRun(
      1,
      undefined,
      'Coding incomplete because dependencies are unresolved: ' + dependencyBlockedItems
        .map((item) => formatRunnerDependencyBlocker(item))
        .join('; '),
      undefined,
    );
    return;
  }
  if (pendingCount > 0 || progress.completed < progress.total) {
    finishRun(1, undefined, 'Coding incomplete: ' + progress.completed + '/' + progress.total + ' work items completed.', undefined);
    return;
  }
  finishRun(0, undefined, undefined, undefined);
}

function restoreKnownCodingStatuses(currentSubtaskId) {
  for (const subtaskId of completedCodingSubtaskIds) {
    markPlanSubtaskStatus(subtaskId, 'completed', 'Completed by Autocode CLI runner.');
  }
  for (const subtaskId of failedCodingSubtaskIds) {
    markPlanSubtaskStatus(subtaskId, 'failed', 'CLI work item run failed.');
  }
  for (const subtaskId of activeCodingSubtaskIds) {
    if (subtaskId !== currentSubtaskId && !completedCodingSubtaskIds.has(subtaskId) && !failedCodingSubtaskIds.has(subtaskId)) {
      markPlanSubtaskStatus(subtaskId, 'in_progress');
    }
  }
}

function buildFocusedSubtaskPrompt(subtask) {
  const workLabel = subtask.workPackage ? 'Work Package' : 'Subtask';
  const workflowRules = subtask.workPackage
    ? [
        '- Implement every upstream OpenSpec task listed in this work package.',
        '- Do not implement later pending work packages in this invocation.',
        '- Keep other work package checkboxes unchanged.',
        '- Do not edit implementation_plan.md or OpenSpec tasks.md status checkboxes; this runner updates work package ' + subtask.id + ' after the CLI exits.',
        '- Return a concise completion summary for this work package.',
        '- On Node 24+, do not mix require(...) with top-level await in node -e, stdin, or eval scripts; use an async IIFE or ESM import with node --input-type=module.',
        '- Avoid brittle smoke assertions against initial or transient task status; retries and resume can advance state. Verify final behavior or durable files unless this work package explicitly changes state-machine code.',
      ]
    : [
        '- Implement only this current subtask.',
        '- Do not implement later pending subtasks in this invocation.',
        '- Keep other subtask checkboxes unchanged.',
        '- Do not edit implementation_plan.md status checkboxes; this runner updates subtask ' + subtask.id + ' after the CLI exits.',
        '- Return a concise completion summary for this subtask.',
        '- On Node 24+, do not mix require(...) with top-level await in node -e, stdin, or eval scripts; use an async IIFE or ESM import with node --input-type=module.',
        '- Avoid brittle smoke assertions against initial or transient task status; retries and resume can advance state. Verify final behavior or durable files unless this subtask explicitly changes state-machine code.',
      ];
  const fields = [
    '# Current Work Item',
    '',
    workLabel + ' ID: ' + subtask.id,
    'Phase: ' + (subtask.phaseName || 'Implementation'),
    'Title: ' + subtask.title,
    subtask.dependsOn && subtask.dependsOn.length > 0 ? 'Depends on completed work items: ' + subtask.dependsOn.join(', ') : '',
    subtask.upstreamTaskIds && subtask.upstreamTaskIds.length > 0 ? 'Upstream OpenSpec tasks: ' + subtask.upstreamTaskIds.join(', ') : '',
    subtask.upstreamSource ? 'Upstream source: ' + subtask.upstreamSource : '',
    '',
    'Description:',
    subtask.details.length > 0 ? subtask.details.join('\\n') : subtask.title,
    '',
    '## Required Workflow',
    ...workflowRules,
    '- If blocked, leave this work item incomplete and explain the blocker.',
  ].filter(Boolean);
  return [
    buildPromptWithMemoryContext(prompt),
    '',
    '---',
    '',
    ...fields,
  ].join('\\n');
}

function findNextRunnableSubtask() {
  const planItems = readPlanItems();
  const candidates = planItems
    .filter((item) => item.isSubtask && item.status === 'pending' && !activeCodingSubtaskIds.has(item.id));
  const analysis = analyzeRunnerWorkDependencies(candidates, getPlanItemStatusMap(planItems));
  return analysis.runnable.find((item) => !conflictsWithActiveCodingWork(item)) || null;
}

function hasPendingCodingWork() {
  return readPlanItems().some((item) => item.isSubtask && item.status === 'pending');
}

function conflictsWithActiveCodingWork(candidate) {
  const candidateFiles = getWorkItemFiles(candidate);

  const activeItems = readPlanItems()
    .filter((item) => item.isSubtask && activeCodingSubtaskIds.has(item.id));
  for (const active of activeItems) {
    const activeFiles = getWorkItemFiles(active);
    if (candidateFiles.length === 0 || activeFiles.length === 0) {
      continue;
    }
    if (candidateFiles.some((file) => activeFiles.some((activeFile) => workItemPathsOverlap(file, activeFile)))) {
      return true;
    }
  }
  return false;
}

function getPlanItemStatusMap(items) {
  const statusById = new Map();
  for (const item of items || readPlanItems()) {
    if (item.isSubtask) {
      statusById.set(item.id, item.status);
    }
  }
  return statusById;
}

function getDependencyBlockedPlanItems(items) {
  return analyzeRunnerWorkDependencies(
    items.filter((item) => item.isSubtask && item.status === 'pending'),
    getPlanItemStatusMap(items),
  ).blocked;
}

function formatRunnerDependencyBlocker(item) {
  const cycleIssue = (item.dependencyIssues || []).find((issue) => issue.type === 'cycle');
  if (cycleIssue && cycleIssue.cycle) {
    return item.id + ' blocked by dependency cycle ' + cycleIssue.cycle.join(' -> ');
  }
  const issueMessages = (item.dependencyIssues || [])
    .filter((issue) => issue.type === 'missing' || issue.type === 'self' || issue.type === 'duplicate')
    .map((issue) => issue.message);
  if (issueMessages.length > 0) {
    return item.id + ' blocked: ' + issueMessages.join('; ');
  }
  return item.id + ' waits for ' + (item.unresolvedDependencies || []).join(', ');
}

function analyzeRunnerWorkDependencies(items, statusById) {
  const issues = collectRunnerDependencyIssues(items, statusById);
  const issuesByItemId = new Map();
  for (const issue of issues) {
    const existing = issuesByItemId.get(issue.itemId) || [];
    existing.push(issue);
    issuesByItemId.set(issue.itemId, existing);
  }

  const runnable = [];
  const blocked = [];
  for (const item of items) {
    const unresolvedDependencies = getUnresolvedRunnerWorkDependencies(item, statusById);
    const itemIssues = issuesByItemId.get(item.id) || [];
    if (unresolvedDependencies.length === 0 && itemIssues.length === 0) {
      runnable.push(item);
    } else {
      blocked.push({
        ...item,
        unresolvedDependencies,
        dependencyIssues: itemIssues,
      });
    }
  }
  return { runnable, blocked, issues };
}

function getUnresolvedRunnerWorkDependencies(item, statusById) {
  return normalizeRunnerWorkDependencyIds(item.dependsOn)
    .filter((dependencyId) => dependencyId === item.id || statusById.get(dependencyId) !== 'completed');
}

function collectRunnerDependencyIssues(items, statusById) {
  const issues = [];
  const counts = new Map();
  for (const item of items) {
    if (!item.id) continue;
    counts.set(item.id, (counts.get(item.id) || 0) + 1);
  }
  const duplicateIds = new Set(
    Array.from(counts.entries())
      .filter((entry) => entry[1] > 1)
      .map((entry) => entry[0]),
  );
  for (const itemId of duplicateIds) {
    issues.push({
      type: 'duplicate',
      itemId,
      message: 'Duplicate work item id ' + itemId,
    });
  }
  for (const item of items) {
    for (const dependencyId of normalizeRunnerWorkDependencyIds(item.dependsOn)) {
      if (dependencyId === item.id) {
        issues.push({
          type: 'self',
          itemId: item.id,
          dependencyId,
          message: item.id + ' cannot depend on itself',
        });
      } else if (!statusById.has(dependencyId)) {
        issues.push({
          type: 'missing',
          itemId: item.id,
          dependencyId,
          message: item.id + ' depends on missing work item ' + dependencyId,
        });
      }
    }
  }
  return issues.concat(collectRunnerCycleIssues(items));
}

function collectRunnerCycleIssues(items) {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const visited = new Set();
  const visiting = new Set();
  const stack = [];
  const seenCycleKeys = new Set();
  const issues = [];

  const visit = (itemId) => {
    if (visiting.has(itemId)) {
      const cycleStart = stack.indexOf(itemId);
      if (cycleStart >= 0) {
        const cycle = stack.slice(cycleStart).concat(itemId);
        const key = canonicalRunnerCycleKey(cycle);
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          for (const cycleItemId of cycle.slice(0, -1)) {
            issues.push({
              type: 'cycle',
              itemId: cycleItemId,
              cycle,
              message: 'Dependency cycle detected: ' + cycle.join(' -> '),
            });
          }
        }
      }
      return;
    }
    if (visited.has(itemId)) return;
    const item = itemById.get(itemId);
    if (!item) return;

    visiting.add(itemId);
    stack.push(itemId);
    for (const dependencyId of normalizeRunnerWorkDependencyIds(item.dependsOn)) {
      if (dependencyId !== itemId && itemById.has(dependencyId)) {
        visit(dependencyId);
      }
    }
    stack.pop();
    visiting.delete(itemId);
    visited.add(itemId);
  };

  for (const item of items) {
    visit(item.id);
  }
  return issues;
}

function canonicalRunnerCycleKey(cycle) {
  const body = cycle.slice(0, -1);
  const rotations = body.map((_, index) => body.slice(index).concat(body.slice(0, index)).join('>'));
  return rotations.sort()[0] || body.join('>');
}

function normalizeRunnerWorkDependencyIds(value) {
  if (Array.isArray(value)) return normalizeRunnerStringArray(value);
  if (typeof value === 'string') {
    return [...new Set(value.split(',').map((item) => item.trim()).filter((item) => item && !isNoneDependencyToken(item)))];
  }
  return [];
}

function normalizeRunnerStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => String(item || '').trim()).filter((item) => item && !isNoneDependencyToken(item)))];
}

function isNoneDependencyToken(value) {
  return /^(none|no dependencies?|n\\/a|na|nil|null|无|无依赖|没有|没有依赖)$/i.test(String(value || '').trim());
}

function getWorkItemFiles(item) {
  return [...new Set([
    ...(item.filesToModify || []),
    ...(item.filesToCreate || []),
    ...(item.patternFiles || []),
  ].map(normalizeWorkItemFileIntent).filter(Boolean))];
}

function normalizeWorkItemFileIntent(file) {
  const normalized = String(file || '').trim().replace(/\\\\/g, '/').replace(/\\/+/g, '/').toLowerCase();
  if (!normalized || normalized === '.') {
    return '';
  }

  const wildcardIndex = normalized.search(/[*?[{]/);
  const stablePrefix = wildcardIndex >= 0 ? normalized.slice(0, wildcardIndex) : normalized;
  const pathLike = stablePrefix.replace(/\\/+\$/g, '');
  if (!pathLike || pathLike === '.') {
    return '';
  }

  const parts = [];
  for (const part of pathLike.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function workItemPathsOverlap(leftPath, rightPath) {
  return leftPath === rightPath ||
    leftPath.startsWith(rightPath + '/') ||
    rightPath.startsWith(leftPath + '/');
}

function resetInProgressCodingSubtasks() {
  for (const item of readPlanItems()) {
    if (item.isSubtask && item.status === 'in_progress') {
      markPlanSubtaskStatus(item.id, 'pending');
    }
  }
}

function getCodingProgress() {
  const subtasks = readPlanItems().filter((item) => item.isSubtask);
  const total = subtasks.length;
  const completed = subtasks.filter((item) => item.status === 'completed').length;
  return {
    total,
    completed,
    percent: total > 0 ? Math.round((completed / total) * 100) : 100,
  };
}

function readPlanItems() {
  let content = '';
  try {
    content = readFileSync(join(specDir, artifacts.implementationPlan), 'utf8');
  } catch {
    return [];
  }
  const planMetadata = parsePlanMachineMetadata(content);
  const subtaskMetadata = planMetadata && planMetadata.subtaskMetadata && typeof planMetadata.subtaskMetadata === 'object'
    ? planMetadata.subtaskMetadata
    : {};
  const lines = content.replace(/\\r\\n/g, '\\n').split('\\n');
  const items = [];
  let currentPhaseName = '';
  let current = null;
  for (const line of lines) {
    const match = /^(\\s*)-\\s+\\[([ xX/!\\-])\\]\\s+([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)(?:\\.)?\\s+(.+?)\\s*$/.exec(line);
    if (match) {
      const metadata = subtaskMetadata[match[3]] && typeof subtaskMetadata[match[3]] === 'object'
        ? subtaskMetadata[match[3]]
        : {};
      const hasMetadataField = (field) => Object.prototype.hasOwnProperty.call(metadata, field);
      current = {
        indent: match[1].length,
        marker: match[2],
        id: match[3],
        title: match[4].trim(),
        status: markerToStatus(match[2]),
        details: [],
        filesToCreate: normalizeRunnerStringArray(metadata.files_to_create),
        filesToModify: [
          ...normalizeRunnerStringArray(metadata.files),
          ...normalizeRunnerStringArray(metadata.files_to_modify),
        ],
        patternFiles: normalizeRunnerStringArray(metadata.pattern_files),
        dependsOn: normalizeRunnerWorkDependencyIds(metadata.depends_on),
        requirements: normalizeRunnerStringArray(metadata.requirements),
        hasFileMetadata: hasMetadataField('files') ||
          hasMetadataField('files_to_create') ||
          hasMetadataField('files_to_modify') ||
          hasMetadataField('pattern_files'),
        hasDependencyMetadata: hasMetadataField('depends_on'),
        hasVerificationMetadata: hasMetadataField('verification'),
        phaseName: currentPhaseName,
        isSubtask: match[1].length > 0 || /[.-]/.test(match[3]),
        workPackage: metadata.work_package === true,
        upstreamTaskIds: Array.isArray(metadata.upstream_task_ids)
          ? metadata.upstream_task_ids.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
          : [],
        upstreamSource: typeof metadata.upstream_source === 'string' ? metadata.upstream_source : '',
      };
      if (!current.isSubtask) {
        currentPhaseName = current.title;
        current.phaseName = current.title;
      }
      items.push(current);
      continue;
    }
    if (current && /^\\s+-\\s+/.test(line)) {
      const detail = line.replace(/^\\s+-\\s+/, '').trim();
      if (detail) {
        current.details.push(detail);
        applyPlanItemFileHint(current, detail);
      }
    }
  }
  return items;
}

function applyPlanItemFileHint(item, detail) {
  const clean = detail.replace(/^_+|_+$/g, '').trim();
  const match = /^([^:]+):\\s*(.*?)\\s*$/.exec(clean);
  if (!match) {
    return;
  }
  const key = match[1].trim().toLowerCase();
  const values = splitPlanList(match[2]);
  if (key === 'files to create') {
    item.hasFileMetadata = true;
    if (values.length === 0) return;
    item.filesToCreate.push(...values);
    return;
  }
  if (key === 'files' || key === 'files to modify') {
    item.hasFileMetadata = true;
    if (values.length === 0) return;
    item.filesToModify.push(...values);
    return;
  }
  if (key === 'pattern files' || key === 'patterns from') {
    item.hasFileMetadata = true;
    if (values.length === 0) return;
    item.patternFiles.push(...values);
    return;
  }
  if (key === 'depends on') {
    item.hasDependencyMetadata = true;
    if (values.length === 0) return;
    item.dependsOn.push(...values);
    return;
  }
  if (key === 'verification') {
    item.hasVerificationMetadata = true;
  }
}

function splitPlanList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && !isNoneDependencyToken(item));
}

function parsePlanMachineMetadata(content) {
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

function markerToStatus(marker) {
  if (marker === 'x' || marker === 'X') return 'completed';
  if (marker === '/') return 'in_progress';
  if (marker === '!') return 'failed';
  if (marker === '-') return 'blocked';
  return 'pending';
}

function statusToMarker(status) {
  if (status === 'completed') return 'x';
  if (status === 'in_progress') return '/';
  if (status === 'failed') return '!';
  if (status === 'blocked') return '-';
  return ' ';
}

function markPlanSubtaskStatus(subtaskId, status, note) {
  const planPath = join(specDir, artifacts.implementationPlan);
  return withFileWriteLock(planPath, 'runner:plan-subtask:' + subtaskId, () => {
    let content = '';
    try {
      content = readFileSync(planPath, 'utf8');
    } catch {
      return false;
    }

    const marker = statusToMarker(status);
    const now = new Date().toISOString();
    const lines = content.replace(/\\r\\n/g, '\\n').split('\\n');
    let updated = false;
    for (let index = 0; index < lines.length; index += 1) {
      const pattern = /^(\\s*-\\s+\\[)([ xX/!\\-])(\\]\\s+)([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)(\\.?)(\\s+.+?)\\s*$/;
      const match = pattern.exec(lines[index]);
      if (!match || match[4] !== subtaskId) {
        continue;
      }

      if (match[2] !== marker) {
        lines[index] = match[1] + marker + match[3] + match[4] + match[5] + match[6];
        updated = true;
      }
      const detailIndent = (match[1].match(/^\\s*/) || [''])[0] + '  ';
      let insertAt = index + 1;
      let hasCompletion = false;
      let hasStarted = false;
      let hasCompleted = false;
      let hasUpdated = false;
      while (insertAt < lines.length) {
        if (/^\\s*-\\s+\\[[ xX/!\\-]\\]\\s+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*/.test(lines[insertAt])) {
          break;
        }
        if (/^\\s*-\\s+_Completion:/i.test(lines[insertAt])) {
          hasCompletion = true;
          if (status !== 'completed') {
            lines.splice(insertAt, 1);
            updated = true;
            continue;
          }
        }
        if (/^\\s*-\\s+_Started:/i.test(lines[insertAt])) {
          hasStarted = true;
          if (status === 'pending') {
            lines.splice(insertAt, 1);
            updated = true;
            continue;
          }
        }
        if (/^\\s*-\\s+_Completed:/i.test(lines[insertAt])) {
          hasCompleted = true;
          if (status === 'pending' || status === 'in_progress') {
            lines.splice(insertAt, 1);
            updated = true;
            continue;
          }
        }
        if (/^\\s*-\\s+_Updated:/i.test(lines[insertAt])) hasUpdated = true;
        insertAt += 1;
      }
      if (status === 'completed' && note && !hasCompletion) {
        lines.splice(insertAt, 0, detailIndent + '- _Completion: ' + compactPlanField(note) + '_');
        insertAt += 1;
        updated = true;
      }
      if (status !== 'pending' && !hasStarted) {
        lines.splice(insertAt, 0, detailIndent + '- _Started: ' + now + '_');
        insertAt += 1;
        updated = true;
      }
      if ((status === 'completed' || status === 'failed' || status === 'blocked') && !hasCompleted) {
        lines.splice(insertAt, 0, detailIndent + '- _Completed: ' + now + '_');
        insertAt += 1;
        updated = true;
      }
      if (updated && !hasUpdated) {
        lines.splice(insertAt, 0, detailIndent + '- _Updated: ' + now + '_');
      }
      break;
    }

    if (!updated) {
      return false;
    }
    content = lines.join('\\n');
    content = upsertPlanMetadata(content, 'Updated', now);
    writeFileSync(planPath, content.endsWith('\\n') ? content : content + '\\n', 'utf8');
    return true;
  });
}

function compactPlanField(value) {
  return cleanLogText(value).replace(/\\s+/g, ' ').replace(/_/g, '\\\\_').trim().slice(0, 500);
}

function syncOpenSpecTasksFromPlan() {
  const metadata = readJson(join(specDir, artifacts.taskMetadata));
  if (!metadata || metadata.sourceType !== 'openspec' || typeof metadata.openSpecTasksPath !== 'string') {
    return;
  }
  const tasksPath = join(cwd, metadata.openSpecTasksPath);
  if (!existsSync(tasksPath)) {
    return;
  }
  const statusById = new Map();
  const items = readPlanItems();
  for (const item of items) {
    if (!item.isSubtask) continue;
    const status = item.status === 'completed' ? 'completed' : 'pending';
    statusById.set(item.id, status);
    for (const upstreamTaskId of item.upstreamTaskIds || []) {
      statusById.set(upstreamTaskId, status);
    }
  }
  for (const item of items.filter((candidate) => !candidate.isSubtask)) {
    const childPrefix = item.id + '.';
    const children = items.filter((candidate) => candidate.isSubtask && candidate.id.startsWith(childPrefix));
    if (children.length > 0) {
      statusById.set(item.id, children.every((child) => child.status === 'completed') ? 'completed' : 'pending');
    }
  }

  withFileWriteLock(tasksPath, 'runner:openspec-tasks', () => {
    let content = '';
    try {
      content = readFileSync(tasksPath, 'utf8');
    } catch {
      return;
    }
    populateParentOpenSpecTaskStatuses(content, statusById);
    const updated = content.replace(
      /^(\\s*-\\s+\\[)([ xX/!\\-])(\\]\\s+)([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)(\\.?)(\\s+.+)$/gm,
      (line, prefix, oldMarker, suffix, id, dot, rest) => {
        const status = statusById.get(id);
        if (!status) return line;
        return prefix + (status === 'completed' ? 'x' : ' ') + suffix + id + dot + rest;
      },
    );
    if (updated !== content) {
      writeFileSync(tasksPath, updated, 'utf8');
    }
  });
}

function populateParentOpenSpecTaskStatuses(content, statusById) {
  const taskIds = [...content.matchAll(/^\\s*-\\s+\\[[ xX/!\\-]\\]\\s+([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)(?:\\.?)\\s+.+$/gm)]
    .map((match) => match[1])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const taskId of taskIds) {
    if (statusById.has(taskId)) {
      continue;
    }
    const children = taskIds.filter((candidate) => candidate !== taskId && candidate.startsWith(taskId + '.'));
    if (children.length === 0 || children.some((childId) => !statusById.has(childId))) {
      continue;
    }
    statusById.set(
      taskId,
      children.every((childId) => statusById.get(childId) === 'completed') ? 'completed' : 'pending',
    );
  }
}

function inferFileWriteLockScope() {
  const specsDir = dirname(specDir);
  if (basename(specsDir).toLowerCase() === 'specs') {
    const dataDir = dirname(specsDir);
    return {
      projectRoot: dirname(dataDir),
      dataDirName: basename(dataDir),
    };
  }
  return {
    projectRoot: cwd,
    dataDirName: '.autocode',
  };
}

function withFileWriteLock(filePath, ownerId, callback) {
  const lock = acquireFileWriteLock(filePath, ownerId);
  try {
    return callback();
  } finally {
    releaseFileWriteLock(lock);
  }
}

function acquireFileWriteLock(filePath, ownerId) {
  const normalizedFilePath = normalizeLockPath(filePath);
  const lockRoot = join(fileWriteLockScope.projectRoot, fileWriteLockScope.dataDirName, '.locks', 'runtime-file-writes');
  const lockDir = join(lockRoot, createHash('sha256').update(normalizedFilePath).digest('hex').slice(0, 32) + '.lock');
  const metadataPath = join(lockDir, 'metadata.json');
  const token = randomUUID();
  const deadline = Date.now() + 120000;
  mkdirSync(lockRoot, { recursive: true });

  while (true) {
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(metadataPath, JSON.stringify({
          filePath: normalizedFilePath,
          ownerId: ownerId || 'autocode-runner',
          token,
          acquiredAt: new Date().toISOString(),
          processId: process.pid,
        }, null, 2), 'utf8');
      } catch (metadataError) {
        rmSync(lockDir, { recursive: true, force: true });
        throw metadataError;
      }
      activeFileWriteLockDirs.add(lockDir);
      return { lockDir, metadataPath, token };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }
      if (isFileWriteLockHeldByThisProcess(lockDir)) {
        throw new Error('Write lock on ' + normalizedFilePath + ' is already held by this process. Avoid nested writes to the same file.');
      }
      if (isFileWriteLockStale(lockDir)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for write lock on ' + normalizedFilePath + '.');
      }
      waitForFileWriteLock(100);
    }
  }
}

function releaseFileWriteLock(lock) {
  try {
    const metadata = readFileWriteLockMetadata(lock.lockDir);
    if (metadata && metadata.token && metadata.token !== lock.token) {
      return;
    }
    rmSync(lock.lockDir, { recursive: true, force: true });
  } finally {
    activeFileWriteLockDirs.delete(lock.lockDir);
  }
}

function readFileWriteLockMetadata(lockDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(lockDir, 'metadata.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isFileWriteLockHeldByThisProcess(lockDir) {
  if (activeFileWriteLockDirs.has(lockDir)) {
    return true;
  }
  const metadata = readFileWriteLockMetadata(lockDir);
  return metadata && metadata.processId === process.pid;
}

function isFileWriteLockStale(lockDir) {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > 600000;
  } catch {
    return false;
  }
}

function normalizeLockPath(filePath) {
  return resolve(filePath).replace(/\\\\/g, '/').replace(/\\/+$|^\\s+|\\s+$/g, '').toLowerCase();
}

function waitForFileWriteLock(delayMs) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, delayMs);
}

function handleChildOutput(stream, data, state = defaultAttemptState) {
  const text = decodeCliOutputChunk(data);
  if (!text) return;
  refreshAttemptActivity(state);
  if (codexJsonMode && stream === 'stdout') {
    processCodexJsonOutput(text, state);
    return;
  }
  if (stream === 'stderr') {
    process.stderr.write(text);
  } else {
    process.stdout.write(text);
  }
  queueModelOutput(text, state);
}

function decodeCliOutputChunk(data) {
  const utf8Text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const repairedUtf8Text = repairChineseMojibakeText(utf8Text);
  if (!Buffer.isBuffer(data)) {
    return repairedUtf8Text;
  }

  const legacyText = decodeLegacyCliOutput(data);
  if (!legacyText) {
    return repairedUtf8Text;
  }

  const repairedLegacyText = repairChineseMojibakeText(legacyText);
  return shouldPreferEncodingCandidate(repairedUtf8Text, repairedLegacyText)
    ? repairedLegacyText
    : repairedUtf8Text;
}

function decodeLegacyCliOutput(data) {
  if (!data.toString('utf8').includes('\\uFFFD')) {
    return '';
  }

  try {
    gb18030Decoder = gb18030Decoder || new TextDecoder('gb18030');
    return gb18030Decoder.decode(data);
  } catch {
    return '';
  }
}

function repairChineseMojibakeText(text) {
  if (!text || text.includes('\\uFFFD') || scoreEncodingDamage(text) < 2 || !iconvLite) {
    return text;
  }

  let candidate = text;
  try {
    candidate = iconvLite.decode(iconvLite.encode(text, 'gbk'), 'utf8');
  } catch {
    return text;
  }

  return shouldPreferEncodingCandidate(text, candidate) ? candidate : text;
}

function shouldPreferEncodingCandidate(original, candidate) {
  if (!candidate || candidate === original) {
    return false;
  }
  const originalScore = scoreEncodingDamage(original);
  const candidateScore = scoreEncodingDamage(candidate);
  return originalScore >= 2 && candidateScore + 1 < originalScore;
}

function scoreEncodingDamage(text) {
  const patterns = [
    '锟斤拷',
    '锛',
    '锚',
    '涓€',
    '涓�',
    '涓',
    '瀛愪',
    '换鍔',
    '浠诲姟',
    '褰撳墠',
    '鏂',
    '绋',
    '鐢',
    '寮€濮',
    '鐨',
    '缃戦',
    '椤电',
    '瀹炵幇',
    '淇勭綏',
    '娓告垙',
    '鏂瑰潡',
    '瑰潡',
    '告垙',
    '犲',
    '佸',
    '傚',
    '熷',
    '堕',
    '姝',
    '垚',
  ];
  let score = 0;
  for (const char of text) {
    if (char.charCodeAt(0) === 0xfffd) {
      score += 12;
    }
  }
  for (const pattern of patterns) {
    let index = text.indexOf(pattern);
    while (index >= 0) {
      score += pattern.length;
      index = text.indexOf(pattern, index + pattern.length);
    }
  }
  return score;
}

function loadIconvLite() {
  const candidates = [iconvLiteModulePath, 'iconv-lite'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next lookup path.
    }
  }
  return null;
}

function queueModelOutput(text, state = defaultAttemptState) {
  const cleaned = cleanLogText(text);
  if (!cleaned.trim()) {
    return;
  }

  state.pendingModelOutput += cleaned;
  if (state.pendingModelOutput.length >= MODEL_OUTPUT_MAX_CHARS || cleaned.includes('\\n')) {
    flushModelOutput(state);
    return;
  }

  if (!state.modelOutputFlushTimer) {
    state.modelOutputFlushTimer = setTimeout(() => flushModelOutput(state), MODEL_OUTPUT_FLUSH_MS);
  }
}

function flushModelOutput(state = defaultAttemptState) {
  if (state.modelOutputFlushTimer) {
    clearTimeout(state.modelOutputFlushTimer);
    state.modelOutputFlushTimer = null;
  }

  const text = state.pendingModelOutput.trim();
  state.pendingModelOutput = '';
  if (!text) {
    return;
  }

  const content = text.length > MODEL_OUTPUT_MAX_CHARS
    ? text.slice(0, MODEL_OUTPUT_MAX_CHARS - 3) + '...'
    : text;
  const detail = text.length > MODEL_OUTPUT_MAX_CHARS ? text : undefined;
  appendTaskLogEntry(logPhase, 'text', content, detail, buildAttemptLogExtra(state));
}

function processCodexJsonOutput(text, state = defaultAttemptState) {
  state.codexJsonLineBuffer += text.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
  const lines = state.codexJsonLineBuffer.split('\\n');
  state.codexJsonLineBuffer = lines.pop() || '';

  for (const line of lines) {
    processCodexJsonLine(line, state);
  }
}

function flushCodexJsonOutput(state = defaultAttemptState) {
  if (!state.codexJsonLineBuffer.trim()) {
    state.codexJsonLineBuffer = '';
    return;
  }
  processCodexJsonLine(state.codexJsonLineBuffer, state);
  state.codexJsonLineBuffer = '';
}

function processCodexJsonLine(line, state = defaultAttemptState) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) {
    return;
  }

  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    process.stdout.write(trimmed + '\\n');
    queueModelOutput(trimmed + '\\n', state);
    return;
  }

  if (!handleCodexJsonEvent(event, state)) {
    if (process.env.AUTOCODE_DEBUG_CLI_JSON === '1') {
      appendTaskLogEntry(
        logPhase,
        'info',
        'Unhandled Codex JSON event: ' + limitLogText(trimmed, 800),
        trimmed,
        buildAttemptLogExtra(state),
      );
    }
  }
}

function handleCodexJsonEvent(event, state = defaultAttemptState) {
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
      appendCodexMessageLog(message, state);
      return true;
    }
  }

  if (payloadType === 'message') {
    handleTokenUsage();
    const message = stringifyCodexText(payload.message ?? payload.content ?? payload.text);
    if (message.trim()) {
      appendCodexMessageLog(message, state);
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
      buildAttemptLogExtra(state, {
        tool_name: toolName,
        tool_input: toolInput ? limitLogText(toolInput, 1000) : undefined,
        tool_call_id: getFirstString(payload, ['call_id', 'callId', 'id']),
      }),
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
      buildAttemptLogExtra(state, {
        tool_name: toolName,
        tool_success: success,
        tool_call_id: getFirstString(payload, ['call_id', 'callId', 'id']),
      }),
    );
    return true;
  }

  if (payloadType && /reasoning|analysis|encrypted/i.test(payloadType)) {
    return true;
  }

  const usageOnlyEvent = handleTokenUsage();
  const message = stringifyCodexText(payload.message ?? payload.content ?? payload.text ?? envelope.message);
  if (message.trim()) {
    appendTaskLogEntry(
      logPhase,
      'info',
      limitLogText(message, 1600),
      message.length > 1600 ? message : undefined,
      buildAttemptLogExtra(state),
    );
    return true;
  }

  return payloadType === 'turn_started' ||
    payloadType === 'session_configured' ||
    payloadType === 'response_started' ||
    usageOnlyEvent ||
    handleCodexCompletionEvent(payloadType, state);
}

function handleCodexCompletionEvent(payloadType, state) {
  if (payloadType === 'turn_completed' || payloadType === 'response_completed') {
    scheduleAttemptCompletionGrace(state);
    return true;
  }
  return false;
}

function appendCodexMessageLog(message, state = defaultAttemptState) {
  const cleanMessage = cleanLogText(message).trim();
  if (!cleanMessage || cleanMessage === state.lastCodexMessageText) {
    return;
  }
  state.lastCodexMessageText = cleanMessage;
  const content = limitLogText(cleanMessage, MODEL_OUTPUT_MAX_CHARS);
  process.stdout.write(content + '\\n');
  appendTaskLogEntry(
    logPhase,
    'text',
    content,
    cleanMessage.length > MODEL_OUTPUT_MAX_CHARS ? cleanMessage : undefined,
    buildAttemptLogExtra(state),
  );
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
  const merged = withFileWriteLock(planPath, 'runner:plan-token-usage', () => {
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
    const nextUsage = mergeTokenUsage(previousUsage, incoming);

    content = upsertPlanMetadata(content, 'Updated', now);
    content = upsertPlanMachineMetadata(content, {
      tokenUsage: nextUsage,
      last_updated: now,
    });
    writeFileSync(planPath, content.endsWith('\\n') ? content : content + '\\n', 'utf8');
    return nextUsage;
  });
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

async function validateExpectedArtifacts() {
  const derivedPlanError = await deriveRuntimePlanFromStandardTasksIfNeeded();
  if (derivedPlanError) {
    return derivedPlanError;
  }

  if (phase === 'spec') {
    if (!existsSync(join(specDir, artifacts.specFile))) {
      return \`CLI finished without creating \${artifacts.specFile}.\`;
    }
    if (!planHasSubtasks()) {
      return \`CLI finished without creating \${artifacts.implementationPlan} subtasks.\`;
    }
    const metadataError = validatePlanningSchedulingMetadata();
    if (metadataError) {
      return metadataError;
    }
  }
  if (phase === 'planning' && !planHasSubtasks()) {
    return \`CLI finished without creating \${artifacts.implementationPlan} subtasks.\`;
  }
  if (phase === 'planning') {
    const metadataError = validatePlanningSchedulingMetadata();
    if (metadataError) {
      return metadataError;
    }
  }
  return undefined;
}

async function deriveRuntimePlanFromStandardTasksIfNeeded() {
  if ((phase !== 'spec' && phase !== 'planning') || isOpenSpecRunnerTask()) {
    return undefined;
  }

  const tasksPath = join(specDir, artifacts.tasks || 'tasks.md');
  if (!existsSync(tasksPath)) {
    return \`CLI finished without creating \${artifacts.tasks || 'tasks.md'}.\`;
  }
  if (!workPackagesModulePath) {
    return 'Unable to load Autocode work package builder.';
  }

  try {
    const moduleUrl = pathToFileURL(workPackagesModulePath).href;
    const workPackages = await import(moduleUrl);
    const plan = workPackages.buildAutocodeRuntimeImplementationPlanFromTasksMarkdown(
      readFileSync(tasksPath, 'utf8'),
      {
        now: new Date().toISOString(),
        language,
        sourcePath: artifacts.tasks || 'tasks.md',
      },
    );
    const existingPlanMetadata = readExistingPlanMachineMetadata();
    if (existingPlanMetadata.tokenUsage) {
      plan.tokenUsage = existingPlanMetadata.tokenUsage;
    }
    if (existingPlanMetadata.last_updated) {
      plan.last_updated = existingPlanMetadata.last_updated;
    }
    const markdown = workPackages.stringifyAutocodeImplementationPlanMarkdown(plan);
    writeFileSync(join(specDir, artifacts.implementationPlan), markdown, 'utf8');
    appendTaskLogEntry(logPhase, 'info', 'Generated runtime work packages from tasks.md.');
    return undefined;
  } catch (error) {
    return \`Failed to generate \${artifacts.implementationPlan} from \${artifacts.tasks || 'tasks.md'}: \${error instanceof Error ? error.message : String(error)}\`;
  }
}

function readExistingPlanMachineMetadata() {
  try {
    return readPlanMachineMetadata(readFileSync(join(specDir, artifacts.implementationPlan), 'utf8'));
  } catch {
    return {};
  }
}

function isOpenSpecRunnerTask() {
  return String(taskMetadata?.sourceType || '').toLowerCase() === 'openspec';
}

function shouldValidatePlanningSchedulingMetadata() {
  const mode = String(taskMetadata?.developmentMode || '').toLowerCase();
  const sourceType = String(taskMetadata?.sourceType || '').toLowerCase();
  return sourceType !== 'openspec' && (mode === 'standard' || runtimeConcurrency.mode === 'concurrent');
}

function validatePlanningSchedulingMetadata() {
  if (!shouldValidatePlanningSchedulingMetadata()) {
    return undefined;
  }
  const items = readPlanItems().filter((item) => item.isSubtask);
  const errors = [];
  for (const item of items) {
    if (!item.hasDependencyMetadata) {
      errors.push(item.id + ' missing _Depends on: ..._ metadata');
    }
    if (!item.hasVerificationMetadata) {
      errors.push(item.id + ' missing _Verification: ..._ metadata');
    }
  }
  const dependencyIssues = collectRunnerDependencyIssues(items, getPlanItemStatusMap(items));
  for (const issue of dependencyIssues) {
    errors.push(issue.message);
  }
  if (errors.length === 0) {
    return undefined;
  }
  const preview = errors.slice(0, 8).join('; ');
  return \`\${artifacts.implementationPlan} missing scheduling metadata: \${preview}\${errors.length > 8 ? '; ...' : ''}\`;
}

function buildArtifactValidationRetryPrompt(validationError) {
  const standardTasksMode = !isOpenSpecRunnerTask() && (phase === 'spec' || phase === 'planning');
  const requiredOutputs = phase === 'spec'
    ? [
        \`- Write or repair \${specDir}/\${artifacts.specFile}.\`,
        standardTasksMode
          ? \`- Write or repair \${specDir}/\${artifacts.tasks || 'tasks.md'}.\`
          : \`- Write or repair \${specDir}/\${artifacts.implementationPlan}.\`,
      ]
    : [
        standardTasksMode
          ? \`- Write or repair \${specDir}/\${artifacts.tasks || 'tasks.md'}.\`
          : \`- Write or repair \${specDir}/\${artifacts.implementationPlan}.\`,
      ];

  const retryIntro = [
    '## Retry Required',
    '',
    \`The previous CLI attempt exited successfully, but artifact validation failed: \${validationError}\`,
    '',
    'Repair the missing or invalid artifact now. Write the file, not just an explanation.',
  ];

  const planRules = [
    standardTasksMode ? '## tasks.md Requirements' : '## implementation_plan.md Requirements',
    '',
    '- Single Autocode Markdown checklist.',
    '- Include at least one executable task numbered like 1.1, 1.2, or 2.1.',
    '- A top-level phase alone is not enough.',
    '- Each task must include _Depends on_ and _Verification_. Include _Files to create/modify_ when write intent is known.',
    '- Use _Depends on: none_ only for root work. Use _Files to modify: none_ only for read-only validation.',
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
    standardTasksMode ? '# Tasks' : '# Implementation Plan',
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
    '    - _Depends on: none_',
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
  withFileWriteLock(planPath, 'runner:plan-metadata', () => {
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
  });
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
  withFileWriteLock(logsPath, 'runner:task-logs:append:' + logPhase, () => {
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
  });
}

function updateTaskLogs(logPhase, status, message) {
  const now = new Date().toISOString();
  const logsPath = join(specDir, artifacts.taskLogs);
  withFileWriteLock(logsPath, 'runner:task-logs:phase:' + logPhase, () => {
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
  });
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
  return repairChineseMojibakeText(String(value ?? ''))
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
  const tmpPath = filePath + '.tmp';
  const serialized = \`\${JSON.stringify(value, null, 2)}\\n\`;
  JSON.parse(serialized);
  try {
    writeFileSync(tmpPath, serialized, 'utf8');
    JSON.parse(readFileSync(tmpPath, 'utf8'));
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failures and rethrow the original write failure.
    }
    throw error;
  }
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
