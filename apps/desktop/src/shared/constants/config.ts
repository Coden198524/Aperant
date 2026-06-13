/**
 * Application configuration constants
 * Default settings, file paths, and project structure
 */

import {
  AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME,
  AUTOCODE_PROJECT_DATA_DIR_NAME,
  AUTOCODE_TASK_ARTIFACTS,
  getAutocodeSpecsRelativeDir,
  normalizeAutocodeProjectDataDirName,
} from '@autocode/core/tasks/artifacts';
import {
  AUTOCODE_COMPETITOR_ANALYSIS_FILE_NAME,
  AUTOCODE_GENERATION_PROGRESS_FILE_NAME,
  AUTOCODE_IDEATION_CONTEXT_FILE_NAME,
  AUTOCODE_IDEATION_FILE_NAME,
  AUTOCODE_MANUAL_COMPETITORS_FILE_NAME,
  AUTOCODE_ROADMAP_DISCOVERY_FILE_NAME,
  AUTOCODE_ROADMAP_FILE_NAME,
  getAutocodeIdeationRelativeDir,
  getAutocodeProjectEnvRelativePath,
  getAutocodeRoadmapRelativeDir,
} from '@autocode/core/project/data-paths';

// ============================================
// Terminal Timing Constants
// ============================================

/** Delay for DOM updates before terminal operations (refit, resize).
 * Must be long enough for dnd-kit CSS transitions to complete after drag-drop reorder.
 * 50ms was too short, causing xterm to fit into containers with zero/invalid dimensions. */
export const TERMINAL_DOM_UPDATE_DELAY_MS = 250;

/** Grace period before cleaning up error panel constraints after panel removal */
export const PANEL_CLEANUP_GRACE_PERIOD_MS = 150;

// ============================================
// UI Scale Constants
// ============================================

export const UI_SCALE_MIN = 75;
export const UI_SCALE_MAX = 200;
export const UI_SCALE_DEFAULT = 100;
export const UI_SCALE_STEP = 5;

// ============================================
// Default App Settings
// ============================================

export const DEFAULT_APP_SETTINGS = {
  theme: 'dark' as const,
  colorTheme: 'default' as const,
  defaultModel: 'opus',
  agentFramework: 'autocode',
  pythonPath: undefined as string | undefined,
  gitPath: undefined as string | undefined,
  githubCLIPath: undefined as string | undefined,
  gitlabCLIPath: undefined as string | undefined,
  autoBuildPath: undefined as string | undefined,
  autoUpdateAutoBuild: true,
  autoNameTerminals: true,
  onboardingCompleted: false,
  notifications: {
    onTaskComplete: true,
    onTaskFailed: true,
    onReviewNeeded: true,
    sound: false
  },
  // Global API keys (used as defaults for all projects)
  globalOpenAIApiKey: undefined as string | undefined,
  // Selected agent profile - defaults to 'auto' for per-phase optimized model selection
  selectedAgentProfile: 'auto',
  // Changelog preferences (persisted between sessions)
  changelogFormat: 'keep-a-changelog' as const,
  changelogAudience: 'user-facing' as const,
  changelogEmojiLevel: 'none' as const,
  // UI Scale (default 100% - standard size)
  uiScale: UI_SCALE_DEFAULT,
  // Log order setting for task detail view (default chronological - oldest first)
  logOrder: 'chronological' as const,
  // Beta updates opt-in (receive pre-release versions)
  betaUpdates: false,
  // Language preference (default to English)
  language: 'en' as const,
  // Legacy setting kept for compatibility. Remote error reporting is disabled.
  sentryEnabled: false,
  // Auto-name Claude terminals based on initial message (enabled by default)
  autoNameClaudeTerminals: true,
  // GPU acceleration for terminal rendering
  // Default to 'off' until WebGL stability is proven across all GPU drivers.
  // Users can opt-in via Settings > Display > GPU Acceleration.
  gpuAcceleration: 'off' as const
};

// ============================================
// Default Project Settings
// ============================================

export const DEFAULT_PROJECT_SETTINGS = {
  model: 'opus',
  projectType: 'general' as const,
  preferredCLI: undefined as import('../types/settings').SupportedCLI | undefined,
  memoryBackend: 'file' as const,
  linearSync: false,
  notifications: {
    onTaskComplete: true,
    onTaskFailed: true,
    onReviewNeeded: true,
    sound: false
  },
  // Include CLAUDE.md instructions in agent context (enabled by default)
  useClaudeMd: true,
  // Keep newly created task/worktree branches local unless explicitly enabled.
  pushNewBranches: false
};

// ============================================
// Auto Build File Paths
// ============================================

export const PROJECT_DATA_DIR_NAME = AUTOCODE_PROJECT_DATA_DIR_NAME;
export const LEGACY_PROJECT_DATA_DIR_NAME = AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME;

export function normalizeProjectDataDirName(autoBuildPath: string | undefined): string {
  return normalizeAutocodeProjectDataDirName(autoBuildPath);
}

// File paths relative to project
// IMPORTANT: All paths use .autocode/ (the installed instance), NOT autocode/ (source code)
export const AUTO_BUILD_PATHS = {
  SPECS_DIR: getAutocodeSpecsRelativeDir(PROJECT_DATA_DIR_NAME),
  ROADMAP_DIR: getAutocodeRoadmapRelativeDir(PROJECT_DATA_DIR_NAME),
  IDEATION_DIR: getAutocodeIdeationRelativeDir(PROJECT_DATA_DIR_NAME),
  IMPLEMENTATION_PLAN: AUTOCODE_TASK_ARTIFACTS.implementationPlan,
  SPEC_FILE: AUTOCODE_TASK_ARTIFACTS.specFile,
  QA_REPORT: AUTOCODE_TASK_ARTIFACTS.qaReport,
  BUILD_PROGRESS: 'build-progress.txt',
  GENERATION_PROGRESS: AUTOCODE_GENERATION_PROGRESS_FILE_NAME,
  CONTEXT: 'context.json',
  REQUIREMENTS: AUTOCODE_TASK_ARTIFACTS.requirements,
  TASK_METADATA: AUTOCODE_TASK_ARTIFACTS.taskMetadata,
  TASK_LOGS: AUTOCODE_TASK_ARTIFACTS.taskLogs,
  DIRECT_SUMMARY: AUTOCODE_TASK_ARTIFACTS.directSummary,
  RUN_RESULT: AUTOCODE_TASK_ARTIFACTS.runResult,
  ROADMAP_FILE: AUTOCODE_ROADMAP_FILE_NAME,
  ROADMAP_DISCOVERY: AUTOCODE_ROADMAP_DISCOVERY_FILE_NAME,
  COMPETITOR_ANALYSIS: AUTOCODE_COMPETITOR_ANALYSIS_FILE_NAME,
  MANUAL_COMPETITORS: AUTOCODE_MANUAL_COMPETITORS_FILE_NAME,
  IDEATION_FILE: AUTOCODE_IDEATION_FILE_NAME,
  IDEATION_CONTEXT: AUTOCODE_IDEATION_CONTEXT_FILE_NAME,
  PROJECT_ENV: getAutocodeProjectEnvRelativePath(PROJECT_DATA_DIR_NAME),
  MEMORY_STATE: '.memory_state.json'
} as const;

/**
 * Get the specs directory path.
 * All specs go to .autocode/specs/ (the project's data directory).
 */
export function getSpecsDir(autoBuildPath: string | undefined): string {
  return getAutocodeSpecsRelativeDir(autoBuildPath);
}
