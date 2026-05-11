import type { APIProfile } from '@shared/types/profile';
import type { ProviderAccount } from '@shared/types/provider-account';
import { readSettingsFile, writeSettingsFile } from '../../settings-utils';

const LEGACY_API_PROFILE_ACCOUNT_PREFIX = 'api-profile:';

export function getAPIProfileProviderAccountId(profileId: string): string {
  return `${LEGACY_API_PROFILE_ACCOUNT_PREFIX}${profileId}`;
}

function isAPIProfileProviderAccountId(accountId: string): boolean {
  return accountId.startsWith(LEGACY_API_PROFILE_ACCOUNT_PREFIX);
}

function sanitizeQueue(queue: unknown, existingIds: Set<string>): string[] {
  if (!Array.isArray(queue)) {
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const accountId of queue) {
    if (
      typeof accountId === 'string' &&
      existingIds.has(accountId) &&
      !seen.has(accountId)
    ) {
      result.push(accountId);
      seen.add(accountId);
    }
  }
  return result;
}

function prependQueueId(queue: string[], accountId: string): string[] {
  return [accountId, ...queue.filter(id => id !== accountId)];
}

function replaceQueueId(queue: unknown, fromId: string, toId: string): string[] {
  if (!Array.isArray(queue)) {
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const accountId of queue) {
    if (typeof accountId !== 'string') {
      continue;
    }

    const normalizedId = accountId === fromId ? toId : accountId;
    if (!seen.has(normalizedId)) {
      result.push(normalizedId);
      seen.add(normalizedId);
    }
  }
  return result;
}

export function hasAPIProfileProviderAccount(profileId: string): boolean {
  const settings = readSettingsFile() ?? {};
  const accounts = (settings.providerAccounts as ProviderAccount[] | undefined) ?? [];
  const accountId = getAPIProfileProviderAccountId(profileId);
  return accounts.some(account => account.id === accountId);
}

/**
 * Keep legacy API Profiles usable by the current task runner.
 *
 * Task execution resolves credentials from settings.providerAccounts, while the
 * old API Profile UI writes profiles.json. This bridge mirrors each API Profile
 * into the queue as an Anthropic-compatible API-key account.
 */
export function syncAPIProfileToProviderAccount(
  profile: APIProfile,
  options?: { activate?: boolean }
): ProviderAccount {
  const settings = readSettingsFile() ?? {};
  const accounts = (settings.providerAccounts as ProviderAccount[] | undefined) ?? [];
  const accountId = getAPIProfileProviderAccountId(profile.id);
  const now = Date.now();
  const existingIndex = accounts.findIndex((account) =>
    account.id === accountId ||
    (
      account.authType === 'api-key' &&
      account.name === profile.name &&
      account.baseUrl === profile.baseUrl &&
      account.apiKey === profile.apiKey &&
      (account.provider === 'openai-compatible' || account.provider === 'anthropic')
    )
  );
  const existing = existingIndex >= 0 ? accounts[existingIndex] : undefined;
  const existingAccountId = existing?.id;

  const account: ProviderAccount = {
    ...existing,
    id: accountId,
    provider: 'anthropic',
    name: profile.name,
    authType: 'api-key',
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    billingModel: 'pay-per-use',
    createdAt: existing?.createdAt ?? profile.createdAt ?? now,
    updatedAt: now,
  };

  const nextAccounts = [...accounts];
  if (existingIndex >= 0) {
    nextAccounts[existingIndex] = account;
  } else {
    nextAccounts.push(account);
  }

  const existingIds = new Set(nextAccounts.map(item => item.id));
  if (existingAccountId && existingAccountId !== accountId) {
    existingIds.add(existingAccountId);
  }

  let globalPriorityOrder = sanitizeQueue(settings.globalPriorityOrder, existingIds);
  if (existingAccountId && existingAccountId !== accountId) {
    globalPriorityOrder = replaceQueueId(globalPriorityOrder, existingAccountId, accountId);
  }
  if (options?.activate) {
    globalPriorityOrder = prependQueueId(globalPriorityOrder, accountId);
  }

  writeSettingsFile({
    ...settings,
    providerAccounts: nextAccounts,
    globalPriorityOrder,
    crossProviderPriorityOrder: replaceQueueId(
      sanitizeQueue(settings.crossProviderPriorityOrder, existingIds),
      existingAccountId ?? accountId,
      accountId
    ),
  });

  return account;
}

export function removeAPIProfileProviderAccount(profileId: string): void {
  const settings = readSettingsFile() ?? {};
  const accountId = getAPIProfileProviderAccountId(profileId);
  const accounts = ((settings.providerAccounts as ProviderAccount[] | undefined) ?? [])
    .filter(account => account.id !== accountId);
  const existingIds = new Set(accounts.map(account => account.id));

  writeSettingsFile({
    ...settings,
    providerAccounts: accounts,
    globalPriorityOrder: sanitizeQueue(settings.globalPriorityOrder, existingIds),
    crossProviderPriorityOrder: sanitizeQueue(settings.crossProviderPriorityOrder, existingIds),
  });
}

export function deactivateAPIProfileProviderAccounts(): void {
  const settings = readSettingsFile() ?? {};
  const accounts = ((settings.providerAccounts as ProviderAccount[] | undefined) ?? [])
    .filter(account => !isAPIProfileProviderAccountId(account.id));
  const existingIds = new Set(accounts.map(account => account.id));

  writeSettingsFile({
    ...settings,
    providerAccounts: accounts,
    globalPriorityOrder: sanitizeQueue(settings.globalPriorityOrder, existingIds),
    crossProviderPriorityOrder: sanitizeQueue(settings.crossProviderPriorityOrder, existingIds),
  });
}
