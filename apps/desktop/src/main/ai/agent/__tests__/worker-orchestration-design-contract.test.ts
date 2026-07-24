import { describe, expect, it } from 'vitest';

import { appendWorkerDesignContractExemptOrchestrationOverride } from '../worker-orchestration-design-contract';

describe('worker agentic and MMO Design-Contract exemption prompts', () => {
  it('overrides the full agentic design pipeline with three owner stages', () => {
    const prompt = appendWorkerDesignContractExemptOrchestrationOverride(
      'Run the complete Design-Contract: 5 pipeline.',
      'spec_orchestrator_agentic',
      true,
    );

    expect(prompt).toContain('## NON-IMPLEMENTATION AGENTIC FLOW OVERRIDE');
    expect(prompt).toContain('`spec_gatherer -> spec_writer -> planner`');
    expect(prompt).toContain('Do not dispatch requirement_modeler, domain_modeler, software_designer');
    expect(prompt.indexOf('NON-IMPLEMENTATION AGENTIC FLOW OVERRIDE'))
      .toBeGreaterThan(prompt.indexOf('Design-Contract: 5 pipeline'));
  });

  it('adds the MMO tasks-only override only to exempt planning prompts', () => {
    const planning = appendWorkerDesignContractExemptOrchestrationOverride(
      'Read the five-file design package.',
      'mmo_system_designer',
      true,
      'planning',
    );
    const requirements = appendWorkerDesignContractExemptOrchestrationOverride(
      'Requirements prompt.',
      'mmo_system_designer',
      true,
      'requirements',
    );
    const selfCritique = appendWorkerDesignContractExemptOrchestrationOverride(
      'Self-critique prompt.',
      'mmo_system_designer',
      true,
      'self_critique',
    );

    expect(planning).toContain('## NON-IMPLEMENTATION MMO PLANNING OVERRIDE');
    expect(planning).toContain('Do not invent Design-Contract IDs or add `_Design_` metadata');
    expect(requirements).toContain('## NON-IMPLEMENTATION MMO SPEC-PHASE OVERRIDE');
    expect(requirements).toContain('The active owner phase is requirements');
    expect(requirements).toContain('Do not create or modify tasks.md or implementation_plan.md');
    expect(requirements).not.toContain('## NON-IMPLEMENTATION MMO PLANNING OVERRIDE');
    expect(selfCritique).toContain('## NON-IMPLEMENTATION MMO SPEC-PHASE OVERRIDE');
    expect(selfCritique).toContain('The active owner phase is self_critique');
    expect(selfCritique).toContain('Do not create or modify tasks.md or implementation_plan.md');
    expect(selfCritique).not.toContain('## NON-IMPLEMENTATION MMO PLANNING OVERRIDE');
  });

  it('leaves implementation prompts unchanged', () => {
    expect(appendWorkerDesignContractExemptOrchestrationOverride(
      'Agentic prompt.',
      'spec_orchestrator_agentic',
      false,
    )).toBe('Agentic prompt.');
    expect(appendWorkerDesignContractExemptOrchestrationOverride(
      'MMO planner prompt.',
      'mmo_system_designer',
      false,
      'planning',
    )).toBe('MMO planner prompt.');
  });
});
