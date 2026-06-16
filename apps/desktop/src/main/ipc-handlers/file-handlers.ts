import { ipcMain, shell, type WebContents } from 'electron';
import { execFileSync } from 'child_process';
import chokidar, { type FSWatcher } from 'chokidar';
import { readdirSync } from 'fs';
import { readFile, stat, writeFile } from 'fs/promises';
import path from 'path';
import { shouldSkipAutocodeWorkspaceDir } from '@autocode/core/workspace/ignore-rules';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, FileNode, FileExplorerChangeEvent, FileExplorerChangeType, FileExplorerPathChange } from '../../shared/types';
import { getToolPath } from '../cli-tool-manager';
import { getIsolatedGitEnv } from '../utils/git-isolation';

// Maximum file size to read (10MB for JSON files, 1MB for others)
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_JSON_FILE_SIZE = 10 * 1024 * 1024;
const MAX_IMAGE_FILE_SIZE = 25 * 1024 * 1024;
const FILE_EXPLORER_CHANGE_FLUSH_DELAY_MS = 150;

const IMAGE_MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp']
]);

const VISIBLE_HIDDEN_FILES = new Set(['.env', '.gitignore', '.env.example', '.env.local']);

interface ProjectFileWatcherState {
  projectPath: string;
  watcher: FSWatcher;
  subscribers: Map<number, WebContents>;
  pendingChanges: Map<string, FileExplorerPathChange>;
  flushTimer: NodeJS.Timeout | null;
}

const projectFileWatchers = new Map<string, ProjectFileWatcherState>();

function getMaxFileSize(filePath: string): number {
  return filePath.toLowerCase().endsWith('.json') ? MAX_JSON_FILE_SIZE : MAX_FILE_SIZE;
}

function getImageMimeType(filePath: string): string | null {
  return IMAGE_MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? null;
}

/**
 * Validates and normalizes a file path for safe reading.
 * Returns the normalized path if valid, or an error message.
 */
function validatePath(filePath: string): { valid: true; path: string } | { valid: false; error: string } {
  // Resolve to absolute path (handles .., ., etc.)
  const resolvedPath = path.resolve(filePath);

  // Must be absolute after resolution
  if (!path.isAbsolute(resolvedPath)) {
    return { valid: false, error: 'Path must be absolute' };
  }

  // After resolution, path should not contain .. segments
  // This catches edge cases where resolve might not fully normalize
  const segments = resolvedPath.split(path.sep);
  if (segments.includes('..')) {
    return { valid: false, error: 'Invalid path: contains parent directory references' };
  }

  return { valid: true, path: resolvedPath };
}

function validatePathInsideProject(
  projectPath: string,
  filePath: string
): { valid: true; projectPath: string; filePath: string; relativePath: string } | { valid: false; error: string } {
  const projectValidation = validatePath(projectPath);
  if (!projectValidation.valid) {
    return { valid: false, error: projectValidation.error };
  }

  const fileValidation = validatePath(filePath);
  if (!fileValidation.valid) {
    return { valid: false, error: fileValidation.error };
  }

  const relativePath = path.relative(projectValidation.path, fileValidation.path);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return { valid: false, error: 'File must be inside the project directory' };
  }

  return {
    valid: true,
    projectPath: projectValidation.path,
    filePath: fileValidation.path,
    relativePath
  };
}

function parseGitStatusPaths(statusOutput: string): string[] {
  const paths: string[] = [];

  for (const rawLine of statusOutput.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    let filePath = line.slice(3).trim();
    const renameSeparator = ' -> ';
    if (filePath.includes(renameSeparator)) {
      filePath = filePath.slice(filePath.indexOf(renameSeparator) + renameSeparator.length);
    }

    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      try {
        filePath = JSON.parse(filePath) as string;
      } catch {
        filePath = filePath.slice(1, -1);
      }
    }

    if (filePath) {
      paths.push(filePath);
    }
  }

  return paths;
}

function getWatchKey(projectPath: string): string {
  const resolvedPath = path.resolve(projectPath);
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function isPathInsideProject(projectPath: string, filePath: string): boolean {
  const relativePath = path.relative(projectPath, filePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function shouldSkipFileExplorerPath(projectPath: string, filePath: string, isDirectory: boolean): boolean {
  if (!isPathInsideProject(projectPath, filePath)) {
    return true;
  }

  const relativePath = path.relative(projectPath, filePath);
  if (!relativePath) {
    return false;
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  const directorySegments = isDirectory ? segments : segments.slice(0, -1);
  if (directorySegments.some((segment) => shouldSkipAutocodeWorkspaceDir(segment))) {
    return true;
  }

  const name = segments[segments.length - 1] ?? path.basename(filePath);
  if (isDirectory) {
    return shouldSkipAutocodeWorkspaceDir(name);
  }

  return name.startsWith('.') && !VISIBLE_HIDDEN_FILES.has(name);
}

function sendProjectFileChangeBatch(state: ProjectFileWatcherState): void {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }

  const changes = Array.from(state.pendingChanges.values());
  state.pendingChanges.clear();
  if (changes.length === 0) {
    return;
  }

  const affectedDirectoryPaths = new Set<string>();
  const removedDirectoryPaths = new Set<string>();
  for (const change of changes) {
    affectedDirectoryPaths.add(change.parentPath);
    if (change.type === 'unlinkDir') {
      removedDirectoryPaths.add(change.path);
    }
  }

  const payload: FileExplorerChangeEvent = {
    projectPath: state.projectPath,
    changes,
    affectedDirectoryPaths: Array.from(affectedDirectoryPaths),
    removedDirectoryPaths: Array.from(removedDirectoryPaths)
  };

  for (const [id, subscriber] of state.subscribers.entries()) {
    if (subscriber.isDestroyed()) {
      state.subscribers.delete(id);
      continue;
    }
    subscriber.send(IPC_CHANNELS.FILE_EXPLORER_PROJECT_CHANGED, payload);
  }
}

function enqueueProjectFileChange(
  state: ProjectFileWatcherState,
  type: FileExplorerChangeType,
  rawChangedPath: string
): void {
  const changedPath = path.isAbsolute(rawChangedPath)
    ? path.resolve(rawChangedPath)
    : path.resolve(state.projectPath, rawChangedPath);
  const isDirectory = type === 'addDir' || type === 'unlinkDir';
  if (shouldSkipFileExplorerPath(state.projectPath, changedPath, isDirectory)) {
    return;
  }

  const change: FileExplorerPathChange = {
    type,
    path: changedPath,
    parentPath: path.dirname(changedPath),
    isDirectory
  };

  state.pendingChanges.set(getWatchKey(changedPath), change);
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
  }
  state.flushTimer = setTimeout(
    () => sendProjectFileChangeBatch(state),
    FILE_EXPLORER_CHANGE_FLUSH_DELAY_MS
  );
}

function closeProjectFileWatcher(watchKey: string, state: ProjectFileWatcherState): void {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  state.pendingChanges.clear();
  projectFileWatchers.delete(watchKey);
  void state.watcher.close().catch((error: unknown) => {
    console.warn('[FILE_EXPLORER_WATCH] Failed to close watcher:', error);
  });
}

function removeProjectFileSubscriber(watchKey: string, sender: WebContents): void {
  const state = projectFileWatchers.get(watchKey);
  if (!state) {
    return;
  }

  state.subscribers.delete(sender.id);
  if (state.subscribers.size === 0) {
    closeProjectFileWatcher(watchKey, state);
  }
}

function createProjectFileWatcher(projectPath: string): ProjectFileWatcherState {
  const watcher = chokidar.watch(projectPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 50
    },
    ignored: (candidatePath, stats) => {
      const candidate = path.isAbsolute(candidatePath)
        ? path.resolve(candidatePath)
        : path.resolve(projectPath, candidatePath);
      return shouldSkipFileExplorerPath(projectPath, candidate, stats?.isDirectory() ?? true);
    }
  });

  const state: ProjectFileWatcherState = {
    projectPath,
    watcher,
    subscribers: new Map(),
    pendingChanges: new Map(),
    flushTimer: null
  };

  watcher.on('add', (changedPath) => enqueueProjectFileChange(state, 'add', changedPath));
  watcher.on('addDir', (changedPath) => enqueueProjectFileChange(state, 'addDir', changedPath));
  watcher.on('unlink', (changedPath) => enqueueProjectFileChange(state, 'unlink', changedPath));
  watcher.on('unlinkDir', (changedPath) => enqueueProjectFileChange(state, 'unlinkDir', changedPath));
  watcher.on('error', (error) => {
    console.warn('[FILE_EXPLORER_WATCH] Watcher error:', error);
  });

  return state;
}

/**
 * Register all file-related IPC handlers
 */
export function registerFileHandlers(): void {
  // ============================================
  // File Explorer Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.FILE_EXPLORER_LIST,
    async (_, dirPath: string): Promise<IPCResult<FileNode[]>> => {
      try {
        // Validate and normalize path to prevent directory traversal
        const validation = validatePath(dirPath);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }
        const entries = readdirSync(validation.path, { withFileTypes: true });

        // Filter and map entries
        const nodes: FileNode[] = [];
        for (const entry of entries) {
          // Skip hidden files (not directories) except useful ones like .env, .gitignore
          if (!entry.isDirectory() && entry.name.startsWith('.') &&
              !['.env', '.gitignore', '.env.example', '.env.local'].includes(entry.name)) {
            continue;
          }
          // Skip ignored directories
          if (entry.isDirectory() && shouldSkipAutocodeWorkspaceDir(entry.name)) continue;

          nodes.push({
            path: path.join(validation.path, entry.name),
            name: entry.name,
            isDirectory: entry.isDirectory()
          });
        }

        // Sort: directories first, then alphabetically
        nodes.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });

        return { success: true, data: nodes };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list directory'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_EXPLORER_READ,
    async (_, filePath: string): Promise<IPCResult<string>> => {
      try {
        console.log('[FILE_EXPLORER_READ] Reading file:', filePath);

        // Validate and normalize path
        const validation = validatePath(filePath);
        if (!validation.valid) {
          console.error('[FILE_EXPLORER_READ] Path validation failed:', validation.error);
          return { success: false, error: validation.error };
        }
        const safePath = validation.path;
        console.log('[FILE_EXPLORER_READ] Normalized path:', safePath);

        const maxSize = getMaxFileSize(safePath);

        // Use async file read to avoid blocking; check size after reading to avoid TOCTOU
        const content = await readFile(safePath, 'utf-8');
        const fileSize = Buffer.byteLength(content, 'utf-8');
        console.log('[FILE_EXPLORER_READ] File read successfully, size:', fileSize);

        if (fileSize > maxSize) {
          const maxSizeMB = maxSize / (1024 * 1024);
          console.error('[FILE_EXPLORER_READ] File too large');
          return { success: false, error: `File too large (max ${maxSizeMB}MB)` };
        }
        return { success: true, data: content };
      } catch (error) {
        console.error('[FILE_EXPLORER_READ] Error reading file:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read file'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_EXPLORER_READ_IMAGE,
    async (_, filePath: string): Promise<IPCResult<{ dataUrl: string; mimeType: string; size: number }>> => {
      try {
        const validation = validatePath(filePath);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }

        const safePath = validation.path;
        const mimeType = getImageMimeType(safePath);
        if (!mimeType) {
          return { success: false, error: 'Unsupported image file type' };
        }

        const fileStat = await stat(safePath);
        if (fileStat.isDirectory()) {
          return { success: false, error: 'Path must be a file' };
        }
        if (fileStat.size > MAX_IMAGE_FILE_SIZE) {
          return { success: false, error: 'Image too large (max 25MB)' };
        }

        const buffer = await readFile(safePath);
        return {
          success: true,
          data: {
            dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
            mimeType,
            size: buffer.length
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read image file'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_EXPLORER_WRITE,
    async (_, filePath: string, content: string): Promise<IPCResult<void>> => {
      try {
        if (typeof content !== 'string') {
          return { success: false, error: 'Content must be a string' };
        }

        const validation = validatePath(filePath);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }

        const safePath = validation.path;
        const fileStat = await stat(safePath);
        if (fileStat.isDirectory()) {
          return { success: false, error: 'Path must be a file' };
        }

        const maxSize = getMaxFileSize(safePath);
        const fileSize = Buffer.byteLength(content, 'utf-8');
        if (fileSize > maxSize) {
          const maxSizeMB = maxSize / (1024 * 1024);
          return { success: false, error: `File too large (max ${maxSizeMB}MB)` };
        }

        await writeFile(safePath, content, 'utf-8');
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to write file'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_EXPLORER_DIFF,
    async (_, projectPath: string, filePath: string): Promise<IPCResult<string>> => {
      try {
        const validation = validatePathInsideProject(projectPath, filePath);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }

        const git = getToolPath('git');
        const commonOptions = {
          cwd: validation.projectPath,
          encoding: 'utf-8' as const,
          stdio: 'pipe' as const,
          timeout: 5000,
          env: getIsolatedGitEnv()
        };

        try {
          const status = execFileSync(git, ['status', '--porcelain', '--', validation.relativePath], commonOptions);
          if (status.trim().startsWith('??')) {
            return { success: true, data: `__AUTOCODE_UNTRACKED__\n${status}` };
          }
        } catch {
          // Continue to diff. Non-git folders or git failures are reported below.
        }

        const unstagedDiff = execFileSync(git, ['diff', '--', validation.relativePath], commonOptions);
        const stagedDiff = execFileSync(git, ['diff', '--cached', '--', validation.relativePath], commonOptions);
        return { success: true, data: `${unstagedDiff}\n${stagedDiff}`.trim() };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get file diff'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_EXPLORER_CHANGED_FILES,
    async (_, projectPath: string): Promise<IPCResult<string[]>> => {
      try {
        const validation = validatePath(projectPath);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }

        const output = execFileSync(
          getToolPath('git'),
          ['status', '--porcelain', '--untracked-files=all'],
          {
            cwd: validation.path,
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 5000,
            env: getIsolatedGitEnv()
          }
        );

        return { success: true, data: parseGitStatusPaths(output) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get changed files'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_EXPLORER_SHOW_ITEM_IN_FOLDER,
    async (_, filePath: string): Promise<IPCResult<void>> => {
      try {
        const validation = validatePath(filePath);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }

        const safePath = validation.path;
        const fileStat = await stat(safePath);
        if (fileStat.isDirectory()) {
          return { success: false, error: 'Path must be a file' };
        }

        shell.showItemInFolder(safePath);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to show item in folder'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_EXPLORER_WATCH_PROJECT,
    async (event, projectPath: string): Promise<IPCResult<void>> => {
      try {
        const validation = validatePath(projectPath);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }

        const projectStat = await stat(validation.path);
        if (!projectStat.isDirectory()) {
          return { success: false, error: 'Project path must be a directory' };
        }

        const watchKey = getWatchKey(validation.path);
        let state = projectFileWatchers.get(watchKey);
        if (!state) {
          state = createProjectFileWatcher(validation.path);
          projectFileWatchers.set(watchKey, state);
        }

        if (!state.subscribers.has(event.sender.id)) {
          state.subscribers.set(event.sender.id, event.sender);
          event.sender.once('destroyed', () => {
            removeProjectFileSubscriber(watchKey, event.sender);
          });
        }

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to watch project files'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_EXPLORER_UNWATCH_PROJECT,
    async (event, projectPath: string): Promise<IPCResult<void>> => {
      try {
        const validation = validatePath(projectPath);
        const watchKey = getWatchKey(validation.valid ? validation.path : projectPath);
        removeProjectFileSubscriber(watchKey, event.sender);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to unwatch project files'
        };
      }
    }
  );
}
