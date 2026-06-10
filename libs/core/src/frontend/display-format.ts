import { truncateAutocodeText } from './task-view-model.js';

export function formatAutocodeTokenCount(count: number): string {
  if (!Number.isFinite(count)) return '0';

  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(Math.round(count));
}

export function buildAutocodeTokenHoverTitle(label: string, count: number): string {
  const exactTokens = Math.round(count);
  const tokenText = new Intl.NumberFormat().format(exactTokens);

  return `${label}: ${tokenText}`;
}

export function sanitizeAutocodeMarkdownForDisplay(text: string, maxLength = 200): string {
  if (!text) return '';

  let sanitized = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    .replace(/^[-*_]{3,}$/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/\[[ x]\]\s*/gi, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (maxLength > 0 && sanitized.length > maxLength) {
    sanitized = truncateAutocodeText(sanitized, maxLength);
  }

  return sanitized;
}
