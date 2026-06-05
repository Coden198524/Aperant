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
