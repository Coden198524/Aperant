import { join, resolve, sep } from 'node:path';
import {
  AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME,
  AUTOCODE_PROJECT_DATA_DIR_NAME,
  getAutocodeSpecsRelativeDir,
  normalizeAutocodeProjectDataDirName,
} from './artifacts.js';

export const AUTOCODE_WORKTREES_DIR_NAME = 'worktrees';
export const AUTOCODE_TASK_WORKTREES_DIR_NAME = 'tasks';
export const AUTOCODE_TERMINAL_WORKTREES_DIR_NAME = 'terminal';
export const AUTOCODE_PR_WORKTREES_DIR_NAME = 'pr';
export const AUTOCODE_TERMINAL_METADATA_DIR_NAME = 'metadata';
export const AUTOCODE_LEGACY_WORKTREE_DIR_NAME = '.worktrees';

export function isValidAutocodePathId(value: string | null | undefined): value is string {
  if (!value || typeof value !== 'string') {
    return false;
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  return value !== '.' && value !== '..';
}

export function getAutocodeTaskWorktreesRelativeDir(dataDirName?: string): string {
  return [
    normalizeAutocodeProjectDataDirName(dataDirName),
    AUTOCODE_WORKTREES_DIR_NAME,
    AUTOCODE_TASK_WORKTREES_DIR_NAME,
  ].join('/');
}

export function getAutocodeLegacyTaskWorktreesRelativeDir(): string {
  return [
    AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME,
    AUTOCODE_WORKTREES_DIR_NAME,
    AUTOCODE_TASK_WORKTREES_DIR_NAME,
  ].join('/');
}

export function getAutocodeTerminalWorktreesRelativeDir(dataDirName?: string): string {
  return [
    normalizeAutocodeProjectDataDirName(dataDirName),
    AUTOCODE_WORKTREES_DIR_NAME,
    AUTOCODE_TERMINAL_WORKTREES_DIR_NAME,
  ].join('/');
}

export function getAutocodePrWorktreesRelativeDir(dataDirName?: string): string {
  return [
    normalizeAutocodeProjectDataDirName(dataDirName),
    AUTOCODE_WORKTREES_DIR_NAME,
    AUTOCODE_PR_WORKTREES_DIR_NAME,
  ].join('/');
}

export function getAutocodeLegacyTerminalWorktreesRelativeDir(): string {
  return [
    AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME,
    AUTOCODE_WORKTREES_DIR_NAME,
    AUTOCODE_TERMINAL_WORKTREES_DIR_NAME,
  ].join('/');
}

export function getAutocodeTerminalMetadataRelativeDir(dataDirName?: string): string {
  return [
    normalizeAutocodeProjectDataDirName(dataDirName),
    AUTOCODE_TERMINAL_WORKTREES_DIR_NAME,
    AUTOCODE_TERMINAL_METADATA_DIR_NAME,
  ].join('/');
}

export function getAutocodeTaskWorktreeDir(projectRoot: string, dataDirName?: string): string {
  return join(projectRoot, getAutocodeTaskWorktreesRelativeDir(dataDirName));
}

export function getAutocodeTaskWorktreePath(
  projectRoot: string,
  specId: string,
  dataDirName?: string,
): string {
  return join(getAutocodeTaskWorktreeDir(projectRoot, dataDirName), specId);
}

export function getAutocodeLegacyFlatTaskWorktreePath(
  projectRoot: string,
  specId: string,
  dataDirName?: string,
): string {
  return join(projectRoot, normalizeAutocodeProjectDataDirName(dataDirName), AUTOCODE_WORKTREES_DIR_NAME, specId);
}

export function getAutocodeTaskWorktreeSpecDir(
  projectRoot: string,
  worktreeName: string,
  specId: string,
  dataDirName?: string,
): string {
  return join(
    getAutocodeTaskWorktreePath(projectRoot, worktreeName, dataDirName),
    getAutocodeSpecsRelativeDir(dataDirName),
    specId,
  );
}

export function getAutocodeTerminalWorktreeDir(projectRoot: string, dataDirName?: string): string {
  return join(projectRoot, getAutocodeTerminalWorktreesRelativeDir(dataDirName));
}

export function getAutocodePrWorktreeDir(projectRoot: string, dataDirName?: string): string {
  return join(projectRoot, getAutocodePrWorktreesRelativeDir(dataDirName));
}

export function getAutocodeTerminalWorktreePath(
  projectRoot: string,
  name: string,
  dataDirName?: string,
): string {
  return join(getAutocodeTerminalWorktreeDir(projectRoot, dataDirName), name);
}

export function getAutocodeTerminalMetadataDir(projectRoot: string, dataDirName?: string): string {
  return join(projectRoot, getAutocodeTerminalMetadataRelativeDir(dataDirName));
}

export function getAutocodeTerminalMetadataPath(
  projectRoot: string,
  name: string,
  dataDirName?: string,
): string {
  return join(getAutocodeTerminalMetadataDir(projectRoot, dataDirName), `${name}.json`);
}

export function isAutocodePathWithinBase(targetPath: string, basePath: string): boolean {
  const normalizedPath = resolve(targetPath);
  const normalizedBase = resolve(basePath);
  return normalizedPath === normalizedBase || normalizedPath.startsWith(normalizedBase + sep);
}

export function getAutocodeTaskWorktreeCandidatePaths(projectRoot: string, specId: string): string[] {
  return [
    getAutocodeTaskWorktreePath(projectRoot, specId, AUTOCODE_PROJECT_DATA_DIR_NAME),
    getAutocodeTaskWorktreePath(projectRoot, specId, AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME),
    getAutocodeLegacyFlatTaskWorktreePath(projectRoot, specId, AUTOCODE_PROJECT_DATA_DIR_NAME),
    join(projectRoot, AUTOCODE_LEGACY_WORKTREE_DIR_NAME, specId),
  ];
}

export function getAutocodeTerminalWorktreeCandidatePaths(projectRoot: string, name: string): string[] {
  return [
    getAutocodeTerminalWorktreePath(projectRoot, name, AUTOCODE_PROJECT_DATA_DIR_NAME),
    getAutocodeTerminalWorktreePath(projectRoot, name, AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME),
    join(projectRoot, AUTOCODE_LEGACY_WORKTREE_DIR_NAME, `terminal-${name}`),
  ];
}
