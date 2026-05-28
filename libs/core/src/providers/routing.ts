import { MODEL_PROVIDER_MAP } from '../config/types.js';
import type { ProviderConfig, SupportedProvider } from './types.js';
import { SupportedProvider as SupportedProviderValue } from './types.js';

const OPENAI_API_SUFFIXES = [
  '/chat/completions',
  '/responses',
  '/embeddings',
  '/models',
  '/completions',
  '/images/generations',
  '/audio/speech',
  '/audio/transcriptions',
  '/audio/translations',
] as const;

export const ANTHROPIC_CLAUDE_CODE_BETA_HEADER =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14';

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

export type ProviderSdkAdapter =
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'google'
  | 'bedrock'
  | 'azure'
  | 'mistral'
  | 'groq'
  | 'xai'
  | 'openrouter';

export type ProviderFetchStrategy =
  | 'none'
  | 'openai-oauth'
  | 'openai-compatible-alternate';

export type ProviderModelInvocationMethod =
  | 'call'
  | 'chat'
  | 'responses'
  | 'chatModel';

export interface ProviderSdkInstancePlan {
  sourceProvider: SupportedProvider;
  sdk: ProviderSdkAdapter;
  name?: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  region?: string;
  headers?: Record<string, string>;
  fetchStrategy: ProviderFetchStrategy;
  oauthTokenFilePath?: string;
}

export interface ProviderModelInvocationPlan {
  method: ProviderModelInvocationMethod;
  modelId: string;
  supportsPromptCaching: boolean;
}

export interface ProviderModelCreationPlan {
  instance: ProviderSdkInstancePlan;
  invocation: ProviderModelInvocationPlan;
}

export function detectProviderFromModel(modelId: string): SupportedProvider | undefined {
  for (const [prefix, provider] of Object.entries(MODEL_PROVIDER_MAP)) {
    if (modelId.startsWith(prefix)) {
      return provider;
    }
  }
  return undefined;
}

export function getKnownModelProviderPrefixes(): string[] {
  return Object.keys(MODEL_PROVIDER_MAP);
}

export function isAnthropicOAuthToken(token: string | undefined): boolean {
  if (!token) return false;
  return token.startsWith('sk-ant-oa') || token.startsWith('sk-ant-ort');
}

export function isOfficialAnthropicBaseUrl(baseURL: string | undefined): boolean {
  if (!baseURL) return true;

  try {
    const { hostname } = new URL(baseURL);
    return hostname === 'api.anthropic.com' || hostname.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}

export function normalizeAnthropicBaseUrl(baseURL: string | undefined): string | undefined {
  return normalizeCompatibleBaseUrl(baseURL, isOfficialAnthropicBaseUrl);
}

export function isOfficialOpenAIBaseUrl(baseURL: string | undefined): boolean {
  if (!baseURL) return true;

  try {
    const { hostname } = new URL(baseURL);
    return (
      hostname === 'openai.com' ||
      hostname.endsWith('.openai.com') ||
      hostname === 'chatgpt.com' ||
      hostname.endsWith('.chatgpt.com')
    );
  } catch {
    return false;
  }
}

export function normalizeOpenAICompatibleBaseUrl(baseURL: string | undefined): string | undefined {
  return normalizeCompatibleBaseUrl(baseURL, isOfficialOpenAIBaseUrl);
}

export function normalizeOllamaBaseUrl(baseURL: string | undefined): string {
  const resolvedBaseURL = baseURL ?? DEFAULT_OLLAMA_BASE_URL;
  if (resolvedBaseURL.endsWith('/v1')) {
    return resolvedBaseURL;
  }
  return resolvedBaseURL.replace(/\/+$/, '') + '/v1';
}

export function normalizeDeepSeekBaseUrl(baseURL: string | undefined): string {
  return normalizeOpenAICompatibleBaseUrl(baseURL ?? 'https://api.deepseek.com') ?? DEFAULT_DEEPSEEK_BASE_URL;
}

export function shouldUseOpenAICompatibleChat(
  config: Pick<ProviderConfig, 'provider' | 'baseURL' | 'oauthTokenFilePath'>,
): boolean {
  return (
    config.provider === SupportedProviderValue.OpenAI &&
    !config.oauthTokenFilePath &&
    !isOfficialOpenAIBaseUrl(config.baseURL)
  );
}

export function isCodexModel(modelId: string | undefined): boolean {
  return modelId?.toLowerCase().includes('codex') ?? false;
}

export function isResponsesApiModel(modelId: string | undefined): boolean {
  if (!modelId) return false;

  return (
    modelId.startsWith('gpt-5') ||
    isCodexModel(modelId) ||
    modelId === 'o3' ||
    modelId.startsWith('o3-') ||
    modelId === 'o4-mini' ||
    modelId.startsWith('o4-')
  );
}

export function buildAlternateOpenAICompatibleUrl(requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl);
    const suffix = OPENAI_API_SUFFIXES.find((candidate) => url.pathname.endsWith(candidate));
    if (!suffix) return null;

    const prefix = url.pathname.slice(0, -suffix.length);
    const alternatePrefix = prefix.endsWith('/v1')
      ? prefix.slice(0, -3)
      : `${prefix.replace(/\/+$/, '')}/v1`;

    const alternatePath = `${alternatePrefix}${suffix}` || suffix;
    if (alternatePath === url.pathname) return null;

    url.pathname = alternatePath.replace(/\/{2,}/g, '/');
    return url.toString();
  } catch {
    return null;
  }
}

export function buildProviderSdkInstancePlan(config: ProviderConfig): ProviderSdkInstancePlan {
  const { provider, apiKey, baseURL, headers } = config;

  switch (provider) {
    case SupportedProviderValue.Anthropic: {
      const normalizedBaseURL = normalizeAnthropicBaseUrl(baseURL);
      const useOAuth = isAnthropicOAuthToken(apiKey);
      const resolvedHeaders = withAnthropicBetaHeader(
        headers,
        isOfficialAnthropicBaseUrl(normalizedBaseURL),
      );

      return {
        sourceProvider: provider,
        sdk: 'anthropic',
        ...(useOAuth ? { authToken: apiKey } : { apiKey }),
        baseURL: normalizedBaseURL,
        headers: resolvedHeaders,
        fetchStrategy: 'none',
      };
    }

    case SupportedProviderValue.OpenAI:
      return {
        sourceProvider: provider,
        sdk: 'openai',
        apiKey: config.oauthTokenFilePath ? (apiKey ?? 'codex-oauth-placeholder') : apiKey,
        baseURL,
        headers,
        fetchStrategy: config.oauthTokenFilePath ? 'openai-oauth' : 'none',
        oauthTokenFilePath: config.oauthTokenFilePath,
      };

    case SupportedProviderValue.OpenAICompatible:
      return {
        sourceProvider: provider,
        sdk: 'openai-compatible',
        name: 'openai-compatible',
        apiKey: apiKey ?? 'custom-endpoint',
        baseURL: normalizeOpenAICompatibleBaseUrl(baseURL) ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
        headers,
        fetchStrategy: 'openai-compatible-alternate',
      };

    case SupportedProviderValue.Google:
      return {
        sourceProvider: provider,
        sdk: 'google',
        apiKey,
        baseURL,
        headers,
        fetchStrategy: 'none',
      };

    case SupportedProviderValue.Bedrock:
      return {
        sourceProvider: provider,
        sdk: 'bedrock',
        apiKey,
        region: config.region ?? 'us-east-1',
        fetchStrategy: 'none',
      };

    case SupportedProviderValue.Azure:
      return {
        sourceProvider: provider,
        sdk: 'azure',
        apiKey,
        baseURL,
        headers,
        fetchStrategy: 'none',
      };

    case SupportedProviderValue.Mistral:
      return {
        sourceProvider: provider,
        sdk: 'mistral',
        apiKey,
        baseURL,
        headers,
        fetchStrategy: 'none',
      };

    case SupportedProviderValue.Groq:
      return {
        sourceProvider: provider,
        sdk: 'groq',
        apiKey,
        baseURL,
        headers,
        fetchStrategy: 'none',
      };

    case SupportedProviderValue.XAI:
      return {
        sourceProvider: provider,
        sdk: 'xai',
        apiKey,
        baseURL,
        headers,
        fetchStrategy: 'none',
      };

    case SupportedProviderValue.OpenRouter:
      return {
        sourceProvider: provider,
        sdk: 'openrouter',
        apiKey,
        fetchStrategy: 'none',
      };

    case SupportedProviderValue.ZAI:
      return {
        sourceProvider: provider,
        sdk: 'openai-compatible',
        name: 'zai',
        apiKey,
        baseURL: baseURL ?? DEFAULT_ZAI_BASE_URL,
        headers,
        fetchStrategy: 'none',
      };

    case SupportedProviderValue.DeepSeek:
      return {
        sourceProvider: provider,
        sdk: 'openai-compatible',
        name: 'deepseek',
        apiKey,
        baseURL: normalizeDeepSeekBaseUrl(baseURL),
        headers,
        fetchStrategy: 'openai-compatible-alternate',
      };

    case SupportedProviderValue.Ollama:
      return {
        sourceProvider: provider,
        sdk: 'openai-compatible',
        name: 'ollama',
        apiKey: apiKey ?? 'ollama',
        baseURL: normalizeOllamaBaseUrl(baseURL),
        headers,
        fetchStrategy: 'none',
      };
  }
}

export function buildProviderModelCreationPlan(
  config: ProviderConfig,
  modelId: string,
): ProviderModelCreationPlan {
  switch (config.provider) {
    case SupportedProviderValue.Azure:
      return {
        instance: buildProviderSdkInstancePlan(config),
        invocation: {
          method: 'chat',
          modelId: config.deploymentName ?? modelId,
          supportsPromptCaching: false,
        },
      };

    case SupportedProviderValue.Anthropic:
      return {
        instance: buildProviderSdkInstancePlan(config),
        invocation: {
          method: 'call',
          modelId,
          supportsPromptCaching: isOfficialAnthropicBaseUrl(config.baseURL),
        },
      };

    case SupportedProviderValue.OpenAI:
      return buildOpenAIModelCreationPlan(config, modelId);

    case SupportedProviderValue.OpenAICompatible:
      return buildOpenAICompatibleModelCreationPlan(config, modelId);

    case SupportedProviderValue.DeepSeek:
      return {
        instance: buildProviderSdkInstancePlan(config),
        invocation: {
          method: 'chatModel',
          modelId,
          supportsPromptCaching: false,
        },
      };

    default:
      return {
        instance: buildProviderSdkInstancePlan(config),
        invocation: {
          method: 'call',
          modelId,
          supportsPromptCaching: false,
        },
      };
  }
}

function buildOpenAIModelCreationPlan(
  config: ProviderConfig,
  modelId: string,
): ProviderModelCreationPlan {
  const isOfficialBaseUrl = isOfficialOpenAIBaseUrl(config.baseURL);

  if (config.oauthTokenFilePath && !isOfficialBaseUrl) {
    return {
      instance: buildOpenAICompatibleChatInstancePlan(config, 'openai-oauth'),
      invocation: {
        method: 'chatModel',
        modelId,
        supportsPromptCaching: false,
      },
    };
  }

  if (config.oauthTokenFilePath || (isResponsesApiModel(modelId) && isOfficialBaseUrl)) {
    return {
      instance: buildProviderSdkInstancePlan(config),
      invocation: {
        method: 'responses',
        modelId,
        supportsPromptCaching: isOfficialBaseUrl,
      },
    };
  }

  if (shouldUseOpenAICompatibleChat(config)) {
    return {
      instance: buildOpenAICompatibleChatInstancePlan(config, 'openai-compatible-alternate'),
      invocation: {
        method: 'chatModel',
        modelId,
        supportsPromptCaching: false,
      },
    };
  }

  return {
    instance: buildProviderSdkInstancePlan(config),
    invocation: {
      method: 'chat',
      modelId,
      supportsPromptCaching: isOfficialBaseUrl,
    },
  };
}

function buildOpenAICompatibleModelCreationPlan(
  config: ProviderConfig,
  modelId: string,
): ProviderModelCreationPlan {
  if (isResponsesApiModel(modelId) && isOfficialOpenAIBaseUrl(config.baseURL)) {
    return {
      instance: {
        sourceProvider: config.provider,
        sdk: 'openai',
        apiKey: config.apiKey ?? 'custom-endpoint',
        baseURL: normalizeOpenAICompatibleBaseUrl(config.baseURL) ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
        headers: config.headers,
        fetchStrategy: 'none',
      },
      invocation: {
        method: 'responses',
        modelId,
        supportsPromptCaching: false,
      },
    };
  }

  return {
    instance: buildProviderSdkInstancePlan(config),
    invocation: {
      method: 'chatModel',
      modelId,
      supportsPromptCaching: false,
    },
  };
}

function buildOpenAICompatibleChatInstancePlan(
  config: ProviderConfig,
  fetchStrategy: ProviderFetchStrategy,
): ProviderSdkInstancePlan {
  return {
    sourceProvider: config.provider,
    sdk: 'openai-compatible',
    name: 'openai-compatible',
    apiKey: config.apiKey ?? 'custom-endpoint',
    baseURL: normalizeOpenAICompatibleBaseUrl(config.baseURL) ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    headers: config.headers,
    fetchStrategy,
    oauthTokenFilePath: config.oauthTokenFilePath,
  };
}

function withAnthropicBetaHeader(
  headers: Record<string, string> | undefined,
  enabled: boolean,
): Record<string, string> | undefined {
  if (!enabled) return headers;
  return {
    ...headers,
    'anthropic-beta': ANTHROPIC_CLAUDE_CODE_BETA_HEADER,
  };
}

function normalizeCompatibleBaseUrl(
  baseURL: string | undefined,
  isOfficialBaseUrl: (baseURL: string | undefined) => boolean,
): string | undefined {
  if (!baseURL) return baseURL;

  if (isOfficialBaseUrl(baseURL)) {
    return baseURL;
  }

  try {
    const url = new URL(baseURL);
    const pathname = url.pathname;

    if (pathname.endsWith('/v1') || pathname.endsWith('/v1/')) {
      return baseURL;
    }

    if (pathname.includes('/v1/') || pathname.includes('/v1')) {
      return baseURL;
    }

    url.pathname = pathname.replace(/\/+$/, '') + '/v1';
    return url.toString();
  } catch {
    return baseURL;
  }
}
