import type { OpenSpecAction } from '../../../shared/types';

/**
 * Plain `codex exec` does not expose Aperant's AskUserQuestion, TodoWrite, or
 * Task host tools. Explore is host-tool-free. Apply is also resume-safe here
 * because Aperant always supplies the selected change explicitly and grants
 * only the official status-authorized write roots. Both Actions can inspect
 * the current workspace state after a partially completed API attempt.
 * Codex CLI authenticates through its own login state, so API-key and OAuth
 * OpenAI sessions share the same fallback capability.
 *
 * Keep this as an explicit allowlist so a future upstream Action fails closed
 * until its prompt/tool contract has been reviewed.
 */
const OPEN_SPEC_CLI_SUPPORTED_ACTIONS = new Set<OpenSpecAction>([
  'explore',
  'apply',
]);

export interface OpenSpecCodexCliFallbackRegistrationInput {
  agentType?: string;
  provider?: string;
  initialMessages?: ReadonlyArray<{
    role?: string;
    content?: string;
  }>;
  action?: OpenSpecAction;
  readOnly?: boolean;
  allowedPathRoots?: ReadonlyArray<string>;
  trustedRuntimeReadPaths?: ReadonlyArray<string>;
  allowedWritePaths?: ReadonlyArray<string>;
}

export interface OpenSpecCodexCliFallbackRegistration {
  action: OpenSpecAction;
  userMessage: string;
  readOnly: boolean;
  allowProviderFailureFallbackAfterProgress: true;
  allowedPathRoots: string[];
  trustedRuntimeReadPaths: string[];
  allowedWritePaths: string[];
}

export function canUseOpenSpecCodexCliFallback(
  action: OpenSpecAction | undefined,
): action is OpenSpecAction {
  return action !== undefined && OPEN_SPEC_CLI_SUPPORTED_ACTIONS.has(action);
}

function hasNonEmptyPaths(
  paths: ReadonlyArray<string> | undefined,
): paths is ReadonlyArray<string> {
  return (
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every((path) => typeof path === 'string' && path.trim().length > 0)
  );
}

export function hasValidOpenSpecCodexCliAccessMode(
  action: OpenSpecAction,
  readOnly: boolean | undefined,
  allowedWritePaths: ReadonlyArray<string> | undefined,
): boolean {
  if (!Array.isArray(allowedWritePaths)) return false;
  if (action === 'explore') {
    return readOnly === true && allowedWritePaths.length === 0;
  }
  if (action === 'apply') {
    return readOnly === false && hasNonEmptyPaths(allowedWritePaths);
  }
  return false;
}

/**
 * Resolve the complete, resume-safe registration payload for the plain Codex
 * CLI fallback. Returning null means the Worker must not install a provider
 * fallback callback, preserving the normal no-fallback retry budget.
 */
export function resolveOpenSpecCodexCliFallbackRegistration(
  input: OpenSpecCodexCliFallbackRegistrationInput,
): OpenSpecCodexCliFallbackRegistration | null {
  const allowedWritePaths = input.allowedWritePaths;
  const readOnly = input.readOnly;
  if (
    input.agentType !== 'openspec' ||
    input.provider !== 'openai' ||
    !canUseOpenSpecCodexCliFallback(input.action) ||
    typeof readOnly !== 'boolean' ||
    !Array.isArray(allowedWritePaths) ||
    !hasValidOpenSpecCodexCliAccessMode(
      input.action,
      readOnly,
      allowedWritePaths,
    ) ||
    !hasNonEmptyPaths(input.allowedPathRoots) ||
    !hasNonEmptyPaths(input.trustedRuntimeReadPaths) ||
    !Array.isArray(input.initialMessages) ||
    input.initialMessages.length !== 1
  ) {
    return null;
  }

  const message = input.initialMessages[0];
  if (
    message?.role !== 'user' ||
    typeof message.content !== 'string' ||
    message.content.trim().length === 0
  ) {
    return null;
  }

  return {
    action: input.action,
    userMessage: message.content,
    readOnly,
    allowProviderFailureFallbackAfterProgress: true,
    allowedPathRoots: [...input.allowedPathRoots],
    trustedRuntimeReadPaths: [...input.trustedRuntimeReadPaths],
    allowedWritePaths: [...allowedWritePaths],
  };
}

export const __openSpecCodexCliCapabilityTestUtils = {
  supportedActions: [...OPEN_SPEC_CLI_SUPPORTED_ACTIONS],
};
