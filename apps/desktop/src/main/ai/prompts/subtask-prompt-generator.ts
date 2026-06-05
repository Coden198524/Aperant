/**
 * Subtask Prompt Generator
 * ========================
 *
 * Generates minimal, focused prompts for each subtask and planner invocation.
 * See apps/desktop/src/main/ai/prompts/subtask-prompt-generator.ts for the TypeScript implementation.
 *
 * Instead of a 900-line mega-prompt, each subtask gets a tailored ~100-line
 * prompt with only the context it needs. This reduces token usage by ~80%
 * and keeps the agent focused on ONE task.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildAutocodePlannerPrompt,
  buildAutocodeSubtaskPrompt,
  calculateAutocodeStringSimilarity,
  generateAutocodeWorktreeIsolationWarning,
  validateAutocodeProjectRelativePath,
} from '@autocode/core/runtime/agent-subtask-prompts';
import { shouldSkipAutocodeWorkspaceDir } from '@autocode/core/workspace/ignore-rules';

import { loadPrompt } from './prompt-loader';
import type {
  PlannerPromptConfig,
  SubtaskPromptConfig,
  SubtaskContext,
  SubtaskPromptInfo,
} from './types';

/**
 * Generate the worktree isolation warning section for prompts.
 * Mirrors generate_worktree_isolation_warning() from Python.
 */
export function generateWorktreeIsolationWarning(
  projectDir: string,
  parentProjectPath: string,
): string {
  return generateAutocodeWorktreeIsolationWarning(projectDir, parentProjectPath);
}

// =============================================================================
// Planner Prompt Generator
// =============================================================================

/**
 * Generate the planner prompt (used once at start of planning phase).
 * Mirrors generate_planner_prompt() from Python.
 *
 * @param config - Planner prompt configuration
 * @returns Assembled planner prompt
 */
export async function generatePlannerPrompt(config: PlannerPromptConfig): Promise<string> {
  const { specDir, projectDir, projectInstructions, planningRetryContext } = config;

  const basePlannerPrompt = loadPrompt('planner');

  return buildAutocodePlannerPrompt({
    specDir,
    projectDir,
    basePlannerPrompt,
    projectInstructions,
    planningRetryContext,
  });
}

// =============================================================================
// Subtask Prompt Generator
// =============================================================================

/**
 * Generate a minimal, focused prompt for implementing a single subtask.
 * Mirrors generate_subtask_prompt() from Python.
 *
 * @param config - Subtask prompt configuration
 * @returns Focused subtask prompt (~100 lines instead of 900)
 */
export async function generateSubtaskPrompt(config: SubtaskPromptConfig): Promise<string> {
  const {
    specDir,
    projectDir,
    subtask,
    phase,
    attemptCount = 0,
    recoveryHints,
    projectInstructions,
  } = config;

  let context: SubtaskContext | null = null;
  try {
    context = await loadSubtaskContext(specDir, projectDir, subtask);
  } catch {
    // Non-fatal: context loading is best-effort
  }

  return buildAutocodeSubtaskPrompt({
    specDir,
    projectDir,
    subtask,
    phase,
    attemptCount,
    recoveryHints,
    projectInstructions,
    context,
  });
}

// =============================================================================
// Subtask Context Loader
// =============================================================================

/**
 * Load minimal file context needed for a subtask.
 * Mirrors load_subtask_context() from Python.
 *
 * @param specDir - Spec directory
 * @param projectDir - Project root
 * @param subtask - Subtask definition
 * @param maxFileLines - Maximum lines to include per file (default: 200)
 * @returns Loaded context dict
 */
export async function loadSubtaskContext(
  specDir: string,
  projectDir: string,
  subtask: SubtaskPromptInfo,
  maxFileLines = 200,
): Promise<SubtaskContext> {
  const context: SubtaskContext = {
    patterns: {},
    filesToModify: {},
    specExcerpt: null,
  };

  // Load pattern files
  for (const patternPath of (subtask.patternsFrom ?? [])) {
    const fullPath = join(projectDir, patternPath);
    const validPath = validateAndResolvePath(fullPath, projectDir);
    if (!validPath) continue;

    try {
      const content = await readFileTruncated(validPath, maxFileLines);
      context.patterns[patternPath] = content;
    } catch {
      context.patterns[patternPath] = '(Could not read file)';
    }
  }

  // Load files to modify
  for (const filePath of (subtask.filesToModify ?? [])) {
    const fullPath = join(projectDir, filePath);

    // Try fuzzy correction if file doesn't exist
    const resolvedPath = existsSync(fullPath)
      ? fullPath
      : await fuzzyFindFile(projectDir, filePath);

    if (!resolvedPath) continue;

    const validPath = validateAndResolvePath(resolvedPath, projectDir);
    if (!validPath) continue;

    try {
      const content = await readFileTruncated(validPath, maxFileLines);
      context.filesToModify[filePath] = content;
    } catch {
      context.filesToModify[filePath] = '(Could not read file)';
    }
  }

  return context;
}

// =============================================================================
// File Utilities
// =============================================================================

/**
 * Read a file, truncating if it exceeds maxLines.
 */
async function readFileTruncated(filePath: string, maxLines: number): Promise<string> {
  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.split('\n');

  if (lines.length <= maxLines) {
    return raw;
  }

  return (
    lines.slice(0, maxLines).join('\n') +
    `\n\n... (truncated, ${lines.length - maxLines} more lines)`
  );
}

/**
 * Validate that a path stays within the project root (path traversal guard).
 * Returns the resolved path if safe, null otherwise.
 */
function validateAndResolvePath(filePath: string, projectRoot: string): string | null {
  return validateAutocodeProjectRelativePath(filePath, projectRoot);
}

/**
 * Fuzzy file finder with similarity cutoff of 0.6.
 * If a referenced file doesn't exist, try to find the closest match.
 *
 * @param projectDir - Project root to search within
 * @param targetPath - Relative path that doesn't exist
 * @returns Best matching file path, or null if no close match
 */
async function fuzzyFindFile(
  projectDir: string,
  targetPath: string,
): Promise<string | null> {
  try {
    // Get the target filename for comparison
    const targetParts = targetPath.replace(/\\/g, '/').split('/');
    const targetFilename = targetParts[targetParts.length - 1];

    // Build a list of candidate files (limited search for performance)
    const candidates = collectFiles(projectDir, 5000);

    let bestMatch: string | null = null;
    let bestScore = 0.6; // Minimum similarity threshold

    for (const candidate of candidates) {
      const score = stringSimilarity(targetFilename, candidate.name);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate.path;
      }
    }

    return bestMatch;
  } catch {
    return null;
  }
}

/**
 * Collect files from a directory (breadth-first, limited count).
 */
function collectFiles(
  dir: string,
  maxCount: number,
): Array<{ name: string; path: string }> {
  const results: Array<{ name: string; path: string }> = [];

  function walk(currentDir: string, depth: number): void {
    if (results.length >= maxCount || depth > 8) return;

    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= maxCount) break;

        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !shouldSkipAutocodeWorkspaceDir(entry.name)) {
            walk(join(currentDir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          results.push({
            name: entry.name,
            path: join(currentDir, entry.name),
          });
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  walk(dir, 0);
  return results;
}

/**
 * Compute string similarity between two strings (simple ratio).
 * Returns a value between 0 and 1.
 */
function stringSimilarity(a: string, b: string): number {
  return calculateAutocodeStringSimilarity(a, b);
}
