/**
 * Build Tool Registry
 * ===================
 *
 * Shared helper that creates a ToolRegistry pre-populated with all builtin tools.
 * Used by worker threads, runners (insights, roadmap, ideation), and the client factory.
 */

import { buildToolRegistrationPlan } from '@autocode/core';
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
import { askUserQuestionTool } from './builtin/ask-user-question';
import { todoWriteTool } from './builtin/todo-write';
import { openSpecTaskTool } from './builtin/openspec-task';
import { isSearchProviderConfigured } from './providers';
import {
  updateSubtaskStatusTool,
  getBuildProgressTool,
  recordDiscoveryTool,
  recordGotchaTool,
  getSessionContextTool,
  updateQaStatusTool,
} from './autocode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDefined = (t: unknown): DefinedTool => t as DefinedTool;

const TOOL_IMPLEMENTATIONS: Record<string, DefinedTool> = {
  Read: asDefined(readTool),
  Write: asDefined(writeTool),
  Edit: asDefined(editTool),
  Bash: asDefined(bashTool),
  Glob: asDefined(globTool),
  Grep: asDefined(grepTool),
  WebFetch: asDefined(webFetchTool),
  WebSearch: asDefined(webSearchTool),
  SpawnSubagent: asDefined(spawnSubagentTool),
  AskUserQuestion: asDefined(askUserQuestionTool),
  TodoWrite: asDefined(todoWriteTool),
  Task: asDefined(openSpecTaskTool),
  mcp__autocode__update_subtask_status: asDefined(updateSubtaskStatusTool),
  mcp__autocode__get_build_progress: asDefined(getBuildProgressTool),
  mcp__autocode__record_discovery: asDefined(recordDiscoveryTool),
  mcp__autocode__record_gotcha: asDefined(recordGotchaTool),
  mcp__autocode__get_session_context: asDefined(getSessionContextTool),
  mcp__autocode__update_qa_status: asDefined(updateQaStatusTool),
};

/**
 * Build and return a ToolRegistry with all builtin tools registered.
 */
export function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of buildToolRegistrationPlan({
    webSearchEnabled: isSearchProviderConfigured(),
  })) {
    const definedTool = TOOL_IMPLEMENTATIONS[name];
    if (definedTool) {
      registry.registerTool(name, definedTool);
    }
  }
  return registry;
}
