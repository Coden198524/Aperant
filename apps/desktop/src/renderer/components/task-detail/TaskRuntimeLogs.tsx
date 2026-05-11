import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDownToLine, Bot, Terminal } from 'lucide-react';
import { PROVIDER_REGISTRY } from '@shared/constants/providers';
import { getProviderModelLabel } from '@shared/utils/model-display';
import { cn } from '../../lib/utils';
import { useSettingsStore } from '../../stores/settings-store';
import { useTaskStore } from '../../stores/task-store';
import type { Task, TaskLogEntry, TaskLogPhase, TaskLogStreamChunk, TaskLogs as TaskLogsData } from '../../../shared/types';
import type { PhaseModelConfig } from '../../../shared/types/settings';
import type { BuiltinProvider } from '../../../shared/types/provider-account';
import { buildDisplayLogEntries, buildDisplayRuntimeLogs, type DisplayTaskLogEntry } from './task-log-display';
import { Button } from '../ui/button';

interface TaskRuntimeLogsProps {
  task: Task;
  className?: string;
}

type RuntimePanelMode = 'runtime' | 'model';
type ModelOutputEntryType = 'text' | 'tool_start' | 'tool_end' | 'error';

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
  accent: string;
  badge: string;
  glow: string;
  prompt: string;
}> = {
  planning: {
    accent: 'text-amber-300',
    badge: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
    glow: 'from-amber-400/20',
    prompt: 'text-amber-300',
  },
  coding: {
    accent: 'text-cyan-300',
    badge: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200',
    glow: 'from-cyan-400/20',
    prompt: 'text-cyan-300',
  },
  validation: {
    accent: 'text-emerald-300',
    badge: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    glow: 'from-emerald-400/20',
    prompt: 'text-emerald-300',
  },
};

const TYPEWRITER_CHARS_PER_TICK = 12;
const TYPEWRITER_TICK_MS = 18;

const runtimeMarkdownComponents: Components = {
  p: ({ children }) => (
    <p className="my-1 leading-relaxed text-slate-200">
      {children}
    </p>
  ),
  h1: ({ children }) => (
    <h1 className="mb-1.5 mt-2 text-sm font-semibold text-sky-300">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-2 text-[13px] font-semibold text-sky-300">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-1.5 text-xs font-semibold text-cyan-300">
      {children}
    </h3>
  ),
  ul: ({ children }) => (
    <ul className="my-1 ml-4 list-disc space-y-0.5 text-slate-200">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 ml-4 list-decimal space-y-0.5 text-slate-200">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="pl-1 leading-relaxed marker:text-cyan-400">
      {children}
    </li>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-emerald-300">
      {children}
    </strong>
  ),
  em: ({ children }) => (
    <em className="text-amber-300">
      {children}
    </em>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-sky-500/50 pl-3 text-slate-300">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="break-all text-sky-300 underline-offset-2 hover:underline"
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    const isInline = !className;

    if (isInline) {
      return (
        <code className="rounded border border-slate-700 bg-slate-950 px-1 py-0.5 text-[10px] text-amber-200" {...props}>
          {children}
        </code>
      );
    }

    return (
      <code className={cn('block whitespace-pre font-mono text-[10px] leading-relaxed text-teal-100', className)} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-1.5 max-w-full overflow-x-auto rounded-md border border-slate-700/80 bg-slate-950/90 p-2.5">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-1.5 max-w-full overflow-x-auto rounded-md border border-slate-700/80">
      <table className="w-full border-collapse text-[10px] text-slate-200">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-r border-slate-700 bg-slate-900 px-2 py-1 text-left font-semibold text-cyan-200 last:border-r-0">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-r border-slate-800 px-2 py-1 align-top last:border-r-0">
      {children}
    </td>
  ),
  hr: () => <hr className="my-2 border-slate-700" />,
};

const modelMarkdownComponents: Components = {
  p: ({ children }) => (
    <p className="my-1.5 leading-relaxed text-slate-100">
      {children}
    </p>
  ),
  h1: ({ children }) => (
    <h1 className="mb-2 mt-3 text-sm font-semibold text-amber-200">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-3 text-[13px] font-semibold text-amber-200">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-2.5 text-xs font-semibold text-cyan-200">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-2 text-[11px] font-semibold text-cyan-200">
      {children}
    </h4>
  ),
  ul: ({ children }) => (
    <ul className="my-1.5 ml-4 list-disc space-y-1 text-slate-100">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 ml-4 list-decimal space-y-1 text-slate-100">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="pl-1 leading-relaxed marker:text-sky-300">
      {children}
    </li>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-emerald-200">
      {children}
    </strong>
  ),
  em: ({ children }) => (
    <em className="text-slate-300">
      {children}
    </em>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-slate-600 pl-3 text-slate-300">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="break-all text-sky-300 underline-offset-2 hover:underline"
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    const isInline = !className;

    if (isInline) {
      return (
        <code className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-[10px] text-cyan-200" {...props}>
          {children}
        </code>
      );
    }

    return (
      <code className={cn('block whitespace-pre font-mono text-[10px] leading-relaxed text-teal-100', className)} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 max-w-full overflow-x-auto rounded-md border border-slate-700 bg-slate-950/90 p-2.5">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto rounded-md border border-slate-700">
      <table className="w-full border-collapse text-[10px] text-slate-100">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-r border-slate-700 bg-slate-900 px-2 py-1 text-left font-semibold text-slate-200 last:border-r-0">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-r border-slate-800 px-2 py-1 align-top last:border-r-0">
      {children}
    </td>
  ),
  hr: () => <hr className="my-3 border-slate-700" />,
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
    ...(chunk.tool_call_id ? { tool_call_id: chunk.tool_call_id } : {}),
    ...(chunk.subtask_id ? { subtask_id: chunk.subtask_id } : {}),
    ...(chunk.session ? { session: chunk.session } : {}),
  });
  nextLogs.updated_at = timestamp;

  return nextLogs;
}

function getModelTextLength(logs: TaskLogsData | null): number {
  if (!logs) return 0;

  return (
    logs.phases.planning.entries.reduce((sum, entry) => sum + (entry.type === 'text' ? entry.content.length : 0), 0) +
    logs.phases.coding.entries.reduce((sum, entry) => sum + (entry.type === 'text' ? entry.content.length : 0), 0) +
    logs.phases.validation.entries.reduce((sum, entry) => sum + (entry.type === 'text' ? entry.content.length : 0), 0)
  );
}

function mergeFullLogsWithoutRegressingStream(
  currentLogs: TaskLogsData | null,
  nextLogs: TaskLogsData | null
): TaskLogsData | null {
  if (!nextLogs) return currentLogs ?? null;
  if (!currentLogs) return nextLogs;

  return getModelTextLength(nextLogs) >= getModelTextLength(currentLogs)
    ? nextLogs
    : currentLogs;
}

function getPhaseLabel(phase: TaskLogPhase, t: ReturnType<typeof useTranslation>['t']): string {
  const labels: Record<TaskLogPhase, string> = {
    planning: t('tasks:logs.phaseLabels.planning', { defaultValue: 'Plan' }),
    coding: t('tasks:logs.phaseLabels.coding', { defaultValue: 'Code' }),
    validation: t('tasks:logs.phaseLabels.validation', { defaultValue: 'QA' }),
  };

  return labels[phase];
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

function getToolDisplay(entry: DisplayTaskLogEntry): { name: string; input: string; status: 'running' | 'done' | 'error' } {
  const name = entry.tool_name || entry.content.match(/^\[([^\]]+)\]/)?.[1] || 'Tool';
  const input = entry.tool_input || entry.content.replace(/^\[[^\]]+\]\s*/, '').replace(/^(Done|Error)$/i, '').trim();
  const status = entry.type === 'tool_start'
    ? 'running'
    : /\berror\b/i.test(entry.content)
      ? 'error'
      : 'done';

  return { name, input, status };
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

export function TaskRuntimeLogs({ task, className }: TaskRuntimeLogsProps) {
  const { t } = useTranslation(['tasks']);
  const [mode, setMode] = useState<RuntimePanelMode>('runtime');
  const [modelLogs, setModelLogs] = useState<TaskLogsData | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const modelScrollRef = useRef<HTMLDivElement | null>(null);
  const modelEndRef = useRef<HTMLDivElement | null>(null);
  const isModelPinnedToBottomRef = useRef(true);
  const logOrder = useSettingsStore(s => s.settings.logOrder);
  const liveTask = useTaskStore(state =>
    state.tasks.find(item => item.id === task.id || item.specId === task.specId)
  );
  const runtimeSourceTask = liveTask ?? task;
  const runtimeLogs = useMemo(() => {
    const logs = buildDisplayRuntimeLogs(runtimeSourceTask.logs || []);
    return logOrder === 'reverse-chronological' ? [...logs].reverse() : logs;
  }, [runtimeSourceTask.logs, logOrder]);
  const modelOutputEntries = useMemo(() => {
    if (!modelLogs) return [];

    const entries = [
      ...modelLogs.phases.planning.entries,
      ...modelLogs.phases.coding.entries,
      ...modelLogs.phases.validation.entries,
    ]
      .filter(entry => MODEL_OUTPUT_ENTRY_TYPES.has(entry.type as ModelOutputEntryType))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return mergeToolLifecycleEntries(buildDisplayLogEntries(entries));
  }, [modelLogs]);
  const visibleCount = mode === 'runtime' ? runtimeLogs.length : modelOutputEntries.length;
  const activeModelPhase = getActiveModelPhase(modelLogs, runtimeSourceTask);
  const runtimeModelInfo = getRuntimeModelInfo(modelOutputEntries, runtimeSourceTask, activeModelPhase);
  const runtimeModelLabel = formatModelInfo(runtimeModelInfo);
  const isTaskModelActive = runtimeSourceTask.status === 'in_progress' || runtimeSourceTask.status === 'ai_review';
  const isModelActive = isTaskModelActive;
  const isModelStreaming = mode === 'model' && isModelActive;
  const modelActivityCopy = getModelActivityCopy(activeModelPhase, t);
  const latestModelEntry = modelOutputEntries[modelOutputEntries.length - 1];
  const latestModelContent = latestModelEntry?.content;

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

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isPinned = distanceFromBottom < 48;
    isModelPinnedToBottomRef.current = isPinned;
    setShowJumpToLatest(!isPinned);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setModelLogs(null);
    isModelPinnedToBottomRef.current = true;
    setShowJumpToLatest(false);

    const loadModelLogs = async () => {
      const result = await window.electronAPI.getTaskLogs(task.projectId, task.specId);
      if (!cancelled && result.success) {
        setModelLogs(currentLogs => mergeFullLogsWithoutRegressingStream(currentLogs, result.data ?? null));
      }
    };

    void loadModelLogs();
    void window.electronAPI.watchTaskLogs(task.projectId, task.specId);

    const unsubscribe = window.electronAPI.onTaskLogsChanged((specId, logs) => {
      if (specId === task.specId) {
        setModelLogs(currentLogs => mergeFullLogsWithoutRegressingStream(currentLogs, logs));
      }
    });
    const unsubscribeStream = window.electronAPI.onTaskLogsStream((specId, chunk) => {
      if (specId === task.specId) {
        setModelLogs(currentLogs => mergeModelTextChunk(currentLogs, task.specId, chunk));
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeStream();
      void window.electronAPI.unwatchTaskLogs(task.specId);
    };
  }, [task.projectId, task.specId]);

  useEffect(() => {
    if (mode !== 'model' || !isModelPinnedToBottomRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      scrollModelToLatest('auto');
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [mode, modelOutputEntries.length, latestModelContent, scrollModelToLatest]);

  useEffect(() => {
    if (mode !== 'model') {
      return undefined;
    }

    isModelPinnedToBottomRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      scrollModelToLatest('auto');
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [mode, scrollModelToLatest]);

  return (
    <section
      className={cn('flex h-full min-h-0 flex-col border-l border-border bg-muted/10', className)}
      data-testid="task-runtime-logs"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {mode === 'runtime' ? (
            <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium text-foreground">
            {mode === 'runtime'
              ? t('tasks:logs.runtimeLabel', { defaultValue: 'Runtime' })
              : t('tasks:logs.modelOutputLabel', { defaultValue: 'Model output' })}
            {mode === 'model' && runtimeModelLabel && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {runtimeModelLabel}
              </span>
            )}
            {isModelStreaming && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 animate-pulse" />
                {t('tasks:logs.modelOutputLive', { defaultValue: 'Live' })}
              </span>
            )}
          </span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('tasks:logs.entriesCount', {
            count: visibleCount,
            defaultValue: '({{count}} entries)'
          })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/70 bg-background/40 px-4 py-2">
        <Button
          type="button"
          variant={mode === 'runtime' ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 gap-1.5 px-2"
          onClick={() => setMode('runtime')}
        >
          <Terminal className="h-3.5 w-3.5" />
          {t('tasks:logs.runtimeTab', { defaultValue: 'Runtime' })}
        </Button>
        <Button
          type="button"
          variant={mode === 'model' ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 gap-1.5 px-2"
          onClick={() => setMode('model')}
        >
          <Bot className="h-3.5 w-3.5" />
          {t('tasks:logs.modelOutputTab', { defaultValue: 'Model output' })}
        </Button>
      </div>

      {mode === 'runtime' && runtimeLogs.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto bg-[#0B1020] p-4 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
          <div className="space-y-2">
            {runtimeLogs.map((log, index) => (
              <div
                key={`${index}-${log.content.slice(0, 80)}`}
                className="rounded-md border border-slate-700/70 bg-slate-950/70 px-3 py-2 font-mono text-[11px] leading-relaxed shadow-sm"
              >
                <div className="max-w-none break-words [&_*:first-child]:mt-0 [&_*:last-child]:mb-0">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={runtimeMarkdownComponents}>
                    {log.content}
                  </ReactMarkdown>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : mode === 'model' && modelOutputEntries.length > 0 ? (
        <div className="relative min-h-0 flex-1 bg-[#080B10]">
          <div
            ref={modelScrollRef}
            className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent"
            onScroll={handleModelScroll}
            data-testid="model-output-scroll"
          >
            <div className="space-y-3">
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
              className="absolute bottom-3 right-3 h-7 gap-1.5 border border-slate-600/60 bg-slate-900/90 px-2 text-[11px] text-slate-100 shadow-lg hover:bg-slate-800"
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
            'flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground',
            mode === 'model' && isModelActive && 'bg-[#080B10]'
          )}
        >
          <div>
            {mode === 'runtime' ? (
              <Terminal className="mx-auto mb-2 h-8 w-8 opacity-40" />
            ) : isModelActive ? (
              <ModelActivityStatus
                label={modelActivityCopy.label}
                description={modelActivityCopy.description}
                centered
              />
            ) : (
              <Bot className="mx-auto mb-2 h-8 w-8 opacity-40" />
            )}
            {(mode !== 'model' || !isModelActive) && (
              <>
                <p>
                  {mode === 'runtime'
                    ? t('tasks:logs.runtimeEmpty', { defaultValue: 'No runtime logs yet' })
                    : t('tasks:logs.modelOutputEmpty', { defaultValue: 'No model output yet' })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground/70">
                  {mode === 'runtime'
                    ? t('tasks:logs.runtimeEmptyDescription', {
                        defaultValue: 'Runtime output will appear here when the task runs'
                      })
                    : t('tasks:logs.modelOutputEmptyDescription', {
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
        'font-mono text-[11px] text-slate-300',
        centered ? 'flex flex-col items-center' : 'flex items-center gap-2 pl-6'
      )}
    >
      <div className={cn('flex items-center gap-2', centered && 'justify-center')}>
        <span className="h-2 w-2 rounded-full bg-amber-300 animate-pulse" />
        <span className="text-amber-200">{label}</span>
      </div>
      {description && (
        <p className="mt-2 max-w-[280px] text-center text-xs leading-relaxed text-slate-500">
          {description}
        </p>
      )}
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
  const phaseLabel = getPhaseLabel(entry.phase, t);
  const timeLabel = formatEntryTime(entry.timestamp);
  const visibleContent = useTypewriterText(entry.content, isStreaming);
  const isError = entry.type === 'error';

  if (entry.type === 'tool_start' || entry.type === 'tool_end') {
    const tool = getToolDisplay(entry);

    return (
      <div
        className={cn(
          'flex min-w-0 items-center gap-2 rounded border border-slate-800/80 bg-slate-950/50 px-3 py-1.5 font-mono text-[11px] leading-relaxed',
          isLatest && 'border-slate-700 bg-slate-950/70'
        )}
      >
        <span className={cn('shrink-0', styles.prompt)}>{'>'}</span>
        <span className="shrink-0 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
          tool
        </span>
        <span
          className={cn(
            'shrink-0 font-medium',
            tool.status === 'error'
              ? 'text-rose-300'
              : tool.status === 'done'
                ? 'text-emerald-300'
                : 'text-sky-300'
          )}
        >
          {tool.name}
        </span>
        {tool.input && (
          <span className="min-w-0 truncate text-slate-400" title={tool.input}>
            {tool.input}
          </span>
        )}
        <span
          className={cn(
            'ml-auto shrink-0 text-[10px]',
            tool.status === 'error'
              ? 'text-rose-400'
              : tool.status === 'done'
                ? 'text-emerald-400'
                : 'text-slate-500'
          )}
        >
          {tool.status}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-md border border-slate-700/60 bg-slate-950/70 px-3 py-2.5 shadow-sm',
        isLatest && 'border-slate-500/70 bg-slate-950',
        isError && 'border-rose-500/40'
      )}
    >
      <div className={cn('pointer-events-none absolute inset-y-0 left-0 w-20 bg-gradient-to-r to-transparent opacity-80', styles.glow)} />
      <div className="relative mb-1.5 flex items-center gap-2 font-mono text-[10px] leading-none text-slate-500">
        <span className={cn('text-[11px]', styles.prompt)}>{'>'}</span>
        <span className={cn('rounded border px-1.5 py-0.5 uppercase tracking-wide', styles.badge)}>
          {phaseLabel}
        </span>
        {timeLabel && <span className="tabular-nums text-slate-500">{timeLabel}</span>}
        {entry.mergedEntryCount && entry.mergedEntryCount > 1 && (
          <span className="rounded bg-slate-800/80 px-1.5 py-0.5 text-slate-400">
            {t('tasks:logs.streamChunkCount', {
              count: entry.mergedEntryCount,
              defaultValue: '{{count}} chunks',
            })}
          </span>
        )}
      </div>
      <div className="relative font-mono text-[11px] leading-relaxed">
        <div className="max-w-none text-slate-100 [&_*:first-child]:mt-0 [&_*:last-child]:mb-0">
          {isError ? (
            <p className="my-1.5 whitespace-pre-wrap break-words leading-relaxed text-rose-300">
              {visibleContent}
            </p>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={modelMarkdownComponents}>
              {visibleContent}
            </ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  );
}
