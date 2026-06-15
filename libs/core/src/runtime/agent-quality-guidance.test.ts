import { describe, expect, it } from 'vitest';

import {
  type AutocodePreImplementationChecklist,
  formatAutocodeChecklistForPrompt,
  formatAutocodeCompactChecklistForPrompt,
} from './agent-quality-guidance.js';

function makeChecklist(overrides: Partial<AutocodePreImplementationChecklist> = {}): AutocodePreImplementationChecklist {
  return {
    subtaskId: '1.1',
    riskLevel: 'high',
    generatedAt: '2026-06-14T00:00:00.000Z',
    filesToReview: [],
    items: [],
    ...overrides,
  };
}

describe('agent quality guidance formatting', () => {
  it('bounds long checklist issue and prevention text in compact prompts', () => {
    const checklist = makeChecklist({
      items: [
        {
          category: 'historical_failure',
          priority: 'high',
          issue: `Long historical issue ${'details '.repeat(80)}ISSUE_TAIL_OK`,
          prevention: `Review the risky implementation path ${'carefully '.repeat(80)}PREVENTION_TAIL_OK`,
          likelihood: 0.9,
        },
      ],
    });

    const prompt = formatAutocodeCompactChecklistForPrompt(checklist);

    expect(prompt).toContain('Long historical issue');
    expect(prompt).toContain('checklist middle omitted');
    expect(prompt).toContain('ISSUE_TAIL_OK');
    expect(prompt).toContain('PREVENTION_TAIL_OK');
    expect(prompt.length).toBeLessThan(700);
  });

  it('folds repeated checklist lines before formatting prompt guidance', () => {
    const repeatedLine = 'CHECKLIST_REPEAT: same prevention detail without new signal.';
    const checklist = makeChecklist({
      items: [
        {
          category: 'historical_failure',
          priority: 'high',
          issue: 'Repeated implementation risk',
          prevention: [
            'CHECKLIST_PREVENTION_HEAD',
            ...Array.from({ length: 120 }, () => repeatedLine),
            'CHECKLIST_PREVENTION_TAIL',
          ].join('\n'),
          likelihood: 0.85,
        },
      ],
    });

    const prompt = formatAutocodeCompactChecklistForPrompt(checklist);

    expect(prompt).toContain('Repeated implementation risk');
    expect(prompt).toContain('CHECKLIST_PREVENTION_HEAD');
    expect(prompt).toContain('CHECKLIST_PREVENTION_TAIL');
    expect(prompt).toContain('119 repeated line(s) omitted for prompt budget');
    expect((prompt.match(/CHECKLIST_REPEAT/g) ?? [])).toHaveLength(1);
  });

  it('bounds long references in full checklist prompts', () => {
    const checklist = makeChecklist({
      filesToReview: [
        `src/${'very-long-path/'.repeat(20)}review-target.ts`,
      ],
      items: [
        {
          category: 'security',
          priority: 'critical',
          issue: 'Missing validation',
          prevention: 'Validate input at the boundary.',
          references: Array.from({ length: 7 }, (_, index) => `src/${index}-${'nested/'.repeat(20)}file-${index}.ts`),
          likelihood: 0.8,
        },
      ],
    });

    const prompt = formatAutocodeChecklistForPrompt(checklist);

    expect(prompt).toContain('Missing validation');
    expect(prompt).toContain('... 2 more');
    expect(prompt).toContain('checklist middle omitted');
    expect(prompt).toContain('review-target.ts');
    expect(prompt).toContain('file-0.ts');
    expect(prompt).not.toContain('nested/nested/nested/nested/nested/nested/nested/nested/nested/nested/nested/nested');
  });
});
