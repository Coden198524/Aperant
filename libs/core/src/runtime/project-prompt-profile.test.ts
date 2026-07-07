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

  it('keeps generated Standard planning prompts compact and task-first', () => {
    const prompts = generateAutocodeProjectPromptOverrides(createProfile());
    const planner = prompts.planner;
    const specQuick = prompts.spec_quick;

    expect(planner).toContain('Create or repair one upstream `tasks.md`');
    expect(planner).toContain('Update `spec.md` or `requirements.md` only when missing, stale, or required by real Request Changes feedback');
    expect(planner).toContain('runtime file-conflict scheduler queues overlapping writes');
    expect(planner).toContain('Add architecture metadata only for cross-boundary, migration, schema/compatibility, or high-risk work');
    expect(planner).toContain('Every executable task needs precise file metadata, exactly one dependency line');
    expect(planner).toContain('Request Changes');
    expect(planner).toContain('Never prefix task titles with revision');
    expect(planner).not.toContain('OpenSpec');
    expect(planner).not.toContain('Do not cap tasks.md by phase or task count');
    expect(planner).not.toContain('Architecture Grounding');
    expect(planner).not.toContain('First update');
    expect(planner).not.toContain('needs_revision');
    expect(planner.length).toBeLessThan(7_000);

    expect(specQuick).toContain('Write a compact Standard plan');
    expect(specQuick).toContain('Split only by real behavior, contract, data shape, UI surface, risky error path, or verification scenario');
    expect(specQuick).toContain('Shared files do not imply dependencies');
    expect(specQuick).toContain('_Done when:');
    expect(specQuick).toContain('Static syntax, unit, lint, typecheck, build, or file-existence checks alone are not enough');
    expect(specQuick).not.toContain('OpenSpec');
    expect(specQuick).not.toContain('Do not cap task count');
    expect(specQuick).not.toContain('Architecture Grounding');
    expect(specQuick.length).toBeLessThan(7_000);
  });

  it('grounds generated coder prompts in implementation contracts and reviewable summaries', () => {
    const coder = generateAutocodeProjectPromptOverrides(createProfile()).coder;

    expect(coder).toContain('Identify the local contract before editing');
    expect(coder).toContain('public APIs, schemas, IPC/protocol contracts');
    expect(coder).toContain('Do not leave placeholder code');
    expect(coder).toContain('closest regression test');
    expect(coder).toContain('mark `[x]` when complete');
    expect(coder).toContain('do not mark the subtask complete until the launch/open/browser/CLI smoke path passes');
  });

  it('grounds generated QA prompts in acceptance matrices and changed contracts', () => {
    const prompts = generateAutocodeProjectPromptOverrides(createProfile());

    expect(prompts.qa_reviewer).toContain('map requirement/evidence -> changed file/contract -> verification result -> residual risk');
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
