import {
  transformAutocodeIdeaFromSnakeCase,
  transformAutocodeIdeationSessionFromSnakeCase,
} from '@autocode/core/tasks/ideation-transformers';
import type {
  Idea,
  IdeationSession
} from '../../../shared/types';
import { debugLog } from '../../../shared/utils/debug-logger';
import type { RawIdea } from './types';

const transformerOptions = {
  logger: {
    debug: debugLog,
  },
};

export function transformIdeaFromSnakeCase(idea: RawIdea): Idea {
  return transformAutocodeIdeaFromSnakeCase<Idea>(idea, transformerOptions);
}

interface RawIdeationSession {
  id?: string;
  project_id?: string;
  config?: {
    enabled_types?: string[];
    enabledTypes?: string[];
    include_roadmap_context?: boolean;
    includeRoadmapContext?: boolean;
    include_kanban_context?: boolean;
    includeKanbanContext?: boolean;
    max_ideas_per_type?: number;
    maxIdeasPerType?: number;
  };
  ideas?: RawIdea[];
  project_context?: {
    existing_features?: string[];
    tech_stack?: string[];
    target_audience?: string;
    planned_features?: string[];
  };
  projectContext?: {
    existingFeatures?: string[];
    techStack?: string[];
    targetAudience?: string;
    plannedFeatures?: string[];
  };
  generated_at?: string;
  updated_at?: string;
}

export function transformSessionFromSnakeCase(
  rawSession: RawIdeationSession,
  projectId: string
): IdeationSession {
  return transformAutocodeIdeationSessionFromSnakeCase<IdeationSession, Idea>(
    rawSession,
    projectId,
    transformerOptions
  );
}
