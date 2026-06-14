export const AUTOCODE_RETRY_ERROR_LIMIT = 8;
export const AUTOCODE_RETRY_ERROR_MAX_CHARS = 260;
export const AUTOCODE_RETRY_TEXT_MAX_CHARS = 1_800;
export const AUTOCODE_RETRY_RAW_OUTPUT_MAX_CHARS = 2_400;
const AUTOCODE_RETRY_COMPACTION_HEAD_RATIO = 0.65;

export interface FormatAutocodeRetryErrorLinesOptions {
  maxErrors?: number;
  maxCharsPerError?: number;
  bulletPrefix?: string;
}

function compactAutocodeHeadTailText(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }

  const marker = `... [truncated middle, ${value.length} chars total] ...`;
  if (marker.length >= maxChars - 2) {
    return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  const budget = maxChars - marker.length;
  const headLength = Math.ceil(budget * AUTOCODE_RETRY_COMPACTION_HEAD_RATIO);
  const tailLength = Math.max(0, budget - headLength);
  return [
    value.slice(0, headLength).trimEnd(),
    marker,
    tailLength > 0 ? value.slice(-tailLength).trimStart() : '',
  ].join('');
}

export function compactAutocodeRetryText(
  value: string,
  maxChars = AUTOCODE_RETRY_TEXT_MAX_CHARS,
): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return compactAutocodeHeadTailText(normalized, maxChars);
}

export function compactAutocodeRetryLine(
  value: string,
  maxChars = AUTOCODE_RETRY_ERROR_MAX_CHARS,
): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return compactAutocodeHeadTailText(normalized, maxChars);
}

export function formatAutocodeRetryErrorLines(
  errors: readonly string[],
  options: FormatAutocodeRetryErrorLinesOptions = {},
): string[] {
  const maxErrors = Math.max(0, options.maxErrors ?? AUTOCODE_RETRY_ERROR_LIMIT);
  const maxCharsPerError = Math.max(0, options.maxCharsPerError ?? AUTOCODE_RETRY_ERROR_MAX_CHARS);
  const bulletPrefix = options.bulletPrefix ?? '- ';
  const visible = errors.slice(0, maxErrors)
    .map((error) => `${bulletPrefix}${compactAutocodeRetryLine(error, maxCharsPerError)}`);
  const omitted = errors.length - visible.length;
  if (omitted > 0) {
    visible.push(`${bulletPrefix}... ${omitted} more error(s) omitted`);
  }
  return visible;
}
