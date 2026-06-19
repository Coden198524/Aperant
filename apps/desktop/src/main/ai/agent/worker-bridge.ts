/**
 * Worker Bridge
 * =============
 *
 * Main-thread bridge that spawns a Worker thread and relays `postMessage()`
 * events to an EventEmitter matching the `AgentManagerEvents` interface.
 *
 * This allows the existing agent management system (agent-process.ts,
 * agent-events.ts) to consume worker thread events transparently — the UI
 * cannot distinguish between a Python subprocess and a TS worker thread.
 */

import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { app } from 'electron';
import {
  repairAutocodeChineseMojibakeText,
  toAutocodeMemoryRuntimeRecentContext,
  type AutocodeMemoryRuntimeIpcResponse,
} from '@autocode/core';
import { foldRepeatedAutocodePromptLines } from '@autocode/core/runtime/prompt-context';

import type { AgentManagerEvents, ExecutionProgressData, ProcessType } from '../../agent/types';
import type { TaskEventPayload } from '../../agent/task-event-schema';
import type { TaskLogPhase, TaskLogStreamChunk, TokenUsage } from '../../../shared/types';
import type {
  WorkerConfig,
  WorkerMessage,
  AgentExecutorConfig,
} from './types';
import type { SessionResult } from '../session/types';
import { ProgressTracker } from '../session/progress-tracker';
import { MemoryObserver } from '../memory/observer';
import { StepInjectionDecider } from '../memory/injection';
import { stripLowValueMemoryLines } from '../memory/outcome-content';
import type { Memory, MemoryIpcRequest, MemoryCandidate, SessionOutcome, SessionType } from '../memory/types';
import type { MemoryToolIpcRequest, MemoryIpcMessage } from '../memory/ipc/worker-observer-proxy';
import { estimateTokens } from '../memory/retrieval/context-packer';
import { debugLog } from '../../../shared/utils/debug-logger';

const MEMORY_SEARCH_RESPONSE_CONTENT_MAX_CHARS = 900;
const MEMORY_SEARCH_RESPONSE_CONTENT_MAX_TOKENS = 225;
const MEMORY_SEARCH_RESPONSE_TEXT_MAX_CHARS = 300;
const MEMORY_SEARCH_RESPONSE_TEXT_MAX_TOKENS = 75;
const MEMORY_SEARCH_RESPONSE_METHODOLOGY_MAX_CHARS = 96;
const MEMORY_SEARCH_RESPONSE_METHODOLOGY_MAX_TOKENS = 24;
const MEMORY_SEARCH_RESPONSE_MEMORY_LIMIT = 12;
const MEMORY_SEARCH_RESPONSE_TAG_LIMIT = 12;
const MEMORY_SEARCH_RESPONSE_TAG_MAX_CHARS = 64;
const MEMORY_SEARCH_RESPONSE_TAG_MAX_TOKENS = 24;
const MEMORY_SEARCH_RESPONSE_FILE_LIMIT = 12;
const MEMORY_SEARCH_RESPONSE_FILE_MAX_CHARS = 180;
const MEMORY_SEARCH_RESPONSE_FILE_MAX_TOKENS = 48;
const MEMORY_SEARCH_RESPONSE_MODULE_LIMIT = 10;
const MEMORY_SEARCH_RESPONSE_MODULE_MAX_CHARS = 96;
const MEMORY_SEARCH_RESPONSE_MODULE_MAX_TOKENS = 32;
const MEMORY_SEARCH_RESPONSE_ID_LIST_LIMIT = 12;
const MEMORY_SEARCH_RESPONSE_ID_MAX_CHARS = 80;
const MEMORY_SEARCH_RESPONSE_ID_MAX_TOKENS = 24;
const MEMORY_SEARCH_RESPONSE_RELATION_LIMIT = 8;
const MEMORY_SEARCH_RESPONSE_OMISSION_MARKER = ' ... [memory response middle omitted before IPC] ... ';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Worker Path Resolution
// =============================================================================

/**
 * Resolve the path to the worker entry point.
 * Handles both dev (source via electron-vite) and production (bundled) paths.
 */
function resolveWorkerPath(): string {
  if (app.isPackaged) {
    // Production: worker is inside app.asar at out/main/ai/agent/worker.js
    return path.join(process.resourcesPath, 'app.asar', 'out', 'main', 'ai', 'agent', 'worker.js');
  }
  // Dev: electron-vite outputs worker at out/main/ai/agent/worker.js
  // because the Rollup input key is 'ai/agent/worker'.
  // __dirname resolves to out/main/ at runtime, so we need the subdirectory.
  return path.join(__dirname, 'ai', 'agent', 'worker.js');
}

// =============================================================================
// WorkerBridge
// =============================================================================

/**
 * Bridges a worker thread to the AgentManagerEvents interface.
 *
 * Usage:
 * ```ts
 * const bridge = new WorkerBridge();
 * bridge.on('log', (taskId, log) => { ... });
 * bridge.on('exit', (taskId, code, processType) => { ... });
 * await bridge.spawn(config);
 * ```
 */
export class WorkerBridge extends EventEmitter {
  private worker: Worker | null = null;
  private progressTracker: ProgressTracker = new ProgressTracker();
  private taskId: string = '';
  private projectId: string | undefined;
  private processType: ProcessType = 'task-execution';
  private executionProgressSequence = 0;
  private lastTokenUsage: TokenUsage | null = null;
  private historicalTokenUsage: TokenUsage | null = null; // Baseline from previous sessions
  private activeTokenUsageSessionId: string | undefined;
  private tokenUsageSessionBaseline: TokenUsage | null = null;
  private memoryObserver: MemoryObserver | null = null;
  private memorySessionType: SessionType = 'build';

  /**
   * Spawn a worker thread with the given configuration.
   * The worker will immediately begin executing the agent session.
   *
   * @param config - Executor configuration (task ID, session params, etc.)
   * @param initialTokenUsage - Optional initial token usage from previous sessions (restored from plan file)
   */
  spawn(config: AgentExecutorConfig, initialTokenUsage?: TokenUsage | null): void {
    if (this.worker) {
      throw new Error('WorkerBridge already has an active worker. Call terminate() first.');
    }

    this.taskId = config.taskId;
    this.projectId = config.projectId;
    this.processType = config.processType;
    this.progressTracker = new ProgressTracker();
    this.executionProgressSequence = 0;
    this.memorySessionType = resolveMemorySessionType(config.processType);
    this.memoryObserver = shouldEnableWorkerMemory(config)
      ? new MemoryObserver(config.taskId, this.memorySessionType, config.projectId || config.taskId)
      : null;

    // Initialize with historical token usage if provided (for task resume scenarios)
    // Store as both baseline and last usage
    this.historicalTokenUsage = initialTokenUsage ?? null;
    this.lastTokenUsage = initialTokenUsage ?? null;
    this.activeTokenUsageSessionId = undefined;
    this.tokenUsageSessionBaseline = null;

    const workerConfig: WorkerConfig = {
      taskId: config.taskId,
      projectId: config.projectId,
      processType: config.processType,
      session: config.session,
    };

    const workerPath = resolveWorkerPath();

    this.worker = new Worker(workerPath, {
      workerData: workerConfig,
    });

    this.worker.on('online', () => {
      const message = `Worker thread online: ${path.basename(workerPath)}`;
      console.log(`[WorkerBridge:${this.taskId}] ${message}`);
      this.emitTyped('log', this.taskId, message, this.projectId);
    });

    this.worker.on('message', (message: WorkerMessage | MemoryIpcMessage) => {
      this.handleWorkerMessage(message);
    });

    this.worker.on('messageerror', (error: Error) => {
      console.error(`[WorkerBridge:${this.taskId}] Worker message error:`, error);
      this.emitTyped('error', this.taskId, `Worker message error: ${error.message}`, this.projectId);
    });

    this.worker.on('error', (error: Error) => {
      console.error(`[WorkerBridge:${this.taskId}] Worker error:`, error);
      this.emitTyped('error', this.taskId, error.message, this.projectId);
      this.cleanup();
    });

    this.worker.on('exit', (code: number) => {
      console.log(`[WorkerBridge:${this.taskId}] Worker exited with code ${code}`);
      // Code 0 = clean exit; non-zero = crash/error
      // Only emit exit if we haven't already emitted from a 'result' message
      if (this.worker) {
        this.emitTyped('exit', this.taskId, code === 0 ? 0 : code, this.processType, this.projectId);
        this.cleanup();
      }
    });
  }

  /**
   * Terminate the worker thread.
   * Sends an abort message first for graceful shutdown, then terminates.
   */
  async terminate(): Promise<void> {
    if (!this.worker) return;

    // Try graceful abort first
    try {
      this.worker.postMessage({ type: 'abort' });
    } catch {
      // Worker may already be dead
    }

    // Force terminate after a short grace period
    const worker = this.worker;
    this.cleanup();

    try {
      await worker.terminate();
    } catch {
      // Already terminated
    }
  }

  /** Whether the worker is currently active */
  get isActive(): boolean {
    return this.worker !== null;
  }

  /** Get the underlying Worker instance (for advanced use) */
  get workerInstance(): Worker | null {
    return this.worker;
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private handleWorkerMessage(message: WorkerMessage | MemoryIpcMessage): void {
    if (isMemoryIpcMessage(message)) {
      this.handleMemoryMessage(message);
      return;
    }

    switch (message.type) {
      case 'log':
        this.emitTyped('log', message.taskId, message.data, message.projectId);
        break;

      case 'error':
        this.emitTyped('error', message.taskId, message.data, message.projectId);
        break;

      case 'execution-progress':
        this.emitExecutionProgress(message.taskId, message.data, message.projectId);
        break;

      case 'stream-event':
        if (message.data.type === 'text-delta') {
          this.emitTaskLogStreamTextDelta(message);
          break;
        }
        if (message.data.type === 'tool-call' || message.data.type === 'tool-result' || message.data.type === 'error') {
          this.emitTaskLogStreamEvent(message);
        }

        // Feed the progress tracker and emit progress updates
        this.progressTracker.processEvent(message.data);
        this.emitProgressFromTracker(message.taskId, message.projectId);
        if (message.data.type === 'usage-update') {
          debugLog('[worker-bridge] Received usage-update, before merge:', {
            lastTokenUsage: this.lastTokenUsage,
            historicalTokenUsage: this.historicalTokenUsage,
            incomingUsage: message.data.usage,
          });
          this.lastTokenUsage = this.mergeIncomingTokenUsage(message.data.usage);
          debugLog('[worker-bridge] After merge:', this.lastTokenUsage);
          this.emitTyped('task-token-usage', message.taskId, this.lastTokenUsage, message.projectId);
        }
        break;

      case 'task-event':
        this.emitTyped('task-event', message.taskId, message.data as TaskEventPayload, message.projectId);
        break;

      case 'task-token-usage':
        debugLog('[worker-bridge] Received task-token-usage, before merge:', {
          lastTokenUsage: this.lastTokenUsage,
          historicalTokenUsage: this.historicalTokenUsage,
          incomingUsage: message.data,
        });
        this.lastTokenUsage = this.mergeIncomingTokenUsage(message.data, { authoritativeSnapshot: true });
        debugLog('[worker-bridge] After merge:', this.lastTokenUsage);
        this.emitTyped('task-token-usage', message.taskId, this.lastTokenUsage, message.projectId);
        break;

      case 'result':
        this.handleResult(message.taskId, message.data, message.projectId);
        break;
    }
  }

  private handleMemoryMessage(message: MemoryIpcMessage): void {
    if (isMemoryObservationMessage(message)) {
      this.memoryObserver?.observe(message);
      return;
    }

    if (message.type === 'memory:step-injection-request') {
      this.handleMemoryStepInjection(message);
      return;
    }

    if (message.type === 'memory:search') {
      this.handleMemorySearch(message);
      return;
    }

    if (message.type === 'memory:record') {
      this.handleMemoryRecord(message);
      return;
    }

    if (message.type === 'memory:access') {
      this.handleMemoryAccess(message);
    }
  }

  private handleMemorySearch(message: Extract<MemoryToolIpcRequest, { type: 'memory:search' }>): void {
    getMemoryServiceLazy()
      .then((service) => service.search(message.filters))
      .then((memories) => {
        this.postMemoryResponse({
          type: 'memory:search-result',
          requestId: message.requestId,
          memories: compactMemorySearchResponseMemories(memories, message.filters.limit),
        });
      })
      .catch((error) => {
        this.postMemoryResponse({
          type: 'memory:error',
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private handleMemoryRecord(message: Extract<MemoryToolIpcRequest, { type: 'memory:record' }>): void {
    getMemoryServiceLazy()
      .then((service) => service.store(message.entry))
      .then((id) => {
        this.postMemoryResponse({
          type: 'memory:stored',
          requestId: message.requestId,
          id,
        });
      })
      .catch((error) => {
        this.postMemoryResponse({
          type: 'memory:error',
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private handleMemoryAccess(message: Extract<MemoryToolIpcRequest, { type: 'memory:access' }>): void {
    getMemoryServiceLazy()
      .then((service) => service.updateAccessCount(message.memoryId))
      .then(() => {
        this.postMemoryResponse({
          type: 'memory:accessed',
          requestId: message.requestId,
        });
      })
      .catch((error) => {
        this.postMemoryResponse({
          type: 'memory:error',
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private handleMemoryStepInjection(
    message: Extract<MemoryToolIpcRequest, { type: 'memory:step-injection-request' }>,
  ): void {
    const observer = this.memoryObserver;
    const projectId = this.projectId || this.taskId;
    if (!observer || !projectId) {
      this.postMemoryResponse({
        type: 'memory:step-injection-result',
        requestId: message.requestId,
        injection: null,
      });
      return;
    }

    getMemoryServiceLazy()
      .then((service) => {
        const decider = new StepInjectionDecider(service, observer.getScratchpad(), projectId);
        return decider.decide(
          message.stepNumber,
          toAutocodeMemoryRuntimeRecentContext(message.recentContext),
        );
      })
      .then((injection) => {
        this.postMemoryResponse({
          type: 'memory:step-injection-result',
          requestId: message.requestId,
          injection,
        });
      })
      .catch((error) => {
        this.postMemoryResponse({
          type: 'memory:error',
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private postMemoryResponse(response: AutocodeMemoryRuntimeIpcResponse): void {
    try {
      this.worker?.postMessage(response);
    } catch {
      // Worker may already be exiting; memory must not affect task completion.
    }
  }

  private emitTaskLogStreamTextDelta(message: WorkerMessage & { type: 'stream-event' }): void {
    if (message.data.type !== 'text-delta' || !message.data.text) return;

    const model = this.resolveStreamModel(message);
    const chunk: TaskLogStreamChunk = {
      type: 'text',
      content: repairAutocodeChineseMojibakeText(message.data.text),
      phase: message.phase ?? this.resolveCurrentLogPhase(),
      timestamp: new Date().toISOString(),
      ...(model ? { model } : {}),
      ...(message.subtaskId ? { subtask_id: message.subtaskId } : {}),
      ...(message.sessionNumber ? { session: message.sessionNumber } : {}),
      source: 'sdk',
    };

    this.emitTyped('task-log-stream', message.taskId, chunk, message.projectId);
  }

  private emitTaskLogStreamEvent(message: WorkerMessage & { type: 'stream-event' }): void {
    const phase = message.phase ?? this.resolveCurrentLogPhase();
    const timestamp = new Date().toISOString();
    const model = this.resolveStreamModel(message);

    if (message.data.type === 'tool-call') {
      const toolInput = this.extractToolInput(message.data.args);
      const chunk: TaskLogStreamChunk = {
        type: 'tool_start',
        content: repairAutocodeChineseMojibakeText(`[${message.data.toolName}] ${toolInput ?? ''}`.trim()),
        phase,
        timestamp,
        ...(model ? { model } : {}),
        tool: {
          name: message.data.toolName,
          input: toolInput ? repairAutocodeChineseMojibakeText(toolInput) : toolInput,
        },
        tool_call_id: message.data.toolCallId,
        ...(message.subtaskId ? { subtask_id: message.subtaskId } : {}),
        ...(message.sessionNumber ? { session: message.sessionNumber } : {}),
        source: 'sdk',
      };
      this.emitTyped('task-log-stream', message.taskId, chunk, message.projectId);
      return;
    }

    if (message.data.type === 'tool-result') {
      const chunk: TaskLogStreamChunk = {
        type: 'tool_end',
        content: `[${message.data.toolName}] ${message.data.isError ? 'Error' : 'Done'}`,
        phase,
        timestamp,
        ...(model ? { model } : {}),
        tool: {
          name: message.data.toolName,
          success: !message.data.isError,
        },
        tool_call_id: message.data.toolCallId,
        ...(message.subtaskId ? { subtask_id: message.subtaskId } : {}),
        ...(message.sessionNumber ? { session: message.sessionNumber } : {}),
        source: 'sdk',
      };
      this.emitTyped('task-log-stream', message.taskId, chunk, message.projectId);
      return;
    }

    if (message.data.type === 'error') {
      const chunk: TaskLogStreamChunk = {
        type: 'error',
        content: repairAutocodeChineseMojibakeText(message.data.error.message),
        phase,
        timestamp,
        ...(model ? { model } : {}),
        ...(message.subtaskId ? { subtask_id: message.subtaskId } : {}),
        ...(message.sessionNumber ? { session: message.sessionNumber } : {}),
        source: 'sdk',
      };
      this.emitTyped('task-log-stream', message.taskId, chunk, message.projectId);
    }
  }

  private resolveStreamModel(message: WorkerMessage & { type: 'stream-event' }): NonNullable<TaskLogStreamChunk['model']> | undefined {
    if (!message.provider && !message.modelId) {
      return undefined;
    }

    return {
      ...(message.provider ? { provider: message.provider } : {}),
      ...(message.modelId ? { modelId: message.modelId } : {}),
    };
  }

  private extractToolInput(args: Record<string, unknown>): string | undefined {
    const value = args.file_path ?? args.path ?? args.command ?? args.query ?? args.pattern;
    if (typeof value !== 'string') return undefined;
    return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  }

  private resolveCurrentLogPhase(): TaskLogPhase {
    const phase = this.progressTracker.state.currentPhase;
    switch (phase) {
      case 'planning':
        return 'planning';
      case 'qa_review':
      case 'qa_fixing':
      case 'complete':
      case 'failed':
        return 'validation';
      default:
        return 'coding';
    }
  }

  /**
   * Convert ProgressTracker state into an ExecutionProgressData event
   * and emit it to listeners.
   */
  private emitProgressFromTracker(taskId: string, projectId?: string): void {
    const state = this.progressTracker.state;
    const progressData: ExecutionProgressData = {
      phase: state.currentPhase,
      phaseProgress: 0, // Detailed progress calculated by UI from phase
      overallProgress: 0,
      currentSubtask: state.currentSubtask ?? undefined,
      message: state.currentMessage,
      completedPhases: state.completedPhases as ExecutionProgressData['completedPhases'],
    };
    this.emitExecutionProgress(taskId, progressData, projectId);
  }

  /**
   * Handle the final session result from the worker.
   * Maps SessionResult.outcome to an exit code.
   */
  private handleResult(taskId: string, result: SessionResult, projectId?: string): void {
    // Map outcome to exit code
    const exitCode = result.outcome === 'completed' || result.outcome === 'max_steps' || result.outcome === 'context_window' ? 0 : 1;

    // Merge stepsExecuted into usage for frontend display
    const shouldAttachResultSteps = shouldUseResultStepsForTokenUsage(result.usage);
    const usageWithSteps: TokenUsage = this.mergeIncomingTokenUsage({
      ...result.usage,
      ...(shouldAttachResultSteps ? { stepsExecuted: result.stepsExecuted } : {}),
    }, { authoritativeSnapshot: true });
    this.lastTokenUsage = usageWithSteps;

    this.emitTyped('task-token-usage', taskId, usageWithSteps, projectId);

    // Log the result summary
    const summary = `Session complete: outcome=${result.outcome}, steps=${result.stepsExecuted}, tools=${result.toolCallCount}, duration=${result.durationMs}ms`;
    this.emitTyped('log', taskId, summary, projectId);

    if (result.error) {
      this.emitTyped('error', taskId, result.error.message, projectId);
    }

    this.finalizeMemoryObserver(result, projectId);

    // Emit exit and cleanup
    this.emitTyped('exit', taskId, exitCode, this.processType, projectId);
    this.cleanup();
  }

  private finalizeMemoryObserver(result: SessionResult, projectId?: string): void {
    const observer = this.memoryObserver;
    const memoryTaskId = this.taskId;
    const memorySessionType = this.memorySessionType;
    const memoryProjectId = projectId || this.projectId || this.taskId;
    if (!observer || !memoryProjectId) {
      return;
    }

    const outcome = mapSessionResultToMemoryOutcome(result);
    observer.finalize(outcome)
      .then((candidates) =>
        this.storeMemoryCandidates(candidates, {
          projectId: memoryProjectId,
          taskId: memoryTaskId,
          sessionType: memorySessionType,
        }))
      .catch((error) => {
        console.warn(`[WorkerBridge:${memoryTaskId}] Memory finalize failed:`, error);
      });
  }

  private async storeMemoryCandidates(
    candidates: MemoryCandidate[],
    context: { projectId: string; taskId: string; sessionType: SessionType },
  ): Promise<void> {
    if (candidates.length === 0) {
      return;
    }

    try {
      const service = await getMemoryServiceLazy();
      const results = await Promise.allSettled(
        candidates.map((candidate) => service.store({
          type: candidate.proposedType,
          content: candidate.content,
          confidence: candidate.confidence,
          tags: buildMemoryCandidateTags(candidate, context.sessionType),
          relatedFiles: candidate.relatedFiles,
          relatedModules: candidate.relatedModules,
          source: 'observer_inferred',
          scope: candidate.relatedFiles.length > 0 ? 'module' : 'session',
          projectId: context.projectId,
          sessionId: context.taskId,
          needsReview: candidate.needsReview ?? candidate.trustFlags?.contaminated ?? false,
        })),
      );
      const storedCount = results.filter((result) => result.status === 'fulfilled').length;
      const failedCount = results.length - storedCount;
      if (storedCount > 0) {
        this.emitTyped(
          'log',
          context.taskId,
          `Memory learned: ${storedCount} candidate(s) stored`,
          context.projectId,
        );
      }
      if (failedCount > 0) {
        console.warn(
          `[WorkerBridge:${context.taskId}] Failed to store ${failedCount} memory candidate(s)`,
        );
      }
    } catch (error) {
      console.warn(`[WorkerBridge:${context.taskId}] Failed to store memory candidates:`, error);
    }
  }

  private emitExecutionProgress(taskId: string, progress: ExecutionProgressData, projectId?: string): void {
    if (progress.phase) {
      this.progressTracker.forcePhase(
        progress.phase,
        progress.message ?? this.progressTracker.state.currentMessage,
        progress.currentSubtask,
      );
    }

    const nextSequence =
      progress.sequenceNumber && progress.sequenceNumber > 0
        ? progress.sequenceNumber
        : this.executionProgressSequence + 1;

    this.executionProgressSequence = Math.max(this.executionProgressSequence, nextSequence);
    this.emitTyped('execution-progress', taskId, {
      ...progress,
      sequenceNumber: nextSequence,
    }, projectId);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Type-safe emit that matches AgentManagerEvents signatures.
   */
  private emitTyped<K extends keyof AgentManagerEvents>(
    event: K,
    ...args: Parameters<AgentManagerEvents[K]>
  ): void {
    this.emit(event, ...args);
  }

  private cleanup(): void {
    this.worker = null;
    this.lastTokenUsage = null;
    this.activeTokenUsageSessionId = undefined;
    this.tokenUsageSessionBaseline = null;
    this.memoryObserver = null;
  }

  private mergeIncomingTokenUsage(
    incoming: TokenUsage,
    options: { authoritativeSnapshot?: boolean } = {},
  ): TokenUsage {
    if (!incoming.sessionId) {
      return options.authoritativeSnapshot
        ? authoritativeTokenUsageSnapshot(this.lastTokenUsage, incoming)
        : maxTokenUsage(this.lastTokenUsage, incoming);
    }

    if (this.activeTokenUsageSessionId !== incoming.sessionId) {
      const previousTotal = this.lastTokenUsage;
      this.activeTokenUsageSessionId = incoming.sessionId;
      this.tokenUsageSessionBaseline = previousTotal?.sessionId === incoming.sessionId
        ? null
        : previousTotal;
    }

    const cumulativeForSession = addTokenUsage(this.tokenUsageSessionBaseline, incoming);
    return options.authoritativeSnapshot
      ? authoritativeTokenUsageSnapshot(this.lastTokenUsage, cumulativeForSession)
      : maxTokenUsage(this.lastTokenUsage, cumulativeForSession);
  }
}

function shouldEnableWorkerMemory(config: AgentExecutorConfig): boolean {
  const envToggle = config.session.mcpOptions?.mcpEnv?.GRAPHITI_ENABLED;
  return envToggle?.toLowerCase() !== 'false';
}

function resolveMemorySessionType(processType: ProcessType): SessionType {
  switch (processType) {
    case 'spec-creation':
      return 'spec_creation';
    case 'task-execution':
    case 'qa-process':
      return 'build';
    default:
      return 'build';
  }
}

function mapSessionResultToMemoryOutcome(result: SessionResult): SessionOutcome {
  switch (result.outcome) {
    case 'completed':
      return 'success';
    case 'max_steps':
    case 'context_window':
      return 'partial';
    case 'cancelled':
      return 'abandoned';
    default:
      return 'failure';
  }
}

function compactMemorySearchResponseMemories(memories: Memory[], requestedLimit?: number): Memory[] {
  const byKey = new Map<string, RankedMemorySearchResponseMemory>();
  memories.forEach((memory, rank) => {
    const compactMemory = compactMemorySearchResponseMemory(memory);
    const key = getMemorySearchResponseMemoryDedupeKey(compactMemory);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        memory: compactMemory,
        rank,
      });
      return;
    }

    const preferredMemory = isHigherPriorityMemorySearchResponseMemory(compactMemory, existing.memory)
      ? compactMemory
      : existing.memory;
    const secondaryMemory = preferredMemory === compactMemory ? existing.memory : compactMemory;
    byKey.set(key, {
      memory: mergeDuplicateMemorySearchResponseMemory(preferredMemory, secondaryMemory),
      rank: existing.rank,
    });
  });

  return [...byKey.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, normalizeMemorySearchResponseMemoryLimit(requestedLimit))
    .map((item) => item.memory);
}

function normalizeMemorySearchResponseMemoryLimit(requestedLimit: number | undefined): number {
  if (requestedLimit === undefined) {
    return MEMORY_SEARCH_RESPONSE_MEMORY_LIMIT;
  }
  if (!Number.isFinite(requestedLimit)) {
    return 0;
  }
  return Math.min(
    Math.max(0, Math.floor(requestedLimit)),
    MEMORY_SEARCH_RESPONSE_MEMORY_LIMIT,
  );
}

function compactMemorySearchResponseMemory(memory: Memory): Memory {
  return {
    ...memory,
    content: compactMemorySearchResponseText(
      formatMemorySearchResponseContentForIpc(memory),
      MEMORY_SEARCH_RESPONSE_CONTENT_MAX_CHARS,
      MEMORY_SEARCH_RESPONSE_CONTENT_MAX_TOKENS,
    ),
    tags: compactMemorySearchResponseTextList(
      memory.tags,
      MEMORY_SEARCH_RESPONSE_TAG_LIMIT,
      MEMORY_SEARCH_RESPONSE_TAG_MAX_CHARS,
      MEMORY_SEARCH_RESPONSE_TAG_MAX_TOKENS,
      { normalizedKey: true },
    ) ?? [],
    relatedFiles: compactMemorySearchResponsePathList(
      memory.relatedFiles,
      MEMORY_SEARCH_RESPONSE_FILE_LIMIT,
      MEMORY_SEARCH_RESPONSE_FILE_MAX_CHARS,
      MEMORY_SEARCH_RESPONSE_FILE_MAX_TOKENS,
    ) ?? [],
    relatedModules: compactMemorySearchResponseTextList(
      memory.relatedModules,
      MEMORY_SEARCH_RESPONSE_MODULE_LIMIT,
      MEMORY_SEARCH_RESPONSE_MODULE_MAX_CHARS,
      MEMORY_SEARCH_RESPONSE_MODULE_MAX_TOKENS,
      { normalizedKey: true },
    ) ?? [],
    provenanceSessionIds: compactMemorySearchResponseTextList(
      memory.provenanceSessionIds,
      MEMORY_SEARCH_RESPONSE_ID_LIST_LIMIT,
      MEMORY_SEARCH_RESPONSE_ID_MAX_CHARS,
      MEMORY_SEARCH_RESPONSE_ID_MAX_TOKENS,
    ) ?? [],
    impactedNodeIds: compactMemorySearchResponseTextList(
      memory.impactedNodeIds,
      MEMORY_SEARCH_RESPONSE_ID_LIST_LIMIT,
      MEMORY_SEARCH_RESPONSE_ID_MAX_CHARS,
      MEMORY_SEARCH_RESPONSE_ID_MAX_TOKENS,
    ),
    citationText: compactOptionalMemorySearchResponseText(memory.citationText),
    contextPrefix: compactOptionalMemorySearchResponseText(memory.contextPrefix),
    methodology: compactOptionalMemorySearchResponseMethodology(memory.methodology),
    workUnitRef: memory.workUnitRef
      ? {
          ...memory.workUnitRef,
          methodology: compactMemorySearchResponseText(
            memory.workUnitRef.methodology,
            MEMORY_SEARCH_RESPONSE_METHODOLOGY_MAX_CHARS,
            MEMORY_SEARCH_RESPONSE_METHODOLOGY_MAX_TOKENS,
          ),
          label: compactMemorySearchResponseText(
            memory.workUnitRef.label,
            MEMORY_SEARCH_RESPONSE_TEXT_MAX_CHARS,
            MEMORY_SEARCH_RESPONSE_TEXT_MAX_TOKENS,
          ),
          hierarchy: compactMemorySearchResponseTextList(
            memory.workUnitRef.hierarchy,
            MEMORY_SEARCH_RESPONSE_ID_LIST_LIMIT,
            MEMORY_SEARCH_RESPONSE_ID_MAX_CHARS,
            MEMORY_SEARCH_RESPONSE_ID_MAX_TOKENS,
            { normalizedKey: true },
          ) ?? [],
        }
      : undefined,
    relations: compactMemorySearchResponseRelations(memory.relations),
  };
}

function formatMemorySearchResponseContentForIpc(memory: Memory): string {
  return memory.type === 'context_cost'
    ? memory.content
    : stripLowValueMemoryLines(memory.content);
}

function mergeDuplicateMemorySearchResponseMemory(primary: Memory, secondary: Memory): Memory {
  return {
    ...primary,
    tags: compactMemorySearchResponseTextList(
      [...primary.tags, ...secondary.tags],
      MEMORY_SEARCH_RESPONSE_TAG_LIMIT,
      MEMORY_SEARCH_RESPONSE_TAG_MAX_CHARS,
      MEMORY_SEARCH_RESPONSE_TAG_MAX_TOKENS,
      { normalizedKey: true },
    ) ?? [],
    relatedFiles: compactMemorySearchResponsePathList(
      [...primary.relatedFiles, ...secondary.relatedFiles],
      MEMORY_SEARCH_RESPONSE_FILE_LIMIT,
      MEMORY_SEARCH_RESPONSE_FILE_MAX_CHARS,
      MEMORY_SEARCH_RESPONSE_FILE_MAX_TOKENS,
    ) ?? [],
    relatedModules: compactMemorySearchResponseTextList(
      [...primary.relatedModules, ...secondary.relatedModules],
      MEMORY_SEARCH_RESPONSE_MODULE_LIMIT,
      MEMORY_SEARCH_RESPONSE_MODULE_MAX_CHARS,
      MEMORY_SEARCH_RESPONSE_MODULE_MAX_TOKENS,
      { normalizedKey: true },
    ) ?? [],
    provenanceSessionIds: compactMemorySearchResponseTextList(
      [...primary.provenanceSessionIds, ...secondary.provenanceSessionIds],
      MEMORY_SEARCH_RESPONSE_ID_LIST_LIMIT,
      MEMORY_SEARCH_RESPONSE_ID_MAX_CHARS,
      MEMORY_SEARCH_RESPONSE_ID_MAX_TOKENS,
    ) ?? [],
    impactedNodeIds: compactMemorySearchResponseTextList(
      [
        ...(primary.impactedNodeIds ?? []),
        ...(secondary.impactedNodeIds ?? []),
      ],
      MEMORY_SEARCH_RESPONSE_ID_LIST_LIMIT,
      MEMORY_SEARCH_RESPONSE_ID_MAX_CHARS,
      MEMORY_SEARCH_RESPONSE_ID_MAX_TOKENS,
    ),
    relations: compactMemorySearchResponseRelations([
      ...(primary.relations ?? []),
      ...(secondary.relations ?? []),
    ]),
  };
}

interface RankedMemorySearchResponseMemory {
  memory: Memory;
  rank: number;
}

function getMemorySearchResponseMemoryDedupeKey(memory: Memory): string {
  return [
    memory.type,
    fingerprintMemorySearchResponseText(memory.content),
  ].join(':');
}

function isHigherPriorityMemorySearchResponseMemory(candidate: Memory, existing: Memory): boolean {
  const candidateScore = scoreMemorySearchResponseMemory(candidate);
  const existingScore = scoreMemorySearchResponseMemory(existing);
  return candidateScore > existingScore;
}

function scoreMemorySearchResponseMemory(memory: Memory): number {
  const verifiedBoost = memory.userVerified ? 0.3 : 0;
  const pinnedBoost = memory.pinned ? 0.5 : 0;
  const accessBoost = Math.min(memory.accessCount || 0, 10) * 0.01;
  return memory.confidence + verifiedBoost + pinnedBoost + accessBoost;
}

function compactOptionalMemorySearchResponseText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return compactMemorySearchResponseText(
    value,
    MEMORY_SEARCH_RESPONSE_TEXT_MAX_CHARS,
    MEMORY_SEARCH_RESPONSE_TEXT_MAX_TOKENS,
  );
}

function compactOptionalMemorySearchResponseMethodology(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return compactMemorySearchResponseText(
    value,
    MEMORY_SEARCH_RESPONSE_METHODOLOGY_MAX_CHARS,
    MEMORY_SEARCH_RESPONSE_METHODOLOGY_MAX_TOKENS,
  );
}

function compactMemorySearchResponseText(value: string, maxChars: number, maxTokens: number): string {
  const folded = foldRepeatedAutocodePromptLines(value);
  const normalized = folded.replace(/\s+/g, ' ').trim();
  if (maxChars <= 0 || maxTokens <= 0) {
    return '';
  }
  if (normalized.length <= maxChars && estimateTokens(normalized) <= maxTokens) {
    return normalized;
  }

  const charBounded = compactMemorySearchResponseTextByChars(normalized, maxChars);
  if (estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, normalized.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = compactMemorySearchResponseTextByChars(normalized, midpoint);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function compactMemorySearchResponseTextByChars(normalized: string, maxChars: number): string {
  if (maxChars <= 0 || normalized.length <= maxChars) {
    return normalized.slice(0, Math.max(0, maxChars));
  }

  const marker = MEMORY_SEARCH_RESPONSE_OMISSION_MARKER;
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

function normalizeMemorySearchResponseDedupeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function fingerprintMemorySearchResponseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactMemorySearchResponseTextList(
  values: string[] | undefined,
  limit: number,
  maxItemChars: number,
  maxItemTokens: number,
  options: { normalizedKey?: boolean } = {},
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
    const item = compactMemorySearchResponseText(value, maxItemChars, maxItemTokens);
    const key = getMemorySearchResponseTextListDedupeKey(item, options);
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

function getMemorySearchResponseTextListDedupeKey(
  value: string,
  options: { normalizedKey?: boolean },
): string {
  if (!options.normalizedKey) {
    return value;
  }
  return normalizeMemorySearchResponseDedupeText(value);
}

function compactMemorySearchResponsePathList(
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
    const item = compactMemorySearchResponsePathTailToBudget(value, maxItemChars, maxItemTokens);
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

function compactMemorySearchResponseRelations(
  relations: Memory['relations'],
): Memory['relations'] {
  if (!relations) {
    return undefined;
  }

  const byKey = new Map<string, RankedMemorySearchResponseRelation>();
  relations.forEach((relation, rank) => {
    const compactRelation = {
      ...relation,
      targetFilePath: relation.targetFilePath
        ? compactMemorySearchResponsePathTailToBudget(
            relation.targetFilePath,
            MEMORY_SEARCH_RESPONSE_FILE_MAX_CHARS,
            MEMORY_SEARCH_RESPONSE_FILE_MAX_TOKENS,
          )
        : relation.targetFilePath,
    };
    const key = getMemorySearchResponseRelationDedupeKey(compactRelation);
    const existing = byKey.get(key);
    if (!existing || isHigherPriorityMemorySearchResponseRelation(compactRelation, existing.relation)) {
      const relationForStorage = existing
        ? {
            ...compactRelation,
            targetFilePath: existing.relation.targetFilePath,
          }
        : compactRelation;
      byKey.set(key, {
        relation: relationForStorage,
        rank: existing?.rank ?? rank,
      });
    }
  });

  return [...byKey.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MEMORY_SEARCH_RESPONSE_RELATION_LIMIT)
    .map((item) => item.relation);
}

type MemorySearchResponseRelation = NonNullable<Memory['relations']>[number];

interface RankedMemorySearchResponseRelation {
  relation: MemorySearchResponseRelation;
  rank: number;
}

function isHigherPriorityMemorySearchResponseRelation(
  candidate: MemorySearchResponseRelation,
  existing: MemorySearchResponseRelation,
): boolean {
  if (candidate.confidence !== existing.confidence) {
    return candidate.confidence > existing.confidence;
  }
  return existing.autoExtracted && !candidate.autoExtracted;
}

function getMemorySearchResponseRelationDedupeKey(
  relation: MemorySearchResponseRelation,
): string {
  return [
    relation.relationType,
    relation.targetMemoryId ?? '',
    relation.targetFilePath?.toLowerCase().replace(/\\/g, '/').replace(/\/+/g, '/').trim() ?? '',
  ].join(':');
}

function compactMemorySearchResponsePathTailToBudget(value: string, maxChars: number, maxTokens: number): string {
  const normalized = value
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
  if (maxChars <= 0 || maxTokens <= 0) {
    return '';
  }

  const charBounded = truncateMemorySearchResponsePathTail(normalized, maxChars);
  if (estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, normalized.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = truncateMemorySearchResponsePathTail(normalized, midpoint);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function truncateMemorySearchResponsePathTail(path: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (path.length <= maxChars) {
    return path;
  }
  return path.slice(-maxChars).replace(/^\/+/, '');
}

function isMemoryIpcMessage(message: unknown): message is MemoryIpcMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' && type.startsWith('memory:');
}

function isMemoryObservationMessage(message: MemoryIpcMessage): message is MemoryIpcRequest {
  return message.type === 'memory:tool-call' ||
    message.type === 'memory:tool-result' ||
    message.type === 'memory:reasoning' ||
    message.type === 'memory:token-usage' ||
    message.type === 'memory:step-complete';
}

function buildMemoryCandidateTags(
  candidate: MemoryCandidate,
  sessionType: SessionType,
): string[] {
  const tags = new Set<string>([candidate.signalType, sessionType]);
  if (candidate.proposedType === 'context_cost') {
    tags.add('context_cost');
    tags.add('token_usage');
  }
  return [...tags];
}

async function getMemoryServiceLazy() {
  const { getMemoryService } = await import('../../ipc-handlers/context/memory-service-factory');
  return getMemoryService();
}

function addTokenUsage(
  baseline: TokenUsage | null,
  incoming: TokenUsage,
): TokenUsage {
  if (!baseline) return incoming;

  return {
    promptTokens: (baseline.promptTokens ?? 0) + (incoming.promptTokens ?? 0),
    completionTokens: (baseline.completionTokens ?? 0) + (incoming.completionTokens ?? 0),
    totalTokens: (baseline.totalTokens ?? 0) + (incoming.totalTokens ?? 0),
    thinkingTokens: ((baseline.thinkingTokens ?? 0) + (incoming.thinkingTokens ?? 0)) || undefined,
    cacheReadTokens: ((baseline.cacheReadTokens ?? 0) + (incoming.cacheReadTokens ?? 0)) || undefined,
    cacheCreationTokens:
      ((baseline.cacheCreationTokens ?? 0) + (incoming.cacheCreationTokens ?? 0)) || undefined,
    stepsExecuted: ((baseline.stepsExecuted ?? 0) + (incoming.stepsExecuted ?? 0)) || undefined,
    estimated: baseline.estimated === true || incoming.estimated === true ? true : undefined,
    sessionId: incoming.sessionId ?? baseline.sessionId,
  };
}

function maxTokenUsage(
  previous: TokenUsage | null,
  incoming: TokenUsage,
): TokenUsage {
  if (!previous) return incoming;
  const replaceEstimatedWithReported = previous.estimated === true && incoming.estimated !== true;
  if (replaceEstimatedWithReported) {
    return {
      promptTokens: incoming.promptTokens,
      completionTokens: incoming.completionTokens,
      totalTokens: incoming.totalTokens,
      thinkingTokens: incoming.thinkingTokens,
      cacheReadTokens: incoming.cacheReadTokens,
      cacheCreationTokens: incoming.cacheCreationTokens,
      stepsExecuted: Math.max(previous.stepsExecuted ?? 0, incoming.stepsExecuted ?? 0) || undefined,
      sessionId: incoming.sessionId ?? previous.sessionId,
    };
  }

  const preferIncomingTokens = !incoming.estimated || previous.estimated === true;

  return {
    promptTokens: preferIncomingTokens
      ? Math.max(previous.promptTokens ?? 0, incoming.promptTokens ?? 0)
      : previous.promptTokens,
    completionTokens: preferIncomingTokens
      ? Math.max(previous.completionTokens ?? 0, incoming.completionTokens ?? 0)
      : previous.completionTokens,
    totalTokens: preferIncomingTokens
      ? Math.max(previous.totalTokens ?? 0, incoming.totalTokens ?? 0)
      : previous.totalTokens,
    thinkingTokens: Math.max(previous.thinkingTokens ?? 0, incoming.thinkingTokens ?? 0) || undefined,
    cacheReadTokens: Math.max(previous.cacheReadTokens ?? 0, incoming.cacheReadTokens ?? 0) || undefined,
    cacheCreationTokens:
      Math.max(previous.cacheCreationTokens ?? 0, incoming.cacheCreationTokens ?? 0) || undefined,
    stepsExecuted: Math.max(previous.stepsExecuted ?? 0, incoming.stepsExecuted ?? 0) || undefined,
    estimated: previous.estimated === true && incoming.estimated === true ? true : undefined,
    sessionId: incoming.sessionId ?? previous.sessionId,
  };
}

function authoritativeTokenUsageSnapshot(
  previous: TokenUsage | null,
  incoming: TokenUsage,
): TokenUsage {
  if (!previous) return incoming;
  if (!hasPositiveTokenUsage(incoming)) {
    return maxTokenUsage(previous, incoming);
  }
  if (incoming.estimated === true && previous.estimated !== true) {
    return maxTokenUsage(previous, incoming);
  }

  return {
    promptTokens: incoming.promptTokens,
    completionTokens: incoming.completionTokens,
    totalTokens: incoming.totalTokens,
    thinkingTokens: incoming.thinkingTokens,
    cacheReadTokens: incoming.cacheReadTokens,
    cacheCreationTokens: incoming.cacheCreationTokens,
    stepsExecuted: incoming.stepsExecuted ?? previous.stepsExecuted,
    estimated: incoming.estimated === true ? true : undefined,
    sessionId: incoming.sessionId ?? previous.sessionId,
  };
}

function shouldUseResultStepsForTokenUsage(usage: TokenUsage): boolean {
  return hasPositiveTokenUsage(usage) || Boolean(usage.sessionId);
}

function hasPositiveTokenUsage(usage: TokenUsage): boolean {
  return (usage.promptTokens ?? 0) > 0 ||
    (usage.completionTokens ?? 0) > 0 ||
    (usage.totalTokens ?? 0) > 0 ||
    (usage.thinkingTokens ?? 0) > 0 ||
    (usage.cacheReadTokens ?? 0) > 0 ||
    (usage.cacheCreationTokens ?? 0) > 0;
}
