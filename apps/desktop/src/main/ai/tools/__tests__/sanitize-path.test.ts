/**
 * Tests for sanitizeFilePathArg function
 * Verifies Windows path normalization and JSON artifact stripping
 */

import { describe, it, expect } from 'vitest';
import { sanitizeFilePathArg } from '../define';

describe('sanitizeFilePathArg', () => {
  it('should normalize Windows backslashes to forward slashes', () => {
    const input = {
      file_path: 'E:\\Work\\Game\\TestCodex\\test\\.autocode\\specs\\006-build-web-based-sudoku-game\\spec.md',
    };

    sanitizeFilePathArg(input);

    expect(input.file_path).toBe('E:/Work/Game/TestCodex/test/.autocode/specs/006-build-web-based-sudoku-game/spec.md');
  });

  it('should handle mixed slashes', () => {
    const input = {
      file_path: 'E:\\Work\\Game/TestCodex\\test/.autocode/specs/file.ts',
    };

    sanitizeFilePathArg(input);

    expect(input.file_path).toBe('E:/Work/Game/TestCodex/test/.autocode/specs/file.ts');
  });

  it('should strip trailing JSON artifacts', () => {
    const input = {
      file_path: 'src/components/Button.tsx"}},{',
    };

    sanitizeFilePathArg(input);

    expect(input.file_path).toBe('src/components/Button.tsx');
  });

  it('should handle both backslashes and JSON artifacts', () => {
    const input = {
      file_path: 'E:\\Work\\file.ts"}',
    };

    sanitizeFilePathArg(input);

    expect(input.file_path).toBe('E:/Work/file.ts');
  });

  it('should not modify already correct paths', () => {
    const input = {
      file_path: 'src/components/Button.tsx',
    };

    sanitizeFilePathArg(input);

    expect(input.file_path).toBe('src/components/Button.tsx');
  });

  it('should handle paths with forward slashes only', () => {
    const input = {
      file_path: 'E:/Work/Game/TestCodex/test/.autocode/specs/file.ts',
    };

    sanitizeFilePathArg(input);

    expect(input.file_path).toBe('E:/Work/Game/TestCodex/test/.autocode/specs/file.ts');
  });

  it('should convert an MSYS drive path before Windows tool policy checks', () => {
    const input = {
      file_path:
        '/e/Work/Test/aitest/.autocode/worktrees/tasks/005-8-8-5/openspec/changes/change-a/spec.md',
    };

    sanitizeFilePathArg(input, 'win32');

    expect(input.file_path).toBe(
      'E:/Work/Test/aitest/.autocode/worktrees/tasks/005-8-8-5/openspec/changes/change-a/spec.md',
    );
  });

  it('should leave the same POSIX path unchanged outside Windows', () => {
    const input = {
      file_path: '/e/Work/Test/project/spec.md',
    };

    sanitizeFilePathArg(input, 'linux');

    expect(input.file_path).toBe('/e/Work/Test/project/spec.md');
  });

  it.runIf(process.platform === 'win32')(
    'should use the Windows host platform by default',
    () => {
      const input = {
        file_path: '/e/Work/Test/project/spec.md',
      };

      sanitizeFilePathArg(input);

      expect(input.file_path).toBe('E:/Work/Test/project/spec.md');
    },
  );

  it('should do nothing if file_path is not a string', () => {
    const input = {
      file_path: 123,
    };

    sanitizeFilePathArg(input as any);

    expect(input.file_path).toBe(123);
  });

  it('should do nothing if file_path is missing', () => {
    const input = {
      other_field: 'value',
    };

    sanitizeFilePathArg(input);

    expect(input).toEqual({ other_field: 'value' });
  });
});
