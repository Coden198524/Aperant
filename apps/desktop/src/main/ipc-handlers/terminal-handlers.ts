import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, TerminalCreateOptions, ClaudeProfile, ClaudeProfileSettings, ClaudeUsageSnapshot, AllProfilesUsage, SupportedCLI, NativeCliSession } from '../../shared/types';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { getUsageMonitor } from '../claude-profile/usage-monitor';
import { TerminalManager } from '../terminal-manager';
import { projectStore } from '../project-store';
import { terminalNameGenerator } from '../terminal-name-generator';
import { debugLog, } from '../../shared/utils/debug-logger';
import { migrateSession } from '../claude-profile/session-utils';
import { createProfileDirectory } from '../claude-profile/profile-utils';
import { isValidConfigDir } from '../utils/config-path-validator';
import { deepSeekSessionsToNativeHistory } from '../terminal/deepseek-history';

function formatCliSessionTitle(text: unknown, fallback: string): string {
  if (typeof text !== 'string') {
    return fallback;
  }

  const firstLine = text.replace(/\s+/g, ' ').trim();
  if (!firstLine) {
    return fallback;
  }

  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function getClaudeProjectSlug(projectPath: string): string {
  // Replace colons and slashes with dashes to match Claude Code's directory naming
  // E:\Work\Aperant -> E--Work-Aperant
  return projectPath.replace(/[:\\/]/g, '-');
}

function readJsonLines(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is unknown => entry !== null);
}

function walkJsonlFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

function getCodexSessionIdFromPath(filePath: string): string | undefined {
  const fileName = path.basename(filePath);
  const match = fileName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1];
}

function isPathInProject(sessionPath: string | undefined, projectPath: string | undefined): boolean {
  if (!projectPath) {
    return true;
  }
  if (!sessionPath) {
    return false;
  }

  const normalizedSessionPath = path.resolve(sessionPath).toLowerCase();
  const normalizedProjectPath = path.resolve(projectPath).toLowerCase();
  return normalizedSessionPath === normalizedProjectPath
    || normalizedSessionPath.startsWith(`${normalizedProjectPath}${path.sep}`);
}

function extractCodexUserText(entry: unknown): string | undefined {
  const payload = (entry as { payload?: unknown } | undefined)?.payload;
  const payloadRecord = payload as { type?: unknown; role?: unknown; content?: unknown } | undefined;

  if (payloadRecord?.type === 'message' && payloadRecord.role === 'user') {
    const content = payloadRecord.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      const textPart = content.find((part) => part && typeof part === 'object' && (part as { type?: unknown }).type === 'input_text');
      const text = (textPart as { text?: unknown } | undefined)?.text;
      return typeof text === 'string' ? text : undefined;
    }
  }

  const legacyText = (entry as { text?: unknown } | undefined)?.text;
  return typeof legacyText === 'string' ? legacyText : undefined;
}

function getCodexNativeHistory(projectPath?: string): NativeCliSession[] {
  const codexRoot = path.join(os.homedir(), '.codex');
  const historyPath = path.join(codexRoot, 'history.jsonl');
  const sessionIndexPath = path.join(codexRoot, 'session_index.jsonl');
  const sessionsRoot = path.join(codexRoot, 'sessions');
  const bySession = new Map<string, NativeCliSession & { firstText?: string; lastText?: string }>();

  const upsertSession = (
    id: string,
    updates: Partial<NativeCliSession> & { firstText?: string; lastText?: string }
  ) => {
    const existing = bySession.get(id);
    if (!existing) {
      bySession.set(id, {
        id,
        cli: 'codex',
        title: updates.title || formatCliSessionTitle(updates.firstText || updates.lastText, 'Codex session'),
        createdAt: updates.createdAt,
        updatedAt: updates.updatedAt || new Date().toISOString(),
        projectPath: updates.projectPath,
        sourcePath: updates.sourcePath,
        firstText: updates.firstText,
        lastText: updates.lastText,
      });
      return;
    }

    const incomingUpdatedAt = updates.updatedAt ? new Date(updates.updatedAt).getTime() : 0;
    const existingUpdatedAt = new Date(existing.updatedAt).getTime();
    if (incomingUpdatedAt >= existingUpdatedAt) {
      existing.updatedAt = updates.updatedAt || existing.updatedAt;
      existing.lastText = updates.lastText || existing.lastText;
      existing.sourcePath = updates.sourcePath || existing.sourcePath;
    }

    existing.createdAt = existing.createdAt || updates.createdAt;
    existing.projectPath = existing.projectPath || updates.projectPath;
    existing.firstText = existing.firstText || updates.firstText;
    existing.title = updates.title || formatCliSessionTitle(existing.firstText || existing.lastText, existing.title || 'Codex session');
  };

  for (const entry of readJsonLines(sessionIndexPath)) {
    const record = entry as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
    if (typeof record.id !== 'string') {
      continue;
    }

    upsertSession(record.id, {
      title: formatCliSessionTitle(record.thread_name, 'Codex session'),
      updatedAt: typeof record.updated_at === 'string' ? record.updated_at : undefined,
      sourcePath: sessionIndexPath,
    });
  }

  for (const filePath of walkJsonlFiles(sessionsRoot)) {
    const stat = fs.statSync(filePath);
    let id = getCodexSessionIdFromPath(filePath);
    let createdAt: string | undefined;
    let projectPath: string | undefined;
    let firstText: string | undefined;

    for (const entry of readJsonLines(filePath)) {
      const record = entry as { type?: unknown; timestamp?: unknown; payload?: unknown };
      if (record.type === 'session_meta') {
        const payload = record.payload as { id?: unknown; timestamp?: unknown; cwd?: unknown } | undefined;
        id = typeof payload?.id === 'string' ? payload.id : id;
        createdAt = typeof payload?.timestamp === 'string' ? payload.timestamp : createdAt;
        projectPath = typeof payload?.cwd === 'string' ? payload.cwd : projectPath;
      }

      if (!firstText) {
        firstText = extractCodexUserText(entry);
      }
    }

    if (!id) {
      continue;
    }

    upsertSession(id, {
      title: formatCliSessionTitle(firstText, 'Codex session'),
      createdAt,
      updatedAt: stat.mtime.toISOString(),
      projectPath,
      sourcePath: filePath,
      firstText,
    });
  }

  for (const entry of readJsonLines(historyPath)) {
    const record = entry as { session_id?: unknown; ts?: unknown; text?: unknown };
    if (typeof record.session_id !== 'string') {
      continue;
    }

    const timestamp = typeof record.ts === 'number'
      ? new Date(record.ts * 1000)
      : new Date();
    const text = typeof record.text === 'string' ? record.text : undefined;

    upsertSession(record.session_id, {
      title: formatCliSessionTitle(text, 'Codex session'),
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
      sourcePath: historyPath,
      firstText: text,
      lastText: text,
    });
  }

  return [...bySession.values()]
    .filter((session) => isPathInProject(session.projectPath, projectPath))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(({ firstText: _firstText, lastText: _lastText, ...session }) => session);
}

function extractClaudeMessageText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const textPart = content.find((part) => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text');
    const text = (textPart as { text?: unknown } | undefined)?.text;
    return typeof text === 'string' ? text : undefined;
  }
  return undefined;
}

function getClaudeNativeHistory(projectPath?: string): NativeCliSession[] {
  const sessions: NativeCliSession[] = [];

  // Check both .claude and .claude-profiles directories
  const possibleRoots = [
    path.join(os.homedir(), '.claude', 'projects'),
    path.join(os.homedir(), '.claude-profiles', 'primary', 'projects'),
  ];

  console.log('[getClaudeNativeHistory] Looking for sessions in:', possibleRoots);
  console.log('[getClaudeNativeHistory] Project path:', projectPath);

  for (const projectsRoot of possibleRoots) {
    if (!fs.existsSync(projectsRoot)) {
      console.log('[getClaudeNativeHistory] Directory does not exist:', projectsRoot);
      continue;
    }

    console.log('[getClaudeNativeHistory] Found directory:', projectsRoot);

    const projectDirs = projectPath
      ? [path.join(projectsRoot, getClaudeProjectSlug(projectPath))]
      : fs.readdirSync(projectsRoot).map((name) => path.join(projectsRoot, name));

    console.log('[getClaudeNativeHistory] Project directories to check:', projectDirs);

    for (const projectDir of projectDirs) {
      if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        console.log('[getClaudeNativeHistory] Project directory does not exist or is not a directory:', projectDir);
        continue;
      }

      const jsonlFiles = fs.readdirSync(projectDir).filter((name) => name.endsWith('.jsonl'));
      console.log('[getClaudeNativeHistory] Found .jsonl files in', projectDir, ':', jsonlFiles.length);

      for (const fileName of jsonlFiles) {
        const filePath = path.join(projectDir, fileName);
        const stat = fs.statSync(filePath);
        let title = 'Claude session';
        let createdAt: string | undefined;
        let updatedAt = stat.mtime.toISOString();

        for (const entry of readJsonLines(filePath)) {
          const record = entry as { type?: unknown; timestamp?: unknown; message?: unknown };
          if (typeof record.timestamp === 'string') {
            createdAt ??= record.timestamp;
            updatedAt = record.timestamp;
          }
          if (title === 'Claude session' && record.type === 'user') {
            title = formatCliSessionTitle(extractClaudeMessageText(record.message), title);
          }
        }

        sessions.push({
          id: fileName.replace(/\.jsonl$/, ''),
          cli: 'claude-code',
          title,
          createdAt,
          updatedAt,
          projectPath,
          sourcePath: filePath,
        });
      }
    }
  }

  console.log('[getClaudeNativeHistory] Total sessions found:', sessions.length);
  return sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

/**
 * Register all terminal-related IPC handlers
 */
export function registerTerminalHandlers(
  terminalManager: TerminalManager,
  getMainWindow: () => BrowserWindow | null
): void {

  // ============================================
  // Terminal Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_CREATE,
    async (_, options: TerminalCreateOptions): Promise<IPCResult> => {
      try {
        const result = await terminalManager.create(options);
        return result;
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create terminal (exception)'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_DESTROY,
    async (_, id: string): Promise<IPCResult> => {
      return terminalManager.destroy(id);
    }
  );

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_INPUT,
    (_, id: string, data: string) => {
      terminalManager.write(id, data);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_RESIZE,
    async (_, id: string, cols: number, rows: number): Promise<IPCResult<{ success: boolean }>> => {
      const success = terminalManager.resize(id, cols, rows);
      return { success, data: { success } };
    }
  );

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_INVOKE_CLI,
    (_, id: string, cwd?: string, cli?: SupportedCLI) => {
      // Claude smart terminals always run with the requested full-permission mode.
      // Non-Claude CLIs ignore this Claude-specific flag.
      (async () => {
        await terminalManager.invokeCLIAsync(id, cwd, undefined, true, cli);
      })().catch((error) => {
        console.warn('[terminal-handlers] Failed to invoke CLI:', error);
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_GENERATE_NAME,
    async (_, command: string, cwd?: string): Promise<IPCResult<string>> => {
      try {
        const name = await terminalNameGenerator.generateName(command, cwd);
        if (name) {
          return { success: true, data: name };
        } else {
          return { success: false, error: 'Failed to generate terminal name' };
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to generate terminal name'
        };
      }
    }
  );

  // Set terminal title (user renamed terminal in renderer)
  ipcMain.on(
    IPC_CHANNELS.TERMINAL_SET_TITLE,
    (_, id: string, title: string) => {
      terminalManager.setTitle(id, title);
    }
  );

  // Set terminal worktree config (user changed worktree association in renderer)
  ipcMain.on(
    IPC_CHANNELS.TERMINAL_SET_WORKTREE_CONFIG,
    (_, id: string, config: import('../../shared/types').TerminalWorktreeConfig | undefined) => {
      terminalManager.setWorktreeConfig(id, config);
    }
  );

  // Claude profile management (multi-account support)
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILES_GET,
    async (): Promise<IPCResult<ClaudeProfileSettings>> => {
      try {
        const profileManager = getClaudeProfileManager();
        const settings = profileManager.getSettings();
        return { success: true, data: settings };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get Claude profiles'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_SAVE,
    async (_, profile: ClaudeProfile): Promise<IPCResult<ClaudeProfile>> => {
      try {
        const profileManager = getClaudeProfileManager();

        // If this is a new profile without an ID, generate one
        if (!profile.id) {
          profile.id = profileManager.generateProfileId(profile.name);
        }

        // For non-default profiles, ensure configDir is ALWAYS set
        // This is critical for the CLAUDE_CONFIG_DIR-based auth flow
        // See: docs/LONG_LIVED_AUTH_PLAN.md for context
        if (!profile.isDefault) {
          if (!profile.configDir) {
            // Auto-create a configDir in ~/.claude-profiles/{profile-name}/
            console.warn('[CLAUDE_PROFILE_SAVE] Profile missing configDir, creating one:', profile.name);
            profile.configDir = await createProfileDirectory(profile.name);
          }

          // Security: Validate configDir path to prevent path traversal attacks
          if (!isValidConfigDir(profile.configDir)) {
            return {
              success: false,
              error: `Invalid config directory path: ${profile.configDir}. Config directories must be within the user's home directory.`
            };
          }

          // Ensure config directory exists
          const { mkdirSync, existsSync } = await import('fs');
          if (!existsSync(profile.configDir)) {
            mkdirSync(profile.configDir, { recursive: true });
          }
        }

        const savedProfile = profileManager.saveProfile(profile);
        return { success: true, data: savedProfile };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save Claude profile'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_DELETE,
    async (_, profileId: string): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();
        const success = profileManager.deleteProfile(profileId);
        if (!success) {
          return { success: false, error: 'Cannot delete default or last profile' };
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete Claude profile'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_RENAME,
    async (_, profileId: string, newName: string): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();
        const success = profileManager.renameProfile(profileId, newName);
        if (!success) {
          return { success: false, error: 'Profile not found or invalid name' };
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to rename Claude profile'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_SET_ACTIVE,
    async (_, profileId: string): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();
        const previousProfile = profileManager.getActiveProfile();
        const previousProfileId = previousProfile.id;

        const success = profileManager.setActiveProfile(profileId);

        if (!success) {
          return { success: false, error: 'Profile not found' };
        }

        const newProfile = profileManager.getProfile(profileId);

        // If the profile actually changed, restart Claude in active terminals
        // This ensures existing Claude sessions use the new profile's OAuth token
        const profileChanged = previousProfileId !== profileId;

        if (profileChanged) {
          // Get all terminal info for profile change
          const terminals = terminalManager.getTerminalsForProfileChange();
          debugLog('[terminal-handlers:CLAUDE_PROFILE_SET_ACTIVE] Terminals for profile change:', terminals.length);

          // Determine config directories for session migration
          // All profiles now have their own configDir (no special case for default)
          const sourceConfigDir = previousProfile.configDir;
          const targetConfigDir = newProfile?.configDir;

          // Build terminal refresh info for frontend
          const terminalsNeedingRefresh: Array<{
            id: string;
            sessionId?: string;
            sessionMigrated?: boolean;
            isCLIMode?: boolean;
            dangerouslySkipPermissions?: boolean;
          }> = [];

          // Process each terminal
          for (const terminal of terminals) {
            debugLog('[terminal-handlers:CLAUDE_PROFILE_SET_ACTIVE] Processing terminal:', {
              id: terminal.id,
              isCLIMode: terminal.isCLIMode,
              claudeSessionId: terminal.claudeSessionId,
              cwd: terminal.cwd
            });

            let sessionMigrated = false;

            // If terminal has an active Claude session, migrate it to new profile
            if (terminal.claudeSessionId && sourceConfigDir && targetConfigDir) {
              debugLog('[terminal-handlers:CLAUDE_PROFILE_SET_ACTIVE] Migrating session:', {
                sessionId: terminal.claudeSessionId,
                from: sourceConfigDir,
                to: targetConfigDir
              });

              const migrationResult = await migrateSession(
                sourceConfigDir,
                targetConfigDir,
                terminal.cwd,
                terminal.claudeSessionId
              );

              sessionMigrated = migrationResult.success;
              debugLog('[terminal-handlers:CLAUDE_PROFILE_SET_ACTIVE] Session migration result:', migrationResult);
            }

            // Store YOLO mode flag server-side for migrated sessions
            // (consumed by resumeClaudeAsync when the new terminal resumes)
            if (sessionMigrated && terminal.claudeSessionId && terminal.dangerouslySkipPermissions) {
              terminalManager.storeMigratedSessionFlag(terminal.claudeSessionId, terminal.dangerouslySkipPermissions);
            }

            // All terminals need refresh (PTY env vars can't be updated)
            terminalsNeedingRefresh.push({
              id: terminal.id,
              sessionId: terminal.claudeSessionId,
              sessionMigrated,
              isCLIMode: terminal.isCLIMode,
              dangerouslySkipPermissions: terminal.dangerouslySkipPermissions
            });
          }

          debugLog('[terminal-handlers:CLAUDE_PROFILE_SET_ACTIVE] Terminals needing refresh:', terminalsNeedingRefresh);

          // Notify frontend that terminals need to be refreshed
          // Frontend will destroy and recreate terminals with new profile env vars
          const mainWindow = getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.TERMINAL_PROFILE_CHANGED, {
              previousProfileId,
              newProfileId: profileId,
              terminals: terminalsNeedingRefresh
            });
            debugLog('[terminal-handlers:CLAUDE_PROFILE_SET_ACTIVE] Sent TERMINAL_PROFILE_CHANGED event to frontend');
          }
        }

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set active Claude profile'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_SWITCH,
    async (_, terminalId: string, profileId: string): Promise<IPCResult> => {
      try {
        const result = await terminalManager.switchClaudeProfile(terminalId, profileId);
        return result;
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to switch Claude profile'
        };
      }
    }
  );

  // CLAUDE_PROFILE_INITIALIZE handler has been removed.
  // Use CLAUDE_PROFILE_AUTHENTICATE (in claude-code-handlers.ts) instead,
  // which opens a visible terminal for the user to run /login manually.
  // Authentication status is checked via CLAUDE_PROFILE_VERIFY_AUTH with polling.

  // Set OAuth token for a profile (used when capturing from terminal or manual input)
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_SET_TOKEN,
    async (_, profileId: string, token: string, email?: string): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();
        const success = profileManager.setProfileToken(profileId, token, email);
        if (!success) {
          return { success: false, error: 'Profile not found' };
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set OAuth token'
        };
      }
    }
  );

  // TERMINAL_OAUTH_CODE_SUBMIT handler has been removed.
  // The new authentication flow (CLAUDE_PROFILE_AUTHENTICATE) doesn't require
  // manual code submission - the user completes OAuth directly in the browser.

  // Get auto-switch settings
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_AUTO_SWITCH_SETTINGS,
    async (): Promise<IPCResult<import('../../shared/types').ClaudeAutoSwitchSettings>> => {
      try {
        const profileManager = getClaudeProfileManager();
        const settings = profileManager.getAutoSwitchSettings();
        return { success: true, data: settings };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get auto-switch settings'
        };
      }
    }
  );

  // Update auto-switch settings
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_UPDATE_AUTO_SWITCH,
    async (_, settings: Partial<import('../../shared/types').ClaudeAutoSwitchSettings>): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();
        profileManager.updateAutoSwitchSettings(settings);

        // Restart usage monitor with new settings
        const monitor = getUsageMonitor();
        monitor.stop();
        monitor.start();

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update auto-switch settings'
        };
      }
    }
  );

  // Get account priority order
  ipcMain.handle(
    IPC_CHANNELS.ACCOUNT_PRIORITY_GET,
    async (): Promise<IPCResult<string[]>> => {
      try {
        const profileManager = getClaudeProfileManager();
        const order = profileManager.getAccountPriorityOrder();
        return { success: true, data: order };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get account priority order'
        };
      }
    }
  );

  // Set account priority order
  ipcMain.handle(
    IPC_CHANNELS.ACCOUNT_PRIORITY_SET,
    async (_, order: string[]): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();
        profileManager.setAccountPriorityOrder(order);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set account priority order'
        };
      }
    }
  );

  // Fetch usage by sending /usage command to terminal
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_FETCH_USAGE,
    async (_, terminalId: string): Promise<IPCResult> => {
      try {
        // Send /usage command to the terminal
        terminalManager.write(terminalId, '/usage\r');
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch usage'
        };
      }
    }
  );

  // Get best available profile
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_GET_BEST_PROFILE,
    async (_, excludeProfileId?: string): Promise<IPCResult<ClaudeProfile | null>> => {
      try {
        const profileManager = getClaudeProfileManager();
        const bestProfile = profileManager.getBestAvailableProfile(excludeProfileId);
        return { success: true, data: bestProfile };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get best profile'
        };
      }
    }
  );

  // Retry rate-limited operation with a different profile
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_RETRY_WITH_PROFILE,
    async (_, request: import('../../shared/types').RetryWithProfileRequest): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();

        // Set the new active profile
        profileManager.setActiveProfile(request.profileId);

        // Get the project
        const project = projectStore.getProject(request.projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        // Retry based on the source
        switch (request.source) {
          case 'changelog':
            // The changelog UI will handle retrying by re-submitting the form
            // We just need to confirm the profile switch was successful
            return { success: true };

          case 'task':
            // For tasks, we would need to restart the task
            // This is complex and would need task state restoration
            return { success: true, data: { message: 'Please restart the task manually' } };

          case 'roadmap':
            // For roadmap, the UI can trigger a refresh
            return { success: true };

          case 'ideation':
            // For ideation, the UI can trigger a refresh
            return { success: true };

          default:
            return { success: true };
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to retry with profile'
        };
      }
    }
  );

  // ============================================
  // Usage Monitoring (Proactive Account Switching)
  // ============================================

  // Request current usage snapshot
  ipcMain.handle(
    IPC_CHANNELS.USAGE_REQUEST,
    async (): Promise<IPCResult<import('../../shared/types').ClaudeUsageSnapshot | null>> => {
      try {
        const monitor = getUsageMonitor();
        const usage = monitor.getCurrentUsage();
        return { success: true, data: usage };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get current usage'
        };
      }
    }
  );

  // Request all profiles usage immediately (for startup/refresh)
  // Optional forceRefresh parameter bypasses cache to get fresh data
  ipcMain.handle(
    IPC_CHANNELS.ALL_PROFILES_USAGE_REQUEST,
    async (_event: IpcMainInvokeEvent, forceRefresh: boolean = false): Promise<IPCResult<AllProfilesUsage | null>> => {
      try {
        const monitor = getUsageMonitor();
        const allProfilesUsage = await monitor.getAllProfilesUsage(forceRefresh);
        return { success: true, data: allProfilesUsage };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get all profiles usage'
        };
      }
    }
  );


  // Terminal session management (persistence/restore)
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_GET_SESSIONS,
    async (_, projectPath: string, cli?: SupportedCLI): Promise<IPCResult<import('../../shared/types').TerminalSession[]>> => {
      try {
        const sessions = terminalManager.getSavedSessions(projectPath, cli);
        return { success: true, data: sessions };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get terminal sessions'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_RESTORE_SESSION,
    async (_, session: import('../../shared/types').TerminalSession, cols?: number, rows?: number): Promise<IPCResult<import('../../shared/types').TerminalRestoreResult>> => {
      try {
        const result = await terminalManager.restore(session, cols, rows);
        return {
          success: result.success,
          data: {
            success: result.success,
            terminalId: session.id,
            outputBuffer: result.outputBuffer,
            error: result.error
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to restore terminal session'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_CLEAR_SESSIONS,
    async (_, projectPath: string): Promise<IPCResult> => {
      try {
        terminalManager.clearSavedSessions(projectPath);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to clear terminal sessions'
        };
      }
    }
  );

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_RESUME_CLAUDE,
    (_, id: string, sessionId?: string, options?: { migratedSession?: boolean }) => {
      // Use async version to avoid blocking main process during CLI detection
      terminalManager.resumeClaudeAsync(id, sessionId, options).catch((error) => {
        console.warn('[terminal-handlers] Failed to resume Claude:', error);
      });
    }
  );

  // Activate deferred Claude resume when terminal becomes active
  // This is triggered by the renderer when a terminal with pendingCLIResume becomes the active tab
  ipcMain.on(
    IPC_CHANNELS.TERMINAL_ACTIVATE_DEFERRED_RESUME,
    (_, id: string) => {
      terminalManager.activateDeferredResume(id).catch((error) => {
        console.warn('[terminal-handlers] Failed to activate deferred resume:', error);
      });
    }
  );

  // Get available session dates for a project
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_GET_SESSION_DATES,
    async (_, projectPath?: string, cli?: SupportedCLI) => {
      try {
        const dates = terminalManager.getAvailableSessionDates(projectPath, cli);
        return { success: true, data: dates };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get session dates'
        };
      }
    }
  );

  // Get sessions for a specific date and project
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_GET_SESSIONS_FOR_DATE,
    async (_, date: string, projectPath: string, cli?: SupportedCLI) => {
      try {
        const sessions = terminalManager.getSessionsForDate(date, projectPath, cli);
        return { success: true, data: sessions };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get sessions for date'
        };
      }
    }
  );

  // Restore all sessions from a specific date
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_RESTORE_FROM_DATE,
    async (_, date: string, projectPath: string, cols?: number, rows?: number, cli?: SupportedCLI) => {
      try {
        const result = await terminalManager.restoreSessionsFromDate(
          date,
          projectPath,
          cols || 80,
          rows || 24,
          cli
        );
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to restore sessions from date'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_GET_NATIVE_CLI_HISTORY,
    async (_, cli: SupportedCLI, projectPath?: string): Promise<IPCResult<NativeCliSession[]>> => {
      try {
        if (cli === 'codex') {
          return { success: true, data: getCodexNativeHistory(projectPath) };
        }
        if (cli === 'claude-code') {
          return { success: true, data: getClaudeNativeHistory(projectPath) };
        }
        if (cli === 'deepseek' && projectPath) {
          const sessions = terminalManager
            .getAvailableSessionDates(projectPath, 'deepseek')
            .flatMap((dateInfo) => terminalManager.getSessionsForDate(dateInfo.date, projectPath, 'deepseek'));
          return { success: true, data: deepSeekSessionsToNativeHistory(sessions) };
        }
        return { success: true, data: [] };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get native CLI history'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_RESUME_NATIVE_CLI_SESSION,
    async (_, terminalId: string, cli: SupportedCLI, sessionId: string, cwd?: string): Promise<IPCResult> => {
      try {
        return await terminalManager.resumeNativeCliSession(terminalId, cli, sessionId, cwd);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to resume native CLI session'
        };
      }
    }
  );

  // Check if a terminal's PTY process is alive
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_CHECK_PTY_ALIVE,
    async (_, terminalId: string): Promise<IPCResult<{ alive: boolean }>> => {
      try {
        const alive = terminalManager.isTerminalAlive(terminalId);
        return { success: true, data: { alive } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check terminal status'
        };
      }
    }
  );

  // Update terminal display orders after drag-drop reorder
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_UPDATE_DISPLAY_ORDERS,
    async (
      _,
      projectPath: string,
      orders: Array<{ terminalId: string; displayOrder: number }>
    ): Promise<IPCResult> => {
      try {
        terminalManager.updateDisplayOrders(projectPath, orders);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update display orders'
        };
      }
    }
  );
}

/**
 * Initialize usage monitor event forwarding to renderer process
 * Call this after mainWindow is created
 */
export function initializeUsageMonitorForwarding(mainWindow: BrowserWindow): void {
  const monitor = getUsageMonitor();

  // Forward usage updates to renderer
  monitor.on('usage-updated', (usage: ClaudeUsageSnapshot) => {
    mainWindow.webContents.send(IPC_CHANNELS.USAGE_UPDATED, usage);
  });

  // Forward all profiles usage updates to renderer (for multi-profile display)
  monitor.on('all-profiles-usage-updated', (allProfilesUsage: AllProfilesUsage) => {
    mainWindow.webContents.send(IPC_CHANNELS.ALL_PROFILES_USAGE_UPDATED, allProfilesUsage);
  });

  // Forward proactive swap notifications to renderer
  monitor.on('show-swap-notification', (notification: unknown) => {
    mainWindow.webContents.send(IPC_CHANNELS.PROACTIVE_SWAP_NOTIFICATION, notification);
  });
}
