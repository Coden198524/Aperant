import { describe, expect, it } from 'vitest';

import {
  CODEX_OAUTH_RESPONSES_TRANSPORT,
  buildProviderFallbackSessionConfigOverrides,
  mergeProviderFallbackInvocationRoutes,
  normalizeProviderBaseUrl,
  resolveEffectiveSessionProviderTransport,
  resolveProviderFallbackCacheKey,
  resolveSessionProviderTransport,
  shouldFallbackForProviderError,
  shouldForceProviderFallbackTransport,
} from '../provider-transport';
import type { SerializableSessionConfig } from '../types';

function createSession(overrides: Partial<SerializableSessionConfig> = {}): SerializableSessionConfig {
  return {
    agentType: 'direct_task',
    systemPrompt: 'Direct prompt',
    initialMessages: [{ role: 'user', content: 'Fix it.' }],
    maxSteps: 10,
    specDir: 'E:/repo/.autocode/specs/001-direct',
    projectDir: 'E:/repo',
    provider: 'openai',
    modelId: 'gpt-5.4',
    baseURL: 'https://gateway.example.com/codex/v1/',
    responsePersistence: true,
    providerTransport: 'openai.responses',
    providerResponsePersistence: {
      capabilityId: 'responses-previous-response',
      mode: 'provider',
      providerResponseId: 'resp_prev',
      continuationProviderOptions: {
        openai: { previousResponseId: '{providerResponseId}' },
      },
    },
    providerFallback: {
      capabilityId: 'responses-persistence-chatmodel-fallback',
      fallbackInvocationMethod: 'chatModel',
      errorMatchers: [
        { messageIncludes: ['item with id', 'fc_', 'not found', 'responses'] },
        { messageIncludes: ['items are not persisted', 'store', 'false'] },
      ],
      resetProviderPersistence: true,
    },
    toolContext: {
      cwd: 'E:/repo',
      projectDir: 'E:/repo',
      specDir: 'E:/repo/.autocode/specs/001-direct',
      securityProfile: {
        baseCommands: [],
        stackCommands: [],
        scriptCommands: [],
        customCommands: [],
        customScripts: { shellScripts: [] },
      },
    },
    ...overrides,
  } as SerializableSessionConfig;
}

describe('agent provider transport helpers', () => {
  it('normalizes provider base URLs for broken transport cache keys', () => {
    expect(normalizeProviderBaseUrl('https://gateway.example.com/codex/v1/')).toBe('https://gateway.example.com/codex/v1');
    expect(normalizeProviderBaseUrl('not a url ')).toBe('not a url');
  });

  it('detects configured provider fallback errors without provider-specific branches', () => {
    const session = createSession();

    expect(shouldFallbackForProviderError({
      outcome: 'error',
      error: {
        code: 'generic_error',
        message: 'Item with id fc_123 was not found by /responses',
        retryable: true,
      },
    }, session)).toBe(true);

    expect(shouldFallbackForProviderError({
      outcome: 'error',
      error: {
        code: 'generic_error',
        message: 'items are not persisted when store is false',
        retryable: true,
      },
    }, session)).toBe(true);

    expect(shouldFallbackForProviderError({
      outcome: 'error',
      error: {
        code: 'generic_error',
        message: 'unrelated provider error',
        retryable: true,
      },
    }, session)).toBe(false);
  });

  it('forces fallback transport when a configured provider fallback cache key is marked broken', () => {
    const session = createSession();
    const cacheKey = resolveProviderFallbackCacheKey(session);
    const broken = new Set(cacheKey ? [cacheKey] : []);

    expect(cacheKey).toBe('responses-persistence-chatmodel-fallback:https://gateway.example.com/codex/v1');
    expect(shouldForceProviderFallbackTransport(session, broken)).toBe(true);
    expect(resolveEffectiveSessionProviderTransport(session, session.modelId, broken)).toBe('openai.chatModel');
  });

  it('keeps configured transport when the fallback cache key is not marked broken', () => {
    const session = createSession();

    expect(resolveEffectiveSessionProviderTransport(session, session.modelId, new Set())).toBe('openai.responses');
  });

  it('uses a distinct transport id for ChatGPT Codex OAuth Responses', () => {
    const session = createSession({
      baseURL: undefined,
      oauthTokenFilePath: 'C:/Users/test/AppData/Roaming/autocode/codex-auth.json',
      providerTransport: undefined,
    });

    expect(resolveSessionProviderTransport(session, session.modelId))
      .toBe(CODEX_OAUTH_RESPONSES_TRANSPORT);
    expect(resolveEffectiveSessionProviderTransport(session, session.modelId, new Set()))
      .toBe(CODEX_OAUTH_RESPONSES_TRANSPORT);
  });

  it('clears provider-native persistence when fallback capability requests it', () => {
    expect(buildProviderFallbackSessionConfigOverrides(createSession())).toEqual({
      providerTransport: 'openai.chatModel',
      responsePersistence: false,
      previousResponseId: undefined,
      providerOptions: undefined,
      providerResponseIdFields: undefined,
      providerResponsePersistence: undefined,
    });
  });

  it('prepends fallback invocation routes before configured routes', () => {
    expect(mergeProviderFallbackInvocationRoutes(createSession({
      providerModelInvocationRoutes: {
        provider: 'openai',
        modelIdPrefix: 'gpt-5',
        method: 'responses',
      },
    }))).toEqual([
      {
        provider: 'openai',
        method: 'chatModel',
      },
      {
        provider: 'openai',
        modelIdPrefix: 'gpt-5',
        method: 'responses',
      },
    ]);
  });
});
