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

    expect(prompt).toContain('smallest affected section before editing');
    expect(prompt).toContain('repair `tasks.md`; the runtime will derive `implementation_plan.md` again');
    expect(prompt).toContain('Return a concise list of the owning artifact');
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
    expect(plannerPrompt).toContain('app-state, manifest, settings, metadata, index, or parsed-config files');
    expect(plannerPrompt).toContain('runtime derives `implementation_plan.md`');
    expect(plannerPrompt).toContain('Write only `tasks.md` in the spec directory');
    expect(specPrompt).toContain('Retry only the failed owner');
    expect(specPrompt).toContain('Stop for human review after validated `tasks.md`');
  });

  it('keeps active Standard prompts aligned with the five-file design package', () => {
    const orchestrator = readPrompt('spec_orchestrator_agentic.md');
    const validationFixer = readPrompt('validation_fixer.md');
    const reviewer = readPrompt('qa_reviewer.md');
    const followupPlanner = readPrompt('followup_planner.md');
    const mmoPlanner = readPrompt('mmo_system_designer.md');

    expect(orchestrator).toContain('requirement_modeler -> domain_modeler -> software_designer -> design_modeler -> implementation_modeler');
    expect(orchestrator).toContain('shared `Design-Contract: 4` and `Design-Revision`');
    expect(orchestrator).not.toContain('quick_spec');
    expect(validationFixer).toContain('`requirement_model.md`: behavioral analysis');
    expect(validationFixer).toContain('`implementation_model.md`: exact repository bridge');
    expect(validationFixer).toContain('Never move a model body into `design.md`');
    expect(reviewer).toContain('Referenced sections across `requirement_model.md`, `domain_model.md`, `design.md`, `design_model.md`, and `implementation_model.md`');
    expect(followupPlanner).toContain('canonical design-package owner');
    expect(mmoPlanner).toContain('complete five-file design package');
  });

  it('keeps bundled coder prompt contract-aware and reviewable', () => {
    const coderPrompt = readPrompt('coder.md');

    expect(coderPrompt).toContain('Identify affected contracts before editing');
    expect(coderPrompt).toContain('APIs, schemas, IPC/protocol');
    expect(coderPrompt).toContain('placeholder code');
    expect(coderPrompt).toContain('closest regression test');
    expect(coderPrompt).toContain('changed files/contracts, verification, residual risk');
    expect(coderPrompt).toContain('touched contracts');
  });

  it('requires deep but bounded paradigm-aware design for stateful interactive systems', () => {
    const designerPrompt = readPrompt('software_designer.md');
    const requirementModelerPrompt = readPrompt('requirement_modeler.md');
    const domainModelerPrompt = readPrompt('domain_modeler.md');
    const designModelerPrompt = readPrompt('design_modeler.md');
    const implementationModelerPrompt = readPrompt('implementation_modeler.md');
    const criticPrompt = readPrompt('design_critic.md');

    expect(designerPrompt).toContain('Design-Contract: 4');
    expect(designerPrompt).toContain('Never choose by implementation language alone');
    expect(designerPrompt).toContain('Analysis direction');
    expect(designerPrompt).toContain('Candidate patterns evaluated');
    expect(designerPrompt).toContain('God coordinators, anemic models');
    expect(requirementModelerPrompt).toContain('### RM-001');
    expect(requirementModelerPrompt).toContain('Alternate or failure flow');
    expect(domainModelerPrompt).toContain('### DOM-001');
    expect(domainModelerPrompt).toContain('Rules and invariants');
    expect(designModelerPrompt).toContain('### SYS-001');
    expect(designModelerPrompt).toContain('### DES-001');
    expect(designModelerPrompt).toContain('CRC reasoning');
    expect(implementationModelerPrompt).toContain('### IMP-001');
    expect(implementationModelerPrompt).toContain('Project files and symbols');
    expect(criticPrompt).toContain('Underdesign Gate');
    expect(criticPrompt).toContain('NOP is not a pattern-avoidance principle');
    expect(criticPrompt).toContain('greenfield or new-subsystem interactive design');
  });

  it('keeps QA prompts evidence-bound and contract-aware', () => {
    const reviewerPrompt = readPrompt('qa_reviewer.md');
    const fixerPrompt = readPrompt('qa_fixer.md');
    const mmoReviewerPrompt = readPrompt('mmo_qa_reviewer.md');
    const mmoFixerPrompt = readPrompt('mmo_qa_fixer.md');

    expect(reviewerPrompt).toContain('Pass Criteria');
    expect(reviewerPrompt).toContain('Changed Files And Contracts');
    expect(reviewerPrompt).toContain('Acceptance Matrix');
    expect(reviewerPrompt).toContain('impacted requirement/SYS/DES/FLOW/REV/IMP IDs');
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

  it('keeps the complexity assessor aligned with the Standard owner chain', () => {
    const prompt = readPrompt('complexity_assessor.md');

    expect(prompt).toContain('Every route preserves the Standard owner chain');
    expect(prompt).toContain('requirements -> spec_writing -> requirement_model -> domain_model -> design -> design_model -> implementation_model -> design_review -> planning -> deterministic validation');
    expect(prompt).toContain('never an owner stage');
    expect(prompt).not.toContain('quick_spec');
    expect(prompt).not.toContain('`standard`: discovery, requirements, context, spec_writing, planning, validation');
    expect(prompt).not.toContain('Do not run broad discovery');
  });

  it('keeps Standard prompts within concise bundled budgets', () => {
    const budgets: Record<string, number> = {
      'planner.md': 3600,
      'software_designer.md': 15_000,
      'design_critic.md': 6000,
      'spec_writer.md': 2200,
      'spec_orchestrator_agentic.md': 2200,
      'complexity_assessor.md': 1800,
      'coder.md': 3700,
      'qa_reviewer.md': 3000,
    };

    for (const [fileName, maxLength] of Object.entries(budgets)) {
      expect(readPrompt(fileName).length, fileName).toBeLessThanOrEqual(maxLength);
    }
  });
});
