import { foldRepeatedAutocodePromptLines } from '../../runtime/prompt-context.js';
import { estimateTokens } from '../retrieval/context-packer.js';

export function compactMemoryInjectionText(text: string, maxChars: number, maxTokens?: number): string {
  if (maxChars <= 0 || (maxTokens !== undefined && maxTokens <= 0)) {
    return '';
  }
  const compact = foldRepeatedAutocodePromptLines(text).replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars && (maxTokens === undefined || estimateTokens(compact) <= maxTokens)) {
    return compact;
  }

  const charBounded = compactMemoryInjectionTextByChars(compact, maxChars);
  if (maxTokens === undefined || estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, compact.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = compactMemoryInjectionTextByChars(compact, midpoint);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function compactMemoryInjectionTextByChars(compact: string, maxChars: number): string {
  if (maxChars <= 0 || compact.length <= maxChars) {
    return compact.slice(0, Math.max(0, maxChars));
  }
  if (maxChars <= 3) {
    return compact.slice(0, maxChars);
  }

  const marker = ' ... [middle omitted] ... ';
  const effectiveMarker = marker.length >= maxChars - 2 ? '...' : marker;
  const budget = maxChars - effectiveMarker.length;

  const headChars = Math.ceil(budget * 0.6);
  const tailChars = budget - headChars;
  return `${compact.slice(0, headChars).trimEnd()}${effectiveMarker}${compact.slice(-tailChars).trimStart()}`;
}
