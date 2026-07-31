import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalProcess } from '../types';

const mocks = vi.hoisted(() => ({
  killPty: vi.fn(),
  persistAllSessionsAsync: vi.fn(async () => undefined),
  setShuttingDown: vi.fn(),
}));

vi.mock('../pty-manager', () => ({
  killPty: mocks.killPty,
  setShuttingDown: mocks.setShuttingDown,
}));

vi.mock('../session-handler', () => ({
  persistAllSessionsAsync: mocks.persistAllSessionsAsync,
}));

vi.mock('../deepseek-cli-session', () => ({}));

vi.mock('electron-log/main.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { destroyAllTerminals } from '../terminal-lifecycle';

describe('Terminal lifecycle shutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not finish before each PTY shutdown settles', async () => {
    let resolveKill: (() => void) | undefined;
    const kill = new Promise<void>((resolve) => {
      resolveKill = resolve;
    });
    mocks.killPty.mockReturnValue(kill);

    const terminal = {
      id: 'terminal-1',
      hasExited: false,
    } as TerminalProcess;
    const terminals = new Map<string, TerminalProcess>([[terminal.id, terminal]]);

    let cleanupResolved = false;
    const cleanup = destroyAllTerminals(terminals, null).then(() => {
      cleanupResolved = true;
    });

    await Promise.resolve();
    expect(mocks.setShuttingDown).toHaveBeenCalledWith(true);
    expect(mocks.killPty).toHaveBeenCalledWith(terminal, true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(cleanupResolved).toBe(false);
    expect(terminals.size).toBe(1);

    resolveKill?.();
    await cleanup;

    expect(cleanupResolved).toBe(true);
    expect(terminals.size).toBe(0);
  });
});
