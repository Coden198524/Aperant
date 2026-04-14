/**
 * Conflict Detector
 * =================
 *
 * Detects file conflicts between subtasks to determine which can be
 * executed in parallel (batched) and which must be serialized.
 */

import type { SubtaskInfo, ConflictGraph } from './batch-types';

const MAX_AUTO_BATCH_SIZE = 5;

// =============================================================================
// Conflict Detection
// =============================================================================

/**
 * Detects file conflicts between subtasks.
 *
 * A conflict occurs when multiple subtasks modify or create the same file.
 * Conflicting subtasks should be executed serially to avoid race conditions.
 *
 * @param subtasks - Array of subtasks to analyze
 * @returns Conflict graph with independent and sequential subtasks
 */
export function detectFileConflicts(subtasks: SubtaskInfo[]): ConflictGraph {
  // Build file → subtask mapping
  const fileToSubtasks = new Map<string, string[]>();

  for (const subtask of subtasks) {
    const files = [
      ...(subtask.filesToModify || []),
      ...(subtask.filesToCreate || []),
    ];

    for (const file of files) {
      if (!fileToSubtasks.has(file)) {
        fileToSubtasks.set(file, []);
      }
      fileToSubtasks.get(file)!.push(subtask.id);
    }
  }

  // Identify conflicting subtasks
  const conflicts = new Set<string>();
  for (const [_file, subtaskIds] of fileToSubtasks) {
    if (subtaskIds.length > 1) {
      // Multiple subtasks modify the same file → conflict
      for (const id of subtaskIds) {
        conflicts.add(id);
      }
    }
  }

  // Separate independent and sequential subtasks
  const independent = subtasks.filter((st) => !conflicts.has(st.id));
  const sequential = subtasks.filter((st) => conflicts.has(st.id));

  return {
    independent: independent.length > 0 ? [independent] : [],
    sequential,
  };
}

/**
 * Groups conflicting subtasks by shared files.
 *
 * Subtasks that modify the same files are grouped together.
 * This allows batching subtasks that conflict with each other
 * (letting the model coordinate changes) while keeping different
 * conflict groups separate.
 *
 * @param subtasks - Array of subtasks to group
 * @returns Array of subtask groups
 */
export function groupConflictingSubtasks(subtasks: SubtaskInfo[]): SubtaskInfo[][] {
  if (subtasks.length === 0) return [];

  // Build file → subtask mapping
  const fileToSubtasks = new Map<string, Set<string>>();

  for (const subtask of subtasks) {
    const files = [
      ...(subtask.filesToModify || []),
      ...(subtask.filesToCreate || []),
    ];

    for (const file of files) {
      if (!fileToSubtasks.has(file)) {
        fileToSubtasks.set(file, new Set());
      }
      fileToSubtasks.get(file)!.add(subtask.id);
    }
  }

  // Build subtask → group mapping using union-find
  const subtaskToGroup = new Map<string, number>();
  let nextGroupId = 0;

  for (const subtask of subtasks) {
    const files = [
      ...(subtask.filesToModify || []),
      ...(subtask.filesToCreate || []),
    ];

    // Find all groups this subtask should belong to
    const relatedGroups = new Set<number>();
    for (const file of files) {
      const relatedSubtasks = fileToSubtasks.get(file);
      if (relatedSubtasks) {
        for (const relatedId of relatedSubtasks) {
          const groupId = subtaskToGroup.get(relatedId);
          if (groupId !== undefined) {
            relatedGroups.add(groupId);
          }
        }
      }
    }

    // Merge all related groups
    if (relatedGroups.size === 0) {
      // New group
      subtaskToGroup.set(subtask.id, nextGroupId++);
    } else {
      // Merge into the first group
      const targetGroup = Math.min(...relatedGroups);
      subtaskToGroup.set(subtask.id, targetGroup);

      // Update all related subtasks to use the target group
      for (const [id, groupId] of subtaskToGroup) {
        if (relatedGroups.has(groupId)) {
          subtaskToGroup.set(id, targetGroup);
        }
      }
    }
  }

  // Group subtasks by their group ID
  const groups = new Map<number, SubtaskInfo[]>();
  for (const subtask of subtasks) {
    const groupId = subtaskToGroup.get(subtask.id)!;
    if (!groups.has(groupId)) {
      groups.set(groupId, []);
    }
    groups.get(groupId)!.push(subtask);
  }

  return Array.from(groups.values());
}

/**
 * Calculates optimal batch size based on context window and subtask complexity.
 *
 * @param subtasks - Array of subtasks
 * @param contextLimit - Model context window limit (tokens)
 * @param maxBatchTokens - Maximum tokens to use for batch prompt
 * @param safetyMargin - Safety margin (0.8 = use 80% of available tokens)
 * @returns Optimal batch size
 */
export function calculateOptimalBatchSize(
  subtasks: SubtaskInfo[],
  contextLimit: number,
  maxBatchTokens: number,
  safetyMargin: number
): number {
  // Estimate token usage
  const basePromptTokens = 5_000; // Environment + instructions
  const perSubtaskTokens = 500; // Each subtask description
  const workingTokens = 50_000; // Model working space

  // Calculate available tokens
  const availableTokens = Math.min(
    (contextLimit * safetyMargin) - basePromptTokens - workingTokens,
    maxBatchTokens
  );

  // Calculate max subtasks that fit
  const maxSubtasks = Math.floor(availableTokens / perSubtaskTokens);

  // Cap at reasonable limits
  const cappedMax = Math.min(maxSubtasks, MAX_AUTO_BATCH_SIZE); // Max 5 subtasks per batch

  // Return at least 1, at most the number of subtasks
  return Math.max(1, Math.min(cappedMax, subtasks.length));
}

/**
 * Splits subtasks into batches of the specified size.
 *
 * @param subtasks - Array of subtasks to split
 * @param batchSize - Size of each batch
 * @returns Array of batches
 */
export function chunkSubtasks(
  subtasks: SubtaskInfo[],
  batchSize: number
): SubtaskInfo[][] {
  if (batchSize <= 0) {
    throw new Error('Batch size must be positive');
  }

  const batches: SubtaskInfo[][] = [];
  for (let i = 0; i < subtasks.length; i += batchSize) {
    batches.push(subtasks.slice(i, i + batchSize));
  }

  return batches;
}
