import {
  buildAutocodeTaskRunnerShellCommand,
  buildAutocodeWorkspaceState,
  createAutocodeProjectDocumentationTask,
  createAutocodeTaskRunPlan,
  createManualAutocodeTask,
  createStartedAutocodeAgentRuntime,
  createStartedAutocodeTaskRun,
  detectProviderFromModel,
  markAutocodeTaskDone,
  parseAutocodeCliRuntimeRoutes,
  parseAutocodeModelProviderRoutes,
  markAutocodeTaskStopped,
  requestAutocodeTaskChanges,
  resolveAutocodeCliRuntimeStartOptions,
  updateAutocodeTaskPlanStatus,
  type AutocodeCli,
  type AutocodeProjectDocType,
} from '@autocode/core';
import { getConfiguredDataDirName } from '../adapters/workspace-adapter.js';

type VscodeTaskDevelopmentMode = 'direct' | 'standard';

export function listState(projectRoot: string) {
  const dataDirName = getConfiguredDataDirName();
  return buildAutocodeWorkspaceState({ projectRoot, dataDirName });
}

export function createManualTask(projectRoot: string, title: string, description: string, options: {
  developmentMode?: VscodeTaskDevelopmentMode;
} = {}) {
  return createManualAutocodeTask({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    title,
    description,
    metadata: { developmentMode: options.developmentMode ?? 'standard' },
  });
}

export function createProjectDocumentationTask(projectRoot: string, options: {
  documentType?: AutocodeProjectDocType;
  outputDir?: string;
} = {}) {
  return createAutocodeProjectDocumentationTask({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    documentType: options.documentType,
    outputDir: options.outputDir,
  });
}

export function createRunPlan(projectRoot: string, taskId: string, options: {
  cli: AutocodeCli;
  customCommand?: string;
  bypassPermissions: boolean;
}) {
  const runtimeInput = resolveVscodeCliRuntimeInput(projectRoot, taskId, options);
  return createAutocodeTaskRunPlan({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    taskId,
    ...runtimeInput,
    bypassPermissions: options.bypassPermissions,
  });
}

export function createStartedRunPlan(projectRoot: string, taskId: string, options: {
  cli: AutocodeCli;
  customCommand?: string;
  bypassPermissions: boolean;
}) {
  const runtimeInput = resolveVscodeCliRuntimeInput(projectRoot, taskId, options);
  return createStartedAutocodeTaskRun({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    taskId,
    ...runtimeInput,
    bypassPermissions: options.bypassPermissions,
  });
}

export function createStartedAgentRuntime(projectRoot: string, taskId: string, options: {
  cli: AutocodeCli;
  customCommand?: string;
  bypassPermissions: boolean;
}) {
  const runtimeInput = resolveVscodeCliRuntimeInput(projectRoot, taskId, options);
  return createStartedAutocodeAgentRuntime({
    projectRoot,
    dataDirName: getConfiguredDataDirName(),
    taskId,
    ...runtimeInput,
    bypassPermissions: options.bypassPermissions,
  });
}

function resolveVscodeCliRuntimeInput(projectRoot: string, taskId: string, options: {
  cli: AutocodeCli;
  customCommand?: string;
}) {
  const dataDirName = getConfiguredDataDirName();
  const task = buildAutocodeWorkspaceState({ projectRoot, dataDirName, includeLogs: false }).tasks
    .find((candidate) => candidate.id === taskId || candidate.specId === taskId);
  const model = typeof task?.metadata?.model === 'string' && task.metadata.model.trim()
    ? task.metadata.model.trim()
    : undefined;
  const provider = typeof task?.metadata?.provider === 'string' && task.metadata.provider.trim()
    ? task.metadata.provider.trim()
    : model ? detectProviderFromModel(model, readEnvModelProviderRoutes()) : undefined;
  const resolved = resolveAutocodeCliRuntimeStartOptions({
    cli: options.cli,
    customCommand: options.customCommand,
    provider,
    modelId: model,
    routes: readEnvCliRuntimeRoutes(),
  });

  return {
    cli: resolved.cli,
    customCommand: resolved.customCommand,
    model,
    directCliContinuationStrategy: resolved.directCliContinuationStrategy,
    directCliJsonEventParser: resolved.directCliJsonEventParser,
    directCliRuntimeRouteId: resolved.directCliRuntimeRouteId,
    directCliRuntimeRouteDisplayName: resolved.directCliRuntimeRouteDisplayName,
    directCliPermissionBypassArgs: resolved.directCliPermissionBypassArgs,
    directCliTaskRunStrategy: resolved.directCliTaskRunStrategy,
    directCliPreflightActions: resolved.directCliPreflightActions,
  };
}

function readEnvCliRuntimeRoutes(): ReturnType<typeof parseAutocodeCliRuntimeRoutes> {
  const raw = process.env.AUTOCODE_CLI_RUNTIME_ROUTES_JSON ?? process.env.AUTOCODE_CLI_RUNTIME_ROUTES;
  if (!raw?.trim()) {
    return [];
  }
  try {
    return parseAutocodeCliRuntimeRoutes(JSON.parse(raw));
  } catch {
    return [];
  }
}

function readEnvModelProviderRoutes(): ReturnType<typeof parseAutocodeModelProviderRoutes> {
  const raw = process.env.AUTOCODE_MODEL_PROVIDER_ROUTES_JSON ?? process.env.AUTOCODE_MODEL_PROVIDER_ROUTES;
  if (!raw?.trim()) {
    return [];
  }
  try {
    return parseAutocodeModelProviderRoutes(JSON.parse(raw));
  } catch {
    return [];
  }
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
