import { joinPaths } from './os.js';

export type AutocodeCliTool = 'python' | 'git' | 'gh' | 'glab' | 'claude';

export interface AutocodeToolConfig {
  pythonPath?: string;
  gitPath?: string;
  githubCLIPath?: string;
  gitlabCLIPath?: string;
  claudePath?: string;
}

export type AutocodeToolDetectionSource =
  | 'user-config'
  | 'venv'
  | 'homebrew'
  | 'nvm'
  | 'system-path'
  | 'bundled'
  | 'fallback';

export interface AutocodeCliToolDetectionResult {
  found: boolean;
  path?: string;
  version?: string;
  source: AutocodeToolDetectionSource;
  message: string;
}

export interface AutocodeToolValidation {
  valid: boolean;
  version?: string;
  message: string;
}

export interface AutocodeClaudeDetectionPaths {
  homebrewPaths: string[];
  platformPaths: string[];
  nvmVersionsDir: string;
}

export interface GetAutocodeClaudeDetectionPathsOptions {
  isWindows: boolean;
  executableExtension?: string;
  joinPath?: (...parts: string[]) => string;
}

export const AUTOCODE_TOOL_CONFIG_KEYS = [
  'pythonPath',
  'gitPath',
  'githubCLIPath',
  'gitlabCLIPath',
  'claudePath',
] as const satisfies readonly (keyof AutocodeToolConfig)[];

export function normalizeAutocodeExecOutput(output: string | Buffer): string {
  return typeof output === 'string' ? output : output.toString('utf-8');
}

export function normalizeAutocodeToolConfig(config: AutocodeToolConfig): AutocodeToolConfig {
  const normalized: AutocodeToolConfig = {};

  for (const key of AUTOCODE_TOOL_CONFIG_KEYS) {
    const value = config[key]?.trim();
    if (value) {
      normalized[key] = value;
    }
  }

  return normalized;
}

export function areAutocodeToolConfigsEqual(
  left: AutocodeToolConfig,
  right: AutocodeToolConfig,
): boolean {
  return AUTOCODE_TOOL_CONFIG_KEYS.every((key) => left[key] === right[key]);
}

export function isAutocodeWrongPlatformPath(
  pathStr: string | undefined,
  options: { isWindows: boolean },
): boolean {
  if (!pathStr) return false;

  if (options.isWindows) {
    return pathStr.startsWith('/') && !pathStr.startsWith('//');
  }

  return (
    /^[A-Za-z]:[/\\]/.test(pathStr) ||
    pathStr.includes('\\') ||
    pathStr.includes('AppData') ||
    pathStr.includes('Program Files')
  );
}

export function getAutocodeClaudeDetectionPaths(
  homeDir: string,
  options: GetAutocodeClaudeDetectionPathsOptions,
): AutocodeClaudeDetectionPaths {
  const joinPath = options.joinPath || joinPaths;
  const executableExtension = options.executableExtension ?? (options.isWindows ? '.exe' : '');
  const homebrewPaths = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];

  const platformPaths = options.isWindows
    ? [
        joinPath(homeDir, 'AppData', 'Local', 'Programs', 'claude', `claude${executableExtension}`),
        joinPath(homeDir, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        joinPath(homeDir, '.local', 'bin', `claude${executableExtension}`),
        'C:\\Program Files\\Claude\\claude.exe',
        'C:\\Program Files (x86)\\Claude\\claude.exe',
      ]
    : [
        joinPath(homeDir, '.local', 'bin', 'claude'),
        joinPath(homeDir, 'bin', 'claude'),
      ];

  return {
    homebrewPaths,
    platformPaths,
    nvmVersionsDir: joinPath(homeDir, '.nvm', 'versions', 'node'),
  };
}

export function sortAutocodeNvmVersionDirs(
  entries: Array<{ name: string; isDirectory(): boolean }>,
): string[] {
  const semverRegex = /^v\d+\.\d+\.\d+$/;

  return entries
    .filter((entry) => entry.isDirectory() && semverRegex.test(entry.name))
    .sort((a, b) => {
      const vA = a.name.slice(1).split('.').map(Number);
      const vB = b.name.slice(1).split('.').map(Number);
      for (let index = 0; index < 3; index += 1) {
        const diff = (vB[index] ?? 0) - (vA[index] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    })
    .map((entry) => entry.name);
}

export function buildAutocodeClaudeDetectionResult(
  claudePath: string,
  validation: AutocodeToolValidation,
  source: AutocodeToolDetectionSource,
  messagePrefix: string,
): AutocodeCliToolDetectionResult | null {
  if (!validation.valid) {
    return null;
  }

  return {
    found: true,
    path: claudePath,
    version: validation.version,
    source,
    message: `${messagePrefix}: ${claudePath}`,
  };
}
