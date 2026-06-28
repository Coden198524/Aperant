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
    expect(toolJsonPrompt).toContain('even when the model creates, reads, or updates the content');
    expect(toolJsonPrompt).toContain('app-parsed structured outputs as JSON/JSONL');
    expect(toolJsonPrompt).toContain('Do not convert JSON config/tables just because they are mentioned in prompts');
    expect(toolJsonPrompt).toContain('Convert only pure prose/reference artifacts');
    expect(toolJsonPrompt).toContain('package.json');
    expect(toolJsonPrompt).toContain('tsconfig.json');
    expect(specPrompt).toContain('task_metadata.json');
    expect(specPrompt).toContain('change_requests.jsonl');
    expect(specPrompt).toContain('prompt_profile.json');
    expect(specPrompt).toContain('roadmap.json');
    expect(specPrompt).toContain('roadmap_discovery.json');
    expect(specPrompt).toContain('ideation.json');
    expect(specPrompt).toContain('downstream UI/runtime code parses the output');
    expect(specPrompt).toContain('Do not convert JSON configuration tables or app-owned structured data merely because a model prompt references them');
    expect(plannerPrompt).toContain('app-owned JSON/JSONL/config artifacts');
    expect(plannerPrompt).toContain('Write Markdown checklist text, not JSON');
    expect(plannerPrompt).toContain('Ground architecture in the current project');
    expect(plannerPrompt).toContain('Do not add standalone research, architecture review');
    expect(plannerPrompt).toContain('Use an OpenSpec-like flow');
  });

  it('keeps bundled coder prompt contract-aware and reviewable', () => {
    const coderPrompt = readPrompt('coder.md');

    expect(coderPrompt).toContain('identify the local contract');
    expect(coderPrompt).toContain('public APIs, schemas, IPC/protocol contracts');
    expect(coderPrompt).toContain('placeholder code');
    expect(coderPrompt).toContain('closest regression test');
    expect(coderPrompt).toContain('touched files/contracts, verification, and remaining risk');
    expect(coderPrompt).toContain('touched contracts/APIs');
  });

  it('keeps QA prompts evidence-bound and contract-aware', () => {
    const reviewerPrompt = readPrompt('qa_reviewer.md');
    const fixerPrompt = readPrompt('qa_fixer.md');
    const mmoReviewerPrompt = readPrompt('mmo_qa_reviewer.md');
    const mmoFixerPrompt = readPrompt('mmo_qa_fixer.md');

    expect(reviewerPrompt).toContain('Review Method');
    expect(reviewerPrompt).toContain('Changed Files And Contracts');
    expect(reviewerPrompt).toContain('Acceptance Matrix');
    expect(reviewerPrompt).toContain('impacted requirement or contract');
    expect(reviewerPrompt).toContain('expected re-verification');
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
});
