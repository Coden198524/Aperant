/**
 * Tool.define() Wrapper
 * =====================
 *
 * Wraps the Vercel AI SDK v6 `tool()` function with:
 * - Zod v3 input schema validation
 * - Security hook integration (pre-execution)
 * - Tool context injection
 *
 * Usage:
 *   const readTool = Tool.define({
 *     metadata: { name: 'Read', description: '...', permission: 'read_only', executionOptions: DEFAULT_EXECUTION_OPTIONS },
 *     inputSchema: z.object({ file_path: z.string() }),
 *     execute: async (input, ctx) => { ... },
 *   });
 *
 *   // Later, bind context and get AI SDK tool:
 *   const aiTool = readTool.bind(toolContext);
 */

import { tool } from 'ai';
import type { Tool as AITool } from 'ai';
import {
  acquireAutocodeRuntimeFileWriteLock,
  getToolWritePathDenial,
  guardReadOnlyToolUsage,
  normalizeAutocodeRuntimeFileIntent,
  releaseAutocodeRuntimeFileWriteLock,
  sanitizeFilePathArg,
  type AutocodeRuntimeFileWriteLock,
} from '@autocode/core';
import { z } from 'zod/v3';

import { bashSecurityHook } from '../security/bash-validator';
import type {
  ToolContext,
  ToolDefinitionConfig,
  ToolMetadata,
} from './types';
import { ToolPermission } from './types';
import { truncateToolOutput, SAFETY_NET_MAX_BYTES } from './truncation';

export { sanitizeFilePathArg } from '@autocode/core';

// ---------------------------------------------------------------------------
// Defined Tool
// ---------------------------------------------------------------------------

/**
 * A defined tool that can be bound to a ToolContext to produce
 * an AI SDK v6 compatible tool object.
 */
export interface DefinedTool<
  TInput extends z.ZodType = z.ZodType,
  TOutput = unknown,
> {
  /** Tool metadata */
  metadata: ToolMetadata;
  /** Bind a ToolContext to produce an AI SDK tool */
  bind: (context: ToolContext) => AITool<z.infer<TInput>, TOutput>;
  /** Original config for inspection/testing */
  config: ToolDefinitionConfig<TInput, TOutput>;
}

// ---------------------------------------------------------------------------
// Security pre-execution hook
// ---------------------------------------------------------------------------

/**
 * Run security hooks before tool execution.
 * Currently validates Bash commands against the security profile.
 */
function runSecurityHooks(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): void {
  const result = bashSecurityHook(
    {
      toolName,
      toolInput: input,
      cwd: context.cwd,
    },
    context.securityProfile,
  );

  if ('hookSpecificOutput' in result) {
    const reason = result.hookSpecificOutput.permissionDecisionReason;
    throw new Error(`Security hook denied ${toolName}: ${reason}`);
  }
}

function getWritePathInputKeys(metadata: ToolMetadata): string[] {
  return metadata.writePathInputKeys ?? ['file_path'];
}

function getWritePathsFromInput(
  input: Record<string, unknown>,
  metadata: ToolMetadata,
): string[] {
  const paths = new Set<string>();
  for (const key of getWritePathInputKeys(metadata)) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      paths.add(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          paths.add(item.trim());
        }
      }
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

async function acquireFileWriteLocks(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
  metadata: ToolMetadata,
): Promise<AutocodeRuntimeFileWriteLock[]> {
  if (context.fileWriteLock?.enabled !== true || metadata.permission === ToolPermission.ReadOnly) {
    return [];
  }

  const writePaths = getWritePathsFromInput(input, metadata);
  if (writePaths.length === 0) {
    return [];
  }

  const projectRoot = context.fileWriteLock.projectRoot ?? context.projectDir;
  const sortedWritePaths = [...writePaths].sort((left, right) => {
    const leftKey = normalizeAutocodeRuntimeFileIntent(left, projectRoot) ?? left;
    const rightKey = normalizeAutocodeRuntimeFileIntent(right, projectRoot) ?? right;
    return leftKey.localeCompare(rightKey);
  });
  const locks: AutocodeRuntimeFileWriteLock[] = [];
  try {
    for (const filePath of sortedWritePaths) {
      locks.push(await acquireAutocodeRuntimeFileWriteLock({
        ...context.fileWriteLock,
        projectRoot,
        filePath,
        ownerId: context.fileWriteLock.ownerId ?? `${toolName}:${Date.now()}`,
      }));
    }
    return locks;
  } catch (error) {
    releaseFileWriteLocks(locks);
    throw error;
  }
}

function releaseFileWriteLocks(locks: AutocodeRuntimeFileWriteLock[]): void {
  for (const lock of locks.reverse()) {
    releaseAutocodeRuntimeFileWriteLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Tool.define()
// ---------------------------------------------------------------------------

/**
 * Define a tool with metadata, Zod input schema, and execute function.
 * Returns a DefinedTool that can be bound to a ToolContext for use with AI SDK.
 */
function define<TInput extends z.ZodType, TOutput>(
  config: ToolDefinitionConfig<TInput, TOutput>,
): DefinedTool<TInput, TOutput> {
  const { metadata, inputSchema, execute } = config;

  return {
    metadata,
    config,
    bind(context: ToolContext): AITool<z.infer<TInput>, TOutput> {
      type Input = z.infer<TInput>;

      // Use type assertion because tool() overloads can't infer
      // from generic TInput/TOutput at the definition site.
      // Concrete types resolve correctly when Tool.define() is called
      // with a specific Zod schema.
      const executeWithHooks = async (input: Input): Promise<TOutput> => {
        sanitizeFilePathArg(input as Record<string, unknown>);

        if (metadata.permission !== ToolPermission.ReadOnly) {
          runSecurityHooks(
            metadata.name,
            input as Record<string, unknown>,
            context,
          );
        } else {
          const guardMessage = guardReadOnlyToolUsage(
            metadata.name,
            input as Record<string, unknown>,
            context,
          );
          if (guardMessage) {
            return guardMessage as TOutput;
          }
        }

        if (context.allowedWritePaths?.length && metadata.permission !== ToolPermission.ReadOnly) {
          const denial = getToolWritePathDenial(
            metadata.name,
            input as Record<string, unknown>,
            context.allowedWritePaths,
            metadata.writePathInputKeys,
          );
          if (denial) {
            throw new Error(denial);
          }
        }

        const fileWriteLocks = await acquireFileWriteLocks(
          metadata.name,
          input as Record<string, unknown>,
          context,
          metadata,
        );
        let result: TOutput;
        try {
          result = await (execute(input as z.infer<TInput>, context) as Promise<TOutput>);
        } finally {
          releaseFileWriteLocks(fileWriteLocks);
        }

        // Safety-net: apply disk-spillover truncation to string outputs.
        // Individual tools should catch most cases first.
        if (typeof result === 'string') {
          const truncated = truncateToolOutput(
            result,
            metadata.name,
            context.projectDir,
            SAFETY_NET_MAX_BYTES,
          );
          return truncated.content as TOutput;
        }
        return result;
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic TInput can't satisfy tool() overloads at definition site
      return tool({
        description: metadata.description,
        inputSchema: inputSchema as any,
        execute: executeWithHooks as any,
      }) as AITool<Input, TOutput>;
    },
  };
}

/**
 * Tool namespace - entry point for defining tools.
 */
export const Tool = { define } as const;
