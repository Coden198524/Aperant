import type { AgentRuntimeAdapter, AutocodeAgentRuntimePlan } from '@autocode/core';
import type { AgentManager } from './agent-manager';
import type { SpecCreationMetadata, TaskExecutionOptions } from './types';

export function createDesktopAgentRuntimeAdapter(agentManager: AgentManager): AgentRuntimeAdapter {
  return {
    startRuntime(plan: AutocodeAgentRuntimePlan): Promise<void> {
      if (plan.mode === 'direct') {
        return agentManager.startDirectTaskExecution(
          plan.taskId,
          plan.projectRoot,
          plan.specId,
          plan.options as TaskExecutionOptions,
          plan.projectId,
        );
      }

      if (plan.mode === 'spec') {
        return agentManager.startSpecCreation(
          plan.taskId,
          plan.projectRoot,
          plan.taskDescription,
          plan.specDir,
          plan.metadata as SpecCreationMetadata | undefined,
          plan.options.baseBranch,
          plan.projectId,
        );
      }

      return agentManager.startTaskExecution(
        plan.taskId,
        plan.projectRoot,
        plan.specId,
        plan.options as TaskExecutionOptions,
        plan.projectId,
      );
    },
    stopRuntime(taskId: string): void {
      agentManager.killTask(taskId);
    },
    isRuntimeRunning(taskId: string): boolean {
      return agentManager.isRunning(taskId);
    },
  };
}
