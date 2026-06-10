import {
  API_ID_PREFIX,
  OAUTH_ID_PREFIX,
  apiProfileToAutocodeUnified,
  claudeProfileToAutocodeUnified,
  extractAutocodeProfileId,
  isAutocodeAPIAccountId,
  isAutocodeOAuthAccountId,
  toAutocodeAPIUnifiedId,
  toAutocodeOAuthUnifiedId,
} from '@autocode/core/auth/account-selection';
import type { ClaudeProfile } from '../types/agent';
import type { APIProfile } from '../types/profile';
import type { RateLimitType, UnifiedAccount } from '../types/unified-account';

export { API_ID_PREFIX, OAUTH_ID_PREFIX };

export function claudeProfileToUnified(
  profile: ClaudeProfile,
  isActive: boolean,
  options?: {
    isRateLimited?: boolean;
    rateLimitType?: RateLimitType;
    isAuthenticated?: boolean;
  }
): UnifiedAccount {
  return claudeProfileToAutocodeUnified(profile, isActive, options) as UnifiedAccount;
}

export function apiProfileToUnified(
  profile: APIProfile,
  isActive: boolean,
  isAuthenticated: boolean = false
): UnifiedAccount {
  return apiProfileToAutocodeUnified(profile, isActive, isAuthenticated) as UnifiedAccount;
}

export function isOAuthAccountId(id: string): boolean {
  return isAutocodeOAuthAccountId(id);
}

export function isAPIAccountId(id: string): boolean {
  return isAutocodeAPIAccountId(id);
}

export function extractProfileId(unifiedId: string): string {
  return extractAutocodeProfileId(unifiedId);
}

export function toOAuthUnifiedId(profileId: string): string {
  return toAutocodeOAuthUnifiedId(profileId);
}

export function toAPIUnifiedId(profileId: string): string {
  return toAutocodeAPIUnifiedId(profileId);
}
