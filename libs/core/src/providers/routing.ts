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

export type AutocodeModelProviderRouteMatch = string | readonly string[];

export interface AutocodeModelProviderRouteConfig {
  provider: string;
  modelId?: AutocodeModelProviderRouteMatch;
  model_id?: AutocodeModelProviderRouteMatch;
  model?: AutocodeModelProviderRouteMatch;
  modelIdPrefix?: AutocodeModelProviderRouteMatch;
  model_id_prefix?: AutocodeModelProviderRouteMatch;
  modelPrefix?: AutocodeModelProviderRouteMatch;
  model_prefix?: AutocodeModelProviderRouteMatch;
  modelIdIncludes?: AutocodeModelProviderRouteMatch;
  model_id_includes?: AutocodeModelProviderRouteMatch;
  modelIncludes?: AutocodeModelProviderRouteMatch;
  model_includes?: AutocodeModelProviderRouteMatch;
}

export interface AutocodeModelProviderRoute {
  provider: string;
  modelId?: string[];
  modelIdPrefix?: string[];
  modelIdIncludes?: string[];
  supports(modelId: string): boolean;
}

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

export interface AutocodeProviderModelInvocationRouteConfig {
  method: ProviderModelInvocationMethod;
  provider?: AutocodeModelProviderRouteMatch;
  modelId?: AutocodeModelProviderRouteMatch;
  model_id?: AutocodeModelProviderRouteMatch;
  model?: AutocodeModelProviderRouteMatch;
  modelIdPrefix?: AutocodeModelProviderRouteMatch;
  model_id_prefix?: AutocodeModelProviderRouteMatch;
  modelPrefix?: AutocodeModelProviderRouteMatch;
  model_prefix?: AutocodeModelProviderRouteMatch;
  modelIdIncludes?: AutocodeModelProviderRouteMatch;
  model_id_includes?: AutocodeModelProviderRouteMatch;
  modelIncludes?: AutocodeModelProviderRouteMatch;
  model_includes?: AutocodeModelProviderRouteMatch;
}

export interface AutocodeProviderModelInvocationRoute {
  method: ProviderModelInvocationMethod;
  provider?: string[];
  modelId?: string[];
  modelIdPrefix?: string[];
  modelIdIncludes?: string[];
  supports(input: { provider: SupportedProvider; modelId: string }): boolean;
}

export interface ProviderModelCreationPlanOptions {
  invocationRoutes?: readonly AutocodeProviderModelInvocationRoute[];
}

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

export function parseAutocodeModelProviderRoutes(value: unknown): AutocodeModelProviderRoute[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .map(parseAutocodeModelProviderRoute)
    .filter((item): item is AutocodeModelProviderRoute => item !== null);
}

function parseAutocodeModelProviderRoute(value: unknown): AutocodeModelProviderRoute | null {
  const record = asModelProviderRouteRecord(value);
  if (!record) {
    return null;
  }
  const provider = readModelProviderRouteProvider(record.provider);
  const modelId = readModelProviderRouteStringList(record.modelId ?? record.model_id ?? record.model);
  const modelIdPrefix = readModelProviderRouteStringList(
    record.modelIdPrefix ?? record.model_id_prefix ?? record.modelPrefix ?? record.model_prefix,
  );
  const modelIdIncludes = readModelProviderRouteStringList(
    record.modelIdIncludes ?? record.model_id_includes ?? record.modelIncludes ?? record.model_includes,
  );
  if (!provider || (!modelId && !modelIdPrefix && !modelIdIncludes)) {
    return null;
  }
  return {
    provider,
    ...(modelId ? { modelId } : {}),
    ...(modelIdPrefix ? { modelIdPrefix } : {}),
    ...(modelIdIncludes ? { modelIdIncludes } : {}),
    supports: (inputModelId) => matchesModelProviderRoute(inputModelId, { modelId, modelIdPrefix, modelIdIncludes }),
  };
}

export function parseAutocodeProviderModelInvocationRoutes(value: unknown): AutocodeProviderModelInvocationRoute[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .map(parseAutocodeProviderModelInvocationRoute)
    .filter((item): item is AutocodeProviderModelInvocationRoute => item !== null);
}

function parseAutocodeProviderModelInvocationRoute(value: unknown): AutocodeProviderModelInvocationRoute | null {
  const record = asModelProviderRouteRecord(value);
  if (!record) {
    return null;
  }
  const method = readProviderModelInvocationMethod(record.method ?? record.invocationMethod ?? record.invocation_method);
  const provider = readModelProviderRouteStringList(record.provider);
  const modelId = readModelProviderRouteStringList(record.modelId ?? record.model_id ?? record.model);
  const modelIdPrefix = readModelProviderRouteStringList(
    record.modelIdPrefix ?? record.model_id_prefix ?? record.modelPrefix ?? record.model_prefix,
  );
  const modelIdIncludes = readModelProviderRouteStringList(
    record.modelIdIncludes ?? record.model_id_includes ?? record.modelIncludes ?? record.model_includes,
  );
  if (!method || (!provider && !modelId && !modelIdPrefix && !modelIdIncludes)) {
    return null;
  }
  return {
    method,
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
    ...(modelIdPrefix ? { modelIdPrefix } : {}),
    ...(modelIdIncludes ? { modelIdIncludes } : {}),
    supports: (input) => matchesProviderModelInvocationRoute(input, { provider, modelId, modelIdPrefix, modelIdIncludes }),
  };
}

export function resolveProviderModelInvocationMethod(
  provider: SupportedProvider,
  modelId: string,
  routes: readonly AutocodeProviderModelInvocationRoute[] = [],
): ProviderModelInvocationMethod | undefined {
  return routes.find((route) => route.supports({ provider, modelId }))?.method;
}

export function detectProviderFromModel(
  modelId: string,
  routes: readonly AutocodeModelProviderRoute[] = [],
): string | undefined {
  const normalizedModelId = normalizeModelProviderRouteString(modelId);
  if (!normalizedModelId) {
    return undefined;
  }
  return routes.find((route) => route.supports(normalizedModelId))?.provider ??
    detectBuiltinProviderFromModel(normalizedModelId);
}

function detectBuiltinProviderFromModel(modelId: string): SupportedProvider | undefined {
  for (const [match, provider] of Object.entries(MODEL_PROVIDER_MAP)) {
    const isPrefixMatch = match.endsWith('-') || match.endsWith('/');
    if (isPrefixMatch ? modelId.startsWith(match) : modelId === match) {
      return provider;
    }
  }
  return undefined;
}

export function getKnownModelProviderPrefixes(routes: readonly AutocodeModelProviderRoute[] = []): string[] {
  return [
    ...routes.flatMap((route) => route.modelIdPrefix ?? []),
    ...Object.keys(MODEL_PROVIDER_MAP),
  ];
}

function matchesProviderModelInvocationRoute(
  input: { provider: SupportedProvider; modelId: string },
  route: Pick<AutocodeProviderModelInvocationRoute, 'provider' | 'modelId' | 'modelIdPrefix' | 'modelIdIncludes'>,
): boolean {
  const hasModelMatch = Boolean(route.modelId || route.modelIdPrefix || route.modelIdIncludes);
  if (route.provider) {
    const providerMatches = route.provider.some((item) => normalizeModelProviderRouteString(item) === input.provider);
    return providerMatches && (!hasModelMatch || matchesModelProviderRoute(input.modelId, route));
  }
  return matchesModelProviderRoute(input.modelId, route);
}
function matchesModelProviderRoute(
  modelId: string,
  route: Pick<AutocodeModelProviderRoute, 'modelId' | 'modelIdPrefix' | 'modelIdIncludes'>,
): boolean {
  const normalizedModelId = normalizeModelProviderRouteString(modelId);
  if (!normalizedModelId) {
    return false;
  }
  if (route.modelId?.some((item) => normalizeModelProviderRouteString(item) === normalizedModelId)) {
    return true;
  }
  if (route.modelIdPrefix?.some((item) => {
    const normalized = normalizeModelProviderRouteString(item);
    return Boolean(normalized && normalizedModelId.startsWith(normalized));
  })) {
    return true;
  }
  return route.modelIdIncludes?.some((item) => {
    const normalized = normalizeModelProviderRouteString(item);
    return Boolean(normalized && normalizedModelId.includes(normalized));
  }) ?? false;
}

function readProviderModelInvocationMethod(value: unknown): ProviderModelInvocationMethod | undefined {
  const normalized = normalizeModelProviderRouteString(value);
  if (
    normalized === 'call' ||
    normalized === 'chat' ||
    normalized === 'responses' ||
    normalized === 'chatmodel'
  ) {
    return normalized === 'chatmodel' ? 'chatModel' : normalized;
  }
  return undefined;
}
function readSupportedProvider(value: unknown): SupportedProvider | undefined {
  const normalized = normalizeModelProviderRouteString(value);
  if (!normalized) {
    return undefined;
  }
  return (Object.values(SupportedProviderValue) as string[]).includes(normalized)
    ? normalized as SupportedProvider
    : undefined;
}

function readModelProviderRouteProvider(value: unknown): string | undefined {
  return normalizeModelProviderRouteString(value) ?? undefined;
}

function readModelProviderRouteStringList(value: unknown): string[] | undefined {
  const single = readModelProviderRouteString(value);
  if (single) {
    return [single];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.map(readModelProviderRouteString).filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function readModelProviderRouteString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeModelProviderRouteString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function asModelProviderRouteRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
  options: ProviderModelCreationPlanOptions = {},
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
      return buildOpenAIModelCreationPlan(config, modelId, options);

    case SupportedProviderValue.OpenAICompatible:
      return buildOpenAICompatibleModelCreationPlan(config, modelId, options);

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
  options: ProviderModelCreationPlanOptions,
): ProviderModelCreationPlan {
  const isOfficialBaseUrl = isOfficialOpenAIBaseUrl(config.baseURL);
  const routedMethod = resolveProviderModelInvocationMethod(config.provider, modelId, options.invocationRoutes);

  if (routedMethod === 'chatModel' || (!routedMethod && config.oauthTokenFilePath && !isOfficialBaseUrl)) {
    return {
      instance: buildOpenAICompatibleChatInstancePlan(config, 'openai-oauth'),
      invocation: {
        method: 'chatModel',
        modelId,
        supportsPromptCaching: false,
      },
    };
  }

  if (routedMethod === 'responses' || (!routedMethod && (config.oauthTokenFilePath || (isResponsesApiModel(modelId) && isOfficialBaseUrl)))) {
    return {
      instance: buildProviderSdkInstancePlan(config),
      invocation: {
        method: 'responses',
        modelId,
        supportsPromptCaching: isOfficialBaseUrl,
      },
    };
  }

  if (!routedMethod && shouldUseOpenAICompatibleChat(config)) {
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
  options: ProviderModelCreationPlanOptions,
): ProviderModelCreationPlan {
  const routedMethod = resolveProviderModelInvocationMethod(config.provider, modelId, options.invocationRoutes);
  if (routedMethod === 'responses' || (!routedMethod && isResponsesApiModel(modelId) && isOfficialOpenAIBaseUrl(config.baseURL))) {
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
