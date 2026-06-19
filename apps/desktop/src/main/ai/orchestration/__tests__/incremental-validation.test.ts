import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import {
  INCREMENTAL_VALIDATION_OUTPUT_MAX_CHARS,
  compactValidationOutput,
  getValidationCommandForPlatform,
  runIncrementalValidation,
  shouldUseShellForValidationCommand,
} from '../incremental-validation';

describe('incremental validation output budgets', () => {
  let projectDir: string;

  beforeEach(async () => {
    mockExecFile.mockReset();
    projectDir = await mkdtemp(join(tmpdir(), 'incremental-validation-project-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('compacts oversized validation output with head and tail context', () => {
    const output = [
      'VALIDATION_HEAD',
      'x'.repeat(INCREMENTAL_VALIDATION_OUTPUT_MAX_CHARS * 2),
      'VALIDATION_TAIL',
    ].join('\n');

    const compacted = compactValidationOutput(output);

    expect(compacted.length).toBeLessThanOrEqual(INCREMENTAL_VALIDATION_OUTPUT_MAX_CHARS);
    expect(compacted).toContain('VALIDATION_HEAD');
    expect(compacted).toContain('VALIDATION_TAIL');
    expect(compacted).toContain('validation output truncated');
  });

  it('compacts failing related test output before returning validation results', async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      const output = [
        'TEST_OUTPUT_HEAD',
        'x'.repeat(INCREMENTAL_VALIDATION_OUTPUT_MAX_CHARS * 2),
        'TEST_OUTPUT_TAIL',
      ].join('\n');
      const error = new Error('test command failed') as Error & { stdout?: string; stderr?: string };
      error.stdout = output;
      error.stderr = '';
      callback(error);
      return null;
    });

    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'src', 'feature.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(projectDir, 'src', 'feature.test.ts'), 'test placeholder\n', 'utf-8');
    await writeFile(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node fail-test.cjs' } }, null, 2),
      'utf-8',
    );

    const result = await runIncrementalValidation({
      subtaskId: '1.1',
      filesModified: ['src/feature.ts'],
      projectDir,
      specDir: join(projectDir, '.autocode', 'specs', '001-task'),
    });

    const testCheck = result.checks.find((check) => check.name === 'tests');
    const testFailure = result.failures.find((failure) => failure.type === 'test');

    expect(result.passed).toBe(false);
    expect(testCheck?.output?.length).toBeLessThanOrEqual(INCREMENTAL_VALIDATION_OUTPUT_MAX_CHARS);
    expect(testCheck?.output).toContain('TEST_OUTPUT_HEAD');
    expect(testCheck?.output).toContain('TEST_OUTPUT_TAIL');
    expect(testCheck?.output).toContain('validation output truncated');
    expect(testFailure?.message.length).toBeLessThanOrEqual(INCREMENTAL_VALIDATION_OUTPUT_MAX_CHARS);
  });

  it('uses Windows command shims and shell for npm-class validation commands', () => {
    expect(getValidationCommandForPlatform('npm', 'win32')).toBe('npm.cmd');
    expect(getValidationCommandForPlatform('npx', 'win32')).toBe('npx.cmd');
    expect(getValidationCommandForPlatform('pnpm.cmd', 'win32')).toBe('pnpm.cmd');
    expect(getValidationCommandForPlatform('git', 'win32')).toBe('git');
    expect(getValidationCommandForPlatform('npm', 'linux')).toBe('npm');

    expect(shouldUseShellForValidationCommand('npm.cmd', 'win32')).toBe(true);
    expect(shouldUseShellForValidationCommand('npx', 'win32')).toBe(true);
    expect(shouldUseShellForValidationCommand('git.exe', 'win32')).toBe(false);
    expect(shouldUseShellForValidationCommand('npm', 'linux')).toBe(false);
  });

  it('treats validation command startup failures as non-blocking warnings', async () => {
    mockExecFile.mockImplementation((command, _args, _options, callback) => {
      const error = new Error(`spawn ${command} ENOENT`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      callback(error);
      return null;
    });

    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'src', 'feature.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(projectDir, 'src', 'feature.test.ts'), 'test placeholder\n', 'utf-8');
    await writeFile(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node fail-test.cjs' } }, null, 2),
      'utf-8',
    );

    const result = await runIncrementalValidation({
      subtaskId: '1.1',
      filesModified: ['src/feature.ts'],
      projectDir,
      specDir: join(projectDir, '.autocode', 'specs', '001-task'),
    });

    const testFailure = result.failures.find((failure) => failure.type === 'test');

    expect(result.passed).toBe(true);
    expect(testFailure?.severity).toBe('warning');
    expect(testFailure?.message).toContain('ENOENT');
  });

  it('does not run related tests against package metadata files', async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, '', '');
      return null;
    });

    await writeFile(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }, null, 2),
      'utf-8',
    );

    const result = await runIncrementalValidation({
      subtaskId: '1.1',
      filesModified: ['package.json', 'package.json'],
      projectDir,
      specDir: join(projectDir, '.autocode', 'specs', '001-task'),
    });

    const testCheck = result.checks.find((check) => check.name === 'tests');

    expect(result.passed).toBe(true);
    expect(testCheck?.passed).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('treats implicit fallback typecheck failures as advisory warnings', async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      const error = new Error('typecheck failed') as Error & { stdout?: string; stderr?: string };
      error.stdout = '';
      error.stderr = "src/main.ts(1,1): error TS2307: Cannot find module './style.css'.";
      callback(error);
      return null;
    });

    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'tsconfig.json'), JSON.stringify({}, null, 2), 'utf-8');
    await writeFile(join(projectDir, 'src', 'main.ts'), "import './style.css';\n", 'utf-8');
    await writeFile(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }, null, 2),
      'utf-8',
    );

    const result = await runIncrementalValidation({
      subtaskId: '1.3',
      filesModified: ['src/main.ts'],
      projectDir,
      specDir: join(projectDir, '.autocode', 'specs', '001-task'),
    });

    const typeFailure = result.failures.find((failure) => failure.type === 'type');

    expect(result.passed).toBe(true);
    expect(typeFailure?.severity).toBe('warning');
    expect(typeFailure?.message).toContain('style.css');
  });

  it('keeps declared typecheck script failures blocking', async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      const error = new Error('typecheck failed') as Error & { stdout?: string; stderr?: string };
      error.stdout = '';
      error.stderr = "src/main.ts(1,1): error TS2307: Cannot find module './style.css'.";
      callback(error);
      return null;
    });

    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'tsconfig.json'), JSON.stringify({}, null, 2), 'utf-8');
    await writeFile(join(projectDir, 'src', 'main.ts'), "import './style.css';\n", 'utf-8');
    await writeFile(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } }, null, 2),
      'utf-8',
    );

    const result = await runIncrementalValidation({
      subtaskId: '1.3',
      filesModified: ['src/main.ts'],
      projectDir,
      specDir: join(projectDir, '.autocode', 'specs', '001-task'),
    });

    const typeFailure = result.failures.find((failure) => failure.type === 'type');

    expect(result.passed).toBe(false);
    expect(typeFailure?.severity).toBe('error');
    expect(typeFailure?.message).toContain('style.css');
  });
});
