import { describe, expect, it } from 'vitest';

import {
  type AutocodeProjectPromptProfile,
  buildAutocodeCompactProjectPromptProfileSection,
  buildAutocodeProjectPromptProfileSection,
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
