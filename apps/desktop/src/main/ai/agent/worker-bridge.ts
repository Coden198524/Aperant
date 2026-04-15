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

import type { AgentManagerEvents, ExecutionProgressData, ProcessType } from '../../agent/types';
import type { TaskEventPayload } from '../../agent/task-event-schema';
import type { TokenUsage } from '../../../shared/types';
import type {
  WorkerConfig,
  WorkerMessage,
  AgentExecutorConfig,
} from './types';
import type { SessionResult } from '../session/types';
import { ProgressTracker } from '../session/progress-tracker';

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
  private static readonly TEXT_DELTA_LOG_FLUSH_MS = 250;
  private static readonly TEXT_DELTA_LOG_MAX_CHARS = 240;

  private worker: Worker | null = null;
  private progressTracker: ProgressTracker = new ProgressTracker();
  private taskId: string = '';
  private projectId: string | undefined;
  private processType: ProcessType = 'task-execution';
  private executionProgressSequence = 0;
  private lastTokenUsage: TokenUsage | null = null;
  private bufferedTextDeltaLog = '';
  private textDeltaFlushTimer: NodeJS.Timeout | null = null;

  /**
   * Spawn a worker thread with the given configuration.
   * The worker will immediately begin executing the agent session.
   *
   * @param config - Executor configuration (task ID, session params, etc.)
   */
  spawn(config: AgentExecutorConfig): void {
    if (this.worker) {
      throw new Error('WorkerBridge already has an active worker. Call terminate() first.');
    }

    this.taskId = config.taskId;
    this.projectId = config.projectId;
    this.processType = config.processType;
    this.progressTracker = new ProgressTracker();
    this.executionProgressSequence = 0;
    this.lastTokenUsage = null;

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

    this.worker.on('message', (message: WorkerMessage) => {
      this.handleWorkerMessage(message);
    });

    this.worker.on('messageerror', (error: Error) => {
      console.error(`[WorkerBridge:${this.taskId}] Worker message error:`, error);
      this.emitTyped('error', this.taskId, `Worker message error: ${error.message}`, this.projectId);
    });

    this.worker.on('error', (error: Error) => {
      console.error(`[WorkerBridge:${this.taskId}] Worker error:`, error);
      this.flushBufferedTextDeltaLog(this.taskId, this.projectId);
      this.emitTyped('error', this.taskId, error.message, this.projectId);
      this.cleanup();
    });

    this.worker.on('exit', (code: number) => {
      console.log(`[WorkerBridge:${this.taskId}] Worker exited with code ${code}`);
      // Code 0 = clean exit; non-zero = crash/error
      // Only emit exit if we haven't already emitted from a 'result' message
      if (this.worker) {
        this.flushBufferedTextDeltaLog(this.taskId, this.projectId);
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

  private handleWorkerMessage(message: WorkerMessage): void {
    switch (message.type) {
      case 'log':
        this.flushBufferedTextDeltaLog(message.taskId, message.projectId);
        this.emitTyped('log', message.taskId, message.data, message.projectId);
        break;

      case 'error':
        this.flushBufferedTextDeltaLog(message.taskId, message.projectId);
        this.emitTyped('error', message.taskId, message.data, message.projectId);
        break;

      case 'execution-progress':
        this.flushBufferedTextDeltaLog(message.taskId, message.projectId);
        this.emitExecutionProgress(message.taskId, message.data, message.projectId);
        break;

      case 'stream-event':
        if (message.data.type === 'text-delta') {
          this.bufferTextDeltaLog(message.taskId, message.data.text, message.projectId);
          break;
        }

        this.flushBufferedTextDeltaLog(message.taskId, message.projectId);
        // Feed the progress tracker and emit progress updates
        this.progressTracker.processEvent(message.data);
        this.emitProgressFromTracker(message.taskId, message.projectId);
        if (message.data.type === 'usage-update') {
          this.lastTokenUsage = mergeTokenUsage(this.lastTokenUsage, message.data.usage);
          this.emitTyped('task-token-usage', message.taskId, this.lastTokenUsage, message.projectId);
        }
        break;

      case 'task-event':
        this.flushBufferedTextDeltaLog(message.taskId, message.projectId);
        this.emitTyped('task-event', message.taskId, message.data as TaskEventPayload, message.projectId);
        break;

      case 'task-token-usage':
        this.flushBufferedTextDeltaLog(message.taskId, message.projectId);
        this.lastTokenUsage = mergeTokenUsage(this.lastTokenUsage, message.data);
        this.emitTyped('task-token-usage', message.taskId, this.lastTokenUsage, message.projectId);
        break;

      case 'result':
        this.flushBufferedTextDeltaLog(message.taskId, message.projectId);
        this.handleResult(message.taskId, message.data, message.projectId);
        break;
    }
  }

  private bufferTextDeltaLog(taskId: string, text: string, projectId?: string): void {
    if (!text) return;

    this.bufferedTextDeltaLog += text;

    if (this.bufferedTextDeltaLog.length >= WorkerBridge.TEXT_DELTA_LOG_MAX_CHARS) {
      this.flushBufferedTextDeltaLog(taskId, projectId);
      return;
    }

    this.scheduleTextDeltaFlush(taskId, projectId);
  }

  private scheduleTextDeltaFlush(taskId: string, projectId?: string): void {
    if (this.textDeltaFlushTimer) return;

    this.textDeltaFlushTimer = setTimeout(() => {
      this.textDeltaFlushTimer = null;
      this.flushBufferedTextDeltaLog(taskId, projectId);
    }, WorkerBridge.TEXT_DELTA_LOG_FLUSH_MS);
    this.textDeltaFlushTimer.unref?.();
  }

  private flushBufferedTextDeltaLog(taskId: string, projectId?: string): void {
    if (this.textDeltaFlushTimer) {
      clearTimeout(this.textDeltaFlushTimer);
      this.textDeltaFlushTimer = null;
    }

    if (!this.bufferedTextDeltaLog) return;

    this.emitTyped('log', taskId, this.bufferedTextDeltaLog, projectId);
    this.bufferedTextDeltaLog = '';
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
    const usageWithSteps: TokenUsage = mergeTokenUsage(this.lastTokenUsage, {
      ...result.usage,
      stepsExecuted: result.stepsExecuted,
    });
    this.lastTokenUsage = usageWithSteps;

    this.emitTyped('task-token-usage', taskId, usageWithSteps, projectId);

    // Log the result summary
    const summary = `Session complete: outcome=${result.outcome}, steps=${result.stepsExecuted}, tools=${result.toolCallCount}, duration=${result.durationMs}ms`;
    this.emitTyped('log', taskId, summary, projectId);

    if (result.error) {
      this.emitTyped('error', taskId, result.error.message, projectId);
    }

    // Emit exit and cleanup
    this.emitTyped('exit', taskId, exitCode, this.processType, projectId);
    this.cleanup();
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
    if (this.textDeltaFlushTimer) {
      clearTimeout(this.textDeltaFlushTimer);
      this.textDeltaFlushTimer = null;
    }
    this.bufferedTextDeltaLog = '';
    this.worker = null;
    this.lastTokenUsage = null;
  }
}

function mergeTokenUsage(previous: TokenUsage | null, incoming: TokenUsage): TokenUsage {
  if (!previous) return incoming;

  // Never regress aggregate counters in UI due to late zero/partial payloads.
  return {
    promptTokens: Math.max(previous.promptTokens ?? 0, incoming.promptTokens ?? 0),
    completionTokens: Math.max(previous.completionTokens ?? 0, incoming.completionTokens ?? 0),
    totalTokens: Math.max(previous.totalTokens ?? 0, incoming.totalTokens ?? 0),
    thinkingTokens: Math.max(previous.thinkingTokens ?? 0, incoming.thinkingTokens ?? 0) || undefined,
    cacheReadTokens: Math.max(previous.cacheReadTokens ?? 0, incoming.cacheReadTokens ?? 0) || undefined,
    cacheCreationTokens: Math.max(previous.cacheCreationTokens ?? 0, incoming.cacheCreationTokens ?? 0) || undefined,
    stepsExecuted: Math.max(previous.stepsExecuted ?? 0, incoming.stepsExecuted ?? 0) || undefined,
  };
}
