import type {
  AutocodeSessionError,
  AutocodeSessionOutcome,
} from './agent-session-types.js';

export const AutocodeSessionErrorCode = {
  RATE_LIMITED: 'rate_limited',
  BILLING_ERROR: 'billing_error',
  AUTH_FAILURE: 'auth_failure',
  CONCURRENCY: 'concurrency_error',
  NETWORK_ERROR: 'network_error',
  TEMPORARILY_UNAVAILABLE: 'temporarily_unavailable',
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
const MAX_NESTED_ERROR_DEPTH = 5;
const MAX_RETRY_ERROR_DETAILS = 1;

const REQUEST_ID_FIELDS = [
  'requestId',
  'request_id',
  '_request_id',
] as const;

const REQUEST_ID_HEADERS = new Set([
  'request-id',
  'x-request-id',
  'x-amz-request-id',
  'x-amzn-requestid',
]);

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

const TRANSIENT_NETWORK_PATTERNS = [
  'stream disconnected before completion',
  'error sending request for url',
  'request aborted',
  'failed to connect to websocket',
  'tls handshake eof',
  'socket hang up',
  'connection reset',
  'connection refused',
  'connection timed out',
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'fetch failed',
  'network error',
] as const;

const TEMPORARILY_UNAVAILABLE_PATTERNS = [
  'temporarily unavailable',
  'service unavailable',
  'service_unavailable_error',
  'server_error',
  'bad gateway',
  'gateway timeout',
  'upstream timeout',
  'stream inactivity timeout',
  'provider overloaded',
  'server overloaded',
  'server_is_overloaded',
  'try again later',
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
  const errorStr = normalizedErrorText(error);
  return BILLING_ERROR_PATTERNS.some((pattern) => errorStr.includes(pattern));
}

export function isAutocodeRateLimitError(error: unknown): boolean {
  if (isAutocodeBillingError(error)) return false;
  const statusCode = getHttpStatusCode(error);
  if (statusCode === 429) return true;
  const errorStr = normalizedErrorText(error);
  if (WORD_BOUNDARY_429.test(errorStr)) return true;
  return RATE_LIMIT_PATTERNS.some((pattern) => errorStr.includes(pattern));
}

export function isAutocodeAuthenticationError(error: unknown): boolean {
  const statusCode = getHttpStatusCode(error);
  if (statusCode === 401) return true;
  const errorStr = normalizedErrorText(error);
  if (WORD_BOUNDARY_401.test(errorStr)) return true;
  return AUTH_PATTERNS.some((pattern) => errorStr.includes(pattern));
}

export function isAutocodeToolConcurrencyError(error: unknown): boolean {
  const errorStr = normalizedErrorText(error);
  return /\b400\b/.test(errorStr) &&
    ((errorStr.includes('tool') && errorStr.includes('concurrency')) ||
      errorStr.includes('too many tools') ||
      errorStr.includes('concurrent tool'));
}

export function isAutocodeTransientNetworkError(error: unknown): boolean {
  const errorStr = normalizedErrorText(error);
  return TRANSIENT_NETWORK_PATTERNS.some((pattern) => errorStr.includes(pattern));
}

export function isAutocodeTemporarilyUnavailableError(error: unknown): boolean {
  const statusCode = getHttpStatusCode(error);
  if (
    statusCode === 408 ||
    statusCode === 409 ||
    (statusCode !== undefined && statusCode >= 500)
  ) {
    return true;
  }
  const errorStr = normalizedErrorText(error);
  return TEMPORARILY_UNAVAILABLE_PATTERNS.some((pattern) => errorStr.includes(pattern));
}

export function isAutocodeModelNotFoundError(error: unknown): boolean {
  const statusCode = getHttpStatusCode(error);
  if (statusCode === 404) return true;
  const errorStr = normalizedErrorText(error);
  if (/\b404\b/.test(errorStr)) return true;
  return MODEL_NOT_FOUND_PATTERNS.some((pattern) => errorStr.includes(pattern));
}

export function isAutocodeAbortError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return record.name === 'AbortError' ||
      record.code === 'ABORT_ERR' ||
      record.code === 'ERR_CANCELED';
  }
  // Provider/network failures frequently include words such as "aborted".
  // Treat cancellation as structured state only so those errors are not
  // misreported as an explicit user cancellation.
  return false;
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

  if (isAutocodeTransientNetworkError(error)) {
    return {
      sessionError: {
        code: AutocodeSessionErrorCode.NETWORK_ERROR,
        message: `Network error: ${message}`,
        retryable: true,
        cause: error,
      },
      outcome: 'error',
    };
  }

  if (isAutocodeTemporarilyUnavailableError(error)) {
    return {
      sessionError: {
        code: AutocodeSessionErrorCode.TEMPORARILY_UNAVAILABLE,
        message: `Provider temporarily unavailable: ${message}`,
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
  return errorToDiagnosticText(error, new Set<object>(), 0);
}

function normalizedErrorText(error: unknown): string {
  return errorToString(error).toLowerCase();
}

function errorToDiagnosticText(
  error: unknown,
  seen: Set<object>,
  depth: number,
): string {
  if (typeof error === 'string') return error;
  if (error == null || typeof error !== 'object') return String(error);
  if (seen.has(error)) return '';
  if (depth > MAX_NESTED_ERROR_DEPTH) {
    return serializeUnknown(error) ?? '';
  }
  seen.add(error);
  return buildErrorText(
    error instanceof Error ? error.message : undefined,
    error as Record<string, unknown>,
    seen,
    depth,
  );
}

function appendUnique(parts: string[], value: string | undefined): void {
  const normalized = value?.trim();
  if (normalized && !parts.includes(normalized)) {
    parts.push(normalized);
  }
}

function buildErrorText(
  primaryMessage: string | undefined,
  errorObject: Record<string, unknown>,
  seen: Set<object>,
  depth: number,
): string {
  const parts: string[] = [];
  appendUnique(parts, primaryMessage);

  const structuredMessage = safeString(errorObject.message);
  appendUnique(parts, structuredMessage);

  const statusCode = getHttpStatusCode(errorObject);
  if (statusCode !== undefined) {
    appendUnique(parts, `http ${statusCode}`);
  }

  const maybeCode = safeString(errorObject.code);
  appendUnique(parts, maybeCode);

  const maybeType = safeString(errorObject.type);
  appendUnique(parts, maybeType);

  const maybeUrl = safeString(errorObject.url);
  appendUnique(parts, maybeUrl);

  for (const requestId of requestIds(errorObject)) {
    appendUnique(parts, `request-id: ${requestId}`);
  }

  const responseBody = safeString(errorObject.responseBody);
  appendUnique(parts, responseBody);

  const dataString = serializeUnknown(errorObject.data);
  appendUnique(parts, dataString);

  appendUnique(
    parts,
    nestedErrorText(errorObject.error, seen, depth + 1),
  );

  appendUnique(
    parts,
    nestedErrorText(errorObject.cause, seen, depth + 1),
  );

  appendUnique(
    parts,
    nestedErrorText(errorObject.lastError, seen, depth + 1),
  );

  if (Array.isArray(errorObject.errors)) {
    for (
      let index = errorObject.errors.length - 1, included = 0;
      index >= 0 && included < MAX_RETRY_ERROR_DETAILS;
      index--
    ) {
      const detail = nestedErrorText(errorObject.errors[index], seen, depth + 1);
      if (detail) {
        appendUnique(parts, detail);
        included++;
      }
    }
  }

  return parts.length > 0 ? parts.join(' ') : String(errorObject);
}

function nestedErrorText(
  value: unknown,
  seen: Set<object>,
  depth: number,
): string | undefined {
  if (value == null) return undefined;
  const text = errorToDiagnosticText(value, seen, depth).trim();
  return text || undefined;
}

function requestIds(errorObject: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const field of REQUEST_ID_FIELDS) {
    const value = safeDiagnosticIdentifier(errorObject[field]);
    if (value) ids.add(value);
  }

  collectRequestIdsFromHeaders(errorObject.responseHeaders, ids);
  const response = errorObject.response;
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    collectRequestIdsFromHeaders(
      (response as Record<string, unknown>).headers,
      ids,
    );
  }
  return [...ids];
}

function collectRequestIdsFromHeaders(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    value.forEach((rawValue, name) => {
      if (!REQUEST_ID_HEADERS.has(name.toLowerCase())) return;
      const requestId = safeDiagnosticIdentifier(rawValue);
      if (requestId) ids.add(requestId);
    });
    return;
  }
  for (const [name, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (!REQUEST_ID_HEADERS.has(name.toLowerCase())) continue;
    const requestId = safeDiagnosticIdentifier(rawValue);
    if (requestId) ids.add(requestId);
  }
}

function safeDiagnosticIdentifier(value: unknown): string | undefined {
  const identifier = safeString(value);
  if (!identifier) return undefined;
  return identifier.slice(0, 512);
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

function getHttpStatusCode(
  error: unknown,
  seen = new Set<object>(),
  depth = 0,
): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if (seen.has(error) || depth > MAX_NESTED_ERROR_DEPTH) return undefined;
  seen.add(error);
  const e = error as Record<string, unknown>;

  const directStatus = parseHttpStatusCode(e.statusCode ?? e.status);
  if (directStatus !== undefined) return directStatus;

  const response = e.response;
  if (response && typeof response === 'object') {
    const responseStatus = parseHttpStatusCode(
      (response as Record<string, unknown>).status,
    );
    if (responseStatus !== undefined) return responseStatus;
  }

  const nestedCandidates = [
    e.lastError,
    e.cause,
    e.error,
    ...(Array.isArray(e.errors) && e.errors.length > 0
      ? [e.errors[e.errors.length - 1]]
      : []),
  ];
  for (const candidate of nestedCandidates) {
    const nestedStatus = getHttpStatusCode(candidate, seen, depth + 1);
    if (nestedStatus !== undefined) return nestedStatus;
  }

  return undefined;
}

function parseHttpStatusCode(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{3}$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599
    ? parsed
    : undefined;
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9-_]{20,}/g, 'sk-***')
    .replace(/Bearer [a-zA-Z0-9\-_.+/=]+/gi, 'Bearer ***')
    .replace(/token[=:]\s*[a-zA-Z0-9\-_.+/=]+/gi, 'token=***');
}

