import type { AcuteCandidate, SignalType } from '../types.js';
import type { ObserverSignal } from './signals.js';

export interface ScratchpadAnalytics {
  fileAccessCounts: Map<string, number>;
  fileFirstAccess: Map<string, number>;
  fileLastAccess: Map<string, number>;
  fileEditSet: Set<string>;
  grepPatternCounts: Map<string, number>;
  grepPatternResults: Map<string, boolean[]>;
  errorFingerprints: Map<string, number>;
  errorFingerprintSamples: Map<string, string>;
  currentStep: number;
  recentToolSequence: string[];
  intraSessionCoAccess: Map<string, Set<string>>;
  configFilesTouched: Set<string>;
  selfCorrectionCount: number;
  lastSelfCorrectionStep: number;
  totalInputTokens: number;
  peakContextTokens: number;
}

export interface ScratchpadLike {
  signals: Map<SignalType, ObserverSignal[]>;
  analytics: ScratchpadAnalytics;
  acuteCandidates: AcuteCandidate[];
}
