import type {
  AutocodeSessionError,
  AutocodeSessionOutcome,
} from './agent-session-types.js';

export const AutocodeSessionErrorCode = {
  RATE_LIMITED: 'rate_limited',
  BILLING_ERROR: 'billing_error',
  AUTH_FAILURE: 'auth_failure',
  CONCURRENCY: 'concurrency_error',
  TOOL_ERROR: 'tool_execution_error',
  ABORTED: 'aborted',
  MAX_STEPS: 'max_steps_reached',
  MODEL_NOT_FOUND: 'model_not_found',
  GENERIC: 'generic_error',
} as const;

export type AutocodeSessionErrorCode =
  (typeof AutocodeSessionErrorCode)[keyof typeof AutocodeSessionErrorCode];

const WORD_BOUNDARY_429 = /\b429\b/;
const WORD_BOUNDARY_401 = /\b401\b/;

const BILLING_ERROR_PATTERNS = [
  'insufficient balance',
  'no resource package',
  'please recharge',
  'payment required',
  'credits exhausted',
  'subscription expired',
  'billing error',
  'no_available_channel',
  'distributor.no_available_channel',
] as const;

const RATE_LIMIT_PATTERNS = [
  'limit reached',
  'rate limit',
  'too many requests',
  'usage limit',
  'quota exceeded',
] as const;

const AUTH_PATTERNS = [
  'authentication failed',
  'authentication error',
  'unauthorized',
  'invalid token',
  'token expired',
  'authentication_error',
  'invalid_token',
  'token_expired',
  'not authenticated',
  'http 401',
  'does not have access to claude',
  'please login again',
] as const;

const MODEL_NOT_FOUND_PATTERNS = [
  'model not found',
  'model does not exist',
  'invalid model',
  'unknown model',
  'model_not_found',
  'endpoint not supported',
  'codex channel',
  'items are not persisted when `store` is set to false',
  'cannot post',
  'not found',
  'http 404',
] as const;

export interface AutocodeClassifiedSessionError {
  sessionError: AutocodeSessionError;
  outcome: AutocodeSessionOutcome;
}

export function isAutocodeBillingError(error: unknown): boolean {
  const errorStr = errorToString(error);
  return BILLING_ERROR_PATTERNS.some((pattern) => errorStr.includes(pattern));
}

export function isAutocodeRateLimitError(error: unknown): boolean {
  if (isAutocodeBillingError(error)) return false;
  const statusCode = getHttpStatusCode(error);
  if (statusCode === 429) return true;
  const errorStr = errorToString(error);
  if (WORD_BOUNDARY_429.test(errorStr)) return true;
  return RATE_LIMIT_PATTERNS.some((pattern) => errorStr.includes(pattern));
}

export function isAutocodeAuthenticationError(error: unknown): boolean {
  const statusCode = getHttpStatusCode(error);
  if (statusCode === 401) return true;
  const errorStr = errorToString(error);
  if (WORD_BOUNDARY_401.test(errorStr)) return true;
  return AUTH_PATTERNS.some((pattern) => errorStr.includes(pattern));
}

export function isAutocodeToolConcurrencyError(error: unknown): boolean {
  const errorStr = errorToString(error);
  return /\b400\b/.test(errorStr) &&
    ((errorStr.includes('tool') && errorStr.includes('concurrency')) ||
      errorStr.includes('too many tools') ||
      errorStr.includes('concurrent tool'));
}

export function isAutocodeModelNotFoundError(error: unknown): boolean {
  const statusCode = getHttpStatusCode(error);
  if (statusCode === 404) return true;
  const errorStr = errorToString(error);
  if (/\b404\b/.test(errorStr)) return true;
  return MODEL_NOT_FOUND_PATTERNS.some((pattern) => errorStr.includes(pattern));
}

export function isAutocodeAbortError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (record.name === 'AbortError') return true;
  }
  const errorStr = errorToString(error);
  return errorStr.includes('aborted') || errorStr.includes('abort');
}

export function classifyAutocodeSessionError(error: unknown): AutocodeClassifiedSessionError {
  const message = sanitizeErrorMessage(errorToString(error));

  if (isAutocodeAbortError(error)) {
    return {
      sessionError: {
        code: AutocodeSessionErrorCode.ABORTED,
        message: 'Session was cancelled',
        retryable: false,
        cause: error,
      },
      outcome: 'cancelled',
    };
  }

  if (isAutocodeBillingError(error)) {
    return {
      sessionError: {
        code: AutocodeSessionErrorCode.BILLING_ERROR,
        message: `Billing error: ${message}`,
        retryable: false,
        cause: error,
      },
      outcome: 'error',
    };
  }

  if (isAutocodeRateLimitError(error)) {
    return {
      sessionError: {
        code: AutocodeSessionErrorCode.RATE_LIMITED,
        message: `Rate limit exceeded: ${message}`,
        retryable: true,
        cause: error,
      },
      outcome: 'rate_limited',
    };
  }

  if (isAutocodeAuthenticationError(error)) {
    return {
      sessionError: {
        code: AutocodeSessionErrorCode.AUTH_FAILURE,
        message: `Authentication failed: ${message}`,
        retryable: false,
        cause: error,
      },
      outcome: 'auth_failure',
    };
  }

  if (isAutocodeModelNotFoundError(error)) {
    return {
      sessionError: {
        code: AutocodeSessionErrorCode.MODEL_NOT_FOUND,
        message: `Model not found: ${message}`,
        retryable: true,
        cause: error,
      },
      outcome: 'error',
    };
  }

  if (isAutocodeToolConcurrencyError(error)) {
    return {
      sessionError: {
        code: AutocodeSessionErrorCode.CONCURRENCY,
        message: `Tool concurrency limit: ${message}`,
        retryable: true,
        cause: error,
      },
      outcome: 'error',
    };
  }

  return {
    sessionError: {
      code: AutocodeSessionErrorCode.GENERIC,
      message,
      retryable: false,
      cause: error,
    },
    outcome: 'error',
  };
}

export function classifyAutocodeToolError(
  toolName: string,
  toolCallId: string,
  error: unknown,
): AutocodeSessionError {
  return {
    code: AutocodeSessionErrorCode.TOOL_ERROR,
    message: `Tool '${toolName}' (${toolCallId}) failed: ${sanitizeErrorMessage(errorToString(error))}`,
    retryable: true,
    cause: error,
  };
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return buildErrorText(error.message, error as unknown as Record<string, unknown>).toLowerCase();
  }
  if (typeof error === 'string') return error.toLowerCase();
  if (error && typeof error === 'object') {
    return buildErrorText(undefined, error as Record<string, unknown>).toLowerCase();
  }
  return String(error).toLowerCase();
}

function buildErrorText(primaryMessage: string | undefined, errorObject: Record<string, unknown>): string {
  const parts: string[] = [];
  if (primaryMessage?.trim()) {
    parts.push(primaryMessage.trim());
  }

  const statusCode = getHttpStatusCode(errorObject);
  if (statusCode !== undefined) {
    parts.push(`http ${statusCode}`);
  }

  const maybeCode = safeString(errorObject.code);
  if (maybeCode) parts.push(maybeCode);

  const maybeType = safeString(errorObject.type);
  if (maybeType) parts.push(maybeType);

  const maybeUrl = safeString(errorObject.url);
  if (maybeUrl) parts.push(maybeUrl);

  const responseBody = safeString(errorObject.responseBody);
  if (responseBody) parts.push(responseBody);

  const dataString = serializeUnknown(errorObject.data);
  if (dataString) parts.push(dataString);

  const causeString = serializeUnknown(errorObject.cause);
  if (causeString) parts.push(causeString);

  return parts.length > 0 ? parts.join(' ') : String(errorObject);
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function serializeUnknown(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function getHttpStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;

  const directStatus = e.statusCode ?? e.status;
  if (typeof directStatus === 'number') return directStatus;
  if (typeof directStatus === 'string') {
    const parsed = Number.parseInt(directStatus, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  const response = e.response;
  if (response && typeof response === 'object') {
    const responseStatus = (response as Record<string, unknown>).status;
    if (typeof responseStatus === 'number') return responseStatus;
    if (typeof responseStatus === 'string') {
      const parsed = Number.parseInt(responseStatus, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9-_]{20,}/g, 'sk-***')
    .replace(/Bearer [a-zA-Z0-9\-_.+/=]+/gi, 'Bearer ***')
    .replace(/token[=:]\s*[a-zA-Z0-9\-_.+/=]+/gi, 'token=***');
}

