export const AUTOCODE_API_PROFILE_ACCOUNT_PREFIX = 'api-profile:';

export interface AutocodeAPIProfileLike {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AutocodeAPIProviderAccountLike {
  id: string;
  provider: string;
  name: string;
  authType: string;
  billingModel?: string;
  apiKey?: string;
  baseUrl?: string;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export interface AutocodeProviderAccountSettingsLike<TAccount extends AutocodeAPIProviderAccountLike = AutocodeAPIProviderAccountLike> {
  providerAccounts?: TAccount[];
  globalPriorityOrder?: unknown;
  crossProviderPriorityOrder?: unknown;
  [key: string]: unknown;
}

export interface SyncAutocodeAPIProfileOptions {
  activate?: boolean;
  now?: number;
}

export function getAutocodeAPIProfileProviderAccountId(profileId: string): string {
  return `${AUTOCODE_API_PROFILE_ACCOUNT_PREFIX}${profileId}`;
}

export function isAutocodeAPIProfileProviderAccountId(accountId: string): boolean {
  return accountId.startsWith(AUTOCODE_API_PROFILE_ACCOUNT_PREFIX);
}

export function sanitizeAutocodeProviderAccountQueue(
  queue: unknown,
  existingIds: Set<string>,
): string[] {
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

export function prependAutocodeProviderAccountQueueId(queue: string[], accountId: string): string[] {
  return [accountId, ...queue.filter(id => id !== accountId)];
}

export function replaceAutocodeProviderAccountQueueId(
  queue: unknown,
  fromId: string,
  toId: string,
): string[] {
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

export function findAutocodeAPIProfileProviderAccountIndex<TAccount extends AutocodeAPIProviderAccountLike>(
  accounts: TAccount[],
  profile: AutocodeAPIProfileLike,
): number {
  const accountId = getAutocodeAPIProfileProviderAccountId(profile.id);
  return accounts.findIndex((account) =>
    account.id === accountId ||
    (
      account.authType === 'api-key' &&
      account.name === profile.name &&
      account.baseUrl === profile.baseUrl &&
      account.apiKey === profile.apiKey &&
      (account.provider === 'openai-compatible' || account.provider === 'anthropic')
    )
  );
}

export function buildAutocodeAPIProfileProviderAccount<TAccount extends AutocodeAPIProviderAccountLike>(
  profile: AutocodeAPIProfileLike,
  existing?: TAccount,
  now = Date.now(),
): TAccount {
  return {
    ...existing,
    id: getAutocodeAPIProfileProviderAccountId(profile.id),
    provider: 'anthropic',
    name: profile.name,
    authType: 'api-key',
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    billingModel: 'pay-per-use',
    createdAt: existing?.createdAt ?? profile.createdAt ?? now,
    updatedAt: now,
  } as TAccount;
}

export function syncAutocodeAPIProfileProviderAccountState<
  TAccount extends AutocodeAPIProviderAccountLike,
  TSettings extends AutocodeProviderAccountSettingsLike<TAccount>,
>(
  settings: TSettings,
  profile: AutocodeAPIProfileLike,
  options: SyncAutocodeAPIProfileOptions = {},
): { settings: TSettings & { providerAccounts: TAccount[]; globalPriorityOrder: string[]; crossProviderPriorityOrder: string[] }; account: TAccount } {
  const accounts = Array.isArray(settings.providerAccounts) ? settings.providerAccounts : [];
  const accountId = getAutocodeAPIProfileProviderAccountId(profile.id);
  const now = options.now ?? Date.now();
  const existingIndex = findAutocodeAPIProfileProviderAccountIndex(accounts, profile);
  const existing = existingIndex >= 0 ? accounts[existingIndex] : undefined;
  const existingAccountId = existing?.id;
  const account = buildAutocodeAPIProfileProviderAccount(profile, existing, now);

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

  let globalPriorityOrder = sanitizeAutocodeProviderAccountQueue(settings.globalPriorityOrder, existingIds);
  if (existingAccountId && existingAccountId !== accountId) {
    globalPriorityOrder = replaceAutocodeProviderAccountQueueId(globalPriorityOrder, existingAccountId, accountId);
  }
  if (options.activate) {
    globalPriorityOrder = prependAutocodeProviderAccountQueueId(globalPriorityOrder, accountId);
  }

  return {
    settings: {
      ...settings,
      providerAccounts: nextAccounts,
      globalPriorityOrder,
      crossProviderPriorityOrder: replaceAutocodeProviderAccountQueueId(
        sanitizeAutocodeProviderAccountQueue(settings.crossProviderPriorityOrder, existingIds),
        existingAccountId ?? accountId,
        accountId,
      ),
    },
    account,
  };
}

export function removeAutocodeAPIProfileProviderAccountState<
  TAccount extends AutocodeAPIProviderAccountLike,
  TSettings extends AutocodeProviderAccountSettingsLike<TAccount>,
>(
  settings: TSettings,
  profileId: string,
): TSettings & { providerAccounts: TAccount[]; globalPriorityOrder: string[]; crossProviderPriorityOrder: string[] } {
  const accountId = getAutocodeAPIProfileProviderAccountId(profileId);
  const accounts = (Array.isArray(settings.providerAccounts) ? settings.providerAccounts : [])
    .filter(account => account.id !== accountId);
  const existingIds = new Set(accounts.map(account => account.id));

  return {
    ...settings,
    providerAccounts: accounts,
    globalPriorityOrder: sanitizeAutocodeProviderAccountQueue(settings.globalPriorityOrder, existingIds),
    crossProviderPriorityOrder: sanitizeAutocodeProviderAccountQueue(settings.crossProviderPriorityOrder, existingIds),
  };
}

export function deactivateAutocodeAPIProfileProviderAccountsState<
  TAccount extends AutocodeAPIProviderAccountLike,
  TSettings extends AutocodeProviderAccountSettingsLike<TAccount>,
>(
  settings: TSettings,
): TSettings & { providerAccounts: TAccount[]; globalPriorityOrder: string[]; crossProviderPriorityOrder: string[] } {
  const accounts = (Array.isArray(settings.providerAccounts) ? settings.providerAccounts : [])
    .filter(account => !isAutocodeAPIProfileProviderAccountId(account.id));
  const existingIds = new Set(accounts.map(account => account.id));

  return {
    ...settings,
    providerAccounts: accounts,
    globalPriorityOrder: sanitizeAutocodeProviderAccountQueue(settings.globalPriorityOrder, existingIds),
    crossProviderPriorityOrder: sanitizeAutocodeProviderAccountQueue(settings.crossProviderPriorityOrder, existingIds),
  };
}
