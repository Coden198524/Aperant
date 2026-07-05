import { describe, expect, it } from 'vitest';

import {
  resolveAutocodeDirectProviderContinuationCapability,
  supportsAutocodeDirectProviderContinuation,
} from './direct-provider-capabilities.js';

describe('direct provider continuation capabilities', () => {
  it('enables provider continuation for responses transports', () => {
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
    })).toBe(true);
  });

  it('falls back to transcript or summary continuation for providers without native state', () => {
    expect(resolveAutocodeDirectProviderContinuationCapability({
      provider: 'deepseek',
      modelId: 'deepseek-v4-flash',
    })).toBeNull();
  });
});