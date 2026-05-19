import { describe, expect, it } from 'vitest';

import { resolveProjectAgentProfile } from '../project-agent-profile';

describe('resolveProjectAgentProfile', () => {
  it('defaults to the general software agent profile', () => {
    const profile = resolveProjectAgentProfile(undefined);

    expect(profile).toMatchObject({
      id: 'general',
      specOrchestrator: 'spec_orchestrator',
      buildOrchestrator: 'build_orchestrator',
      planning: 'planner',
      coding: 'coder',
      qaReview: 'qa_reviewer',
      qaFix: 'qa_fixer',
    });
  });

  it('routes MMO projects to game and engine oriented agents', () => {
    const profile = resolveProjectAgentProfile('game-mmo');

    expect(profile).toMatchObject({
      id: 'game-mmo',
      specOrchestrator: 'mmo_spec_orchestrator',
      buildOrchestrator: 'mmo_build_orchestrator',
      planning: 'mmo_system_designer',
      coding: 'mmo_engine_programmer',
      qaReview: 'mmo_qa_reviewer',
      qaFix: 'mmo_qa_fixer',
    });
  });
});
