import {
  detectAutocodeWorkConflicts,
  groupAutocodeConflictingWorkItems,
} from '@autocode/core';
import type { ConflictGraph, WorkItemInfo } from './work-executor-types';

/**
 * Detects file conflicts between work items.
 *
 * A conflict occurs when multiple work items modify or create the same file.
 */
export function detectFileConflicts(workItems: WorkItemInfo[]): ConflictGraph {
  return detectAutocodeWorkConflicts(workItems);
}

/**
 * Groups conflicting work items by shared files.
 */
export function groupConflictingWorkItems(workItems: WorkItemInfo[]): WorkItemInfo[][] {
  return groupAutocodeConflictingWorkItems(workItems);
}
