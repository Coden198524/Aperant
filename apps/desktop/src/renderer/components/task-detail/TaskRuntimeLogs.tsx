import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDownToLine, Bot, ChevronDown, ChevronRight } from 'lucide-react';
import { PROVIDER_REGISTRY } from '@shared/constants/providers';
import { getProviderModelLabel } from '@shared/utils/model-display';
import { cn } from '../../lib/utils';
import { useTaskStore } from '../../stores/task-store';
import type { Task, TaskLogEntry, TaskLogPhase, TaskLogStreamChunk, TaskLogs as TaskLogsData } from '../../../shared/types';
import type { PhaseModelConfig } from '../../../shared/types/settings';
import type { BuiltinProvider } from '../../../shared/types/provider-account';
import {
  buildDisplayLogEntries,
  findCodexToolRouterErrorLog,
  formatLogMarkdownForDisplay,
  isPowerShellJsonParseFailureLog,
  isRawCodexInternalEventLog,
  normalizeRawCodexInternalEventLog,
  type DisplayTaskLogEntry,
} from './task-log-display';
import { Button } from '../ui/button';

interface TaskRuntimeLogsProps {
  task: Task;
  className?: string;
  modelLogs?: TaskLogsData | null;
  scope?: TaskRuntimeLogScope;
  compact?: boolean;
  title?: string;
}

type ModelOutputEntryType = 'text' | 'tool_start' | 'tool_end' | 'error';

export type TaskRuntimeLogScope =
  | { type: 'none' }
  | { type: 'global' }
  | { type: 'work-item'; workItemId: string };

interface UseTaskModelLogsOptions {
  enabled?: boolean;
}

interface RuntimeModelInfo {
  provider?: string;
  modelId?: string;
}

const MODEL_OUTPUT_ENTRY_TYPES = new Set<ModelOutputEntryType>([
  'text',
  'tool_start',
  'tool_end',
  'error',
]);

const MODEL_PHASE_STYLES: Record<TaskLogPhase, {
  rail: string;
  prompt: string;
  chip: string;
  latest: string;
}> = {
  planning: {
    rail: 'bg-warning',
    prompt: 'text-warning',
    chip: 'border-warning/30 bg-warning/10 text-warning',
    latest: 'border-warning/40 bg-warning/5',
  },
  coding: {
    rail: 'bg-info',
    prompt: 'text-info',
    chip: 'border-info/30 bg-info/10 text-info',
    latest: 'border-info/40 bg-info/5',
  },
  validation: {
    rail: 'bg-success',
    prompt: 'text-success',
    chip: 'border-success/30 bg-success/10 text-success',
    latest: 'border-success/40 bg-success/5',
  },
};

const TYPEWRITER_CHARS_PER_TICK = 12;
const TYPEWRITER_TICK_MS = 18;
const INITIAL_RENDERED_MODEL_ENTRIES = 250;
const LOG_RENDER_BATCH_SIZE = 250;
const LOAD_MORE_SCROLL_THRESHOLD = 96;
const GLOBAL_LOG_SCOPE: TaskRuntimeLogScope = { type: 'global' };
const MODEL_OUTPUT_LINK_CLASS = [
  'break-all rounded-sm px-0.5 font-semibold underline decoration-sky-500/45 underline-offset-2',
  'text-sky-700 hover:text-sky-800 hover:decoration-sky-700',
  'dark:text-sky-300 dark:decoration-sky-300/55 dark:hover:text-sky-200'
].join(' ');
const MODEL_OUTPUT_INLINE_CODE_CLASS = [
  'rounded border border-sky-500/25 bg-sky-50 px-1 py-0.5 font-mono text-[11px] font-medium text-sky-800',
  'dark:border-sky-300/25 dark:bg-sky-400/10 dark:text-sky-100'
].join(' ');

function isConcurrentRuntimeTask(task: Task): boolean {
  const concurrency = task.metadata?.runtimeConcurrency;
  return concurrency?.mode === 'concurrent' && (concurrency.workers ?? 1) > 1;
}

export function isWorkPackageSubtask(subtask: Task['subtasks'][number]): boolean {
  const workItem = subtask as Task['subtasks'][number] & { workPackage?: boolean };
  return workItem.workPackage === true || /^wp-\d+$/i.test(subtask.id);
}

function getConcurrentWorkPackageIds(task: Task): Set<string> {
  if (!isConcurrentRuntimeTask(task)) {
    return new Set();
  }

  return new Set(
    task.subtasks
      .filter(isWorkPackageSubtask)
      .map(subtask => subtask.id)
      .filter(Boolean)
  );
}

export function shouldSplitConcurrentWorkPackageLogs(task: Task): boolean {
  return getConcurrentWorkPackageIds(task).size > 0;
}

function shouldIncludeModelEntryInScope(
  entry: TaskLogEntry,
  task: Task,
  scope: TaskRuntimeLogScope,
): boolean {
  if (scope.type === 'none') {
    return false;
  }

  if (scope.type === 'work-item') {
    return entry.subtask_id === scope.workItemId;
  }

  const splitWorkPackageIds = getConcurrentWorkPackageIds(task);
  if (splitWorkPackageIds.size === 0) {
    return true;
  }

  return !entry.subtask_id || !splitWorkPackageIds.has(entry.subtask_id);
}

export function countTaskRuntimeLogEntriesForScope(
  logs: TaskLogsData | null,
  task: Task,
  scope: TaskRuntimeLogScope,
): number {
  if (!logs) {
    return 0;
  }

  const entries = [
    ...logs.phases.planning.entries,
    ...logs.phases.coding.entries,
    ...logs.phases.validation.entries,
  ].filter(entry =>
    MODEL_OUTPUT_ENTRY_TYPES.has(entry.type as ModelOutputEntryType) &&
    shouldIncludeModelEntryInScope(entry, task, scope)
  );

  return buildDisplayLogEntries(entries).length;
}

const modelMarkdownComponents: Components = {
  p: ({ children }) => (
    <p className="my-1.5 leading-relaxed text-foreground">
      {children}
    </p>
  ),
  h1: ({ children }) => (
    <h1 className="mb-2 mt-3 text-sm font-semibold text-foreground">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-3 text-[13px] font-semibold text-foreground">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-2.5 text-xs font-semibold text-foreground">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-2 text-[11px] font-semibold text-foreground">
      {children}
    </h4>
  ),
  ul: ({ children }) => (
    <ul className="my-1.5 ml-4 list-disc space-y-1 text-foreground">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 ml-4 list-decimal space-y-1 text-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="pl-1 leading-relaxed marker:text-sky-600 dark:marker:text-sky-300">
      {children}
    </li>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">
      {children}
    </strong>
  ),
  em: ({ children }) => (
    <em className="text-muted-foreground">
      {children}
    </em>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 rounded-r-md border-l-2 border-primary/40 bg-primary/5 py-1 pl-3 text-foreground/80">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={MODEL_OUTPUT_LINK_CLASS}
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    const isInline = !className;

    if (isInline) {
      return (
        <code className={MODEL_OUTPUT_INLINE_CODE_CLASS} {...props}>
          {children}
        </code>
      );
    }

    return (
      <code className={cn('block whitespace-pre font-mono text-[11px] leading-relaxed text-foreground', className)} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 max-w-full overflow-x-auto rounded-md border border-border bg-muted/70 p-2.5">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto rounded-md border border-border bg-card">
      <table className="w-full border-collapse text-[11px] text-foreground">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-r border-border bg-muted px-2 py-1.5 text-left font-semibold text-foreground last:border-r-0">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-r border-border px-2 py-1.5 align-top last:border-r-0">
      {children}
    </td>
  ),
  hr: () => <hr className="my-3 border-border" />,
};

function createEmptyTaskLogs(specId: string, timestamp: string): TaskLogsData {
  return {
    spec_id: specId,
    created_at: timestamp,
    updated_at: timestamp,
    phases: {
      planning: { phase: 'planning', status: 'pending', started_at: null, completed_at: null, entries: [] },
      coding: { phase: 'coding', status: 'pending', started_at: null, completed_at: null, entries: [] },
      validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] },
    },
  };
}

function mergeModelTextChunk(
  currentLogs: TaskLogsData | null,
  specId: string,
  chunk: TaskLogStreamChunk
): TaskLogsData | null {
  if (chunk.source === 'task_logs') {
    return currentLogs;
  }

  if (!chunk.phase || !MODEL_OUTPUT_ENTRY_TYPES.has(chunk.type as ModelOutputEntryType)) {
    return currentLogs;
  }

  const timestamp = chunk.timestamp ?? new Date().toISOString();
  const nextLogs = structuredClone(currentLogs ?? createEmptyTaskLogs(specId, timestamp));
  const phase = chunk.phase;
  const phaseLog = nextLogs.phases[phase];
  const toolName = chunk.tool?.name;
  const toolInput = chunk.tool?.input;
  const content = chunk.content ?? (toolName ? `[${toolName}] ${toolInput ?? ''}`.trim() : '');

  if (!content) {
    return currentLogs;
  }

  if (chunk.type === 'text' && chunk.source === 'sdk') {
    const previousEntry = phaseLog.entries[phaseLog.entries.length - 1];
    if (
      previousEntry?.type === 'text' &&
      previousEntry.phase === phase &&
      previousEntry.subtask_id === chunk.subtask_id &&
      previousEntry.session === chunk.session &&
      !previousEntry.detail
    ) {
      previousEntry.content += content;
      previousEntry.timestamp = timestamp;
      nextLogs.updated_at = timestamp;
      return nextLogs;
    }
  }

  const exists = phaseLog.entries.some(entry =>
    entry.timestamp === timestamp &&
    entry.type === chunk.type &&
    entry.content === content &&
    entry.phase === phase
  );

  if (exists) {
    return currentLogs;
  }

  phaseLog.status = phaseLog.status === 'pending' ? 'active' : phaseLog.status;
  phaseLog.started_at = phaseLog.started_at ?? timestamp;
  phaseLog.entries.push({
    timestamp,
    type: chunk.type as TaskLogEntry['type'],
    content,
    phase,
    ...(chunk.model ? { model: chunk.model } : {}),
    ...(toolName ? { tool_name: toolName } : {}),
    ...(toolInput ? { tool_input: toolInput } : {}),
    ...(chunk.tool?.success !== undefined ? { tool_success: chunk.tool.success } : {}),
    ...(chunk.tool_call_id ? { tool_call_id: chunk.tool_call_id } : {}),
    ...(chunk.subtask_id ? { subtask_id: chunk.subtask_id } : {}),
    ...(chunk.session ? { session: chunk.session } : {}),
  });
  nextLogs.updated_at = timestamp;

  return nextLogs;
}

function getLogTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getLatestLogTimestamp(...timestamps: Array<string | null | undefined>): string {
  let latest = timestamps.find((timestamp): timestamp is string => Boolean(timestamp)) ?? new Date().toISOString();

  for (const timestamp of timestamps) {
    if (timestamp && getLogTimestamp(timestamp) > getLogTimestamp(latest)) {
      latest = timestamp;
    }
  }

  return latest;
}

function getPhaseStatusRank(status: TaskLogsData['phases'][TaskLogPhase]['status']): number {
  switch (status) {
    case 'failed':
      return 3;
    case 'completed':
      return 2;
    case 'active':
      return 1;
    default:
      return 0;
  }
}

function pickMergedPhaseStatus(
  currentPhase: TaskLogsData['phases'][TaskLogPhase],
  nextPhase: TaskLogsData['phases'][TaskLogPhase],
): TaskLogsData['phases'][TaskLogPhase]['status'] {
  const currentTimestamp = getPhaseActivityTimestamp(currentPhase);
  const nextTimestamp = getPhaseActivityTimestamp(nextPhase);

  if (nextTimestamp > currentTimestamp) {
    return nextPhase.status;
  }
  if (currentTimestamp > nextTimestamp) {
    return currentPhase.status;
  }

  return getPhaseStatusRank(currentPhase.status) > getPhaseStatusRank(nextPhase.status)
    ? currentPhase.status
    : nextPhase.status;
}

function getPhaseActivityTimestamp(phase: TaskLogsData['phases'][TaskLogPhase]): number {
  return Math.max(
    getLogTimestamp(phase.completed_at),
    getLogTimestamp(phase.started_at),
    ...phase.entries.map(entry => getLogTimestamp(entry.timestamp))
  );
}

function getEntryExactKey(entry: TaskLogEntry): string {
  return [
    entry.phase,
    entry.type,
    entry.timestamp,
    entry.content,
    entry.tool_call_id ?? '',
    entry.tool_name ?? '',
    entry.subtask_id ?? '',
    entry.session ?? '',
  ].join('\u0001');
}

function getToolLifecycleKey(entry: TaskLogEntry): string | null {
  if ((entry.type !== 'tool_start' && entry.type !== 'tool_end') || !entry.tool_call_id) {
    return null;
  }

  return [entry.phase, entry.type, entry.tool_call_id].join('\u0001');
}

function normalizeTextForDedupe(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isCompatibleTextScope(left: TaskLogEntry, right: TaskLogEntry): boolean {
  if (left.type !== 'text' || right.type !== 'text') {
    return false;
  }

  if (left.phase !== right.phase) return false;
  if (left.subtask_id !== right.subtask_id) return false;

  // Persisted task_logs entries may not have a session, while live SDK chunks do.
  // Treat a missing session as compatible so file refreshes do not duplicate live output.
  return left.session === right.session || left.session == null || right.session == null;
}

function isDuplicateOrContainedText(existing: TaskLogEntry, incoming: TaskLogEntry): boolean {
  if (!isCompatibleTextScope(existing, incoming)) {
    return false;
  }

  const existingText = normalizeTextForDedupe(existing.content);
  const incomingText = normalizeTextForDedupe(incoming.content);
  if (!existingText || !incomingText) {
    return false;
  }

  return existingText === incomingText || existingText.includes(incomingText);
}

function hasEquivalentNonTextEntry(entries: TaskLogEntry[], entry: TaskLogEntry): boolean {
  const exactKey = getEntryExactKey(entry);
  const toolKey = getToolLifecycleKey(entry);

  return entries.some(existing =>
    getEntryExactKey(existing) === exactKey ||
    (toolKey !== null && getToolLifecycleKey(existing) === toolKey)
  );
}

function isSameTextScope(left: TaskLogEntry, right: TaskLogEntry): boolean {
  return isCompatibleTextScope(left, right);
}

function mergeLiveTextEntry(entries: TaskLogEntry[], entry: TaskLogEntry): void {
  const sameScopeEntries = entries
    .map((existing, index) => ({ existing, index }))
    .filter(({ existing }) => isSameTextScope(existing, entry));

  if (sameScopeEntries.some(({ existing }) => isDuplicateOrContainedText(existing, entry))) {
    return;
  }

  const combinedScopeContent = normalizeTextForDedupe(sameScopeEntries.map(({ existing }) => existing.content).join(''));
  const entryContent = normalizeTextForDedupe(entry.content);
  if (combinedScopeContent.includes(entryContent)) {
    return;
  }

  const prefixMatch = sameScopeEntries
    .filter(({ existing }) => entryContent.startsWith(normalizeTextForDedupe(existing.content)))
    .sort((left, right) => right.existing.content.length - left.existing.content.length)[0];

  if (prefixMatch) {
    if (entryContent.length > normalizeTextForDedupe(prefixMatch.existing.content).length) {
      entries[prefixMatch.index] = { ...prefixMatch.existing, ...entry };
    }
    return;
  }

  entries.push({ ...entry });
}

function mergeTaskLogEntries(fullEntries: TaskLogEntry[], currentEntries: TaskLogEntry[]): TaskLogEntry[] {
  const merged = fullEntries.map(entry => ({ ...entry }));

  for (const entry of currentEntries) {
    if (entry.type === 'text') {
      mergeLiveTextEntry(merged, entry);
      continue;
    }

    if (!hasEquivalentNonTextEntry(merged, entry)) {
      merged.push({ ...entry });
    }
  }

  return merged.sort((left, right) => getLogTimestamp(left.timestamp) - getLogTimestamp(right.timestamp));
}

function mergeFullLogsWithoutRegressingStream(
  currentLogs: TaskLogsData | null,
  nextLogs: TaskLogsData | null
): TaskLogsData | null {
  if (!nextLogs) return currentLogs ?? null;
  if (!currentLogs) return nextLogs;

  const mergedLogs = structuredClone(nextLogs);
  const phases: TaskLogPhase[] = ['planning', 'coding', 'validation'];

  for (const phase of phases) {
    const currentPhase = currentLogs.phases[phase];
    const nextPhase = nextLogs.phases[phase];

    mergedLogs.phases[phase] = {
      ...nextPhase,
      status: pickMergedPhaseStatus(currentPhase, nextPhase),
      started_at: nextPhase.started_at ?? currentPhase.started_at,
      completed_at: nextPhase.completed_at ?? currentPhase.completed_at,
      entries: mergeTaskLogEntries(nextPhase.entries, currentPhase.entries),
    };
  }

  mergedLogs.updated_at = getLatestLogTimestamp(currentLogs.updated_at, nextLogs.updated_at);
  return mergedLogs;
}

function getTaskExecutionLogPhase(task: Task): TaskLogPhase | null {
  const phase = String(task.executionProgress?.phase ?? '');

  if (phase === 'planning') {
    return 'planning';
  }

  if (phase === 'qa_review' || phase === 'qa_fixing' || phase === 'validation') {
    return 'validation';
  }

  if (phase) {
    return 'coding';
  }

  return null;
}

function getActiveModelPhase(logs: TaskLogsData | null, task: Task): TaskLogPhase | null {
  if (logs) {
    const activePhase = Object.values(logs.phases).find(phase => phase.status === 'active');
    if (activePhase) {
      return activePhase.phase;
    }
  }

  return getTaskExecutionLogPhase(task);
}

function getProviderName(provider?: string): string | undefined {
  if (!provider) return undefined;
  return PROVIDER_REGISTRY.find(entry => entry.id === provider)?.name ?? provider;
}

function getConfigPhaseForLogPhase(phase: TaskLogPhase | null): keyof PhaseModelConfig {
  switch (phase) {
    case 'coding':
      return 'coding';
    case 'validation':
      return 'qa';
    case 'planning':
    default:
      return 'planning';
  }
}

function getFallbackModelInfo(task: Task, activePhase: TaskLogPhase | null): RuntimeModelInfo | null {
  const metadata = task.metadata;
  if (!metadata) return null;

  const configPhase = getConfigPhaseForLogPhase(activePhase);
  const modelId = metadata.phaseModels?.[configPhase] ?? metadata.model;
  const provider = metadata.phaseProviders?.[configPhase] ?? metadata.provider;

  if (!modelId && !provider) {
    return null;
  }

  return { modelId, provider };
}

function getRuntimeModelInfo(
  entries: DisplayTaskLogEntry[],
  task: Task,
  activePhase: TaskLogPhase | null
): RuntimeModelInfo | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const model = entries[index].model;
    if (model?.modelId || model?.provider) {
      return model;
    }
  }

  return getFallbackModelInfo(task, activePhase);
}

function formatModelInfo(info: RuntimeModelInfo | null): string | null {
  if (!info?.modelId && !info?.provider) {
    return null;
  }

  const providerName = getProviderName(info.provider);
  const modelLabel = info.modelId
    ? info.provider
      ? getProviderModelLabel(info.modelId, info.provider as BuiltinProvider)
      : info.modelId
    : undefined;

  if (providerName && modelLabel) {
    return `${providerName} · ${modelLabel}`;
  }

  return modelLabel ?? providerName ?? null;
}

function getModelActivityCopy(phase: TaskLogPhase | null, t: ReturnType<typeof useTranslation>['t']): {
  label: string;
  description: string;
} {
  if (phase === 'planning') {
    return {
      label: t('tasks:logs.modelThinking', { defaultValue: 'Thinking...' }),
      description: t('tasks:logs.modelThinkingDescription', {
        defaultValue: 'The model is preparing its next response.',
      }),
    };
  }

  return {
    label: t('tasks:logs.modelWorking', { defaultValue: 'Working...' }),
    description: t('tasks:logs.modelWorkingDescription', {
      defaultValue: 'The model is active. Output will appear here when it starts responding.',
    }),
  };
}

function formatEntryTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

interface ToolDisplay {
  name: string;
  input: string;
  rawInput: string;
  status: 'running' | 'done' | 'error';
}

interface CommandLineToken {
  value: string;
  end: number;
}

function tokenizeCommandLine(value: string): CommandLineToken[] {
  const tokens: CommandLineToken[] = [];
  let index = 0;

  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index])) {
      index += 1;
    }

    if (index >= value.length) {
      break;
    }

    const quote = value[index] === '"' || value[index] === "'" ? value[index] : '';

    if (quote) {
      index += 1;
      let tokenValue = '';

      while (index < value.length) {
        const char = value[index];
        if (char === quote) {
          index += 1;
          break;
        }
        tokenValue += char;
        index += 1;
      }

      tokens.push({ value: tokenValue, end: index });
      continue;
    }

    const start = index;
    while (index < value.length && !/\s/.test(value[index])) {
      index += 1;
    }

    tokens.push({ value: value.slice(start, index), end: index });
  }

  return tokens;
}

function isPowerShellExecutable(value: string): boolean {
  const executable = value.replace(/\//g, '\\').split('\\').pop()?.toLowerCase();
  return executable === 'powershell.exe' || executable === 'powershell' || executable === 'pwsh.exe' || executable === 'pwsh';
}

function stripMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function simplifyToolInputForDisplay(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const tokens = tokenizeCommandLine(trimmed);
  if (tokens.length < 2 || !isPowerShellExecutable(tokens[0].value)) {
    return trimmed;
  }

  const commandToken = tokens.find((token, index) =>
    index > 0 && /^[-/](?:command|c)$/i.test(token.value)
  );
  if (!commandToken) {
    return trimmed;
  }

  const commandPayload = stripMatchingOuterQuotes(trimmed.slice(commandToken.end));
  return commandPayload || trimmed;
}

function getToolDisplay(entry: DisplayTaskLogEntry): ToolDisplay {
  const name = entry.tool_name || entry.content.match(/^\[([^\]]+)\]/)?.[1] || 'Tool';
  const rawInput = (entry.tool_input || entry.content.replace(/^\[[^\]]+\]\s*/, '').replace(/^(Done|Error)$/i, '')).trim();
  const input = simplifyToolInputForDisplay(rawInput);
  const status = entry.type === 'tool_start'
    ? 'running'
    : entry.tool_success === false || /\b(error|fail|failed)\b/i.test(entry.content)
      ? 'error'
      : 'done';

  return { name, input, rawInput, status };
}

function getCollapsedLogDetail(
  entry: DisplayTaskLogEntry,
  t: ReturnType<typeof useTranslation>['t'],
): { summary: string; detail: string; defaultCollapsed: boolean } | null {
  if (isRawCodexInternalEventLog(entry.content)) {
    return {
      summary: t('tasks:logs.internalEventCollapsed', {
        defaultValue: 'Internal Codex event log collapsed.',
      }),
      detail: entry.detail || normalizeRawCodexInternalEventLog(entry.content),
      defaultCollapsed: true,
    };
  }

  const toolRouterErrorDetail = findCodexToolRouterErrorLog(entry.content, entry.detail);
  if (toolRouterErrorDetail) {
    return {
      summary: isPowerShellJsonParseFailureLog(toolRouterErrorDetail)
        ? t('tasks:logs.codexJsonParseErrorCollapsed', {
            defaultValue: 'PowerShell JSON parse failure log collapsed.',
          })
        : t('tasks:logs.codexToolErrorCollapsed', {
            defaultValue: 'Codex tool error log collapsed.',
          }),
      detail: toolRouterErrorDetail,
      defaultCollapsed: true,
    };
  }

  if (entry.collapsed || entry.detail) {
    return {
      summary: entry.content,
      detail: entry.detail || entry.content,
      defaultCollapsed: entry.collapsed !== false,
    };
  }

  return null;
}

function getToolName(entry: TaskLogEntry): string {
  return entry.tool_name || entry.content.match(/^\[([^\]]+)\]/)?.[1] || 'Tool';
}

function findMatchingToolStart(
  displayEntries: DisplayTaskLogEntry[],
  toolEnd: DisplayTaskLogEntry
): DisplayTaskLogEntry | undefined {
  const endToolName = getToolName(toolEnd);

  for (let index = displayEntries.length - 1; index >= 0; index -= 1) {
    const candidate = displayEntries[index];
    if (candidate.type !== 'tool_start') {
      continue;
    }

    if (toolEnd.tool_call_id || candidate.tool_call_id) {
      if (toolEnd.tool_call_id && candidate.tool_call_id === toolEnd.tool_call_id) {
        return candidate;
      }
      continue;
    }

    if (
      candidate.phase === toolEnd.phase &&
      candidate.subtask_id === toolEnd.subtask_id &&
      candidate.session === toolEnd.session &&
      getToolName(candidate) === endToolName
    ) {
      return candidate;
    }
  }

  return undefined;
}

function mergeToolLifecycleEntries(entries: DisplayTaskLogEntry[]): DisplayTaskLogEntry[] {
  const displayEntries: DisplayTaskLogEntry[] = [];

  for (const entry of entries) {
    if (entry.type !== 'tool_end') {
      displayEntries.push(entry);
      continue;
    }

    const matchingStart = findMatchingToolStart(displayEntries, entry);
    if (!matchingStart) {
      displayEntries.push(entry);
      continue;
    }

    matchingStart.type = 'tool_end';
    matchingStart.timestamp = entry.timestamp;
    matchingStart.content = entry.content;
    matchingStart.tool_name = matchingStart.tool_name ?? entry.tool_name;
    matchingStart.tool_input = matchingStart.tool_input ?? entry.tool_input;
    matchingStart.tool_success = entry.tool_success ?? matchingStart.tool_success;
    matchingStart.tool_call_id = matchingStart.tool_call_id ?? entry.tool_call_id;
    matchingStart.detail = entry.detail ?? matchingStart.detail;
    matchingStart.collapsed = entry.collapsed ?? matchingStart.collapsed;
    matchingStart.mergedEntryCount = (matchingStart.mergedEntryCount ?? 1) + 1;
    matchingStart.mergedEndTimestamp = entry.timestamp;
  }

  return displayEntries;
}

function useTypewriterText(content: string, enabled: boolean): string {
  const [visibleLength, setVisibleLength] = useState(() => content.length);
  const previousContentRef = useRef(content);

  useEffect(() => {
    const previousContent = previousContentRef.current;
    previousContentRef.current = content;

    if (!enabled) {
      setVisibleLength(content.length);
      return;
    }

    if (content.startsWith(previousContent)) {
      setVisibleLength(length => Math.min(length, content.length));
      return;
    }

    setVisibleLength(0);
  }, [content, enabled]);

  useEffect(() => {
    if (!enabled || visibleLength >= content.length) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setVisibleLength(length => Math.min(length + TYPEWRITER_CHARS_PER_TICK, content.length));
    }, TYPEWRITER_TICK_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [content.length, enabled, visibleLength]);

  return enabled ? content.slice(0, visibleLength) : content;
}

export function useTaskModelLogs(
  task: Task,
  options: UseTaskModelLogsOptions = {},
): { modelLogs: TaskLogsData | null } {
  const enabled = options.enabled ?? true;
  const [modelLogs, setModelLogs] = useState<TaskLogsData | null>(null);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let cancelled = false;
    setModelLogs(null);

    const loadModelLogs = async () => {
      const result = await window.electronAPI.getTaskLogs(task.projectId, task.specId);
      if (!cancelled && result.success) {
        setModelLogs(currentLogs => mergeFullLogsWithoutRegressingStream(currentLogs, result.data ?? null));
      }
    };

    void loadModelLogs();
    void window.electronAPI.watchTaskLogs(task.projectId, task.specId);

    const unsubscribe = window.electronAPI.onTaskLogsChanged((specId, logs, projectId) => {
      if (specId === task.specId && (!projectId || projectId === task.projectId)) {
        setModelLogs(currentLogs => mergeFullLogsWithoutRegressingStream(currentLogs, logs));
      }
    });
    const unsubscribeStream = window.electronAPI.onTaskLogsStream((specId, chunk, projectId) => {
      if (specId === task.specId && (!projectId || projectId === task.projectId)) {
        setModelLogs(currentLogs => mergeModelTextChunk(currentLogs, task.specId, chunk));
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeStream();
      void window.electronAPI.unwatchTaskLogs(task.specId, task.projectId);
    };
  }, [enabled, task.projectId, task.specId]);

  return { modelLogs };
}

export function TaskRuntimeLogs({
  task,
  className,
  modelLogs: providedModelLogs,
  scope = GLOBAL_LOG_SCOPE,
  compact = false,
  title,
}: TaskRuntimeLogsProps) {
  const { t } = useTranslation(['tasks']);
  const { modelLogs: internalModelLogs } = useTaskModelLogs(task, { enabled: providedModelLogs === undefined });
  const modelLogs = providedModelLogs === undefined ? internalModelLogs : providedModelLogs;
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const modelScrollRef = useRef<HTMLDivElement | null>(null);
  const modelEndRef = useRef<HTMLDivElement | null>(null);
  const isModelPinnedToBottomRef = useRef(true);
  const liveTask = useTaskStore(state =>
    state.tasks.find(item => item.projectId === task.projectId && (item.id === task.id || item.specId === task.specId))
  );
  const runtimeSourceTask = liveTask ?? task;
  const scopeKey = scope.type === 'work-item' ? `work-item:${scope.workItemId}` : scope.type;
  const fullModelOutputEntries = useMemo(() => {
    if (!modelLogs) return [];

    const entries = [
      ...modelLogs.phases.planning.entries,
      ...modelLogs.phases.coding.entries,
      ...modelLogs.phases.validation.entries,
    ]
      .filter(entry => MODEL_OUTPUT_ENTRY_TYPES.has(entry.type as ModelOutputEntryType))
      .filter(entry => shouldIncludeModelEntryInScope(entry, runtimeSourceTask, scope))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return mergeToolLifecycleEntries(buildDisplayLogEntries(entries));
  }, [modelLogs, runtimeSourceTask, scope, scopeKey]);
  const [visibleModelCount, setVisibleModelCount] = useState(INITIAL_RENDERED_MODEL_ENTRIES);
  const modelOutputEntries = useMemo(() => {
    return fullModelOutputEntries.slice(-visibleModelCount);
  }, [fullModelOutputEntries, visibleModelCount]);
  const visibleCount = modelOutputEntries.length;
  const totalCount = fullModelOutputEntries.length;
  const hasMoreModelOutput = visibleModelCount < fullModelOutputEntries.length;
  const activeModelPhase = getActiveModelPhase(modelLogs, runtimeSourceTask);
  const runtimeModelInfo = getRuntimeModelInfo(modelOutputEntries, runtimeSourceTask, activeModelPhase);
  const runtimeModelLabel = formatModelInfo(runtimeModelInfo);
  const scopedSubtask = scope.type === 'work-item'
    ? runtimeSourceTask.subtasks.find(subtask => subtask.id === scope.workItemId)
    : null;
  const isScopedModelActive = scope.type === 'work-item'
    ? scopedSubtask?.status === 'in_progress' || runtimeSourceTask.executionProgress?.currentSubtask === scope.workItemId
    : scope.type === 'global';
  const isTaskModelActive = (
    runtimeSourceTask.status === 'in_progress' ||
    runtimeSourceTask.status === 'ai_review'
  ) && isScopedModelActive;
  const isModelActive = isTaskModelActive;
  const isModelStreaming = isModelActive;
  const modelActivityCopy = getModelActivityCopy(activeModelPhase, t);
  const latestModelEntry = modelOutputEntries[modelOutputEntries.length - 1];
  const latestModelContent = latestModelEntry?.content;
  const resolvedTitle = title ?? t('tasks:logs.modelOutputLabel', { defaultValue: 'Model output' });

  const scrollModelToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = modelScrollRef.current;
    if (!container) return;

    if (typeof container.scrollTo === 'function') {
      container.scrollTo({
        top: container.scrollHeight,
        behavior,
      });
    } else {
      container.scrollTop = container.scrollHeight;
    }
    isModelPinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
  }, []);

  const handleModelScroll = useCallback(() => {
    const container = modelScrollRef.current;
    if (!container) return;

    const distanceFromTop = container.scrollTop;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromTop < LOAD_MORE_SCROLL_THRESHOLD) {
      setVisibleModelCount(count => Math.min(count + LOG_RENDER_BATCH_SIZE, fullModelOutputEntries.length));
    }

    const isPinned = distanceFromBottom < 48;
    isModelPinnedToBottomRef.current = isPinned;
    setShowJumpToLatest(!isPinned);
  }, [fullModelOutputEntries.length]);

  useEffect(() => {
    setVisibleModelCount(count => Math.max(count, INITIAL_RENDERED_MODEL_ENTRIES));
    isModelPinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
  }, [task.id, task.specId, scopeKey]);

  useEffect(() => {
    if (!isModelPinnedToBottomRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      scrollModelToLatest('auto');
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [modelOutputEntries.length, latestModelContent, scrollModelToLatest]);

  useEffect(() => {
    isModelPinnedToBottomRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      scrollModelToLatest('auto');
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [scrollModelToLatest]);

  return (
    <section
      className={cn(
        compact
          ? 'flex h-72 min-h-[16rem] min-w-0 flex-col overflow-hidden rounded-md border border-border bg-card'
          : 'flex h-full min-h-0 flex-col border-l border-border bg-card',
        className
      )}
      data-testid="task-runtime-logs"
    >
      <div className={cn(
        'flex shrink-0 items-center justify-between gap-3 border-b border-border',
        compact ? 'px-3 py-2' : 'px-4 py-3'
      )}>
        <div className="flex min-w-0 items-center gap-2">
          <Bot className={cn('shrink-0 text-muted-foreground', compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
          <span className={cn('truncate font-medium text-foreground', compact ? 'text-xs' : 'text-sm')}>
            {resolvedTitle}
            {runtimeModelLabel && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {runtimeModelLabel}
              </span>
            )}
            {isModelStreaming && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                {t('tasks:logs.modelOutputLive', { defaultValue: 'Live' })}
              </span>
            )}
          </span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {totalCount > visibleCount
            ? t('tasks:logs.visibleEntriesCount', {
                visible: visibleCount,
                total: totalCount,
                defaultValue: '({{visible}}/{{total}} entries)'
              })
            : t('tasks:logs.entriesCount', {
                count: visibleCount,
                defaultValue: '({{count}} entries)'
              })}
        </span>
      </div>
      {modelOutputEntries.length > 0 ? (
        <div className="relative min-h-0 flex-1 bg-background/70">
          <div
            ref={modelScrollRef}
            className={cn(
              'h-full overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent',
              compact ? 'p-3' : 'p-4'
            )}
            onScroll={handleModelScroll}
            data-testid="model-output-scroll"
          >
            <div className={compact ? 'space-y-2.5' : 'space-y-3'}>
              {hasMoreModelOutput && (
                <LogHistoryLoadingHint label={t('tasks:logs.scrollForOlder', { defaultValue: 'Scroll up to load older output' })} />
              )}
              {modelOutputEntries.map((entry, index) => (
                <ModelOutputEntry
                  key={`${entry.timestamp}-${entry.phase}-${entry.type}-${entry.tool_name ?? ''}-${entry.subtask_id ?? ''}-${index}`}
                  entry={entry}
                  isLatest={index === modelOutputEntries.length - 1}
                  isStreaming={isModelStreaming && index === modelOutputEntries.length - 1}
                  t={t}
                />
              ))}
              {isModelStreaming && <ModelActivityStatus label={modelActivityCopy.label} />}
              <div ref={modelEndRef} />
            </div>
          </div>
          {showJumpToLatest && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="absolute bottom-3 right-3 h-7 gap-1.5 border border-border bg-card px-2 text-[11px] text-foreground shadow-lg hover:bg-accent"
              onClick={() => scrollModelToLatest()}
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
              {t('tasks:logs.jumpToLatest', { defaultValue: 'Latest' })}
            </Button>
          )}
        </div>
      ) : (
        <div
          className={cn(
            'flex min-h-0 flex-1 items-center justify-center text-center text-sm text-muted-foreground',
            compact ? 'p-4' : 'p-6',
            isModelActive && 'bg-background/70'
          )}
        >
          <div>
            {isModelActive ? (
              <ModelActivityStatus
                label={modelActivityCopy.label}
                description={modelActivityCopy.description}
                centered
              />
            ) : (
              <Bot className="mx-auto mb-2 h-8 w-8 opacity-40" />
            )}
            {!isModelActive && (
              <>
                <p>
                  {t('tasks:logs.modelOutputEmpty', { defaultValue: 'No model output yet' })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground/70">
                  {t('tasks:logs.modelOutputEmptyDescription', {
                    defaultValue: 'Model text output will appear here while the task runs'
                  })}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ModelActivityStatus({
  label,
  description,
  centered = false,
}: {
  label: string;
  description?: string;
  centered?: boolean;
}) {
  return (
    <div
      className={cn(
        'text-[11px] text-muted-foreground',
        centered ? 'flex flex-col items-center' : 'flex items-center gap-2 pl-6'
      )}
    >
      <div className={cn('flex items-center gap-2', centered && 'justify-center')}>
        <span className="h-2 w-2 rounded-full bg-warning animate-pulse" />
        <span className="font-medium text-warning">{label}</span>
      </div>
      {description && (
        <p className="mt-2 max-w-[280px] text-center text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

function LogHistoryLoadingHint({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-2 text-[11px] text-muted-foreground">
      <div className="rounded-full border border-border bg-card px-2.5 py-1">
        {label}
      </div>
    </div>
  );
}

interface ModelOutputEntryProps {
  entry: DisplayTaskLogEntry;
  isLatest: boolean;
  isStreaming: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}

function ModelOutputEntry({ entry, isLatest, isStreaming, t }: ModelOutputEntryProps) {
  const styles = MODEL_PHASE_STYLES[entry.phase];
  const timeLabel = formatEntryTime(entry.timestamp);
  const visibleContent = useTypewriterText(entry.content, isStreaming);
  const markdownContent = formatLogMarkdownForDisplay(visibleContent);
  const isError = entry.type === 'error';
  const collapsedDetail = getCollapsedLogDetail(entry, t);
  const [isExpanded, setIsExpanded] = useState(() => collapsedDetail ? !collapsedDetail.defaultCollapsed : true);

  useEffect(() => {
    setIsExpanded(collapsedDetail ? !collapsedDetail.defaultCollapsed : true);
  }, [entry.timestamp, entry.content, entry.detail, entry.collapsed, collapsedDetail?.defaultCollapsed]);

  if (entry.type === 'tool_start' || entry.type === 'tool_end') {
    const tool = getToolDisplay(entry);

    return (
      <div
        className={cn(
          'rounded-md border border-border bg-card px-3 py-1.5 font-mono text-[11px] leading-relaxed text-foreground shadow-sm',
          isLatest && styles.latest
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {collapsedDetail ? (
            <button
              type="button"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={isExpanded
                ? t('tasks:logs.collapseDetail', { defaultValue: 'Collapse log detail' })
                : t('tasks:logs.expandDetail', { defaultValue: 'Expand log detail' })}
              onClick={() => setIsExpanded(value => !value)}
            >
              {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          ) : (
            <span className={cn('shrink-0', styles.prompt)}>{'>'}</span>
          )}
          <span
            className={cn(
              'shrink-0 font-medium',
              tool.status === 'error'
                ? 'text-destructive'
                : tool.status === 'done'
                  ? 'text-success'
                  : 'text-info'
            )}
          >
            {tool.name}
          </span>
          {tool.input && (
            <span className="min-w-0 truncate text-muted-foreground" title={tool.rawInput || tool.input}>
              {tool.input}
            </span>
          )}
          {tool.status !== 'done' && (
            <span
              className={cn(
                'ml-auto shrink-0 text-[10px]',
                tool.status === 'error'
                  ? 'text-destructive'
                  : 'text-muted-foreground'
              )}
            >
              {tool.status}
            </span>
          )}
        </div>
        {collapsedDetail && isExpanded && (
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
            {collapsedDetail.detail}
          </pre>
        )}
      </div>
    );
  }

  if (collapsedDetail) {
    return (
      <div
        className={cn(
          'group relative overflow-hidden rounded-md border border-border bg-card px-3 py-2.5 shadow-sm',
          isLatest && styles.latest,
          isError && 'border-destructive/40 bg-destructive/5'
        )}
      >
        <div className={cn('pointer-events-none absolute inset-y-2 left-0 w-0.5 rounded-r-full', styles.rail)} />
        <div className="relative flex min-w-0 items-center gap-2 font-mono text-[10px] leading-none text-muted-foreground">
          <button
            type="button"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={isExpanded
              ? t('tasks:logs.collapseDetail', { defaultValue: 'Collapse log detail' })
              : t('tasks:logs.expandDetail', { defaultValue: 'Expand log detail' })}
            onClick={() => setIsExpanded(value => !value)}
          >
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          {timeLabel && <span className="shrink-0 tabular-nums text-muted-foreground">{timeLabel}</span>}
          <span className={cn('shrink-0 rounded border px-1.5 py-0.5', styles.chip)}>
            {t('tasks:logs.collapsedLog', { defaultValue: 'collapsed' })}
          </span>
          <span className="min-w-0 truncate text-[11px] font-medium text-foreground">
            {collapsedDetail.summary}
          </span>
        </div>
        {isExpanded && (
          <pre className="relative mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {collapsedDetail.detail}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-md border border-border bg-card px-3 py-2.5 shadow-sm',
        isLatest && styles.latest,
        isError && 'border-destructive/40 bg-destructive/5'
      )}
    >
      <div className={cn('pointer-events-none absolute inset-y-2 left-0 w-0.5 rounded-r-full', styles.rail)} />
      <div className="relative mb-1.5 flex items-center gap-2 font-mono text-[10px] leading-none text-muted-foreground">
        <span className={cn('text-[11px]', styles.prompt)}>{'>'}</span>
        {timeLabel && <span className="tabular-nums text-muted-foreground">{timeLabel}</span>}
        {entry.mergedEntryCount && entry.mergedEntryCount > 1 && (
          <span className={cn('rounded border px-1.5 py-0.5', styles.chip)}>
            {t('tasks:logs.streamChunkCount', {
              count: entry.mergedEntryCount,
              defaultValue: '{{count}} chunks',
            })}
          </span>
        )}
      </div>
      <div className="relative text-[12px] leading-relaxed">
        <div className="max-w-none text-foreground [&_*:first-child]:mt-0 [&_*:last-child]:mb-0">
          {isError ? (
            <p className="my-1.5 whitespace-pre-wrap break-words leading-relaxed text-destructive">
              {visibleContent}
            </p>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={modelMarkdownComponents}>
              {markdownContent}
            </ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  );
}
