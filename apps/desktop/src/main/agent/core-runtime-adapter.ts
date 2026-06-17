import type {
  AgentRuntimeAdapter,
  AutocodeAgentRuntimeStartRequest,
  AutocodeAgentRuntimeStartResult,
} from '@autocode/core';
import { createAutocodeAgentTaskController } from '@autocode/core/runtime/agent-task-controller';
import type { AgentManager } from './agent-manager';
import type { SpecCreationMetadata, TaskExecutionOptions } from './types';

export function createDesktopAgentRuntimeAdapter(agentManager: AgentManager): AgentRuntimeAdapter {
  const taskController = createAutocodeAgentTaskController();
  const startDesktopRuntime = async (
    request: AutocodeAgentRuntimeStartRequest,
  ): Promise<AutocodeAgentRuntimeStartResult> => {
    const { plan } = request;
    if (plan.mode === 'direct') {
      await agentManager.startDirectTaskExecution(
        plan.taskId,
        plan.projectRoot,
        plan.specId,
        plan.options as TaskExecutionOptions,
        plan.projectId,
      );
    } else if (plan.mode === 'spec') {
      await agentManager.startSpecCreation(
        plan.taskId,
        plan.projectRoot,
        plan.taskDescription,
        plan.specDir,
        plan.metadata as SpecCreationMetadata | undefined,
        plan.options.baseBranch,
        plan.projectId,
      );
    } else {
      await agentManager.startTaskExecution(
        plan.taskId,
        plan.projectRoot,
        plan.specId,
        plan.options as TaskExecutionOptions,
        plan.projectId,
      );
    }

    return {
      runtimeId: request.runtimeId,
      status: 'started',
      message: request.messages.started,
    };
  };

  return {
    startRuntime(request: AutocodeAgentRuntimeStartRequest): Promise<AutocodeAgentRuntimeStartResult> {
      return taskController.start(request, { startRuntime: startDesktopRuntime });
    },
    stopRuntime(taskId: string, projectId?: string): void {
      agentManager.killTask(taskId, projectId);
    },
    isRuntimeRunning(taskId: string, projectId?: string): boolean {
      return agentManager.isRunning(taskId, projectId);
    },
  };
}
