/**
 * Error reporting compatibility layer.
 *
 * Anonymous remote error reporting has been removed. The functions remain as
 * local no-ops so existing error boundaries and stores do not need special
 * cases.
 */

let settingsLoaded = false;

export function markSettingsLoaded(): void {
  settingsLoaded = true;
}

export function areSettingsLoaded(): boolean {
  return settingsLoaded;
}

export async function initSentryRenderer(): Promise<void> {
  // Remote error reporting is intentionally disabled.
}

export function isSentryInitialized(): boolean {
  return false;
}

export function notifySentryStateChanged(_enabled: boolean): void {
  // Remote error reporting is intentionally disabled.
}

export function captureException(error: Error, context?: Record<string, unknown>): void {
  console.error('[ErrorBoundary] Unhandled renderer error:', error, context);
}
