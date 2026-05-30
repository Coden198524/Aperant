import { describe, it, expect } from 'vitest';
import { z } from 'zod/v3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Tool, sanitizeFilePathArg } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';
import type { ToolContext } from '../types';
import {
  acquireAutocodeRuntimeFileWriteLock,
  releaseAutocodeRuntimeFileWriteLock,
} from '@autocode/core';

// =============================================================================
// sanitizeFilePathArg
// =============================================================================

describe('sanitizeFilePathArg', () => {
  it('leaves a normal path unchanged', () => {
    const input = { file_path: 'src/main/file.ts' };
    sanitizeFilePathArg(input);
    expect(input.file_path).toBe('src/main/file.ts');
  });

  it('strips trailing JSON artifact sequence', () => {
    const input: Record<string, unknown> = { file_path: "spec.md'}}," };
    sanitizeFilePathArg(input);
    expect(input.file_path).toBe('spec.md');
  });

  it('strips trailing brace', () => {
    const input: Record<string, unknown> = { file_path: 'file.json}' };
    sanitizeFilePathArg(input);
    expect(input.file_path).toBe('file.json');
  });

  it('strips trailing quote and brace', () => {
    const input: Record<string, unknown> = { file_path: "file.ts'}" };
    sanitizeFilePathArg(input);
    expect(input.file_path).toBe('file.ts');
  });

  it('does not modify when file_path is a number', () => {
    const input: Record<string, unknown> = { file_path: 123 };
    sanitizeFilePathArg(input);
    expect(input.file_path).toBe(123);
  });

  it('does not modify when file_path key is absent', () => {
    const input: Record<string, unknown> = { other: 'value' };
    sanitizeFilePathArg(input);
    expect(input).toEqual({ other: 'value' });
  });

  it('handles empty string without error', () => {
    const input: Record<string, unknown> = { file_path: '' };
    sanitizeFilePathArg(input);
    expect(input.file_path).toBe('');
  });

  it('leaves path with dots and extensions unchanged', () => {
    const input: Record<string, unknown> = { file_path: 'src/components/App.tsx' };
    sanitizeFilePathArg(input);
    expect(input.file_path).toBe('src/components/App.tsx');
  });
});

// =============================================================================
// write-path containment
// =============================================================================

const baseContext: ToolContext = {
  cwd: '/test/project',
  projectDir: '/test/project',
  specDir: '/test/project/.autocode/specs/003-task',
  securityProfile: {
    baseCommands: new Set(),
    stackCommands: new Set(),
    scriptCommands: new Set(),
    customCommands: new Set(),
    customScripts: { shellScripts: [] },
    getAllAllowedCommands: () => new Set(),
  },
  allowedWritePaths: ['/test/project/.autocode/specs/003-task'],
} as ToolContext;

describe('Tool.define write-path containment', () => {
  it('checks file_path by default for non-read-only tools', async () => {
    const writeLikeTool = Tool.define({
      metadata: {
        name: 'WriteLike',
        description: 'Test write-like tool',
        permission: ToolPermission.Auto,
        executionOptions: DEFAULT_EXECUTION_OPTIONS,
      },
      inputSchema: z.object({ file_path: z.string() }),
      execute: () => 'ok',
    });

    const boundTool = writeLikeTool.bind(baseContext);

    await expect(
      boundTool.execute?.({ file_path: 'Designer/Setting/' }, {} as never),
    ).rejects.toThrow('Write denied: WriteLike cannot write to Designer/Setting/');
  });

  it('allows tools with no input write path to use file_path as a reference', async () => {
    const referenceTool = Tool.define({
      metadata: {
        name: 'ReferenceRecorder',
        description: 'Records a referenced project path',
        permission: ToolPermission.Auto,
        executionOptions: DEFAULT_EXECUTION_OPTIONS,
        writePathInputKeys: [],
      },
      inputSchema: z.object({ file_path: z.string() }),
      execute: (input) => `recorded:${input.file_path}`,
    });

    const boundTool = referenceTool.bind(baseContext);

    await expect(
      boundTool.execute?.({ file_path: 'Designer/Setting/' }, {} as never),
    ).resolves.toBe('recorded:Designer/Setting/');
  });

  it('uses the shared file write lock when enabled', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-tool-lock-'));
    const filePath = join(projectRoot, 'src', 'locked.ts');
    const externalLock = await acquireAutocodeRuntimeFileWriteLock({
      projectRoot,
      filePath,
      ownerId: 'external-test-lock',
      timeoutMs: 20,
      retryMs: 1,
    });

    try {
      const writeLikeTool = Tool.define({
        metadata: {
          name: 'WriteLike',
          description: 'Test write-like tool',
          permission: ToolPermission.Auto,
          executionOptions: DEFAULT_EXECUTION_OPTIONS,
        },
        inputSchema: z.object({ file_path: z.string() }),
        execute: () => 'ok',
      });

      const boundTool = writeLikeTool.bind({
        ...baseContext,
        projectDir: projectRoot,
        allowedWritePaths: undefined,
        fileWriteLock: {
          enabled: true,
          projectRoot,
          ownerId: 'tool-test-lock',
          timeoutMs: 5,
          retryMs: 1,
        },
      });

      await expect(
        boundTool.execute?.({ file_path: filePath }, {} as never),
      ).rejects.toThrow(/Timed out waiting for write lock|already held by this process/);
    } finally {
      releaseAutocodeRuntimeFileWriteLock(externalLock);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('Tool.define read-only usage guard', () => {
  it('returns a compact guard message after repeated identical read-only calls', async () => {
    const readLikeTool = Tool.define({
      metadata: {
        name: 'Read',
        description: 'Test read-like tool',
        permission: ToolPermission.ReadOnly,
        executionOptions: DEFAULT_EXECUTION_OPTIONS,
      },
      inputSchema: z.object({ file_path: z.string() }),
      execute: (input) => `read:${input.file_path}`,
    });

    const context: ToolContext = {
      ...baseContext,
      allowedWritePaths: undefined,
      toolUsageState: { totalCalls: 0, toolCalls: {}, readOnlySignatureCalls: {} },
      toolUsageLimits: { maxDuplicateReadOnlyCalls: 2 },
    };
    const boundTool = readLikeTool.bind(context);

    await expect(boundTool.execute?.({ file_path: '/test/project/a.ts' }, {} as never)).resolves.toBe('read:/test/project/a.ts');
    await expect(boundTool.execute?.({ file_path: '/test/project/a.ts' }, {} as never)).resolves.toBe('read:/test/project/a.ts');
    await expect(boundTool.execute?.({ file_path: '/test/project/a.ts' }, {} as never)).resolves.toContain('Repeated Read call skipped');
  });

  it('enforces per-tool read-only budgets', async () => {
    const grepLikeTool = Tool.define({
      metadata: {
        name: 'Grep',
        description: 'Test grep-like tool',
        permission: ToolPermission.ReadOnly,
        executionOptions: DEFAULT_EXECUTION_OPTIONS,
      },
      inputSchema: z.object({ pattern: z.string() }),
      execute: (input) => `grep:${input.pattern}`,
    });

    const context: ToolContext = {
      ...baseContext,
      allowedWritePaths: undefined,
      toolUsageState: { totalCalls: 0, toolCalls: {}, readOnlySignatureCalls: {} },
      toolUsageLimits: { readOnlyToolCallLimits: { Grep: 1 } },
    };
    const boundTool = grepLikeTool.bind(context);

    await expect(boundTool.execute?.({ pattern: 'alpha' }, {} as never)).resolves.toBe('grep:alpha');
    await expect(boundTool.execute?.({ pattern: 'beta' }, {} as never)).resolves.toContain('Tool budget exceeded for Grep');
  });
});
