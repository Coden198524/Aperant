import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectFilesChangedSinceBaseline,
  collectGitChangedFileSnapshot,
  loadGeneratedFilesForCritique,
} from '../changed-files';

const execFileAsync = promisify(execFile);

describe('changed file collection', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'changed-files-project-'));
    await execFileAsync('git', ['init'], { cwd: projectDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: projectDir });
    await writeFile(join(projectDir, 'tracked.ts'), 'export const value = 1;\n', 'utf-8');
    await execFileAsync('git', ['add', 'tracked.ts'], { cwd: projectDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: projectDir });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('collects files changed after a baseline and skips autocode task artifacts', async () => {
    const baseline = await collectGitChangedFileSnapshot(projectDir);

    await writeFile(join(projectDir, 'tracked.ts'), 'export const value = 2;\n', 'utf-8');
    await writeFile(join(projectDir, 'new-file.ts'), 'export const fresh = true;\n', 'utf-8');
    await mkdir(join(projectDir, '.autocode', 'specs', '001-task'), { recursive: true });
    await writeFile(join(projectDir, '.autocode', 'specs', '001-task', 'implementation_plan.md'), '# plan\n', 'utf-8');

    const changedFiles = await collectFilesChangedSinceBaseline(projectDir, baseline);

    expect(changedFiles).toEqual(expect.arrayContaining(['tracked.ts', 'new-file.ts']));
    expect(changedFiles.some((filePath) => filePath.startsWith('.autocode/'))).toBe(false);
  });

  it('loads text source files for self-critique', async () => {
    await writeFile(join(projectDir, 'new-file.ts'), 'export const fresh = true;\n', 'utf-8');

    const generatedFiles = await loadGeneratedFilesForCritique(projectDir, ['new-file.ts']);

    expect(generatedFiles).toHaveLength(1);
    expect(generatedFiles[0]).toMatchObject({
      path: 'new-file.ts',
      isNew: true,
    });
    expect(generatedFiles[0].content).toContain('fresh');
  });
});
