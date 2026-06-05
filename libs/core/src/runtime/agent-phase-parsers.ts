import {
  EXECUTION_PHASES,
  TERMINAL_PHASES,
  isTerminalPhase,
  isPausePhase,
  isValidExecutionPhase,
  wouldPhaseRegress,
  type ExecutionPhase,
} from '../tasks/phase-protocol.js';
import { parseAutocodePhaseEvent } from './agent-events.js';

export const AUTOCODE_EXECUTION_PHASE_WEIGHTS: Readonly<Record<ExecutionPhase, { start: number; end: number }>> = {
  idle: { start: 0, end: 0 },
  planning: { start: 0, end: 20 },
  coding: { start: 20, end: 80 },
  rate_limit_paused: { start: 20, end: 80 },
  auth_failure_paused: { start: 20, end: 80 },
  qa_review: { start: 80, end: 95 },
  qa_fixing: { start: 80, end: 95 },
  complete: { start: 100, end: 100 },
  failed: { start: 0, end: 0 },
};

export interface AutocodePhaseParseResult<TPhase extends string = string> {
  phase: TPhase;
  message?: string;
  currentSubtask?: string;
  progress?: number;
  resetTimestamp?: number;
  profileId?: string;
}

export interface AutocodePhaseParserContext<TPhase extends string = string> {
  currentPhase: TPhase;
  isTerminal: boolean;
}

export abstract class AutocodeBasePhaseParser<TPhase extends string> {
  protected abstract readonly phaseOrder: readonly TPhase[];
  protected abstract readonly terminalPhases: ReadonlySet<TPhase>;

  protected wouldRegress(currentPhase: TPhase, newPhase: TPhase): boolean {
    const currentIdx = this.phaseOrder.indexOf(currentPhase);
    const newIdx = this.phaseOrder.indexOf(newPhase);
    return currentIdx >= 0 && newIdx >= 0 && newIdx < currentIdx;
  }

  protected isTerminal(phase: TPhase): boolean {
    return this.terminalPhases.has(phase);
  }

  abstract parse(
    log: string,
    context: AutocodePhaseParserContext<TPhase>,
  ): AutocodePhaseParseResult<TPhase> | null;
}

export interface AutocodeExecutionParserContext extends AutocodePhaseParserContext<ExecutionPhase> {
  isSpecRunner: boolean;
}

export interface AutocodeStructuredProgressEvent {
  phase: ExecutionPhase;
  message?: string;
  currentSubtask?: string;
  phaseProgress?: number;
  overallProgress?: number;
  resetTimestamp?: number;
  profileId?: string;
  completedPhases?: string[];
}

export interface AutocodeExecutionProgressData {
  phase: ExecutionPhase;
  phaseProgress: number;
  overallProgress: number;
  currentSubtask?: string;
  message?: string;
  completedPhases?: string[];
}

export function handleAutocodeStructuredProgressEvent(
  event: AutocodeStructuredProgressEvent,
  currentPhase: ExecutionPhase,
): AutocodePhaseParseResult<ExecutionPhase> | null {
  if (isTerminalPhase(currentPhase) && !isTerminalPhase(event.phase)) {
    return null;
  }

  if (
    isValidExecutionPhase(currentPhase) &&
    isValidExecutionPhase(event.phase) &&
    wouldPhaseRegress(currentPhase, event.phase)
  ) {
    return null;
  }

  return {
    phase: event.phase,
    message: event.message,
    currentSubtask: event.currentSubtask,
    resetTimestamp: event.resetTimestamp,
    profileId: event.profileId,
  };
}

export function buildAutocodeExecutionProgressData(
  event: AutocodeStructuredProgressEvent,
  currentPhase: ExecutionPhase,
): AutocodeExecutionProgressData | null {
  const update = handleAutocodeStructuredProgressEvent(event, currentPhase);
  if (!update) {
    return null;
  }

  const phaseProgress = event.phaseProgress ?? 0;
  const overallProgress = event.overallProgress ?? calculateAutocodeOverallProgress(update.phase, phaseProgress);

  return {
    phase: update.phase,
    phaseProgress,
    overallProgress,
    currentSubtask: update.currentSubtask,
    message: update.message,
    completedPhases: event.completedPhases,
  };
}

export function calculateAutocodeOverallProgress(phase: string, phaseProgress: number): number {
  if (!isValidExecutionPhase(phase)) {
    return 0;
  }

  const phaseWeight = AUTOCODE_EXECUTION_PHASE_WEIGHTS[phase];
  const phaseRange = phaseWeight.end - phaseWeight.start;
  return Math.round(phaseWeight.start + ((phaseRange * phaseProgress) / 100));
}

export class AutocodeExecutionPhaseParser extends AutocodeBasePhaseParser<ExecutionPhase> {
  protected readonly phaseOrder = EXECUTION_PHASES;
  protected readonly terminalPhases = TERMINAL_PHASES;

  parse(log: string, context: AutocodeExecutionParserContext): AutocodePhaseParseResult<ExecutionPhase> | null {
    const structuredEvent = parseAutocodePhaseEvent(log);
    if (structuredEvent) {
      const result: AutocodePhaseParseResult<ExecutionPhase> = {
        phase: structuredEvent.phase as ExecutionPhase,
        message: structuredEvent.message,
        currentSubtask: structuredEvent.subtask,
      };

      if (structuredEvent.reset_timestamp !== undefined) {
        result.resetTimestamp = structuredEvent.reset_timestamp;
      }
      if (structuredEvent.profile_id !== undefined) {
        result.profileId = structuredEvent.profile_id;
      }

      return result;
    }

    if (this.isTerminal(context.currentPhase)) {
      return null;
    }

    if (isPausePhase(context.currentPhase)) {
      return null;
    }

    return this.parseFallbackPatterns(log, context);
  }

  private parseFallbackPatterns(
    log: string,
    context: AutocodeExecutionParserContext,
  ): AutocodePhaseParseResult<ExecutionPhase> | null {
    if (log.includes('__TASK_LOG_')) {
      return null;
    }

    const lowerLog = log.toLowerCase();
    const { currentPhase, isSpecRunner } = context;

    if (isSpecRunner) {
      return this.parseSpecRunnerPhase(lowerLog);
    }

    return this.parseRunPhase(lowerLog, log, currentPhase);
  }

  private parseSpecRunnerPhase(lowerLog: string): AutocodePhaseParseResult<ExecutionPhase> | null {
    if (lowerLog.includes('discovering') || lowerLog.includes('discovery')) {
      return { phase: 'planning', message: 'Discovering project context...' };
    }
    if (lowerLog.includes('requirements') || lowerLog.includes('gathering')) {
      return { phase: 'planning', message: 'Gathering requirements...' };
    }
    if (lowerLog.includes('writing spec') || lowerLog.includes('spec writer')) {
      return { phase: 'planning', message: 'Writing specification...' };
    }
    if (lowerLog.includes('validating') || lowerLog.includes('validation')) {
      return { phase: 'planning', message: 'Validating specification...' };
    }
    if (lowerLog.includes('spec complete') || lowerLog.includes('specification complete')) {
      return { phase: 'planning', message: 'Specification complete' };
    }

    return null;
  }

  private parseRunPhase(
    lowerLog: string,
    originalLog: string,
    currentPhase: ExecutionPhase,
  ): AutocodePhaseParseResult<ExecutionPhase> | null {
    if (
      !this.wouldRegress(currentPhase, 'planning') &&
      (lowerLog.includes('planner agent') || lowerLog.includes('creating implementation plan'))
    ) {
      return { phase: 'planning', message: 'Creating implementation plan...' };
    }

    if (
      !this.wouldRegress(currentPhase, 'coding') &&
      (lowerLog.includes('coder agent') || lowerLog.includes('starting coder'))
    ) {
      return { phase: 'coding', message: 'Implementing code changes...' };
    }

    const subtaskMatch = originalLog.match(/subtask[:\s]+(\d+(?:\/\d+)?|\w+[-_]\w+)/i);
    if (subtaskMatch && currentPhase === 'coding') {
      return {
        phase: 'coding',
        currentSubtask: subtaskMatch[1],
        message: `Working on subtask ${subtaskMatch[1]}...`,
      };
    }

    if (
      !this.wouldRegress(currentPhase, 'coding') &&
      (lowerLog.includes('subtask completed') || lowerLog.includes('subtask done'))
    ) {
      const completedSubtask = originalLog.match(/subtask[:\s]+"?([^"]+)"?\s+completed/i);
      return {
        phase: 'coding',
        currentSubtask: completedSubtask?.[1],
        message: `Subtask ${completedSubtask?.[1] ?? ''} completed`,
      };
    }

    const canEnterQAPhase = currentPhase === 'coding' || currentPhase === 'qa_review' || currentPhase === 'qa_fixing';

    if (
      canEnterQAPhase &&
      (lowerLog.includes('qa fixer') || lowerLog.includes('qa_fixer') || lowerLog.includes('fixing issues'))
    ) {
      return { phase: 'qa_fixing', message: 'Fixing QA issues...' };
    }

    if (
      canEnterQAPhase &&
      (lowerLog.includes('qa reviewer') || lowerLog.includes('qa_reviewer') || lowerLog.includes('starting qa'))
    ) {
      return { phase: 'qa_review', message: 'Running QA review...' };
    }

    if (
      !this.wouldRegress(currentPhase, 'coding') &&
      (lowerLog.includes('build incomplete') || lowerLog.includes('subtasks still pending'))
    ) {
      return { phase: 'coding', message: 'Build paused - subtasks still pending' };
    }

    const isToolError = lowerLog.includes('tool error') || lowerLog.includes('tool_use_error');
    if (
      !isToolError &&
      (lowerLog.includes('build failed') ||
        lowerLog.includes('fatal error') ||
        lowerLog.includes('agent failed'))
    ) {
      return { phase: 'failed', message: originalLog.trim().substring(0, 200) };
    }

    return null;
  }
}

export const AUTOCODE_IDEATION_PHASES = [
  'idle',
  'analyzing',
  'discovering',
  'generating',
  'finalizing',
  'complete',
] as const;

export type AutocodeIdeationPhase = (typeof AUTOCODE_IDEATION_PHASES)[number];

export const AUTOCODE_IDEATION_TERMINAL_PHASES: ReadonlySet<AutocodeIdeationPhase> = new Set(['complete']);

export interface AutocodeIdeationParserContext extends AutocodePhaseParserContext<AutocodeIdeationPhase> {
  completedTypes: Set<string>;
  totalTypes: number;
}

export interface AutocodeIdeationParseResult extends AutocodePhaseParseResult<AutocodeIdeationPhase> {
  progress: number;
}

export class AutocodeIdeationPhaseParser extends AutocodeBasePhaseParser<AutocodeIdeationPhase> {
  protected readonly phaseOrder = AUTOCODE_IDEATION_PHASES;
  protected readonly terminalPhases = AUTOCODE_IDEATION_TERMINAL_PHASES;

  parse(log: string, context: AutocodeIdeationParserContext): AutocodeIdeationParseResult | null {
    if (context.isTerminal) {
      return null;
    }

    const result = this.parsePhaseFromLog(log);
    if (!result) {
      if (context.currentPhase === 'generating' && context.completedTypes.size > 0) {
        return {
          phase: 'generating',
          progress: this.calculateGeneratingProgress(context.completedTypes.size, context.totalTypes),
        };
      }
      return null;
    }

    let progress = result.progress;
    if (result.phase === 'generating' && context.completedTypes.size > 0) {
      progress = this.calculateGeneratingProgress(context.completedTypes.size, context.totalTypes);
    }

    return {
      ...result,
      progress,
    };
  }

  private calculateGeneratingProgress(completedCount: number, totalTypes: number): number {
    if (totalTypes <= 0) {
      return 90;
    }

    return 30 + Math.floor((completedCount / totalTypes) * 60);
  }

  private parsePhaseFromLog(log: string): AutocodeIdeationParseResult | null {
    if (log.includes('PROJECT INDEX') || log.includes('PROJECT ANALYSIS')) {
      return { phase: 'analyzing', progress: 10 };
    }

    if (log.includes('CONTEXT GATHERING')) {
      return { phase: 'discovering', progress: 20 };
    }

    if (
      log.includes('GENERATING IDEAS (PARALLEL)') ||
      (log.includes('Starting') && log.includes('ideation agents in parallel'))
    ) {
      return { phase: 'generating', progress: 30 };
    }

    if (log.includes('MERGE') || log.includes('FINALIZE')) {
      return { phase: 'finalizing', progress: 90 };
    }

    if (log.includes('IDEATION COMPLETE')) {
      return { phase: 'complete', progress: 100 };
    }

    return null;
  }
}

export function parseAutocodeIdeationProgress(
  log: string,
  currentPhase: string,
  currentProgress: number,
  completedTypes: ReadonlySet<string>,
  totalTypes: number,
): { phase: string; progress: number } {
  const parser = new AutocodeIdeationPhaseParser();
  const result = parser.parse(log, {
    currentPhase: isAutocodeIdeationPhase(currentPhase) ? currentPhase : 'idle',
    isTerminal: currentPhase === 'complete',
    completedTypes: new Set(completedTypes),
    totalTypes,
  });

  if (!result) {
    return { phase: currentPhase, progress: currentProgress };
  }

  return {
    phase: result.phase,
    progress: result.progress,
  };
}

function isAutocodeIdeationPhase(value: string): value is AutocodeIdeationPhase {
  return (AUTOCODE_IDEATION_PHASES as readonly string[]).includes(value);
}

export const AUTOCODE_ROADMAP_PHASES = ['idle', 'analyzing', 'discovering', 'generating', 'complete'] as const;

export type AutocodeRoadmapPhase = (typeof AUTOCODE_ROADMAP_PHASES)[number];

export const AUTOCODE_ROADMAP_TERMINAL_PHASES: ReadonlySet<AutocodeRoadmapPhase> = new Set(['complete']);

export interface AutocodeRoadmapParseResult extends AutocodePhaseParseResult<AutocodeRoadmapPhase> {
  progress: number;
}

export class AutocodeRoadmapPhaseParser extends AutocodeBasePhaseParser<AutocodeRoadmapPhase> {
  protected readonly phaseOrder = AUTOCODE_ROADMAP_PHASES;
  protected readonly terminalPhases = AUTOCODE_ROADMAP_TERMINAL_PHASES;

  parse(
    log: string,
    context: AutocodePhaseParserContext<AutocodeRoadmapPhase>,
  ): AutocodeRoadmapParseResult | null {
    if (this.isTerminal(context.currentPhase)) {
      return null;
    }

    const result = this.parsePhaseFromLog(log);
    if (result && this.wouldRegress(context.currentPhase, result.phase)) {
      return null;
    }

    return result;
  }

  private parsePhaseFromLog(log: string): AutocodeRoadmapParseResult | null {
    if (log.includes('PROJECT ANALYSIS')) {
      return { phase: 'analyzing', progress: 20 };
    }

    if (log.includes('PROJECT DISCOVERY')) {
      return { phase: 'discovering', progress: 40 };
    }

    if (log.includes('FEATURE GENERATION')) {
      return { phase: 'generating', progress: 70 };
    }

    if (log.includes('ROADMAP GENERATED')) {
      return { phase: 'complete', progress: 100 };
    }

    return null;
  }
}

const AUTOCODE_ROADMAP_PHASE_ORDER: Readonly<Record<string, number>> = {
  idle: 0,
  analyzing: 1,
  discovering: 2,
  generating: 3,
  complete: 4,
  error: 5,
};

export function parseAutocodeRoadmapProgress(
  log: string,
  currentPhase: string,
  currentProgress: number,
): { phase: string; progress: number } {
  let phase = currentPhase;
  let progress = currentProgress;
  let detectedPhase = currentPhase;

  if (log.includes('PROJECT ANALYSIS')) {
    detectedPhase = 'analyzing';
    progress = 10;
  } else if (log.includes('Copied existing project_index')) {
    detectedPhase = 'analyzing';
    progress = 15;
  } else if (log.includes('Running project analyzer')) {
    detectedPhase = 'analyzing';
    progress = 20;
  } else if (log.includes('project_index.json already exists')) {
    detectedPhase = 'analyzing';
    progress = 22;
  } else if (log.includes('Created project_index')) {
    detectedPhase = 'analyzing';
    progress = 25;
  } else if (log.includes('PROJECT DISCOVERY')) {
    detectedPhase = 'discovering';
    progress = 30;
  } else if (log.includes('Analyzing project')) {
    detectedPhase = 'discovering';
    progress = 35;
  } else if (log.includes('Running discovery agent')) {
    detectedPhase = 'discovering';
    progress = 40;
  } else if (log.includes('Discovery attempt')) {
    detectedPhase = 'discovering';
    progress = 45;
  } else if (
    log.includes('roadmap_discovery.json') &&
    !log.toLowerCase().includes('failed') &&
    !log.toLowerCase().includes('error')
  ) {
    detectedPhase = 'discovering';
    progress = 50;
  } else if (log.includes('FEATURE GENERATION')) {
    detectedPhase = 'generating';
    progress = 55;
  } else if (log.includes('Generating features')) {
    detectedPhase = 'generating';
    progress = 60;
  } else if (log.includes('Features attempt')) {
    detectedPhase = 'generating';
    progress = 65;
  } else if (log.includes('Prioritizing features')) {
    detectedPhase = 'generating';
    progress = 75;
  } else if (log.includes('Creating roadmap file')) {
    detectedPhase = 'generating';
    progress = 85;
  } else if (log.includes('Created valid roadmap')) {
    detectedPhase = 'generating';
    progress = 90;
  } else if (log.includes('ROADMAP GENERATED')) {
    detectedPhase = 'complete';
    progress = 100;
  }

  if (!wouldAutocodeRoadmapPhaseRegress(currentPhase, detectedPhase)) {
    phase = detectedPhase;
  }

  return {
    phase,
    progress: Math.min(100, Math.max(progress, currentProgress)),
  };
}

function wouldAutocodeRoadmapPhaseRegress(current: string, next: string): boolean {
  if (next === 'error') {
    return false;
  }

  const currentOrder = AUTOCODE_ROADMAP_PHASE_ORDER[current] ?? -1;
  const nextOrder = AUTOCODE_ROADMAP_PHASE_ORDER[next] ?? -1;
  return nextOrder < currentOrder;
}
