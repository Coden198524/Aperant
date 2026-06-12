import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAutocodeAgentRuntimePlan,
  createAutocodeAgentRuntimeStartRequest,
  type AutocodeAgentRuntimePlan,
  type AutocodeAgentRuntimeStartRequest,
} from '../runtime/agent-runtime.js';
import { buildProjectIndex, type ProjectIndex } from '../project/index.js';
import { summarizeWorkspace, type WorkspaceSummary } from '../workspace/summary.js';
import {
  buildAutocodeTaskRunnerShellCommand,
  createAutocodeTaskRunPlan,
  mapAutocodeAgentRuntimeModeToTaskRunPhase,
  type AutocodeTaskRunPlan,
  type CreateAutocodeTaskRunPlanInput,
} from './cli-runner.js';
import { AUTOCODE_TASK_ARTIFACTS, normalizeAutocodeProjectDataDirName } from './artifacts.js';
import { readAutocodeTaskLogs, updateAutocodeTaskLogPhase, type AutocodeTaskLogs } from './logs.js';
import { loadAutocodeImplementationPlanSync } from './plan-store.js';
import {
  buildAutocodeTaskModeMetadata,
  getAutocodeSpecDir,
  createAutocodeTask,
  listAutocodeTasks,
  resolveAutocodeTaskDevelopmentMode,
  updateAutocodeTaskPlanStatus,
  type AutocodeTask,
  type AutocodeTaskDevelopmentMode,
  type AutocodeTaskMetadata,
  type AutocodeTaskPathsInput,
  type AutocodeTaskRequirements,
  type CreateAutocodeTaskInput,
} from './spec-store.js';

export interface AutocodeWorkspaceState {
  projectRoot: string | null;
  dataDirName: string;
  summary: WorkspaceSummary | null;
  projectIndex: ProjectIndex | null;
  tasks: AutocodeTask[];
  logsByTaskId: Record<string, AutocodeTaskLogs | null>;
}

export interface BuildAutocodeWorkspaceStateInput {
  projectRoot?: string | null;
  dataDirName?: string;
  includeLogs?: boolean;
}

export interface CreateManualAutocodeTaskInput extends AutocodeTaskPathsInput {
  title: string;
  description: string;
  metadata?: AutocodeTaskMetadata;
  requirements?: AutocodeTaskRequirements;
  now?: string;
  prepareSpecArtifacts?: CreateAutocodeTaskInput['prepareSpecArtifacts'];
}

export interface CreateAutocodeAgentRuntimeStartPlanInput extends AutocodeTaskPathsInput {
  taskId: string;
  projectId?: string;
  baseBranch?: string;
  forcePlanning?: boolean;
}

export interface StartedAutocodeTaskRun {
  plan: AutocodeTaskRunPlan;
  task: AutocodeTask;
  command: string;
}

export interface CreateStartedAutocodeAgentRuntimeInput extends CreateAutocodeAgentRuntimeStartPlanInput {
  cli: CreateAutocodeTaskRunPlanInput['cli'];
  customCommand?: string;
  model?: string;
  bypassPermissions?: boolean;
  language?: CreateAutocodeTaskRunPlanInput['language'];
  forcePlanning?: boolean;
}

export interface StartedAutocodeAgentRuntime {
  runtimePlan: AutocodeAgentRuntimePlan;
  request: AutocodeAgentRuntimeStartRequest;
  taskRunPlan: AutocodeTaskRunPlan;
  task: AutocodeTask;
  command: string;
}

export interface AutocodeTaskActionInput extends AutocodeTaskPathsInput {
  taskId: string;
}

export function buildAutocodeWorkspaceState(input: BuildAutocodeWorkspaceStateInput): AutocodeWorkspaceState {
  const dataDirName = normalizeAutocodeProjectDataDirName(input.dataDirName);
  if (!input.projectRoot) {
    return {
      projectRoot: null,
      dataDirName,
      summary: null,
      projectIndex: null,
      tasks: [],
      logsByTaskId: {},
    };
  }

  const projectRoot = input.projectRoot;
  const tasks = listAutocodeTasks({ projectRoot, dataDirName });
  const logsByTaskId = input.includeLogs === false
    ? {}
    : Object.fromEntries(
      tasks.map((task) => [
        task.id,
        readAutocodeTaskLogs({
          projectRoot,
          dataDirName,
          taskId: task.id,
        }),
      ]),
    );

  return {
    projectRoot,
    dataDirName,
    summary: summarizeWorkspace(projectRoot),
    projectIndex: buildProjectIndex(projectRoot),
    tasks,
    logsByTaskId,
  };
}

export function buildManualAutocodeTaskMetadata(metadata?: AutocodeTaskMetadata): AutocodeTaskMetadata {
  const developmentMode = resolveManualAutocodeTaskDevelopmentMode(metadata);
  return buildAutocodeTaskModeMetadata(developmentMode, metadata);
}

export function createManualAutocodeTask(input: CreateManualAutocodeTaskInput): AutocodeTask {
  const developmentMode = resolveManualAutocodeTaskDevelopmentMode(input.metadata);

  return createAutocodeTask({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    title: input.title,
    description: input.description,
    metadata: buildManualAutocodeTaskMetadata(input.metadata),
    requirements: input.requirements,
    now: input.now,
    prepareSpecArtifacts: (context) => {
      if (developmentMode !== 'direct') {
        writeFileSync(
          join(context.specDir, AUTOCODE_TASK_ARTIFACTS.specFile),
          `${buildManualAutocodeExecutionSpecMarkdown({
            title: context.title,
            description: context.description,
            developmentMode,
            language: context.metadata.language,
          }).trimEnd()}\n`,
          'utf8',
        );
      }
      return input.prepareSpecArtifacts?.(context);
    },
  });
}

function resolveManualAutocodeTaskDevelopmentMode(metadata?: AutocodeTaskMetadata): 'direct' | 'standard' {
  const developmentMode = resolveAutocodeTaskDevelopmentMode(metadata, 'standard');
  return developmentMode === 'direct' ? 'direct' : 'standard';
}

function buildManualAutocodeExecutionSpecMarkdown(input: {
  title: string;
  description: string;
  developmentMode: AutocodeTaskDevelopmentMode;
  language?: unknown;
}): string {
  if (isChineseLanguage(input.language)) {
    return buildChineseManualAutocodeExecutionSpecMarkdown(input);
  }

  return [
    `# ${input.title}`,
    '',
    '## Type',
    input.developmentMode === 'direct'
      ? 'Direct mode task'
      : 'Standard mode task',
    '',
    '## Request',
    input.description,
    '',
    '## Execution',
    input.developmentMode === 'direct'
      ? 'Run one direct coding session against the selected model. Do not create staged planning or QA artifacts.'
      : [
          'Use Standard Autocode planning. Preserve the local Autocode workflow: spec.md, tasks.md, and implementation_plan.md stay inside this task directory.',
          'Follow the Autocode Standard spec-driven flow: clarify proposal and requirements, capture design decisions, define acceptance criteria and risks, then produce executable tasks.',
          'Before coding, keep spec.md and tasks.md aligned; implementation_plan.md is downstream runtime state derived from those Standard artifacts.',
        ].join('\n'),
    '',
    '## Done',
    '- The change satisfies the request.',
    '- Only relevant files are modified.',
    '- Useful verification is recorded.',
    ...(input.developmentMode === 'direct'
      ? []
      : [
          '- spec.md records requirements, design notes, acceptance criteria, and risks.',
          '- tasks.md contains concrete checklist work items with dependencies before implementation starts.',
        ]),
  ].join('\n');
}

function buildChineseManualAutocodeExecutionSpecMarkdown(input: {
  title: string;
  description: string;
  developmentMode: AutocodeTaskDevelopmentMode;
}): string {
  return [
    `# ${input.title}`,
    '',
    '## 类型',
    input.developmentMode === 'direct'
      ? 'Direct 直连模式任务'
      : 'Standard 标准模式任务',
    '',
    '## 请求',
    input.description,
    '',
    '## 执行方式',
    input.developmentMode === 'direct'
      ? '直连所选大模型进入单次编码会话，不创建分阶段规划或 QA 工件。'
      : '使用 Autocode Standard 规范流程：先澄清目标和需求，再记录设计决策、验收标准、风险和可执行任务，最后由运行时生成 implementation_plan.md。',
    '',
    '## 完成标准',
    '- 变更满足请求描述。',
    '- 只修改相关文件。',
    '- 记录必要的验证结果。',
  ].join('\n');
}

function isChineseLanguage(language: unknown): boolean {
  const normalized = typeof language === 'string' ? language.trim().toLowerCase().replace(/_/g, '-') : '';
  return normalized === 'zh' || normalized.startsWith('zh-') || normalized.includes('chinese');
}

export function createStartedAutocodeTaskRun(input: CreateAutocodeTaskRunPlanInput): StartedAutocodeTaskRun {
  const plan = createAutocodeTaskRunPlan(input);
  const task = updateAutocodeTaskPlanStatus({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    taskId: plan.task.id,
    planStatus: plan.planStatus,
    executionPhase: plan.executionPhase,
  });

  return {
    plan,
    task,
    command: buildAutocodeTaskRunnerShellCommand(plan),
  };
}

export function createStartedAutocodeAgentRuntime(
  input: CreateStartedAutocodeAgentRuntimeInput,
): StartedAutocodeAgentRuntime {
  const dataDirName = normalizeAutocodeProjectDataDirName(input.dataDirName);
  const runtimePlan = createAutocodeAgentRuntimeStartPlan({ ...input, dataDirName });
  const started = createStartedAutocodeTaskRun({
    projectRoot: input.projectRoot,
    dataDirName,
    taskId: input.taskId,
    projectId: input.projectId,
    cli: input.cli,
    customCommand: input.customCommand,
    model: input.model,
    bypassPermissions: input.bypassPermissions,
    phase: mapAutocodeAgentRuntimeModeToTaskRunPhase(runtimePlan.mode),
    language: input.language,
  });

  return {
    runtimePlan,
    request: createAutocodeAgentRuntimeStartRequest(runtimePlan, {
      runner: {
        phase: started.plan.phase,
        promptFilePath: started.plan.promptFilePath,
        runnerFilePath: started.plan.runnerFilePath,
        process: {
          command: 'node',
          args: [started.plan.runnerFilePath],
          cwd: started.plan.cwd,
          shellCommand: started.command,
        },
        terminal: {
          name: `Autocode: ${started.plan.task.specId}`,
          command: started.command,
          cwd: started.plan.cwd,
        },
      },
    }),
    taskRunPlan: started.plan,
    task: started.task,
    command: started.command,
  };
}

export function createAutocodeAgentRuntimeStartPlan(
  input: CreateAutocodeAgentRuntimeStartPlanInput,
): AutocodeAgentRuntimePlan {
  const dataDirName = normalizeAutocodeProjectDataDirName(input.dataDirName);
  const task = listAutocodeTasks({
    projectRoot: input.projectRoot,
    dataDirName,
  }).find((candidate) => candidate.id === input.taskId || candidate.specId === input.taskId);

  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  const specDir = getAutocodeSpecDir({
    projectRoot: input.projectRoot,
    dataDirName,
    specId: task.specId,
  });

  return createAutocodeAgentRuntimePlan({
    projectRoot: input.projectRoot,
    dataDirName,
    projectId: input.projectId,
    taskId: input.taskId,
    task,
    specDir,
    hasSpec: existsSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile)),
    planHasSubtasks: hasAutocodePlanSubtasks(join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan)),
    baseBranch: input.baseBranch,
    forcePlanning: input.forcePlanning,
  });
}

export function markAutocodeTaskDone(input: AutocodeTaskActionInput): AutocodeTask {
  return updateAutocodeTaskPlanStatus({
    ...input,
    planStatus: 'done',
    executionPhase: 'complete',
  });
}

export function requestAutocodeTaskChanges(input: AutocodeTaskActionInput): AutocodeTask {
  return updateAutocodeTaskPlanStatus({
    ...input,
    planStatus: 'human_review',
    reviewReason: 'qa_rejected',
    executionPhase: 'review',
  });
}

export function markAutocodeTaskStopped(input: AutocodeTaskActionInput & {
  phase?: 'planning' | 'coding';
  message?: string;
}): AutocodeTask {
  const dataDirName = normalizeAutocodeProjectDataDirName(input.dataDirName);
  const existingTask = listAutocodeTasks({
    projectRoot: input.projectRoot,
    dataDirName,
  }).find((candidate) => candidate.id === input.taskId || candidate.specId === input.taskId);
  const stoppedPhase = input.phase ?? inferStoppedTaskPhase(existingTask);
  const task = updateAutocodeTaskPlanStatus({
    projectRoot: input.projectRoot,
    dataDirName,
    taskId: input.taskId,
    planStatus: 'human_review',
    reviewReason: 'stopped',
    executionPhase: stoppedPhase,
  });

  updateAutocodeTaskLogPhase({
    projectRoot: input.projectRoot,
    dataDirName,
    taskId: input.taskId,
    phase: stoppedPhase,
    status: 'active',
    message: input.message ?? 'Task stopped.',
  });

  return task;
}

function inferStoppedTaskPhase(task: AutocodeTask | undefined): 'planning' | 'coding' {
  if (!task) {
    return 'planning';
  }

  if (
    task.executionPhase === 'coding' ||
    task.executionPhase === 'qa_review' ||
    task.executionPhase === 'qa_fixing' ||
    task.executionPhase === 'review'
  ) {
    return 'coding';
  }

  if (task.subtasks.some((subtask) => subtask.status !== 'pending') || task.subtasks.length > 0) {
    return 'coding';
  }

  return 'planning';
}

function hasAutocodePlanSubtasks(planPath: string): boolean {
  const plan = loadAutocodeImplementationPlanSync(planPath);
  return plan?.phases?.some((phase) => {
    const subtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    return subtasks.length > 0;
  }) === true;
}
