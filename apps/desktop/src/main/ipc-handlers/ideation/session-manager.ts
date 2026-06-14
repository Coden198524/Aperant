/**
 * Ideation session CRUD operations
 */

import type { IpcMainInvokeEvent } from 'electron';
import { getAutocodeIdeationFilePath, getAutocodeIdeationTypeIdeasPath } from '@autocode/core';
import type { IPCResult, IdeationSession, IdeationType } from '../../../shared/types';
import { projectStore } from '../../project-store';
import { transformIdeaFromSnakeCase } from './transformers';
import { readIdeationFile, writeIdeationFile } from './file-utils';
import type { RawIdea, RawIdeationData } from './types';

const IDEATION_TYPES: IdeationType[] = [
  'code_improvements',
  'ui_ux_improvements',
  'documentation_gaps',
  'security_hardening',
  'performance_optimizations',
  'code_quality',
];

function readTypeIdeas(projectPath: string, dataDirName: string | undefined, type: IdeationType): RawIdea[] {
  const typePath = getAutocodeIdeationTypeIdeasPath(projectPath, type, dataDirName);
  const rawTypeData = readIdeationFile(typePath) as Record<string, unknown> | null;
  const ideas = rawTypeData?.[type];
  return Array.isArray(ideas) ? ideas as RawIdea[] : [];
}

function rebuildIdeationFromTypeFiles(
  projectId: string,
  projectPath: string,
  dataDirName: string | undefined
): RawIdeationData | null {
  const ideas: RawIdea[] = [];
  const enabledTypes: IdeationType[] = [];

  for (const type of IDEATION_TYPES) {
    const typeIdeas = readTypeIdeas(projectPath, dataDirName, type);
    if (typeIdeas.length > 0) {
      ideas.push(...typeIdeas);
      enabledTypes.push(type);
    }
  }

  if (ideas.length === 0) {
    return null;
  }

  const now = new Date().toISOString();
  return {
    id: `ideation-${Date.now()}`,
    project_id: projectId,
    config: {
      enabled_types: enabledTypes,
      include_roadmap_context: true,
      include_kanban_context: true,
      max_ideas_per_type: 5,
    },
    ideas,
    project_context: {
      existing_features: [],
      tech_stack: [],
      planned_features: [],
    },
    generated_at: now,
    updated_at: now,
  };
}

/**
 * Get ideation session for a project
 */
export async function getIdeationSession(
  _event: IpcMainInvokeEvent,
  projectId: string
): Promise<IPCResult<IdeationSession | null>> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  const ideationPath = getAutocodeIdeationFilePath(project.path, project.autoBuildPath);

  let rawIdeation = readIdeationFile(ideationPath);
  if (!rawIdeation) {
    rawIdeation = rebuildIdeationFromTypeFiles(projectId, project.path, project.autoBuildPath);
    if (!rawIdeation) {
      return { success: true, data: null };
    }
    writeIdeationFile(ideationPath, rawIdeation);
  }

  try {
    // Transform snake_case to camelCase for frontend
    const enabledTypes = (rawIdeation.config?.enabled_types || rawIdeation.config?.enabledTypes || []) as unknown[];

    const session: IdeationSession = {
      id: rawIdeation.id || `ideation-${Date.now()}`,
      projectId,
      config: {
        enabledTypes: enabledTypes as IdeationSession['config']['enabledTypes'],
        includeRoadmapContext: rawIdeation.config?.include_roadmap_context ?? rawIdeation.config?.includeRoadmapContext ?? true,
        includeKanbanContext: rawIdeation.config?.include_kanban_context ?? rawIdeation.config?.includeKanbanContext ?? true,
        maxIdeasPerType: rawIdeation.config?.max_ideas_per_type || rawIdeation.config?.maxIdeasPerType || 5
      },
      ideas: (rawIdeation.ideas || []).map(idea => transformIdeaFromSnakeCase(idea)),
      projectContext: {
        existingFeatures: rawIdeation.project_context?.existing_features || rawIdeation.projectContext?.existingFeatures || [],
        techStack: rawIdeation.project_context?.tech_stack || rawIdeation.projectContext?.techStack || [],
        targetAudience: rawIdeation.project_context?.target_audience || rawIdeation.projectContext?.targetAudience,
        plannedFeatures: rawIdeation.project_context?.planned_features || rawIdeation.projectContext?.plannedFeatures || []
      },
      generatedAt: rawIdeation.generated_at ? new Date(rawIdeation.generated_at) : new Date(),
      updatedAt: rawIdeation.updated_at ? new Date(rawIdeation.updated_at) : new Date()
    };

    return { success: true, data: session };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read ideation'
    };
  }
}
