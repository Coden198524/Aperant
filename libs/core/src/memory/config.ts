export interface AutocodeEnvironmentVars {
  [key: string]: string;
}

export interface AutocodeGlobalMemorySettings {
  autoBuildPath?: string;
  globalOpenAIApiKey?: string;
}

export interface AutocodeEmbeddingValidationResult {
  valid: boolean;
  provider: string;
  reason?: string;
}

export interface AutocodeMemoryDatabaseDetails {
  dbPath: string;
  database: string;
}

export interface AutocodeMemoryConfigEnvironment {
  processEnv?: Record<string, string | undefined>;
  defaultDbPath?: string;
}

export function parseAutocodeEnvFile(envContent: string): AutocodeEnvironmentVars {
  const vars: AutocodeEnvironmentVars = {};

  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      vars[key] = value;
    }
  }

  return vars;
}

export function isAutocodeMemoryEnabled(
  projectEnvVars: AutocodeEnvironmentVars,
  processEnv: Record<string, string | undefined> = {},
): boolean {
  return (
    projectEnvVars.GRAPHITI_ENABLED?.toLowerCase() === 'true' ||
    processEnv.GRAPHITI_ENABLED?.toLowerCase() === 'true'
  );
}

export function hasAutocodeOpenAIKey(
  projectEnvVars: AutocodeEnvironmentVars,
  globalSettings: AutocodeGlobalMemorySettings,
  processEnv: Record<string, string | undefined> = {},
): boolean {
  return Boolean(
    projectEnvVars.OPENAI_API_KEY ||
    globalSettings.globalOpenAIApiKey ||
    processEnv.OPENAI_API_KEY,
  );
}

export function validateAutocodeEmbeddingConfiguration(
  projectEnvVars: AutocodeEnvironmentVars,
  globalSettings: AutocodeGlobalMemorySettings,
  processEnv: Record<string, string | undefined> = {},
): AutocodeEmbeddingValidationResult {
  const provider = (
    projectEnvVars.GRAPHITI_EMBEDDER_PROVIDER ||
    processEnv.GRAPHITI_EMBEDDER_PROVIDER ||
    'openai'
  ).toLowerCase();

  switch (provider) {
    case 'openai':
      return hasAutocodeOpenAIKey(projectEnvVars, globalSettings, processEnv)
        ? { valid: true, provider: 'openai' }
        : {
            valid: false,
            provider: 'openai',
            reason: 'OPENAI_API_KEY not set (required for OpenAI embeddings)',
          };
    case 'ollama':
      return { valid: true, provider: 'ollama' };
    case 'google':
      return projectEnvVars.GOOGLE_API_KEY || processEnv.GOOGLE_API_KEY
        ? { valid: true, provider: 'google' }
        : {
            valid: false,
            provider: 'google',
            reason: 'GOOGLE_API_KEY not set (required for Google AI embeddings)',
          };
    case 'voyage':
      return projectEnvVars.VOYAGE_API_KEY || processEnv.VOYAGE_API_KEY
        ? { valid: true, provider: 'voyage' }
        : {
            valid: false,
            provider: 'voyage',
            reason: 'VOYAGE_API_KEY not set (required for Voyage AI embeddings)',
          };
    case 'azure_openai':
      return projectEnvVars.AZURE_OPENAI_API_KEY || processEnv.AZURE_OPENAI_API_KEY
        ? { valid: true, provider: 'azure_openai' }
        : {
            valid: false,
            provider: 'azure_openai',
            reason: 'AZURE_OPENAI_API_KEY not set (required for Azure OpenAI embeddings)',
          };
    default:
      return { valid: true, provider };
  }
}

export function getAutocodeMemoryDatabaseDetails(
  projectEnvVars: AutocodeEnvironmentVars,
  environment: AutocodeMemoryConfigEnvironment = {},
): AutocodeMemoryDatabaseDetails {
  const processEnv = environment.processEnv || {};
  return {
    dbPath: projectEnvVars.GRAPHITI_DB_PATH ||
      processEnv.GRAPHITI_DB_PATH ||
      environment.defaultDbPath ||
      '',
    database: projectEnvVars.GRAPHITI_DATABASE ||
      processEnv.GRAPHITI_DATABASE ||
      'auto_claude_memory',
  };
}
