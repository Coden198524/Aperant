import { z } from 'zod/v3';

import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';

const inputSchema = z.object({
  subagent_type: z.string().min(1).max(100),
  prompt: z.string().min(1).max(32_000),
  description: z.string().max(1_000).optional(),
});

/**
 * Host-compatible Task tool used by the upstream Archive prompt.
 *
 * The tool delegates to a dedicated OpenSpec child session installed by the
 * worker. The child uses the byte-identical pinned Sync prompt and cannot enter
 * either of Aperant's Standard subagent pipelines.
 */
export const openSpecTaskTool = Tool.define({
  metadata: {
    name: 'Task',
    description:
      'Delegate an OpenSpec workflow task. The official Archive workflow uses this for delta-spec synchronization.',
    permission: ToolPermission.ReadOnly,
    executionOptions: {
      ...DEFAULT_EXECUTION_OPTIONS,
      timeoutMs: 600_000,
    },
  },
  inputSchema,
  execute: async (input, context): Promise<string> => {
    if (input.subagent_type !== 'general-purpose') {
      return `Error: Unsupported OpenSpec Task subagent type "${input.subagent_type}".`;
    }
    if (!/\bopenspec-sync-specs\b/i.test(input.prompt)) {
      return 'Error: Only the official openspec-sync-specs delegation is available in this isolated OpenSpec session.';
    }
    if (!context.runOpenSpecDelegation) {
      throw new Error(
        'The isolated OpenSpec delegation executor is unavailable; Archive cannot continue.',
      );
    }

    return context.runOpenSpecDelegation({
      action: 'sync',
      prompt: input.prompt,
      ...(input.description ? { description: input.description } : {}),
    });
  },
});
