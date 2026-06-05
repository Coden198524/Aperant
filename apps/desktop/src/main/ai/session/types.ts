import type { LanguageModel } from 'ai';
import type { ZodSchema } from 'zod';

import type {
  AutocodeSessionMessage as SessionMessage,
} from '@autocode/core/runtime/agent-session-types';
import type {
  ModelShorthand,
  Phase,
  SupportedProvider,
  ThinkingLevel,
} from '@autocode/core';
import type { AgentType } from '../config/agent-configs';
import type { McpClientResult } from '../mcp/types';
import type { ToolContext } from '../tools/types';

export type {
  AutocodeErrorEvent as ErrorEvent,
  AutocodeProgressState as ProgressState,
  AutocodeSessionError as SessionError,
  AutocodeSessionEventCallback as SessionEventCallback,
  AutocodeSessionMessage as SessionMessage,
  AutocodeSessionMessageRole as MessageRole,
  AutocodeSessionOutcome as SessionOutcome,
  AutocodeSessionResult as SessionResult,
  AutocodeStepFinishEvent as StepFinishEvent,
  AutocodeStreamEvent as StreamEvent,
  AutocodeTextDeltaEvent as TextDeltaEvent,
  AutocodeThinkingDeltaEvent as ThinkingDeltaEvent,
  AutocodeTokenUsage as TokenUsage,
  AutocodeToolCallEvent as ToolCallEvent,
  AutocodeToolResultEvent as ToolResultEvent,
  AutocodeUsageUpdateEvent as UsageUpdateEvent,
} from '@autocode/core/runtime/agent-session-types';

export interface SessionConfig {
  agentType: AgentType;
  model: LanguageModel;
  systemPrompt: string;
  initialMessages: SessionMessage[];
  toolContext: ToolContext;
  maxSteps: number;
  thinkingLevel?: ThinkingLevel;
  abortSignal?: AbortSignal;
  mcpClients?: McpClientResult[];
  specDir: string;
  projectDir: string;
  phase?: Phase;
  modelShorthand?: ModelShorthand;
  sessionNumber?: number;
  subtaskId?: string;
  provider?: SupportedProvider;
  contextWindowLimit?: number;
  responsePersistence?: boolean;
  outputSchema?: ZodSchema;
}
