/**
 * Convert ideation ideas to tasks
 */

import path from 'path';
import { existsSync, writeFileSync } from 'fs';
import type { IpcMainInvokeEvent } from 'electron';
import {
  buildAutocodeSpecId,
  createAutocodeTask,
  type AutocodeTask,
  type AutocodeTaskMetadata,
} from '@autocode/core';
import { AUTO_BUILD_PATHS } from '../../../shared/constants';
import type {
  IPCResult,
  Task,
  TaskMetadata,
  TaskCategory,
  TaskImpact,
  TaskComplexity,
  TaskPriority
} from '../../../shared/types';
import { projectStore } from '../../project-store';
import { readIdeationFile, writeIdeationFile, updateIdeationTimestamp } from './file-utils';
import type { RawIdea } from './types';
import { withSpecNumberLock } from '../../utils/spec-number-lock';

function toDesktopTask(coreTask: AutocodeTask, projectId: string): Task {
  return {
    id: coreTask.id,
    specId: coreTask.specId,
    projectId,
    title: coreTask.title,
    description: coreTask.description,
    status: coreTask.status as Task['status'],
    subtasks: coreTask.subtasks,
    logs: [],
    metadata: coreTask.metadata as TaskMetadata | undefined,
    specsPath: coreTask.specsPath,
    createdAt: new Date(coreTask.createdAt),
    updatedAt: new Date(coreTask.updatedAt),
  };
}

/**
 * Build task description from idea data
 */
function buildTaskDescription(idea: RawIdea): string {
  let description = `# ${idea.title}\n\n`;
  description += `${idea.description}\n\n`;
  description += `## Rationale\n${idea.rationale}\n\n`;

  if (idea.type === 'code_improvements') {
    const buildsUpon = idea.builds_upon || [];
    if (Array.isArray(buildsUpon) && buildsUpon.length > 0) {
      description += `## Builds Upon\n${buildsUpon.map((b: string) => `- ${b}`).join('\n')}\n\n`;
    }
    if (idea.implementation_approach) {
      description += `## Implementation Approach\n${idea.implementation_approach}\n\n`;
    }
    const affectedFiles = idea.affected_files || [];
    if (Array.isArray(affectedFiles) && affectedFiles.length > 0) {
      description += `## Affected Files\n${affectedFiles.map((f: string) => `- ${f}`).join('\n')}\n\n`;
    }
    const existingPatterns = idea.existing_patterns || [];
    if (Array.isArray(existingPatterns) && existingPatterns.length > 0) {
      description += `## Patterns to Follow\n${existingPatterns.map((p: string) => `- ${p}`).join('\n')}\n\n`;
    }
  } else if (idea.type === 'ui_ux_improvements') {
    description += `## Category\n${idea.category}\n\n`;
    description += `## Current State\n${idea.current_state}\n\n`;
    description += `## Proposed Change\n${idea.proposed_change}\n\n`;
    description += `## User Benefit\n${idea.user_benefit}\n\n`;
    if (idea.affected_components?.length) {
      description += `## Affected Components\n${idea.affected_components.map((c: string) => `- ${c}`).join('\n')}\n\n`;
    }
  }

  return description;
}

/**
 * Build task metadata from idea
 */
function buildTaskMetadata(idea: RawIdea): TaskMetadata {
  const metadata: TaskMetadata = {
    sourceType: 'ideation',
    ideationType: idea.type,
    ideaId: idea.id,
    rationale: idea.rationale
  };

  // Map idea type to task category
  const ideaTypeToCategory: Record<string, TaskCategory> = {
    'code_improvements': 'feature',
    'ui_ux_improvements': 'ui_ux',
    'documentation_gaps': 'documentation',
    'security_hardening': 'security',
    'performance_optimizations': 'performance',
    'code_quality': 'refactoring'
  };
  metadata.category = ideaTypeToCategory[idea.type] || 'feature';

  // Extract type-specific metadata with proper type casting
  if (idea.type === 'code_improvements') {
    const effort = idea.estimated_effort as TaskComplexity | undefined;
    metadata.estimatedEffort = effort;
    metadata.complexity = effort;
    metadata.affectedFiles = idea.affected_files;
  } else if (idea.type === 'ui_ux_improvements') {
    metadata.uiuxCategory = idea.category;
    metadata.affectedFiles = idea.affected_components;
    metadata.problemSolved = idea.current_state;
  } else if (idea.type === 'documentation_gaps') {
    metadata.estimatedEffort = idea.estimated_effort as TaskComplexity | undefined;
    metadata.priority = idea.priority as TaskPriority | undefined;
    metadata.targetAudience = idea.target_audience;
    metadata.affectedFiles = idea.affected_areas;
  } else if (idea.type === 'security_hardening') {
    const severity = idea.severity as 'low' | 'medium' | 'high' | 'critical' | undefined;
    metadata.securitySeverity = severity;
    metadata.impact = severity as TaskImpact | undefined;
    metadata.priority = severity === 'critical' ? 'urgent' : severity === 'high' ? 'high' : 'medium';
    metadata.affectedFiles = idea.affected_files;
  } else if (idea.type === 'performance_optimizations') {
    metadata.performanceCategory = idea.category;
    metadata.impact = idea.impact as TaskImpact | undefined;
    metadata.estimatedEffort = idea.estimated_effort as TaskComplexity | undefined;
    metadata.affectedFiles = idea.affected_areas;
  } else if (idea.type === 'code_quality') {
    const severity = idea.severity as 'suggestion' | 'minor' | 'major' | 'critical' | undefined;
    metadata.codeQualitySeverity = severity;
    metadata.estimatedEffort = idea.estimated_effort as TaskComplexity | undefined;
    metadata.affectedFiles = idea.affected_files;
    metadata.priority = severity === 'critical' ? 'urgent' : severity === 'major' ? 'high' : 'medium';
  }

  return metadata;
}

function buildSpecContent(idea: RawIdea): string {
  return `# ${idea.title}

## Overview

${idea.description}

## Rationale

${idea.rationale}

---
*This spec was created from ideation and is pending detailed specification.*
`;
}

/**
 * Convert an idea to a task
 */
export async function convertIdeaToTask(
  _event: IpcMainInvokeEvent,
  projectId: string,
  ideaId: string
): Promise<IPCResult<Task>> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  const ideationPath = path.join(
    project.path,
    AUTO_BUILD_PATHS.IDEATION_DIR,
    AUTO_BUILD_PATHS.IDEATION_FILE
  );

  // Quick check that ideation file exists (actual read happens inside lock)
  if (!existsSync(ideationPath)) {
    return { success: false, error: 'Ideation not found' };
  }

  try {
    // Use coordinated spec numbering with lock to prevent collisions
    // CRITICAL: All state checks must happen INSIDE the lock to prevent TOCTOU race conditions
    return await withSpecNumberLock(project.path, async (lock) => {
      // Re-read ideation file INSIDE the lock to get fresh state
      const ideation = readIdeationFile(ideationPath);
      if (!ideation) {
        return { success: false, error: 'Ideation not found' };
      }

      // Find the idea (inside lock for fresh state)
      const idea = ideation.ideas?.find((i) => i.id === ideaId);
      if (!idea) {
        return { success: false, error: 'Idea not found' };
      }

      // Idempotency check INSIDE lock - prevents TOCTOU race condition
      // Two concurrent requests can both pass an outside check, but only one
      // can hold the lock at a time, so this check is authoritative
      if (idea.linked_task_id) {
        return {
          success: false,
          error: `Idea has already been converted to task: ${idea.linked_task_id}`
        };
      }

      // Get next spec number from global scan (main + all worktrees)
      const nextNum = lock.getNextSpecNumber(project.autoBuildPath);
      const specId = buildAutocodeSpecId(nextNum, idea.title);

      // Build task description and metadata
      const taskDescription = buildTaskDescription(idea);
      const metadata = buildTaskMetadata(idea);

      const coreTask = createAutocodeTask({
        projectRoot: project.path,
        dataDirName: project.autoBuildPath || '.autocode',
        specId,
        title: idea.title,
        description: taskDescription,
        metadata: metadata as unknown as AutocodeTaskMetadata,
      });
      writeFileSync(path.join(coreTask.specsPath, AUTO_BUILD_PATHS.SPEC_FILE), buildSpecContent(idea), 'utf-8');

      // Update idea status to archived (converted ideas are archived)
      idea.status = 'archived';
      idea.linked_task_id = coreTask.specId;
      updateIdeationTimestamp(ideation);
      writeIdeationFile(ideationPath, ideation);

      const task = toDesktopTask(coreTask, projectId);
      projectStore.invalidateTasksCache(projectId);

      return { success: true, data: task };
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to convert idea to task'
    };
  }
}
