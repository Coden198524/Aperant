/**
 * record_memory Agent Tool
 *
 * Allows agents to explicitly record a memory during a session.
 * Posts to the main thread's MemoryService via IPC.
 */

import { tool } from 'ai';
import { z } from 'zod/v3';
import type { Tool as AITool } from 'ai';
import type { WorkerObserverProxy } from '../ipc/worker-observer-proxy';
import type { MemoryType, MemoryRecordEntry } from '../types';

const recordMemorySchema = z.object({
  type: z
    .enum([
      'gotcha',
      'decision',
      'pattern',
      'error_pattern',
      'module_insight',
      'dead_end',
      'causal_dependency',
      'requirement',
    ])
    .describe(
      'Type of memory: gotcha=pitfall to avoid, decision=architectural choice, pattern=reusable approach, error_pattern=recurring error, module_insight=non-obvious module behavior, dead_end=failed approach, causal_dependency=file coupling, requirement=constraint',
    ),
  content: z
    .string()
    .min(10)
    .max(500)
    .describe(
      'The memory content. Be specific and actionable. Example: "Always call refreshToken() before making API calls in auth.ts; the token expires after 15 minutes of inactivity"',
    ),
  relatedFiles: z
    .array(z.string())
    .optional()
    .describe('Absolute paths to files this memory relates to'),
  relatedModules: z
    .array(z.string())
    .optional()
    .describe('Module names this memory relates to (e.g., ["auth", "token"])'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.8)
    .describe('Confidence in this memory (0.0-1.0, default 0.8)'),
});

type RecordMemoryInput = z.infer<typeof recordMemorySchema>;

export function createRecordMemoryTool(
  proxy: WorkerObserverProxy,
  projectId: string,
  sessionId: string,
): AITool<RecordMemoryInput, string> {
  return tool({
    description:
      'Record a concise persistent memory for future sessions. Use this only for non-obvious, reusable gotchas, decisions, recurring errors, file couplings, or failed approaches.',
    inputSchema: recordMemorySchema,
    execute: async (input: RecordMemoryInput): Promise<string> => {
      const entry: MemoryRecordEntry = {
        type: input.type as MemoryType,
        content: input.content,
        relatedFiles: input.relatedFiles ?? [],
        relatedModules: input.relatedModules ?? [],
        confidence: input.confidence ?? 0.8,
        source: 'agent_explicit',
        projectId,
        sessionId,
        needsReview: false,
        scope: 'module',
      };

      const id = await proxy.recordMemory(entry);

      if (!id) {
        return 'Memory noted locally, but could not be persisted.';
      }

      return `Memory recorded (id: ${id.slice(0, 8)}).`;
    },
  });
}

export function createRecordMemoryStub(): AITool<RecordMemoryInput, string> {
  return tool({
    description: 'Record a memory (memory not available in this session).',
    inputSchema: recordMemorySchema,
    execute: async (_input: RecordMemoryInput): Promise<string> => {
      return 'Memory noted locally, but memory persistence is unavailable in this session.';
    },
  });
}
