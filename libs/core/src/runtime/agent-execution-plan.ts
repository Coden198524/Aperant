export type AutocodeAgentExecutionKind =
  | 'build-orchestrator'
  | 'qa-loop'
  | 'spec-orchestrator'
  | 'spec-orchestrator-agentic'
  | 'default-session';

export interface AutocodeAgentExecutionPlanInput {
  agentType: string;
  workflowMode?: string;
  useAgenticOrchestration?: boolean;
}

export interface AutocodeAgentExecutionPlan {
  kind: AutocodeAgentExecutionKind;
  agentType: string;
  directTask: boolean;
}

export function resolveAutocodeAgentExecutionPlan(
  input: AutocodeAgentExecutionPlanInput,
): AutocodeAgentExecutionPlan {
  if (input.agentType === 'build_orchestrator' || input.agentType === 'mmo_build_orchestrator') {
    return { kind: 'build-orchestrator', agentType: input.agentType, directTask: false };
  }

  if (input.agentType === 'qa_reviewer' || input.agentType === 'mmo_qa_reviewer') {
    return { kind: 'qa-loop', agentType: input.agentType, directTask: false };
  }

  if (input.agentType === 'spec_orchestrator' || input.agentType === 'mmo_spec_orchestrator') {
    return {
      kind: input.useAgenticOrchestration ? 'spec-orchestrator-agentic' : 'spec-orchestrator',
      agentType: input.agentType,
      directTask: false,
    };
  }

  return {
    kind: 'default-session',
    agentType: input.agentType,
    directTask: isAutocodeDirectTaskExecution(input),
  };
}

export function isAutocodeDirectTaskExecution(input: {
  agentType: string;
  workflowMode?: string;
}): boolean {
  return input.agentType === 'direct_task' || input.workflowMode === 'off';
}

export function isAutocodeSuccessfulAgentSessionOutcome(
  outcome: string | undefined,
): boolean {
  return outcome === 'completed'
    || outcome === 'max_steps'
    || outcome === 'context_window';
}
