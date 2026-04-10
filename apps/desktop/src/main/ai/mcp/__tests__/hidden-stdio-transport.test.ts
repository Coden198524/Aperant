import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock('../../../platform', () => ({
  isWindows: vi.fn(() => true),
  getNpxCommand: vi.fn(() => 'npx.cmd'),
  getNpmCommand: vi.fn(() => 'npm.cmd'),
}));

import { spawn } from 'node:child_process';
import { HiddenWindowsStdioTransport } from '../hidden-stdio-transport';

function createMockChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe('HiddenWindowsStdioTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns MCP servers with windowsHide enabled and normalized Windows npm command', async () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child);

    const transport = new HiddenWindowsStdioTransport({
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      env: { TEST_ENV: '1' },
    });

    const startPromise = transport.start();
    child.emit('spawn');
    await startPromise;

    expect(spawn).toHaveBeenCalledWith(
      'npx.cmd',
      ['-y', '@upstash/context7-mcp@latest'],
      expect.objectContaining({
        env: { TEST_ENV: '1' },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'inherit'],
      }),
    );
  });
});
