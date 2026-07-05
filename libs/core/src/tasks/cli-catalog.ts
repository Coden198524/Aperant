export const SUPPORTED_AUTOCODE_CLIS = [
  'claude-code',
  'gemini',
  'opencode',
  'kilocode',
  'codex',
  'deepseek',
  'custom',
] as const;

export type AutocodeCli = (typeof SUPPORTED_AUTOCODE_CLIS)[number];

type BuiltinAutocodeCli = Exclude<AutocodeCli, 'custom'>;

export const DEFAULT_AUTOCODE_CLI: AutocodeCli = 'claude-code';

export type AutocodeCliJsonEventParserType = 'codex-json';

export interface AutocodeCliJsonEventParser {
  type: AutocodeCliJsonEventParserType;
  displayName: string;
  commandNames: string[];
  requiredArgs?: string[];
}

export interface AutocodeCliTaskRunStrategy {
  args?: string[];
  modelFlag?: string;
  promptStdinArg?: string;
}

export interface AutocodeCliDefinition {
  command: string;
  permissionBypassArgs?: string[];
  taskRunStrategy?: AutocodeCliTaskRunStrategy;
}

export type AutocodeCliRuntimeRouteMatch = string | readonly string[];

export interface AutocodeCliRuntimeRouteCondition {
  provider?: AutocodeCliRuntimeRouteMatch;
  authSource?: AutocodeCliRuntimeRouteMatch;
  modelId?: AutocodeCliRuntimeRouteMatch;
  modelIdPrefix?: AutocodeCliRuntimeRouteMatch;
  modelIdIncludes?: AutocodeCliRuntimeRouteMatch;
}

export interface AutocodeCliRuntimeRoute {
  id: string;
  displayName: string;
  cli: AutocodeCli;
  condition: AutocodeCliRuntimeRouteCondition;
}

export interface ResolveAutocodeCliRuntimeRouteInput {
  provider?: unknown;
  authSource?: unknown;
  modelId?: unknown;
}

export const AUTOCODE_CLI_DEFINITIONS: Readonly<Record<BuiltinAutocodeCli, AutocodeCliDefinition>> = {
  'claude-code': {
    command: 'claude',
    permissionBypassArgs: ['--dangerously-skip-permissions'],
  },
  gemini: {
    command: 'gemini',
  },
  opencode: {
    command: 'opencode',
  },
  kilocode: {
    command: 'kilocode',
  },
  codex: {
    command: 'codex',
    permissionBypassArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    taskRunStrategy: {
      args: ['exec', '--json'],
      modelFlag: '-m',
      promptStdinArg: '-',
    },
  },
  deepseek: {
    command: 'deepseek',
  },
};

export const AUTOCODE_CLI_COMMANDS: Readonly<Record<BuiltinAutocodeCli, string>> = Object.fromEntries(
  Object.entries(AUTOCODE_CLI_DEFINITIONS).map(([cli, definition]) => [cli, definition.command]),
) as Readonly<Record<BuiltinAutocodeCli, string>>;

export const AUTOCODE_CLI_RUNTIME_ROUTES: readonly AutocodeCliRuntimeRoute[] = [
  {
    id: 'openai-codex-oauth',
    displayName: 'Codex CLI',
    cli: 'codex',
    condition: {
      provider: ['openai', 'openai.responses', 'openai-responses'],
      authSource: 'codex-oauth',
    },
  },
] as const;

export const AUTOCODE_CLI_JSON_EVENT_PARSERS: readonly AutocodeCliJsonEventParser[] = [
  {
    type: 'codex-json',
    displayName: 'Codex',
    commandNames: ['codex'],
    requiredArgs: ['--json'],
  },
] as const;

export type AutocodeCliContinuationStrategyType = 'exec-resume-session' | 'append-continuation-flag';
export type AutocodeCliContinuationSessionIdSource = 'json-event-session' | 'latest';

export interface AutocodeCliContinuationStrategy {
  displayName: string;
  type: AutocodeCliContinuationStrategyType;
  commandNames: string[];
  requiresJsonMode?: boolean;
  jsonEventParser?: AutocodeCliJsonEventParserType;
  execCommand?: string;
  resumeArgs?: string[];
  requiredArgs?: string[];
  promptStdinArg?: string;
  continuationFlag?: string;
  existingContinuationFlags?: string[];
  sessionIdSource?: AutocodeCliContinuationSessionIdSource;
}

export const AUTOCODE_CLI_CONTINUATION_STRATEGIES: Readonly<Partial<Record<AutocodeCli, AutocodeCliContinuationStrategy>>> = {
  codex: {
    displayName: 'Codex',
    type: 'exec-resume-session',
    commandNames: ['codex'],
    requiresJsonMode: true,
    jsonEventParser: 'codex-json',
    execCommand: 'exec',
    resumeArgs: ['exec', 'resume'],
    requiredArgs: ['--json'],
    promptStdinArg: '-',
    sessionIdSource: 'json-event-session',
  },
  'claude-code': {
    displayName: 'Claude Code',
    type: 'append-continuation-flag',
    commandNames: ['claude'],
    continuationFlag: '--continue',
    existingContinuationFlags: ['--continue', '-c', '--resume', '-r'],
    sessionIdSource: 'latest',
  },
};

export function getAutocodeCliContinuationStrategy(
  cli: AutocodeCli,
): AutocodeCliContinuationStrategy | undefined {
  const strategy = AUTOCODE_CLI_CONTINUATION_STRATEGIES[cli];
  if (!strategy) {
    return undefined;
  }
  const copy: AutocodeCliContinuationStrategy = {
    ...strategy,
    commandNames: [...strategy.commandNames],
  };
  if (strategy.resumeArgs) {
    copy.resumeArgs = [...strategy.resumeArgs];
  }
  if (strategy.requiredArgs) {
    copy.requiredArgs = [...strategy.requiredArgs];
  }
  if (strategy.existingContinuationFlags) {
    copy.existingContinuationFlags = [...strategy.existingContinuationFlags];
  }
  return copy;
}

export function getAutocodeCliJsonEventParsers(): AutocodeCliJsonEventParser[] {
  return AUTOCODE_CLI_JSON_EVENT_PARSERS.map((parser) => ({
    ...parser,
    commandNames: [...parser.commandNames],
    ...(parser.requiredArgs ? { requiredArgs: [...parser.requiredArgs] } : {}),
  }));
}

export function getAutocodeCliRuntimeRoutes(): AutocodeCliRuntimeRoute[] {
  return AUTOCODE_CLI_RUNTIME_ROUTES.map(copyAutocodeCliRuntimeRoute);
}

export function resolveAutocodeCliRuntimeRoute(
  input: ResolveAutocodeCliRuntimeRouteInput,
): AutocodeCliRuntimeRoute | null {
  const route = AUTOCODE_CLI_RUNTIME_ROUTES.find((candidate) =>
    matchesAutocodeCliRuntimeRoute(candidate.condition, input)
  );
  return route ? copyAutocodeCliRuntimeRoute(route) : null;
}

export function isAutocodeCli(value: unknown): value is AutocodeCli {
  return typeof value === 'string' && SUPPORTED_AUTOCODE_CLIS.includes(value as AutocodeCli);
}

export function resolveAutocodeCli(value: string, fallback?: AutocodeCli): AutocodeCli {
  if (isAutocodeCli(value)) {
    return value;
  }
  if (fallback) {
    return fallback;
  }
  throw new Error(`Unsupported CLI "${value}". Supported values: ${SUPPORTED_AUTOCODE_CLIS.join(', ')}.`);
}

export function getAutocodeCliCommandName(cli: AutocodeCli, customCommand?: string): string {
  if (cli === 'custom') {
    const parts = splitAutocodeCliCommandLine(customCommand?.trim() ?? '');
    if (parts.length === 0) {
      throw new Error('customCommand is required when cli is custom.');
    }
    return parts[0];
  }
  return AUTOCODE_CLI_DEFINITIONS[cli].command;
}

export function resolveAutocodeCliInvocation(
  cli: AutocodeCli,
  customCommand: string | undefined,
): { command: string; args: string[] } {
  if (cli === 'custom') {
    const parts = splitAutocodeCliCommandLine(customCommand?.trim() ?? '');
    if (parts.length === 0) {
      throw new Error('customCommand is required when cli is custom.');
    }
    return { command: parts[0], args: parts.slice(1) };
  }

  return { command: AUTOCODE_CLI_DEFINITIONS[cli].command, args: [] };
}

export function resolveAutocodeCliTaskRunInvocation(input: {
  cli: AutocodeCli;
  customCommand?: string;
  model?: string;
  bypassPermissions: boolean;
}): { command: string; args: string[] } {
  const invocation = resolveAutocodeCliInvocation(input.cli, input.customCommand);
  const permissionArgs = getAutocodeCliPermissionArgs(input.cli, input.bypassPermissions);

  if (input.cli === 'custom') {
    return {
      command: invocation.command,
      args: [...invocation.args, ...permissionArgs],
    };
  }

  const strategy = AUTOCODE_CLI_DEFINITIONS[input.cli].taskRunStrategy;
  if (!strategy) {
    return {
      command: invocation.command,
      args: [...invocation.args, ...permissionArgs],
    };
  }

  const modelArgs = strategy.modelFlag && input.model
    ? [strategy.modelFlag, input.model]
    : [];
  return {
    command: invocation.command,
    args: [
      ...(strategy.args ?? []),
      ...modelArgs,
      ...permissionArgs,
      ...(strategy.promptStdinArg ? [strategy.promptStdinArg] : []),
    ],
  };
}

export function getAutocodeCliPermissionArgs(cli: AutocodeCli, bypassPermissions: boolean): string[] {
  if (!bypassPermissions || cli === 'custom') {
    return [];
  }
  return [...(AUTOCODE_CLI_DEFINITIONS[cli].permissionBypassArgs ?? [])];
}

export function getAutocodeCliPermissionBypassFlag(cli: AutocodeCli, bypassPermissions: boolean): string {
  const args = getAutocodeCliPermissionArgs(cli, bypassPermissions);
  return args.length > 0 ? ` ${args.join(' ')}` : '';
}

export function buildAutocodeCliCommand(input: {
  cli: AutocodeCli;
  customCommand?: string;
  bypassPermissions?: boolean;
}): string {
  const invocation = resolveAutocodeCliInvocation(input.cli, input.customCommand);
  const permissionArgs = getAutocodeCliPermissionArgs(input.cli, input.bypassPermissions === true);
  return [invocation.command, ...invocation.args, ...permissionArgs].map(quoteShellArg).join(' ');
}

export function splitAutocodeCliCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += '\\';
  }
  if (quote) {
    throw new Error('customCommand has an unterminated quote.');
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function copyAutocodeCliRuntimeRoute(route: AutocodeCliRuntimeRoute): AutocodeCliRuntimeRoute {
  return {
    ...route,
    condition: copyAutocodeCliRuntimeRouteCondition(route.condition),
  };
}

function copyAutocodeCliRuntimeRouteCondition(
  condition: AutocodeCliRuntimeRouteCondition,
): AutocodeCliRuntimeRouteCondition {
  return {
    ...(condition.provider ? { provider: copyRuntimeRouteMatch(condition.provider) } : {}),
    ...(condition.authSource ? { authSource: copyRuntimeRouteMatch(condition.authSource) } : {}),
    ...(condition.modelId ? { modelId: copyRuntimeRouteMatch(condition.modelId) } : {}),
    ...(condition.modelIdPrefix ? { modelIdPrefix: copyRuntimeRouteMatch(condition.modelIdPrefix) } : {}),
    ...(condition.modelIdIncludes ? { modelIdIncludes: copyRuntimeRouteMatch(condition.modelIdIncludes) } : {}),
  };
}

function copyRuntimeRouteMatch(match: AutocodeCliRuntimeRouteMatch): AutocodeCliRuntimeRouteMatch {
  return Array.isArray(match) ? [...match] : match;
}

function matchesAutocodeCliRuntimeRoute(
  condition: AutocodeCliRuntimeRouteCondition,
  input: ResolveAutocodeCliRuntimeRouteInput,
): boolean {
  return matchesExactRouteValue(input.provider, condition.provider)
    && matchesExactRouteValue(input.authSource, condition.authSource)
    && matchesExactRouteValue(input.modelId, condition.modelId)
    && matchesPrefixRouteValue(input.modelId, condition.modelIdPrefix)
    && matchesIncludesRouteValue(input.modelId, condition.modelIdIncludes);
}

function matchesExactRouteValue(value: unknown, match?: AutocodeCliRuntimeRouteMatch): boolean {
  if (!match) {
    return true;
  }
  const normalized = normalizeRouteString(value);
  return normalized !== null && toRouteMatchList(match).some((candidate) =>
    normalized === normalizeRouteString(candidate)
  );
}

function matchesPrefixRouteValue(value: unknown, match?: AutocodeCliRuntimeRouteMatch): boolean {
  if (!match) {
    return true;
  }
  const normalized = normalizeRouteString(value);
  return normalized !== null && toRouteMatchList(match).some((candidate) => {
    const normalizedCandidate = normalizeRouteString(candidate);
    return Boolean(normalizedCandidate && normalized.startsWith(normalizedCandidate));
  });
}

function matchesIncludesRouteValue(value: unknown, match?: AutocodeCliRuntimeRouteMatch): boolean {
  if (!match) {
    return true;
  }
  const normalized = normalizeRouteString(value);
  return normalized !== null && toRouteMatchList(match).some((candidate) => {
    const normalizedCandidate = normalizeRouteString(candidate);
    return Boolean(normalizedCandidate && normalized.includes(normalizedCandidate));
  });
}

function toRouteMatchList(match: AutocodeCliRuntimeRouteMatch): readonly string[] {
  return typeof match === 'string' ? [match] : match;
}

function normalizeRouteString(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null;
}
