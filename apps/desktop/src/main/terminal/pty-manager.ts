/**
 * PTY Manager Module
 * Handles low-level PTY process creation and lifecycle
 */

import * as pty from '@lydell/node-pty';
import * as os from 'os';
import { existsSync } from 'fs';
import type { Socket } from 'node:net';
import type { Worker } from 'node:worker_threads';
import type { TerminalProcess, WindowGetter, WindowsShellType } from './types';
import { isWindows, getWindowsShellPaths } from '../platform';
import { IPC_CHANNELS } from '../../shared/constants';
import { safeSendToRenderer } from '../ipc-handlers/utils';
import { readSettingsFile } from '../settings-utils';
import { debugLog, debugError } from '../../shared/utils/debug-logger';
import type { SupportedTerminal } from '../../shared/types/settings';
import log from 'electron-log/main.js';

// Windows shell paths are now imported from the platform module via getWindowsShellPaths()

/**
 * Shutdown flag to prevent PTY handlers from accessing destroyed resources
 * (e.g., BrowserWindow.webContents) during app shutdown.
 * Follows the same pattern as isShuttingDown in pty-daemon-client.ts.
 *
 * Part of the shutdown guard pattern for GitHub issue #1469: without this flag,
 * PTY onData/onExit callbacks can fire after BrowserWindow is destroyed,
 * causing pty.node's native ThreadSafeFunction to SIGABRT.
 */
let isShuttingDown = false;

/**
 * Set the shutting down flag. Call this during app quit/before-quit
 * to prevent PTY handlers from accessing destroyed resources.
 */
export function setShuttingDown(value: boolean): void {
  isShuttingDown = value;
}

/**
 * Check if the PTY manager is in shutting down state.
 */
export function getIsShuttingDown(): boolean {
  return isShuttingDown;
}

/**
 * Result of spawning a PTY process
 */
export interface SpawnPtyResult {
  pty: pty.IPty;
  /** Shell type for Windows (affects command chaining syntax) */
  shellType?: WindowsShellType;
}

/**
 * Result of Windows shell detection
 */
interface WindowsShellResult {
  shell: string;
  shellType: WindowsShellType;
}

/**
 * Track pending exit promises for terminals being destroyed.
 * Used to wait for PTY process exit on Windows where termination is async.
 */
const pendingExitPromises = new Map<string, {
  resolve: () => void;
  timeoutId: NodeJS.Timeout;
}>();

/**
 * Private Windows shape shared by @lydell/node-pty 1.1.x and 1.2.x.
 *
 * Both releases defer public operations, including kill(), until the first PTY
 * data event. A terminal closed between spawn and its first output can therefore
 * retain the native ConPTY callback and worker beyond Electron's environment
 * lifetime. Keep this compatibility type local to the Windows shutdown path.
 */
interface InternalWindowsPtyAgent {
  exitCode: number | undefined;
  innerPid: number;
  outSocket: Socket;
  _inSocket: Socket;
  _pty: unknown;
  _ptyNative: {
    kill: (ptyHandle: unknown, useConptyDll?: boolean) => void;
  };
  _useConptyDll?: boolean;
  _pendingPtyInfo?: unknown;
  _getConsoleProcessList: () => Promise<number[]>;
  _conoutSocketWorker: {
    _worker: Worker;
    dispose: () => void;
  };
}

interface InternalWindowsPty extends pty.IPty {
  _isReady: boolean;
  _deferreds: Array<{ run: () => void }>;
  _agent: InternalWindowsPtyAgent;
  _close: () => void;
}

/**
 * Deduplicate concurrent destroy/quit calls for the same native PTY.
 */
const windowsPtyShutdowns = new WeakMap<object, Promise<void>>();

/**
 * Default timeouts for waiting for PTY exit (in milliseconds).
 * Windows needs longer timeout due to slower process termination.
 *
 * @lydell/node-pty's Windows kill path can spend up to 5 seconds querying the
 * console process list, then another 1 second flushing ConPTY output before its
 * onExit callback fires. Keep a safety margin beyond that native lifecycle so
 * Electron never tears down while the callback is still pending.
 */
const PTY_EXIT_TIMEOUT_WINDOWS = 8000;
const PTY_EXIT_TIMEOUT_UNIX = 500;

function resolvePendingPtyExit(terminalId: string): void {
  const pendingExit = pendingExitPromises.get(terminalId);
  if (!pendingExit) return;

  clearTimeout(pendingExit.timeoutId);
  pendingExitPromises.delete(terminalId);
  pendingExit.resolve();
}

function isInternalWindowsPty(ptyProcess: pty.IPty): ptyProcess is InternalWindowsPty {
  if (!isWindows()) return false;

  const candidate = ptyProcess as Partial<InternalWindowsPty>;
  const agent = candidate._agent as Partial<InternalWindowsPtyAgent> | undefined;
  const conoutWorker = agent?._conoutSocketWorker;

  return (
    typeof candidate._isReady === 'boolean'
    && Array.isArray(candidate._deferreds)
    && typeof candidate._close === 'function'
    && typeof agent === 'object'
    && typeof agent._getConsoleProcessList === 'function'
    && typeof agent._ptyNative?.kill === 'function'
    && typeof agent.outSocket?.once === 'function'
    && typeof agent._inSocket?.destroy === 'function'
    && typeof conoutWorker?.dispose === 'function'
    && typeof conoutWorker._worker?.once === 'function'
    && (agent._useConptyDll === undefined || typeof agent._useConptyDll === 'boolean')
  );
}

function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const onClose = (): void => {
      resolve();
    };
    socket.once('close', onClose);

    // Cover a close between the initial check and listener registration.
    if (socket.destroyed) {
      socket.off('close', onClose);
      resolve();
    }
  });
}

function waitForWorkerExit(worker: Worker): Promise<void> {
  if (worker.threadId === -1) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const onExit = (): void => {
      resolve();
    };
    worker.once('exit', onExit);

    // Cover an exit between the initial check and listener registration.
    if (worker.threadId === -1) {
      worker.off('exit', onExit);
      resolve();
    }
  });
}

function waitForNativePtyExit(agent: InternalWindowsPtyAgent): Promise<void> {
  if (agent.exitCode !== undefined) return Promise.resolve();

  // node-pty 1.1.x does not expose its native process-exit callback as an
  // event. Polling this private field keeps the Electron environment alive
  // until that callback has actually run, even if the output socket closes
  // earlier when the ConPTY worker is disposed.
  return new Promise<void>((resolve) => {
    const intervalId = setInterval(() => {
      if (agent.exitCode === undefined) return;
      clearInterval(intervalId);
      resolve();
    }, 10);
  });
}

async function requestInternalWindowsPtyTermination(agent: InternalWindowsPtyAgent): Promise<void> {
  // node-pty 1.2 defers the native connect until its output worker is ready.
  // Cancel that connection before the first await so it cannot create a child
  // after shutdown has already started.
  if (agent._pendingPtyInfo !== undefined) {
    agent._pendingPtyInfo = undefined;
  }

  let processIds: number[];
  try {
    // This private method has its own five-second fallback. Await it here
    // instead of using agent.kill(), whose untracked .then() can otherwise run
    // after Electron has already torn down the JavaScript environment.
    processIds = await agent._getConsoleProcessList();
  } catch (error) {
    debugError('[PtyManager] Failed to query legacy Windows PTY process list:', error);
    processIds = [agent.innerPid];
  }

  try {
    if (agent.exitCode === undefined) {
      for (const processId of processIds) {
        if (!Number.isInteger(processId) || processId <= 0 || processId === process.pid) continue;
        try {
          process.kill(processId);
        } catch {
          // The process may already have exited.
        }
      }

      // Close the native pseudoconsole only after process discovery completes.
      // Keeping the output worker alive until this point avoids a ConPTY output
      // drain deadlock while ClosePseudoConsole runs.
      if (agent._useConptyDll === undefined) {
        agent._ptyNative.kill(agent._pty);
      } else {
        agent._ptyNative.kill(agent._pty, agent._useConptyDll);
      }
    }
  } finally {
    // dispose() drains output for one second and asynchronously terminates its
    // worker. shutdownInternalWindowsPty() explicitly waits for that worker.
    agent._conoutSocketWorker.dispose();
  }
}

async function shutdownInternalWindowsPty(
  terminal: TerminalProcess,
  ptyProcess: InternalWindowsPty,
): Promise<void> {
  const existingShutdown = windowsPtyShutdowns.get(ptyProcess);
  if (existingShutdown) return existingShutdown;

  const shutdown = (async (): Promise<void> => {
    const { _agent: agent } = ptyProcess;
    const connectionWasPending = agent._pendingPtyInfo !== undefined;
    const socketClosed = waitForSocketClose(agent.outSocket);
    const workerExited = waitForWorkerExit(agent._conoutSocketWorker._worker);
    // A 1.2 PTY killed before its deferred native connect has no registered
    // native exit callback. Closing its pseudoconsole is the terminal native
    // action; the worker and sockets below are still awaited explicitly.
    const nativeExited = connectionWasPending ? Promise.resolve() : waitForNativePtyExit(agent);

    // Drop queued writes/resizes/kill calls. In node-pty 1.1.x they can never
    // run if the shell has not produced its first data event.
    ptyProcess._deferreds.length = 0;
    ptyProcess._close();

    log.info(
      '[PtyManager] Closing Windows PTY:',
      terminal.id,
      'pid:',
      terminal.pty.pid,
      'ready:',
      ptyProcess._isReady,
    );

    if (agent.exitCode === undefined) {
      await requestInternalWindowsPtyTermination(agent);
    } else {
      agent._conoutSocketWorker.dispose();
    }

    // Do not treat a wall-clock timeout as successful native cleanup. The
    // native callback and worker can both call into Node/Electron and must be
    // gone first. If node-pty leaves an unconnected output socket open, close
    // it only after the drain worker has exited.
    await Promise.all([nativeExited, workerExited]);
    if (!agent.outSocket.destroyed) {
      agent.outSocket.destroy();
    }
    await socketClosed;

    agent._inSocket.destroy();
    terminal.hasExited = true;
    pendingWrites.delete(terminal.id);
    resolvePendingPtyExit(terminal.id);

    log.info('[PtyManager] Windows PTY shutdown complete:', terminal.id);
  })();

  windowsPtyShutdowns.set(ptyProcess, shutdown);
  try {
    await shutdown;
  } finally {
    windowsPtyShutdowns.delete(ptyProcess);
  }
}

/**
 * Wait for a PTY process to exit.
 * Returns a promise that resolves when the PTY's onExit event fires.
 * Has a timeout fallback in case the exit event never fires.
 */
export function waitForPtyExit(terminalId: string, timeoutMs?: number): Promise<void> {
  const timeout = timeoutMs ?? (isWindows() ? PTY_EXIT_TIMEOUT_WINDOWS : PTY_EXIT_TIMEOUT_UNIX);

  return new Promise<void>((resolve) => {
    // Set up timeout fallback
    const timeoutId = setTimeout(() => {
      debugLog('[PtyManager] PTY exit timeout for terminal:', terminalId);
      pendingExitPromises.delete(terminalId);
      resolve();
    }, timeout);

    // Store the promise resolver
    pendingExitPromises.set(terminalId, { resolve, timeoutId });
  });
}

/**
 * Determine shell type from shell path.
 * Only PowerShell 5.1 (powershell.exe) needs special handling with ';' separator.
 * PowerShell 7+ (pwsh.exe) supports '&&' like cmd.exe.
 */
function detectShellType(shellPath: string): WindowsShellType {
  // Extract just the filename from the path
  const filename = shellPath.split(/[/\\]/).pop()?.toLowerCase() || '';
  // Only powershell.exe (PS 5.1) needs ';' separator
  // pwsh.exe (PS 7+) supports '&&' so we treat it like cmd
  if (filename === 'powershell.exe') {
    return 'powershell';
  }
  // Everything else (cmd, pwsh, bash, etc.) uses && syntax
  return 'cmd';
}

/**
 * Get the Windows shell executable based on preferred terminal setting
 */
function getWindowsShell(preferredTerminal: SupportedTerminal | undefined): WindowsShellResult {
  // If no preference or 'system', use COMSPEC (usually cmd.exe)
  if (!preferredTerminal || preferredTerminal === 'system') {
    const shell = process.env.COMSPEC || 'cmd.exe';
    return { shell, shellType: detectShellType(shell) };
  }

  // Check if we have paths defined for this terminal type (from platform module)
  const windowsShellPaths = getWindowsShellPaths();
  const paths = windowsShellPaths[preferredTerminal];
  if (paths) {
    // Find the first existing shell
    for (const shellPath of paths) {
      if (existsSync(shellPath)) {
        return { shell: shellPath, shellType: detectShellType(shellPath) };
      }
    }
  }

  // Fallback to COMSPEC for unrecognized terminals
  const shell = process.env.COMSPEC || 'cmd.exe';
  return { shell, shellType: detectShellType(shell) };
}

/**
 * Get a valid working directory, with fallbacks for edge cases.
 * In some environments (VMs, containers), os.homedir() may return invalid paths.
 */
function getValidCwd(requestedCwd: string): string {
  log.info('[PtyManager] Resolving working directory, requested:', requestedCwd);

  // Try the requested cwd first
  if (requestedCwd && existsSync(requestedCwd)) {
    log.info('[PtyManager] Using requested cwd:', requestedCwd);
    return requestedCwd;
  }

  // Try home directory
  const homeDir = os.homedir();
  log.info('[PtyManager] Requested cwd not valid, trying home directory:', homeDir);
  if (homeDir && existsSync(homeDir)) {
    log.info('[PtyManager] Using home directory:', homeDir);
    return homeDir;
  }

  // Windows fallbacks
  if (isWindows()) {
    log.warn('[PtyManager] Home directory not valid, trying Windows fallbacks');

    // Try USERPROFILE
    const userProfile = process.env.USERPROFILE;
    if (userProfile && existsSync(userProfile)) {
      log.info('[PtyManager] Using USERPROFILE:', userProfile);
      return userProfile;
    }

    // Try HOMEDRIVE + HOMEPATH
    const homeDrive = process.env.HOMEDRIVE;
    const homePath = process.env.HOMEPATH;
    if (homeDrive && homePath) {
      const combinedPath = homeDrive + homePath;
      if (existsSync(combinedPath)) {
        log.info('[PtyManager] Using HOMEDRIVE+HOMEPATH:', combinedPath);
        return combinedPath;
      }
    }

    // Last resort: C:\
    if (existsSync('C:\\')) {
      log.warn('[PtyManager] All paths failed, falling back to C:\\');
      return 'C:\\';
    }
  } else {
    // Unix fallbacks
    log.warn('[PtyManager] Home directory not valid, trying Unix fallbacks');

    // Try /tmp
    if (existsSync('/tmp')) {
      log.info('[PtyManager] Using /tmp');
      return '/tmp';
    }

    // Try /
    if (existsSync('/')) {
      log.warn('[PtyManager] All paths failed, falling back to /');
      return '/';
    }
  }

  // If all else fails, return the requested cwd and let pty.spawn fail with a clear error
  log.error('[PtyManager] All directory fallbacks failed! Requested:', requestedCwd, 'Home:', homeDir);
  return requestedCwd || homeDir;
}

/**
 * Spawn a new PTY process with appropriate shell and environment
 */
export function spawnPtyProcess(
  cwd: string,
  cols: number,
  rows: number,
  profileEnv?: Record<string, string>
): SpawnPtyResult {
  // Read user's preferred terminal setting
  const settings = readSettingsFile();
  const preferredTerminal = settings?.preferredTerminal as SupportedTerminal | undefined;

  let shell: string;
  let shellType: WindowsShellType | undefined;

  if (isWindows()) {
    const windowsShell = getWindowsShell(preferredTerminal);
    shell = windowsShell.shell;
    shellType = windowsShell.shellType;
  } else {
    shell = process.env.SHELL || '/bin/zsh';
    shellType = undefined; // Not applicable on Unix
  }

  const shellArgs = isWindows() ? [] : ['-l'];

  // Get a valid working directory with robust fallbacks
  const validCwd = getValidCwd(cwd);

  debugLog('[PtyManager] Spawning shell:', shell, shellArgs, '(preferred:', preferredTerminal || 'system', ', shellType:', shellType, ')');
  debugLog('[PtyManager] PTY dimensions requested - cols:', cols, 'rows:', rows);
  debugLog('[PtyManager] CWD - requested:', cwd, 'resolved:', validCwd);

  // Validate cwd before spawning
  if (!existsSync(validCwd)) {
    const errorMsg = `Cannot spawn PTY: working directory does not exist: ${validCwd}`;
    log.error('[PtyManager]', errorMsg);
    log.error('[PtyManager] Environment - USERPROFILE:', process.env.USERPROFILE, 'HOMEDRIVE:', process.env.HOMEDRIVE, 'HOMEPATH:', process.env.HOMEPATH);
    debugError('[PtyManager]', errorMsg);
    throw new Error(errorMsg);
  }

  // Create a clean environment without DEBUG to prevent Claude Code from
  // enabling debug mode when the Electron app is run in development mode.
  // Also remove ANTHROPIC_API_KEY so the system Claude CLI uses its normal
  // OAuth state from the user's config directory and platform credential store.
  // Remove CLAUDECODE to allow launching Claude Code inside agent terminals —
  // without this, inherited CLAUDECODE triggers the nested session guard.
  const { DEBUG: _DEBUG, ANTHROPIC_API_KEY: _ANTHROPIC_API_KEY, CLAUDECODE: _CLAUDECODE, ...cleanEnv } = process.env;

  try {
    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: validCwd,
      env: {
        ...cleanEnv,
        ...profileEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // Suppress zsh's partial line indicator (%) that appears when output
        // doesn't end with a newline. This prevents rendering artifacts in the terminal.
        PROMPT_EOL_MARK: '',
      },
    });

    log.info('[PtyManager] PTY spawned successfully, pid:', ptyProcess.pid);
    debugLog('[PtyManager] PTY spawned successfully, pid:', ptyProcess.pid);
    return { pty: ptyProcess, shellType };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error('[PtyManager] Failed to spawn PTY:', errorMsg);
    log.error('[PtyManager] Shell:', shell, 'Args:', shellArgs, 'CWD:', validCwd);
    log.error('[PtyManager] Error details:', error);
    debugError('[PtyManager] Failed to spawn PTY:', errorMsg);
    debugError('[PtyManager] Shell:', shell, 'Args:', shellArgs, 'CWD:', validCwd);
    throw new Error(`Cannot create process: ${errorMsg}`);
  }
}

/**
 * Setup PTY event handlers for a terminal process
 */
export function setupPtyHandlers(
  terminal: TerminalProcess,
  terminals: Map<string, TerminalProcess>,
  getWindow: WindowGetter,
  onDataCallback: (terminal: TerminalProcess, data: string) => void,
  onExitCallback: (terminal: TerminalProcess) => void
): void {
  const { id, pty: ptyProcess } = terminal;
  terminal.hasExited = false;

  // Handle data from terminal
  ptyProcess.onData((data) => {
    // Shutdown guard (GitHub #1469): skip processing to avoid accessing
    // destroyed BrowserWindow.webContents, which triggers pty.node SIGABRT
    if (isShuttingDown) return;
    if (terminal.hasExited) return;

    // Append to output buffer (limit to 100KB)
    terminal.outputBuffer = (terminal.outputBuffer + data).slice(-100000);

    // Call custom data handler. This must never crash the main process:
    // parser logic in higher layers can throw on unexpected output.
    try {
      onDataCallback(terminal, data);
    } catch (error) {
      debugError('[PtyManager] onData callback failed for terminal:', id, 'error:', error);
    }

    // Send to renderer with isDestroyed() check to prevent crashes
    // when the window is closed during terminal activity
    safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_OUTPUT, id, data);
  });

  // Handle terminal exit
  ptyProcess.onExit(({ exitCode }) => {
    terminal.hasExited = true;
    // Drop any queued writes for this terminal to avoid writing to dead PTYs.
    pendingWrites.delete(id);
    debugLog('[PtyManager] Terminal exited:', id, 'code:', exitCode);

    // Always resolve pending exit promises, even during shutdown
    // (needed for waitForPtyExit callers to complete)
    resolvePendingPtyExit(id);

    // Shutdown guard (GitHub #1469): skip accessing win.webContents and callbacks
    // to avoid pty.node SIGABRT from destroyed BrowserWindow resources
    if (isShuttingDown) return;

    // Send to renderer with isDestroyed() check to prevent crashes
    // when the window is closed during terminal exit
    safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_EXIT, id, exitCode);

    // Call custom exit handler. Guard against unexpected exceptions so PTY exit
    // handling remains robust and doesn't take down the main process.
    try {
      onExitCallback(terminal);
    } catch (error) {
      debugError('[PtyManager] onExit callback failed for terminal:', id, 'error:', error);
    }

    // Only delete if this is the SAME terminal object (not a newly created one with same ID).
    // This prevents a race where destroyTerminal() awaits PTY exit, a new terminal is created
    // with the same ID during the await, and then the old PTY's onExit deletes the new terminal.
    if (terminals.get(id) === terminal) {
      terminals.delete(id);
    }
  });
}

/**
 * Constants for chunked write behavior
 * CHUNKED_WRITE_THRESHOLD: Data larger than this (bytes) will be written in chunks.
 *   Set high enough that typical pastes go through as a single synchronous write.
 * CHUNK_SIZE: Size of each chunk. Larger chunks = fewer event-loop yields = less
 *   GPU pressure when many terminals are rendering simultaneously.
 *   Previous values (1000/100) caused GPU context exhaustion: a 9KB paste produced
 *   ~91 setImmediate yields, letting GPU rendering tasks from 8+ terminals pile up
 *   until ContextResult::kTransientFailure crashed the app.
 */
const CHUNKED_WRITE_THRESHOLD = 16_384;
const CHUNK_SIZE = 8_192;

/**
 * Write queue per terminal to prevent interleaving of concurrent writes.
 * Maps terminal ID to the last write Promise in the queue.
 */
const pendingWrites = new Map<string, Promise<void>>();

/**
 * Internal function to perform the actual write (chunked or direct)
 * Returns a Promise that resolves when the write is complete
 */
function performWrite(terminal: TerminalProcess, data: string): Promise<void> {
  return new Promise((resolve) => {
    if (terminal.hasExited) {
      resolve();
      return;
    }

    // For large commands, write in chunks to prevent blocking
    if (data.length > CHUNKED_WRITE_THRESHOLD) {
      debugLog('[PtyManager:writeToPty] Large write detected, using chunked write');
      let offset = 0;
      let chunkNum = 0;

      const writeChunk = () => {
        // Check if terminal is still valid before writing
        if (!terminal.pty || terminal.hasExited) {
          debugError('[PtyManager:writeToPty] Terminal PTY no longer valid, aborting chunked write');
          resolve();
          return;
        }

        if (offset >= data.length) {
          debugLog('[PtyManager:writeToPty] Chunked write completed, total chunks:', chunkNum);
          resolve();
          return;
        }

        const chunk = data.slice(offset, offset + CHUNK_SIZE);
        chunkNum++;
        try {
          terminal.pty.write(chunk);
          offset += CHUNK_SIZE;
          // Use setImmediate to yield to the event loop between chunks
          setImmediate(writeChunk);
        } catch (error) {
          debugError('[PtyManager:writeToPty] Chunked write FAILED at chunk', chunkNum, ':', error);
          resolve(); // Resolve anyway - fire-and-forget semantics
        }
      };

      // Start the chunked write after yielding
      setImmediate(writeChunk);
    } else {
      try {
        terminal.pty.write(data);
        debugLog('[PtyManager:writeToPty] Write completed successfully');
      } catch (error) {
        debugError('[PtyManager:writeToPty] Write FAILED:', error);
      }
      resolve();
    }
  });
}

/**
 * Write data to a PTY process
 * Uses setImmediate to prevent blocking the event loop on large writes.
 * Serializes writes per terminal to prevent interleaving of concurrent writes.
 */
export function writeToPty(terminal: TerminalProcess, data: string): void {
  debugLog('[PtyManager:writeToPty] About to write to pty, data length:', data.length);
  if (terminal.hasExited) {
    debugError('[PtyManager:writeToPty] Skipping write to exited terminal:', terminal.id);
    return;
  }

  // Get the previous write Promise for this terminal (if any)
  const previousWrite = pendingWrites.get(terminal.id) || Promise.resolve();

  // Chain this write after the previous one completes
  const currentWrite = previousWrite.then(() => performWrite(terminal, data));

  // Update the pending write for this terminal
  pendingWrites.set(terminal.id, currentWrite);

  // Clean up the Map entry when done to prevent memory leaks
  currentWrite.finally(() => {
    // Only clean up if this is still the latest write
    if (pendingWrites.get(terminal.id) === currentWrite) {
      pendingWrites.delete(terminal.id);
    }
  });
}

/**
 * Resize a PTY process with validation and error handling.
 * @param terminal The terminal process to resize
 * @param cols New column count
 * @param rows New row count
 * @returns true if resize was successful, false otherwise
 */
export function resizePty(terminal: TerminalProcess, cols: number, rows: number): boolean {
  if (terminal.hasExited) {
    debugError('[PtyManager] Resize skipped for exited terminal:', terminal.id);
    return false;
  }

  // Validate dimensions
  if (cols <= 0 || rows <= 0 || !Number.isFinite(cols) || !Number.isFinite(rows)) {
    debugError('[PtyManager] Invalid resize dimensions - terminal:', terminal.id, 'cols:', cols, 'rows:', rows);
    return false;
  }

  try {
    const prevCols = terminal.pty.cols;
    const prevRows = terminal.pty.rows;

    // If dimensions are unchanged, force SIGWINCH via a resize cycle.
    // On macOS/Linux, ioctl(TIOCSWINSZ) only sends SIGWINCH when size actually
    // changes. This matters after project switch: PTY persists with old dimensions,
    // terminal remounts at same size, TUI apps (Claude Code) never get SIGWINCH
    // and never redraw — leaving the terminal blank.
    if (prevCols === cols && prevRows === rows) {
      debugLog('[PtyManager] Same-dimension resize detected, forcing SIGWINCH cycle for terminal:', terminal.id);
      terminal.pty.resize(Math.max(1, cols - 1), rows);
    }

    debugLog('[PtyManager] Resizing PTY - terminal:', terminal.id, 'from:', prevCols, 'x', prevRows, 'to:', cols, 'x', rows);
    terminal.pty.resize(cols, rows);
    debugLog('[PtyManager] PTY resized - actual dimensions now:', terminal.pty.cols, 'x', terminal.pty.rows);
    return true;
  } catch (error) {
    debugError('[PtyManager] Resize failed for terminal:', terminal.id, 'error:', error);
    return false;
  }
}

/**
 * Kill a PTY process.
 * @param terminal The terminal process to kill
 * @param waitForExit If true, returns a promise that resolves when the PTY exits.
 *                    Used on Windows where PTY termination is async.
 */
export function killPty(terminal: TerminalProcess, waitForExit: true): Promise<void>;
export function killPty(terminal: TerminalProcess, waitForExit?: false): void;
export function killPty(terminal: TerminalProcess, waitForExit?: boolean): Promise<void> | void {
  if (isInternalWindowsPty(terminal.pty)) {
    const shutdown = shutdownInternalWindowsPty(terminal, terminal.pty);
    if (waitForExit) return shutdown;

    void shutdown.catch((error) => {
      debugError('[PtyManager] Windows PTY shutdown failed:', terminal.id, error);
    });
    return;
  }

  if (terminal.hasExited) {
    return waitForExit ? Promise.resolve() : undefined;
  }

  if (waitForExit) {
    const exitPromise = waitForPtyExit(terminal.id);
    try {
      terminal.pty.kill();
    } catch (error) {
      // Clean up the pending promise if kill() throws
      resolvePendingPtyExit(terminal.id);
      throw error;
    }
    return exitPromise;
  }
  terminal.pty.kill();
}
