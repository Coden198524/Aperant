import { describe, expect, it } from 'vitest';
import {
  formatCompactChecklistForPrompt,
  type PreImplementationChecklist,
} from '../pre-implementation-checklist';

describe('pre-implementation checklist formatting', () => {
  it('keeps prompt guidance compact and focused on high-risk items', () => {
    const checklist: PreImplementationChecklist = {
      subtaskId: '1.1',
      riskLevel: 'high',
      generatedAt: '2026-06-05T00:00:00.000Z',
      filesToReview: ['src/api.ts', 'src/api.test.ts', 'src/schema.ts', 'src/extra.ts'],
      items: [
        {
          category: 'security',
          priority: 'critical',
          issue: 'Missing input validation',
          prevention: 'Validate all user input at the IPC boundary.',
          likelihood: 0.8,
        },
        {
          category: 'file_type',
          priority: 'high',
          issue: 'Type errors',
          prevention: 'Run the project typecheck after edits.',
          likelihood: 0.7,
        },
        {
          category: 'performance',
          priority: 'medium',
          issue: 'Extra re-render',
          prevention: 'Memoize expensive selectors.',
          likelihood: 0.4,
        },
      ],
    };

    const prompt = formatCompactChecklistForPrompt(checklist);

    expect(prompt).toContain('Missing input validation');
    expect(prompt).toContain('Type errors');
    expect(prompt).not.toContain('Extra re-render');
    expect(prompt).toContain('src/api.ts, src/api.test.ts, src/schema.ts');
    expect(prompt).not.toContain('src/extra.ts');
    expect(prompt.length).toBeLessThan(500);
  });
});
