import {
  type ExecutionPhase,
  isTerminalPhase,
  wouldPhaseRegress,
} from '../tasks/phase-protocol.js';
import type {
  AutocodeStreamEvent,
  AutocodeToolCallEvent,
  AutocodeToolResultEvent,
} from './agent-session-types.js';

export interface AutocodePhaseDetection {
  phase: ExecutionPhase;
  message: string;
  currentSubtask?: string;
  source: 'tool-call' | 'tool-result' | 'text-pattern';
}

export interface AutocodeProgressTrackerState {
  currentPhase: ExecutionPhase;
  currentMessage: string;
  currentSubtask: string | null;
  completedPhases: ExecutionPhase[];
}

const TOOL_FILE_PHASE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  phase: ExecutionPhase;
  message: string;
}> = [
  {
    pattern: /implementation_plan\.md$/,
    phase: 'planning',
    message: 'Creating implementation plan...',
  },
  {
    pattern: /qa_report\.md$/,
    phase: 'qa_review',
    message: 'Writing QA report...',
  },
  {
    pattern: /QA_FIX_REQUEST\.md$/,
    phase: 'qa_fixing',
    message: 'Processing QA fix request...',
  },
];

const TOOL_NAME_PHASE_PATTERNS: ReadonlyArray<{
  toolName: string;
  phase: ExecutionPhase;
  message: string;
}> = [
  {
    toolName: 'update_subtask_status',
    phase: 'coding',
    message: 'Implementing subtask...',
  },
  {
    toolName: 'update_qa_status',
    phase: 'qa_review',
    message: 'Updating QA status...',
  },
];

const TEXT_PHASE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  phase: ExecutionPhase;
  message: string;
}> = [
  { pattern: /qa\s*fix/i, phase: 'qa_fixing', message: 'Fixing QA issues...' },
  { pattern: /fixing\s+issues/i, phase: 'qa_fixing', message: 'Fixing QA issues...' },
  { pattern: /qa\s*review/i, phase: 'qa_review', message: 'Running QA review...' },
  { pattern: /starting\s+qa/i, phase: 'qa_review', message: 'Running QA review...' },
  { pattern: /acceptance\s+criteria/i, phase: 'qa_review', message: 'Checking acceptance criteria...' },
  { pattern: /implementing\s+subtask/i, phase: 'coding', message: 'Implementing code changes...' },
  { pattern: /starting\s+coder/i, phase: 'coding', message: 'Implementing code changes...' },
  { pattern: /coder\s+agent/i, phase: 'coding', message: 'Implementing code changes...' },
  { pattern: /creating\s+implementation\s+plan/i, phase: 'planning', message: 'Creating implementation plan...' },
  { pattern: /planner\s+agent/i, phase: 'planning', message: 'Creating implementation plan...' },
  { pattern: /breaking.*into\s+subtasks/i, phase: 'planning', message: 'Breaking down into subtasks...' },
];

function shouldDetectFilePatternPhase(
  currentPhase: ExecutionPhase,
  detectedPhase: ExecutionPhase,
): boolean {
  if (detectedPhase === 'planning') {
    return currentPhase === 'idle' || currentPhase === 'planning';
  }

  return true;
}

export class AutocodeProgressTracker {
  private _currentPhase: ExecutionPhase = 'idle';
  private _currentMessage = '';
  private _currentSubtask: string | null = null;
  private _completedPhases: ExecutionPhase[] = [];

  get state(): AutocodeProgressTrackerState {
    return {
      currentPhase: this._currentPhase,
      currentMessage: this._currentMessage,
      currentSubtask: this._currentSubtask,
      completedPhases: [...this._completedPhases],
    };
  }

  get currentPhase(): ExecutionPhase {
    return this._currentPhase;
  }

  processEvent(event: AutocodeStreamEvent): AutocodePhaseDetection | null {
    switch (event.type) {
      case 'tool-call':
        return this.processToolCall(event);
      case 'tool-result':
        return this.processToolResult(event);
      case 'text-delta':
        return this.processTextDelta(event.text);
      default:
        return null;
    }
  }

  forcePhase(phase: ExecutionPhase, message: string, subtask?: string): void {
    this.transitionTo(phase, message, subtask);
  }

  reset(): void {
    this._currentPhase = 'idle';
    this._currentMessage = '';
    this._currentSubtask = null;
    this._completedPhases = [];
  }

  private processToolCall(event: AutocodeToolCallEvent): AutocodePhaseDetection | null {
    for (const { toolName, phase, message } of TOOL_NAME_PHASE_PATTERNS) {
      if (event.toolName === toolName || event.toolName.endsWith(toolName)) {
        if (toolName === 'update_subtask_status') {
          const subtaskId = this.extractSubtaskId(event.args);
          if (subtaskId && subtaskId !== this._currentSubtask) {
            this._currentSubtask = subtaskId;
            const msg = `Working on subtask ${subtaskId}...`;
            this._currentMessage = msg;
            return { phase, message: msg, currentSubtask: subtaskId, source: 'tool-call' };
          }
        }
        return this.tryTransition(phase, message, 'tool-call');
      }
    }

    const filePath = this.extractFilePath(event.args);
    if (filePath) {
      for (const { pattern, phase, message } of TOOL_FILE_PHASE_PATTERNS) {
        if (pattern.test(filePath) && shouldDetectFilePatternPhase(this._currentPhase, phase)) {
          return this.tryTransition(phase, message, 'tool-call');
        }
      }
    }

    if (this._currentPhase === 'coding') {
      const subtaskId = this.extractSubtaskId(event.args);
      if (subtaskId && subtaskId !== this._currentSubtask) {
        this._currentSubtask = subtaskId;
        const msg = `Working on subtask ${subtaskId}...`;
        this._currentMessage = msg;
        return { phase: 'coding', message: msg, currentSubtask: subtaskId, source: 'tool-call' };
      }
    }

    return null;
  }

  private processToolResult(event: AutocodeToolResultEvent): AutocodePhaseDetection | null {
    if (
      (event.toolName === 'update_qa_status' || event.toolName.endsWith('update_qa_status')) &&
      !event.isError
    ) {
      const result = event.result;
      if (typeof result === 'object' && result !== null && 'status' in result) {
        const status = (result as Record<string, unknown>).status;
        if (status === 'failed' || status === 'issues_found') {
          return this.tryTransition('qa_fixing', 'QA found issues, fixing...', 'tool-result');
        }
        if (status === 'passed' || status === 'approved') {
          return this.tryTransition('complete', 'Build complete', 'tool-result');
        }
      }
    }

    return null;
  }

  private processTextDelta(text: string): AutocodePhaseDetection | null {
    if (isTerminalPhase(this._currentPhase)) {
      return null;
    }

    if (!text || text.length < 5) {
      return null;
    }

    for (const { pattern, phase, message } of TEXT_PHASE_PATTERNS) {
      if (pattern.test(text)) {
        return this.tryTransition(phase, message, 'text-pattern');
      }
    }

    if (this._currentPhase === 'coding') {
      const subtaskMatch = text.match(/subtask[:\s]+(\d+(?:\/\d+)?|\w+[-_]\w+)/i);
      if (subtaskMatch) {
        const subtaskId = subtaskMatch[1];
        if (subtaskId !== this._currentSubtask) {
          this._currentSubtask = subtaskId;
          const msg = `Working on subtask ${subtaskId}...`;
          this._currentMessage = msg;
          return { phase: 'coding', message: msg, currentSubtask: subtaskId, source: 'text-pattern' };
        }
      }
    }

    return null;
  }

  private tryTransition(
    phase: ExecutionPhase,
    message: string,
    source: AutocodePhaseDetection['source'],
  ): AutocodePhaseDetection | null {
    if (isTerminalPhase(this._currentPhase)) {
      return null;
    }

    if (wouldPhaseRegress(this._currentPhase, phase)) {
      return null;
    }

    if (this._currentPhase === phase && this._currentMessage === message) {
      return null;
    }

    this.transitionTo(phase, message);
    return { phase, message, currentSubtask: this._currentSubtask ?? undefined, source };
  }

  private transitionTo(phase: ExecutionPhase, message: string, subtask?: string): void {
    if (
      this._currentPhase !== 'idle' &&
      this._currentPhase !== phase &&
      !this._completedPhases.includes(this._currentPhase)
    ) {
      this._completedPhases.push(this._currentPhase);
    }

    this._currentPhase = phase;
    this._currentMessage = message;
    if (subtask !== undefined) {
      this._currentSubtask = subtask;
    }
  }

  private extractFilePath(args: Record<string, unknown>): string | null {
    const path = args.file_path ?? args.path ?? args.filePath ?? args.file ?? args.notebook_path;
    return typeof path === 'string' ? path : null;
  }

  private extractSubtaskId(args: Record<string, unknown>): string | null {
    const id = args.subtask_id ?? args.subtaskId;
    return typeof id === 'string' ? id : null;
  }
}

