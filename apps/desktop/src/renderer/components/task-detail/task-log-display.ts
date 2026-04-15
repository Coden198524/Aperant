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
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed)
  );
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

  for (const log of logs) {
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
