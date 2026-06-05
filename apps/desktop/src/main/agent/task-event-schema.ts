import type {
  AutocodeParseResult,
  AutocodeTaskEventPayload,
  AutocodeValidationError,
  AutocodeValidationResult,
} from '@autocode/core/runtime/agent-events';

export {
  AutocodeTaskEventSchema as TaskEventSchema,
  validateAutocodeTaskEvent as validateTaskEvent,
} from '@autocode/core/runtime/agent-events';

export type TaskEventPayload = AutocodeTaskEventPayload;
export type ValidationResult = AutocodeValidationResult<AutocodeTaskEventPayload>;
export type ValidationError = AutocodeValidationError;
export type ParseResult = AutocodeParseResult<AutocodeTaskEventPayload>;
