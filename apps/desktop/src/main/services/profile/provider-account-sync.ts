import type { APIProfile } from '@shared/types/profile';
import type { ProviderAccount } from '@shared/types/provider-account';
import {
  deactivateAutocodeAPIProfileProviderAccountsState,
  getAutocodeAPIProfileProviderAccountId,
  removeAutocodeAPIProfileProviderAccountState,
  syncAutocodeAPIProfileProviderAccountState,
  type AutocodeAPIProviderAccountLike,
  type AutocodeProviderAccountSettingsLike,
} from '@autocode/core/auth/api-profile-provider-account-sync';
import { readSettingsFile, writeSettingsFile } from '../../settings-utils';

type ProviderSettingsSnapshot = AutocodeProviderAccountSettingsLike<AutocodeAPIProviderAccountLike>;

export function getAPIProfileProviderAccountId(profileId: string): string {
  return getAutocodeAPIProfileProviderAccountId(profileId);
}

function readProviderSettingsSnapshot(): ProviderSettingsSnapshot {
  return (readSettingsFile() ?? {}) as ProviderSettingsSnapshot;
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
  const { settings, account } = syncAutocodeAPIProfileProviderAccountState(
    readProviderSettingsSnapshot(),
    profile,
    options
  );
  writeSettingsFile(settings);
  return account as ProviderAccount;
}

export function removeAPIProfileProviderAccount(profileId: string): void {
  writeSettingsFile(removeAutocodeAPIProfileProviderAccountState(
    readProviderSettingsSnapshot(),
    profileId
  ));
}

export function deactivateAPIProfileProviderAccounts(): void {
  writeSettingsFile(deactivateAutocodeAPIProfileProviderAccountsState(readProviderSettingsSnapshot()));
}
