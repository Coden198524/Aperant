import {
  AutocodeExecutionPhaseParser,
  buildAutocodeExecutionProgressData,
  calculateAutocodeOverallProgress,
  handleAutocodeStructuredProgressEvent,
  parseAutocodeIdeationProgress,
  parseAutocodeRoadmapProgress,
} from '@autocode/core/runtime/agent-phase-parsers';
import type { ExecutionProgressData } from './types';
import type { ExecutionPhase } from '../../shared/constants/phase-protocol';

/**
 * Structured progress event from a worker thread (via postMessage).
 * Mirrors the data shape of WorkerProgressMessage without importing from the ai/ layer.
 */
export interface StructuredProgressEvent {
  phase: ExecutionPhase;
  message?: string;
  currentSubtask?: string;
  phaseProgress?: number;
  overallProgress?: number;
  resetTimestamp?: number;
  profileId?: string;
  completedPhases?: ExecutionProgressData['completedPhases'];
}

export class AgentEvents {
  private readonly executionParser = new AutocodeExecutionPhaseParser();

  handleStructuredProgress(
    event: StructuredProgressEvent,
    currentPhase: ExecutionProgressData['phase'],
  ): {
    phase: ExecutionProgressData['phase'];
    message?: string;
    currentSubtask?: string;
    resetTimestamp?: number;
    profileId?: string;
  } | null {
    return handleAutocodeStructuredProgressEvent(event, currentPhase);
  }

  buildProgressData(
    event: StructuredProgressEvent,
    currentPhase: ExecutionProgressData['phase'],
  ): ExecutionProgressData | null {
    const progress = buildAutocodeExecutionProgressData(event, currentPhase);
    if (!progress) {
      return null;
    }

    return {
      phase: progress.phase,
      phaseProgress: progress.phaseProgress,
      overallProgress: progress.overallProgress,
      currentSubtask: progress.currentSubtask,
      message: progress.message,
      completedPhases: event.completedPhases,
    };
  }

  parseExecutionPhase(
    log: string,
    currentPhase: ExecutionProgressData['phase'],
    isSpecRunner: boolean,
  ): {
    phase: ExecutionProgressData['phase'];
    message?: string;
    currentSubtask?: string;
    progress?: number;
    resetTimestamp?: number;
    profileId?: string;
  } | null {
    return this.executionParser.parse(log, {
      currentPhase,
      isTerminal: currentPhase === 'complete' || currentPhase === 'failed',
      isSpecRunner,
    });
  }

  calculateOverallProgress(phase: ExecutionProgressData['phase'], phaseProgress: number): number {
    return calculateAutocodeOverallProgress(phase, phaseProgress);
  }

  parseIdeationProgress(
    log: string,
    currentPhase: string,
    currentProgress: number,
    completedTypes: Set<string>,
    totalTypes: number,
  ): { phase: string; progress: number } {
    return parseAutocodeIdeationProgress(log, currentPhase, currentProgress, completedTypes, totalTypes);
  }

  parseRoadmapProgress(log: string, currentPhase: string, currentProgress: number): { phase: string; progress: number } {
    return parseAutocodeRoadmapProgress(log, currentPhase, currentProgress);
  }
}
