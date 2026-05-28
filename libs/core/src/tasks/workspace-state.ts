import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAutocodeAgentRuntimePlan,
  type AutocodeAgentRuntimePlan,
} from '../runtime/agent-runtime.js';
import { buildProjectIndex, type ProjectIndex } from '../project/index.js';
import { summarizeWorkspace, type WorkspaceSummary } from '../workspace/summary.js';
import {
  buildAutocodeTaskRunnerShellCommand,
  createAutocodeTaskRunPlan,
  type AutocodeTaskRunPlan,
  type CreateAutocodeTaskRunPlanInput,
} from './cli-runner.js';
import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import { readAutocodeTaskLogs, updateAutocodeTaskLogPhase, type AutocodeTaskLogs } from './logs.js';
import {
  createAutocodeTask,
  getAutocodeSpecDir,
  listAutocodeTasks,
  updateAutocodeTaskPlanStatus,
  type AutocodeTask,
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
  dataDirName: string;
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
}

export interface StartedAutocodeTaskRun {
  plan: AutocodeTaskRunPlan;
  task: AutocodeTask;
  command: string;
}

export interface AutocodeTaskActionInput extends AutocodeTaskPathsInput {
  taskId: string;
}

export function buildAutocodeWorkspaceState(input: BuildAutocodeWorkspaceStateInput): AutocodeWorkspaceState {
  const dataDirName = input.dataDirName;
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
  return {
    sourceType: 'manual',
    workflowMode: 'balanced',
    ...metadata,
    enableBatchExecution: metadata?.enableBatchExecution === true,
  };
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

export function createAutocodeAgentRuntimeStartPlan(
  input: CreateAutocodeAgentRuntimeStartPlanInput,
): AutocodeAgentRuntimePlan {
  const task = listAutocodeTasks({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
  }).find((candidate) => candidate.id === input.taskId || candidate.specId === input.taskId);

  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  const specDir = getAutocodeSpecDir({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    specId: task.specId,
  });

  return createAutocodeAgentRuntimePlan({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    projectId: input.projectId,
    taskId: input.taskId,
    task,
    specDir,
    hasSpec: existsSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile)),
    planHasSubtasks: hasAutocodePlanSubtasks(join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan)),
    baseBranch: input.baseBranch,
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
  const task = updateAutocodeTaskPlanStatus({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    taskId: input.taskId,
    planStatus: 'human_review',
    reviewReason: 'stopped',
    executionPhase: 'stopped',
  });

  updateAutocodeTaskLogPhase({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    taskId: input.taskId,
    phase: input.phase ?? (task.executionPhase === 'coding' ? 'coding' : 'planning'),
    status: 'failed',
    message: input.message ?? 'Task stopped.',
  });

  return task;
}

function hasAutocodePlanSubtasks(planPath: string): boolean {
  try {
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      phases?: Array<{ subtasks?: unknown[]; chunks?: unknown[] }>;
    };
    return plan.phases?.some((phase) => {
      const subtasks = Array.isArray(phase.subtasks)
        ? phase.subtasks
        : Array.isArray(phase.chunks)
          ? phase.chunks
          : [];
      return subtasks.length > 0;
    }) === true;
  } catch {
    return false;
  }
}
