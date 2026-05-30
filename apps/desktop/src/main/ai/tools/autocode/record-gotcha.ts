/**
 * record_gotcha Tool
 * ==================
 *
 * Records a gotcha or pitfall to specDir/memory/gotchas.md.
 * See apps/desktop/src/main/ai/tools/autocode/record-gotcha.ts for the TypeScript implementation.
 *
 * Tool name: mcp__autocode__record_gotcha
 */

import {
  appendAutocodeSessionGotcha,
} from '@autocode/core';
import { z } from 'zod/v3';

import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  gotcha: z.string().describe('Description of the gotcha or pitfall to record'),
  context: z
    .string()
    .optional()
    .describe('Additional context about when this gotcha applies'),
});

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const recordGotchaTool = Tool.define({
  metadata: {
    name: 'mcp__autocode__record_gotcha',
    description:
      'Record a gotcha or pitfall to avoid. Use this when you encounter something that future sessions should know about to avoid repeating mistakes.',
    permission: ToolPermission.Auto,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: (input, context) => {
    const { gotcha, context: ctx } = input;

    try {
      appendAutocodeSessionGotcha({
        specDir: context.specDir,
        gotcha,
        context: ctx,
      });

      return `Recorded gotcha: ${gotcha}`;
    } catch (e) {
      return `Error recording gotcha: ${e}`;
    }
  },
});
