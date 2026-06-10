import path from 'path';
import {
  getAutocodeMcpServerConfig,
  resolveAutocodeMcpServers,
  type AutocodeMcpRegistryOptions,
  type AutocodeMcpServerConfig,
  type AutocodeMcpServerId,
} from '@autocode/core/tools/mcp-registry';

export interface McpRegistryOptions extends AutocodeMcpRegistryOptions {}

export function getMcpServerConfig(
  serverId: McpServerId | string,
  options: McpRegistryOptions = {},
): McpServerConfig | null {
  return getAutocodeMcpServerConfig(serverId, withDesktopMcpDefaults(options));
}

export function resolveMcpServers(
  serverIds: string[],
  options: McpRegistryOptions = {},
): McpServerConfig[] {
  return resolveAutocodeMcpServers(serverIds, withDesktopMcpDefaults(options));
}

function withDesktopMcpDefaults(options: McpRegistryOptions): McpRegistryOptions {
  if (options.yunxiaoNpmCache || options.env?.YUNXIAO_MCP_NPM_CACHE) {
    return options;
  }

  return {
    ...options,
    yunxiaoNpmCache: path.join(
      process.env.LOCALAPPDATA || process.env.TEMP || process.cwd(),
      'Autocode',
      'mcp-cache',
      'yunxiao-npm',
    ),
  };
}

export type McpServerConfig = AutocodeMcpServerConfig;
export type McpServerId = AutocodeMcpServerId;
