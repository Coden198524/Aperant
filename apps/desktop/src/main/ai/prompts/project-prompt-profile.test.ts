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
    expect(coderOverride?.content).toContain('Implement the next pending subtask');
    expect(coderOverride?.content).toContain('design pattern decision');
    expect(coderOverride?.content).toContain('Identify the local contract before editing');
    expect(coderOverride?.content).toContain('public APIs, schemas, IPC/protocol contracts');
    expect(coderOverride?.content).toContain('Do not leave placeholder code');
    expect(coderOverride?.content).toContain('closest regression test');
    expect(coderOverride?.content).toContain('mark `[x]` when complete');
    expect(coderOverride?.content).toContain('read the current narrow context');
    expect(coderOverride?.content).toContain('legacy or non-UTF-8 files as encoding-sensitive');
    expect(coderOverride?.content).toContain('do not mark the subtask complete until the launch/open/browser/CLI smoke path passes');
    expect(coderOverride?.content).toContain('TOOL CALL JSON SAFETY');
    expect(coderOverride?.content).toContain('forward slashes');
    expect(coderOverride?.content).toContain('both keys');
    expect(coderOverride?.content).toContain('20-60 line');
    expect(existsSync(join(projectDir, '.autocode', 'prompts', 'spec_quick.md'))).toBe(true);

    const plannerOverride = loadProjectPromptOverride(projectDir, 'planner');
    expect(plannerOverride?.content).toContain('Autocode Markdown checklist format');
    expect(plannerOverride?.content).toContain('Use the Write tool to create `tasks.md`');
    expect(plannerOverride?.content).toContain('## Task Writing');
    expect(plannerOverride?.content).toContain('Do not cap tasks.md by phase or task count');
    expect(plannerOverride?.content).toContain('make descriptions shorter instead of dropping tasks');
    expect(plannerOverride?.content).toContain('Cover every requirement, scenario, acceptance criterion');
    expect(plannerOverride?.content).toContain('## OpenSpec-Style Task Decomposition');
    expect(plannerOverride?.content).toContain('small behavior slices, clear evidence');
    expect(plannerOverride?.content).toContain('more than three behaviors');
    expect(plannerOverride?.content).toContain('startup/open/use-path evidence plus a health check');
    expect(plannerOverride?.content).toContain('console/resource-load/blank-screen/rendering/primary-path/exit-code');
    expect(plannerOverride?.content).toContain('Shared files are not a reason to make broad tasks');
    expect(plannerOverride?.content).toContain('artificial dependency chains');
    expect(plannerOverride?.content).toContain('runtime file-conflict scheduler');
    expect(plannerOverride?.content).toContain('small enough for one focused coding session');
    expect(plannerOverride?.content).toContain('## Request Changes');
    expect(plannerOverride?.content).toContain('active same-task contract');
    expect(plannerOverride?.content).toContain('Apply this section only when runtime context provides valid human review feedback');
    expect(plannerOverride?.content).toContain('ordinary validation repair');
    expect(plannerOverride?.content).toContain('Edit existing checklist items in place');
    expect(plannerOverride?.content).toContain('Never prefix task titles with revision');
    expect(plannerOverride?.content).toContain('Do not keep the only concrete Requirement Index inside `tasks.md`');
    expect(plannerOverride?.content).not.toContain('needs_revision');
    expect(plannerOverride?.content).toContain('do not split tasks.md into phase files');
    expect(plannerOverride?.content).toContain('Omit top-level `summary`, `verification_strategy`, `qa_acceptance`');
    expect(plannerOverride?.content).toContain('PARALLEL EXECUTION PLANNING');
    expect(plannerOverride?.content).toContain('Every executable subtask MUST include exactly one `_Depends on: ..._` line');
    expect(plannerOverride?.content).toContain('File metadata is write intent');
    expect(plannerOverride?.content).toContain('one `_Evidence: ..._` line');
    expect(plannerOverride?.content).toContain('## Architecture Grounding');
    expect(plannerOverride?.content).toContain('affected boundary');
    expect(plannerOverride?.content).toContain('Simple single-boundary tasks can stay direct');
    expect(plannerOverride?.content).toContain('Complex tasks need visible architecture guidance');
    expect(plannerOverride?.content).toContain('Architecture And Design Pattern References');
    expect(plannerOverride?.content).toContain('_Architecture: boundary; strategy; source/reference_');
    expect(plannerOverride?.content).toContain('keep the key in English');
    expect(plannerOverride?.content).not.toContain('Chinese tasks may use');
    expect(plannerOverride?.content).toContain('General guidance');
    expect(plannerOverride?.content).toContain('## Documentation And Analysis Deliverables');
    expect(plannerOverride?.content).toContain('Answer the user\'s concrete question before long source evidence');
    expect(plannerOverride?.content).toContain('Do not add research, rollout, or broad QA tasks');
    expect(plannerOverride?.content).not.toContain('TASK DETAIL RULES');
    expect(plannerOverride?.content).not.toContain('OPENSPEC-GRADE TASK DECOMPOSITION');
    expect(plannerOverride?.content).not.toContain('ARCHITECTURE GROUNDING');
    const specQuickOverride = loadProjectPromptOverride(projectDir, 'spec_quick')?.content;
    expect(specQuickOverride).toContain('OpenSpec-Style Task Decomposition');
    expect(specQuickOverride).toContain('_Done when:');
    expect(specQuickOverride).toContain('Static syntax, unit, lint, typecheck, build, or file-existence checks alone are not enough');
    expect(specQuickOverride).toContain('startup/open result plus console/resource-load/blank-screen');

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

    writeFileSync(profilePath, JSON.stringify({ version: 1, project: {}, workflow: {} }), 'utf-8');
    writeFileSync(
      coderPath,
      '## PROJECT-SPECIFIC PROMPT (GENERATED)\n\nold generated prompt\n',
      'utf-8',
    );

    initializeProjectPromptProfile(projectDir, { overwrite: false });

    expect(readFileSync(profilePath, 'utf-8')).toContain(`"version": ${PROJECT_PROMPT_PROFILE_VERSION}`);
    expect(readFileSync(coderPath, 'utf-8')).toContain('Implement the next pending subtask');
    expect(readFileSync(coderPath, 'utf-8')).not.toContain('old generated prompt');
  });
});
