/**
 * Environment Utilities Module
 *
 * Provides utilities for managing environment variables for child processes.
 * Particularly important for macOS where GUI apps don't inherit the full
 * shell environment, causing issues with tools installed via Homebrew.
 *
 * Common issue: `gh` CLI installed via Homebrew is in /opt/homebrew/bin
 * which isn't in PATH when the Electron app launches from Finder/Dock.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import {
  AUTOCODE_COMMON_BIN_PATHS,
  buildAutocodePathsToAdd,
  expandAutocodePlatformPaths,
  getAutocodeEssentialSystemPaths,
  getAutocodeWindowsNpmFallbackPath,
} from '@autocode/core/platform/env-paths';
import { getSentryEnvForSubprocess } from './sentry';
import { isWindows, isUnix, getPathDelimiter, getNpmCommand } from './platform';

const execFileAsync = promisify(execFile);
const NPM_GLOBAL_PREFIX_ARGS = ['config', 'get', 'prefix', '--location=global'] as const;

/**
 * Windows npm global fallback path
 *
 * On Windows, npm global packages are installed in %APPDATA%\npm by default.
 * This constant provides the fallback path construction for when the npm
 * command itself is not in PATH (e.g., packaged Electron apps launched from GUI).
 *
 * Uses process.env.APPDATA for enterprise environments with redirected profiles,
 * falling back to the default home directory location.
 */
const WINDOWS_NPM_FALLBACK_PATH = (): string => {
  return getAutocodeWindowsNpmFallbackPath(os.homedir(), process.env.APPDATA);
};

/**
 * Check if a path exists asynchronously (non-blocking)
 *
 * Uses fs.promises.access which is non-blocking, unlike fs.existsSync.
 *
 * @param filePath - The path to check
 * @returns Promise resolving to true if path exists, false otherwise
 */
export async function existsAsync(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Cache for npm global prefix to avoid repeated async calls
let npmGlobalPrefixCache: string | null | undefined ;
let npmGlobalPrefixCachePromise: Promise<string | null> | null = null;

function commandHasPathSegment(command: string): boolean {
  return command.includes('\\') || command.includes('/');
}

function getWindowsCommandCandidateNames(command: string): string[] {
  if (path.extname(command)) {
    return [command];
  }
  return ['.cmd', '.exe', '.bat', ''].map((extension) => `${command}${extension}`);
}

function getWindowsCommandLookupDirs(): string[] {
  const pathSeparator = getPathDelimiter();
  const rawDirs = [
    ...(process.env.PATH || '').split(pathSeparator),
    ...getExpandedPlatformPaths(),
  ];
  const seen = new Set<string>();
  return rawDirs
    .map((entry) => entry.trim())
    .map((entry) => entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry)
    .filter((entry) => {
      if (!entry || seen.has(entry)) {
        return false;
      }
      seen.add(entry);
      return true;
    });
}

function resolveWindowsCommandPathSync(command: string): string {
  if (!isWindows() || path.isAbsolute(command) || commandHasPathSegment(command)) {
    return command;
  }

  for (const dir of getWindowsCommandLookupDirs()) {
    for (const candidate of getWindowsCommandCandidateNames(command)) {
      const fullPath = path.join(dir, candidate);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return command;
}

export function _resolveWindowsCommandPathForTest(command: string): string {
  return resolveWindowsCommandPathSync(command);
}

async function resolveWindowsCommandPathAsync(command: string): Promise<string> {
  if (!isWindows() || path.isAbsolute(command) || commandHasPathSegment(command)) {
    return command;
  }

  for (const dir of getWindowsCommandLookupDirs()) {
    for (const candidate of getWindowsCommandCandidateNames(command)) {
      const fullPath = path.join(dir, candidate);
      if (await existsAsync(fullPath)) {
        return fullPath;
      }
    }
  }

  return command;
}

function getWindowsNpmFallbackPathIfExistsSync(): string | null {
  if (!isWindows()) {
    return null;
  }
  const defaultNpmPath = WINDOWS_NPM_FALLBACK_PATH();
  return fs.existsSync(defaultNpmPath) ? defaultNpmPath : null;
}

async function getWindowsNpmFallbackPathIfExistsAsync(): Promise<string | null> {
  if (!isWindows()) {
    return null;
  }
  const defaultNpmPath = WINDOWS_NPM_FALLBACK_PATH();
  return await existsAsync(defaultNpmPath) ? defaultNpmPath : null;
}

function getWindowsCommandShell(): string {
  return process.env.ComSpec
    || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
}

function quoteWindowsCommandPart(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function buildWindowsCommandLine(command: string, args: readonly string[]): string {
  return ['call', quoteWindowsCommandPart(command), ...args.map(quoteWindowsCommandPart)].join(' ');
}

function getNpmGlobalPrefixRawSync(npmCommand: string): string {
  const commonOptions = {
    encoding: 'utf-8' as const,
    timeout: 3000,
    windowsHide: true,
    cwd: os.homedir(), // Run from home dir to avoid ENOWORKSPACES error in monorepos
  };

  if (!isWindows()) {
    return execFileSync(npmCommand, [...NPM_GLOBAL_PREFIX_ARGS], commonOptions).trim();
  }

  const resolvedNpmCommand = resolveWindowsCommandPathSync(npmCommand);
  const windowsOptions = commonOptions;

  return execFileSync(
    getWindowsCommandShell(),
    ['/d', '/c', buildWindowsCommandLine(resolvedNpmCommand, NPM_GLOBAL_PREFIX_ARGS)],
    windowsOptions
  ).trim();
}

async function getNpmGlobalPrefixRawAsync(npmCommand: string): Promise<string> {
  const commonOptions = {
    encoding: 'utf-8' as const,
    timeout: 3000,
    windowsHide: true,
    cwd: os.homedir(), // Run from home dir to avoid ENOWORKSPACES error in monorepos
  };

  if (!isWindows()) {
    const { stdout } = await execFileAsync(npmCommand, [...NPM_GLOBAL_PREFIX_ARGS], commonOptions);
    return stdout.trim();
  }

  const resolvedNpmCommand = await resolveWindowsCommandPathAsync(npmCommand);
  const windowsOptions = commonOptions;

  const { stdout } = await execFileAsync(
    getWindowsCommandShell(),
    ['/d', '/c', buildWindowsCommandLine(resolvedNpmCommand, NPM_GLOBAL_PREFIX_ARGS)],
    windowsOptions
  );
  return stdout.trim();
}

/**
 * Get npm global prefix directory dynamically
 *
 * Runs `npm config get prefix` to find where npm globals are installed.
 * Works with standard npm, nvm-windows, nvm, and custom installations.
 *
 * On Windows: returns the prefix directory (e.g., C:\Users\user\AppData\Roaming\npm)
 * On macOS/Linux: returns prefix/bin (e.g., /usr/local/bin)
 *
 * @returns npm global binaries directory, or null if npm not available or path doesn't exist
 */
function getNpmGlobalPrefix(): string | null {
  if (npmGlobalPrefixCache !== undefined) {
    return npmGlobalPrefixCache;
  }

  const windowsFallbackPath = getWindowsNpmFallbackPathIfExistsSync();
  if (windowsFallbackPath) {
    npmGlobalPrefixCache = windowsFallbackPath;
    return windowsFallbackPath;
  }

  try {
    // Use platform module helper for npm command name
    const npmCommand = getNpmCommand();

    // Use --location=global to bypass workspace context and avoid ENOWORKSPACES error
    const rawPrefix = getNpmGlobalPrefixRawSync(npmCommand);

    if (!rawPrefix) {
      npmGlobalPrefixCache = null;
      return null;
    }

    // On non-Windows platforms, npm globals are installed in prefix/bin
    // On Windows, they're installed directly in the prefix directory
    const binPath = isWindows()
      ? rawPrefix
      : path.join(rawPrefix, 'bin');

    // Normalize and verify the path exists
    const normalizedPath = path.normalize(binPath);
    if (fs.existsSync(normalizedPath)) {
      npmGlobalPrefixCache = normalizedPath;
      return normalizedPath;
    }

    npmGlobalPrefixCache = getWindowsNpmFallbackPathIfExistsSync();
    return npmGlobalPrefixCache;
  } catch (_error) {
    // Fallback for Windows: try default npm global location when npm.cmd is not in PATH
    // This happens when the packaged app launches from GUI without full shell environment
    if (isWindows()) {
      const defaultNpmPath = getWindowsNpmFallbackPathIfExistsSync();
      if (defaultNpmPath) {
        console.warn('[env-utils] npm command not found, using default npm path:', defaultNpmPath);
        npmGlobalPrefixCache = defaultNpmPath;
        return defaultNpmPath;
      }
    }
    npmGlobalPrefixCache = null;
    return null;
  }
}

/**
 * Common binary directories that should be in PATH
 * These are locations where commonly used tools are installed
 */
export const COMMON_BIN_PATHS: Record<string, string[]> = AUTOCODE_COMMON_BIN_PATHS;

/**
 * Get expanded platform paths for PATH augmentation
 *
 * Shared helper used by both sync and async getAugmentedEnv functions.
 * Expands home directory (~) in paths and returns the list of candidate paths.
 *
 * @param additionalPaths - Optional additional paths to include
 * @returns Array of expanded paths (without existence checking)
 */
function getExpandedPlatformPaths(additionalPaths?: string[]): string[] {
  return expandAutocodePlatformPaths({
    platform: process.platform,
    homeDir: os.homedir(),
    additionalPaths,
  });
}

/**
 * Build augmented PATH by filtering existing paths
 *
 * Shared helper that takes candidate paths and a set of current PATH entries,
 * returning only paths that should be added.
 *
 * @param candidatePaths - Array of paths to consider adding
 * @param currentPathSet - Set of paths already in PATH
 * @param existingPaths - Array of paths that actually exist on the filesystem
 * @param npmPrefix - npm global prefix path (or null if not found)
 * @returns Array of paths to prepend to PATH
 */
function buildPathsToAdd(
  candidatePaths: string[],
  currentPathSet: Set<string>,
  existingPaths: Set<string>,
  npmPrefix: string | null
): string[] {
  return buildAutocodePathsToAdd({
    candidatePaths,
    currentPathSet,
    existingPaths,
    npmPrefix,
  });
}

/**
 * Get augmented environment with additional PATH entries
 *
 * This ensures that tools installed in common locations (like Homebrew)
 * are available to child processes even when the app is launched from
 * Finder/Dock which doesn't inherit the full shell environment.
 *
 * @param additionalPaths - Optional array of additional paths to include
 * @returns Environment object with augmented PATH
 */
export function getAugmentedEnv(additionalPaths?: string[]): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  const pathSeparator = getPathDelimiter();

  // Get all candidate paths (platform + additional)
  const candidatePaths = getExpandedPlatformPaths(additionalPaths);

  // Ensure PATH has essential system directories when launched from Finder/Dock.
  // When Electron launches from GUI (not terminal), PATH might be empty or minimal.
  // The Claude Agent SDK needs /usr/bin/security to access macOS Keychain.
  let currentPath = env.PATH || '';

  // Ensure basic system paths are always present
  {
    const essentialPaths = getAutocodeEssentialSystemPaths(
      isUnix() ? 'linux' : 'win32',
      process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
    );
    const pathSetForEssentials = new Set(currentPath.split(pathSeparator).filter(Boolean));
    const missingEssentials = essentialPaths.filter(p => !pathSetForEssentials.has(p));

    if (missingEssentials.length > 0) {
      // Append essential paths if missing (append, not prepend, to respect user's PATH)
      currentPath = currentPath
        ? `${currentPath}${pathSeparator}${missingEssentials.join(pathSeparator)}`
        : missingEssentials.join(pathSeparator);
    }
  }

  // Collect paths to add (only if they exist and aren't already in PATH)
  const currentPathSet = new Set(currentPath.split(pathSeparator).filter(Boolean));

  // Check existence synchronously and build existing paths set
  const existingPaths = new Set(candidatePaths.filter(p => fs.existsSync(p)));

  // Get npm global prefix dynamically
  const npmPrefix = getNpmGlobalPrefix();
  if (npmPrefix && fs.existsSync(npmPrefix)) {
    existingPaths.add(npmPrefix);
  }

  // Build final paths to add using shared helper
  const pathsToAdd = buildPathsToAdd(candidatePaths, currentPathSet, existingPaths, npmPrefix);

  // Prepend new paths to PATH (prepend so they take priority)
  env.PATH = [...pathsToAdd, currentPath].filter(Boolean).join(pathSeparator);

  // Legacy no-op hook for removed remote error reporting environment variables.
  const sentryEnv = getSentryEnvForSubprocess();
  Object.assign(env, sentryEnv);

  return env;
}

/**
 * Find the full path to an executable
 *
 * Searches PATH (including augmented paths) for the given command.
 * Useful for finding tools like `gh`, `git`, `node`, etc.
 *
 * @param command - The command name to find (e.g., 'gh', 'git')
 * @returns The full path to the executable, or null if not found
 */
export function findExecutable(command: string): string | null {
  const env = getAugmentedEnv();
  const pathSeparator = getPathDelimiter();
  const pathDirs = (env.PATH || '').split(pathSeparator);

  // On Windows, check Windows-native extensions first (.exe, .cmd) before
  // extensionless files (which are typically bash/sh scripts for Git Bash/Cygwin)
  const extensions = isWindows()
    ? ['.exe', '.cmd', '.bat', '.ps1', '']
    : [''];

  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, command + ext);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

/**
 * Check if a command is available (in PATH or common locations)
 *
 * @param command - The command name to check
 * @returns true if the command is available
 */
export function isCommandAvailable(command: string): boolean {
  return findExecutable(command) !== null;
}

// ============================================================================
// ASYNC VERSIONS - Non-blocking alternatives for Electron main process
// ============================================================================

/**
 * Get npm global prefix directory asynchronously (non-blocking)
 *
 * Uses caching to avoid repeated subprocess calls. Safe to call from
 * Electron main process without blocking the event loop.
 *
 * @returns Promise resolving to npm global binaries directory, or null
 */
async function getNpmGlobalPrefixAsync(): Promise<string | null> {
  // Return cached value if available
  if (npmGlobalPrefixCache !== undefined) {
    return npmGlobalPrefixCache;
  }

  const windowsFallbackPath = await getWindowsNpmFallbackPathIfExistsAsync();
  if (windowsFallbackPath) {
    npmGlobalPrefixCache = windowsFallbackPath;
    return windowsFallbackPath;
  }

  // If a fetch is already in progress, wait for it
  if (npmGlobalPrefixCachePromise) {
    return npmGlobalPrefixCachePromise;
  }

  // Start the async fetch
  npmGlobalPrefixCachePromise = (async () => {
    try {
      // Use platform module helper for npm command name
      const npmCommand = getNpmCommand();

      const rawPrefix = await getNpmGlobalPrefixRawAsync(npmCommand);
      if (!rawPrefix) {
        npmGlobalPrefixCache = null;
        return null;
      }

      const binPath = isWindows()
        ? rawPrefix
        : path.join(rawPrefix, 'bin');

      const normalizedPath = path.normalize(binPath);
      if (await existsAsync(normalizedPath)) {
        npmGlobalPrefixCache = normalizedPath;
        return normalizedPath;
      }

      npmGlobalPrefixCache = await getWindowsNpmFallbackPathIfExistsAsync();
      return npmGlobalPrefixCache;
    } catch (error) {
      // Fallback for Windows: try default npm global location when npm.cmd is not in PATH
      // This happens when the packaged app launches from GUI without full shell environment
      if (isWindows()) {
        const defaultNpmPath = await getWindowsNpmFallbackPathIfExistsAsync();
        if (defaultNpmPath) {
          console.warn('[env-utils] npm command not found, using default npm path:', defaultNpmPath);
          npmGlobalPrefixCache = defaultNpmPath;
          return defaultNpmPath;
        }
      }
      console.warn('[env-utils] Failed to get npm global prefix: ' + error);
      npmGlobalPrefixCache = null;
      return null;
    } finally {
      npmGlobalPrefixCachePromise = null;
    }
  })();

  return npmGlobalPrefixCachePromise;
}

/**
 * Get augmented environment asynchronously (non-blocking)
 *
 * Same as getAugmentedEnv but uses async npm prefix detection.
 * Safe to call from Electron main process without blocking.
 *
 * @param additionalPaths - Optional array of additional paths to include
 * @returns Promise resolving to environment object with augmented PATH
 */
export async function getAugmentedEnvAsync(additionalPaths?: string[]): Promise<Record<string, string>> {
  const env = { ...process.env } as Record<string, string>;
  const pathSeparator = getPathDelimiter();

  // Get all candidate paths (platform + additional)
  const candidatePaths = getExpandedPlatformPaths(additionalPaths);

  // Ensure essential system paths are present (for macOS Keychain access, Windows System32)
  let currentPath = env.PATH || '';

  {
    const essentialPaths = getAutocodeEssentialSystemPaths(
      isUnix() ? 'linux' : 'win32',
      process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
    );
    const pathSetForEssentials = new Set(currentPath.split(pathSeparator).filter(Boolean));
    const missingEssentials = essentialPaths.filter(p => !pathSetForEssentials.has(p));

    if (missingEssentials.length > 0) {
      currentPath = currentPath
        ? `${currentPath}${pathSeparator}${missingEssentials.join(pathSeparator)}`
        : missingEssentials.join(pathSeparator);
    }
  }

  // Collect paths to add (only if they exist and aren't already in PATH)
  const currentPathSet = new Set(currentPath.split(pathSeparator).filter(Boolean));

  // Check existence asynchronously in parallel for performance
  const pathChecks = await Promise.all(
    candidatePaths.map(async (p) => ({ path: p, exists: await existsAsync(p) }))
  );
  const existingPaths = new Set(
    pathChecks.filter(({ exists }) => exists).map(({ path: p }) => p)
  );

  // Get npm global prefix dynamically (async - non-blocking)
  const npmPrefix = await getNpmGlobalPrefixAsync();
  if (npmPrefix && await existsAsync(npmPrefix)) {
    existingPaths.add(npmPrefix);
  }

  // Build final paths to add using shared helper
  const pathsToAdd = buildPathsToAdd(candidatePaths, currentPathSet, existingPaths, npmPrefix);

  // Prepend new paths to PATH (prepend so they take priority)
  env.PATH = [...pathsToAdd, currentPath].filter(Boolean).join(pathSeparator);

  // Legacy no-op hook for removed remote error reporting environment variables.
  const sentryEnv = getSentryEnvForSubprocess();
  Object.assign(env, sentryEnv);

  return env;
}

/**
 * Find the full path to an executable asynchronously (non-blocking)
 *
 * Same as findExecutable but uses async environment augmentation.
 *
 * @param command - The command name to find (e.g., 'gh', 'git')
 * @returns Promise resolving to the full path to the executable, or null
 */
export async function findExecutableAsync(command: string): Promise<string | null> {
  const env = await getAugmentedEnvAsync();
  const pathSeparator = getPathDelimiter();
  const pathDirs = (env.PATH || '').split(pathSeparator);

  const extensions = isWindows()
    ? ['.exe', '.cmd', '.bat', '.ps1', '']
    : [''];

  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, command + ext);
      if (await existsAsync(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

/**
 * Clear the npm global prefix cache
 *
 * Call this if npm configuration changes and you need fresh detection.
 */
export function clearNpmPrefixCache(): void {
  npmGlobalPrefixCache = undefined;
  npmGlobalPrefixCachePromise = null;
}

/**
 * Determine if a command requires shell execution on Windows
 *
 * Windows .cmd and .bat files MUST be executed through shell, while .exe files
 * can be executed directly. This function checks the file extension to determine
 * the correct execution method.
 *
 * @param command - The command path to check
 * @returns true if shell is required (Windows .cmd/.bat), false otherwise
 *
 * @example
 * ```typescript
 * shouldUseShell('D:\\nodejs\\claude.cmd')                // true
 * shouldUseShell('C:\\Program Files\\nodejs\\claude.cmd')  // true
 * shouldUseShell('C:\\Windows\\System32\\git.exe')         // false
 * shouldUseShell('/usr/local/bin/claude')                  // false (non-Windows)
 * ```
 */
export function shouldUseShell(command: string): boolean {
  // Only Windows needs special handling for .cmd/.bat files
  if (isUnix()) {
    return false;
  }

  const trimmed = command.trim();
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;

  // Check if command ends with .cmd or .bat (case-insensitive)
  return /\.(cmd|bat)$/i.test(unquoted);
}

/**
 * Get spawn options with correct shell setting for Windows compatibility
 *
 * Provides a consistent way to create spawn options that work across platforms.
 * Handles the shell requirement for Windows .cmd/.bat files automatically.
 *
 * For .cmd/.bat files on Windows, returns options that tell the caller to use
 * proper quoting for paths with spaces.
 *
 * @param command - The command path to execute
 * @param baseOptions - Base spawn options to merge with (optional)
 * @returns Spawn options with correct shell setting
 *
 * @example
 * ```typescript
 * const opts = getSpawnOptions(claudeCmd, { cwd: '/project', env: {...} });
 * spawn(getSpawnCommand(claudeCmd), ['--version'], opts);
 * ```
 */
export function getSpawnOptions(
  command: string,
  baseOptions?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    windowsHide?: boolean;
    stdio?: 'inherit' | 'pipe' | Array<'inherit' | 'pipe'>;
  }
): {
  cwd?: string;
  env?: Record<string, string>;
  shell: boolean;
  timeout?: number;
  windowsHide?: boolean;
  stdio?: 'inherit' | 'pipe' | Array<'inherit' | 'pipe'>;
} {
  return {
    ...baseOptions,
    shell: shouldUseShell(command),
  };
}

/**
 * Get the properly quoted command for use with spawn()
 *
 * For .cmd/.bat files on Windows with shell:true, the command path must be
 * quoted to handle paths containing spaces correctly (e.g., C:\Users\OXFAM MONS\...).
 *
 * @param command - The command path to execute
 * @returns The command (quoted if needed for .cmd/.bat files on Windows)
 *
 * @example
 * ```typescript
 * const cmd = getSpawnCommand(claudeCmd); // "C:\Users\OXFAM MONS\...\claude.cmd"
 * const opts = getSpawnOptions(claudeCmd, { cwd: '/project', env: {...} });
 * spawn(cmd, ['--version'], opts);
 * ```
 */
export function getSpawnCommand(command: string): string {
  // For .cmd/.bat files on Windows, quote the command to handle spaces
  // The shell will parse the quoted path correctly
  const trimmed = command.trim();
  if (shouldUseShell(trimmed)) {
    // Idempotent if already quoted
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed;
    }
    return `"${trimmed}"`;
  }
  // For non-.cmd/.bat files, strip quotes if present (defensive: no double quotes with shell:false)
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
