export const AUTOCODE_BUILTIN_MCP_SERVER_IDS = [
  'context7',
  'linear',
  'yunxiao',
  'memory',
  'electron',
  'puppeteer',
  'autocode',
] as const;

export type AutocodeBuiltinMcpServerId = (typeof AUTOCODE_BUILTIN_MCP_SERVER_IDS)[number];

export const AUTOCODE_SAFE_CUSTOM_MCP_COMMANDS = [
  'npx',
  'npm',
  'node',
  'python',
  'python3',
  'uv',
  'uvx',
] as const;

export const AUTOCODE_DANGEROUS_CUSTOM_MCP_FLAGS = [
  '--eval',
  '-e',
  '-c',
  '--exec',
  '-m',
  '-p',
  '--print',
  '--input-type=module',
  '--experimental-loader',
  '--require',
  '-r',
] as const;

export const AUTOCODE_SHELL_METACHARACTERS = [
  '&',
  '|',
  '>',
  '<',
  '^',
  '%',
  ';',
  '$',
  '`',
  '\n',
  '\r',
] as const;

export const AUTOCODE_DEFAULT_YUNXIAO_MCP_ARGS = [
  '-y',
  'alibabacloud-devops-mcp-server',
] as const;

const BUILTIN_SERVER_IDS = new Set<string>(AUTOCODE_BUILTIN_MCP_SERVER_IDS);
const SAFE_COMMANDS = new Set<string>(AUTOCODE_SAFE_CUSTOM_MCP_COMMANDS);
const DANGEROUS_FLAGS = new Set<string>(AUTOCODE_DANGEROUS_CUSTOM_MCP_FLAGS);
const SHELL_METACHARACTERS = new Set<string>(AUTOCODE_SHELL_METACHARACTERS);

export interface AutocodeCustomMcpServerDefinition {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export interface AutocodeNormalizedCustomMcpServer {
  id: string;
  name: string;
  description?: string;
  transport:
    | {
        type: 'stdio';
        command: string;
        args: string[];
      }
    | {
        type: 'streamable-http';
        url: string;
        headers?: Record<string, string>;
      };
}

export interface AutocodeMcpArgSafetyOptions {
  rejectShellMetacharacters?: boolean;
}

export type AutocodeMcpTransportType = 'stdio' | 'streamable-http';

export interface AutocodeStdioTransportConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface AutocodeStreamableHttpTransportConfig {
  type: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
}

export type AutocodeMcpTransportConfig =
  | AutocodeStdioTransportConfig
  | AutocodeStreamableHttpTransportConfig;

export type AutocodeMcpServerId = AutocodeBuiltinMcpServerId;

export interface AutocodeMcpServerConfig {
  id: AutocodeMcpServerId | string;
  name: string;
  transport: AutocodeMcpTransportConfig;
  enabledByDefault: boolean;
  description?: string;
}

export interface AutocodeMcpClientOptions {
  server: AutocodeMcpServerConfig;
  timeoutMs?: number;
  onError?: (error: Error) => void;
}

export interface AutocodeMcpClientResult {
  serverId: string;
  tools: Record<string, unknown>;
  close: () => Promise<void>;
}

export interface AutocodeMcpRegistryOptions {
  specDir?: string;
  memoryMcpUrl?: string;
  linearApiKey?: string;
  yunxiaoAccessToken?: string;
  yunxiaoNpmCache?: string;
  env?: Record<string, string | undefined>;
  customServers?: AutocodeCustomMcpServerDefinition[];
}

export function isAutocodeBuiltinMcpServerId(serverId: string): serverId is AutocodeBuiltinMcpServerId {
  return BUILTIN_SERVER_IDS.has(serverId);
}

export function isAutocodeCustomMcpCommandSafe(command: string | undefined): boolean {
  if (!command) return false;
  if (command.includes('/') || command.includes('\\')) return false;
  return SAFE_COMMANDS.has(command);
}

export function areAutocodeCustomMcpArgsSafe(
  args: string[] | undefined,
  options: AutocodeMcpArgSafetyOptions = {},
): boolean {
  if (!args || args.length === 0) return true;
  if (args.some((arg) => DANGEROUS_FLAGS.has(arg))) {
    return false;
  }
  if (options.rejectShellMetacharacters) {
    return !args.some((arg) => [...SHELL_METACHARACTERS].some((char) => arg.includes(char)));
  }
  return true;
}

export function normalizeAutocodeCustomMcpServer(
  server: AutocodeCustomMcpServerDefinition,
): AutocodeNormalizedCustomMcpServer | null {
  const id = server.id?.trim();
  if (!id || isAutocodeBuiltinMcpServerId(id)) {
    return null;
  }

  const name = server.name?.trim() || id;
  if (server.type === 'command') {
    const command = server.command?.trim();
    const args = server.args ?? [];
    if (!command || !isAutocodeCustomMcpCommandSafe(command) || !areAutocodeCustomMcpArgsSafe(args)) {
      return null;
    }
    return {
      id,
      name,
      description: server.description,
      transport: {
        type: 'stdio',
        command,
        args,
      },
    };
  }

  const url = server.url?.trim();
  if (!url) {
    return null;
  }

  return {
    id,
    name,
    description: server.description,
    transport: {
      type: 'streamable-http',
      url,
      headers: server.headers,
    },
  };
}

export function parseAutocodeYunxiaoMcpArgs(raw?: string): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [...AUTOCODE_DEFAULT_YUNXIAO_MCP_ARGS];

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        const args = parsed.map((item) => String(item).trim()).filter(Boolean);
        if (args.length > 0) return args;
      }
    } catch {
      // Fallback to whitespace splitting.
    }
  }

  const args = trimmed.split(/\s+/).filter(Boolean);
  return args.length > 0 ? args : [...AUTOCODE_DEFAULT_YUNXIAO_MCP_ARGS];
}

function createAutocodeCustomServer(
  server: AutocodeCustomMcpServerDefinition,
  env?: Record<string, string | undefined>,
): AutocodeMcpServerConfig | null {
  const normalized = normalizeAutocodeCustomMcpServer(server);
  if (!normalized) {
    return null;
  }

  if (normalized.transport.type === 'stdio') {
    return {
      id: normalized.id,
      name: normalized.name,
      description: normalized.description,
      enabledByDefault: false,
      transport: {
        type: 'stdio',
        command: normalized.transport.command,
        args: normalized.transport.args,
        env: env && Object.keys(env).length > 0
          ? compactStringRecord(env)
          : undefined,
      },
    };
  }

  return {
    id: normalized.id,
    name: normalized.name,
    description: normalized.description,
    enabledByDefault: false,
    transport: {
      type: 'streamable-http',
      url: normalized.transport.url,
      headers: normalized.transport.headers,
    },
  };
}

const CONTEXT7_SERVER: AutocodeMcpServerConfig = {
  id: 'context7',
  name: 'Context7',
  description: 'Documentation lookup for libraries and frameworks',
  enabledByDefault: true,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
  },
};

const LINEAR_SERVER: AutocodeMcpServerConfig = {
  id: 'linear',
  name: 'Linear',
  description: 'Project management integration for issues and tasks',
  enabledByDefault: false,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@linear/mcp-server'],
  },
};

const YUNXIAO_SERVER: AutocodeMcpServerConfig = {
  id: 'yunxiao',
  name: 'Yunxiao',
  description: 'Alibaba Cloud DevOps work item and project integration',
  enabledByDefault: false,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: [...AUTOCODE_DEFAULT_YUNXIAO_MCP_ARGS],
  },
};
const YUNXIAO_DEFAULT_MCP_COMMAND = 'npx';

const ELECTRON_SERVER: AutocodeMcpServerConfig = {
  id: 'electron',
  name: 'Electron',
  description: 'Desktop app automation via Chrome DevTools Protocol',
  enabledByDefault: false,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'electron-mcp-server'],
  },
};

const PUPPETEER_SERVER: AutocodeMcpServerConfig = {
  id: 'puppeteer',
  name: 'Puppeteer',
  description: 'Web browser automation for frontend validation',
  enabledByDefault: false,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic-ai/puppeteer-mcp-server'],
  },
};

function createAutocodeMemoryServer(url: string): AutocodeMcpServerConfig {
  return {
    id: 'memory',
    name: 'Memory',
    description: 'Knowledge graph memory for cross-session insights',
    enabledByDefault: false,
    transport: {
      type: 'streamable-http',
      url,
    },
  };
}

function createAutocodeServer(specDir: string): AutocodeMcpServerConfig {
  return {
    id: 'autocode',
    name: 'Autocode',
    description: 'Build management tools (progress tracking, session context)',
    enabledByDefault: true,
    transport: {
      type: 'stdio',
      command: 'node',
      args: ['autocode-mcp-server.js'],
      env: { SPEC_DIR: specDir },
    },
  };
}

export function getAutocodeMcpServerConfig(
  serverId: AutocodeMcpServerId | string,
  options: AutocodeMcpRegistryOptions = {},
): AutocodeMcpServerConfig | null {
  if (typeof serverId === 'string' && !isAutocodeBuiltinMcpServerId(serverId)) {
    const custom = options.customServers?.find((server) => server.id === serverId);
    if (custom) {
      return createAutocodeCustomServer(custom, options.env);
    }
  }

  switch (serverId) {
    case 'context7':
      return CONTEXT7_SERVER;

    case 'linear': {
      const apiKey = options.linearApiKey ?? options.env?.LINEAR_API_KEY;
      if (!apiKey) return null;
      return {
        ...LINEAR_SERVER,
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@linear/mcp-server'],
          env: { LINEAR_API_KEY: apiKey },
        },
      };
    }

    case 'yunxiao': {
      const accessToken = options.yunxiaoAccessToken ?? options.env?.YUNXIAO_ACCESS_TOKEN;
      if (!accessToken) return null;

      const command = options.env?.YUNXIAO_MCP_COMMAND?.trim()
        || YUNXIAO_DEFAULT_MCP_COMMAND;
      const args = parseAutocodeYunxiaoMcpArgs(options.env?.YUNXIAO_MCP_ARGS);
      const npmCache = options.env?.YUNXIAO_MCP_NPM_CACHE || options.yunxiaoNpmCache;
      const injectedEnv: Record<string, string> = {
        YUNXIAO_ACCESS_TOKEN: accessToken,
      };

      if (npmCache) {
        injectedEnv.npm_config_cache = npmCache;
        injectedEnv.NPM_CONFIG_CACHE = npmCache;
      }
      copyEnvValue(options.env, injectedEnv, 'DEVOPS_TOOLSETS');
      copyEnvValue(options.env, injectedEnv, 'YUNXIAO_ORGANIZATION_ID');
      copyEnvValue(options.env, injectedEnv, 'YUNXIAO_PROJECT_ID');
      copyEnvValue(options.env, injectedEnv, 'YUNXIAO_WORKITEM_CATEGORY');

      return {
        ...YUNXIAO_SERVER,
        transport: {
          type: 'stdio',
          command,
          args,
          env: injectedEnv,
        },
      };
    }

    case 'memory': {
      const url = options.memoryMcpUrl ?? options.env?.GRAPHITI_MCP_URL;
      return url ? createAutocodeMemoryServer(url) : null;
    }

    case 'electron':
      return ELECTRON_SERVER;

    case 'puppeteer':
      return PUPPETEER_SERVER;

    case 'autocode':
      return createAutocodeServer(options.specDir ?? '');

    default:
      return null;
  }
}

export function resolveAutocodeMcpServers(
  serverIds: string[],
  options: AutocodeMcpRegistryOptions = {},
): AutocodeMcpServerConfig[] {
  return serverIds
    .map((id) => getAutocodeMcpServerConfig(id, options))
    .filter((config): config is AutocodeMcpServerConfig => Boolean(config));
}

function copyEnvValue(
  source: Record<string, string | undefined> | undefined,
  target: Record<string, string>,
  key: string,
): void {
  const value = source?.[key];
  if (value) {
    target[key] = value;
  }
}

function compactStringRecord(record: Record<string, string | undefined>): Record<string, string> {
  const compact: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      compact[key] = value;
    }
  }
  return compact;
}
