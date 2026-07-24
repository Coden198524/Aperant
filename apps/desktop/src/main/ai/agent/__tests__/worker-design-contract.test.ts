import { describe, expect, it } from 'vitest';

import {
  appendWorkerDesignContractExemptExecutionOverride,
  appendWorkerDesignContractExemptPlannerOverride,
  resolveWorkerDesignContractExemption,
  resolveWorkerEffectiveDesignContractExemption,
} from '../worker-design-contract';

describe('worker Design-Contract exemption plumbing', () => {
  it.each([
    {
      label: 'requirements workflow',
      input: { requirements: { workflow_type: 'documentation' } },
    },
    {
      label: 'runtime plan workflow',
      input: { plan: { workflow_type: 'research' } },
    },
    {
      label: 'task metadata',
      input: { metadata: { taskType: 'analysis' } },
    },
    {
      label: 'project documentation metadata',
      input: { metadata: { sourceType: 'project_docs' } },
    },
  ])('recognizes non-implementation work from $label', ({ input }) => {
    expect(resolveWorkerDesignContractExemption(input)).toBe(true);
  });

  it('lets an explicit implementation request override analysis metadata', () => {
    expect(resolveWorkerDesignContractExemption({
      metadata: { taskType: 'analysis' },
      requirements: {
        workflow_type: 'analysis',
        task_description: 'Analyze the worker lifecycle.',
      },
      humanInput: 'Fix the worker lifecycle and update its tests.',
    })).toBe(false);
  });

  it('does not treat generic acceptance wording as an implementation request', () => {
    expect(resolveWorkerDesignContractExemption({
      requirements: {
        workflow_type: 'investigation',
        task_description: 'Investigate the failure and write a report.',
        acceptance_criteria: ['The requested change is implemented according to the task description.'],
      },
    })).toBe(true);
  });

  it('appends a final system-level override to static planner prompts', () => {
    const basePrompt = [
      '# Planner',
      'Read the complete five-file design package.',
      'Every task requires `_Design_` metadata.',
    ].join('\n');

    const prompt = appendWorkerDesignContractExemptPlannerOverride(
      basePrompt,
      'planner',
      true,
    );

    expect(prompt).toContain('## NON-IMPLEMENTATION PLANNING OVERRIDE');
    expect(prompt).toContain('supersedes any earlier generic planner instruction');
    expect(prompt).toContain('Do not invent Design-Contract IDs or add `_Design_` metadata.');
    expect(prompt.indexOf('## NON-IMPLEMENTATION PLANNING OVERRIDE'))
      .toBeGreaterThan(prompt.indexOf('five-file design package'));
  });

  it('prefers the orchestrator Design-Contract decision over the worker fallback', () => {
    expect(resolveWorkerEffectiveDesignContractExemption(false, false)).toBe(true);
    expect(resolveWorkerEffectiveDesignContractExemption(true, true)).toBe(false);
    expect(resolveWorkerEffectiveDesignContractExemption(undefined, true)).toBe(true);
    expect(resolveWorkerEffectiveDesignContractExemption(undefined, false)).toBe(false);
  });

  it.each([
    ['coder', '## NON-IMPLEMENTATION EXECUTION OVERRIDE', 'design preflight'],
    ['qa_reviewer', '## NON-IMPLEMENTATION QA OVERRIDE', 'design IDs'],
    ['qa_fixer', '## NON-IMPLEMENTATION QA FIX OVERRIDE', 'source-code bugs'],
  ])('appends a final no-design override to %s prompts', (promptName, heading, supersededRule) => {
    const basePrompt = `# Base ${promptName}\nRequires ${supersededRule} and the five-file design package.`;
    const prompt = appendWorkerDesignContractExemptExecutionOverride(
      basePrompt,
      promptName,
      true,
    );

    expect(prompt).toContain(heading);
    expect(prompt).toContain('intentionally has no Design-Contract package');
    expect(prompt.indexOf(heading)).toBeGreaterThan(prompt.indexOf(supersededRule));
  });

  it('does not change execution prompts for implementation work or unrelated agents', () => {
    expect(appendWorkerDesignContractExemptExecutionOverride(
      'coder prompt',
      'coder',
      false,
    )).toBe('coder prompt');
    expect(appendWorkerDesignContractExemptExecutionOverride(
      'planner prompt',
      'planner',
      true,
    )).toBe('planner prompt');
  });

  it('leaves implementation and non-planner prompts unchanged', () => {
    expect(appendWorkerDesignContractExemptPlannerOverride(
      'planner prompt',
      'planner',
      false,
    )).toBe('planner prompt');
    expect(appendWorkerDesignContractExemptPlannerOverride(
      'coder prompt',
      'coder',
      true,
    )).toBe('coder prompt');
  });
});
