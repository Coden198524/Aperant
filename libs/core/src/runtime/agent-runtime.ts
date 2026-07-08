import type {
  AutocodePlanStatus,
  AutocodeReviewReason,
  AutocodeTaskDevelopmentMode,
  AutocodeTaskStatus,
  AutocodeTaskWorkflowMode,
} from '../tasks/spec-store.js';
import {
  resolveAutocodeTaskRuntimeConcurrency,
  type AutocodeTaskRuntimeConcurrencyMetadata,
} from './concurrency.js';

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
  forcePlanning?: boolean;
}

export interface AutocodeAgentRuntimeMetadata {
  developmentMode?: AutocodeTaskDevelopmentMode | string;
  workflowMode?: AutocodeTaskWorkflowMode | string;
  useWorktree?: boolean;
  useLocalBranch?: boolean;
  pushNewBranches?: boolean;
  runtimeConcurrency?: AutocodeTaskRuntimeConcurrencyMetadata;
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

export interface AutocodeAgentRuntimeLaunchCommand {
  command: string;
  args: string[];
  cwd: string;
  shell?: boolean;
  shellCommand: string;
}

export interface AutocodeAgentRuntimeTerminalCommand {
  name: string;
  command: string;
  cwd?: string;
}

export interface AutocodeAgentRuntimeRunner {
  phase: string;
  promptFilePath: string;
  runnerFilePath: string;
  process: AutocodeAgentRuntimeLaunchCommand;
  terminal: AutocodeAgentRuntimeTerminalCommand;
}

export interface AutocodeAgentRuntimeMessages {
  prepared: string;
  starting: string;
  started: string;
  completed: string;
  failed: string;
  stopped: string;
}

export interface CreateAutocodeAgentRuntimeStartRequestOptions {
  runner?: AutocodeAgentRuntimeRunner;
  messages?: Partial<AutocodeAgentRuntimeMessages>;
}

export interface AutocodeAgentRuntimeStartRequest {
  runtimeId: string;
  plan: AutocodeAgentRuntimePlan;
  label: string;
  messages: AutocodeAgentRuntimeMessages;
  runner?: AutocodeAgentRuntimeRunner;
}

export type AutocodeAgentRuntimeStartStatus = 'started' | 'completed' | 'failed';

export interface AutocodeAgentRuntimeStartResult {
  runtimeId: string;
  status: AutocodeAgentRuntimeStartStatus;
  message: string;
  terminalName?: string;
  process?: {
    status: AutocodeAgentRuntimeStartStatus;
    exitCode?: number | null;
    signal?: string | null;
    message?: string;
  };
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
  forcePlanning?: boolean;
}

export interface ResolveAutocodeTaskStartEventInput {
  task: Pick<AutocodeAgentRuntimeTaskInput, 'status' | 'reviewReason' | 'metadata'>;
  currentState?: string | null;
  planHasSubtasks: boolean;
}

export interface AutocodeAgentRuntimeStarter {
  startRuntime(
    request: AutocodeAgentRuntimeStartRequest,
  ): Promise<AutocodeAgentRuntimeStartResult | void> | AutocodeAgentRuntimeStartResult | void;
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
    options: buildAutocodeAgentRuntimeOptions(input.task.metadata, input.baseBranch, input.forcePlanning),
    planStatus: isPlanningRuntime ? 'planning' : 'coding',
    executionPhase: isPlanningRuntime ? 'planning' : 'coding',
  };
}

export function resolveAutocodeAgentRuntimeMode(
  input: Pick<CreateAutocodeAgentRuntimePlanInput, 'task' | 'hasSpec' | 'planHasSubtasks' | 'forcePlanning'>,
): AutocodeAgentRuntimeMode {
  if (isDirectAutocodeWorkflow(input.task.metadata)) {
    return 'direct';
  }
  if (!input.hasSpec) {
    return 'spec';
  }
  if (input.forcePlanning) {
    return 'planning';
  }
  return input.planHasSubtasks ? 'coding' : 'planning';
}

export function resolveAutocodeTaskStartEvent(
  input: ResolveAutocodeTaskStartEventInput,
): AutocodeTaskStartEvent {
  const codingStartedEvent = (): AutocodeTaskStartEvent => ({
    type: 'CODING_STARTED',
    subtaskId: 'implementation-plan',
    subtaskDescription: 'Implementation plan execution',
  });

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
  if (input.currentState === 'human_review' || input.currentState === 'error') {
    return input.planHasSubtasks
      ? { type: 'USER_RESUMED' }
      : { type: 'PLANNING_STARTED' };
  }
  if (
    input.planHasSubtasks &&
    (input.currentState === 'planning' ||
      input.currentState === 'coding' ||
      input.currentState === 'backlog' ||
      input.task.status === 'in_progress' ||
      input.task.status === 'backlog' ||
      input.task.status === 'queue')
  ) {
    return codingStartedEvent();
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
  if (input.planHasSubtasks) {
    return codingStartedEvent();
  }
  return { type: 'PLANNING_STARTED' };
}

export async function startAutocodeAgentRuntime(
  requestOrPlan: AutocodeAgentRuntimeStartRequest | AutocodeAgentRuntimePlan,
  starter: AutocodeAgentRuntimeStarter,
): Promise<AutocodeAgentRuntimeStartResult> {
  const request = isAutocodeAgentRuntimeStartRequest(requestOrPlan)
    ? requestOrPlan
    : createAutocodeAgentRuntimeStartRequest(requestOrPlan);
  const result = await starter.startRuntime(request);

  return result ?? {
    runtimeId: request.runtimeId,
    status: 'started',
    message: request.messages.started,
  };
}

export function createAutocodeAgentRuntimeStartRequest(
  plan: AutocodeAgentRuntimePlan,
  options: CreateAutocodeAgentRuntimeStartRequestOptions = {},
): AutocodeAgentRuntimeStartRequest {
  const label = getAutocodeAgentRuntimeModeLabel(plan.mode);
  const messages = createAutocodeAgentRuntimeMessages(plan, label, options.messages);

  return {
    runtimeId: createAutocodeAgentRuntimeId(plan),
    plan,
    label,
    messages,
    ...(options.runner ? { runner: options.runner } : {}),
  };
}

export function createAutocodeAgentRuntimeId(plan: AutocodeAgentRuntimePlan): string {
  return [plan.projectId, plan.projectRoot, plan.taskId].filter(Boolean).join(':');
}

export function getAutocodeAgentRuntimeModeLabel(mode: AutocodeAgentRuntimeMode): string {
  switch (mode) {
    case 'direct':
      return 'direct model execution';
    case 'spec':
      return 'standard planning';
    case 'planning':
      return 'implementation planning';
    case 'coding':
      return 'task coding';
  }
}

function buildAutocodeAgentRuntimeOptions(
  metadata: AutocodeAgentRuntimeMetadata | undefined,
  baseBranch: string | undefined,
  forcePlanning: boolean | undefined,
): AutocodeAgentRuntimeOptions {
  const concurrency = resolveAutocodeTaskRuntimeConcurrency(metadata);
  return {
    parallel: concurrency.mode === 'concurrent',
    workers: concurrency.workers,
    ...(baseBranch ? { baseBranch } : {}),
    ...(forcePlanning ? { forcePlanning: true } : {}),
    ...(metadata?.useWorktree !== undefined ? { useWorktree: metadata.useWorktree } : {}),
    ...(typeof metadata?.useLocalBranch === 'boolean' ? { useLocalBranch: metadata.useLocalBranch } : {}),
    ...(metadata?.pushNewBranches !== undefined ? { pushNewBranches: metadata.pushNewBranches } : {}),
  };
}

function isAutocodeAgentRuntimeStartRequest(
  value: AutocodeAgentRuntimeStartRequest | AutocodeAgentRuntimePlan,
): value is AutocodeAgentRuntimeStartRequest {
  return 'plan' in value && 'runtimeId' in value;
}

function createAutocodeAgentRuntimeMessages(
  plan: AutocodeAgentRuntimePlan,
  label: string,
  overrides: Partial<AutocodeAgentRuntimeMessages> | undefined,
): AutocodeAgentRuntimeMessages {
  return {
    prepared: `Prepared agent runtime for ${plan.specId}: ${label} (${plan.mode}).`,
    starting: `Starting Autocode ${label}: ${plan.taskTitle}.`,
    started: `Started Autocode ${label}: ${plan.taskTitle}.`,
    completed: `Autocode ${label} completed: ${plan.taskTitle}.`,
    failed: `Autocode ${label} failed: ${plan.taskTitle}.`,
    stopped: `Stopped Autocode ${label}: ${plan.taskTitle}.`,
    ...overrides,
  };
}

function isDirectAutocodeWorkflow(metadata: AutocodeAgentRuntimeMetadata | undefined): boolean {
  return metadata?.developmentMode === 'direct' || metadata?.workflowMode === 'off';
}
