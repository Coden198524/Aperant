import { normalizeThinkingLevel } from '../config/types.js';

export const BUILTIN_AUTOCODE_CLIS = [
  'claude-code',
  'gemini',
  'opencode',
  'kilocode',
  'codex',
  'deepseek',
] as const;

export const SUPPORTED_AUTOCODE_CLIS = [
  ...BUILTIN_AUTOCODE_CLIS,
  'custom',
] as const;

export type BuiltinAutocodeCli = (typeof BUILTIN_AUTOCODE_CLIS)[number];
export type KnownAutocodeCli = (typeof SUPPORTED_AUTOCODE_CLIS)[number];
// Built-ins are defaults and UI quick picks; runtime routes may declare any safe CLI identifier.
export type AutocodeCli = KnownAutocodeCli | (string & {});

export const DEFAULT_AUTOCODE_CLI: AutocodeCli = 'claude-code';

export type AutocodeCliJsonEventParserType = string;

export interface AutocodeCliJsonEventParser {
  type: AutocodeCliJsonEventParserType;
  displayName: string;
  commandNames: string[];
  requiredArgs?: string[];
  payloadFields?: string[];
  eventTypeFields?: string[];
  sessionIdFields?: string[];
  messageFields?: string[];
  completionEventTypes?: string[];
  ignoredEventTypes?: string[];
  ignoredEventTypeIncludes?: string[];
  toolStartEventTypes?: string[];
  toolEndEventTypes?: string[];
  toolNameFields?: string[];
  toolInputFields?: string[];
  toolOutputFields?: string[];
  toolCallIdFields?: string[];
  toolSuccessFields?: string[];
  toolExitCodeFields?: string[];
  toolStatusFields?: string[];
}

export interface AutocodeCliTaskRunStrategy {
  args?: string[];
  modelFlag?: string;
  promptStdinArg?: string;
}

export type AutocodeCliPreflightActionType = 'strip-utf8-bom-from-rules';

export interface AutocodeCliPreflightAction {
  type: AutocodeCliPreflightActionType;
  displayName?: string;
  commandNames?: string[];
  directory?: string;
  envHome?: string;
  homeSubdir?: string;
  childDir?: string;
  fileExtension?: string;
}

export interface AutocodeCliDefinition {
  command: string;
  permissionBypassArgs?: string[];
  taskRunStrategy?: AutocodeCliTaskRunStrategy;
  continuationStrategy?: AutocodeCliContinuationStrategy;
  preflightActions?: AutocodeCliPreflightAction[];
}

export type AutocodeCliRuntimeRouteMatch = string | readonly string[];

export interface AutocodeCliRuntimeRouteCondition {
  provider?: AutocodeCliRuntimeRouteMatch;
  providerPrefix?: AutocodeCliRuntimeRouteMatch;
  providerIncludes?: AutocodeCliRuntimeRouteMatch;
  authSource?: AutocodeCliRuntimeRouteMatch;
  authSourcePrefix?: AutocodeCliRuntimeRouteMatch;
  authSourceIncludes?: AutocodeCliRuntimeRouteMatch;
  modelId?: AutocodeCliRuntimeRouteMatch;
  modelIdPrefix?: AutocodeCliRuntimeRouteMatch;
  modelIdIncludes?: AutocodeCliRuntimeRouteMatch;
}

export interface AutocodeCliRuntimeRoute {
  id: string;
  displayName: string;
  cli: AutocodeCli;
  condition: AutocodeCliRuntimeRouteCondition;
  customCommand?: string;
  permissionBypassArgs?: string[];
  taskRunStrategy?: AutocodeCliTaskRunStrategy;
  jsonEventParser?: AutocodeCliJsonEventParser;
  continuationStrategy?: AutocodeCliContinuationStrategy;
  preflightActions?: AutocodeCliPreflightAction[];
}

export interface ResolveAutocodeCliRuntimeRouteInput {
  provider?: unknown;
  authSource?: unknown;
  modelId?: unknown;
  routes?: unknown;
  includeBuiltinRoutes?: boolean;
}

export interface ResolveAutocodeCliRuntimeStartOptionsInput extends ResolveAutocodeCliRuntimeRouteInput {
  cli: AutocodeCli;
  customCommand?: string;
}

export interface ResolvedAutocodeCliRuntimeStartOptions {
  cli: AutocodeCli;
  customCommand?: string;
  directCliContinuationStrategy?: AutocodeCliContinuationStrategy;
  directCliJsonEventParser?: AutocodeCliJsonEventParser;
  directCliRuntimeRouteId?: string;
  directCliRuntimeRouteDisplayName?: string;
  directCliPermissionBypassArgs?: string[];
  directCliTaskRunStrategy?: AutocodeCliTaskRunStrategy;
  directCliPreflightActions?: AutocodeCliPreflightAction[];
  route: AutocodeCliRuntimeRoute | null;
}

export const AUTOCODE_CLI_DEFINITIONS: Readonly<Record<BuiltinAutocodeCli, AutocodeCliDefinition>> = {
  'claude-code': {
    command: 'claude',
    permissionBypassArgs: ['--dangerously-skip-permissions'],
    continuationStrategy: {
      displayName: 'Claude Code',
      type: 'append-continuation-flag',
      commandNames: ['claude'],
      continuationFlag: '--continue',
      existingContinuationFlags: ['--continue', '-c', '--resume', '-r'],
      sessionIdSource: 'latest',
    },
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
    continuationStrategy: {
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
    preflightActions: [
      {
        type: 'strip-utf8-bom-from-rules',
        displayName: 'Codex rules',
        commandNames: ['codex'],
        envHome: 'CODEX_HOME',
        homeSubdir: '.codex',
        childDir: 'rules',
        fileExtension: '.rules',
      },
    ],
  },
  deepseek: {
    command: 'deepseek',
    continuationStrategy: {
      displayName: 'DeepSeek CLI',
      type: 'argument-template',
      commandNames: ['deepseek'],
      argsTemplate: ['{args}'],
      sessionIdSource: 'latest',
    },
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
    payloadFields: ['payload', 'msg.payload', 'msg', 'item', 'response_item', 'event', 'response'],
    eventTypeFields: ['type', 'event_type', 'kind'],
    sessionIdFields: ['session_id', 'sessionId', 'conversation_id', 'session.id'],
    messageFields: ['message', 'content', 'text', 'response.output_text', 'response.outputText'],
    completionEventTypes: ['turn_completed', 'response_completed'],
    ignoredEventTypes: ['turn_started', 'session_configured', 'response_started', 'agent_message_delta', 'message_delta'],
    ignoredEventTypeIncludes: ['reasoning', 'analysis', 'encrypted'],
    toolStartEventTypes: ['function_call', 'tool_call'],
    toolEndEventTypes: ['function_call_output', 'tool_result', 'command_execution'],
    toolNameFields: ['name', 'tool_name', 'toolName'],
    toolInputFields: ['arguments', 'input', 'args', 'command', 'cmd'],
    toolOutputFields: ['output', 'content', 'result', 'aggregated_output', 'stdout', 'stderr'],
    toolCallIdFields: ['call_id', 'callId', 'id'],
    toolSuccessFields: ['success'],
    toolExitCodeFields: ['exit_code', 'exitCode'],
    toolStatusFields: ['status'],
  },
] as const;

export type AutocodeCliContinuationStrategyType = 'exec-resume-session' | 'append-continuation-flag' | 'argument-template';
export type AutocodeCliContinuationSessionIdSource = 'json-event-session' | 'latest';

export interface AutocodeCliContinuationStrategy {
  displayName: string;
  type: AutocodeCliContinuationStrategyType;
  commandNames: string[];
  requiresJsonMode?: boolean;
  jsonEventParser?: AutocodeCliJsonEventParserType;
  execCommand?: string;
  resumeArgs?: string[];
  argsTemplate?: string[];
  requiredArgs?: string[];
  promptStdinArg?: string;
  continuationFlag?: string;
  existingContinuationFlags?: string[];
  sessionIdSource?: AutocodeCliContinuationSessionIdSource;
}

export const AUTOCODE_CLI_CONTINUATION_STRATEGIES: Readonly<Partial<Record<BuiltinAutocodeCli, AutocodeCliContinuationStrategy>>> = Object.fromEntries(
  Object.entries(AUTOCODE_CLI_DEFINITIONS)
    .filter((entry): entry is [BuiltinAutocodeCli, AutocodeCliDefinition & { continuationStrategy: AutocodeCliContinuationStrategy }] =>
      Boolean(entry[1].continuationStrategy)
    )
    .map(([cli, definition]) => [cli, definition.continuationStrategy]),
) as Readonly<Partial<Record<BuiltinAutocodeCli, AutocodeCliContinuationStrategy>>>;

export function getAutocodeCliPreflightActions(
  cli: AutocodeCli,
): AutocodeCliPreflightAction[] {
  if (!isBuiltinAutocodeCli(cli)) {
    return [];
  }
  return (AUTOCODE_CLI_DEFINITIONS[cli].preflightActions ?? []).map(copyAutocodeCliPreflightAction);
}

export function getAutocodeCliContinuationStrategy(
  cli: AutocodeCli,
): AutocodeCliContinuationStrategy | undefined {
  if (!isBuiltinAutocodeCli(cli)) {
    return undefined;
  }
  const strategy = AUTOCODE_CLI_CONTINUATION_STRATEGIES[cli];
  return strategy ? copyAutocodeCliContinuationStrategy(strategy) : undefined;
}

export function getAutocodeCliJsonEventParsers(): AutocodeCliJsonEventParser[] {
  return AUTOCODE_CLI_JSON_EVENT_PARSERS.map(copyAutocodeCliJsonEventParser);
}

export function getAutocodeCliRuntimeRoutes(input: {
  routes?: unknown;
  includeBuiltinRoutes?: boolean;
} = {}): AutocodeCliRuntimeRoute[] {
  const externalRoutes = parseAutocodeCliRuntimeRoutes(input.routes);
  const builtinRoutes = input.includeBuiltinRoutes === false
    ? []
    : AUTOCODE_CLI_RUNTIME_ROUTES.map(copyAutocodeCliRuntimeRoute);
  return [...externalRoutes, ...builtinRoutes];
}

export function resolveAutocodeCliRuntimeRoute(
  input: ResolveAutocodeCliRuntimeRouteInput,
): AutocodeCliRuntimeRoute | null {
  const route = getAutocodeCliRuntimeRoutes({
    routes: input.routes,
    includeBuiltinRoutes: input.includeBuiltinRoutes,
  }).find((candidate) =>
    matchesAutocodeCliRuntimeRoute(candidate.condition, input)
  );
  return route ? copyAutocodeCliRuntimeRoute(route) : null;
}

export function resolveAutocodeCliRuntimeStartOptions(
  input: ResolveAutocodeCliRuntimeStartOptionsInput,
): ResolvedAutocodeCliRuntimeStartOptions {
  const route = resolveAutocodeCliRuntimeRoute(input);
  if (!route) {
    return {
      cli: input.cli,
      ...(input.customCommand ? { customCommand: input.customCommand } : {}),
      route: null,
    };
  }

  return {
    cli: route.cli,
    customCommand: resolveAutocodeCliRuntimeCustomCommand(route, input),
    directCliContinuationStrategy: route.continuationStrategy,
    directCliJsonEventParser: route.jsonEventParser,
    directCliRuntimeRouteId: route.id,
    directCliRuntimeRouteDisplayName: route.displayName,
    directCliPermissionBypassArgs: route.permissionBypassArgs,
    directCliTaskRunStrategy: route.taskRunStrategy,
    directCliPreflightActions: route.preflightActions,
    route,
  };
}

export function resolveAutocodeCliRuntimeCustomCommand(
  route: Pick<AutocodeCliRuntimeRoute, 'customCommand'>,
  context: Pick<ResolveAutocodeCliRuntimeRouteInput, 'provider' | 'modelId' | 'authSource'>,
): string | undefined {
  const command = route.customCommand?.trim();
  if (!command) {
    return undefined;
  }

  const replacements: Record<string, string> = {
    provider: stringifyRuntimeTemplateValue(context.provider),
    model: stringifyRuntimeTemplateValue(context.modelId),
    modelId: stringifyRuntimeTemplateValue(context.modelId),
    authSource: stringifyRuntimeTemplateValue(context.authSource),
  };
  return command.replace(
    /\$\{(provider|model|modelId|authSource)\}|\{(provider|model|modelId|authSource)\}/g,
    (_match, shellKey: string | undefined, braceKey: string | undefined) =>
      replacements[shellKey ?? braceKey ?? ''] ?? '',
  );
}

export function parseAutocodeCliRuntimeRoutes(value: unknown): AutocodeCliRuntimeRoute[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map(parseAutocodeCliRuntimeRoute).filter((route): route is AutocodeCliRuntimeRoute => Boolean(route));
}

export function isAutocodeCli(value: unknown): value is KnownAutocodeCli {
  return typeof value === 'string' && SUPPORTED_AUTOCODE_CLIS.includes(value as KnownAutocodeCli);
}

export function resolveAutocodeCli(value: string, fallback?: AutocodeCli): AutocodeCli {
  if (isAutocodeCli(value)) {
    return value;
  }
  if (isAutocodeCliIdentifier(value)) {
    return value.trim();
  }
  if (fallback) {
    return fallback;
  }
  throw new Error(`Invalid CLI identifier "${value}". Use letters, numbers, dots, underscores, or hyphens.`);
}

export function getAutocodeCliCommandName(cli: AutocodeCli, customCommand?: string): string {
  if (customCommand?.trim() || cli === 'custom') {
    const parts = splitAutocodeCliCommandLine(customCommand?.trim() ?? '');
    if (parts.length === 0) {
      throw new Error('customCommand is required when cli is custom.');
    }
    return parts[0];
  }
  if (!isBuiltinAutocodeCli(cli)) {
    return cli;
  }
  return AUTOCODE_CLI_DEFINITIONS[cli].command;
}

export function resolveAutocodeCliInvocation(
  cli: AutocodeCli,
  customCommand: string | undefined,
): { command: string; args: string[] } {
  if (customCommand?.trim() || cli === 'custom') {
    const parts = splitAutocodeCliCommandLine(customCommand?.trim() ?? '');
    if (parts.length === 0) {
      throw new Error('customCommand is required when cli is custom.');
    }
    return { command: parts[0], args: parts.slice(1) };
  }

  if (!isBuiltinAutocodeCli(cli)) {
    return { command: cli, args: [] };
  }

  return { command: AUTOCODE_CLI_DEFINITIONS[cli].command, args: [] };
}

export function resolveAutocodeCliTaskRunInvocation(input: {
  cli: AutocodeCli;
  customCommand?: string;
  model?: string;
  thinkingLevel?: string;
  bypassPermissions: boolean;
  permissionBypassArgs?: string[];
  taskRunStrategy?: AutocodeCliTaskRunStrategy;
}): { command: string; args: string[] } {
  const invocation = resolveAutocodeCliInvocation(input.cli, input.customCommand);
  const permissionArgs = getAutocodeCliPermissionArgs(
    input.cli,
    input.bypassPermissions,
    input.permissionBypassArgs,
  );
  const strategy = input.taskRunStrategy ?? (isBuiltinAutocodeCli(input.cli)
    ? AUTOCODE_CLI_DEFINITIONS[input.cli].taskRunStrategy
    : undefined);

  if (!strategy) {
    return {
      command: invocation.command,
      args: [...invocation.args, ...permissionArgs],
    };
  }

  const modelArgs = strategy.modelFlag && input.model
    ? [strategy.modelFlag, input.model]
    : [];
  const thinkingArgs = input.cli === 'codex' && input.thinkingLevel
    ? ['-c', `model_reasoning_effort=${normalizeThinkingLevel(input.thinkingLevel)}`]
    : [];
  return {
    command: invocation.command,
    args: [
      ...invocation.args,
      ...(strategy.args ?? []),
      ...modelArgs,
      ...thinkingArgs,
      ...permissionArgs,
      ...(strategy.promptStdinArg ? [strategy.promptStdinArg] : []),
    ],
  };
}

export function getAutocodeCliPermissionArgs(
  cli: AutocodeCli,
  bypassPermissions: boolean,
  permissionBypassArgs?: readonly string[],
): string[] {
  if (!bypassPermissions) {
    return [];
  }
  if (permissionBypassArgs) {
    return [...permissionBypassArgs];
  }
  if (!isBuiltinAutocodeCli(cli)) {
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

function parseAutocodeCliRuntimeRoute(value: unknown): AutocodeCliRuntimeRoute | null {
  const record = asRuntimeRouteRecord(value);
  if (!record) {
    return null;
  }

  const id = parseRuntimeRouteString(record.id);
  const displayName = parseRuntimeRouteString(record.displayName) ?? parseRuntimeRouteString(record.display_name);
  const cli = parseRuntimeRouteString(record.cli);
  const condition = parseAutocodeCliRuntimeRouteCondition(record.condition);
  const customCommand = parseRuntimeRouteString(record.customCommand) ?? parseRuntimeRouteString(record.custom_command);
  const permissionBypassArgs = parseRuntimeStringList(record.permissionBypassArgs ?? record.permission_bypass_args);
  const rawTaskRunStrategy = record.taskRunStrategy ?? record.task_run_strategy ?? record.taskRun ?? record.task_run;
  const taskRunStrategy = rawTaskRunStrategy === undefined
    ? null
    : parseAutocodeCliTaskRunStrategy(rawTaskRunStrategy);
  const rawJsonEventParser = record.jsonEventParser ?? record.json_event_parser;
  const jsonEventParser = rawJsonEventParser === undefined
    ? null
    : parseAutocodeCliJsonEventParser(rawJsonEventParser, displayName ?? cli ?? 'CLI');
  const rawContinuationStrategy = record.continuationStrategy ?? record.continuation_strategy ?? record.continuation;
  const continuationStrategy = rawContinuationStrategy === undefined
    ? null
    : parseAutocodeCliContinuationStrategy(rawContinuationStrategy, displayName ?? cli ?? 'CLI');
  const rawPreflightActions = record.preflightActions ?? record.preflight_actions ?? record.preflight;
  const parsedPreflightActions = rawPreflightActions === undefined
    ? []
    : parseAutocodeCliPreflightActions(rawPreflightActions);
  if (
    !id ||
    !displayName ||
    !cli ||
    !isAutocodeCliIdentifier(cli) ||
    !condition ||
    (cli === 'custom' && !customCommand) ||
    (rawTaskRunStrategy !== undefined && !taskRunStrategy) ||
    (rawJsonEventParser !== undefined && !jsonEventParser) ||
    (rawContinuationStrategy !== undefined && !continuationStrategy) ||
    parsedPreflightActions === null
  ) {
    return null;
  }
  const preflightActions = parsedPreflightActions;

  return {
    id,
    displayName,
    cli,
    condition,
    ...(customCommand ? { customCommand } : {}),
    ...(permissionBypassArgs ? { permissionBypassArgs } : {}),
    ...(taskRunStrategy ? { taskRunStrategy } : {}),
    ...(jsonEventParser ? { jsonEventParser } : {}),
    ...(continuationStrategy ? { continuationStrategy } : {}),
    ...(preflightActions.length > 0 ? { preflightActions } : {}),
  };
}

function parseAutocodeCliRuntimeRouteCondition(value: unknown): AutocodeCliRuntimeRouteCondition | null {
  const record = asRuntimeRouteRecord(value);
  if (!record) {
    return null;
  }

  const condition: AutocodeCliRuntimeRouteCondition = {};
  const fields = [
    ['provider', 'provider'],
    ['providerPrefix', 'providerPrefix', 'provider_prefix'],
    ['providerIncludes', 'providerIncludes', 'provider_includes'],
    ['authSource', 'authSource', 'auth_source'],
    ['authSourcePrefix', 'authSourcePrefix', 'auth_source_prefix'],
    ['authSourceIncludes', 'authSourceIncludes', 'auth_source_includes'],
    ['modelId', 'modelId', 'model_id'],
    ['modelIdPrefix', 'modelIdPrefix', 'model_id_prefix'],
    ['modelIdIncludes', 'modelIdIncludes', 'model_id_includes'],
  ] as const;

  for (const [conditionKey, ...sourceKeys] of fields) {
    const match = parseRuntimeRouteMatch(readFirstRuntimeRouteField(record, sourceKeys));
    if (match) {
      condition[conditionKey] = match;
    }
  }
  return Object.keys(condition).length > 0 ? condition : null;
}

function parseAutocodeCliPreflightActions(value: unknown): AutocodeCliPreflightAction[] | null {
  const rawItems = Array.isArray(value) ? value : value ? [value] : [];
  const actions = rawItems
    .map(parseAutocodeCliPreflightAction)
    .filter((action): action is AutocodeCliPreflightAction => Boolean(action));
  return rawItems.length > 0 && actions.length === 0 ? null : actions;
}

function parseAutocodeCliPreflightAction(value: unknown): AutocodeCliPreflightAction | null {
  const record = asRuntimeRouteRecord(value);
  if (!record) {
    return null;
  }

  const type = parseRuntimeRouteString(record.type);
  if (type !== 'strip-utf8-bom-from-rules') {
    return null;
  }

  const action: AutocodeCliPreflightAction = { type };
  const displayName = parseRuntimeRouteString(record.displayName) ?? parseRuntimeRouteString(record.display_name);
  if (displayName) action.displayName = displayName;
  const commandNames = parseRuntimeStringList(record.commandNames ?? record.command_names);
  if (commandNames) action.commandNames = commandNames;
  const directory = parseRuntimeRouteString(record.directory);
  if (directory) action.directory = directory;
  const envHome = parseRuntimeRouteString(record.envHome ?? record.env_home);
  if (envHome) action.envHome = envHome;
  const homeSubdir = parseRuntimeRouteString(record.homeSubdir ?? record.home_subdir);
  if (homeSubdir) action.homeSubdir = homeSubdir;
  const childDir = parseRuntimeRouteString(record.childDir ?? record.child_dir);
  if (childDir) action.childDir = childDir;
  const fileExtension = parseRuntimeRouteString(record.fileExtension ?? record.file_extension);
  if (fileExtension) action.fileExtension = fileExtension;
  return action;
}

function parseAutocodeCliContinuationStrategy(
  value: unknown,
  defaultDisplayName: string,
): AutocodeCliContinuationStrategy | null {
  const record = asRuntimeRouteRecord(value);
  if (!record) {
    return null;
  }

  const type = parseRuntimeRouteString(record.type);
  if (type !== 'exec-resume-session' && type !== 'append-continuation-flag' && type !== 'argument-template') {
    return null;
  }
  const commandNames = parseRuntimeStringList(record.commandNames ?? record.command_names);
  if (!commandNames) {
    return null;
  }

  const displayName = parseRuntimeRouteString(record.displayName) ??
    parseRuntimeRouteString(record.display_name) ??
    defaultDisplayName;
  const strategy: AutocodeCliContinuationStrategy = {
    displayName,
    type,
    commandNames,
  };

  const sessionIdSource = parseRuntimeRouteString(record.sessionIdSource ?? record.session_id_source);
  if (sessionIdSource) {
    if (sessionIdSource !== 'json-event-session' && sessionIdSource !== 'latest') {
      return null;
    }
    strategy.sessionIdSource = sessionIdSource;
  }

  const requiresJsonMode = parseRuntimeRouteBoolean(record.requiresJsonMode ?? record.requires_json_mode);
  if (requiresJsonMode !== undefined) {
    strategy.requiresJsonMode = requiresJsonMode;
  }

  const jsonEventParser = parseRuntimeRouteString(record.jsonEventParser ?? record.json_event_parser);
  if (jsonEventParser) {
    strategy.jsonEventParser = jsonEventParser;
  }

  const execCommand = parseRuntimeRouteString(record.execCommand ?? record.exec_command);
  if (execCommand) {
    strategy.execCommand = execCommand;
  }

  const promptStdinArg = parseRuntimeRouteString(record.promptStdinArg ?? record.prompt_stdin_arg);
  if (promptStdinArg) {
    strategy.promptStdinArg = promptStdinArg;
  }

  const resumeArgs = parseRuntimeStringList(record.resumeArgs ?? record.resume_args);
  if (resumeArgs) {
    strategy.resumeArgs = resumeArgs;
  }

  const argsTemplate = parseRuntimeStringList(
    record.argsTemplate ??
      record.args_template ??
      record.resumeArgsTemplate ??
      record.resume_args_template,
  );
  if (argsTemplate) {
    strategy.argsTemplate = argsTemplate;
  }

  const requiredArgs = parseRuntimeStringList(record.requiredArgs ?? record.required_args);
  if (requiredArgs) {
    strategy.requiredArgs = requiredArgs;
  }

  if (type === 'append-continuation-flag') {
    const continuationFlag = parseRuntimeRouteString(record.continuationFlag ?? record.continuation_flag);
    if (!continuationFlag) {
      return null;
    }
    strategy.continuationFlag = continuationFlag;
    const existingContinuationFlags = parseRuntimeStringList(
      record.existingContinuationFlags ?? record.existing_continuation_flags,
    );
    if (existingContinuationFlags) {
      strategy.existingContinuationFlags = existingContinuationFlags;
    }
  }

  if (type === 'argument-template' && !strategy.argsTemplate) {
    return null;
  }

  return strategy;
}

function parseAutocodeCliTaskRunStrategy(value: unknown): AutocodeCliTaskRunStrategy | null {
  const record = asRuntimeRouteRecord(value);
  if (!record) {
    return null;
  }

  const args = parseRuntimeStringList(record.args);
  const modelFlag = parseRuntimeRouteString(record.modelFlag ?? record.model_flag);
  const promptStdinArg = parseRuntimeRouteString(record.promptStdinArg ?? record.prompt_stdin_arg);
  if (!args && !modelFlag && !promptStdinArg) {
    return null;
  }

  return {
    ...(args ? { args } : {}),
    ...(modelFlag ? { modelFlag } : {}),
    ...(promptStdinArg ? { promptStdinArg } : {}),
  };
}

function parseAutocodeCliJsonEventParser(
  value: unknown,
  defaultDisplayName: string,
): AutocodeCliJsonEventParser | null {
  const record = asRuntimeRouteRecord(value);
  if (!record) {
    return null;
  }

  const type = parseRuntimeRouteString(record.type);
  const displayName = parseRuntimeRouteString(record.displayName) ??
    parseRuntimeRouteString(record.display_name) ??
    defaultDisplayName;
  const commandNames = parseRuntimeStringList(record.commandNames ?? record.command_names);
  if (!type || !displayName || !commandNames) {
    return null;
  }

  const parser: AutocodeCliJsonEventParser = {
    type,
    displayName,
    commandNames,
  };

  const requiredArgs = parseRuntimeStringList(record.requiredArgs ?? record.required_args);
  if (requiredArgs) {
    parser.requiredArgs = requiredArgs;
  }

  const payloadFields = parseRuntimeStringList(record.payloadFields ?? record.payload_fields);
  if (payloadFields) {
    parser.payloadFields = payloadFields;
  }

  const eventTypeFields = parseRuntimeStringList(record.eventTypeFields ?? record.event_type_fields);
  if (eventTypeFields) {
    parser.eventTypeFields = eventTypeFields;
  }

  const sessionIdFields = parseRuntimeStringList(record.sessionIdFields ?? record.session_id_fields);
  if (sessionIdFields) {
    parser.sessionIdFields = sessionIdFields;
  }

  const messageFields = parseRuntimeStringList(record.messageFields ?? record.message_fields);
  if (messageFields) {
    parser.messageFields = messageFields;
  }

  const completionEventTypes = parseRuntimeStringList(record.completionEventTypes ?? record.completion_event_types);
  if (completionEventTypes) {
    parser.completionEventTypes = completionEventTypes;
  }

  const listFields = [
    ['ignoredEventTypes', 'ignoredEventTypes', 'ignored_event_types'],
    ['ignoredEventTypeIncludes', 'ignoredEventTypeIncludes', 'ignored_event_type_includes'],
    ['toolStartEventTypes', 'toolStartEventTypes', 'tool_start_event_types'],
    ['toolEndEventTypes', 'toolEndEventTypes', 'tool_end_event_types'],
    ['toolNameFields', 'toolNameFields', 'tool_name_fields'],
    ['toolInputFields', 'toolInputFields', 'tool_input_fields'],
    ['toolOutputFields', 'toolOutputFields', 'tool_output_fields'],
    ['toolCallIdFields', 'toolCallIdFields', 'tool_call_id_fields'],
    ['toolSuccessFields', 'toolSuccessFields', 'tool_success_fields'],
    ['toolExitCodeFields', 'toolExitCodeFields', 'tool_exit_code_fields'],
    ['toolStatusFields', 'toolStatusFields', 'tool_status_fields'],
  ] as const;

  for (const [targetKey, ...sourceKeys] of listFields) {
    const value = parseRuntimeStringList(readFirstRuntimeRouteField(record, sourceKeys));
    if (value) {
      parser[targetKey] = value;
    }
  }

  return parser;
}

function parseRuntimeStringList(value: unknown): string[] | null {
  const single = parseRuntimeRouteString(value);
  if (single) {
    return [single];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value.map(parseRuntimeRouteString).filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : null;
}

function parseRuntimeRouteBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readFirstRuntimeRouteField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function parseRuntimeRouteMatch(value: unknown): AutocodeCliRuntimeRouteMatch | null {
  const single = parseRuntimeRouteString(value);
  if (single) {
    return single;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const matches = value.map(parseRuntimeRouteString).filter((item): item is string => Boolean(item));
  return matches.length > 0 ? matches : null;
}

function parseRuntimeRouteString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringifyRuntimeTemplateValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function isBuiltinAutocodeCli(value: unknown): value is BuiltinAutocodeCli {
  return typeof value === 'string' && BUILTIN_AUTOCODE_CLIS.includes(value as BuiltinAutocodeCli);
}

export function isAutocodeCliIdentifier(value: unknown): value is AutocodeCli {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value.trim());
}

function asRuntimeRouteRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function copyAutocodeCliRuntimeRoute(route: AutocodeCliRuntimeRoute): AutocodeCliRuntimeRoute {
  return {
    ...route,
    condition: copyAutocodeCliRuntimeRouteCondition(route.condition),
    ...(route.permissionBypassArgs ? { permissionBypassArgs: [...route.permissionBypassArgs] } : {}),
    ...(route.taskRunStrategy ? { taskRunStrategy: copyAutocodeCliTaskRunStrategy(route.taskRunStrategy) } : {}),
    ...(route.jsonEventParser
      ? { jsonEventParser: copyAutocodeCliJsonEventParser(route.jsonEventParser) }
      : {}),
    ...(route.continuationStrategy
      ? { continuationStrategy: copyAutocodeCliContinuationStrategy(route.continuationStrategy) }
      : {}),
    ...(route.preflightActions
      ? { preflightActions: route.preflightActions.map(copyAutocodeCliPreflightAction) }
      : {}),
  };
}

function copyAutocodeCliTaskRunStrategy(strategy: AutocodeCliTaskRunStrategy): AutocodeCliTaskRunStrategy {
  return {
    ...strategy,
    ...(strategy.args ? { args: [...strategy.args] } : {}),
  };
}

function copyAutocodeCliJsonEventParser(parser: AutocodeCliJsonEventParser): AutocodeCliJsonEventParser {
  return {
    ...parser,
    commandNames: [...parser.commandNames],
    ...(parser.requiredArgs ? { requiredArgs: [...parser.requiredArgs] } : {}),
    ...(parser.payloadFields ? { payloadFields: [...parser.payloadFields] } : {}),
    ...(parser.eventTypeFields ? { eventTypeFields: [...parser.eventTypeFields] } : {}),
    ...(parser.sessionIdFields ? { sessionIdFields: [...parser.sessionIdFields] } : {}),
    ...(parser.messageFields ? { messageFields: [...parser.messageFields] } : {}),
    ...(parser.completionEventTypes ? { completionEventTypes: [...parser.completionEventTypes] } : {}),
    ...(parser.ignoredEventTypes ? { ignoredEventTypes: [...parser.ignoredEventTypes] } : {}),
    ...(parser.ignoredEventTypeIncludes ? { ignoredEventTypeIncludes: [...parser.ignoredEventTypeIncludes] } : {}),
    ...(parser.toolStartEventTypes ? { toolStartEventTypes: [...parser.toolStartEventTypes] } : {}),
    ...(parser.toolEndEventTypes ? { toolEndEventTypes: [...parser.toolEndEventTypes] } : {}),
    ...(parser.toolNameFields ? { toolNameFields: [...parser.toolNameFields] } : {}),
    ...(parser.toolInputFields ? { toolInputFields: [...parser.toolInputFields] } : {}),
    ...(parser.toolOutputFields ? { toolOutputFields: [...parser.toolOutputFields] } : {}),
    ...(parser.toolCallIdFields ? { toolCallIdFields: [...parser.toolCallIdFields] } : {}),
    ...(parser.toolSuccessFields ? { toolSuccessFields: [...parser.toolSuccessFields] } : {}),
    ...(parser.toolExitCodeFields ? { toolExitCodeFields: [...parser.toolExitCodeFields] } : {}),
    ...(parser.toolStatusFields ? { toolStatusFields: [...parser.toolStatusFields] } : {}),
  };
}

function copyAutocodeCliPreflightAction(action: AutocodeCliPreflightAction): AutocodeCliPreflightAction {
  return {
    ...action,
    ...(action.commandNames ? { commandNames: [...action.commandNames] } : {}),
  };
}

function copyAutocodeCliContinuationStrategy(
  strategy: AutocodeCliContinuationStrategy,
): AutocodeCliContinuationStrategy {
  const copy: AutocodeCliContinuationStrategy = {
    ...strategy,
    commandNames: [...strategy.commandNames],
  };
  if (strategy.resumeArgs) {
    copy.resumeArgs = [...strategy.resumeArgs];
  }
  if (strategy.argsTemplate) {
    copy.argsTemplate = [...strategy.argsTemplate];
  }
  if (strategy.requiredArgs) {
    copy.requiredArgs = [...strategy.requiredArgs];
  }
  if (strategy.existingContinuationFlags) {
    copy.existingContinuationFlags = [...strategy.existingContinuationFlags];
  }
  return copy;
}

function copyAutocodeCliRuntimeRouteCondition(
  condition: AutocodeCliRuntimeRouteCondition,
): AutocodeCliRuntimeRouteCondition {
  return {
    ...(condition.provider ? { provider: copyRuntimeRouteMatch(condition.provider) } : {}),
    ...(condition.providerPrefix ? { providerPrefix: copyRuntimeRouteMatch(condition.providerPrefix) } : {}),
    ...(condition.providerIncludes ? { providerIncludes: copyRuntimeRouteMatch(condition.providerIncludes) } : {}),
    ...(condition.authSource ? { authSource: copyRuntimeRouteMatch(condition.authSource) } : {}),
    ...(condition.authSourcePrefix ? { authSourcePrefix: copyRuntimeRouteMatch(condition.authSourcePrefix) } : {}),
    ...(condition.authSourceIncludes ? { authSourceIncludes: copyRuntimeRouteMatch(condition.authSourceIncludes) } : {}),
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
    && matchesPrefixRouteValue(input.provider, condition.providerPrefix)
    && matchesIncludesRouteValue(input.provider, condition.providerIncludes)
    && matchesExactRouteValue(input.authSource, condition.authSource)
    && matchesPrefixRouteValue(input.authSource, condition.authSourcePrefix)
    && matchesIncludesRouteValue(input.authSource, condition.authSourceIncludes)
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
