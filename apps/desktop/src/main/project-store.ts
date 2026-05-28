import { isMainThread } from 'worker_threads';
import electron from 'electron';

// Only expose Electron app where ProjectStore is expected to run.
let app: Electron.App | undefined;
const isProjectStoreRuntime = isMainThread || process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
if (isProjectStoreRuntime) {
  app = electron.app;
}
import { readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  AUTOCODE_PROJECT_DATA_DIR_NAME,
  getAutocodeRoadmapFilePath,
  loadAutocodeProjectTasks,
  type AutocodeProjectTask,
} from '@autocode/core';
import type { Project, ProjectSettings, Task, TaskMetadata, KanbanPreferences } from '../shared/types';
import { DEFAULT_PROJECT_SETTINGS, getSpecsDir } from '../shared/constants';
import { getAutoBuildPath, isInitialized } from './project-initializer';
import { getTaskWorktreeDir } from './worktree-paths';
import { findAllSpecPaths } from './utils/spec-path-helpers';
import { ensureAbsolutePath } from './utils/path-helpers';
import { writeFileAtomicSync } from './utils/atomic-file';
import { updateRoadmapFeatureOutcome, revertRoadmapFeatureOutcome } from './utils/roadmap-utils';

interface TabState {
  openProjectIds: string[];
  activeProjectId: string | null;
  tabOrder: string[];
}

interface StoreData {
  projects: Project[];
  settings: Record<string, unknown>;
  tabState?: TabState;
  kanbanPreferences?: Record<string, KanbanPreferences>;
}

interface TasksCacheEntry {
  tasks: Task[];
  timestamp: number;
}

function toDesktopTask(task: AutocodeProjectTask, projectId: string): Task {
  return {
    id: task.id,
    specId: task.specId,
    projectId,
    title: task.title,
    description: task.description,
    status: task.status as Task['status'],
    subtasks: task.subtasks as Task['subtasks'],
    logs: task.logs,
    ...(task.metadata ? { metadata: task.metadata as TaskMetadata } : {}),
    ...(task.reviewReason ? { reviewReason: task.reviewReason as Task['reviewReason'] } : {}),
    ...(task.executionProgress ? { executionProgress: task.executionProgress as Task['executionProgress'] } : {}),
    ...(task.tokenUsage ? { tokenUsage: task.tokenUsage as Task['tokenUsage'] } : {}),
    ...(task.stagedInMainProject !== undefined ? { stagedInMainProject: task.stagedInMainProject } : {}),
    ...(task.stagedAt ? { stagedAt: task.stagedAt } : {}),
    ...(task.location ? { location: task.location } : {}),
    specsPath: task.specsPath,
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
  };
}

/**
 * Persistent storage for projects and settings
 */
export class ProjectStore {
  private storePath: string;
  private data: StoreData;
  private tasksCache: Map<string, TasksCacheEntry> = new Map();
  private readonly CACHE_TTL_MS = 3000; // 3 seconds TTL for task cache

  constructor() {
    if (!app) {
      throw new Error('ProjectStore can only be instantiated in main thread');
    }
    // Store in app's userData directory
    const userDataPath = app.getPath('userData');
    const storeDir = path.join(userDataPath, 'store');

    // Ensure directory exists
    if (!existsSync(storeDir)) {
      mkdirSync(storeDir, { recursive: true });
    }

    this.storePath = path.join(storeDir, 'projects.json');
    this.data = this.load();
  }

  /**
   * Load store from disk
   */
  private load(): StoreData {
    if (existsSync(this.storePath)) {
      try {
        const content = readFileSync(this.storePath, 'utf-8');
        const data = JSON.parse(content);
        // Convert date strings back to Date objects and normalize paths to absolute
        data.projects = data.projects.map((p: Project) => {
          const absolutePath = ensureAbsolutePath(p.path);
          const detectedAutoBuildPath = getAutoBuildPath(absolutePath);
          return {
            ...p,
            // Ensure project.path is always absolute (critical for dev mode path resolution)
            path: absolutePath,
            autoBuildPath: detectedAutoBuildPath ?? p.autoBuildPath,
            createdAt: new Date(p.createdAt),
            updatedAt: new Date(p.updatedAt)
          };
        });
        return data;
      } catch {
        return { projects: [], settings: {} };
      }
    }
    return { projects: [], settings: {} };
  }

  /**
   * Save store to disk
   */
  private save(): void {
    writeFileAtomicSync(this.storePath, JSON.stringify(this.data, null, 2));
  }

  /**
   * Add a new project
   */
  addProject(projectPath: string, name?: string): Project {
    // CRITICAL: Normalize to absolute path for dev mode compatibility
    // This prevents path resolution issues after app restart
    const absolutePath = ensureAbsolutePath(projectPath);

    // Check if project already exists (using absolute path for comparison)
    const existing = this.data.projects.find((p) => p.path === absolutePath);
    if (existing) {
      // Validate that .autocode folder still exists for existing project
      // If manually deleted, reset autoBuildPath so UI prompts for reinitialization
      if (existing.autoBuildPath && !isInitialized(existing.path)) {
        console.warn(`[ProjectStore] ${AUTOCODE_PROJECT_DATA_DIR_NAME} folder was deleted for project "${existing.name}" - resetting autoBuildPath`);
        existing.autoBuildPath = '';
        existing.updatedAt = new Date();
        this.save();
      }
      return existing;
    }

    // Derive name from path if not provided
    const projectName = name || path.basename(absolutePath);

    // Determine the configured Autocode project data path.
    const autoBuildPath = getAutoBuildPath(absolutePath) || '';

    const project: Project = {
      id: uuidv4(),
      name: projectName,
      path: absolutePath, // Store absolute path
      autoBuildPath,
      settings: { ...DEFAULT_PROJECT_SETTINGS },
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.data.projects.push(project);
    this.save();

    return project;
  }

  /**
   * Update project's autoBuildPath after initialization
   */
  updateAutoBuildPath(projectId: string, autoBuildPath: string): Project | undefined {
    const project = this.data.projects.find((p) => p.id === projectId);
    if (project) {
      project.autoBuildPath = autoBuildPath;
      project.updatedAt = new Date();
      this.save();
    }
    return project;
  }

  /**
   * Remove a project
   */
  removeProject(projectId: string): boolean {
    const index = this.data.projects.findIndex((p) => p.id === projectId);
    if (index !== -1) {
      this.data.projects.splice(index, 1);
      // Clean up kanban preferences to avoid orphaned data
      if (this.data.kanbanPreferences?.[projectId]) {
        delete this.data.kanbanPreferences[projectId];
      }
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Get all projects
   */
  getProjects(): Project[] {
    return this.data.projects;
  }

  /**
   * Get tab state
   */
  getTabState(): TabState {
    return this.data.tabState || {
      openProjectIds: [],
      activeProjectId: null,
      tabOrder: []
    };
  }

  /**
   * Save tab state
   */
  saveTabState(tabState: TabState): void {
    // Filter out any project IDs that no longer exist
    const validProjectIds = this.data.projects.map(p => p.id);
    this.data.tabState = {
      openProjectIds: tabState.openProjectIds.filter(id => validProjectIds.includes(id)),
      activeProjectId: tabState.activeProjectId && validProjectIds.includes(tabState.activeProjectId)
        ? tabState.activeProjectId
        : null,
      tabOrder: tabState.tabOrder.filter(id => validProjectIds.includes(id))
    };
    this.save();
  }

  /**
   * Get kanban column preferences for a specific project
   */
  getKanbanPreferences(projectId: string): KanbanPreferences | null {
    return this.data.kanbanPreferences?.[projectId] ?? null;
  }

  /**
   * Save kanban column preferences for a specific project
   */
  saveKanbanPreferences(projectId: string, preferences: KanbanPreferences): void {
    if (!this.data.kanbanPreferences) {
      this.data.kanbanPreferences = {};
    }
    this.data.kanbanPreferences[projectId] = preferences;
    this.save();
  }

  /**
   * Validate all projects to ensure their .autocode folders still exist.
   * If a project has autoBuildPath set but the folder was deleted,
   * reset autoBuildPath to empty string so the UI prompts for reinitialization.
   *
   * @returns Array of project IDs that were reset due to missing .autocode folder
   */
  validateProjects(): string[] {
    const resetProjectIds: string[] = [];
    let hasChanges = false;

    for (const project of this.data.projects) {
      // Skip projects that aren't initialized (autoBuildPath is empty)
      if (!project.autoBuildPath) {
        continue;
      }

      // Check if the project path still exists
      if (!existsSync(project.path)) {
        console.warn(`[ProjectStore] Project path no longer exists: ${project.path}`);
        continue; // Don't reset - let user handle this case
      }

      // Check if .autocode folder still exists
      if (!isInitialized(project.path)) {
        console.warn(`[ProjectStore] ${AUTOCODE_PROJECT_DATA_DIR_NAME} folder missing for project "${project.name}" at ${project.path}`);
        project.autoBuildPath = '';
        project.updatedAt = new Date();
        resetProjectIds.push(project.id);
        hasChanges = true;
      }
    }

    if (hasChanges) {
      this.save();
      console.warn(`[ProjectStore] Reset ${resetProjectIds.length} project(s) due to missing ${AUTOCODE_PROJECT_DATA_DIR_NAME} folder`);
    }

    return resetProjectIds;
  }

  /**
   * Get a project by ID
   */
  getProject(projectId: string): Project | undefined {
    return this.data.projects.find((p) => p.id === projectId);
  }

  /**
   * Update project settings
   */
  updateProjectSettings(
    projectId: string,
    settings: Partial<ProjectSettings>
  ): Project | undefined {
    const project = this.data.projects.find((p) => p.id === projectId);
    if (project) {
      project.settings = { ...project.settings, ...settings };
      project.updatedAt = new Date();
      this.save();
    }
    return project;
  }

  /**
   * Get tasks for a project by scanning specs directory
   * Implements caching with 3-second TTL to prevent excessive worktree scanning
   */
  getTasks(projectId: string): Task[] {
    // Check cache first
    const cached = this.tasksCache.get(projectId);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL_MS) {
      return cached.tasks;
    }

    const project = this.getProject(projectId);
    if (!project) {
      return [];
    }

    const tasks = loadAutocodeProjectTasks({
      projectRoot: project.path,
      dataDirName: project.autoBuildPath || AUTOCODE_PROJECT_DATA_DIR_NAME,
      projectId,
      worktreesDir: getTaskWorktreeDir(project.path),
    }).map((task) => toDesktopTask(task, projectId));

    // Update cache
    this.tasksCache.set(projectId, { tasks, timestamp: now });

    return tasks;
  }

  /**
   * Invalidate the tasks cache for a specific project
   * Call this when tasks are modified (created, deleted, status changed, etc.)
   */
  invalidateTasksCache(projectId: string): void {
    this.tasksCache.delete(projectId);
  }

  /**
   * Clear all tasks cache entries
   * Useful for global refresh scenarios
   */
  clearTasksCache(): void {
    this.tasksCache.clear();
  }

  /**
   * Archive tasks by writing archivedAt to their metadata
   * @param projectId - Project ID
   * @param taskIds - IDs of tasks to archive
   * @param version - Version they were archived in (optional)
   */
  archiveTasks(projectId: string, taskIds: string[], version?: string): boolean {
    const project = this.getProject(projectId);
    if (!project) {
      console.error('[ProjectStore] archiveTasks: Project not found:', projectId);
      return false;
    }

    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const archivedAt = new Date().toISOString();
    let hasErrors = false;

    for (const taskId of taskIds) {
      // Find ALL locations where this task exists (main + worktrees)
      const specPaths = findAllSpecPaths(project.path, specsBaseDir, taskId);

      // If spec directory doesn't exist anywhere, skip gracefully
      if (specPaths.length === 0) {
        continue;
      }

      // Archive in ALL locations
      for (const specPath of specPaths) {
        try {
          const metadataPath = path.join(specPath, 'task_metadata.json');
          let metadata: TaskMetadata = {};

          // Read existing metadata, handling missing file without TOCTOU race
          try {
            metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
          } catch (readErr: unknown) {
            // File doesn't exist yet - start with empty metadata
            if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw readErr;
            }
          }

          // Add archive info
          metadata.archivedAt = archivedAt;
          if (version) {
            metadata.archivedInVersion = version;
          }

          writeFileAtomicSync(metadataPath, JSON.stringify(metadata, null, 2));
        } catch (error) {
          console.error(`[ProjectStore] archiveTasks: Failed to archive task ${taskId} at ${specPath}:`, error);
          hasErrors = true;
          // Continue with other locations/tasks even if one fails
        }
      }
    }

    // Update linked roadmap features for archived tasks
    this.updateRoadmapForArchivedTasks(project, taskIds);

    // Invalidate cache since task metadata changed
    this.invalidateTasksCache(projectId);

    return !hasErrors;
  }

  /**
   * Update roadmap features linked to archived tasks
   */
  private updateRoadmapForArchivedTasks(project: Project, taskIds: string[]): void {
    const roadmapFile = getAutocodeRoadmapFilePath(project.path, project.autoBuildPath);
    updateRoadmapFeatureOutcome(roadmapFile, taskIds, 'archived', '[ProjectStore]').catch((err) => {
      console.warn('[ProjectStore] Failed to update roadmap for archived tasks:', err);
    });
  }

  /**
   * Unarchive tasks by removing archivedAt from their metadata
   * @param projectId - Project ID
   * @param taskIds - IDs of tasks to unarchive
   */
  unarchiveTasks(projectId: string, taskIds: string[]): boolean {
    const project = this.getProject(projectId);
    if (!project) {
      console.error('[ProjectStore] unarchiveTasks: Project not found:', projectId);
      return false;
    }

    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    let hasErrors = false;

    for (const taskId of taskIds) {
      // Find ALL locations where this task exists (main + worktrees)
      const specPaths = findAllSpecPaths(project.path, specsBaseDir, taskId);

      if (specPaths.length === 0) {
        console.warn(`[ProjectStore] unarchiveTasks: Spec directory not found for task ${taskId}`);
        continue;
      }

      // Unarchive in ALL locations
      for (const specPath of specPaths) {
        try {
          const metadataPath = path.join(specPath, 'task_metadata.json');
          let metadata: TaskMetadata;

          // Read metadata, handling missing file without TOCTOU race
          try {
            metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
          } catch (readErr: unknown) {
            if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
              console.warn(`[ProjectStore] unarchiveTasks: Metadata file not found for task ${taskId} at ${specPath}`);
              continue;
            }
            throw readErr;
          }

          delete metadata.archivedAt;
          delete metadata.archivedInVersion;
          writeFileAtomicSync(metadataPath, JSON.stringify(metadata, null, 2));
        } catch (error) {
          console.error(`[ProjectStore] unarchiveTasks: Failed to unarchive task ${taskId} at ${specPath}:`, error);
          hasErrors = true;
          // Continue with other locations/tasks even if one fails
        }
      }
    }

    // Revert linked roadmap features from 'archived' back to 'in_progress'
    const roadmapFile = getAutocodeRoadmapFilePath(project.path, project.autoBuildPath);
    revertRoadmapFeatureOutcome(roadmapFile, taskIds, '[ProjectStore]').catch((err) => {
      console.warn('[ProjectStore] Failed to revert roadmap for unarchived tasks:', err);
    });

    // Invalidate cache since task metadata changed
    this.invalidateTasksCache(projectId);

    return !hasErrors;
  }
}

// Singleton instance - only instantiate in main thread
export const projectStore = isProjectStoreRuntime ? new ProjectStore() : (null as any as ProjectStore);
