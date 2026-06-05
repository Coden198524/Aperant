import { isWindows } from '../platform';
import type { WindowsShellType } from '../types/terminal';

export type { WindowsShellType };

export {
  escapeAutocodeForWindowsDoubleQuote as escapeForWindowsDoubleQuote,
  escapeAutocodeShellArg as escapeShellArg,
  escapeAutocodeShellArgWindows as escapeShellArgWindows,
  escapeAutocodeShellPath as escapeShellPath,
  isAutocodePathShellSafe as isPathSafe,
} from '@autocode/core/tools/shell';

import {
  buildAutocodeCdCommand,
} from '@autocode/core/tools/shell';

export function buildCdCommand(path: string | undefined, shellType?: WindowsShellType): string {
  return buildAutocodeCdCommand(path, {
    isWindows: isWindows(),
    shellType,
  });
}

export interface FileReferenceDropData {
  type: 'file-reference';
  path: string;
  name: string;
  isDirectory: boolean;
}

export function parseFileReferenceDrop(dataTransfer: DataTransfer): FileReferenceDropData | null {
  const jsonData = dataTransfer.getData('application/json');
  if (!jsonData) {
    return null;
  }

  try {
    const data = JSON.parse(jsonData) as Record<string, unknown>;
    if (
      data.type === 'file-reference' &&
      typeof data.path === 'string' &&
      data.path.length > 0
    ) {
      return {
        type: 'file-reference',
        path: data.path,
        name: typeof data.name === 'string' ? data.name : '',
        isDirectory: typeof data.isDirectory === 'boolean' ? data.isDirectory : false,
      };
    }
  } catch {
    return null;
  }

  return null;
}
