/**
 * Prompt Loader
 * =============
 *
 * Loads .md prompt files from the bundled prompts directory and performs
 * dynamic context injection. Mirrors apps/desktop/prompts_pkg/prompts.py.
 *
 * Path resolution:
 * - Dev:        apps/desktop/prompts/ (relative to project root via __dirname traversal)
 * - Production: process.resourcesPath/prompts/ (bundled into Electron resources)
 */

import { readFileSync, existsSync, readFile as readFileAsync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  AUTOCODE_COMMON_BASE_BRANCHES,
  AUTOCODE_DEFAULT_BASE_BRANCH,
  AUTOCODE_TASK_ARTIFACTS,
  detectAutocodeProjectCapabilities,
  getAutocodeProjectIndexPath,
  injectAutocodePromptContext,
  isAutocodeGitBranchName,
  normalizeAutocodeBaseBranch,
} from '@autocode/core';

import type { ProjectCapabilities, PromptContext, PromptValidationResult } from './types';

// =============================================================================
// Expected prompt files (used for startup validation)
// =============================================================================

const EXPECTED_PROMPT_FILES = [
  'planner.md',
  'coder.md',
  'coder_recovery.md',
  'followup_planner.md',
  'qa_reviewer.md',
  'qa_fixer.md',
  'spec_discovery.md',
  'spec_context.md',
  'spec_gatherer.md',
  'spec_researcher.md',
  'spec_writer.md',
  'spec_critic.md',
  'complexity_assessor.md',
  'validation_fixer.md',
  'mmo_spec_orchestrator.md',
  'mmo_build_orchestrator.md',
  'mmo_system_designer.md',
  'mmo_engine_architect.md',
  'mmo_engine_programmer.md',
  'mmo_rendering_engineer.md',
  'mmo_animation_engineer.md',
  'mmo_asset_pipeline_engineer.md',
  'mmo_world_streaming_engineer.md',
  'mmo_tools_engineer.md',
  'mmo_build_release_engineer.md',
  'mmo_engine_performance_engineer.md',
  'mmo_server_authority_engineer.md',
  'mmo_network_sync_engineer.md',
  'mmo_client_gameplay_engineer.md',
  'mmo_data_persistence_engineer.md',
  'mmo_security_anticheat_engineer.md',
  'mmo_liveops_engineer.md',
  'mmo_qa_reviewer.md',
  'mmo_qa_fixer.md',
] as const;

// =============================================================================
// Path Resolution
// =============================================================================

let _resolvedPromptsDir: string | null = null;

/**
 * Resolve the prompts directory path.
 *
 * In production (app.isPackaged), prompts are bundled into process.resourcesPath.
 * In dev, they live in apps/desktop/prompts/ relative to the frontend root.
 *
 * The worker thread's __dirname is in out/main/ (or src/main/ in dev),
 * so we traverse upward to find the frontend root.
 */
export function resolvePromptsDir(): string {
  if (_resolvedPromptsDir) return _resolvedPromptsDir;

  // Production: Electron bundles prompts into resources
  // Skip this check in worker threads (process.resourcesPath is still available)
  try {
    // Check if we're in a packaged Electron app by testing process.resourcesPath
    // This works in both main thread and worker threads
    if (process.resourcesPath && existsSync(join(process.resourcesPath, 'prompts', 'planner.md'))) {
      const prodPath = join(process.resourcesPath, 'prompts');
      _resolvedPromptsDir = prodPath;
      return prodPath;
    }
  } catch {
    // Not in Electron environment or prompts not found in resources
  }

  // Dev: traverse from __dirname up to find apps/desktop/prompts/
  const candidateBases = [
    // Worker thread: __dirname = out/main/ai/agent/ 鈫?traverse up to frontend root
    join(__dirname, '..', '..', '..', '..', 'prompts'),
    // Worker thread in dev: __dirname = src/main/ai/agent/
    join(__dirname, '..', '..', '..', 'prompts'),
    // Direct: 2 levels up from src/main/ai/prompts/
    join(__dirname, '..', '..', 'prompts'),
    // From out/main/ 鈫?../../prompts
    join(__dirname, '..', 'prompts'),
    // Local prompts dir
    join(__dirname, 'prompts'),
    // Repo root traversal: up to repo root, then apps/desktop/prompts/
    join(__dirname, '..', '..', '..', '..', '..', 'apps', 'desktop', 'prompts'),
    join(__dirname, '..', '..', '..', '..', 'apps', 'desktop', 'prompts'),
  ];

  for (const candidate of candidateBases) {
    if (existsSync(join(candidate, 'planner.md'))) {
      _resolvedPromptsDir = candidate;
      return candidate;
    }
  }

  // Fallback to first candidate even if not found 鈥?errors will surface on use
  const fallback = candidateBases[0];
  _resolvedPromptsDir = fallback;
  return fallback;
}

// =============================================================================
// Core Loader
// =============================================================================

/**
 * Load a prompt .md file from the bundled prompts directory.
 *
 * @param promptName - Relative path without extension (e.g., "planner", "mcp_tools/electron_validation")
 * @returns Prompt file content
 * @throws Error if the file does not exist
 */
export function loadPrompt(promptName: string): string {
  const promptsDir = resolvePromptsDir();
  const promptPath = join(promptsDir, `${promptName}.md`);

  if (!existsSync(promptPath)) {
    throw new Error(
      `Prompt file not found: ${promptPath}\n` +
      `Prompts directory resolved to: ${promptsDir}\n` +
      `Make sure apps/desktop/prompts/${promptName}.md exists.`
    );
  }

  return expandPromptPartials(readFileSync(promptPath, 'utf-8'), promptsDir);
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

function formatPathForPrompt(filePath: string | undefined): string | undefined {
  return filePath?.replace(/\\/g, '/');
}

/**
 * Load a prompt file, returning null if it doesn't exist.
 */
export function tryLoadPrompt(promptName: string): string | null {
  try {
    return loadPrompt(promptName);
  } catch {
    return null;
  }
}

// =============================================================================
// Project Instructions Loading
// =============================================================================

/**
 * Try to read a file asynchronously, returning trimmed content or null.
 */
async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    const content = await new Promise<string>((resolve, reject) => {
      readFileAsync(filePath, 'utf-8', (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
    return content.trim() || null;
  } catch {
    return null;
  }
}

/** Result of loading project instructions, includes the source filename */
export interface ProjectInstructionsResult {
  content: string;
  /** Which file was loaded (e.g., "AGENTS.md", "CLAUDE.md") */
  source: string;
}

/**
 * Load project instructions from AGENTS.md (preferred) or CLAUDE.md (fallback).
 *
 * AGENTS.md is the canonical provider-agnostic instruction file.
 * CLAUDE.md is supported for backward compatibility.
 * Only one file is loaded 鈥?AGENTS.md takes priority if it exists.
 * Both upper and lower case variants are tried.
 *
 * @param projectDir - Project root directory
 * @returns Content of the first found instruction file, or null
 */
export async function loadProjectInstructions(projectDir: string): Promise<ProjectInstructionsResult | null> {
  const candidates = ['AGENTS.md', 'agents.md', 'CLAUDE.md', 'claude.md'];
  for (const name of candidates) {
    const content = await tryReadFile(join(projectDir, name));
    if (content) return { content, source: name };
  }
  return null;
}

/** @deprecated Use loadProjectInstructions() instead */
export async function loadClaudeMd(projectDir: string): Promise<string | null> {
  return tryReadFile(join(projectDir, 'CLAUDE.md'));
}

/** @deprecated Use loadProjectInstructions() instead */
export async function loadAgentsMd(projectDir: string): Promise<string | null> {
  return tryReadFile(join(projectDir, 'agents.md'));
}

// =============================================================================
// Context Injection
// =============================================================================

/**
 * Inject dynamic sections into a prompt template.
 *
 * Handles:
 * - SPEC LOCATION header with file paths
 * - CLAUDE.md injection if provided
 * - Human input injection
 * - Recovery context injection
 *
 * @param promptTemplate - Base prompt content from .md file
 * @param context - Dynamic context to inject
 * @returns Assembled prompt with all context prepended
 */
export function injectContext(promptTemplate: string, context: PromptContext): string {
  return injectAutocodePromptContext(promptTemplate, context, {
    domain: process.env.AUTOCODE_AGENT_DOMAIN ?? 'general',
  });
}

/**
 * Build optional domain guidance header.
 *
 * Defaults to general software-development guidance. Can be disabled by setting
 * AUTOCODE_AGENT_DOMAIN to "none".
 */
function buildDomainGuidanceHeader(): string {
  const domain = (process.env.AUTOCODE_AGENT_DOMAIN ?? 'general').trim().toLowerCase();
  if (!domain || domain === 'none') return '';

  return (
    `## DOMAIN FOCUS: GENERAL SOFTWARE DEVELOPMENT\n\n` +
    `Treat this as a general software-development project unless the task, project instructions, or project profile indicate a more specific domain.\n\n` +
    `Prioritize:\n` +
    `- Correctness against requirements and acceptance criteria\n` +
    `- Fit with existing architecture, module boundaries, and local conventions\n` +
    `- Security, privacy, permissions, and data integrity where relevant\n` +
    `- Maintainability, readability, and minimizing unnecessary churn\n` +
    `- Performance and resource usage appropriate to the affected paths\n` +
    `- Reliability, error handling, observability, and safe rollback for production changes\n` +
    `- Accessibility and usability for user-facing UI changes\n` +
    `- Compatibility with supported runtimes, platforms, browsers, and dependency versions\n\n` +
    `When proposing plans or verification, include concrete project-specific checks such as targeted tests, typecheck, lint, build, smoke tests, or manual verification.\n\n` +
    `---\n\n`
  );
}

/**
 * Build Git push policy header based on branch detection.
 *
 * @param autoPushToRemote - Whether to allow automatic push to remote
 * @returns Git push policy instruction
 */
function buildGitPushPolicyHeader(autoPushToRemote: boolean): string {
  if (autoPushToRemote) {
    return (
      `## GIT PUSH POLICY\n\n` +
      `After committing changes, run \`git push\` to push your commits to the remote repository.\n\n` +
      `---\n\n`
    );
  } else {
    return (
      `## GIT PUSH POLICY\n\n` +
      `Keep work local; do not run \`git push\` until the user reviews and approves.\n` +
      `The user will push to remote after reviewing your changes.\n\n` +
      `---\n\n`
    );
  }
}

/**
 * Build the SPEC LOCATION header section.
 */
function buildSpecLocationHeader(context: PromptContext): string {
  if (!context.specDir) return '';

  const specDir = formatPathForPrompt(context.specDir);
  const projectDir = formatPathForPrompt(context.projectDir);

  return (
    `## SPEC LOCATION\n\n` +
    `Your spec and progress files are located at:\n` +
    `- Spec: \`${specDir}/spec.md\`\n` +
    `- Implementation plan: \`${specDir}/implementation_plan.md\`\n` +
    `- Progress notes: \`${specDir}/build-progress.txt\`\n` +
    `- QA report output: \`${specDir}/qa_report.md\`\n` +
    `- Fix request output: \`${specDir}/QA_FIX_REQUEST.md\`\n\n` +
    `The project root is: \`${projectDir}\`\n\n` +
    `---\n\n`
  );
}

// =============================================================================
// QA Tools Section
// =============================================================================

/**
 * Generate the QA tools section based on project capabilities.
 * Mirrors get_mcp_tools_for_project() + tool injection in Python.
 *
 * @param capabilities - Detected project capabilities
 * @returns Assembled MCP tools documentation string, or empty string
 */
export function getQaToolsSection(capabilities: ProjectCapabilities): string {
  const toolFiles = getMcpToolFilesForCapabilities(capabilities);
  if (toolFiles.length === 0) return '';

  const sections: string[] = [
    '## PROJECT-SPECIFIC VALIDATION TOOLS\n\n' +
    'The following validation tools are available based on your project type:\n\n'
  ];

  for (const toolFile of toolFiles) {
    const content = tryLoadPrompt(toolFile.replace(/\.md$/, ''));
    if (content) {
      sections.push(content);
    }
  }

  if (sections.length <= 1) return '';

  return sections.join('\n\n---\n\n') + '\n\n---\n';
}

/**
 * Get MCP tool documentation file names for the given capabilities.
 * Mirrors get_mcp_tools_for_project() from Python.
 */
function getMcpToolFilesForCapabilities(capabilities: ProjectCapabilities): string[] {
  const tools: string[] = [];

  if (capabilities.is_electron) {
    tools.push('mcp_tools/electron_validation.md');
  }
  if (capabilities.is_tauri) {
    tools.push('mcp_tools/tauri_validation.md');
  }
  if (capabilities.is_web_frontend && !capabilities.is_electron) {
    tools.push('mcp_tools/puppeteer_browser.md');
  }
  if (capabilities.has_database) {
    tools.push('mcp_tools/database_validation.md');
  }
  if (capabilities.has_api) {
    tools.push('mcp_tools/api_validation.md');
  }

  return tools;
}

// =============================================================================
// Base Branch Detection
// =============================================================================

/**
 * Detect the base branch for a project.
 *
 * Priority:
 * 1. task_metadata.json baseBranch field
 * 2. DEFAULT_BRANCH environment variable
 * 3. Auto-detect: main / master / develop
 * 4. Fall back to "main"
 */
export function detectBaseBranch(specDir: string, projectDir: string): string {
  // 1. Check task_metadata.json
  const metadataPath = join(specDir, AUTOCODE_TASK_ARTIFACTS.taskMetadata);
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as { baseBranch?: string };
      const branch = normalizeAutocodeBaseBranch(metadata.baseBranch);
      if (isAutocodeGitBranchName(branch)) return branch;
    } catch {
      // Continue
    }
  }

  // 2. Check DEFAULT_BRANCH env var
  const envBranch = normalizeAutocodeBaseBranch(process.env.DEFAULT_BRANCH);
  if (isAutocodeGitBranchName(envBranch)) {
    try {
      execSync(`git rev-parse --verify ${envBranch}`, {
        cwd: projectDir,
        stdio: 'pipe',
        timeout: 3000,
      });
      return envBranch;
    } catch {
      // Branch doesn't exist
    }
  }

  // 3. Auto-detect
  for (const branch of AUTOCODE_COMMON_BASE_BRANCHES) {
    try {
      execSync(`git rev-parse --verify ${branch}`, {
        cwd: projectDir,
        stdio: 'pipe',
        timeout: 3000,
      });
      return branch;
    } catch {
      // Try next
    }
  }

  // 4. Fallback
  return AUTOCODE_DEFAULT_BASE_BRANCH;
}

// =============================================================================
// Project Capabilities Detection
// =============================================================================

/**
 * Load project_index.json from the project's data directory.
 */
export function loadProjectIndex(projectDir: string, dataDirName?: string): Record<string, unknown> {
  const indexPath = getAutocodeProjectIndexPath(projectDir, dataDirName);
  if (!existsSync(indexPath)) return {};
  try {
    return JSON.parse(readFileSync(indexPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Detect project capabilities from project_index.json.
 * Mirrors detect_project_capabilities() from Python.
 */
export function detectProjectCapabilities(projectIndex: Record<string, unknown>): ProjectCapabilities {
  return detectAutocodeProjectCapabilities(projectIndex);
}

// =============================================================================
// Startup Validation
// =============================================================================

/**
 * Validate that all expected prompt files exist at startup.
 *
 * @returns Validation result with missing files and resolved directory
 */
export function validatePromptFiles(): PromptValidationResult {
  const promptsDir = resolvePromptsDir();
  const missingFiles: string[] = [];

  for (const filename of EXPECTED_PROMPT_FILES) {
    const fullPath = join(promptsDir, filename);
    if (!existsSync(fullPath)) {
      missingFiles.push(filename);
    }
  }

  return {
    valid: missingFiles.length === 0,
    missingFiles,
    promptsDir,
  };
}
