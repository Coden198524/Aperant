/**
 * Shared worktree path utilities
 *
 * Centralizes all worktree path constants and helper functions to avoid duplication
 * and ensure consistent path handling across the application.
 */

import path from 'path';
import { existsSync } from 'fs';
import {
  AUTOCODE_LEGACY_WORKTREE_DIR_NAME,
  getAutocodeLegacyTaskWorktreesRelativeDir,
  getAutocodeLegacyTerminalWorktreesRelativeDir,
  getAutocodeTaskWorktreeCandidatePaths,
  getAutocodeTaskWorktreeDir,
  getAutocodeTaskWorktreePath,
  getAutocodeTaskWorktreesRelativeDir,
  getAutocodeTerminalMetadataDir,
  getAutocodeTerminalMetadataPath,
  getAutocodeTerminalMetadataRelativeDir,
  getAutocodeTerminalWorktreeCandidatePaths,
  getAutocodeTerminalWorktreeDir,
  getAutocodeTerminalWorktreePath,
  getAutocodeTerminalWorktreesRelativeDir,
  isAutocodePathWithinBase,
} from '@autocode/core';
import { debugLog } from '../shared/utils/debug-logger';

// Path constants for worktree directories
export const TASK_WORKTREE_DIR = getAutocodeTaskWorktreesRelativeDir();
export const LEGACY_TASK_WORKTREE_DIR = getAutocodeLegacyTaskWorktreesRelativeDir();
export const TERMINAL_WORKTREE_DIR = getAutocodeTerminalWorktreesRelativeDir();
export const LEGACY_TERMINAL_WORKTREE_DIR = getAutocodeLegacyTerminalWorktreesRelativeDir();

// Metadata directories (separate from git worktrees to avoid uncommitted files)
export const TERMINAL_WORKTREE_METADATA_DIR = getAutocodeTerminalMetadataRelativeDir();

// Legacy path for backwards compatibility
export const LEGACY_WORKTREE_DIR = AUTOCODE_LEGACY_WORKTREE_DIR_NAME;

/**
 * Get the task worktrees directory path
 */
export function getTaskWorktreeDir(projectPath: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] getTaskWorktreeDir: projectPath is undefined or not a string');
    return '';
  }
  return getAutocodeTaskWorktreeDir(projectPath);
}

/**
 * Get the full path for a specific task worktree
 */
export function getTaskWorktreePath(projectPath: string, specId: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] getTaskWorktreePath: projectPath is undefined or not a string');
    return '';
  }
  if (!specId || typeof specId !== 'string') {
    console.error('[worktree-paths] getTaskWorktreePath: specId is undefined or not a string');
    return '';
  }
  return getAutocodeTaskWorktreePath(projectPath, specId);
}

/**
 * Validate that a resolved path is within the expected base directory
 * Protects against path traversal attacks (e.g., specId containing "..")
 */
export function isPathWithinBase(resolvedPath: string, basePath: string): boolean {
  return isAutocodePathWithinBase(resolvedPath, basePath);
}

/**
 * Find a task worktree path, checking new location first then legacy.
 * Returns the dedicated worktree path if found, null otherwise.
 * Includes path traversal protection to ensure paths stay within project
 */
export function findTaskWorktree(projectPath: string, specId: string): string | null {
  // Defensive check for undefined inputs
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] findTaskWorktree: projectPath is undefined or not a string');
    return null;
  }
  if (!specId || typeof specId !== 'string') {
    console.error('[worktree-paths] findTaskWorktree: specId is undefined or not a string');
    return null;
  }

  const normalizedProject = path.resolve(projectPath);

  for (const candidatePath of getAutocodeTaskWorktreeCandidatePaths(projectPath, specId)) {
    const resolvedCandidate = path.resolve(candidatePath);

    if (!isPathWithinBase(resolvedCandidate, normalizedProject)) {
      console.error(`[worktree-paths] Path traversal detected: specId "${specId}" resolves outside project`);
      return null;
    }

    if (existsSync(resolvedCandidate)) {
      debugLog('[worktree-paths] Found worktree at:', resolvedCandidate);
      return resolvedCandidate;
    }
  }

  debugLog('[worktree-paths] No dedicated worktree found for task:', specId);
  return null;
}

/**
 * Get the terminal worktrees directory path
 */
export function getTerminalWorktreeDir(projectPath: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] getTerminalWorktreeDir: projectPath is undefined or not a string');
    return '';
  }
  return getAutocodeTerminalWorktreeDir(projectPath);
}

/**
 * Get the full path for a specific terminal worktree
 */
export function getTerminalWorktreePath(projectPath: string, name: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] getTerminalWorktreePath: projectPath is undefined or not a string');
    return '';
  }
  if (!name || typeof name !== 'string') {
    console.error('[worktree-paths] getTerminalWorktreePath: name is undefined or not a string');
    return '';
  }
  return getAutocodeTerminalWorktreePath(projectPath, name);
}

/**
 * Find a terminal worktree path, checking new location first then legacy
 * Returns the path if found, null otherwise
 * Includes path traversal protection to ensure paths stay within project
 */
export function findTerminalWorktree(projectPath: string, name: string): string | null {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] findTerminalWorktree: projectPath is undefined or not a string');
    return null;
  }
  if (!name || typeof name !== 'string') {
    console.error('[worktree-paths] findTerminalWorktree: name is undefined or not a string');
    return null;
  }

  const normalizedProject = path.resolve(projectPath);

  for (const candidatePath of getAutocodeTerminalWorktreeCandidatePaths(projectPath, name)) {
    const resolvedCandidate = path.resolve(candidatePath);

    if (!isPathWithinBase(resolvedCandidate, normalizedProject)) {
      console.error(`[worktree-paths] Path traversal detected: name "${name}" resolves outside project`);
      return null;
    }

    if (existsSync(resolvedCandidate)) return resolvedCandidate;
  }

  return null;
}

/**
 * Get the terminal worktree metadata directory path
 * This is separate from the git worktree to avoid uncommitted files
 */
export function getTerminalWorktreeMetadataDir(projectPath: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] getTerminalWorktreeMetadataDir: projectPath is undefined or not a string');
    return '';
  }
  return getAutocodeTerminalMetadataDir(projectPath);
}

/**
 * Get the metadata file path for a specific terminal worktree
 */
export function getTerminalWorktreeMetadataPath(projectPath: string, name: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] getTerminalWorktreeMetadataPath: projectPath is undefined or not a string');
    return '';
  }
  if (!name || typeof name !== 'string') {
    console.error('[worktree-paths] getTerminalWorktreeMetadataPath: name is undefined or not a string');
    return '';
  }
  return getAutocodeTerminalMetadataPath(projectPath, name);
}
