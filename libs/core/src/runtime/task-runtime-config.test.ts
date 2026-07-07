import { describe, expect, it } from 'vitest';

import { parseAutocodeModelProviderRoutes } from '../providers/routing.js';
import {
  inferAutocodePinnedProviderFromModel,
  inferAutocodeProviderFromModelValue,
  resolveAutocodeTaskPhaseProvider,
  resolveAutocodeTaskWorkflowMode,
} from './task-runtime-config.js';

describe('task runtime config provider inference', () => {
  it('defaults missing Standard workflow metadata to balanced mode', () => {
    expect(resolveAutocodeTaskWorkflowMode(null)).toBe('balanced');
    expect(resolveAutocodeTaskWorkflowMode(undefined)).toBe('balanced');
    expect(resolveAutocodeTaskWorkflowMode({})).toBe('balanced');
  });

  it('falls back invalid Standard workflow metadata to balanced mode', () => {
    expect(resolveAutocodeTaskWorkflowMode({ workflowMode: 'legacy-heavy' })).toBe('balanced');
  });

  it('uses centralized model provider routing for concrete models', () => {
    expect(inferAutocodeProviderFromModelValue('gpt-5.3-codex')).toBe('openai');
    expect(inferAutocodeProviderFromModelValue('o3')).toBe('openai');
    expect(inferAutocodeProviderFromModelValue('meta-llama/llama-4')).toBe('groq');
    expect(inferAutocodeProviderFromModelValue('future-model-1')).toBeUndefined();
  });

  it('keeps cross-provider shorthand models unpinned while pinning resolved concrete aliases', () => {
    expect(inferAutocodePinnedProviderFromModel('sonnet')).toBeNull();
    expect(inferAutocodePinnedProviderFromModel('gpt-5.5')).toBe('openai');
  });

  it('prefers explicit phase provider metadata over model inference', () => {
    expect(resolveAutocodeTaskPhaseProvider({
      phaseProviders: { coding: 'future-ai' },
      phaseModels: { coding: 'gpt-5.5' },
    }, 'coding')).toBe('future-ai');
  });

  it('uses configured model provider routes before built-in model prefixes', () => {
    const routes = parseAutocodeModelProviderRoutes([
      { provider: 'openai-compatible', modelIdPrefix: 'future-' },
      { provider: 'openai-compatible', modelIdPrefix: 'gpt-' },
    ]);

    expect(inferAutocodeProviderFromModelValue('future-large', routes)).toBe('openai-compatible');
    expect(inferAutocodeProviderFromModelValue('gpt-5.5', routes)).toBe('openai-compatible');
    expect(resolveAutocodeTaskPhaseProvider({
      phaseModels: { coding: 'future-large' },
    }, 'coding', { modelProviderRoutes: routes })).toBe('openai-compatible');
  });

  it('accepts configured future provider identifiers in model provider routes', () => {
    const routes = parseAutocodeModelProviderRoutes({ provider: 'future-ai', modelIdPrefix: 'future-' });

    expect(inferAutocodeProviderFromModelValue('future-large', routes)).toBe('future-ai');
    expect(resolveAutocodeTaskPhaseProvider({
      phaseModels: { coding: 'future-large' },
    }, 'coding', { modelProviderRoutes: routes })).toBe('future-ai');
  });
  it('uses task metadata model provider routes without requiring code changes', () => {
    expect(resolveAutocodeTaskPhaseProvider({
      phaseModels: { coding: 'future-large' },
      modelProviderRoutes: { provider: 'openai-compatible', modelIdPrefix: 'future-' },
    }, 'coding')).toBe('openai-compatible');
  });

  it('lets explicit routes pin shorthand models when a task needs that behavior', () => {
    const routes = parseAutocodeModelProviderRoutes({ provider: 'openai', modelId: 'sonnet' });
    expect(inferAutocodePinnedProviderFromModel('sonnet', routes)).toBe('openai');
  });
});