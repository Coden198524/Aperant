import { ChildProcess } from 'child_process';
import type { Worker } from 'worker_threads';
import type { CompletablePhase, ExecutionPhase } from '../../shared/constants/phase-protocol';
import type { TaskLogStreamChunk, TaskWorkflowMode, TokenUsage } from '../../shared/types';
import type { TaskEventPayload } from './task-event-schema';

/**
 * Agent-specific types for process and state management
 */

export type QueueProcessType = 'ideation' | 'roadmap';

export interface AgentProcess {
  taskId: string;
  process: ChildProcess | null; // null during async spawn setup before ChildProcess is created
  startedAt: Date;
  projectPath?: string; // For ideation processes to load session on completion
  spawnId: number; // Unique ID to identify this specific spawn
  queueProcessType?: QueueProcessType; // Type of queue process (ideation or roadmap)
  /** Worker thread instance for TypeScript AI SDK agent execution */
  worker?: Worker | null;
}

export interface ExecutionProgressData {
  phase: ExecutionPhase;
  phaseProgress: number;
  overallProgress: number;
  currentSubtask?: string;
  message?: string;
  sequenceNumber?: number;
  // FIX (ACS-203): Track completed phases to prevent phase overlaps
  completedPhases?: CompletablePhase[];
}

export type ProcessType = 'spec-creation' | 'task-execution' | 'qa-process';

export interface AgentManagerEvents {
  log: (taskId: string, log: string, projectId?: string) => void;
  error: (taskId: string, error: string, projectId?: string) => void;
  exit: (taskId: string, code: number | null, processType: ProcessType, projectId?: string) => void;
  'execution-progress': (taskId: string, progress: ExecutionProgressData, projectId?: string) => void;
  'task-token-usage': (taskId: string, usage: TokenUsage, projectId?: string) => void;
  'task-event': (taskId: string, event: TaskEventPayload, projectId?: string) => void;
  'task-log-stream': (taskId: string, chunk: TaskLogStreamChunk, projectId?: string) => void;
}

// IdeationConfig now imported from shared types to maintain consistency

export interface RoadmapConfig {
  model?: string;          // Model shorthand or full model ID (e.g., gpt-5.4)
  thinkingLevel?: string;  // Thinking level (low, medium, high)
  language?: string;       // User's preferred language for AI-generated content (e.g., 'en', 'zh')
}

export interface TaskExecutionOptions {
  baseBranch?: string;
  useWorktree?: boolean; // If true, use worktree isolation; omitted defaults to direct mode
  useLocalBranch?: boolean; // If true, use local branch directly instead of preferring origin/branch
  pushNewBranches?: boolean; // If false, keep task worktree branches local-only
  forcePlanning?: boolean; // Internal: rerun planning even when an old implementation plan has subtasks
}

export interface SpecCreationMetadata {
  requireReviewBeforeCoding?: boolean;
  // Auto profile - phase-based model and thinking configuration
  isAutoProfile?: boolean;
  phaseModels?: {
    spec: string;
    planning: string;
    coding: string;
    qa: string;
  };
  phaseThinking?: {
    spec: string;
    planning: string;
    coding: string;
    qa: string;
  };
  /** Per-phase provider preference (e.g. { spec: 'openai', coding: 'anthropic' }) */
  phaseProviders?: Record<string, string>;
  /** Task-level provider preference (e.g. 'openai', 'ollama') */
  provider?: string;
  // Non-auto profile - single model and thinking level
  model?: string;
  thinkingLevel?: string;
  workflowMode?: TaskWorkflowMode;
  // Workspace mode - whether to use worktree isolation
  useWorktree?: boolean; // If true, use worktree isolation; omitted defaults to direct mode
  useLocalBranch?: boolean; // If true, use local branch directly instead of preferring origin/branch
}

export interface IdeationProgressData {
  phase: string;
  progress: number;
  message: string;
  completedTypes?: string[];
}

export interface RoadmapProgressData {
  phase: string;
  progress: number;
  message: string;
}
