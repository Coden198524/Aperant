export const BROWSE_CONTENT_MAX_CHARS = 20_000;

const BROWSE_CONTENT_OMISSION_MARKER =
  '\n\n[Content middle omitted for context budget]\n\n';
const BROWSE_CONTENT_HEAD_RATIO = 0.6;

export function compactBrowseContent(
  content: string,
  maxChars: number = BROWSE_CONTENT_MAX_CHARS,
): string {
  if (maxChars <= 0 || content.length <= maxChars) {
    return content;
  }
  if (BROWSE_CONTENT_OMISSION_MARKER.length >= maxChars - 2) {
    return content.slice(0, maxChars);
  }

  const budget = maxChars - BROWSE_CONTENT_OMISSION_MARKER.length;
  const headChars = Math.ceil(budget * BROWSE_CONTENT_HEAD_RATIO);
  const tailChars = Math.max(0, budget - headChars);
  return [
    content.slice(0, headChars).trimEnd(),
    BROWSE_CONTENT_OMISSION_MARKER,
    tailChars > 0 ? content.slice(-tailChars).trimStart() : '',
  ].join('');
}
