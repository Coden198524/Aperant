import {
  buildAutocodeTaskRunnerShellCommand,
  buildProjectIndex,
  createAutocodeTask,
  createAutocodeTaskRunPlan,
  listAutocodeTasks,
  readAutocodeTaskLogs,
  summarizeWorkspace,
  updateAutocodeTaskLogPhase,
  updateAutocodeTaskPlanStatus,
  type AutocodeCli,
  type AutocodeTaskMetadata,
} from '@autocode/core';
import { getConfiguredDataDirName } from '../adapters/workspace-adapter.js';

export function listState(projectRoot: string) {
  const dataDirName = getConfiguredDataDirName();
  const tasks = listAutocodeTasks({ projectRoot, dataDirName });

  return {
    projectRoot,
    dataDirName,
    summary: summarizeWorkspace(projectRoot),
    projectIndex: buildProjectIndex(projectRoot),
    tasks,
    logsByTaskId: Object.fromEntries(
      tasks.map((task) => [
        task.id,
        readAutocodeTaskLogs({
          projectRoot,
          dataDirName,
          taskId: task.id,
        }),
      ]),
    ),
  };
}

export function createManualTask(projectRoot: string, title: string, description: string) {
  const metadata: AutocodeTaskMetadata = {
    sourceType: 'manual',
    workflowMode: 'balanced',
    enableBatchExecution: false,
  };

  return createAutocodeTask({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    title,
    description,
    metadata,
  });
}

export function createRunPlan(projectRoot: string, taskId: string, options: {
  cli: AutocodeCli;
  customCommand?: string;
  bypassPermissions: boolean;
}) {
  return createAutocodeTaskRunPlan({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    taskId,
    cli: options.cli,
    customCommand: options.customCommand,
    bypassPermissions: options.bypassPermissions,
  });
}

export function buildRunCommand(plan: Parameters<typeof buildAutocodeTaskRunnerShellCommand>[0]) {
  return buildAutocodeTaskRunnerShellCommand(plan);
}

export function markTaskStatus(projectRoot: string, taskId: string, input: {
  planStatus: Parameters<typeof updateAutocodeTaskPlanStatus>[0]['planStatus'];
  executionPhase: Parameters<typeof updateAutocodeTaskPlanStatus>[0]['executionPhase'];
  reviewReason?: Parameters<typeof updateAutocodeTaskPlanStatus>[0]['reviewReason'];
}) {
  return updateAutocodeTaskPlanStatus({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    taskId,
    planStatus: input.planStatus,
    executionPhase: input.executionPhase,
    reviewReason: input.reviewReason,
  });
}

export function markTaskLogFailed(projectRoot: string, taskId: string, phase: 'planning' | 'coding') {
  return updateAutocodeTaskLogPhase({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    taskId,
    phase,
    status: 'failed',
    message: 'Task stopped from VS Code.',
  });
}
