import {
  createAutocodeAgentRuntimeStartRequest,
  getAutocodeAgentRuntimeModeLabel,
  resolveAutocodeTaskStartEvent,
  startAutocodeAgentRuntime,
  type AutocodeAgentRuntimePlan,
  type AutocodeAgentRuntimeStartRequest,
  type AutocodeAgentRuntimeStartResult,
  type AutocodeAgentRuntimeStarter,
  type AutocodeAgentRuntimeTaskInput,
  type AutocodeTaskStartEvent,
  type CreateAutocodeAgentRuntimeStartRequestOptions,
} from './agent-runtime.js';

export interface AutocodeAgentTaskControllerDecisionInput {
  plan: AutocodeAgentRuntimePlan;
  task: Pick<AutocodeAgentRuntimeTaskInput, 'status' | 'reviewReason' | 'metadata'>;
  currentState?: string | null;
  planHasSubtasks: boolean;
  startRequestOptions?: CreateAutocodeAgentRuntimeStartRequestOptions;
}

export interface AutocodeAgentTaskControllerDecision {
  plan: AutocodeAgentRuntimePlan;
  label: string;
  startEvent: AutocodeTaskStartEvent;
  startRequest: AutocodeAgentRuntimeStartRequest;
}

export class AutocodeAgentTaskController {
  createDecision(input: AutocodeAgentTaskControllerDecisionInput): AutocodeAgentTaskControllerDecision {
    const label = getAutocodeAgentRuntimeModeLabel(input.plan.mode);
    const startEvent = resolveAutocodeTaskStartEvent({
      task: input.task,
      currentState: input.currentState,
      planHasSubtasks: input.planHasSubtasks,
    });

    return {
      plan: input.plan,
      label,
      startEvent,
      startRequest: createAutocodeAgentRuntimeStartRequest(input.plan, input.startRequestOptions),
    };
  }

  start(
    requestOrPlan: AutocodeAgentRuntimeStartRequest | AutocodeAgentRuntimePlan,
    starter: AutocodeAgentRuntimeStarter,
  ): Promise<AutocodeAgentRuntimeStartResult> {
    return startAutocodeAgentRuntime(requestOrPlan, starter);
  }

  startDecision(
    decision: AutocodeAgentTaskControllerDecision,
    starter: AutocodeAgentRuntimeStarter,
  ): Promise<AutocodeAgentRuntimeStartResult> {
    return this.start(decision.startRequest, starter);
  }
}

export function createAutocodeAgentTaskController(): AutocodeAgentTaskController {
  return new AutocodeAgentTaskController();
}
