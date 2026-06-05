import {
  createAutocodeStreamHandler,
  type AutocodeErrorPart,
  type AutocodeFinishStepPart,
  type AutocodeFullStreamPart,
  type AutocodeReasoningDeltaPart,
  type AutocodeStreamHandler,
  type AutocodeTextDeltaPart,
  type AutocodeToolCallPart,
  type AutocodeToolErrorPart,
  type AutocodeToolResultPart,
} from '@autocode/core/runtime/agent-stream-handler';
import { debugLog } from '../../../shared/utils/debug-logger';

export type TextDeltaPart = AutocodeTextDeltaPart;
export type ReasoningDeltaPart = AutocodeReasoningDeltaPart;
export type ToolCallPart = AutocodeToolCallPart;
export type ToolResultPart = AutocodeToolResultPart;
export type ToolErrorPart = AutocodeToolErrorPart;
export type FinishStepPart = AutocodeFinishStepPart;
export type ErrorPart = AutocodeErrorPart;
export type FullStreamPart = AutocodeFullStreamPart;
export type StreamHandler = AutocodeStreamHandler;

export function createStreamHandler(
  ...args: Parameters<typeof createAutocodeStreamHandler>
): AutocodeStreamHandler {
  const [onEvent, sessionId, options] = args;
  return createAutocodeStreamHandler(onEvent, sessionId, {
    ...options,
    debug: options?.debug ?? (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development'),
    logger: {
      debug: debugLog,
      warn: console.warn,
      error: console.error,
      ...options?.logger,
    },
  });
}
