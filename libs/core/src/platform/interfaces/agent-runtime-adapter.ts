import type { AutocodeAgentRuntimeStarter } from '../../runtime/agent-runtime.js';

export interface AgentRuntimeAdapter extends AutocodeAgentRuntimeStarter {
  stopRuntime(taskId: string, projectId?: string): Promise<void> | void;
  isRuntimeRunning?(taskId: string, projectId?: string): boolean;
}
