import {
  buildProviderModelCreationPlan,
  parseAutocodeProviderModelInvocationRoutes,
  type AutocodeProviderModelInvocationRouteConfig,
  type SupportedProvider,
} from '@autocode/core';
import type { SessionConfig, SessionResult } from '../session/types';
import type { SerializableSessionConfig } from './types';

export const CODEX_OAUTH_RESPONSES_TRANSPORT = 'openai.codex-oauth.responses';

export function normalizeProviderBaseUrl(baseURL: string | undefined): string | null {
  if (!baseURL) return null;
  try {
    const parsed = new URL(baseURL);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return baseURL.trim().toLowerCase();
  }
}

export function resolveProviderFallbackCacheKey(
  session: Pick<SerializableSessionConfig, 'provider' | 'modelId' | 'baseURL' | 'providerTransport' | 'providerFallback'>,
): string | null {
  const runtime = session.providerFallback;
  if (!runtime) {
    return null;
  }

  const baseUrl = normalizeProviderBaseUrl(session.baseURL);
  const target = baseUrl || [session.provider, session.providerTransport, session.modelId]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(':');
  return target ? `${runtime.capabilityId}:${target}` : null;
}

export function supportsProviderFallbackTransport(
  session: Pick<SerializableSessionConfig, 'providerFallback'>,
): boolean {
  return Boolean(session.providerFallback);
}

export function shouldFallbackForProviderError(
  result: Pick<SessionResult, 'outcome' | 'error'>,
  session: Pick<SerializableSessionConfig, 'providerFallback'>,
): boolean {
  if (result.outcome !== 'error') return false;
  return matchesProviderFallbackError(session.providerFallback, result.error?.message);
}

export function shouldForceProviderFallbackTransport(
  session: Pick<SerializableSessionConfig, 'provider' | 'modelId' | 'baseURL' | 'providerTransport' | 'providerFallback'>,
  brokenFallbacks: ReadonlySet<string>,
): boolean {
  const cacheKey = resolveProviderFallbackCacheKey(session);
  return Boolean(cacheKey && brokenFallbacks.has(cacheKey) && supportsProviderFallbackTransport(session));
}

export function resolveProviderFallbackTransport(
  session: Pick<SerializableSessionConfig, 'provider' | 'providerFallback'>,
): string {
  const runtime = session.providerFallback;
  const provider = session.provider?.trim();
  if (!runtime) {
    return provider || 'fallback';
  }
  return resolveFallbackTransport(runtime, provider || '');
}

export function buildProviderFallbackInvocationRoutes(
  session: Pick<SerializableSessionConfig, 'provider' | 'providerFallback'>,
): AutocodeProviderModelInvocationRouteConfig[] {
  const runtime = session.providerFallback;
  const provider = session.provider?.trim();
  if (!runtime || !provider) {
    return [];
  }
  return [{ provider, method: runtime.fallbackInvocationMethod }];
}

export function mergeProviderFallbackInvocationRoutes(
  session: Pick<SerializableSessionConfig, 'provider' | 'providerFallback' | 'providerModelInvocationRoutes'>,
): AutocodeProviderModelInvocationRouteConfig[] | AutocodeProviderModelInvocationRouteConfig | undefined {
  const fallbackRoutes = buildProviderFallbackInvocationRoutes(session);
  if (fallbackRoutes.length === 0) {
    return session.providerModelInvocationRoutes;
  }
  const configured = readProviderModelInvocationRouteConfigs(session.providerModelInvocationRoutes);
  return [...fallbackRoutes, ...configured];
}

export function resolveSessionProviderTransport(
  session: Pick<SerializableSessionConfig,
    | 'provider'
    | 'apiKey'
    | 'baseURL'
    | 'oauthTokenFilePath'
    | 'providerModelInvocationRoutes'
  >,
  modelId: string,
): string | undefined {
  const provider = session.provider?.trim();
  if (!provider) {
    return undefined;
  }

  try {
    const plan = buildProviderModelCreationPlan({
      provider: provider as SupportedProvider,
      apiKey: session.apiKey,
      baseURL: session.baseURL,
      oauthTokenFilePath: session.oauthTokenFilePath,
    }, modelId, {
      invocationRoutes: parseAutocodeProviderModelInvocationRoutes(session.providerModelInvocationRoutes),
    });
    if (
      provider === 'openai' &&
      session.oauthTokenFilePath &&
      plan.invocation.method === 'responses'
    ) {
      return CODEX_OAUTH_RESPONSES_TRANSPORT;
    }
    return `${provider}.${plan.invocation.method}`;
  } catch {
    return provider;
  }
}

export function resolveEffectiveSessionProviderTransport(
  session: Pick<SerializableSessionConfig,
    | 'provider'
    | 'apiKey'
    | 'baseURL'
    | 'oauthTokenFilePath'
    | 'providerTransport'
    | 'providerModelInvocationRoutes'
    | 'modelId'
    | 'providerFallback'
  >,
  modelId: string,
  brokenFallbacks: ReadonlySet<string>,
): string | undefined {
  if (shouldForceProviderFallbackTransport(session, brokenFallbacks)) {
    return resolveProviderFallbackTransport(session);
  }
  return session.providerTransport ?? resolveSessionProviderTransport(session, modelId);
}

export function buildProviderFallbackSessionConfigOverrides(
  session: Pick<SerializableSessionConfig, 'provider' | 'providerFallback'>,
): Partial<Pick<SessionConfig,
  | 'providerTransport'
  | 'responsePersistence'
  | 'previousResponseId'
  | 'providerOptions'
  | 'providerResponseIdFields'
  | 'providerResponsePersistence'
>> {
  const base = {
    providerTransport: resolveProviderFallbackTransport(session),
  };
  if (session.providerFallback?.resetProviderPersistence === false) {
    return base;
  }
  return {
    ...base,
    responsePersistence: false,
    previousResponseId: undefined,
    providerOptions: undefined,
    providerResponseIdFields: undefined,
    providerResponsePersistence: undefined,
  };
}

function readProviderModelInvocationRouteConfigs(value: unknown): AutocodeProviderModelInvocationRouteConfig[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.filter((item): item is AutocodeProviderModelInvocationRouteConfig =>
    Boolean(item && typeof item === 'object' && !Array.isArray(item)),
  );
}
function resolveFallbackTransport(
  runtime: NonNullable<SerializableSessionConfig['providerFallback']>,
  provider: string,
): string {
  const template = runtime.fallbackProviderTransport?.trim();
  if (template) {
    return template
      .replace(/\$\{provider\}|\{provider\}/g, provider)
      .replace(/\$\{method\}|\{method\}/g, runtime.fallbackInvocationMethod);
  }
  return provider ? `${provider}.${runtime.fallbackInvocationMethod}` : runtime.fallbackInvocationMethod;
}

function matchesProviderFallbackError(
  runtime: SerializableSessionConfig['providerFallback'],
  message: unknown,
): boolean {
  const normalizedMessage = typeof message === 'string' && message.trim()
    ? message.trim().toLowerCase()
    : null;
  if (!runtime || !normalizedMessage) {
    return false;
  }
  return runtime.errorMatchers.some((matcher) =>
    matcher.messageIncludes.every((item) => normalizedMessage.includes(item.toLowerCase()))
  );
}
