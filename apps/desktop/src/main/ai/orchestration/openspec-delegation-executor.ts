import type { LanguageModel, Tool as AITool } from 'ai';
import {
  appendAutocodeLanguageRequirement,
  type AutocodeOutputLanguage,
} from '@autocode/core/runtime/agent-language';

import { appendOpenSpecAutomaticDecisionRequirement } from '../agent/openspec-auto-answer';
import { runAgentSession } from '../session/runner';
import type { RunnerOptions } from '../session/runner';
import type {
  SessionConfig,
  SessionError,
  SessionResult,
  StreamEvent,
} from '../session/types';
import type { ToolRegistry } from '../tools/registry';
import type {
  OpenSpecDelegationInput,
  ToolContext,
} from '../tools/types';

type OpenSpecDelegatedSessionRunner = (
  config: SessionConfig,
  options?: RunnerOptions,
) => Promise<SessionResult>;

export interface OpenSpecDelegationExecutorConfig {
  model: LanguageModel;
  registry: ToolRegistry;
  baseToolContext: ToolContext;
  syncSystemPrompt: string;
  language?: AutocodeOutputLanguage;
  maxSteps: number;
  thinkingLevel?: SessionConfig['thinkingLevel'];
  provider?: SessionConfig['provider'];
  providerTransport?: SessionConfig['providerTransport'];
  providerModelInvocationRoutes?: SessionConfig['providerModelInvocationRoutes'];
  contextWindowLimit?: number;
  abortSignal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  onAuthRefresh?: RunnerOptions['onAuthRefresh'];
  onModelRefresh?: RunnerOptions['onModelRefresh'];
  onProviderFailureFallback?: (input: {
    action: 'sync';
    systemPrompt: string;
    userMessage: string;
    readOnly: boolean;
    sessionError: SessionError;
  }) => Promise<SessionResult | null>;
  runSession?: OpenSpecDelegatedSessionRunner;
}

export function failSessionForOpenSpecDelegation(
  result: SessionResult,
  error: Error,
): SessionResult {
  return {
    ...result,
    outcome: 'error',
    error: {
      code: 'openspec_delegation_failed',
      message: error.message,
      retryable: false,
    },
  };
}

/**
 * Executes the `Task(general-purpose, ...)` call used by the official Archive
 * Action as a genuinely separate OpenSpec model session.
 *
 * It deliberately does not use Aperant's Standard subagent configuration,
 * prompt loader, MCP clients, memory service, or response continuation state.
 */
export class OpenSpecDelegationExecutor {
  private readonly config: OpenSpecDelegationExecutorConfig;

  constructor(config: OpenSpecDelegationExecutorConfig) {
    this.config = config;
  }

  async run(input: OpenSpecDelegationInput): Promise<string> {
    if (input.action !== 'sync') {
      throw new Error(`Unsupported OpenSpec delegated action "${input.action}".`);
    }
    if (!this.config.syncSystemPrompt) {
      throw new Error(
        'The pinned official OpenSpec Sync prompt is unavailable; Archive cannot continue.',
      );
    }

    const childToolContext: ToolContext = {
      ...this.config.baseToolContext,
      abortSignal: this.config.abortSignal,
      runOpenSpecDelegation: undefined,
    };
    const tools: Record<string, AITool> = {
      ...this.config.registry.getToolsForAgent('openspec', childToolContext),
    };

    // Official Archive may delegate Sync once, but the Sync child must never
    // be able to delegate again or enter either generic subagent pipeline.
    delete tools.Task;
    delete tools.SpawnSubagent;
    if (childToolContext.readOnlySession) {
      delete tools.Write;
      delete tools.Edit;
    }
    const localizedUserPrompt = appendOpenSpecAutomaticDecisionRequirement(
      appendAutocodeLanguageRequirement(
        input.prompt,
        this.config.language,
      ),
      this.config.language,
    );

    const sessionConfig: SessionConfig = {
      agentType: 'openspec',
      model: this.config.model,
      // Keep the pinned official prompt byte-identical. Output language is a
      // user-level preference and belongs only on the delegated request.
      systemPrompt: this.config.syncSystemPrompt,
      initialMessages: [{
        role: 'user',
        content: localizedUserPrompt,
      }],
      toolContext: childToolContext,
      maxSteps: this.config.maxSteps,
      thinkingLevel: this.config.thinkingLevel,
      abortSignal: this.config.abortSignal,
      specDir: childToolContext.specDir,
      projectDir: childToolContext.projectDir,
      phase: 'planning',
      provider: this.config.provider,
      providerTransport: this.config.providerTransport,
      providerModelInvocationRoutes: this.config.providerModelInvocationRoutes,
      contextWindowLimit: this.config.contextWindowLimit,
    };
    const providerFailureFallback = this.config.onProviderFailureFallback;

    const result = await (this.config.runSession ?? runAgentSession)(
      sessionConfig,
      {
        tools,
        onEvent: this.config.onEvent,
        onAuthRefresh: this.config.onAuthRefresh,
        onModelRefresh: this.config.onModelRefresh,
        ...(providerFailureFallback
          ? {
              onProviderFailureFallback: ({ sessionError }) =>
                providerFailureFallback({
                  action: 'sync',
                  systemPrompt: this.config.syncSystemPrompt,
                  userMessage: localizedUserPrompt,
                  readOnly: childToolContext.readOnlySession === true,
                  sessionError,
                }),
            }
          : {}),
      },
    );

    if (result.outcome !== 'completed') {
      const detail = result.error?.message
        ? `: ${result.error.message}`
        : '';
      throw new Error(
        `OpenSpec Sync delegation ended with outcome "${result.outcome}"${detail}`,
      );
    }

    return getLastAssistantText(result)
      ?? 'OpenSpec Sync delegation completed successfully.';
  }
}

function getLastAssistantText(result: SessionResult): string | undefined {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (
      message?.role === 'assistant'
      && typeof message.content === 'string'
      && message.content.trim()
    ) {
      return message.content;
    }
  }
  return undefined;
}
