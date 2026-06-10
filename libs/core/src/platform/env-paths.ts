export type AutocodeEnvPlatform = 'darwin' | 'linux' | 'win32' | string;

export interface ExpandAutocodePlatformPathsOptions {
  platform: AutocodeEnvPlatform;
  homeDir: string;
  additionalPaths?: string[];
}

export interface BuildAutocodePathsToAddOptions {
  candidatePaths: string[];
  currentPathSet: ReadonlySet<string>;
  existingPaths: ReadonlySet<string>;
  npmPrefix?: string | null;
}

export interface BuildAutocodeAugmentedPathOptions {
  currentPath: string;
  pathSeparator: string;
  candidatePaths: string[];
  existingPaths: ReadonlySet<string>;
  npmPrefix?: string | null;
  essentialPaths?: string[];
}

export const AUTOCODE_COMMON_BIN_PATHS: Record<string, string[]> = {
  darwin: [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/local/share/dotnet',
    '/opt/homebrew/sbin',
    '/usr/local/sbin',
    '~/.local/bin',
    '~/.dotnet/tools',
  ],
  linux: [
    '/usr/local/bin',
    '/usr/bin',
    '/snap/bin',
    '~/.local/bin',
    '~/.dotnet/tools',
    '/usr/sbin',
  ],
  win32: [
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\GitHub CLI',
    'C:\\Program Files\\nodejs',
    'C:\\Program Files (x86)\\nodejs',
    '~\\AppData\\Local\\Programs\\nodejs',
    '~\\AppData\\Roaming\\npm',
    '~\\scoop\\apps\\nodejs\\current',
    'C:\\ProgramData\\chocolatey\\bin',
  ],
};

export const AUTOCODE_UNIX_ESSENTIAL_SYSTEM_PATHS = [
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

export function getAutocodeWindowsNpmFallbackPath(homeDir: string, appDataPath?: string): string {
  return joinAutocodePath(appDataPath || joinAutocodePath(homeDir, 'AppData', 'Roaming'), 'npm');
}

export function getAutocodeEssentialSystemPaths(
  platform: AutocodeEnvPlatform,
  systemRoot = 'C:\\Windows',
): string[] {
  return platform === 'win32'
    ? [`${systemRoot}\\System32`]
    : [...AUTOCODE_UNIX_ESSENTIAL_SYSTEM_PATHS];
}

export function expandAutocodePlatformPaths(options: ExpandAutocodePlatformPathsOptions): string[] {
  const platformPaths = AUTOCODE_COMMON_BIN_PATHS[options.platform] || [];
  const expandedPaths = platformPaths.map((candidate) => expandAutocodeHomePath(candidate, options.homeDir));

  for (const additionalPath of options.additionalPaths || []) {
    expandedPaths.push(expandAutocodeHomePath(additionalPath, options.homeDir));
  }

  return expandedPaths;
}

export function appendMissingAutocodeEssentialPaths(
  currentPath: string,
  pathSeparator: string,
  essentialPaths: string[],
): string {
  const currentPathSet = new Set(currentPath.split(pathSeparator).filter(Boolean));
  const missingEssentials = essentialPaths.filter((candidate) => !currentPathSet.has(candidate));

  if (missingEssentials.length === 0) {
    return currentPath;
  }

  return currentPath
    ? `${currentPath}${pathSeparator}${missingEssentials.join(pathSeparator)}`
    : missingEssentials.join(pathSeparator);
}

export function buildAutocodePathsToAdd(options: BuildAutocodePathsToAddOptions): string[] {
  const pathsToAdd: string[] = [];

  for (const candidatePath of options.candidatePaths) {
    if (!options.currentPathSet.has(candidatePath) && options.existingPaths.has(candidatePath)) {
      pathsToAdd.push(candidatePath);
    }
  }

  if (
    options.npmPrefix &&
    !options.currentPathSet.has(options.npmPrefix) &&
    options.existingPaths.has(options.npmPrefix)
  ) {
    pathsToAdd.push(options.npmPrefix);
  }

  return pathsToAdd;
}

export function buildAutocodeAugmentedPath(options: BuildAutocodeAugmentedPathOptions): string {
  const currentPath = options.essentialPaths
    ? appendMissingAutocodeEssentialPaths(options.currentPath, options.pathSeparator, options.essentialPaths)
    : options.currentPath;
  const currentPathSet = new Set(currentPath.split(options.pathSeparator).filter(Boolean));
  const pathsToAdd = buildAutocodePathsToAdd({
    candidatePaths: options.candidatePaths,
    currentPathSet,
    existingPaths: options.existingPaths,
    npmPrefix: options.npmPrefix,
  });

  return [...pathsToAdd, currentPath].filter(Boolean).join(options.pathSeparator);
}

export function expandAutocodeHomePath(candidatePath: string, homeDir: string): string {
  if (candidatePath === '~') {
    return homeDir;
  }
  if (candidatePath.startsWith('~/') || candidatePath.startsWith('~\\')) {
    return `${homeDir}${candidatePath.slice(1)}`;
  }
  return candidatePath;
}

function joinAutocodePath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part, index) => {
      if (index === 0) return part.replace(/[\\/]+$/, '');
      return part.replace(/^[\\/]+|[\\/]+$/g, '');
    })
    .join('\\');
}
