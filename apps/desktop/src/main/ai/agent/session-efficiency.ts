import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTOCODE_DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS,
  AUTOCODE_TASK_ARTIFACTS,
  buildAutocodeFocusedCoderKickoffMessageFromContext,
  findAutocodeSubtaskKickoffContext,
  loadAutocodeImplementationPlanSync,
  type AutocodeCoderKickoffSubtaskContext,
} from '@autocode/core';

export const DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS = AUTOCODE_DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS;

export type CoderKickoffSubtaskContext = AutocodeCoderKickoffSubtaskContext;

export const findSubtaskKickoffContext = findAutocodeSubtaskKickoffContext;

function readCompactOpenSpecContext(specDir: string): string | null {
  const contextPath = join(specDir, AUTOCODE_TASK_ARTIFACTS.openSpecContext);
  if (!existsSync(contextPath)) {
    return null;
  }
  try {
    const content = readFileSync(contextPath, 'utf8').trim();
    if (!content) {
      return null;
    }
    return content.length <= 8000 ? content : `${content.slice(0, 8000).trimEnd()}\n...[truncated]`;
  } catch {
    return null;
  }
}

function readSubtaskKickoffContext(
  specDir: string,
  subtaskId: string,
): CoderKickoffSubtaskContext | null {
  try {
    const plan = loadAutocodeImplementationPlanSync(specDir) as unknown;
    if (!plan) {
      return null;
    }
    return findSubtaskKickoffContext(plan, subtaskId);
  } catch {
    return null;
  }
}

export function buildFocusedCoderKickoffMessageFromContext(
  specDir: string,
  projectDir: string,
  subtaskId: string,
  context: CoderKickoffSubtaskContext | null,
): string {
  return buildAutocodeFocusedCoderKickoffMessageFromContext({
    specDir,
    projectDir,
    subtaskId,
    context,
    openSpecContext: readCompactOpenSpecContext(specDir),
  });
}

export function buildFocusedCoderKickoffMessage(
  specDir: string,
  projectDir: string,
  subtaskId: string,
): string {
  return buildFocusedCoderKickoffMessageFromContext(
    specDir,
    projectDir,
    subtaskId,
    readSubtaskKickoffContext(specDir, subtaskId),
  );
}
