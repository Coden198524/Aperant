import { foldRepeatedAutocodePromptLines } from '../../runtime/prompt-context.js';
import type { Memory } from '../types.js';

export interface VisibleMemoryItem {
  memory: Memory;
  renderedLine: string;
}

export function getRenderedVisibleMemories(
  context: string,
  items: readonly VisibleMemoryItem[],
): Memory[] {
  const normalizedContext = normalizeRenderedText(context);
  if (!normalizedContext) {
    return [];
  }

  const visible: Memory[] = [];
  for (const item of items) {
    const renderedLine = normalizeRenderedText(item.renderedLine);
    if (
      renderedLine &&
      containsCompleteRenderedLine(normalizedContext, renderedLine)
    ) {
      visible.push(item.memory);
    }
  }
  return visible;
}

function containsCompleteRenderedLine(
  normalizedContext: string,
  renderedLine: string,
): boolean {
  let startIndex = normalizedContext.indexOf(renderedLine);
  while (startIndex >= 0) {
    const before = normalizedContext.slice(0, startIndex);
    const after = normalizedContext.slice(startIndex + renderedLine.length);
    if (
      hasRenderedLineStartBoundary(before) &&
      hasRenderedLineEndBoundary(after)
    ) {
      return true;
    }
    startIndex = normalizedContext.indexOf(renderedLine, startIndex + 1);
  }
  return false;
}

function hasRenderedLineStartBoundary(before: string): boolean {
  return before.length === 0 || /\s$/.test(before);
}

function hasRenderedLineEndBoundary(after: string): boolean {
  if (after.length === 0) {
    return true;
  }
  return (
    after.startsWith(' - ') ||
    after.startsWith(' ===') ||
    after.startsWith(' ... [middle omitted]') ||
    /^[ ]+[A-Z0-9][A-Z0-9 /-]* - /.test(after)
  );
}

function normalizeRenderedText(value: string): string {
  return foldRepeatedAutocodePromptLines(value).replace(/\s+/g, ' ').trim();
}
