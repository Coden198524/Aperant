import { app } from 'electron';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { getAutocodeProjectEnvPath } from '@autocode/core';
import {
  getAutocodeMemoryDatabaseDetails,
  hasAutocodeOpenAIKey,
  isAutocodeMemoryEnabled,
  parseAutocodeEnvFile,
  validateAutocodeEmbeddingConfiguration,
} from '@autocode/core/memory/config';
import { getMemoriesDir } from '../../config-paths';

export interface EnvironmentVars {
  [key: string]: string;
}

export interface GlobalSettings {
  autoBuildPath?: string;
  globalOpenAIApiKey?: string;
}

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

/**
 * Get the auto-build source path from settings
 */
export function getAutoBuildSourcePath(): string | null {
  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      if (settings.autoBuildPath && existsSync(settings.autoBuildPath)) {
        return settings.autoBuildPath;
      }
    } catch {
      // Fall through to null
    }
  }
  return null;
}

/**
 * Parse .env file content into key-value pairs
 * Handles both Unix and Windows line endings
 */
export function parseEnvFile(envContent: string): EnvironmentVars {
  return parseAutocodeEnvFile(envContent);
}

/**
 * Load environment variables from project .env file
 */
export function loadProjectEnvVars(projectPath: string, autoBuildPath?: string): EnvironmentVars {
  if (!autoBuildPath) {
    return {};
  }

  const projectEnvPath = getAutocodeProjectEnvPath(projectPath, autoBuildPath);
  if (!existsSync(projectEnvPath)) {
    return {};
  }

  try {
    const envContent = readFileSync(projectEnvPath, 'utf-8');
    return parseEnvFile(envContent);
  } catch {
    return {};
  }
}

/**
 * Load global settings from user data directory
 */
export function loadGlobalSettings(): GlobalSettings {
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const settingsContent = readFileSync(settingsPath, 'utf-8');
    return JSON.parse(settingsContent);
  } catch {
    return {};
  }
}

/**
 * Check if memory is enabled in project or global environment
 */
export function isMemoryEnabled(projectEnvVars: EnvironmentVars): boolean {
  return isAutocodeMemoryEnabled(projectEnvVars, process.env);
}

/** @deprecated Use isMemoryEnabled instead */
export const isGraphitiEnabled = isMemoryEnabled;

/**
 * Check if OpenAI API key is available
 * Priority: project .env > global settings > process.env
 */
export function hasOpenAIKey(projectEnvVars: EnvironmentVars, globalSettings: GlobalSettings): boolean {
  return hasAutocodeOpenAIKey(projectEnvVars, globalSettings, process.env);
}

/**
 * Embedding configuration validation result
 */
export interface EmbeddingValidationResult {
  valid: boolean;
  provider: string;
  reason?: string;
}

/**
 * Validate embedding configuration based on the configured provider
 * Supports: openai, ollama, google, voyage, azure_openai
 *
 * @returns validation result with provider info and reason if invalid
 */
export function validateEmbeddingConfiguration(
  projectEnvVars: EnvironmentVars,
  globalSettings: GlobalSettings
): EmbeddingValidationResult {
  return validateAutocodeEmbeddingConfiguration(projectEnvVars, globalSettings, process.env);
}

/**
 * Get memory database details (LadybugDB - embedded database)
 */
export interface MemoryDatabaseDetails {
  dbPath: string;
  database: string;
}

export function getMemoryDatabaseDetails(projectEnvVars: EnvironmentVars): MemoryDatabaseDetails {
  return getAutocodeMemoryDatabaseDetails(projectEnvVars, {
    processEnv: process.env,
    defaultDbPath: getMemoriesDir(),
  });
}
