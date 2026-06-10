/**
 * Configuration Paths Module
 *
 * Provides XDG Base Directory Specification compliant paths for storing
 * application configuration and data. This is essential for AppImage,
 * Flatpak, and Snap installations where the application runs in a
 * sandboxed or immutable filesystem environment.
 *
 * XDG Base Directory Specification:
 * - $XDG_CONFIG_HOME: User configuration (default: ~/.config)
 * - $XDG_DATA_HOME: User data (default: ~/.local/share)
 * - $XDG_CACHE_HOME: User cache (default: ~/.cache)
 *
 * @see https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html
 */

import * as os from 'os';
import { existsSync } from 'fs';
import { AUTOCODE_PROJECT_DATA_DIR_NAME } from '@autocode/core/tasks/artifacts';
import {
  getAutocodeAppCacheDir,
  getAutocodeAppConfigDir,
  getAutocodeAppDataDir,
  getAutocodeAppPath,
  getAutocodeMemoriesDir,
  getAutocodeXdgCacheHome,
  getAutocodeXdgConfigHome,
  getAutocodeXdgDataHome,
  isAutocodeImmutableEnvironment,
} from '@autocode/core/platform/app-paths';
import { isLinux } from './platform';

function getAppPathEnvironment() {
  return {
    env: process.env,
    homeDir: os.homedir(),
    isLinux: isLinux(),
    legacyPathExists: existsSync,
  };
}

/**
 * Get the XDG config home directory
 * Uses $XDG_CONFIG_HOME if set, otherwise defaults to ~/.config
 */
export function getXdgConfigHome(): string {
  return getAutocodeXdgConfigHome(getAppPathEnvironment());
}

/**
 * Get the XDG data home directory
 * Uses $XDG_DATA_HOME if set, otherwise defaults to ~/.local/share
 */
export function getXdgDataHome(): string {
  return getAutocodeXdgDataHome(getAppPathEnvironment());
}

/**
 * Get the XDG cache home directory
 * Uses $XDG_CACHE_HOME if set, otherwise defaults to ~/.cache
 */
export function getXdgCacheHome(): string {
  return getAutocodeXdgCacheHome(getAppPathEnvironment());
}

/**
 * Get the application config directory
 * Returns the XDG-compliant path for storing configuration files
 */
export function getAppConfigDir(): string {
  return getAutocodeAppConfigDir(getAppPathEnvironment());
}

/**
 * Get the application data directory
 * Returns the XDG-compliant path for storing application data
 */
export function getAppDataDir(): string {
  return getAutocodeAppDataDir(getAppPathEnvironment());
}

/**
 * Get the application cache directory
 * Returns the XDG-compliant path for storing cache files
 */
export function getAppCacheDir(): string {
  return getAutocodeAppCacheDir(getAppPathEnvironment());
}

/**
 * Get the memories storage directory
 * This is where graph databases are stored.
 */
export function getMemoriesDir(): string {
  return getAutocodeMemoriesDir(getAppPathEnvironment(), AUTOCODE_PROJECT_DATA_DIR_NAME);
}

/**
 * Get the graphs storage directory (alias for memories)
 */
export function getGraphsDir(): string {
  return getMemoriesDir();
}

/**
 * Check if running in an immutable filesystem environment
 * (AppImage, Flatpak, Snap, etc.)
 */
export function isImmutableEnvironment(): boolean {
  return isAutocodeImmutableEnvironment(process.env);
}

/**
 * Get environment-appropriate path for a given type
 * Handles the differences between regular installs and sandboxed environments
 *
 * @param type - The type of path needed: 'config', 'data', 'cache', 'memories'
 * @returns The appropriate path for the current environment
 */
export function getAppPath(type: 'config' | 'data' | 'cache' | 'memories'): string {
  return getAutocodeAppPath(type, getAppPathEnvironment(), AUTOCODE_PROJECT_DATA_DIR_NAME);
}
