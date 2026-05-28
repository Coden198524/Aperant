export {
  BACKEND_PHASES,
  EXECUTION_PHASES,
  PAUSE_PHASES,
  PHASE_MARKER_PREFIX,
  PHASE_ORDER_INDEX,
  PHASE_PROTOCOL_VERSION,
  TERMINAL_PHASES,
  getExpectedPreviousPhase,
  isAllowedPhaseRegression,
  isPausePhase,
  isTerminalPhase,
  isValidBackendPhase,
  isValidExecutionPhase,
  isValidPhaseTransition,
  wouldPhaseRegress,
} from '@autocode/core/tasks/phase-protocol';

export type {
  BackendPhase,
  CompletablePhase,
  ExecutionPhase,
} from '@autocode/core/tasks/phase-protocol';
