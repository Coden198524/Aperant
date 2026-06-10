import {
  classifyAutocodeRateLimitType,
  parseAutocodeResetTime,
  parseAutocodeUsageOutput,
} from '@autocode/core/auth/usage';
import type { ClaudeUsageData } from '../../shared/types';

export const parseResetTime = parseAutocodeResetTime;
export const classifyRateLimitType = classifyAutocodeRateLimitType;

export function parseUsageOutput(usageOutput: string): ClaudeUsageData {
  return parseAutocodeUsageOutput(usageOutput) as ClaudeUsageData;
}
