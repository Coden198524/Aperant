/**
 * record_discovery Tool
 * =====================
 *
 * Records a codebase discovery to session memory (codebase_map.json).
 * See apps/desktop/src/main/ai/tools/autocode/record-discovery.ts for the TypeScript implementation.
 *
 * Tool name: mcp__autocode__record_discovery
 */

import * as fs from 'node:fs';
import {
  createEmptyAutocodeSessionCodebaseMap,
  getAutocodeSessionCodebaseMapPath,
  getAutocodeSessionMemoryDir,
  parseAutocodeSessionCodebaseMap,
  recordAutocodeSessionDiscovery,
  stringifyAutocodeSessionCodebaseMap,
} from '@autocode/core';
import { z } from 'zod/v3';

import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  // This is the source path being documented, not the file this tool writes.
  file_path: z.string().describe('Path to the file or module being documented'),
  description: z.string().describe('What was discovered about this file or module'),
  category: z
    .string()
    .optional()
    .describe('Category of the discovery (e.g., "api", "config", "ui", "general")'),
});

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const recordDiscoveryTool = Tool.define({
  metadata: {
    name: 'mcp__autocode__record_discovery',
    description:
      'Record a codebase discovery to session memory. Use this when you learn something important about the codebase structure or behavior.',
    permission: ToolPermission.Auto,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
    writePathInputKeys: [],
  },
  inputSchema,
  execute: (input, context) => {
    const { file_path, description, category = 'general' } = input;
    const memoryDir = getAutocodeSessionMemoryDir(context.specDir);

    try {
      fs.mkdirSync(memoryDir, { recursive: true });

      const mapFile = getAutocodeSessionCodebaseMapPath(context.specDir);
      let codebaseMap = createEmptyAutocodeSessionCodebaseMap();

      if (fs.existsSync(mapFile)) {
        try {
          const parsed = parseAutocodeSessionCodebaseMap(fs.readFileSync(mapFile, 'utf-8'));
          if (parsed) codebaseMap = parsed;
          // Start fresh if corrupt (parsed === null)
        } catch {
          // Start fresh if corrupt
        }
      }

      codebaseMap = recordAutocodeSessionDiscovery(codebaseMap, {
        filePath: file_path,
        description,
        category,
      });

      const tmp = `${mapFile}.tmp`;
      fs.writeFileSync(tmp, stringifyAutocodeSessionCodebaseMap(codebaseMap), 'utf-8');
      fs.renameSync(tmp, mapFile);

      return `Recorded discovery for '${file_path}': ${description}`;
    } catch (e) {
      return `Error recording discovery: ${e}`;
    }
  },
});
