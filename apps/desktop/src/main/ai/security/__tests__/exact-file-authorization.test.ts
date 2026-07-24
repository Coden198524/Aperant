import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertExactFilePathAllowed,
  assertOpenedExactFilePathAllowed,
} from '../exact-file-authorization';
import {
  canonicalPathsEqual,
  isCanonicalPathWithinRoot,
} from '../canonical-path';

let projectDir: string;
let externalDir: string;
let allowedFile: string;
let allowedSnapshot: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-file-project-'));
  externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-file-external-'));
  allowedFile = path.join(externalDir, 'attachment.md');
  fs.writeFileSync(allowedFile, '# attachment\n');
  allowedSnapshot = fs.realpathSync(allowedFile);
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(externalDir, { recursive: true, force: true });
});

describe('assertExactFilePathAllowed', () => {
  it('keeps canonical path comparisons case-sensitive on Windows-style paths', () => {
    expect(canonicalPathsEqual(
      String.raw`C:\CaseSensitive\report.md`,
      String.raw`C:\CaseSensitive\REPORT.md`,
    )).toBe(false);
    expect(canonicalPathsEqual(
      String.raw`C:\CaseSensitive\report.md`,
      String.raw`C:\CaseSensitive\report.md`,
    )).toBe(true);
  });

  it('does not treat a differently-cased Windows root as the same directory', () => {
    expect(isCanonicalPathWithinRoot(
      String.raw`C:\Project\src\index.ts`,
      String.raw`C:\Project`,
      '\\',
    )).toBe(true);
    expect(isCanonicalPathWithinRoot(
      String.raw`C:\project\secret.txt`,
      String.raw`C:\Project`,
      '\\',
    )).toBe(false);
    expect(isCanonicalPathWithinRoot(
      String.raw`C:\Project-archive\secret.txt`,
      String.raw`C:\Project`,
      '\\',
    )).toBe(false);
  });

  it('allows only the canonical existing regular file', () => {
    const result = assertExactFilePathAllowed(allowedFile, [allowedSnapshot]);

    expect(result).toEqual({
      contained: true,
      resolvedPath: allowedSnapshot,
    });
  });

  it('rejects a case-only allowed-path substitution under Windows semantics', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const substitutedAllowedPath = path.join(
        path.dirname(allowedSnapshot),
        path.basename(allowedSnapshot).toUpperCase(),
      );

      expect(substitutedAllowedPath).not.toBe(allowedSnapshot);
      expect(() => assertExactFilePathAllowed(
        allowedFile,
        [substitutedAllowedPath],
      )).toThrow('not an explicitly allowed file');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('rejects a sibling of the explicitly allowed file', () => {
    const sibling = path.join(externalDir, 'sibling.md');
    fs.writeFileSync(sibling, '# sibling\n');

    expect(() => assertExactFilePathAllowed(sibling, [allowedSnapshot])).toThrow(
      'not an explicitly allowed file',
    );
  });

  it('rejects descendants if the allowed file path is replaced by a directory', () => {
    fs.rmSync(allowedFile);
    fs.mkdirSync(allowedFile);
    const descendant = path.join(allowedFile, 'secret.md');
    fs.writeFileSync(descendant, '# secret\n');

    expect(() => assertExactFilePathAllowed(descendant, [allowedSnapshot])).toThrow(
      'not an explicitly allowed file',
    );
  });

  it('rejects the allowed path itself if it is replaced by a directory', () => {
    fs.rmSync(allowedFile);
    fs.mkdirSync(allowedFile);

    expect(() => assertExactFilePathAllowed(allowedFile, [allowedSnapshot])).toThrow(
      'is no longer a regular file',
    );
  });

  it('rejects the allowed path if it is replaced by a symlink', () => {
    const replacementTarget = path.join(externalDir, 'replacement.md');
    fs.writeFileSync(replacementTarget, '# replacement\n');
    fs.rmSync(allowedFile);

    try {
      fs.symlinkSync(replacementTarget, allowedFile, 'file');
    } catch {
      // Creating file symlinks can require elevated privileges on Windows.
      return;
    }

    expect(() => assertExactFilePathAllowed(allowedFile, [allowedSnapshot])).toThrow(
      'not an explicitly allowed file',
    );
  });
});

describe('assertOpenedExactFilePathAllowed', () => {
  it('binds an allowed canonical path to the same opened file identity', () => {
    const fd = fs.openSync(allowedFile, 'r');
    try {
      expect(assertOpenedExactFilePathAllowed(
        allowedFile,
        [allowedSnapshot],
        fd,
      )).toEqual({
        contained: true,
        resolvedPath: allowedSnapshot,
      });
    } finally {
      fs.closeSync(fd);
    }
  });

  it('rejects a handle for a different file even when the pathname is allowed', () => {
    const replacementTarget = path.join(externalDir, 'replacement.md');
    fs.writeFileSync(replacementTarget, '# replacement\n');
    const replacementFd = fs.openSync(replacementTarget, 'r');
    try {
      expect(() => assertOpenedExactFilePathAllowed(
        allowedFile,
        [allowedSnapshot],
        replacementFd,
      )).toThrow('changed between authorization and opening');
    } finally {
      fs.closeSync(replacementFd);
    }
  });
});
