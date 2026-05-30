/**
 * Conflict Detector
 * =================
 *
 * Detects file conflicts between work items so independent work can run
 * concurrently while overlapping file edits are serialized.
 */

import type { ConflictGraph, WorkItemInfo } from './work-executor-types';

// =============================================================================
// Conflict Detection
// =============================================================================

/**
 * Detects file conflicts between work items.
 *
 * A conflict occurs when multiple work items modify or create the same file.
 */
export function detectFileConflicts(workItems: WorkItemInfo[]): ConflictGraph {
  const fileToWorkItems = new Map<string, string[]>();

  for (const workItem of workItems) {
    const files = [
      ...(workItem.filesToModify || []),
      ...(workItem.filesToCreate || []),
    ];

    for (const file of files) {
      if (!fileToWorkItems.has(file)) {
        fileToWorkItems.set(file, []);
      }
      fileToWorkItems.get(file)!.push(workItem.id);
    }
  }

  const conflicts = new Set<string>();
  for (const workItemIds of fileToWorkItems.values()) {
    if (workItemIds.length > 1) {
      for (const id of workItemIds) {
        conflicts.add(id);
      }
    }
  }

  const independent = workItems.filter((workItem) => !conflicts.has(workItem.id));
  const sequential = workItems.filter((workItem) => conflicts.has(workItem.id));

  return {
    independent: independent.length > 0 ? [independent] : [],
    sequential,
  };
}

/**
 * Groups conflicting work items by shared files.
 */
export function groupConflictingWorkItems(workItems: WorkItemInfo[]): WorkItemInfo[][] {
  if (workItems.length === 0) {
    return [];
  }

  const fileToWorkItems = new Map<string, Set<string>>();

  for (const workItem of workItems) {
    const files = [
      ...(workItem.filesToModify || []),
      ...(workItem.filesToCreate || []),
    ];

    for (const file of files) {
      if (!fileToWorkItems.has(file)) {
        fileToWorkItems.set(file, new Set());
      }
      fileToWorkItems.get(file)!.add(workItem.id);
    }
  }

  const workItemToGroup = new Map<string, number>();
  let nextGroupId = 0;

  for (const workItem of workItems) {
    const files = [
      ...(workItem.filesToModify || []),
      ...(workItem.filesToCreate || []),
    ];

    const relatedGroups = new Set<number>();
    for (const file of files) {
      const relatedWorkItems = fileToWorkItems.get(file);
      if (relatedWorkItems) {
        for (const relatedId of relatedWorkItems) {
          const groupId = workItemToGroup.get(relatedId);
          if (groupId !== undefined) {
            relatedGroups.add(groupId);
          }
        }
      }
    }

    if (relatedGroups.size === 0) {
      workItemToGroup.set(workItem.id, nextGroupId++);
      continue;
    }

    const targetGroup = Math.min(...relatedGroups);
    workItemToGroup.set(workItem.id, targetGroup);

    for (const [id, groupId] of workItemToGroup) {
      if (relatedGroups.has(groupId)) {
        workItemToGroup.set(id, targetGroup);
      }
    }
  }

  const groups = new Map<number, WorkItemInfo[]>();
  for (const workItem of workItems) {
    const groupId = workItemToGroup.get(workItem.id)!;
    if (!groups.has(groupId)) {
      groups.set(groupId, []);
    }
    groups.get(groupId)!.push(workItem);
  }

  return Array.from(groups.values());
}
