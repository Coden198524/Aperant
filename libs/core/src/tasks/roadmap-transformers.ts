export type AutocodeRoadmapFeatureStatus = 'under_review' | 'planned' | 'in_progress' | 'done';

export interface AutocodeRawRoadmapMilestone {
  id: string;
  title: string;
  description: string;
  features?: string[];
  status?: string;
  target_date?: string;
}

export interface AutocodeRawRoadmapPhase {
  id: string;
  name: string;
  description: string;
  order: number;
  status?: string;
  features?: string[];
  milestones?: AutocodeRawRoadmapMilestone[];
}

export interface AutocodeRawRoadmapFeature {
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

export interface AutocodeRawRoadmap {
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
  phases?: AutocodeRawRoadmapPhase[];
  features?: AutocodeRawRoadmapFeature[];
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

export interface AutocodeRoadmapTransformerOptions {
  now?: () => Date;
  nowMs?: () => number;
  logger?: {
    debug?: (...args: unknown[]) => void;
  };
}

export const AUTOCODE_ROADMAP_FEATURE_STATUS_MAP: Record<string, AutocodeRoadmapFeatureStatus> = {
  under_review: 'under_review',
  planned: 'planned',
  in_progress: 'in_progress',
  done: 'done',
  idea: 'under_review',
  backlog: 'under_review',
  proposed: 'under_review',
  pending: 'under_review',
  approved: 'planned',
  scheduled: 'planned',
  active: 'in_progress',
  building: 'in_progress',
  complete: 'done',
  completed: 'done',
  shipped: 'done',
};

export function normalizeAutocodeRoadmapFeatureStatus(
  status: string | undefined,
  options: AutocodeRoadmapTransformerOptions = {},
): AutocodeRoadmapFeatureStatus {
  if (!status) return 'under_review';

  const normalized = AUTOCODE_ROADMAP_FEATURE_STATUS_MAP[status.toLowerCase()];
  if (!normalized) {
    options.logger?.debug?.(
      `[Roadmap] normalizeFeatureStatus: unmapped status "${status}", defaulting to "under_review"`,
    );
    return 'under_review';
  }

  return normalized;
}

export function transformAutocodeRoadmapMilestone<TMilestone = Record<string, unknown>>(
  raw: AutocodeRawRoadmapMilestone,
): TMilestone {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    features: raw.features || [],
    status: raw.status || 'planned',
    targetDate: raw.target_date ? new Date(raw.target_date) : undefined,
  } as TMilestone;
}

export function transformAutocodeRoadmapPhase<TPhase = Record<string, unknown>, TMilestone = Record<string, unknown>>(
  raw: AutocodeRawRoadmapPhase,
): TPhase {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    order: raw.order,
    status: raw.status || 'planned',
    features: raw.features || [],
    milestones: (raw.milestones || []).map((milestone) => transformAutocodeRoadmapMilestone<TMilestone>(milestone)),
  } as TPhase;
}

export function transformAutocodeRoadmapFeature<TFeature = Record<string, unknown>>(
  raw: AutocodeRawRoadmapFeature,
  options: AutocodeRoadmapTransformerOptions = {},
): TFeature {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    rationale: raw.rationale || '',
    priority: raw.priority || 'should',
    complexity: raw.complexity || 'medium',
    impact: raw.impact || 'medium',
    phaseId: raw.phase_id || raw.phaseId || '',
    dependencies: raw.dependencies || [],
    status: normalizeAutocodeRoadmapFeatureStatus(raw.status, options),
    acceptanceCriteria: raw.acceptance_criteria || raw.acceptanceCriteria || [],
    userStories: raw.user_stories || raw.userStories || [],
    linkedSpecId: raw.linked_spec_id || raw.linkedSpecId,
    competitorInsightIds: raw.competitor_insight_ids || raw.competitorInsightIds,
  } as TFeature;
}

export function transformAutocodeRoadmapFromSnakeCase<TRoadmap = Record<string, unknown>, TPhase = Record<string, unknown>, TFeature = Record<string, unknown>>(
  raw: AutocodeRawRoadmap,
  projectId: string,
  projectName?: string,
  options: AutocodeRoadmapTransformerOptions = {},
): TRoadmap {
  const now = options.now || (() => new Date());
  const nowMs = options.nowMs || (() => Date.now());
  const targetAudience = raw.target_audience || raw.targetAudience;
  const createdAt = raw.metadata?.created_at || raw.created_at || raw.createdAt;
  const updatedAt = raw.metadata?.updated_at || raw.updated_at || raw.updatedAt;

  return {
    id: raw.id || `roadmap-${nowMs()}`,
    projectId,
    projectName: raw.project_name || raw.projectName || projectName || '',
    version: raw.version || '1.0',
    vision: raw.vision || '',
    targetAudience: {
      primary: targetAudience?.primary || '',
      secondary: targetAudience?.secondary || [],
    },
    phases: (raw.phases || []).map((phase) => transformAutocodeRoadmapPhase<TPhase>(phase)),
    features: (raw.features || []).map((feature) => transformAutocodeRoadmapFeature<TFeature>(feature, options)),
    status: raw.status || 'draft',
    createdAt: createdAt ? new Date(createdAt) : now(),
    updatedAt: updatedAt ? new Date(updatedAt) : now(),
  } as TRoadmap;
}
