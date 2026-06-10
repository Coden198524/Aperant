export function hasAutocodeHardcodedTimeText(text?: string | null): boolean {
  const trimmed = text?.trim();
  return !trimmed || trimmed === 'Unknown' || trimmed === 'Expired';
}

const AUTOCODE_USAGE_WINDOW_LABEL_MAP: Readonly<Record<string, string>> = {
  '5-hour window': 'window5Hour',
  '7-day window': 'window7Day',
  '5 Hours Quota': 'window5HoursQuota',
  'Monthly Tools Quota': 'windowMonthlyToolsQuota',
} as const;

export function localizeAutocodeUsageWindowLabel(
  backendLabel: string | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
  defaultKey = 'common:usage.sessionDefault',
): string {
  if (!backendLabel) return t(defaultKey);

  if (backendLabel.includes(':')) {
    const translated = t(backendLabel);
    return translated === backendLabel ? t(defaultKey) : translated;
  }

  const translationKey = AUTOCODE_USAGE_WINDOW_LABEL_MAP[backendLabel];
  if (translationKey) {
    const fullKey = `common:usage.${translationKey}`;
    const translated = t(fullKey);
    return translated === fullKey ? backendLabel : translated;
  }

  return t(defaultKey);
}

export interface FormatAutocodeTimeRemainingOptions {
  hoursKey?: string;
  daysKey?: string;
  now?: () => Date;
}

export function formatAutocodeTimeRemaining(
  timestamp: string | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
  options: FormatAutocodeTimeRemainingOptions = {},
): string | undefined {
  if (!timestamp) return undefined;

  const {
    hoursKey = 'common:usage.resetsInHours',
    daysKey = 'common:usage.resetsInDays',
    now = () => new Date(),
  } = options;

  try {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return undefined;

    const diffMs = date.getTime() - now().getTime();
    if (diffMs < 0) return undefined;

    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (diffHours < 24) {
      return t(hoursKey, { hours: diffHours, minutes: diffMins });
    }

    const diffDays = Math.floor(diffHours / 24);
    const remainingHours = diffHours % 24;
    return t(daysKey, { days: diffDays, hours: remainingHours });
  } catch {
    return undefined;
  }
}

export function formatAutocodeTimeRemainingSimple(
  timestamp: string | undefined,
  now: () => Date = () => new Date(),
): string {
  if (!timestamp) return 'Unknown';

  try {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return 'Unknown';

    const diffMs = date.getTime() - now().getTime();
    if (diffMs < 0) return 'Expired';

    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (diffHours < 24) {
      return `${diffHours}h ${diffMins}m`;
    }

    const diffDays = Math.floor(diffHours / 24);
    const remainingHours = diffHours % 24;
    return `${diffDays}d ${remainingHours}h`;
  } catch {
    return 'Unknown';
  }
}

export {
  formatAutocodeTimeRemaining as formatTimeRemaining,
  formatAutocodeTimeRemainingSimple as formatTimeRemainingSimple,
  hasAutocodeHardcodedTimeText as hasHardcodedText,
  localizeAutocodeUsageWindowLabel as localizeUsageWindowLabel,
};
