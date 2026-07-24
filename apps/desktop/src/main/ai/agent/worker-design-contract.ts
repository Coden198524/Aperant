import { isAutocodeNonImplementationDirectContext } from '@autocode/core/runtime/direct-task-summary';

export interface WorkerDesignContractClassificationInput {
  plan?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  requirements?: Record<string, unknown> | null;
  humanInput?: string | null;
  latestChangeRequest?: string | null;
}

const NON_IMPLEMENTATION_PLANNER_OVERRIDE = [
  '## NON-IMPLEMENTATION PLANNING OVERRIDE',
  'This task is analysis, investigation, research, or documentation work and intentionally has no Design-Contract package.',
  'This override supersedes any earlier generic planner instruction that requires the five-file design package, design_review.md, design IDs, or `_Design_` task metadata.',
  '- Read requirements.md, spec.md, context.md/research.md when present, project evidence, and current human feedback.',
  '- Do not read, create, require, repair, or reference design.md, requirement_model.md, domain_model.md, design_model.md, implementation_model.md, or design_review.md.',
  '- Create or repair only tasks.md as static [ ] definitions with R*/AC*/SCN-* coverage, E* evidence, dependencies, file intent, done signals, and focused verification.',
  '- Do not invent Design-Contract IDs or add `_Design_` metadata.',
  '- Do not write implementation_plan.md; the runtime derives it from validated tasks.md.',
].join('\n');

const NON_IMPLEMENTATION_EXECUTION_OVERRIDES: Record<string, string> = {
  coder: [
    '## NON-IMPLEMENTATION EXECUTION OVERRIDE',
    'This work package is analysis, investigation, research, or documentation work and intentionally has no Design-Contract package.',
    'This override supersedes every earlier coder instruction that requires the five-file design package, design IDs, a Design Budget, design conformance, or a design preflight.',
    '- Work from the Current Work Package, requirements.md, spec.md, tasks.md, context.md/research.md when present, cited project evidence, and the requested deliverable.',
    '- Do not read, create, repair, or reference requirement_model.md, domain_model.md, design.md, design_model.md, implementation_model.md, or design_review.md.',
    '- Do not invent Design-Contract IDs, claim design conformance, or return the package to planning because design artifacts are absent.',
    '- Complete the requested analysis or document deliverable with traceable R*/AC*/SCN-* coverage, evidence, done signals, and proportionate verification.',
    '- Do not modify product source code unless the current requirements explicitly request implementation; a non-implementation package should normally change only its requested deliverables.',
    '- Report requirements covered, evidence used, deliverables changed, verification, limitations, and residual risk.',
  ].join('\n'),
  qa_reviewer: [
    '## NON-IMPLEMENTATION QA OVERRIDE',
    'This task is analysis, investigation, research, or documentation work and intentionally has no Design-Contract package.',
    'This override supersedes every earlier QA instruction that requires the five-file design package, design IDs, Design Budget conformance, SYS/DOM/DES/FLOW/REV/IMP mappings, or design preflight evidence.',
    '- Review requirements.md, spec.md, tasks.md, the runtime completion evidence, cited project evidence, requested deliverables, and relevant diffs.',
    '- Do not read, require, repair, or grade requirement_model.md, domain_model.md, design.md, design_model.md, implementation_model.md, or design_review.md.',
    '- Approve when R*/AC*/SCN-* coverage, factual accuracy, evidence traceability, requested document/output quality, and proportionate verification are complete with no blocking issue.',
    '- Treat unexpected product source changes as a scope issue unless the current requirements explicitly authorize implementation.',
    '- Findings must cite the impacted requirement, acceptance criterion, scenario, task, evidence, or deliverable location; design IDs are neither required nor valid for this task.',
  ].join('\n'),
  qa_fixer: [
    '## NON-IMPLEMENTATION QA FIX OVERRIDE',
    'This task is analysis, investigation, research, or documentation work and intentionally has no Design-Contract package.',
    'This override supersedes every earlier QA-fix instruction that assumes source-code bugs, design IDs, Design Budget conformance, or the five-file design package.',
    '- Fix QA findings using QA_FIX_REQUEST.md, qa_report.md, requirements.md, spec.md, tasks.md, cited evidence, and the requested deliverables.',
    '- Do not read, create, repair, or reference requirement_model.md, domain_model.md, design.md, design_model.md, implementation_model.md, or design_review.md.',
    '- Correct analysis or documentation defects in the requested deliverables; do not modify product source merely to satisfy a non-implementation finding.',
    '- Re-run proportionate checks for factual accuracy, R*/AC*/SCN-* coverage, links/citations, structure, formatting, and any requested document generation.',
    '- Report findings fixed, deliverables changed, verification, limitations, and residual risk without claiming design conformance.',
  ].join('\n'),
};

export function resolveWorkerDesignContractExemption(
  input: WorkerDesignContractClassificationInput,
): boolean {
  const plan = input.plan ?? {};
  const requirements = input.requirements ?? {};
  const classificationPlan = {
    ...plan,
    workflow_type: stringValue(requirements.workflow_type) || plan.workflow_type,
  };
  const description = [
    stringValue(plan.description),
    stringValue(requirements.task_description),
    ...stringArray(requirements.user_requirements),
    input.humanInput,
    input.latestChangeRequest,
  ].filter((value): value is string => Boolean(value?.trim())).join('\n');

  return isAutocodeNonImplementationDirectContext({
    plan: classificationPlan,
    metadata: input.metadata,
    description,
  });
}

export function appendWorkerDesignContractExemptPlannerOverride(
  prompt: string,
  promptName: string,
  designContractExempt: boolean | undefined,
): string {
  if (
    designContractExempt !== true ||
    (promptName !== 'planner' && promptName !== 'followup_planner')
  ) {
    return prompt;
  }

  return `${prompt}\n\n${NON_IMPLEMENTATION_PLANNER_OVERRIDE}`;
}

export function appendWorkerDesignContractExemptExecutionOverride(
  prompt: string,
  promptName: string,
  designContractExempt: boolean | undefined,
): string {
  if (designContractExempt !== true) {
    return prompt;
  }

  const override = NON_IMPLEMENTATION_EXECUTION_OVERRIDES[promptName];
  return override ? `${prompt}\n\n${override}` : prompt;
}

export function resolveWorkerEffectiveDesignContractExemption(
  requireDesignContract: boolean | undefined,
  fallbackDesignContractExempt: boolean,
): boolean {
  return requireDesignContract === undefined
    ? fallbackDesignContractExempt
    : !requireDesignContract;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter(Boolean)
    : [];
}
