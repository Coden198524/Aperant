/**
 * Reusable work item conflict detection for Autocode runtimes.
 *
 * This module is intentionally host-agnostic so desktop, CLI, and IDE
 * integrations can share the same concurrency grouping decisions.
 */

import { posix as pathPosix } from 'node:path';

export interface AutocodeWorkConflictItem {
  id: string;
  filesToCreate?: string[];
  filesToModify?: string[];
  patternFiles?: string[];
}

export interface AutocodeWorkConflictGraph<T extends AutocodeWorkConflictItem> {
  independent: T[][];
  sequential: T[];
}

/**
 * Detects file conflicts between work items.
 *
 * A conflict occurs when multiple work items modify or create the same file,
 * or when one item's file intent is a parent path of another item's intent.
 */
export function detectAutocodeWorkConflicts<T extends AutocodeWorkConflictItem>(
  workItems: T[],
): AutocodeWorkConflictGraph<T> {
  const fileIntentsByWorkItem = buildAutocodeFileIntentMap(workItems);
  const conflicts = new Set<string>();

  for (let leftIndex = 0; leftIndex < workItems.length; leftIndex++) {
    const left = workItems[leftIndex];
    const leftFiles = fileIntentsByWorkItem.get(left.id) ?? [];
    if (leftFiles.length === 0) {
      continue;
    }

    for (let rightIndex = leftIndex + 1; rightIndex < workItems.length; rightIndex++) {
      const right = workItems[rightIndex];
      const rightFiles = fileIntentsByWorkItem.get(right.id) ?? [];
      if (doAutocodeWorkItemFileIntentsOverlap(leftFiles, rightFiles)) {
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
 * Groups work items by overlapping file intent.
 */
export function groupAutocodeConflictingWorkItems<T extends AutocodeWorkConflictItem>(workItems: T[]): T[][] {
  if (workItems.length === 0) {
    return [];
  }

  const fileIntentsByWorkItem = buildAutocodeFileIntentMap(workItems);
  const parent = new Map<string, string>();

  for (const workItem of workItems) {
    parent.set(workItem.id, workItem.id);
  }

  for (let leftIndex = 0; leftIndex < workItems.length; leftIndex++) {
    const left = workItems[leftIndex];
    const leftFiles = fileIntentsByWorkItem.get(left.id) ?? [];
    if (leftFiles.length === 0) {
      continue;
    }

    for (let rightIndex = leftIndex + 1; rightIndex < workItems.length; rightIndex++) {
      const right = workItems[rightIndex];
      const rightFiles = fileIntentsByWorkItem.get(right.id) ?? [];
      if (doAutocodeWorkItemFileIntentsOverlap(leftFiles, rightFiles)) {
        unionAutocodeWorkItem(parent, left.id, right.id);
      }
    }
  }

  const groups = new Map<string, T[]>();
  for (const workItem of workItems) {
    const groupId = findAutocodeWorkItemRoot(parent, workItem.id);
    const group = groups.get(groupId) ?? [];
    group.push(workItem);
    groups.set(groupId, group);
  }

  return Array.from(groups.values()).filter((group) => group.length > 0);
}

function buildAutocodeFileIntentMap<T extends AutocodeWorkConflictItem>(workItems: T[]): Map<string, string[]> {
  const fileIntentsByWorkItem = new Map<string, string[]>();

  for (const workItem of workItems) {
    const files = normalizeAutocodeWorkItemFiles([
      ...(workItem.filesToModify || []),
      ...(workItem.filesToCreate || []),
      ...(workItem.patternFiles || []),
    ]);

    if (files.length > 0) {
      fileIntentsByWorkItem.set(workItem.id, files);
    }
  }

  return fileIntentsByWorkItem;
}

function findAutocodeWorkItemRoot(parent: Map<string, string>, id: string): string {
  const current = parent.get(id);
  if (!current || current === id) {
    return id;
  }

  const root = findAutocodeWorkItemRoot(parent, current);
  parent.set(id, root);
  return root;
}

function unionAutocodeWorkItem(parent: Map<string, string>, left: string, right: string): void {
  const leftRoot = findAutocodeWorkItemRoot(parent, left);
  const rightRoot = findAutocodeWorkItemRoot(parent, right);
  if (leftRoot !== rightRoot) {
    parent.set(rightRoot, leftRoot);
  }
}

function normalizeAutocodeWorkItemFiles(files: string[]): string[] {
  return [...new Set(files
    .map(normalizeAutocodeWorkItemFileIntent)
    .filter(Boolean))];
}

function normalizeAutocodeWorkItemFileIntent(file: string): string {
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

function doAutocodeWorkItemFileIntentsOverlap(leftFiles: string[], rightFiles: string[]): boolean {
  for (const leftFile of leftFiles) {
    for (const rightFile of rightFiles) {
      if (doAutocodeWorkItemPathsOverlap(leftFile, rightFile)) {
        return true;
      }
    }
  }
  return false;
}

function doAutocodeWorkItemPathsOverlap(leftPath: string, rightPath: string): boolean {
  return (
    leftPath === rightPath ||
    leftPath.startsWith(`${rightPath}/`) ||
    rightPath.startsWith(`${leftPath}/`)
  );
}
