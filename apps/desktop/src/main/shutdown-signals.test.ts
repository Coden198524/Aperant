import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  getGracefulShutdownSignals,
  registerBrokenStdioHandler,
  registerGracefulShutdownSignals,
} from './shutdown-signals';

describe('graceful shutdown signals', () => {
  it('includes Windows console break handling only on Windows', () => {
    expect(getGracefulShutdownSignals('win32')).toEqual([
      'SIGINT',
      'SIGTERM',
      'SIGHUP',
      'SIGBREAK',
    ]);
    expect(getGracefulShutdownSignals('linux')).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
  });

  it('forwards only the first signal and unregisters every listener', () => {
    const emitter = new EventEmitter();
    const onShutdown = vi.fn();
    const unregister = registerGracefulShutdownSignals(onShutdown, emitter, 'win32');

    emitter.emit('SIGINT');
    emitter.emit('SIGBREAK');
    emitter.emit('SIGTERM');

    expect(onShutdown).toHaveBeenCalledOnce();
    expect(onShutdown).toHaveBeenCalledWith('SIGINT');

    unregister();

    for (const signal of getGracefulShutdownSignals('win32')) {
      expect(emitter.listenerCount(signal)).toBe(0);
    }
  });

  it('forwards the first asynchronous EPIPE and suppresses repeats', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const onBrokenPipe = vi.fn();
    const unregister = registerBrokenStdioHandler([stdout, stderr], onBrokenPipe);
    const unrelatedError = Object.assign(new Error('other'), { code: 'EIO' });
    const brokenPipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });

    stdout.emit('error', unrelatedError);
    stderr.emit('error', brokenPipe);
    stdout.emit('error', brokenPipe);

    expect(onBrokenPipe).toHaveBeenCalledOnce();
    expect(onBrokenPipe).toHaveBeenCalledWith(brokenPipe);

    unregister();
    expect(stdout.listenerCount('error')).toBe(0);
    expect(stderr.listenerCount('error')).toBe(0);
  });
});
