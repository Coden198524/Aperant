import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS = {
  spec: 80,
  planning: 90,
  coding: 140,
  qa: 50,
} as const;

interface PlanLike {
  phases?: unknown[];
}

interface VerificationLike {
  type?: unknown;
  run?: unknown;
  command?: unknown;
  scenario?: unknown;
  instructions?: unknown;
  expected?: unknown;
  url?: unknown;
  checks?: unknown;
}

export interface CoderKickoffSubtaskContext {
  id: string;
  title?: string;
  description?: string;
  phaseName?: string;
  filesToCreate: string[];
  filesToModify: string[];
  patternFiles: string[];
  verification?: string | VerificationLike;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function formatBulletList(items: string[]): string {
  return items.map((item) => `- \`${formatPathForPrompt(item)}\``).join('\n');
}

function formatPathForPrompt(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function formatVerification(verification: string | VerificationLike | undefined): string | null {
  if (!verification) {
    return null;
  }

  if (typeof verification === 'string') {
    return `- ${verification}`;
  }

  const lines: string[] = [];
  const type = typeof verification.type === 'string' ? verification.type : null;
  const run = typeof verification.run === 'string'
    ? verification.run
    : typeof verification.command === 'string'
      ? verification.command
      : null;
  const scenario = typeof verification.scenario === 'string' ? verification.scenario : null;
  const instructions = typeof verification.instructions === 'string' ? verification.instructions : null;
  const expected = typeof verification.expected === 'string' ? verification.expected : null;
  const url = typeof verification.url === 'string' ? verification.url : null;
  const checks = Array.isArray(verification.checks)
    ? verification.checks.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  if (type) {
    lines.push(`- Type: ${type}`);
  }
  if (run) {
    lines.push(`- Run: ${run}`);
  }
  if (scenario) {
    lines.push(`- Scenario: ${scenario}`);
  }
  if (instructions) {
    lines.push(`- Instructions: ${instructions}`);
  }
  if (expected) {
    lines.push(`- Expected: ${expected}`);
  }
  if (url) {
    lines.push(`- URL: ${url}`);
  }
  if (checks.length > 0) {
    lines.push(`- Checks: ${checks.join('; ')}`);
  }

  return lines.length > 0
    ? lines.join('\n')
    : '- Follow the verification instructions recorded in implementation_plan.json.';
}

export function findSubtaskKickoffContext(
  plan: unknown,
  subtaskId: string,
): CoderKickoffSubtaskContext | null {
  if (!plan || typeof plan !== 'object') {
    return null;
  }

  const phases = (plan as PlanLike).phases;
  if (!Array.isArray(phases)) {
    return null;
  }

  for (const phase of phases) {
    if (!phase || typeof phase !== 'object') {
      continue;
    }

    const phaseRecord = phase as {
      name?: unknown;
      subtasks?: unknown[];
    };
    const phaseName = typeof phaseRecord.name === 'string' ? phaseRecord.name : undefined;
    const subtasks = Array.isArray(phaseRecord.subtasks) ? phaseRecord.subtasks : [];

    for (const subtask of subtasks) {
      if (!subtask || typeof subtask !== 'object') {
        continue;
      }

      const subtaskRecord = subtask as {
        id?: unknown;
        title?: unknown;
        description?: unknown;
        files_to_create?: unknown;
        files_to_modify?: unknown;
        pattern_files?: unknown;
        verification?: unknown;
      };
      if (subtaskRecord.id !== subtaskId) {
        continue;
      }

      return {
        id: subtaskId,
        title: typeof subtaskRecord.title === 'string' ? subtaskRecord.title : undefined,
        description: typeof subtaskRecord.description === 'string' ? subtaskRecord.description : undefined,
        phaseName,
        filesToCreate: toStringArray(subtaskRecord.files_to_create),
        filesToModify: toStringArray(subtaskRecord.files_to_modify),
        patternFiles: toStringArray(subtaskRecord.pattern_files),
        verification: typeof subtaskRecord.verification === 'string'
          || (subtaskRecord.verification && typeof subtaskRecord.verification === 'object')
          ? subtaskRecord.verification as string | VerificationLike
          : undefined,
      };
    }
  }

  return null;
}

function readSubtaskKickoffContext(
  specDir: string,
  subtaskId: string,
): CoderKickoffSubtaskContext | null {
  const planPath = join(specDir, 'implementation_plan.json');
  if (!existsSync(planPath)) {
    return null;
  }

  try {
    const raw = readFileSync(planPath, 'utf-8');
    const plan = JSON.parse(raw) as unknown;
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
  const promptSpecDir = formatPathForPrompt(specDir);
  const promptProjectDir = formatPathForPrompt(projectDir);
  const lines: string[] = [
    `Implement ONLY subtask "${subtaskId}".`,
    `Project root: ${promptProjectDir}.`,
    `Plan file for final status update: ${promptSpecDir}/implementation_plan.json.`,
  ];

  if (context) {
    lines.push('');
    lines.push('## Current Subtask');
    if (context.phaseName) {
      lines.push(`- Phase: ${context.phaseName}`);
    }
    if (context.title) {
      lines.push(`- Title: ${context.title}`);
    }
    if (context.description) {
      lines.push(`- Description: ${context.description}`);
    }
  } else {
    lines.push('');
    lines.push(`Read ${promptSpecDir}/implementation_plan.json, locate subtask "${subtaskId}", and implement only that subtask.`);
  }

  lines.push('');
  lines.push('## File Focus');

  const readFirst = [
    ...(context?.patternFiles ?? []),
    ...(context?.filesToModify ?? []),
  ];
  if (readFirst.length > 0) {
    lines.push('Read only these files first:');
    lines.push(formatBulletList(readFirst));
  } else {
    lines.push('No file list is provided. Do one minimal target discovery only: check obvious root files by name or a narrow glob, then edit the best match. Avoid broad repo scans.');
  }

  if (context?.filesToCreate.length) {
    lines.push('');
    lines.push('Create or update these outputs if needed:');
    lines.push(formatBulletList(context.filesToCreate));
  }

  const verification = formatVerification(context?.verification);
  if (verification) {
    lines.push('');
    lines.push('## Required Verification');
    lines.push(verification);
  }

  lines.push('');
  lines.push('## Execution Rules');
  if (context) {
    lines.push('- The Current Subtask section above is already loaded from the plan. Do not read spec.md or implementation_plan.json before implementation.');
  }
  lines.push('- Focus on this one subtask until it is done.');
  lines.push('- Do not re-plan completed work or scan unrelated directories unless the listed files force you to.');
  lines.push('- Prefer the smallest code change that satisfies the subtask.');
  lines.push('- Run the listed verification before finishing.');
  lines.push('- For C/C++ verification on Windows, prefer clang++ -std=c++17 or newer when clang++ is available; do not try g++ first unless it is known present, and do not try C++11 with modern MSVC headers.');
  lines.push('- Limit compiler error output where supported, for example -ferror-limit=3 for clang++ or -fmax-errors=3 for g++.');
  lines.push('- When verification passes, immediately call update_subtask_status for this subtask before writing any final summary.');
  lines.push('- Do not write a long final response before the status update. After the update succeeds, provide only a compact review matrix.');

  return lines.join('\n');
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
