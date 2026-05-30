/**
 * Tool Types
 * ==========
 *
 * Core type definitions for the AI tool system.
 * Defines tool context, permissions, and execution options.
 */

import type { z } from 'zod/v3';
import type {
  AutocodeRuntimeFileWriteLockInput,
  ToolMetadata as CoreToolMetadata,
  ToolPolicyContext as CoreToolPolicyContext,
  ToolUsageLimits as CoreToolUsageLimits,
  ToolUsageState as CoreToolUsageState,
} from '@autocode/core';

import type { SecurityProfile } from '../security/bash-validator';
import type { FileContentCache } from './cache/file-cache';
import type { TaskWorkflowMode } from '../../../shared/types';

export {
  DEFAULT_EXECUTION_OPTIONS,
  ToolPermission,
} from '@autocode/core';

export type {
  ToolExecutionOptions,
  ToolMetadata,
  ToolPermission as ToolPermissionType,
  ToolPolicyContext,
  ToolUsageLimits,
  ToolUsagePolicyContext,
  ToolUsageState,
  ToolWritePathPolicyContext,
} from '@autocode/core';

// ---------------------------------------------------------------------------
// Tool Context
// ---------------------------------------------------------------------------

/**
 * Runtime context passed to every tool execution.
 * Provides filesystem paths and security profile for the current agent session.
 */
export interface ToolContext extends CoreToolPolicyContext {
  /** Current working directory for the agent */
  cwd: string;
  /** Root directory of the project being worked on */
  projectDir: string;
  /** Additional filesystem roots the tool may access alongside projectDir */
  allowedPathRoots?: string[];
  /** Spec directory for the current task (e.g., .autocode/specs/001-feature/) */
  specDir: string;
  /** Security profile governing command allowlists */
  securityProfile: SecurityProfile;
  /** Optional abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** If set, Write/Edit tools can only write within these directories */
  allowedWritePaths?: string[];
  /** Optional file content cache for session-scoped caching */
  fileCache?: FileContentCache;
  /** Current task workflow mode, used for mode-specific tool behavior */
  workflowMode?: TaskWorkflowMode;
  /** Session-scoped accounting used to prevent wasteful repeated read/search tool loops */
  toolUsageState?: CoreToolUsageState;
  /** Optional per-session overrides for generic tool usage limits */
  toolUsageLimits?: CoreToolUsageLimits;
  /** Optional cross-runtime file write lock policy for mutating tools */
  fileWriteLock?: Partial<AutocodeRuntimeFileWriteLockInput> & {
    enabled?: boolean;
  };
}

/**
 * Configuration passed to Tool.define() to create a tool.
 *
 * @typeParam TInput - Zod schema type for the tool's input
 * @typeParam TOutput - Return type of the execute function
 */
export interface ToolDefinitionConfig<
  TInput extends z.ZodType = z.ZodType,
  TOutput = unknown,
> {
  /** Tool metadata */
  metadata: CoreToolMetadata;
  /** Zod v3 schema for input validation */
  inputSchema: TInput;
  /** Execute function called with validated input and tool context */
  execute: (
    input: z.infer<TInput>,
    context: ToolContext,
  ) => Promise<TOutput> | TOutput;
}
