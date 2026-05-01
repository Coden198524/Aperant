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
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

import { runAgentSession } from '../session/runner';
import { runContinuableSession } from '../session/continuation';
import { createProvider } from '../providers/factory';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  createOpenAICompatibleEndpointFetch,
  normalizeOpenAICompatibleBaseUrl,
} from '../providers/openai-base-url';
import type { SupportedProvider } from '../providers/types';
import { getModelContextWindow } from '../../../shared/constants/models';
import { refreshOAuthTokenReactive } from '../auth/resolver';
import { buildToolRegistry } from '../tools/build-registry';
import type { ToolRegistry } from '../tools/registry';
import { SubagentExecutorImpl } from '../orchestration/subagent-executor';
import type { ToolContext } from '../tools/types';
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
import type { AgentType } from '../config/agent-configs';
import type { Phase } from '../config/types';
import type { ExecutionPhase } from '../../../shared/constants/phase-protocol';
import { getPhaseThinking } from '../config/phase-config';
import { TaskLogWriter } from '../logging/task-log-writer';
import { loadProjectInstructions, injectContext } from '../prompts/prompt-loader';
import {
  buildProjectPromptProfileSection,
  initializeProjectPromptProfile,
  loadProjectPromptOverride,
  loadProjectPromptProfile,
  type ProjectPromptProfile,
} from '../prompts/project-prompt-profile';
import { createMcpClientsForAgent, mergeMcpTools, closeAllMcpClients } from '../mcp/client';
import type { McpClientResult } from '../mcp/types';
import { runProjectIndexer } from '../project/project-indexer';
import type { TaskWorkflowMode } from '../../../shared/types';
import { FileContentCache } from '../tools/cache/file-cache';
import { buildFocusedCoderKickoffMessage } from './session-efficiency';
import { OPTIMIZATION_PRESETS, type WorkflowConfig } from '../orchestration/workflow-config';

// =============================================================================
// Validation
// =============================================================================

const MAX_PARALLEL_SUBTASKS_PER_BATCH = 1;

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

function isFastWorkflow(
  session: SerializableSessionConfig,
): session is SerializableSessionConfig & { workflowMode: TaskWorkflowMode } {
  return session.workflowMode === 'aggressive';
}

function formatPathForPrompt(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Map task workflowMode to WorkflowConfig preset
 */
function getWorkflowConfigFromMode(mode?: TaskWorkflowMode): WorkflowConfig | undefined {
  if (!mode) return undefined;
  return OPTIMIZATION_PRESETS[mode as 'conservative' | 'balanced' | 'aggressive'];
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

function isOfficialOpenAIBaseUrl(baseURL: string | undefined): boolean {
  if (!baseURL) return true;
  try {
    const { hostname } = new URL(baseURL);
    return (
      hostname === 'openai.com' ||
      hostname.endsWith('.openai.com') ||
      hostname === 'chatgpt.com' ||
      hostname.endsWith('.chatgpt.com')
    );
  } catch {
    return false;
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
    baseURL: normalizeOpenAICompatibleBaseUrl(session.baseURL) ?? 'https://api.openai.com/v1',
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

function getLanguageRequirement(language: SerializableSessionConfig['language']): string | null {
  switch (language) {
    case 'zh-CN':
      return 'IMPORTANT: The app language is Simplified Chinese. You MUST communicate in Simplified Chinese (简体中文) at all times. This includes:\n- All your responses and explanations to the user\n- Your thinking process and reasoning\n- Task descriptions and progress updates\n- QA reports, summaries, and markdown documents\n- Error messages and debugging information\n\nThe ONLY exceptions are:\n- Code (variable names, function names, comments in English if that\'s the project convention)\n- File paths and command-line commands\n- Technical identifiers that must remain in English\n\nUnless the user explicitly requests another language, communicate entirely in Simplified Chinese.';
    case 'fr':
      return 'IMPORTANT: The app language is French. You MUST communicate in French at all times. This includes all your responses, explanations, thinking process, task descriptions, QA reports, summaries, and markdown documents. The only exceptions are code, file paths, commands, and technical identifiers. Unless the user explicitly requests another language, communicate entirely in French.';
    default:
      return null;
  }
}

function getImplementationPlanLanguageRequirement(
  language: SerializableSessionConfig['language'],
): string | null {
  switch (language) {
    case 'zh-CN':
      return 'When writing implementation_plan.json, all user-facing planning fields must be in Simplified Chinese. This includes `feature`, phase `name` and `description`, subtask `title`, subtask `description`, acceptance criteria, and progress notes. Keep file paths, commands, class names, API names, and code identifiers in their original language when needed, but do not leave the planning text itself in English.';
    case 'fr':
      return 'When writing implementation_plan.json, all user-facing planning fields must be in French. Keep file paths, commands, class names, API names, and code identifiers in their original language when needed.';
    default:
      return null;
  }
}

function appendLanguageRequirement(
  content: string,
  language: SerializableSessionConfig['language'],
): string {
  const requirement = getLanguageRequirement(language);
  if (!requirement) {
    return content;
  }
  return `${content}\n\n## OUTPUT LANGUAGE REQUIREMENT\n${requirement}`;
}

function getPromptProfileProjectDir(session: SerializableSessionConfig): string {
  return session.sourceProjectDir ?? session.projectDir;
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
  const profileProjectDir = getPromptProfileProjectDir(session);
  const projectPromptProfile = getProjectPromptProfile(session);
  const projectOverride = loadProjectPromptOverride(profileProjectDir, promptName);
  if (projectOverride && !loggedProjectPromptOverrides.has(projectOverride.path)) {
    loggedProjectPromptOverrides.add(projectOverride.path);
    postLog(`Using project-specific prompt override: ${projectOverride.path}`);
  }

  const basePrompt = projectOverride?.content
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

  let promptWithContext = injectContext(basePrompt, {
    specDir: session.specDir,
    projectDir: session.projectDir,
    projectInstructions: cachedProjectInstructions,
    humanInput,
    autoPushToRemote: session.autoPushToRemote,
  });

  if (projectPromptProfile && !projectOverride) {
    promptWithContext += `\n\n${buildProjectPromptProfileSection(projectPromptProfile)}`;
  }

  let promptWithLanguage = appendLanguageRequirement(promptWithContext, session.language);
  if (promptName === 'planner' || promptName === 'followup_planner' || promptName === 'spec_quick') {
    const planRequirement = getImplementationPlanLanguageRequirement(session.language);
    if (planRequirement) {
      promptWithLanguage += `\n\n## IMPLEMENTATION PLAN LANGUAGE REQUIREMENT\n${planRequirement}`;
    }
  }

  return promptWithLanguage;
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

  const model = createSessionModel(baseSession, phaseModelId);

  const tools: Record<string, AITool> = {
    ...registry.getToolsForAgent(agentType, toolContext),
    ...(mergeMcpTools(mcpClients) as Record<string, AITool>),
  };

  // Build initial messages: use provided kickoff message, or fall back to session messages
  const initialMessages = initialUserMessage
    ? [{ role: 'user' as const, content: initialUserMessage }]
    : baseSession.initialMessages;

  // Resolve context window limit from model metadata
  const contextWindowLimit = getModelContextWindow(phaseModelId);

  const sessionConfig: SessionConfig = {
    agentType,
    model,
    systemPrompt,
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

    // Route to orchestrator for build_orchestrator agent type
    if (session.agentType === 'build_orchestrator') {
      await runBuildOrchestrator(session, toolContext, registry);
      return;
    }

    // Route to QA loop for qa_reviewer agent type
    if (session.agentType === 'qa_reviewer') {
      await runQALoop(session, toolContext, registry);
      return;
    }

    // Route to spec orchestrator for spec_orchestrator agent type
    if (session.agentType === 'spec_orchestrator') {
      if (session.useAgenticOrchestration) {
        await runAgenticSpecOrchestrator(session, toolContext, registry);
      } else {
        await runSpecOrchestrator(session, toolContext, registry);
      }
      return;
    }

    // Default: single session for all other agent types
    await runDefaultSession(session, toolContext, registry);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    postError(`Agent session failed: ${message}`);
  } finally {
    // Log file cache statistics
    const cacheStats = fileCache.getStats();
    if (cacheStats.hits > 0 || cacheStats.misses > 0) {
      postLog(`[FileCache] Session Stats: ${cacheStats.hits} hits, ${cacheStats.misses} misses, ${(cacheStats.hitRate * 100).toFixed(1)}% hit rate, ${cacheStats.size} files cached`);
    }

    // Cleanup MCP clients
    if (mcpClients.length > 0) {
      await closeAllMcpClients(mcpClients);
    }
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

  const tools: Record<string, AITool> = {
    ...registry.getToolsForAgent(session.agentType, toolContext),
    ...(mergeMcpTools(mcpClients) as Record<string, AITool>),
  };

  // Resolve context window limit from model metadata
  const contextWindowLimit = getModelContextWindow(session.modelId);

  const sessionConfig: SessionConfig = {
    agentType: session.agentType,
    model,
    systemPrompt: session.systemPrompt,
    initialMessages: session.initialMessages,
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
  };

  // Start phase logging for default session
  const defaultPhase: Phase = session.phase ?? 'coding';
  if (logWriter) {
    logWriter.startPhase(defaultPhase);
  }

  let result: SessionResult | undefined;
  try {
    result = await runContinuableSessionWithGatewayFallback(sessionConfig, {
      tools,
      onEvent: (event: StreamEvent) => {
        // Write stream events to task_logs.json for UI log display
        if (logWriter) {
          logWriter.processEvent(event, defaultPhase);
        }
        postMessage({
          type: 'stream-event',
          taskId: config.taskId,
          data: event,
          projectId: config.projectId,
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
      logWriter.endPhase(defaultPhase, success ?? false);
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

  const orchestrator = new BuildOrchestrator({
    specDir: session.specDir,
    projectDir: session.projectDir,
    sourceSpecDir: session.sourceSpecDir,
    maxIterations: isFastWorkflow(session) ? 1 : undefined,
    language: session.language,
    abortSignal: abortController.signal,

    // Enable subtask batch execution to process multiple subtasks in a single AI session
    enableBatchExecution: true,
    batchSize: 'auto', // Auto-detect based on subtask dependencies
    maxBatchRetries: 2,
    maxConcurrentSubtasks: MAX_PARALLEL_SUBTASKS_PER_BATCH,

    // Apply workflow optimization config based on task's workflowMode
    workflowConfig: getWorkflowConfigFromMode(session.workflowMode),

    generatePrompt: async (agentType, _phase, context) => {
      const promptName = agentType === 'coder' ? 'coder' : agentType;
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
  if (outcome.success) {
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
    maxIterations: isFastWorkflow(session) ? 1 : undefined,
    abortSignal: abortController.signal,

    generatePrompt: async (agentType, _context) => {
      const promptName = agentType === 'qa_fixer' ? 'qa_fixer' : 'qa_reviewer';
      return assemblePrompt(promptName, session);
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
  if (isFastWorkflow(session)) {
    postLog('Fast workflow enabled: skipping project index generation');
  } else {
    try {
      const indexOutputPath = join(session.specDir, 'project_index.json');
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
    complexityOverride: isFastWorkflow(session) ? 'simple' : undefined,
    useAiAssessment: !isFastWorkflow(session),
    projectIndex: projectIndexContent,
    language: session.language,
    abortSignal: abortController.signal,

    generatePrompt: async (_agentType, phase, context) => {
      const promptName = specPhaseToPromptName(phase);
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
    const indexOutputPath = join(session.specDir, 'project_index.json');
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
    ...registry.getToolsForAgent('spec_orchestrator', orchestratorToolContext),
    ...(mergeMcpTools(mcpClients) as Record<string, AITool>),
  };

  const sessionConfig: SessionConfig = {
    agentType: 'spec_orchestrator',
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
 * Map a SpecPhase to the prompt file name to load.
 * Falls back to the closest available prompt when a phase-specific one doesn't exist.
 */
function specPhaseToPromptName(phase: SpecPhase): string {
  switch (phase) {
    case 'discovery': return 'spec_gatherer';
    case 'requirements': return 'spec_gatherer';
    case 'complexity_assessment': return 'complexity_assessor';
    case 'research': return 'spec_researcher';
    case 'context': return 'spec_writer';
    case 'historical_context': return 'spec_writer';
    case 'spec_writing': return 'spec_writer';
    case 'self_critique': return 'spec_critic';
    case 'planning': return 'planner';
    case 'quick_spec': return 'spec_quick';
    case 'validation': return 'spec_writer';
    default: return 'spec_writer';
  }
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
  const promptSpecDir = formatPathForPrompt(specDir);
  const promptProjectDir = formatPathForPrompt(projectDir);

  // Build the base task-specific message
  let baseMessage: string;

  // Spec phase takes priority over agentType for kickoff routing
  // (e.g., complexity_assessment uses spec_gatherer agentType but needs a different kickoff)
  if (specPhase === 'complexity_assessment') {
    baseMessage = `Assess the complexity of the following task and write your assessment to ${promptSpecDir}/complexity_assessment.json. Task: ${taskDescription}. Project root: ${promptProjectDir}. Determine if this is a SIMPLE, STANDARD, or COMPLEX task based on the scope of changes required.\n\nIMPORTANT: This is the FIRST phase of the spec pipeline. No spec.md or other spec files exist yet — do NOT attempt to read them. Assess complexity based on the task description and the project structure at ${promptProjectDir} only.`;
  } else switch (agentType) {
    case 'spec_discovery':
      baseMessage = `Analyze the project structure at ${promptProjectDir} to understand the codebase architecture, tech stack, and conventions. Write your findings to ${promptSpecDir}/context.json. Task context: ${taskDescription}\n\nIMPORTANT: This is an early phase of the spec pipeline. No spec.md exists yet — do NOT attempt to read it. Analyze the project source code at ${promptProjectDir} directly.`;
      break;
    case 'spec_gatherer':
      baseMessage = `Gather and validate requirements for the following task: ${taskDescription}. Project root: ${promptProjectDir}. Write requirements to ${promptSpecDir}/requirements.json.\n\nIMPORTANT: This is an early phase of the spec pipeline. No spec.md exists yet — do NOT attempt to read it. Derive requirements from the task description and the project source code at ${promptProjectDir}.`;
      break;
    case 'spec_researcher':
      baseMessage = `Research implementation approaches for: ${taskDescription}. Review relevant code in ${promptProjectDir} and document your findings in ${promptSpecDir}/research.json.`;
      break;
    case 'spec_writer':
      baseMessage = `Write the specification for: ${taskDescription}. Write spec.md to ${promptSpecDir}. Project root: ${promptProjectDir}.`;
      break;
    case 'planner':
      baseMessage = `Create a detailed implementation plan for: ${taskDescription}. Read the spec at ${promptSpecDir}/spec.md and create ${promptSpecDir}/implementation_plan.json with concrete coding subtasks. Project root: ${promptProjectDir}.`;
      break;
    case 'spec_critic':
      baseMessage = `Review and critique the specification at ${promptSpecDir}/spec.md for completeness, clarity, and technical feasibility. Write your critique findings back to ${promptSpecDir}/spec.md with improvements.`;
      break;
    case 'spec_context':
      baseMessage = `Gather project context relevant to: ${taskDescription}. Analyze the codebase at ${promptProjectDir} and write context to ${promptSpecDir}/context.json.\n\nIMPORTANT: This is an early phase of the spec pipeline. No spec.md exists yet — do NOT attempt to read it. Analyze the project source code at ${promptProjectDir} directly.`;
      break;
    case 'spec_validation':
      baseMessage = `Validate that ${promptSpecDir}/spec.md and ${promptSpecDir}/implementation_plan.json are complete, consistent, and ready for implementation. Fix any issues found.`;
      break;
    default:
      baseMessage = `Complete the spec creation task described in your system prompt. Task: ${taskDescription}. Spec directory: ${promptSpecDir}. Project directory: ${promptProjectDir}`;
  }

  // Inject accumulated context from prior phases
  const contextSections: string[] = [baseMessage];

  if (projectIndex) {
    contextSections.push(`\n\n## PROJECT INDEX (pre-generated)\n\nThe following project structure analysis has been pre-generated for you. Use this as your starting point instead of scanning the entire project:\n\n\`\`\`json\n${projectIndex}\n\`\`\``);
  }

  const planLanguageRequirement = (agentType === 'planner' || specPhase === 'quick_spec')
    ? getImplementationPlanLanguageRequirement(language)
    : null;
  if (planLanguageRequirement) {
    contextSections.push(`\n\n## IMPLEMENTATION PLAN LANGUAGE REQUIREMENT\n\n${planLanguageRequirement}`);
  }

  if (priorPhaseOutputs && Object.keys(priorPhaseOutputs).length > 0) {
    contextSections.push('\n\n## CONTEXT FROM PRIOR PHASES\n\nThe following outputs from earlier spec phases are provided to avoid re-reading files:');
    for (const [fileName, content] of Object.entries(priorPhaseOutputs)) {
      const ext = fileName.endsWith('.json') ? 'json' : 'markdown';
      contextSections.push(`\n### ${fileName}\n\n\`\`\`${ext}\n${content}\n\`\`\``);
    }
    contextSections.push('\nUse these outputs as your primary source of context. Only read additional project files if you need specific code patterns not covered above.');
  }

  return appendLanguageRequirement(contextSections.join(''), language);
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
): string {
  const promptSpecDir = formatPathForPrompt(specDir);
  const promptProjectDir = formatPathForPrompt(projectDir);
  let baseMessage: string;
  switch (agentType) {
    case 'planner':
      baseMessage = `Read the spec at ${promptSpecDir}/spec.md and create a detailed implementation plan at ${promptSpecDir}/implementation_plan.json. Project root: ${promptProjectDir}`;
      break;
    case 'coder':
      if (subtaskId) {
        baseMessage = buildFocusedCoderKickoffMessage(
          promptSpecDir,
          promptProjectDir,
          subtaskId,
        );
      } else {
        baseMessage = `Read ${promptSpecDir}/implementation_plan.json and implement the next pending subtask. Project root: ${promptProjectDir}. After completing the subtask, update its status to "completed" in implementation_plan.json.`;
      }
      break;
    case 'qa_reviewer':
      baseMessage = `Review the implementation in ${promptProjectDir} against the specification in ${promptSpecDir}/spec.md. Write your findings to ${promptSpecDir}/qa_report.md with a clear "Status: PASSED" or "Status: FAILED" line.`;
      break;
    case 'qa_fixer':
      baseMessage = `Read ${promptSpecDir}/qa_report.md for the issues found by QA review. Fix all issues in ${promptProjectDir}. After fixing, update ${promptSpecDir}/qa_report.md to indicate fixes have been applied.`;
      break;
    default:
      baseMessage = `Complete the task described in your system prompt. Spec directory: ${promptSpecDir}. Project directory: ${promptProjectDir}`;
      break;
  }

  let kickoffMessage = appendLanguageRequirement(baseMessage, language);
  if (agentType === 'planner') {
    const planLanguageRequirement = getImplementationPlanLanguageRequirement(language);
    if (planLanguageRequirement) {
      kickoffMessage += `\n\n## IMPLEMENTATION PLAN LANGUAGE REQUIREMENT\n${planLanguageRequirement}`;
    }
  }

  return kickoffMessage;
}

/**
 * Build a minimal fallback prompt when the prompts directory is not found.
 */
function buildFallbackPrompt(agentType: AgentType, specDir: string, projectDir: string): string {
  const promptSpecDir = formatPathForPrompt(specDir);
  const promptProjectDir = formatPathForPrompt(projectDir);
  switch (agentType) {
    case 'planner':
      return `You are a planning agent. Read spec.md in ${promptSpecDir} and create implementation_plan.json with phases and subtasks. Each subtask must have id, description, and status fields. Set all statuses to "pending". If the system prompt specifies an app language, localize all user-facing planning fields such as feature, phase names, subtask titles, and subtask descriptions to that language.`;
    case 'coder':
      return `You are a coding agent. Implement the current pending subtask from implementation_plan.json in ${promptSpecDir}. Project root: ${promptProjectDir}. After completing the subtask, update its status to "completed" in implementation_plan.json.`;
    case 'qa_reviewer':
      return `You are a QA reviewer. Review the implementation in ${promptProjectDir} against the spec in ${promptSpecDir}/spec.md. Write your findings to ${promptSpecDir}/qa_report.md with "Status: PASSED" or "Status: FAILED".`;
    case 'qa_fixer':
      return `You are a QA fixer. Read ${promptSpecDir}/qa_report.md for the issues found by QA review. Fix the issues in ${promptProjectDir}. After fixing, update ${promptSpecDir}/implementation_plan.json qa_signoff status to "fixes_applied".`;
    default:
      return `You are an AI agent. Complete the task described in ${promptSpecDir}/spec.md for the project at ${promptProjectDir}.`;
  }
}

// Start execution
run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  postError(`Unhandled worker error: ${message}`);
});
