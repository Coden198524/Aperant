import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateText, stepCountIs, tool } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';

import { SupportedProvider } from '@autocode/core';
import { createProvider } from './factory';
import {
  CODEX_RESPONSES_ENDPOINT,
  createCodexOAuthFetch,
  ensureValidCodexOAuthCredentials,
  normalizeCodexResponsesPayload,
} from './codex-oauth-fetch';

function createAccessToken(accountId?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    ...(accountId
      ? {
          'https://api.openai.com/auth': {
            chatgpt_account_id: accountId,
          },
        }
      : {}),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function createResponsesResult(
  id: string,
  output: Array<Record<string, unknown>>,
): Response {
  return new Response(JSON.stringify({
    id,
    created_at: 1_756_000_000,
    model: 'gpt-5.6-sol',
    output,
    service_tier: 'default',
    incomplete_details: null,
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 1 },
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Codex OAuth fetch transport', () => {
  let tempDir: string;
  let tokenFilePath: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocode-codex-oauth-'));
    tokenFilePath = path.join(tempDir, 'codex-auth.json');
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('adds native Codex account headers and normalizes the Responses body', async () => {
    const accessToken = createAccessToken('acct_test_123');
    fs.writeFileSync(tokenFilePath, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const input = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'create the change' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'Bash',
        arguments: '{"command":"openspec status"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'ready',
      },
    ];
    const diagnostics: Array<Record<string, unknown>> = [];
    const codexFetch = createCodexOAuthFetch(tokenFilePath, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await codexFetch(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer placeholder',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        input,
        tools: [{ type: 'function', name: 'Bash', parameters: { type: 'object' } }],
        instructions: 'OpenSpec prompt',
        max_output_tokens: 32000,
        metadata: { unsupported: true },
        store: true,
        stream: true,
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toBe(CODEX_RESPONSES_ENDPOINT);
    const headers = new Headers(requestInit.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(headers.get('chatgpt-account-id')).toBe('acct_test_123');
    expect(headers.get('originator')).toBe('autocode');
    expect(headers.has('content-length')).toBe(false);

    const body = JSON.parse(String(requestInit.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-5.6-sol',
      input,
      instructions: 'OpenSpec prompt',
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
    });
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('metadata');
    expect(diagnostics).toEqual([{
      phase: 'response',
      endpoint: CODEX_RESPONSES_ENDPOINT,
      status: 200,
      statusText: null,
      requestId: null,
      model: 'gpt-5.6-sol',
      requestFields: [
        'include',
        'input',
        'instructions',
        'model',
        'store',
        'stream',
        'tools',
      ],
      inputItemTypes: ['message', 'function_call', 'function_call_output'],
      toolCount: 1,
    }]);
  });

  it('logs a safe non-2xx diagnostic without exposing credentials or request values', async () => {
    const accessToken = createAccessToken('acct_test_123');
    fs.writeFileSync(tokenFilePath, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));
    const fetchMock = vi.fn(async () => new Response('provider body must not be logged', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'req_safe_503',
      },
    }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const diagnostics: Array<Record<string, unknown>> = [];

    const response = await createCodexOAuthFetch(tokenFilePath, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: 'Bearer request-secret' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'SECRET_PROMPT_SENTINEL' }],
        }],
        instructions: 'SECRET_INSTRUCTIONS_SENTINEL',
        tools: [{
          type: 'function',
          name: 'SECRET_TOOL_NAME',
          description: 'SECRET_TOOL_DESCRIPTION',
        }],
        stream: true,
      }),
    });

    expect(response.status).toBe(503);
    expect(diagnostics).toEqual([{
      phase: 'response',
      endpoint: CODEX_RESPONSES_ENDPOINT,
      status: 503,
      statusText: 'Service Unavailable',
      requestId: 'req_safe_503',
      model: 'gpt-5.6-sol',
      requestFields: [
        'include',
        'input',
        'instructions',
        'model',
        'store',
        'stream',
        'tools',
      ],
      inputItemTypes: ['message'],
      toolCount: 1,
    }]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const serializedLog = JSON.stringify(warnSpy.mock.calls);
    expect(serializedLog).toContain('req_safe_503');
    expect(serializedLog).not.toContain(accessToken);
    expect(serializedLog).not.toContain('request-secret');
    expect(serializedLog).not.toContain('SECRET_PROMPT_SENTINEL');
    expect(serializedLog).not.toContain('SECRET_INSTRUCTIONS_SENTINEL');
    expect(serializedLog).not.toContain('SECRET_TOOL_NAME');
    expect(serializedLog).not.toContain('provider body must not be logged');
  });

  it('correlates a successful Responses stream error with its HTTP request id', async () => {
    fs.writeFileSync(tokenFilePath, JSON.stringify({
      access_token: createAccessToken('acct_stream_test'),
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));
    const sse = [
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'event: error\n',
      'data: {"type":"error","error":{"type":"service_unavailable_error",',
      '"code":"server_is_overloaded","message":"SECRET_PROVIDER_MESSAGE"}}\n\n',
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of sse) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'x-request-id': 'req_stream_200',
      },
    }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const diagnostics: Array<Record<string, unknown>> = [];

    const response = await createCodexOAuthFetch(tokenFilePath, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        input: [],
        tools: [],
        stream: true,
      }),
    });

    expect(await response.text()).toBe(sse.join(''));
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      phase: 'response',
      status: 200,
      requestId: 'req_stream_200',
    });
    expect(diagnostics[1]).toMatchObject({
      phase: 'stream_error',
      status: 200,
      requestId: 'req_stream_200',
      streamEventType: 'error',
      errorType: 'service_unavailable_error',
      errorCode: 'server_is_overloaded',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const serializedLog = JSON.stringify(warnSpy.mock.calls);
    expect(serializedLog).toContain('req_stream_200');
    expect(serializedLog).toContain('server_is_overloaded');
    expect(serializedLog).not.toContain('SECRET_PROVIDER_MESSAGE');
  });

  it('preserves an account id while rotating an expired access token', async () => {
    fs.writeFileSync(tokenFilePath, JSON.stringify({
      access_token: 'expired-opaque-token',
      refresh_token: 'refresh-old',
      expires_at: Date.now() - 1000,
      account_id: 'acct_persisted',
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'refreshed-opaque-token',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await createCodexOAuthFetch(tokenFilePath)(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        input: [],
        store: false,
        stream: true,
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, requestInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const headers = new Headers(requestInit.headers);
    expect(headers.get('authorization')).toBe('Bearer refreshed-opaque-token');
    expect(headers.get('chatgpt-account-id')).toBe('acct_persisted');

    const stored = JSON.parse(fs.readFileSync(tokenFilePath, 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({
      access_token: 'refreshed-opaque-token',
      refresh_token: 'refresh-new',
      account_id: 'acct_persisted',
    });
  });

  it('fails closed when credentials do not contain a ChatGPT account id', async () => {
    fs.writeFileSync(tokenFilePath, JSON.stringify({
      access_token: createAccessToken(),
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    expect(await ensureValidCodexOAuthCredentials(tokenFilePath)).toBeNull();
    await expect(createCodexOAuthFetch(tokenFilePath)(CODEX_RESPONSES_ENDPOINT, {
      method: 'POST',
      body: '{}',
    })).rejects.toThrow('ChatGPT account id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects public API URLs instead of leaking a subscription token', async () => {
    fs.writeFileSync(tokenFilePath, JSON.stringify({
      access_token: createAccessToken('acct_test_123'),
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await expect(createCodexOAuthFetch(tokenFilePath)('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: '{}',
    })).rejects.toThrow('only supports');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps tool continuation items while removing public-only parameters', () => {
    const input = [
      { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ];
    expect(normalizeCodexResponsesPayload({
      model: 'gpt-5.6-sol',
      input,
      max_output_tokens: 12000,
      prompt_cache_retention: '24h',
      previous_response_id: 'resp_must_not_be_reused',
      store: true,
    })).toEqual({
      model: 'gpt-5.6-sol',
      input,
      store: false,
      include: ['reasoning.encrypted_content'],
    });
  });

  it('normalizes real AI SDK requests and carries tool output in local history', async () => {
    const accessToken = createAccessToken('acct_sdk_test');
    fs.writeFileSync(tokenFilePath, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
    }));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createResponsesResult('resp_tool', [{
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'Bash',
        arguments: '{"command":"openspec status --json"}',
      }]))
      .mockResolvedValueOnce(createResponsesResult('resp_final', [{
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: 'OpenSpec status loaded.',
          annotations: [],
        }],
      }]));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const model = createProvider({
      config: {
        provider: SupportedProvider.OpenAI,
        apiKey: 'codex-oauth-placeholder',
        oauthTokenFilePath: tokenFilePath,
      },
      modelId: 'gpt-5.6-sol',
    });
    const result = await generateText({
      model,
      prompt: 'Inspect the current OpenSpec change.',
      maxOutputTokens: 16_000,
      stopWhen: stepCountIs(2),
      tools: {
        Bash: tool({
          description: 'Run an approved OpenSpec command.',
          inputSchema: z.object({ command: z.string() }),
          execute: async ({ command }) => `completed: ${command}`,
        }),
      },
      providerOptions: {
        openai: {
          instructions: 'Use the official OpenSpec workflow.',
          metadata: { publicApiOnly: true },
          previousResponseId: 'resp_public_persistence',
          store: true,
        },
      },
    });

    expect(result.text).toBe('OpenSpec status loaded.');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const requests = fetchMock.mock.calls.map((call) => {
      const [url, init] = call as unknown as [string, RequestInit];
      return {
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      };
    });
    expect(requests.map((request) => request.url)).toEqual([
      CODEX_RESPONSES_ENDPOINT,
      CODEX_RESPONSES_ENDPOINT,
    ]);
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(requests[0].headers.get('chatgpt-account-id')).toBe('acct_sdk_test');
    expect(requests[0].body).toMatchObject({
      model: 'gpt-5.6-sol',
      instructions: 'Use the official OpenSpec workflow.',
      store: false,
      include: ['reasoning.encrypted_content'],
    });
    expect(requests[0].body).not.toHaveProperty('max_output_tokens');
    expect(requests[0].body).not.toHaveProperty('metadata');
    expect(requests[0].body).not.toHaveProperty('previous_response_id');

    const continuationInput = requests[1].body.input;
    expect(Array.isArray(continuationInput)).toBe(true);
    expect(continuationInput).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_1',
        name: 'Bash',
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'completed: openspec status --json',
      }),
    ]));
    expect(requests[1].body.store).toBe(false);
    expect(requests[1].body).not.toHaveProperty('max_output_tokens');
    expect(requests[1].body).not.toHaveProperty('previous_response_id');
  });
});
