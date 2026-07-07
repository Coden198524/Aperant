/**
 * Provider Factory
 *
 * Creates Vercel AI SDK language models from pure @autocode/core plans.
 * Core owns provider routing decisions; desktop owns the heavy SDK adapters.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

import {
  buildProviderModelCreationPlan,
  detectProviderFromModel as detectProviderFromModelCore,
  getKnownModelProviderPrefixes,
  parseAutocodeProviderModelInvocationRoutes,
  SupportedProvider as SupportedProviderValue,
  type AutocodeProviderModelInvocationRouteConfig,
  type ProviderConfig,
  type ProviderModelInvocationPlan,
  type SupportedProvider,
} from '@autocode/core';
import { createProviderSdkInstanceFromPlan } from './sdk-adapter';

function invokeModelFromPlan(
  instance: unknown,
  invocation: ProviderModelInvocationPlan,
): LanguageModel {
  switch (invocation.method) {
    case 'chat':
      return (instance as ReturnType<typeof createAzure>).chat(invocation.modelId);
    case 'responses':
      return (instance as ReturnType<typeof createOpenAI>).responses(invocation.modelId);
    case 'chatModel':
      return (instance as ReturnType<typeof createOpenAICompatible>).chatModel(invocation.modelId);
    case 'call':
      return (instance as ReturnType<typeof createAnthropic>)(invocation.modelId);
  }
}

/** Options for creating a language model */
export interface CreateProviderOptions {
  /** Provider configuration */
  config: ProviderConfig;
  /** Full model ID, e.g. 'claude-sonnet-4-5-20250929' */
  modelId: string;
  /** Optional configurable provider/model -> SDK invocation method routes. */
  invocationRoutes?: AutocodeProviderModelInvocationRouteConfig | AutocodeProviderModelInvocationRouteConfig[];
}

export function createProvider(options: CreateProviderOptions): LanguageModel {
  const plan = buildProviderModelCreationPlan(options.config, options.modelId, {
    invocationRoutes: parseAutocodeProviderModelInvocationRoutes(options.invocationRoutes),
  });
  const instance = createProviderSdkInstanceFromPlan(plan.instance);
  const model = invokeModelFromPlan(instance, plan.invocation);

  if (!plan.invocation.supportsPromptCaching) {
    return model;
  }

  return Object.assign(model, {
    supportsPromptCaching: true,
  }) as LanguageModel;
}

export function detectProviderFromModel(modelId: string): SupportedProvider | undefined {
  const provider = detectProviderFromModelCore(modelId);
  return isSupportedProvider(provider) ? provider : undefined;
}

function isSupportedProvider(value: string | undefined): value is SupportedProvider {
  return typeof value === 'string' && (Object.values(SupportedProviderValue) as string[]).includes(value);
}

export function createProviderFromModelId(
  modelId: string,
  overrides?: Partial<Omit<ProviderConfig, 'provider'>>,
): LanguageModel {
  const provider = detectProviderFromModel(modelId);
  if (!provider) {
    throw new Error(
      `Cannot detect provider for model "${modelId}". ` +
        `Known prefixes: ${getKnownModelProviderPrefixes().join(', ')}`,
    );
  }

  return createProvider({
    config: {
      provider,
      ...overrides,
    },
    modelId,
  });
}
