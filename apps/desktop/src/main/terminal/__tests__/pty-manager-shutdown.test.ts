import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from '@lydell/node-pty';
import type { TerminalProcess } from '../types';

vi.mock('../../platform', () => ({
  isWindows: vi.fn(() => true),
  getWindowsShellPaths: vi.fn(() => ({})),
}));

vi.mock('electron-log/main.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { killPty, waitForPtyExit } from '../pty-manager';

describe('PTY manager shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the Windows exit wait open through node-pty process discovery and output flushing', async () => {
    let resolved = false;
    const wait = waitForPtyExit('slow-windows-pty').then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(6000);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    await wait;

    expect(resolved).toBe(true);
  });

  it('bypasses the deferred public kill and awaits every native resource for an unready Windows PTY', async () => {
    const publicKill = vi.fn();
    const nativeKill = vi.fn();
    const closeTerminal = vi.fn();
    const disposeConoutWorker = vi.fn();
    const destroyInputSocket = vi.fn();
    const deferredOperation = vi.fn();

    const outputSocket = Object.assign(new EventEmitter(), {
      destroyed: false,
    });

    let workerThreadId = 42;
    const conoutWorker = new EventEmitter();
    Object.defineProperty(conoutWorker, 'threadId', {
      get: () => workerThreadId,
    });

    const agent = {
      exitCode: undefined as number | undefined,
      innerPid: 1234,
      outSocket: outputSocket,
      _inSocket: {
        destroy: destroyInputSocket,
      },
      _pty: {},
      _ptyNative: {
        kill: nativeKill,
      },
      _getConsoleProcessList: vi.fn(async () => []),
      _conoutSocketWorker: {
        _worker: conoutWorker,
        dispose: disposeConoutWorker,
      },
    };

    const ptyProcess = {
      pid: 1234,
      kill: publicKill,
      _isReady: false,
      _deferreds: [{ run: deferredOperation }],
      _agent: agent,
      _close: closeTerminal,
    } as unknown as IPty;

    const terminal = {
      id: 'unready-windows-pty',
      pty: ptyProcess,
      hasExited: false,
    } as TerminalProcess;

    let shutdownResolved = false;
    const shutdown = killPty(terminal, true).then(() => {
      shutdownResolved = true;
    });

    await Promise.resolve();

    expect(publicKill).not.toHaveBeenCalled();
    expect(deferredOperation).not.toHaveBeenCalled();
    expect((ptyProcess as unknown as { _deferreds: unknown[] })._deferreds).toEqual([]);
    expect(closeTerminal).toHaveBeenCalledOnce();
    expect(nativeKill).toHaveBeenCalledOnce();
    expect(disposeConoutWorker).toHaveBeenCalledOnce();

    outputSocket.destroyed = true;
    outputSocket.emit('close');
    workerThreadId = -1;
    conoutWorker.emit('exit', 0);

    // Socket/worker shutdown alone is insufficient. The native process-exit
    // callback can still call into Node after Electron starts tearing down.
    await vi.advanceTimersByTimeAsync(8000);
    expect(shutdownResolved).toBe(false);
    expect(destroyInputSocket).not.toHaveBeenCalled();

    agent.exitCode = 0;
    await vi.advanceTimersByTimeAsync(10);
    await shutdown;

    expect(shutdownResolved).toBe(true);
    expect(destroyInputSocket).toHaveBeenCalledOnce();
    expect(terminal.hasExited).toBe(true);
  });

  it('cancels a node-pty 1.2 pending connection and closes its native resources', async () => {
    const publicKill = vi.fn();
    const nativeKill = vi.fn();
    const closeTerminal = vi.fn();
    const disposeConoutWorker = vi.fn();
    const destroyInputSocket = vi.fn();
    const deferredOperation = vi.fn();

    const outputSocket = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy: vi.fn(function (this: EventEmitter & { destroyed: boolean }) {
        this.destroyed = true;
        this.emit('close');
      }),
    });

    let workerThreadId = 73;
    const conoutWorker = new EventEmitter();
    Object.defineProperty(conoutWorker, 'threadId', {
      get: () => workerThreadId,
    });

    const nativeHandle = {};
    const pendingConnection = {};
    const agent = {
      exitCode: undefined as number | undefined,
      innerPid: 0,
      outSocket: outputSocket,
      _inSocket: {
        destroy: destroyInputSocket,
      },
      _pty: nativeHandle,
      _ptyNative: {
        kill: nativeKill,
      },
      _useConptyDll: false,
      _pendingPtyInfo: pendingConnection as unknown,
      _getConsoleProcessList: vi.fn(async () => []),
      _conoutSocketWorker: {
        _worker: conoutWorker,
        dispose: disposeConoutWorker,
      },
    };

    const ptyProcess = {
      pid: 0,
      kill: publicKill,
      _isReady: false,
      _deferreds: [{ run: deferredOperation }],
      _agent: agent,
      _close: closeTerminal,
    } as unknown as IPty;

    const terminal = {
      id: 'pending-node-pty-1-2',
      pty: ptyProcess,
      hasExited: false,
    } as TerminalProcess;

    let shutdownResolved = false;
    const shutdown = killPty(terminal, true).then(() => {
      shutdownResolved = true;
    });

    await Promise.resolve();

    expect(publicKill).not.toHaveBeenCalled();
    expect(deferredOperation).not.toHaveBeenCalled();
    expect(agent._pendingPtyInfo).toBeUndefined();
    expect(nativeKill).toHaveBeenCalledWith(nativeHandle, false);
    expect(disposeConoutWorker).toHaveBeenCalledOnce();
    expect(shutdownResolved).toBe(false);

    workerThreadId = -1;
    conoutWorker.emit('exit', 0);
    await shutdown;

    expect(outputSocket.destroy).toHaveBeenCalledOnce();
    expect(destroyInputSocket).toHaveBeenCalledOnce();
    expect(terminal.hasExited).toBe(true);
    expect(shutdownResolved).toBe(true);
  });
});
