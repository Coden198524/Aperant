import type {
  AutocodeParseResult,
  AutocodePhaseEventPayload,
  AutocodeValidationError,
  AutocodeValidationResult,
} from '@autocode/core/runtime/agent-events';

export {
  AutocodePhaseEventSchema as PhaseEventSchema,
  isValidAutocodePhasePayload as isValidPhasePayload,
  validateAutocodePhaseEvent as validatePhaseEvent,
} from '@autocode/core/runtime/agent-events';

export type PhaseEventPayload = AutocodePhaseEventPayload;
export type ValidationResult = AutocodeValidationResult<AutocodePhaseEventPayload>;
export type ValidationError = AutocodeValidationError;
export type ParseResult = AutocodeParseResult<AutocodePhaseEventPayload>;
