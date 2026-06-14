export type AutocodeIdeationType =
  | 'code_improvements'
  | 'ui_ux_improvements'
  | 'documentation_gaps'
  | 'security_hardening'
  | 'performance_optimizations'
  | 'code_quality';

export type AutocodeIdeationStatus = 'draft' | 'selected' | 'converted' | 'dismissed' | 'archived';

export interface AutocodeRawIdea extends Record<string, unknown> {
  id: string;
  type: string;
  title: string;
  description: string;
  rationale: string;
  status?: string;
  created_at?: string;
  builds_upon?: string[];
  buildsUpon?: string[];
  estimated_effort?: string;
  estimatedEffort?: string;
  affected_files?: string[];
  affectedFiles?: string[];
  category?: string;
  affected_components?: string[];
  affectedComponents?: string[];
  screenshots?: string[];
  current_state?: string;
  currentState?: string;
  proposed_change?: string;
  proposedChange?: string;
  user_benefit?: string;
  userBenefit?: string;
  target_audience?: string;
  targetAudience?: string;
  affected_areas?: string[];
  affectedAreas?: string[];
  current_documentation?: string;
  currentDocumentation?: string;
  proposed_content?: string;
  proposedContent?: string;
  priority?: string;
  severity?: string;
  vulnerability?: string;
  current_risk?: string;
  currentRisk?: string;
  remediation?: string;
  references?: string[];
  compliance?: string[];
  impact?: string;
  current_metric?: string;
  currentMetric?: string;
  expected_improvement?: string;
  expectedImprovement?: string;
  implementation?: string;
  tradeoffs?: string;
  code_example?: string;
  codeExample?: string;
  best_practice?: string;
  bestPractice?: string;
  metrics?: Record<string, unknown>;
  breaking_change?: boolean;
  breakingChange?: boolean;
  prerequisites?: string[];
  linked_task_id?: string;
  linkedTaskId?: string;
  taskId?: string;
}

export interface AutocodeRawIdeationSession {
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
  ideas?: AutocodeRawIdea[];
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

export interface AutocodeIdeationTransformerOptions {
  now?: () => Date;
  nowMs?: () => number;
  logger?: {
    debug?: (...args: unknown[]) => void;
  };
}

const VALID_IDEATION_TYPES: ReadonlySet<AutocodeIdeationType> = new Set([
  'code_improvements',
  'ui_ux_improvements',
  'documentation_gaps',
  'security_hardening',
  'performance_optimizations',
  'code_quality',
] as const);

export function isAutocodeIdeationType(value: unknown): value is AutocodeIdeationType {
  return typeof value === 'string' && VALID_IDEATION_TYPES.has(value as AutocodeIdeationType);
}

export function validateAutocodeIdeationTypes(
  rawTypes: unknown,
  options: AutocodeIdeationTransformerOptions = {},
): AutocodeIdeationType[] {
  if (!Array.isArray(rawTypes)) {
    return [];
  }

  const validTypes: AutocodeIdeationType[] = [];
  const invalidTypes: unknown[] = [];
  for (const entry of rawTypes) {
    if (isAutocodeIdeationType(entry)) {
      validTypes.push(entry);
    } else {
      invalidTypes.push(entry);
    }
  }

  if (invalidTypes.length > 0) {
    options.logger?.debug?.('[Transformers] Dropped invalid IdeationType values:', invalidTypes);
  }

  return validTypes;
}

export function transformAutocodeIdeaFromSnakeCase<TIdea = Record<string, unknown>>(
  idea: AutocodeRawIdea,
  options: AutocodeIdeationTransformerOptions = {},
): TIdea {
  const status = (idea.status || 'draft') as AutocodeIdeationStatus;
  const now = options.now || (() => new Date());
  const createdAt = idea.created_at ? new Date(idea.created_at) : now();
  const taskId = idea.linked_task_id || idea.linkedTaskId || idea.taskId;

  if (idea.type === 'code_improvements') {
    return {
      id: idea.id,
      type: 'code_improvements',
      title: idea.title,
      description: idea.description,
      rationale: idea.rationale,
      status,
      createdAt,
      ...(taskId ? { taskId } : {}),
      buildsUpon: idea.builds_upon || idea.buildsUpon || [],
      estimatedEffort: idea.estimated_effort || idea.estimatedEffort || 'small',
      affectedFiles: idea.affected_files || idea.affectedFiles || [],
      existingPatterns: idea.existing_patterns || idea.existingPatterns || [],
      implementationApproach: idea.implementation_approach || idea.implementationApproach || '',
    } as TIdea;
  }

  if (idea.type === 'ui_ux_improvements') {
    return {
      id: idea.id,
      type: 'ui_ux_improvements',
      title: idea.title,
      description: idea.description,
      rationale: idea.rationale,
      status,
      createdAt,
      ...(taskId ? { taskId } : {}),
      category: idea.category || 'usability',
      affectedComponents: idea.affected_components || idea.affectedComponents || [],
      screenshots: idea.screenshots || [],
      currentState: idea.current_state || idea.currentState || '',
      proposedChange: idea.proposed_change || idea.proposedChange || '',
      userBenefit: idea.user_benefit || idea.userBenefit || '',
    } as TIdea;
  }

  if (idea.type === 'documentation_gaps') {
    return {
      id: idea.id,
      type: 'documentation_gaps',
      title: idea.title,
      description: idea.description,
      rationale: idea.rationale,
      status,
      createdAt,
      ...(taskId ? { taskId } : {}),
      category: idea.category || 'readme',
      targetAudience: idea.target_audience || idea.targetAudience || 'developers',
      affectedAreas: idea.affected_areas || idea.affectedAreas || [],
      currentDocumentation: idea.current_documentation || idea.currentDocumentation || '',
      proposedContent: idea.proposed_content || idea.proposedContent || '',
      priority: idea.priority || 'medium',
      estimatedEffort: idea.estimated_effort || idea.estimatedEffort || 'small',
    } as TIdea;
  }

  if (idea.type === 'security_hardening') {
    return {
      id: idea.id,
      type: 'security_hardening',
      title: idea.title,
      description: idea.description,
      rationale: idea.rationale,
      status,
      createdAt,
      ...(taskId ? { taskId } : {}),
      category: idea.category || 'configuration',
      severity: idea.severity || 'medium',
      affectedFiles: idea.affected_files || idea.affectedFiles || [],
      vulnerability: idea.vulnerability || '',
      currentRisk: idea.current_risk || idea.currentRisk || '',
      remediation: idea.remediation || '',
      references: idea.references || [],
      compliance: idea.compliance || [],
    } as TIdea;
  }

  if (idea.type === 'performance_optimizations') {
    return {
      id: idea.id,
      type: 'performance_optimizations',
      title: idea.title,
      description: idea.description,
      rationale: idea.rationale,
      status,
      createdAt,
      ...(taskId ? { taskId } : {}),
      category: idea.category || 'runtime',
      impact: idea.impact || 'medium',
      affectedAreas: idea.affected_areas || idea.affectedAreas || [],
      currentMetric: idea.current_metric || idea.currentMetric || '',
      expectedImprovement: idea.expected_improvement || idea.expectedImprovement || '',
      implementation: idea.implementation || '',
      tradeoffs: idea.tradeoffs || '',
      estimatedEffort: idea.estimated_effort || idea.estimatedEffort || 'medium',
    } as TIdea;
  }

  if (idea.type === 'code_quality') {
    return {
      id: idea.id,
      type: 'code_quality',
      title: idea.title,
      description: idea.description,
      rationale: idea.rationale,
      status,
      createdAt,
      ...(taskId ? { taskId } : {}),
      category: idea.category || 'code_smells',
      severity: idea.severity || 'minor',
      affectedFiles: idea.affected_files || idea.affectedFiles || [],
      currentState: idea.current_state || idea.currentState || '',
      proposedChange: idea.proposed_change || idea.proposedChange || '',
      codeExample: idea.code_example || idea.codeExample || '',
      bestPractice: idea.best_practice || idea.bestPractice || '',
      metrics: idea.metrics || {},
      estimatedEffort: idea.estimated_effort || idea.estimatedEffort || 'medium',
      breakingChange: idea.breaking_change ?? idea.breakingChange ?? false,
      prerequisites: idea.prerequisites || [],
    } as TIdea;
  }

  return {
    id: idea.id,
    type: 'code_improvements',
    title: idea.title,
    description: idea.description,
    rationale: idea.rationale,
    status,
    createdAt,
    ...(taskId ? { taskId } : {}),
    buildsUpon: [],
    estimatedEffort: 'small',
    affectedFiles: [],
    existingPatterns: [],
    implementationApproach: '',
  } as TIdea;
}

export function transformAutocodeIdeationSessionFromSnakeCase<TSession = Record<string, unknown>, TIdea = Record<string, unknown>>(
  rawSession: AutocodeRawIdeationSession,
  projectId: string,
  options: AutocodeIdeationTransformerOptions = {},
): TSession {
  const now = options.now || (() => new Date());
  const nowMs = options.nowMs || (() => Date.now());
  const rawEnabledTypes = rawSession.config?.enabled_types || rawSession.config?.enabledTypes || [];
  const enabledTypes = validateAutocodeIdeationTypes(rawEnabledTypes, options);

  return {
    id: rawSession.id || `ideation-${nowMs()}`,
    projectId,
    config: {
      enabledTypes,
      includeRoadmapContext: rawSession.config?.include_roadmap_context ?? rawSession.config?.includeRoadmapContext ?? true,
      includeKanbanContext: rawSession.config?.include_kanban_context ?? rawSession.config?.includeKanbanContext ?? true,
      maxIdeasPerType: rawSession.config?.max_ideas_per_type || rawSession.config?.maxIdeasPerType || 5,
    },
    ideas: (rawSession.ideas || []).map((idea) => transformAutocodeIdeaFromSnakeCase<TIdea>(idea, options)),
    projectContext: {
      existingFeatures: rawSession.project_context?.existing_features || rawSession.projectContext?.existingFeatures || [],
      techStack: rawSession.project_context?.tech_stack || rawSession.projectContext?.techStack || [],
      targetAudience: rawSession.project_context?.target_audience || rawSession.projectContext?.targetAudience,
      plannedFeatures: rawSession.project_context?.planned_features || rawSession.projectContext?.plannedFeatures || [],
    },
    generatedAt: rawSession.generated_at ? new Date(rawSession.generated_at) : now(),
    updatedAt: rawSession.updated_at ? new Date(rawSession.updated_at) : now(),
  } as TSession;
}
