import { describe, expect, it } from 'vitest';

import {
  buildAutocodeDirectProviderContinuationRuntime,
  buildAutocodeDirectProviderFallbackInvocationRoute,
  buildAutocodeDirectProviderFallbackRuntime,
  matchesAutocodeDirectProviderFallbackError,
  parseAutocodeDirectProviderContinuationCapabilities,
  parseAutocodeDirectProviderFallbackCapabilities,
  resolveAutocodeDirectProviderContinuationCapability,
  resolveAutocodeDirectProviderFallbackCapability,
  resolveAutocodeDirectProviderFallbackTransport,
  supportsAutocodeDirectProviderContinuation,
} from './direct-provider-capabilities.js';

describe('direct provider continuation capabilities', () => {
  it('enables provider continuation for declared responses transports', () => {
    expect(resolveAutocodeDirectProviderContinuationCapability({
      provider: 'openai.responses',
      modelId: 'gpt-5.3-codex',
    })).toMatchObject({
      id: 'responses-previous-response',
      mode: 'provider',
    });

    expect(supportsAutocodeDirectProviderContinuation({
      provider: 'openai',
      modelId: 'gpt-5.3-codex',
      transport: 'openai.responses',
    })).toBe(true);
  });

  it('does not infer responses continuation from provider or model names', () => {
    expect(resolveAutocodeDirectProviderContinuationCapability({
      provider: 'openai',
      modelId: 'gpt-5.3-codex',
    })).toBeNull();

    expect(resolveAutocodeDirectProviderContinuationCapability({
      provider: 'openai',
      modelId: 'gpt-5.3-codex',
      transport: 'openai.chatModel',
    })).toBeNull();
  });

  it('falls back to transcript or summary continuation for providers without native state', () => {
    expect(resolveAutocodeDirectProviderContinuationCapability({
      provider: 'deepseek',
      modelId: 'deepseek-v4-flash',
    })).toBeNull();
  });

  it('accepts a single configured provider continuation capability object', () => {
    const capabilities = parseAutocodeDirectProviderContinuationCapabilities({
      id: 'future-single-state',
      condition: {
        provider_prefix: 'future-',
        model_id_prefix: 'future-state-',
      },
      provider_options: {
        future: { store: true },
      },
      continuation_provider_options: {
        future: { previousStateId: '{providerResponseId}' },
      },
      response_id_fields: ['future.stateId'],
    });

    expect(resolveAutocodeDirectProviderContinuationCapability({
      provider: 'future-ai',
      modelId: 'future-state-large',
      capabilities,
    })).toMatchObject({
      id: 'future-single-state',
      providerResponseIdFields: ['future.stateId'],
      continuationProviderOptions: {
        future: { previousStateId: '{providerResponseId}' },
      },
    });
  });
  it('matches configured capabilities by model id contains without provider-specific code', () => {
    const capabilities = parseAutocodeDirectProviderContinuationCapabilities([
      {
        id: 'contains-match-state',
        condition: {
          providerPrefix: 'future-',
          model_id_includes: 'stateful',
        },
        provider_options: {
          future: { persist: true },
        },
        continuation_provider_options: {
          future: { previous_state: '{providerResponseId}' },
        },
        response_id_fields: ['state.id'],
      },
    ]);

    expect(resolveAutocodeDirectProviderContinuationCapability({
      provider: 'future-provider',
      modelId: 'future-stateful-xl',
      capabilities,
    })).toMatchObject({
      id: 'contains-match-state',
      providerOptions: { future: { persist: true } },
      continuationProviderOptions: { future: { previous_state: '{providerResponseId}' } },
      providerResponseIdFields: ['state.id'],
    });
    expect(resolveAutocodeDirectProviderContinuationCapability({
      provider: 'future-provider',
      modelId: 'future-stateless-xl',
      capabilities,
    })).toBeNull();
  });

  it('resolves configured provider continuation capabilities without provider-specific code', () => {
    const capabilities = parseAutocodeDirectProviderContinuationCapabilities([
      {
        id: 'future-response-state',
        mode: 'provider',
        condition: {
          provider: 'future-ai',
          modelIdPrefix: 'future-',
        },
        providerOptions: {
          future: { store: true },
        },
        continuationProviderOptions: {
          future: {
            store: true,
            previousStateId: '{providerResponseId}',
          },
        },
        providerResponseIdFields: ['future.stateId'],
      },
    ]);

    const capability = resolveAutocodeDirectProviderContinuationCapability({
      provider: 'future-ai',
      modelId: 'future-large',
      capabilities,
    });

    expect(capability).toMatchObject({
      id: 'future-response-state',
      mode: 'provider',
      providerResponseIdFields: ['future.stateId'],
    });
    expect(buildAutocodeDirectProviderContinuationRuntime({
      capability: capability!,
      providerResponseId: 'state-1',
    })).toMatchObject({
      capabilityId: 'future-response-state',
      providerResponseId: 'state-1',
      continuationProviderOptions: {
        future: { previousStateId: '{providerResponseId}' },
      },
    });
  });

  it('matches configured capabilities by generic provider transport conditions', () => {
    const capabilities = parseAutocodeDirectProviderContinuationCapabilities([
      {
        id: 'future-transport-state',
        condition: {
          provider_includes: 'future',
          providerTransport: 'future-sdk.responses',
        },
        continuation_provider_options: {
          future: { previousStateId: '{providerResponseId}' },
        },
        response_id_fields: ['future.stateId'],
      },
      {
        id: 'prefix-transport-state',
        condition: {
          transport_prefix: 'prefix-sdk.',
        },
      },
      {
        id: 'includes-transport-state',
        condition: {
          transport_includes: '.responses',
        },
      },
    ]);

    expect(resolveAutocodeDirectProviderContinuationCapability({
      provider: 'future-ai',
      modelId: 'future-large',
      transport: 'future-sdk.responses',
      capabilities,
    })).toMatchObject({
      id: 'future-transport-state',
      providerResponseIdFields: ['future.stateId'],
    });
    expect(resolveAutocodeDirectProviderContinuationCapability({
      provider: 'future-ai',
      modelId: 'future-large',
      transport: 'prefix-sdk.chat',
      capabilities,
    })).toMatchObject({ id: 'prefix-transport-state' });
    expect(resolveAutocodeDirectProviderContinuationCapability({
      provider: 'future-ai',
      modelId: 'future-large',
      transport: 'another.responses',
      capabilities,
    })).toMatchObject({ id: 'includes-transport-state' });
    expect(resolveAutocodeDirectProviderContinuationCapability({
      provider: 'other-ai',
      modelId: 'future-large',
      transport: 'future-sdk.chat',
      capabilities,
    })).toBeNull();
  });
  it('resolves provider fallback capabilities from transport and configured error matchers', () => {
    const capability = resolveAutocodeDirectProviderFallbackCapability({
      provider: 'openai',
      modelId: 'gpt-5.4',
      transport: 'openai.responses',
    });

    expect(capability).toMatchObject({
      id: 'responses-persistence-chatmodel-fallback',
      fallbackInvocationMethod: 'chatModel',
      resetProviderPersistence: true,
    });

    const runtime = buildAutocodeDirectProviderFallbackRuntime({ capability: capability! });
    expect(matchesAutocodeDirectProviderFallbackError(
      runtime,
      'Item with id fc_123 was not found by /responses',
    )).toBe(true);
    expect(resolveAutocodeDirectProviderFallbackTransport(runtime, 'openai')).toBe('openai.chatModel');
    expect(buildAutocodeDirectProviderFallbackInvocationRoute(runtime, 'openai')).toEqual({
      provider: 'openai',
      method: 'chatModel',
    });
  });

  it('parses future provider fallback capabilities without source-code branches', () => {
    const capabilities = parseAutocodeDirectProviderFallbackCapabilities({
      id: 'future-state-fallback',
      condition: {
        provider_prefix: 'future-',
        provider_transport_includes: '.stateful',
      },
      fallback_invocation_method: 'chat',
      fallback_provider_transport: '{provider}.chat',
      error_matchers: [
        { message_includes: ['state id', 'not found'] },
      ],
      reset_provider_persistence: false,
    });

    const capability = resolveAutocodeDirectProviderFallbackCapability({
      provider: 'future-ai',
      modelId: 'future-large',
      transport: 'future-sdk.stateful',
      capabilities,
    });
    const runtime = buildAutocodeDirectProviderFallbackRuntime({ capability: capability! });

    expect(runtime).toMatchObject({
      capabilityId: 'future-state-fallback',
      fallbackInvocationMethod: 'chat',
      fallbackProviderTransport: '{provider}.chat',
      resetProviderPersistence: false,
    });
    expect(matchesAutocodeDirectProviderFallbackError(runtime, 'remote state id was not found')).toBe(true);
    expect(resolveAutocodeDirectProviderFallbackTransport(runtime, 'future-ai')).toBe('future-ai.chat');
  });
});
