import {
  TOOL_GET_BUILD_PROGRESS,
  TOOL_GET_SESSION_CONTEXT,
  TOOL_RECORD_DISCOVERY,
  TOOL_RECORD_GOTCHA,
  TOOL_UPDATE_QA_STATUS,
  TOOL_UPDATE_SUBTASK_STATUS,
  getAgentConfig,
  type AgentType,
} from '../config/agent-configs.js';

export const SPAWN_SUBAGENT_TOOL_NAME = 'SpawnSubagent';

export const LOCAL_TOOL_REGISTRATION_ORDER = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
] as const;

export const AUTOCODE_TOOL_REGISTRATION_ORDER = [
  TOOL_UPDATE_SUBTASK_STATUS,
  TOOL_GET_BUILD_PROGRESS,
  TOOL_RECORD_DISCOVERY,
  TOOL_RECORD_GOTCHA,
  TOOL_GET_SESSION_CONTEXT,
  TOOL_UPDATE_QA_STATUS,
] as const;

export interface ToolRegistrationPlanOptions {
  webSearchEnabled?: boolean;
}

export interface ToolSelectionOptions {
  hasSubagentExecutor?: boolean;
}

export function buildToolRegistrationPlan(
  options: ToolRegistrationPlanOptions = {},
): string[] {
  return [
    ...LOCAL_TOOL_REGISTRATION_ORDER,
    ...(options.webSearchEnabled ? ['WebSearch'] : []),
    SPAWN_SUBAGENT_TOOL_NAME,
    ...AUTOCODE_TOOL_REGISTRATION_ORDER,
  ];
}

export function getAllowedToolNamesForAgent(agentType: AgentType): string[] {
  const config = getAgentConfig(agentType);
  return Array.from(new Set([...config.tools, ...config.autoClaudeTools]));
}

export function shouldExposeRegisteredTool(
  name: string,
  allowedNames: ReadonlySet<string>,
  options: ToolSelectionOptions = {},
): boolean {
  if (name === SPAWN_SUBAGENT_TOOL_NAME && !options.hasSubagentExecutor) {
    return false;
  }
  return allowedNames.has(name);
}

export function selectRegisteredToolNamesForAgent(
  agentType: AgentType,
  registeredNames: Iterable<string>,
  options: ToolSelectionOptions = {},
): string[] {
  const allowedNames = new Set(getAllowedToolNamesForAgent(agentType));
  return Array.from(registeredNames).filter((name) =>
    shouldExposeRegisteredTool(name, allowedNames, options),
  );
}
