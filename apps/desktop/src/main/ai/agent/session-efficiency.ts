import {
  AUTOCODE_TASK_ARTIFACTS,
  AUTOCODE_DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS,
  buildAutocodeFocusedCoderKickoffMessageFromContext,
  findAutocodeSubtaskKickoffContext,
  extractAutocodeDesignPackageReferenceExcerpt,
  loadAutocodeImplementationPlanSync,
  type AutocodeCoderKickoffSubtaskContext,
} from '@autocode/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS = AUTOCODE_DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS;

export type CoderKickoffSubtaskContext = AutocodeCoderKickoffSubtaskContext;

export const findSubtaskKickoffContext = findAutocodeSubtaskKickoffContext;

function readOptionalDesignArtifact(specDir: string, fileName: string): string | undefined {
  try {
    return readFileSync(join(specDir, fileName), 'utf-8');
  } catch {
    return undefined;
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
    const context = findSubtaskKickoffContext(plan, subtaskId);
    if (context?.designRefs?.length) {
      try {
        const designMarkdown = readFileSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.design), 'utf-8');
        context.designExcerpt = extractAutocodeDesignPackageReferenceExcerpt(
          {
            designMarkdown,
            requirementModelMarkdown: readOptionalDesignArtifact(specDir, AUTOCODE_TASK_ARTIFACTS.requirementModel),
            domainModelMarkdown: readOptionalDesignArtifact(specDir, AUTOCODE_TASK_ARTIFACTS.domainModel),
            designModelMarkdown: readOptionalDesignArtifact(specDir, AUTOCODE_TASK_ARTIFACTS.designModel),
            implementationModelMarkdown: readOptionalDesignArtifact(specDir, AUTOCODE_TASK_ARTIFACTS.implementationModel),
          },
          context.designRefs,
        );
      } catch {
        // Legacy Standard plans may not have design.md. Keep their focused
        // work-item context so the current validated plan can still finish.
      }
    }
    return context;
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
