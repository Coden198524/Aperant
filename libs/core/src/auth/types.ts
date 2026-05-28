import type { ReasoningConfig } from '../config/types.js';
import type { SupportedProvider } from '../providers/types.js';
import { SupportedProvider as SupportedProviderValue } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Shared provider account shape
// ---------------------------------------------------------------------------

export type BuiltinProvider =
  | SupportedProvider
  | 'amazon-bedrock';

export type ProviderAccountAuthType = 'oauth' | 'api-key';
export type BillingModel = 'subscription' | 'pay-per-use';

export interface ProviderAccountLike {
  id?: string;
  provider: BuiltinProvider | string;
  name?: string;
  authType?: ProviderAccountAuthType;
  billingModel?: BillingModel;
  isActive?: boolean;
  apiKey?: string;
  baseUrl?: string;
  region?: string;
  claudeProfileId?: string;
  modelEquivalenceProvider?: BuiltinProvider | string;
}

// ---------------------------------------------------------------------------
// Auth source tracking and resolved credentials
// ---------------------------------------------------------------------------

export type AuthSource =
  | 'profile-oauth'
  | 'codex-oauth'
  | 'profile-api-key'
  | 'environment'
  | 'default'
  | 'none';

export interface ResolvedAuth {
  apiKey: string;
  source: AuthSource;
  baseURL?: string;
  headers?: Record<string, string>;
  oauthTokenFilePath?: string;
}

export interface AuthResolverContext {
  provider: SupportedProvider;
  profileId?: string;
  configDir?: string;
}

export interface QueueResolvedAuth extends ResolvedAuth {
  accountId: string;
  resolvedProvider: SupportedProvider;
  resolvedModelId: string;
  reasoningConfig: ReasoningConfig;
}

// ---------------------------------------------------------------------------
// Host adapter contracts
// ---------------------------------------------------------------------------

export type AuthSettingsAccessor = (key: string) => unknown;
export type AuthEnvironmentAccessor = (key: string) => string | undefined;

export interface CredentialSettingsAdapter {
  getSetting(key: string): unknown | Promise<unknown>;
}

export interface ProviderAccountAdapter {
  listProviderAccounts(): ProviderAccountLike[] | Promise<ProviderAccountLike[]>;
  getPriorityOrder?(): string[] | Promise<string[]>;
}

export interface OAuthTokenAdapter {
  resolveProfileToken(ctx: AuthResolverContext): Promise<ResolvedAuth | null>;
  refreshProfileToken?(configDir?: string): Promise<string | null>;
}

export interface OAuthTokenFileAdapter {
  getTokenFilePath(provider: SupportedProvider): string | Promise<string>;
  ensureValidToken(tokenFilePath: string, provider: SupportedProvider): Promise<string | null>;
}

export interface OAuthBrowserAdapter {
  openOAuthUrl(url: string): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Provider mappings
// ---------------------------------------------------------------------------

export const PROVIDER_ENV_VARS: Record<SupportedProvider, string | undefined> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-compatible': undefined,
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  bedrock: undefined,
  azure: 'AZURE_OPENAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  zai: 'ZHIPU_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  ollama: undefined,
} as const;

export const PROVIDER_SETTINGS_KEY: Partial<Record<SupportedProvider, string>> = {
  anthropic: 'globalAnthropicApiKey',
  openai: 'globalOpenAIApiKey',
  google: 'globalGoogleApiKey',
  groq: 'globalGroqApiKey',
  mistral: 'globalMistralApiKey',
  xai: 'globalXAIApiKey',
  azure: 'globalAzureApiKey',
  openrouter: 'globalOpenRouterApiKey',
  zai: 'globalZAIApiKey',
  deepseek: 'globalDeepSeekApiKey',
} as const;

export const PROVIDER_BASE_URL_ENV: Partial<Record<SupportedProvider, string>> = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
  azure: 'AZURE_OPENAI_ENDPOINT',
  'openai-compatible': 'OPENAI_BASE_URL',
  deepseek: 'DEEPSEEK_BASE_URL',
} as const;

export const BUILTIN_TO_SUPPORTED_PROVIDER: Record<string, SupportedProvider> = {
  anthropic: SupportedProviderValue.Anthropic,
  openai: SupportedProviderValue.OpenAI,
  'openai-compatible': SupportedProviderValue.OpenAICompatible,
  google: SupportedProviderValue.Google,
  'amazon-bedrock': SupportedProviderValue.Bedrock,
  bedrock: SupportedProviderValue.Bedrock,
  azure: SupportedProviderValue.Azure,
  mistral: SupportedProviderValue.Mistral,
  groq: SupportedProviderValue.Groq,
  xai: SupportedProviderValue.XAI,
  openrouter: SupportedProviderValue.OpenRouter,
  zai: SupportedProviderValue.ZAI,
  deepseek: SupportedProviderValue.DeepSeek,
  ollama: SupportedProviderValue.Ollama,
};

export const NO_AUTH_PROVIDERS: ReadonlySet<SupportedProvider> = new Set<SupportedProvider>([
  SupportedProviderValue.Ollama,
]);

export const ZAI_GENERAL_API = 'https://api.z.ai/api/paas/v4';
export const ZAI_CODING_API = 'https://api.z.ai/api/coding/paas/v4';

// ---------------------------------------------------------------------------
// Pure auth helpers
// ---------------------------------------------------------------------------

export function toSupportedProvider(provider: string): SupportedProvider | undefined {
  return BUILTIN_TO_SUPPORTED_PROVIDER[provider];
}

export function resolveProviderBaseUrlFromEnvironment(
  provider: SupportedProvider,
  getEnv: AuthEnvironmentAccessor,
): string | undefined {
  const baseUrlEnv = PROVIDER_BASE_URL_ENV[provider];
  return baseUrlEnv ? getEnv(baseUrlEnv) : undefined;
}

export function resolveProviderEnvironmentAuth(
  ctx: AuthResolverContext,
  getEnv: AuthEnvironmentAccessor,
): ResolvedAuth | null {
  const envVar = PROVIDER_ENV_VARS[ctx.provider];
  if (!envVar) return null;

  const apiKey = getEnv(envVar);
  if (!apiKey) return null;

  const resolved: ResolvedAuth = {
    apiKey,
    source: 'environment',
  };

  const baseURL = resolveProviderBaseUrlFromEnvironment(ctx.provider, getEnv);
  if (baseURL) {
    resolved.baseURL = baseURL;
  }

  return resolved;
}

export function resolveProviderSettingsAuth(
  ctx: AuthResolverContext,
  getSetting: AuthSettingsAccessor | null | undefined,
  getEnv: AuthEnvironmentAccessor,
): ResolvedAuth | null {
  if (!getSetting) return null;

  const settingsKey = PROVIDER_SETTINGS_KEY[ctx.provider];
  if (!settingsKey) return null;

  const apiKey = readStringSetting(getSetting(settingsKey));
  if (!apiKey) return null;

  const resolved: ResolvedAuth = {
    apiKey,
    source: 'profile-api-key',
  };

  const baseURL = resolveProviderBaseUrlFromEnvironment(ctx.provider, getEnv);
  if (baseURL) {
    resolved.baseURL = baseURL;
  }

  return resolved;
}

export function resolveDefaultProviderAuth(ctx: AuthResolverContext): ResolvedAuth | null {
  if (!NO_AUTH_PROVIDERS.has(ctx.provider)) return null;

  return {
    apiKey: '',
    source: 'default',
  };
}

export function resolveZaiBaseUrlForBilling(account: Pick<ProviderAccountLike, 'baseUrl' | 'billingModel'>): string {
  if (account.baseUrl) return account.baseUrl;
  return account.billingModel === 'subscription' ? ZAI_CODING_API : ZAI_GENERAL_API;
}

export function resolveApiKeyProviderAccountAuth(
  account: ProviderAccountLike,
  provider = toSupportedProvider(account.provider),
): ResolvedAuth | null {
  if (!provider) return null;

  if (NO_AUTH_PROVIDERS.has(provider)) {
    return {
      apiKey: '',
      source: 'default',
      baseURL: account.baseUrl,
    };
  }

  if (account.authType !== 'api-key' || !account.apiKey) {
    return null;
  }

  return {
    apiKey: account.apiKey,
    source: 'profile-api-key',
    baseURL: provider === SupportedProviderValue.ZAI
      ? resolveZaiBaseUrlForBilling(account)
      : account.baseUrl,
  };
}

export function parseProviderAccounts(value: unknown): ProviderAccountLike[] {
  const parsed = parseMaybeJson(value);
  if (!Array.isArray(parsed)) return [];

  return parsed.filter((account): account is ProviderAccountLike => {
    if (!account || typeof account !== 'object') return false;
    const candidate = account as Partial<ProviderAccountLike>;
    return (
      typeof candidate.provider === 'string' &&
      (
        candidate.authType === undefined ||
        candidate.authType === 'oauth' ||
        candidate.authType === 'api-key'
      )
    );
  });
}

export function parseStringArraySetting(value: unknown): string[] {
  const parsed = parseMaybeJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}

export function sortProviderAccountsByPriority<T extends Pick<ProviderAccountLike, 'id'>>(
  accounts: T[],
  priorityOrder: string[],
): T[] {
  return [...accounts].sort((a, b) => {
    const idxA = a.id ? priorityOrder.indexOf(a.id) : -1;
    const idxB = b.id ? priorityOrder.indexOf(b.id) : -1;
    const effectiveA = idxA === -1 ? Number.POSITIVE_INFINITY : idxA;
    const effectiveB = idxB === -1 ? Number.POSITIVE_INFINITY : idxB;
    return effectiveA - effectiveB;
  });
}

export function buildProviderAccountQueueConfig(
  requestedModel: string,
  getSetting: AuthSettingsAccessor | null | undefined,
): { queue: ProviderAccountLike[]; requestedModel: string } | undefined {
  if (!getSetting) return undefined;

  const accounts = parseProviderAccounts(getSetting('providerAccounts'));
  if (accounts.length === 0) return undefined;

  const priorityOrder = parseStringArraySetting(getSetting('globalPriorityOrder'));
  return {
    queue: sortProviderAccountsByPriority(accounts, priorityOrder),
    requestedModel,
  };
}

function readStringSetting(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
