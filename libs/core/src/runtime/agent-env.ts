export function normalizeAutocodeEnvPathKey(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if ('PATH' in env) {
    for (const key of Object.keys(env)) {
      if (key !== 'PATH' && key.toUpperCase() === 'PATH') {
        delete env[key];
      }
    }
    return env;
  }

  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  if (pathKey) {
    env.PATH = env[pathKey];
    delete env[pathKey];
    for (const key of Object.keys(env)) {
      if (key !== 'PATH' && key.toUpperCase() === 'PATH') {
        delete env[key];
      }
    }
  }

  return env;
}

export function mergeAutocodePythonEnvPath(
  env: Record<string, string | undefined>,
  mergedPythonEnv: Record<string, string | undefined>,
  pathSep: string,
): void {
  normalizeAutocodeEnvPathKey(env);
  normalizeAutocodeEnvPathKey(mergedPythonEnv);

  if (mergedPythonEnv.PATH && env.PATH) {
    const augmentedPathEntries = new Set(env.PATH.split(pathSep).filter(Boolean));
    const pythonPathEntries = mergedPythonEnv.PATH
      .split(pathSep)
      .filter((entry) => entry && !augmentedPathEntries.has(entry));

    mergedPythonEnv.PATH = pythonPathEntries.length > 0
      ? [...pythonPathEntries, env.PATH].join(pathSep)
      : env.PATH;
  }
}

export function getAutocodeOAuthModeClearVars(
  apiProfileEnv: Record<string, string> | null | undefined,
): Record<string, string> {
  if (apiProfileEnv && Object.keys(apiProfileEnv).some((key) => key.startsWith('ANTHROPIC_'))) {
    return {};
  }

  return {
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: '',
    ANTHROPIC_MODEL: '',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
    ANTHROPIC_DEFAULT_SONNET_MODEL: '',
    ANTHROPIC_DEFAULT_OPUS_MODEL: '',
  };
}
