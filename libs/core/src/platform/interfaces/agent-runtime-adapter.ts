import type { AutocodeAgentRuntimePlan } from '../../runtime/agent-runtime.js';

export interface AgentRuntimeAdapter {
  startRuntime(plan: AutocodeAgentRuntimePlan): Promise<void> | void;
  stopRuntime(taskId: string, projectId?: string): Promise<void> | void;
  isRuntimeRunning?(taskId: string, projectId?: string): boolean;
}
