import { describe, it, expect } from 'vitest';
import {
  ComplexityAssessmentOutputSchema,
  ImplementationPlanOutputSchema,
  QASignoffOutputSchema,
  SpecContextOutputSchema,
  RequirementsOutputSchema,
  ResearchOutputSchema,
} from '../index';

describe('ComplexityAssessmentOutputSchema', () => {
  it('should accept valid complexity assessment', () => {
    const valid = {
      complexity: 'simple',
      confidence: 0.95,
      reasoning: 'Small change to a single file',
      needs_research: false,
      needs_self_critique: false,
    };
    expect(ComplexityAssessmentOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should reject missing required fields', () => {
    expect(() => ComplexityAssessmentOutputSchema.parse({
      complexity: 'simple',
    })).toThrow();
  });

  it('should reject invalid complexity values', () => {
    expect(() => ComplexityAssessmentOutputSchema.parse({
      complexity: 'medium', // not in enum
      confidence: 0.5,
      reasoning: 'test',
      needs_research: false,
      needs_self_critique: false,
    })).toThrow();
  });
});

describe('ImplementationPlanOutputSchema', () => {
  it('should accept valid implementation plan', () => {
    const valid = {
      feature: 'Add user auth',
      workflow_type: 'feature',
      phases: [{
        id: '1',
        name: 'Setup',
        subtasks: [{
          id: '1.1',
          title: 'Create auth module',
          description: 'Set up authentication module',
          status: 'pending',
          files_to_create: ['src/auth.ts'],
          files_to_modify: ['src/app.ts'],
        }],
      }],
    };
    const result = ImplementationPlanOutputSchema.parse(valid);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].subtasks).toHaveLength(1);
  });

  it('should reject plan with no phases', () => {
    expect(() => ImplementationPlanOutputSchema.parse({
      feature: 'test',
      workflow_type: 'feature',
      phases: [],
    })).toThrow();
  });

  it('should reject subtask with invalid status', () => {
    expect(() => ImplementationPlanOutputSchema.parse({
      feature: 'test',
      workflow_type: 'feature',
      phases: [{
        id: '1',
        name: 'Phase 1',
        subtasks: [{
          id: '1.1',
          title: 'Task',
          description: 'Test',
          status: 'done', // not in enum
          files_to_create: [],
          files_to_modify: [],
        }],
      }],
    })).toThrow();
  });

  it('should accept large plans when each subtask stays concise', () => {
    const result = ImplementationPlanOutputSchema.parse({
      feature: 'Large refactor',
      workflow_type: 'refactor',
      phases: Array.from({ length: 6 }, (_, phaseIndex) => ({
        id: `phase-${phaseIndex + 1}`,
        name: `Phase ${phaseIndex + 1}`,
        subtasks: Array.from({ length: 10 }, (_, subtaskIndex) => ({
          id: `${phaseIndex + 1}-${subtaskIndex + 1}`,
          title: `Task ${phaseIndex + 1}-${subtaskIndex + 1}`,
          description: 'Concise implementation step',
          status: 'pending',
          files_to_create: [],
          files_to_modify: ['src/app.ts'],
        })),
      })),
    });

    expect(result.phases).toHaveLength(6);
    expect(result.phases[0].subtasks).toHaveLength(10);
  });
});

describe('QASignoffOutputSchema', () => {
  it('should accept approved signoff with empty issues', () => {
    const valid = {
      status: 'approved',
      issues_found: [],
    };
    expect(QASignoffOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should accept rejected signoff with issues', () => {
    const valid = {
      status: 'rejected',
      issues_found: [{
        title: 'Missing tests',
        description: 'No unit tests for auth module',
        type: 'critical',
        location: 'src/auth.ts',
        fix_required: 'Add unit tests',
      }],
    };
    expect(QASignoffOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should reject invalid status', () => {
    expect(() => QASignoffOutputSchema.parse({
      status: 'passed', // not in enum
      issues_found: [],
    })).toThrow();
  });
});

describe('Spec phase output schemas', () => {
  it('accepts compact context output', () => {
    const result = SpecContextOutputSchema.parse({
      task_description: 'Refactor renderer pipeline',
      scoped_services: ['Renderer'],
      architecture_summary: 'Renderer owns frame graph setup and pass execution.',
      files_to_modify: [{
        path: 'Source/Renderer/Renderer.cpp',
        reason: 'Main orchestration point',
        change_needed: 'Route pass execution through render graph',
      }],
      files_to_reference: [{
        path: 'Source/Renderer/RenderTask.cpp',
        reason: 'Existing render task pattern',
        pattern: 'Use existing task lifecycle hooks',
      }],
      design_patterns: [{
        name: 'Builder',
        existing_usage: 'Render tasks are configured before execution',
        files: ['Source/Renderer/RenderTask.cpp'],
        guidance: 'Reuse builder-style setup for graph nodes',
      }],
      evidence_sources: [{
        path: 'Source/Renderer/Renderer.cpp',
        symbol: 'Renderer',
        lines: '1-80',
        proves: 'Renderer owns pass execution',
        confidence: 'high',
      }],
      standards_references: ['Project rendering architecture notes'],
      assumptions: ['One legacy pass may have implicit dependencies'],
      implementation_notes: ['Keep pass ordering deterministic'],
      risks: ['Render pass dependencies may be implicit'],
      verification_suggestions: ['Run renderer unit tests'],
      created_at: '2026-05-02T00:00:00.000Z',
    });

    expect(result.files_to_modify[0].path).toBe('Source/Renderer/Renderer.cpp');
  });

  it('accepts requirements output', () => {
    const result = RequirementsOutputSchema.parse({
      task_description: 'Add task deletion',
      workflow_type: 'feature',
      services_involved: ['desktop'],
      user_requirements: ['Allow deleting unnecessary subtasks'],
      acceptance_criteria: ['Deleted subtasks no longer execute'],
      constraints: ['Do not delete completed source changes'],
      evidence_sources: ['src/tasks/store.ts - current subtask persistence'],
      standards_references: ['Project task lifecycle rules'],
      assumptions: ['No remote sync is required for deleted subtasks'],
      created_at: '2026-05-02T00:00:00.000Z',
    });

    expect(result.workflow_type).toBe('feature');
    expect(result.evidence_sources).toContain('src/tasks/store.ts - current subtask persistence');
  });

  it('accepts research output', () => {
    const result = ResearchOutputSchema.parse({
      integrations_researched: [{
        name: 'RenderGraph',
        type: 'architecture',
        verified_package: {
          name: 'internal',
          install_command: 'none',
          version: 'n/a',
          verified: true,
        },
        api_patterns: {
          imports: [],
          initialization: 'Create graph before pass execution',
          key_functions: ['compile()', 'execute()'],
          verified_against: 'project source',
        },
        configuration: {
          env_vars: [],
          config_files: [],
          dependencies: [],
        },
        gotchas: ['Resource lifetime must be explicit'],
        research_sources: ['Source/Renderer'],
      }],
      unverified_claims: [],
      recommendations: ['Prototype one pass first'],
      created_at: '2026-05-02T00:00:00.000Z',
    });

    expect(result.integrations_researched).toHaveLength(1);
  });
});
