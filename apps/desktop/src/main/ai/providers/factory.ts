/**
 * Provider Factory
 *
 * Creates Vercel AI SDK provider instances from configuration.
 * Maps provider names to the correct @ai-sdk/* constructor and handles
 * per-provider options (thinking tokens, strict JSON, Azure deployments).
 *
 * See apps/desktop/src/main/ai/providers/factory.ts for the TypeScript implementation.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';

import { MODEL_PROVIDER_MAP } from '../config/types';
import { createOAuthProviderFetch } from './oauth-fetch';
import {
  createOpenAICompatibleEndpointFetch,
  isOfficialOpenAIBaseUrl,
  normalizeOpenAICompatibleBaseUrl,
} from './openai-base-url';
import { type ProviderConfig, SupportedProvider } from './types';

// =============================================================================
// OAuth Token Detection
// =============================================================================

/**
 * Detects if a credential is an Anthropic OAuth token vs an API key.
 * OAuth access tokens start with 'sk-ant-oa' prefix.
 * API keys start with 'sk-ant-api' prefix.
 */
function isOAuthToken(token: string | undefined): boolean {
  if (!token) return false;
  return token.startsWith('sk-ant-oa') || token.startsWith('sk-ant-ort');
}

/**
 * Detects if the baseURL is an official Anthropic API endpoint.
 * Third-party API gateways should not receive Claude Code beta headers.
 */
function isOfficialAnthropicBaseUrl(baseURL: string | undefined): boolean {
  if (!baseURL) return true; // Default to official API

  try {
    const { hostname } = new URL(baseURL);
    return (
      hostname === 'api.anthropic.com' ||
      hostname.endsWith('.anthropic.com')
    );
  } catch {
    return false;
  }
}

/**
 * Normalizes the baseURL for third-party Anthropic-compatible APIs.
 *
 * The Anthropic SDK appends `/messages` to the baseURL, so:
 * - Official API: uses built-in `/v1` path
 * - Third-party APIs: may need `/v1` added if missing
 *
 * This function ensures third-party APIs work correctly by:
 * 1. Checking if the URL already ends with `/v1` or `/v1/`
 * 2. If not, appending `/v1` for compatibility
 *
 * @param baseURL - The configured base URL
 * @returns Normalized base URL with `/v1` if needed
 */
function normalizeAnthropicBaseUrl(baseURL: string | undefined): string | undefined {
  if (!baseURL) return baseURL;

  // Official Anthropic API doesn't need normalization
  if (isOfficialAnthropicBaseUrl(baseURL)) {
    return baseURL;
  }

  try {
    const url = new URL(baseURL);
    const pathname = url.pathname;

    // Already has /v1 or /v1/ at the end
    if (pathname.endsWith('/v1') || pathname.endsWith('/v1/')) {
      return baseURL;
    }

    // Already has /v1 in the middle (e.g., /api/v1)
    if (pathname.includes('/v1/') || pathname.includes('/v1')) {
      return baseURL;
    }

    // Add /v1 to the end (remove trailing slash first)
    const normalizedPathname = pathname.replace(/\/+$/, '') + '/v1';
    url.pathname = normalizedPathname;

    return url.toString();
  } catch {
    // Invalid URL, return as-is
    return baseURL;
  }
}

function shouldUseOpenAICompatibleChat(config: ProviderConfig): boolean {
  return (
    config.provider === SupportedProvider.OpenAI &&
    !config.oauthTokenFilePath &&
    !isOfficialOpenAIBaseUrl(config.baseURL)
  );
}

function createOpenAICompatibleChatModel(
  config: ProviderConfig,
  modelId: string,
  fetchImpl?: typeof fetch,
): LanguageModel {
  const normalizedBaseURL = normalizeOpenAICompatibleBaseUrl(config.baseURL);
  const provider = createOpenAICompatible({
    name: 'openai-compatible',
    apiKey: config.apiKey ?? 'custom-endpoint',
    baseURL: normalizedBaseURL ?? 'https://api.openai.com/v1',
    headers: config.headers,
    fetch: fetchImpl ?? createOpenAICompatibleEndpointFetch(),
  });
  return provider.chatModel(modelId);
}

// =============================================================================
// Provider Instance Creators
// =============================================================================

/**
 * Creates a provider SDK instance (not a model) for the given config.
 * Each provider has its own constructor with different auth options.
 */
function createProviderInstance(config: ProviderConfig) {
  const { provider, apiKey, baseURL, headers } = config;

  switch (provider) {
    case SupportedProvider.Anthropic: {
      // OAuth tokens use authToken (Authorization: Bearer) + required beta header
      // API keys use apiKey (x-api-key header)
      // IMPORTANT: Only add beta header for official Anthropic API endpoints
      // Third-party API gateways may not support or recognize these beta features
      const isOAuth = isOAuthToken(apiKey);
      const normalizedBaseURL = normalizeAnthropicBaseUrl(baseURL);
      const isOfficialApi = isOfficialAnthropicBaseUrl(normalizedBaseURL);

      if (isOAuth) {
        // OAuth tokens always use authToken + beta header (only for official API)
        return createAnthropic({
          authToken: apiKey,
          baseURL: normalizedBaseURL,
          headers: isOfficialApi ? {
            ...headers,
            'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14',
          } : headers,
        });
      }

      // API keys: only add beta header for official Anthropic API
      // Third-party APIs should work without beta headers
      return createAnthropic({
        apiKey,
        baseURL: normalizedBaseURL,
        headers: isOfficialApi ? {
          ...headers,
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14',
        } : headers,
      });
    }

    case SupportedProvider.OpenAI: {
      // File-based OAuth: use generic fetch interceptor for token injection + URL rewriting
      if (config.oauthTokenFilePath) {
        return createOpenAI({
          apiKey: apiKey ?? 'codex-oauth-placeholder',
          baseURL,
          headers,
          fetch: createOAuthProviderFetch(config.oauthTokenFilePath, 'openai'),
        });
      }
      return createOpenAI({
        apiKey,
        baseURL,
        headers,
      });
    }

    case SupportedProvider.OpenAICompatible:
      return createOpenAICompatible({
        name: 'openai-compatible',
        apiKey: apiKey ?? 'custom-endpoint',
        baseURL: normalizeOpenAICompatibleBaseUrl(baseURL) ?? 'https://api.openai.com/v1',
        headers,
        fetch: createOpenAICompatibleEndpointFetch(),
      });

    case SupportedProvider.Google:
      return createGoogleGenerativeAI({
        apiKey,
        baseURL,
        headers,
      });

    case SupportedProvider.Bedrock:
      return createAmazonBedrock({
        region: config.region ?? 'us-east-1',
        apiKey,
      });

    case SupportedProvider.Azure:
      return createAzure({
        apiKey,
        baseURL,
        headers,
      });

    case SupportedProvider.Mistral:
      return createMistral({
        apiKey,
        baseURL,
        headers,
      });

    case SupportedProvider.Groq:
      return createGroq({
        apiKey,
        baseURL,
        headers,
      });

    case SupportedProvider.XAI:
      return createXai({
        apiKey,
        baseURL,
        headers,
      });

    case SupportedProvider.OpenRouter:
      return createOpenRouter({
        apiKey,
      });

    case SupportedProvider.ZAI:
      return createOpenAICompatible({
        name: 'zai',
        apiKey,
        baseURL: baseURL ?? 'https://api.z.ai/api/paas/v4',
        headers,
      });

    case SupportedProvider.Ollama: {
      // Account settings store the base Ollama URL (e.g., 'http://localhost:11434')
      // but the OpenAI-compatible SDK needs the /v1 path appended.
      let ollamaBaseURL = baseURL ?? 'http://localhost:11434';
      if (!ollamaBaseURL.endsWith('/v1')) {
        ollamaBaseURL = ollamaBaseURL.replace(/\/+$/, '') + '/v1';
      }
      return createOpenAICompatible({
        name: 'ollama',
        apiKey: apiKey ?? 'ollama',
        baseURL: ollamaBaseURL,
        headers,
      });
    }

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive}`);
    }
  }
}

// =============================================================================
// Codex Model Detection
// =============================================================================

/**
 * Detects if a model ID refers to an OpenAI Codex model.
 * Codex models only support the Responses API (not Chat Completions).
 */
function isCodexModel(modelId: string): boolean {
  return modelId.includes('codex');
}

/**
 * Detects models that should use the OpenAI Responses API.
 * Covers GPT-5, Codex, and modern reasoning models exposed through OpenAI-compatible backends.
 */
function isResponsesApiModel(modelId: string): boolean {
  return (
    modelId.startsWith('gpt-5') ||
    isCodexModel(modelId) ||
    modelId === 'o3' ||
    modelId.startsWith('o3-') ||
    modelId === 'o4-mini' ||
    modelId.startsWith('o4-')
  );
}

// =============================================================================
// Model Creation Options
// =============================================================================

/** Options for creating a language model */
export interface CreateProviderOptions {
  /** Provider configuration */
  config: ProviderConfig;
  /** Full model ID (e.g., 'claude-sonnet-4-5-20250929') */
  modelId: string;
}

// =============================================================================
// Provider Factory
// =============================================================================

/**
 * Creates a LanguageModel instance for the given provider + model combination.
 *
 * Handles per-provider quirks:
 * - Azure uses deployment-based routing via `.chat()`
 * - Ollama uses OpenAI-compatible adapter
 * - Anthropic: enables prompt caching for official API endpoints
 *
 * @param options - Provider config and model ID
 * @returns A configured LanguageModel instance
 */
export function createProvider(options: CreateProviderOptions): LanguageModel {
  const { config, modelId } = options;
  const instance = createProviderInstance(config);

  // Azure uses deployment names, not model IDs
  if (config.provider === SupportedProvider.Azure) {
    const deploymentName = config.deploymentName ?? modelId;
    return (instance as ReturnType<typeof createAzure>).chat(deploymentName);
  }

  // Anthropic: return the model with provider metadata for prompt caching
  // Only enable caching for official Anthropic API endpoints
  if (config.provider === SupportedProvider.Anthropic) {
    const model = (instance as ReturnType<typeof createAnthropic>)(modelId);
    const isOfficialApi = isOfficialAnthropicBaseUrl(config.baseURL);

    // Add prompt caching support for official Anthropic API
    if (isOfficialApi) {
      return {
        ...model,
        // Mark this model as supporting prompt caching
        // The runner.ts will use experimental_providerMetadata when calling streamText()
        supportsPromptCaching: true,
      } as LanguageModel;
    }

    return model;
  }

  // OpenAI: Codex OAuth accounts rewrite ALL URLs to the Codex Responses endpoint,
  // so every model must use `.responses()` to avoid a format mismatch (Chat Completions
  // format sent to Responses endpoint → 400). Regular API-key accounts use
  // `.responses()` for Codex models and `.chat()` for everything else.
  if (config.provider === SupportedProvider.OpenAI) {
    const isOfficialBaseUrl = isOfficialOpenAIBaseUrl(config.baseURL);

    if (config.oauthTokenFilePath && !isOfficialBaseUrl) {
      return createOpenAICompatibleChatModel(
        config,
        modelId,
        createOAuthProviderFetch(config.oauthTokenFilePath, 'openai'),
      );
    }

    if (config.oauthTokenFilePath || (isResponsesApiModel(modelId) && isOfficialBaseUrl)) {
      return (instance as ReturnType<typeof createOpenAI>).responses(modelId);
    }

    if (shouldUseOpenAICompatibleChat(config)) {
      return createOpenAICompatibleChatModel(config, modelId);
    }

    return (instance as ReturnType<typeof createOpenAI>).chat(modelId);
  }

  if (config.provider === SupportedProvider.OpenAICompatible) {
    if (isResponsesApiModel(modelId)) {
      if (!isOfficialOpenAIBaseUrl(config.baseURL)) {
        const provider = instance as ReturnType<typeof createOpenAICompatible>;
        return provider.chatModel(modelId);
      }

      const responsesProvider = createOpenAI({
        apiKey: config.apiKey ?? 'custom-endpoint',
        baseURL: normalizeOpenAICompatibleBaseUrl(config.baseURL) ?? 'https://api.openai.com/v1',
        headers: config.headers,
      });
      return responsesProvider.responses(modelId);
    }

    const provider = instance as ReturnType<typeof createOpenAICompatible>;
    return provider.chatModel(modelId);
  }

  // Generic path: call provider instance as function with model ID
  return (instance as ReturnType<typeof createAnthropic>)(modelId);
}

// =============================================================================
// Provider Detection
// =============================================================================

/**
 * Detects the provider for a model ID based on its prefix.
 * Uses MODEL_PROVIDER_MAP for prefix-based matching.
 *
 * @param modelId - Full model ID (e.g., 'claude-sonnet-4-5-20250929', 'gpt-4o')
 * @returns The detected provider, or undefined if no match
 */
export function detectProviderFromModel(modelId: string): SupportedProvider | undefined {
  for (const [prefix, provider] of Object.entries(MODEL_PROVIDER_MAP)) {
    if (modelId.startsWith(prefix)) {
      return provider;
    }
  }
  return undefined;
}

/**
 * Creates a LanguageModel from a model ID, auto-detecting the provider.
 * Useful when only a model ID is known (e.g., from user settings).
 *
 * @param modelId - Full model ID
 * @param overrides - Optional provider config overrides (apiKey, baseURL, etc.)
 * @returns A configured LanguageModel instance
 * @throws If the provider cannot be detected from the model ID
 */
export function createProviderFromModelId(
  modelId: string,
  overrides?: Partial<Omit<ProviderConfig, 'provider'>>,
): LanguageModel {
  const provider = detectProviderFromModel(modelId);
  if (!provider) {
    throw new Error(
      `Cannot detect provider for model "${modelId}". ` +
        `Known prefixes: ${Object.keys(MODEL_PROVIDER_MAP).join(', ')}`,
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
