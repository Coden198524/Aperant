import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { startCodexOAuthFlow, getCodexAuthState, clearCodexAuth } from '../ai/auth/codex-oauth';
import { isWindows } from '../platform';
import type { IPCResult } from '../../shared/types';
import type { CodexCliVersionInfo } from '../../shared/types/cli';

const execFileAsync = promisify(execFile);

async function runCodexVersion(): Promise<{ version: string; path?: string }> {
  let stdout = '';

  if (isWindows()) {
    const cmdExe = process.env.ComSpec || 'cmd.exe';
    const result = await execFileAsync(cmdExe, ['/d', '/s', '/c', 'codex --version'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    stdout = result.stdout;
  } else {
    const result = await execFileAsync('codex', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    stdout = result.stdout;
  }

  const output = String(stdout).trim();
  const versionMatch = output.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
  const version = versionMatch ? versionMatch[1] : output.split('\n')[0] || 'unknown';
  const path = await findCodexPath();
  return { version, path };
}

async function findCodexPath(): Promise<string | undefined> {
  try {
    if (isWindows()) {
      const result = await execFileAsync('where', ['codex'], {
        encoding: 'utf-8',
        timeout: 3000,
        windowsHide: true,
      });
      return String(result.stdout).split(/\r?\n/).find(Boolean)?.trim();
    }

    const result = await execFileAsync('which', ['codex'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    });
    return String(result.stdout).split(/\r?\n/).find(Boolean)?.trim();
  } catch {
    return undefined;
  }
}

export function registerCodexAuthHandlers(): void {
  ipcMain.handle('codex-cli-check-version', async (): Promise<IPCResult<CodexCliVersionInfo>> => {
    try {
      const { version, path } = await runCodexVersion();
      return {
        success: true,
        data: {
          installed: version,
          path,
          detectionResult: {
            found: true,
            path,
            version,
            source: 'system-path',
            message: `Codex CLI found${path ? ` at ${path}` : ''}`,
          },
        },
      };
    } catch (error) {
      return {
        success: true,
        data: {
          installed: null,
          detectionResult: {
            found: false,
            source: 'system-path',
            message: error instanceof Error ? error.message : 'Codex CLI not found',
          },
        },
      };
    }
  });

  ipcMain.handle('codex-auth-login', async () => {
    try {
      const result = await startCodexOAuthFlow();
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('codex-auth-status', async () => {
    try {
      const state = await getCodexAuthState();
      return { success: true, data: state };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('codex-auth-logout', async () => {
    try {
      await clearCodexAuth();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });
}
