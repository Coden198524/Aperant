/**
 * Batch Prompt Generator
 * =======================
 *
 * Generates prompts for batch subtask execution.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchPromptConfig, SubtaskInfo } from './batch-types';

// =============================================================================
// Constants
// =============================================================================

/** Maximum lines to read from pattern files */
const MAX_PATTERN_FILE_LINES = 200;

// =============================================================================
// Prompt Generation
// =============================================================================

/**
 * Generates a batch prompt for multiple subtasks.
 *
 * @param config - Batch prompt configuration
 * @returns Generated prompt string
 */
export async function generateBatchPrompt(config: BatchPromptConfig): Promise<string> {
  const { subtasks, specDir, projectDir, attemptCount, isContinuation, previousProgress } = config;

  const sections: string[] = [];

  // 1. Environment context
  sections.push(generateEnvironmentContext(projectDir, specDir));

  // 2. Continuation context (if applicable)
  if (isContinuation && previousProgress) {
    sections.push(generateContinuationContext(previousProgress));
  }

  // 3. Task manifest
  sections.push(generateTaskManifest(subtasks));

  // 4. Batch execution instructions
  sections.push(generateBatchInstructions(subtasks.length, attemptCount));

  // 5. Pattern files (merged and deduplicated)
  const patternFilesSection = await loadPatternFiles(subtasks, projectDir);
  if (patternFilesSection) {
    sections.push(patternFilesSection);
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Generates environment context section.
 *
 * @param projectDir - Project directory
 * @param specDir - Spec directory
 * @returns Environment context string
 */
function generateEnvironmentContext(projectDir: string, specDir: string): string {
  return `# Environment

**Project directory**: ${projectDir}
**Spec directory**: ${specDir}

Work in the project directory and implement the subtasks defined in the spec.`;
}

/**
 * Generates continuation context section.
 *
 * @param previousProgress - Previous progress information
 * @returns Continuation context string
 */
function generateContinuationContext(previousProgress: {
  completed: string[];
  inProgress: string[];
  blocked: string[];
  notStarted: string[];
}): string {
  return `# Continuation

This is a continuation session after the previous context window ended.
**Completed**: ${previousProgress.completed.length}
**In progress**: ${previousProgress.inProgress.length}
**Blocked**: ${previousProgress.blocked.length}
**Not started**: ${previousProgress.notStarted.length}

Continue with the remaining subtasks.`;
}

/**
 * Generates task manifest section.
 *
 * @param subtasks - Array of subtasks
 * @returns Task manifest string
 */
function generateTaskManifest(subtasks: SubtaskInfo[]): string {
  const manifest = subtasks
    .map((st, i) => {
      const fileOps: string[] = [];
      if (st.filesToCreate && st.filesToCreate.length > 0) {
        fileOps.push(`- Create: ${st.filesToCreate.join(', ')}`);
      }
      if (st.filesToModify && st.filesToModify.length > 0) {
        fileOps.push(`- Modify: ${st.filesToModify.join(', ')}`);
      }

      return `### Subtask ${i + 1}/${subtasks.length}: ${st.id}

**Description**: ${st.description}

${fileOps.length > 0 ? `**File operations**:\n${fileOps.join('\n')}` : ''}

${st.verification ? `**Verification**: ${st.verification}` : ''}`;
    })
    .join('\n\n');

  return `## Task Manifest

Complete the following ${subtasks.length} subtasks in order:
${manifest}`;
}

/**
 * Generates batch execution instructions.
 *
 * @param count - Number of subtasks
 * @param attempt - Attempt count
 * @returns Batch instructions string
 */
function generateBatchInstructions(count: number, attempt: number): string {
  const retryContext =
    attempt > 0
      ? `
### Retry context
This is attempt ${attempt + 1}. A previous batch run did not fully complete, so pay special attention to unfinished subtasks.`
      : '';

  return `## Execution Protocol

You will complete ${count} subtasks in one session.

### 1. Execution order
- Complete subtasks strictly in order, from 1 through ${count}.
- Do not skip subtasks.
- If a subtask is blocked, mark it as [-] in implementation_plan.md and continue with the next subtask.

### 2. Progress tracking
After each subtask:
1. Update implementation_plan.md, mark the subtask as [x], and add \`_Completion: ..._\`.
2. Include the progress marker \`[SUBTASK_COMPLETED: {id}]\` in your output.
3. Commit code every 2-3 subtasks when practical.

### 3. Verification
- Run the relevant verification after each subtask.
- Fix verification failures before continuing.
- Do not skip verification.

### 4. Quality bar
- Follow the style in referenced pattern files.
- Avoid stray debug logging.
- Handle errors deliberately.
- Keep the code focused and clean.
${retryContext}
## Start
Start these ${count} subtasks now. Work in order, verify, update status, and commit as needed.`;
}

/**
 * Loads and merges pattern files from all subtasks.
 *
 * @param subtasks - Array of subtasks
 * @param projectDir - Project directory
 * @returns Pattern files section string, or null if no pattern files
 */
async function loadPatternFiles(
  subtasks: SubtaskInfo[],
  projectDir: string
): Promise<string | null> {
  // Collect unique pattern files
  const patternFiles = new Set<string>();
  for (const subtask of subtasks) {
    if (subtask.patternFiles) {
      for (const file of subtask.patternFiles) {
        patternFiles.add(file);
      }
    }
  }

  if (patternFiles.size === 0) {
    return null;
  }

  // Load pattern files
  const loadedFiles: Array<{ path: string; content: string }> = [];

  for (const file of patternFiles) {
    try {
      const filePath = join(projectDir, file);
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      // Truncate if too long
      const truncated =
        lines.length > MAX_PATTERN_FILE_LINES
          ? lines.slice(0, MAX_PATTERN_FILE_LINES).join('\n') +
            `\n\n... (truncated, ${lines.length - MAX_PATTERN_FILE_LINES} more lines)`
          : content;

      loadedFiles.push({ path: file, content: truncated });
    } catch (error) {
      console.warn(`[BatchPromptGenerator] Failed to load pattern file ${file}:`, error);
    }
  }

  if (loadedFiles.length === 0) {
    return null;
  }

  // Format pattern files section
  const filesSection = loadedFiles
    .map(
      (f) => `### ${f.path}

\`\`\`
${f.content}
\`\`\``
    )
    .join('\n\n');

  return `## Pattern Files

Use these related files as style and implementation references:
${filesSection}`;
}

/**
 * Collects unique pattern files from all subtasks.
 *
 * @param subtasks - Array of subtasks
 * @returns Array of unique pattern file paths
 */
export function collectUniquePatterns(subtasks: SubtaskInfo[]): string[] {
  const patterns = new Set<string>();

  for (const subtask of subtasks) {
    if (subtask.patternFiles) {
      for (const file of subtask.patternFiles) {
        patterns.add(file);
      }
    }
  }

  return Array.from(patterns);
}
