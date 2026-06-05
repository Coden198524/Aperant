/**
 * SubagentExecutor
 * ================
 *
 * Implements the SubagentExecutor interface from spawn-subagent.ts.
 * Runs nested generateText() sessions for specialist subagents.
 *
 * Key design decisions:
 * - Uses generateText() (not streamText()) because subagent output goes back to
 *   the orchestrator's context, not to the UI stream.
 * - Subagents get their own tool set from AGENT_CONFIGS (excluding SpawnSubagent).
 * - Inherits allowedWritePaths from parent context for write containment.
 * - Step budget is capped at SUBAGENT_MAX_STEPS (default 100).
 */

import { generateText, Output, stepCountIs } from 'ai';
import type { LanguageModel, Tool as AITool } from 'ai';

import type { SubagentExecutor, SubagentSpawnParams, SubagentResult } from '../tools/builtin/spawn-subagent';
import type { ToolContext } from '../tools/types';
import type { ToolRegistry } from '../tools/registry';
import { getAgentConfig } from '../config/agent-configs';
import { ComplexityAssessmentOutputSchema } from '../schema/output/complexity-assessment.output';
import {
  AUTOCODE_SUBAGENT_MAX_STEPS,
  buildAutocodeSubagentUserMessage,
  resolveAutocodeSubagentAgentType,
  resolveAutocodeSubagentPromptName,
  shouldAutocodeSubagentUseStructuredOutput,
} from '@autocode/core/runtime/subagent-plan';

// ---------------------------------------------------------------------------
// SubagentExecutorConfig
// ---------------------------------------------------------------------------

export interface SubagentExecutorConfig {
  /** Language model for subagent sessions */
  model: LanguageModel;
  /** Tool registry containing all builtin tools */
  registry: ToolRegistry;
  /** Base tool context (cwd, projectDir, specDir, securityProfile) */
  baseToolContext: ToolContext;
  /** Function to load and assemble a system prompt for a given prompt name */
  loadPrompt: (promptName: string) => Promise<string>;
  /** Abort signal from the parent orchestrator */
  abortSignal?: AbortSignal;
  /** Optional callback for subagent stream events */
  onSubagentEvent?: (agentType: string, event: string) => void;
}

// ---------------------------------------------------------------------------
// SubagentExecutorImpl
// ---------------------------------------------------------------------------

/**
 * SubagentExecutorImpl — runs nested generateText() sessions for specialist subagents.
 */
export class SubagentExecutorImpl implements SubagentExecutor {
  private readonly config: SubagentExecutorConfig;

  constructor(config: SubagentExecutorConfig) {
    this.config = config;
  }

  async spawn(params: SubagentSpawnParams): Promise<SubagentResult> {
    const startTime = Date.now();
    const agentType = resolveAutocodeSubagentAgentType(params.agentType);
    const promptName = resolveAutocodeSubagentPromptName(params.agentType);

    this.config.onSubagentEvent?.(params.agentType, 'spawning');

    try {
      // 1. Load system prompt for the subagent
      const systemPrompt = await this.config.loadPrompt(promptName);

      // 2. Build tool set — exclude SpawnSubagent to prevent recursion
      const subagentToolContext: ToolContext = {
        ...this.config.baseToolContext,
        abortSignal: this.config.abortSignal,
      };

      const tools: Record<string, AITool> = {};
      const agentConfig = getAgentConfig(agentType);
      for (const toolName of agentConfig.tools) {
        if (toolName === 'SpawnSubagent') continue; // No recursion
        const definedTool = this.config.registry.getTool(toolName);
        if (definedTool) {
          tools[toolName] = definedTool.bind(subagentToolContext);
        }
      }

      // 3. Build the user message with task + context
      const userMessage = buildAutocodeSubagentUserMessage({
        task: params.task,
        context: params.context,
      });

      // 4. Determine if we should use structured output
      const outputSchema = params.expectStructuredOutput &&
        shouldAutocodeSubagentUseStructuredOutput(params.agentType)
        ? ComplexityAssessmentOutputSchema
        : undefined;

      // 5. Run generateText() with the subagent configuration
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generateText overloads don't resolve with conditional output spread
      const generateOptions: any = {
        model: this.config.model,
        system: systemPrompt,
        messages: [{ role: 'user' as const, content: userMessage }],
        tools,
        stopWhen: stepCountIs(AUTOCODE_SUBAGENT_MAX_STEPS),
        abortSignal: this.config.abortSignal,
        ...(outputSchema
          ? { output: Output.object({ schema: outputSchema }) }
          : {}),
      };

      const result = await generateText(generateOptions);

      this.config.onSubagentEvent?.(params.agentType, 'completed');

      // 6. Extract results
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- result.output type varies with OUTPUT generic
      const resultAny = result as any;
      const structuredOutput =
        outputSchema && resultAny.output != null
          ? (resultAny.output as Record<string, unknown>)
          : undefined;

      return {
        text: result.text || undefined,
        structuredOutput,
        stepsExecuted: result.steps?.length ?? 1,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      this.config.onSubagentEvent?.(params.agentType, 'failed');
      const message = error instanceof Error ? error.message : String(error);
      return {
        error: message,
        stepsExecuted: 0,
        durationMs: Date.now() - startTime,
      };
    }
  }
}
