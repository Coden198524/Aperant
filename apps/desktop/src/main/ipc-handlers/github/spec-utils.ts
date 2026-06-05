/**
 * Utility functions for spec creation and management
 */

import path from 'path';
import {
  AUTOCODE_PROJECT_DATA_DIR_NAME,
  AUTOCODE_TASK_ARTIFACTS,
  createImportedAutocodeTask,
  buildAutocodeSpecId,
  loadAutocodeImplementationPlanSync,
  saveAutocodeImplementationPlanSync,
} from '@autocode/core';
import {
  buildGitHubInvestigationTask,
  buildGitHubIssueContext,
} from '@autocode/core/integrations/github';
import { determineAutocodeTaskCategoryFromLabels } from '@autocode/core/integrations/common';
import type { Project, TaskMetadata } from '../../../shared/types';
import { withSpecNumberLock } from '../../utils/spec-number-lock';
import { debugLog } from './utils/logger';
import { sanitizeText, sanitizeStringArray, sanitizeUrl } from '../shared/sanitize';

export interface SpecCreationData {
  specId: string;
  specDir: string;
  taskDescription: string;
  metadata: TaskMetadata;
}

/**
 * Determine task category based on GitHub issue labels
 * Maps to TaskCategory type from shared/types/task.ts
 */
function determineCategoryFromLabels(labels: string[]): 'feature' | 'bug_fix' | 'refactoring' | 'documentation' | 'security' | 'performance' | 'ui_ux' | 'infrastructure' | 'testing' {
  return determineAutocodeTaskCategoryFromLabels(labels);
}

/**
 * Create a new spec directory and initial files
 * Uses coordinated spec numbering to prevent collisions across worktrees
 */
export async function createSpecForIssue(
  project: Project,
  issueNumber: number,
  issueTitle: string,
  taskDescription: string,
  githubUrl: string,
  labels: string[] = [],
  baseBranch?: string
): Promise<SpecCreationData> {
  // Sanitize network-sourced data before writing to disk
  const safeTitle = sanitizeText(issueTitle, 500);
  const safeDescription = sanitizeText(taskDescription, 50000, true);
  const safeGithubUrl = sanitizeUrl(githubUrl);
  const safeLabels = sanitizeStringArray(labels, 50, 200);

  // Use coordinated spec numbering with lock to prevent collisions
  return await withSpecNumberLock(project.path, async (lock) => {
    // Get next spec number from global scan (main + all worktrees)
    const specNumber = lock.getNextSpecNumber(project.autoBuildPath);
    const specId = buildAutocodeSpecId(specNumber, safeTitle);

    // Determine category from GitHub issue labels
    const category = determineCategoryFromLabels(safeLabels);

    const metadata = {
      sourceType: 'github',
      githubIssueNumber: issueNumber,
      githubUrl: safeGithubUrl,
      category,
      // Store baseBranch for worktree creation and QA comparison
      // This comes from project.settings.mainBranch or task-level override
      ...(baseBranch && { baseBranch })
    } satisfies TaskMetadata & { sourceType: 'github' };

    const task = createImportedAutocodeTask({
      projectRoot: project.path,
      dataDirName: project.autoBuildPath || AUTOCODE_PROJECT_DATA_DIR_NAME,
      specId,
      title: safeTitle,
      description: safeDescription,
      metadata,
      requirements: {
        workflow_type: 'feature',
      },
    });

    return {
      specId: task.specId,
      specDir: task.specsPath,
      taskDescription: safeDescription,
      metadata
    };
  });
}

/**
 * Build issue context with comments
 */
export function buildIssueContext(
  issueNumber: number,
  issueTitle: string,
  issueBody: string | undefined,
  labels: string[],
  htmlUrl: string,
  comments: Array<{ body: string; user: { login: string } }>
): string {
  return buildGitHubIssueContext(issueNumber, issueTitle, issueBody, labels, htmlUrl, comments);
}

/**
 * Build investigation task description
 */
export function buildInvestigationTask(
  issueNumber: number,
  issueTitle: string,
  issueContext: string
): string {
  return buildGitHubInvestigationTask(issueNumber, issueTitle, issueContext);
}

/**
 * Update implementation plan status
 * Used to immediately update the plan file so the frontend shows the correct status
 */
export function updateImplementationPlanStatus(specDir: string, status: string): void {
  const planPath = path.join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);

  try {
    const plan = loadAutocodeImplementationPlanSync(planPath) as Record<string, unknown> | null;
    if (!plan) {
      return;
    }
    plan.status = status;
    plan.updated_at = new Date().toISOString();
    saveAutocodeImplementationPlanSync(planPath, plan as never);
  } catch (error) {
    // File doesn't exist or couldn't be read - this is expected for new specs
    // Log legitimate errors (malformed Markdown, disk write failures, permission errors)
    if (error instanceof Error && error.message && !error.message.includes('ENOENT')) {
      debugLog('spec-utils', `Failed to update implementation plan status: ${error.message}`);
    }
  }
}
