/**
 * Tool Registry
 * =============
 *
 * Desktop adapter for the shared agent/tool/MCP policy in @autocode/core.
 * Concrete tool implementations and AI SDK tool binding stay in desktop.
 */

import type { Tool as AITool } from 'ai';

import {
  type AgentConfig,
  type AgentType,
  AGENT_CONFIGS,
  BASE_READ_TOOLS,
  BASE_WRITE_TOOLS,
  CONTEXT7_TOOLS,
  DIRECT_TASK_TOOLS,
  ELECTRON_TOOLS,
  GRAPHITI_MCP_TOOLS,
  LINEAR_TOOLS,
  MEMORY_MCP_TOOLS,
  PUPPETEER_TOOLS,
  SPEC_TOOLS,
  TOOL_GET_BUILD_PROGRESS,
  TOOL_GET_SESSION_CONTEXT,
  TOOL_RECORD_DISCOVERY,
  TOOL_RECORD_GOTCHA,
  TOOL_UPDATE_QA_STATUS,
  TOOL_UPDATE_SUBTASK_STATUS,
  WEB_TOOLS,
  getAgentConfig,
  getDefaultThinkingLevel,
  getRequiredMcpServersFromConfig,
  type McpConfig,
  type ProjectCapabilities,
} from '../config/agent-configs';
import type { DefinedTool } from './define';
import type { ToolContext } from './types';

export {
  type AgentConfig,
  type AgentType,
  AGENT_CONFIGS,
  BASE_READ_TOOLS,
  BASE_WRITE_TOOLS,
  CONTEXT7_TOOLS,
  DIRECT_TASK_TOOLS,
  ELECTRON_TOOLS,
  GRAPHITI_MCP_TOOLS,
  LINEAR_TOOLS,
  MEMORY_MCP_TOOLS,
  PUPPETEER_TOOLS,
  SPEC_TOOLS,
  TOOL_GET_BUILD_PROGRESS,
  TOOL_GET_SESSION_CONTEXT,
  TOOL_RECORD_DISCOVERY,
  TOOL_RECORD_GOTCHA,
  TOOL_UPDATE_QA_STATUS,
  TOOL_UPDATE_SUBTASK_STATUS,
  WEB_TOOLS,
  getAgentConfig,
  getDefaultThinkingLevel,
};

export type { McpConfig, ProjectCapabilities };

// =============================================================================
// ToolRegistry
// =============================================================================

/**
 * Registry for AI tools.
 *
 * Manages tool registration and provides agent-type-aware tool resolution
 * using the shared AGENT_CONFIGS mapping.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, DefinedTool>();

  /**
   * Register a tool by name.
   */
  registerTool(name: string, definedTool: DefinedTool): void {
    this.tools.set(name, definedTool);
  }

  /**
   * Get a registered tool by name, or undefined if not found.
   */
  getTool(name: string): DefinedTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tool names.
   */
  getRegisteredNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get the AI SDK tool map for a given agent type, bound to the provided context.
   */
  getToolsForAgent(
    agentType: AgentType,
    context: ToolContext,
  ): Record<string, AITool> {
    const config = getAgentConfig(agentType);
    const allowedNames = new Set([...config.tools, ...config.autoClaudeTools]);
    const hasSubagentExecutor = Boolean(
      (context as ToolContext & { subagentExecutor?: unknown }).subagentExecutor,
    );
    const result: Record<string, AITool> = {};

    for (const [name, definedTool] of Array.from(this.tools.entries())) {
      if (name === 'SpawnSubagent' && !hasSubagentExecutor) {
        continue;
      }
      if (allowedNames.has(name)) {
        result[name] = definedTool.bind(context);
      }
    }

    return result;
  }
}

/**
 * Get MCP servers required for an agent type from desktop-style MCP settings.
 */
export function getRequiredMcpServers(
  agentType: AgentType,
  options: {
    projectCapabilities?: ProjectCapabilities;
    linearEnabled?: boolean;
    yunxiaoEnabled?: boolean;
    memoryEnabled?: boolean;
    /** @deprecated Use memoryEnabled instead. */
    graphitiEnabled?: boolean;
    mcpConfig?: McpConfig;
  } = {},
): string[] {
  return getRequiredMcpServersFromConfig(agentType, options);
}
