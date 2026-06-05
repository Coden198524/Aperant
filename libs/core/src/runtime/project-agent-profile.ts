import type { AgentType } from '../config/agent-configs.js';

export type AutocodeProjectType = 'general' | 'game-mmo';

export interface AutocodeProjectAgentProfile {
  id: AutocodeProjectType;
  specOrchestrator: AgentType;
  buildOrchestrator: AgentType;
  planning: AgentType;
  coding: AgentType;
  qaReview: AgentType;
  qaFix: AgentType;
}

export const AUTOCODE_GENERAL_AGENT_PROFILE: AutocodeProjectAgentProfile = {
  id: 'general',
  specOrchestrator: 'spec_orchestrator',
  buildOrchestrator: 'build_orchestrator',
  planning: 'planner',
  coding: 'coder',
  qaReview: 'qa_reviewer',
  qaFix: 'qa_fixer',
};

export const AUTOCODE_MMO_AGENT_PROFILE: AutocodeProjectAgentProfile = {
  id: 'game-mmo',
  specOrchestrator: 'mmo_spec_orchestrator',
  buildOrchestrator: 'mmo_build_orchestrator',
  planning: 'mmo_system_designer',
  coding: 'mmo_engine_programmer',
  qaReview: 'mmo_qa_reviewer',
  qaFix: 'mmo_qa_fixer',
};

export function normalizeAutocodeProjectType(
  projectType: AutocodeProjectType | string | null | undefined,
): AutocodeProjectType {
  return projectType === 'game-mmo' ? 'game-mmo' : 'general';
}

export function resolveAutocodeProjectAgentProfile(
  projectType: AutocodeProjectType | string | null | undefined,
): AutocodeProjectAgentProfile {
  return normalizeAutocodeProjectType(projectType) === 'game-mmo'
    ? AUTOCODE_MMO_AGENT_PROFILE
    : AUTOCODE_GENERAL_AGENT_PROFILE;
}
