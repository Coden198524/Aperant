import type {
  Memory,
  MemoryRecordEntry,
  MemorySearchFilters,
  MemoryType,
  WorkUnitRef,
} from './types.js';

export interface AutocodeMemoryRuntimeToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface AutocodeMemoryRuntimeRecentToolCallContext {
  toolCalls: AutocodeMemoryRuntimeToolCall[];
  injectedMemoryIds: Set<string>;
}

export interface AutocodeMemoryRuntimeSerializableRecentContext {
  toolCalls: AutocodeMemoryRuntimeToolCall[];
  injectedMemoryIds: string[];
}

export interface AutocodeMemoryRuntimeStepInjection {
  content: string;
  type: 'gotcha_injection' | 'scratchpad_reflection' | 'search_short_circuit';
  memoryIds: string[];
}

export type AutocodeMemoryRuntimeObservationIpcRequest =
  | {
      type: 'memory:tool-call';
      toolName: string;
      args: Record<string, unknown>;
      stepNumber: number;
    }
  | {
      type: 'memory:tool-result';
      toolName: string;
      result: unknown;
      stepNumber: number;
    }
  | {
      type: 'memory:reasoning';
      text: string;
      stepNumber: number;
    }
  | {
      type: 'memory:step-complete';
      stepNumber: number;
    };

export type AutocodeMemoryRuntimeToolIpcRequest =
  | {
      type: 'memory:search';
      requestId: string;
      filters: MemorySearchFilters;
    }
  | {
      type: 'memory:record';
      requestId: string;
      entry: MemoryRecordEntry;
    }
  | {
      type: 'memory:step-injection-request';
      requestId: string;
      stepNumber: number;
      recentContext: AutocodeMemoryRuntimeSerializableRecentContext;
    };

export type AutocodeMemoryRuntimeIpcRequest =
  | AutocodeMemoryRuntimeObservationIpcRequest
  | AutocodeMemoryRuntimeToolIpcRequest;

export type AutocodeMemoryRuntimeIpcResponse =
  | {
      type: 'memory:search-result';
      requestId: string;
      memories: Memory[];
    }
  | {
      type: 'memory:stored';
      requestId: string;
      id: string;
    }
  | {
      type: 'memory:step-injection-result';
      requestId: string;
      injection: AutocodeMemoryRuntimeStepInjection | null;
    }
  | {
      type: 'memory:error';
      requestId: string;
      error: string;
    };

export interface AutocodeMemoryRuntimeWorkUnitOutcomeInput {
  projectId: string;
  sessionId: string;
  workUnitId: string;
  workUnitTitle?: string;
  workUnitDescription?: string;
  outcome: 'success' | 'failure' | 'partial' | 'abandoned';
  phase?: string;
  source?: 'desktop-worker' | 'cli-runner' | 'vscode-runner' | 'core-runtime';
  summary?: string;
  error?: string;
  relatedFiles?: string[];
  relatedModules?: string[];
  upstreamTaskIds?: string[];
  durationMs?: number;
  completedAt?: string;
  tags?: string[];
}

export interface AutocodeMemoryRuntimeSessionInsight {
  sessionId: string;
  subtaskId: string;
  timestamp: string;
  outcome: string;
  insights: string[];
  keyFiles: string[];
  source: string;
  workUnit: {
    id: string;
    title?: string;
    description?: string;
    upstreamTaskIds: string[];
  };
}

export function toAutocodeMemoryRuntimeRecentContext(
  context: AutocodeMemoryRuntimeSerializableRecentContext,
): AutocodeMemoryRuntimeRecentToolCallContext {
  return {
    toolCalls: context.toolCalls,
    injectedMemoryIds: new Set(context.injectedMemoryIds),
  };
}

export function buildAutocodeWorkUnitOutcomeMemoryEntry(
  input: AutocodeMemoryRuntimeWorkUnitOutcomeInput,
): MemoryRecordEntry {
  const completedAt = input.completedAt ?? new Date().toISOString();
  const content = buildAutocodeWorkUnitOutcomeContent({ ...input, completedAt });
  const relatedFiles = uniqueStrings(input.relatedFiles);
  const workUnitRef: WorkUnitRef = {
    methodology: 'autocode',
    hierarchy: [input.phase ?? 'coding', input.workUnitId],
    label: input.workUnitTitle
      ? `${input.workUnitId}: ${input.workUnitTitle}`
      : input.workUnitId,
  };

  return {
    type: 'work_unit_outcome',
    content,
    confidence: input.outcome === 'success' ? 0.82 : 0.72,
    tags: uniqueStrings([
      'work_unit',
      input.outcome,
      input.source ?? 'core-runtime',
      input.phase ?? 'coding',
      ...(input.tags ?? []),
      ...(input.upstreamTaskIds ?? []).map((id) => `upstream:${id}`),
    ]),
    relatedFiles,
    relatedModules: uniqueStrings(input.relatedModules),
    scope: 'work_unit',
    source: 'agent_explicit',
    sessionId: input.sessionId,
    projectId: input.projectId,
    workUnitRef,
    methodology: 'autocode',
    citationText: input.summary,
    trustLevelScope: 'personal',
  };
}

export function buildAutocodeWorkUnitOutcomeSessionInsight(
  input: AutocodeMemoryRuntimeWorkUnitOutcomeInput,
): AutocodeMemoryRuntimeSessionInsight {
  const timestamp = input.completedAt ?? new Date().toISOString();
  return {
    sessionId: input.sessionId,
    subtaskId: input.workUnitId,
    timestamp,
    outcome: input.outcome,
    insights: [
      input.summary || input.workUnitDescription || input.workUnitTitle || input.workUnitId,
      ...(input.error ? [`Error: ${input.error}`] : []),
    ].filter(Boolean),
    keyFiles: uniqueStrings(input.relatedFiles),
    source: input.source ?? 'core-runtime',
    workUnit: {
      id: input.workUnitId,
      ...(input.workUnitTitle ? { title: input.workUnitTitle } : {}),
      ...(input.workUnitDescription ? { description: input.workUnitDescription } : {}),
      upstreamTaskIds: uniqueStrings(input.upstreamTaskIds),
    },
  };
}

export function formatAutocodeMemoryRuntimeContext(memories: Memory[], maxItems = 6): string {
  const usable = memories
    .filter((memory) => !memory.deprecated)
    .slice(0, Math.max(0, maxItems));

  if (usable.length === 0) {
    return '';
  }

  const lines = [
    '## Project Memory',
    '',
    'Use these prior outcomes, gotchas, and decisions when relevant. Do not repeat failed approaches.',
    '',
  ];

  for (const memory of usable) {
    const files = memory.relatedFiles.length > 0
      ? ` Files: ${memory.relatedFiles.join(', ')}.`
      : '';
    lines.push(`- [${memory.type}] ${memory.content}${files}`);
  }

  return lines.join('\n');
}

function buildAutocodeWorkUnitOutcomeContent(
  input: AutocodeMemoryRuntimeWorkUnitOutcomeInput & { completedAt: string },
): string {
  const title = input.workUnitTitle ? ` (${input.workUnitTitle})` : '';
  const lines = [
    `Work unit ${input.workUnitId}${title} finished with outcome: ${input.outcome}.`,
    input.workUnitDescription ? `Task: ${input.workUnitDescription}` : '',
    input.summary ? `Summary: ${input.summary}` : '',
    input.error ? `Error: ${input.error}` : '',
    input.upstreamTaskIds && input.upstreamTaskIds.length > 0
      ? `Upstream tasks: ${input.upstreamTaskIds.join(', ')}`
      : '',
    input.relatedFiles && input.relatedFiles.length > 0
      ? `Files: ${uniqueStrings(input.relatedFiles).join(', ')}`
      : '',
    input.durationMs ? `Duration: ${input.durationMs}ms` : '',
    `Completed at: ${input.completedAt}`,
  ].filter(Boolean);

  return lines.join('\n');
}

function uniqueStrings(values: readonly unknown[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(
    values
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )];
}

export type AutocodeMemoryRuntimeMemoryType = MemoryType;
