import type {
  OpenSpecAction,
  OpenSpecActionRunSummary,
  OpenSpecArtifactSnapshot,
  OpenSpecBoardSnapshot,
  OpenSpecStartAction,
} from '../../../shared/types';
import { resolveOpenSpecWorkflowAction } from '../../../shared/utils/openspec-workflow-action';

export type OpenSpecBoardColumn =
  | 'blocked'
  | 'ready'
  | 'in_progress'
  | 'done'
  | 'unsupported';

export const OPEN_SPEC_READ_ONLY_ACTIONS = new Set<OpenSpecAction>([
  'explore',
  'verify',
]);

export interface OpenSpecAutomaticAction {
  action: OpenSpecAction;
  labelKey: string;
  descriptionKey: string;
  retry?: boolean;
}

export interface OpenSpecAutomaticActionOptions {
  preferredStartAction?: OpenSpecStartAction;
  hasChanges?: boolean;
  lastRun?: OpenSpecActionRunSummary | null;
}

function resolveOpenSpecAutomaticActionFromStatus(
  snapshot: OpenSpecBoardSnapshot | null,
  options: OpenSpecAutomaticActionOptions,
): OpenSpecAutomaticAction | null {
  if (
    snapshot?.archived &&
    snapshot.availableActions.includes('new')
  ) {
    return {
      action: 'new',
      labelKey: 'tasks:openSpec.automatic.followUpIteration.label',
      descriptionKey: 'tasks:openSpec.automatic.followUpIteration.description',
    };
  }
  if (
    snapshot?.workflowStage === 'verified' &&
    snapshot.taskProgress &&
    snapshot.taskProgress.total > 0 &&
    snapshot.taskProgress.completed >= snapshot.taskProgress.total &&
    snapshot.availableActions.includes('archive')
  ) {
    return {
      action: 'archive',
      labelKey: 'tasks:openSpec.automatic.archiveVerified.label',
      descriptionKey: 'tasks:openSpec.automatic.archiveVerified.description',
    };
  }

  const action = resolveOpenSpecWorkflowAction(snapshot, {
    preferredStartAction: options.preferredStartAction,
    hasChanges: options.hasChanges,
    lastSuccessfulAction: options.lastRun?.state === 'succeeded'
      ? options.lastRun.action
      : null,
  });
  if (!snapshot) return null;

  const progress = snapshot.taskProgress;
  const implementationComplete = Boolean(
    progress &&
    progress.total > 0 &&
    progress.completed >= progress.total,
  );
  if (
    !action &&
    implementationComplete &&
    options.lastRun?.state === 'succeeded' &&
    options.lastRun.action === 'verify' &&
    snapshot.availableActions.includes('archive')
  ) {
    return {
      action: 'archive',
      labelKey: 'tasks:openSpec.automatic.archiveVerified.label',
      descriptionKey: 'tasks:openSpec.automatic.archiveVerified.description',
    };
  }
  if (!action) return null;

  if (snapshot.unsupportedStatus) {
    return {
      action,
      labelKey: 'tasks:openSpec.automatic.inspectUnsupported.label',
      descriptionKey: 'tasks:openSpec.automatic.inspectUnsupported.description',
    };
  }
  if (action === 'continue') {
    return {
      action,
      labelKey: 'tasks:openSpec.automatic.continuePlanning.label',
      descriptionKey: 'tasks:openSpec.automatic.continuePlanning.description',
    };
  }
  if (action === 'ff') {
    return {
      action,
      labelKey: 'tasks:openSpec.automatic.completePlanning.label',
      descriptionKey: 'tasks:openSpec.automatic.completePlanning.description',
    };
  }
  if (action === 'verify' && implementationComplete) {
    return {
      action,
      labelKey: 'tasks:openSpec.automatic.reviewImplementation.label',
      descriptionKey: 'tasks:openSpec.automatic.reviewImplementation.description',
    };
  }
  if (action === 'apply') {
    return {
      action,
      labelKey: progress?.completed
        ? 'tasks:openSpec.automatic.continueImplementation.label'
        : 'tasks:openSpec.automatic.startImplementation.label',
      descriptionKey: 'tasks:openSpec.automatic.implementation.description',
    };
  }
  if (action === 'verify') {
    return {
      action,
      labelKey: 'tasks:openSpec.automatic.reviewWorkflow.label',
      descriptionKey: 'tasks:openSpec.automatic.reviewWorkflow.description',
    };
  }
  if (action === 'explore') {
    const startingWorkflow = !snapshot.initialized || !snapshot.changeName;
    return {
      action,
      labelKey: startingWorkflow
        ? 'tasks:openSpec.automatic.explore.label'
        : 'tasks:openSpec.automatic.inspectWorkflow.label',
      descriptionKey: startingWorkflow
        ? 'tasks:openSpec.automatic.explore.description'
        : 'tasks:openSpec.automatic.inspectWorkflow.description',
    };
  }
  return {
    action,
    labelKey: 'tasks:openSpec.automatic.start.label',
    descriptionKey: 'tasks:openSpec.automatic.start.description',
  };
}

const TRANSIENT_OPEN_SPEC_RUN_ERROR =
  /\b(?:temporarily unavailable|service[_ ]unavailable|server[_ ]is[_ ]overloaded|server[_ ]error|overloaded|try again later|network error|rate limit)\b/i;

export function isOpenSpecTransientRunFailure(
  run: OpenSpecActionRunSummary | null | undefined,
): boolean {
  return run?.state === 'failed' &&
    typeof run.error === 'string' &&
    TRANSIENT_OPEN_SPEC_RUN_ERROR.test(run.error);
}

/**
 * Picks one user-facing workflow intent from official OpenSpec status.
 *
 * The UI never asks the user to choose between OpenSpec command names. The
 * selected action still executes its byte-identical official prompt, and the
 * model invokes the status/instructions commands required by that workflow.
 */
export function resolveOpenSpecAutomaticAction(
  snapshot: OpenSpecBoardSnapshot | null,
  options: OpenSpecAutomaticActionOptions = {},
): OpenSpecAutomaticAction | null {
  const action = resolveOpenSpecAutomaticActionFromStatus(snapshot, options);
  if (!action || !isOpenSpecTransientRunFailure(options.lastRun)) return action;

  return {
    ...action,
    labelKey: 'tasks:openSpec.automatic.retry.label',
    descriptionKey: 'tasks:openSpec.automatic.retry.description',
    retry: true,
  };
}

export function openSpecArtifactColumn(
  artifact: OpenSpecArtifactSnapshot,
): OpenSpecBoardColumn {
  if (artifact.inProgress) return 'in_progress';
  switch (artifact.status) {
    case 'blocked':
      return 'blocked';
    case 'ready':
      return 'ready';
    case 'done':
      return 'done';
    case 'unknown':
      return 'unsupported';
  }
}

export function isOpenSpecActionDisabled(input: {
  snapshot: OpenSpecBoardSnapshot | null;
  action: OpenSpecAction;
  actionRunning: boolean;
  pending: boolean;
}): boolean {
  const available = input.snapshot?.availableActions.includes(input.action) === true;
  const failClosed = input.snapshot?.unsupportedStatus === true &&
    !OPEN_SPEC_READ_ONLY_ACTIONS.has(input.action);
  return !available || input.actionRunning || input.pending || failClosed;
}
