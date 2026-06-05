export {
  DEAD_END_LANGUAGE_PATTERNS,
  detectDeadEnd,
  type DeadEndDetectionResult,
} from './dead-end-detector.js';

export {
  applyTrustGate,
} from './trust-gate.js';

export {
  SIGNAL_VALUES,
  SELF_CORRECTION_PATTERNS,
  type BacktrackSignal,
  type BaseSignal,
  type CoAccessSignal,
  type ConfigTouchSignal,
  type ContextTokenSpikeSignal,
  type ErrorRetrySignal,
  type ExternalReferenceSignal,
  type FileAccessSignal,
  type GlobIgnoreSignal,
  type ImportChaseSignal,
  type ObserverSignal,
  type ParallelConflictSignal,
  type ReadAbandonSignal,
  type RepeatedGrepSignal,
  type SelfCorrectionSignal,
  type SignalValueEntry,
  type StepOverrunSignal,
  type TestOrderSignal,
  type TimeAnomalySignal,
  type ToolSequenceSignal,
} from './signals.js';

export {
  EARLY_TRIGGERS,
  PromotionPipeline,
  SESSION_TYPE_PROMOTION_LIMITS,
  type EarlyTrigger,
} from './promotion.js';

export {
  ParallelScratchpadMerger,
  type MergedScratchpad,
  type MergedScratchpadEntry,
} from './scratchpad-merger.js';

export type {
  ScratchpadAnalytics,
  ScratchpadLike,
} from './types.js';
