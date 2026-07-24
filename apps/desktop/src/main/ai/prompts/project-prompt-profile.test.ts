import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PROJECT_PROMPT_PROFILE_VERSION,
  buildCompactProjectPromptProfileSection,
  buildProjectPromptProfileSection,
  generateProjectPromptProfile,
  initializeProjectPromptProfile,
  loadProjectPromptOverride,
  loadProjectPromptProfile,
} from './project-prompt-profile';

let tempDirs: string[] = [];

function makeProject(): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'prompt-profile-test-'));
  tempDirs.push(projectDir);
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  mkdirSync(join(projectDir, 'src', '__tests__'), { recursive: true });
  mkdirSync(join(projectDir, '.autocode'), { recursive: true });
  writeFileSync(join(projectDir, 'package-lock.json'), '{}\n', 'utf-8');
  writeFileSync(join(projectDir, 'AGENTS.md'), '# Project Rules\n\nUse project conventions.\n', 'utf-8');
  writeFileSync(join(projectDir, 'biome.json'), JSON.stringify({ formatter: { indentStyle: 'space' } }), 'utf-8');
  writeFileSync(join(projectDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }), 'utf-8');
  writeFileSync(join(projectDir, 'vite.config.ts'), 'export default {};\n', 'utf-8');
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({
      scripts: {
        build: 'vite build',
        test: 'vitest run',
        lint: 'biome check .',
        typecheck: 'tsc --noEmit',
      },
      dependencies: {
        '@vitejs/plugin-react': 'latest',
        react: 'latest',
        vite: 'latest',
      },
      devDependencies: {
        '@biomejs/biome': 'latest',
        typescript: 'latest',
        vitest: 'latest',
      },
    }, null, 2),
    'utf-8',
  );
  writeFileSync(join(projectDir, 'src', 'App.tsx'), 'export function App() { return null; }\n', 'utf-8');
  writeFileSync(join(projectDir, 'src', '__tests__', 'App.test.tsx'), 'import { describe } from "vitest";\n', 'utf-8');
  return projectDir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('project prompt profile', () => {
  it('generates a lightweight profile and prompt overrides for a small project', () => {
    const projectDir = makeProject();

    const profile = initializeProjectPromptProfile(projectDir, { overwrite: true });

    expect(profile.project.size).toBe('small');
    expect(profile.project.domain).toBe('web');
    expect(profile.workflow.promptIntensity).toBe('lightweight');
    expect(profile.workflow.specStyle).toBe('standard');
    expect(profile.commands.build).toContain('npm run build');
    expect(profile.commands.test).toContain('npm run test');
    expect(profile.conventions.instructionFiles).toContain('AGENTS.md');
    expect(profile.conventions.configFiles).toContain('biome.json');
    expect(profile.conventions.configFiles).toContain('tsconfig.json');
    expect(profile.conventions.sourceRoots).toContain('src');
    expect(profile.conventions.testRoots).toContain('src/__tests__');
    expect(profile.conventions.frameworkConventions.join('\n')).toContain('React conventions');
    expect(profile.conventions.codingRules.join('\n')).toContain('Biome');

    const storedProfile = loadProjectPromptProfile(projectDir);
    expect(storedProfile?.project.name).toBe(profile.project.name);

    const coderOverride = loadProjectPromptOverride(projectDir, 'coder');
    expect(coderOverride?.content).toContain('PROJECT-SPECIFIC PROMPT');
    expect(coderOverride?.content).toContain('PROJECT CONVENTIONS');
    expect(coderOverride?.content).toContain('Rule files to respect: AGENTS.md');
    expect(coderOverride?.content).toContain('React conventions');
    expect(coderOverride?.content).toContain('Implement the current work package');
    expect(coderOverride?.content).toContain('design pattern decision');
    expect(coderOverride?.content).toContain('Identify the local contract before editing');
    expect(coderOverride?.content).toContain('public APIs, schemas, IPC/protocol contracts');
    expect(coderOverride?.content).toContain('Do not leave placeholder code');
    expect(coderOverride?.content).toContain('closest regression test');
    expect(coderOverride?.content).toContain('read the current narrow context');
    expect(coderOverride?.content).toContain('legacy or non-UTF-8 files as encoding-sensitive');
    expect(coderOverride?.content).toContain('do not mark the subtask complete until the launch/open/browser/CLI smoke path passes');
    expect(coderOverride?.content).toContain('TOOL CALL JSON SAFETY');
    expect(coderOverride?.content).toContain('forward slashes');
    expect(coderOverride?.content).toContain('both keys');
    expect(coderOverride?.content).toContain('without imposing a line or character limit');
    expect(coderOverride?.content).not.toContain('20-60 line');
    expect(existsSync(join(projectDir, '.autocode', 'prompts', 'spec_quick.md'))).toBe(false);

    const plannerOverride = loadProjectPromptOverride(projectDir, 'planner');
    expect(plannerOverride?.content).toContain('Create or repair the static definition catalog in `tasks.md`');
    expect(plannerOverride?.content).toContain('Write only `tasks.md`');
    expect(plannerOverride?.content).toContain('all five design-package files');
    expect(plannerOverride?.content).toContain('`requirement_model.md`');
    expect(plannerOverride?.content).toContain('`domain_model.md`');
    expect(plannerOverride?.content).toContain('`design_model.md`');
    expect(plannerOverride?.content).toContain('`implementation_model.md`');
    expect(plannerOverride?.content).toContain('Resolve design IDs from their canonical package owner');
    expect(plannerOverride?.content).toContain('do not edit them');
    expect(plannerOverride?.content).toContain('Every executable task needs precise file metadata, exactly one dependency line');
    expect(plannerOverride?.content).toContain('runtime file-conflict scheduler queues overlapping writes');
    expect(plannerOverride?.content).toContain('Add architecture metadata only for cross-boundary, migration, schema/compatibility, or high-risk work');
    expect(plannerOverride?.content).toContain('Never prefix task titles with revision');
    expect(plannerOverride?.content).toContain('Omit copied source, long rationale');
    expect(plannerOverride?.content).not.toContain('OpenSpec');
    expect(plannerOverride?.content).not.toContain('Do not cap tasks.md by phase or task count');
    expect(plannerOverride?.content).not.toContain('Architecture Grounding');
    expect(plannerOverride?.content).not.toContain('needs_revision');
    expect((plannerOverride?.content.length ?? 0)).toBeLessThan(7_500);

    const qaReviewerOverride = loadProjectPromptOverride(projectDir, 'qa_reviewer');
    expect(qaReviewerOverride?.content).toContain('map requirement/evidence -> changed file/contract -> verification result -> residual risk');
    expect(qaReviewerOverride?.content).toContain('public APIs, schemas, IPC/protocols');
    expect(qaReviewerOverride?.content).toContain('Acceptance Matrix');
    expect(qaReviewerOverride?.content).toContain('impacted requirement/contract');
    expect(qaReviewerOverride?.content).toContain('reject `Status: PASSED` when runtime readiness is missing');

    const qaFixerOverride = loadProjectPromptOverride(projectDir, 'qa_fixer');
    expect(qaFixerOverride?.content).toContain('caller/callee expectations');
    expect(qaFixerOverride?.content).toContain('Preserve public APIs, schemas, IPC/protocols');
    expect(qaFixerOverride?.content).toContain('placeholder code');
    expect(qaFixerOverride?.content).toContain('rerun the exact runtime-readiness smoke path');
  });

  it('builds an adaptation section for bundled prompts', () => {
    const projectDir = makeProject();
    const profile = generateProjectPromptProfile(projectDir);

    const section = buildProjectPromptProfileSection(profile);

    expect(section).toContain('PROJECT PROMPT ADAPTATION');
    expect(section).toContain('Apply web domain checks only when they are relevant');
    expect(section).toContain('Rule files: AGENTS.md');
    expect(section).toContain('Project-specific rules and flow');
    expect(section).toContain('Typecheck: npm run typecheck');
  });

  it('builds a compact adaptation section for Direct mode prompts', () => {
    const projectDir = makeProject();
    const profile = generateProjectPromptProfile(projectDir);

    const section = buildCompactProjectPromptProfileSection(profile);

    expect(section).toContain('PROJECT PROFILE');
    expect(section).toContain('Rules: AGENTS.md');
    expect(section).toContain('Roots: src');
    expect(section).toContain('typecheck: npm run typecheck');
    expect(section).not.toContain('PROJECT PROMPT ADAPTATION');
    expect(section.length).toBeLessThan(700);
  });

  it('does not overwrite existing project prompt overrides unless requested', () => {
    const projectDir = makeProject();
    initializeProjectPromptProfile(projectDir, { overwrite: true });

    const coderPath = join(projectDir, '.autocode', 'prompts', 'coder.md');
    writeFileSync(coderPath, 'custom coder prompt\n', 'utf-8');

    initializeProjectPromptProfile(projectDir, { overwrite: false });
    expect(readFileSync(coderPath, 'utf-8')).toBe('custom coder prompt\n');

    initializeProjectPromptProfile(projectDir, { overwrite: true });
    expect(readFileSync(coderPath, 'utf-8')).toContain('PROJECT-SPECIFIC PROMPT');
  });

  it('keeps generated prompt overrides when a refreshed profile uses standard workflow', () => {
    const projectDir = makeProject();
    initializeProjectPromptProfile(projectDir, { overwrite: true });

    const coderPath = join(projectDir, '.autocode', 'prompts', 'coder.md');
    expect(existsSync(coderPath)).toBe(true);

    for (let i = 0; i < 45; i += 1) {
      writeFileSync(join(projectDir, 'src', `module-${i}.ts`), `export const value${i} = ${i};\n`, 'utf-8');
    }

    const profile = initializeProjectPromptProfile(projectDir, { overwrite: true });

    expect(profile.workflow.promptIntensity).toBe('standard');
    expect(existsSync(coderPath)).toBe(true);
    expect(readFileSync(coderPath, 'utf-8')).toContain('Workflow intensity: standard');
  });

  it('refreshes stale generated prompts when the profile version changes', () => {
    const projectDir = makeProject();
    initializeProjectPromptProfile(projectDir, { overwrite: true });

    const profilePath = join(projectDir, '.autocode', 'prompt_profile.json');
    const coderPath = join(projectDir, '.autocode', 'prompts', 'coder.md');
    const removedQuickSpecPath = join(projectDir, '.autocode', 'prompts', 'spec_quick.md');

    writeFileSync(profilePath, JSON.stringify({ version: 1, project: {}, workflow: {} }), 'utf-8');
    writeFileSync(
      coderPath,
      '## PROJECT-SPECIFIC PROMPT (GENERATED)\n\nold generated prompt\n',
      'utf-8',
    );
    writeFileSync(
      removedQuickSpecPath,
      '## PROJECT-SPECIFIC PROMPT (GENERATED)\n\nremoved quick-spec prompt\n',
      'utf-8',
    );

    initializeProjectPromptProfile(projectDir, { overwrite: false });

    expect(readFileSync(profilePath, 'utf-8')).toContain(`"version": ${PROJECT_PROMPT_PROFILE_VERSION}`);
    expect(readFileSync(coderPath, 'utf-8')).toContain('Implement the current work package');
    expect(readFileSync(coderPath, 'utf-8')).not.toContain('old generated prompt');
    expect(existsSync(removedQuickSpecPath)).toBe(false);
  });
});
