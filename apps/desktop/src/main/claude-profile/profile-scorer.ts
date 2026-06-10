import {
  getAutocodeProfilesSortedByAvailability,
  getBestAvailableAutocodeProfile,
  getBestAvailableAutocodeUnifiedAccount,
  scoreAutocodeProviderAccount,
  shouldAutocodeProactivelySwitch,
  type AutocodeClaudeProfileLike,
} from '@autocode/core/auth/account-selection';
import type { ClaudeProfile, ClaudeAutoSwitchSettings, APIProfile } from '../../shared/types';
import type { ProviderAccount } from '../../shared/types/provider-account';
import type { UnifiedAccount } from '../../shared/types/unified-account';
import { isProfileRateLimited } from './rate-limit-manager';
import { isProfileAuthenticated } from './profile-utils';

export interface UnifiedAccountSelectionOptions {
  excludeAccountId?: string;
  priorityOrder?: string[];
  activeOAuthId?: string;
  activeAPIId?: string;
}

const selectionAdapters = {
  isProfileAuthenticated: (profile: AutocodeClaudeProfileLike): boolean => isProfileAuthenticated(profile as ClaudeProfile),
  getProfileRateLimitStatus: (profile: AutocodeClaudeProfileLike): {
    limited: boolean;
    type?: 'session' | 'weekly';
    resetAt?: Date;
  } => isProfileRateLimited(profile as ClaudeProfile),
};

export function getBestAvailableUnifiedAccount(
  oauthProfiles: ClaudeProfile[],
  apiProfiles: APIProfile[],
  settings: ClaudeAutoSwitchSettings,
  options: UnifiedAccountSelectionOptions = {}
): UnifiedAccount | null {
  return getBestAvailableAutocodeUnifiedAccount(oauthProfiles, apiProfiles, settings, {
    ...options,
    ...selectionAdapters,
  }) as UnifiedAccount | null;
}

export function getBestAvailableProfile(
  profiles: ClaudeProfile[],
  settings: ClaudeAutoSwitchSettings,
  excludeProfileId?: string,
  priorityOrder: string[] = []
): ClaudeProfile | null {
  return getBestAvailableAutocodeProfile(
    profiles,
    settings,
    excludeProfileId,
    priorityOrder,
    selectionAdapters
  ) as ClaudeProfile | null;
}

export function shouldProactivelySwitch(
  profile: ClaudeProfile,
  allProfiles: ClaudeProfile[],
  settings: ClaudeAutoSwitchSettings,
  priorityOrder: string[] = []
): { shouldSwitch: boolean; reason?: string; suggestedProfile?: ClaudeProfile } {
  return shouldAutocodeProactivelySwitch(
    profile,
    allProfiles,
    settings,
    priorityOrder,
    selectionAdapters
  ) as { shouldSwitch: boolean; reason?: string; suggestedProfile?: ClaudeProfile };
}

export function scoreProviderAccount(
  account: ProviderAccount,
  settings: ClaudeAutoSwitchSettings
): { available: boolean; score: number; reason?: string } {
  return scoreAutocodeProviderAccount(account, settings);
}

export function getProfilesSortedByAvailability(profiles: ClaudeProfile[]): ClaudeProfile[] {
  return getAutocodeProfilesSortedByAvailability(profiles, selectionAdapters) as ClaudeProfile[];
}
