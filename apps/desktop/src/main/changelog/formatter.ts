import {
  buildChangelogPrompt as buildCoreChangelogPrompt,
  buildGitPrompt as buildCoreGitPrompt,
  getAutocodeChangelogEmojiInstructions,
} from '@autocode/core/changelog';
import type {
  ChangelogGenerationRequest,
  TaskSpecContent,
  GitCommit
} from '../../shared/types';

export function getEmojiInstructions(emojiLevel?: string, format?: string): string {
  return getAutocodeChangelogEmojiInstructions(emojiLevel, format);
}

export function buildChangelogPrompt(
  request: ChangelogGenerationRequest,
  specs: TaskSpecContent[]
): string {
  return buildCoreChangelogPrompt(request, specs);
}

export function buildGitPrompt(
  request: ChangelogGenerationRequest,
  commits: GitCommit[]
): string {
  return buildCoreGitPrompt(request, commits);
}

/**
 * Create Python script for Claude generation
 *
 * On Windows, .cmd/.bat files require shell=True in subprocess.run() because
 * they are batch scripts that need cmd.exe to execute, not direct executables.
 */
export function createGenerationScript(prompt: string, claudePath: string): string {
  // Convert prompt to base64 to avoid any string escaping issues in Python
  const base64Prompt = Buffer.from(prompt, 'utf-8').toString('base64');

  // Escape the claude path for Python string
  const escapedClaudePath = claudePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // Detect if this is a Windows batch file (.cmd or .bat)
  // These require shell=True in subprocess.run() because they need cmd.exe to execute
  const isCmdFile = /\.(cmd|bat)$/i.test(claudePath);

  return `
import subprocess
import sys
import base64

try:
    # Decode the base64 prompt to avoid string escaping issues
    prompt = base64.b64decode('${base64Prompt}').decode('utf-8')

    # Use Claude Code CLI to generate
    # stdin=DEVNULL prevents hanging when claude checks for interactive input
    # shell=${isCmdFile ? 'True' : 'False'} - Windows .cmd files require shell execution
    result = subprocess.run(
        ['${escapedClaudePath}', '-p', prompt, '--output-format', 'text', '--model', 'haiku'],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=300,
        shell=${isCmdFile ? 'True' : 'False'}
    )

    if result.returncode == 0:
        print(result.stdout)
    else:
        # Print more detailed error info
        print(f"Claude CLI error (code {result.returncode}):", file=sys.stderr)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
        if result.stdout:
            print(f"stdout: {result.stdout}", file=sys.stderr)
        sys.exit(1)
except Exception as e:
    print(f"Python error: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
`;
}
