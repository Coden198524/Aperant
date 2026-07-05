/**
 * Worker Thread Entry Point
 * =========================
 *
 * Runs in an isolated worker_thread. Receives configuration via `workerData`,
 * executes `runAgentSession()`, and posts structured messages back to the
 * main thread via `parentPort.postMessage()`.
 *
 * Path handling:
 * - Dev: Loaded directly by electron-vite from source
 * - Production: Bundled into app resources (app.isPackaged)
 */

import { parentPort, workerData } from 'worker_threads';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

import { runAgentSession } from '../session/runner';
import { runContinuableSession } from '../session/continuation';
import { createProvider } from '../providers/factory';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAICompatibleEndpointFetch } from '../providers/openai-base-url';
import {
  AUTOCODE_TASK_ARTIFACTS,
  AUTOCODE_DIRECT_SESSION_STATE_VERSION,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  buildAutocodeProjectDocsReferencePrompt,
  buildAutocodeDirectTaskExecutionMessages,
  inferAutocodeRuntimeFileWriteLockScopeFromSpecDir,
  isOfficialOpenAIBaseUrl,
  normalizeOpenAICompatibleBaseUrl,
  resolveAutocodeDirectSessionState,
  resolveAutocodeTaskRuntimeConcurrency,
  saveAutocodeDirectSessionState,
  type Phase,
  type SupportedProvider,
} from '@autocode/core';
import {
  appendAutocodeLanguageRequirement,
  appendAutocodeLanguageRequirementToMessages,
  getAutocodeImplementationPlanLanguageRequirement,
} from '@autocode/core/runtime/agent-language';
import {
  buildAutocodeAgenticSpecOrchestratorKickoffMessage,
  buildAutocodeAgentKickoffMessage,
  buildAutocodeFallbackPrompt,
  buildAutocodeSpecKickoffMessage,
  formatAutocodePathForPrompt,
  resolveAutocodePromptNameForAgent,
} from '@autocode/core/runtime/agent-kickoff';
import {
  isAutocodeDirectTaskExecution,
  resolveAutocodeAgentExecutionPlan,
} from '@autocode/core/runtime/agent-execution-plan';
import {
  buildAutocodeDirectCompletionSummaryV2,
  buildAutocodeDirectExecutionMetadata,
  extractAutocodeDirectFilePathFromToolArgs,
  extractAutocodeDirectTaskDescription,
  getAutocodeDirectQualityGateFailureReason,
  inferAutocodeDirectValidationEvidence,
  isAutocodeSuccessfulDirectOutcome,
  shouldTrackAutocodeDirectModifiedFile,
  type AutocodeDirectCodingQualityMetrics,
} from '@autocode/core/runtime/direct-task-summary';
import {
  buildAutocodeSessionQualityConfig,
  getWorkflowConfigFromMode as getCoreWorkflowConfigFromMode,
  type WorkflowConfig,
} from '@autocode/core/runtime/workflow-config';
import { getModelContextWindow } from '../../../shared/constants/models';
import { refreshOAuthTokenReactive } from '../auth/resolver';
import { buildToolRegistry } from '../tools/build-registry';
import type { ToolRegistry } from '../tools/registry';
import { SubagentExecutorImpl } from '../orchestration/subagent-executor';
import type { ToolContext, ToolUsageState } from '../tools/types';
import type { SecurityProfile } from '../security/bash-validator';
import type {
  WorkerConfig,
  WorkerMessage,
  MainToWorkerMessage,
  SerializableSessionConfig,
  WorkerTaskEventMessage,
} from './types';
import type { LanguageModel, Tool as AITool } from 'ai';
import type { SessionConfig, StreamEvent, SessionResult } from '../session/types';
import { BuildOrchestrator, type BuildOutcome } from '../orchestration/build-orchestrator';
import { QALoop } from '../orchestration/qa-loop';
import { SpecOrchestrator } from '../orchestration/spec-orchestrator';
import type { SpecPhase } from '../orchestration/spec-orchestrator';
import type { QualityConfig } from '../orchestration/quality-integration';
import type { AgentType } from '../config/agent-configs';
import type { ExecutionPhase } from '../../../shared/constants/phase-protocol';
import { getPhaseThinking } from '../config/phase-config';
import { TaskLogWriter } from '../logging/task-log-writer';
import { loadProjectInstructions, injectContext } from '../prompts/prompt-loader';
import {
  buildCompactProjectPromptProfileSection,
  buildProjectPromptProfileSection,
  initializeProjectPromptProfile,
  loadProjectPromptOverride,
  loadProjectPromptProfile,
  type ProjectPromptProfile,
} from '../prompts/project-prompt-profile';
import { createMcpClientsForAgent, mergeMcpTools, closeAllMcpClients } from '../mcp/client';
import type { McpClientResult } from '../mcp/types';
import type { ProjectType, TaskLogPhase, TaskWorkflowMode } from '../../../shared/types';
import { FileContentCache } from '../tools/cache/file-cache';
import { buildFocusedCoderKickoffMessage } from './session-efficiency';
import { specPhaseToPromptName } from './spec-phase-prompts';
import {
  loadImplementationPlanFromFilesSync,
  saveImplementationPlanToFilesSync,
  type ShardableImplementationPlan,
} from '../schema/plan-shards';
import { buildAggressiveCoderPrompt } from './aggressive-coder-prompt';
import {
  AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS,
  applyDirectProviderSessionPersistence,
  buildDirectRetrySessionConfig,
  mergeDirectValidationAttemptResults,
  shouldRetryDirectValidationAttempt,
  type DirectValidationAttemptFeedback,
} from './direct-retry';
import { resolveProjectAgentProfile } from '../config/project-agent-profile';
import { extractSpecTaskDescriptionFromInitialMessages } from './task-description';
import { WorkerObserverProxy } from '../memory/ipc/worker-observer-proxy';
import { isMemoryEligibleForPromptContext } from '../memory/retrieval/context-packer';
import { createRecordMemoryTool, createSearchMemoryTool } from '../memory/tools';
import {
  collectFilesChangedSinceBaseline,
  collectGitChangedFileSnapshot,
  loadGeneratedFilesForCritique,
  type ChangedFileSnapshot,
} from '../orchestration/changed-files';
import type {
  Memory,
  MemoryRecordEntry,
  MemorySearchFilters,
  MemoryService,
} from '@autocode/core';

// =============================================================================
// Validation
// =============================================================================

if (!parentPort) {
  throw new Error('worker.ts must be run inside a worker_thread');
}

const config = workerData as WorkerConfig;
const AUTOCODE_DIRECT_CONTEXT_WINDOW_CONTINUATIONS = 1;
if (!config?.taskId || !config?.session) {
  throw new Error('worker.ts requires valid WorkerConfig via workerData');
}

function resolvePhaseStepBudget(
  session: SerializableSessionConfig,
  phase: Phase | 'spec' | undefined,
): number {
  const fallback = session.maxSteps;
  const budgets = session.phaseStepBudgets;

  if (!budgets || !phase) {
    return fallback;
  }

  const budget = budgets[phase as keyof typeof budgets];
  return typeof budget === 'number' ? budget : fallback;
}

function isAggressiveWorkflow(
  session: SerializableSessionConfig,
): session is SerializableSessionConfig & { workflowMode: TaskWorkflowMode } {
  return session.workflowMode === 'aggressive';
}

function formatPathForPrompt(filePath: string): string {
  return formatAutocodePathForPrompt(filePath);
}

function getSpecPhaseDisplayName(phase: SpecPhase, language?: string): string {
  const labels: Record<SpecPhase, string> = language === 'zh-CN'
    ? {
        complexity_assessment: '\u590d\u6742\u5ea6\u8bc4\u4f30',
        discovery: '\u9879\u76ee\u53d1\u73b0',
        requirements: '\u9700\u6c42\u5206\u6790',
        historical_context: '\u5386\u53f2\u4e0a\u4e0b\u6587',
        research: '\u7814\u7a76\u9a8c\u8bc1',
        context: '\u4e0a\u4e0b\u6587\u5efa\u6a21',
        spec_writing: '\u89c4\u683c\u6587\u6863',
        self_critique: '\u81ea\u6211\u5ba1\u67e5',
        planning: '\u4efb\u52a1\u8ba1\u5212',
        validation: '\u8ba1\u5212\u6821\u9a8c',
        quick_spec: '\u6807\u51c6\u8f7b\u91cf\u89c4\u5212',
      }
    : {
        complexity_assessment: 'Complexity assessment',
        discovery: 'Project discovery',
        requirements: 'Requirements analysis',
        historical_context: 'Historical context',
        research: 'Research validation',
        context: 'Context modeling',
        spec_writing: 'Specification writing',
        self_critique: 'Self critique',
        planning: 'Task planning',
        validation: 'Plan validation',
        quick_spec: 'Standard light planning',
      };

  return labels[phase] ?? phase.replace(/_/g, ' ');
}

/**
 * Map task workflowMode to WorkflowConfig preset
 */
function getWorkflowConfigFromMode(mode?: TaskWorkflowMode): WorkflowConfig | undefined {
  return getCoreWorkflowConfigFromMode(mode);
}

function getQualityConfigFromWorkflowConfig(
  workflowConfig?: WorkflowConfig,
  projectType?: ProjectType,
): QualityConfig | undefined {
  return buildAutocodeSessionQualityConfig(workflowConfig, projectType) as QualityConfig | undefined;
}

// =============================================================================
// Task Log Writer
// =============================================================================

// Single writer instance for this worker's spec, shared across all sessions
// so that planning/coding/QA phases accumulate into one task_logs.jsonl file.
const logWriter = config.session.specDir
  ? new TaskLogWriter(config.session.specDir, basename(config.session.specDir))
  : null;

// =============================================================================
// File Content Cache
// =============================================================================

// Session-scoped file content cache for this worker
const fileCache = new FileContentCache();

const toolUsageState: ToolUsageState = {
  totalCalls: 0,
  toolCalls: {},
  readOnlySignatureCalls: {},
};

// =============================================================================
// Messaging Helpers
// =============================================================================

function postMessage(message: WorkerMessage): void {
  parentPort!.postMessage(message);
}

function postLog(data: string): void {
  const trimmed = data.trim();
  if (trimmed) {
    console.log(`[Worker:${config.taskId}] ${trimmed}`);
    logWriter?.logText(trimmed, undefined, 'info');
  }
  postMessage({ type: 'log', taskId: config.taskId, data, projectId: config.projectId });
}

function postError(data: string): void {
  const trimmed = data.trim();
  if (trimmed) {
    console.error(`[Worker:${config.taskId}] ${trimmed}`);
    logWriter?.logText(trimmed, undefined, 'error');
  }
  postMessage({ type: 'error', taskId: config.taskId, data, projectId: config.projectId });
}

function postTaskEvent(eventType: string, extra?: Record<string, unknown>): void {
  parentPort?.postMessage({
    type: 'task-event',
    taskId: config.taskId,
    projectId: config.projectId,
    data: {
      type: eventType,
      taskId: config.taskId,
      specId: config.session.specDir ? basename(config.session.specDir) : config.taskId,
      projectId: config.projectId ?? '',
      timestamp: new Date().toISOString(),
      eventId: `${config.taskId}-${eventType}-${Date.now()}`,
      sequence: Date.now(),
      ...extra,
    },
  } satisfies WorkerTaskEventMessage);
}

function toTaskLogPhase(phase: Phase | undefined): TaskLogPhase {
  switch (phase) {
    case 'spec':
    case 'planning':
      return 'planning';
    case 'qa':
      return 'validation';
    case 'coding':
    default:
      return 'coding';
  }
}

// =============================================================================
// Abort Handling
// =============================================================================

const abortController = new AbortController();

parentPort.on('message', (msg: MainToWorkerMessage) => {
  if (msg.type === 'abort') {
    abortController.abort();
  }
});

// =============================================================================
// Memory IPC
// =============================================================================

function isWorkerMemoryEnabled(session: SerializableSessionConfig): boolean {
  const envToggle = session.mcpOptions?.mcpEnv?.GRAPHITI_ENABLED;
  return envToggle?.toLowerCase() !== 'false';
}

const memoryProxy = isWorkerMemoryEnabled(config.session)
  ? new WorkerObserverProxy(parentPort)
  : null;

function createWorkerMemoryService(
  proxy: WorkerObserverProxy,
  fallbackProjectId: string,
): MemoryService {
  const withProject = <T extends { projectId?: string }>(value: T): T & { projectId: string } => ({
    ...value,
    projectId: value.projectId || fallbackProjectId,
  });

  return {
    store: async (entry: MemoryRecordEntry): Promise<string> => {
      const id = await proxy.recordMemory(withProject(entry));
      return id ?? `memory-unavailable-${Date.now()}`;
    },
    search: async (filters: MemorySearchFilters): Promise<Memory[]> => {
      const scoped = withProject(filters);
      return proxy.searchMemory({
        ...scoped,
        promptContextOnly: scoped.promptContextOnly ?? true,
      });
    },
    searchByPattern: async (
      pattern: string,
      opts?: { projectId?: string; recordAccess?: boolean },
    ): Promise<Memory | null> => {
      const memories = await proxy.searchMemory({
        query: pattern,
        projectId: opts?.projectId ?? fallbackProjectId,
        limit: 1,
        excludeDeprecated: true,
        promptContextOnly: true,
        recordAccess: opts?.recordAccess ?? true,
      });
      return memories.find(isMemoryEligibleForPromptContext) ?? null;
    },
    insertUserTaught: async (content: string, projectId: string, tags: string[]): Promise<string> => {
      const id = await proxy.recordMemory({
        type: 'preference',
        content,
        projectId: projectId || fallbackProjectId,
        tags,
        source: 'user_taught',
        scope: 'global',
      });
      return id ?? `memory-unavailable-${Date.now()}`;
    },
    searchWorkflowRecipe: async (
      taskDescription: string,
      opts?: { limit?: number; projectId?: string; recordAccess?: boolean },
    ): Promise<Memory[]> => {
      const memories = await proxy.searchMemory({
        query: taskDescription,
        projectId: opts?.projectId ?? fallbackProjectId,
        types: ['workflow_recipe'],
        limit: opts?.limit ?? 3,
        excludeDeprecated: true,
        promptContextOnly: true,
        recordAccess: opts?.recordAccess ?? true,
      });
      return memories.filter((memory) =>
        memory.type === 'workflow_recipe' && isMemoryEligibleForPromptContext(memory)
      );
    },
    updateAccessCount: async (memoryId: string): Promise<void> => {
      await proxy.updateAccessCount(memoryId);
    },
    deprecateMemory: async (): Promise<void> => {},
    verifyMemory: async (): Promise<void> => {},
    pinMemory: async (): Promise<void> => {},
    deleteMemory: async (): Promise<void> => {},
  };
}

function buildSessionQualityConfig(
  session: SerializableSessionConfig,
  workflowConfig: WorkflowConfig | undefined,
): import('../orchestration/quality-integration').QualityConfig | undefined {
  const qualityConfig = getQualityConfigFromWorkflowConfig(workflowConfig, session.projectType);
  if (!qualityConfig) {
    return undefined;
  }

  const projectId = config.projectId || config.taskId;
  return {
    ...qualityConfig,
    projectId,
    ...(memoryProxy ? { memoryService: createWorkerMemoryService(memoryProxy, projectId) } : {}),
  };
}

// =============================================================================
// Shared Helpers
// =============================================================================

/**
 * Reconstruct the SecurityProfile from the serialized form in session config.
 * SecurityProfile uses Set objects that can't cross worker boundaries.
 */
function buildSecurityProfile(session: SerializableSessionConfig): SecurityProfile {
  const serialized = session.toolContext.securityProfile;
  return {
    baseCommands: new Set(serialized?.baseCommands ?? []),
    stackCommands: new Set(serialized?.stackCommands ?? []),
    scriptCommands: new Set(serialized?.scriptCommands ?? []),
    customCommands: new Set(serialized?.customCommands ?? []),
    customScripts: { shellScripts: serialized?.customScripts?.shellScripts ?? [] },
    getAllAllowedCommands() {
      return new Set([
        ...this.baseCommands,
        ...this.stackCommands,
        ...this.scriptCommands,
        ...this.customCommands,
      ]);
    },
  };
}

/**
 * Build a ToolContext for the given session config.
 */
function buildToolContext(session: SerializableSessionConfig, securityProfile: SecurityProfile, fileCache?: FileContentCache): ToolContext {
  const fileWriteLockScope = inferAutocodeRuntimeFileWriteLockScopeFromSpecDir(session.sourceSpecDir ?? session.specDir);
  const allowedPathRoots = [
    session.toolContext.projectDir,
    session.sourceProjectDir,
    session.toolContext.specDir,
    session.sourceSpecDir,
  ].filter((value): value is string => Boolean(value));

  return {
    cwd: session.toolContext.cwd,
    projectDir: session.toolContext.projectDir,
    allowedPathRoots,
    specDir: session.toolContext.specDir,
    securityProfile,
    abortSignal: abortController.signal,
    fileCache,
    workflowMode: session.workflowMode,
    currentSubtaskId: session.subtaskId,
    toolUsageState,
    fileWriteLock: {
      enabled: true,
      dataDirName: fileWriteLockScope.dataDirName,
      projectRoot: session.sourceProjectDir ?? session.projectDir,
      ownerId: [config.taskId, session.subtaskId, session.phase].filter(Boolean).join(':') || config.taskId,
    },
  };
}

function getSpecWritePaths(session: SerializableSessionConfig): string[] {
  return [
    session.specDir,
    session.sourceSpecDir,
  ].filter((value): value is string => Boolean(value));
}


/**
 * Load a prompt file from the prompts directory.
 * The prompts dir is expected relative to the worker file's location.
 * In dev and production, the worker sits in the main/ output folder.
 */
function loadPrompt(promptName: string): string | null {
  // Try to find the prompts directory relative to common locations
  const candidateBases: string[] = [
    // Standard: apps/desktop/prompts/ relative to project root
    // The worker runs in the Electron main process — __dirname is in out/main/
    // We need to traverse up to find apps/desktop/prompts/
    join(__dirname, '..', '..', 'prompts'),
    join(__dirname, '..', '..', '..', 'apps', 'desktop', 'prompts'),
    join(__dirname, '..', '..', '..', '..', 'apps', 'desktop', 'prompts'),
    join(__dirname, 'prompts'),
  ];

  for (const base of candidateBases) {
    const promptPath = join(base, `${promptName}.md`);
    try {
      if (existsSync(promptPath)) {
        return expandPromptPartials(readFileSync(promptPath, 'utf-8'), base);
      }
    } catch {
      // Try next
    }
  }
  return null;
}

function expandPromptPartials(
  content: string,
  promptsDir: string,
  seen = new Set<string>(),
): string {
  return content.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (match, partialName: string) => {
    const partialPath = join(promptsDir, 'partials', `${partialName}.md`);
    if (!existsSync(partialPath) || seen.has(partialName)) {
      return match;
    }

    try {
      seen.add(partialName);
      return expandPromptPartials(readFileSync(partialPath, 'utf-8'), promptsDir, seen);
    } catch {
      return match;
    } finally {
      seen.delete(partialName);
    }
  });
}

// =============================================================================
// MCP Clients (module-scope for worker lifetime)
// =============================================================================

let mcpClients: McpClientResult[] = [];
const RESPONSES_PERSISTENCE_BROKEN_BASE_URLS = new Set<string>();

function normalizeBaseUrl(baseURL: string | undefined): string | null {
  if (!baseURL) return null;
  try {
    const parsed = new URL(baseURL);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return baseURL.trim().toLowerCase();
  }
}

function supportsChatFallbackTransport(session: SerializableSessionConfig): boolean {
  const provider = session.provider.toLowerCase();
  return (
    (provider === 'openai' || provider === 'openai-compatible') &&
    !isOfficialOpenAIBaseUrl(session.baseURL)
  );
}

function shouldFallbackForResponsesPersistenceError(result: SessionResult): boolean {
  if (result.outcome !== 'error') return false;
  const message = result.error?.message?.toLowerCase() ?? '';
  const hasMissingFcItem =
    message.includes('item with id') &&
    message.includes('fc_') &&
    message.includes('not found');
  const mentionsResponsesEndpoint = message.includes('/responses') || message.includes('responses');
  const hasStorePersistenceMismatch =
    message.includes('items are not persisted') &&
    message.includes('store') &&
    message.includes('false');

  return (
    hasStorePersistenceMismatch ||
    (hasMissingFcItem && mentionsResponsesEndpoint)
  );
}

function createForcedChatModel(session: SerializableSessionConfig, modelId: string): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'openai-compatible',
    apiKey: session.apiKey ?? 'custom-endpoint',
    baseURL: normalizeOpenAICompatibleBaseUrl(session.baseURL) ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    fetch: createOpenAICompatibleEndpointFetch(),
  });
  return provider.chatModel(modelId);
}

function createSessionModel(session: SerializableSessionConfig, modelId: string): LanguageModel {
  const normalizedBaseUrl = normalizeBaseUrl(session.baseURL);
  if (
    normalizedBaseUrl &&
    RESPONSES_PERSISTENCE_BROKEN_BASE_URLS.has(normalizedBaseUrl) &&
    supportsChatFallbackTransport(session)
  ) {
    return createForcedChatModel(session, modelId);
  }

  return createProvider({
    config: {
      provider: session.provider as SupportedProvider,
      apiKey: session.apiKey,
      baseURL: session.baseURL,
      oauthTokenFilePath: session.oauthTokenFilePath,
    },
    modelId,
  });
}

async function runContinuableSessionWithGatewayFallback(
  sessionConfig: SessionConfig,
  runnerOptions: Parameters<typeof runContinuableSession>[1],
  continuationOptions: Parameters<typeof runContinuableSession>[2],
  session: SerializableSessionConfig,
  modelId: string,
): Promise<SessionResult> {
  const firstResult = await runContinuableSession(sessionConfig, runnerOptions, continuationOptions);

  if (!supportsChatFallbackTransport(session) || !shouldFallbackForResponsesPersistenceError(firstResult)) {
    return firstResult;
  }

  const normalizedBaseUrl = normalizeBaseUrl(session.baseURL);
  if (normalizedBaseUrl) {
    RESPONSES_PERSISTENCE_BROKEN_BASE_URLS.add(normalizedBaseUrl);
  }

  postLog(
    `[GatewayFallback] Responses item persistence error detected for provider=${session.provider}, baseURL=${session.baseURL ?? 'unknown baseURL'}; retrying with chat transport.`,
  );

  const fallbackConfig: SessionConfig = {
    ...sessionConfig,
    model: createForcedChatModel(session, modelId),
  };

  return runContinuableSession(fallbackConfig, runnerOptions, continuationOptions);
}

async function runDirectSessionWithGatewayFallback(
  sessionConfig: SessionConfig,
  runnerOptions: Parameters<typeof runContinuableSession>[1],
  continuationOptions: Parameters<typeof runContinuableSession>[2],
  session: SerializableSessionConfig,
  modelId: string,
): Promise<SessionResult> {
  const firstResult = await runContinuableSession(sessionConfig, runnerOptions, continuationOptions);

  if (!supportsChatFallbackTransport(session) || !shouldFallbackForResponsesPersistenceError(firstResult)) {
    return firstResult;
  }

  const normalizedBaseUrl = normalizeBaseUrl(session.baseURL);
  if (normalizedBaseUrl) {
    RESPONSES_PERSISTENCE_BROKEN_BASE_URLS.add(normalizedBaseUrl);
  }

  postLog(
    `[GatewayFallback] Direct Responses continuation is not supported for provider=${session.provider}, baseURL=${session.baseURL ?? 'unknown baseURL'}; retrying without provider session persistence.`,
  );

  return runContinuableSession({
    ...sessionConfig,
    model: createForcedChatModel(session, modelId),
    initialMessages: buildDirectSummaryFallbackMessages(session, sessionConfig.initialMessages),
    responsePersistence: false,
    previousResponseId: undefined,
  }, runnerOptions, continuationOptions);
}

function buildDirectSummaryFallbackMessages(
  session: SerializableSessionConfig,
  fallbackMessages: SessionConfig['initialMessages'],
): SessionConfig['initialMessages'] {
  const state = resolveAutocodeDirectSessionState(session.specDir, session.sourceSpecDir);
  if (!state) {
    return fallbackMessages;
  }
  return buildAutocodeDirectTaskExecutionMessages({
    specDir: session.specDir,
    specId: basename(session.specDir),
    projectRoot: session.projectDir,
    language: session.language,
    directSessionState: state,
    directContinuationMode: 'summary',
  });
}

// =============================================================================
// Prompt Assembly (provider-agnostic context injection)
// =============================================================================

let cachedProjectInstructions: string | null | undefined;
let cachedProjectInstructionsSource: string | null = null;
let cachedProjectPromptProfile: ProjectPromptProfile | null | undefined;
let cachedProjectPromptProfileDir: string | null = null;
const loggedProjectPromptOverrides = new Set<string>();

function getImplementationPlanLanguageRequirement(
  language: SerializableSessionConfig['language'],
): string | null {
  return getAutocodeImplementationPlanLanguageRequirement(language);
}

function appendLanguageRequirement(
  content: string,
  language: SerializableSessionConfig['language'],
): string {
  return appendAutocodeLanguageRequirement(content, language);
}

function appendLanguageRequirementToMessages(
  messages: SessionConfig['initialMessages'],
  language: SerializableSessionConfig['language'],
): SessionConfig['initialMessages'] {
  return appendAutocodeLanguageRequirementToMessages(messages, language);
}

function appendSearchDiscipline(content: string): string {
  return [
    content,
    '',
    '## SEARCH AND SHELL DISCIPLINE',
    '- Prefer the Grep tool for content search and Glob for filename search before using Bash search commands.',
    '- Do not call shell grep, findstr, Select-String, dir /s, or recursive PowerShell searches when Grep or Glob can answer the question.',
    '- If one targeted search is empty, change the query strategy at most once, then proceed with the best available file evidence.',
    '- Do not repeat the same search through multiple shell syntaxes.',
    '- On Windows, do not use Unix-only helpers such as head, tail, sed, awk, or lsof. Use Read/Grep/Glob first; for shell fallback use simple PowerShell or cmd commands only.',
  ].join('\n');
}

function readPlanReviewFeedback(session: SerializableSessionConfig): string | null {
  if (session.forcePlanning !== true) {
    return null;
  }

  const humanInputPath = join(session.specDir, 'HUMAN_INPUT.md');
  if (!existsSync(humanInputPath)) {
    return null;
  }

  try {
    return readFileSync(humanInputPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function buildPlanReviewRegenerationDirective(session: SerializableSessionConfig): string {
  const promptSpecDir = formatPathForPrompt(session.specDir);
  const feedback = readPlanReviewFeedback(session);
  const lines = [
    '## PLAN REVIEW REGENERATION',
    'This run was started from Request Changes in plan review.',
    `Read ${promptSpecDir}/HUMAN_INPUT.md and treat it as required reviewer feedback.`,
    `If ${promptSpecDir}/change_requests.jsonl exists, use its latest entry as the active same-task iteration contract.`,
    `Update ${promptSpecDir}/spec.md, ${promptSpecDir}/requirements.md, and ${promptSpecDir}/tasks.md where the feedback changes requirements, acceptance criteria, design decisions, task scope, or verification.`,
    `Do not edit ${promptSpecDir}/implementation_plan.md directly; the runtime derives it from validated tasks.md after the Standard artifacts are updated.`,
    `Do not make ${promptSpecDir}/implementation_plan.md the only changed planning artifact when the feedback changes requirements, design, user behavior, or task scope.`,
    'Only edit affected requirement IDs, design notes, risks, acceptance criteria, and task checklist items. Keep unaffected sections stable.',
    'Keep one canonical tasks.md checklist item per behavior/file/requirement boundary. If represented work needs revision, edit that item in place, reset it to pending, and put any needs_revision marker only in a detail note or metadata line instead of appending a duplicate task.',
    'Add pending tasks only for genuinely new requirements or verification gaps, and remove or compact obsolete executable checklist items after recording the change request. Never prefix task titles or work package titles with needs_revision, obsolete, or other state labels.',
    'Every new or revised requirement/design/task must carry Evidence; if evidence is missing, add an assumption/open question or validation task instead of guessing.',
    'Add or update focused verification commands for every new or revised task so the next coding pass can test and commit through the normal task flow.',
    'Keep this as a planning-only run: do not implement code, do not run coding subtasks, and do not mark subtasks completed.',
    'Preserve useful parts of the previous Autocode Standard documents only when they still match the reviewer feedback; otherwise replace them.',
  ];

  if (feedback) {
    lines.push('', 'Reviewer feedback:', feedback);
  }

  return lines.join('\n');
}

function countPlanSubtasks(plan: ShardableImplementationPlan | null): number {
  return (plan?.phases ?? []).reduce((total, phase) => {
    const subtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    return total + subtasks.length;
  }, 0);
}

function syncRegeneratedPlanToSource(session: SerializableSessionConfig): void {
  if (!session.sourceSpecDir || session.sourceSpecDir === session.specDir) {
    return;
  }

  try {
    const plan = loadImplementationPlanFromFilesSync(session.specDir);
    if (!plan) {
      return;
    }
    saveImplementationPlanToFilesSync(session.sourceSpecDir, plan);
  } catch (error) {
    postLog(`Failed to sync regenerated plan to source spec directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getPromptProfileProjectDir(session: SerializableSessionConfig): string {
  return session.sourceProjectDir ?? session.projectDir;
}

function shouldUseProjectPromptProfile(session: SerializableSessionConfig, promptName: string): boolean {
  return promptName !== 'direct_task' || isDirectTaskSession(session);
}

function resolvePromptNameForAgent(agentType: AgentType): string {
  return resolveAutocodePromptNameForAgent(agentType);
}

function getProjectPromptProfile(session: SerializableSessionConfig): ProjectPromptProfile | null {
  const profileProjectDir = getPromptProfileProjectDir(session);
  if (
    cachedProjectPromptProfile !== undefined &&
    cachedProjectPromptProfileDir === profileProjectDir
  ) {
    return cachedProjectPromptProfile;
  }

  cachedProjectPromptProfileDir = profileProjectDir;
  cachedProjectPromptProfile = loadProjectPromptProfile(profileProjectDir);

  if (!cachedProjectPromptProfile) {
    try {
      cachedProjectPromptProfile = initializeProjectPromptProfile(profileProjectDir, { overwrite: false });
      postLog(
        `Project prompt profile generated (${cachedProjectPromptProfile.project.size}, ${cachedProjectPromptProfile.workflow.promptIntensity})`,
      );
    } catch (error) {
      cachedProjectPromptProfile = null;
      postLog(`Project prompt profile unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return cachedProjectPromptProfile;
}

/**
 * Assemble a full system prompt by loading the base prompt and injecting
 * project instructions (AGENTS.md or CLAUDE.md fallback). Provider-agnostic —
 * injected for ALL AI providers, not just Anthropic.
 */
async function assemblePrompt(
  promptName: string,
  session: SerializableSessionConfig,
): Promise<string> {
  const useCompactAggressiveCoderPrompt = promptName === 'coder' && isAggressiveWorkflow(session);
  const useProviderDirectContinuationPrompt = promptName === 'direct_task' && session.directProviderContinuation === true;
  const profileProjectDir = getPromptProfileProjectDir(session);
  const projectPromptProfile = !useProviderDirectContinuationPrompt && shouldUseProjectPromptProfile(session, promptName)
    ? getProjectPromptProfile(session)
    : null;
  const projectOverride = useCompactAggressiveCoderPrompt || useProviderDirectContinuationPrompt
    ? null
    : loadProjectPromptOverride(profileProjectDir, promptName);
  if (projectOverride && !loggedProjectPromptOverrides.has(projectOverride.path)) {
    loggedProjectPromptOverrides.add(projectOverride.path);
    postLog(`Using project-specific prompt override: ${projectOverride.path}`);
  }

  const basePrompt = useCompactAggressiveCoderPrompt
    ? buildAggressiveCoderPrompt()
    : projectOverride?.content
    ?? loadPrompt(promptName)
    ?? buildFallbackPrompt(promptName as AgentType, session.specDir, session.projectDir);

  // Load project instructions once per worker lifetime
  if (cachedProjectInstructions === undefined) {
    const result = await loadProjectInstructions(session.projectDir);
    cachedProjectInstructions = result?.content ?? null;
    cachedProjectInstructionsSource = result?.source ?? null;
    if (result) {
      postLog(`Project instructions loaded from ${result.source} (${(result.content.length / 1024).toFixed(1)}KB)`);
    } else {
      postLog('No project instructions found (checked AGENTS.md, CLAUDE.md)');
    }
  }

  let humanInput: string | null = null;
  if (!promptName.startsWith('qa_') && !useProviderDirectContinuationPrompt) {
    const humanInputPath = join(session.specDir, 'HUMAN_INPUT.md');
    if (existsSync(humanInputPath)) {
      try {
        humanInput = readFileSync(humanInputPath, 'utf-8').trim() || null;
      } catch {
        humanInput = null;
      }
    }
  }

  let promptWithContext = useCompactAggressiveCoderPrompt || useProviderDirectContinuationPrompt
    ? basePrompt
    : injectContext(basePrompt, {
      specDir: session.specDir,
      projectDir: session.projectDir,
      projectInstructions: cachedProjectInstructions,
      humanInput,
      autoPushToRemote: session.autoPushToRemote,
    });

  if (projectPromptProfile && !projectOverride) {
    const profileSection = promptName === 'direct_task' || useCompactAggressiveCoderPrompt
      ? buildCompactProjectPromptProfileSection(projectPromptProfile)
      : buildProjectPromptProfileSection(projectPromptProfile);
    promptWithContext += `\n\n${profileSection}`;
  }

  let promptWithLanguage = appendLanguageRequirement(promptWithContext, session.language);
  if (promptName === 'planner' || promptName === 'followup_planner' || promptName === 'spec_quick') {
    const planRequirement = getImplementationPlanLanguageRequirement(session.language);
    if (planRequirement) {
      promptWithLanguage += `\n\n## IMPLEMENTATION PLAN LANGUAGE REQUIREMENT\n${planRequirement}`;
    }
    if (session.forcePlanning === true) {
      promptWithLanguage += `\n\n${buildPlanReviewRegenerationDirective(session)}`;
    }
  }
  if (promptName === 'spec_quick' && isAggressiveWorkflow(session)) {
    promptWithLanguage += [
      '',
      '## AGGRESSIVE WORKFLOW PLAN LIMIT',
      'This task is running in aggressive mode. Keep the plan optimized for a single coder session.',
      '- Write exactly 1 implementation phase.',
      '- Write exactly 1 pending subtask unless the user explicitly requested independent staged delivery.',
      '- Put the full implementation scope, files, and verification in that one subtask.',
      '- Do not split by component, file, test, cleanup, or other internal implementation area for a single-deliverable task.',
    ].join('\n');
  }
  if (promptName === 'coder' && isAggressiveWorkflow(session)) {
    promptWithLanguage += [
      '',
      '## AGGRESSIVE WORKFLOW CODING LIMITS',
      'This task is running in aggressive mode. Keep coding to one compact implementation session.',
      '- Use the kickoff work item details as primary context; do not start by reading spec.md or implementation_plan.md when Current Work Item or Current Work Package is present.',
      '- Avoid broad repository discovery. Read only files required for the implementation.',
      '- On Windows project roots such as E:\\path, use that path directly in commands; do not rewrite it as /e/path.',
      '- Prefer one target write/edit pass, one targeted verification, then completion.',
      '- If verification needs an unavailable tool, discover one compatible alternative at most.',
      '- Keep failed verification output compact; include only the first relevant errors needed to fix the issue.',
    ].join('\n');
  }

  return appendSearchDiscipline(promptWithLanguage);
}

// =============================================================================
// Single Session Runner
// =============================================================================

/**
 * Run a single agent session and return the result.
 * Used as the runSession callback for BuildOrchestrator and QALoop.
 */
async function runSingleSession(
  agentType: AgentType,
  phase: Phase,
  systemPrompt: string,
  specDir: string,
  projectDir: string,
  sessionNumber: number,
  subtaskId: string | undefined,
  baseSession: SerializableSessionConfig,
  toolContext: ToolContext,
  registry: ToolRegistry,
  initialUserMessage?: string,
  skipPhaseLogging = false,
  outputSchema?: import('zod').ZodSchema,
): Promise<SessionResult> {
  // Use queue-resolved model ID from baseSession (already mapped to the correct
  // provider-specific model, e.g., 'gpt-5.3-codex' for OpenAI Codex).
  // getPhaseModel() only knows local shorthands (opus → claude-opus-4-6) and
  // would create a mismatch when the provider queue selected a non-Anthropic account.
  const phaseModelId = baseSession.modelId;
  const phaseThinking = await getPhaseThinking(specDir, phase);
  const memorySessionId = `${config.taskId}:${agentType}:${phase}:${sessionNumber}:${subtaskId ?? 'task'}`;
  const projectId = config.projectId || config.taskId;

  const model = createSessionModel(baseSession, phaseModelId);

  const tools: Record<string, AITool> = {
    ...registry.getToolsForAgent(agentType, toolContext),
    ...(memoryProxy
      ? {
          search_memory: createSearchMemoryTool(memoryProxy, projectId),
          record_memory: createRecordMemoryTool(memoryProxy, projectId, memorySessionId),
        }
      : {}),
    ...(mergeMcpTools(mcpClients) as Record<string, AITool>),
  };

  // Build initial messages: use provided kickoff message, or fall back to session messages
  const initialMessages = appendLanguageRequirementToMessages(
    initialUserMessage
      ? [{ role: 'user' as const, content: initialUserMessage }]
      : baseSession.initialMessages,
    baseSession.language,
  );

  // Resolve context window limit from model metadata
  const contextWindowLimit = getModelContextWindow(phaseModelId);

  const sessionConfig: SessionConfig = {
    agentType,
    model,
    systemPrompt: appendLanguageRequirement(systemPrompt, baseSession.language),
    initialMessages,
    toolContext,
    maxSteps: resolvePhaseStepBudget(baseSession, phase),
    thinkingLevel: phaseThinking as SessionConfig['thinkingLevel'],
    abortSignal: abortController.signal,
    specDir,
    projectDir,
    phase,
    modelShorthand: undefined,
    sessionNumber,
    subtaskId,
    contextWindowLimit,
    outputSchema,
  };

  // Start phase logging for this session (skip when orchestrator manages phases)
  if (logWriter && !skipPhaseLogging) {
    logWriter.startPhase(phase);
  }
  if (logWriter && subtaskId) {
    logWriter.setSubtask(subtaskId);
  }

  const runnerOptions = {
    tools,
    memoryContext: memoryProxy ? { proxy: memoryProxy } : undefined,
    onEvent: (event: StreamEvent) => {
      // Write stream events to task_logs.jsonl for UI log display
      if (logWriter) {
        logWriter.processEvent(event, phase, subtaskId);
      }
      // Also relay to main thread for real-time progress updates
      postMessage({
        type: 'stream-event',
        taskId: config.taskId,
        data: event,
        projectId: config.projectId,
        phase: toTaskLogPhase(phase),
        subtaskId,
        sessionNumber,
        provider: baseSession.provider,
        modelId: phaseModelId,
      });
    },
    onAuthRefresh: baseSession.configDir
      ? () => refreshOAuthTokenReactive(baseSession.configDir as string)
      : undefined,
    onModelRefresh: baseSession.configDir
      ? (newToken: string) => createProvider({
          config: {
            provider: baseSession.provider as SupportedProvider,
            apiKey: newToken,
            baseURL: baseSession.baseURL,
          },
          modelId: phaseModelId,
        })
      : undefined,
  };

  let sessionResult: SessionResult;
  try {
    sessionResult = await runContinuableSessionWithGatewayFallback(sessionConfig, runnerOptions, {
      contextWindowLimit,
      apiKey: baseSession.apiKey,
      baseURL: baseSession.baseURL,
      oauthTokenFilePath: baseSession.oauthTokenFilePath,
    }, baseSession, phaseModelId);
  } catch (error) {
    // Ensure log cleanup happens on failure
    if (logWriter && !skipPhaseLogging) logWriter.endPhase(phase, false);
    if (logWriter) logWriter.setSubtask(undefined);
    throw error;
  }

  // End phase logging — mark as completed or failed based on outcome (skip when orchestrator manages phases)
  if (logWriter && !skipPhaseLogging) {
    const success = sessionResult.outcome === 'completed' || sessionResult.outcome === 'max_steps' || sessionResult.outcome === 'context_window';
    logWriter.endPhase(phase, success);
  }
  if (logWriter) {
    logWriter.setSubtask(undefined);
  }

  return sessionResult;
}

// =============================================================================
// Session Execution
// =============================================================================

async function run(): Promise<void> {
  const { session } = config;

  postLog(`Starting agent session: type=${session.agentType}, model=${session.modelId}`);

  try {
    const securityProfile = buildSecurityProfile(session);
    const toolContext = buildToolContext(session, securityProfile, fileCache);
    const registry = buildToolRegistry();

    // Initialize MCP clients from session config
    try {
      const customMcpServers = session.mcpOptions?.customMcpServers ?? [];
      const customServerIds = customMcpServers
        .map((server) => server.id)
        .filter((id): id is string => Boolean(id));

      mcpClients = await createMcpClientsForAgent(session.agentType, {
        context7Enabled: session.mcpOptions?.context7Enabled ?? true,
        memoryEnabled: session.mcpOptions?.memoryEnabled ?? false,
        linearEnabled: session.mcpOptions?.linearEnabled ?? false,
        yunxiaoEnabled: session.mcpOptions?.yunxiaoEnabled ?? false,
        electronMcpEnabled: session.mcpOptions?.electronMcpEnabled ?? false,
        puppeteerMcpEnabled: session.mcpOptions?.puppeteerMcpEnabled ?? false,
        projectCapabilities: session.mcpOptions?.projectCapabilities,
        agentMcpAdd: session.mcpOptions?.agentMcpAdd,
        agentMcpRemove: session.mcpOptions?.agentMcpRemove,
        customServerIds,
      }, {
        specDir: session.specDir,
        env: session.mcpOptions?.mcpEnv,
        customServers: customMcpServers,
      });
      if (mcpClients.length > 0) {
        postLog(`MCP initialized: ${mcpClients.map(c => c.serverId).join(', ')}`);
      }
    } catch (error) {
      postLog(`MCP init failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    }

    const executionPlan = resolveAutocodeAgentExecutionPlan({
      agentType: session.agentType,
      workflowMode: session.workflowMode,
      useAgenticOrchestration: session.useAgenticOrchestration,
    });

    switch (executionPlan.kind) {
      case 'build-orchestrator':
        await runBuildOrchestrator(session, toolContext, registry);
        return;
      case 'qa-loop':
        await runQALoop(session, toolContext, registry);
        return;
      case 'spec-orchestrator-agentic':
        await runAgenticSpecOrchestrator(session, toolContext, registry);
        return;
      case 'spec-orchestrator':
        await runSpecOrchestrator(session, toolContext, registry);
        return;
      case 'default-session':
        await runDefaultSession(session, toolContext, registry);
        return;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    postError(`Agent session failed: ${message}`);
  } finally {
    // Log file cache statistics
    const cacheStats = fileCache.getStats();
    if (cacheStats.hits > 0 || cacheStats.misses > 0) {
      const cachedMiB = (cacheStats.bytes / (1024 * 1024)).toFixed(1);
      const maxMiB = (cacheStats.maxBytes / (1024 * 1024)).toFixed(0);
      postLog(`[FileCache] Session Stats: ${cacheStats.hits} hits, ${cacheStats.misses} misses, ${(cacheStats.hitRate * 100).toFixed(1)}% hit rate, ${cacheStats.size}/${cacheStats.maxEntries} files cached, ${cachedMiB}/${maxMiB} MiB`);
    }

    // Cleanup MCP clients
    if (mcpClients.length > 0) {
      await closeAllMcpClients(mcpClients);
    }
  }
}

function isDirectTaskSession(session: SerializableSessionConfig): boolean {
  return isAutocodeDirectTaskExecution(session);
}

function isSuccessfulDirectOutcome(result: SessionResult | undefined): boolean {
  return isAutocodeSuccessfulDirectOutcome(result);
}

type DirectCodingQualityMetrics = AutocodeDirectCodingQualityMetrics;

function buildDirectCompletionSummaryV2(
  session: SerializableSessionConfig,
  result: SessionResult | undefined,
  streamedText: string,
  quality?: DirectCodingQualityMetrics,
): string {
  return buildAutocodeDirectCompletionSummaryV2({
    specDir: session.specDir,
    language: session.language,
    result,
    streamedText,
    quality,
  });
}

async function evaluateDirectCodingQuality(
  session: SerializableSessionConfig,
  result: SessionResult | undefined,
  changedFiles: string[],
  streamedText = '',
): Promise<DirectCodingQualityMetrics> {
  const metrics: DirectCodingQualityMetrics = {
    mode: 'direct',
    outcome: result?.outcome ?? 'unknown',
    changedFiles,
    filesChanged: changedFiles.length,
    stepsExecuted: result?.stepsExecuted ?? 0,
    toolCallCount: result?.toolCallCount ?? 0,
    durationMs: result?.durationMs ?? 0,
    recordedAt: new Date().toISOString(),
    validation: inferAutocodeDirectValidationEvidence(result, streamedText),
  };

  if (!isSuccessfulDirectOutcome(result) || changedFiles.length === 0) {
    metrics.selfCritique = {
      status: 'skipped',
      filesReviewed: 0,
      improvements: [],
    };
    return metrics;
  }

  try {
    const generatedFiles = await loadGeneratedFilesForCritique(session.projectDir, changedFiles);
    if (generatedFiles.length === 0) {
      metrics.selfCritique = {
        status: 'skipped',
        filesReviewed: 0,
        improvements: [],
      };
      return metrics;
    }

    const { runSelfCritique } = await import('../orchestration/self-critique');
    const critique = await runSelfCritique({
      generatedFiles,
      subtask: {
        id: 'direct-implementation',
        description: extractDirectTaskDescription(session),
        filesToModify: changedFiles,
      },
      projectDir: session.projectDir,
      specDir: session.specDir,
      minScore: 0.75,
    });

    metrics.selfCritique = {
      status: critique.passed ? 'passed' : 'failed',
      score: critique.score,
      filesReviewed: generatedFiles.length,
      improvements: critique.improvements.slice(0, 10),
    };
  } catch (error) {
    metrics.selfCritique = {
      status: 'skipped',
      filesReviewed: 0,
      improvements: [`Self-critique unavailable: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  return metrics;
}

function extractDirectTaskDescription(session: SerializableSessionConfig): string {
  return extractAutocodeDirectTaskDescription({
    initialMessages: session.initialMessages,
    specDir: session.specDir,
  });
}

function extractFilePathFromToolArgs(args: Record<string, unknown>): string | null {
  return extractAutocodeDirectFilePathFromToolArgs(args);
}

function shouldTrackDirectModifiedFile(toolName: string): boolean {
  return shouldTrackAutocodeDirectModifiedFile(toolName);
}

function getDirectSessionSubtaskId(session: SerializableSessionConfig): string {
  return session.subtaskId?.trim() || 'direct-implementation';
}

function shouldRequireDirectValidation(session: SerializableSessionConfig): boolean {
  return !isNonImplementationDirectSession(session);
}

function isNonImplementationDirectSession(session: SerializableSessionConfig): boolean {
  const specDirs = Array.from(new Set([
    session.specDir,
    session.sourceSpecDir,
  ].filter((value): value is string => Boolean(value))));

  return specDirs.some((specDir) => isNonImplementationDirectContext(
    loadDirectContextPlan(specDir),
    loadDirectContextMetadata(specDir),
  ));
}

function loadDirectContextPlan(specDir: string): Record<string, unknown> {
  try {
    return directRecordValue(loadImplementationPlanFromFilesSync(specDir));
  } catch {
    return {};
  }
}

function loadDirectContextMetadata(specDir: string): Record<string, unknown> {
  const metadataPath = join(specDir, 'task_metadata.json');
  if (!existsSync(metadataPath)) {
    return {};
  }
  try {
    return directRecordValue(JSON.parse(readFileSync(metadataPath, 'utf-8')));
  } catch {
    return {};
  }
}

function isNonImplementationDirectContext(
  plan: Record<string, unknown>,
  metadata: Record<string, unknown>,
): boolean {
  const workflowType = directNormalizedString(plan.workflow_type) ||
    directNormalizedString(metadata.workflow_type) ||
    directNormalizedString(metadata.workflowType);
  if (['documentation', 'investigation', 'analysis', 'research'].includes(workflowType)) {
    return true;
  }

  const metadataCategory = directNormalizedString(metadata.category);
  const metadataSource = directNormalizedString(metadata.sourceType) || directNormalizedString(metadata.source_type);
  const metadataIdeaType = directNormalizedString(metadata.ideationType) || directNormalizedString(metadata.ideation_type);
  const metadataTaskType = directNormalizedString(metadata.taskType) || directNormalizedString(metadata.task_type) || directNormalizedString(metadata.type);

  if (metadataCategory === 'documentation' || metadataSource === 'project_docs') {
    return true;
  }
  if (['documentation_gaps', 'documentation', 'analysis', 'investigation', 'research'].includes(metadataIdeaType)) {
    return true;
  }
  if (['documentation', 'analysis', 'investigation', 'research'].includes(metadataTaskType)) {
    return true;
  }
  if (
    directStringValue(metadata.projectDocumentType) ||
    directStringValue(metadata.project_document_type) ||
    directStringValue(metadata.projectDocumentOutputDir) ||
    directStringValue(metadata.project_document_output_dir) ||
    Array.isArray(metadata.projectDocumentOutputs) ||
    Array.isArray(metadata.project_document_outputs)
  ) {
    return true;
  }
  if (
    directStringValue(plan.documentation_depth) ||
    directStringValue(plan.documentation_profile) ||
    Array.isArray(plan.documentation_focus) ||
    Object.keys(directRecordValue(plan.project_documentation)).length > 0
  ) {
    return true;
  }

  return false;
}

function directRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function directStringValue(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function directNormalizedString(value: unknown): string {
  return directStringValue(value).toLowerCase();
}

function applyDirectQualityGateToResult(
  session: SerializableSessionConfig,
  result: SessionResult | undefined,
  quality: DirectCodingQualityMetrics,
): SessionResult | undefined {
  if (!result || !isSuccessfulDirectOutcome(result)) {
    return result;
  }

  const failureReason = getAutocodeDirectQualityGateFailureReason(quality, {
    requireValidation: shouldRequireDirectValidation(session),
  });
  if (!failureReason) {
    return result;
  }

  return {
    ...result,
    outcome: 'error',
    error: {
      code: 'direct_quality_gate_failed',
      message: failureReason,
      retryable: true,
    },
  };
}

function ensureDirectPlanPhase(plan: ShardableImplementationPlan): {
  phase?: number;
  id?: string;
  name?: string;
  type?: string;
  subtasks?: Array<Record<string, unknown>>;
} {
  if (!Array.isArray(plan.phases)) {
    plan.phases = [];
  }

  let directPhase = plan.phases.find((phase) => phase.type === 'direct') as
    | {
        phase?: number;
        id?: string;
        name?: string;
        type?: string;
        subtasks?: Array<Record<string, unknown>>;
      }
    | undefined;
  if (!directPhase) {
    directPhase = {
      id: 'direct',
      phase: 1,
      name: 'Direct execution',
      type: 'direct',
      subtasks: [],
    };
    plan.phases.unshift(directPhase);
  }

  directPhase.id = directPhase.id ?? 'direct';
  directPhase.phase = typeof directPhase.phase === 'number' ? directPhase.phase : 1;
  directPhase.name = directPhase.name || 'Direct execution';
  directPhase.type = 'direct';
  if (!Array.isArray(directPhase.subtasks)) {
    directPhase.subtasks = [];
  }
  return directPhase;
}

function persistDirectTaskCompletion(
  session: SerializableSessionConfig,
  result: SessionResult | undefined,
  streamedText: string,
  modifiedFiles: string[] = [],
  quality?: DirectCodingQualityMetrics,
): void {
  const success = isSuccessfulDirectOutcome(result);
  const summary = buildDirectCompletionSummaryV2(session, result, streamedText, quality);
  const now = new Date().toISOString();
  const directSubtaskId = getDirectSessionSubtaskId(session);
  const specDirs = Array.from(new Set([
    session.specDir,
    session.sourceSpecDir,
  ].filter((value): value is string => Boolean(value))));

  for (const specDir of specDirs) {
    try {
      const existingPlan = loadImplementationPlanFromFilesSync(specDir);
      const plan: ShardableImplementationPlan = existingPlan ?? {
        feature: basename(specDir),
        workflow_type: 'direct',
        phases: [],
        created_at: now,
        updated_at: now,
      };

      plan.feature = typeof plan.feature === 'string' && plan.feature.trim()
        ? plan.feature
        : basename(specDir);
      plan.workflow_type = 'direct';
      plan.status = success ? 'human_review' : 'error';
      plan.planStatus = success ? 'review' : 'pending';
      plan.reviewReason = success ? 'completed' : 'errors';
      plan.xstateState = success ? 'human_review' : 'error';
      plan.executionPhase = success ? 'complete' : 'failed';
      plan.direct_execution = buildAutocodeDirectExecutionMetadata({
        existing: typeof plan.direct_execution === 'object' && plan.direct_execution !== null
          ? plan.direct_execution as Record<string, unknown>
          : null,
        outcome: result?.outcome ?? 'unknown',
        completedAt: now,
        currentSubtaskId: directSubtaskId,
        quality,
      });
      plan.updated_at = now;
      if (!plan.created_at) {
        plan.created_at = now;
      }
      const directPhase = ensureDirectPlanPhase(plan);
      const subtasks = directPhase.subtasks ?? [];
      let currentSubtask = subtasks.find((subtask) => subtask.id === directSubtaskId);
      if (!currentSubtask) {
        currentSubtask = {
          id: directSubtaskId,
          title: directSubtaskId === 'direct-implementation'
            ? 'Direct model execution'
            : 'Direct Request Changes',
          description: extractDirectTaskDescription(session),
          created_at: now,
        };
        subtasks.push(currentSubtask);
      }

      currentSubtask.title = typeof currentSubtask.title === 'string' && currentSubtask.title.trim()
        ? currentSubtask.title
        : directSubtaskId === 'direct-implementation'
          ? 'Direct model execution'
          : 'Direct Request Changes';
      currentSubtask.description = typeof currentSubtask.description === 'string' && currentSubtask.description.trim()
        ? currentSubtask.description
        : extractDirectTaskDescription(session);
      currentSubtask.status = success ? 'completed' : 'failed';
      currentSubtask.files_to_modify = modifiedFiles;
      currentSubtask.completion_summary = summary;
      currentSubtask.notes = summary;
      currentSubtask.completed_at = now;
      currentSubtask.verification = {
        type: 'manual',
        scenario: 'Review the completion summary, runtime log, and git changes.',
      };
      plan.final_acceptance = Array.isArray(plan.final_acceptance) && plan.final_acceptance.length > 0
        ? plan.final_acceptance
        : ['Manual reviewer approves the direct execution summary and git changes.'];

      writeFileSync(join(specDir, 'direct_summary.md'), summary, 'utf-8');
      saveImplementationPlanToFilesSync(specDir, plan);

      const existingState = resolveAutocodeDirectSessionState(specDir, session.sourceSpecDir);
      saveAutocodeDirectSessionState(specDir, {
        version: AUTOCODE_DIRECT_SESSION_STATE_VERSION,
        sessionId: session.sessionId ?? result?.usage.sessionId ?? existingState?.sessionId ?? crypto.randomUUID(),
        createdAt: existingState?.createdAt ?? now,
        updatedAt: now,
        iteration: (existingState?.iteration ?? 0) + 1,
        provider: session.provider,
        modelId: session.modelId,
        providerResponseId: result?.providerResponseId ?? existingState?.providerResponseId,
        originalRequest: existingState?.originalRequest ?? extractDirectTaskDescription(session),
        latestSummary: summary,
        changedFiles: modifiedFiles,
        lastOutcome: result?.outcome ?? 'unknown',
      });
    } catch (error) {
      postLog(`Direct completion summary persistence failed for ${specDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

interface DirectAttemptTrace {
  streamedText: string;
  modifiedFiles: Set<string>;
}

interface DirectExecutionOutcome {
  result: SessionResult;
  streamedText: string;
  modifiedFiles: string[];
  quality: DirectCodingQualityMetrics;
  attemptCount: number;
}

async function runDirectSessionWithValidationRetries(input: {
  session: SerializableSessionConfig;
  sessionConfig: SessionConfig;
  runnerOptions: Parameters<typeof runContinuableSession>[1];
  continuationOptions: Parameters<typeof runContinuableSession>[2];
  modelId: string;
  changedFileBaseline: ChangedFileSnapshot | null;
  modifiedFileHints: Set<string>;
  setActiveAttempt: (attempt: DirectAttemptTrace | null) => void;
}): Promise<DirectExecutionOutcome> {
  const attempts: DirectValidationAttemptFeedback[] = [];
  let currentSessionConfig = input.sessionConfig;

  for (let attempt = 1; attempt <= AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS; attempt += 1) {
    const trace: DirectAttemptTrace = {
      streamedText: '',
      modifiedFiles: new Set<string>(),
    };
    input.setActiveAttempt(trace);

    let attemptResult: SessionResult;
    try {
      attemptResult = await runDirectSessionWithGatewayFallback(
        currentSessionConfig,
        input.runnerOptions,
        input.continuationOptions,
        input.session,
        input.modelId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attemptResult = buildDirectSessionErrorResult(message);
      postError(`Direct task session failed: ${message}`);
    } finally {
      input.setActiveAttempt(null);
    }

    const modifiedFiles = await collectDirectModifiedFiles(
      input.session,
      input.changedFileBaseline,
      input.modifiedFileHints,
    );
    const quality = await evaluateDirectCodingQuality(
      input.session,
      attemptResult,
      modifiedFiles,
      trace.streamedText,
    );
    const gatedResult = applyDirectQualityGateToResult(input.session, attemptResult, quality) ?? attemptResult;
    const feedback: DirectValidationAttemptFeedback = {
      attempt,
      result: gatedResult,
      quality,
      streamedText: trace.streamedText,
      modifiedFiles,
      failureReason: getDirectAttemptFailureReason(gatedResult),
    };
    attempts.push(feedback);

    if (!shouldRetryDirectValidationAttempt(gatedResult, attempt, AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS)) {
      const mergedResult = mergeDirectValidationAttemptResults(gatedResult, attempts);
      return {
        result: mergedResult,
        streamedText: trace.streamedText,
        modifiedFiles,
        quality: applyDirectAttemptTotalsToQuality(quality, mergedResult, modifiedFiles),
        attemptCount: attempt,
      };
    }

    postLog(
      `Direct validation attempt ${attempt}/${AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS} failed: ${gatedResult.error?.message ?? 'quality gate failed'}. Retrying with corrective feedback.`,
    );
    currentSessionConfig = buildDirectRetrySessionConfig(
      currentSessionConfig,
      input.session,
      attempts,
      attempt + 1,
      AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS,
    );
  }

  const last = attempts[attempts.length - 1];
  const fallbackResult = last?.result ?? buildDirectSessionErrorResult('Direct task ended without a result.');
  const mergedResult = mergeDirectValidationAttemptResults(fallbackResult, attempts);
  return {
    result: mergedResult,
    streamedText: last?.streamedText ?? '',
    modifiedFiles: last?.modifiedFiles ?? [],
    quality: applyDirectAttemptTotalsToQuality(last?.quality ?? buildFallbackDirectQuality(mergedResult), mergedResult, last?.modifiedFiles ?? []),
    attemptCount: attempts.length,
  };
}

async function collectDirectModifiedFiles(
  session: SerializableSessionConfig,
  changedFileBaseline: ChangedFileSnapshot | null,
  modifiedFileHints: Set<string>,
): Promise<string[]> {
  return changedFileBaseline
    ? collectFilesChangedSinceBaseline(session.projectDir, changedFileBaseline, [...modifiedFileHints])
    : [...modifiedFileHints];
}

function buildDirectSessionErrorResult(message: string): SessionResult {
  return {
    outcome: 'error',
    stepsExecuted: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    toolCallCount: 0,
    durationMs: 0,
    error: {
      code: 'direct_session_error',
      message,
      retryable: false,
    },
  };
}

function getDirectAttemptFailureReason(result: SessionResult): string {
  return result.error?.message ?? `Direct task ended with outcome ${result.outcome}`;
}

function applyDirectAttemptTotalsToQuality(
  quality: DirectCodingQualityMetrics,
  result: SessionResult,
  modifiedFiles: string[],
): DirectCodingQualityMetrics {
  return {
    ...quality,
    outcome: result.outcome,
    changedFiles: modifiedFiles,
    filesChanged: modifiedFiles.length,
    stepsExecuted: result.stepsExecuted,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
  };
}

function buildFallbackDirectQuality(result: SessionResult): DirectCodingQualityMetrics {
  return {
    mode: 'direct',
    outcome: result.outcome,
    changedFiles: [],
    filesChanged: 0,
    stepsExecuted: result.stepsExecuted,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    recordedAt: new Date().toISOString(),
    selfCritique: {
      status: 'skipped',
      filesReviewed: 0,
      improvements: [],
    },
    validation: inferAutocodeDirectValidationEvidence(result),
  };
}

async function learnFromDirectTaskSession(
  session: SerializableSessionConfig,
  result: SessionResult | undefined,
  modifiedFiles: string[] = [],
): Promise<void> {
  if (!memoryProxy || !result) {
    return;
  }

  const projectId = config.projectId || config.taskId;
  const status = isSuccessfulDirectOutcome(result) ? 'completed' : 'stuck';

  try {
    const { learnFromSession } = await import('../orchestration/quality-integration');
    await learnFromSession(
      {
        id: 'direct-implementation',
        description: extractDirectTaskDescription(session),
        phaseName: 'Direct execution',
        filesToCreate: [],
        filesToModify: modifiedFiles,
        patternFiles: [],
        verification: 'Review direct_summary.md, runtime logs, and git changes.',
        status,
      },
      result,
      {
        enableActiveMemoryLearning: true,
        memoryService: createWorkerMemoryService(memoryProxy, projectId),
        projectId,
        projectType: session.projectType,
      },
      session.projectDir,
      session.specDir,
    );
  } catch (error) {
    postLog(`Direct task memory learning failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Run a single agent session (default path for spec_orchestrator, etc.)
 */
async function runDefaultSession(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
  registry: ToolRegistry,
): Promise<void> {
  const model = createSessionModel(session, session.modelId);
  const defaultPhase: Phase = session.phase ?? 'coding';
  const projectId = config.projectId || config.taskId;
  const memorySessionId = [
    config.taskId,
    session.agentType,
    defaultPhase,
    session.sessionNumber ?? 1,
    session.subtaskId ?? (isDirectTaskSession(session) ? 'direct-implementation' : 'task'),
  ].join(':');

  const tools: Record<string, AITool> = {
    ...registry.getToolsForAgent(session.agentType, toolContext),
    ...(memoryProxy
      ? {
          search_memory: createSearchMemoryTool(memoryProxy, projectId),
          record_memory: createRecordMemoryTool(memoryProxy, projectId, memorySessionId),
        }
      : {}),
    ...(mergeMcpTools(mcpClients) as Record<string, AITool>),
  };

  // Resolve context window limit from model metadata
  const contextWindowLimit = getModelContextWindow(session.modelId);

  const baseSessionConfig: SessionConfig = {
    sessionId: session.sessionId,
    agentType: session.agentType,
    model,
    systemPrompt: appendLanguageRequirement(session.systemPrompt, session.language),
    initialMessages: appendLanguageRequirementToMessages(session.initialMessages, session.language),
    toolContext,
    maxSteps: resolvePhaseStepBudget(session, session.phase),
    thinkingLevel: session.thinkingLevel,
    abortSignal: abortController.signal,
    specDir: session.specDir,
    projectDir: session.projectDir,
    phase: session.phase,
    modelShorthand: session.modelShorthand,
    sessionNumber: session.sessionNumber,
    subtaskId: session.subtaskId,
    contextWindowLimit,
    responsePersistence: session.responsePersistence,
    previousResponseId: session.previousResponseId,
  };
  const sessionConfig = isDirectTaskSession(session)
    ? applyDirectProviderSessionPersistence(baseSessionConfig)
    : baseSessionConfig;

  // Start phase logging for default session
  if (logWriter) {
    logWriter.startPhase(defaultPhase);
    if (session.subtaskId) {
      logWriter.setSubtask(session.subtaskId);
    }
  }

  let result: SessionResult | undefined;
  let streamedText = '';
  const directModifiedFiles = new Set<string>();
  let activeDirectAttempt: DirectAttemptTrace | null = null;
  let directChangedFileBaseline: ChangedFileSnapshot | null = null;
  let directExecutionOutcome: DirectExecutionOutcome | undefined;
  try {
    if (isDirectTaskSession(session)) {
      directChangedFileBaseline = await collectGitChangedFileSnapshot(session.projectDir);
    }
    const runnerOptions = {
      tools,
      memoryContext: memoryProxy ? { proxy: memoryProxy } : undefined,
      onEvent: (event: StreamEvent) => {
        if (isDirectTaskSession(session) && event.type === 'text-delta') {
          if (activeDirectAttempt) {
            activeDirectAttempt.streamedText += event.text;
          } else {
            streamedText += event.text;
          }
        }
        if (isDirectTaskSession(session) && event.type === 'tool-call' && shouldTrackDirectModifiedFile(event.toolName)) {
          const filePath = extractFilePathFromToolArgs(event.args);
          if (filePath) {
            directModifiedFiles.add(filePath);
            activeDirectAttempt?.modifiedFiles.add(filePath);
          }
        }
        // Write stream events to task_logs.jsonl for UI log display
        if (logWriter) {
          logWriter.processEvent(event, defaultPhase, session.subtaskId);
        }
        postMessage({
          type: 'stream-event',
          taskId: config.taskId,
          data: event,
          projectId: config.projectId,
          phase: toTaskLogPhase(defaultPhase),
          subtaskId: session.subtaskId,
          sessionNumber: session.sessionNumber,
          provider: session.provider,
          modelId: session.modelId,
        });
      },
      onAuthRefresh: session.configDir
        ? () => refreshOAuthTokenReactive(session.configDir as string)
        : undefined,
      onModelRefresh: session.configDir
        ? (newToken: string) => createProvider({
            config: {
              provider: session.provider as SupportedProvider,
              apiKey: newToken,
              baseURL: session.baseURL,
            },
            modelId: session.modelId,
          })
        : undefined,
    };
    const continuationOptions = {
      contextWindowLimit,
      apiKey: session.apiKey,
      baseURL: session.baseURL,
      oauthTokenFilePath: session.oauthTokenFilePath,
      maxContinuations: isDirectTaskSession(session) ? AUTOCODE_DIRECT_CONTEXT_WINDOW_CONTINUATIONS : undefined,
      contextWindowExhaustedOutcome: isDirectTaskSession(session) ? 'context_window' as const : undefined,
    };

    if (isDirectTaskSession(session)) {
      directExecutionOutcome = await runDirectSessionWithValidationRetries({
        session,
        sessionConfig,
        runnerOptions,
        continuationOptions,
        modelId: session.modelId,
        changedFileBaseline: directChangedFileBaseline,
        modifiedFileHints: directModifiedFiles,
        setActiveAttempt: (attempt) => {
          activeDirectAttempt = attempt;
        },
      });
      result = directExecutionOutcome.result;
    } else {
      result = await runContinuableSessionWithGatewayFallback(
        sessionConfig,
        runnerOptions,
        continuationOptions,
        session,
        session.modelId,
      );
    }
  } catch (error) {
    if (!isDirectTaskSession(session)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    result = {
      outcome: 'error',
      stepsExecuted: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      messages: [],
      toolCallCount: 0,
      durationMs: 0,
      error: {
        code: 'direct_session_error',
        message,
        retryable: false,
      },
    };
    postError(`Direct task session failed: ${message}`);
  } finally {
    if (logWriter) {
      const success = isDirectTaskSession(session)
        ? isSuccessfulDirectOutcome(result)
        : result?.outcome === 'completed' || result?.outcome === 'max_steps' || result?.outcome === 'context_window';
      logWriter.endPhase(defaultPhase, success ?? false);
      logWriter.setSubtask(undefined);
    }
  }

  if (isDirectTaskSession(session)) {
    const modifiedFiles = directExecutionOutcome?.modifiedFiles ?? await collectDirectModifiedFiles(
      session,
      directChangedFileBaseline,
      directModifiedFiles,
    );
    const finalStreamedText = directExecutionOutcome?.streamedText ?? streamedText;
    const directQuality = directExecutionOutcome?.quality ?? await evaluateDirectCodingQuality(
      session,
      result,
      modifiedFiles,
      finalStreamedText,
    );
    if (!directExecutionOutcome) {
      result = applyDirectQualityGateToResult(session, result, directQuality);
    }
    persistDirectTaskCompletion(session, result, finalStreamedText, modifiedFiles, directQuality);
    await learnFromDirectTaskSession(session, result, modifiedFiles);
    if (isSuccessfulDirectOutcome(result)) {
      postTaskEvent('DIRECT_COMPLETED', {
        outcome: result?.outcome ?? 'unknown',
        filesChanged: modifiedFiles.length,
        quality: directQuality,
        attemptCount: directExecutionOutcome?.attemptCount ?? 1,
      });
    } else {
      postTaskEvent('CODING_FAILED', {
        subtaskId: getDirectSessionSubtaskId(session),
        error: result?.error?.message ?? `Direct task ended with outcome ${result?.outcome ?? 'unknown'}`,
        attemptCount: directExecutionOutcome?.attemptCount ?? 1,
      });
    }
  }

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result as SessionResult,
    projectId: config.projectId,
  });
}

/** Map ExecutionPhase to Phase for log writer. Returns undefined for non-loggable phases. */
function mapExecutionPhaseToPhase(executionPhase: ExecutionPhase): Phase | undefined {
  switch (executionPhase) {
    case 'planning': return 'planning';
    case 'coding': return 'coding';
    case 'qa_review': return 'qa';
    case 'qa_fixing': return 'qa';
    default: return undefined; // idle, complete, failed, pause states
  }
}

/**
 * Run the full build orchestration pipeline:
 * planning → coding (per subtask) → QA review → QA fixing
 */
async function runBuildOrchestrator(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
  registry: ToolRegistry,
): Promise<void> {
  postLog('Starting BuildOrchestrator pipeline (planning → coding → QA)');

  const workflowConfig = getWorkflowConfigFromMode(session.workflowMode);
  const agentProfile = resolveProjectAgentProfile(session.projectType);
  const qualityConfig = buildSessionQualityConfig(session, workflowConfig);

  const orchestrator = new BuildOrchestrator({
    specDir: session.specDir,
    projectDir: session.projectDir,
    sourceSpecDir: session.sourceSpecDir,
    maxIterations: isAggressiveWorkflow(session) ? 1 : undefined,
    language: session.language,
    forcePlanning: session.forcePlanning === true,
    abortSignal: abortController.signal,

    runtimeConcurrency: session.runtimeConcurrency ?? resolveAutocodeTaskRuntimeConcurrency({
      workflowMode: session.workflowMode,
    }),
    maxConcurrentWorkItemRetries: 2,

    // Apply workflow optimization config based on task's workflowMode
    workflowConfig,
    qualityConfig,
    agentProfile,

    generatePrompt: async (agentType, _phase, context) => {
      const promptName = resolvePromptNameForAgent(agentType);
      let prompt = await assemblePrompt(promptName, session);

      // Inject schema validation error feedback on retry so the planner knows what to fix
      if (context.planningRetryContext) {
        prompt += `\n\n${context.planningRetryContext}`;
      }

      return prompt;
    },

    runSession: async (runConfig) => {
      postLog(`Running ${runConfig.agentType} session (phase=${runConfig.phase}, session=${runConfig.sessionNumber})`);
      // Build a kickoff message for the agent so it has a task to act on
      const kickoffMessage = buildKickoffMessage(
        runConfig.agentType,
        runConfig.specDir,
        runConfig.projectDir,
        runConfig.subtaskId,
        session.language,
        session.forcePlanning === true && runConfig.phase === 'planning',
      );
      return runSingleSession(
        runConfig.agentType,
        runConfig.phase,
        runConfig.systemPrompt,
        runConfig.specDir,
        runConfig.projectDir,
        runConfig.sessionNumber,
        runConfig.subtaskId,
        session,
        toolContext,
        registry,
        kickoffMessage,
        true, // skipPhaseLogging — orchestrator manages phase start/end
        runConfig.outputSchema,
      );
    },
  });

  orchestrator.on('phase-change', (phase: ExecutionPhase, message: string) => {
    postLog(`Phase: ${phase} — ${message}`);
    // Start the phase in the log writer at orchestrator level (not per-session)
    const logPhase = mapExecutionPhaseToPhase(phase);
    if (logWriter && logPhase) {
      logWriter.startPhase(logPhase, message);
    }
    // Emit XState-compatible task events for phase transitions
    // so the state machine tracks the build lifecycle correctly.
    if (phase === 'coding') {
      postTaskEvent('CODING_STARTED', { subtaskId: '', subtaskDescription: 'Starting coding phase' });
    } else if (phase === 'qa_review') {
      postTaskEvent('QA_STARTED', { iteration: 0, maxIterations: 3 });
    } else if (phase === 'qa_fixing') {
      postTaskEvent('QA_FIXING_STARTED', { iteration: 0 });
    }
    // Emit execution-progress so the main thread can:
    // 1. Re-point the file watcher to the worktree spec dir
    // 2. Update the UI with phase progress
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase,
        phaseProgress: 0,
        overallProgress: 0,
        message,
      },
      projectId: config.projectId,
    });
  });

  orchestrator.on('iteration-start', (iteration: number, phase: ExecutionPhase) => {
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase,
        phaseProgress: 0,
        overallProgress: 0,
        message: `Iteration ${iteration} (${phase})`,
      },
      projectId: config.projectId,
    });
  });

  orchestrator.on('session-complete', (result: SessionResult, phase: string) => {
    // Notify the main process that a session (subtask) completed.
    // This triggers persistPlanPhaseSync → invalidateTasksCache so the frontend
    // sees updated subtask statuses in the implementation plan.
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase: phase as ExecutionPhase,
        phaseProgress: 0,
        overallProgress: 0,
        message: `Session complete (${phase})`,
      },
      projectId: config.projectId,
    });

    // Send token usage from this session
    console.log(`[Worker] Session complete for ${config.taskId}, usage:`, result.usage);
    // Always send usage data, even if totalTokens is 0 (helps with debugging)
    // The UI and persistence layer will handle 0 values appropriately
    if (result.usage) {
      console.log(`[Worker] Sending task-token-usage for ${config.taskId}:`, result.usage);
      postMessage({
        type: 'task-token-usage',
        taskId: config.taskId,
        data: result.usage,
        projectId: config.projectId,
      });
    } else {
      console.warn(`[Worker] No usage object in result for ${config.taskId}`);
    }
  });

  orchestrator.on('log', (message: string) => {
    postLog(message);
  });

  orchestrator.on('error', (error: Error, phase: string) => {
    postLog(`Error in ${phase} phase: ${error.message}`);
  });

  orchestrator.on('build-complete', (outcome: BuildOutcome) => {
    postLog(`Build orchestration complete: success=${outcome.success}, phase=${outcome.finalPhase}`);
  });

  const outcome = await orchestrator.run();

  // End the final phase and flush any remaining accumulated log entries.
  // When the orchestrator reaches 'complete' or 'failed', finalPhase is a terminal
  // state that doesn't map to a log phase. In that case, close whichever log phase
  // is still marked 'active' so the UI shows "Complete" instead of "Running".
  if (logWriter) {
    const finalLogPhase = mapExecutionPhaseToPhase(outcome.finalPhase);
    if (finalLogPhase) {
      logWriter.endPhase(finalLogPhase, outcome.success);
    } else {
      // Terminal state (complete/failed) — close any still-active log phase
      const data = logWriter.getData();
      for (const phase of ['validation', 'coding', 'planning'] as const) {
        if (data.phases[phase]?.status === 'active') {
          const mapped = phase === 'validation' ? 'qa' : phase;
          logWriter.endPhase(mapped as 'qa' | 'coding' | 'planning', outcome.success);
          break;
        }
      }
    }
    logWriter.flush();
  }

  // Emit task events based on orchestration outcome so XState machine
  // can transition to the correct state (e.g., human_review on success).
  if (outcome.success && session.forcePlanning === true && outcome.finalPhase === 'planning') {
    syncRegeneratedPlanToSource(session);
    const plan = loadImplementationPlanFromFilesSync(session.specDir);
    const subtaskCount = countPlanSubtasks(plan);
    postTaskEvent('PLANNING_COMPLETE', {
      hasSubtasks: subtaskCount > 0,
      subtaskCount,
      requireReviewBeforeCoding: true,
    });
  } else if (outcome.success) {
    postTaskEvent('QA_PASSED');
    postTaskEvent('BUILD_COMPLETE');
  } else if (outcome.codingCompleted) {
    // Coding succeeded but QA failed — emit QA-specific event so XState
    // transitions to 'error' with reviewReason='errors' instead of the
    // generic CODING_FAILED which would be misleading.
    postTaskEvent('QA_MAX_ITERATIONS', {
      iteration: outcome.totalIterations,
      maxIterations: 3,
    });
  } else {
    // Pre-QA failure (planning or coding phase)
    postTaskEvent('CODING_FAILED', { error: outcome.error });
  }

  // Map outcome to a SessionResult-compatible result for the bridge
  const result: SessionResult = {
    outcome: outcome.success ? 'completed' : 'error',
    stepsExecuted: outcome.totalIterations,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    toolCallCount: 0,
    durationMs: outcome.durationMs,
    error: outcome.error
      ? { code: 'error', message: outcome.error, retryable: false }
      : undefined,
  };

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result,
    projectId: config.projectId,
  });
}

/**
 * Run the QA validation loop: qa_reviewer → qa_fixer → re-review
 */
async function runQALoop(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
  registry: ToolRegistry,
): Promise<void> {
  postLog('Starting QA validation loop');

  const qaLoop = new QALoop({
    specDir: session.specDir,
    projectDir: session.projectDir,
    maxIterations: isAggressiveWorkflow(session) ? 1 : undefined,
    abortSignal: abortController.signal,
    agentProfile: resolveProjectAgentProfile(session.projectType),

    generatePrompt: async (agentType, _context) => {
      return assemblePrompt(resolvePromptNameForAgent(agentType), session);
    },

    runSession: async (runConfig) => {
      postLog(`Running ${runConfig.agentType} session (session=${runConfig.sessionNumber})`);
      const kickoffMessage = buildKickoffMessage(
        runConfig.agentType,
        runConfig.specDir,
        runConfig.projectDir,
        undefined,
        session.language,
      );
      return runSingleSession(
        runConfig.agentType,
        runConfig.phase,
        runConfig.systemPrompt,
        runConfig.specDir,
        runConfig.projectDir,
        runConfig.sessionNumber,
        undefined,
        session,
        toolContext,
        registry,
        kickoffMessage,
        true, // skipPhaseLogging — QA loop manages phase start/end
      );
    },
  });

  qaLoop.on('log', (message: string) => {
    postLog(message);
  });

  // Start QA validation phase logging at the loop level
  if (logWriter) {
    logWriter.startPhase('qa');
  }

  const outcome = await qaLoop.run();

  // End QA validation phase and flush any remaining accumulated log entries
  if (logWriter) {
    logWriter.endPhase('qa', outcome.approved);
    logWriter.flush();
  }

  // Emit task events so XState machine transitions correctly.
  if (outcome.approved) {
    postTaskEvent('QA_PASSED');
  } else if (outcome.reason === 'max_iterations') {
    postTaskEvent('QA_MAX_ITERATIONS');
  } else {
    postTaskEvent('QA_AGENT_ERROR', { error: outcome.error });
  }

  const result: SessionResult = {
    outcome: outcome.approved ? 'completed' : 'error',
    stepsExecuted: outcome.totalIterations,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    toolCallCount: 0,
    durationMs: outcome.durationMs,
    error: outcome.error
      ? { code: 'error', message: outcome.error, retryable: false }
      : undefined,
  };

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result,
    projectId: config.projectId,
  });
}

/**
 * Run the spec creation orchestration pipeline with complexity-based phase routing.
 */
async function runSpecOrchestrator(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
  registry: ToolRegistry,
): Promise<void> {
  const taskDescription = extractSpecTaskDescriptionFromInitialMessages(session.initialMessages);

  postLog(`Starting SpecOrchestrator pipeline (complexity-first phase routing)`);

  // Load project documentation BEFORE any agent runs so all phases share stable context.
  let projectDocsReference: string | undefined;
  if (isAggressiveWorkflow(session)) {
    postLog('Aggressive workflow enabled: skipping project documentation context injection');
  } else {
    projectDocsReference = buildAutocodeProjectDocsReferencePrompt({
      projectRoot: session.projectDir,
      dataDirName: session.dataDirName,
    });
    if (projectDocsReference) {
      postLog(`Project documentation loaded (${(projectDocsReference.length / 1024).toFixed(1)}KB)`);
    } else {
      postLog('Project documentation not found; continuing with targeted source reads');
    }
  }

  const orchestrator = new SpecOrchestrator({
    specDir: session.specDir,
    projectDir: session.projectDir,
    taskDescription,
    complexityOverride: isAggressiveWorkflow(session) ? 'simple' : undefined,
    useAiAssessment: !isAggressiveWorkflow(session),
    workflowConfig: getWorkflowConfigFromMode(session.workflowMode),
    projectDocsReference,
    language: session.language,
    abortSignal: abortController.signal,
    agentProfile: resolveProjectAgentProfile(session.projectType),

    generatePrompt: async (_agentType, phase, context) => {
      const promptName = session.projectType === 'game-mmo'
        ? resolvePromptNameForAgent(_agentType)
        : specPhaseToPromptName(phase);
      let prompt = await assemblePrompt(promptName, session);

      // Inject schema validation error feedback on retry so the agent knows what to fix
      if (context.schemaRetryContext) {
        prompt += `\n\n${context.schemaRetryContext}`;
      }

      return prompt;
    },

    runSession: async (runConfig) => {
      postLog(`Running ${runConfig.agentType} session (spec phase=${runConfig.specPhase ?? runConfig.phase}, session=${runConfig.sessionNumber})`);
      const kickoffMessage = buildSpecKickoffMessage(
        runConfig.agentType,
        runConfig.specDir,
        runConfig.projectDir,
        taskDescription,
        runConfig.priorPhaseOutputs,
        runConfig.projectDocsReference,
        runConfig.specPhase,
        session.language,
      );
      // Spec agents can only write to the spec directory
      const specToolContext: ToolContext = {
        ...toolContext,
        allowedWritePaths: getSpecWritePaths(session),
      };
      return runSingleSession(
        runConfig.agentType,
        runConfig.phase,
        runConfig.systemPrompt,
        runConfig.specDir,
        runConfig.projectDir,
        runConfig.sessionNumber,
        undefined,
        session,
        specToolContext,
        registry,
        kickoffMessage,
        true, // skipPhaseLogging — orchestrator manages phase start/end
        runConfig.outputSchema,
      );
    },
  });

  // Wire event listeners
  orchestrator.on('phase-start', (phase: SpecPhase, phaseNumber: number, totalPhases: number) => {
    const displayPhase = getSpecPhaseDisplayName(phase, session.language);
    postLog(`Spec phase ${phaseNumber}/${totalPhases}: ${displayPhase}`);
    if (logWriter) {
      logWriter.startPhase('spec', `${displayPhase} (${phaseNumber}/${totalPhases})`);
    }
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase: 'planning', // spec creation maps to 'planning' in the UI execution phases
        phaseProgress: phaseNumber / Math.max(totalPhases, 1),
        overallProgress: phaseNumber / Math.max(totalPhases, 1),
        message: `Standard planning: ${displayPhase} (${phaseNumber}/${totalPhases})`,
      },
      projectId: config.projectId,
    });
  });

  orchestrator.on('phase-complete', (_phase: SpecPhase, _result: unknown) => {
    // End the current spec log phase so the next one can start fresh
    if (logWriter) {
      logWriter.endPhase('spec', true);
    }
  });

  orchestrator.on('log', (message: string) => {
    postLog(message);
  });

  orchestrator.on('error', (error: Error, phase: SpecPhase) => {
    postLog(`Error in spec ${getSpecPhaseDisplayName(phase, session.language)} phase: ${error.message}`);
  });

  const outcome = await orchestrator.run();

  // Emit task event on failure so XState gets a specific signal
  // instead of relying on the generic PROCESS_EXITED fallback.
  if (!outcome.success) {
    postTaskEvent('PLANNING_FAILED', { error: outcome.error });
  }

  // Ensure any still-active log phase is closed and flushed
  if (logWriter) {
    const data = logWriter.getData();
    // toLogPhase('spec') maps to 'planning' in the log writer
    if (data.phases.planning?.status === 'active') {
      logWriter.endPhase('spec', outcome.success);
    }
    logWriter.flush();
  }

  // Map outcome to SessionResult for the worker bridge
  const result: SessionResult = {
    outcome: outcome.success ? 'completed' : 'error',
    stepsExecuted: outcome.phasesExecuted.length,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    toolCallCount: 0,
    durationMs: outcome.durationMs,
    error: outcome.error
      ? { code: 'error', message: outcome.error, retryable: false }
      : undefined,
  };

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result,
    projectId: config.projectId,
  });
}

/**
 * Run the spec creation pipeline using agentic orchestration.
 * Instead of procedural phase routing, an AI orchestrator agent drives the
 * entire pipeline using tools (including SpawnSubagent for specialist work).
 */
async function runAgenticSpecOrchestrator(
  session: SerializableSessionConfig,
  toolContext: ToolContext,
  registry: ToolRegistry,
): Promise<void> {
  const taskDescription = extractSpecTaskDescriptionFromInitialMessages(session.initialMessages);

  postLog('Starting Agentic SpecOrchestrator (AI-driven pipeline via SpawnSubagent)');

  const projectDocsReference = buildAutocodeProjectDocsReferencePrompt({
    projectRoot: session.projectDir,
    dataDirName: session.dataDirName,
  });
  if (projectDocsReference) {
    postLog(`Project documentation loaded (${(projectDocsReference.length / 1024).toFixed(1)}KB)`);
  } else {
    postLog('Project documentation not found; continuing with targeted source reads');
  }

  // Create the SubagentExecutor
  const model = createSessionModel(session, session.modelId);

  const executor = new SubagentExecutorImpl({
    model,
    registry,
    baseToolContext: {
      ...toolContext,
      allowedWritePaths: getSpecWritePaths(session),
    },
    loadPrompt: async (promptName: string) => assemblePrompt(promptName, session),
    abortSignal: abortController.signal,
    onSubagentEvent: (agentType: string, event: string) => {
      postLog(`Subagent ${agentType}: ${event}`);
    },
  });

  // Create an extended tool context with the executor
  const orchestratorToolContext: ToolContext & { subagentExecutor: SubagentExecutorImpl } = {
    ...toolContext,
    allowedWritePaths: getSpecWritePaths(session),
    subagentExecutor: executor,
  };

  // Load the agentic orchestrator prompt
  const systemPrompt = await assemblePrompt('spec_orchestrator_agentic', session);

  // Build the kickoff message through the shared helper so context budgets stay consistent.
  const kickoffMessage = buildAutocodeAgenticSpecOrchestratorKickoffMessage({
    taskDescription,
    specDir: session.specDir,
    projectDir: session.projectDir,
    projectDocsReference,
  });

  // Resolve context window and tools
  const contextWindowLimit = getModelContextWindow(session.modelId);
  const phaseThinking = await getPhaseThinking(session.specDir, 'spec');

  // Get tools for the orchestrator (includes SpawnSubagent since it's in AGENT_CONFIGS)
  const tools: Record<string, AITool> = {
    ...registry.getToolsForAgent(session.agentType, orchestratorToolContext),
    ...(mergeMcpTools(mcpClients) as Record<string, AITool>),
  };

  const sessionConfig: SessionConfig = {
    agentType: session.agentType,
    model,
    systemPrompt,
    initialMessages: [{ role: 'user' as const, content: kickoffMessage }],
    toolContext: orchestratorToolContext,
    maxSteps: resolvePhaseStepBudget(session, 'spec'),
    thinkingLevel: phaseThinking as SessionConfig['thinkingLevel'],
    abortSignal: abortController.signal,
    specDir: session.specDir,
    projectDir: session.projectDir,
    phase: 'spec',
    sessionNumber: 1,
    contextWindowLimit,
  };

  // Start phase logging
  if (logWriter) {
    logWriter.startPhase('spec', 'Agentic spec orchestration');
  }

  let result: SessionResult | undefined;
  try {
    result = await runContinuableSessionWithGatewayFallback(sessionConfig, {
      tools,
      onEvent: (event: StreamEvent) => {
        if (logWriter) {
          logWriter.processEvent(event, 'spec', session.subtaskId);
        }
        postMessage({
          type: 'stream-event',
          taskId: config.taskId,
          data: event,
          projectId: config.projectId,
          phase: toTaskLogPhase('spec'),
          subtaskId: session.subtaskId,
          sessionNumber: session.sessionNumber,
          provider: session.provider,
          modelId: session.modelId,
        });
      },
      onAuthRefresh: session.configDir
        ? () => refreshOAuthTokenReactive(session.configDir as string)
        : undefined,
      onModelRefresh: session.configDir
        ? (newToken: string) => createProvider({
            config: {
              provider: session.provider as SupportedProvider,
              apiKey: newToken,
              baseURL: session.baseURL,
            },
            modelId: session.modelId,
          })
        : undefined,
    }, {
      contextWindowLimit,
      apiKey: session.apiKey,
      baseURL: session.baseURL,
      oauthTokenFilePath: session.oauthTokenFilePath,
    }, session, session.modelId);
  } finally {
    if (logWriter) {
      const success = result?.outcome === 'completed' || result?.outcome === 'max_steps' || result?.outcome === 'context_window';
      logWriter.endPhase('spec', success ?? false);
      logWriter.flush();
    }
  }

  postMessage({
    type: 'result',
    taskId: config.taskId,
    data: result as SessionResult,
    projectId: config.projectId,
  });
}

/**
 * Build a kickoff user message for a spec phase session.
 * Includes accumulated context from prior phases to eliminate redundant file reads.
 */
function buildSpecKickoffMessage(
  agentType: AgentType,
  specDir: string,
  projectDir: string,
  taskDescription: string,
  priorPhaseOutputs?: Record<string, string>,
  projectDocsReference?: string,
  specPhase?: string,
  language?: SerializableSessionConfig['language'],
): string {
  return buildAutocodeSpecKickoffMessage({
    agentType,
    specDir,
    projectDir,
    taskDescription,
    priorPhaseOutputs,
    projectDocsReference,
    specPhase,
    language,
  });
}

/**
 * Build a kickoff user message for an agent session.
 * The AI SDK requires at least one user message; this provides a concrete task directive.
 */
function buildKickoffMessage(
  agentType: AgentType,
  specDir: string,
  projectDir: string,
  subtaskId?: string,
  language?: SerializableSessionConfig['language'],
  forcePlanning?: boolean,
): string {
  const promptSpecDir = formatPathForPrompt(specDir);
  const promptProjectDir = formatPathForPrompt(projectDir);
  return buildAutocodeAgentKickoffMessage({
    agentType,
    specDir,
    projectDir,
    subtaskId,
    language,
    forcePlanning,
    focusedCoderKickoff: subtaskId
      ? buildFocusedCoderKickoffMessage(promptSpecDir, promptProjectDir, subtaskId)
      : undefined,
  });
}

/**
 * Build a minimal fallback prompt when the prompts directory is not found.
 */
function buildFallbackPrompt(agentType: AgentType, specDir: string, projectDir: string): string {
  return buildAutocodeFallbackPrompt({ agentType, specDir, projectDir });
}

// Start execution
run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  postError(`Unhandled worker error: ${message}`);
});
