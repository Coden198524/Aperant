/**
 * Profile Storage Module
 * Handles persistence of profile data to disk
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import {
  AUTOCODE_PROFILE_STORE_VERSION,
  DEFAULT_AUTOCODE_AUTO_SWITCH_SETTINGS,
  getAutocodeClaudeProfilesDir,
  normalizeAutocodeProfileStoreData,
  slugifyAutocodeClaudeProfileName,
  usesAutocodeLegacySharedClaudeDirectory,
} from '@autocode/core/auth/profile-store';
import type { ClaudeProfile, ClaudeAutoSwitchSettings } from '../../shared/types';

/**
 * Directory constants for profile isolation
 */
const CLAUDE_PROFILES_DIR = getAutocodeClaudeProfilesDir(homedir());

export const STORE_VERSION = AUTOCODE_PROFILE_STORE_VERSION;  // Bumped for encrypted token storage

/**
 * Default auto-switch settings
 */
export const DEFAULT_AUTO_SWITCH_SETTINGS: ClaudeAutoSwitchSettings = DEFAULT_AUTOCODE_AUTO_SWITCH_SETTINGS;

/**
 * Internal storage format for Claude profiles
 */
export interface ProfileStoreData {
  version: number;
  profiles: ClaudeProfile[];
  activeProfileId: string;
  autoSwitch?: ClaudeAutoSwitchSettings;
  /** Unified priority order for both OAuth and API profiles */
  accountPriorityOrder?: string[];
  /**
   * Profile IDs that were migrated from shared ~/.claude to isolated directories.
   * These profiles need re-authentication since their credentials are in the old location.
   * Cleared after successful re-authentication.
   */
  migratedProfileIds?: string[];
}

/**
 * Check if a profile uses the legacy shared ~/.claude directory
 */
function usesLegacySharedDirectory(profile: ClaudeProfile): boolean {
  return usesAutocodeLegacySharedClaudeDirectory(profile, homedir());
}

/**
 * Migrate a profile from shared ~/.claude to isolated ~/.claude-profiles/{name}
 * Returns the new configDir path
 *
 * Handles directory collisions by appending a counter (e.g., 'work-account-2')
 * when two profile names sanitize to the same value.
 */
function migrateProfileToIsolatedDirectory(profile: ClaudeProfile): string {
  // Generate isolated directory name from profile name
  const baseName = slugifyAutocodeClaudeProfileName(profile.name);

  // Ensure the profiles directory exists
  if (!existsSync(CLAUDE_PROFILES_DIR)) {
    mkdirSync(CLAUDE_PROFILES_DIR, { recursive: true });
  }

  // Check for directory collision and append counter if needed
  let sanitizedName = baseName;
  let counter = 1;
  let isolatedDir = join(CLAUDE_PROFILES_DIR, sanitizedName);

  // Keep incrementing counter until we find an available directory name
  // Use profile.id as a marker file to detect if the directory belongs to this profile
  // NOTE: There's a TOCTOU race window between existsSync and readFileSync, but this is
  // acceptable because profile directory creation is infrequent and concurrent creation
  // is unlikely. The worst case is we increment the counter unnecessarily.
  while (existsSync(isolatedDir)) {
    const markerFile = join(isolatedDir, '.profile-id');
    if (existsSync(markerFile)) {
      try {
        const existingId = readFileSync(markerFile, 'utf-8').trim();
        if (existingId === profile.id) {
          // This directory belongs to us, use it
          break;
        }
      } catch {
        // Ignore read errors, treat as collision
      }
    }
    // Directory exists but belongs to different profile, try next counter
    counter++;
    sanitizedName = `${baseName}-${counter}`;
    isolatedDir = join(CLAUDE_PROFILES_DIR, sanitizedName);
  }

  // Create the profile directory if it doesn't exist
  if (!existsSync(isolatedDir)) {
    mkdirSync(isolatedDir, { recursive: true });
  }

  // Write a marker file with our profile ID for collision detection
  // Use 'wx' flag to atomically create file only if it doesn't exist (avoids TOCTOU race)
  const markerFile = join(isolatedDir, '.profile-id');
  try {
    writeFileSync(markerFile, profile.id, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    // EEXIST means file already exists, which is fine - we already own this directory
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.warn('[ProfileStorage] Failed to write marker file:', err);
    }
  }

  console.warn(`[ProfileStorage] Migrated profile "${profile.name}" from ~/.claude to ${isolatedDir}`);
  console.warn('[ProfileStorage] NOTE: Credentials remain at ~/.claude - user should re-authenticate in Settings > Accounts');

  return isolatedDir;
}

/**
 * Parse and migrate profile data from JSON.
 * Handles version migration and date parsing.
 * Shared helper used by both sync and async loaders.
 */
function parseAndMigrateProfileData(data: Record<string, unknown>): ProfileStoreData | null {
  return normalizeAutocodeProfileStoreData<ClaudeProfile>(data, {
    migrateLegacyProfile: (profile) => (
      usesLegacySharedDirectory(profile)
        ? migrateProfileToIsolatedDirectory(profile)
        : undefined
    ),
    logger: console,
  }) as ProfileStoreData | null;
}

/**
 * Load profiles from disk
 */
export function loadProfileStore(storePath: string): ProfileStoreData | null {
  try {
    if (existsSync(storePath)) {
      const content = readFileSync(storePath, 'utf-8');
      const data = JSON.parse(content);
      return parseAndMigrateProfileData(data);
    }
  } catch (error) {
    console.error('[ProfileStorage] Error loading profiles:', error);
  }

  return null;
}

/**
 * Load profiles from disk (async, non-blocking)
 * Use this version for initialization to avoid blocking the main process.
 */
export async function loadProfileStoreAsync(storePath: string): Promise<ProfileStoreData | null> {
  try {
    // Read file directly - avoid TOCTOU race condition by not checking existence first
    // If file doesn't exist, readFile will throw ENOENT which we handle below
    const content = await readFile(storePath, 'utf-8');
    const data = JSON.parse(content);
    return parseAndMigrateProfileData(data);
  } catch (error) {
    // ENOENT is expected if file doesn't exist yet
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[ProfileStorage] Error loading profiles:', error);
    }
  }

  return null;
}

/**
 * Save profiles to disk
 */
export function saveProfileStore(storePath: string, data: ProfileStoreData): void {
  try {
    writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error('[ProfileStorage] Error saving profiles:', error);
  }
}
