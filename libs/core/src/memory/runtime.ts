import { selectMemoryContextItems } from './injection/context-selection.js';
import { estimateTokens, isMemoryEligibleForPromptContext } from './retrieval/context-packer.js';
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
      type: 'memory:access';
      requestId: string;
      memoryId: string;
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
      type: 'memory:accessed';
      requestId: string;
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
    toolCalls: compactAutocodeMemoryRuntimeRecentToolCalls(context.toolCalls),
    injectedMemoryIds: new Set(
      compactAutocodeMemoryRuntimeInjectedMemoryIds(context.injectedMemoryIds),
    ),
  };
}

const AUTOCODE_MEMORY_RUNTIME_TOOL_ARG_STRING_MAX_CHARS = 240;
const AUTOCODE_MEMORY_RUNTIME_TOOL_RESULT_STRING_MAX_CHARS = 1_200;
const AUTOCODE_MEMORY_RUNTIME_REASONING_TEXT_MAX_CHARS = 900;
const AUTOCODE_MEMORY_RUNTIME_OBJECT_VALUE_MAX_CHARS = 160;
const AUTOCODE_MEMORY_RUNTIME_OBJECT_KEY_LIMIT = 12;
export const AUTOCODE_MEMORY_RUNTIME_RECENT_TOOL_CALL_LIMIT = 5;
export const AUTOCODE_MEMORY_RUNTIME_INJECTED_MEMORY_ID_LIMIT = 128;
const AUTOCODE_MEMORY_RUNTIME_INJECTED_MEMORY_ID_MAX_CHARS = 160;
export const AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_CHARS = 1_800;
export const AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_TOKENS = 450;
export const AUTOCODE_MEMORY_RUNTIME_CONTEXT_ITEM_MAX_CHARS = 260;
export const AUTOCODE_MEMORY_RUNTIME_CONTEXT_ITEM_MAX_TOKENS = 90;
export const AUTOCODE_MEMORY_RUNTIME_CONTEXT_MIN_CONFIDENCE = 0.55;
export const AUTOCODE_MEMORY_RUNTIME_CONTEXT_FILE_REF_LIMIT = 3;
export const AUTOCODE_MEMORY_RUNTIME_CONTEXT_FILE_REF_MAX_CHARS = 80;
export const AUTOCODE_MEMORY_RUNTIME_CONTEXT_FILE_REF_MAX_TOKENS = 32;
const AUTOCODE_MEMORY_RUNTIME_CONTEXT_CANDIDATE_MULTIPLIER = 3;
export const AUTOCODE_MEMORY_RUNTIME_OUTCOME_CONTENT_MAX_CHARS = 1_200;
export const AUTOCODE_MEMORY_RUNTIME_OUTCOME_FIELD_MAX_CHARS = 500;
export const AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_LIMIT = 12;
export const AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_MAX_CHARS = 160;
export const AUTOCODE_MEMORY_RUNTIME_OUTCOME_RELATED_MODULE_LIMIT = 12;
export const AUTOCODE_MEMORY_RUNTIME_OUTCOME_RELATED_MODULE_MAX_CHARS = 96;
export const AUTOCODE_MEMORY_RUNTIME_OUTCOME_TAG_LIMIT = 16;
export const AUTOCODE_MEMORY_RUNTIME_OUTCOME_TAG_MAX_CHARS = 64;
export const AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_LIMIT = 12;
export const AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_MAX_CHARS = 96;
const AUTOCODE_MEMORY_RUNTIME_OUTCOME_INLINE_FILE_REF_LIMIT = 4;

const AUTOCODE_MEMORY_RUNTIME_TOOL_ARG_KEYS = new Set([
  'file_path',
  'path',
  'pattern',
  'glob',
  'command',
  'query',
  'limit',
  'offset',
]);

const AUTOCODE_MEMORY_RUNTIME_TOOL_ARG_OMITTED_KEYS = new Set([
  'content',
  'old_string',
  'new_string',
  'input',
  'output',
]);

const AUTOCODE_MEMORY_RUNTIME_RESULT_OMITTED_KEYS = new Set([
  'content',
  'stdout',
  'stderr',
  'output',
  'data',
  'text',
]);

const AUTOCODE_MEMORY_RUNTIME_REASONING_SIGNAL_PATTERNS = [
  /I was wrong about/i,
  /Let me reconsider/i,
  /Actually,?/i,
  /I initially thought/i,
  /Correction:/i,
  /Wait[,.]?/i,
  /approach (won't|will not|cannot) work/i,
  /try a different approach/i,
  /not available in this environment/i,
  /this method (is deprecated|has been removed|no longer exists)/i,
];

export function compactAutocodeMemoryRuntimeToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const compact: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (AUTOCODE_MEMORY_RUNTIME_TOOL_ARG_OMITTED_KEYS.has(key)) {
      continue;
    }
    if (!AUTOCODE_MEMORY_RUNTIME_TOOL_ARG_KEYS.has(key)) {
      continue;
    }

    const compactValue = compactAutocodeMemoryRuntimeValue(
      value,
      AUTOCODE_MEMORY_RUNTIME_TOOL_ARG_STRING_MAX_CHARS,
      { preserveTail: true },
    );
    if (compactValue !== undefined) {
      compact[key] = compactValue;
    }
  }

  return compact;
}

export function compactAutocodeMemoryRuntimeRecentToolCalls(
  toolCalls: readonly AutocodeMemoryRuntimeToolCall[],
): AutocodeMemoryRuntimeToolCall[] {
  return toolCalls
    .slice(-AUTOCODE_MEMORY_RUNTIME_RECENT_TOOL_CALL_LIMIT)
    .map((toolCall) => ({
      toolName: toolCall.toolName,
      args: compactAutocodeMemoryRuntimeToolArgs(toolCall.args),
    }));
}

export function compactAutocodeMemoryRuntimeInjectedMemoryIds(
  ids: Iterable<unknown>,
): string[] {
  const compact = new Set<string>();

  for (const rawId of ids) {
    if (typeof rawId !== 'string') {
      continue;
    }
    const id = rawId.trim();
    if (
      !id ||
      id.length > AUTOCODE_MEMORY_RUNTIME_INJECTED_MEMORY_ID_MAX_CHARS
    ) {
      continue;
    }
    if (compact.has(id)) {
      compact.delete(id);
    }
    compact.add(id);
    while (compact.size > AUTOCODE_MEMORY_RUNTIME_INJECTED_MEMORY_ID_LIMIT) {
      const oldest = compact.values().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      compact.delete(oldest);
    }
  }

  return [...compact];
}

export function compactAutocodeMemoryRuntimeToolResult(
  result: unknown,
): unknown {
  if (typeof result === 'string') {
    return truncateAutocodeMemoryRuntimeText(
      result,
      AUTOCODE_MEMORY_RUNTIME_TOOL_RESULT_STRING_MAX_CHARS,
      { preferDiagnosticWindow: true, preserveTail: true },
    );
  }
  if (
    typeof result === 'number' ||
    typeof result === 'boolean' ||
    result === null
  ) {
    return result;
  }
  if (Array.isArray(result)) {
    return {
      type: 'array',
      length: result.length,
      items: result
        .slice(0, 5)
        .map((item) =>
          compactAutocodeMemoryRuntimeValue(
            item,
            AUTOCODE_MEMORY_RUNTIME_OBJECT_VALUE_MAX_CHARS,
            { preferDiagnosticWindow: true, preserveTail: true },
          ),
        ),
    };
  }
  if (typeof result === 'object' && result !== null) {
    const compact: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result).slice(
      0,
      AUTOCODE_MEMORY_RUNTIME_OBJECT_KEY_LIMIT,
    )) {
      if (AUTOCODE_MEMORY_RUNTIME_RESULT_OMITTED_KEYS.has(key)) {
        compact[key] = '[omitted]';
        continue;
      }
      const compactValue = compactAutocodeMemoryRuntimeValue(
        value,
        AUTOCODE_MEMORY_RUNTIME_OBJECT_VALUE_MAX_CHARS,
        { preferDiagnosticWindow: true, preserveTail: true },
      );
      if (compactValue !== undefined) {
        compact[key] = compactValue;
      }
    }
    return compact;
  }
  return undefined;
}

export function compactAutocodeMemoryRuntimeReasoningText(
  text: string,
): string {
  return truncateAutocodeMemoryRuntimeText(
    text,
    AUTOCODE_MEMORY_RUNTIME_REASONING_TEXT_MAX_CHARS,
    {
      preferDiagnosticWindow: true,
      preserveTail: true,
      signalPatterns: AUTOCODE_MEMORY_RUNTIME_REASONING_SIGNAL_PATTERNS,
    },
  );
}

function compactAutocodeMemoryRuntimeValue(
  value: unknown,
  maxStringChars: number,
  options: {
    preferDiagnosticWindow?: boolean;
    preserveTail?: boolean;
    signalPatterns?: readonly RegExp[];
  } = {},
): unknown {
  if (typeof value === 'string') {
    return truncateAutocodeMemoryRuntimeText(value, maxStringChars, options);
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 5)
      .map((item) =>
        compactAutocodeMemoryRuntimeValue(item, maxStringChars, options),
      )
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function truncateAutocodeMemoryRuntimeText(
  text: string,
  maxChars: number,
  options: {
    preferDiagnosticWindow?: boolean;
    preserveTail?: boolean;
    signalPatterns?: readonly RegExp[];
  } = {},
): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (maxChars <= 0) {
    return '';
  }
  if (compact.length <= maxChars) {
    return compact;
  }
  if (maxChars <= 3) {
    return compact.slice(0, maxChars);
  }

  if (options.preferDiagnosticWindow) {
    const diagnosticIndex = findAutocodeMemoryRuntimeImportantTextIndex(
      compact,
      options.signalPatterns ?? [],
    );
    if (diagnosticIndex > Math.floor(maxChars / 2)) {
      if (options.preserveTail) {
        return truncateAutocodeMemoryRuntimeDiagnosticTailText(
          compact,
          maxChars,
          diagnosticIndex,
        );
      }
      const headBudget = Math.min(180, Math.floor(maxChars / 4));
      const windowBudget = Math.max(0, maxChars - headBudget - 8);
      const windowStart = Math.max(0, diagnosticIndex - 80);
      const window = compact
        .slice(windowStart, windowStart + windowBudget)
        .trim();
      return `${`${compact.slice(0, headBudget).trimEnd()} ... ${window}`.slice(0, maxChars - 3).trimEnd()}...`;
    }
  }

  if (options.preserveTail) {
    return truncateAutocodeMemoryRuntimeHeadTailText(compact, maxChars);
  }

  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function truncateAutocodeMemoryRuntimeHeadTailText(
  text: string,
  maxChars: number,
): string {
  const marker = ' ... [middle omitted] ... ';
  if (maxChars <= 0) {
    return '';
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  if (maxChars <= marker.length + 24) {
    return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  const contentBudget = maxChars - marker.length;
  const headBudget = Math.ceil(contentBudget * 0.58);
  const tailBudget = Math.max(0, contentBudget - headBudget);
  return `${text.slice(0, headBudget).trimEnd()}${marker}${text.slice(-tailBudget).trimStart()}`;
}

function truncateAutocodeMemoryRuntimeDiagnosticTailText(
  text: string,
  maxChars: number,
  diagnosticIndex: number,
): string {
  const marker = ' ... [middle omitted] ... ';
  const minimumContentBudget = 96;
  if (maxChars <= marker.length * 2 + minimumContentBudget) {
    return truncateAutocodeMemoryRuntimeHeadTailText(text, maxChars);
  }

  const headBudget = Math.min(180, Math.max(80, Math.floor(maxChars * 0.16)));
  const tailBudget = Math.min(280, Math.max(96, Math.floor(maxChars * 0.24)));
  const diagnosticBudget = Math.max(
    0,
    maxChars - headBudget - tailBudget - marker.length * 2,
  );
  if (diagnosticBudget < 96) {
    return truncateAutocodeMemoryRuntimeHeadTailText(text, maxChars);
  }

  const diagnosticStart = Math.max(
    0,
    diagnosticIndex - Math.floor(diagnosticBudget * 0.2),
  );
  const diagnosticWindow = text
    .slice(diagnosticStart, diagnosticStart + diagnosticBudget)
    .trim();
  const head = text.slice(0, headBudget).trimEnd();
  const tail = text.slice(-tailBudget).trimStart();
  return `${head}${marker}${diagnosticWindow}${marker}${tail}`;
}

function findAutocodeMemoryRuntimeImportantTextIndex(
  text: string,
  signalPatterns: readonly RegExp[],
): number {
  const patterns = [
    /\b(error|failed|failure|exception|traceback)\b/i,
    ...signalPatterns,
  ];
  let bestIndex = -1;
  for (const pattern of patterns) {
    const index = text.search(pattern);
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
      bestIndex = index;
    }
  }
  return bestIndex;
}

export function buildAutocodeWorkUnitOutcomeMemoryEntry(
  input: AutocodeMemoryRuntimeWorkUnitOutcomeInput,
): MemoryRecordEntry {
  const completedAt = input.completedAt ?? new Date().toISOString();
  const content = buildAutocodeWorkUnitOutcomeContent({
    ...input,
    completedAt,
  });
  const relatedFiles = compactAutocodeMemoryRuntimeOutcomeFiles(
    input.relatedFiles,
  );
  const relatedModules = compactAutocodeMemoryRuntimeBoundedTextList(
    input.relatedModules,
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_RELATED_MODULE_LIMIT,
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_RELATED_MODULE_MAX_CHARS,
  );
  const upstreamTaskIds = compactAutocodeMemoryRuntimeBoundedTextList(
    input.upstreamTaskIds,
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_LIMIT,
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_MAX_CHARS,
  );
  const workUnitRef: WorkUnitRef = {
    methodology: 'autocode',
    hierarchy: [input.phase ?? 'coding', input.workUnitId],
    label: input.workUnitTitle
      ? `${input.workUnitId}: ${input.workUnitTitle}`
      : input.workUnitId,
  };
  const tags = compactAutocodeMemoryRuntimeBoundedTextList(
    [
      'work_unit',
      input.outcome,
      input.source ?? 'core-runtime',
      input.phase ?? 'coding',
      ...(input.tags ?? []),
      ...upstreamTaskIds.map((id) => `upstream:${id}`),
    ],
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_TAG_LIMIT,
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_TAG_MAX_CHARS,
  );

  return {
    type: 'work_unit_outcome',
    content,
    confidence: input.outcome === 'success' ? 0.82 : 0.72,
    tags,
    relatedFiles,
    relatedModules,
    scope: 'work_unit',
    source: 'agent_explicit',
    sessionId: input.sessionId,
    projectId: input.projectId,
    workUnitRef,
    methodology: 'autocode',
    citationText: compactAutocodeMemoryRuntimeOutcomeField(input.summary),
    trustLevelScope: 'personal',
  };
}

export function buildAutocodeWorkUnitOutcomeSessionInsight(
  input: AutocodeMemoryRuntimeWorkUnitOutcomeInput,
): AutocodeMemoryRuntimeSessionInsight {
  const timestamp = input.completedAt ?? new Date().toISOString();
  const summary = compactAutocodeMemoryRuntimeOutcomeField(input.summary);
  const description = compactAutocodeMemoryRuntimeOutcomeField(
    input.workUnitDescription,
  );
  const error = compactAutocodeMemoryRuntimeOutcomeField(input.error);
  const upstreamTaskIds = compactAutocodeMemoryRuntimeBoundedTextList(
    input.upstreamTaskIds,
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_LIMIT,
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_MAX_CHARS,
  );
  return {
    sessionId: input.sessionId,
    subtaskId: input.workUnitId,
    timestamp,
    outcome: input.outcome,
    insights: [
      summary || description || input.workUnitTitle || input.workUnitId,
      ...(error ? [`Error: ${error}`] : []),
    ].filter(Boolean),
    keyFiles: compactAutocodeMemoryRuntimeOutcomeFiles(input.relatedFiles),
    source: input.source ?? 'core-runtime',
    workUnit: {
      id: input.workUnitId,
      ...(input.workUnitTitle ? { title: input.workUnitTitle } : {}),
      ...(description ? { description } : {}),
      upstreamTaskIds,
    },
  };
}

export function formatAutocodeMemoryRuntimeContext(
  memories: Memory[],
  maxItems = 6,
): string {
  const itemLimit = Math.max(0, maxItems);
  const usable = selectMemoryContextItems(
    memories.filter(isAutocodeMemoryRuntimeContextMemoryEligible),
    {
      maxItems: itemLimit * AUTOCODE_MEMORY_RUNTIME_CONTEXT_CANDIDATE_MULTIPLIER,
      minConfidence: AUTOCODE_MEMORY_RUNTIME_CONTEXT_MIN_CONFIDENCE,
      getContent: formatAutocodeMemoryRuntimeContextMemoryContent,
    },
  );

  if (usable.length === 0) {
    return '';
  }

  const lines = [
    '## Project Memory',
    '',
    'Use these prior outcomes, gotchas, and decisions when relevant. Do not repeat failed approaches.',
    '',
  ];

  let omitted = 0;
  let included = 0;
  const seenContextFiles = new Set<string>();
  for (let index = 0; index < usable.length; index++) {
    if (included >= itemLimit) {
      omitted += usable.length - index;
      break;
    }

    const memory = usable[index];
    const formatted = formatAutocodeMemoryRuntimeContextLine(
      memory,
      seenContextFiles,
    );
    const line = formatted.line;
    const next = [...lines, line].join('\n');
    if (!fitsAutocodeMemoryRuntimeContextBudget(next)) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    for (const fileKey of formatted.displayedFileKeys) {
      seenContextFiles.add(fileKey);
    }
    included += 1;
  }

  if (omitted > 0) {
    const omittedLine = `- ... ${omitted} more memory item(s) omitted; search memory only if needed.`;
    const next = [...lines, omittedLine].join('\n');
    if (fitsAutocodeMemoryRuntimeContextBudget(next)) {
      lines.push(omittedLine);
    }
  }

  return truncateAutocodeMemoryRuntimeTextToTokenBudget(
    lines.join('\n'),
    AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_CHARS,
    AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_TOKENS,
  );
}

function fitsAutocodeMemoryRuntimeContextBudget(text: string): boolean {
  return (
    text.length <= AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_CHARS &&
    estimateTokens(text) <= AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_TOKENS
  );
}

function isAutocodeMemoryRuntimeContextMemoryEligible(memory: Memory): boolean {
  return (
    memory.type !== 'prefetch_pattern' &&
    memory.type !== 'context_cost' &&
    isMemoryEligibleForPromptContext(memory)
  );
}

interface FormattedRuntimeContextLine {
  line: string;
  displayedFileKeys: string[];
}

function formatAutocodeMemoryRuntimeContextLine(
  memory: Memory,
  seenContextFiles: Set<string>,
): FormattedRuntimeContextLine {
  const sourceFiles = uniquePathStrings(memory.relatedFiles);
  const unseenFiles = sourceFiles.filter(
    (file) => !seenContextFiles.has(normalizeRuntimePathKey(file)),
  );
  const displayedFiles = unseenFiles.slice(
    0,
    AUTOCODE_MEMORY_RUNTIME_CONTEXT_FILE_REF_LIMIT,
  );
  const visibleFiles = displayedFiles.map((file) =>
    truncateAutocodeMemoryRuntimePathTailToTokenBudget(
      file,
      AUTOCODE_MEMORY_RUNTIME_CONTEXT_FILE_REF_MAX_CHARS,
      AUTOCODE_MEMORY_RUNTIME_CONTEXT_FILE_REF_MAX_TOKENS,
    ),
  );
  const files =
    visibleFiles.length > 0
      ? ` Files: ${visibleFiles.join(', ')}${unseenFiles.length > visibleFiles.length ? ', ...' : ''}.`
      : '';
  return {
    line: `- [${memory.type}] ${formatAutocodeMemoryRuntimeContextMemoryContent(memory)}${files}`,
    displayedFileKeys: displayedFiles.map(normalizeRuntimePathKey),
  };
}

function formatAutocodeMemoryRuntimeContextMemoryContent(memory: Memory): string {
  return truncateAutocodeMemoryRuntimeTextToTokenBudget(
    memory.content,
    AUTOCODE_MEMORY_RUNTIME_CONTEXT_ITEM_MAX_CHARS,
    AUTOCODE_MEMORY_RUNTIME_CONTEXT_ITEM_MAX_TOKENS,
    { preserveTail: true },
  );
}

function buildAutocodeWorkUnitOutcomeContent(
  input: AutocodeMemoryRuntimeWorkUnitOutcomeInput & { completedAt: string },
): string {
  const title = input.workUnitTitle ? ` (${input.workUnitTitle})` : '';
  const description = compactAutocodeMemoryRuntimeOutcomeField(
    input.workUnitDescription,
  );
  const summary = compactAutocodeMemoryRuntimeOutcomeField(input.summary);
  const error = compactAutocodeMemoryRuntimeOutcomeField(input.error);
  const upstreamTaskIds = compactAutocodeMemoryRuntimeBoundedTextList(
    input.upstreamTaskIds,
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_LIMIT,
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_MAX_CHARS,
  );
  const relatedFiles = compactAutocodeMemoryRuntimeOutcomeFiles(
    input.relatedFiles,
  );
  const inlineRelatedFiles = relatedFiles.slice(
    0,
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_INLINE_FILE_REF_LIMIT,
  );
  const lines = [
    `Work unit ${input.workUnitId}${title} finished with outcome: ${input.outcome}.`,
    description ? `Task: ${description}` : '',
    summary ? `Summary: ${summary}` : '',
    upstreamTaskIds.length > 0
      ? `Upstream tasks: ${upstreamTaskIds.join(', ')}`
      : '',
    inlineRelatedFiles.length > 0
      ? `Files: ${inlineRelatedFiles.join(', ')}${relatedFiles.length > inlineRelatedFiles.length ? ', ...' : ''}`
      : '',
    input.durationMs ? `Duration: ${input.durationMs}ms` : '',
    error ? `Error: ${error}` : '',
    `Completed at: ${input.completedAt}`,
  ].filter(Boolean);

  return truncateAutocodeMemoryRuntimeText(
    lines.join('\n'),
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_CONTENT_MAX_CHARS,
    { preferDiagnosticWindow: input.outcome !== 'success', preserveTail: true },
  );
}

function compactAutocodeMemoryRuntimeOutcomeField(
  value: string | undefined,
): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return truncateAutocodeMemoryRuntimeText(
    value,
    AUTOCODE_MEMORY_RUNTIME_OUTCOME_FIELD_MAX_CHARS,
    { preferDiagnosticWindow: true, preserveTail: true },
  );
}

function compactAutocodeMemoryRuntimeOutcomeFiles(
  values: readonly unknown[] | undefined,
): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const file of uniquePathStrings(values)) {
    const compacted = truncateAutocodeMemoryRuntimePathTail(
      file,
      AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_MAX_CHARS,
    );
    const key = compacted.toLowerCase();
    if (!compacted || seen.has(key)) {
      continue;
    }

    seen.add(key);
    files.push(compacted);
    if (files.length >= AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_LIMIT) {
      break;
    }
  }

  return files;
}

function compactAutocodeMemoryRuntimeBoundedTextList(
  values: readonly unknown[] | undefined,
  limit: number,
  maxItemChars: number,
): string[] {
  const itemLimit = Math.max(0, limit);
  if (itemLimit === 0) {
    return [];
  }

  const compactedValues: string[] = [];
  const seen = new Set<string>();
  for (const value of uniqueStrings(values)) {
    const compacted = truncateAutocodeMemoryRuntimeText(value, maxItemChars, {
      preserveTail: true,
    });
    const key = normalizeRuntimeTextKey(compacted);
    if (!compacted || seen.has(key)) {
      continue;
    }

    seen.add(key);
    compactedValues.push(compacted);
    if (compactedValues.length >= itemLimit) {
      break;
    }
  }

  return compactedValues;
}

function truncateAutocodeMemoryRuntimePathTail(
  path: string,
  maxChars: number,
): string {
  const normalized = normalizeRuntimePath(path);
  if (maxChars <= 0) {
    return '';
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(-maxChars).replace(/^\/+/, '');
}

function truncateAutocodeMemoryRuntimePathTailToTokenBudget(
  path: string,
  maxChars: number,
  maxTokens: number,
): string {
  if (maxChars <= 0 || maxTokens <= 0) {
    return '';
  }

  const normalized = normalizeRuntimePath(path);
  const initial = truncateAutocodeMemoryRuntimePathTail(normalized, maxChars);
  if (estimateTokens(initial) <= maxTokens) {
    return initial;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, normalized.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = truncateAutocodeMemoryRuntimePathTail(
      normalized,
      midpoint,
    );
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function truncateAutocodeMemoryRuntimeTextToTokenBudget(
  text: string,
  maxChars: number,
  maxTokens: number,
  options: {
    preferDiagnosticWindow?: boolean;
    preserveTail?: boolean;
    signalPatterns?: readonly RegExp[];
  } = {},
): string {
  if (maxChars <= 0 || maxTokens <= 0) {
    return '';
  }

  const initial = truncateAutocodeMemoryRuntimeText(text, maxChars, options);
  if (estimateTokens(initial) <= maxTokens) {
    return initial;
  }

  const compact = text.replace(/\s+/g, ' ').trim();
  let best = '';
  let low = 1;
  let high = Math.min(maxChars, compact.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = truncateAutocodeMemoryRuntimeText(
      compact,
      midpoint,
      options,
    );
    if (
      candidate.length <= maxChars &&
      estimateTokens(candidate) <= maxTokens
    ) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function uniqueStrings(values: readonly unknown[] | undefined): string[] {
  if (!values) return [];
  return [
    ...new Set(
      values.map((value) => String(value ?? '').trim()).filter(Boolean),
    ),
  ];
}

function uniquePathStrings(values: readonly unknown[] | undefined): string[] {
  if (!values) {
    return [];
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeRuntimePath(String(value ?? ''));
    if (!normalized) {
      continue;
    }

    const key = normalizeRuntimePathKey(normalized);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    paths.push(normalized);
  }

  return paths;
}

function normalizeRuntimePath(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}

function normalizeRuntimePathKey(value: string): string {
  return normalizeRuntimePath(value).toLowerCase();
}

function normalizeRuntimeTextKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export type AutocodeMemoryRuntimeMemoryType = MemoryType;
