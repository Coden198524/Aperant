/**
 * Debug Logger
 * Only logs when DEBUG=true in environment
 */

export const isDebugEnabled = (): boolean => {
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.DEBUG === 'true' || process.env.DEBUG === '1') {
      return true;
    }
  }

  return typeof window !== 'undefined' && window.DEBUG === true;
};

function safeConsoleWarn(...args: unknown[]): void {
  try {
    console.warn(...args);
  } catch {
    // Ignore console stream failures (e.g. EIO) in debug logging paths.
  }
}

function safeConsoleError(...args: unknown[]): void {
  try {
    console.error(...args);
  } catch {
    // Ignore console stream failures (e.g. EIO) in debug logging paths.
  }
}

export const debugLog = (...args: unknown[]): void => {
  if (isDebugEnabled()) {
    safeConsoleWarn(...args);
  }
};

export const debugWarn = (...args: unknown[]): void => {
  if (isDebugEnabled()) {
    safeConsoleWarn(...args);
  }
};

export const debugError = (...args: unknown[]): void => {
  if (isDebugEnabled()) {
    safeConsoleError(...args);
  }
};
