/**
 * Browser mock for window.electronAPI
 * This allows the app to run in a regular browser for UI development/testing
 *
 * This module aggregates all mock implementations from separate modules
 * for better code organization and maintainability.
 */

import type { ElectronAPI } from '../../shared/types';
import {
  projectMock,
  taskMock,
  workspaceMock,
  terminalMock,
  claudeProfileMock,
  contextMock,
  integrationMock,
  changelogMock,
  insightsMock,
  infrastructureMock,
  settingsMock
} from './mocks';

/**
 * Create mock electronAPI for browser
 * Aggregates all mock implementations from separate modules
 */
const browserMockAPI: ElectronAPI = {
  // Project Operations
  ...projectMock,

  // Task Operations
  ...taskMock,

  // OpenSpec workflow
  getOpenSpecSnapshot: async (taskId: string) => ({
    taskId,
    openSpecVersion: '1.6.0' as const,
    rootKind: 'project' as const,
    rootLabel: 'Browser mock',
    initialized: false,
    changeName: null,
    schema: { name: 'spec-driven' },
    artifacts: [],
    applyRequires: [],
    activeRun: null,
    validation: null,
    nextSteps: ['Run New or Propose to initialize OpenSpec.'],
    availableActions: ['new', 'propose', 'explore', 'onboard'] as const,
    archived: false,
    revision: 1,
  }),
  selectOpenSpecChange: async (taskId: string, changeName: string) => ({
    taskId,
    openSpecVersion: '1.6.0' as const,
    rootKind: 'project' as const,
    rootLabel: 'Browser mock',
    initialized: true,
    changeName,
    schema: { name: 'spec-driven' },
    artifacts: [],
    applyRequires: [],
    activeRun: null,
    validation: null,
    nextSteps: [],
    availableActions: ['explore', 'update', 'sync', 'verify'] as const,
    archived: false,
    revision: 2,
  }),
  runOpenSpecAction: async () => ({ runId: crypto.randomUUID() }),
  confirmOpenSpecAction: async () => ({ runId: crypto.randomUUID() }),
  cancelOpenSpecAction: async () => {},
  answerOpenSpecInteraction: async () => {},
  readOpenSpecArtifact: async (input) => ({
    artifactId: input.artifactId,
    relativePath: input.relativePath ?? 'artifact.md',
    content: '# Browser mock OpenSpec artifact',
    modifiedAt: new Date().toISOString(),
  }),
  getOpenSpecArtifactDiff: async (input) => ({
    artifactId: input.artifactId,
    relativePath: input.relativePath ?? 'artifact.md',
    patch: '',
    base: 'unavailable' as const,
  }),
  validateOpenSpec: async () => ({
    valid: true,
    checkedAt: new Date().toISOString(),
    issues: [],
  }),
  listOpenSpecChanges: async () => [],
  preflightOpenSpec: async (input) => ({
    valid: true,
    openSpecVersion: '1.6.0' as const,
    rootKind: input.rootKind === 'store' ? 'store' as const : 'project' as const,
    rootLabel: input.rootKind === 'store' ? `Store: ${input.storeId}` : 'Browser mock',
    initialized: false,
    schemaName: input.schemaName ?? 'spec-driven',
    availableSchemas: [input.schemaName ?? 'spec-driven'],
    registeredStores: input.storeId ? [input.storeId] : [],
    changeExists: false,
    checks: [],
  }),
  getOpenSpecHistory: async () => ({
    runs: [],
    activeRun: null,
    waitingInteraction: null,
    activityLog: {
      segments: [],
      truncated: false,
    },
    latestRunLog: null,
    pendingPlanningReview: null,
  }),
  readOpenSpecRunLog: async (_taskId: string, runId: string) => ({
    runId,
    content: '',
    truncated: false,
  }),
  resumeOpenSpecAction: async () => ({ runId: crypto.randomUUID() }),
  getOpenSpecPlanningReview: async (input) => ({
    runId: input.runId,
    state: 'ready' as const,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    changes: [],
  }),
  acknowledgeOpenSpecPlanningReview: async () => null,
  retryOpenSpecPlanningReview: async (input) => ({
    runId: input.runId,
    state: 'ready' as const,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    changes: [],
  }),
  onOpenSpecEvent: () => () => {},

  // Workspace Management
  ...workspaceMock,

  // Terminal Operations
  ...terminalMock,

  // Claude Profile Management
  ...claudeProfileMock,

  // Settings
  ...settingsMock,

  // Roadmap Operations
  getRoadmap: async () => ({
    success: true,
    data: null
  }),

  getRoadmapStatus: async () => ({
    success: true,
    data: { isRunning: false }
  }),

  saveRoadmap: async () => ({
    success: true
  }),

  saveCompetitorAnalysis: async () => ({
    success: true
  }),

  generateRoadmap: async (_projectId: string, _enableCompetitorAnalysis?: boolean, _refreshCompetitorAnalysis?: boolean) => {
    console.warn('[Browser Mock] generateRoadmap called');
    return { success: true };
  },

  refreshRoadmap: async (_projectId: string, _enableCompetitorAnalysis?: boolean, _refreshCompetitorAnalysis?: boolean) => {
    console.warn('[Browser Mock] refreshRoadmap called');
    return { success: true };
  },

  updateFeatureStatus: async () => ({ success: true }),

  convertFeatureToSpec: async (projectId: string, _featureId: string) => ({
    success: true,
    data: {
      id: `task-${Date.now()}`,
      specId: '',
      projectId,
      title: 'Converted Feature',
      description: 'Feature converted from roadmap',
      status: 'backlog' as const,
      subtasks: [],
      logs: [],
      createdAt: new Date(),
      updatedAt: new Date()
    }
  }),

  stopRoadmap: async () => ({ success: true }),

  // Roadmap Progress Persistence
  saveRoadmapProgress: async () => ({ success: true }),
  loadRoadmapProgress: async () => ({ success: true, data: null }),
  clearRoadmapProgress: async () => ({ success: true }),

  // Roadmap Event Listeners
  onRoadmapProgress: () => () => {},
  onRoadmapComplete: () => () => {},
  onRoadmapError: () => () => {},
  onRoadmapStopped: () => () => {},
  // Context Operations
  ...contextMock,

  // Environment Configuration & Integration Operations
  ...integrationMock,

  // Changelog & Release Operations
  ...changelogMock,

  // Insights Operations
  ...insightsMock,

  // Infrastructure & Docker Operations
  ...infrastructureMock,

  // API Profile Management (custom Anthropic-compatible endpoints)
  getAPIProfiles: async () => ({
    success: true,
    data: {
      profiles: [],
      activeProfileId: null,
      version: 1
    }
  }),

  saveAPIProfile: async (profile) => ({
    success: true,
    data: {
      id: `mock-profile-${Date.now()}`,
      ...profile,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  }),

  updateAPIProfile: async (profile) => ({
    success: true,
    data: {
      ...profile,
      updatedAt: Date.now()
    }
  }),

  deleteAPIProfile: async (_profileId: string) => ({
    success: true
  }),

  setActiveAPIProfile: async (_profileId: string | null) => ({
    success: true
  }),

  testConnection: async (_baseUrl: string, _apiKey: string, _signal?: AbortSignal) => ({
    success: true,
    data: {
      success: true,
      message: 'Connection successful (mock)'
    }
  }),

  discoverModels: async (_baseUrl: string, _apiKey: string, _signal?: AbortSignal) => ({
    success: true,
    data: {
      models: []
    }
  }),

  // Provider Account management (unified multi-provider credentials)
  getProviderAccounts: async () => ({
    success: true,
    data: { accounts: [] }
  }),

  saveProviderAccount: async (account) => ({
    success: true,
    data: {
      id: `mock-account-${Date.now()}`,
      ...account,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  }),

  updateProviderAccount: async (_id, updates) => ({
    success: true,
    data: {
      id: _id,
      provider: 'anthropic' as const,
      name: 'Mock Account',
      authType: 'api-key' as const,
      billingModel: 'pay-per-use' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...updates
    }
  }),

  deleteProviderAccount: async (_id: string) => ({
    success: true
  }),

  setProviderAccountQueueOrder: async (_order: string[]) => ({
    success: true
  }),

  setCrossProviderQueueOrder: async (_order: string[]) => ({
    success: true
  }),

  saveModelOverrides: async (_overrides: Record<string, unknown>) => ({
    success: true
  }),

  testProviderConnection: async (_provider: string, _config) => ({
    success: true,
    data: { success: true }
  }),

  checkEnvCredentials: async () => ({
    success: true,
    data: {}
  }),

  // Codex OAuth authentication (mock)
  codexAuthLogin: async () => ({
    success: false,
    error: 'Codex OAuth not available in browser mock'
  }),

  codexAuthStatus: async () => ({
    success: true,
    data: { isAuthenticated: false }
  }),

  codexAuthLogout: async () => ({
    success: true
  }),

  checkCodexCliVersion: async () => ({
    success: true,
    data: {
      installed: null,
      detectionResult: {
        found: false,
        source: 'system-path' as const,
        message: 'Codex CLI not available in browser mock'
      }
    }
  }),

  // GitHub API
  github: {
    getGitHubRepositories: async () => ({ success: true, data: [] }),
    getGitHubIssues: async () => ({ success: true, data: { issues: [], hasMore: false } }),
    getGitHubIssue: async () => ({ success: true, data: null as any }),
    getIssueComments: async () => ({ success: true, data: [] }),
    checkGitHubConnection: async () => ({ success: true, data: { connected: false, repoFullName: undefined, error: undefined } }),
    investigateGitHubIssue: () => {},
    importGitHubIssues: async () => ({ success: true, data: { success: true, imported: 0, failed: 0, issues: [] } }),
    createGitHubRelease: async () => ({ success: true, data: { url: '' } }),
    suggestReleaseVersion: async () => ({ success: true, data: { suggestedVersion: '1.0.0', currentVersion: '0.0.0', bumpType: 'minor' as const, commitCount: 0, reason: 'Initial' } }),
    checkGitHubCli: async () => ({ success: true, data: { installed: false } }),
    checkGitHubAuth: async () => ({ success: true, data: { authenticated: false } }),
    startGitHubAuth: async () => ({ success: true, data: { success: false } }),
    getGitHubToken: async () => ({ success: true, data: { token: '' } }),
    getGitHubUser: async () => ({ success: true, data: { username: '' } }),
    listGitHubUserRepos: async () => ({ success: true, data: { repos: [] } }),
    detectGitHubRepo: async () => ({ success: true, data: '' }),
    getGitHubBranches: async () => ({ success: true, data: [] }),
    createGitHubRepo: async () => ({ success: true, data: { fullName: '', url: '' } }),
    addGitRemote: async () => ({ success: true, data: { remoteUrl: '' } }),
    listGitHubOrgs: async () => ({ success: true, data: { orgs: [] } }),
    onGitHubAuthDeviceCode: () => () => {},
    onGitHubAuthChanged: () => () => {},
    onGitHubInvestigationProgress: () => () => {},
    onGitHubInvestigationComplete: () => () => {},
    onGitHubInvestigationError: () => () => {},
    getAutoFixConfig: async () => null,
    saveAutoFixConfig: async () => true,
    getAutoFixQueue: async () => [],
    checkAutoFixLabels: async () => [],
    checkNewIssues: async () => [],
    startAutoFix: () => {},
    onAutoFixProgress: () => () => {},
    onAutoFixComplete: () => () => {},
    onAutoFixError: () => () => {},
    listPRs: async () => ({ prs: [], hasNextPage: false }),
    listMorePRs: async () => ({ prs: [], hasNextPage: false }),
    getPR: async () => null,
    runPRReview: () => {},
    cancelPRReview: async () => true,
    postPRReview: async () => true,
    postPRComment: async () => true,
    mergePR: async () => true,
    assignPR: async () => true,
    markReviewPosted: async () => true,
    getPRReview: async () => null,
    getPRReviewsBatch: async () => ({}),
    notifyExternalReviewComplete: async () => {},
    deletePRReview: async () => true,
    checkNewCommits: async () => ({ hasNewCommits: false, newCommitCount: 0 }),
    checkMergeReadiness: async () => ({ isDraft: false, mergeable: 'UNKNOWN' as const, isBehind: false, ciStatus: 'none' as const, blockers: [] }),
    updatePRBranch: async () => ({ success: true }),
    runFollowupReview: () => {},
    getPRLogs: async () => null,
    getWorkflowsAwaitingApproval: async () => ({ awaiting_approval: 0, workflow_runs: [], can_approve: false }),
    approveWorkflow: async () => true,
    onPRReviewProgress: () => () => {},
    onPRReviewComplete: () => () => {},
    onPRReviewError: () => () => {},
    onPRReviewStateChange: () => () => {},
    onPRLogsUpdated: () => () => {},
    batchAutoFix: () => {},
    getBatches: async () => [],
    onBatchProgress: () => () => {},
    onBatchComplete: () => () => {},
    onBatchError: () => () => {},
    // Analyze & Group Issues (proactive workflow)
    analyzeIssuesPreview: () => {},
    approveBatches: async () => ({ success: true, batches: [] }),
    onAnalyzePreviewProgress: () => () => {},
    onAnalyzePreviewComplete: () => () => {},
    onAnalyzePreviewError: () => () => {},
    // PR status polling
    startStatusPolling: async () => true,
    stopStatusPolling: async () => true,
    getPollingMetadata: async () => null,
    onPRStatusUpdate: () => () => {}
  },

  // Queue Routing API (rate limit recovery)
  queue: {
    getRunningTasksByProfile: async () => ({ success: true, data: { byProfile: {}, totalRunning: 0 } }),
    getBestProfileForTask: async () => ({ success: true, data: null }),
    getBestUnifiedAccount: async () => ({ success: true, data: null }),
    assignProfileToTask: async () => ({ success: true }),
    updateTaskSession: async () => ({ success: true }),
    getTaskSession: async () => ({ success: true, data: null }),
    onQueueProfileSwapped: () => () => {},
    onQueueSessionCaptured: () => () => {},
    onQueueBlockedNoProfiles: () => () => {}
  },

  // Claude Code Operations
  checkClaudeCodeVersion: async () => ({
    success: true,
    data: {
      installed: '1.0.0',
      latest: '1.0.0',
      isOutdated: false,
      path: '/usr/local/bin/claude',
      detectionResult: {
        found: true,
        version: '1.0.0',
        path: '/usr/local/bin/claude',
        source: 'system-path' as const,
        message: 'Claude Code CLI found'
      }
    }
  }),
  installClaudeCode: async () => ({
    success: true,
    data: { command: 'npm install -g @anthropic-ai/claude-code' }
  }),
  getClaudeCodeVersions: async () => ({
    success: true,
    data: {
      versions: ['1.0.5', '1.0.4', '1.0.3', '1.0.2', '1.0.1', '1.0.0']
    }
  }),
  installClaudeCodeVersion: async (version: string) => ({
    success: true,
    data: { command: `npm install -g @anthropic-ai/claude-code@${version}`, version }
  }),
  getClaudeCodeInstallations: async () => ({
    success: true,
    data: {
      installations: [
        {
          path: '/usr/local/bin/claude',
          version: '1.0.0',
          source: 'system-path' as const,
          isActive: true,
        }
      ],
      activePath: '/usr/local/bin/claude',
    }
  }),
  setClaudeCodeActivePath: async (cliPath: string) => ({
    success: true,
    data: { path: cliPath }
  }),

  // Needs-input decision gate
  getNeedsInputDecisions: async () => ({
    success: true,
    data: { blocked: false, message: '', questions: [], decisions: [] }
  }),
  resolveNeedsInputDecisions: async () => ({
    success: true,
    data: { written: 0 }
  }),

  // Worktree Change Detection
  checkWorktreeChanges: async () => ({
    success: true,
    data: { hasChanges: false, changedFileCount: 0 }
  }),

  // Git Changes
  getWorktreeChangedFiles: async () => ({
    success: true,
    data: []
  }),

  getWorktreeCommits: async () => ({
    success: true,
    data: []
  }),

  getWorktreeFileDiff: async () => ({
    success: true,
    data: ''
  }),

  getWorkPackageFileDiff: async () => ({
    success: true,
    data: {
      patch: '',
      changedFiles: [],
      unavailableReason: 'history_unavailable' as const
    }
  }),

  getWorktreeCommitFiles: async () => ({
    success: true,
    data: []
  }),

  getWorktreeCommitFileDiff: async () => ({
    success: true,
    data: ''
  }),

  // Terminal Worktree Operations
  createTerminalWorktree: async () => ({
    success: false,
    error: 'Not available in browser mode'
  }),
  listTerminalWorktrees: async () => ({
    success: true,
    data: []
  }),
  removeTerminalWorktree: async () => ({
    success: false,
    error: 'Not available in browser mode'
  }),
  listOtherWorktrees: async () => ({
    success: true,
    data: []
  }),

  // MCP Server Health Check Operations
  checkMcpHealth: async (server) => ({
    success: true,
    data: {
      serverId: server.id,
      status: 'unknown' as const,
      message: 'Health check not available in browser mode',
      checkedAt: new Date().toISOString()
    }
  }),
  testMcpConnection: async (server) => ({
    success: true,
    data: {
      serverId: server.id,
      success: false,
      message: 'Connection test not available in browser mode'
    }
  }),

  // Screenshot capture operations
  getSources: async () => ({
    success: true,
    data: []
  }),
  capture: async (_options: { sourceId: string }) => ({
    success: false,
    error: 'Screenshot capture not available in browser mode'
  }),

  // Debug Operations
  getDebugInfo: async () => ({
    systemInfo: {
      appVersion: '0.0.0-browser-mock',
      platform: 'browser',
      isPackaged: 'false'
    },
    recentErrors: [],
    logsPath: '/mock/logs',
    debugReport: '[Browser Mock] Debug report not available in browser mode'
  }),
  openLogsFolder: async () => ({ success: false, error: 'Not available in browser mode' }),
  copyDebugInfo: async () => ({ success: false, error: 'Not available in browser mode' }),
  getRecentErrors: async () => [],
  listLogFiles: async () => [],

  // Workflow Optimization API (mock)
  getWorkflowMetrics: async () => null,
  clearWorkflowMetrics: async () => {},
  getRecentRecords: async () => [],
  compareOptimizationLevels: async () => null,
};

/**
 * Initialize browser mock if not running in Electron
 */
export function initBrowserMock(): void {
  // Check at runtime, not at module load time
  const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

  if (!isElectron) {
    console.warn('%c[Browser Mock] Initializing mock electronAPI for browser preview', 'color: #f0ad4e; font-weight: bold;');
    (window as Window & { electronAPI: ElectronAPI }).electronAPI = browserMockAPI;
  }
}

// Auto-initialize
initBrowserMock();
