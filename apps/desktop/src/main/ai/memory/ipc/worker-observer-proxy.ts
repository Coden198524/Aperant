/**
 * WorkerObserverProxy
 *
 * Lives in the worker thread and proxies memory operations to the main thread.
 * Synchronous observation events are fire-and-forget; search, record, and
 * step injection use request/response IPC with a short timeout.
 */

import { MessagePort } from 'worker_threads';
import { randomUUID } from 'crypto';
import type {
  AutocodeMemoryRuntimeIpcResponse,
  AutocodeMemoryRuntimeObservationIpcRequest,
  AutocodeMemoryRuntimeSerializableRecentContext,
  AutocodeMemoryRuntimeToolIpcRequest,
  Memory,
  MemoryRecordEntry,
  MemorySearchFilters,
} from '@autocode/core';
import type { RecentToolCallContext, StepInjection } from '../injection/step-injection-decider';

const IPC_TIMEOUT_MS = 3_000;

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
      args,
      stepNumber,
    });
  }

  onToolResult(toolName: string, result: unknown, stepNumber: number): void {
    this.postFireAndForget({
      type: 'memory:tool-result',
      toolName,
      result,
      stepNumber,
    });
  }

  onReasoning(text: string, stepNumber: number): void {
    this.postFireAndForget({
      type: 'memory:reasoning',
      text,
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
        { type: 'memory:search', requestId, filters },
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
        { type: 'memory:record', requestId, entry },
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
      toolCalls: recentContext.toolCalls,
      injectedMemoryIds: [...recentContext.injectedMemoryIds],
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
