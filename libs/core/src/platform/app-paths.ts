import { joinPaths } from './os.js';

export type AutocodeAppPathType = 'config' | 'data' | 'cache' | 'memories';

export interface AutocodeAppPathEnvironment {
  env?: Record<string, string | undefined>;
  homeDir: string;
  isLinux?: boolean;
  legacyPathExists?: (candidatePath: string) => boolean;
}

export const AUTOCODE_APP_NAME = 'autocode';
export const AUTOCODE_LEGACY_HOME_APP_NAMES = ['.auto-claude', '.aperant'];

export function getAutocodeXdgConfigHome(input: AutocodeAppPathEnvironment): string {
  return input.env?.XDG_CONFIG_HOME || joinPaths(input.homeDir, '.config');
}

export function getAutocodeXdgDataHome(input: AutocodeAppPathEnvironment): string {
  return input.env?.XDG_DATA_HOME || joinPaths(input.homeDir, '.local', 'share');
}

export function getAutocodeXdgCacheHome(input: AutocodeAppPathEnvironment): string {
  return input.env?.XDG_CACHE_HOME || joinPaths(input.homeDir, '.cache');
}

export function getAutocodeAppConfigDir(input: AutocodeAppPathEnvironment): string {
  return joinPaths(getAutocodeXdgConfigHome(input), AUTOCODE_APP_NAME);
}

export function getAutocodeAppDataDir(input: AutocodeAppPathEnvironment): string {
  return joinPaths(getAutocodeXdgDataHome(input), AUTOCODE_APP_NAME);
}

export function getAutocodeAppCacheDir(input: AutocodeAppPathEnvironment): string {
  return joinPaths(getAutocodeXdgCacheHome(input), AUTOCODE_APP_NAME);
}

export function isAutocodeImmutableEnvironment(env: Record<string, string | undefined> = {}): boolean {
  return Boolean(env.APPIMAGE || env.SNAP || env.FLATPAK_ID);
}

export function shouldUseAutocodeXdgDataPath(input: AutocodeAppPathEnvironment): boolean {
  const env = input.env || {};
  return Boolean(
    input.isLinux &&
    (env.XDG_DATA_HOME || env.APPIMAGE || env.SNAP || env.FLATPAK_ID),
  );
}

export function getAutocodeMemoriesDir(
  input: AutocodeAppPathEnvironment,
  projectDataDirName: string,
): string {
  const defaultPath = joinPaths(input.homeDir, projectDataDirName, 'memories');
  const legacyPath = AUTOCODE_LEGACY_HOME_APP_NAMES
    .map((name) => joinPaths(input.homeDir, name, 'memories'))
    .find((candidate) => input.legacyPathExists?.(candidate));

  if (shouldUseAutocodeXdgDataPath(input)) {
    return joinPaths(getAutocodeXdgDataHome(input), AUTOCODE_APP_NAME, 'memories');
  }

  return legacyPath || defaultPath;
}

export function getAutocodeAppPath(
  type: AutocodeAppPathType,
  input: AutocodeAppPathEnvironment,
  projectDataDirName: string,
): string {
  switch (type) {
    case 'config':
      return getAutocodeAppConfigDir(input);
    case 'data':
      return getAutocodeAppDataDir(input);
    case 'cache':
      return getAutocodeAppCacheDir(input);
    case 'memories':
      return getAutocodeMemoriesDir(input, projectDataDirName);
    default:
      return getAutocodeAppDataDir(input);
  }
}
