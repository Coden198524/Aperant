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
  mkdirSync(join(projectDir, '.autocode'), { recursive: true });
  writeFileSync(join(projectDir, 'package-lock.json'), '{}\n', 'utf-8');
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

    const storedProfile = loadProjectPromptProfile(projectDir);
    expect(storedProfile?.project.name).toBe(profile.project.name);

    const coderOverride = loadProjectPromptOverride(projectDir, 'coder');
    expect(coderOverride?.content).toContain('PROJECT-SPECIFIC PROMPT');
    expect(coderOverride?.content).toContain('Implement the next pending subtask');
    expect(coderOverride?.content).toContain('design pattern decision');
    expect(coderOverride?.content).toContain('TOOL CALL JSON SAFETY');
    expect(coderOverride?.content).toContain('forward slashes');
    expect(coderOverride?.content).toContain('both keys');
    expect(coderOverride?.content).toContain('20-60 line');
    expect(existsSync(join(projectDir, '.autocode', 'prompts', 'spec_quick.md'))).toBe(true);

    const plannerOverride = loadProjectPromptOverride(projectDir, 'planner');
    expect(plannerOverride?.content).toContain('final response JSON object');
    expect(plannerOverride?.content).toContain('Do NOT call Write for `implementation_plan.json`');
  });

  it('builds an adaptation section for bundled prompts', () => {
    const projectDir = makeProject();
    const profile = generateProjectPromptProfile(projectDir);

    const section = buildProjectPromptProfileSection(profile);

    expect(section).toContain('PROJECT PROMPT ADAPTATION');
    expect(section).toContain('Apply web domain checks only when they are relevant');
    expect(section).toContain('Typecheck: npm run typecheck');
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

    expect(readFileSync(profilePath, 'utf-8')).toContain('"version": 6');
    expect(readFileSync(coderPath, 'utf-8')).toContain('Implement the next pending subtask');
    expect(readFileSync(coderPath, 'utf-8')).not.toContain('old generated prompt');
  });
});
