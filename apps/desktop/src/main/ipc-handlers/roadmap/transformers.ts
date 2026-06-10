import { transformAutocodeRoadmapFromSnakeCase } from '@autocode/core/tasks/roadmap-transformers';
import type {
  Roadmap,
  RoadmapFeature,
  RoadmapPhase,
} from '../../../shared/types';

interface RawRoadmapMilestone {
  id: string;
  title: string;
  description: string;
  features?: string[];
  status?: string;
  target_date?: string;
}

interface RawRoadmapPhase {
  id: string;
  name: string;
  description: string;
  order: number;
  status?: string;
  features?: string[];
  milestones?: RawRoadmapMilestone[];
}

interface RawRoadmapFeature {
  id: string;
  title: string;
  description: string;
  rationale?: string;
  priority?: string;
  complexity?: string;
  impact?: string;
  phase_id?: string;
  phaseId?: string;
  dependencies?: string[];
  status?: string;
  acceptance_criteria?: string[];
  acceptanceCriteria?: string[];
  user_stories?: string[];
  userStories?: string[];
  linked_spec_id?: string;
  linkedSpecId?: string;
  competitor_insight_ids?: string[];
  competitorInsightIds?: string[];
}

interface RawRoadmap {
  id?: string;
  project_name?: string;
  projectName?: string;
  version?: string;
  vision?: string;
  target_audience?: {
    primary?: string;
    secondary?: string[];
  };
  targetAudience?: {
    primary?: string;
    secondary?: string[];
  };
  phases?: RawRoadmapPhase[];
  features?: RawRoadmapFeature[];
  status?: string;
  metadata?: {
    created_at?: string;
    updated_at?: string;
  };
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
}

export function transformRoadmapFromSnakeCase(
  raw: RawRoadmap,
  projectId: string,
  projectName?: string
): Roadmap {
  return transformAutocodeRoadmapFromSnakeCase<Roadmap, RoadmapPhase, RoadmapFeature>(
    raw,
    projectId,
    projectName,
    {
      logger: process.env.NODE_ENV === 'development'
        ? { debug: console.debug }
        : undefined,
    }
  );
}
