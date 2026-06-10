/**
 * Desktop platform entry point.
 *
 * Pure platform/path helpers live in @autocode/core so CLI/VS Code/desktop use
 * the same OS and executable discovery rules. Desktop keeps process lifecycle
 * control here because it owns the host ChildProcess instances.
 */

import { spawn, type ChildProcess } from 'child_process';
import { isWindows } from '@autocode/core/platform/os';
import { getTaskkillExePath } from '../utils/windows-paths';

export {
  findExecutable,
  getBinaryDirectories,
  getClaudeExecutablePath,
  getCurrentOS,
  getEnvVar,
  getExecutableExtension,
  getGitExecutablePath,
  getHomebrewPath,
  getNodeExecutablePath,
  getNpmCommand,
  getNpxCommand,
  getOllamaExecutablePaths,
  getOllamaInstallCommand,
  getPathConfig,
  getPathDelimiter,
  getPlatformDescription,
  getPythonCommands,
  getPythonPaths,
  getShellConfig,
  getWhichCommand,
  getWindowsShellPaths,
  getWindowsToolPath,
  isLinux,
  isMacOS,
  isSecurePath,
  isUnix,
  isWindows,
  joinPaths,
  normalizePath,
  requiresShell,
  withExecutableExtension,
} from '@autocode/core/platform/os';

export {
  OS,
  ShellType,
  type BinaryDirectories,
  type ExecutableConfig,
  type PathConfig,
  type ShellConfig,
  type ToolDetectionResult,
} from '@autocode/core/platform/types';

export const GRACEFUL_KILL_TIMEOUT_MS = 5000;

export interface KillProcessOptions {
  timeoutMs?: number;
  debugPrefix?: string;
  debug?: boolean;
}

export function killProcessGracefully(
  childProcess: ChildProcess,
  options: KillProcessOptions = {}
): void {
  const {
    timeoutMs = GRACEFUL_KILL_TIMEOUT_MS,
    debugPrefix = '[ProcessKill]',
    debug = false,
  } = options;

  const pid = childProcess.pid;
  const log = (...args: unknown[]) => {
    if (debug) console.warn(debugPrefix, ...args);
  };

  let hasExited = false;
  let forceKillTimer: NodeJS.Timeout | null = null;

  const cleanup = () => {
    hasExited = true;
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  if (typeof childProcess.once === 'function') {
    childProcess.once('exit', cleanup);
    childProcess.once('error', cleanup);
  } else {
    log('process.once unavailable, cannot track exit state');
  }

  try {
    if (isWindows()) {
      childProcess.kill();
    } else {
      childProcess.kill('SIGTERM');
    }
    log('Graceful kill signal sent');
  } catch (err) {
    log('Graceful kill failed (process likely dead):',
      err instanceof Error ? err.message : String(err));
  }

  if (pid) {
    forceKillTimer = setTimeout(() => {
      if (hasExited) {
        log('Process already exited, skipping force kill');
        return;
      }

      try {
        if (isWindows()) {
          log('Running taskkill for PID:', pid);
          spawn(getTaskkillExePath(), ['/pid', pid.toString(), '/f', '/t'], {
            stdio: 'ignore',
            detached: true,
          }).unref();
        } else if (!childProcess.killed) {
          log('Sending SIGKILL to PID:', pid);
          childProcess.kill('SIGKILL');
        }
      } catch (err) {
        log('Force kill failed:',
          err instanceof Error ? err.message : String(err));
      }
    }, timeoutMs);

    forceKillTimer.unref();
  }
}
