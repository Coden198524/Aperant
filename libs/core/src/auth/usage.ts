export type AutocodeRateLimitType = 'session' | 'weekly';

export interface AutocodeClaudeUsageData {
  sessionUsagePercent: number;
  sessionResetTime: string;
  weeklyUsagePercent: number;
  weeklyResetTime: string;
  opusUsagePercent?: number;
  lastUpdated: Date;
}

export interface AutocodeRateLimitEventLike {
  type: AutocodeRateLimitType;
  hitAt: Date;
  resetAt: Date;
  resetTimeString: string;
}

export interface AutocodeRateLimitedProfileLike {
  rateLimitEvents?: AutocodeRateLimitEventLike[];
}

const USAGE_PERCENT_PATTERN = /(\d+)%\s*used/i;
const USAGE_RESET_PATTERN = /Resets?\s+(.+?)(?:\s*$|\n)/i;

export function parseAutocodeResetTime(resetTimeStr: string, now: Date = new Date()): Date {
  const dateMatch = resetTimeStr.match(/([A-Za-z]+)\s+(\d+)(?:,|\s+at)?\s*(\d+)?:?(\d+)?(am|pm)?/i);
  if (dateMatch) {
    const [, month, day, hour = '0', minute = '0', ampm = ''] = dateMatch;
    const monthMap: Record<string, number> = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const monthNum = monthMap[month.toLowerCase()] ?? now.getMonth();
    let hourNum = Number.parseInt(hour, 10);
    if (ampm.toLowerCase() === 'pm' && hourNum < 12) {
      hourNum += 12;
    }
    if (ampm.toLowerCase() === 'am' && hourNum === 12) {
      hourNum = 0;
    }

    const resetDate = new Date(now.getFullYear(), monthNum, Number.parseInt(day, 10), hourNum, Number.parseInt(minute, 10));
    if (resetDate < now) {
      resetDate.setFullYear(resetDate.getFullYear() + 1);
    }
    return resetDate;
  }

  const timeOnlyMatch = resetTimeStr.match(/(\d+):?(\d+)?\s*(am|pm)/i);
  if (timeOnlyMatch) {
    const [, hour, minute = '0', ampm] = timeOnlyMatch;
    let hourNum = Number.parseInt(hour, 10);
    if (ampm.toLowerCase() === 'pm' && hourNum < 12) {
      hourNum += 12;
    }
    if (ampm.toLowerCase() === 'am' && hourNum === 12) {
      hourNum = 0;
    }

    const resetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hourNum, Number.parseInt(minute, 10));
    if (resetDate < now) {
      resetDate.setDate(resetDate.getDate() + 1);
    }
    return resetDate;
  }

  const isWeekly = resetTimeStr.toLowerCase().includes('week') || /[a-z]{3}\s+\d+/i.test(resetTimeStr);
  return new Date(now.getTime() + (isWeekly ? 7 * 24 * 60 * 60 * 1000 : 5 * 60 * 60 * 1000));
}

export function classifyAutocodeRateLimitType(resetTimeStr: string): AutocodeRateLimitType {
  const hasDate = /[A-Za-z]{3}\s+\d+/i.test(resetTimeStr);
  const hasWeeklyIndicator = resetTimeStr.toLowerCase().includes('week');
  return hasDate || hasWeeklyIndicator ? 'weekly' : 'session';
}

export function parseAutocodeUsageOutput(usageOutput: string): AutocodeClaudeUsageData {
  const sections = usageOutput.split(/Current\s+/i).filter(Boolean);
  const usage: AutocodeClaudeUsageData = {
    sessionUsagePercent: 0,
    sessionResetTime: '',
    weeklyUsagePercent: 0,
    weeklyResetTime: '',
    lastUpdated: new Date(),
  };

  for (const section of sections) {
    const percentMatch = section.match(USAGE_PERCENT_PATTERN);
    const resetMatch = section.match(USAGE_RESET_PATTERN);

    if (!percentMatch) {
      continue;
    }

    const percent = Number.parseInt(percentMatch[1], 10);
    const resetTime = resetMatch?.[1]?.trim() || '';

    if (/session/i.test(section)) {
      usage.sessionUsagePercent = percent;
      usage.sessionResetTime = resetTime;
    } else if (/week.*all\s*model/i.test(section)) {
      usage.weeklyUsagePercent = percent;
      usage.weeklyResetTime = resetTime;
    } else if (/week.*opus/i.test(section)) {
      usage.opusUsagePercent = percent;
    }
  }

  return usage;
}

export function recordAutocodeRateLimitEvent<TProfile extends AutocodeRateLimitedProfileLike>(
  profile: TProfile,
  resetTimeStr: string,
  now: Date = new Date()
): AutocodeRateLimitEventLike {
  const event: AutocodeRateLimitEventLike = {
    type: classifyAutocodeRateLimitType(resetTimeStr),
    hitAt: now,
    resetAt: parseAutocodeResetTime(resetTimeStr, now),
    resetTimeString: resetTimeStr,
  };

  profile.rateLimitEvents = [
    event,
    ...(profile.rateLimitEvents || []).slice(0, 9),
  ];

  return event;
}

export function isAutocodeProfileRateLimited(
  profile: AutocodeRateLimitedProfileLike | null | undefined,
  now: Date = new Date()
): { limited: boolean; type?: AutocodeRateLimitType; resetAt?: Date } {
  if (!profile?.rateLimitEvents?.length) {
    return { limited: false };
  }

  const latestEvent = profile.rateLimitEvents[0];
  if (latestEvent.resetAt > now) {
    return {
      limited: true,
      type: latestEvent.type,
      resetAt: latestEvent.resetAt,
    };
  }

  return { limited: false };
}

export function clearAutocodeRateLimitEvents(profile: AutocodeRateLimitedProfileLike): void {
  profile.rateLimitEvents = [];
}
