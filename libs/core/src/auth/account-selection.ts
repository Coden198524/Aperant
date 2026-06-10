import {
  isAutocodeProfileRateLimited,
  type AutocodeClaudeUsageData,
  type AutocodeRateLimitEventLike,
  type AutocodeRateLimitType,
} from './usage.js';

export const OAUTH_ID_PREFIX = 'oauth-';
export const API_ID_PREFIX = 'api-';
export const AUTOCODE_OAUTH_ID_PREFIX = OAUTH_ID_PREFIX;
export const AUTOCODE_API_ID_PREFIX = API_ID_PREFIX;

export interface AutocodeAutoSwitchSettingsLike {
  enabled?: boolean;
  sessionThreshold: number;
  weeklyThreshold: number;
}

export interface AutocodeClaudeProfileLike {
  id: string;
  name: string;
  email?: string;
  usage?: AutocodeClaudeUsageData;
  rateLimitEvents?: AutocodeRateLimitEventLike[];
  isAuthenticated?: boolean;
}

export interface AutocodeApiProfileLike {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
}

export type AutocodeUnifiedAccountType = 'oauth' | 'api';

export interface AutocodeUnifiedAccount {
  id: string;
  name: string;
  type: AutocodeUnifiedAccountType;
  displayName: string;
  identifier: string;
  isActive: boolean;
  isNext: boolean;
  isAvailable: boolean;
  hasUnlimitedUsage: boolean;
  sessionPercent?: number;
  weeklyPercent?: number;
  isRateLimited?: boolean;
  rateLimitType?: AutocodeRateLimitType;
  isAuthenticated?: boolean;
  isDuplicateUsage?: boolean;
  needsReauthentication?: boolean;
}

export interface AutocodeProviderAccountLike {
  billingModel?: 'subscription' | 'pay-per-use' | string;
  usage?: Pick<AutocodeClaudeUsageData, 'sessionUsagePercent' | 'weeklyUsagePercent'>;
  rateLimitEvents?: Array<{
    resetAt?: Date | string | number;
  }>;
}

export interface AutocodeAccountSelectionOptions {
  excludeAccountId?: string;
  priorityOrder?: string[];
  activeOAuthId?: string;
  activeAPIId?: string;
  isProfileAuthenticated?: (profile: AutocodeClaudeProfileLike) => boolean;
  isApiProfileAuthenticated?: (profile: AutocodeApiProfileLike) => boolean;
  getProfileRateLimitStatus?: (profile: AutocodeClaudeProfileLike) => {
    limited: boolean;
    type?: AutocodeRateLimitType;
    resetAt?: Date;
  };
}

interface ScoredAutocodeProfile<TProfile> {
  profile: TProfile;
  score: number;
  priorityIndex: number;
  isAvailable: boolean;
  unavailableReason?: string;
}

export interface ScoredAutocodeUnifiedAccount {
  account: AutocodeUnifiedAccount;
  score: number;
  priorityIndex: number;
  isAvailable: boolean;
  unavailableReason?: string;
}

function getPriorityIndex(priorityOrder: readonly string[] | undefined, unifiedId: string): number {
  const index = priorityOrder?.indexOf(unifiedId) ?? -1;
  return index === -1 ? Infinity : index;
}

function getDefaultProfileAuthenticated(profile: AutocodeClaudeProfileLike): boolean {
  return profile.isAuthenticated ?? false;
}

function getDefaultApiProfileAuthenticated(profile: AutocodeApiProfileLike): boolean {
  return !!profile.apiKey;
}

function getProfileRateLimitStatus(profile: AutocodeClaudeProfileLike): {
  limited: boolean;
  type?: AutocodeRateLimitType;
  resetAt?: Date;
} {
  return isAutocodeProfileRateLimited(profile);
}

export function claudeProfileToAutocodeUnified(
  profile: AutocodeClaudeProfileLike,
  isActive: boolean,
  options?: {
    isRateLimited?: boolean;
    rateLimitType?: AutocodeRateLimitType;
    isAuthenticated?: boolean;
  }
): AutocodeUnifiedAccount {
  const activeRateLimit = isAutocodeProfileRateLimited(profile);
  const isRateLimited = options?.isRateLimited ?? activeRateLimit.limited;
  const isAuthenticated = options?.isAuthenticated ?? profile.isAuthenticated ?? false;

  return {
    id: toAutocodeOAuthUnifiedId(profile.id),
    name: profile.name,
    type: 'oauth',
    displayName: profile.name,
    identifier: profile.email || profile.id,
    isActive,
    isNext: false,
    isAvailable: !!(isAuthenticated && !isRateLimited),
    hasUnlimitedUsage: false,
    sessionPercent: profile.usage?.sessionUsagePercent,
    weeklyPercent: profile.usage?.weeklyUsagePercent,
    isRateLimited,
    rateLimitType: options?.rateLimitType ?? activeRateLimit.type,
    isAuthenticated,
    needsReauthentication: false,
  };
}

export function apiProfileToAutocodeUnified(
  profile: AutocodeApiProfileLike,
  isActive: boolean,
  isAuthenticated: boolean = false
): AutocodeUnifiedAccount {
  return {
    id: toAutocodeAPIUnifiedId(profile.id),
    name: profile.name,
    type: 'api',
    displayName: profile.name,
    identifier: profile.baseUrl,
    isActive,
    isNext: false,
    isAvailable: isAuthenticated && !!profile.apiKey,
    hasUnlimitedUsage: true,
    sessionPercent: undefined,
    weeklyPercent: undefined,
    isRateLimited: false,
    rateLimitType: undefined,
    isAuthenticated,
    needsReauthentication: false,
  };
}

export function isAutocodeOAuthAccountId(id: string): boolean {
  return id.startsWith(OAUTH_ID_PREFIX);
}

export function isAutocodeAPIAccountId(id: string): boolean {
  return id.startsWith(API_ID_PREFIX);
}

export function extractAutocodeProfileId(unifiedId: string): string {
  if (isAutocodeOAuthAccountId(unifiedId)) {
    return unifiedId.slice(OAUTH_ID_PREFIX.length);
  }
  if (isAutocodeAPIAccountId(unifiedId)) {
    return unifiedId.slice(API_ID_PREFIX.length);
  }
  return unifiedId;
}

export function toAutocodeOAuthUnifiedId(profileId: string): string {
  if (profileId.startsWith(OAUTH_ID_PREFIX)) {
    return profileId;
  }
  if (profileId.startsWith(API_ID_PREFIX)) {
    throw new Error(`Cannot convert API-prefixed ID "${profileId}" to OAuth unified ID`);
  }
  return `${OAUTH_ID_PREFIX}${profileId}`;
}

export function toAutocodeAPIUnifiedId(profileId: string): string {
  if (profileId.startsWith(API_ID_PREFIX)) {
    return profileId;
  }
  if (profileId.startsWith(OAUTH_ID_PREFIX)) {
    throw new Error(`Cannot convert OAuth-prefixed ID "${profileId}" to API unified ID`);
  }
  return `${API_ID_PREFIX}${profileId}`;
}

export function checkAutocodeProfileAvailability(
  profile: AutocodeClaudeProfileLike,
  settings: AutocodeAutoSwitchSettingsLike,
  options: Pick<AutocodeAccountSelectionOptions, 'isProfileAuthenticated' | 'getProfileRateLimitStatus'> = {}
): { available: boolean; reason?: string } {
  const isAuthenticated = options.isProfileAuthenticated ?? getDefaultProfileAuthenticated;
  if (!isAuthenticated(profile)) {
    return { available: false, reason: 'not authenticated' };
  }

  const rateLimitStatus = (options.getProfileRateLimitStatus ?? getProfileRateLimitStatus)(profile);
  if (rateLimitStatus.limited) {
    return {
      available: false,
      reason: `rate limited (${rateLimitStatus.type}, resets ${rateLimitStatus.resetAt?.toISOString() || 'unknown'})`,
    };
  }

  if (profile.usage) {
    if (profile.usage.weeklyUsagePercent >= settings.weeklyThreshold) {
      return {
        available: false,
        reason: `weekly usage ${profile.usage.weeklyUsagePercent}% >= threshold ${settings.weeklyThreshold}%`,
      };
    }

    if (profile.usage.sessionUsagePercent >= settings.sessionThreshold) {
      return {
        available: false,
        reason: `session usage ${profile.usage.sessionUsagePercent}% >= threshold ${settings.sessionThreshold}%`,
      };
    }
  }

  return { available: true };
}

export function calculateAutocodeProfileFallbackScore(
  profile: AutocodeClaudeProfileLike,
  settings: AutocodeAutoSwitchSettingsLike,
  options: Pick<AutocodeAccountSelectionOptions, 'isProfileAuthenticated' | 'getProfileRateLimitStatus'> = {},
  now: Date = new Date()
): number {
  let score = 100;
  const isAuthenticated = options.isProfileAuthenticated ?? getDefaultProfileAuthenticated;

  if (!isAuthenticated(profile)) {
    score -= 1000;
  }

  const rateLimitStatus = (options.getProfileRateLimitStatus ?? getProfileRateLimitStatus)(profile);
  if (rateLimitStatus.limited) {
    score -= rateLimitStatus.type === 'weekly' ? 500 : 200;

    if (rateLimitStatus.resetAt) {
      const hoursUntilReset = (rateLimitStatus.resetAt.getTime() - now.getTime()) / (1000 * 60 * 60);
      score += Math.max(0, 50 - hoursUntilReset);
    }
  }

  if (profile.usage) {
    const weeklyOverage = Math.max(0, profile.usage.weeklyUsagePercent - settings.weeklyThreshold);
    const sessionOverage = Math.max(0, profile.usage.sessionUsagePercent - settings.sessionThreshold);

    score -= weeklyOverage * 2;
    score -= sessionOverage;
    score -= profile.usage.weeklyUsagePercent * 0.3;
    score -= profile.usage.sessionUsagePercent * 0.1;
  }

  return score;
}

export function scoreAutocodeUnifiedAccount(
  account: AutocodeUnifiedAccount,
  priorityIndex: number,
  settings: AutocodeAutoSwitchSettingsLike
): ScoredAutocodeUnifiedAccount {
  let score = 100;
  let unavailableReason: string | undefined;
  let isOverThreshold = false;

  if (account.type === 'api') {
    if (!account.isAuthenticated) {
      score = -1000;
      unavailableReason = 'API key not validated';
    } else if (!account.isAvailable) {
      score = -500;
      unavailableReason = 'not available';
    }

    return {
      account,
      score,
      priorityIndex,
      isAvailable: score > 0,
      unavailableReason,
    };
  }

  if (!account.isAuthenticated) {
    score = -1000;
    unavailableReason = 'not authenticated';
  } else if (account.isRateLimited) {
    score = account.rateLimitType === 'weekly' ? -500 : -200;
    unavailableReason = `rate limited (${account.rateLimitType || 'unknown'})`;
  } else {
    if (account.weeklyPercent !== undefined && account.weeklyPercent >= settings.weeklyThreshold) {
      isOverThreshold = true;
      unavailableReason = `weekly usage ${account.weeklyPercent}% >= threshold ${settings.weeklyThreshold}%`;
    } else if (account.sessionPercent !== undefined && account.sessionPercent >= settings.sessionThreshold) {
      isOverThreshold = true;
      unavailableReason = `session usage ${account.sessionPercent}% >= threshold ${settings.sessionThreshold}%`;
    }

    if (account.weeklyPercent !== undefined) {
      score -= account.weeklyPercent * 0.3;
    }
    if (account.sessionPercent !== undefined) {
      score -= account.sessionPercent * 0.1;
    }
  }

  return {
    account,
    score,
    priorityIndex,
    isAvailable: score > 0 && account.isAuthenticated === true && !account.isRateLimited && !isOverThreshold,
    unavailableReason,
  };
}

function sortScoredAccounts<T extends { isAvailable: boolean; priorityIndex: number; score: number }>(items: T[]): T[] {
  return items.sort((a, b) => {
    if (a.isAvailable !== b.isAvailable) {
      return a.isAvailable ? -1 : 1;
    }

    if (a.isAvailable && b.isAvailable) {
      if (a.priorityIndex !== b.priorityIndex) {
        return a.priorityIndex - b.priorityIndex;
      }
      return b.score - a.score;
    }

    return b.score - a.score;
  });
}

export function getBestAvailableAutocodeUnifiedAccount<
  TOAuthProfile extends AutocodeClaudeProfileLike,
  TApiProfile extends AutocodeApiProfileLike,
>(
  oauthProfiles: TOAuthProfile[],
  apiProfiles: TApiProfile[],
  settings: AutocodeAutoSwitchSettingsLike,
  options: AutocodeAccountSelectionOptions = {}
): AutocodeUnifiedAccount | null {
  const {
    excludeAccountId,
    priorityOrder = [],
    activeOAuthId,
    activeAPIId,
    isProfileAuthenticated = getDefaultProfileAuthenticated,
    isApiProfileAuthenticated = getDefaultApiProfileAuthenticated,
    getProfileRateLimitStatus: getRateLimit = getProfileRateLimitStatus,
  } = options;

  const unifiedAccounts: AutocodeUnifiedAccount[] = [];

  for (const profile of oauthProfiles) {
    const rateLimitStatus = getRateLimit(profile);
    unifiedAccounts.push(claudeProfileToAutocodeUnified(profile, profile.id === activeOAuthId, {
      isRateLimited: rateLimitStatus.limited,
      rateLimitType: rateLimitStatus.type,
      isAuthenticated: isProfileAuthenticated(profile),
    }));
  }

  for (const profile of apiProfiles) {
    unifiedAccounts.push(apiProfileToAutocodeUnified(profile, profile.id === activeAPIId, isApiProfileAuthenticated(profile)));
  }

  const candidates = unifiedAccounts.filter((account) => account.id !== excludeAccountId);
  if (candidates.length === 0) {
    return null;
  }

  const scoredAccounts = sortScoredAccounts(candidates.map((account) => {
    return scoreAutocodeUnifiedAccount(account, getPriorityIndex(priorityOrder, account.id), settings);
  }));

  const best = scoredAccounts[0];
  if (best.isAvailable || best.score > 0) {
    return best.account;
  }

  return null;
}

export function getBestAvailableAutocodeProfile<TProfile extends AutocodeClaudeProfileLike>(
  profiles: TProfile[],
  settings: AutocodeAutoSwitchSettingsLike,
  excludeProfileId?: string,
  priorityOrder: string[] = [],
  options: Pick<AutocodeAccountSelectionOptions, 'isProfileAuthenticated' | 'getProfileRateLimitStatus'> = {}
): TProfile | null {
  const candidates = profiles.filter((profile) => profile.id !== excludeProfileId);
  if (candidates.length === 0) {
    return null;
  }

  const scoredProfiles: Array<ScoredAutocodeProfile<TProfile>> = candidates.map((profile) => {
    const unifiedId = toAutocodeOAuthUnifiedId(profile.id);
    const availability = checkAutocodeProfileAvailability(profile, settings, options);
    const fallbackScore = calculateAutocodeProfileFallbackScore(profile, settings, options);

    return {
      profile,
      score: fallbackScore,
      priorityIndex: getPriorityIndex(priorityOrder, unifiedId),
      isAvailable: availability.available,
      unavailableReason: availability.reason,
    };
  });

  const best = sortScoredAccounts(scoredProfiles)[0];
  if (best.isAvailable || best.score > 0) {
    return best.profile;
  }

  return null;
}

export function shouldAutocodeProactivelySwitch<TProfile extends AutocodeClaudeProfileLike>(
  profile: TProfile,
  allProfiles: TProfile[],
  settings: AutocodeAutoSwitchSettingsLike,
  priorityOrder: string[] = [],
  options: Pick<AutocodeAccountSelectionOptions, 'isProfileAuthenticated' | 'getProfileRateLimitStatus'> = {}
): { shouldSwitch: boolean; reason?: string; suggestedProfile?: TProfile } {
  if (!settings.enabled || !profile?.usage) {
    return { shouldSwitch: false };
  }

  const usage = profile.usage;

  if (usage.weeklyUsagePercent >= settings.weeklyThreshold) {
    const bestProfile = getBestAvailableAutocodeProfile(allProfiles, settings, profile.id, priorityOrder, options);
    if (bestProfile) {
      return {
        shouldSwitch: true,
        reason: `Weekly usage at ${usage.weeklyUsagePercent}% (threshold: ${settings.weeklyThreshold}%)`,
        suggestedProfile: bestProfile,
      };
    }
  }

  if (usage.sessionUsagePercent >= settings.sessionThreshold) {
    const bestProfile = getBestAvailableAutocodeProfile(allProfiles, settings, profile.id, priorityOrder, options);
    if (bestProfile) {
      return {
        shouldSwitch: true,
        reason: `Session usage at ${usage.sessionUsagePercent}% (threshold: ${settings.sessionThreshold}%)`,
        suggestedProfile: bestProfile,
      };
    }
  }

  return { shouldSwitch: false };
}

export function scoreAutocodeProviderAccount(
  account: AutocodeProviderAccountLike,
  settings: AutocodeAutoSwitchSettingsLike,
  now: Date = new Date()
): { available: boolean; score: number; reason?: string } {
  if (account.billingModel === 'pay-per-use') {
    return { available: true, score: 100 };
  }

  if (account.rateLimitEvents?.length) {
    const nowMs = now.getTime();
    const activeRateLimit = account.rateLimitEvents.find((event) => {
      if (!event.resetAt) {
        return false;
      }
      const resetTime = typeof event.resetAt === 'number' ? event.resetAt : new Date(event.resetAt).getTime();
      return resetTime > nowMs;
    });

    if (activeRateLimit) {
      return { available: false, score: -200, reason: 'rate limited' };
    }
  }

  if (account.usage) {
    if (account.usage.weeklyUsagePercent >= settings.weeklyThreshold) {
      return { available: false, score: -100, reason: 'weekly threshold exceeded' };
    }
    if (account.usage.sessionUsagePercent >= settings.sessionThreshold) {
      return { available: false, score: -50, reason: 'session threshold exceeded' };
    }
    return { available: true, score: 100 - (account.usage.weeklyUsagePercent ?? 0) * 0.3 };
  }

  return { available: true, score: 100 };
}

export function getAutocodeProfilesSortedByAvailability<TProfile extends AutocodeClaudeProfileLike>(
  profiles: TProfile[],
  options: Pick<AutocodeAccountSelectionOptions, 'isProfileAuthenticated' | 'getProfileRateLimitStatus'> = {}
): TProfile[] {
  const isProfileAuthenticated = options.isProfileAuthenticated ?? getDefaultProfileAuthenticated;
  const getRateLimit = options.getProfileRateLimitStatus ?? getProfileRateLimitStatus;

  return [...profiles].sort((a, b) => {
    const aAuth = isProfileAuthenticated(a);
    const bAuth = isProfileAuthenticated(b);
    if (aAuth !== bAuth) {
      return aAuth ? -1 : 1;
    }

    const aLimited = getRateLimit(a);
    const bLimited = getRateLimit(b);
    if (aLimited.limited !== bLimited.limited) {
      return aLimited.limited ? 1 : -1;
    }

    if (aLimited.limited && bLimited.limited && aLimited.resetAt && bLimited.resetAt) {
      return aLimited.resetAt.getTime() - bLimited.resetAt.getTime();
    }

    const aWeekly = a.usage?.weeklyUsagePercent ?? 0;
    const bWeekly = b.usage?.weeklyUsagePercent ?? 0;
    if (aWeekly !== bWeekly) {
      return aWeekly - bWeekly;
    }

    const aSession = a.usage?.sessionUsagePercent ?? 0;
    const bSession = b.usage?.sessionUsagePercent ?? 0;
    return aSession - bSession;
  });
}
