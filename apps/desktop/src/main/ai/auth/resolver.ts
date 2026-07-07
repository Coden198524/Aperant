/**
 * AI Auth Resolver
 *
 * Multi-stage credential resolution for Vercel AI SDK providers.
 * Reuses existing claude-profile/credential-utils.ts for OAuth token retrieval.
 *
 * Fallback chain (in priority order):
 * 1. Profile-specific OAuth token (from credential-utils keychain/credential store)
 * 2. Profile-specific API key (from app settings)
 * 3. Environment variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
 * 4. Default provider credentials (no-auth for Ollama, etc.)
 *
 * This module does NOT rewrite credential storage — it imports from
 * existing claude-profile/ utilities.
 */

import * as path from 'node:path';
import { ensureValidToken, reactiveTokenRefresh } from '../../claude-profile/token-refresh';
import {
  detectProviderFromModel as detectProviderFromModelCore,
  type AutocodeModelProviderRoute,
  type SupportedProvider,
} from '@autocode/core';
import { detectProviderFromModel } from '../providers/factory';
import type {
  AuthResolverContext,
  AuthSettingsAccessor,
  QueueResolvedAuth,
  ResolvedAuth,
} from './types';
import {
  BUILTIN_TO_SUPPORTED_PROVIDER,
  PROVIDER_BASE_URL_ENV,
  buildProviderAccountQueueConfig,
  parseProviderAccounts,
  resolveApiKeyProviderAccountAuth,
  resolveDefaultProviderAuth,
  resolveProviderEnvironmentAuth,
  resolveProviderSettingsAuth,
} from './types';
import type { ProviderAccount } from '../../../shared/types/provider-account';
import type { BuiltinProvider } from '../../../shared/types/provider-account';
import { resolveModelEquivalent } from '../../../shared/constants/models';
import { scoreProviderAccount } from '../../claude-profile/profile-scorer';
import type { ClaudeAutoSwitchSettings } from '../../../shared/types/agent';

// ============================================
// Settings Accessor
// ============================================

/**
 * Function type for retrieving a global API key from app settings.
 * Injected to avoid circular dependency on settings-store.
 */
let _getSettingsValue: AuthSettingsAccessor | null = null;

/**
 * Register a settings accessor function.
 * Called once during app initialization to wire up settings access.
 *
 * @param accessor - Function that retrieves a value from AppSettings by key
 */
export function registerSettingsAccessor(accessor: AuthSettingsAccessor): void {
  _getSettingsValue = accessor;
}

// ============================================
// Stage 0: Provider Account (Unified Accounts)
// ============================================

/**
 * Attempt to resolve credentials from unified ProviderAccount in settings.
 * This is the highest priority stage — checks providerAccounts array.
 */
async function resolveFromProviderAccount(ctx: AuthResolverContext): Promise<ResolvedAuth | null> {
  if (!_getSettingsValue) return null;

  const accounts = parseProviderAccounts(_getSettingsValue('providerAccounts'));
  const account = accounts.find(a => a.provider === ctx.provider && a.isActive);
  if (!account) return null;

  // File-based OAuth accounts (e.g., OpenAI Codex)
  if (account.authType === 'oauth' && account.provider === 'openai') {
    // Resolve token file path on main thread (has electron.app access)
    const { app } = await import('electron');
    const tokenFilePath = path.join(app.getPath('userData'), 'codex-auth.json');
    const { ensureValidOAuthToken } = await import('../providers/oauth-fetch');
    const token = await ensureValidOAuthToken(tokenFilePath, 'openai');
    if (token) {
      return {
        apiKey: 'codex-oauth-placeholder', // Dummy key; real token injected via custom fetch
        source: 'codex-oauth',
        oauthTokenFilePath: tokenFilePath,
      };
    }
    return null;
  }

  // OAuth accounts — delegate to profile OAuth flow
  if (account.authType === 'oauth' && account.claudeProfileId) {
    // Let the existing OAuth stage handle it
    return null;
  }

  return resolveApiKeyProviderAccountAuth(account, ctx.provider);
}

// ============================================
// Stage 1: Profile OAuth Token
// ============================================

/**
 * Attempt to resolve credentials from the profile's OAuth token store.
 * Only applicable for Anthropic provider (Claude profiles use OAuth).
 * Calls ensureValidToken() for proactive token refresh before expiry.
 *
 * @param ctx - Auth resolution context
 * @returns Resolved auth or null if not available
 */
async function resolveFromProfileOAuth(ctx: AuthResolverContext): Promise<ResolvedAuth | null> {
  if (ctx.provider !== 'anthropic') return null;

  try {
    const tokenResult = await ensureValidToken(ctx.configDir);
    if (tokenResult.token) {
      const resolved: ResolvedAuth = {
        apiKey: tokenResult.token,
        source: 'profile-oauth',
      };

      // Check for custom base URL from environment (profile may set ANTHROPIC_BASE_URL)
      const baseUrlEnv = PROVIDER_BASE_URL_ENV[ctx.provider];
      if (baseUrlEnv) {
        const baseURL = process.env[baseUrlEnv];
        if (baseURL) {
          resolved.baseURL = baseURL;
        }
      }

      // Only add beta header for official Anthropic API endpoints
      // Third-party API gateways may not support these beta features
      const isOfficialApi = !resolved.baseURL ||
        resolved.baseURL.includes('api.anthropic.com') ||
        resolved.baseURL.includes('.anthropic.com');

      if (isOfficialApi) {
        // OAuth tokens require the beta header for Anthropic API
        resolved.headers = {
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14'
        };
      }

      return resolved;
    }
  } catch {
    // Token refresh failed (network, keychain locked, etc.) — fall through
  }

  return null;
}

/**
 * Perform a reactive OAuth token refresh (called on 401 errors).
 * Forces a refresh regardless of apparent token state.
 *
 * @param configDir - Config directory for the profile
 * @returns New token or null if refresh failed
 */
export async function refreshOAuthTokenReactive(configDir: string | undefined): Promise<string | null> {
  try {
    const result = await reactiveTokenRefresh(configDir);
    return result.token ?? null;
  } catch {
    return null;
  }
}

// ============================================
// Stage 2: Profile API Key (from settings)
// ============================================

/**
 * Attempt to resolve credentials from profile-specific API key in app settings.
 *
 * @param ctx - Auth resolution context
 * @returns Resolved auth or null if not available
 */
function resolveFromProfileApiKey(ctx: AuthResolverContext): ResolvedAuth | null {
  return resolveProviderSettingsAuth(ctx, _getSettingsValue, (key) => process.env[key]);
}

// ============================================
// Stage 3: Environment Variable
// ============================================

/**
 * Attempt to resolve credentials from environment variables.
 *
 * @param ctx - Auth resolution context
 * @returns Resolved auth or null if not available
 */
function resolveFromEnvironment(ctx: AuthResolverContext): ResolvedAuth | null {
  return resolveProviderEnvironmentAuth(ctx, (key) => process.env[key]);
}

// ============================================
// Stage 4: Default Provider Credentials
// ============================================

/**
 * Attempt to resolve default credentials for providers that don't require auth.
 *
 * @param ctx - Auth resolution context
 * @returns Resolved auth or null if provider requires auth
 */
function resolveDefaultCredentials(ctx: AuthResolverContext): ResolvedAuth | null {
  return resolveDefaultProviderAuth(ctx);
}

// ============================================
// Public API
// ============================================

/**
 * Resolve authentication credentials for a given provider and profile.
 *
 * Walks the multi-stage fallback chain in priority order:
 * 1. Profile OAuth token (Anthropic only, from system keychain, with proactive refresh)
 * 2. Profile API key (from app settings)
 * 3. Environment variable
 * 4. Default provider credentials (no-auth providers like Ollama)
 *
 * @param ctx - Auth resolution context (provider, profileId, configDir)
 * @returns Resolved auth credentials, or null if no credentials found
 */
export async function resolveAuth(ctx: AuthResolverContext): Promise<ResolvedAuth | null> {
  return (
    (await resolveFromProviderAccount(ctx)) ??
    (await resolveFromProfileOAuth(ctx)) ??
    resolveFromProfileApiKey(ctx) ??
    resolveFromEnvironment(ctx) ??
    resolveDefaultCredentials(ctx) ??
    null
  );
}

/**
 * Check if credentials are available for a provider without returning them.
 * Useful for UI validation and provider availability checks.
 *
 * @param ctx - Auth resolution context
 * @returns True if credentials can be resolved
 */
export async function hasCredentials(ctx: AuthResolverContext): Promise<boolean> {
  return (await resolveAuth(ctx)) !== null;
}

// ============================================
// Queue-Based Resolution (Global Priority Queue)
// ============================================

/**
 * Resolve auth from the global priority queue.
 *
 * Algorithm:
 * 1. Walk queue in order
 * 2. Skip excluded accounts (previously failed)
 * 3. Check availability (scoring: subscription = check limits, pay-per-use = always available)
 * 4. Find model equivalent for account's provider (user overrides → defaults)
 * 5. Resolve credentials (OAuth token refresh, API key, etc.)
 * 6. Return first match with resolved model + reasoning config
 */
export async function resolveAuthFromQueue(
  requestedModel: string,
  queue: ProviderAccount[],
  options?: {
    excludeAccountIds?: string[];
    userModelOverrides?: Record<string, Partial<Record<BuiltinProvider, import('../../../shared/constants/models').ProviderModelSpec>>>;
    autoSwitchSettings?: ClaudeAutoSwitchSettings;
    executionMode?: 'standard' | 'agentic';
    modelProviderRoutes?: readonly AutocodeModelProviderRoute[];
    requestedProvider?: SupportedProvider;
  }
): Promise<QueueResolvedAuth | null> {
  const excludeSet = new Set(options?.excludeAccountIds ?? []);
  const requestedProvider = options?.requestedProvider ?? (options?.modelProviderRoutes
    ? detectProviderFromModelCore(requestedModel, options.modelProviderRoutes)
    : detectProviderFromModel(requestedModel));
  const defaultSettings: ClaudeAutoSwitchSettings = {
    enabled: true,
    proactiveSwapEnabled: false,
    sessionThreshold: 95,
    weeklyThreshold: 99,
    autoSwitchOnRateLimit: true,
    autoSwitchOnAuthFailure: true,
    usageCheckInterval: 30000,
  };
  const settings = options?.autoSwitchSettings ?? defaultSettings;

  for (const account of queue) {
    // Skip excluded accounts
    if (excludeSet.has(account.id)) continue;

    // Score account availability
    const { available } = scoreProviderAccount(account, settings);
    if (!available) continue;

    // Map BuiltinProvider to SupportedProvider
    const supportedProvider = BUILTIN_TO_SUPPORTED_PROVIDER[account.provider];
    if (!supportedProvider) continue;

    // Use modelEquivalenceProvider if specified, otherwise use the account's provider
    const equivalenceProvider = account.modelEquivalenceProvider ?? account.provider;
    const isOpenAIProviderPair = (
      (requestedProvider === 'openai' && supportedProvider === 'openai-compatible') ||
      (requestedProvider === 'openai-compatible' && supportedProvider === 'openai')
    );
    const canUseCrossProviderEquivalence = requestedProvider === undefined;
    const canUseSameProviderEquivalence = requestedProvider === supportedProvider || isOpenAIProviderPair;

    // Resolve which model to use on this account.
    // Only shorthand models should cross-map between providers. Fully-qualified
    // model IDs (e.g. gpt-5.4) remain provider-strict.
    const modelSpec = (canUseCrossProviderEquivalence || canUseSameProviderEquivalence)
      ? resolveModelEquivalent(
        requestedModel,
        equivalenceProvider,
        options?.userModelOverrides,
      )
      : null;

    if (!modelSpec) {
      if (requestedProvider) {
        // For full model IDs, require provider match (OpenAI and OpenAI-compatible
        // are treated as compatible for custom endpoints).
        if (supportedProvider === 'ollama' && requestedProvider !== 'ollama') continue;
        if (
          supportedProvider !== requestedProvider &&
          !isOpenAIProviderPair &&
          supportedProvider !== 'ollama'
        ) {
          continue;
        }
      } else {
        // For shorthand/unknown models, if no equivalence is available then only
        // Ollama can still accept arbitrary local model names.
        if (supportedProvider !== 'ollama') continue;
      }
    }

    const resolvedModelId = modelSpec?.modelId ?? requestedModel;
    const reasoningConfig = modelSpec?.reasoning ?? { type: 'none' as const };

    // Resolve credentials for this account
    const auth = await resolveCredentialsForAccount(account, supportedProvider);
    if (!auth) continue;

    // Success — return the fully resolved auth
    return {
      ...auth,
      accountId: account.id,
      resolvedProvider: supportedProvider,
      resolvedModelId,
      reasoningConfig,
    };
  }

  return null;
}

/**
 * Build a default queue config from app settings.
 * Reads providerAccounts and globalPriorityOrder, sorts accounts
 * by the priority order, and returns a queueConfig object compatible
 * with createSimpleClient() / createAgentClient().
 *
 * Returns undefined if no provider accounts are configured.
 */
export function buildDefaultQueueConfig(
  requestedModel: string,
): { queue: ProviderAccount[]; requestedModel: string } | undefined {
  const queueConfig = buildProviderAccountQueueConfig(requestedModel, _getSettingsValue);
  if (!queueConfig) return undefined;

  return {
    queue: queueConfig.queue as ProviderAccount[],
    requestedModel: queueConfig.requestedModel,
  };
}

/**
 * Resolve credentials for a specific ProviderAccount.
 * Handles OAuth token refresh, API keys, and Codex OAuth.
 */
async function resolveCredentialsForAccount(
  account: ProviderAccount,
  provider: SupportedProvider,
): Promise<ResolvedAuth | null> {
  // File-based OAuth (e.g., OpenAI Codex subscription)
  if (account.authType === 'oauth' && account.provider === 'openai') {
    try {
      const { app } = await import('electron');
      const tokenFilePath = path.join(app.getPath('userData'), 'codex-auth.json');
      const { ensureValidOAuthToken } = await import('../providers/oauth-fetch');
      const token = await ensureValidOAuthToken(tokenFilePath, 'openai');
      if (token) {
        return {
          apiKey: 'codex-oauth-placeholder',
          source: 'codex-oauth',
          oauthTokenFilePath: tokenFilePath,
        };
      }
    } catch { /* fall through */ }
    return null;
  }

  // Anthropic OAuth — refresh token via existing claude-profile system
  if (account.authType === 'oauth' && account.provider === 'anthropic') {
    if (account.claudeProfileId) {
      // Delegate to profile OAuth resolution
      const ctx: AuthResolverContext = { provider, profileId: account.claudeProfileId };
      return resolveAuth(ctx);
    }
    return null;
  }

  return resolveApiKeyProviderAccountAuth(account, provider);
}
