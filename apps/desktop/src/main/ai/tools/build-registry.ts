/**
 * Build Tool Registry
 * ===================
 *
 * Shared helper that creates a ToolRegistry pre-populated with all builtin tools.
 * Used by worker threads, runners (insights, roadmap, ideation), and the client factory.
 */

import { ToolRegistry } from './registry';
import type { DefinedTool } from './define';

import { readTool } from './builtin/read';
import { writeTool } from './builtin/write';
import { editTool } from './builtin/edit';
import { bashTool } from './builtin/bash';
import { globTool } from './builtin/glob';
import { grepTool } from './builtin/grep';
import { webFetchTool } from './builtin/web-fetch';
import { webSearchTool } from './builtin/web-search';
import { spawnSubagentTool } from './builtin/spawn-subagent';
import {
  updateSubtaskStatusTool,
  getBuildProgressTool,
  recordDiscoveryTool,
  recordGotchaTool,
  getSessionContextTool,
  updateQaStatusTool,
} from './auto-claude';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDefined = (t: unknown): DefinedTool => t as DefinedTool;

/**
 * Build and return a ToolRegistry with all builtin tools registered.
 */
export function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerTool('Read', asDefined(readTool));
  registry.registerTool('Write', asDefined(writeTool));
  registry.registerTool('Edit', asDefined(editTool));
  registry.registerTool('Bash', asDefined(bashTool));
  registry.registerTool('Glob', asDefined(globTool));
  registry.registerTool('Grep', asDefined(grepTool));
  registry.registerTool('WebFetch', asDefined(webFetchTool));
  registry.registerTool('WebSearch', asDefined(webSearchTool));
  registry.registerTool('SpawnSubagent', asDefined(spawnSubagentTool));
  registry.registerTool('mcp__auto-claude__update_subtask_status', asDefined(updateSubtaskStatusTool));
  registry.registerTool('mcp__auto-claude__get_build_progress', asDefined(getBuildProgressTool));
  registry.registerTool('mcp__auto-claude__record_discovery', asDefined(recordDiscoveryTool));
  registry.registerTool('mcp__auto-claude__record_gotcha', asDefined(recordGotchaTool));
  registry.registerTool('mcp__auto-claude__get_session_context', asDefined(getSessionContextTool));
  registry.registerTool('mcp__auto-claude__update_qa_status', asDefined(updateQaStatusTool));
  return registry;
}
