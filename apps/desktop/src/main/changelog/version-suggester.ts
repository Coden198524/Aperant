import { spawn } from 'child_process';
import * as os from 'os';
import {
  buildAutocodeVersionBumpPrompt,
  fallbackAutocodeVersionSuggestion,
  parseAutocodeVersionSuggestionResponse,
} from '@autocode/core/changelog';
import type { GitCommit } from '../../shared/types';
import { getBestAvailableProfileEnv } from '../rate-limit-detector';

import { getAugmentedEnv } from '../env-utils';
import { isWindows, requiresShell } from '../platform';

interface VersionSuggestion {
  version: string;
  reason: string;
  bumpType: 'major' | 'minor' | 'patch';
}

/**
 * AI-powered version bump suggester using Claude SDK with haiku model
 * Analyzes commits to intelligently suggest semantic version bumps
 */
export class VersionSuggester {
  private debugEnabled: boolean;

  constructor(
    private pythonPath: string,
    private claudePath: string,
    private autoBuildSourcePath: string,
    debugEnabled: boolean
  ) {
    this.debugEnabled = debugEnabled;
  }

  private debug(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.warn('[VersionSuggester]', ...args);
    }
  }

  /**
   * Suggest version bump using AI analysis of commits
   */
  async suggestVersionBump(
    commits: GitCommit[],
    currentVersion: string
  ): Promise<VersionSuggestion> {
    this.debug('suggestVersionBump called', {
      commitCount: commits.length,
      currentVersion
    });

    // Build prompt for Claude to analyze commits
    const prompt = this.buildPrompt(commits, currentVersion);
    const script = this.createAnalysisScript(prompt);

    // Build environment
    const spawnEnv = this.buildSpawnEnvironment();

    return new Promise((resolve, _reject) => {
      // Use python3/python as fallback command (Python subprocess path removed in Vercel AI SDK migration)
      const pythonCommand = this.pythonPath || 'python3';
      const childProcess = spawn(pythonCommand, ['-c', script], {
        cwd: this.autoBuildSourcePath,
        env: spawnEnv
      });

      let output = '';
      let errorOutput = '';

      childProcess.stdout?.on('data', (data: Buffer) => {
        output += data.toString('utf-8');
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        errorOutput += data.toString('utf-8');
      });

      childProcess.on('exit', (code: number | null) => {
        if (code === 0 && output.trim()) {
          try {
            const result = this.parseAIResponse(output.trim(), currentVersion);
            this.debug('AI suggestion parsed', result);
            resolve(result);
          } catch (error) {
            this.debug('Failed to parse AI response', error);
            // Fallback to simple bump
            resolve(this.fallbackSuggestion(currentVersion));
          }
        } else {
          this.debug('AI analysis failed', { code, error: errorOutput });
          // Fallback to simple bump
          resolve(this.fallbackSuggestion(currentVersion));
        }
      });

      childProcess.on('error', (err: Error) => {
        this.debug('Process error', err);
        resolve(this.fallbackSuggestion(currentVersion));
      });
    });
  }

  /**
   * Build prompt for Claude to analyze commits and suggest version bump
   */
  private buildPrompt(commits: GitCommit[], currentVersion: string): string {
    return buildAutocodeVersionBumpPrompt(commits, currentVersion);
  }

  /**
   * Create Python script to run Claude analysis
   *
   * On Windows, .cmd/.bat files require shell=True in subprocess.run() because
   * they are batch scripts that need cmd.exe to execute, not direct executables.
   */
  private createAnalysisScript(prompt: string): string {
    // Escape the prompt for Python string literal
    const escapedPrompt = prompt
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');

    // Escape the claude path for Python string (handle Windows backslashes)
    const escapedClaudePath = this.claudePath
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');

    // Detect if this is a Windows batch file (.cmd or .bat)
    // These require shell=True in subprocess.run() because they need cmd.exe to execute
    const needsShell = requiresShell(this.claudePath);

    return `
import subprocess
import sys

# Use haiku model for fast, cost-effective analysis
prompt = "${escapedPrompt}"

try:
    # shell=${needsShell ? 'True' : 'False'} - Windows .cmd files require shell execution
    result = subprocess.run(
        ["${escapedClaudePath}", "chat", "--model", "haiku", "--prompt", prompt],
        capture_output=True,
        text=True,
        check=True,
        shell=${needsShell ? 'True' : 'False'}
    )
    print(result.stdout)
except subprocess.CalledProcessError as e:
    print(f"Error: {e.stderr}", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f"Error: {str(e)}", file=sys.stderr)
    sys.exit(1)
`;
  }

  /**
   * Parse AI response to extract version suggestion
   */
  private parseAIResponse(output: string, currentVersion: string): VersionSuggestion {
    return parseAutocodeVersionSuggestionResponse(output, currentVersion);
  }

  /**
   * Fallback suggestion if AI analysis fails
   */
  private fallbackSuggestion(currentVersion: string): VersionSuggestion {
    return fallbackAutocodeVersionSuggestion(currentVersion);
  }

  /**
   * Build spawn environment with proper PATH and auth settings
   */
  private buildSpawnEnvironment(): Record<string, string> {
    const homeDir = os.homedir();

    // Use getAugmentedEnv() to ensure common tool paths are available
    // even when app is launched from Finder/Dock
    const augmentedEnv = getAugmentedEnv();

    // Get best available Claude profile environment (automatically handles rate limits)
    const profileResult = getBestAvailableProfileEnv();
    const profileEnv = profileResult.env;

    const spawnEnv: Record<string, string> = {
      ...augmentedEnv,
      ...profileEnv,
      // Ensure critical env vars are set for claude CLI
      ...(isWindows() ? { USERPROFILE: homeDir } : { HOME: homeDir }),
      USER: process.env.USER || process.env.USERNAME || 'user',
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1'
    };

    return spawnEnv;
  }
}
