import type {
  AutocodePlanStatus,
  AutocodeReviewReason,
  AutocodeTaskStatus,
  AutocodeTaskWorkflowMode,
} from '../tasks/spec-store.js';

export type AutocodeAgentRuntimeMode = 'direct' | 'spec' | 'planning' | 'coding';
export type AutocodeAgentRuntimeProcessType = 'spec-creation' | 'task-execution';

export type AutocodeTaskStartEvent =
  | { type: 'PLANNING_STARTED' }
  | { type: 'PLAN_APPROVED' }
  | { type: 'USER_RESUMED' }
  | { type: 'CODING_STARTED'; subtaskId: string; subtaskDescription: string };

export interface AutocodeAgentRuntimeOptions {
  parallel: boolean;
  workers: number;
  baseBranch?: string;
  useWorktree?: boolean;
  useLocalBranch?: boolean;
  pushNewBranches?: boolean;
}

export interface AutocodeAgentRuntimeMetadata {
  workflowMode?: AutocodeTaskWorkflowMode | string;
  useWorktree?: boolean;
  useLocalBranch?: boolean;
  pushNewBranches?: boolean;
}

export interface AutocodeAgentRuntimePlan {
  taskId: string;
  specId: string;
  projectRoot: string;
  dataDirName: string;
  projectId?: string;
  specDir: string;
  mode: AutocodeAgentRuntimeMode;
  processType: AutocodeAgentRuntimeProcessType;
  taskTitle: string;
  taskDescription: string;
  metadata?: AutocodeAgentRuntimeMetadata;
  options: AutocodeAgentRuntimeOptions;
  planStatus: AutocodePlanStatus;
  executionPhase: 'planning' | 'coding';
}

export interface AutocodeAgentRuntimeTaskInput {
  id: string;
  specId: string;
  title: string;
  description: string;
  status: AutocodeTaskStatus | string;
  reviewReason?: AutocodeReviewReason | string;
  metadata?: AutocodeAgentRuntimeMetadata;
}

export interface CreateAutocodeAgentRuntimePlanInput {
  projectRoot: string;
  dataDirName: string;
  task: AutocodeAgentRuntimeTaskInput;
  taskId?: string;
  projectId?: string;
  specDir: string;
  hasSpec: boolean;
  planHasSubtasks: boolean;
  baseBranch?: string;
}

export interface ResolveAutocodeTaskStartEventInput {
  task: Pick<AutocodeAgentRuntimeTaskInput, 'status' | 'reviewReason' | 'metadata'>;
  currentState?: string | null;
  planHasSubtasks: boolean;
}

export interface AutocodeAgentRuntimeStarter {
  startRuntime(plan: AutocodeAgentRuntimePlan): Promise<void> | void;
}

export function createAutocodeAgentRuntimePlan(
  input: CreateAutocodeAgentRuntimePlanInput,
): AutocodeAgentRuntimePlan {
  const mode = resolveAutocodeAgentRuntimeMode(input);
  const isPlanningRuntime = mode === 'spec' || mode === 'planning';

  return {
    taskId: input.taskId ?? input.task.id,
    specId: input.task.specId,
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    specDir: input.specDir,
    mode,
    processType: mode === 'spec' ? 'spec-creation' : 'task-execution',
    taskTitle: input.task.title,
    taskDescription: input.task.description || input.task.title,
    ...(input.task.metadata ? { metadata: input.task.metadata } : {}),
    options: buildAutocodeAgentRuntimeOptions(input.task.metadata, input.baseBranch),
    planStatus: isPlanningRuntime ? 'planning' : 'coding',
    executionPhase: isPlanningRuntime ? 'planning' : 'coding',
  };
}

export function resolveAutocodeAgentRuntimeMode(
  input: Pick<CreateAutocodeAgentRuntimePlanInput, 'task' | 'hasSpec' | 'planHasSubtasks'>,
): AutocodeAgentRuntimeMode {
  if (isDirectAutocodeWorkflow(input.task.metadata)) {
    return 'direct';
  }
  if (!input.hasSpec) {
    return 'spec';
  }
  return input.planHasSubtasks ? 'coding' : 'planning';
}

export function resolveAutocodeTaskStartEvent(
  input: ResolveAutocodeTaskStartEventInput,
): AutocodeTaskStartEvent {
  if (isDirectAutocodeWorkflow(input.task.metadata)) {
    return input.currentState === 'human_review' ||
      input.currentState === 'error' ||
      input.task.status === 'human_review' ||
      input.task.status === 'error'
      ? { type: 'USER_RESUMED' }
      : {
          type: 'CODING_STARTED',
          subtaskId: 'direct-implementation',
          subtaskDescription: 'Direct model execution',
        };
  }

  if (input.currentState === 'plan_review') {
    return { type: 'PLAN_APPROVED' };
  }
  if (input.currentState === 'human_review' && !input.planHasSubtasks) {
    return { type: 'PLANNING_STARTED' };
  }
  if (input.currentState === 'error' && !input.planHasSubtasks) {
    return { type: 'PLANNING_STARTED' };
  }
  if (input.currentState === 'human_review' || input.currentState === 'error') {
    return { type: 'USER_RESUMED' };
  }
  if (input.currentState) {
    return { type: 'PLANNING_STARTED' };
  }
  if (input.task.status === 'human_review' && input.task.reviewReason === 'plan_review') {
    return { type: 'PLAN_APPROVED' };
  }
  if (input.task.status === 'human_review' && !input.planHasSubtasks) {
    return { type: 'PLANNING_STARTED' };
  }
  if (input.task.status === 'error' && !input.planHasSubtasks) {
    return { type: 'PLANNING_STARTED' };
  }
  if (input.task.status === 'human_review' || input.task.status === 'error') {
    return { type: 'USER_RESUMED' };
  }
  return { type: 'PLANNING_STARTED' };
}

export async function startAutocodeAgentRuntime(
  plan: AutocodeAgentRuntimePlan,
  starter: AutocodeAgentRuntimeStarter,
): Promise<void> {
  await starter.startRuntime(plan);
}

export function getAutocodeAgentRuntimeModeLabel(mode: AutocodeAgentRuntimeMode): string {
  switch (mode) {
    case 'direct':
      return 'direct model execution';
    case 'spec':
      return 'spec creation';
    case 'planning':
      return 'implementation planning';
    case 'coding':
      return 'task coding';
  }
}

function buildAutocodeAgentRuntimeOptions(
  metadata: AutocodeAgentRuntimeMetadata | undefined,
  baseBranch: string | undefined,
): AutocodeAgentRuntimeOptions {
  return {
    parallel: false,
    workers: 1,
    ...(baseBranch ? { baseBranch } : {}),
    ...(metadata?.useWorktree !== undefined ? { useWorktree: metadata.useWorktree } : {}),
    ...(typeof metadata?.useLocalBranch === 'boolean' ? { useLocalBranch: metadata.useLocalBranch } : {}),
    ...(metadata?.pushNewBranches !== undefined ? { pushNewBranches: metadata.pushNewBranches } : {}),
  };
}

function isDirectAutocodeWorkflow(metadata: AutocodeAgentRuntimeMetadata | undefined): boolean {
  return metadata?.workflowMode === 'off';
}
