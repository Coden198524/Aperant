export type AutocodeClaudeCodeSettingsLevel = 'user' | 'projectShared' | 'projectLocal' | 'managed';

export interface AutocodeClaudeCodePermissions {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  defaultMode?: 'ask' | 'acceptEdits' | 'plan';
  additionalDirectories?: string[];
}

export interface AutocodeClaudeCodeSettings {
  permissions?: AutocodeClaudeCodePermissions;
  model?: string;
  alwaysThinkingEnabled?: boolean;
  env?: Record<string, string>;
}

export interface AutocodeClaudeCodeSettingsHierarchy {
  user?: AutocodeClaudeCodeSettings;
  projectShared?: AutocodeClaudeCodeSettings;
  projectLocal?: AutocodeClaudeCodeSettings;
  managed?: AutocodeClaudeCodeSettings;
  merged: AutocodeClaudeCodeSettings;
}

export interface AutocodeEnvSanitizerLogger {
  debug?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

const LOG_PREFIX = '[EnvSanitizer]';

export const AUTOCODE_DANGEROUS_CLAUDE_CODE_ENV_VARS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_BIND_NOW',
  'LD_DEBUG',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  'DYLD_VERSIONED_LIBRARY_PATH',
  'DYLD_VERSIONED_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONINSPECT',
  'RUBYOPT',
  'RUBYLIB',
  'PERL5OPT',
  'PERLLIB',
  'PERL5LIB',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'PROMPT_COMMAND',
  'INPUTRC',
  'CDPATH',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'MAVEN_OPTS',
  'GRADLE_OPTS',
  'PYTHONUSERBASE',
  'NPM_CONFIG_PREFIX',
  'YARN_RC_FILENAME',
  'COMPOSER_HOME',
  'GIT_TRACE',
  'GIT_TRACE_PACKET',
  'GIT_TRACE_PERFORMANCE',
  'GIT_SSH_COMMAND',
  'GIT_ALLOW_PROTOCOL',
]);

export const AUTOCODE_WARNING_CLAUDE_CODE_ENV_VARS = new Set([
  'PATH',
  'SHELL',
  'TERM',
]);

export function sanitizeAutocodeClaudeCodeEnvVars(
  env: Record<string, string> | undefined,
  sourceLevel: AutocodeClaudeCodeSettingsLevel = 'user',
  logger?: AutocodeEnvSanitizerLogger,
): Record<string, string> {
  if (!env || typeof env !== 'object') {
    return {};
  }

  const sanitized: Record<string, string> = {};
  const blocked: string[] = [];
  const warned: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      logger?.error?.(`${LOG_PREFIX} Invalid env var type: ${typeof key}=${typeof value}`);
      continue;
    }

    const upperKey = key.toUpperCase();
    if (AUTOCODE_DANGEROUS_CLAUDE_CODE_ENV_VARS.has(upperKey)) {
      blocked.push(key);
      logger?.error?.(
        `${LOG_PREFIX} BLOCKED dangerous env var from ${sourceLevel}: ${key}`,
        '(prevents code injection attack)',
      );
      continue;
    }

    if (
      (sourceLevel === 'projectShared' || sourceLevel === 'projectLocal') &&
      AUTOCODE_WARNING_CLAUDE_CODE_ENV_VARS.has(upperKey)
    ) {
      warned.push(key);
      logger?.debug?.(
        `${LOG_PREFIX} WARNING: ${key} set from ${sourceLevel} settings`,
        '(can affect command execution, verify this is intentional)',
      );
    }

    sanitized[key] = value;
  }

  if (blocked.length > 0) {
    logger?.error?.(
      `${LOG_PREFIX} Blocked ${blocked.length} dangerous env var(s) from ${sourceLevel}:`,
      blocked.join(', '),
    );
  }

  if (warned.length > 0) {
    logger?.debug?.(
      `${LOG_PREFIX} ${warned.length} potentially dangerous env var(s) from ${sourceLevel}:`,
      warned.join(', '),
    );
  }

  return sanitized;
}

export function isAutocodeDangerousClaudeCodeEnvVar(key: string): boolean {
  return AUTOCODE_DANGEROUS_CLAUDE_CODE_ENV_VARS.has(key.toUpperCase());
}

export function isAutocodeWarningClaudeCodeEnvVar(key: string): boolean {
  return AUTOCODE_WARNING_CLAUDE_CODE_ENV_VARS.has(key.toUpperCase());
}

export function getAutocodeDangerousClaudeCodeEnvVars(): string[] {
  return Array.from(AUTOCODE_DANGEROUS_CLAUDE_CODE_ENV_VARS).sort();
}

export function getAutocodeWarningClaudeCodeEnvVars(): string[] {
  return Array.from(AUTOCODE_WARNING_CLAUDE_CODE_ENV_VARS).sort();
}

export function mergeAutocodeClaudeCodeSettings(
  hierarchy: AutocodeClaudeCodeSettingsHierarchy,
  logger?: AutocodeEnvSanitizerLogger,
): AutocodeClaudeCodeSettings {
  let merged: AutocodeClaudeCodeSettings = {};

  merged = mergeTwoLevels(merged, hierarchy.user, 'user', 'user', logger);
  merged = mergeTwoLevels(merged, hierarchy.projectShared, 'user', 'projectShared', logger);
  merged = mergeTwoLevels(merged, hierarchy.projectLocal, 'projectShared', 'projectLocal', logger);
  merged = mergeTwoLevels(merged, hierarchy.managed, 'projectLocal', 'managed', logger);

  return merged;
}

function mergeEnv(
  lower: Record<string, string> | undefined,
  higher: Record<string, string> | undefined,
  lowerLevel: AutocodeClaudeCodeSettingsLevel,
  higherLevel: AutocodeClaudeCodeSettingsLevel,
  logger?: AutocodeEnvSanitizerLogger,
): Record<string, string> | undefined {
  if (!lower && !higher) return undefined;
  if (!lower) return sanitizeAutocodeClaudeCodeEnvVars(higher, higherLevel, logger);
  if (!higher) return sanitizeAutocodeClaudeCodeEnvVars(lower, lowerLevel, logger);

  return {
    ...sanitizeAutocodeClaudeCodeEnvVars(lower, lowerLevel, logger),
    ...sanitizeAutocodeClaudeCodeEnvVars(higher, higherLevel, logger),
  };
}

function mergeArrays(
  lower: string[] | undefined,
  higher: string[] | undefined,
): string[] | undefined {
  if (!lower && !higher) return undefined;
  if (!lower) return higher ? [...higher] : undefined;
  if (!higher) return [...lower];

  return [...new Set([...lower, ...higher])];
}

function mergeTwoLevels(
  lower: AutocodeClaudeCodeSettings | undefined,
  higher: AutocodeClaudeCodeSettings | undefined,
  lowerLevel: AutocodeClaudeCodeSettingsLevel,
  higherLevel: AutocodeClaudeCodeSettingsLevel,
  logger?: AutocodeEnvSanitizerLogger,
): AutocodeClaudeCodeSettings {
  if (!lower && !higher) return {};
  if (!lower) return sanitizeSingleLevel(higher || {}, higherLevel, logger);
  if (!higher) return sanitizeSingleLevel(lower, lowerLevel, logger);

  const result: AutocodeClaudeCodeSettings = { ...lower };

  if (higher.model !== undefined) {
    result.model = higher.model;
  }
  if (higher.alwaysThinkingEnabled !== undefined) {
    result.alwaysThinkingEnabled = higher.alwaysThinkingEnabled;
  }

  result.env = mergeEnv(lower.env, higher.env, lowerLevel, higherLevel, logger);
  if (!result.env || Object.keys(result.env).length === 0) {
    delete result.env;
  }

  if (lower.permissions || higher.permissions) {
    const lp = lower.permissions ?? {};
    const hp = higher.permissions ?? {};

    result.permissions = {
      ...lp,
      ...(hp.defaultMode !== undefined ? { defaultMode: hp.defaultMode } : {}),
      allow: mergeArrays(lp.allow, hp.allow),
      deny: mergeArrays(lp.deny, hp.deny),
      ask: mergeArrays(lp.ask, hp.ask),
      additionalDirectories: mergeArrays(lp.additionalDirectories, hp.additionalDirectories),
    };

    if (!result.permissions.allow) delete result.permissions.allow;
    if (!result.permissions.deny) delete result.permissions.deny;
    if (!result.permissions.ask) delete result.permissions.ask;
    if (!result.permissions.additionalDirectories) delete result.permissions.additionalDirectories;
    if (!result.permissions.defaultMode) delete result.permissions.defaultMode;
  }

  return result;
}

function sanitizeSingleLevel(
  settings: AutocodeClaudeCodeSettings,
  level: AutocodeClaudeCodeSettingsLevel,
  logger?: AutocodeEnvSanitizerLogger,
): AutocodeClaudeCodeSettings {
  const result = { ...settings };
  if (result.env) {
    result.env = sanitizeAutocodeClaudeCodeEnvVars(result.env, level, logger);
    if (Object.keys(result.env).length === 0) {
      delete result.env;
    }
  }
  return result;
}
