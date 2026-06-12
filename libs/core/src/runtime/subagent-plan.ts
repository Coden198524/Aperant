import type { AgentType } from '../config/agent-configs.js';

export const AUTOCODE_SUBAGENT_MAX_STEPS = 100;

export const AUTOCODE_SUBAGENT_TYPES = [
  'complexity_assessor',
  'spec_discovery',
  'spec_gatherer',
  'spec_researcher',
  'spec_writer',
  'spec_critic',
  'spec_validation',
  'planner',
  'coder',
  'qa_reviewer',
  'qa_fixer',
  'mmo_system_designer',
  'mmo_engine_architect',
  'mmo_engine_programmer',
  'mmo_rendering_engineer',
  'mmo_animation_engineer',
  'mmo_asset_pipeline_engineer',
  'mmo_world_streaming_engineer',
  'mmo_tools_engineer',
  'mmo_build_release_engineer',
  'mmo_engine_performance_engineer',
  'mmo_server_authority_engineer',
  'mmo_network_sync_engineer',
  'mmo_client_gameplay_engineer',
  'mmo_data_persistence_engineer',
  'mmo_security_anticheat_engineer',
  'mmo_liveops_engineer',
  'mmo_qa_reviewer',
  'mmo_qa_fixer',
] as const;

export type AutocodeSubagentType = typeof AUTOCODE_SUBAGENT_TYPES[number];

export const AUTOCODE_SUBAGENT_AGENT_TYPE_MAP: Record<AutocodeSubagentType, AgentType> = {
  complexity_assessor: 'spec_gatherer',
  spec_discovery: 'spec_discovery',
  spec_gatherer: 'spec_gatherer',
  spec_researcher: 'spec_researcher',
  spec_writer: 'spec_writer',
  spec_critic: 'spec_critic',
  spec_validation: 'spec_validation',
  planner: 'planner',
  coder: 'coder',
  qa_reviewer: 'qa_reviewer',
  qa_fixer: 'qa_fixer',
  mmo_system_designer: 'mmo_system_designer',
  mmo_engine_architect: 'mmo_engine_architect',
  mmo_engine_programmer: 'mmo_engine_programmer',
  mmo_rendering_engineer: 'mmo_rendering_engineer',
  mmo_animation_engineer: 'mmo_animation_engineer',
  mmo_asset_pipeline_engineer: 'mmo_asset_pipeline_engineer',
  mmo_world_streaming_engineer: 'mmo_world_streaming_engineer',
  mmo_tools_engineer: 'mmo_tools_engineer',
  mmo_build_release_engineer: 'mmo_build_release_engineer',
  mmo_engine_performance_engineer: 'mmo_engine_performance_engineer',
  mmo_server_authority_engineer: 'mmo_server_authority_engineer',
  mmo_network_sync_engineer: 'mmo_network_sync_engineer',
  mmo_client_gameplay_engineer: 'mmo_client_gameplay_engineer',
  mmo_data_persistence_engineer: 'mmo_data_persistence_engineer',
  mmo_security_anticheat_engineer: 'mmo_security_anticheat_engineer',
  mmo_liveops_engineer: 'mmo_liveops_engineer',
  mmo_qa_reviewer: 'mmo_qa_reviewer',
  mmo_qa_fixer: 'mmo_qa_fixer',
};

export const AUTOCODE_SUBAGENT_PROMPT_NAME_MAP: Record<AutocodeSubagentType, string> = {
  complexity_assessor: 'complexity_assessor',
  spec_discovery: 'spec_gatherer',
  spec_gatherer: 'spec_gatherer',
  spec_researcher: 'spec_researcher',
  spec_writer: 'spec_writer',
  spec_critic: 'spec_critic',
  spec_validation: 'spec_writer',
  planner: 'planner',
  coder: 'coder',
  qa_reviewer: 'qa_reviewer',
  qa_fixer: 'qa_fixer',
  mmo_system_designer: 'mmo_system_designer',
  mmo_engine_architect: 'mmo_engine_architect',
  mmo_engine_programmer: 'mmo_engine_programmer',
  mmo_rendering_engineer: 'mmo_rendering_engineer',
  mmo_animation_engineer: 'mmo_animation_engineer',
  mmo_asset_pipeline_engineer: 'mmo_asset_pipeline_engineer',
  mmo_world_streaming_engineer: 'mmo_world_streaming_engineer',
  mmo_tools_engineer: 'mmo_tools_engineer',
  mmo_build_release_engineer: 'mmo_build_release_engineer',
  mmo_engine_performance_engineer: 'mmo_engine_performance_engineer',
  mmo_server_authority_engineer: 'mmo_server_authority_engineer',
  mmo_network_sync_engineer: 'mmo_network_sync_engineer',
  mmo_client_gameplay_engineer: 'mmo_client_gameplay_engineer',
  mmo_data_persistence_engineer: 'mmo_data_persistence_engineer',
  mmo_security_anticheat_engineer: 'mmo_security_anticheat_engineer',
  mmo_liveops_engineer: 'mmo_liveops_engineer',
  mmo_qa_reviewer: 'mmo_qa_reviewer',
  mmo_qa_fixer: 'mmo_qa_fixer',
};

export const AUTOCODE_STRUCTURED_OUTPUT_SUBAGENT_TYPES = [
  'complexity_assessor',
] as const satisfies readonly AutocodeSubagentType[];

const AUTOCODE_STRUCTURED_OUTPUT_SUBAGENT_TYPE_SET = new Set<string>(
  AUTOCODE_STRUCTURED_OUTPUT_SUBAGENT_TYPES,
);

export const AUTOCODE_SPAWN_SUBAGENT_UNAVAILABLE_MESSAGE =
  'Error: SpawnSubagent is not available in this session. This tool is only available when running in agentic orchestration mode.';

export const AUTOCODE_SPAWN_SUBAGENT_TOOL_DESCRIPTION = `Spawn a specialist subagent to perform a focused task. The subagent runs independently with its own tools and system prompt. You receive the subagent's text output (or structured data) back in your context.

Available subagent types:
- complexity_assessor: Assess task complexity (simple/standard/complex). Returns structured JSON.
- spec_discovery: Analyze project structure, tech stack, conventions, and source evidence. Writes context.json.
- spec_gatherer: Gather and validate evidence-backed requirements from task description, project source, and standards. Writes requirements.md.
- spec_researcher: Research implementation approaches, external APIs, libraries, and standards using verified sources. Writes research.json.
- spec_writer: Write the evidence-backed specification (spec.md). Writes files.
- spec_critic: Review spec for completeness, technical feasibility, gaps.
- spec_validation: Final validation of spec.md and implementation_plan.md.
- planner: Create source-backed tasks with dependencies, evidence notes, and verification.
- coder: Implement code changes.
- qa_reviewer: Review implementation against specification.
- qa_fixer: Fix issues found by qa_reviewer.
- mmo_system_designer: Design MMORPG systems, progression, content loops, and acceptance criteria.
- mmo_engine_architect: Plan engine-level architecture boundaries and runtime integration.
- mmo_engine_programmer: Implement core engine/runtime code for large online game features.
- mmo_rendering_engineer: Implement rendering, shader, lighting, and frame-time sensitive changes.
- mmo_animation_engineer: Implement animation, character movement, state machines, and replication hooks.
- mmo_asset_pipeline_engineer: Implement import, cooking, validation, and content pipeline changes.
- mmo_world_streaming_engineer: Implement terrain, scene, shard, streaming, and loading behavior.
- mmo_tools_engineer: Implement editor, GM, content authoring, and production tools.
- mmo_build_release_engineer: Implement build, packaging, patching, deployment, and release automation.
- mmo_engine_performance_engineer: Diagnose and fix CPU, GPU, memory, IO, and network performance issues.
- mmo_server_authority_engineer: Implement authoritative gameplay and simulation server changes.
- mmo_network_sync_engineer: Implement replication, prediction, reconciliation, interest management, and protocol changes.
- mmo_client_gameplay_engineer: Implement client gameplay UX, combat, quests, UI, and integration code.
- mmo_data_persistence_engineer: Implement database, save, migration, economy, and account data changes.
- mmo_security_anticheat_engineer: Review and implement cheat resistance, exploit prevention, and trust boundaries.
- mmo_liveops_engineer: Implement telemetry, feature flags, operational controls, events, and rollout safety.
- mmo_qa_reviewer: Review MMO implementation against correctness, performance, networking, and operations.
- mmo_qa_fixer: Fix issues found by mmo_qa_reviewer.

Tips:
- Pass accumulated context from prior subagents to avoid redundant work.
- Keep context concise; summarize large outputs (>10KB).
- Use expect_structured_output=true for complexity_assessor (returns JSON).`;

function isAutocodeSubagentType(value: string): value is AutocodeSubagentType {
  return (AUTOCODE_SUBAGENT_TYPES as readonly string[]).includes(value);
}

export function resolveAutocodeSubagentAgentType(subagentType: string): AgentType {
  return isAutocodeSubagentType(subagentType)
    ? AUTOCODE_SUBAGENT_AGENT_TYPE_MAP[subagentType]
    : 'spec_gatherer';
}

export function resolveAutocodeSubagentPromptName(subagentType: string): string {
  return isAutocodeSubagentType(subagentType)
    ? AUTOCODE_SUBAGENT_PROMPT_NAME_MAP[subagentType]
    : 'spec_writer';
}

export function shouldAutocodeSubagentUseStructuredOutput(subagentType: string): boolean {
  return AUTOCODE_STRUCTURED_OUTPUT_SUBAGENT_TYPE_SET.has(subagentType);
}

export function buildAutocodeSubagentUserMessage(input: {
  task: string;
  context?: string | null;
}): string {
  let message = `Your task: ${input.task}`;
  if (input.context) {
    message += `\n\nContext:\n${input.context}`;
  }
  return message;
}

export function formatAutocodeSubagentToolResult(input: {
  agentType: string;
  text?: string;
  structuredOutput?: Record<string, unknown>;
  error?: string;
}): string {
  if (input.error) {
    return `Subagent (${input.agentType}) failed: ${input.error}`;
  }

  if (input.structuredOutput) {
    return `Subagent (${input.agentType}) completed successfully.\n\nStructured output:\n\`\`\`json\n${JSON.stringify(input.structuredOutput, null, 2)}\n\`\`\``;
  }

  return `Subagent (${input.agentType}) completed successfully.\n\nOutput:\n${input.text ?? '(no text output)'}`;
}
