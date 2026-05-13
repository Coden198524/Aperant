import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPreQASmokeTests } from '../pre-qa-smoke-tests';
import { runPreQAQualityChecks } from '../quality-integration';

describe('pre-QA smoke tests', () => {
  let projectDir: string;
  let specDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'pre-qa-project-'));
    specDir = await mkdtemp(join(tmpdir(), 'pre-qa-spec-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(specDir, { recursive: true, force: true });
  });

  it('passes secret scanning in a non-git project without shell grep', async () => {
    await writeFile(join(projectDir, 'index.html'), '<!doctype html><title>ok</title>\n', 'utf-8');

    const result = await runPreQASmokeTests(projectDir, specDir);

    expect(result.passed).toBe(true);
    expect(result.shouldReturnToCoding).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.checks.find((check) => check.name === 'secrets')?.passed).toBe(true);
  });

  it('ignores generated autocode task files during fallback scanning', async () => {
    await mkdir(join(projectDir, '.autocode', 'specs', '001-task'), { recursive: true });
    await writeFile(
      join(projectDir, '.autocode', 'specs', '001-task', 'task_logs.json'),
      '{"api_key":"abcdefghijklmnopqrstuvwxyzABCDEFGH123456"}\n',
      'utf-8',
    );

    const result = await runPreQAQualityChecks(
      { enablePreQASmokeTests: true },
      projectDir,
      specDir,
    );

    expect(result.shouldProceedToQA).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('blocks QA when project files contain likely secrets', async () => {
    await writeFile(
      join(projectDir, 'app.js'),
      'const apiKey = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456";\n',
      'utf-8',
    );

    const result = await runPreQAQualityChecks(
      { enablePreQASmokeTests: true },
      projectDir,
      specDir,
    );

    expect(result.shouldProceedToQA).toBe(false);
    expect(result.issues.join('\n')).toContain('secrets: Potential secrets detected');
  });
});
