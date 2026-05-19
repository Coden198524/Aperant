import type { ProjectType } from '../../../shared/types';
import type { AgentType } from './agent-configs';

export interface ProjectAgentProfile {
  id: ProjectType;
  specOrchestrator: AgentType;
  buildOrchestrator: AgentType;
  planning: AgentType;
  coding: AgentType;
  qaReview: AgentType;
  qaFix: AgentType;
}

export const GENERAL_AGENT_PROFILE: ProjectAgentProfile = {
  id: 'general',
  specOrchestrator: 'spec_orchestrator',
  buildOrchestrator: 'build_orchestrator',
  planning: 'planner',
  coding: 'coder',
  qaReview: 'qa_reviewer',
  qaFix: 'qa_fixer',
};

export const MMO_AGENT_PROFILE: ProjectAgentProfile = {
  id: 'game-mmo',
  specOrchestrator: 'mmo_spec_orchestrator',
  buildOrchestrator: 'mmo_build_orchestrator',
  planning: 'mmo_system_designer',
  coding: 'mmo_engine_programmer',
  qaReview: 'mmo_qa_reviewer',
  qaFix: 'mmo_qa_fixer',
};

export function normalizeProjectType(projectType: ProjectType | undefined): ProjectType {
  return projectType === 'game-mmo' ? 'game-mmo' : 'general';
}

export function resolveProjectAgentProfile(projectType: ProjectType | undefined): ProjectAgentProfile {
  return normalizeProjectType(projectType) === 'game-mmo'
    ? MMO_AGENT_PROFILE
    : GENERAL_AGENT_PROFILE;
}
