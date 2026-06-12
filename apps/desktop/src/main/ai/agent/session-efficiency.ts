import {
  AUTOCODE_DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS,
  buildAutocodeFocusedCoderKickoffMessageFromContext,
  findAutocodeSubtaskKickoffContext,
  loadAutocodeImplementationPlanSync,
  type AutocodeCoderKickoffSubtaskContext,
} from '@autocode/core';

export const DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS = AUTOCODE_DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS;

export type CoderKickoffSubtaskContext = AutocodeCoderKickoffSubtaskContext;

export const findSubtaskKickoffContext = findAutocodeSubtaskKickoffContext;

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
