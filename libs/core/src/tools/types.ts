/**
 * Shared tool policy types.
 *
 * These are intentionally runtime-light and do not depend on AI SDK, Zod,
 * Electron, or concrete tool implementations.
 */

/**
 * Session-scoped tool usage counters. This is intentionally lightweight and
 * lives on the tool context so copied contexts can share the same counters.
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

/**
 * Metadata for a defined tool, used by registries and runtime adapters.
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

export interface ToolUsagePolicyContext {
  /** Root directory of the project being worked on */
  projectDir: string;
  /** Session-scoped accounting used to prevent wasteful repeated read/search tool loops */
  toolUsageState?: ToolUsageState;
  /** Optional per-session overrides for generic tool usage limits */
  toolUsageLimits?: ToolUsageLimits;
}

export interface ToolWritePathPolicyContext {
  /** If set, Write/Edit tools can only write within these directories */
  allowedWritePaths?: string[];
}

export interface ToolPolicyContext extends ToolUsagePolicyContext, ToolWritePathPolicyContext {}
