interface ErrorBreadcrumb {
  category?: string;
  message?: string;
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  data?: Record<string, unknown>;
}

interface ErrorCaptureContext {
  contexts?: Record<string, Record<string, unknown>>;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/**
 * Error reporting compatibility layer.
 *
 * Anonymous remote error reporting has been removed. These exports stay in
 * place so existing callers can keep recording local errors without loading a
 * reporting SDK or sending data over the network.
 */

export function initSentryMain(): void {
  // Remote error reporting is intentionally disabled.
}

export function isSentryEnabled(): boolean {
  return false;
}

export function setSentryEnabled(_enabled: boolean): void {
  // Remote error reporting is intentionally disabled.
}

export function safeBreadcrumb(_breadcrumb: ErrorBreadcrumb): void {
  // Remote error reporting is intentionally disabled.
}

export function safeCaptureException(_error: Error, _context?: ErrorCaptureContext): void {
  // Remote error reporting is intentionally disabled.
}

export function getSentryEnvForSubprocess(): Record<string, string> {
  return {};
}
