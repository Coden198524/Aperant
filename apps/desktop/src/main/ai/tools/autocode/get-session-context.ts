/**
 * get_session_context Tool
 * ========================
 *
 * Reads accumulated session context from memory files:
 *   - memory/codebase_map.json  → discoveries
 *   - memory/gotchas.md         → gotchas & pitfalls
 *   - memory/patterns.md        → code patterns
 *
 * See apps/desktop/src/main/ai/tools/autocode/get-session-context.ts for the TypeScript implementation.
 *
 * Tool name: mcp__autocode__get_session_context
 */

import * as fs from 'node:fs';
import {
  AUTOCODE_NO_SESSION_MEMORY_MESSAGE,
  buildAutocodeSessionContext,
  getAutocodeSessionCodebaseMapPath,
  getAutocodeSessionGotchasPath,
  getAutocodeSessionMemoryDir,
  getAutocodeSessionPatternsPath,
  parseAutocodeSessionCodebaseMap,
  type AutocodeSessionCodebaseMap,
} from '@autocode/core';
import { z } from 'zod/v3';

import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';

// ---------------------------------------------------------------------------
// Input Schema (no parameters)
// ---------------------------------------------------------------------------

const inputSchema = z.object({});

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const getSessionContextTool = Tool.define({
  metadata: {
    name: 'mcp__autocode__get_session_context',
    description:
      'Get context from previous sessions including codebase discoveries, gotchas, and patterns. Call this at the start of a session to pick up where the last session left off.',
    permission: ToolPermission.ReadOnly,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: (_input, context) => {
    const memoryDir = getAutocodeSessionMemoryDir(context.specDir);

    if (!fs.existsSync(memoryDir)) {
      return AUTOCODE_NO_SESSION_MEMORY_MESSAGE;
    }

    let codebaseMap: AutocodeSessionCodebaseMap | null = null;
    let gotchasMarkdown: string | null = null;
    let patternsMarkdown: string | null = null;

    // Load codebase map (discoveries)
    const mapFile = getAutocodeSessionCodebaseMapPath(context.specDir);
    if (fs.existsSync(mapFile)) {
      try {
        codebaseMap = parseAutocodeSessionCodebaseMap(fs.readFileSync(mapFile, 'utf-8'));
      } catch {
        // Skip corrupt file
      }
    }

    // Load gotchas
    const gotchasFile = getAutocodeSessionGotchasPath(context.specDir);
    if (fs.existsSync(gotchasFile)) {
      try {
        gotchasMarkdown = fs.readFileSync(gotchasFile, 'utf-8');
      } catch {
        // Skip
      }
    }

    // Load patterns
    const patternsFile = getAutocodeSessionPatternsPath(context.specDir);
    if (fs.existsSync(patternsFile)) {
      try {
        patternsMarkdown = fs.readFileSync(patternsFile, 'utf-8');
      } catch {
        // Skip
      }
    }

    return buildAutocodeSessionContext({ codebaseMap, gotchasMarkdown, patternsMarkdown });
  },
});
