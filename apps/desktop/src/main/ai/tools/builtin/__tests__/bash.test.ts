import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireAutocodeRuntimeFileWriteLock,
  releaseAutocodeRuntimeFileWriteLock,
} from '@autocode/core';

import { bashTool } from '../bash';
import type { ToolContext } from '../../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

const mockIsWindows = vi.fn(() => false);
const mockFindExecutable = vi.fn<() => string | null>(() => null);
const mockKillProcessGracefully = vi.fn();

vi.mock('../../../../platform/index', () => ({
  isWindows: () => mockIsWindows(),
  findExecutable: (_name: string, _additionalPaths?: string[]) => mockFindExecutable(),
  killProcessGracefully: (_childProcess: unknown, _options?: unknown) => mockKillProcessGracefully(),
}));

const mockBashSecurityHook = vi.fn(() => ({}));
vi.mock('../../../security/bash-validator', () => ({
  bashSecurityHook: (_input: unknown, _profile?: unknown) => mockBashSecurityHook(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseContext: ToolContext = {
  cwd: '/test/project',
  projectDir: '/test/project',
  specDir: '/test/specs/001',
  securityProfile: {
    baseCommands: new Set(),
    stackCommands: new Set(),
    scriptCommands: new Set(),
    customCommands: new Set(),
    customScripts: { shellScripts: [] },
    getAllAllowedCommands: () => new Set(),
  },
} as unknown as ToolContext;

/**
 * Set up mockExecFile to invoke the callback with the provided values.
 */
function setupExecFile(stdout: string, stderr: string, exitCode: number) {
  mockExecFile.mockImplementation(
    (_shell: unknown, _args: unknown, _opts: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
      const err = exitCode !== 0 ? Object.assign(new Error('exit'), { code: exitCode }) : null;
      callback(err, stdout, stderr);
      return { pid: 1234 };
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bash Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWindows.mockReturnValue(false);
    mockBashSecurityHook.mockReturnValue({});
  });

  it('should have correct metadata', () => {
    expect(bashTool.metadata.name).toBe('Bash');
    expect(bashTool.metadata.permission).toBe('requires_approval');
  });

  it('should return stdout from successful command', async () => {
    setupExecFile('hello from bash\n', '', 0);

    const result = await bashTool.config.execute(
      { command: 'echo hello from bash' },
      baseContext,
    );

    expect(result).toContain('hello from bash');
  });

  it('should include stderr in output when present', async () => {
    setupExecFile('', 'some warning\n', 0);

    const result = await bashTool.config.execute(
      { command: 'cmd-with-stderr' },
      baseContext,
    );

    expect(result).toContain('STDERR:');
    expect(result).toContain('some warning');
  });

  it('should include exit code in output when non-zero', async () => {
    setupExecFile('', '', 1);

    const result = await bashTool.config.execute(
      { command: 'failing-command' },
      baseContext,
    );

    expect(result).toContain('Exit code: 1');
  });

  it('should return (no output) when stdout and stderr are empty and exit code is 0', async () => {
    setupExecFile('', '', 0);

    const result = await bashTool.config.execute(
      { command: 'silent-command' },
      baseContext,
    );

    expect(result).toBe('(no output)');
  });

  it('should truncate output exceeding MAX_OUTPUT_LENGTH', async () => {
    const longOutput = 'x'.repeat(31_000);
    setupExecFile(longOutput, '', 0);

    const result = await bashTool.config.execute(
      { command: 'long-output-cmd' },
      baseContext,
    );

    expect(result).toContain('[Output truncated');
    expect(result.length).toBeLessThan(longOutput.length);
  });

  it('should compact compiler stderr in aggressive mode', async () => {
    const hugeCompilerError = [
      'In file included from tetris.cpp:1:',
      ...Array.from({ length: 400 }, (_, i) => `C:/VS/include/header${i}.hpp:${i}:10: note: template instantiation context`),
      'C:/VS/include/type_traits:2461:22: error: deduced return types are a C++14 extension',
      'C:/VS/include/xutility:314:1: error: statement not allowed in constexpr function',
      'fatal error: too many errors emitted, stopping now [-ferror-limit=]',
    ].join('\n');
    setupExecFile('', hugeCompilerError, 1);

    const result = await bashTool.config.execute(
      { command: 'clang++ -o tetris.exe tetris.cpp -std=c++11' },
      {
        ...baseContext,
        workflowMode: 'aggressive',
      },
    );

    expect(result).toContain('deduced return types are a C++14 extension');
    expect(result).toContain('[Compiler output truncated');
    expect(result.length).toBeLessThan(7_000);
  });

  it('should reject Windows Python here-doc verification before execution', async () => {
    mockIsWindows.mockReturnValue(true);
    mockFindExecutable.mockReturnValue('C:\\Program Files\\Git\\bin\\bash.exe');

    const result = await bashTool.config.execute(
      { command: "cd /d E:\\Work\\Test && python - <<'PY'\nprint('ok')\nPY" },
      baseContext,
    );

    expect(result).toContain('Unsupported Windows shell syntax');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('should reject risky Windows non-ASCII Python one-liners before execution', async () => {
    mockIsWindows.mockReturnValue(true);
    mockFindExecutable.mockReturnValue('C:\\Program Files\\Git\\bin\\bash.exe');

    const result = await bashTool.config.execute(
      { command: 'cd /d E:\\Work\\Test && python -c "assert \'中文\' in open(\'README.md\', encoding=\'utf-8\').read()"' },
      baseContext,
    );

    expect(result).toContain('Risky Windows verification command');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('should reject inefficient Windows shell search commands before execution', async () => {
    mockIsWindows.mockReturnValue(true);
    mockFindExecutable.mockReturnValue('C:\\Program Files\\Git\\bin\\bash.exe');

    const result = await bashTool.config.execute(
      { command: 'cd /d E:\\Work\\Project && findstr /s /n "GPU_CB_STRUCT" Source\\*.h 2>nul | head -20' },
      baseContext,
    );

    expect(result).toContain('Inefficient Windows search command');
    expect(result).toContain('Use the Grep tool');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('should return error message when security hook rejects command', async () => {
    mockBashSecurityHook.mockReturnValue({
      hookSpecificOutput: {
        permissionDecisionReason: 'command is blocked for safety',
      },
    });

    const result = await bashTool.config.execute(
      { command: 'rm -rf /' },
      baseContext,
    );

    expect(result).toContain('Error: Command not allowed');
    expect(result).toContain('command is blocked for safety');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('should start command in background and return immediately', async () => {
    // In background mode the execute call is fire-and-forget, so mockExecFile
    // may or may not be called synchronously. The return value is what matters.
    mockExecFile.mockImplementation(
      (_shell: unknown, _args: unknown, _opts: unknown, _callback: unknown) => {
        return { pid: 5678 };
      },
    );

    const result = await bashTool.config.execute(
      { command: 'sleep 100', run_in_background: true },
      baseContext,
    );

    expect(result).toContain('Command started in background');
    expect(result).toContain('sleep 100');
  });

  it('should reject background commands with detected file writes when locking is enabled', async () => {
    mockExecFile.mockImplementation(
      (_shell: unknown, _args: unknown, _opts: unknown, _callback: unknown) => {
        return { pid: 5678 };
      },
    );

    const result = await bashTool.config.execute(
      { command: 'echo hello > result.txt', run_in_background: true },
      {
        ...baseContext,
        fileWriteLock: {
          enabled: true,
          projectRoot: baseContext.projectDir,
          ownerId: 'bash-background-test',
        },
      },
    );

    expect(result).toContain('Background Bash commands with detected file writes are disabled');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('should use shared file write locks for redirection targets', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-bash-lock-'));
    const lockedFile = join(projectRoot, 'result.txt');
    const externalLock = await acquireAutocodeRuntimeFileWriteLock({
      projectRoot,
      filePath: lockedFile,
      ownerId: 'external-bash-test',
      timeoutMs: 20,
      retryMs: 1,
    });

    try {
      await expect(
        bashTool.config.execute(
          { command: 'echo hello > result.txt' },
          {
            ...baseContext,
            cwd: projectRoot,
            projectDir: projectRoot,
            fileWriteLock: {
              enabled: true,
              projectRoot,
              ownerId: 'bash-tool-test',
              timeoutMs: 5,
              retryMs: 1,
            },
          },
        ),
      ).rejects.toThrow(/Timed out waiting for write lock|already held by this process/);
      expect(mockExecFile).not.toHaveBeenCalled();
    } finally {
      releaseAutocodeRuntimeFileWriteLock(externalLock);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('should pass cwd from context to execFile', async () => {
    setupExecFile('output', '', 0);

    await bashTool.config.execute(
      { command: 'pwd' },
      baseContext,
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/test/project' }),
      expect.any(Function),
    );
  });

  it('should cap timeout to MAX_TIMEOUT_MS (600000)', async () => {
    setupExecFile('output', '', 0);

    await bashTool.config.execute(
      { command: 'cmd', timeout: 9_000_000 },
      baseContext,
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeout: 600_000 }),
      expect.any(Function),
    );
  });

  it('should use /bin/bash as shell on non-Windows', async () => {
    mockIsWindows.mockReturnValue(false);
    setupExecFile('output', '', 0);

    await bashTool.config.execute(
      { command: 'echo hi' },
      baseContext,
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      '/bin/bash',
      ['-c', 'echo hi'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('should use cmd.exe args (/c) on Windows when bash not found', async () => {
    // The Windows branch uses /c rather than -c for cmd.exe.
    // We verify the logic by checking that bash uses -c on non-Windows (already tested
    // above) and that the findExecutable mock would select the right executable.
    // This test validates the cmd.exe ComSpec fallback resolution path.
    mockIsWindows.mockReturnValue(true);
    mockFindExecutable.mockReturnValue(null);

    const origComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';

    setupExecFile('output', '', 0);

    await bashTool.config.execute(
      { command: 'dir' },
      baseContext,
    );

    // Verify that on Windows with no bash found, cmd.exe with /c flag is used
    const callArgs = mockExecFile.mock.calls[0];
    const shell = callArgs[0] as string;
    const args = callArgs[1] as string[];

    // The shell should be cmd.exe (via ComSpec) and arg should be /c
    expect(shell).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args[0]).toBe('/c');
    expect(args[1]).toBe('dir');

    process.env.ComSpec = origComSpec;
  });
});
