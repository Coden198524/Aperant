import type {
  OpenSpecAction,
  OpenSpecBoardSnapshot,
  OpenSpecStartAction,
} from '../types';

export interface OpenSpecWorkflowActionOptions {
  preferredStartAction?: OpenSpecStartAction;
  hasChanges?: boolean;
  lastSuccessfulAction?: OpenSpecAction | null;
}

const ACTIVE_RUN_STATES = new Set([
  'queued',
  'preparing',
  'running',
  'awaiting_user',
  'cancelling',
  'interrupted',
]);

function resolveStartAction(
  available: ReadonlySet<OpenSpecAction>,
  preferred: OpenSpecStartAction,
): OpenSpecAction | null {
  if (available.has(preferred)) return preferred;
  if (available.has('new')) return 'new';
  if (available.has('propose')) return 'propose';
  if (available.has('onboard')) return 'onboard';
  if (available.has('explore')) return 'explore';
  return null;
}

/**
 * Resolves the next safe workflow action from authoritative OpenSpec status.
 *
 * This intentionally never selects archive or bulk-archive. Those actions
 * remain explicit, confirmed user operations.
 */
export function resolveOpenSpecWorkflowAction(
  snapshot: OpenSpecBoardSnapshot | null,
  options: OpenSpecWorkflowActionOptions = {},
): OpenSpecAction | null {
  if (!snapshot) return null;
  if (snapshot.activeRun && ACTIVE_RUN_STATES.has(snapshot.activeRun.state)) {
    return null;
  }

  const available = new Set(snapshot.availableActions);
  const preferredStartAction = options.preferredStartAction ?? 'new';

  if (snapshot.archived) return null;
  if (snapshot.unsupportedStatus) {
    if (available.has('verify')) return 'verify';
    if (available.has('explore')) return 'explore';
    return null;
  }
  if (!snapshot.initialized) {
    return resolveStartAction(available, preferredStartAction);
  }
  if (!snapshot.changeName) {
    return options.hasChanges
      ? null
      : resolveStartAction(available, preferredStartAction);
  }

  if (
    snapshot.artifacts.some((artifact) => artifact.status === 'ready') &&
    available.has('continue')
  ) {
    return 'continue';
  }

  const planningComplete = snapshot.artifacts.length > 0 &&
    snapshot.artifacts.every((artifact) => artifact.status === 'done');
  if (!planningComplete && available.has('ff')) {
    return 'ff';
  }

  const progress = snapshot.taskProgress;
  const implementationComplete = Boolean(
    progress &&
    progress.total > 0 &&
    progress.completed >= progress.total,
  );
  if (
    implementationComplete &&
    options.lastSuccessfulAction === 'verify'
  ) {
    return null;
  }
  if (implementationComplete && available.has('verify')) {
    return 'verify';
  }
  if (available.has('apply')) {
    return 'apply';
  }
  if (available.has('verify')) {
    return 'verify';
  }
  if (available.has('explore')) {
    return 'explore';
  }
  return null;
}
