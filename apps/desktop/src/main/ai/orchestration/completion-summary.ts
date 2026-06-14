import type { SessionResult } from '../session/types';
import { compactHeadTailSingleLineText } from './prompt-compaction';

const MAX_FALLBACK_COMPLETION_SUMMARY_CHARS = 900;
const MAX_PRESERVED_COMPLETION_TABLE_CHARS = 1400;

export function summarizeSessionCompletion(result: SessionResult): string | undefined {
  const content = [...(result.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim())?.content;
  if (!content) {
    return undefined;
  }

  const tableSummary = extractCompletionSummaryTable(content);
  if (tableSummary) {
    return compactMultilineText(tableSummary, MAX_PRESERVED_COMPLETION_TABLE_CHARS);
  }

  const normalized = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#*_>\-[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return undefined;
  }

  return formatCompletionSummaryTable(
    compactText(normalized, MAX_FALLBACK_COMPLETION_SUMMARY_CHARS),
    result,
  );
}

function compactMultilineText(value: string, maxChars: number): string {
  const compact = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  const marker = '\n...[completion table middle omitted]...\n';
  const budget = maxChars - marker.length;
  if (budget <= 0) {
    return compact.slice(0, maxChars);
  }
  const headChars = Math.ceil(budget * 0.65);
  const tailChars = budget - headChars;
  return `${compact.slice(0, headChars).trimEnd()}${marker}${compact.slice(-tailChars).trimStart()}`;
}

function extractCompletionSummaryTable(content: string): string | undefined {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const start = lines.findIndex((line, index) => {
    const next = lines[index + 1] ?? '';
    return /^\|\s*(?:Item|项目)\s*\|\s*(?:Details|详情)\s*\|$/i.test(line) &&
      /^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|$/.test(next);
  });

  if (start < 0) {
    return undefined;
  }

  const tableLines = lines
    .slice(start)
    .filter((line) => line.startsWith('|') && line.endsWith('|'));
  return tableLines.length >= 3 ? tableLines.join('\n') : undefined;
}

function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
}

function formatCompletionSummaryTable(summary: string, result: SessionResult): string {
  const verification = [
    `Session outcome: ${result.outcome}`,
    `Steps: ${result.stepsExecuted ?? 0}`,
    `Tools: ${result.toolCallCount ?? 0}`,
    formatTokenUsage(result),
  ].join('. ');

  return [
    '| Item | Details |',
    '| --- | --- |',
    `| What changed | ${escapeMarkdownTableCell(summary)} |`,
    `| Verification | ${escapeMarkdownTableCell(verification)} |`,
    '| Review notes | Review changed files, runtime output, and git diff before approval. |',
  ].join('\n');
}

function formatTokenUsage(result: SessionResult): string {
  const usage = result.usage;
  if (!usage || usage.totalTokens <= 0) {
    return 'Tokens: unavailable';
  }
  const estimated = usage.estimated ? ', estimated' : '';
  return `Tokens: ${usage.totalTokens} total (${usage.promptTokens} prompt, ${usage.completionTokens} completion${estimated})`;
}

function compactText(value: string, maxChars: number): string {
  return compactHeadTailSingleLineText(value, maxChars);
}
