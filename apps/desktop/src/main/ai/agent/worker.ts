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
  AUTOCODE_PROJECT_INDEX_FILE_NAME,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  inferAutocodeRuntimeFileWriteLockScopeFromSpecDir,
  isOfficialOpenAIBaseUrl,
  normalizeOpenAICompatibleBaseUrl,
  resolveAutocodeTaskRuntimeConcurrency,
  type Phase,
  type SupportedProvider,
} from '@autocode/core';
import {
  appendAutocodeLanguageRequirement,
  appendAutocodeLanguageRequirementToMessages,
  getAutocodeImplementationPlanLanguageRequirement,
} from '@autocode/core/runtime/agent-language';
import {
  buildAutocodeAgentKickoffMessage,
  buildAutocodeFallbackPrompt,
  buildAutocodeSpecKickoffMessage,
  formatAutocodePathForPrompt,
  resolveAutocodePromptNameForAgent,
} from '@autocode/core/runtime/agent-kickoff';
import {
  isAutocodeDirectTaskExecution,
  isAutocodeSuccessfulAgentSessionOutcome,
  resolveAutocodeAgentExecutionPlan,
} from '@autocode/core/runtime/agent-execution-plan';
import {
  buildAutocodeDirectCompletionSummary,
  buildAutocodeDirectCompletionSummaryV2,
  extractAutocodeDirectFilePathFromToolArgs,
  extractAutocodeDirectTaskDescription,
  formatAutocodeDirectQualityAppendix,
  getAutocodeFinalAssistantText,
  shouldTrackAutocodeDirectModifiedFile,
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
import { runProjectIndexer } from '../project/project-indexer';
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
import { resolveProjectAgentProfile } from '../config/project-agent-profile';
import { WorkerObserverProxy } from '../memory/ipc/worker-observer-proxy';
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
// so that planning/coding/QA phases accumulate into one task_logs.json file.
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
      return proxy.searchMemory(withProject(filters));
    },
    searchByPattern: async (pattern: string): Promise<Memory | null> => {
      const memories = await proxy.searchMemory({
        query: pattern,
        projectId: fallbackProjectId,
        limit: 1,
        excludeDeprecated: true,
      });
      return memories[0] ?? null;
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
    searchWorkflowRecipe: async (taskDescription: string, opts?: { limit?: number }): Promise<Memory[]> => {
      const memories = await proxy.searchMemory({
        query: taskDescription,
        projectId: fallbackProjectId,
        types: ['workflow_recipe'],
        limit: opts?.limit ?? 3,
        excludeDeprecated: true,
      });
      return memories.filter((memory) => memory.type === 'workflow_recipe');
    },
    updateAccessCount: async (): Promise<void> => {},
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
  const openSpecDirective = buildOpenSpecPlanReviewDirective(session, promptSpecDir);
  const lines = [
    '## PLAN REVIEW REGENERATION',
    'This run was started from Request Changes in plan review.',
    `Read ${promptSpecDir}/HUMAN_INPUT.md and treat it as required reviewer feedback.`,
    openSpecDirective || `Rewrite ${promptSpecDir}/tasks.md to address that feedback. Do not edit implementation_plan.md; the runtime derives it.`,
    'Keep this as a planning-only run: do not implement code, do not run coding subtasks, and do not mark subtasks completed.',
    openSpecDirective
      ? 'Preserve useful parts of the previous OpenSpec artifacts and plan only when they still match the reviewer feedback; otherwise replace them.'
      : 'Preserve useful parts of the previous tasks.md only when they still match the reviewer feedback; otherwise replace them.',
  ];

  if (feedback) {
    lines.push('', 'Reviewer feedback:', feedback);
  }

  return lines.join('\n');
}

function buildOpenSpecPlanReviewDirective(
  session: SerializableSessionConfig,
  promptSpecDir: string,
): string {
  const metadata = readTaskMetadata(session.specDir);
  if (metadata?.sourceType !== 'openspec') {
    return '';
  }

  const artifactLines = [
    metadata.openSpecProposalPath ? `- proposal.md: ${metadata.openSpecProposalPath}` : '',
    metadata.openSpecDesignPath ? `- design.md: ${metadata.openSpecDesignPath}` : '',
    metadata.openSpecTasksPath ? `- tasks.md: ${metadata.openSpecTasksPath}` : '',
    ...((Array.isArray(metadata.openSpecSpecDeltaPaths) ? metadata.openSpecSpecDeltaPaths : [])
      .map((artifactPath, index) => `- spec delta ${index + 1}: ${artifactPath}`)),
  ].filter(Boolean);

  return [
    'OpenSpec is the upstream specification layer for this task.',
    'First update the relevant OpenSpec Markdown artifacts to reflect the reviewer feedback.',
    ...(metadata.openSpecChangeId ? [`OpenSpec change ID: ${metadata.openSpecChangeId}`] : []),
    ...(metadata.openSpecChangeDir ? [`OpenSpec change directory: ${metadata.openSpecChangeDir}`] : []),
    ...(artifactLines.length > 0 ? ['OpenSpec artifacts:', ...artifactLines] : []),
    `After updating OpenSpec artifacts, regenerate ${promptSpecDir}/implementation_plan.md from the updated tasks.md and spec deltas.`,
    `Do not make ${promptSpecDir}/implementation_plan.md the only changed planning artifact when the feedback changes requirements, design, user behavior, or task scope.`,
  ].join('\n');
}

function readTaskMetadata(specDir: string): {
  sourceType?: string;
  openSpecChangeId?: string;
  openSpecChangeDir?: string;
  openSpecProposalPath?: string;
  openSpecDesignPath?: string;
  openSpecTasksPath?: string;
  openSpecSpecDeltaPaths?: unknown;
} | null {
  try {
    const content = readFileSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.taskMetadata), 'utf-8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
  const profileProjectDir = getPromptProfileProjectDir(session);
  const projectPromptProfile = shouldUseProjectPromptProfile(session, promptName)
    ? getProjectPromptProfile(session)
    : null;
  const projectOverride = useCompactAggressiveCoderPrompt
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
  if (!promptName.startsWith('qa_')) {
    const humanInputPath = join(session.specDir, 'HUMAN_INPUT.md');
    if (existsSync(humanInputPath)) {
      try {
        humanInput = readFileSync(humanInputPath, 'utf-8').trim() || null;
      } catch {
        humanInput = null;
      }
    }
  }

  let promptWithContext = useCompactAggressiveCoderPrompt
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
      // Write stream events to task_logs.json for UI log display
      if (logWriter) {
        logWriter.processEvent(event, phase);
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
  return isAutocodeSuccessfulAgentSessionOutcome(result?.outcome);
}

function getFinalAssistantText(result: SessionResult | undefined, streamedText: string): string {
  return getAutocodeFinalAssistantText(result, streamedText);
}

function escapeTableCell(value: string): string {
  return value
    .trim()
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function buildDirectCompletionSummary(
  session: SerializableSessionConfig,
  result: SessionResult | undefined,
  streamedText: string,
): string {
  return buildAutocodeDirectCompletionSummary({
    specDir: session.specDir,
    language: session.language,
    result,
    streamedText,
  });
}

function localizeDirectSummaryText(
  language: SerializableSessionConfig['language'],
  en: string,
  zh: string,
  fr: string,
): string {
  if (language === 'zh-CN') return zh;
  if (language === 'fr') return fr;
  return en;
}

function getDirectSummaryLabels(language: SerializableSessionConfig['language']): {
  item: string;
  details: string;
  whatChanged: string;
  verification: string;
  reviewNotes: string;
} {
  if (language === 'zh-CN') {
    return {
      item: '项目',
      details: '内容',
      whatChanged: '修改内容',
      verification: '验证结果',
      reviewNotes: '审核要点',
    };
  }
  if (language === 'fr') {
    return {
      item: 'Element',
      details: 'Details',
      whatChanged: 'Changements',
      verification: 'Verification',
      reviewNotes: 'Notes de revue',
    };
  }
  return {
    item: 'Item',
    details: 'Details',
    whatChanged: 'What changed',
    verification: 'Verification',
    reviewNotes: 'Review notes',
  };
}

interface DirectCodingQualityMetrics {
  mode: 'direct';
  outcome: string;
  changedFiles: string[];
  filesChanged: number;
  stepsExecuted: number;
  toolCallCount: number;
  durationMs: number;
  recordedAt: string;
  selfCritique?: {
    status: 'passed' | 'failed' | 'skipped';
    score?: number;
    filesReviewed: number;
    improvements: string[];
  };
  validation: {
    status: 'not_run';
    reason: string;
  };
}

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
    validation: {
      status: 'not_run',
      reason: 'Direct mode does not run staged QA; rely on model-reported verification and manual review.',
    },
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

function formatDirectQualityAppendix(
  language: SerializableSessionConfig['language'],
  quality?: DirectCodingQualityMetrics,
): string {
  return formatAutocodeDirectQualityAppendix(language, quality);
}

function formatChangedFilesForSummary(files: string[]): string {
  if (files.length === 0) {
    return 'No changed files detected.';
  }
  const preview = files.slice(0, 12).join('<br>');
  return files.length > 12 ? `${preview}<br>...and ${files.length - 12} more` : preview;
}

function formatDirectQualityLine(
  language: SerializableSessionConfig['language'],
  quality?: DirectCodingQualityMetrics,
): string {
  if (!quality) {
    return localizeDirectSummaryText(language, 'Quality metrics unavailable.', '质量指标不可用。', 'Metriques qualite indisponibles.');
  }
  const selfCritique = quality.selfCritique
    ? `${quality.selfCritique.status}${typeof quality.selfCritique.score === 'number' ? ` (${Math.round(quality.selfCritique.score * 100)}%)` : ''}, files reviewed: ${quality.selfCritique.filesReviewed}`
    : 'not run';
  return localizeDirectSummaryText(
    language,
    `Files changed: ${quality.filesChanged}. Self-critique: ${selfCritique}. Validation: ${quality.validation.status} (${quality.validation.reason}).`,
    `变更文件：${quality.filesChanged}。自检：${selfCritique}。验证：${quality.validation.status}（${quality.validation.reason}）。`,
    `Fichiers modifies : ${quality.filesChanged}. Auto-critique : ${selfCritique}. Validation : ${quality.validation.status} (${quality.validation.reason}).`,
  );
}

function getDirectSummaryLabelsV2(language: SerializableSessionConfig['language']): {
  item: string;
  details: string;
  whatChanged: string;
  verification: string;
  reviewNotes: string;
  changedFiles: string;
  quality: string;
} {
  if (language === 'zh-CN') {
    return {
      item: '项目',
      details: '内容',
      whatChanged: '修改内容',
      verification: '验证结果',
      reviewNotes: '审核要点',
      changedFiles: '变更文件',
      quality: 'AI 编码质量',
    };
  }
  if (language === 'fr') {
    return {
      item: 'Element',
      details: 'Details',
      whatChanged: 'Changements',
      verification: 'Verification',
      reviewNotes: 'Notes de revue',
      changedFiles: 'Fichiers modifies',
      quality: 'Qualite du codage IA',
    };
  }
  return {
    item: 'Item',
    details: 'Details',
    whatChanged: 'What changed',
    verification: 'Verification',
    reviewNotes: 'Review notes',
    changedFiles: 'Changed files',
    quality: 'AI coding quality',
  };
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
      plan.direct_execution = {
        enabled: true,
        outcome: result?.outcome ?? 'unknown',
        completed_at: now,
        summary_file: 'direct_summary.md',
        ai_coding_quality: quality,
      };
      plan.updated_at = now;
      if (!plan.created_at) {
        plan.created_at = now;
      }
      plan.phases = [
        {
          phase: 1,
          name: 'Direct execution',
          type: 'direct',
          subtasks: [
            {
              id: 'direct-implementation',
              title: 'Direct model execution',
              description: extractDirectTaskDescription(session),
              status: success ? 'completed' : 'failed',
              files_to_modify: modifiedFiles,
              completion_summary: summary,
              notes: summary,
              verification: {
                type: 'manual',
                scenario: 'Review the completion summary, runtime log, and git changes.',
              },
            },
          ],
        },
      ];
      plan.final_acceptance = Array.isArray(plan.final_acceptance) && plan.final_acceptance.length > 0
        ? plan.final_acceptance
        : ['Manual reviewer approves the direct execution summary and git changes.'];

      writeFileSync(join(specDir, 'direct_summary.md'), summary, 'utf-8');
      saveImplementationPlanToFilesSync(specDir, plan);
    } catch (error) {
      postLog(`Direct completion summary persistence failed for ${specDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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

  const sessionConfig: SessionConfig = {
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
  };

  // Start phase logging for default session
  if (logWriter) {
    logWriter.startPhase(defaultPhase);
  }

  let result: SessionResult | undefined;
  let streamedText = '';
  const directModifiedFiles = new Set<string>();
  let directChangedFileBaseline: ChangedFileSnapshot | null = null;
  try {
    if (isDirectTaskSession(session)) {
      directChangedFileBaseline = await collectGitChangedFileSnapshot(session.projectDir);
    }
    const runnerOptions = {
      tools,
      memoryContext: memoryProxy ? { proxy: memoryProxy } : undefined,
      onEvent: (event: StreamEvent) => {
        if (isDirectTaskSession(session) && event.type === 'text-delta') {
          streamedText += event.text;
        }
        if (isDirectTaskSession(session) && event.type === 'tool-call' && shouldTrackDirectModifiedFile(event.toolName)) {
          const filePath = extractFilePathFromToolArgs(event.args);
          if (filePath) {
            directModifiedFiles.add(filePath);
          }
        }
        // Write stream events to task_logs.json for UI log display
        if (logWriter) {
          logWriter.processEvent(event, defaultPhase);
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
      maxContinuations: isDirectTaskSession(session) ? 0 : undefined,
    };

    result = isDirectTaskSession(session)
      ? await runAgentSession(sessionConfig, runnerOptions)
      : await runContinuableSessionWithGatewayFallback(
          sessionConfig,
          runnerOptions,
          continuationOptions,
          session,
          session.modelId,
        );
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
      const success = result?.outcome === 'completed' || result?.outcome === 'max_steps' || result?.outcome === 'context_window';
      logWriter.endPhase(defaultPhase, success ?? false);
    }
  }

  if (isDirectTaskSession(session)) {
    const modifiedFiles = directChangedFileBaseline
      ? await collectFilesChangedSinceBaseline(session.projectDir, directChangedFileBaseline, [...directModifiedFiles])
      : [...directModifiedFiles];
    const directQuality = await evaluateDirectCodingQuality(session, result, modifiedFiles);
    persistDirectTaskCompletion(session, result, streamedText, modifiedFiles, directQuality);
    await learnFromDirectTaskSession(session, result, modifiedFiles);
    if (isSuccessfulDirectOutcome(result)) {
      postTaskEvent('DIRECT_COMPLETED', {
        outcome: result?.outcome ?? 'unknown',
        filesChanged: modifiedFiles.length,
        quality: directQuality,
      });
    } else {
      postTaskEvent('CODING_FAILED', {
        subtaskId: 'direct-implementation',
        error: result?.error?.message ?? `Direct task ended with outcome ${result?.outcome ?? 'unknown'}`,
        attemptCount: 1,
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
  // Extract the task description from the first user message
  const taskDescription = session.initialMessages?.[0]?.content
    ? typeof session.initialMessages[0].content === 'string'
      ? session.initialMessages[0].content
      : 'Create the specification as described in your system prompt.'
    : 'Create the specification as described in your system prompt.';

  postLog(`Starting SpecOrchestrator pipeline (complexity-first phase routing)`);

  // Generate project index BEFORE any agent runs – gives all phases project context
  let projectIndexContent: string | undefined;
  if (isAggressiveWorkflow(session)) {
    postLog('Aggressive workflow enabled: skipping project index generation');
  } else {
    try {
      const indexOutputPath = join(session.specDir, AUTOCODE_PROJECT_INDEX_FILE_NAME);
      postLog('Generating project index...');
      runProjectIndexer(session.projectDir, indexOutputPath);
      projectIndexContent = readFileSync(indexOutputPath, 'utf-8');
      postLog(`Project index generated (${(projectIndexContent.length / 1024).toFixed(1)}KB)`);
    } catch (error) {
      postLog(`Project index generation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const orchestrator = new SpecOrchestrator({
    specDir: session.specDir,
    projectDir: session.projectDir,
    taskDescription,
    complexityOverride: isAggressiveWorkflow(session) ? 'simple' : undefined,
    useAiAssessment: !isAggressiveWorkflow(session),
    workflowConfig: getWorkflowConfigFromMode(session.workflowMode),
    projectIndex: projectIndexContent,
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
        runConfig.projectIndex,
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
    postLog(`Spec phase ${phaseNumber}/${totalPhases}: ${phase}`);
    if (logWriter) {
      logWriter.startPhase('spec', `${phase} (${phaseNumber}/${totalPhases})`);
    }
    postMessage({
      type: 'execution-progress',
      taskId: config.taskId,
      data: {
        phase: 'planning', // spec creation maps to 'planning' in the UI execution phases
        phaseProgress: phaseNumber / Math.max(totalPhases, 1),
        overallProgress: phaseNumber / Math.max(totalPhases, 1),
        message: `Spec creation: ${phase} (${phaseNumber}/${totalPhases})`,
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
    postLog(`Error in spec ${phase} phase: ${error.message}`);
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
  // Extract task description
  const taskDescription = session.initialMessages?.[0]?.content
    ? typeof session.initialMessages[0].content === 'string'
      ? session.initialMessages[0].content
      : 'Create the specification as described in your system prompt.'
    : 'Create the specification as described in your system prompt.';

  postLog('Starting Agentic SpecOrchestrator (AI-driven pipeline via SpawnSubagent)');

  // Generate project index
  let projectIndexContent: string | undefined;
  try {
    const indexOutputPath = join(session.specDir, AUTOCODE_PROJECT_INDEX_FILE_NAME);
    postLog('Generating project index...');
    runProjectIndexer(session.projectDir, indexOutputPath);
    projectIndexContent = readFileSync(indexOutputPath, 'utf-8');
    postLog(`Project index generated (${(projectIndexContent.length / 1024).toFixed(1)}KB)`);
  } catch (error) {
    postLog(`Project index generation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
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

  // Build the kickoff message
  const promptSpecDir = formatPathForPrompt(session.specDir);
  const promptProjectDir = formatPathForPrompt(session.projectDir);
  const kickoffParts = [
    `Create a complete specification for the following task:\n\n${taskDescription}\n`,
    `\nSpec directory: ${promptSpecDir}`,
    `\nProject directory: ${promptProjectDir}`,
  ];

  if (projectIndexContent) {
    kickoffParts.push(`\n\n## PROJECT INDEX\n\n\`\`\`json\n${projectIndexContent}\n\`\`\``);
  }

  const kickoffMessage = kickoffParts.join('');

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
          logWriter.processEvent(event, 'spec');
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
  projectIndex?: string,
  specPhase?: string,
  language?: SerializableSessionConfig['language'],
): string {
  return buildAutocodeSpecKickoffMessage({
    agentType,
    specDir,
    projectDir,
    taskDescription,
    priorPhaseOutputs,
    projectIndex,
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
