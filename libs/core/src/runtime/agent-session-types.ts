export type AutocodeSessionMessageRole = 'user' | 'assistant';

export interface AutocodeSessionMessage {
  role: AutocodeSessionMessageRole;
  content: string;
}

export type AutocodeSessionOutcome =
  | 'completed'
  | 'error'
  | 'rate_limited'
  | 'auth_failure'
  | 'cancelled'
  | 'max_steps'
  | 'context_window';

export interface AutocodeSessionResult {
  outcome: AutocodeSessionOutcome;
  stepsExecuted: number;
  usage: AutocodeTokenUsage;
  error?: AutocodeSessionError;
  messages: AutocodeSessionMessage[];
  durationMs: number;
  toolCallCount: number;
  completedSubtaskIds?: string[];
  structuredOutput?: Record<string, unknown>;
}

export interface AutocodeTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  stepsExecuted?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  estimated?: boolean;
  sessionId?: string;
}

export interface AutocodeSessionError {
  code: string;
  message: string;
  retryable: boolean;
  cause?: unknown;
}

export type AutocodeStreamEvent =
  | AutocodeTextDeltaEvent
  | AutocodeThinkingDeltaEvent
  | AutocodeToolCallEvent
  | AutocodeToolResultEvent
  | AutocodeStepFinishEvent
  | AutocodeErrorEvent
  | AutocodeUsageUpdateEvent;

export interface AutocodeTextDeltaEvent {
  type: 'text-delta';
  text: string;
}

export interface AutocodeThinkingDeltaEvent {
  type: 'thinking-delta';
  text: string;
}

export interface AutocodeToolCallEvent {
  type: 'tool-call';
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

export interface AutocodeToolResultEvent {
  type: 'tool-result';
  toolName: string;
  toolCallId: string;
  result: unknown;
  durationMs: number;
  isError: boolean;
}

export interface AutocodeStepFinishEvent {
  type: 'step-finish';
  stepNumber: number;
  usage: AutocodeTokenUsage;
}

export interface AutocodeErrorEvent {
  type: 'error';
  error: AutocodeSessionError;
}

export interface AutocodeUsageUpdateEvent {
  type: 'usage-update';
  usage: AutocodeTokenUsage;
}

export interface AutocodeProgressState {
  currentSubtaskId: string | null;
  totalSubtasks: number;
  completedSubtasks: number;
  inProgressSubtasks: number;
  isBuildComplete: boolean;
  stuckSubtasks: string[];
}

export type AutocodeSessionEventCallback = (event: AutocodeStreamEvent) => void;

