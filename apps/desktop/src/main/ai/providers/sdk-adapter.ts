import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  type ProviderSdkInstancePlan,
} from '@autocode/core';

import {
  CODEX_API_BASE_URL,
  createCodexOAuthFetch,
} from './codex-oauth-fetch';
import { createOpenAICompatibleEndpointFetch } from './openai-base-url';

export function createProviderSdkInstanceFromPlan(plan: ProviderSdkInstancePlan) {
  const fetchImpl = createFetchForPlan(plan);

  switch (plan.sdk) {
    case 'anthropic':
      return createAnthropic({
        ...(plan.authToken ? { authToken: plan.authToken } : { apiKey: plan.apiKey }),
        baseURL: plan.baseURL,
        headers: plan.headers,
      });

    case 'openai':
      return createOpenAI({
        apiKey: plan.apiKey,
        baseURL: plan.fetchStrategy === 'openai-codex-oauth'
          ? CODEX_API_BASE_URL
          : plan.baseURL,
        headers: plan.headers,
        fetch: fetchImpl,
      });

    case 'openai-compatible':
      return createOpenAICompatible({
        name: plan.name ?? 'openai-compatible',
        apiKey: plan.apiKey,
        baseURL: plan.baseURL ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
        headers: plan.headers,
        fetch: fetchImpl,
      });

    case 'google':
      return createGoogleGenerativeAI({
        apiKey: plan.apiKey,
        baseURL: plan.baseURL,
        headers: plan.headers,
      });

    case 'bedrock':
      return createAmazonBedrock({
        region: plan.region ?? 'us-east-1',
        apiKey: plan.apiKey,
      });

    case 'azure':
      return createAzure({
        apiKey: plan.apiKey,
        baseURL: plan.baseURL,
        headers: plan.headers,
      });

    case 'mistral':
      return createMistral({
        apiKey: plan.apiKey,
        baseURL: plan.baseURL,
        headers: plan.headers,
      });

    case 'groq':
      return createGroq({
        apiKey: plan.apiKey,
        baseURL: plan.baseURL,
        headers: plan.headers,
      });

    case 'xai':
      return createXai({
        apiKey: plan.apiKey,
        baseURL: plan.baseURL,
        headers: plan.headers,
      });

    case 'openrouter':
      return createOpenRouter({
        apiKey: plan.apiKey,
      });
  }
}

function createFetchForPlan(plan: ProviderSdkInstancePlan): typeof fetch | undefined {
  switch (plan.fetchStrategy) {
    case 'openai-codex-oauth':
      return plan.oauthTokenFilePath
        ? createCodexOAuthFetch(plan.oauthTokenFilePath)
        : undefined;
    case 'openai-compatible-alternate':
      return createOpenAICompatibleEndpointFetch();
    case 'none':
      return undefined;
  }
}
