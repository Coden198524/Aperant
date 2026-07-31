import { describe, it, expect } from 'vitest';

import {
  isBillingError,
  isRateLimitError,
  isAuthenticationError,
  isToolConcurrencyError,
  isAbortError,
  classifyError,
  classifyToolError,
  ErrorCode,
} from '../error-classifier';

// =============================================================================
// isBillingError
// =============================================================================

describe('isBillingError', () => {
  it('should detect Z.AI insufficient balance error', () => {
    expect(isBillingError('Insufficient balance or no resource package. Please recharge.')).toBe(true);
  });

  it('should detect individual billing patterns', () => {
    expect(isBillingError('insufficient balance')).toBe(true);
    expect(isBillingError('no resource package')).toBe(true);
    expect(isBillingError('please recharge your account')).toBe(true);
    expect(isBillingError('payment required')).toBe(true);
    expect(isBillingError('credits exhausted')).toBe(true);
    expect(isBillingError('subscription expired')).toBe(true);
  });

  it('should not match rate limit messages that mention billing period', () => {
    expect(isBillingError('limit reached for this billing period')).toBe(false);
  });

  it('should not match unrelated errors', () => {
    expect(isBillingError('rate limit exceeded')).toBe(false);
    expect(isBillingError('connection refused')).toBe(false);
  });
});

// =============================================================================
// isRateLimitError
// =============================================================================

describe('isRateLimitError', () => {
  it('should detect HTTP 429', () => {
    expect(isRateLimitError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  it('should detect rate limit keywords', () => {
    expect(isRateLimitError('rate limit exceeded')).toBe(true);
    expect(isRateLimitError('too many requests')).toBe(true);
    expect(isRateLimitError('usage limit reached')).toBe(true);
    expect(isRateLimitError('quota exceeded')).toBe(true);
    expect(isRateLimitError('limit reached for this billing period')).toBe(true);
  });

  it('should not match billing errors that use 429', () => {
    expect(isRateLimitError('429 Insufficient balance or no resource package')).toBe(false);
    expect(isRateLimitError('429 please recharge')).toBe(false);
  });

  it('should not match non-rate-limit errors', () => {
    expect(isRateLimitError('connection refused')).toBe(false);
    expect(isRateLimitError(new Error('timeout'))).toBe(false);
  });

  it('should detect 429 from structured API errors', () => {
    const err = Object.assign(new Error('openai_error'), { statusCode: 429 });
    expect(isRateLimitError(err)).toBe(true);
  });

  it('should not match 429 embedded in other numbers', () => {
    // \b429\b should not match 4290 or 1429
    expect(isRateLimitError('error code 4290')).toBe(false);
  });
});

// =============================================================================
// isAuthenticationError
// =============================================================================

describe('isAuthenticationError', () => {
  it('should detect HTTP 401', () => {
    expect(isAuthenticationError(new Error('HTTP 401 Unauthorized'))).toBe(true);
  });

  it('should detect auth keywords', () => {
    expect(isAuthenticationError('authentication failed')).toBe(true);
    expect(isAuthenticationError('unauthorized access')).toBe(true);
    expect(isAuthenticationError('invalid token provided')).toBe(true);
    expect(isAuthenticationError('token expired')).toBe(true);
    expect(isAuthenticationError('authentication_error')).toBe(true);
    expect(isAuthenticationError('does not have access to claude')).toBe(true);
    expect(isAuthenticationError('please login again')).toBe(true);
  });

  it('should not match non-auth errors', () => {
    expect(isAuthenticationError('connection timeout')).toBe(false);
  });

  it('should detect 401 from structured API errors', () => {
    const err = Object.assign(new Error('openai_error'), { statusCode: 401 });
    expect(isAuthenticationError(err)).toBe(true);
  });
});

// =============================================================================
// isToolConcurrencyError
// =============================================================================

describe('isToolConcurrencyError', () => {
  it('should detect 400 + tool concurrency', () => {
    expect(isToolConcurrencyError('400 tool concurrency limit')).toBe(true);
    expect(isToolConcurrencyError('400 too many tools running')).toBe(true);
    expect(isToolConcurrencyError('400 concurrent tool limit')).toBe(true);
  });

  it('should not match 400 without concurrency keywords', () => {
    expect(isToolConcurrencyError('400 bad request')).toBe(false);
  });

  it('should not match concurrency without 400', () => {
    expect(isToolConcurrencyError('tool concurrency limit')).toBe(false);
  });
});

// =============================================================================
// isAbortError
// =============================================================================

describe('isAbortError', () => {
  it('should detect DOMException AbortError', () => {
    const err = new DOMException('The operation was aborted', 'AbortError');
    expect(isAbortError(err)).toBe(true);
  });

  it('should not confuse provider abort text with user cancellation', () => {
    expect(isAbortError('upstream request aborted')).toBe(false);
    const result = classifyError(new Error('upstream request aborted'));
    expect(result.sessionError.code).toBe(ErrorCode.NETWORK_ERROR);
    expect(result.outcome).toBe('error');
    expect(result.sessionError.retryable).toBe(true);
  });

  it('should not match unrelated errors', () => {
    expect(isAbortError('timeout')).toBe(false);
  });
});

// =============================================================================
// classifyError
// =============================================================================

describe('classifyError', () => {
  it('should classify abort errors with cancelled outcome', () => {
    const err = new DOMException('aborted', 'AbortError');
    const result = classifyError(err);
    expect(result.sessionError.code).toBe(ErrorCode.ABORTED);
    expect(result.outcome).toBe('cancelled');
    expect(result.sessionError.retryable).toBe(false);
  });

  it('should classify billing errors as non-retryable', () => {
    const result = classifyError(new Error('429 Insufficient balance or no resource package'));
    expect(result.sessionError.code).toBe(ErrorCode.BILLING_ERROR);
    expect(result.outcome).toBe('error');
    expect(result.sessionError.retryable).toBe(false);
  });

  it('should classify 429 as rate_limited', () => {
    const result = classifyError(new Error('429 rate limit'));
    expect(result.sessionError.code).toBe(ErrorCode.RATE_LIMITED);
    expect(result.outcome).toBe('rate_limited');
    expect(result.sessionError.retryable).toBe(true);
  });

  it('should classify 401 as auth_failure', () => {
    const result = classifyError(new Error('401 unauthorized'));
    expect(result.sessionError.code).toBe(ErrorCode.AUTH_FAILURE);
    expect(result.outcome).toBe('auth_failure');
    expect(result.sessionError.retryable).toBe(false);
  });

  it('should classify endpoint mismatch errors as model_not_found', () => {
    const result = classifyError(new Error('codex channel: /v1/chat/completions endpoint not supported'));
    expect(result.sessionError.code).toBe(ErrorCode.MODEL_NOT_FOUND);
    expect(result.outcome).toBe('error');
    expect(result.sessionError.retryable).toBe(true);
  });

  it('should classify structured 404 API errors as model_not_found', () => {
    const err = Object.assign(new Error('openai_error'), {
      statusCode: 404,
      responseBody: '{"error":{"message":"openai_error","code":"bad_response_status_code"}}',
      data: {
        error: {
          message: 'openai_error',
          type: 'bad_response_status_code',
          code: 'bad_response_status_code',
        },
      },
    });
    const result = classifyError(err);
    expect(result.sessionError.code).toBe(ErrorCode.MODEL_NOT_FOUND);
    expect(result.outcome).toBe('error');
    expect(result.sessionError.retryable).toBe(true);
    expect(result.sessionError.message).toContain('http 404');
  });

  it('should classify 400 concurrency as retryable error', () => {
    const result = classifyError(new Error('400 tool concurrency exceeded'));
    expect(result.sessionError.code).toBe(ErrorCode.CONCURRENCY);
    expect(result.outcome).toBe('error');
    expect(result.sessionError.retryable).toBe(true);
  });


  it('should classify transient network failures as retryable errors', () => {
    const disconnected = classifyError(new Error('stream disconnected before completion: error sending request for url'));
    expect(disconnected.sessionError.code).toBe(ErrorCode.NETWORK_ERROR);
    expect(disconnected.outcome).toBe('error');
    expect(disconnected.sessionError.retryable).toBe(true);

    const websocket = classifyError(new Error('failed to connect to websocket: IO error: tls handshake eof'));
    expect(websocket.sessionError.code).toBe(ErrorCode.NETWORK_ERROR);
    expect(websocket.sessionError.retryable).toBe(true);
  });

  it('should classify provider availability failures as retryable errors', () => {
    const unavailable = classifyError(Object.assign(new Error('service unavailable'), { statusCode: 503 }));
    expect(unavailable.sessionError.code).toBe(ErrorCode.TEMPORARILY_UNAVAILABLE);
    expect(unavailable.outcome).toBe('error');
    expect(unavailable.sessionError.retryable).toBe(true);

    const inactivityTimeout = classifyError(new Error(
      'Stream inactivity timeout - no data received from provider for 120s',
    ));
    expect(inactivityTimeout.sessionError.code).toBe(ErrorCode.TEMPORARILY_UNAVAILABLE);
    expect(inactivityTimeout.outcome).toBe('error');
    expect(inactivityTimeout.sessionError.retryable).toBe(true);
  });

  it.each([408, 409, 500, 529])(
    'should classify retryable provider HTTP %s failures as temporarily unavailable',
    (statusCode) => {
      const unavailable = classifyError(Object.assign(
        new Error(`Provider Failure at HTTP ${statusCode}`),
        { statusCode },
      ));

      expect(unavailable.sessionError.code).toBe(ErrorCode.TEMPORARILY_UNAVAILABLE);
      expect(unavailable.outcome).toBe('error');
      expect(unavailable.sessionError.retryable).toBe(true);
      expect(unavailable.sessionError.message).toContain(`Provider Failure at HTTP ${statusCode}`);
      expect(unavailable.sessionError.message).toContain(`http ${statusCode}`);
    },
  );

  it('matches availability patterns case-insensitively while preserving display text', () => {
    const unavailable = classifyError(new Error(
      'Service Unavailable From ExampleProvider; Try Again Later.',
    ));

    expect(unavailable.sessionError.code).toBe(ErrorCode.TEMPORARILY_UNAVAILABLE);
    expect(unavailable.sessionError.message).toContain(
      'Service Unavailable From ExampleProvider; Try Again Later.',
    );
  });

  it('should classify structured OpenAI server overload stream errors', () => {
    const overloaded = classifyError({
      type: 'service_unavailable_error',
      code: 'server_is_overloaded',
      message: 'Our servers are currently overloaded. Please try again later.',
      param: null,
    });

    expect(overloaded.sessionError.code).toBe(ErrorCode.TEMPORARILY_UNAVAILABLE);
    expect(overloaded.outcome).toBe('error');
    expect(overloaded.sessionError.retryable).toBe(true);
    expect(overloaded.sessionError.message).toContain('Our servers are currently overloaded');
  });

  it('preserves request IDs from API error fields and safe response headers', () => {
    const unavailable = classifyError(Object.assign(
      new Error('Upstream Failed'),
      {
        statusCode: 500,
        requestId: 'req_top_level',
        responseHeaders: {
          'x-request-id': 'req_header',
          authorization: 'Bearer must-not-be-copied',
        },
      },
    ));

    expect(unavailable.sessionError.code).toBe(ErrorCode.TEMPORARILY_UNAVAILABLE);
    expect(unavailable.sessionError.message).toContain('request-id: req_top_level');
    expect(unavailable.sessionError.message).toContain('request-id: req_header');
    expect(unavailable.sessionError.message).not.toContain('must-not-be-copied');
  });

  it('preserves request IDs from a native Headers instance', () => {
    const unavailable = classifyError(Object.assign(
      new Error('Upstream Failed'),
      {
        statusCode: 500,
        response: {
          headers: new Headers({
            'x-request-id': 'req_native_headers',
            authorization: 'Bearer must-not-be-copied',
          }),
        },
      },
    ));

    expect(unavailable.sessionError.message).toContain(
      'request-id: req_native_headers',
    );
    expect(unavailable.sessionError.message).not.toContain(
      'must-not-be-copied',
    );
  });

  it('rejects malformed status strings instead of partially parsing them', () => {
    const malformed = classifyError(Object.assign(
      new Error('Invalid Request'),
      { statusCode: '500oops' },
    ));

    expect(malformed.sessionError.code).toBe(ErrorCode.GENERIC);
    expect(malformed.sessionError.message).not.toContain('http 500');
  });

  it('unwraps RetryError lastError diagnostics without losing response details', () => {
    const finalError = Object.assign(
      new Error('Anthropic Overloaded'),
      {
        statusCode: 529,
        responseBody:
          '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        responseHeaders: {
          'request-id': 'req_retry_final',
        },
      },
    );
    const retryError = Object.assign(
      new Error('Failed after 3 attempts'),
      {
        lastError: finalError,
        errors: [
          Object.assign(new Error('Earlier Failure'), { statusCode: 500 }),
          finalError,
        ],
      },
    );

    const result = classifyError(retryError);

    expect(result.sessionError.code).toBe(ErrorCode.TEMPORARILY_UNAVAILABLE);
    expect(result.sessionError.message).toContain('Failed after 3 attempts');
    expect(result.sessionError.message).toContain('Anthropic Overloaded');
    expect(result.sessionError.message).toContain('http 529');
    expect(result.sessionError.message).toContain('overloaded_error');
    expect(result.sessionError.message).toContain('request-id: req_retry_final');
  });

  it('uses the newest RetryError errors entry when lastError is unavailable', () => {
    const retryError = Object.assign(
      new Error('Retries Exhausted'),
      {
        errors: [
          Object.assign(new Error('First Attempt Failed'), { statusCode: 400 }),
          Object.assign(new Error('Final Attempt Failed'), {
            statusCode: 500,
            request_id: 'req_errors_final',
          }),
        ],
      },
    );

    const result = classifyError(retryError);

    expect(result.sessionError.code).toBe(ErrorCode.TEMPORARILY_UNAVAILABLE);
    expect(result.sessionError.message).toContain('Final Attempt Failed');
    expect(result.sessionError.message).toContain('http 500');
    expect(result.sessionError.message).toContain('request-id: req_errors_final');
  });

  it('does not classify a final non-retryable RetryError entry from an older transient attempt', () => {
    const retryError = Object.assign(
      new Error('Retries Exhausted'),
      {
        errors: [
          Object.assign(new Error('Service Unavailable'), { statusCode: 503 }),
          Object.assign(new Error('Invalid Request'), { statusCode: 400 }),
        ],
      },
    );

    const result = classifyError(retryError);

    expect(result.sessionError.code).toBe(ErrorCode.GENERIC);
    expect(result.sessionError.message).toContain('Invalid Request');
    expect(result.sessionError.message).not.toContain('Service Unavailable');
  });

  it('should classify structured OpenAI server errors and preserve the request ID', () => {
    const serverError = classifyError({
      type: 'server_error',
      code: 'server_error',
      message:
        'An error occurred while processing your request. You can retry your request, ' +
        'or contact us through our help center at help.openai.com if the error persists. ' +
        'Please include the request ID a473a81e-ad50-4e7c-b793-b9cdb347f96c in your message.',
      param: null,
    });

    expect(serverError.sessionError.code).toBe(ErrorCode.TEMPORARILY_UNAVAILABLE);
    expect(serverError.outcome).toBe('error');
    expect(serverError.sessionError.retryable).toBe(true);
    expect(serverError.sessionError.message).toContain(
      'a473a81e-ad50-4e7c-b793-b9cdb347f96c',
    );
  });

  it('should classify unknown errors as generic', () => {
    const result = classifyError(new Error('something went wrong'));
    expect(result.sessionError.code).toBe(ErrorCode.GENERIC);
    expect(result.outcome).toBe('error');
    expect(result.sessionError.retryable).toBe(false);
  });

  it('should prioritize abort over rate limit', () => {
    // An error message that matches both abort and rate limit
    const err = new DOMException('aborted 429', 'AbortError');
    const result = classifyError(err);
    expect(result.sessionError.code).toBe(ErrorCode.ABORTED);
  });

  it('should sanitize API keys from error messages', () => {
    const result = classifyError(new Error('failed with key sk-ant-abc123456789012345678'));
    expect(result.sessionError.message).not.toContain('sk-ant-abc123456789012345678');
    expect(result.sessionError.message).toContain('sk-***');
  });

  it('should sanitize Bearer tokens from error messages', () => {
    const result = classifyError(new Error('Bearer eyJhbGciOiJIUzI1NiJ9.test'));
    expect(result.sessionError.message).toContain('Bearer ***');
  });

  it('should sanitize token= values from error messages', () => {
    const result = classifyError(new Error('token=secret123abc'));
    expect(result.sessionError.message).toContain('token=***');
  });

  it('should preserve cause in error', () => {
    const original = new Error('test');
    const result = classifyError(original);
    expect(result.sessionError.cause).toBe(original);
  });
});

// =============================================================================
// classifyToolError
// =============================================================================

describe('classifyToolError', () => {
  it('should create tool error with correct code', () => {
    const result = classifyToolError('Bash', 'call-1', 'command not found');
    expect(result.code).toBe(ErrorCode.TOOL_ERROR);
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("Tool 'Bash'");
    expect(result.message).toContain('call-1');
  });

  it('should sanitize tool error messages', () => {
    const result = classifyToolError('Bash', 'c1', 'failed with sk-ant-secret1234567890abcdef');
    expect(result.message).not.toContain('secret');
    expect(result.message).toContain('sk-***');
  });
});
