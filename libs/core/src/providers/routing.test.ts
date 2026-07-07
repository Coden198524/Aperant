import { describe, expect, it } from 'vitest';

import {
  buildProviderModelCreationPlan,
  parseAutocodeProviderModelInvocationRoutes,
  resolveProviderModelInvocationMethod,
} from './routing.js';
import { SupportedProvider } from './types.js';

describe('provider model invocation routing', () => {
  it('routes future OpenAI models to Responses API without model prefix hardcoding', () => {
    const routes = parseAutocodeProviderModelInvocationRoutes({
      provider: 'openai',
      modelIdPrefix: 'future-resp-',
      method: 'responses',
    });

    const plan = buildProviderModelCreationPlan(
      { provider: SupportedProvider.OpenAI, apiKey: 'test-key' },
      'future-resp-large',
      { invocationRoutes: routes },
    );

    expect(plan.instance.sdk).toBe('openai');
    expect(plan.invocation.method).toBe('responses');
  });

  it('lets configured routes override built-in OpenAI Responses heuristics', () => {
    const routes = parseAutocodeProviderModelInvocationRoutes({
      provider: 'openai',
      modelIdPrefix: 'gpt-5',
      method: 'chat',
    });

    const plan = buildProviderModelCreationPlan(
      { provider: SupportedProvider.OpenAI, apiKey: 'test-key', baseURL: 'https://api.openai.com/v1' },
      'gpt-5.4',
      { invocationRoutes: routes },
    );

    expect(resolveProviderModelInvocationMethod(SupportedProvider.OpenAI, 'gpt-5.4', routes)).toBe('chat');
    expect(plan.invocation.method).toBe('chat');
  });

  it('supports provider-only invocation routes for OpenAI-compatible endpoints', () => {
    const routes = parseAutocodeProviderModelInvocationRoutes({
      provider: 'openai-compatible',
      method: 'responses',
    });

    const plan = buildProviderModelCreationPlan(
      { provider: SupportedProvider.OpenAICompatible, apiKey: 'test-key', baseURL: 'https://example.com/v1' },
      'custom-next-large',
      { invocationRoutes: routes },
    );

    expect(resolveProviderModelInvocationMethod(SupportedProvider.OpenAICompatible, 'custom-next-large', routes)).toBe('responses');
    expect(plan.instance.sdk).toBe('openai');
    expect(plan.invocation.method).toBe('responses');
  });
});