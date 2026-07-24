import { describe, expect, it } from 'vitest';

import { selectAutocodeSpecPhases } from './spec-orchestrator-strategy.js';

describe('selectAutocodeSpecPhases non-implementation routing', () => {
  it.each([
    'Analyze task logs and write a findings report.',
    'Investigate the startup failure and explain the root cause.',
    'Generate a project documentation pack. Do not modify product source code.',
    'Analyze task logs and generate a Markdown findings report without modifying source code.',
  ])('skips the Design-Contract: 5 phases for %s', (taskDescription) => {
    const phases = selectAutocodeSpecPhases({
      complexity: 'standard',
      taskDescription,
      workflowConfig: {},
    });

    expect(phases).toEqual(['requirements', 'spec_writing', 'planning', 'validation']);
  });

  it('keeps a requested research phase while still skipping the design package', () => {
    const phases = selectAutocodeSpecPhases({
      complexity: 'standard',
      taskDescription: 'Research the current API behavior and generate documentation.',
      workflowConfig: {},
    });

    expect(phases).toEqual([
      'requirements',
      'research',
      'spec_writing',
      'planning',
      'validation',
    ]);
  });

  it('uses metadata and plan workflow classifications without requiring text signals', () => {
    expect(selectAutocodeSpecPhases({
      complexity: 'standard',
      taskDescription: 'Inspect the requested deliverable.',
      metadata: { sourceType: 'project_docs' },
      workflowConfig: {},
    })).toEqual(['requirements', 'spec_writing', 'planning', 'validation']);
    expect(selectAutocodeSpecPhases({
      complexity: 'standard',
      taskDescription: 'Inspect the requested deliverable.',
      plan: { workflow_type: 'research' },
      workflowConfig: {},
    })).toEqual(['requirements', 'spec_writing', 'planning', 'validation']);
  });

  it('keeps optional complex analysis phases while removing only the design package', () => {
    const phases = selectAutocodeSpecPhases({
      complexity: 'complex',
      assessment: { needs_research: true, needs_self_critique: true },
      taskDescription: 'Analyze the platform and produce a research report.',
      workflowConfig: { optimizationLevel: 'conservative' },
    });

    expect(phases).toEqual([
      'discovery',
      'requirements',
      'research',
      'context',
      'spec_writing',
      'self_critique',
      'planning',
      'validation',
    ]);
  });

  it.each([
    'Analyze the failure and fix worker.ts.',
    'Create a documentation generator for API modules.',
    'Build document upload integration.',
    'Do not only analyze; implement the feature.',
  ])('keeps the complete design sequence for implementation request %s', (taskDescription) => {
    const phases = selectAutocodeSpecPhases({
      complexity: 'standard',
      taskDescription,
      workflowConfig: {},
    });

    expect(phases).toContain('requirement_model');
    expect(phases).toContain('design');
    expect(phases).toContain('implementation_model');
    expect(phases).toContain('design_review');
  });
});
