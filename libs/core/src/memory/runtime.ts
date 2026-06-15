import { selectMemoryContextItems } from './injection/context-selection.js';
import { stripLowValueMemoryLines } from './outcome-content.js';
import {
  estimateTokens,
  isMemoryEligibleForAutomationContext,
  isMemoryEligibleForPromptContext,
} from './retrieval/context-packer.js';
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
      type: 'memory:token-usage';
      inputTokens: number;
      stepNumber: number;
      contextWindowLimit?: number;
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
const AUTOCODE_MEMORY_RUNTIME_OBJECT_DIAGNOSTIC_MAX_CHARS = 360;
const AUTOCODE_MEMORY_RUNTIME_OBJECT_KEY_LIMIT = 12;
const AUTOCODE_MEMORY_RUNTIME_OBJECT_SCAN_KEY_LIMIT = 32;
const AUTOCODE_MEMORY_RUNTIME_ARRAY_ITEM_LIMIT = 5;
const AUTOCODE_MEMORY_RUNTIME_ARRAY_SCAN_ITEM_LIMIT = 24;
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
const AUTOCODE_MEMORY_RUNTIME_PREFETCH_PATTERN_HINT =
  '- Search memory before broad file scans: search_memory("files to read").';
const AUTOCODE_MEMORY_RUNTIME_CONTEXT_COST_HINT =
  '- Search memory before broad rereads: search_memory("token cost").';
const AUTOCODE_MEMORY_RUNTIME_MACHINE_MEMORY_HINT =
  '- Search memory before broad scans/rereads: search_memory("files to read"); search_memory("token cost").';
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

const AUTOCODE_MEMORY_RUNTIME_RESULT_PRIORITY_KEYS = new Set([
  'diagnostictext',
  'diagnostic_text',
  'error',
  'message',
  'exitcode',
  'exit_code',
  'code',
  'status',
  'statuscode',
  'status_code',
  'success',
  'ok',
  'failed',
]);

const AUTOCODE_MEMORY_RUNTIME_OBJECT_KEY_ALIASES = new Map<string, string>([
  ['std_out', 'stdout'],
  ['standard_output', 'stdout'],
  ['std_err', 'stderr'],
  ['standard_error', 'stderr'],
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
    const canonicalKey = canonicalizeAutocodeMemoryRuntimeKey(key);
    if (AUTOCODE_MEMORY_RUNTIME_TOOL_ARG_OMITTED_KEYS.has(canonicalKey)) {
      continue;
    }
    if (!AUTOCODE_MEMORY_RUNTIME_TOOL_ARG_KEYS.has(canonicalKey)) {
      continue;
    }

    const compactValue = compactAutocodeMemoryRuntimeValue(
      value,
      AUTOCODE_MEMORY_RUNTIME_TOOL_ARG_STRING_MAX_CHARS,
      { preserveTail: true },
    );
    if (compactValue !== undefined) {
      compact[canonicalKey] = compactValue;
    }
  }

  return compact;
}

function canonicalizeAutocodeMemoryRuntimeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function canonicalizeAutocodeMemoryRuntimeResultKey(key: string): string {
  const canonicalKey = canonicalizeAutocodeMemoryRuntimeKey(key);
  return AUTOCODE_MEMORY_RUNTIME_OBJECT_KEY_ALIASES.get(canonicalKey) ?? canonicalKey;
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
    return compactAutocodeMemoryRuntimeToolResultText(
      result,
      AUTOCODE_MEMORY_RUNTIME_TOOL_RESULT_STRING_MAX_CHARS,
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
    return compactAutocodeMemoryRuntimeArrayValue(
      result,
      AUTOCODE_MEMORY_RUNTIME_OBJECT_VALUE_MAX_CHARS,
      {
        preferDiagnosticWindow: true,
        preserveTail: true,
        stripLowValueLines: true,
      },
      { preserveEmptySummary: true },
    );
  }
  if (typeof result === 'object' && result !== null) {
    return compactAutocodeMemoryRuntimeToolResultObject(result);
  }
  return undefined;
}

function compactAutocodeMemoryRuntimeToolResultObject(
  result: object,
): Record<string, unknown> {
  const entries = Object.entries(result).slice(
    0,
    AUTOCODE_MEMORY_RUNTIME_OBJECT_SCAN_KEY_LIMIT,
  );
  const omittedKeys: string[] = [];
  const diagnosticParts: string[] = [];
  const priorityEntries: Array<[string, unknown]> = [];
  const normalEntries: Array<[string, unknown]> = [];

  for (const [key, value] of entries) {
    const canonicalKey = canonicalizeAutocodeMemoryRuntimeResultKey(key);
    if (AUTOCODE_MEMORY_RUNTIME_RESULT_OMITTED_KEYS.has(canonicalKey)) {
      if (!omittedKeys.includes(canonicalKey)) {
        omittedKeys.push(canonicalKey);
      }
      const diagnosticText = extractAutocodeMemoryRuntimeResultDiagnosticText(canonicalKey, value);
      if (diagnosticText) {
        diagnosticParts.push(diagnosticText);
      }
      continue;
    }

    if (AUTOCODE_MEMORY_RUNTIME_RESULT_PRIORITY_KEYS.has(canonicalKey)) {
      priorityEntries.push([key, value]);
    } else {
      normalEntries.push([key, value]);
    }
  }

  const compact: Record<string, unknown> = {};
  if (omittedKeys.length > 0) {
    compact.omittedKeys = omittedKeys.slice(0, AUTOCODE_MEMORY_RUNTIME_OBJECT_KEY_LIMIT);
  }
  if (diagnosticParts.length > 0) {
    compact.diagnosticText = truncateAutocodeMemoryRuntimeText(
      diagnosticParts.join(' '),
      AUTOCODE_MEMORY_RUNTIME_OBJECT_DIAGNOSTIC_MAX_CHARS,
      { preferDiagnosticWindow: true, preserveTail: true },
    );
  }

  for (const [key, value] of [...priorityEntries, ...normalEntries]) {
    if (Object.keys(compact).length >= AUTOCODE_MEMORY_RUNTIME_OBJECT_KEY_LIMIT) {
      break;
    }
    const compactValue = compactAutocodeMemoryRuntimeValue(
      value,
      AUTOCODE_MEMORY_RUNTIME_OBJECT_VALUE_MAX_CHARS,
      {
        preferDiagnosticWindow: true,
        preserveTail: true,
        stripLowValueLines: true,
      },
    );
    if (compactValue !== undefined) {
      compact[key] = compactValue;
    }
  }

  return compact;
}

function extractAutocodeMemoryRuntimeResultDiagnosticText(
  key: string,
  value: unknown,
): string | undefined {
  const text = flattenAutocodeMemoryRuntimeDiagnosticValue(value);
  if (!text || findAutocodeMemoryRuntimeImportantTextIndex(text, []) < 0) {
    return undefined;
  }
  const compact = compactAutocodeMemoryRuntimeToolResultText(
    text,
    AUTOCODE_MEMORY_RUNTIME_OBJECT_DIAGNOSTIC_MAX_CHARS,
  );
  return compact ? `${key}: ${compact}` : undefined;
}

function compactAutocodeMemoryRuntimeToolResultText(
  text: string,
  maxChars: number,
): string {
  return truncateAutocodeMemoryRuntimeText(
    stripLowValueMemoryLines(text),
    maxChars,
    { preferDiagnosticWindow: true, preserveTail: true },
  );
}

function flattenAutocodeMemoryRuntimeDiagnosticValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 5)
      .map((item) => flattenAutocodeMemoryRuntimeDiagnosticValue(item))
      .filter(Boolean)
      .join(' ');
  }
  return '';
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
    stripLowValueLines?: boolean;
  } = {},
): unknown {
  if (typeof value === 'string') {
    const text = options.stripLowValueLines ? stripLowValueMemoryLines(value) : value;
    if (options.stripLowValueLines && !text.trim()) {
      return undefined;
    }
    return truncateAutocodeMemoryRuntimeText(text, maxStringChars, options);
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return compactAutocodeMemoryRuntimeArrayValue(
      value,
      maxStringChars,
      options,
    );
  }
  return undefined;
}

function compactAutocodeMemoryRuntimeArrayValue(
  value: readonly unknown[],
  maxStringChars: number,
  options: {
    preferDiagnosticWindow?: boolean;
    preserveTail?: boolean;
    signalPatterns?: readonly RegExp[];
    stripLowValueLines?: boolean;
  },
  summaryOptions: {
    preserveEmptySummary?: boolean;
  } = {},
): { type: 'array'; length: number; items: unknown[] } | undefined {
  const items: unknown[] = [];
  const seen = new Set<string>();

  const scanLimit = Math.min(
    value.length,
    AUTOCODE_MEMORY_RUNTIME_ARRAY_SCAN_ITEM_LIMIT,
  );
  for (let index = 0; index < scanLimit; index += 1) {
    const item = value[index];
    const compactValue = compactAutocodeMemoryRuntimeValue(
      item,
      maxStringChars,
      options,
    );
    if (compactValue === undefined) {
      continue;
    }

    const key = compactAutocodeMemoryRuntimeValueKey(compactValue);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    items.push(compactValue);
    if (items.length >= AUTOCODE_MEMORY_RUNTIME_ARRAY_ITEM_LIMIT) {
      break;
    }
  }

  if (items.length === 0 && !summaryOptions.preserveEmptySummary) {
    return undefined;
  }

  return {
    type: 'array',
    length: value.length,
    items,
  };
}

function compactAutocodeMemoryRuntimeValueKey(value: unknown): string {
  if (typeof value === 'string') {
    return `string:${normalizeRuntimeTextKey(value)}`;
  }
  try {
    return `${typeof value}:${JSON.stringify(value)}`;
  } catch {
    return `${typeof value}:${String(value)}`;
  }
}

function truncateAutocodeMemoryRuntimeText(
  text: string,
  maxChars: number,
  options: {
    preferDiagnosticWindow?: boolean;
    preserveTail?: boolean;
    signalPatterns?: readonly RegExp[];
    stripLowValueLines?: boolean;
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
  const content = buildAutocodeWorkUnitOutcomeContent(input);
  const relatedFiles = compactAutocodeMemoryRuntimeOutcomeFiles(
    input.relatedFiles,
  );
  const relatedModules = compactAutocodeMemoryRuntimeRelatedModules(
    input.relatedModules,
    relatedFiles,
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
  const machineHints = buildAutocodeMemoryRuntimeMachineHints(
    memories,
    itemLimit > 0,
  );
  const usable = selectMemoryContextItems(
    memories.filter(isAutocodeMemoryRuntimeContextMemoryEligible),
    {
      maxItems: itemLimit * AUTOCODE_MEMORY_RUNTIME_CONTEXT_CANDIDATE_MULTIPLIER,
      minConfidence: AUTOCODE_MEMORY_RUNTIME_CONTEXT_MIN_CONFIDENCE,
      getContent: formatAutocodeMemoryRuntimeContextMemoryContent,
    },
  );

  if (usable.length === 0 && machineHints.length === 0) {
    return '';
  }

  const lines = [
    '## Project Memory',
    '',
    'Use these prior outcomes, gotchas, and decisions when relevant. Do not repeat failed approaches.',
    '',
  ];
  if (machineHints.length > 0) {
    lines.push(...machineHints, '');
  }

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

function buildAutocodeMemoryRuntimeMachineHints(
  memories: Memory[],
  enabled: boolean,
): string[] {
  if (!enabled) {
    return [];
  }

  const hasPrefetchPatternHint = hasAutocodeMemoryRuntimePrefetchPatternHint(memories);
  const hasContextCostHint = hasAutocodeMemoryRuntimeContextCostHint(memories);
  if (hasPrefetchPatternHint && hasContextCostHint) {
    return [AUTOCODE_MEMORY_RUNTIME_MACHINE_MEMORY_HINT];
  }

  const hints: string[] = [];
  if (hasPrefetchPatternHint) {
    hints.push(AUTOCODE_MEMORY_RUNTIME_PREFETCH_PATTERN_HINT);
  }
  if (hasContextCostHint) {
    hints.push(AUTOCODE_MEMORY_RUNTIME_CONTEXT_COST_HINT);
  }
  return hints;
}

function hasAutocodeMemoryRuntimePrefetchPatternHint(memories: Memory[]): boolean {
  return memories.some((memory) =>
    memory.type === 'prefetch_pattern' &&
    isMemoryEligibleForAutomationContext(memory)
  );
}

function hasAutocodeMemoryRuntimeContextCostHint(memories: Memory[]): boolean {
  return memories.some((memory) =>
    memory.type === 'context_cost' &&
    isMemoryEligibleForAutomationContext(memory)
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
  const content = formatAutocodeMemoryRuntimeContextMemoryContent(memory);
  const sourceFiles = uniquePathStrings(memory.relatedFiles);
  const mentionedFiles = sourceFiles.filter((file) =>
    isAutocodeMemoryRuntimePathMentionedInText(file, content)
  );
  const unseenFiles = sourceFiles.filter(
    (file) =>
      !seenContextFiles.has(normalizeRuntimePathKey(file)) &&
      !isAutocodeMemoryRuntimePathMentionedInText(file, content),
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
      ? ` Files: ${formatCompactAutocodeMemoryRuntimePathList(visibleFiles)}${unseenFiles.length > visibleFiles.length ? ', ...' : ''}.`
      : '';
  return {
    line: `- [${memory.type}] ${content}${files}`,
    displayedFileKeys: [
      ...mentionedFiles,
      ...displayedFiles,
    ].map(normalizeRuntimePathKey),
  };
}

function isAutocodeMemoryRuntimePathMentionedInText(
  path: string,
  text: string,
): boolean {
  const normalizedText = normalizeAutocodeMemoryRuntimeTextForPathMatch(text);
  if (!normalizedText) {
    return false;
  }

  const normalizedPath = normalizeAutocodeMemoryRuntimeTextForPathMatch(path);
  const fileName = normalizeAutocodeMemoryRuntimeTextForPathMatch(
    path.split('/').pop() ?? path,
  );
  return normalizedText.includes(normalizedPath) ||
    (fileName.length > 0 &&
      containsStandaloneAutocodeMemoryRuntimePathName(normalizedText, fileName));
}

function containsStandaloneAutocodeMemoryRuntimePathName(
  text: string,
  pathName: string,
): boolean {
  return new RegExp(
    `(?:^|[^a-z0-9_.-])${escapeAutocodeMemoryRuntimeRegExp(pathName)}(?:$|[^a-z0-9_.-])`,
  ).test(text);
}

function escapeAutocodeMemoryRuntimeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAutocodeMemoryRuntimeTextForPathMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatAutocodeMemoryRuntimeContextMemoryContent(memory: Memory): string {
  const content = stripLowValueMemoryLines(memory.content);
  return truncateAutocodeMemoryRuntimeTextToTokenBudget(
    content,
    AUTOCODE_MEMORY_RUNTIME_CONTEXT_ITEM_MAX_CHARS,
    AUTOCODE_MEMORY_RUNTIME_CONTEXT_ITEM_MAX_TOKENS,
    { preserveTail: true },
  );
}

function buildAutocodeWorkUnitOutcomeContent(input: AutocodeMemoryRuntimeWorkUnitOutcomeInput): string {
  const title = compactAutocodeMemoryRuntimeOutcomeField(input.workUnitTitle);
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
    summary ? `Summary: ${summary}` : '',
    description
      ? `Task: ${description}`
      : title
        ? `Task: ${title}`
        : '',
    upstreamTaskIds.length > 0
      ? `Upstream tasks: ${upstreamTaskIds.join(', ')}`
      : '',
    inlineRelatedFiles.length > 0
      ? `Files: ${formatCompactAutocodeMemoryRuntimePathList(inlineRelatedFiles)}${relatedFiles.length > inlineRelatedFiles.length ? ', ...' : ''}`
      : '',
    error ? `Error: ${error}` : '',
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

function formatCompactAutocodeMemoryRuntimePathList(paths: readonly string[]): string {
  const expanded = paths.join(', ');
  if (paths.length < 2) {
    return expanded;
  }

  const segments = paths.map(splitAutocodeMemoryRuntimePath);
  if (segments.some((parts) => parts.length < 2)) {
    return expanded;
  }

  const maxCommonDepth = Math.min(...segments.map((parts) => parts.length - 1));
  let commonDepth = 0;
  for (let index = 0; index < maxCommonDepth; index += 1) {
    const segment = segments[0][index].toLowerCase();
    if (!segments.every((parts) => parts[index].toLowerCase() === segment)) {
      break;
    }
    commonDepth += 1;
  }

  if (commonDepth < 2) {
    return expanded;
  }

  const commonDir = segments[0].slice(0, commonDepth).join('/');
  const tails = segments.map((parts) => parts.slice(commonDepth).join('/'));
  const compact = `${commonDir}/{${tails.join(', ')}}`;
  return compact.length < expanded.length ? compact : expanded;
}

function splitAutocodeMemoryRuntimePath(path: string): string[] {
  return normalizeRuntimePath(path).split('/').filter(Boolean);
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

function compactAutocodeMemoryRuntimeRelatedModules(
  values: readonly unknown[] | undefined,
  relatedFiles: readonly string[],
  limit: number,
  maxItemChars: number,
): string[] {
  const itemLimit = Math.max(0, limit);
  if (itemLimit === 0) {
    return [];
  }

  const relatedFileRefs = getAutocodeMemoryRuntimeRelatedFileRefs(relatedFiles);
  const compactedValues: string[] = [];
  const seen = new Set<string>();
  for (const value of uniqueStrings(values)) {
    const compacted = truncateAutocodeMemoryRuntimeText(value, maxItemChars, {
      preserveTail: true,
    });
    const key = normalizeRuntimeTextKey(compacted);
    if (
      !compacted ||
      seen.has(key) ||
      isRedundantAutocodeMemoryRuntimeRelatedModule(compacted, relatedFileRefs)
    ) {
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

interface AutocodeMemoryRuntimeRelatedFileRefs {
  paths: Set<string>;
  fileNames: Set<string>;
  fileStems: Set<string>;
}

function getAutocodeMemoryRuntimeRelatedFileRefs(
  files: readonly string[],
): AutocodeMemoryRuntimeRelatedFileRefs {
  const paths = new Set<string>();
  const fileNames = new Set<string>();
  const fileStems = new Set<string>();
  for (const file of files) {
    const normalized = normalizeRuntimePath(file);
    if (!normalized) {
      continue;
    }

    paths.add(normalizeRuntimePathKey(normalized));
    const fileName = normalized.split('/').pop()?.toLowerCase();
    if (!fileName) {
      continue;
    }

    fileNames.add(fileName);
    const stem = stripAutocodeMemoryRuntimeFileExtension(fileName);
    if (stem) {
      fileStems.add(stem);
    }
  }

  return { paths, fileNames, fileStems };
}

function isRedundantAutocodeMemoryRuntimeRelatedModule(
  module: string,
  relatedFileRefs: AutocodeMemoryRuntimeRelatedFileRefs,
): boolean {
  const moduleKey = normalizeRuntimeTextKey(module);
  if (!moduleKey) {
    return true;
  }

  return relatedFileRefs.paths.has(normalizeRuntimePathKey(module)) ||
    relatedFileRefs.fileNames.has(moduleKey) ||
    relatedFileRefs.fileStems.has(moduleKey);
}

function stripAutocodeMemoryRuntimeFileExtension(fileName: string): string {
  return fileName.replace(
    /\.(?:cjs|cts|d\.ts|e2e\.ts|js|jsx|mjs|mts|spec\.ts|test\.ts|ts|tsx)$/i,
    '',
  );
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
