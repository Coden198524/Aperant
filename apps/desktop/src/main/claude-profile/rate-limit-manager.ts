import {
  clearAutocodeRateLimitEvents,
  isAutocodeProfileRateLimited,
  recordAutocodeRateLimitEvent,
} from '@autocode/core/auth/usage';
import type { ClaudeProfile, ClaudeRateLimitEvent } from '../../shared/types';

export function recordRateLimitEvent(
  profile: ClaudeProfile,
  resetTimeStr: string
): ClaudeRateLimitEvent {
  return recordAutocodeRateLimitEvent(profile, resetTimeStr) as ClaudeRateLimitEvent;
}

export function isProfileRateLimited(
  profile: ClaudeProfile
): { limited: boolean; type?: 'session' | 'weekly'; resetAt?: Date } {
  return isAutocodeProfileRateLimited(profile);
}

export function clearRateLimitEvents(profile: ClaudeProfile): void {
  clearAutocodeRateLimitEvents(profile);
}
