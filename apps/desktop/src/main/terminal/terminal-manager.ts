/**
 * Terminal Manager
 * Main orchestrator for terminal lifecycle, Claude integration, and profile management
 */

import type { TerminalCreateOptions } from '../../shared/types';
import type { TerminalSession } from '../terminal-session-store';
import { IPC_CHANNELS } from '../../shared/constants';

// Internal modules
import type {
  TerminalProcess,
  WindowGetter,
  TerminalOperationResult,
  TerminalProfileChangeInfo,
} from './types';
import * as PtyManager from './pty-manager';
import * as SessionHandler from './session-handler';
import * as TerminalLifecycle from './terminal-lifecycle';
import * as TerminalEventHandler from './terminal-event-handler';
import * as ClaudeIntegration from './cli-integration-handler';
import * as DeepSeekCliSession from './deepseek-cli-session';
import { isDeepSeekStoredSession } from './deepseek-history';
import { projectStore } from '../project-store';
import { safeSendToRenderer } from '../ipc-handlers/utils';
import { debugLog, debugError } from '../../shared/utils/debug-logger';

export class TerminalManager {
  private terminals: Map<string, TerminalProcess> = new Map();
  private getWindow: WindowGetter;
  private saveTimer: NodeJS.Timeout | null = null;
  private lastNotifiedRateLimitReset: Map<string, string> = new Map();
  private eventCallbacks: TerminalEventHandler.EventHandlerCallbacks;
  /** Server-side storage for YOLO mode flags during profile migration (sessionId → flag) */
  private migratedSessionFlags: Map<string, boolean> = new Map();

  constructor(getWindow: WindowGetter) {
    this.getWindow = getWindow;

    // Create event callbacks with bound context
    this.eventCallbacks = TerminalEventHandler.createEventCallbacks(
      this.getWindow,
      this.lastNotifiedRateLimitReset,
      async (terminalId, profileId) => {
        await this.switchClaudeProfile(terminalId, profileId);
      }
    );

    // Periodically save session data (every 30 seconds)
    this.saveTimer = setInterval(() => {
      SessionHandler.persistAllSessionsAsync(this.terminals).catch((error) => {
        console.error('[TerminalManager] Failed to persist sessions:', error);
      });
    }, 30000);
  }

  /**
   * Create a new terminal process
   */
  async create(
    options: TerminalCreateOptions & { projectPath?: string }
  ): Promise<TerminalOperationResult> {
    return TerminalLifecycle.createTerminal(
      options,
      this.terminals,
      this.getWindow,
      (terminal, data) => this.handleTerminalData(terminal, data)
    );
  }

  /**
   * Restore a terminal session
   */
  async restore(
    session: TerminalSession,
    cols = 80,
    rows = 24
  ): Promise<TerminalOperationResult> {
    return TerminalLifecycle.restoreTerminal(
      session,
      this.terminals,
      this.getWindow,
      (terminal, data) => this.handleTerminalData(terminal, data),
      {
        resumeClaudeSession: true,
        captureSessionId: (terminalId, projectPath, startTime) => {
          SessionHandler.captureClaudeSessionId(
            terminalId,
            projectPath,
            startTime,
            this.terminals,
            this.getWindow
          );
        },
        onResumeNeeded: (terminalId, sessionId) => {
          // Use async version to avoid blocking main process
          this.resumeClaudeAsync(terminalId, sessionId).catch((error) => {
            debugError('[terminal-manager] Failed to resume Claude session:', error);
          });
        }
      },
      cols,
      rows
    );
  }

  /**
   * Destroy a terminal process
   */
  async destroy(id: string): Promise<TerminalOperationResult> {
    DeepSeekCliSession.disposeDeepSeekCli(id);
    return TerminalLifecycle.destroyTerminal(
      id,
      this.terminals,
      (terminalId) => {
        this.lastNotifiedRateLimitReset.delete(terminalId);
      }
    );
  }

  /**
   * Kill all terminal processes
   */
  async killAll(): Promise<void> {
    this.migratedSessionFlags.clear();
    for (const terminalId of this.terminals.keys()) {
      DeepSeekCliSession.disposeDeepSeekCli(terminalId);
    }
    this.saveTimer = await TerminalLifecycle.destroyAllTerminals(
      this.terminals,
      this.saveTimer
    );
  }

  /**
   * Send input to a terminal
   */
  write(id: string, data: string): void {
    debugLog('[TerminalManager:write] Writing to terminal:', id, 'data length:', data.length);
    const terminal = this.terminals.get(id);
    if (terminal) {
      if (DeepSeekCliSession.handleDeepSeekInput(terminal, data, this.getWindow)) {
        return;
      }
      debugLog('[TerminalManager:write] Terminal found, calling writeToPty...');
      PtyManager.writeToPty(terminal, data);
      debugLog('[TerminalManager:write] writeToPty completed');
    } else {
      debugError('[TerminalManager:write] Terminal NOT found:', id);
    }
  }

  /**
   * Resize a terminal
   * @returns true if resize was successful, false otherwise
   */
  resize(id: string, cols: number, rows: number): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return false;
    }
    return PtyManager.resizePty(terminal, cols, rows);
  }

  /**
   * Invoke Claude in a terminal with optional profile override (async - non-blocking)
   */
  async invokeCLIAsync(id: string, cwd?: string, profileId?: string, dangerouslySkipPermissions?: boolean, cliOverride?: import('../../shared/types/settings').SupportedCLI): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return;
    }

    const settings = cliOverride ? undefined : await import('../settings-utils').then(m => m.readSettingsFileAsync());
    const projectPreferredCLI = terminal.projectPath
      ? projectStore.getProjects().find((project) => project.path === terminal.projectPath)?.settings?.preferredCLI
      : undefined;
    const selectedCLI = cliOverride || projectPreferredCLI || (settings?.preferredCLI as import('../../shared/types/settings').SupportedCLI | undefined) || 'claude-code';
    if (selectedCLI === 'deepseek') {
      DeepSeekCliSession.startDeepSeekCli(terminal, cwd, this.getWindow);
      return;
    }

    await ClaudeIntegration.invokeCLIAsync(
      terminal,
      cwd,
      profileId,
      this.getWindow,
      (terminalId, projectPath, startTime) => {
        SessionHandler.captureClaudeSessionId(
          terminalId,
          projectPath,
          startTime,
          this.terminals,
          this.getWindow
        );
      },
      dangerouslySkipPermissions,
      cliOverride
    );
  }

  /**
   * Invoke Claude in a terminal with optional profile override
   * @deprecated Use invokeCLIAsync for non-blocking behavior
   */
  invokeClaude(id: string, cwd?: string, profileId?: string, dangerouslySkipPermissions?: boolean): void {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return;
    }

    ClaudeIntegration.invokeClaude(
      terminal,
      cwd,
      profileId,
      this.getWindow,
      (terminalId, projectPath, startTime) => {
        SessionHandler.captureClaudeSessionId(
          terminalId,
          projectPath,
          startTime,
          this.terminals,
          this.getWindow
        );
      },
      dangerouslySkipPermissions
    );
  }

  /**
   * Switch a terminal to a different Claude profile
   */
  async switchClaudeProfile(id: string, profileId: string): Promise<TerminalOperationResult> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return { success: false, error: 'Terminal not found' };
    }

    return ClaudeIntegration.switchClaudeProfile(
      terminal,
      profileId,
      this.getWindow,
      async (terminalId, cwd, profileId, dangerouslySkipPermissions) => this.invokeCLIAsync(terminalId, cwd, profileId, dangerouslySkipPermissions),
      (terminalId) => this.lastNotifiedRateLimitReset.delete(terminalId)
    );
  }

  /**
   * Resume Claude in a terminal asynchronously (non-blocking)
   */
  async resumeClaudeAsync(id: string, sessionId?: string, options?: { migratedSession?: boolean }): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      // Clean up stale migratedSessionFlags if terminal no longer exists
      if (options?.migratedSession && sessionId) {
        this.migratedSessionFlags.delete(sessionId);
      }
      return;
    }

    // For migrated sessions, restore YOLO mode from server-side storage
    // (set during profile change in storeMigratedSessionFlag)
    if (options?.migratedSession && sessionId) {
      const storedFlag = this.migratedSessionFlags.get(sessionId);
      if (storedFlag !== undefined) {
        terminal.dangerouslySkipPermissions = storedFlag;
        this.migratedSessionFlags.delete(sessionId);
      }
    }

    await ClaudeIntegration.resumeClaudeAsync(terminal, sessionId, this.getWindow, options);
  }

  async resumeNativeCliSession(
    id: string,
    cli: import('../../shared/types/settings').SupportedCLI,
    sessionId: string,
    cwd?: string
  ): Promise<TerminalOperationResult> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return { success: false, error: 'Terminal not found' };
    }

    if (cli === 'deepseek') {
      const projectPath = cwd || terminal.projectPath || terminal.cwd;
      const savedSession = projectPath
        ? this.findDeepSeekSession(projectPath, sessionId)
        : undefined;

      if (!savedSession || !isDeepSeekStoredSession(savedSession)) {
        return { success: false, error: 'DeepSeek session not found' };
      }

      terminal.isCLIMode = true;
      terminal.activeCLI = 'deepseek';
      terminal.deepseekState = savedSession.deepseekState;
      terminal.outputBuffer = savedSession.outputBuffer || '';
      terminal.title = 'DeepSeek';
      if (savedSession.outputBuffer) {
        safeSendToRenderer(this.getWindow, IPC_CHANNELS.TERMINAL_OUTPUT, terminal.id, savedSession.outputBuffer);
      }
      DeepSeekCliSession.startDeepSeekCli(terminal, savedSession.cwd || projectPath, this.getWindow);
      return { success: true, outputBuffer: savedSession.outputBuffer || '' };
    }

    const settings = await import('../settings-utils').then(m => m.readSettingsFileAsync());
    const dangerouslySkipPermissions = settings?.dangerouslySkipPermissions === true;

    const cwdCommand = (await import('../../shared/utils/shell-escape')).buildCdCommand(cwd || terminal.projectPath || terminal.cwd, terminal.shellType);
    const cliCommand = ClaudeIntegration.getCLICommand(cli, settings?.customCLIPath as string | undefined, dangerouslySkipPermissions);
    const resumeCommand = cli === 'claude-code'
      ? `${cliCommand} --resume ${sessionId}`
      : `${cliCommand} resume ${sessionId}`;

    terminal.isCLIMode = true;
    terminal.activeCLI = cli;
    terminal.dangerouslySkipPermissions = dangerouslySkipPermissions;
    terminal.claudeSessionId = cli === 'claude-code' ? sessionId : undefined;
    terminal.outputBuffer = '';
    if (cli === 'claude-code') {
      terminal.title = 'Claude';
    } else if (cli === 'codex') {
      terminal.title = 'Codex';
    }

    const command = cwdCommand ? `${cwdCommand}${resumeCommand}` : resumeCommand;
    PtyManager.writeToPty(terminal, `${command}\r`);

    if (terminal.projectPath) {
      SessionHandler.persistSessionAsync(terminal);
    }

    return { success: true };
  }

  private findDeepSeekSession(projectPath: string, sessionId: string): TerminalSession | undefined {
    const savedSession = SessionHandler.getSavedSessions(projectPath, 'deepseek')
      .find(session => session.id === sessionId);
    if (savedSession && isDeepSeekStoredSession(savedSession)) {
      return savedSession;
    }

    return SessionHandler.getAvailableSessionDates(projectPath, 'deepseek')
      .flatMap((dateInfo) => SessionHandler.getSessionsForDate(dateInfo.date, projectPath, 'deepseek'))
      .find(session => session.id === sessionId && isDeepSeekStoredSession(session));
  }

  /**
   * Store YOLO mode flag for a session being migrated during profile swap.
   * Called from the profile change handler before the renderer recreates terminals.
   * The flag is consumed by resumeClaudeAsync when the new terminal resumes.
   */
  storeMigratedSessionFlag(sessionId: string, dangerouslySkipPermissions: boolean): void {
    this.migratedSessionFlags.set(sessionId, dangerouslySkipPermissions);
  }

  /**
   * Activate deferred Claude resume for a terminal
   * Called when a terminal with pendingCLIResume becomes active (user views it)
   */
  async activateDeferredResume(id: string): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return;
    }

    // Check if terminal has a pending resume
    if (!terminal.pendingCLIResume) {
      return;
    }

    // Clear the pending flag
    terminal.pendingCLIResume = false;

    // Now actually resume Claude
    await ClaudeIntegration.resumeClaudeAsync(terminal, undefined, this.getWindow);
  }

  /**
   * Resume Claude in a terminal with a specific session ID
   * @deprecated Use resumeClaudeAsync for non-blocking behavior
   */
  resumeClaude(id: string, sessionId?: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return;
    }

    ClaudeIntegration.resumeClaude(terminal, sessionId, this.getWindow);
  }

  /**
   * Get saved sessions for a project
   */
  getSavedSessions(projectPath: string, cli?: import('../../shared/types/settings').SupportedCLI): TerminalSession[] {
    return SessionHandler.getSavedSessions(projectPath, cli);
  }

  /**
   * Clear saved sessions for a project
   */
  clearSavedSessions(projectPath: string): void {
    SessionHandler.clearSavedSessions(projectPath);
  }

  /**
   * Get available session dates
   */
  getAvailableSessionDates(projectPath?: string, cli?: import('../../shared/types/settings').SupportedCLI): import('../terminal-session-store').SessionDateInfo[] {
    return SessionHandler.getAvailableSessionDates(projectPath, cli);
  }

  /**
   * Get sessions for a specific date
   */
  getSessionsForDate(date: string, projectPath: string, cli?: import('../../shared/types/settings').SupportedCLI): TerminalSession[] {
    return SessionHandler.getSessionsForDate(date, projectPath, cli);
  }

  /**
   * Update display orders for terminals after drag-drop reorder
   */
  updateDisplayOrders(
    projectPath: string,
    orders: Array<{ terminalId: string; displayOrder: number }>
  ): void {
    SessionHandler.updateDisplayOrders(projectPath, orders);
  }

  /**
   * Restore all sessions from a specific date
   */
  async restoreSessionsFromDate(
    date: string,
    projectPath: string,
    cols = 80,
    rows = 24,
    cli?: import('../../shared/types/settings').SupportedCLI
  ): Promise<{ restored: number; failed: number; sessions: Array<{ id: string; success: boolean; error?: string }> }> {
    return TerminalLifecycle.restoreSessionsFromDate(
      date,
      projectPath,
      this.terminals,
      this.getWindow,
      (terminal, data) => this.handleTerminalData(terminal, data),
      {
        resumeClaudeSession: true,
        captureSessionId: (terminalId, projectPath, startTime) => {
          SessionHandler.captureClaudeSessionId(
            terminalId,
            projectPath,
            startTime,
            this.terminals,
            this.getWindow
          );
        },
        onResumeNeeded: (terminalId, sessionId) => {
          // Use async version to avoid blocking main process
          this.resumeClaudeAsync(terminalId, sessionId).catch((error) => {
            debugError('[terminal-manager] Failed to resume Claude session:', error);
          });
        }
      },
      cols,
      rows,
      cli
    );
  }

  /**
   * Get all active terminal IDs
   */
  getActiveTerminalIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Get a terminal by ID (for debugging/inspection)
   */
  getTerminal(id: string): TerminalProcess | undefined {
    return this.terminals.get(id);
  }

  /**
   * Check if a terminal is in Claude mode
   */
  isCLIMode(id: string): boolean {
    const terminal = this.terminals.get(id);
    return terminal?.isCLIMode ?? false;
  }

  /**
   * Get Claude session ID for a terminal
   */
  getClaudeSessionId(id: string): string | undefined {
    const terminal = this.terminals.get(id);
    return terminal?.claudeSessionId;
  }

  /**
   * Get info about all terminals for profile change operations.
   * Returns info needed to migrate sessions and notify frontend.
   */
  getTerminalsForProfileChange(): TerminalProfileChangeInfo[] {
    const result: TerminalProfileChangeInfo[] = [];

    for (const [id, terminal] of this.terminals) {
      result.push({
        id,
        cwd: terminal.cwd,
        projectPath: terminal.projectPath,
        claudeSessionId: terminal.claudeSessionId,
        claudeProfileId: terminal.claudeProfileId,
        isCLIMode: terminal.isCLIMode,
        dangerouslySkipPermissions: terminal.dangerouslySkipPermissions
      });
    }

    return result;
  }

  /**
   * Update terminal title
   */
  setTitle(id: string, title: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.title = title;
    }
  }

  /**
   * Update terminal worktree config
   */
  setWorktreeConfig(id: string, config: import('../../shared/types').TerminalWorktreeConfig | undefined): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.worktreeConfig = config;
      // Persist immediately when worktree config changes (async to avoid blocking)
      if (terminal.projectPath) {
        SessionHandler.persistSessionAsync(terminal);
      }
    }
  }

  /**
   * Check if a terminal's PTY process is alive
   */
  isTerminalAlive(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /**
   * Handle terminal data output
   */
  private handleTerminalData(terminal: TerminalProcess, data: string): void {
    TerminalEventHandler.handleTerminalData(terminal, data, this.eventCallbacks);
  }
}
