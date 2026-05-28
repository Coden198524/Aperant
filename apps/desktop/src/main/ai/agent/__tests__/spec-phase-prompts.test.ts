import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { specPhaseToPromptName } from '../spec-phase-prompts';

describe('spec phase prompt mapping', () => {
  it('routes validation to the validation fixer prompt', () => {
    expect(specPhaseToPromptName('validation')).toBe('validation_fixer');
  });

  it('keeps validation fixer guidance focused on edit-based fixes', () => {
    const prompt = readFileSync(join(process.cwd(), 'prompts', 'validation_fixer.md'), 'utf-8');

    expect(prompt).toContain('Use Edit for the smallest affected section');
    expect(prompt).toContain('do NOT rewrite the whole file with Write');
    expect(prompt).toContain('single concise Markdown checklist');
  });
});
