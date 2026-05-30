/**
 * Conflict Detector
 * =================
 *
 * Detects file conflicts between work items so independent work can run
 * concurrently while overlapping file edits are serialized.
 */

import { posix as pathPosix } from 'node:path';
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
  const fileIntentsByWorkItem = new Map<string, string[]>();

  for (const workItem of workItems) {
    const files = normalizeWorkItemFiles([
      ...(workItem.filesToModify || []),
      ...(workItem.filesToCreate || []),
      ...(workItem.patternFiles || []),
    ]);

    if (files.length === 0) {
      continue;
    }

    fileIntentsByWorkItem.set(workItem.id, files);
  }

  const conflicts = new Set<string>();
  for (let leftIndex = 0; leftIndex < workItems.length; leftIndex++) {
    const left = workItems[leftIndex];
    const leftFiles = fileIntentsByWorkItem.get(left.id) ?? [];
    for (let rightIndex = leftIndex + 1; rightIndex < workItems.length; rightIndex++) {
      const right = workItems[rightIndex];
      const rightFiles = fileIntentsByWorkItem.get(right.id) ?? [];
      if (doWorkItemFileIntentsOverlap(leftFiles, rightFiles)) {
        conflicts.add(left.id);
        conflicts.add(right.id);
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

  const workItemToGroup = new Map<string, number>();
  let nextGroupId = 0;

  for (const workItem of workItems) {
    const files = normalizeWorkItemFiles([
      ...(workItem.filesToModify || []),
      ...(workItem.filesToCreate || []),
      ...(workItem.patternFiles || []),
    ]);

    if (files.length === 0) {
      workItemToGroup.set(workItem.id, nextGroupId++);
      continue;
    }

    const relatedGroups = new Set<number>();
    for (const previousWorkItem of workItems) {
      const groupId = workItemToGroup.get(previousWorkItem.id);
      if (groupId === undefined) {
        continue;
      }
      const previousFiles = normalizeWorkItemFiles([
        ...(previousWorkItem.filesToModify || []),
        ...(previousWorkItem.filesToCreate || []),
        ...(previousWorkItem.patternFiles || []),
      ]);
      if (doWorkItemFileIntentsOverlap(files, previousFiles)) {
        relatedGroups.add(groupId);
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

  return Array.from(groups.values()).filter((group) => group.length > 0);
}

function normalizeWorkItemFiles(files: string[]): string[] {
  return [...new Set(files
    .map(normalizeWorkItemFileIntent)
    .filter(Boolean))];
}

function normalizeWorkItemFileIntent(file: string): string {
  const normalized = file.trim().replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  if (!normalized || normalized === '.') {
    return '';
  }

  const wildcardIndex = normalized.search(/[*?[{]/);
  const stablePrefix = wildcardIndex >= 0 ? normalized.slice(0, wildcardIndex) : normalized;
  const pathLike = stablePrefix.replace(/\/+$/, '');
  const intentPath = pathLike || '.';
  const normalizedPath = pathPosix.normalize(intentPath).replace(/\/+$/, '');
  return normalizedPath === '.' ? '' : normalizedPath;
}

function doWorkItemFileIntentsOverlap(leftFiles: string[], rightFiles: string[]): boolean {
  for (const leftFile of leftFiles) {
    for (const rightFile of rightFiles) {
      if (doWorkItemPathsOverlap(leftFile, rightFile)) {
        return true;
      }
    }
  }
  return false;
}

function doWorkItemPathsOverlap(leftPath: string, rightPath: string): boolean {
  return (
    leftPath === rightPath ||
    leftPath.startsWith(`${rightPath}/`) ||
    rightPath.startsWith(`${leftPath}/`)
  );
}
