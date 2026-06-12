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

interface CodeLineClassification {
  isCode: boolean;
  strongSignal: boolean;
  startsPatch: boolean;
}

const RUNTIME_BOUNDARY_PATTERNS = [
  /Worker thread online:/g,
  /Starting agent session:/g,
  /Starting SpecOrchestrator pipeline/g,
  /Aggressive workflow enabled:/g,
  /Generating project index\.\.\./g,
  /Project index generated/g,
  /Project index generation failed/g,
  /No project instructions found/g,
  /Spec phase \d+\/\d+:/g,
  /Standard planning:/g,
  /Running [\w-]+ session/g,
  /Applied MMO routing hints:/g,
  /Complexity (?:assessed|fallback|heuristic|override|escalated)/g,
  /Running (?:simple|standard|complex) workflow:/g,
  /Skipping [\w-]+/g,
  /Wrote [\w.-]+ from/g,
  /Phase [\w-]+ (?:output validation|schema validation|failed)/g,
  /Session complete:/g,
  /\|\s*Item\s*\|\s*Details\s*\|/g,
];

const COMPACT_SUMMARY_ROW_PATTERN = /\|\s*(What changed|Verification|Review notes)\s*\|/gi;
const COMPACT_SUMMARY_TABLE_PATTERN =
  /\|\s*Item\s*\|\s*Details\s*\|\s*\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|/i;
const FENCED_CODE_BLOCK_PATTERN = /(^|\n)\s*(```|~~~)/;
const NOISY_CODEX_DIAGNOSTIC_PATTERNS = [
  /WARN\s+codex_core::shell_snapshot:\s+Failed to create shell snapshot for powershell\b/i,
  /WARN\s+codex_core_plugins::manifest:\s+ignoring interface\.defaultPrompt\[\d+\]:\s+prompt must be at most \d+ characters\b/i,
  /WARN\s+codex_core_skills::loader:\s+ignoring interface\.icon_(?:small|large):\s+icon path with '\.\.' must resolve under plugin assets\//i,
];

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function stripLogTimestampPrefix(value: string): string {
  return value.replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+/, '').trim();
}

function isNoisyCodexDiagnosticLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  const withoutTimestamp = stripLogTimestampPrefix(trimmed);
  return NOISY_CODEX_DIAGNOSTIC_PATTERNS.some(pattern => pattern.test(withoutTimestamp));
}

export function stripNoisyCodexDiagnostics(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(line => !isNoisyCodexDiagnosticLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeDisplayLogEntry(entry: TaskLogEntry): TaskLogEntry | null {
  if (entry.type !== 'text') {
    return entry;
  }

  const content = stripNoisyCodexDiagnostics(entry.content);
  if (!content) {
    return null;
  }

  const detail = entry.detail ? stripNoisyCodexDiagnostics(entry.detail) : undefined;

  return {
    ...entry,
    content,
    ...(detail ? { detail } : { detail: undefined }),
  };
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

function isLikelyJsonLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }

  return /^["']?[\w.-]+["']?\s*:\s*.+,?$/.test(trimmed) && /["'{}[\],]/.test(trimmed);
}

function classifyMarkdownLogLine(line: string, insidePatch: boolean): CodeLineClassification {
  const trimmed = line.trim();

  if (!trimmed) {
    return { isCode: false, strongSignal: false, startsPatch: false };
  }

  if (/^diff --git\b|^@@\s|^index\s+[0-9a-f]{5,}\b|^(---|\+\+\+)\s+[ab/]/.test(trimmed)) {
    return { isCode: true, strongSignal: true, startsPatch: true };
  }

  if (insidePatch && (/^[ +-]/.test(line) || /^\\ No newline at end of file/.test(trimmed))) {
    return { isCode: true, strongSignal: true, startsPatch: false };
  }

  if (/^\|.+\|$/.test(trimmed)) {
    return { isCode: false, strongSignal: false, startsPatch: false };
  }

  if (/^(#{1,6}\s|[-*+]\s+\S|\d+\.\s+\S|>\s+\S)/.test(trimmed)) {
    return { isCode: false, strongSignal: false, startsPatch: false };
  }

  if (/^<\/?[A-Za-z][^>]*>$/.test(trimmed) || /^<!doctype\s+html>/i.test(trimmed)) {
    return { isCode: true, strongSignal: true, startsPatch: false };
  }

  if (isLikelyJsonLine(trimmed)) {
    return { isCode: true, strongSignal: true, startsPatch: false };
  }

  if (
    /^(import|export|const|let|var|function|class|interface|type|enum|return|if|else|for|while|switch|case|try|catch|async|await)\b/.test(trimmed) ||
    /^(def|from|class|return|if|elif|else|for|while|try|except|with)\b/.test(trimmed) ||
    /^[.#]?[\w-]+\s*\{/.test(trimmed) ||
    /^[}\]);,]+$/.test(trimmed)
  ) {
    return { isCode: true, strongSignal: /[{}();=<>]/.test(trimmed), startsPatch: false };
  }

  if (/^\s{2,}\S/.test(line) && /[{}();=<>]/.test(trimmed)) {
    return { isCode: true, strongSignal: false, startsPatch: false };
  }

  return { isCode: false, strongSignal: false, startsPatch: false };
}

function countNonBlankLines(lines: string[]): number {
  return lines.filter(line => line.trim()).length;
}

function guessCodeFenceLanguage(lines: string[]): string {
  const block = lines.join('\n');
  const trimmed = block.trim();

  if (/^diff --git\b|^@@\s/m.test(trimmed)) return 'diff';
  if (/^<!doctype\s+html>|<\/?[A-Za-z][^>]*>/i.test(trimmed)) return 'html';
  if (/^(import|export|const|let|function|class|interface|type|enum)\b/m.test(trimmed)) return 'ts';
  if (/^([.#][\w-]+|[A-Za-z][\w-]*(?:\s+[.#]?[A-Za-z][\w-]*)?)\s*\{/m.test(trimmed)) return 'css';
  if (/^(def|from|class|import)\b/m.test(trimmed)) return 'py';

  try {
    JSON.parse(trimmed);
    return 'json';
  } catch {
    return '';
  }
}

function shouldFenceCodeBlock(lines: string[], strongSignal: boolean): boolean {
  const nonBlankLineCount = countNonBlankLines(lines);
  if (nonBlankLineCount === 0) return false;
  if (strongSignal) return true;
  return nonBlankLineCount >= 2;
}

function fenceCodeBlock(lines: string[]): string[] {
  const language = guessCodeFenceLanguage(lines);
  return [`\`\`\`${language}`, ...lines, '```'];
}

/**
 * The model often streams raw diffs or file contents without Markdown fences.
 * Keep authored Markdown intact, but wrap bare code-like blocks so the runtime
 * panel renders code/text changes as readable code blocks.
 */
export function formatLogMarkdownForDisplay(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n').trim();
  if (!normalized || FENCED_CODE_BLOCK_PATTERN.test(normalized)) {
    return normalized;
  }

  const output: string[] = [];
  let codeBlock: string[] = [];
  let codeBlockHasStrongSignal = false;
  let insidePatch = false;

  const flushCodeBlock = () => {
    if (codeBlock.length === 0) return;

    if (shouldFenceCodeBlock(codeBlock, codeBlockHasStrongSignal)) {
      output.push(...fenceCodeBlock(codeBlock));
    } else {
      output.push(...codeBlock);
    }

    codeBlock = [];
    codeBlockHasStrongSignal = false;
    insidePatch = false;
  };

  for (const line of normalized.split('\n')) {
    const classification = classifyMarkdownLogLine(line, insidePatch);

    if (classification.isCode || (insidePatch && line.trim() === '')) {
      codeBlock.push(line);
      codeBlockHasStrongSignal ||= classification.strongSignal;
      insidePatch ||= classification.startsPatch;
      continue;
    }

    flushCodeBlock();
    output.push(line);
  }

  flushCodeBlock();

  return output.join('\n').replace(/\n{4,}/g, '\n\n\n');
}

function looksStructuredRuntimeLog(content: string): boolean {
  const trimmed = content.trimStart();

  return (
    /^\[[^\]]+\]/.test(trimmed) ||
    /^(INFO|WARN|WARNING|ERROR|DEBUG|TRACE)\b/i.test(trimmed) ||
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed) ||
    /^Worker thread online:/i.test(trimmed) ||
    /^Starting agent session:/i.test(trimmed) ||
    /^Starting SpecOrchestrator pipeline/i.test(trimmed) ||
    /^Aggressive workflow enabled:/i.test(trimmed) ||
    /^Generating project index/i.test(trimmed) ||
    /^Project index generated/i.test(trimmed) ||
    /^Project index generation failed/i.test(trimmed) ||
    /^No project instructions found/i.test(trimmed) ||
    /^Spec phase \d+\/\d+:/i.test(trimmed) ||
    /^Standard planning:/i.test(trimmed) ||
    /^Running [\w-]+ session/i.test(trimmed) ||
    /^Applied MMO routing hints:/i.test(trimmed) ||
    /^Complexity (assessed|fallback|heuristic|override|escalated)/i.test(trimmed) ||
    /^Running (simple|standard|complex) workflow:/i.test(trimmed) ||
    /^Skipping [\w-]+/i.test(trimmed) ||
    /^Wrote [\w.-]+ from/i.test(trimmed) ||
    /^Phase [\w-]+ (output validation|schema validation|failed)/i.test(trimmed) ||
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

function normalizeInternalSpecPhaseNames(content: string): string {
  return content
    .replace(/(Spec phase \d+\/\d+:\s*)quick_spec\b/gi, '$1Standard light planning')
    .replace(/\b(Standard planning:\s*)quick_spec\b/gi, '$1Standard light planning')
    .replace(/\b(Error in spec\s*)quick_spec(\s*phase:)/gi, '$1Standard light planning$2')
    .replace(/\(spec phase=quick_spec\b/gi, '(spec phase=Standard light planning')
    .replace(/\bquick_spec\b/gi, 'Standard light planning');
}

function normalizeRuntimeLogContent(content: string): string {
  return normalizeInternalSpecPhaseNames(normalizeCompactSummaryTables(insertRuntimeBoundaries(content)));
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
      /^Starting SpecOrchestrator pipeline/i.test(trimmed) ||
      /^Aggressive workflow enabled:/i.test(trimmed) ||
      /^Generating project index/i.test(trimmed) ||
      /^Project index generated/i.test(trimmed) ||
      /^Project index generation failed/i.test(trimmed) ||
      /^No project instructions found/i.test(trimmed) ||
      /^Spec phase \d+\/\d+:/i.test(trimmed) ||
      /^Standard planning:/i.test(trimmed) ||
      /^Running [\w-]+ session/i.test(trimmed) ||
      /^Applied MMO routing hints:/i.test(trimmed) ||
      /^Complexity (assessed|fallback|heuristic|override|escalated)/i.test(trimmed) ||
      /^Running (simple|standard|complex) workflow:/i.test(trimmed) ||
      /^Skipping [\w-]+/i.test(trimmed) ||
      /^Wrote [\w.-]+ from/i.test(trimmed) ||
      /^Phase [\w-]+ (output validation|schema validation|failed)/i.test(trimmed) ||
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

  for (const rawEntry of entries) {
    const entry = normalizeDisplayLogEntry(rawEntry);
    if (!entry) {
      continue;
    }

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

  for (const log of logs.flatMap(value => splitRuntimeLogBlocks(stripNoisyCodexDiagnostics(value)))) {
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
