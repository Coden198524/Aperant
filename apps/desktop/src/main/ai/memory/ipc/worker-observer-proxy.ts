/**
 * WorkerObserverProxy
 *
 * Lives in the worker thread and proxies memory operations to the main thread.
 * Synchronous observation events are fire-and-forget; search, record, and
 * step injection use request/response IPC with a short timeout.
 */

import { MessagePort } from 'worker_threads';
import { randomUUID } from 'crypto';
import {
  compactAutocodeMemoryRuntimeReasoningText,
  compactAutocodeMemoryRuntimeInjectedMemoryIds,
  compactAutocodeMemoryRuntimeRecentToolCalls,
  compactAutocodeMemoryRuntimeToolArgs,
  compactAutocodeMemoryRuntimeToolResult,
  type AutocodeMemoryRuntimeIpcResponse,
  type AutocodeMemoryRuntimeObservationIpcRequest,
  type AutocodeMemoryRuntimeSerializableRecentContext,
  type AutocodeMemoryRuntimeToolIpcRequest,
  type Memory,
  type MemoryRecordEntry,
  type MemorySearchFilters,
} from '@autocode/core';
import type { RecentToolCallContext, StepInjection } from '../injection/step-injection-decider';
import { estimateTokens } from '../retrieval/context-packer';

const IPC_TIMEOUT_MS = 3_000;
const MEMORY_SEARCH_IPC_QUERY_MAX_CHARS = 800;
const MEMORY_SEARCH_IPC_QUERY_MAX_TOKENS = 200;
const MEMORY_SEARCH_IPC_RELATED_FILE_LIMIT = 16;
const MEMORY_SEARCH_IPC_RELATED_FILE_MAX_CHARS = 180;
const MEMORY_SEARCH_IPC_RELATED_FILE_MAX_TOKENS = 48;
const MEMORY_SEARCH_IPC_RELATED_MODULE_LIMIT = 12;
const MEMORY_SEARCH_IPC_RELATED_MODULE_MAX_CHARS = 96;
const MEMORY_SEARCH_IPC_RELATED_MODULE_MAX_TOKENS = 32;
const MEMORY_SEARCH_IPC_OMISSION_MARKER = ' ... [memory search middle omitted before IPC] ... ';
const MEMORY_RECORD_IPC_CONTENT_MAX_CHARS = 2_000;
const MEMORY_RECORD_IPC_CONTENT_MAX_TOKENS = 500;
const MEMORY_RECORD_IPC_CITATION_TEXT_MAX_CHARS = 1_000;
const MEMORY_RECORD_IPC_CITATION_TEXT_MAX_TOKENS = 250;
const MEMORY_RECORD_IPC_CONTEXT_PREFIX_MAX_CHARS = 600;
const MEMORY_RECORD_IPC_CONTEXT_PREFIX_MAX_TOKENS = 150;
const MEMORY_RECORD_IPC_TAG_LIMIT = 20;
const MEMORY_RECORD_IPC_TAG_MAX_CHARS = 64;
const MEMORY_RECORD_IPC_TAG_MAX_TOKENS = 24;
const MEMORY_RECORD_IPC_RELATED_FILE_LIMIT = 24;
const MEMORY_RECORD_IPC_RELATED_FILE_MAX_CHARS = 220;
const MEMORY_RECORD_IPC_RELATED_FILE_MAX_TOKENS = 56;
const MEMORY_RECORD_IPC_RELATED_MODULE_LIMIT = 16;
const MEMORY_RECORD_IPC_RELATED_MODULE_MAX_CHARS = 96;
const MEMORY_RECORD_IPC_RELATED_MODULE_MAX_TOKENS = 32;
const MEMORY_RECORD_IPC_OMISSION_MARKER = ' ... [memory record middle omitted before IPC] ... ';
const MEMORY_ACCESS_ID_MAX_CHARS = 256;

export type MemoryToolIpcRequest = AutocodeMemoryRuntimeToolIpcRequest;
export type SerializableRecentContext = AutocodeMemoryRuntimeSerializableRecentContext;
export type MemoryIpcMessage = AutocodeMemoryRuntimeObservationIpcRequest | MemoryToolIpcRequest;

export class WorkerObserverProxy {
  private readonly port: MessagePort;
  private readonly pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(port: MessagePort) {
    this.port = port;
    this.port.on('message', (msg: AutocodeMemoryRuntimeIpcResponse) => {
      this.handleResponse(msg);
    });
  }

  onToolCall(toolName: string, args: Record<string, unknown>, stepNumber: number): void {
    this.postFireAndForget({
      type: 'memory:tool-call',
      toolName,
      args: compactAutocodeMemoryRuntimeToolArgs(args),
      stepNumber,
    });
  }

  onToolResult(toolName: string, result: unknown, stepNumber: number): void {
    this.postFireAndForget({
      type: 'memory:tool-result',
      toolName,
      result: compactAutocodeMemoryRuntimeToolResult(result),
      stepNumber,
    });
  }

  onReasoning(text: string, stepNumber: number): void {
    this.postFireAndForget({
      type: 'memory:reasoning',
      text: compactAutocodeMemoryRuntimeReasoningText(text),
      stepNumber,
    });
  }

  onStepComplete(stepNumber: number): void {
    this.postFireAndForget({
      type: 'memory:step-complete',
      stepNumber,
    });
  }

  async searchMemory(filters: MemorySearchFilters): Promise<Memory[]> {
    const requestId = randomUUID();
    try {
      const response = await this.sendRequest<AutocodeMemoryRuntimeIpcResponse>(
        { type: 'memory:search', requestId, filters: compactMemorySearchFiltersForIpc(filters) },
        requestId,
      );
      return response.type === 'memory:search-result' ? response.memories : [];
    } catch {
      return [];
    }
  }

  async recordMemory(entry: MemoryRecordEntry): Promise<string | null> {
    const requestId = randomUUID();
    try {
      const response = await this.sendRequest<AutocodeMemoryRuntimeIpcResponse>(
        { type: 'memory:record', requestId, entry: compactMemoryRecordEntryForIpc(entry) },
        requestId,
      );
      return response.type === 'memory:stored' ? response.id : null;
    } catch {
      return null;
    }
  }

  async updateAccessCount(memoryId: string): Promise<void> {
    const normalizedMemoryId = compactMemoryIdForIpc(memoryId);
    if (!normalizedMemoryId) {
      return;
    }

    const requestId = randomUUID();
    try {
      await this.sendRequest<AutocodeMemoryRuntimeIpcResponse>(
        { type: 'memory:access', requestId, memoryId: normalizedMemoryId },
        requestId,
      );
    } catch {
      // Access feedback is best-effort and must never block agent progress.
    }
  }

  async requestStepInjection(
    stepNumber: number,
    recentContext: RecentToolCallContext,
  ): Promise<StepInjection | null> {
    const requestId = randomUUID();
    const serializableContext: SerializableRecentContext = {
      toolCalls: compactAutocodeMemoryRuntimeRecentToolCalls(recentContext.toolCalls),
      injectedMemoryIds: compactAutocodeMemoryRuntimeInjectedMemoryIds(recentContext.injectedMemoryIds),
    };

    try {
      const response = await this.sendRequest<AutocodeMemoryRuntimeIpcResponse>(
        {
          type: 'memory:step-injection-request',
          requestId,
          stepNumber,
          recentContext: serializableContext,
        },
        requestId,
      );
      return response.type === 'memory:step-injection-result' ? response.injection : null;
    } catch {
      return null;
    }
  }

  private postFireAndForget(message: MemoryIpcMessage): void {
    try {
      this.port.postMessage(message);
    } catch {
      // Worker port may be closing; memory must never disrupt execution.
    }
  }

  private sendRequest<T>(message: MemoryIpcMessage, requestId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Memory IPC timeout for request ${requestId}`));
      }, IPC_TIMEOUT_MS);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutId,
      });

      try {
        this.port.postMessage(message);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleResponse(msg: AutocodeMemoryRuntimeIpcResponse): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(msg.requestId);

    if (msg.type === 'memory:error') {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg);
    }
  }
}

function compactMemoryRecordEntryForIpc(entry: MemoryRecordEntry): MemoryRecordEntry {
  return {
    ...entry,
    content: compactMemoryIpcText(
      entry.content,
      MEMORY_RECORD_IPC_CONTENT_MAX_CHARS,
      MEMORY_RECORD_IPC_CONTENT_MAX_TOKENS,
      MEMORY_RECORD_IPC_OMISSION_MARKER,
    ),
    tags: compactMemoryIpcTextList(
      entry.tags,
      MEMORY_RECORD_IPC_TAG_LIMIT,
      MEMORY_RECORD_IPC_TAG_MAX_CHARS,
      MEMORY_RECORD_IPC_TAG_MAX_TOKENS,
      MEMORY_RECORD_IPC_OMISSION_MARKER,
    ),
    relatedFiles: compactMemoryIpcPathList(
      entry.relatedFiles,
      MEMORY_RECORD_IPC_RELATED_FILE_LIMIT,
      MEMORY_RECORD_IPC_RELATED_FILE_MAX_CHARS,
      MEMORY_RECORD_IPC_RELATED_FILE_MAX_TOKENS,
    ),
    relatedModules: compactMemoryIpcTextList(
      entry.relatedModules,
      MEMORY_RECORD_IPC_RELATED_MODULE_LIMIT,
      MEMORY_RECORD_IPC_RELATED_MODULE_MAX_CHARS,
      MEMORY_RECORD_IPC_RELATED_MODULE_MAX_TOKENS,
      MEMORY_RECORD_IPC_OMISSION_MARKER,
    ),
    citationText: compactOptionalMemoryIpcText(
      entry.citationText,
      MEMORY_RECORD_IPC_CITATION_TEXT_MAX_CHARS,
      MEMORY_RECORD_IPC_CITATION_TEXT_MAX_TOKENS,
      MEMORY_RECORD_IPC_OMISSION_MARKER,
    ),
    contextPrefix: compactOptionalMemoryIpcText(
      entry.contextPrefix,
      MEMORY_RECORD_IPC_CONTEXT_PREFIX_MAX_CHARS,
      MEMORY_RECORD_IPC_CONTEXT_PREFIX_MAX_TOKENS,
      MEMORY_RECORD_IPC_OMISSION_MARKER,
    ),
  };
}

function compactMemoryIdForIpc(memoryId: string): string {
  return memoryId.replace(/\s+/g, ' ').trim().slice(0, MEMORY_ACCESS_ID_MAX_CHARS);
}

function compactMemorySearchFiltersForIpc(filters: MemorySearchFilters): MemorySearchFilters {
  const { filter: _filter, ...serializableFilters } = filters;
  return {
    ...serializableFilters,
    query: serializableFilters.query
      ? compactMemoryIpcText(
          serializableFilters.query,
          MEMORY_SEARCH_IPC_QUERY_MAX_CHARS,
          MEMORY_SEARCH_IPC_QUERY_MAX_TOKENS,
          MEMORY_SEARCH_IPC_OMISSION_MARKER,
        )
      : serializableFilters.query,
    relatedFiles: compactMemoryIpcPathList(
      serializableFilters.relatedFiles,
      MEMORY_SEARCH_IPC_RELATED_FILE_LIMIT,
      MEMORY_SEARCH_IPC_RELATED_FILE_MAX_CHARS,
      MEMORY_SEARCH_IPC_RELATED_FILE_MAX_TOKENS,
    ),
    relatedModules: compactMemoryIpcTextList(
      serializableFilters.relatedModules,
      MEMORY_SEARCH_IPC_RELATED_MODULE_LIMIT,
      MEMORY_SEARCH_IPC_RELATED_MODULE_MAX_CHARS,
      MEMORY_SEARCH_IPC_RELATED_MODULE_MAX_TOKENS,
      MEMORY_SEARCH_IPC_OMISSION_MARKER,
    ),
  };
}

function compactOptionalMemoryIpcText(
  value: string | undefined,
  maxChars: number,
  maxTokens: number,
  marker: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return compactMemoryIpcText(value, maxChars, maxTokens, marker);
}

function compactMemoryIpcText(value: string, maxChars: number, maxTokens: number, marker: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (maxChars <= 0 || maxTokens <= 0) {
    return '';
  }
  if (normalized.length <= maxChars && estimateTokens(normalized) <= maxTokens) {
    return normalized;
  }

  const charBounded = compactMemoryIpcTextByChars(normalized, maxChars, marker);
  if (estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, normalized.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = compactMemoryIpcTextByChars(normalized, midpoint, marker);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function compactMemoryIpcTextByChars(normalized: string, maxChars: number, marker: string): string {
  if (maxChars <= 0 || normalized.length <= maxChars) {
    return normalized.slice(0, Math.max(0, maxChars));
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }

  const effectiveMarker = marker.length >= maxChars - 2 ? '...' : marker;

  const budget = maxChars - effectiveMarker.length;
  const headChars = Math.ceil(budget * 0.62);
  const tailChars = Math.max(0, budget - headChars);
  return [
    normalized.slice(0, headChars).trimEnd(),
    effectiveMarker,
    tailChars > 0 ? normalized.slice(-tailChars).trimStart() : '',
  ].join('');
}

function compactMemoryIpcTextList(
  values: string[] | undefined,
  limit: number,
  maxItemChars: number,
  maxItemTokens: number,
  marker: string,
  normalize: (value: string) => string = normalizeMemoryIpcListItem,
): string[] | undefined {
  if (!values) {
    return undefined;
  }

  const itemLimit = Math.max(0, limit);
  if (itemLimit === 0) {
    return [];
  }

  const seen = new Set<string>();
  const compacted: string[] = [];
  for (const value of values) {
    const item = compactMemoryIpcText(
      normalize(value),
      maxItemChars,
      maxItemTokens,
      marker,
    );
    if (!item || seen.has(item)) {
      continue;
    }

    seen.add(item);
    compacted.push(item);
    if (compacted.length >= itemLimit) {
      break;
    }
  }

  return compacted;
}

function compactMemoryIpcPathList(
  values: string[] | undefined,
  limit: number,
  maxItemChars: number,
  maxItemTokens: number,
): string[] | undefined {
  if (!values) {
    return undefined;
  }

  const itemLimit = Math.max(0, limit);
  if (itemLimit === 0) {
    return [];
  }

  const seen = new Set<string>();
  const compacted: string[] = [];
  for (const value of values) {
    const item = compactMemoryIpcPathTailToBudget(value, maxItemChars, maxItemTokens);
    const key = item.toLowerCase();
    if (!item || seen.has(key)) {
      continue;
    }

    seen.add(key);
    compacted.push(item);
    if (compacted.length >= itemLimit) {
      break;
    }
  }

  return compacted;
}

function normalizeMemoryIpcListItem(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeMemoryIpcPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
}

function compactMemoryIpcPathTailToBudget(value: string, maxChars: number, maxTokens: number): string {
  const normalized = normalizeMemoryIpcPath(value);
  if (maxChars <= 0 || maxTokens <= 0) {
    return '';
  }

  const charBounded = truncateMemoryIpcPathTail(normalized, maxChars);
  if (estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, normalized.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = truncateMemoryIpcPathTail(normalized, midpoint);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function truncateMemoryIpcPathTail(path: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (path.length <= maxChars) {
    return path;
  }
  return path.slice(-maxChars).replace(/^\/+/, '');
}
