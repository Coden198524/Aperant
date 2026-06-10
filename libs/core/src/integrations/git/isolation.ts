export const AUTOCODE_GIT_ENV_VARS_TO_CLEAR = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
] as const;

export type AutocodeGitEnvVarToClear = typeof AUTOCODE_GIT_ENV_VARS_TO_CLEAR[number];
export type AutocodeGitEnvironment = Record<string, string | undefined>;

export function getAutocodeIsolatedGitEnv(
  baseEnv: AutocodeGitEnvironment = {}
): AutocodeGitEnvironment {
  const env: AutocodeGitEnvironment = { ...baseEnv };

  for (const varName of AUTOCODE_GIT_ENV_VARS_TO_CLEAR) {
    delete env[varName];
  }

  env.HUSKY = '0';

  return env;
}

export function getAutocodeIsolatedGitSpawnOptions(
  cwd: string,
  additionalOptions: Record<string, unknown> = {},
  baseEnv: AutocodeGitEnvironment = {}
): Record<string, unknown> {
  return {
    cwd,
    env: getAutocodeIsolatedGitEnv(baseEnv),
    encoding: 'utf-8',
    ...additionalOptions,
  };
}
