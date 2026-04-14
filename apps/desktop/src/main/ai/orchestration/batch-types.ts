/**
 * Batch Execution Types
 * =====================
 *
 * Type definitions and interfaces for batch subtask execution.
 */

import type { SessionResult } from '../session/types';

// =============================================================================
// Execution Mode
// =============================================================================

/** Execution mode for subtask processing */
export type ExecutionMode = 'batch' | 'serial' | 'auto';

// =============================================================================
// Batch Configuration
// =============================================================================

/** Configuration for batch execution */
export interface BatchExecutionConfig {
  /** Execution mode */
  mode: ExecutionMode;

  /** Batch size (number of subtasks per batch, or 'auto' for dynamic calculation) */
  batchSize: number | 'auto';

  /** Fallback strategy */
  fallback: {
    /** Enable fallback to serial mode */
    enabled: boolean;
    /** Trigger condition */
    trigger: 'consecutive_failures' | 'low_completion_rate';
    /** Threshold (e.g., 3 consecutive failures, or 30% completion rate) */
    threshold: number;
  };

  /** Conflict resolution strategy */
  conflictResolution: 'serialize' | 'batch_together' | 'skip';

  /** Validation strategy */
  validation: {
    /** When to validate */
    timing: 'per_subtask' | 'per_batch' | 'end_of_session';
    /** What to do on validation failure */
    onFailure: 'rollback_all' | 'rollback_failed' | 'mark_failed';
  };

  /** Context window management */
  contextManagement: {
    /** Maximum tokens for batch prompt */
    maxBatchTokens: number;
    /** Safety margin (0.8 = use 80% of context window) */
    safetyMargin: number;
    /** Enable continuation sessions for context exhaustion */
    enableContinuation: boolean;
  };
}

/** Default batch execution configuration */
export const DEFAULT_BATCH_CONFIG: BatchExecutionConfig = {
  mode: 'auto',
  batchSize: 'auto',
  fallback: {
    enabled: true,
    trigger: 'consecutive_failures',
    threshold: 3,
  },
  conflictResolution: 'batch_together',
  validation: {
    timing: 'per_batch',
    onFailure: 'rollback_failed',
  },
  contextManagement: {
    maxBatchTokens: 100_000,
    safetyMargin: 0.8,
    enableContinuation: true,
  },
};

// =============================================================================
// Subtask Information
// =============================================================================

/** Subtask information for batch execution */
export interface SubtaskInfo {
  /** Subtask ID */
  id: string;
  /** Phase ID (optional) */
  phaseId?: string;
  /** Description */
  description: string;
  /** Files to create */
  filesToCreate?: string[];
  /** Files to modify */
  filesToModify?: string[];
  /** Pattern files to study */
  patternFiles?: string[];
  /** Verification instructions */
  verification?: string;
  /** Current status */
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'stuck';
}

// =============================================================================
// Batch Progress
// =============================================================================

/** Progress tracking for batch execution */
export interface BatchProgress {
  /** Completed subtask IDs */
  completed: string[];
  /** In-progress subtask IDs */
  inProgress: string[];
  /** Blocked subtask IDs */
  blocked: string[];
  /** Not started subtask IDs */
  notStarted: string[];
}

// =============================================================================
// Batch Result
// =============================================================================

/** Result of a single batch execution */
export interface BatchResult {
  /** Successfully completed subtask IDs */
  completed: string[];
  /** Failed subtask IDs */
  failed: string[];
  /** Blocked subtask IDs */
  blocked: string[];
  /** Session result */
  sessionResult: SessionResult;
}

/** Result of the entire batch executor */
export interface BatchExecutorResult {
  /** Overall success */
  success: boolean;
  /** Total completed subtasks */
  totalCompleted: number;
  /** Total failed subtasks */
  totalFailed?: number;
  /** Cancelled flag */
  cancelled?: boolean;
  /** Error message */
  error?: string;
}

// =============================================================================
// Conflict Detection
// =============================================================================

/** File conflict graph */
export interface ConflictGraph {
  /** Independent subtask groups (can be batched together) */
  independent: SubtaskInfo[][];
  /** Sequential subtasks (must be executed serially) */
  sequential: SubtaskInfo[];
}

// =============================================================================
// Batch Prompt Context
// =============================================================================

/** Context for generating batch prompts */
export interface BatchPromptConfig {
  /** Subtasks to include in the batch */
  subtasks: SubtaskInfo[];
  /** Spec directory */
  specDir: string;
  /** Project directory */
  projectDir: string;
  /** Attempt count (for retry context) */
  attemptCount: number;
  /** Is this a continuation session? */
  isContinuation?: boolean;
  /** Previous progress (for continuation) */
  previousProgress?: BatchProgress;
}
