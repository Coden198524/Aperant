/**
 * Version management utilities
 *
 * Simplified version that uses only the bundled app version.
 * The "source updater" system has been removed since the backend
 * is bundled with the app and updates via electron-updater.
 */

import { app } from 'electron';
import { compareAutocodeVersions } from '@autocode/core/platform/version';

/**
 * Get the current app/framework version from package.json
 *
 * Uses app.getVersion() (from package.json) as the version.
 */
export function getBundledVersion(): string {
  return app.getVersion();
}

/**
 * Compare semantic versions with proper pre-release support
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 *
 * Pre-release ordering:
 * - alpha < beta < rc < stable (no prerelease)
 * - 2.7.2-beta.1 < 2.7.2-beta.2 < 2.7.2 (stable)
 * - 2.7.1 < 2.7.2-beta.1 < 2.7.2
 */
export function compareVersions(a: string, b: string): number {
  return compareAutocodeVersions(a, b);
}
