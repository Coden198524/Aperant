import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type {
  OpenSpecAction,
  OpenSpecActionRunSummary,
  OpenSpecBoardSnapshot,
  OpenSpecInteraction,
  OpenSpecPlanningReview,
  OpenSpecPlanningReviewSummary,
  OpenSpecRendererEvent,
  Project,
  ReviewReason,
  ResumeOpenSpecActionInput,
  RunOpenSpecActionInput,
  Task,
  TaskLogStreamChunk,
} from '../../shared/types';
import type { WorkerOpenSpecInteractionRequiredMessage } from '../ai/agent/types';
import type { SessionResult } from '../ai/session/types';
import type { AgentManager } from '../agent';
import {
  assertPinnedOpenSpecPackage,
  ensureOpenSpecCommandShim,
} from './openspec-package';
import { OpenSpecCliAdapter } from './openspec-cli-adapter';
import { OpenSpecGitBaselineGuard } from './openspec-git-baseline';
import { OpenSpecLockManager } from './openspec-lock-manager';
import { OpenSpecPromptRegistry, OPEN_SPEC_ACTIONS } from './openspec-prompt-registry';
import {
  OpenSpecPlanningReviewStore,
  summarizeOpenSpecPlanningReview,
} from './openspec-planning-review-store';
import { OpenSpecRootResolver } from './openspec-root-resolver';
import {
  OpenSpecRuntimeStore,
  type OpenSpecWorkflowStage,
} from './openspec-runtime-store';
import { OpenSpecStatusService } from './openspec-status-service';

const MAX_ARGUMENT_LENGTH = 32_000;
const READ_ONLY_ACTIONS = new Set<OpenSpecAction>(['explore', 'verify']);
const CONFIRMATION_ACTIONS = new Set<OpenSpecAction>(['archive', 'bulk-archive']);
const IMPLEMENTATION_ACTIONS = new Set<OpenSpecAction>(['apply', 'onboard']);
const DEFAULT_SCHEMA_NAME = 'spec-driven';
const TRUSTED_ADR_SCHEMA_NAME = 'spec-driven-with-adr';
const SAFE_SCHEMA_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SAFE_CHANGE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;
const MAX_AUTOMATIC_CONTINUE_DEPTH = 12;
const MAX_CONTINUE_DIRECTIVE_TEXT_LENGTH = 64 * 1024;
const AUTOMATIC_CONTINUE_SOURCE_ACTIONS = new Set<OpenSpecAction>([
  'new',
  'propose',
  'continue',
]);
const PLANNING_WORKFLOW_ACTIONS = new Set<OpenSpecAction>([
  'new',
  'propose',
  'continue',
  'ff',
  'update',
  'sync',
]);
const ADR_ARTIFACT_WRITING_ACTIONS = new Set<OpenSpecAction>([
  'propose',
  'continue',
  'ff',
  'update',
]);

interface OpenSpecSchemaResolution {
  name: string;
  source: string;
  path: string;
}

interface ActiveRun {
  task: Task;
  project: Project;
  summary: OpenSpecActionRunSummary;
  controller: AbortController;
  releaseLocks?: () => void;
  sequence: number;
  outputEndsWithNewline: boolean;
  lastError?: string;
  interactionCount: number;
  cancelled: boolean;
  finished: boolean;
  automaticContinueDepth: number;
  requestedChangeName?: string;
  observedChangeName?: string;
  sessionOutcome?: SessionResult['outcome'];
  finalAssistantText: string;
  startStatusFingerprint?: string;
  planningReviewWritePaths?: string[];
  resumedFromRunId?: string;
  cleanupListeners?: () => void;
}

type AutomaticContinueStopReason =
  | 'source_action'
  | 'session_outcome'
  | 'cancelled'
  | 'agent_error'
  | 'no_directive'
  | 'unavailable'
  | 'limit'
  | 'stalled';

type AutomaticContinueDecision =
  | { kind: 'start'; changeName: string }
  | { kind: 'stop'; reason: AutomaticContinueStopReason };

interface AutomaticContinueDecisionInput {
  action: OpenSpecAction;
  sessionOutcome?: SessionResult['outcome'];
  cancelled: boolean;
  lastError?: string;
  finalAssistantText: string;
  automaticContinueDepth: number;
  startStatusFingerprint?: string;
  snapshot: OpenSpecBoardSnapshot;
}

type AutomaticVerifyStopReason =
  | 'source_action'
  | 'action_outcome'
  | 'session_outcome'
  | 'cancelled'
  | 'agent_error'
  | 'incomplete'
  | 'unavailable';

type AutomaticVerifyDecision =
  | { kind: 'start'; changeName: string }
  | { kind: 'stop'; reason: AutomaticVerifyStopReason };

interface AutomaticVerifyDecisionInput {
  action: OpenSpecAction;
  actionOutcome: 'succeeded' | 'failed' | 'cancelled';
  sessionOutcome?: SessionResult['outcome'];
  cancelled: boolean;
  lastError?: string;
  snapshot: OpenSpecBoardSnapshot;
}

interface OpenSpecReconcileOptions {
  selectedChangeName?: string;
}

interface FinishedTaskLifecycle {
  taskStatus: Task['status'];
  reviewReason: ReviewReason | null;
  workflowStage: OpenSpecWorkflowStage;
  executionPhase: string;
}

export type OpenSpecEventPublisher = (
  task: Task,
  project: Project,
  event: OpenSpecRendererEvent,
) => void;

function activeRunKey(task: Task, project: Project): string {
  return `${project.id}::${task.id}`;
}

function workflowStageForStartedAction(
  action: OpenSpecAction,
  current: OpenSpecWorkflowStage | undefined,
): OpenSpecWorkflowStage {
  if (action === 'apply') return 'implementation';
  if (PLANNING_WORKFLOW_ACTIONS.has(action)) return 'planning';
  return current ?? 'planning';
}

function implementationChecklistComplete(
  snapshot: OpenSpecBoardSnapshot,
): boolean {
  return Boolean(
    snapshot.taskProgress &&
    snapshot.taskProgress.total > 0 &&
    snapshot.taskProgress.completed >= snapshot.taskProgress.total,
  );
}

function resolveFinishedTaskLifecycle(input: {
  action: OpenSpecAction;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  currentStage: OpenSpecWorkflowStage;
  snapshot: OpenSpecBoardSnapshot;
  automaticContinueStarting: boolean;
  automaticVerifyStarting?: boolean;
  archivedSelectedChange: boolean;
}): FinishedTaskLifecycle {
  if (input.outcome === 'failed') {
    return {
      taskStatus: 'error',
      reviewReason: 'errors',
      workflowStage: input.currentStage,
      executionPhase: 'failed',
    };
  }
  if (input.outcome === 'cancelled') {
    return {
      taskStatus: 'human_review',
      reviewReason: 'stopped',
      workflowStage: input.currentStage,
      executionPhase: 'stopped',
    };
  }
  if (input.automaticContinueStarting) {
    return {
      taskStatus: 'in_progress',
      reviewReason: null,
      workflowStage: 'planning',
      executionPhase: 'planning',
    };
  }
  if (input.automaticVerifyStarting) {
    return {
      taskStatus: 'in_progress',
      reviewReason: null,
      workflowStage: 'implementation',
      executionPhase: 'verify',
    };
  }
  if (
    (input.action === 'archive' || input.action === 'bulk-archive') &&
    input.archivedSelectedChange
  ) {
    return {
      taskStatus: 'done',
      reviewReason: null,
      workflowStage: 'archived',
      executionPhase: 'complete',
    };
  }
  if (
    input.action === 'verify' &&
    implementationChecklistComplete(input.snapshot)
  ) {
    return {
      taskStatus: 'human_review',
      reviewReason: 'completed',
      workflowStage: 'verified',
      executionPhase: 'complete',
    };
  }
  if (
    input.action === 'apply' &&
    implementationChecklistComplete(input.snapshot)
  ) {
    return {
      taskStatus: 'human_review',
      reviewReason: 'completed',
      workflowStage: 'implementation',
      executionPhase: 'complete',
    };
  }
  if (PLANNING_WORKFLOW_ACTIONS.has(input.action)) {
    return {
      taskStatus: 'human_review',
      reviewReason: 'plan_review',
      workflowStage: 'planning',
      executionPhase: 'planning',
    };
  }
  return {
    taskStatus: 'human_review',
    reviewReason: 'stopped',
    workflowStage: input.currentStage,
    executionPhase: 'stopped',
  };
}

function sameScopedTask(
  active: ActiveRun,
  taskId: string,
  projectId?: string,
): boolean {
  return (
    (active.task.id === taskId || active.task.specId === taskId) &&
    (!projectId || active.project.id === projectId)
  );
}

function getFinalAssistantText(
  result: Pick<SessionResult, 'messages'>,
): string {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (message.role === 'assistant' && message.content.trim()) {
      return message.content;
    }
  }
  return '';
}

function appendAssistantTextTail(current: string, delta: string): string {
  const combined = `${current}${delta}`;
  return combined.length <= MAX_CONTINUE_DIRECTIVE_TEXT_LENGTH
    ? combined
    : combined.slice(-MAX_CONTINUE_DIRECTIVE_TEXT_LENGTH);
}

function resolveFinalAssistantText(
  streamedText: string,
  result: Pick<SessionResult, 'messages'>,
): string {
  return getFinalAssistantText(result) || streamedText;
}

function clauseBefore(text: string): string {
  const boundary = Math.max(
    text.lastIndexOf('\n'),
    text.lastIndexOf('.'),
    text.lastIndexOf('!'),
    text.lastIndexOf('?'),
    text.lastIndexOf(';'),
    text.lastIndexOf('。'),
    text.lastIndexOf('！'),
    text.lastIndexOf('？'),
    text.lastIndexOf('；'),
  );
  return text.slice(boundary + 1);
}

function clauseAfter(text: string): string {
  const boundary = text.search(/[\n.!?;。！？；]/);
  return boundary >= 0 ? text.slice(0, boundary) : text;
}

function detectOpenSpecContinueDirective(text: string): boolean {
  if (!text.trim()) return false;
  const normalized = text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[`*_]/g, '')
    .slice(-MAX_CONTINUE_DIRECTIVE_TEXT_LENGTH);
  const matches = [...normalized.matchAll(/\/opsx:continue\b/gi)];
  const match = matches.at(-1);
  if (!match || match.index === undefined) return false;

  const commandStart = match.index;
  const commandEnd = commandStart + match[0].length;
  const beforeWindow = normalized.slice(Math.max(0, commandStart - 192), commandStart);
  const afterWindow = normalized.slice(commandEnd, commandEnd + 128);
  const before = clauseBefore(beforeWindow);
  const after = clauseAfter(afterWindow);

  const negatedBefore = (
    /(?:不要|请勿|切勿|无需|无须|不需要|不必|不能|不可|不应|不应该|禁止|避免)\s*(?:(?:再|自动|手动)\s*)*(?:运行|执行|调用|使用|触发|启动)?\s*(?:(?:以下|下面的|该|此|这个)\s*)?(?:命令\s*)?$/i.test(before)
    || /(?:do\s+not|don't|never|must\s+not|mustn't|should\s+not|shouldn't|cannot|can't|need\s+not|no\s+need\s+to|avoid)\s+(?:automatically\s+|manually\s+)?(?:run|running|execute|invoke|use|rerun|trigger|start)\s*(?:the\s+)?(?:(?:following|next)\s+)?(?:command\s*)?$/i.test(before)
  );
  const negatedAfter = (
    /^[\s,，:：()-]*(?:不要|请勿|切勿|无需|无须|不需要|不必|不能|不可|不应|不应该|禁止)/i.test(after)
    || /^[\s,，:：()-]*(?:do\s+not|don't|must\s+not|mustn't|should\s+not|shouldn't|cannot|can't|is\s+not\s+(?:required|necessary)|isn't\s+(?:required|necessary)|not\s+(?:required|necessary|needed))/i.test(after)
  );
  if (negatedBefore || negatedAfter) return false;

  const mentionOnly = /(?:例如|比如|示例|举例|教程|文档|for\s+example|e\.g\.|example|tutorial|documentation)[^。！？；\n!?;]{0,80}$/i
    .test(beforeWindow);
  if (mentionOnly) return false;

  const imperativeBefore = (
    /(?:请|现在|下一步|然后|接下来|自动|直接|可|可以|需要|应当|应该|必须|再|系统将)*\s*(?:运行|执行|调用|使用|触发|启动)\s*(?:以下|下面的|该|此|这个)?\s*(?:命令)?\s*$/i.test(before)
    || /(?:(?:please|now|next|then|automatically|directly)\s+)*(?:run|execute|invoke|use|rerun|trigger|start)\s+(?:the\s+)?(?:(?:following|next)\s+)?(?:command\s*)?$/i.test(before)
  );
  const continuationAfter = (
    /^[\s,，:：()-]*(?:以便|来|以|并)?\s*(?:继续|推进|恢复)/i.test(after)
    || /^[\s,，:：()-]*(?:(?:to|and)\s+)?(?:continue|proceed|resume)\b/i.test(after)
  );
  const headingBefore = (
    /(?:下一步|接下来|解决方案)\s*[:：]?\s*$/i.test(before)
    || /(?:next\s+step|resolution)\s*:?\s*$/i.test(before)
  );
  if (imperativeBefore || continuationAfter || headingBefore) return true;

  const lineStart = normalized.lastIndexOf('\n', commandStart - 1) + 1;
  const nextLineBreak = normalized.indexOf('\n', commandEnd);
  const lineEnd = nextLineBreak >= 0 ? nextLineBreak : normalized.length;
  const commandLine = normalized.slice(lineStart, lineEnd).trim();
  if (
    !/^\/opsx:continue(?:\s+[a-z0-9][a-z0-9-]{0,127})?\s*[。.!！]?$/i
      .test(commandLine)
  ) {
    return false;
  }
  if (normalized.trim() === commandLine) return true;

  const precedingLines = normalized
    .slice(0, lineStart)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ');
  return /(?:请运行|请执行|下一步|接下来|继续|命令|解决方案|please\s+run|please\s+execute|next\s+step|continue|command|resolution)/i
    .test(precedingLines);
}

function extractOpenSpecNewChangeName(command: string): string | null {
  const match = command.match(
    /(?:^|[\s;&|])(?:npx\s+)?openspec(?:\.cmd|\.exe)?\s+new\s+change\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([a-z0-9][a-z0-9-]{0,127}))(?=\s|$)/i,
  );
  const candidate = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
  return candidate && SAFE_CHANGE_NAME.test(candidate) ? candidate : null;
}

function extractContinueChangeNameFromText(text: string): string | null {
  const normalized = text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .slice(-MAX_CONTINUE_DIRECTIVE_TEXT_LENGTH);
  const candidates: string[] = [];
  const patterns = [
    /(?:^|[\\/])openspec[\\/]changes[\\/]([a-z0-9][a-z0-9-]{0,127})(?=$|[\\/\s`"'）)\]])/gi,
    /\/opsx:continue\s+(?:--change\s+)?[`"'“”]*([a-z0-9][a-z0-9-]{0,127})/gi,
    /(?:命名为|变更为|change\s+(?:is\s+)?named)\s*[`"'“”]*([a-z0-9][a-z0-9-]{0,127})/gi,
    /(?:变更|change)\s*[`"'“”]*([a-z0-9][a-z0-9-]{0,127})[`"'“”]*\s*(?:已存在|already\s+exists)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (candidate && SAFE_CHANGE_NAME.test(candidate)) {
        candidates.push(candidate);
      }
    }
  }
  return candidates.at(-1) ?? null;
}

function resolveOfficialContinueChangeName(input: {
  requestedChangeName?: string;
  observedChangeName?: string;
  finalAssistantText: string;
  activeChangeNames: readonly string[];
}): string | null {
  const activeNames = new Set(input.activeChangeNames);
  const candidates = [
    input.requestedChangeName,
    input.observedChangeName,
    extractContinueChangeNameFromText(input.finalAssistantText),
  ];
  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (
      normalized &&
      SAFE_CHANGE_NAME.test(normalized) &&
      activeNames.has(normalized)
    ) {
      return normalized;
    }
  }
  return null;
}

function openSpecStatusFingerprint(snapshot: OpenSpecBoardSnapshot): string {
  return JSON.stringify({
    changeName: snapshot.changeName,
    schemaName: snapshot.schema.name,
    artifacts: [...snapshot.artifacts]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((artifact) => ({
        id: artifact.id,
        status: artifact.status,
        outputPath: artifact.outputPath,
        existingOutputPaths: [...artifact.existingOutputPaths].sort(),
        modifiedAt: artifact.modifiedAt ?? null,
      })),
  });
}

function resolveAutomaticContinueDecision(
  input: AutomaticContinueDecisionInput,
): AutomaticContinueDecision {
  if (!AUTOMATIC_CONTINUE_SOURCE_ACTIONS.has(input.action)) {
    return { kind: 'stop', reason: 'source_action' };
  }
  if (input.sessionOutcome !== 'completed') {
    return { kind: 'stop', reason: 'session_outcome' };
  }
  if (input.cancelled) {
    return { kind: 'stop', reason: 'cancelled' };
  }
  if (input.lastError) {
    return { kind: 'stop', reason: 'agent_error' };
  }
  if (!detectOpenSpecContinueDirective(input.finalAssistantText)) {
    return { kind: 'stop', reason: 'no_directive' };
  }
  if (
    !input.snapshot.initialized ||
    input.snapshot.archived ||
    input.snapshot.unsupportedStatus ||
    !input.snapshot.changeName ||
    !input.snapshot.availableActions.includes('continue') ||
    !input.snapshot.artifacts.some((artifact) => artifact.status === 'ready')
  ) {
    return { kind: 'stop', reason: 'unavailable' };
  }
  if (input.automaticContinueDepth >= MAX_AUTOMATIC_CONTINUE_DEPTH) {
    return { kind: 'stop', reason: 'limit' };
  }
  if (
    input.action === 'continue' &&
    (
      !input.startStatusFingerprint ||
      input.startStatusFingerprint === openSpecStatusFingerprint(input.snapshot)
    )
  ) {
    return { kind: 'stop', reason: 'stalled' };
  }
  return {
    kind: 'start',
    changeName: input.snapshot.changeName,
  };
}

function resolveAutomaticVerifyDecision(
  input: AutomaticVerifyDecisionInput,
): AutomaticVerifyDecision {
  if (input.action !== 'apply') {
    return { kind: 'stop', reason: 'source_action' };
  }
  if (input.actionOutcome !== 'succeeded') {
    return { kind: 'stop', reason: 'action_outcome' };
  }
  if (input.sessionOutcome !== 'completed') {
    return { kind: 'stop', reason: 'session_outcome' };
  }
  if (input.cancelled) {
    return { kind: 'stop', reason: 'cancelled' };
  }
  if (input.lastError) {
    return { kind: 'stop', reason: 'agent_error' };
  }
  if (!implementationChecklistComplete(input.snapshot)) {
    return { kind: 'stop', reason: 'incomplete' };
  }
  if (
    !input.snapshot.initialized ||
    input.snapshot.archived ||
    !input.snapshot.changeName ||
    !input.snapshot.availableActions.includes('verify')
  ) {
    return { kind: 'stop', reason: 'unavailable' };
  }
  return {
    kind: 'start',
    changeName: input.snapshot.changeName,
  };
}

function formatOpenSpecConsoleChunk(
  chunk: Pick<TaskLogStreamChunk, 'type' | 'content' | 'tool'>,
  outputEndsWithNewline: boolean,
): string {
  const rawContent = (chunk.content ?? '').replace(/\r\n?/g, '\n');
  if (!rawContent) return '';
  // A successful tool_end only repeats the immediately preceding tool_start
  // as "[Tool] Done" and carries no result detail. Keep failures and any
  // non-generic completion summary, but omit this noise from both the live
  // Activity console and the persisted OpenSpec run log.
  if (
    chunk.type === 'tool_end' &&
    chunk.tool?.success === true &&
    /^\[[^\]\r\n]+\]\s+Done\s*$/i.test(rawContent)
  ) {
    return '';
  }
  if (chunk.type === 'text') return rawContent;

  const linePrefixed = outputEndsWithNewline || rawContent.startsWith('\n')
    ? rawContent
    : `\n${rawContent}`;
  return linePrefixed.endsWith('\n') ? linePrefixed : `${linePrefixed}\n`;
}

function validateRunInput(input: RunOpenSpecActionInput): void {
  if (!OPEN_SPEC_ACTIONS.includes(input.action)) {
    throw new Error('Unsupported OpenSpec Action.');
  }
  if (input.arguments && input.arguments.length > MAX_ARGUMENT_LENGTH) {
    throw new Error(`OpenSpec Action input exceeds ${MAX_ARGUMENT_LENGTH} characters.`);
  }
  if (input.changeName && !SAFE_CHANGE_NAME.test(input.changeName)) {
    throw new Error('OpenSpec change name must be a kebab-case identifier.');
  }
  if (CONFIRMATION_ACTIONS.has(input.action) && input.confirmed !== true) {
    throw new Error(`${input.action} requires explicit confirmation.`);
  }
  if (
    input.action === 'bulk-archive' &&
    (!Array.isArray(input.selectedChanges) || input.selectedChanges.length < 2)
  ) {
    throw new Error('Bulk Archive requires at least two selected changes.');
  }
  if (input.selectedChanges) {
    if (input.selectedChanges.length > 100) {
      throw new Error('Bulk Archive accepts at most 100 selected changes.');
    }
    const uniqueChanges = new Set(input.selectedChanges);
    if (
      uniqueChanges.size !== input.selectedChanges.length ||
      input.selectedChanges.some((change) => !/^[a-z0-9][a-z0-9-]{0,127}$/.test(change))
    ) {
      throw new Error('Selected OpenSpec changes must be unique kebab-case identifiers.');
    }
  }
}

function assertPlanningReviewAcknowledged(
  action: OpenSpecAction,
  pendingReview: OpenSpecPlanningReviewSummary | null,
): void {
  if (action !== 'apply' || !pendingReview) return;
  throw new Error(
    `OpenSpec Apply is blocked until planning review "${pendingReview.runId}" ` +
    'has been reviewed and acknowledged.',
  );
}

function configuredSchemaName(task: Task): string {
  const schemaName = task.metadata?.openSpec?.schemaName?.trim() || DEFAULT_SCHEMA_NAME;
  if (!SAFE_SCHEMA_NAME.test(schemaName)) {
    throw new Error('Task references an invalid OpenSpec schema name.');
  }
  return schemaName;
}

function buildOfficialActionArgument(
  input: RunOpenSpecActionInput,
  task: Task,
  selectedChange: string | null,
): string {
  const parts: string[] = [];
  if (input.action === 'bulk-archive') {
    parts.push(...(input.selectedChanges ?? []));
  } else if (
    input.changeName &&
    (input.action === 'new' || input.action === 'propose')
  ) {
    parts.push(input.changeName);
  } else if (
    selectedChange &&
    input.action !== 'new' &&
    input.action !== 'propose' &&
    input.action !== 'onboard'
  ) {
    parts.push(selectedChange);
  }
  if (input.arguments?.trim()) {
    parts.push(input.arguments);
  }
  if (
    parts.length === 0 &&
    (input.action === 'new' || input.action === 'propose' || input.action === 'ff' || input.action === 'onboard')
  ) {
    parts.push(task.description);
  }
  if (input.action === 'new' || input.action === 'propose') {
    const schemaName = configuredSchemaName(task);
    if (schemaName !== DEFAULT_SCHEMA_NAME) {
      parts.push('--schema', schemaName);
    }
  }
  const argument = parts.join(' ').trim();
  const storeId = task.metadata?.openSpec?.rootKind === 'store'
    ? task.metadata.openSpec.storeId?.trim()
    : undefined;
  if (storeId) {
    return argument
      ? `Use the registered OpenSpec Store "${storeId}".\n\n${argument}`
      : `Use the registered OpenSpec Store "${storeId}".`;
  }
  return argument;
}

function sameCanonicalPath(firstPath: string, secondPath: string): boolean {
  try {
    const first = realpathSync.native(resolve(firstPath));
    const second = realpathSync.native(resolve(secondPath));
    return process.platform === 'win32'
      ? first.toLocaleLowerCase('en-US') === second.toLocaleLowerCase('en-US')
      : first === second;
  } catch {
    return false;
  }
}

function isTrustedAdrSchemaResolution(
  value: unknown,
  packageRoot: string,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const resolution = value as Partial<OpenSpecSchemaResolution>;
  if (
    resolution.name !== TRUSTED_ADR_SCHEMA_NAME ||
    resolution.source !== 'package' ||
    typeof resolution.path !== 'string'
  ) {
    return false;
  }
  return sameCanonicalPath(
    resolution.path,
    join(packageRoot, 'schemas', TRUSTED_ADR_SCHEMA_NAME),
  );
}

async function hasTrustedAdrSchemaWriteAccess(
  cli: Pick<OpenSpecCliAdapter, 'schemaWhich'>,
  planningRoot: string | null,
  schemaName: string,
  action: OpenSpecAction,
  packageRoot: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (
    !planningRoot ||
    schemaName !== TRUSTED_ADR_SCHEMA_NAME ||
    !ADR_ARTIFACT_WRITING_ACTIONS.has(action)
  ) {
    return false;
  }
  try {
    const schemaResolution = await cli.schemaWhich<unknown>(
      { cwd: planningRoot },
      TRUSTED_ADR_SCHEMA_NAME,
      signal,
    );
    return isTrustedAdrSchemaResolution(schemaResolution, packageRoot);
  } catch {
    // Fail closed. A missing or unverifiable Schema must never grant
    // repository-level ADR write access.
    return false;
  }
}

function rawStatusRecord(snapshot: OpenSpecBoardSnapshot): Record<string, unknown> | null {
  return snapshot.rawStatus && typeof snapshot.rawStatus === 'object' && !Array.isArray(snapshot.rawStatus)
    ? snapshot.rawStatus as Record<string, unknown>
    : null;
}

function officialContextRootPath(context: unknown): string | null {
  if (
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context)
  ) {
    return null;
  }
  const root = (context as Record<string, unknown>).root;
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return null;
  }
  const path = (root as Record<string, unknown>).path;
  return typeof path === 'string' && path.trim() ? path : null;
}

async function resolveActionRootIdentity(
  root: ReturnType<OpenSpecRootResolver['resolve']>,
  cli: OpenSpecCliAdapter,
  roots: OpenSpecRootResolver,
  signal?: AbortSignal,
): Promise<{ lockRootKey: string; planningRoot: string | null }> {
  if (root.rootKind !== 'store') {
    return {
      lockRootKey: root.cwd,
      planningRoot: null,
    };
  }

  const context = await cli.context<unknown>({
    cwd: root.cwd,
    rootKind: root.rootKind,
    storeId: root.storeId,
  }, signal);
  const officialRoot = officialContextRootPath(context);
  if (!officialRoot) {
    throw new Error('The registered OpenSpec Store did not resolve an official planning root.');
  }
  const planningRoot = roots.validateOfficialPlanningRoot(root, officialRoot);
  return {
    lockRootKey: planningRoot,
    planningRoot,
  };
}

function buildActionPathPolicy(
  action: OpenSpecAction,
  root: ReturnType<OpenSpecRootResolver['resolve']>,
  planningRoot: string | null,
  officialEditRoots: ReadonlySet<string>,
  allowPersistentAdrWrites = false,
): { allowedWritePaths: string[]; runtimeRoot: string } {
  const allowedWritePaths = new Set<string>();
  if (!READ_ONLY_ACTIONS.has(action)) {
    if (!planningRoot) {
      throw new Error(
        'OpenSpec did not resolve an official planning root; mutating Actions are disabled.',
      );
    }
    allowedWritePaths.add(join(planningRoot, 'openspec'));
    if (
      allowPersistentAdrWrites &&
      ADR_ARTIFACT_WRITING_ACTIONS.has(action)
    ) {
      allowedWritePaths.add(join(root.workspaceRoot, 'adr'));
    }
    if (IMPLEMENTATION_ACTIONS.has(action)) {
      for (const editRoot of officialEditRoots) {
        allowedWritePaths.add(editRoot);
      }
      if (action === 'onboard' && root.rootKind === 'project') {
        allowedWritePaths.add(root.workspaceRoot);
      }
    }
  }
  const runtimeRoot = root.rootKind === 'store' ? planningRoot : root.workspaceRoot;
  if (!runtimeRoot) {
    throw new Error('The registered OpenSpec Store did not resolve an official runtime root.');
  }
  return {
    allowedWritePaths: [...allowedWritePaths],
    runtimeRoot,
  };
}

function buildTrustedRuntimeReadPaths(
  shimDirectory: string,
  packageRoot: string,
  runtimeNodeModulesRoot: string,
  executablePath: string,
): string[] {
  return [
    shimDirectory,
    packageRoot,
    runtimeNodeModulesRoot,
    dirname(executablePath),
  ];
}

export class OpenSpecActionRunner {
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(
    private readonly agentManager: AgentManager,
    private readonly cli: OpenSpecCliAdapter,
    private readonly roots: OpenSpecRootResolver,
    private readonly prompts: OpenSpecPromptRegistry,
    private readonly locks: OpenSpecLockManager,
    private readonly runtimeStore: OpenSpecRuntimeStore,
    private readonly status: OpenSpecStatusService,
    private readonly publish: OpenSpecEventPublisher,
    private readonly publishTaskStatus: (
      task: Task,
      project: Project,
      status: Task['status'],
      reviewReason?: ReviewReason,
    ) => void,
    private readonly onReconcile: (
      task: Task,
      project: Project,
      options?: OpenSpecReconcileOptions,
    ) => Promise<OpenSpecBoardSnapshot>,
    private readonly gitBaseline = new OpenSpecGitBaselineGuard(),
    private readonly planningReviews = new OpenSpecPlanningReviewStore(runtimeStore),
  ) {}

  async runAction(
    task: Task,
    project: Project,
    input: RunOpenSpecActionInput,
    options: {
      resumeRunId?: string;
      automaticContinueDepth?: number;
    } = {},
  ): Promise<{ runId: string }> {
    validateRunInput(input);
    assertPlanningReviewAcknowledged(
      input.action,
      input.action === 'apply'
        ? this.planningReviews.readPending(task, project)
        : null,
    );
    const key = activeRunKey(task, project);
    if (this.activeRuns.has(key)) {
      throw new Error('Another OpenSpec Action is already running for this task.');
    }
    this.runtimeStore.initialize(task, project);
    const previousRuntime = this.runtimeStore.read(task, project);
    if (
      previousRuntime.state === 'interrupted' &&
      previousRuntime.activeRunId &&
      previousRuntime.activeRunId !== options.resumeRunId
    ) {
      throw new Error(
        'An interrupted OpenSpec Action must be continued or cancelled before starting another Action.',
      );
    }

    if (options.resumeRunId && input.action !== 'update') {
      // The recovered official Action no longer produces a planning review, so
      // the interrupted Update draft can never be completed. Drop it instead of
      // leaving a stale baseline snapshot behind.
      try {
        this.planningReviews.discard(task, project, options.resumeRunId);
      } catch {
        // Never block a recovery Action on draft cleanup.
      }
    }

    const runId = randomUUID();
    const summary: OpenSpecActionRunSummary = {
      runId,
      action: input.action,
      state: 'queued',
      startedAt: new Date().toISOString(),
    };
    const active: ActiveRun = {
      task,
      project,
      summary,
      controller: new AbortController(),
      sequence: 0,
      outputEndsWithNewline: true,
      interactionCount: 0,
      cancelled: false,
      finished: false,
      automaticContinueDepth: options.automaticContinueDepth ?? 0,
      requestedChangeName: input.changeName,
      finalAssistantText: '',
      ...(options.resumeRunId ? { resumedFromRunId: options.resumeRunId } : {}),
    };
    this.activeRuns.set(key, active);
    this.runtimeStore.setRecoveryInput(task, project, input);
    this.runtimeStore.update(task, project, {
      activeRunId: runId,
      activeRunStartedAt: summary.startedAt,
      activeAction: input.action,
      state: 'queued',
      executionPhase: input.action,
      taskStatus: 'in_progress',
      reviewReason: null,
      workflowStage: workflowStageForStartedAction(
        input.action,
        previousRuntime.workflowStage,
      ),
      lastError: null,
      waitingInteraction: null,
      interruptedFromState: null,
      waitingReason: null,
      ...(input.changeName ? { selectedChangeName: input.changeName } : {}),
    });
    this.publish(task, project, { type: 'run-state', run: summary });
    this.publishTaskStatus(task, project, 'in_progress');

    void this.execute(active, input).catch((error) => {
      void this.finish(active, 'failed', error instanceof Error ? error.message : String(error));
    });
    return { runId };
  }

  async resumeAction(
    task: Task,
    project: Project,
    input: ResumeOpenSpecActionInput,
  ): Promise<{ runId: string }> {
    const runtime = this.runtimeStore.read(task, project);
    if (
      runtime.state !== 'interrupted' ||
      runtime.activeRunId !== input.runId ||
      !runtime.recoveryInput
    ) {
      throw new Error('The interrupted OpenSpec Action is no longer recoverable.');
    }
    if (
      CONFIRMATION_ACTIONS.has(runtime.recoveryInput.action) &&
      input.confirmed !== true
    ) {
      throw new Error(`${runtime.recoveryInput.action} requires explicit confirmation to resume.`);
    }
    return await this.runAction(task, project, {
      taskId: task.id,
      projectId: project.id,
      ...runtime.recoveryInput,
      ...(input.confirmed === true ? { confirmed: true } : {}),
    }, {
      resumeRunId: input.runId,
    });
  }

  private updateRun(active: ActiveRun, state: OpenSpecActionRunSummary['state'], error?: string): void {
    const { waitingReason: _waitingReason, ...currentSummary } = active.summary;
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(state);
    const completedAt = terminal ? new Date().toISOString() : undefined;
    active.summary = {
      ...currentSummary,
      state,
      ...(error ? { error } : {}),
      ...(completedAt
        ? {
            completedAt,
            durationMs: Math.max(
              0,
              Date.parse(completedAt) - Date.parse(active.summary.startedAt),
            ),
          }
        : {}),
    };
    this.runtimeStore.update(active.task, active.project, {
      state,
      activeRunId: active.summary.runId,
      activeAction: active.summary.action,
      lastError: error ?? null,
      waitingReason: null,
    });
    this.publish(active.task, active.project, {
      type: 'run-state',
      run: active.summary,
    });
  }

  private async execute(active: ActiveRun, input: RunOpenSpecActionInput): Promise<void> {
    const root = this.roots.resolve(active.task, active.project);
    await this.cli.version({
      cwd: root.cwd,
      rootKind: root.rootKind,
      storeId: root.storeId,
    });
    const rootIdentity = await resolveActionRootIdentity(
      root,
      this.cli,
      this.roots,
      active.controller.signal,
    );
    let planningRoot = rootIdentity.planningRoot;
    const actionStartsChange =
      input.action === 'new' || input.action === 'propose';
    const lockChangeName = input.changeName ?? (
      actionStartsChange
        ? undefined
        : this.runtimeStore.read(active.task, active.project).selectedChangeName ??
          undefined
    );
    const blockers = this.locks.getBlockers({
      rootKey: rootIdentity.lockRootKey,
      changeName: lockChangeName,
      action: input.action,
    });
    if (blockers.length > 0) {
      const waitingReason = `Waiting for ${blockers.length} conflicting OpenSpec Action${
        blockers.length === 1 ? '' : 's'
      } to release the required lock.`;
      active.summary = { ...active.summary, waitingReason };
      this.runtimeStore.update(active.task, active.project, { waitingReason });
      this.publish(active.task, active.project, {
        type: 'run-state',
        run: active.summary,
      });
    }
    active.releaseLocks = await this.locks.acquireForAction({
      rootKey: rootIdentity.lockRootKey,
      changeName: lockChangeName,
      action: input.action,
      owner: active.summary.runId,
      signal: active.controller.signal,
    });
    if (active.finished) return;

    this.updateRun(active, 'preparing');
    if (
      root.rootKind === 'project' &&
      !existsSync(`${root.cwd}/openspec`) &&
      ['new', 'propose', 'ff', 'onboard'].includes(input.action)
    ) {
      await this.cli.init({
        cwd: root.cwd,
        rootKind: root.rootKind,
        storeId: root.storeId,
      }, active.controller.signal);
    }

    let snapshot = await this.status.getSnapshot(active.task, active.project);
    active.startStatusFingerprint = openSpecStatusFingerprint(snapshot);
    if (!snapshot.availableActions.includes(input.action)) {
      throw new Error(
        `OpenSpec Action "${input.action}" is not available in the current official status.`,
      );
    }
    if (snapshot.unsupportedStatus && !READ_ONLY_ACTIONS.has(input.action)) {
      throw new Error(
        'OpenSpec returned an unsupported upstream status; mutating Actions are disabled until the status is understood.',
      );
    }
    this.gitBaseline.assertSafeForAction(
      active.task,
      active.project,
      root,
      input.action,
    );
    if (input.action === 'bulk-archive') {
      const activeChanges = await this.status.listChanges(active.task, active.project);
      const activeNames = new Set(activeChanges.map((change) => change.name));
      if (input.selectedChanges?.some((change) => !activeNames.has(change))) {
        throw new Error('Bulk Archive selection contains a change that is not active in this OpenSpec root.');
      }
    }
    const selectedChange = input.changeName ?? (
      actionStartsChange
        ? null
        : this.runtimeStore.read(active.task, active.project).selectedChangeName ??
          snapshot.changeName
    );
    if (selectedChange) {
      this.runtimeStore.update(active.task, active.project, {
        selectedChangeName: selectedChange,
      });
    }
    const prompt = await this.prompts.getPrompt(input.action);
    const delegatedPrompts = input.action === 'archive'
      ? { sync: await this.prompts.getPrompt('sync') }
      : undefined;
    const userMessage = buildOfficialActionArgument(input, active.task, selectedChange);
    const openSpecPackage = assertPinnedOpenSpecPackage();
    const shim = ensureOpenSpecCommandShim();
    // These roots are executable runtime dependencies, not project
    // capabilities. The CLI fallback may read them but never write to them.
    const trustedRuntimeReadPaths = buildTrustedRuntimeReadPaths(
      shim.directory,
      openSpecPackage.packageRoot,
      openSpecPackage.runtimeNodeModulesRoot,
      process.execPath,
    );

    const allowedPathRoots = new Set<string>([root.workspaceRoot]);
    const officialEditRoots = new Set<string>();
    if (planningRoot) {
      allowedPathRoots.add(planningRoot);
    }
    if (!planningRoot) {
      try {
        const context = await this.cli.context<unknown>({
          cwd: root.cwd,
          rootKind: root.rootKind,
          storeId: root.storeId,
        }, active.controller.signal);
        const officialRoot = officialContextRootPath(context);
        if (officialRoot) {
          const authorizedRoot = this.roots.validateOfficialPlanningRoot(root, officialRoot);
          planningRoot = authorizedRoot;
          allowedPathRoots.add(authorizedRoot);
        }
      } catch (error) {
        if (root.rootKind === 'store') {
          throw error;
        }
        // A local uninitialized root may not expose context until init completes.
      }
    }
    const rawStatus = rawStatusRecord(snapshot);
    const planningHome = rawStatus?.planningHome;
    if (
      planningHome &&
      typeof planningHome === 'object' &&
      !Array.isArray(planningHome) &&
      typeof (planningHome as Record<string, unknown>).root === 'string'
    ) {
      const statusPlanningRoot = this.roots.validateOfficialPlanningRoot(
        root,
        (planningHome as Record<string, unknown>).root as string,
      );
      if (
        root.rootKind === 'store' &&
        planningRoot &&
        statusPlanningRoot !== planningRoot
      ) {
        throw new Error(
          'OpenSpec status resolved a different Store root than the registered Store context.',
        );
      }
      planningRoot = statusPlanningRoot;
      allowedPathRoots.add(planningRoot);
    }
    const actionContext = rawStatus?.actionContext;
    const rawOfficialEditRoots = actionContext && typeof actionContext === 'object' && !Array.isArray(actionContext)
      ? (actionContext as Record<string, unknown>).allowedEditRoots
      : undefined;
    if (Array.isArray(rawOfficialEditRoots)) {
      for (const editRoot of rawOfficialEditRoots) {
        if (typeof editRoot === 'string' && planningRoot) {
          try {
            const authorizedEditRoot = this.roots.validateOfficialEditRoot(
              root,
              planningRoot,
              editRoot,
            );
            allowedPathRoots.add(authorizedEditRoot);
            officialEditRoots.add(authorizedEditRoot);
          } catch {
            // Fail closed: never grant an upstream path outside both trusted roots.
          }
        }
      }
    }

    let allowPersistentAdrWrites = false;
    if (
      snapshot.schema.name === TRUSTED_ADR_SCHEMA_NAME &&
      ADR_ARTIFACT_WRITING_ACTIONS.has(input.action)
    ) {
      allowPersistentAdrWrites = await hasTrustedAdrSchemaWriteAccess(
        this.cli,
        planningRoot,
        snapshot.schema.name,
        input.action,
        openSpecPackage.packageRoot,
        active.controller.signal,
      );
    }

    // Most planning Actions only mutate the official OpenSpec tree. The
    // package-pinned ADR Schema may additionally create durable ADRs in the
    // task's code workspace. Apply and Onboard may edit roots explicitly
    // authorized by OpenSpec actionContext.
    const pathPolicy = buildActionPathPolicy(
      input.action,
      root,
      planningRoot,
      officialEditRoots,
      allowPersistentAdrWrites,
    );
    if (input.action === 'update') {
      this.planningReviews.begin(
        active.task,
        active.project,
        active.summary.runId,
        pathPolicy.allowedWritePaths,
        active.resumedFromRunId
          ? { inheritBaselineFromRunId: active.resumedFromRunId }
          : {},
      );
      active.planningReviewWritePaths = [...pathPolicy.allowedWritePaths];
    }

    const onOutput = (
      taskId: string,
      chunk: TaskLogStreamChunk,
      projectId?: string,
    ): void => {
      if (!sameScopedTask(active, taskId, projectId) || active.finished) return;
      if (chunk.type === 'text' && chunk.content) {
        active.finalAssistantText = appendAssistantTextTail(
          active.finalAssistantText,
          chunk.content,
        );
      }
      if (
        chunk.type === 'tool_start' &&
        (active.summary.action === 'new' || active.summary.action === 'propose')
      ) {
        const command = chunk.tool?.input ?? chunk.content ?? '';
        const observedChangeName = extractOpenSpecNewChangeName(command);
        if (observedChangeName) {
          active.observedChangeName = observedChangeName;
        }
      }
      const content = formatOpenSpecConsoleChunk(chunk, active.outputEndsWithNewline);
      if (!content) return;
      active.outputEndsWithNewline = content.endsWith('\n');
      active.sequence += 1;
      this.runtimeStore.appendRunLog(active.task, active.project, active.summary.runId, content);
      this.publish(active.task, active.project, {
        type: 'output',
        runId: active.summary.runId,
        sequence: active.sequence,
        text: content,
      });
    };
    const onInteraction = (message: WorkerOpenSpecInteractionRequiredMessage): void => {
      if (
        !sameScopedTask(active, message.taskId, message.projectId) ||
        message.runId !== active.summary.runId ||
        active.finished
      ) {
        return;
      }
      active.interactionCount += 1;
      const interaction: OpenSpecInteraction = {
        interactionId: message.interactionId,
        runId: message.runId,
        taskId: message.taskId,
        prompt: message.prompt,
        createdAt: message.createdAt,
        questions: message.questions,
      };
      this.updateRun(active, 'awaiting_user');
      this.runtimeStore.update(active.task, active.project, {
        waitingInteraction: interaction,
      });
      this.publish(active.task, active.project, {
        type: 'interaction-required',
        interaction,
      });
    };
    const onError = (taskId: string, error: string, projectId?: string): void => {
      if (!sameScopedTask(active, taskId, projectId) || active.finished) return;
      active.lastError = error;
      this.publish(active.task, active.project, {
        type: 'error',
        code: 'agent_error',
        message: error,
      });
    };
    const onResult = (
      taskId: string,
      result: SessionResult,
      runId?: string,
      projectId?: string,
    ): void => {
      if (
        !sameScopedTask(active, taskId, projectId) ||
        runId !== active.summary.runId ||
        active.finished
      ) {
        return;
      }
      active.sessionOutcome = result.outcome;
      active.finalAssistantText = resolveFinalAssistantText(
        active.finalAssistantText,
        result,
      );
    };
    const onExit = (
      taskId: string,
      code: number | null,
      processType: string,
      projectId?: string,
    ): void => {
      if (
        processType !== 'openspec-action' ||
        !sameScopedTask(active, taskId, projectId) ||
        active.finished
      ) {
        return;
      }
      this.removeAgentListeners(onOutput, onInteraction, onError, onResult, onExit);
      void this.finish(
        active,
        active.cancelled ? 'cancelled' : code === 0 && !active.lastError ? 'succeeded' : 'failed',
        active.lastError,
      );
    };

    this.agentManager.on('openspec-output', onOutput);
    this.agentManager.on('openspec-interaction-required', onInteraction);
    this.agentManager.on('openspec-error', onError);
    this.agentManager.on('openspec-result', onResult);
    this.agentManager.on('exit', onExit);
    active.cleanupListeners = () => {
      this.removeAgentListeners(onOutput, onInteraction, onError, onResult, onExit);
    };

    this.updateRun(active, 'running');
    try {
      await this.agentManager.startOpenSpecAction({
        taskId: active.task.id,
        projectId: active.project.id,
        runId: active.summary.runId,
        action: input.action,
        projectPath: active.project.path,
        runtimeRoot: pathPolicy.runtimeRoot,
        specDir: this.runtimeStore.getSpecDir(active.task, active.project),
        prompt,
        userMessage,
        commandEnv: shim.commandEnv,
        allowedPathRoots: [...allowedPathRoots],
        trustedRuntimeReadPaths,
        allowedWritePaths: pathPolicy.allowedWritePaths,
        openSpecStoreId: root.storeId,
        readOnly: READ_ONLY_ACTIONS.has(input.action),
        delegatedPrompts,
      });
    } catch (error) {
      active.cleanupListeners?.();
      active.cleanupListeners = undefined;
      throw error;
    }
    if (active.finished) return;

    // Capture a fresh status reference after the worker has started. Further
    // state changes are handled by watcher reconciliation and the exit handler.
    snapshot = await this.status.getSnapshot(active.task, active.project);
    this.publish(active.task, active.project, {
      type: 'snapshot',
      revision: snapshot.revision,
      snapshot,
    });
  }

  private removeAgentListeners(
    onOutput: (
      taskId: string,
      chunk: TaskLogStreamChunk,
      projectId?: string,
    ) => void,
    onInteraction: (message: WorkerOpenSpecInteractionRequiredMessage) => void,
    onError: (taskId: string, error: string, projectId?: string) => void,
    onResult: (
      taskId: string,
      result: SessionResult,
      runId?: string,
      projectId?: string,
    ) => void,
    onExit: (
      taskId: string,
      code: number | null,
      processType: string,
      projectId?: string,
    ) => void,
  ): void {
    this.agentManager.off('openspec-output', onOutput);
    this.agentManager.off('openspec-interaction-required', onInteraction);
    this.agentManager.off('openspec-error', onError);
    this.agentManager.off('openspec-result', onResult);
    this.agentManager.off('exit', onExit);
  }

  private async finish(
    active: ActiveRun,
    outcome: 'succeeded' | 'failed' | 'cancelled',
    error?: string,
  ): Promise<void> {
    if (active.finished) return;
    active.finished = true;
    active.cleanupListeners?.();
    active.cleanupListeners = undefined;
    let planningReview: OpenSpecPlanningReview | null = null;
    if (active.summary.action === 'update') {
      try {
        if (outcome === 'succeeded') {
          planningReview = this.planningReviews.complete(
            active.task,
            active.project,
            active.summary.runId,
            active.planningReviewWritePaths ?? [],
          );
        } else {
          this.planningReviews.discard(
            active.task,
            active.project,
            active.summary.runId,
          );
        }
      } catch (reviewError) {
        try {
          planningReview = this.planningReviews.fail(
            active.task,
            active.project,
            active.summary.runId,
            reviewError,
          );
        } catch (persistenceError) {
          this.publish(active.task, active.project, {
            type: 'error',
            code: 'planning_review_persistence_failed',
            message:
              'The OpenSpec Update finished, but its complete planning change review could not be persisted: ' +
              (persistenceError instanceof Error
                ? persistenceError.message
                : String(persistenceError)),
          });
        }
      }
    }
    try {
      this.updateRun(active, outcome, error);
      if (planningReview) {
        this.publish(active.task, active.project, {
          type: 'planning-review',
          review: summarizeOpenSpecPlanningReview(planningReview),
        });
      }
    } finally {
      active.releaseLocks?.();
      active.releaseLocks = undefined;
    }
    const durationMs = active.summary.durationMs ??
      Math.max(0, Date.now() - Date.parse(active.summary.startedAt));
    this.runtimeStore.appendActionEvent(active.task, active.project, {
      runId: active.summary.runId,
      taskId: active.task.id,
      projectId: active.project.id,
      action: active.summary.action,
      state: outcome,
      timestamp: new Date().toISOString(),
      startedAt: active.summary.startedAt,
      completedAt: active.summary.completedAt ?? new Date().toISOString(),
      durationMs,
      interactionCount: active.interactionCount,
      ...(error ? { errorCode: 'action_failed' } : {}),
      ...(error ? { error } : {}),
    });

    const runtimeBeforeCompletion = this.runtimeStore.read(active.task, active.project);
    const currentWorkflowStage = runtimeBeforeCompletion.workflowStage ??
      workflowStageForStartedAction(active.summary.action, 'planning');
    let archivedSelectedChange = false;
    if (
      outcome === 'succeeded' &&
      (active.summary.action === 'archive' || active.summary.action === 'bulk-archive') &&
      runtimeBeforeCompletion.selectedChangeName
    ) {
      try {
        const activeChanges = await this.status.listChanges(active.task, active.project);
        archivedSelectedChange = !activeChanges.some(
          (change) => change.name === runtimeBeforeCompletion.selectedChangeName,
        );
      } catch {
        // Reconciliation below will surface the official CLI failure. Do not
        // claim task completion without authoritative evidence.
      }
    }
    const provisionalStatus: Task['status'] = outcome === 'failed'
      ? 'error'
      : outcome === 'cancelled'
        ? 'human_review'
        : 'in_progress';
    const provisionalReviewReason: ReviewReason | null = outcome === 'failed'
      ? 'errors'
      : outcome === 'cancelled'
        ? 'stopped'
        : null;
    this.runtimeStore.update(active.task, active.project, {
      activeRunId: null,
      activeRunStartedAt: null,
      activeAction: null,
      state: outcome,
      waitingInteraction: null,
      recoveryInput: null,
      interruptedFromState: null,
      waitingReason: null,
      lastSuccessfulAction: outcome === 'succeeded'
        ? active.summary.action
        : runtimeBeforeCompletion.lastSuccessfulAction,
      lastError: error ?? active.lastError ?? null,
      taskStatus: provisionalStatus,
      reviewReason: provisionalReviewReason,
      executionPhase: outcome === 'cancelled' ? 'stopped' : outcome,
    });
    let preferredChangeName: string | null = null;
    if (
      outcome === 'succeeded' &&
      active.sessionOutcome === 'completed' &&
      !active.cancelled &&
      !active.lastError &&
      (active.summary.action === 'new' || active.summary.action === 'propose') &&
      detectOpenSpecContinueDirective(active.finalAssistantText)
    ) {
      try {
        const activeChanges = await this.status.listChanges(
          active.task,
          active.project,
        );
        preferredChangeName = resolveOfficialContinueChangeName({
          requestedChangeName: active.requestedChangeName,
          observedChangeName: active.observedChangeName,
          finalAssistantText: active.finalAssistantText,
          activeChangeNames: activeChanges.map((change) => change.name),
        });
      } catch {
        // The authoritative reconcile below owns status error reporting.
      }
    }
    let snapshot: OpenSpecBoardSnapshot | null = null;
    let reconcileFailure: string | null = null;
    try {
      snapshot = await this.onReconcile(
        active.task,
        active.project,
        preferredChangeName
          ? { selectedChangeName: preferredChangeName }
          : undefined,
      );
    } catch (reconcileError) {
      reconcileFailure = reconcileError instanceof Error
        ? reconcileError.message
        : String(reconcileError);
      this.publish(active.task, active.project, {
        type: 'error',
        code: 'reconcile_failed',
        message: reconcileFailure,
      });
    }
    this.activeRuns.delete(activeRunKey(active.task, active.project));
    if (!snapshot) {
      const fallback: FinishedTaskLifecycle = outcome === 'cancelled'
        ? {
            taskStatus: 'human_review',
            reviewReason: 'stopped',
            workflowStage: currentWorkflowStage,
            executionPhase: 'stopped',
          }
        : {
            taskStatus: 'error',
            reviewReason: 'errors',
            workflowStage: currentWorkflowStage,
            executionPhase: 'failed',
          };
      this.runtimeStore.update(active.task, active.project, {
        ...fallback,
        ...(reconcileFailure ? { lastError: reconcileFailure } : {}),
      });
      this.publishTaskStatus(
        active.task,
        active.project,
        fallback.taskStatus,
        fallback.reviewReason ?? undefined,
      );
      return;
    }

    if (
      outcome === 'succeeded' &&
      (active.summary.action === 'archive' || active.summary.action === 'bulk-archive') &&
      runtimeBeforeCompletion.selectedChangeName &&
      snapshot.archived
    ) {
      archivedSelectedChange = true;
    }

    const automaticContinue = resolveAutomaticContinueDecision({
      action: active.summary.action,
      sessionOutcome: active.sessionOutcome,
      cancelled: active.cancelled,
      lastError: active.lastError,
      finalAssistantText: active.finalAssistantText,
      automaticContinueDepth: active.automaticContinueDepth,
      startStatusFingerprint: active.startStatusFingerprint,
      snapshot,
    });
    const automaticVerify = resolveAutomaticVerifyDecision({
      action: active.summary.action,
      actionOutcome: outcome,
      sessionOutcome: active.sessionOutcome,
      cancelled: active.cancelled,
      lastError: active.lastError,
      snapshot,
    });
    const lifecycle = resolveFinishedTaskLifecycle({
      action: active.summary.action,
      outcome,
      currentStage: currentWorkflowStage,
      snapshot,
      automaticContinueStarting: automaticContinue.kind === 'start',
      automaticVerifyStarting: automaticVerify.kind === 'start',
      archivedSelectedChange,
    });
    this.runtimeStore.update(active.task, active.project, lifecycle);
    if (lifecycle.workflowStage !== currentWorkflowStage) {
      try {
        // The OpenSpec file watcher intentionally ignores Aperant runtime
        // bookkeeping. Reconcile once more after a local lifecycle transition
        // so Verify/Archive stage changes reach the board immediately.
        await this.onReconcile(active.task, active.project);
      } catch (lifecycleReconcileError) {
        this.publish(active.task, active.project, {
          type: 'error',
          code: 'lifecycle_reconcile_failed',
          message: lifecycleReconcileError instanceof Error
            ? lifecycleReconcileError.message
            : String(lifecycleReconcileError),
        });
      }
    }
    this.publishTaskStatus(
      active.task,
      active.project,
      lifecycle.taskStatus,
      lifecycle.reviewReason ?? undefined,
    );
    if (
      automaticContinue.kind === 'stop' &&
      automaticVerify.kind === 'stop'
    ) {
      if (automaticContinue.reason === 'limit') {
        this.publish(active.task, active.project, {
          type: 'error',
          code: 'automatic_continue_limit',
          message:
            `OpenSpec requested more than ${MAX_AUTOMATIC_CONTINUE_DEPTH} consecutive Continue Actions. ` +
            'Automatic continuation stopped to prevent a loop.',
        });
      } else if (automaticContinue.reason === 'stalled') {
        this.publish(active.task, active.project, {
          type: 'error',
          code: 'automatic_continue_stalled',
          message:
            'OpenSpec requested another Continue Action without advancing the official artifact status. ' +
            'Automatic continuation stopped to prevent a loop.',
        });
      } else if (
        automaticContinue.reason === 'unavailable' &&
        detectOpenSpecContinueDirective(active.finalAssistantText)
      ) {
        this.publish(active.task, active.project, {
          type: 'error',
          code: 'automatic_continue_unavailable',
          message:
            'OpenSpec requested /opsx:continue, but the authoritative status did not expose a ready Continue Action for the resolved change.',
        });
      }
      return;
    }

    if (automaticVerify.kind === 'start') {
      try {
        console.info(
          `[OpenSpecActionRunner] Automatically verifying change "${automaticVerify.changeName}" ` +
          'after Apply completed every official task.',
        );
        await this.runAction(active.task, active.project, {
          taskId: active.task.id,
          projectId: active.project.id,
          action: 'verify',
          changeName: automaticVerify.changeName,
        });
      } catch (verifyError) {
        const message = verifyError instanceof Error
          ? verifyError.message
          : String(verifyError);
        this.runtimeStore.update(active.task, active.project, {
          taskStatus: 'error',
          reviewReason: 'errors',
          executionPhase: 'failed',
          lastError: message,
        });
        this.publishTaskStatus(active.task, active.project, 'error', 'errors');
        this.publish(active.task, active.project, {
          type: 'error',
          code: 'automatic_verify_failed',
          message:
            `OpenSpec could not start the automatic Verify Action: ${message}`,
        });
      }
      return;
    }

    if (automaticContinue.kind === 'stop') return;

    try {
      console.info(
        `[OpenSpecActionRunner] Automatically continuing change "${automaticContinue.changeName}" ` +
        `after ${active.summary.action} (depth ${active.automaticContinueDepth + 1}).`,
      );
      await this.runAction(
        active.task,
        active.project,
        {
          taskId: active.task.id,
          projectId: active.project.id,
          action: 'continue',
          changeName: automaticContinue.changeName,
        },
        {
          automaticContinueDepth: active.automaticContinueDepth + 1,
        },
      );
    } catch (continueError) {
      const message = continueError instanceof Error
        ? continueError.message
        : String(continueError);
      this.runtimeStore.update(active.task, active.project, {
        taskStatus: 'error',
        reviewReason: 'errors',
        executionPhase: 'failed',
        lastError: message,
      });
      this.publishTaskStatus(active.task, active.project, 'error', 'errors');
      this.publish(active.task, active.project, {
        type: 'error',
        code: 'automatic_continue_failed',
        message:
          `OpenSpec could not start the automatic Continue Action: ${message}`,
      });
    }
  }

  cancel(task: Task, project: Project, runId: string): void {
    const active = this.activeRuns.get(activeRunKey(task, project));
    if (!active || active.summary.runId !== runId || active.finished) {
      throw new Error('OpenSpec run is not active.');
    }
    active.cancelled = true;
    this.updateRun(active, 'cancelling');
    active.controller.abort();
    this.agentManager.killTask(task.id, project.id);
    void this.finish(active, 'cancelled');
  }

  answerInteraction(
    task: Task,
    project: Project,
    input: { runId: string; interactionId: string; answer: string },
  ): void {
    const active = this.activeRuns.get(activeRunKey(task, project));
    if (!active || active.summary.runId !== input.runId || active.finished) {
      throw new Error('OpenSpec interaction no longer belongs to an active run.');
    }
    if (!input.answer.trim() || input.answer.length > 16_000) {
      throw new Error('OpenSpec interaction answer is empty or too long.');
    }
    const waiting = this.runtimeStore.read(task, project).waitingInteraction;
    if (!waiting || waiting.interactionId !== input.interactionId) {
      throw new Error('OpenSpec interaction ID is stale.');
    }
    const delivered = this.agentManager.answerOpenSpecInteraction(
      task.id,
      input.interactionId,
      input.answer,
      project.id,
    );
    if (!delivered) {
      throw new Error('OpenSpec session is no longer available; run the Action again to recover.');
    }
    this.runtimeStore.update(task, project, {
      waitingInteraction: null,
      state: 'running',
    });
    this.updateRun(active, 'running');
  }

}

export const __openSpecActionRunnerTestUtils = {
  buildActionPathPolicy,
  buildOfficialActionArgument,
  buildTrustedRuntimeReadPaths,
  configuredSchemaName,
  appendAssistantTextTail,
  formatOpenSpecConsoleChunk,
  detectOpenSpecContinueDirective,
  extractContinueChangeNameFromText,
  extractOpenSpecNewChangeName,
  getFinalAssistantText,
  hasTrustedAdrSchemaWriteAccess,
  isTrustedAdrSchemaResolution,
  MAX_AUTOMATIC_CONTINUE_DEPTH,
  officialContextRootPath,
  openSpecStatusFingerprint,
  resolveFinalAssistantText,
  resolveFinishedTaskLifecycle,
  resolveOfficialContinueChangeName,
  resolveAutomaticContinueDecision,
  resolveAutomaticVerifyDecision,
  resolveActionRootIdentity,
  assertPlanningReviewAcknowledged,
  validateRunInput,
  workflowStageForStartedAction,
};
