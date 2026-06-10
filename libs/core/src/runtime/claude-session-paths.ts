import { joinPaths } from '../platform/os.js';

export interface AutocodeClaudeSessionPathInput {
  configDir: string;
  cwd: string;
  sessionId: string;
  homeDir: string;
  joinPath?: (...parts: string[]) => string;
}

export function cwdToAutocodeClaudeProjectPath(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/');
  return normalized.replace(/^[a-zA-Z]:/, '').replace(/\//g, '-');
}

export function expandAutocodeTildePath(inputPath: string, homeDir: string): string {
  if (inputPath === '~') return homeDir;
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return `${homeDir}${inputPath.slice(1)}`;
  }
  return inputPath;
}

export function getAutocodeClaudeSessionFilePath(input: AutocodeClaudeSessionPathInput): string {
  const joinPath = input.joinPath || joinPaths;
  const expandedConfigDir = expandAutocodeTildePath(input.configDir, input.homeDir);
  return joinPath(
    expandedConfigDir,
    'projects',
    cwdToAutocodeClaudeProjectPath(input.cwd),
    `${input.sessionId}.jsonl`,
  );
}

export function getAutocodeClaudeSessionDirPath(input: AutocodeClaudeSessionPathInput): string {
  const joinPath = input.joinPath || joinPaths;
  const expandedConfigDir = expandAutocodeTildePath(input.configDir, input.homeDir);
  return joinPath(
    expandedConfigDir,
    'projects',
    cwdToAutocodeClaudeProjectPath(input.cwd),
    input.sessionId,
  );
}
