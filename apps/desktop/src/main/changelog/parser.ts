import { readFileSync } from 'fs';
import {
  extractChangelog,
  extractSpecOverview,
  parseAutocodeExistingChangelogContent,
  parseAutocodeExistingChangelogError,
  parseGitLogOutput,
} from '@autocode/core/changelog';
import type { ExistingChangelog } from '../../shared/types';

export { extractChangelog, extractSpecOverview, parseGitLogOutput };

/**
 * Parse existing changelog file and extract metadata
 */
export function parseExistingChangelog(filePath: string): ExistingChangelog {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return parseAutocodeExistingChangelogContent(content);
  } catch (error) {
    return parseAutocodeExistingChangelogError(error);
  }
}
