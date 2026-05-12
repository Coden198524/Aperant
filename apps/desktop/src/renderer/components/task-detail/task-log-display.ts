import type { TaskLogEntry } from '../../../shared/types';

const TEXT_ENTRY_MERGE_WINDOW_MS = 5000;

export interface DisplayTaskLogEntry extends TaskLogEntry {
  mergedEntryCount?: number;
  mergedEndTimestamp?: string;
}

export interface DisplayRuntimeLog {
  content: string;
  mergedEntryCount?: number;
}

const RUNTIME_BOUNDARY_PATTERNS = [
  /Worker thread online:/g,
  /Starting agent session:/g,
  /Session complete:/g,
  /\|\s*Item\s*\|\s*Details\s*\|/g,
];

const COMPACT_SUMMARY_ROW_PATTERN = /\|\s*(What changed|Verification|Review notes)\s*\|/gi;
const COMPACT_SUMMARY_TABLE_PATTERN =
  /\|\s*Item\s*\|\s*Details\s*\|\s*\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|/i;

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function shouldStartNewLine(previousContent: string, nextContent: string): boolean {
  const previous = previousContent.trimEnd();
  const next = nextContent.trimStart();

  if (!previous || !next) {
    return false;
  }

  if (/^(```|`|- |\* |• |\d+\. )/.test(next)) {
    return /[：:。！？.!?`]$/.test(previous);
  }

  return false;
}

export function mergeStreamingTextContent(previousContent: string, nextContent: string): string {
  if (!previousContent) return nextContent;
  if (!nextContent) return previousContent;

  const previous = previousContent.trimEnd();
  const next = nextContent.trimStart();

  if (!previous) return next;
  if (!next) return previous;

  return shouldStartNewLine(previous, next)
    ? `${previous}\n${next}`
    : `${previous}${next}`;
}

function looksStructuredRuntimeLog(content: string): boolean {
  const trimmed = content.trimStart();

  return (
    /^\[[^\]]+\]/.test(trimmed) ||
    /^(INFO|WARN|WARNING|ERROR|DEBUG|TRACE)\b/i.test(trimmed) ||
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed) ||
    /^Worker thread online:/i.test(trimmed) ||
    /^Starting agent session:/i.test(trimmed) ||
    /^Session complete:/i.test(trimmed) ||
    /^\|/.test(trimmed)
  );
}

function insertRuntimeBoundaries(content: string): string {
  let normalized = content.replace(/\r\n?/g, '\n');

  for (const pattern of RUNTIME_BOUNDARY_PATTERNS) {
    normalized = normalized.replace(pattern, match => `\n${match}`);
  }

  return normalized
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeMarkdownTableCell(value: string): string {
  return value
    .trim()
    .replace(/^\|\s*/, '')
    .replace(/\s*\|$/, '')
    .trim()
    .replace(/\|/g, '\\|');
}

function expandCompactSummaryTableLine(line: string): string[] {
  const headerMatch = line.match(COMPACT_SUMMARY_TABLE_PATTERN);
  if (!headerMatch || headerMatch.index === undefined) {
    return [line];
  }

  const prefix = line.slice(0, headerMatch.index).trim();
  const remainderStart = headerMatch.index + headerMatch[0].length;
  const remainder = line.slice(remainderStart);
  const matches = [...remainder.matchAll(COMPACT_SUMMARY_ROW_PATTERN)];

  if (matches.length === 0) {
    return [line];
  }

  const expandedLines = [
    '| Item | Details |',
    '| --- | --- |',
  ];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const label = match[1];
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd = matches[index + 1]?.index ?? remainder.length;
    const details = normalizeMarkdownTableCell(remainder.slice(contentStart, contentEnd));

    expandedLines.push(`| ${label} | ${details} |`);
  }

  return prefix ? [prefix, ...expandedLines] : expandedLines;
}

function normalizeCompactSummaryTables(content: string): string {
  return content
    .split('\n')
    .flatMap(line => expandCompactSummaryTableLine(line))
    .join('\n');
}

function normalizeRuntimeLogContent(content: string): string {
  return normalizeCompactSummaryTables(insertRuntimeBoundaries(content));
}

function splitRuntimeLogBlocks(content: string): string[] {
  const normalized = normalizeRuntimeLogContent(content);
  if (!normalized) return [];

  const blocks: string[] = [];
  let current: string[] = [];
  let currentIsTable = false;

  const flush = () => {
    const block = current.join('\n').trim();
    if (block) {
      blocks.push(block);
    }
    current = [];
    currentIsTable = false;
  };

  for (const line of normalized.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.length > 0) {
        current.push(line);
      }
      continue;
    }

    const isLifecycleLine =
      /^Worker thread online:/i.test(trimmed) ||
      /^Starting agent session:/i.test(trimmed) ||
      /^Session complete:/i.test(trimmed);
    const isTableLine = /^\|/.test(trimmed);

    if (isLifecycleLine) {
      flush();
      blocks.push(trimmed);
      continue;
    }

    if (isTableLine) {
      if (!currentIsTable && current.length > 0) {
        flush();
      }
      currentIsTable = true;
      current.push(trimmed);
      continue;
    }

    if (currentIsTable) {
      flush();
    }

    current.push(line);
  }

  flush();
  return blocks;
}

function canMergeTextEntries(previousEntry: DisplayTaskLogEntry | undefined, nextEntry: TaskLogEntry): boolean {
  if (!previousEntry || previousEntry.type !== 'text' || nextEntry.type !== 'text') {
    return false;
  }

  if (previousEntry.phase !== nextEntry.phase) return false;
  if (previousEntry.subphase !== nextEntry.subphase) return false;
  if (previousEntry.subtask_id !== nextEntry.subtask_id) return false;
  if (previousEntry.detail || nextEntry.detail) return false;

  const previousTimestamp = parseTimestamp(previousEntry.mergedEndTimestamp ?? previousEntry.timestamp);
  const nextTimestamp = parseTimestamp(nextEntry.timestamp);
  if (previousTimestamp === null || nextTimestamp === null) {
    return true;
  }

  return nextTimestamp - previousTimestamp <= TEXT_ENTRY_MERGE_WINDOW_MS;
}

function canMergeRuntimeLogs(previousLog: DisplayRuntimeLog | undefined, nextLog: string): boolean {
  if (!previousLog) {
    return false;
  }

  const previous = previousLog.content.trim();
  const next = nextLog.trim();

  if (!previous || !next) {
    return true;
  }

  if (looksStructuredRuntimeLog(previous) || looksStructuredRuntimeLog(next)) {
    return false;
  }

  return true;
}

/**
 * Long model text responses are flushed to disk in short streaming chunks.
 * Merge adjacent text entries back into readable blocks before rendering.
 */
export function buildDisplayLogEntries(entries: TaskLogEntry[]): DisplayTaskLogEntry[] {
  const displayEntries: DisplayTaskLogEntry[] = [];

  for (const entry of entries) {
    const previousEntry = displayEntries[displayEntries.length - 1];

    if (canMergeTextEntries(previousEntry, entry)) {
      previousEntry.content = mergeStreamingTextContent(previousEntry.content, entry.content);
      previousEntry.mergedEntryCount = (previousEntry.mergedEntryCount ?? 1) + 1;
      previousEntry.mergedEndTimestamp = entry.timestamp;
      continue;
    }

    displayEntries.push({
      ...entry,
      ...(entry.type === 'text'
        ? {
            mergedEntryCount: 1,
            mergedEndTimestamp: entry.timestamp,
          }
        : {}),
    });
  }

  return displayEntries;
}

export function buildDisplayRuntimeLogs(logs: string[]): DisplayRuntimeLog[] {
  const displayLogs: DisplayRuntimeLog[] = [];

  for (const log of logs.flatMap(splitRuntimeLogBlocks)) {
    const previousLog = displayLogs[displayLogs.length - 1];

    if (canMergeRuntimeLogs(previousLog, log)) {
      previousLog.content = mergeStreamingTextContent(previousLog.content, log);
      previousLog.mergedEntryCount = (previousLog.mergedEntryCount ?? 1) + 1;
      continue;
    }

    displayLogs.push({
      content: log,
      mergedEntryCount: 1,
    });
  }

  return displayLogs;
}
