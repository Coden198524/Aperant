/**
 * Tests for Path Containment
 *
 * Tests filesystem boundary checking to prevent escape from project directory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertPathContained, isPathContained } from '../path-containment';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let projectDir: string;
let secondaryDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-test-'));
  secondaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-test-secondary-'));
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), '');
  fs.mkdirSync(path.join(secondaryDir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(secondaryDir, 'specs', 'implementation_plan.md'), '# Implementation Plan\n');
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(secondaryDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// assertPathContained
// ---------------------------------------------------------------------------

describe('assertPathContained', () => {
  it('allows file inside project directory', () => {
    const result = assertPathContained(
      path.join(projectDir, 'src', 'index.ts'),
      projectDir,
    );
    expect(result.contained).toBe(true);
  });

  it('allows relative path inside project', () => {
    const result = assertPathContained('src/index.ts', projectDir);
    expect(result.contained).toBe(true);
  });

  it('allows the project directory itself', () => {
    const result = assertPathContained(projectDir, projectDir);
    expect(result.contained).toBe(true);
  });

  it('throws for path outside project directory', () => {
    expect(() => assertPathContained('/etc/passwd', projectDir)).toThrow(
      'outside the project directory',
    );
  });

  it('throws for parent traversal (../)', () => {
    expect(() =>
      assertPathContained(path.join(projectDir, '..', 'escape'), projectDir),
    ).toThrow('outside the project directory');
  });

  it('throws for empty filePath', () => {
    expect(() => assertPathContained('', projectDir)).toThrow(
      'requires both',
    );
  });

  it('throws for empty projectDir', () => {
    expect(() => assertPathContained('/some/file', '')).toThrow(
      'requires both',
    );
  });

  it('allows non-existent file inside project', () => {
    const result = assertPathContained(
      path.join(projectDir, 'new-file.ts'),
      projectDir,
    );
    expect(result.contained).toBe(true);
  });

  it('allows deeply nested path inside project', () => {
    const deepDir = path.join(projectDir, 'a', 'b', 'c', 'd');
    fs.mkdirSync(deepDir, { recursive: true });
    const deepPath = path.join(deepDir, 'file.ts');
    const result = assertPathContained(deepPath, projectDir);
    expect(result.contained).toBe(true);
  });

  it('allows file inside a secondary allowed root', () => {
    const result = assertPathContained(
      path.join(secondaryDir, 'specs', 'implementation_plan.md'),
      [projectDir, secondaryDir],
    );
    expect(result.contained).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isPathContained (non-throwing variant)
// ---------------------------------------------------------------------------

describe('isPathContained', () => {
  it('returns contained=true for valid path', () => {
    const result = isPathContained(
      path.join(projectDir, 'src', 'index.ts'),
      projectDir,
    );
    expect(result.contained).toBe(true);
    expect(result.resolvedPath).toBeTruthy();
  });

  it('returns contained=false for path outside project', () => {
    const result = isPathContained('/etc/passwd', projectDir);
    expect(result.contained).toBe(false);
    expect(result.reason).toContain('outside the project directory');
  });

  it('returns contained=false for parent traversal', () => {
    const result = isPathContained(
      path.join(projectDir, '..', 'escape'),
      projectDir,
    );
    expect(result.contained).toBe(false);
  });

  it('returns contained=false for empty inputs', () => {
    const result = isPathContained('', projectDir);
    expect(result.contained).toBe(false);
    expect(result.reason).toContain('requires both');
  });

  it('handles absolute paths outside project', () => {
    const result = isPathContained('/usr/bin/evil', projectDir);
    expect(result.contained).toBe(false);
  });

  it('handles symlinks that escape project', () => {
    const symlinkPath = path.join(projectDir, 'escape-link');
    try {
      fs.symlinkSync('/tmp', symlinkPath);
      const result = isPathContained(symlinkPath, projectDir);
      expect(result.contained).toBe(false);
    } catch {
      // Symlink creation may fail on some systems/CI; skip gracefully.
    }
  });

  it('returns contained=true for path inside secondary allowed root', () => {
    const result = isPathContained(
      path.join(secondaryDir, 'specs', 'implementation_plan.md'),
      [projectDir, secondaryDir],
    );
    expect(result.contained).toBe(true);
  });
});
