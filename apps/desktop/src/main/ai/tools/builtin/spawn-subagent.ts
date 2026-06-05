/**
 * SpawnSubagent Tool
 * ==================
 *
 * Allows orchestrator agents (spec_orchestrator, build_orchestrator) to spawn
 * nested specialist agent sessions within their own streamText() loop.
 *
 * Subagents CANNOT access this tool (no recursion).
 * The tool delegates to a SubagentExecutor provided via the ToolContext's
 * subagentExecutor property. If no executor is available, returns a graceful
 * error (for non-agentic sessions).
 */

import { z } from 'zod/v3';

import {
  AUTOCODE_SPAWN_SUBAGENT_TOOL_DESCRIPTION,
  AUTOCODE_SPAWN_SUBAGENT_UNAVAILABLE_MESSAGE,
  AUTOCODE_SUBAGENT_TYPES,
  formatAutocodeSubagentToolResult,
} from '@autocode/core/runtime/subagent-plan';
import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';
import type { ToolContext } from '../types';

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const SpawnSubagentInputSchema = z.object({
  agent_type: z
    .enum(AUTOCODE_SUBAGENT_TYPES)
    .describe('The type of specialist subagent to spawn'),
  task: z.string().describe('Clear description of what the subagent should accomplish'),
  context: z
    .string()
    .nullable()
    .describe(
      'Additional context to pass to the subagent (accumulated findings, prior outputs, etc.)',
    ),
  expect_structured_output: z
    .boolean()
    .describe('Whether to expect structured JSON output from the subagent'),
});

export type SpawnSubagentInput = z.infer<typeof SpawnSubagentInputSchema>;

// ---------------------------------------------------------------------------
// SubagentExecutor Interface
// ---------------------------------------------------------------------------

/**
 * Interface for the SubagentExecutor that the tool delegates to.
 * Implemented in orchestration/subagent-executor.ts.
 */
export interface SubagentExecutor {
  spawn(params: SubagentSpawnParams): Promise<SubagentResult>;
}

export interface SubagentSpawnParams {
  agentType: string;
  task: string;
  context?: string;
  expectStructuredOutput: boolean;
}

export interface SubagentResult {
  text?: string;
  structuredOutput?: Record<string, unknown>;
  error?: string;
  stepsExecuted: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

/**
 * SpawnSubagent tool 鈥?allows orchestrator agents to spawn nested specialist agent sessions.
 *
 * Only available to orchestrator agent types (spec_orchestrator, build_orchestrator).
 * Subagents CANNOT access this tool (no recursion).
 *
 * The tool delegates to a SubagentExecutor provided via the ToolContext's
 * subagentExecutor property. If no executor is available, the tool returns
 * an error message (graceful degradation for non-agentic sessions).
 */
export const spawnSubagentTool = Tool.define({
  metadata: {
    name: 'SpawnSubagent',
    description: AUTOCODE_SPAWN_SUBAGENT_TOOL_DESCRIPTION,
    permission: ToolPermission.Auto,
    executionOptions: {
      ...DEFAULT_EXECUTION_OPTIONS,
      timeoutMs: 600_000, // 10 minutes 鈥?subagents can take a while
    },
  },
  inputSchema: SpawnSubagentInputSchema,
  execute: async (input: SpawnSubagentInput, context: ToolContext): Promise<string> => {
    // Access the SubagentExecutor from the tool context via extension cast
    const executor = (context as ToolContext & { subagentExecutor?: SubagentExecutor })
      .subagentExecutor;

    if (!executor) {
      return AUTOCODE_SPAWN_SUBAGENT_UNAVAILABLE_MESSAGE;
    }

    try {
      const result = await executor.spawn({
        agentType: input.agent_type,
        task: input.task,
        context: input.context ?? undefined,
        expectStructuredOutput: input.expect_structured_output,
      });

      if (result.error) {
        return formatAutocodeSubagentToolResult({
          agentType: input.agent_type,
          error: result.error,
        });
      }

      return formatAutocodeSubagentToolResult({
        agentType: input.agent_type,
        text: result.text,
        structuredOutput: result.structuredOutput,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Subagent (${input.agent_type}) execution error: ${message}`;
    }
  },
});
