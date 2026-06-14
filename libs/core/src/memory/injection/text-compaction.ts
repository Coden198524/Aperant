export function compactMemoryInjectionText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }

  const marker = ' ... [middle omitted] ... ';
  const budget = maxChars - marker.length;
  if (budget <= 0) {
    return compact.slice(0, maxChars);
  }

  const headChars = Math.ceil(budget * 0.6);
  const tailChars = budget - headChars;
  return `${compact.slice(0, headChars).trimEnd()}${marker}${compact.slice(-tailChars).trimStart()}`;
}
