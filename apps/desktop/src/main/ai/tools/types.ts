/**
 * Tool Types
 * ==========
 *
 * Core type definitions for the AI tool system.
 * Defines tool context, permissions, and execution options.
 */

import type { z } from 'zod/v3';

import type { SecurityProfile } from '../security/bash-validator';
import type { FileContentCache } from './cache/file-cache';
import type { TaskWorkflowMode } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Tool Context
// ---------------------------------------------------------------------------

/**
 * Runtime context passed to every tool execution.
 * Provides filesystem paths and security profile for the current agent session.
 */
export interface ToolContext {
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
  toolUsageState?: ToolUsageState;
  /** Optional per-session overrides for generic tool usage limits */
  toolUsageLimits?: ToolUsageLimits;
}

/**
 * Session-scoped tool usage counters. This is intentionally lightweight and
 * lives on ToolContext so copied tool contexts can share the same counters.
 */
export interface ToolUsageState {
  totalCalls: number;
  toolCalls: Record<string, number>;
  readOnlySignatureCalls: Record<string, number>;
}

export interface ToolUsageLimits {
  /** Per-tool call caps for read-only exploration tools. */
  readOnlyToolCallLimits?: Record<string, number>;
  /** Max times an identical read/search call may be repeated before it is skipped. */
  maxDuplicateReadOnlyCalls?: number;
}

// ---------------------------------------------------------------------------
// Tool Permissions
// ---------------------------------------------------------------------------

/**
 * Permission level for a tool.
 * Controls whether the tool requires user approval before execution.
 */
export const ToolPermission = {
  /** Tool runs without any approval */
  Auto: 'auto',
  /** Tool requires user approval before each execution */
  RequiresApproval: 'requires_approval',
  /** Tool is read-only and safe to run automatically */
  ReadOnly: 'read_only',
} as const;

export type ToolPermission = (typeof ToolPermission)[keyof typeof ToolPermission];

// ---------------------------------------------------------------------------
// Tool Execution Options
// ---------------------------------------------------------------------------

/**
 * Options controlling how a tool executes.
 */
export interface ToolExecutionOptions {
  /** Timeout in milliseconds (0 = no timeout) */
  timeoutMs: number;
  /** Whether the tool can run in the background */
  allowBackground: boolean;
}

/** Default execution options */
export const DEFAULT_EXECUTION_OPTIONS: ToolExecutionOptions = {
  timeoutMs: 120_000,
  allowBackground: false,
};

// ---------------------------------------------------------------------------
// Tool Definition Shape
// ---------------------------------------------------------------------------

/**
 * Metadata for a defined tool, used by the registry and define wrapper.
 */
export interface ToolMetadata {
  /** Unique tool name (e.g., 'Read', 'Bash', 'Glob') */
  name: string;
  /** Human-readable description for the LLM */
  description: string;
  /** Permission level */
  permission: ToolPermission;
  /** Default execution options */
  executionOptions: ToolExecutionOptions;
  /**
   * Input keys that contain user-supplied write paths for allowedWritePaths checks.
   *
   * Defaults to ['file_path'] for backwards compatibility. Use [] for tools
   * that write only to internal context-derived paths.
   */
  writePathInputKeys?: string[];
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
  metadata: ToolMetadata;
  /** Zod v3 schema for input validation */
  inputSchema: TInput;
  /** Execute function called with validated input and tool context */
  execute: (
    input: z.infer<TInput>,
    context: ToolContext,
  ) => Promise<TOutput> | TOutput;
}
