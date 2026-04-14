import { describe, expect, it } from 'vitest';
import { buildProviderQueueResolutionErrorMessage } from './provider-queue-errors';
import type { ProviderAccount } from '../../shared/types/provider-account';

const baseAccount: ProviderAccount = {
  id: 'acc-1',
  provider: 'openai',
  name: 'Custom OpenAI',
  authType: 'api-key',
  billingModel: 'pay-per-use',
  apiKey: 'sk-test',
  baseUrl: 'https://cc-vibe.com',
  createdAt: 0,
  updatedAt: 0,
};

describe('buildProviderQueueResolutionErrorMessage', () => {
  it('returns a specific message for custom OpenAI base URLs on agentic GPT-5 tasks', () => {
    const message = buildProviderQueueResolutionErrorMessage('gpt-5.4', 'openai', [baseAccount]);

    expect(message).toContain('custom base URL');
    expect(message).toContain('/v1');
    expect(message).toContain('gpt-5.4');
  });

  it('returns a generic message for non-OpenAI queue failures', () => {
    const anthropicAccount: ProviderAccount = {
      ...baseAccount,
      id: 'acc-2',
      provider: 'anthropic',
      name: 'Anthropic',
      baseUrl: undefined,
    };

    const message = buildProviderQueueResolutionErrorMessage('sonnet', 'anthropic', [anthropicAccount]);

    expect(message).toContain('No compatible account available for model "sonnet"');
    expect(message).not.toContain('openai-compatible');
  });
});
