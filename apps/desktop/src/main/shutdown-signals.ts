interface SignalEmitter {
  on: (signal: NodeJS.Signals, listener: () => void) => unknown;
  removeListener: (signal: NodeJS.Signals, listener: () => void) => unknown;
}

interface StdioErrorEmitter {
  on: (event: 'error', listener: (error: NodeJS.ErrnoException) => void) => unknown;
  removeListener: (event: 'error', listener: (error: NodeJS.ErrnoException) => void) => unknown;
}

export function getGracefulShutdownSignals(platform: NodeJS.Platform): NodeJS.Signals[] {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (platform === 'win32') {
    signals.push('SIGBREAK');
  }
  return signals;
}

/**
 * Route console termination signals through the application's async cleanup.
 *
 * Installing a listener suppresses Node's default immediate termination. Only
 * the first signal is forwarded so a repeated Ctrl+C cannot interrupt cleanup.
 */
export function registerGracefulShutdownSignals(
  onShutdown: (signal: NodeJS.Signals) => void,
  signalEmitter: SignalEmitter = process,
  platform: NodeJS.Platform = process.platform,
): () => void {
  let handled = false;
  const handlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of getGracefulShutdownSignals(platform)) {
    const handler = (): void => {
      if (handled) return;
      handled = true;
      onShutdown(signal);
    };
    handlers.set(signal, handler);
    signalEmitter.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      signalEmitter.removeListener(signal, handler);
    }
  };
}

/**
 * A development runner or IDE can close Electron's inherited stdout/stderr
 * pipes before the app exits. Stream write failures are emitted asynchronously,
 * so a try/catch around console.log or electron-log cannot catch them.
 */
export function registerBrokenStdioHandler(
  streams: StdioErrorEmitter[],
  onBrokenPipe: (error: NodeJS.ErrnoException) => void,
): () => void {
  let handled = false;
  const handlers = new Map<StdioErrorEmitter, (error: NodeJS.ErrnoException) => void>();

  for (const stream of streams) {
    const handler = (error: NodeJS.ErrnoException): void => {
      if (error.code !== 'EPIPE' || handled) return;
      handled = true;
      onBrokenPipe(error);
    };
    handlers.set(stream, handler);
    stream.on('error', handler);
  }

  return () => {
    for (const [stream, handler] of handlers) {
      stream.removeListener('error', handler);
    }
  };
}
