import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { specPhaseToPromptName } from '../spec-phase-prompts';

const promptsDir = existsSync(join(process.cwd(), 'prompts'))
  ? join(process.cwd(), 'prompts')
  : join(process.cwd(), 'apps', 'desktop', 'prompts');

function readPrompt(...segments: string[]): string {
  return readFileSync(join(promptsDir, ...segments), 'utf-8');
}

describe('spec phase prompt mapping', () => {
  it('routes validation to the validation fixer prompt', () => {
    expect(specPhaseToPromptName('validation')).toBe('validation_fixer');
  });

  it('keeps validation fixer guidance focused on edit-based fixes', () => {
    const prompt = readPrompt('validation_fixer.md');

    expect(prompt).toContain('Use Edit for the smallest affected section');
    expect(prompt).toContain('do NOT rewrite the whole file with Write');
    expect(prompt).toContain('single concise Markdown checklist');
  });

  it('keeps JSON-to-Markdown guidance scoped to prose artifacts', () => {
    const toolJsonPrompt = readPrompt('partials', 'tool_call_json_formatting.md');
    const specPrompt = readPrompt('spec_orchestrator_agentic.md');
    const plannerPrompt = readPrompt('planner.md');

    expect(toolJsonPrompt).toContain('keep app-owned configuration tables/files, manifests, settings, state, app-parsed indexes, metadata');
    expect(toolJsonPrompt).toContain('app-parsed structured outputs as JSON/JSONL');
    expect(toolJsonPrompt).toContain('Convert only pure prose/reference artifacts');
    expect(toolJsonPrompt).toContain('package.json');
    expect(toolJsonPrompt).toContain('tsconfig.json');
    expect(specPrompt).toContain('Keep JSON/JSONL/config artifacts as structured data');
    expect(specPrompt).toContain('app JSON/JSONL state');
    expect(plannerPrompt).toContain('app JSON/JSONL state');
    expect(plannerPrompt).toContain('The runtime derives `implementation_plan.md`; do not write it');
    expect(plannerPrompt).toContain('Do not add standalone research, architecture, cleanup, rollout, or broad QA tasks');
  });

  it('keeps bundled coder prompt contract-aware and reviewable', () => {
    const coderPrompt = readPrompt('coder.md');

    expect(coderPrompt).toContain('Identify affected contracts before editing');
    expect(coderPrompt).toContain('APIs, schemas, IPC/protocol');
    expect(coderPrompt).toContain('placeholder code');
    expect(coderPrompt).toContain('closest regression test');
    expect(coderPrompt).toContain('changed files/contracts, verification, and residual risk');
    expect(coderPrompt).toContain('touched contracts');
  });

  it('keeps QA prompts evidence-bound and contract-aware', () => {
    const reviewerPrompt = readPrompt('qa_reviewer.md');
    const fixerPrompt = readPrompt('qa_fixer.md');
    const mmoReviewerPrompt = readPrompt('mmo_qa_reviewer.md');
    const mmoFixerPrompt = readPrompt('mmo_qa_fixer.md');

    expect(reviewerPrompt).toContain('Pass Criteria');
    expect(reviewerPrompt).toContain('Changed Files And Contracts');
    expect(reviewerPrompt).toContain('Acceptance Matrix');
    expect(reviewerPrompt).toContain('impacted requirement/contract');
    expect(reviewerPrompt).toContain('re-verification');
    expect(fixerPrompt).toContain('caller/callee expectations');
    expect(fixerPrompt).toContain('placeholder code');
    expect(fixerPrompt).toContain('verification run');
    expect(mmoReviewerPrompt).toContain('MMO Review Method');
    expect(mmoReviewerPrompt).toContain('MMO domain matrix');
    expect(mmoReviewerPrompt).toContain('server authority');
    expect(mmoReviewerPrompt).toContain('network sync/protocol');
    expect(mmoFixerPrompt).toContain('protocol compatibility, save/config contracts');
    expect(mmoFixerPrompt).toContain('MMO domains reviewed');
  });

  it('keeps the complexity assessor aligned with compact Standard routing', () => {
    const prompt = readPrompt('complexity_assessor.md');

    expect(prompt).toContain('Balanced `standard` without research/self-critique');
    expect(prompt).toContain('compact `quick_spec` + deterministic validation');
    expect(prompt).toContain('requirements -> research -> spec_writing -> planning -> deterministic validation');
    expect(prompt).not.toContain('`standard`: discovery, requirements, context, spec_writing, planning, validation');
    expect(prompt).not.toContain('Do not run broad discovery');
  });

  it('keeps Standard prompts within concise bundled budgets', () => {
    const budgets: Record<string, number> = {
      'planner.md': 2600,
      'spec_writer.md': 2200,
      'spec_quick.md': 2200,
      'spec_orchestrator_agentic.md': 2200,
      'complexity_assessor.md': 1700,
      'coder.md': 2400,
      'qa_reviewer.md': 2000,
    };

    for (const [fileName, maxLength] of Object.entries(budgets)) {
      expect(readPrompt(fileName).length, fileName).toBeLessThanOrEqual(maxLength);
    }
  });
});
