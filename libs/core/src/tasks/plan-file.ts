import type { AutocodeExecutionPhase, AutocodePlanStatus, AutocodeTaskStatus } from './spec-store.js';

export interface AutocodeTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  estimated?: boolean;
  stepsExecuted?: number;
  sessionId?: string;
}

export interface MutableAutocodePlanSubtask extends Record<string, unknown> {
  id?: string;
  status?: string;
  started_at?: string | null;
  active_started_at?: string | null;
  completed_at?: string | null;
  completion_summary?: string | null;
  duration_ms?: number | null;
}

export interface MutableAutocodePlanPhase extends Record<string, unknown> {
  subtasks?: MutableAutocodePlanSubtask[];
  chunks?: MutableAutocodePlanSubtask[];
}

export interface MutableAutocodePlan extends Record<string, unknown> {
  feature?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  planRevision?: number;
  status?: string;
  planStatus?: string;
  reviewReason?: string;
  xstateState?: string;
  executionPhase?: string;
  phases?: MutableAutocodePlanPhase[];
  tokenUsage?: AutocodeTokenUsage;
}

export interface AutocodeTaskPlanSeed {
  title: string;
  description?: string;
  createdAt: string;
}

export function mapAutocodeTaskStatusToPlanStatus(status: AutocodeTaskStatus | string): AutocodePlanStatus {
  switch (status) {
    case 'queue':
      return 'queued';
    case 'in_progress':
      return 'in_progress';
    case 'ai_review':
    case 'human_review':
      return 'review';
    case 'done':
      return 'completed';
    case 'pr_created':
      return 'pr_created';
    case 'error':
      return 'error';
    case 'backlog':
    default:
      return 'pending';
  }
}

export function mapAutocodeExecutionPhaseToTaskStatus(phase: string): AutocodeTaskStatus | undefined {
  const phaseToStatus: Record<string, AutocodeTaskStatus> = {
    planning: 'in_progress',
    coding: 'in_progress',
    qa_review: 'ai_review',
    qa_fixing: 'ai_review',
    complete: 'human_review',
    failed: 'error',
  };
  return phaseToStatus[phase];
}

export function createMinimalAutocodePlan(
  task: AutocodeTaskPlanSeed,
  status: AutocodeTaskStatus | string,
  now = new Date().toISOString(),
  xstateState?: string,
): MutableAutocodePlan {
  return {
    feature: task.title,
    description: task.description || '',
    created_at: task.createdAt,
    updated_at: now,
    status,
    planStatus: mapAutocodeTaskStatusToPlanStatus(status),
    ...(xstateState ? { xstateState } : {}),
    phases: [],
  };
}

export function applyAutocodePlanStatus(
  plan: MutableAutocodePlan,
  status: AutocodeTaskStatus | string,
  now = new Date().toISOString(),
): MutableAutocodePlan {
  plan.status = status;
  plan.planStatus = mapAutocodeTaskStatusToPlanStatus(status);
  plan.updated_at = now;
  return plan;
}

export function applyAutocodePlanStatusAndReason(
  plan: MutableAutocodePlan,
  status: AutocodeTaskStatus | string,
  input: {
    reviewReason?: string;
    xstateState?: string;
    executionPhase?: string;
    now?: string;
  } = {},
): MutableAutocodePlan {
  applyAutocodePlanStatus(plan, status, input.now);
  plan.reviewReason = input.reviewReason;
  if (input.xstateState) {
    plan.xstateState = input.xstateState;
  }
  if (input.executionPhase) {
    plan.executionPhase = input.executionPhase;
  }
  return plan;
}

export function applyAutocodePlanPhase(
  plan: MutableAutocodePlan,
  phase: string,
  now = new Date().toISOString(),
): MutableAutocodePlan {
  plan.executionPhase = phase;
  const mappedStatus = mapAutocodeExecutionPhaseToTaskStatus(phase);
  if (mappedStatus) {
    plan.status = mappedStatus;
    plan.planStatus = mapAutocodeTaskStatusToPlanStatus(mappedStatus);
  }
  plan.updated_at = now;
  return plan;
}

export function mergeAutocodeTokenUsage(
  previous: AutocodeTokenUsage | undefined,
  incoming: AutocodeTokenUsage,
): AutocodeTokenUsage {
  if (!previous) {
    return incoming;
  }

  const prevSteps = previous.stepsExecuted ?? 0;
  const incomingSteps = incoming.stepsExecuted ?? 0;
  if (previous.estimated === true && incoming.estimated !== true) {
    return {
      ...incoming,
      stepsExecuted: Math.max(prevSteps, incomingSteps) || undefined,
      sessionId: incoming.sessionId,
    };
  }

  const preferIncomingTokens = !incoming.estimated || previous.estimated === true;

  return {
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
    stepsExecuted: Math.max(prevSteps, incomingSteps) || undefined,
    estimated: previous.estimated === true && incoming.estimated === true ? true : undefined,
    sessionId: incoming.sessionId,
  };
}

export function applyAutocodePlanTokenUsage(
  plan: MutableAutocodePlan,
  usage: AutocodeTokenUsage,
  now = new Date().toISOString(),
): MutableAutocodePlan {
  plan.tokenUsage = mergeAutocodeTokenUsage(plan.tokenUsage, usage);
  plan.updated_at = now;
  return plan;
}

export function countAutocodePlanSubtasks(phases: unknown): number {
  if (!Array.isArray(phases)) {
    return 0;
  }

  return phases.reduce((total, phase) => {
    if (!phase || typeof phase !== 'object') {
      return total;
    }
    const typedPhase = phase as MutableAutocodePlanPhase;
    const subtasks = Array.isArray(typedPhase.subtasks)
      ? typedPhase.subtasks
      : Array.isArray(typedPhase.chunks)
        ? typedPhase.chunks
        : [];
    return total + subtasks.length;
  }, 0);
}

export function resetAutocodeStuckSubtasksInPlan(plan: MutableAutocodePlan): {
  plan: MutableAutocodePlan;
  resetCount: number;
} {
  let resetCount = 0;
  if (!Array.isArray(plan.phases)) {
    return { plan, resetCount };
  }

  for (const phase of plan.phases) {
    const subtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    for (const subtask of subtasks) {
      if (subtask.status === 'in_progress' || subtask.status === 'failed' || subtask.status === 'blocked') {
        subtask.status = 'pending';
        subtask.started_at = null;
        subtask.active_started_at = null;
        subtask.completed_at = null;
        subtask.completion_summary = null;
        resetCount++;
      }
    }
  }

  if (resetCount > 0) {
    plan.updated_at = new Date().toISOString();
  }

  return { plan, resetCount };
}

export function canSyncAutocodePlanPhases(existingPhases: unknown, incomingPhases: unknown): boolean {
  const existingSubtaskCount = countAutocodePlanSubtasks(existingPhases);
  const incomingSubtaskCount = countAutocodePlanSubtasks(incomingPhases);
  return !(existingSubtaskCount > 0 && incomingSubtaskCount === 0);
}

export function inferAutocodeExecutionProgress(
  planStatus: string | undefined,
): { phase: AutocodeExecutionPhase; phaseProgress: number; overallProgress: number } | undefined {
  if (!planStatus) {
    return undefined;
  }

  const phaseMap: Record<string, AutocodeExecutionPhase> = {
    pending: 'idle',
    backlog: 'idle',
    queue: 'idle',
    queued: 'idle',
    planning: 'planning',
    coding: 'coding',
    in_progress: 'coding',
    review: 'qa_review',
    ai_review: 'qa_review',
    qa_review: 'qa_review',
    qa_fixing: 'qa_fixing',
    human_review: 'complete',
    completed: 'complete',
    done: 'complete',
    error: 'failed',
  };
  const phase = phaseMap[planStatus];
  return phase ? { phase, phaseProgress: 50, overallProgress: 50 } : undefined;
}

export function inferAutocodeExecutionProgressFromXState(
  xstateState: string,
): { phase: AutocodeExecutionPhase; phaseProgress: number; overallProgress: number } | undefined {
  const phaseMap: Record<string, AutocodeExecutionPhase> = {
    backlog: 'idle',
    planning: 'planning',
    plan_review: 'planning',
    coding: 'coding',
    qa_review: 'qa_review',
    qa_fixing: 'qa_fixing',
    human_review: 'complete',
    error: 'failed',
    creating_pr: 'complete',
    pr_created: 'complete',
    done: 'complete',
  };
  const phase = phaseMap[xstateState];
  return phase
    ? {
        phase,
        phaseProgress: phase === 'complete' ? 100 : 50,
        overallProgress: phase === 'complete' ? 100 : 50,
      }
    : undefined;
}
