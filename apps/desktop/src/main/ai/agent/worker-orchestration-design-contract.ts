const NON_IMPLEMENTATION_AGENTIC_ORCHESTRATOR_OVERRIDE = [
  '## NON-IMPLEMENTATION AGENTIC FLOW OVERRIDE',
  'This override supersedes the generic Design-Contract: 5 pipeline for this analysis, investigation, research, or documentation task.',
  '- Run exactly `spec_gatherer -> spec_writer -> planner`, producing requirements.md, spec.md, and tasks.md.',
  '- Do not dispatch requirement_modeler, domain_modeler, software_designer, design_modeler, implementation_modeler, or design_critic.',
  '- Do not read, create, require, validate, or reference requirement_model.md, domain_model.md, design.md, design_model.md, implementation_model.md, or design_review.md.',
  '- The planner must use approved requirements/specification and evidence directly; never invent Design-Contract IDs or `_Design_` metadata.',
  '- Stop after tasks.md validation. Never create implementation_plan.md, implement source code, or run build/QA execution.',
].join('\n');

const NON_IMPLEMENTATION_MMO_PLANNING_OVERRIDE = [
  '## NON-IMPLEMENTATION MMO PLANNING OVERRIDE',
  'This tasks-only planning stage intentionally has no Design-Contract package.',
  '- Read requirements.md, spec.md, context.md/research.md when present, project evidence, and current human feedback.',
  '- Do not read, create, require, repair, or reference the five design files or design_review.md.',
  '- Create or repair only tasks.md with R*/AC*/SCN-* coverage, E* evidence, dependencies, file intent, done signals, and focused verification for affected MMO domains.',
  '- Do not invent Design-Contract IDs or add `_Design_` metadata.',
  '- Do not write implementation_plan.md; the runtime derives it from validated tasks.md.',
].join('\n');

function buildNonImplementationMmoSpecPhaseOverride(phase: string): string {
  return [
    '## NON-IMPLEMENTATION MMO SPEC-PHASE OVERRIDE',
    `The active owner phase is ${phase}; the static MMO tasks-planning instructions do not apply to this session.`,
    '- Follow the phase-specific kickoff and output schema. Produce or review only the artifact owned by this phase.',
    '- Do not read, create, require, repair, or reference the five design files or design_review.md.',
    '- Do not create or modify tasks.md or implementation_plan.md in this phase.',
    '- Do not invent Design-Contract IDs, `_Design_` metadata, architecture, implementation tasks, or source changes.',
  ].join('\n');
}

export function appendWorkerDesignContractExemptOrchestrationOverride(
  prompt: string,
  promptName: string,
  designContractExempt: boolean | undefined,
  phase?: string,
): string {
  if (designContractExempt !== true) {
    return prompt;
  }
  if (promptName === 'spec_orchestrator_agentic') {
    return `${prompt}\n\n${NON_IMPLEMENTATION_AGENTIC_ORCHESTRATOR_OVERRIDE}`;
  }
  if (promptName === 'mmo_system_designer') {
    if (phase === 'planning') {
      return `${prompt}\n\n${NON_IMPLEMENTATION_MMO_PLANNING_OVERRIDE}`;
    }
    if (phase) {
      return `${prompt}\n\n${buildNonImplementationMmoSpecPhaseOverride(phase)}`;
    }
  }
  return prompt;
}
