/**
 * Cross-process contracts for the OpenSpec-backed Spec development mode.
 *
 * These are Aperant transport/view types. Raw OpenSpec CLI responses are
 * validated and adapted in the main process before crossing IPC.
 */

export const OPEN_SPEC_VERSION = '1.6.0' as const;
export const OPEN_SPEC_TARBALL_SHA1 = '00b6f63e9671153b8621466a9ed423792349b54f' as const;
export const OPEN_SPEC_ARTIFACT_REFRESH_REQUIRED_ERROR_CODE =
  'OPEN_SPEC_ARTIFACT_REFRESH_REQUIRED' as const;

export function isOpenSpecArtifactRefreshRequiredError(
  value: unknown,
): boolean {
  const message = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : value &&
          typeof value === 'object' &&
          'message' in value &&
          typeof (value as { message?: unknown }).message === 'string'
        ? (value as { message: string }).message
        : '';
  return message.includes(OPEN_SPEC_ARTIFACT_REFRESH_REQUIRED_ERROR_CODE);
}

export const OPEN_SPEC_ACTIONS = [
  'explore',
  'propose',
  'apply',
  'update',
  'sync',
  'archive',
  'new',
  'continue',
  'ff',
  'verify',
  'bulk-archive',
  'onboard',
] as const;

export type OpenSpecAction = (typeof OPEN_SPEC_ACTIONS)[number];

export type OpenSpecStartAction = Extract<OpenSpecAction, 'new' | 'propose' | 'explore'>;
export type OpenSpecRootKind = 'project' | 'store';
export type OpenSpecWorkflowStage =
  | 'planning'
  | 'implementation'
  | 'verified'
  | 'archived';

export interface OpenSpecTaskConfig {
  formatVersion?: 1;
  startAction?: OpenSpecStartAction;
  rootKind?: OpenSpecRootKind;
  storeId?: string;
  changeName?: string;
  schemaName?: string;
}

export type OpenSpecArtifactStatus = 'blocked' | 'ready' | 'done' | 'unknown';
export type OpenSpecRunState =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'awaiting_user'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface OpenSpecArtifactSnapshot {
  id: string;
  description?: string;
  outputPath: string;
  status: OpenSpecArtifactStatus;
  missingDeps: string[];
  existingOutputPaths: string[];
  dependencies: string[];
  unlocks: string[];
  instruction?: string;
  template?: string;
  inProgress: boolean;
  modifiedAt?: string;
  blocksApply: boolean;
  checklist?: {
    completed: number;
    total: number;
  };
  metrics?: {
    requirements?: number;
    scenarios?: number;
  };
}

export interface OpenSpecActionRunSummary {
  runId: string;
  action: OpenSpecAction;
  state: OpenSpecRunState;
  startedAt: string;
  completedAt?: string;
  error?: string;
  durationMs?: number;
  interactionCount?: number;
  recoverable?: boolean;
  waitingReason?: string;
}

export type OpenSpecPlanningChangeKind = 'created' | 'modified' | 'deleted';

export interface OpenSpecPlanningFileChange {
  relativePath: string;
  kind: OpenSpecPlanningChangeKind;
  patch: string;
}

export interface OpenSpecPlanningReview {
  runId: string;
  state: 'ready' | 'error';
  createdAt: string;
  completedAt: string;
  changes: OpenSpecPlanningFileChange[];
  error?: string;
}

export interface OpenSpecPlanningReviewSummary {
  runId: string;
  state: OpenSpecPlanningReview['state'];
  createdAt: string;
  completedAt: string;
  changeCount: number;
  error?: string;
}

export interface OpenSpecPlanningReviewInput {
  taskId: string;
  projectId?: string;
  runId: string;
}

export interface OpenSpecValidationIssue {
  path?: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface OpenSpecValidationSummary {
  valid: boolean;
  checkedAt: string;
  issues: OpenSpecValidationIssue[];
}

export interface OpenSpecActionContextSnapshot {
  planningHome: {
    kind?: string;
    root: string;
    changesDir?: string;
    defaultSchema?: string;
  };
  mode?: string;
  sourceOfTruth?: string;
  linkedContext: string[];
  allowedEditRoots: string[];
  requiresAffectedAreaSelection: boolean;
  constraints: string[];
}

export interface OpenSpecBoardSnapshot {
  taskId: string;
  openSpecVersion: typeof OPEN_SPEC_VERSION;
  rootKind: OpenSpecRootKind;
  rootLabel: string;
  initialized: boolean;
  changeName: string | null;
  schema: {
    name: string;
    version?: number;
    description?: string;
  };
  artifacts: OpenSpecArtifactSnapshot[];
  applyRequires: string[];
  taskProgress?: {
    completed: number;
    total: number;
  };
  workflowStage?: OpenSpecWorkflowStage;
  actionContext?: OpenSpecActionContextSnapshot;
  activeRun: OpenSpecActionRunSummary | null;
  validation: OpenSpecValidationSummary | null;
  nextSteps: string[];
  availableActions: OpenSpecAction[];
  rawStatus?: unknown;
  unsupportedStatus?: boolean;
  archived: boolean;
  revision: number;
}

export interface RunOpenSpecActionInput {
  taskId: string;
  projectId?: string;
  action: OpenSpecAction;
  changeName?: string;
  arguments?: string;
  selectedChanges?: string[];
  confirmed?: boolean;
}

export interface ResumeOpenSpecActionInput {
  taskId: string;
  projectId?: string;
  runId: string;
  confirmed?: boolean;
}

export interface OpenSpecInteraction {
  interactionId: string;
  runId: string;
  taskId: string;
  prompt: string;
  createdAt: string;
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{
      label: string;
      description?: string;
    }>;
    multiSelect?: boolean;
  }>;
}

export interface AnswerOpenSpecInteractionInput {
  taskId: string;
  projectId?: string;
  runId: string;
  interactionId: string;
  answer: string;
}

export interface ReadOpenSpecArtifactInput {
  taskId: string;
  projectId?: string;
  expectedChangeName: string;
  artifactId: string;
  relativePath?: string;
}

export interface OpenSpecArtifactContent {
  artifactId: string;
  relativePath: string;
  content: string;
  modifiedAt: string;
}

export interface OpenSpecArtifactDiff {
  artifactId: string;
  relativePath: string;
  patch: string;
  base: 'git' | 'action-snapshot' | 'unavailable';
}

export interface GetOpenSpecArtifactDiffInput extends ReadOpenSpecArtifactInput {}

export interface ValidateOpenSpecInput {
  taskId: string;
  projectId?: string;
  changeName?: string;
  strict?: boolean;
}

export interface ConfirmOpenSpecActionInput extends RunOpenSpecActionInput {
  confirmationId: string;
}

export interface OpenSpecChangeSummary {
  name: string;
  completedTasks: number;
  totalTasks: number;
  lastModified?: string;
  status: string;
  archived?: boolean;
}

export interface OpenSpecRunLog {
  runId: string;
  content: string;
  truncated: boolean;
}

export interface OpenSpecActivityLog {
  segments: OpenSpecRunLog[];
  truncated: boolean;
}

export interface OpenSpecActionHistory {
  runs: OpenSpecActionRunSummary[];
  activeRun: OpenSpecActionRunSummary | null;
  waitingInteraction: OpenSpecInteraction | null;
  activityLog: OpenSpecActivityLog;
  latestRunLog: OpenSpecRunLog | null;
  pendingPlanningReview: OpenSpecPlanningReviewSummary | null;
}

export interface OpenSpecPreflightInput {
  projectId: string;
  rootKind?: OpenSpecRootKind;
  storeId?: string;
  schemaName?: string;
  changeName?: string;
  startAction?: OpenSpecStartAction;
  useWorktree?: boolean;
}

export type OpenSpecPreflightCheckCode =
  | 'version'
  | 'project-root'
  | 'worktree'
  | 'store'
  | 'schema'
  | 'change';

export interface OpenSpecPreflightCheck {
  code: OpenSpecPreflightCheckCode;
  ok: boolean;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface OpenSpecPreflightResult {
  valid: boolean;
  openSpecVersion: typeof OPEN_SPEC_VERSION;
  rootKind: OpenSpecRootKind;
  rootLabel: string;
  initialized: boolean;
  schemaName: string;
  availableSchemas: string[];
  registeredStores: string[];
  changeExists: boolean;
  checks: OpenSpecPreflightCheck[];
}

export interface OpenSpecPromptManifestEntry {
  action: OpenSpecAction;
  sha256: string;
  byteLength: number;
}

export type OpenSpecRendererEvent =
  | { type: 'snapshot'; revision: number; snapshot: OpenSpecBoardSnapshot }
  | { type: 'run-state'; run: OpenSpecActionRunSummary }
  | { type: 'planning-review'; review: OpenSpecPlanningReviewSummary }
  | { type: 'output'; runId: string; sequence: number; text: string }
  | { type: 'interaction-required'; interaction: OpenSpecInteraction }
  | { type: 'validation'; validation: OpenSpecValidationSummary }
  | { type: 'error'; code: string; message: string };
