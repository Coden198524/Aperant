/**
 * Compact retry recovery hints shared by Autocode host runtimes.
 */

import { foldRepeatedAutocodePromptLines } from './prompt-context.js';

export interface AutocodeCodingRecoverySubtask {
  id: string;
  filesToCreate?: string[];
  filesToModify?: string[];
}

export interface AutocodeCodingRecoverySessionResult {
  outcome: string;
  stepsExecuted?: number;
  toolCallCount?: number;
  error?: {
    code?: string;
    message?: string;
  };
}

export function formatAutocodeCodingRecoveryHints(subtaskId: string, hints: string[]): string {
  const lines = [
    '## Previous Attempt Recovery',
    '',
    `Use this compact failure context before retrying \`${subtaskId}\`:`,
    '',
    ...hints.slice(-3).map((hint) => `- ${hint}`),
    '',
    'Retry rules:',
    '- Read the current file state before editing.',
    '- Change approach instead of repeating the failed command or tool call.',
    '- Run the smallest relevant verification before marking the work complete.',
  ];

  return lines.join('\n');
}

export function summarizeAutocodeCodingAttemptFailure(
  subtask: AutocodeCodingRecoverySubtask,
  result: AutocodeCodingRecoverySessionResult,
  attempt: number,
): string {
  const reason = compactAutocodeAgentRecoveryText(
    result.error?.message ?? `Session ended with outcome ${result.outcome}`,
  );
  const code = result.error?.code ? `, code=${result.error.code}` : '';
  const action = getAutocodeCodingRecoveryAction(result);
  const touchedFiles = [
    ...(subtask.filesToModify ?? []),
    ...(subtask.filesToCreate ?? []),
  ].slice(0, 4);
  const files = touchedFiles.length > 0 ? ` Files: ${touchedFiles.join(', ')}.` : '';

  return `Attempt ${attempt} failed (${result.outcome}${code}; steps=${result.stepsExecuted ?? 0}; tools=${result.toolCallCount ?? 0}). ${reason}.${files} Next: ${action}`;
}

export function compactAutocodeAgentRecoveryText(value: string, maxLength = 260): string {
  const withoutCodeBlocks = value.replace(/```[\s\S]*?```/g, ' ');
  const compacted = foldRepeatedAutocodePromptLines(withoutCodeBlocks)
    .replace(/\s+/g, ' ')
    .trim();

  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, maxLength - 3).trimEnd()}...`;
}

export function getAutocodeCodingRecoveryAction(result: AutocodeCodingRecoverySessionResult): string {
  const code = result.error?.code ?? result.outcome;
  if (code.includes('quality')) {
    return 'fix the quality issue first, then rerun focused validation.';
  }
  if (code.includes('tool') || code.includes('concurrency')) {
    return 'avoid the failing tool pattern and use a smaller edit/read sequence.';
  }
  if (result.outcome === 'max_steps' || result.outcome === 'context_window') {
    return 'continue from current file state and avoid broad rereads.';
  }
  if (result.outcome === 'rate_limited') {
    return 'resume after the pause with the smallest remaining change.';
  }
  if (result.outcome === 'auth_failure') {
    return 'retry only after credentials are refreshed.';
  }
  return 'inspect the changed files and choose a narrower implementation path.';
}
