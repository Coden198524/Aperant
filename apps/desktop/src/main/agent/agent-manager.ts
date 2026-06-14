import { EventEmitter } from 'events';
import path from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import {
  AUTOCODE_COMMON_BASE_BRANCHES,
  AUTOCODE_DEFAULT_BASE_BRANCH,
  AUTOCODE_TASK_ARTIFACTS,
  DEFAULT_PHASE_THINKING,
  buildAutocodeDefaultDirectTaskPrompt,
  buildAutocodeDefaultPlannerPrompt,
  buildAutocodeDefaultQAPrompt,
  buildAutocodeDefaultSpecPrompt,
  buildAutocodeDirectTaskExecutionMessages,
  buildAutocodeQAInitialMessages,
  buildAutocodeSessionRuntimeOptions,
  buildAutocodeTaskExecutionMessages,
  collectAutocodeRuntimeFileIntentsFromPlan,
  createStartedAutocodeAgentRuntime,
  getAutocodeSpecDir,
  getAutocodeSpecsDir,
  getAutocodeSpecsRelativeDir,
  inferAutocodeRuntimeFileWriteLockScopeFromSpecDir,
  inferAutocodePinnedProviderFromModel,
  isAutocodeCommonBaseBranch,
  isAutocodeOpenAIResponsesTransport,
  loadAutocodeImplementationPlanSync,
  loadAutocodeTaskRuntimeMetadataConfig,
  normalizeAutocodeBaseBranch,
  normalizeAutocodeRuntimePath,
  parseAutocodeOriginHeadBranch,
  resolveAutocodeCrossProviderModelRequest,
  resolveAutocodeTaskPhaseModelId,
  resolveAutocodeTaskPhaseProvider,
  resolveAutocodeTaskRuntimeConcurrency,
  resolveAutocodeTaskWorkflowMode,
  resolveAutocodeDirectSessionState,
  withAutocodeRuntimeFileWriteLockSync,
  type AutocodeTaskRuntimeConcurrencyResolved,
  type AutocodeRuntimeWorkspaceMode,
} from '@autocode/core';
import { AgentState } from './agent-state';
import { AgentEvents } from './agent-events';
import { AgentProcessManager } from './agent-process';
import { AgentQueueManager } from './agent-queue';
import { getClaudeProfileManager, initializeClaudeProfileManager } from '../claude-profile-manager';
import type { ClaudeProfileManager } from '../claude-profile-manager';
import { getOperationRegistry } from '../claude-profile/operation-registry';
import {
  SpecCreationMetadata,
  TaskExecutionOptions,
  RoadmapConfig
} from './types';
import type { IdeationConfig, TaskMetadata, TaskWorkflowMode } from '../../shared/types';
import { resetStuckSubtasks } from '../ipc-handlers/task/plan-file-utils';
import { projectStore } from '../project-store';
import { resolveAuth, resolveAuthFromQueue } from '../ai/auth/resolver';
import { resolveModelId } from '../ai/config/phase-config';
import { detectProviderFromModel } from '../ai/providers/factory';
import { resolveModelEquivalent } from '../../shared/constants/models';
import { resolveSupportedLanguage } from '../../shared/constants/i18n';
import type { BuiltinProvider } from '../../shared/types/provider-account';
import type { AgentExecutorConfig, SerializableSessionConfig, SerializedSecurityProfile } from '../ai/agent/types';
import { getSecurityProfile } from '../ai/security/security-profile';
import { createOrGetWorktree } from '../ai/worktree';
import { findTaskWorktree } from '../worktree-paths';
import { readSettingsFile } from '../settings-utils';
import type { ProviderAccount } from '../../shared/types/provider-account';
import { tryLoadPrompt } from '../ai/prompts/prompt-loader';
import { buildProviderQueueResolutionErrorMessage } from './provider-queue-errors';
import { resolveProjectAgentProfile } from '../ai/config/project-agent-profile';

export function inferPinnedProviderFromModel(model: string | undefined): BuiltinProvider | null {
  return inferAutocodePinnedProviderFromModel(model) as BuiltinProvider | null;
}

export const __agentManagerTestUtils = {
  normalizeBaseBranch: normalizeAutocodeBaseBranch,
  resolveTaskBaseBranch,
};

const SPEC_INITIAL_TASK_DESCRIPTION_MAX_CHARS = 4_000;
const SPEC_INITIAL_TASK_DESCRIPTION_TRUNCATION_MARKER =
  '\n\n...[task description middle omitted for initial session budget; worker can inspect task metadata if exact omitted detail is required]...\n\n';
/**
 * Check if the current Git branch is a main/trunk branch.
 * Main branches: main, master, develop, dev, trunk
 */
function isMainBranch(projectPath: string): boolean {
  try {
    const currentBranch = execSync('git branch --show-current', {
      cwd: projectPath,
      encoding: 'utf-8',
    }).trim();

    return isAutocodeCommonBaseBranch(currentBranch);
  } catch (error) {
    console.warn('[AgentManager] Failed to detect Git branch:', error);
    // Default to safe behavior (no push) if detection fails
    return true;
  }
}

function compactSpecInitialTaskDescription(value: string): string {
  const normalized = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (normalized.length <= SPEC_INITIAL_TASK_DESCRIPTION_MAX_CHARS) {
    return normalized;
  }
  const budget = Math.max(0, SPEC_INITIAL_TASK_DESCRIPTION_MAX_CHARS - SPEC_INITIAL_TASK_DESCRIPTION_TRUNCATION_MARKER.length);
  const headLength = Math.ceil(budget * 0.65);
  const tailLength = Math.max(0, budget - headLength);
  return [
    normalized.slice(0, headLength).trimEnd(),
    SPEC_INITIAL_TASK_DESCRIPTION_TRUNCATION_MARKER,
    normalized.slice(-tailLength).trimStart(),
  ].join('');
}

function gitRefExists(projectPath: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function getCurrentGitBranch(projectPath: string): string | null {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

function detectRepositoryBaseBranch(projectPath: string): string | null {
  try {
    const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const branch = parseAutocodeOriginHeadBranch(ref);
    if (branch) {
      return branch;
    }
  } catch {
    // origin/HEAD is optional for local-only repositories.
  }

  for (const branch of AUTOCODE_COMMON_BASE_BRANCHES) {
    if (gitRefExists(projectPath, branch) || gitRefExists(projectPath, `origin/${branch}`)) {
      return branch;
    }
  }

  return getCurrentGitBranch(projectPath);
}

function resolveTaskBaseBranch(
  projectPath: string,
  requestedBaseBranch?: string,
  projectMainBranch?: string,
): string {
  for (const candidate of [requestedBaseBranch, projectMainBranch]) {
    const normalized = normalizeAutocodeBaseBranch(candidate);
    if (!normalized) {
      continue;
    }

    if (gitRefExists(projectPath, normalized) || gitRefExists(projectPath, `origin/${normalized}`)) {
      return normalized;
    }

    console.warn(`[AgentManager] Configured base branch "${normalized}" was not found in ${projectPath}; trying repository detection.`);
  }

  return detectRepositoryBaseBranch(projectPath) ?? AUTOCODE_DEFAULT_BASE_BRANCH;
}

function getGitHeadCommit(projectPath: string): string | null {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return commit || null;
  } catch {
    return null;
  }
}

function captureDirectWorkspaceBaseline(projectPath: string, specDir: string): void {
  try {
    const metadataPath = path.join(specDir, 'task_metadata.json');
    const lockScope = inferAutocodeRuntimeFileWriteLockScopeFromSpecDir(specDir);

    const writeBaseline = () => {
      let metadata: Record<string, unknown> = {};

      if (existsSync(metadataPath)) {
        try {
          metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;
        } catch {
          metadata = {};
        }
      }

      if (typeof metadata.directWorkspaceBaselineCommit === 'string' && metadata.directWorkspaceBaselineCommit.trim()) {
        return;
      }

      const commit = getGitHeadCommit(projectPath);
      if (!commit) {
        return;
      }

      const branch = getCurrentGitBranch(projectPath);
      metadata.directWorkspaceBaselineCommit = commit;
      metadata.directWorkspaceBaselineCapturedAt = new Date().toISOString();
      if (branch) {
        metadata.directWorkspaceBaselineBranch = branch;
      }

      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    };

    if (!existsSync(lockScope.projectRoot)) {
      writeBaseline();
      return;
    }

    withAutocodeRuntimeFileWriteLockSync(
      {
        ...lockScope,
        filePath: metadataPath,
        ownerId: 'desktop:direct-workspace-baseline',
      },
      writeBaseline,
    );
  } catch (error) {
    console.warn('[AgentManager] Failed to capture direct workspace baseline:', error);
  }
}

/**
 * Main AgentManager - orchestrates agent process lifecycle
 * This is a slim facade that delegates to focused modules
 */
export class AgentManager extends EventEmitter {
  private state: AgentState;
  private events: AgentEvents;
  private processManager: AgentProcessManager;
  private queueManager: AgentQueueManager;
  private taskExecutionContext: Map<string, {
    projectPath: string;
    specId: string;
    options: TaskExecutionOptions;
    isSpecCreation?: boolean;
    taskDescription?: string;
    specDir?: string;
    metadata?: SpecCreationMetadata;
    baseBranch?: string;
    isDirectExecution?: boolean;
    swapCount: number;
    projectId?: string;
    /** Generation counter to prevent stale cleanup after restart */
    generation: number;
  }> = new Map();
  constructor() {
    super();

    // Initialize modular components
    this.state = new AgentState();
    this.events = new AgentEvents();
    this.processManager = new AgentProcessManager(this.state, this.events, this);
    this.queueManager = new AgentQueueManager(this.state, this.events, this.processManager, this);

    // Listen for auto-swap restart events
    this.on('auto-swap-restart-task', (taskId: string, newProfileId: string) => {
      console.log('[AgentManager] Received auto-swap-restart-task event:', { taskId, newProfileId });
      const success = this.restartTask(taskId, newProfileId);
      console.log('[AgentManager] Task restart result:', success ? 'SUCCESS' : 'FAILED');
    });

    // Listen for task completion to clean up context (prevent memory leak)
    this.on('exit', (taskId: string, code: number | null, _processType?: string, _projectId?: string) => {
      // Clean up context when:
      // 1. Task completed successfully (code === 0), or
      // 2. Task failed and won't be restarted (handled by auto-swap logic)

      // Capture generation at exit time to prevent race conditions with restarts
      const contextAtExit = this.taskExecutionContext.get(taskId);
      const generationAtExit = contextAtExit?.generation;

      // Note: Auto-swap restart happens BEFORE this exit event is processed,
      // so we need a small delay to allow restart to preserve context
      setTimeout(() => {
        const context = this.taskExecutionContext.get(taskId);
        if (!context) return; // Already cleaned up or restarted

        // Check if the context's generation matches - if not, a restart incremented it
        // and this cleanup is for a stale exit event that shouldn't affect the new task
        if (generationAtExit !== undefined && context.generation !== generationAtExit) {
          return; // Stale exit event - task was restarted, don't clean up new context
        }

        // If task completed successfully, always clean up
        if (code === 0) {
          this.taskExecutionContext.delete(taskId);
          // Unregister from OperationRegistry
          getOperationRegistry().unregisterOperation(taskId);
          return;
        }

        // If task failed and hit max retries, clean up
        if (context.swapCount >= 2) {
          this.taskExecutionContext.delete(taskId);
          // Unregister from OperationRegistry
          getOperationRegistry().unregisterOperation(taskId);
        }
        // Otherwise keep context for potential restart
      }, 1000); // Delay to allow restart logic to run first
    });
  }

  /**
   * Configure paths for Python and autocode source
   */
  configure(pythonPath?: string, autoBuildSourcePath?: string): void {
    this.processManager.configure(pythonPath, autoBuildSourcePath);
  }

  /**
   * Check if any provider account is configured (API key or OAuth).
   * Used to bypass the legacy hasValidAuth() check for non-Anthropic providers.
   */
  private hasAnyProviderAccount(): boolean {
    const settings = readSettingsFile();
    const accounts = (settings?.providerAccounts as ProviderAccount[] | undefined) ?? [];
    return accounts.length > 0;
  }

  /**
   * Resolve auth using the provider accounts priority queue.
   * Falls back to legacy Claude profile only when no provider accounts exist.
   */
  private async resolveAuthFromProviderQueue(
    requestedModel: string,
    preferredProvider?: string | null,
  ): Promise<{
    auth: { apiKey?: string; baseURL?: string; oauthTokenFilePath?: string; source?: string } | null;
    provider: string;
    modelId: string;
    configDir?: string;
  }> {
    // Read provider accounts and priority order from settings
    const settings = readSettingsFile();
    const accounts = (settings?.providerAccounts as ProviderAccount[] | undefined) ?? [];
    const priorityOrder = (settings?.globalPriorityOrder as string[] | undefined) ?? [];

    if (accounts.length > 0) {
      // Sort by global priority order when present, while keeping accounts not in the
      // order list at the end in their original sequence.
      const orderIndex = new Map<string, number>();
      priorityOrder.forEach((id, idx) => orderIndex.set(id, idx));
      const orderedQueue = [...accounts].sort((a, b) => {
        const idxA = orderIndex.get(a.id);
        const idxB = orderIndex.get(b.id);
        const effA = idxA === undefined ? Number.MAX_SAFE_INTEGER : idxA;
        const effB = idxB === undefined ? Number.MAX_SAFE_INTEGER : idxB;
        return effA - effB;
      });

      // If a preferred provider is specified, reorder queue to try that provider first
      if (preferredProvider) {
        const preferred: ProviderAccount[] = [];
        const rest: ProviderAccount[] = [];
        for (const acct of orderedQueue) {
          if (acct.provider === preferredProvider) {
            preferred.push(acct);
          } else {
            rest.push(acct);
          }
        }
        orderedQueue.splice(0, orderedQueue.length, ...preferred, ...rest);
      }

      const resolved = await resolveAuthFromQueue(requestedModel, orderedQueue, {
        executionMode: 'agentic',
      });
      if (resolved) {
        console.warn(`[AgentManager] Resolved auth from provider queue: account=${resolved.accountId} provider=${resolved.resolvedProvider} model=${resolved.resolvedModelId}`);
        return {
          auth: resolved,
          provider: resolved.resolvedProvider,
          modelId: resolved.resolvedModelId,
          configDir: undefined, // Queue-based auth handles its own token refresh
        };
      }

      // Compatibility fallback: if a task stored an Anthropic full model ID
      // (e.g. claude-sonnet-4-6) but provider preference is not fixed, retry
      // with shorthand so queue can cross-map to non-Anthropic providers.
      if (!preferredProvider) {
        const shorthandRequest = this.toCrossProviderModelRequest(requestedModel);
        if (shorthandRequest !== requestedModel) {
          const fallbackResolved = await resolveAuthFromQueue(shorthandRequest, orderedQueue, {
            executionMode: 'agentic',
          });
          if (fallbackResolved) {
            console.warn(`[AgentManager] Resolved auth from provider queue (compat retry): account=${fallbackResolved.accountId} provider=${fallbackResolved.resolvedProvider} model=${fallbackResolved.resolvedModelId}`);
            return {
              auth: fallbackResolved,
              provider: fallbackResolved.resolvedProvider,
              modelId: fallbackResolved.resolvedModelId,
              configDir: undefined,
            };
          }
        }
      }

      if (!preferredProvider) {
        // Last-resort queue retry with provider-agnostic shorthand. This avoids
        // hard fallback to Anthropic when imported tasks carry legacy/full model IDs.
        const genericFallbackResolved = await resolveAuthFromQueue('sonnet', orderedQueue, {
          executionMode: 'agentic',
        });
        if (genericFallbackResolved) {
          console.warn(`[AgentManager] Resolved auth from provider queue (generic retry): account=${genericFallbackResolved.accountId} provider=${genericFallbackResolved.resolvedProvider} model=${genericFallbackResolved.resolvedModelId}`);
          return {
            auth: genericFallbackResolved,
            provider: genericFallbackResolved.resolvedProvider,
            modelId: genericFallbackResolved.resolvedModelId,
            configDir: undefined,
          };
        }
      }

      const requestedProvider = preferredProvider ?? detectProviderFromModel(requestedModel);
      const errorMessage = buildProviderQueueResolutionErrorMessage(
        requestedModel,
        requestedProvider,
        orderedQueue,
      );
      console.warn(`[AgentManager] ${errorMessage}`);
      throw new Error(errorMessage);
    }

    // Fallback: legacy Claude profile system
    const profileManager = getClaudeProfileManager();
    const activeProfile = profileManager?.getActiveProfile();
    const configDir = activeProfile?.configDir;
    const auth = await resolveAuth({ provider: 'anthropic', configDir });
    const provider = detectProviderFromModel(requestedModel) ?? 'anthropic';
    const modelId = provider === 'anthropic'
      ? resolveModelId(requestedModel)
      : requestedModel;
    return { auth, provider, modelId, configDir };
  }

  /**
   * Run startup recovery scan to detect and reset stuck subtasks on app launch
   * Scans all projects for implementation_plan.md files and resets any stuck subtasks
   */
  async runStartupRecoveryScan(): Promise<void> {
    console.log('[AgentManager] Running startup recovery scan for stuck subtasks...');

    try {
      // Get all projects from the store
      const projects = projectStore.getProjects();

      if (projects.length === 0) {
        console.log('[AgentManager] No projects found - skipping startup recovery scan');
        return;
      }

      let totalScanned = 0;
      let totalReset = 0;

      // Scan each project for stuck subtasks
      for (const project of projects) {
        if (!project.autoBuildPath) {
          continue; // Skip projects that haven't been initialized yet
        }

        const specsDir = getAutocodeSpecsDir({
          projectRoot: project.path,
          dataDirName: project.autoBuildPath,
        });

        // Check if specs directory exists
        if (!existsSync(specsDir)) {
          continue;
        }

        // Read all spec directories
        try {
          const specDirs = readdirSync(specsDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

          // Process each spec directory
          for (const specDirName of specDirs) {
            const planPath = path.join(specsDir, specDirName, AUTOCODE_TASK_ARTIFACTS.implementationPlan);

            // Check if implementation_plan.md exists
            if (!existsSync(planPath)) {
              continue;
            }

            totalScanned++;

            // Reset stuck subtasks (pass project.id to invalidate tasks cache)
            const { success, resetCount } = await resetStuckSubtasks(planPath, project.id);

            if (success && resetCount > 0) {
              totalReset += resetCount;
              console.log(`[AgentManager] Startup recovery: Reset ${resetCount} stuck subtask(s) in ${specDirName}`);
            }
          }
        } catch (err) {
          console.warn(`[AgentManager] Failed to scan specs directory for project ${project.name}:`, err);
        }
      }

      if (totalReset > 0) {
        console.log(`[AgentManager] Startup recovery complete: Reset ${totalReset} stuck subtask(s) across ${totalScanned} task(s)`);
      } else {
        console.log(`[AgentManager] Startup recovery complete: No stuck subtasks found (scanned ${totalScanned} task(s))`);
      }
    } catch (err) {
      console.error('[AgentManager] Startup recovery scan failed:', err);
    }
  }

  /**
   * Register a task with the unified OperationRegistry for proactive swap support.
   * Extracted helper to avoid code duplication between spec creation and task execution.
   * @private
   */
  private registerTaskWithOperationRegistry(
    taskId: string,
    operationType: 'spec-creation' | 'task-execution',
    metadata: Record<string, unknown>
  ): void {
    const profileManager = getClaudeProfileManager();
    const activeProfile = profileManager.getActiveProfile();
    if (!activeProfile) {
      return;
    }

    // Keep internal state tracking for backward compatibility
    this.assignProfileToTask(taskId, activeProfile.id, activeProfile.name, 'proactive');

    // Register with unified registry for proactive swap
    // Note: We don't provide a stopFn because restartTask() already handles stopping
    // the task internally via killTask() before restarting. Providing a separate
    // stopFn would cause a redundant double-kill during profile swaps.
    const operationRegistry = getOperationRegistry();
    operationRegistry.registerOperation(
      taskId,
      operationType,
      activeProfile.id,
      activeProfile.name,
      (newProfileId: string) => this.restartTask(taskId, newProfileId),
      { metadata }
    );
    console.log('[AgentManager] Task registered with OperationRegistry:', {
      taskId,
      profileId: activeProfile.id,
      profileName: activeProfile.name,
      type: operationType
    });
  }

  /**
   * Start spec creation process
   */
  async startSpecCreation(
    taskId: string,
    projectPath: string,
    taskDescription: string,
    specDir?: string,
    metadata?: SpecCreationMetadata,
    baseBranch?: string,
    projectId?: string
  ): Promise<void> {
    // Pre-flight auth check: Verify active profile has valid authentication
    // Ensure profile manager is initialized to prevent race condition
    let profileManager: ClaudeProfileManager;
    try {
      profileManager = await initializeClaudeProfileManager();
    } catch (error) {
      console.error('[AgentManager] Failed to initialize profile manager:', error);
      this.emit('error', taskId, 'Failed to initialize profile manager. Please check file permissions and disk space.');
      return;
    }
    if (!profileManager.hasValidAuth() && !this.hasAnyProviderAccount()) {
      this.emit('error', taskId, 'Authentication required. Please add an account in Settings > Accounts before starting tasks.');
      return;
    }

    // Reset stuck subtasks if restarting an existing spec creation task
    if (specDir) {
      const planPath = path.join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);
      console.log('[AgentManager] Resetting stuck subtasks before spec creation restart:', planPath);
      try {
        const { success, resetCount } = await resetStuckSubtasks(planPath);
        if (success && resetCount > 0) {
          console.log(`[AgentManager] Successfully reset ${resetCount} stuck subtask(s) before spec creation`);
        }
      } catch (err) {
        console.warn('[AgentManager] Failed to reset stuck subtasks before spec creation:', err);
      }
    }

    // Resolve model and thinking level for the spec phase
    const specModelShorthand = metadata?.phaseModels?.spec
      ? metadata.phaseModels.spec
      : (metadata?.model ?? 'sonnet');

    // Determine the preferred provider (from metadata or task_metadata.json)
    const preferredProvider = (
      specDir ? this.resolveTaskPhaseProvider(specDir, 'spec') : null
    ) ?? metadata?.phaseProviders?.spec ?? inferPinnedProviderFromModel(specModelShorthand) ?? (metadata?.provider as string | undefined) ?? null;

    // Resolve the model requested by queue. Keep shorthand when no preferred provider
    // so the queue can map across providers (e.g. sonnet -> gpt-5.x).
    let specModelRequest: string;
    if (preferredProvider && preferredProvider !== 'anthropic') {
      const equiv = resolveModelEquivalent(specModelShorthand, preferredProvider as BuiltinProvider)
        ?? resolveModelEquivalent(resolveModelId(specModelShorthand), preferredProvider as BuiltinProvider);
      specModelRequest = equiv?.modelId ?? specModelShorthand;
    } else if (preferredProvider === 'anthropic') {
      specModelRequest = resolveModelId(specModelShorthand);
    } else {
      specModelRequest = specModelShorthand;
    }

    const project = projectStore.getProjects().find((p) => p.id === projectId || p.path === projectPath);
    const agentProfile = resolveProjectAgentProfile(project?.settings?.projectType);
    const specAgentType = agentProfile.specOrchestrator;

    // Load system prompt from prompts directory
    const systemPrompt = this.loadPrompt(specAgentType) ?? buildAutocodeDefaultSpecPrompt({
      taskDescription,
      specDir,
      projectType: agentProfile.id,
    });

    // Resolve auth from provider accounts priority queue (falls back to legacy profile)
    let resolved: Awaited<ReturnType<AgentManager['resolveAuthFromProviderQueue']>>;
    try {
      resolved = await this.resolveAuthFromProviderQueue(specModelRequest, preferredProvider);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resolve a compatible account for this task.';
      this.emit('error', taskId, message);
      return;
    }
    if (this.providerRequiresCredentials(resolved.provider) && !resolved.auth) {
      this.emit('error', taskId, `No credentials available for provider "${resolved.provider}". Please add or fix an account in Settings > Accounts.`);
      return;
    }
    const workflowMode = metadata?.workflowMode ?? 'conservative';

    // Build the serializable session config for the worker
    const resolvedSpecDir = specDir ?? getAutocodeSpecDir({
      projectRoot: projectPath,
      dataDirName: project?.autoBuildPath,
      specId: taskId,
    });

    if (this.shouldUseCodexCliRuntime(resolved)) {
      await this.startCodexCliRuntime({
        taskId,
        projectPath,
        runtimeProjectRoot: projectPath,
        dataDirName: project?.autoBuildPath,
        specId: taskId,
        modelId: resolved.modelId,
        options: baseBranch ? { baseBranch } : {},
        processType: 'spec-creation',
        projectId,
        isSpecCreation: true,
        taskDescription,
        specDir: resolvedSpecDir,
        metadata,
        baseBranch,
      });
      return;
    }

    const sessionRuntime = this.buildSessionRuntimeOptions(workflowMode, projectPath, specAgentType);
    const initialTaskDescription = compactSpecInitialTaskDescription(taskDescription);
    const specInitialContent = [
      `Task: ${initialTaskDescription}`,
      `Project directory: ${projectPath}`,
      ...(specDir ? [`Spec directory: ${specDir}`] : []),
      ...(baseBranch ? [`Base branch: ${baseBranch}`] : []),
      metadata?.requireReviewBeforeCoding ? 'Require review before coding: true' : 'Auto-approve: true',
    ].join('\n');

    const sessionConfig: SerializableSessionConfig = {
      agentType: specAgentType,
      systemPrompt,
      phase: 'spec' as const,
      initialMessages: [
        {
          role: 'user',
          content: specInitialContent,
        },
      ],
      maxSteps: sessionRuntime.maxSteps,
      phaseStepBudgets: sessionRuntime.phaseStepBudgets,
      specDir: resolvedSpecDir,
      projectDir: projectPath,
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey: resolved.auth?.apiKey,
      baseURL: resolved.auth?.baseURL,
      configDir: resolved.configDir,
      oauthTokenFilePath: resolved.auth?.oauthTokenFilePath,
      mcpOptions: sessionRuntime.mcpOptions,
      workflowMode,
      projectType: agentProfile.id,
      language: this.resolveAppLanguage(),
      autoPushToRemote: !isMainBranch(projectPath),
      toolContext: {
        cwd: projectPath,
        projectDir: projectPath,
        specDir: resolvedSpecDir,
        securityProfile: this.serializeSecurityProfile(projectPath),
      },
    };

    const executorConfig: AgentExecutorConfig = {
      taskId,
      projectId,
      processType: 'spec-creation',
      session: sessionConfig,
    };

    // Store context for potential restart
    this.storeTaskContext(taskId, projectPath, '', {}, true, taskDescription, specDir, metadata, baseBranch, projectId);

    // Register with unified OperationRegistry for proactive swap support
    this.registerTaskWithOperationRegistry(taskId, 'spec-creation', { projectPath, taskDescription, specDir });

    await this.processManager.spawnWorkerProcess(taskId, executorConfig, {}, 'spec-creation', projectId);

    // Note (Python fallback preserved for reference):
    // const combinedEnv = this.processManager.getCombinedEnv(projectPath);
    // const args = [specRunnerPath, '--task', taskDescription, '--project-dir', projectPath];
    // await this.processManager.spawnProcess(taskId, projectPath, args, combinedEnv, 'task-execution', projectId);
  }

  /**
   * Start task execution (build orchestrator)
   */
  async startTaskExecution(
    taskId: string,
    projectPath: string,
    specId: string,
    options: TaskExecutionOptions = {},
    projectId?: string
  ): Promise<void> {
    // Pre-flight auth check: Verify active profile has valid authentication
    // Ensure profile manager is initialized to prevent race condition
    let profileManager: ClaudeProfileManager;
    try {
      profileManager = await initializeClaudeProfileManager();
    } catch (error) {
      console.error('[AgentManager] Failed to initialize profile manager:', error);
      this.emit('error', taskId, 'Failed to initialize profile manager. Please check file permissions and disk space.');
      return;
    }
    if (!profileManager.hasValidAuth() && !this.hasAnyProviderAccount()) {
      this.emit('error', taskId, 'Authentication required. Please add an account in Settings > Accounts before starting tasks.');
      return;
    }

    // Resolve the spec directory from specId
    const project = projectStore.getProjects().find((p) => p.id === projectId || p.path === projectPath);
    const specDir = getAutocodeSpecDir({
      projectRoot: projectPath,
      dataDirName: project?.autoBuildPath,
      specId,
    });
    const workflowMode = this.resolveTaskWorkflowMode(specDir);
    if (workflowMode === 'off') {
      await this.startDirectTaskExecution(taskId, projectPath, specId, options, projectId);
      return;
    }

    // Load model configuration from task_metadata.json if available
    const modelId = await this.resolveTaskModelId(specDir, 'planning');
    const preferredProvider = this.resolveTaskPhaseProvider(specDir, 'planning');
    const runtimeConcurrency = this.resolveTaskRuntimeConcurrency(specDir);
    const agentProfile = resolveProjectAgentProfile(project?.settings?.projectType);
    const buildAgentType = agentProfile.buildOrchestrator;
    const sessionRuntime = this.buildSessionRuntimeOptions(workflowMode, projectPath, buildAgentType);

    // Load system prompt (planner prompt for build orchestrator entry point)
    const systemPrompt = this.loadPrompt(agentProfile.planning) ?? this.loadPrompt('planner') ?? buildAutocodeDefaultPlannerPrompt({
      specId,
      projectRoot: projectPath,
      projectType: agentProfile.id,
    });

    // Resolve auth from provider accounts priority queue (falls back to legacy profile)
    let resolved: Awaited<ReturnType<AgentManager['resolveAuthFromProviderQueue']>>;
    try {
      resolved = await this.resolveAuthFromProviderQueue(modelId, preferredProvider);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resolve a compatible account for this task.';
      this.emit('error', taskId, message, projectId);
      return;
    }
    if (this.providerRequiresCredentials(resolved.provider) && !resolved.auth) {
      this.emit('error', taskId, `No credentials available for provider "${resolved.provider}". Please add or fix an account in Settings > Accounts.`, projectId);
      return;
    }

    // Create or get a git worktree only when explicitly requested. Existing task
    // worktrees are still honored for backwards-compatible resume/retry behavior.
    let worktreePath: string | null = null;
    let worktreeSpecDir = specDir;
    const existingWorktreePath = options.useWorktree === false ? null : findTaskWorktree(projectPath, specId);
    const useWorktree = options.useWorktree === true || existingWorktreePath !== null;
    if (useWorktree) {
      try {
        const baseBranch = resolveTaskBaseBranch(projectPath, options.baseBranch, project?.settings?.mainBranch);
        const result = await createOrGetWorktree(
          projectPath,
          specId,
          baseBranch,
          options.useLocalBranch ?? false,
          options.pushNewBranches ?? project?.settings?.pushNewBranches === true,
          project?.autoBuildPath,
          options.forcePlanning === true,
        );
        worktreePath = result.worktreePath;
        // Spec dir in the worktree (spec files were copied by createOrGetWorktree)
        worktreeSpecDir = getAutocodeSpecDir({
          projectRoot: worktreePath,
          dataDirName: project?.autoBuildPath,
          specId,
        });
        console.warn(`[AgentManager] Task ${taskId} will run in worktree: ${worktreePath}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[AgentManager] Failed to create worktree for ${taskId}:`, err);
        this.emit(
          'error',
          taskId,
          `Failed to create isolated worktree for this task. Execution was stopped to avoid writing changes to the main project branch. ${message}`,
          projectId,
        );
        this.emit('task-event', taskId, {
          type: 'CODING_FAILED',
          taskId,
          specId,
          projectId: projectId ?? '',
          timestamp: new Date().toISOString(),
          eventId: `${taskId}-worktree-setup-failed-${Date.now()}`,
          sequence: Date.now(),
          subtaskId: 'worktree-setup',
          error: message,
          attemptCount: 0,
        }, projectId);
        return;
      }
    } else {
      captureDirectWorkspaceBaseline(projectPath, specDir);
    }

    const effectiveCwd = worktreePath ?? projectPath;
    const effectiveProjectDir = worktreePath ?? projectPath;

    if (this.shouldUseCodexCliRuntime(resolved)) {
      await this.startCodexCliRuntime({
        taskId,
        projectPath,
        runtimeProjectRoot: effectiveProjectDir,
        dataDirName: project?.autoBuildPath,
        specId,
        modelId: resolved.modelId,
        options,
        processType: 'task-execution',
        projectId,
        specDir: worktreeSpecDir,
      });
      return;
    }

    // Load initial context from spec directory
    const language = this.resolveAppLanguage();
    const initialMessages = buildAutocodeTaskExecutionMessages({
      specDir: worktreeSpecDir,
      specId,
      projectRoot: effectiveProjectDir,
      dataDirName: project?.autoBuildPath,
      language,
      forcePlanning: options.forcePlanning === true,
    });

    // Build the serializable session config for the worker
    const sessionConfig: SerializableSessionConfig = {
      agentType: buildAgentType,
      systemPrompt,
      initialMessages,
      maxSteps: sessionRuntime.maxSteps,
      phaseStepBudgets: sessionRuntime.phaseStepBudgets,
      specDir: worktreeSpecDir,
      projectDir: effectiveProjectDir,
      sourceProjectDir: worktreePath ? projectPath : undefined,
      // When running in a worktree, sourceSpecDir points to the main project spec dir
      // so the subtask iterator can sync phase updates in real time (not just on exit).
      sourceSpecDir: worktreePath ? specDir : undefined,
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey: resolved.auth?.apiKey,
      baseURL: resolved.auth?.baseURL,
      configDir: resolved.configDir,
      oauthTokenFilePath: resolved.auth?.oauthTokenFilePath,
      mcpOptions: sessionRuntime.mcpOptions,
      workflowMode,
      forcePlanning: options.forcePlanning === true,
      projectType: agentProfile.id,
      runtimeConcurrency,
      language,
      autoPushToRemote: !isMainBranch(projectPath),
      toolContext: {
        cwd: effectiveCwd,
        projectDir: effectiveProjectDir,
        specDir: worktreeSpecDir,
        securityProfile: this.serializeSecurityProfile(effectiveProjectDir),
      },
    };

    const executorConfig: AgentExecutorConfig = {
      taskId,
      projectId,
      processType: 'task-execution',
      session: sessionConfig,
    };

    // Store context for potential restart
    this.storeTaskContext(taskId, projectPath, specId, options, false, undefined, undefined, undefined, undefined, projectId);

    // Register with unified OperationRegistry for proactive swap support
    this.registerTaskWithOperationRegistry(taskId, 'task-execution', { projectPath, specId, options });

    await this.processManager.spawnWorkerProcess(taskId, executorConfig, {}, 'task-execution', projectId);

    // Note (Python fallback preserved for reference):
    // const combinedEnv = this.processManager.getCombinedEnv(projectPath);
    // const args = [runPath, '--spec', specId, '--project-dir', projectPath, '--auto-continue', '--force'];
    // await this.processManager.spawnProcess(taskId, projectPath, args, combinedEnv, 'task-execution', projectId);
  }

  /**
   * Start direct task execution: one model session, no spec/planning/QA orchestration.
   */
  async startDirectTaskExecution(
    taskId: string,
    projectPath: string,
    specId: string,
    options: TaskExecutionOptions = {},
    projectId?: string
  ): Promise<void> {
    let profileManager: ClaudeProfileManager;
    try {
      profileManager = await initializeClaudeProfileManager();
    } catch (error) {
      console.error('[AgentManager] Failed to initialize profile manager:', error);
      this.emit('error', taskId, 'Failed to initialize profile manager. Please check file permissions and disk space.');
      return;
    }
    if (!profileManager.hasValidAuth() && !this.hasAnyProviderAccount()) {
      this.emit('error', taskId, 'Authentication required. Please add an account in Settings > Accounts before starting tasks.');
      return;
    }

    const project = projectStore.getProjects().find((p) => p.id === projectId || p.path === projectPath);
    const specDir = getAutocodeSpecDir({
      projectRoot: projectPath,
      dataDirName: project?.autoBuildPath,
      specId,
    });
    const workflowMode = this.resolveTaskWorkflowMode(specDir);

    const modelId = await this.resolveTaskModelId(specDir, 'coding');
    const preferredProvider = this.resolveTaskPhaseProvider(specDir, 'coding');
    const thinkingLevel = this.resolveTaskThinkingLevel(specDir, 'coding');
    const sessionRuntime = this.buildSessionRuntimeOptions(workflowMode, projectPath, 'direct_task');
    const systemPrompt = this.loadPrompt('direct_task') ?? buildAutocodeDefaultDirectTaskPrompt({
      specId,
      projectRoot: projectPath,
    });

    let resolved: Awaited<ReturnType<AgentManager['resolveAuthFromProviderQueue']>>;
    try {
      resolved = await this.resolveAuthFromProviderQueue(modelId, preferredProvider);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resolve a compatible account for this task.';
      this.emit('error', taskId, message, projectId);
      return;
    }
    if (this.providerRequiresCredentials(resolved.provider) && !resolved.auth) {
      this.emit('error', taskId, `No credentials available for provider "${resolved.provider}". Please add or fix an account in Settings > Accounts.`, projectId);
      return;
    }

    let worktreePath: string | null = null;
    let worktreeSpecDir = specDir;
    const existingWorktreePath = options.useWorktree === false ? null : findTaskWorktree(projectPath, specId);
    const useWorktree = options.useWorktree === true || existingWorktreePath !== null;
    if (useWorktree) {
      try {
        const baseBranch = resolveTaskBaseBranch(projectPath, options.baseBranch, project?.settings?.mainBranch);
        const result = await createOrGetWorktree(
          projectPath,
          specId,
          baseBranch,
          options.useLocalBranch ?? false,
          options.pushNewBranches ?? project?.settings?.pushNewBranches === true,
          project?.autoBuildPath,
        );
        worktreePath = result.worktreePath;
        worktreeSpecDir = getAutocodeSpecDir({
          projectRoot: worktreePath,
          dataDirName: project?.autoBuildPath,
          specId,
        });
        console.warn(`[AgentManager] Direct task ${taskId} will run in worktree: ${worktreePath}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[AgentManager] Failed to create worktree for direct task ${taskId}:`, err);
        this.emit(
          'error',
          taskId,
          `Failed to create isolated worktree for this direct task. Execution was stopped to avoid writing changes to the main project branch. ${message}`,
          projectId,
        );
        this.emit('task-event', taskId, {
          type: 'CODING_FAILED',
          taskId,
          specId,
          projectId: projectId ?? '',
          timestamp: new Date().toISOString(),
          eventId: `${taskId}-direct-worktree-setup-failed-${Date.now()}`,
          sequence: Date.now(),
          subtaskId: 'direct-implementation',
          error: message,
          attemptCount: 0,
        }, projectId);
        return;
      }
    } else {
      captureDirectWorkspaceBaseline(projectPath, specDir);
    }

    const effectiveCwd = worktreePath ?? projectPath;
    const effectiveProjectDir = worktreePath ?? projectPath;
    const directSessionState = resolveAutocodeDirectSessionState(worktreeSpecDir, specDir);
    const supportsProviderContinuation = isAutocodeOpenAIResponsesTransport(resolved.provider, resolved.modelId);
    const useProviderContinuation = supportsProviderContinuation && Boolean(directSessionState?.providerResponseId);
    const directContinuationMode = directSessionState
      ? useProviderContinuation
        ? 'provider'
        : 'summary'
      : undefined;

    if (this.shouldUseCodexCliRuntime(resolved)) {
      await this.startCodexCliRuntime({
        taskId,
        projectPath,
        runtimeProjectRoot: effectiveProjectDir,
        dataDirName: project?.autoBuildPath,
        specId,
        modelId: resolved.modelId,
        options,
        processType: 'task-execution',
        projectId,
        direct: true,
        specDir: worktreeSpecDir,
      });
      return;
    }

    const language = this.resolveAppLanguage();
    const initialMessages = buildAutocodeDirectTaskExecutionMessages({
      specDir: worktreeSpecDir,
      specId,
      projectRoot: effectiveProjectDir,
      dataDirName: project?.autoBuildPath,
      language,
      directSessionState,
      directContinuationMode,
    });

    const sessionConfig: SerializableSessionConfig = {
      sessionId: directSessionState?.sessionId ?? randomUUID(),
      agentType: 'direct_task',
      systemPrompt,
      initialMessages,
      maxSteps: sessionRuntime.maxSteps,
      phaseStepBudgets: sessionRuntime.phaseStepBudgets,
      specDir: worktreeSpecDir,
      projectDir: effectiveProjectDir,
      sourceProjectDir: worktreePath ? projectPath : undefined,
      sourceSpecDir: worktreePath ? specDir : undefined,
      phase: 'coding',
      provider: resolved.provider,
      modelId: resolved.modelId,
      thinkingLevel,
      apiKey: resolved.auth?.apiKey,
      baseURL: resolved.auth?.baseURL,
      configDir: resolved.configDir,
      oauthTokenFilePath: resolved.auth?.oauthTokenFilePath,
      responsePersistence: supportsProviderContinuation,
      previousResponseId: useProviderContinuation ? directSessionState?.providerResponseId : undefined,
      directProviderContinuation: useProviderContinuation,
      mcpOptions: sessionRuntime.mcpOptions,
      workflowMode: 'off',
      language,
      autoPushToRemote: !isMainBranch(projectPath),
      toolContext: {
        cwd: effectiveCwd,
        projectDir: effectiveProjectDir,
        specDir: worktreeSpecDir,
        securityProfile: this.serializeSecurityProfile(effectiveProjectDir),
      },
    };

    const executorConfig: AgentExecutorConfig = {
      taskId,
      projectId,
      processType: 'task-execution',
      session: sessionConfig,
    };

    this.storeTaskContext(taskId, projectPath, specId, options, false, undefined, undefined, undefined, undefined, projectId, true);
    this.registerTaskWithOperationRegistry(taskId, 'task-execution', { projectPath, specId, options, direct: true });

    await this.processManager.spawnWorkerProcess(taskId, executorConfig, {}, 'task-execution', projectId);
  }

  /**
   * Start QA process (qa_reviewer agent)
   */
  async startQAProcess(
    taskId: string,
    projectPath: string,
    specId: string,
    projectId?: string
  ): Promise<void> {
    // Ensure profile manager is initialized for auth resolution
    let profileManager: ClaudeProfileManager;
    try {
      profileManager = await initializeClaudeProfileManager();
    } catch (error) {
      console.error('[AgentManager] Failed to initialize profile manager:', error);
      this.emit('error', taskId, 'Failed to initialize profile manager. Please check file permissions and disk space.');
      return;
    }
    if (!profileManager.hasValidAuth() && !this.hasAnyProviderAccount()) {
      this.emit('error', taskId, 'Authentication required. Please add an account in Settings > Accounts before starting tasks.');
      return;
    }

    // Resolve the spec directory from specId
    const project = projectStore.getProjects().find((p) => p.id === projectId || p.path === projectPath);
    const specDir = getAutocodeSpecDir({
      projectRoot: projectPath,
      dataDirName: project?.autoBuildPath,
      specId,
    });

    // Load model configuration from task_metadata.json if available
    const modelId = await this.resolveTaskModelId(specDir, 'qa');
    const preferredProvider = this.resolveTaskPhaseProvider(specDir, 'qa');
    const workflowMode = this.resolveTaskWorkflowMode(specDir);
    const agentProfile = resolveProjectAgentProfile(project?.settings?.projectType);
    const qaReviewAgentType = agentProfile.qaReview;
    const sessionRuntime = this.buildSessionRuntimeOptions(workflowMode, projectPath, qaReviewAgentType);

    // Load system prompt for QA reviewer
    const systemPrompt = this.loadPrompt(qaReviewAgentType) ?? this.loadPrompt('qa_reviewer') ?? buildAutocodeDefaultQAPrompt({
      specId,
      projectRoot: projectPath,
      projectType: agentProfile.id,
    });

    // Resolve auth from provider accounts priority queue (falls back to legacy profile)
    let resolved: Awaited<ReturnType<AgentManager['resolveAuthFromProviderQueue']>>;
    try {
      resolved = await this.resolveAuthFromProviderQueue(modelId, preferredProvider);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resolve a compatible account for this task.';
      this.emit('error', taskId, message, projectId);
      return;
    }
    if (this.providerRequiresCredentials(resolved.provider) && !resolved.auth) {
      this.emit('error', taskId, `No credentials available for provider "${resolved.provider}". Please add or fix an account in Settings > Accounts.`, projectId);
      return;
    }

    // Find existing worktree for QA (created during task execution)
    const worktreePath = findTaskWorktree(projectPath, specId);
    const effectiveCwd = worktreePath ?? projectPath;
    const effectiveProjectDir = worktreePath ?? projectPath;
    const effectiveSpecDir = worktreePath
      ? getAutocodeSpecDir({
        projectRoot: worktreePath,
        dataDirName: project?.autoBuildPath,
        specId,
      })
      : specDir;

    if (worktreePath) {
      console.warn(`[AgentManager] QA for ${taskId} will run in worktree: ${worktreePath}`);
    } else {
      console.warn(`[AgentManager] No worktree found for ${taskId}, QA running in project root`);
    }

    // Load initial context from spec directory
    const qaInitialMessages = buildAutocodeQAInitialMessages({
      specDir: effectiveSpecDir,
      specId,
      projectRoot: effectiveProjectDir,
      dataDirName: project?.autoBuildPath,
    });

    // Build the serializable session config for the worker
    const sessionConfig: SerializableSessionConfig = {
      agentType: qaReviewAgentType,
      systemPrompt,
      initialMessages: qaInitialMessages,
      maxSteps: sessionRuntime.maxSteps,
      phaseStepBudgets: sessionRuntime.phaseStepBudgets,
      specDir: effectiveSpecDir,
      projectDir: effectiveProjectDir,
      sourceProjectDir: worktreePath ? projectPath : undefined,
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey: resolved.auth?.apiKey,
      baseURL: resolved.auth?.baseURL,
      configDir: resolved.configDir,
      oauthTokenFilePath: resolved.auth?.oauthTokenFilePath,
      mcpOptions: sessionRuntime.mcpOptions,
      workflowMode,
      projectType: agentProfile.id,
      language: this.resolveAppLanguage(),
      autoPushToRemote: !isMainBranch(projectPath),
      toolContext: {
        cwd: effectiveCwd,
        projectDir: effectiveProjectDir,
        specDir: effectiveSpecDir,
        securityProfile: this.serializeSecurityProfile(effectiveProjectDir),
      },
    };

    const executorConfig: AgentExecutorConfig = {
      taskId,
      projectId,
      processType: 'qa-process',
      session: sessionConfig,
    };

    await this.processManager.spawnWorkerProcess(taskId, executorConfig, {}, 'qa-process', projectId);

    // Note (Python fallback preserved for reference):
    // const combinedEnv = this.processManager.getCombinedEnv(projectPath);
    // const args = [runPath, '--spec', specId, '--project-dir', projectPath, '--qa'];
    // await this.processManager.spawnProcess(taskId, projectPath, args, combinedEnv, 'qa-process', projectId);
  }

  /**
   * Start roadmap generation process
   */
  startRoadmapGeneration(
    projectId: string,
    projectPath: string,
    refresh: boolean = false,
    enableCompetitorAnalysis: boolean = false,
    refreshCompetitorAnalysis: boolean = false,
    config?: RoadmapConfig
  ): void {
    void this.queueManager
      .startRoadmapGeneration(projectId, projectPath, refresh, enableCompetitorAnalysis, refreshCompetitorAnalysis, config)
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to start roadmap generation';
        console.error('[AgentManager] Roadmap generation failed to start:', error);
        this.emit('roadmap-error', projectId, message);
      });
  }

  /**
   * Start ideation generation process
   */
  startIdeationGeneration(
    projectId: string,
    projectPath: string,
    config: IdeationConfig,
    refresh: boolean = false
  ): void {
    this.queueManager.startIdeationGeneration(projectId, projectPath, config, refresh);
  }

  /**
   * Kill a specific task's process
   */
  killTask(taskId: string): boolean {
    return this.processManager.killProcess(taskId);
  }

  /**
   * Stop ideation generation for a project
   */
  stopIdeation(projectId: string): boolean {
    return this.queueManager.stopIdeation(projectId);
  }

  /**
   * Check if ideation is running for a project
   */
  isIdeationRunning(projectId: string): boolean {
    return this.queueManager.isIdeationRunning(projectId);
  }

  /**
   * Stop roadmap generation for a project
   */
  stopRoadmap(projectId: string): boolean {
    return this.queueManager.stopRoadmap(projectId);
  }

  /**
   * Check if roadmap is running for a project
   */
  isRoadmapRunning(projectId: string): boolean {
    return this.queueManager.isRoadmapRunning(projectId);
  }

  /**
   * Kill all running processes
   */
  async killAll(): Promise<void> {
    await this.processManager.killAllProcesses();
  }

  /**
   * Check if a task is running
   */
  isRunning(taskId: string): boolean {
    return this.state.hasProcess(taskId);
  }

  getTaskRuntimeMs(taskId: string): number | null {
    const process = this.state.getProcess(taskId);
    return process ? Date.now() - process.startedAt.getTime() : null;
  }

  /**
   * Get all running task IDs
   */
  getRunningTasks(): string[] {
    return this.state.getRunningTaskIds();
  }

  /**
   * Store task execution context for potential restarts
   */
  private storeTaskContext(
    taskId: string,
    projectPath: string,
    specId: string,
    options: TaskExecutionOptions,
    isSpecCreation?: boolean,
    taskDescription?: string,
    specDir?: string,
    metadata?: SpecCreationMetadata,
    baseBranch?: string,
    projectId?: string,
    isDirectExecution?: boolean
  ): void {
    // Preserve swapCount if context already exists (for restarts)
    const existingContext = this.taskExecutionContext.get(taskId);
    const swapCount = existingContext?.swapCount ?? 0;
    // Increment generation on each store (restarts) to invalidate pending cleanup callbacks
    const generation = (existingContext?.generation ?? 0) + 1;

    this.taskExecutionContext.set(taskId, {
      projectPath,
      specId,
      options,
      isSpecCreation,
      taskDescription,
      specDir,
      metadata,
      baseBranch,
      isDirectExecution,
      swapCount, // Preserve existing count instead of resetting
      projectId,
      generation, // Incremented to prevent stale exit cleanup
    });
  }

  /**
   * Restart task after profile swap
   * @param taskId - The task to restart
   * @param newProfileId - Optional new profile ID to apply (from auto-swap)
   */
  restartTask(taskId: string, newProfileId?: string): boolean {
    console.log('[AgentManager] restartTask called for:', taskId, 'with newProfileId:', newProfileId);

    const context = this.taskExecutionContext.get(taskId);
    if (!context) {
      console.error('[AgentManager] No context for task:', taskId);
      console.log('[AgentManager] Available task contexts:', Array.from(this.taskExecutionContext.keys()));
      return false;
    }

    console.log('[AgentManager] Task context found:', {
      taskId,
      projectPath: context.projectPath,
      specId: context.specId,
      isSpecCreation: context.isSpecCreation,
      swapCount: context.swapCount
    });

    // Prevent infinite swap loops
    if (context.swapCount >= 2) {
      console.error('[AgentManager] Max swap count reached for task:', taskId, '- stopping restart loop');
      return false;
    }

    context.swapCount++;
    console.log('[AgentManager] Incremented swap count to:', context.swapCount);

    // If a new profile was specified, ensure it's set as active before restart
    if (newProfileId) {
      const profileManager = getClaudeProfileManager();
      const currentActiveId = profileManager.getActiveProfile()?.id;
      if (currentActiveId !== newProfileId) {
        console.log('[AgentManager] Setting active profile to:', newProfileId);
        profileManager.setActiveProfile(newProfileId);
      }
    }

    // Kill current process
    console.log('[AgentManager] Killing current process for task:', taskId);
    this.killTask(taskId);

    // Wait for cleanup, then reset stuck subtasks and restart
    console.log('[AgentManager] Scheduling task restart in 500ms');
    setTimeout(async () => {
      // Reset stuck subtasks before restart to avoid picking up stale in-progress states
      if (context.specId || context.specDir) {
        const planPath = context.specDir
          ? path.join(context.specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan)
          : path.join(
              context.projectPath,
              getAutocodeSpecsRelativeDir(),
              context.specId,
              AUTOCODE_TASK_ARTIFACTS.implementationPlan,
            );

        console.log('[AgentManager] Resetting stuck subtasks before restart:', planPath);
        try {
          const { success, resetCount } = await resetStuckSubtasks(planPath);
          if (success && resetCount > 0) {
            console.log(`[AgentManager] Successfully reset ${resetCount} stuck subtask(s)`);
          }
        } catch (err) {
          console.warn('[AgentManager] Failed to reset stuck subtasks:', err);
        }
      }

      console.log('[AgentManager] Restarting task now:', taskId);
      if (context.isSpecCreation) {
        console.log('[AgentManager] Restarting as spec creation');
        if (!context.taskDescription) {
          console.error('[AgentManager] Cannot restart spec creation: taskDescription is missing');
          return;
        }
        this.startSpecCreation(
          taskId,
          context.projectPath,
          context.taskDescription,
          context.specDir,
          context.metadata,
          context.baseBranch,
          context.projectId
        );
      } else {
        console.log('[AgentManager] Restarting as task execution');
        if (context.isDirectExecution) {
          this.startDirectTaskExecution(
            taskId,
            context.projectPath,
            context.specId,
            context.options,
            context.projectId
          );
        } else {
          this.startTaskExecution(
            taskId,
            context.projectPath,
            context.specId,
            context.options,
            context.projectId
          );
        }
      }
    }, 500);

    return true;
  }

  // ============================================
  // Queue Routing Methods (Rate Limit Recovery)
  // ============================================

  /**
   * Get running tasks grouped by profile
   * Used by queue routing to determine profile load
   */
  getRunningTasksByProfile(): { byProfile: Record<string, string[]>; totalRunning: number } {
    return this.state.getRunningTasksByProfile();
  }

  /**
   * Assign a profile to a task
   * Records which profile is being used for a task
   */
  assignProfileToTask(
    taskId: string,
    profileId: string,
    profileName: string,
    reason: 'proactive' | 'reactive' | 'manual'
  ): void {
    this.state.assignProfileToTask(taskId, profileId, profileName, reason);
  }

  /**
   * Get the profile assignment for a task
   */
  getTaskProfileAssignment(taskId: string): { profileId: string; profileName: string; reason: string } | undefined {
    return this.state.getTaskProfileAssignment(taskId);
  }

  /**
   * Update the session ID for a task (for session resume)
   */
  updateTaskSession(taskId: string, sessionId: string): void {
    this.state.updateTaskSession(taskId, sessionId);
  }

  /**
   * Get the session ID for a task
   */
  getTaskSessionId(taskId: string): string | undefined {
    return this.state.getTaskSessionId(taskId);
  }

  // ============================================
  // Private helpers for TypeScript agent path
  // ============================================

  /**
   * Serialize a project's SecurityProfile (Sets) into a SerializedSecurityProfile (arrays)
   * for transfer across worker thread boundaries.
   */
  private serializeSecurityProfile(projectDir: string): SerializedSecurityProfile {
    const profile = getSecurityProfile(projectDir);
    return {
      baseCommands: [...profile.baseCommands],
      stackCommands: [...profile.stackCommands],
      scriptCommands: [...profile.scriptCommands],
      customCommands: [...profile.customCommands],
      customScripts: {
        shellScripts: profile.customScripts.shellScripts,
      },
    };
  }

  /**
   * Resolve the model ID for a task by reading task_metadata.json.
   * Falls back to the default sonnet model if metadata is not available.
   *
   * @param specDir - The spec directory path
   * @param phase - The execution phase ('planning', 'coding', 'qa', 'spec')
   */
  private async resolveTaskModelId(specDir: string, phase: 'planning' | 'coding' | 'qa' | 'spec'): Promise<string> {
    return resolveAutocodeTaskPhaseModelId({
      metadata: loadAutocodeTaskRuntimeMetadataConfig(specDir),
      phase,
      resolveModelId,
      inferPinnedProvider: inferPinnedProviderFromModel,
      resolveModelEquivalent: (modelValue, targetProvider) =>
        resolveModelEquivalent(modelValue, targetProvider as BuiltinProvider),
      providerPhaseModelResolver: (targetProvider) => {
        const settings = readSettingsFile();
        return (settings?.providerAgentConfig as Record<string, Record<string, unknown>> | undefined)
          ?.[targetProvider]
          ?.customPhaseModels as Record<string, string> | undefined;
      },
    });
  }

  /**
   * Resolve the provider override for a phase from task_metadata.json.
   * Returns null if no per-phase provider is specified (use default queue).
   */
  private resolveTaskPhaseProvider(specDir: string, phase: 'planning' | 'coding' | 'qa' | 'spec'): string | null {
    return resolveAutocodeTaskPhaseProvider(
      loadAutocodeTaskRuntimeMetadataConfig(specDir),
      phase,
      { inferPinnedProvider: inferPinnedProviderFromModel },
    );
  }

  private resolveTaskThinkingLevel(
    specDir: string,
    phase: 'planning' | 'coding' | 'qa' | 'spec',
  ): SerializableSessionConfig['thinkingLevel'] {
    const metadata = loadAutocodeTaskRuntimeMetadataConfig(specDir) as TaskMetadata | null;
    if (metadata?.isAutoProfile && metadata.phaseThinking?.[phase]) {
      return metadata.phaseThinking[phase];
    }
    return metadata?.thinkingLevel || DEFAULT_PHASE_THINKING[phase];
  }

  private resolveTaskWorkflowMode(specDir: string): TaskWorkflowMode {
    return resolveAutocodeTaskWorkflowMode(loadAutocodeTaskRuntimeMetadataConfig(specDir));
  }

  private resolveTaskRuntimeConcurrency(specDir: string): AutocodeTaskRuntimeConcurrencyResolved {
    return resolveAutocodeTaskRuntimeConcurrency(loadAutocodeTaskRuntimeMetadataConfig(specDir));
  }

  private resolveAppLanguage(): SerializableSessionConfig['language'] {
    const language = readSettingsFile()?.language;
    if (typeof language === 'string' && language.trim()) {
      return resolveSupportedLanguage(language);
    }
    return undefined;
  }

  private toCrossProviderModelRequest(model: string): string {
    return resolveAutocodeCrossProviderModelRequest(model, { resolveModelId });
  }

  private providerRequiresCredentials(provider: string): boolean {
    return provider !== 'ollama';
  }

  private shouldUseCodexCliRuntime(resolved: {
    provider: string;
    modelId: string;
    auth: { source?: string; oauthTokenFilePath?: string } | null;
  }): boolean {
    return (
      resolved.provider === 'openai' &&
      resolved.auth?.source === 'codex-oauth'
    );
  }

  private async startCodexCliRuntime(input: {
    taskId: string;
    projectPath: string;
    runtimeProjectRoot: string;
    dataDirName?: string;
    specId: string;
    modelId: string;
    options: TaskExecutionOptions;
    processType: 'spec-creation' | 'task-execution';
    projectId?: string;
    isSpecCreation?: boolean;
    taskDescription?: string;
    specDir?: string;
    metadata?: SpecCreationMetadata;
    baseBranch?: string;
    direct?: boolean;
  }): Promise<void> {
    const runtimeSpecDir = input.specDir ?? getAutocodeSpecDir({
      projectRoot: input.runtimeProjectRoot,
      dataDirName: input.dataDirName,
      specId: input.specId,
    });
    const settings = readSettingsFile();
    const started = createStartedAutocodeAgentRuntime({
      projectRoot: input.runtimeProjectRoot,
      dataDirName: input.dataDirName,
      taskId: input.specId || input.taskId,
      projectId: input.projectId,
      cli: 'codex',
      model: input.modelId,
      bypassPermissions: settings?.dangerouslySkipPermissions === true,
      language: this.resolveAppLanguage(),
      forcePlanning: input.options.forcePlanning === true,
    });
    const processCommand = started.request.runner?.process;
    if (!processCommand) {
      throw new Error('Codex CLI runtime request did not include a process command.');
    }

    this.storeTaskContext(
      input.taskId,
      input.projectPath,
      input.isSpecCreation ? '' : input.specId,
      input.options,
      input.isSpecCreation === true,
      input.taskDescription,
      runtimeSpecDir,
      input.metadata,
      input.baseBranch,
      input.projectId,
      input.direct === true,
    );

    this.registerTaskWithOperationRegistry(
      input.taskId,
      input.processType,
      input.isSpecCreation
        ? { projectPath: input.projectPath, taskDescription: input.taskDescription, specDir: input.specDir }
        : { projectPath: input.projectPath, specId: input.specId, options: input.options, ...(input.direct ? { direct: true } : {}) },
    );

    console.warn('[AgentManager] Routing OpenAI Codex subscription task through Codex CLI runtime:', {
      taskId: input.taskId,
      specId: input.specId,
      cwd: processCommand.cwd,
      command: processCommand.shellCommand,
    });

    await this.processManager.spawnProcess(
      input.taskId,
      processCommand.cwd,
      [processCommand.command, ...processCommand.args],
      this.processManager.getCombinedEnv(input.projectPath),
      input.processType,
      input.projectId,
      {
        taskId: input.taskId,
        projectId: input.projectId,
        projectRoot: input.projectPath,
        workspaceRoot: input.runtimeProjectRoot,
        mode: this.resolveRuntimeWorkspaceMode(input.projectPath, input.runtimeProjectRoot),
        fileIntents: this.collectRuntimeWorkspaceFileIntents(runtimeSpecDir),
        label: `${input.processType}:${input.taskId}`,
      },
    );
  }

  private resolveRuntimeWorkspaceMode(projectRoot: string, workspaceRoot: string): AutocodeRuntimeWorkspaceMode {
    return normalizeAutocodeRuntimePath(projectRoot) === normalizeAutocodeRuntimePath(workspaceRoot)
      ? 'direct'
      : 'worktree';
  }

  private collectRuntimeWorkspaceFileIntents(specDir: string | undefined): string[] {
    if (!specDir) {
      return [];
    }
    try {
      return collectAutocodeRuntimeFileIntentsFromPlan(loadAutocodeImplementationPlanSync(specDir));
    } catch {
      return [];
    }
  }

  private buildSessionRuntimeOptions(
    workflowMode: TaskWorkflowMode,
    projectPath: string,
    agentType: SerializableSessionConfig['agentType'],
  ): {
    maxSteps: number;
    phaseStepBudgets?: SerializableSessionConfig['phaseStepBudgets'];
    mcpOptions: NonNullable<SerializableSessionConfig['mcpOptions']>;
  } {
    const combinedEnv = this.processManager.getCombinedEnv(projectPath);
    return buildAutocodeSessionRuntimeOptions({
      workflowMode,
      agentType,
      env: combinedEnv,
    });
  }

  /**
   * Load a system prompt from the prompts directory.
   * Returns null if the prompt file is not found.
   *
   * @param promptName - The prompt filename without extension (e.g., 'planner', 'qa_reviewer')
   */
  private loadPrompt(promptName: string): string | null {
    return tryLoadPrompt(promptName);
  }

}
