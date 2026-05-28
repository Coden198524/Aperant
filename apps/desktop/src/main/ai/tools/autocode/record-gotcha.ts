/**
 * record_gotcha Tool
 * ==================
 *
 * Records a gotcha or pitfall to specDir/memory/gotchas.md.
 * See apps/desktop/src/main/ai/tools/autocode/record-gotcha.ts for the TypeScript implementation.
 *
 * Tool name: mcp__autocode__record_gotcha
 */

import * as fs from 'node:fs';
import {
  formatAutocodeGotchaMarkdownEntry,
  formatAutocodeGotchasFileHeader,
  getAutocodeSessionGotchasPath,
  getAutocodeSessionMemoryDir,
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
    const memoryDir = getAutocodeSessionMemoryDir(context.specDir);

    try {
      fs.mkdirSync(memoryDir, { recursive: true });

      const gotchasFile = getAutocodeSessionGotchasPath(context.specDir);

      // Determine whether file is new or empty without a separate existsSync check
      let isNew: boolean;
      try {
        const stat = fs.statSync(gotchasFile);
        isNew = stat.size === 0;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        isNew = true;
      }
      const header = isNew ? formatAutocodeGotchasFileHeader() : '';
      const entry = formatAutocodeGotchaMarkdownEntry({ gotcha, context: ctx });

      fs.writeFileSync(gotchasFile, header + entry, { flag: isNew ? 'w' : 'a', encoding: 'utf-8' });

      return `Recorded gotcha: ${gotcha}`;
    } catch (e) {
      return `Error recording gotcha: ${e}`;
    }
  },
});
