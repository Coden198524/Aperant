import { describe, expect, it } from 'vitest';

import {
  type AutocodeProjectPromptProfile,
  buildAutocodeCompactProjectPromptProfileSection,
  buildAutocodeProjectPromptProfileSection,
  generateAutocodeProjectPromptOverrides,
} from './project-prompt-profile.js';

describe('project prompt profile formatting', () => {
  it('deduplicates repeated profile values and folds repeated guidance lines', () => {
    const repeatedContextLine = 'PROFILE_CONTEXT_REPEAT_SIGNAL';
    const duplicateFlowRule = 'Reuse the renderer module flow.';
    const profile = createProfile({
      workflow: {
        contextGuidance: Array.from({ length: 40 }, () => repeatedContextLine).join('\n'),
      },
      conventions: {
        frameworkConventions: [duplicateFlowRule, duplicateFlowRule, 'Keep IPC calls in preload adapters.'],
        architectureHints: [duplicateFlowRule, 'Keep IPC calls in preload adapters.'],
      },
    });

    const compact = buildAutocodeCompactProjectPromptProfileSection(profile);
    const full = buildAutocodeProjectPromptProfileSection(profile);

    expect(compact).toContain('39 repeated line(s) omitted for prompt budget');
    expect((compact.match(/PROFILE_CONTEXT_REPEAT/g) ?? [])).toHaveLength(1);
    expect(compact).toContain('Keep IPC calls in preload adapters.');
    expect((compact.match(/Reuse the renderer module flow/g) ?? [])).toHaveLength(1);
    expect((compact.match(/typecheck: npm run typecheck/g) ?? [])).toHaveLength(1);
    expect((full.match(/Reuse the renderer module flow/g) ?? [])).toHaveLength(1);
    expect(full).toContain('- Stack: TypeScript, JavaScript, React, Electron');
  });

  it('grounds generated planner prompts in project architecture instead of generic templates', () => {
    const prompts = generateAutocodeProjectPromptOverrides(createProfile());
    const planner = prompts.planner;

    expect(planner).toContain('ARCHITECTURE GROUNDING');
    expect(planner).toContain('affected project boundary');
    expect(planner).toContain('Do not force named architecture or design pattern guidance');
    expect(planner).toContain('For complex or high-risk tasks');
    expect(planner).toContain('Architecture And Design Pattern References');
    expect(planner).toContain('Use 4-8 bullets');
    expect(planner).toContain('Each architecture reference bullet must include four parts');
    expect(planner).toContain('_Architecture: boundary; pattern/strategy; source/reference_');
    expect(planner).toContain('general engineering experience');
    expect(planner).toContain('pattern, decision, or module insight entries for similar tasks');
    expect(planner).toContain('architecture and design pattern references');
    expect(planner).toContain('no new design pattern required');
    expect(planner).toContain('ownership, call/data flow, public contracts');
    expect(planner).toContain('Do not add standalone research, design, architecture review');
    expect(planner).toContain('Avoid generic titles such as "implement feature"');
    expect(planner).toContain('Do not cap tasks.md by phase or task count');
    expect(planner).toContain('Cover every requirement, scenario, acceptance criterion');
    expect(planner).toContain('OPENSPEC-GRADE TASK DECOMPOSITION');
    expect(planner).toContain('at least as granular as OpenSpec tasks');
    expect(planner).toContain('more than three distinct behaviors');
    expect(planner).toContain('runtime-readiness leaf task');
    expect(planner).toContain('starts/opens the artifact');
    expect(planner).toContain('Shared files are not a reason to make broad tasks');
    expect(planner).toContain('small enough for one focused coding session');
    expect(planner).toContain('REQUEST CHANGES ITERATION');
    expect(planner).toContain('active same-task contract');
    expect(planner).toContain('Apply this section only when runtime context provides valid human review feedback');
    expect(planner).toContain('ordinary validation repair');
    expect(planner).toContain('updated artifact chain');
    expect(planner).toContain('revision-state marker');
    expect(planner).not.toContain('needs_revision');
    expect(planner).not.toContain('TASK SIZE LIMITS');
    expect(planner).not.toContain('about 24 tasks or fewer');
    expect(prompts.spec_quick).toContain('Do not cap task count in quick/simple mode');
    expect(prompts.spec_quick).toContain('OPENSPEC-GRADE TASK DECOMPOSITION');
    expect(prompts.spec_quick).toContain('spec.md` must include a non-empty `## Evidence` section');
    expect(prompts.spec_quick).toContain('_Done when:');
    expect(prompts.spec_quick).toContain('Static syntax, unit, lint, typecheck, build, or file-existence checks alone are not enough');
    expect(prompts.spec_quick).not.toContain('1-4 tasks');
  });

  it('grounds generated coder prompts in implementation contracts and reviewable summaries', () => {
    const coder = generateAutocodeProjectPromptOverrides(createProfile()).coder;

    expect(coder).toContain('Identify the local implementation contract');
    expect(coder).toContain('public APIs, schemas, IPC/protocol contracts');
    expect(coder).toContain('Do not leave placeholder code');
    expect(coder).toContain('closest regression test');
    expect(coder).toContain('touched files/contracts, verification, and review notes/risks');
    expect(coder).toContain('do not mark the subtask completed until the actual launch/open/browser/CLI smoke check passes');
  });

  it('grounds generated QA prompts in acceptance matrices and changed contracts', () => {
    const prompts = generateAutocodeProjectPromptOverrides(createProfile());

    expect(prompts.qa_reviewer).toContain('completion notes against actual changed files and changed contracts');
    expect(prompts.qa_reviewer).toContain('public APIs, schemas, IPC/protocols');
    expect(prompts.qa_reviewer).toContain('Acceptance Matrix');
    expect(prompts.qa_reviewer).toContain('impacted requirement/contract');
    expect(prompts.qa_reviewer).toContain('reject `Status: PASSED` when runtime readiness is missing');
    expect(prompts.qa_fixer).toContain('caller/callee expectations');
    expect(prompts.qa_fixer).toContain('Preserve public APIs, schemas, IPC/protocols');
    expect(prompts.qa_fixer).toContain('placeholder code');
    expect(prompts.qa_fixer).toContain('rerun the exact runtime-readiness smoke path');
  });
});

type ProfileOverrides =
  & Omit<Partial<AutocodeProjectPromptProfile>, 'commands' | 'conventions' | 'project' | 'promptOverrides' | 'workflow'>
  & {
    commands?: Partial<AutocodeProjectPromptProfile['commands']>;
    conventions?: Partial<NonNullable<AutocodeProjectPromptProfile['conventions']>>;
    project?: Partial<AutocodeProjectPromptProfile['project']>;
    promptOverrides?: Partial<AutocodeProjectPromptProfile['promptOverrides']>;
    workflow?: Partial<AutocodeProjectPromptProfile['workflow']>;
  };

function createProfile(
  overrides: ProfileOverrides = {},
): AutocodeProjectPromptProfile {
  return {
    version: 1,
    generatedAt: '2026-06-16T00:00:00.000Z',
    project: {
      name: 'Aperant',
      size: 'medium',
      domain: 'desktop',
      sourceFileCount: 120,
      totalFileCount: 420,
      packageCount: 1,
      languages: ['TypeScript', 'TypeScript', 'JavaScript'],
      frameworks: ['React', 'React', 'Electron'],
      packageManagers: ['npm'],
      databases: [],
      infrastructure: [],
      ...overrides.project,
    },
    conventions: {
      instructionFiles: ['AGENTS.md', 'AGENTS.md'],
      configFiles: ['package.json'],
      sourceRoots: ['apps/desktop/src', 'apps/desktop/src'],
      testRoots: ['apps/desktop/src/__tests__'],
      frameworkConventions: ['Reuse existing React component patterns.'],
      codingRules: ['Use TypeScript and keep changes scoped.', 'Use TypeScript and keep changes scoped.'],
      architectureHints: ['Keep Electron main and renderer boundaries separate.'],
      workflowHints: ['Run targeted tests.'],
      ...overrides.conventions,
    },
    workflow: {
      promptIntensity: 'standard',
      specStyle: 'standard',
      planningGuidance: 'Plan only the affected modules.',
      contextGuidance: 'Read focused context first.',
      validationGuidance: 'Run targeted tests.',
      maxRecommendedSubtasks: 4,
      ...overrides.workflow,
    },
    commands: {
      build: ['npm run build', 'npm run build'],
      test: ['npm test'],
      lint: ['npm run lint'],
      typecheck: ['npm run typecheck', 'npm run typecheck'],
      ...overrides.commands,
    },
    promptOverrides: {
      generated: [],
      directory: '.autocode/prompts',
      ...overrides.promptOverrides,
    },
  };
}
