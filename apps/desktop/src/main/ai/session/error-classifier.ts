import {
  AutocodeSessionErrorCode,
  classifyAutocodeSessionError as classifyError,
  classifyAutocodeToolError as classifyToolError,
  isAutocodeAbortError as isAbortError,
  isAutocodeAuthenticationError as isAuthenticationError,
  isAutocodeBillingError as isBillingError,
  isAutocodeModelNotFoundError as isModelNotFoundError,
  isAutocodeRateLimitError as isRateLimitError,
  isAutocodeToolConcurrencyError as isToolConcurrencyError,
} from '@autocode/core/runtime/agent-error-classifier';
import type {
  AutocodeClassifiedSessionError,
  AutocodeSessionErrorCode as AutocodeSessionErrorCodeType,
} from '@autocode/core/runtime/agent-error-classifier';

export const ErrorCode = AutocodeSessionErrorCode;
export type ErrorCode = AutocodeSessionErrorCodeType;
export type ClassifiedError = AutocodeClassifiedSessionError;

export {
  classifyError,
  classifyToolError,
  isAbortError,
  isAuthenticationError,
  isBillingError,
  isModelNotFoundError,
  isRateLimitError,
  isToolConcurrencyError,
};
