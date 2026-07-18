import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';

export const AUTOCODE_STANDARD_CHANGE_REQUESTS_FILE = 'change_requests.jsonl';

export type AutocodeStandardPlanningOwnerStage =
  | 'requirements'
  | 'spec'
  | 'requirement_model'
  | 'domain_model'
  | 'design'
  | 'design_model'
  | 'implementation_model'
  | 'design_review'
  | 'tasks';

export const AUTOCODE_STANDARD_PLANNING_OWNER_STAGE_ORDER:
readonly AutocodeStandardPlanningOwnerStage[] = [
  'requirements',
  'spec',
  'requirement_model',
  'domain_model',
  'design',
  'design_model',
  'implementation_model',
  'design_review',
  'tasks',
];

export interface AutocodeStandardPlanningOwnerPlan {
  stages: AutocodeStandardPlanningOwnerStage[];
  changeRequestId?: string;
  changeRequestCreatedAt?: string;
  source: 'initial' | 'change_request' | 'legacy_force' | 'invalid_change_request';
}

export function parseAutocodeStandardPlanningOwnerPlan(
  content: string,
): AutocodeStandardPlanningOwnerPlan | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const iteration = asRecord(record.iteration);
    if (
      record.scope !== 'planning' ||
      (iteration?.mode !== undefined && iteration.mode !== 'standard-planning')
    ) {
      continue;
    }

    const flowDocuments = stringArrayFrom(iteration?.flowDocuments);
    const impacts = stringArrayFrom(record.impacts);
    const stages = new Set<AutocodeStandardPlanningOwnerStage>();
    const hasDocument = (fileName: string): boolean => flowDocuments.includes(fileName);
    const hasImpact = (impact: string): boolean => impacts.includes(impact);

    if (hasDocument(AUTOCODE_TASK_ARTIFACTS.requirements) || hasImpact('requirements')) {
      addStagesFrom(stages, 'requirements');
    } else if (hasDocument(AUTOCODE_TASK_ARTIFACTS.specFile)) {
      addStagesFrom(stages, 'spec');
    } else if (hasDocument(AUTOCODE_TASK_ARTIFACTS.requirementModel)) {
      addStagesFrom(stages, 'requirement_model');
    } else if (hasDocument(AUTOCODE_TASK_ARTIFACTS.domainModel)) {
      addStagesFrom(stages, 'domain_model');
    } else if (hasDocument(AUTOCODE_TASK_ARTIFACTS.design)) {
      addStagesFrom(stages, 'design');
    } else if (hasDocument(AUTOCODE_TASK_ARTIFACTS.designModel)) {
      addStagesFrom(stages, 'design_model');
    } else if (hasDocument(AUTOCODE_TASK_ARTIFACTS.implementationModel)) {
      addStagesFrom(stages, 'implementation_model');
    } else if (hasDocument(AUTOCODE_TASK_ARTIFACTS.designReview)) {
      addStagesFrom(stages, 'design_review');
    } else if (hasImpact('design')) {
      // Generic design impact fallback. The 'design' impact is set for every
      // design-package change (design_model/implementation_model included), while the
      // specific owner is encoded by the earliest design document in flowDocuments and
      // matched above. Only fall back to the architecture owner when no design-package
      // document is named, so a design_model/implementation_model change is not forced
      // to regenerate design.md and rerun the full downstream package.
      addStagesFrom(stages, 'design');
    } else if (hasDocument(AUTOCODE_TASK_ARTIFACTS.tasks) || hasImpact('tasks')) {
      stages.add('tasks');
    }

    if (stages.size === 0) {
      stages.add('tasks');
    }

    const changeRequestId = stringFrom(record.id);
    const changeRequestCreatedAt = stringFrom(record.createdAt);
    return {
      stages: AUTOCODE_STANDARD_PLANNING_OWNER_STAGE_ORDER.filter((stage) => stages.has(stage)),
      ...(changeRequestId ? { changeRequestId } : {}),
      ...(changeRequestCreatedAt ? { changeRequestCreatedAt } : {}),
      source: 'change_request',
    };
  }
  return null;
}

export function resolveAutocodeStandardPlanningOwnerPlan(input: {
  phase: 'direct' | 'spec' | 'planning' | 'coding';
  forcePlanning: boolean;
  changeRequestsContent?: string;
}): AutocodeStandardPlanningOwnerPlan {
  if (input.forcePlanning) {
    if (input.changeRequestsContent === undefined) {
      return {
        stages: [
          'requirement_model',
          'domain_model',
          'design',
          'design_model',
          'implementation_model',
          'design_review',
          'tasks',
        ],
        source: 'legacy_force',
      };
    }
    return parseAutocodeStandardPlanningOwnerPlan(input.changeRequestsContent) ?? {
      stages: [...AUTOCODE_STANDARD_PLANNING_OWNER_STAGE_ORDER],
      source: 'invalid_change_request',
    };
  }

  if (input.phase === 'spec') {
    return {
      stages: [...AUTOCODE_STANDARD_PLANNING_OWNER_STAGE_ORDER],
      source: 'initial',
    };
  }

  return {
    stages: [
      'requirement_model',
      'domain_model',
      'design',
      'design_model',
      'implementation_model',
      'design_review',
      'tasks',
    ],
    source: 'initial',
  };
}

function addStagesFrom(
  stages: Set<AutocodeStandardPlanningOwnerStage>,
  firstStage: AutocodeStandardPlanningOwnerStage,
): void {
  const firstIndex = AUTOCODE_STANDARD_PLANNING_OWNER_STAGE_ORDER.indexOf(firstStage);
  for (const stage of AUTOCODE_STANDARD_PLANNING_OWNER_STAGE_ORDER.slice(firstIndex)) {
    stages.add(stage);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringFrom(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArrayFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringFrom).filter(Boolean)
    : [];
}
