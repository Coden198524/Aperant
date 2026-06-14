import { describe, expect, it } from 'vitest';

import {
  ALL_AVAILABLE_MODELS,
  PROVIDER_PRESET_DEFINITIONS,
} from '../models';
import {
  PROVIDER_MODEL_SUPPORT_POLICY_VERSION,
  buildProviderModelSupportMatrix,
  stringifyProviderModelSupportMatrixMarkdown,
} from '../provider-support';
import { PROVIDER_REGISTRY } from '../providers';

describe('provider model support matrix', () => {
  it('includes every registered provider exactly once', () => {
    const matrix = buildProviderModelSupportMatrix();

    expect(matrix.map((entry) => entry.provider)).toEqual(
      PROVIDER_REGISTRY.map((provider) => provider.id),
    );
    expect(new Set(matrix.map((entry) => entry.provider)).size).toBe(PROVIDER_REGISTRY.length);
  });

  it('assigns every built-in catalog model to its provider support entry', () => {
    const matrix = buildProviderModelSupportMatrix();

    for (const provider of PROVIDER_REGISTRY) {
      const entry = matrix.find((candidate) => candidate.provider === provider.id);
      const expectedModels = ALL_AVAILABLE_MODELS
        .filter((model) => model.provider === provider.id)
        .map((model) => model.value);

      expect(entry?.catalogModels.map((model) => model.value)).toEqual(expectedModels);
      expect(entry?.presetIds).toEqual(
        Object.keys(PROVIDER_PRESET_DEFINITIONS[provider.id] ?? {}),
      );
    }
  });

  it('marks catalog, local, and custom endpoint providers with explicit support levels', () => {
    const matrix = buildProviderModelSupportMatrix();
    const byProvider = new Map(matrix.map((entry) => [entry.provider, entry]));

    expect(byProvider.get('anthropic')?.supportLevel).toBe('built-in-catalog');
    expect(byProvider.get('openai')?.catalogModels.some((model) => model.value === 'gpt-5.5')).toBe(true);
    expect(byProvider.get('openai-compatible')?.supportLevel).toBe('custom-endpoint');
    expect(byProvider.get('openai-compatible')?.catalogModels).toEqual([]);
    expect(byProvider.get('ollama')?.supportLevel).toBe('local-runtime');
    expect(byProvider.get('ollama')?.catalogModels).toEqual([]);
    expect(byProvider.get('azure')?.supportLevel).toBe('provider-config-only');
    expect(byProvider.get('amazon-bedrock')?.supportLevel).toBe('provider-config-only');
  });

  it('serializes a versioned Markdown policy for release evidence', () => {
    const markdown = stringifyProviderModelSupportMatrixMarkdown();

    expect(markdown).toContain(`# Provider Model Support Matrix\n\nVersion: ${PROVIDER_MODEL_SUPPORT_POLICY_VERSION}`);
    expect(markdown).toContain('| OpenAI | `built-in-catalog` |');
    expect(markdown).toContain('| Custom Endpoint | `custom-endpoint` |');
    expect(markdown).toContain('`gpt-5.5` | GPT-5.5');
    expect(markdown).toContain('## Cost Display Policy');
    expect(markdown).toContain('Monetary cost estimates remain unconfigured');
  });
});
