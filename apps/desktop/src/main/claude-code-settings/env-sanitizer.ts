import {
  getAutocodeDangerousClaudeCodeEnvVars,
  getAutocodeWarningClaudeCodeEnvVars,
  isAutocodeDangerousClaudeCodeEnvVar,
  isAutocodeWarningClaudeCodeEnvVar,
  sanitizeAutocodeClaudeCodeEnvVars,
  type AutocodeClaudeCodeSettingsLevel,
} from '@autocode/core/config/claude-code-settings';
import { debugLog, debugError } from '../../shared/utils/debug-logger';

const logger = {
  debug: debugLog,
  error: debugError,
};

export function sanitizeEnvVars(
  env: Record<string, string> | undefined,
  sourceLevel: AutocodeClaudeCodeSettingsLevel = 'user'
): Record<string, string> {
  return sanitizeAutocodeClaudeCodeEnvVars(env, sourceLevel, logger);
}

export function isDangerousEnvVar(key: string): boolean {
  return isAutocodeDangerousClaudeCodeEnvVar(key);
}

export function isWarningEnvVar(key: string): boolean {
  return isAutocodeWarningClaudeCodeEnvVar(key);
}

export function getDangerousEnvVars(): string[] {
  return getAutocodeDangerousClaudeCodeEnvVars();
}

export function getWarningEnvVars(): string[] {
  return getAutocodeWarningClaudeCodeEnvVars();
}
