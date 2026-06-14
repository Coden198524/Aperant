import { describe, expect, it } from 'vitest';
import { extractOAuthErrorMessage, readOAuthErrorMessage } from './oauth-error';

describe('oauth-error', () => {
  it('extracts nested OAuth error objects without stringifying to [object Object]', () => {
    const message = extractOAuthErrorMessage(
      {
        error: {
          message: 'Authorization code is invalid or expired',
          type: 'invalid_grant',
        },
      },
      'HTTP 400',
    );

    expect(message).toBe('Authorization code is invalid or expired');
  });

  it('falls back to readable JSON when no known message field exists', () => {
    const message = extractOAuthErrorMessage(
      {
        error: {
          reason: 'missing verifier',
        },
      },
      'HTTP 400',
    );

    expect(message).toBe('{"error":{"reason":"missing verifier"}}');
  });

  it('includes HTTP status when reading JSON response errors', async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          message: 'Invalid authorization code',
        },
      }),
      {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'content-type': 'application/json' },
      },
    );

    await expect(readOAuthErrorMessage(response)).resolves.toBe(
      'HTTP 400 Bad Request: Invalid authorization code',
    );
  });

  it('keeps text response errors readable', async () => {
    const response = new Response('upstream auth unavailable', {
      status: 502,
      statusText: 'Bad Gateway',
    });

    await expect(readOAuthErrorMessage(response)).resolves.toBe(
      'HTTP 502 Bad Gateway: upstream auth unavailable',
    );
  });
});
