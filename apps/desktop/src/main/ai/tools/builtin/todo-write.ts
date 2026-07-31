import { z } from 'zod/v3';

import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';

const todoSchema = z.object({
  content: z.string().min(1).max(2_000),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1).max(2_000).optional(),
});

const inputSchema = z.object({
  todos: z.array(todoSchema).max(100),
});

/**
 * Upstream OpenSpec Propose/FF prompts use the Claude-compatible TodoWrite
 * host tool. The complete list is supplied on every call, so acknowledging
 * the normalized list is sufficient for the model to keep Action-local
 * progress without creating a second planning fact source on disk.
 */
export const todoWriteTool = Tool.define({
  metadata: {
    name: 'TodoWrite',
    description:
      'Replace the current Action-local todo list. Supply the complete list with pending, in_progress, or completed status.',
    permission: ToolPermission.ReadOnly,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: async (input): Promise<string> => {
    const counts = {
      pending: 0,
      in_progress: 0,
      completed: 0,
    };
    for (const todo of input.todos) counts[todo.status] += 1;
    return JSON.stringify({
      accepted: true,
      total: input.todos.length,
      ...counts,
      todos: input.todos,
    });
  },
});
