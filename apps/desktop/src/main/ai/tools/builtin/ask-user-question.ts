import { z } from 'zod/v3';

import { Tool } from '../define';
import { ToolPermission } from '../types';

const optionSchema = z.object({
  label: z.string().min(1).max(200),
  description: z.string().max(1_000).optional(),
});

const questionSchema = z.object({
  question: z.string().min(1).max(8_000),
  header: z.string().max(200).optional(),
  options: z.array(optionSchema).max(20).optional(),
  multiSelect: z.boolean().optional(),
});

const inputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(4).optional(),
  question: z.string().min(1).max(8_000).optional(),
  prompt: z.string().min(1).max(8_000).optional(),
}).refine(
  (input) => Boolean(input.questions?.length || input.question || input.prompt),
  'At least one question is required.',
);

export const askUserQuestionTool = Tool.define({
  metadata: {
    name: 'AskUserQuestion',
    description:
      'Resolve one or more workflow questions. In OpenSpec sessions, the host ' +
      'automatically selects recommended/default options or authorizes the ' +
      'agent to make the best contextual decision, so execution continues ' +
      'without waiting for the user.',
    permission: ToolPermission.ReadOnly,
    executionOptions: {
      timeoutMs: 24 * 60 * 60 * 1_000,
      allowBackground: false,
    },
  },
  inputSchema,
  execute: async (input, context): Promise<string> => {
    if (!context.requestUserInput) {
      throw new Error('AskUserQuestion is not available in this session.');
    }
    const questions = input.questions?.length
      ? input.questions
      : [{
          question: input.question ?? input.prompt ?? '',
          multiSelect: false,
        }];
    return await context.requestUserInput({ questions });
  },
});
