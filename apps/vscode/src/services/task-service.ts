import {
  buildAutocodeTaskRunnerShellCommand,
  buildAutocodeWorkspaceState,
  createAutocodeAgentRuntimeStartPlan,
  createAutocodeTaskRunPlan,
  createManualAutocodeTask,
  createStartedAutocodeTaskRun,
  markAutocodeTaskDone,
  markAutocodeTaskStopped,
  requestAutocodeTaskChanges,
  updateAutocodeTaskPlanStatus,
  type AutocodeCli,
} from '@autocode/core';
import { getConfiguredDataDirName } from '../adapters/workspace-adapter.js';

export function listState(projectRoot: string) {
  const dataDirName = getConfiguredDataDirName();
  return buildAutocodeWorkspaceState({ projectRoot, dataDirName });
}

export function createManualTask(projectRoot: string, title: string, description: string) {
  return createManualAutocodeTask({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    title,
    description,
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

export function createStartedRunPlan(projectRoot: string, taskId: string, options: {
  cli: AutocodeCli;
  customCommand?: string;
  bypassPermissions: boolean;
}) {
  return createStartedAutocodeTaskRun({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    taskId,
    cli: options.cli,
    customCommand: options.customCommand,
    bypassPermissions: options.bypassPermissions,
  });
}

export function createAgentRuntimeStartPlan(projectRoot: string, taskId: string) {
  return createAutocodeAgentRuntimeStartPlan({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    taskId,
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
  return markAutocodeTaskStopped({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    taskId,
    phase,
    message: 'Task stopped from VS Code.',
  });
}

export function markTaskDoneStatus(projectRoot: string, taskId: string) {
  return markAutocodeTaskDone({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    taskId,
  });
}

export function requestTaskChangesStatus(projectRoot: string, taskId: string) {
  return requestAutocodeTaskChanges({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    taskId,
  });
}
