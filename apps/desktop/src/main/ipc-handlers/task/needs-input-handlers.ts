/**
 * Needs-input handlers
 *
 * When standard planning pauses at the independent design review because of unresolved
 * open questions, these handlers let the desktop UI:
 *  1. fetch the reviewer's structured decision options (with a recommended default), and
 *  2. write the user's chosen decisions back into requirements.md so a planning re-run
 *     resumes past the human gate instead of blocking again.
 */
import { ipcMain } from 'electron';
import path from 'path';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { detectAutocodeDesignReviewHumanInputGate, AUTOCODE_TASK_ARTIFACTS } from '@autocode/core';
import { IPC_CHANNELS, getSpecsDir } from '../../../shared/constants';
import type {
  IPCResult,
  Project,
  Task,
  TaskDecisionAnswer,
  TaskNeedsInputDecisions,
} from '../../../shared/types';
import { findTaskWorktree } from '../../worktree-paths';
import { findTaskAndProject } from './shared';

const REQUIREMENTS_FILE = 'requirements.md';
const DESIGN_REVIEW_FILE = AUTOCODE_TASK_ARTIFACTS.designReview || 'design_review.md';
const HUMAN_INPUT_FILE = 'HUMAN_INPUT.md';
// Kept in sync with STANDARD_PLANNING_ITERATION_MARKERS in execution-handlers.ts so the
// re-run is recognised as a planning iteration that carries fresh user input.
const PLANNING_ITERATION_MARKER = 'incremental task-iteration planning pass';

/**
 * Returns every spec directory that may hold this task's artifacts: the worktree copy
 * (preferred, since the backend writes there) and the main project copy.
 */
function resolveTaskSpecDirs(task: Task, project: Project): string[] {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const dirs: string[] = [];
  const worktreePath = findTaskWorktree(project.path, task.specId);
  if (worktreePath) {
    dirs.push(path.join(worktreePath, specsBaseDir, task.specId));
  }
  dirs.push(path.join(project.path, specsBaseDir, task.specId));
  return Array.from(new Set(dirs));
}

function readFirstExisting(specDirs: string[], fileName: string): string | undefined {
  for (const dir of specDirs) {
    const filePath = path.join(dir, fileName);
    if (existsSync(filePath)) {
      try {
        return readFileSync(filePath, 'utf-8');
      } catch (error) {
        console.warn(`[needs-input] Failed to read ${filePath}:`, error);
      }
    }
  }
  return undefined;
}

/**
 * Reads the active design review, falling back to the most recent
 * `design_review.md.failed-*` snapshot. When planning pauses on the human gate the runner
 * rolls the unvalidated review back to a `.failed-<timestamp>` file, so the plain
 * design_review.md is usually absent at needs_input time and the failed snapshot holds the
 * open questions the user must resolve.
 */
function readLatestDesignReviewMarkdown(specDirs: string[]): string | undefined {
  const active = readFirstExisting(specDirs, DESIGN_REVIEW_FILE);
  if (active) {
    return active;
  }
  const failedPrefix = `${DESIGN_REVIEW_FILE}.failed-`;
  let newest: { path: string; mtimeMs: number } | undefined;
  for (const dir of specDirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(failedPrefix)) {
        continue;
      }
      const filePath = path.join(dir, entry);
      try {
        const mtimeMs = statSync(filePath).mtimeMs;
        if (!newest || mtimeMs > newest.mtimeMs) {
          newest = { path: filePath, mtimeMs };
        }
      } catch {
        // Ignore unreadable entries.
      }
    }
  }
  if (!newest) {
    return undefined;
  }
  try {
    return readFileSync(newest.path, 'utf-8');
  } catch (error) {
    console.warn(`[needs-input] Failed to read ${newest.path}:`, error);
    return undefined;
  }
}

/** Extracts a `Q<n>` open-question id from arbitrary review/question text, if present. */
function extractOpenQuestionId(text: string): string | undefined {
  const match = /\bQ(\d{1,3})\b/i.exec(text);
  return match ? `Q${match[1]}` : undefined;
}

/**
 * Annotates a `- Q<n>:` open-question line in requirements.md with the approved decision,
 * so the reviewer no longer flags it as unresolved. Append-only and non-destructive.
 */
function annotateOpenQuestionLines(
  requirements: string,
  answers: TaskDecisionAnswer[],
  timestamp: string,
): string {
  const lines = requirements.split(/\r?\n/);
  for (const answer of answers) {
    const questionId = extractOpenQuestionId(answer.question) || extractOpenQuestionId(answer.answer);
    if (!questionId) {
      continue;
    }
    const linePattern = new RegExp(`^(\\s*-\\s*${questionId}\\s*[:：])`, 'i');
    for (let i = 0; i < lines.length; i += 1) {
      if (linePattern.test(lines[i]) && !lines[i].includes('[已由用户批准')) {
        lines[i] = `${lines[i]} [已由用户批准 ${timestamp}：${answer.answer}]`;
        break;
      }
    }
  }
  return lines.join('\n');
}

/**
 * Appends an explicit approved-decisions section so the record survives even when a
 * `- Q<n>:` line cannot be matched, and gives the reviewer a strong resolved signal.
 */
function appendApprovedDecisionsSection(
  requirements: string,
  answers: TaskDecisionAnswer[],
  timestamp: string,
): string {
  const body = answers
    .map((answer) => `- ${answer.question} -> ${answer.answer}`)
    .join('\n');
  const section = [
    '',
    '## 人工决策 (Approved Open-Question Decisions)',
    '',
    `Approved-Open-Questions: ${answers.length}`,
    `Approved-At: ${timestamp}`,
    '',
    '以下开放问题已由用户批准为最终决策，视为已解决，规划应据此推进：',
    body,
    '',
  ].join('\n');
  const trimmed = requirements.replace(/\s+$/, '');
  return `${trimmed}\n${section}`;
}

function writeRequirementsWriteBack(specDirs: string[], answers: TaskDecisionAnswer[]): number {
  const timestamp = new Date().toISOString();
  let written = 0;
  for (const dir of specDirs) {
    const requirementsPath = path.join(dir, REQUIREMENTS_FILE);
    if (!existsSync(requirementsPath)) {
      continue;
    }
    try {
      const original = readFileSync(requirementsPath, 'utf-8');
      let next = annotateOpenQuestionLines(original, answers, timestamp);
      next = appendApprovedDecisionsSection(next, answers, timestamp);
      writeFileSync(requirementsPath, next, 'utf-8');

      // Record a planning-iteration note so the re-run is recognised as carrying input.
      const humanInputPath = path.join(dir, HUMAN_INPUT_FILE);
      mkdirSync(dir, { recursive: true });
      const note = [
        '',
        `## Approved design decisions (${timestamp})`,
        '',
        `The user approved the following open-question decisions; run an ${PLANNING_ITERATION_MARKER} to fold them into requirements.md and re-review the design:`,
        ...answers.map((answer) => `- ${answer.question} -> ${answer.answer}`),
        '',
      ].join('\n');
      appendFileSync(humanInputPath, note, 'utf-8');
      written += 1;
    } catch (error) {
      console.warn(`[needs-input] Failed to write decisions to ${dir}:`, error);
    }
  }
  return written;
}

export function registerNeedsInputHandlers(): void {
  /**
   * Fetch the structured decision options for a task paused on the needs_input gate,
   * parsed on demand from design_review.md via the core detector.
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_GET_NEEDS_INPUT_DECISIONS,
    async (_, taskId: string, projectId?: string): Promise<IPCResult<TaskNeedsInputDecisions>> => {
      const { task, project } = findTaskAndProject(taskId, projectId);
      if (!task || !project) {
        return { success: false, error: 'Task or project not found' };
      }
      const specDirs = resolveTaskSpecDirs(task, project);
      const reviewMarkdown = readLatestDesignReviewMarkdown(specDirs);
      const gate = detectAutocodeDesignReviewHumanInputGate(reviewMarkdown);
      return {
        success: true,
        data: {
          blocked: gate.blocked,
          message: gate.message,
          questions: gate.questions,
          decisions: gate.decisions,
        },
      };
    },
  );

  /**
   * Persist the user's chosen decisions into requirements.md (and a HUMAN_INPUT.md note)
   * so a subsequent planning re-run clears the human gate. Re-running is triggered
   * separately by the existing start/queue flow.
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_RESOLVE_NEEDS_INPUT_DECISIONS,
    async (
      _,
      taskId: string,
      answers: TaskDecisionAnswer[],
      projectId?: string,
    ): Promise<IPCResult<{ written: number }>> => {
      const { task, project } = findTaskAndProject(taskId, projectId);
      if (!task || !project) {
        return { success: false, error: 'Task or project not found' };
      }
      if (!Array.isArray(answers) || answers.length === 0) {
        return { success: false, error: 'No decisions were provided' };
      }
      const sanitized = answers
        .filter((answer) => answer && typeof answer.answer === 'string' && answer.answer.trim().length > 0)
        .map((answer) => ({
          questionId: String(answer.questionId ?? '').trim(),
          question: String(answer.question ?? '').trim(),
          optionId: String(answer.optionId ?? '').trim(),
          answer: answer.answer.trim(),
        }));
      if (sanitized.length === 0) {
        return { success: false, error: 'No valid decisions were provided' };
      }
      const specDirs = resolveTaskSpecDirs(task, project);
      const written = writeRequirementsWriteBack(specDirs, sanitized);
      if (written === 0) {
        return { success: false, error: 'requirements.md was not found for this task' };
      }
      return { success: true, data: { written } };
    },
  );
}
