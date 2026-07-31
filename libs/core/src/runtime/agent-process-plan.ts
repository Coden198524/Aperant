import type { AutocodeTokenUsage } from './agent-session-types.js';
import type { AutocodeAgentRuntimeProcessType } from './agent-runtime.js';
import type { AutocodeRuntimeWorkspaceClaimInput } from './workspace-claims.js';

export const AUTOCODE_TASK_TOKEN_USAGE_PREFIX = '__TASK_TOKEN_USAGE__:';

export type AutocodeAgentProcessType =
  | AutocodeAgentRuntimeProcessType
  | 'qa-process'
  | 'openspec-action';
export type AutocodeAgentProcessInitialPhase = 'planning' | 'coding' | 'qa_review';

export interface AutocodeAgentWorkerProcessStartPlanInput {
  taskId: string;
  processType: AutocodeAgentProcessType;
  projectId?: string;
  workspaceClaim?: AutocodeRuntimeWorkspaceClaimInput | null;
  initialTokenUsage?: AutocodeTokenUsage | null;
}

export interface AutocodeAgentWorkerProcessStartPlan {
  taskId: string;
  processType: AutocodeAgentProcessType;
  initialPhase: AutocodeAgentProcessInitialPhase;
  workspaceClaim: AutocodeRuntimeWorkspaceClaimInput | null;
  initialTokenUsage: AutocodeTokenUsage | null;
  projectId?: string;
}

export function getAutocodeInitialPhaseForProcess(
  processType: AutocodeAgentProcessType,
): AutocodeAgentProcessInitialPhase {
  switch (processType) {
    case 'spec-creation':
      return 'planning';
    case 'qa-process':
      return 'qa_review';
    case 'openspec-action':
    case 'task-execution':
    default:
      return 'coding';
  }
}

export function createAutocodeAgentWorkerProcessStartPlan(
  input: AutocodeAgentWorkerProcessStartPlanInput,
): AutocodeAgentWorkerProcessStartPlan {
  return {
    taskId: input.taskId,
    processType: input.processType,
    initialPhase: getAutocodeInitialPhaseForProcess(input.processType),
    workspaceClaim: input.workspaceClaim ?? null,
    initialTokenUsage: input.initialTokenUsage ?? null,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
}

export function parseAutocodeTaskTokenUsage(line: string): AutocodeTokenUsage | null {
  const markerIndex = line.indexOf(AUTOCODE_TASK_TOKEN_USAGE_PREFIX);
  if (markerIndex < 0) {
    return null;
  }

  const jsonText = line.slice(markerIndex + AUTOCODE_TASK_TOKEN_USAGE_PREFIX.length).trim();
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText) as Partial<AutocodeTokenUsage>;
    const promptTokens = readPositiveNumber(parsed.promptTokens);
    const completionTokens = readPositiveNumber(parsed.completionTokens);
    const totalTokens = readPositiveNumber(parsed.totalTokens);
    if (!promptTokens && !completionTokens && !totalTokens) {
      return null;
    }

    const thinkingTokens = readOptionalPositiveNumber(parsed.thinkingTokens);
    const cacheReadTokens = readOptionalPositiveNumber(parsed.cacheReadTokens);
    const cacheCreationTokens = readOptionalPositiveNumber(parsed.cacheCreationTokens);
    const stepsExecuted = readOptionalPositiveNumber(parsed.stepsExecuted);

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      ...(thinkingTokens ? { thinkingTokens } : {}),
      ...(cacheReadTokens ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens ? { cacheCreationTokens } : {}),
      ...(stepsExecuted ? { stepsExecuted } : {}),
      ...(parsed.estimated === true ? { estimated: true } : {}),
      ...(typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
        ? { sessionId: parsed.sessionId.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

function readPositiveNumber(value: unknown): number {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : 0;
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function readOptionalPositiveNumber(value: unknown): number | undefined {
  const number = readPositiveNumber(value);
  return number > 0 ? number : undefined;
}
