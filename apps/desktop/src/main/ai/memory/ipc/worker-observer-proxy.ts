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

const IPC_TIMEOUT_MS = 3_000;
const MEMORY_SEARCH_IPC_QUERY_MAX_CHARS = 800;
const MEMORY_SEARCH_IPC_RELATED_FILE_LIMIT = 16;
const MEMORY_SEARCH_IPC_RELATED_FILE_MAX_CHARS = 180;
const MEMORY_SEARCH_IPC_RELATED_MODULE_LIMIT = 12;
const MEMORY_SEARCH_IPC_RELATED_MODULE_MAX_CHARS = 96;
const MEMORY_SEARCH_IPC_OMISSION_MARKER = ' ... [memory search middle omitted before IPC] ... ';
const MEMORY_RECORD_IPC_CONTENT_MAX_CHARS = 2_000;
const MEMORY_RECORD_IPC_CITATION_TEXT_MAX_CHARS = 1_000;
const MEMORY_RECORD_IPC_CONTEXT_PREFIX_MAX_CHARS = 600;
const MEMORY_RECORD_IPC_TAG_LIMIT = 20;
const MEMORY_RECORD_IPC_TAG_MAX_CHARS = 64;
const MEMORY_RECORD_IPC_RELATED_FILE_LIMIT = 24;
const MEMORY_RECORD_IPC_RELATED_FILE_MAX_CHARS = 220;
const MEMORY_RECORD_IPC_RELATED_MODULE_LIMIT = 16;
const MEMORY_RECORD_IPC_RELATED_MODULE_MAX_CHARS = 96;
const MEMORY_RECORD_IPC_OMISSION_MARKER = ' ... [memory record middle omitted before IPC] ... ';

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
      MEMORY_RECORD_IPC_OMISSION_MARKER,
    ),
    tags: compactMemoryIpcList(entry.tags, MEMORY_RECORD_IPC_TAG_LIMIT, MEMORY_RECORD_IPC_TAG_MAX_CHARS),
    relatedFiles: compactMemoryIpcPathList(
      entry.relatedFiles,
      MEMORY_RECORD_IPC_RELATED_FILE_LIMIT,
      MEMORY_RECORD_IPC_RELATED_FILE_MAX_CHARS,
    ),
    relatedModules: compactMemoryIpcList(
      entry.relatedModules,
      MEMORY_RECORD_IPC_RELATED_MODULE_LIMIT,
      MEMORY_RECORD_IPC_RELATED_MODULE_MAX_CHARS,
    ),
    citationText: compactOptionalMemoryIpcText(
      entry.citationText,
      MEMORY_RECORD_IPC_CITATION_TEXT_MAX_CHARS,
      MEMORY_RECORD_IPC_OMISSION_MARKER,
    ),
    contextPrefix: compactOptionalMemoryIpcText(
      entry.contextPrefix,
      MEMORY_RECORD_IPC_CONTEXT_PREFIX_MAX_CHARS,
      MEMORY_RECORD_IPC_OMISSION_MARKER,
    ),
  };
}

function compactMemorySearchFiltersForIpc(filters: MemorySearchFilters): MemorySearchFilters {
  const { filter: _filter, ...serializableFilters } = filters;
  return {
    ...serializableFilters,
    query: serializableFilters.query
      ? compactMemoryIpcText(
          serializableFilters.query,
          MEMORY_SEARCH_IPC_QUERY_MAX_CHARS,
          MEMORY_SEARCH_IPC_OMISSION_MARKER,
        )
      : serializableFilters.query,
    relatedFiles: compactMemoryIpcList(
      serializableFilters.relatedFiles,
      MEMORY_SEARCH_IPC_RELATED_FILE_LIMIT,
      MEMORY_SEARCH_IPC_RELATED_FILE_MAX_CHARS,
      normalizeMemoryIpcPath,
    ),
    relatedModules: compactMemoryIpcList(
      serializableFilters.relatedModules,
      MEMORY_SEARCH_IPC_RELATED_MODULE_LIMIT,
      MEMORY_SEARCH_IPC_RELATED_MODULE_MAX_CHARS,
    ),
  };
}

function compactOptionalMemoryIpcText(
  value: string | undefined,
  maxChars: number,
  marker: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return compactMemoryIpcText(value, maxChars, marker);
}

function compactMemoryIpcText(value: string, maxChars: number, marker: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (maxChars <= 0 || normalized.length <= maxChars) {
    return normalized;
  }

  if (marker.length >= maxChars - 2) {
    return normalized.slice(0, maxChars);
  }

  const budget = maxChars - marker.length;
  const headChars = Math.ceil(budget * 0.62);
  const tailChars = Math.max(0, budget - headChars);
  return [
    normalized.slice(0, headChars).trimEnd(),
    marker,
    tailChars > 0 ? normalized.slice(-tailChars).trimStart() : '',
  ].join('');
}

function compactMemoryIpcList(
  values: string[] | undefined,
  limit: number,
  maxItemChars: number,
  normalize: (value: string) => string = normalizeMemoryIpcListItem,
): string[] | undefined {
  if (!values) {
    return undefined;
  }

  const compacted = values
    .map((value) => compactMemoryIpcListItem(normalize(value), maxItemChars))
    .filter(Boolean);

  return Array.from(new Set(compacted)).slice(0, Math.max(0, limit));
}

function compactMemoryIpcPathList(
  values: string[] | undefined,
  limit: number,
  maxItemChars: number,
): string[] | undefined {
  return compactMemoryIpcList(values, limit, maxItemChars, normalizeMemoryIpcPath);
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

function compactMemoryIpcListItem(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (maxChars <= 0 || normalized.length <= maxChars) {
    return normalized;
  }

  const marker = '...[omitted]...';
  const budget = maxChars - marker.length;
  if (budget <= 0) {
    return normalized.slice(0, maxChars);
  }

  const headChars = Math.ceil(budget * 0.6);
  const tailChars = Math.max(0, budget - headChars);
  return `${normalized.slice(0, headChars).trimEnd()}${marker}${normalized.slice(-tailChars).trimStart()}`;
}
