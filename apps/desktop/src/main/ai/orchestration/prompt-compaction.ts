export function compactHeadTailSingleLineText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const marker = ' ... [truncated middle] ... ';
  const budget = maxChars - marker.length;
  if (budget <= 0) {
    return normalized.slice(0, maxChars);
  }

  const headChars = Math.ceil(budget * 0.6);
  const tailChars = budget - headChars;
  return `${normalized.slice(0, headChars).trimEnd()}${marker}${normalized.slice(-tailChars).trimStart()}`;
}
