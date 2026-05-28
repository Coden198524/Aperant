import {
  AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME,
  AUTOCODE_PROJECT_DATA_DIR_NAME,
} from '../tasks/artifacts.js';
import { AUTOCODE_LEGACY_WORKTREE_DIR_NAME } from '../tasks/worktree-paths.js';

export const AUTOCODE_TOOL_GENERATED_DIR_NAMES = [
  '.claude',
  '.codex',
  '.cursor',
  '.continue',
  '.windsurf',
  '.aider',
] as const;

export const AUTOCODE_DEPENDENCY_DIR_NAMES = [
  'node_modules',
  'bower_components',
  'vendor',
  'third_party',
  'third-party',
  'extern',
  'external',
  'venv',
  '.venv',
  '__pycache__',
] as const;

export const AUTOCODE_BUILD_OUTPUT_DIR_NAMES = [
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'bin',
  'obj',
] as const;

export const AUTOCODE_TASK_GIT_CHANGE_HIDDEN_DIR_NAMES = [
  '.git',
  ...AUTOCODE_TOOL_GENERATED_DIR_NAMES,
  AUTOCODE_PROJECT_DATA_DIR_NAME,
  AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME,
] as const;

export const AUTOCODE_GENERATED_DIR_NAMES = [
  AUTOCODE_PROJECT_DATA_DIR_NAME,
  AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME,
  AUTOCODE_LEGACY_WORKTREE_DIR_NAME,
] as const;

export const AUTOCODE_COMMON_IGNORED_DIR_NAMES = [
  ...AUTOCODE_TASK_GIT_CHANGE_HIDDEN_DIR_NAMES,
  ...AUTOCODE_GENERATED_DIR_NAMES,
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.gradle',
  '.maven',
  '.idea',
  '.vscode',
  '.pytest_cache',
  '.mypy_cache',
  ...AUTOCODE_DEPENDENCY_DIR_NAMES,
  ...AUTOCODE_BUILD_OUTPUT_DIR_NAMES,
];

export const AUTOCODE_PROMPT_IGNORED_DIR_NAMES = [
  ...AUTOCODE_BUILD_OUTPUT_DIR_NAMES,
  ...AUTOCODE_TOOL_GENERATED_DIR_NAMES,
  '.git',
  AUTOCODE_PROJECT_DATA_DIR_NAME,
  AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME,
  ...AUTOCODE_DEPENDENCY_DIR_NAMES,
];

const TASK_GIT_CHANGE_HIDDEN_DIR_SET = toLowerCaseSet(AUTOCODE_TASK_GIT_CHANGE_HIDDEN_DIR_NAMES);
const GENERATED_DIR_SET = toLowerCaseSet(AUTOCODE_GENERATED_DIR_NAMES);
const COMMON_IGNORED_DIR_SET = toLowerCaseSet(AUTOCODE_COMMON_IGNORED_DIR_NAMES);

function toLowerCaseSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

export function normalizeAutocodeRelativePathSegments(filePath: string): string[] {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split('/')
    .filter(Boolean);
}

export function shouldHideAutocodeTaskGitChangePath(filePath: string | undefined | null): boolean {
  if (!filePath) return false;
  const [firstSegment] = normalizeAutocodeRelativePathSegments(filePath);
  return firstSegment ? TASK_GIT_CHANGE_HIDDEN_DIR_SET.has(firstSegment.toLowerCase()) : false;
}

export function isAutocodeGeneratedPath(filePath: string | undefined | null): boolean {
  if (!filePath) return false;
  return normalizeAutocodeRelativePathSegments(filePath).some((segment) =>
    GENERATED_DIR_SET.has(segment.toLowerCase()),
  );
}

export function isAutocodeProjectDataPath(
  filePath: string | undefined | null,
  dataDirName = AUTOCODE_PROJECT_DATA_DIR_NAME,
): boolean {
  if (!filePath) return false;
  const [firstSegment] = normalizeAutocodeRelativePathSegments(filePath);
  if (!firstSegment) return false;
  const normalized = firstSegment.toLowerCase();
  return normalized === dataDirName.toLowerCase() ||
    normalized === AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME.toLowerCase();
}

export function shouldSkipAutocodeWorkspaceDir(dirName: string): boolean {
  return COMMON_IGNORED_DIR_SET.has(dirName.toLowerCase());
}

export function shouldSkipAutocodeWorkspacePath(filePath: string): boolean {
  return normalizeAutocodeRelativePathSegments(filePath).some((segment) =>
    COMMON_IGNORED_DIR_SET.has(segment.toLowerCase()),
  );
}

export function formatAutocodeIgnoredDirNamesForPrompt(
  dirNames: readonly string[] = AUTOCODE_PROMPT_IGNORED_DIR_NAMES,
): string {
  return Array.from(new Set(dirNames)).join(', ');
}
