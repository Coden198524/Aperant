export const PHASE_MARKER_PREFIX = '__EXEC_PHASE__:' as const;
export const PHASE_PROTOCOL_VERSION = '1.0.0' as const;

export const EXECUTION_PHASES = [
  'idle',
  'planning',
  'coding',
  'rate_limit_paused',
  'auth_failure_paused',
  'qa_review',
  'qa_fixing',
  'complete',
  'failed',
  'stopped',
] as const;

export const BACKEND_PHASES = [
  'planning',
  'coding',
  'rate_limit_paused',
  'auth_failure_paused',
  'qa_review',
  'qa_fixing',
  'complete',
  'failed',
] as const;

export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];
export type BackendPhase = (typeof BACKEND_PHASES)[number];
export type CompletablePhase = 'planning' | 'coding' | 'qa_review' | 'qa_fixing';

export const PHASE_ORDER_INDEX: Readonly<Record<ExecutionPhase, number>> = {
  idle: -1,
  planning: 0,
  coding: 1,
  rate_limit_paused: 1,
  auth_failure_paused: 1,
  qa_review: 2,
  qa_fixing: 3,
  complete: 4,
  failed: 99,
  stopped: -1,
} as const;

export const TERMINAL_PHASES: ReadonlySet<ExecutionPhase> = new Set(['complete', 'failed']);
export const PAUSE_PHASES: ReadonlySet<ExecutionPhase> = new Set([
  'rate_limit_paused',
  'auth_failure_paused',
]);

export function isPausePhase(phase: ExecutionPhase): boolean {
  return PAUSE_PHASES.has(phase);
}

export function wouldPhaseRegress(currentPhase: ExecutionPhase, newPhase: ExecutionPhase): boolean {
  const currentIndex = PHASE_ORDER_INDEX[currentPhase];
  const newIndex = PHASE_ORDER_INDEX[newPhase];
  return newIndex < currentIndex;
}

export function isAllowedPhaseRegression(
  currentPhase: ExecutionPhase,
  newPhase: ExecutionPhase,
): boolean {
  if (currentPhase === 'qa_fixing' && newPhase === 'qa_review') {
    return true;
  }

  return (currentPhase === 'qa_review' || currentPhase === 'qa_fixing') && newPhase === 'coding';
}

export function isTerminalPhase(phase: ExecutionPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function isValidBackendPhase(value: string): value is BackendPhase {
  return (BACKEND_PHASES as readonly string[]).includes(value);
}

export function isValidExecutionPhase(value: string): value is ExecutionPhase {
  return (EXECUTION_PHASES as readonly string[]).includes(value);
}

export function isValidPhaseTransition(
  currentPhase: ExecutionPhase,
  newPhase: ExecutionPhase,
  completedPhases: CompletablePhase[] = [],
): boolean {
  if (isTerminalPhase(currentPhase)) {
    return false;
  }

  if (currentPhase === 'idle') {
    return BACKEND_PHASES.includes(newPhase as BackendPhase);
  }

  if (currentPhase === newPhase) {
    return true;
  }

  const phasePrerequisites: Record<ExecutionPhase, CompletablePhase[]> = {
    idle: [],
    planning: [],
    coding: ['planning'],
    rate_limit_paused: [],
    auth_failure_paused: [],
    qa_review: ['coding'],
    qa_fixing: ['qa_review'],
    complete: ['qa_review', 'qa_fixing'],
    failed: [],
    stopped: [],
  };

  if (newPhase === 'failed') {
    return true;
  }
  if (isAllowedPhaseRegression(currentPhase, newPhase)) {
    return true;
  }
  if (currentPhase === 'coding' && isPausePhase(newPhase)) {
    return true;
  }
  if (isPausePhase(currentPhase) && newPhase === 'coding') {
    return true;
  }

  const prerequisites = phasePrerequisites[newPhase];
  if (prerequisites.length === 0) {
    return true;
  }

  return prerequisites.some((phase) => completedPhases.includes(phase));
}

export function getExpectedPreviousPhase(phase: ExecutionPhase): ExecutionPhase | null {
  const previousPhases: Record<ExecutionPhase, ExecutionPhase | null> = {
    idle: null,
    planning: 'idle',
    coding: 'planning',
    rate_limit_paused: 'coding',
    auth_failure_paused: 'coding',
    qa_review: 'coding',
    qa_fixing: 'qa_review',
    complete: 'qa_review',
    failed: null,
    stopped: null,
  };
  return previousPhases[phase];
}
