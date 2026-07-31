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
  directCliContinuationStrategy?: CreateAutocodeTaskRunPlanInput['directCliContinuationStrategy'];
  directCliJsonEventParser?: CreateAutocodeTaskRunPlanInput['directCliJsonEventParser'];
  directCliRuntimeRouteId?: CreateAutocodeTaskRunPlanInput['directCliRuntimeRouteId'];
  directCliRuntimeRouteDisplayName?: CreateAutocodeTaskRunPlanInput['directCliRuntimeRouteDisplayName'];
  directCliPermissionBypassArgs?: CreateAutocodeTaskRunPlanInput['directCliPermissionBypassArgs'];
  directCliTaskRunStrategy?: CreateAutocodeTaskRunPlanInput['directCliTaskRunStrategy'];
  directCliPreflightActions?: CreateAutocodeTaskRunPlanInput['directCliPreflightActions'];
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
  return createAutocodeTask({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    title: input.title,
    description: input.description,
    metadata: buildManualAutocodeTaskMetadata(input.metadata),
    requirements: input.requirements,
    now: input.now,
    prepareSpecArtifacts: input.prepareSpecArtifacts,
  });
}

function resolveManualAutocodeTaskDevelopmentMode(
  metadata?: AutocodeTaskMetadata,
): AutocodeTaskDevelopmentMode {
  return resolveAutocodeTaskDevelopmentMode(metadata, 'standard');
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
    directCliContinuationStrategy: input.directCliContinuationStrategy,
    directCliJsonEventParser: input.directCliJsonEventParser,
    directCliRuntimeRouteId: input.directCliRuntimeRouteId,
    directCliRuntimeRouteDisplayName: input.directCliRuntimeRouteDisplayName,
    directCliPermissionBypassArgs: input.directCliPermissionBypassArgs,
    directCliTaskRunStrategy: input.directCliTaskRunStrategy,
    directCliPreflightActions: input.directCliPreflightActions,
    model: input.model,
    bypassPermissions: input.bypassPermissions,
    phase: mapAutocodeAgentRuntimeModeToTaskRunPhase(runtimePlan.mode),
    forcePlanning: input.forcePlanning === true,
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
  const stoppedActivityPhase = input.phase ?? inferStoppedTaskPhase(existingTask);
  const task = updateAutocodeTaskPlanStatus({
    projectRoot: input.projectRoot,
    dataDirName,
    taskId: input.taskId,
    planStatus: 'human_review',
    reviewReason: 'stopped',
    executionPhase: 'stopped',
  });

  updateAutocodeTaskLogPhase({
    projectRoot: input.projectRoot,
    dataDirName,
    taskId: input.taskId,
    phase: stoppedActivityPhase,
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
