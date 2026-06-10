import { mergeAutocodeClaudeCodeSettings } from '@autocode/core/config/claude-code-settings';
import { debugLog, debugError } from '../../shared/utils/debug-logger';
import type { ClaudeCodeSettings, ClaudeCodeSettingsHierarchy } from './types';

export function mergeClaudeCodeSettings(
  hierarchy: ClaudeCodeSettingsHierarchy,
): ClaudeCodeSettings {
  return mergeAutocodeClaudeCodeSettings(hierarchy, {
    debug: debugLog,
    error: debugError,
  });
}
