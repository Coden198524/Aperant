/**
 * Provider Registry
 *
 * Creates a centralized provider registry using AI SDK v6's createProviderRegistry.
 * Core owns provider SDK instance plans; desktop adapts those plans to AI SDK providers.
 */

import type { ProviderV3 } from '@ai-sdk/provider';
import { createProviderRegistry } from 'ai';
import type { LanguageModel } from 'ai';

import {
  buildProviderSdkInstancePlan,
  type ProviderConfig,
  type SupportedProvider,
} from '@autocode/core';
import { createProviderSdkInstanceFromPlan } from './sdk-adapter';

/** Configuration for building the provider registry */
export interface RegistryConfig {
  /** Map of provider ID to its configuration */
  providers: Partial<Record<SupportedProvider, Omit<ProviderConfig, 'provider'>>>;
}

function createProviderSDKInstance(
  provider: SupportedProvider,
  config: Omit<ProviderConfig, 'provider'>,
) {
  return createProviderSdkInstanceFromPlan(
    buildProviderSdkInstancePlan({
      provider,
      ...config,
    }),
  );
}

export function buildRegistry(config: RegistryConfig) {
  const providers: Record<string, ProviderV3> = {};

  for (const [providerKey, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig) {
      providers[providerKey] = createProviderSDKInstance(
        providerKey as SupportedProvider,
        providerConfig,
      ) as ProviderV3;
    }
  }

  return createProviderRegistry(providers);
}

/** Return type of buildRegistry */
export type ProviderRegistry = ReturnType<typeof buildRegistry>;

export function resolveModel(
  registry: ProviderRegistry,
  providerAndModel: `${string}:${string}`,
): LanguageModel {
  return registry.languageModel(providerAndModel);
}
