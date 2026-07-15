import { resolve } from 'node:path';
import { AUTOCODE_TASK_ARTIFACTS } from '../tasks/artifacts.js';
import { detectAutocodeWorktreeIsolation } from '../tasks/worktree-paths.js';
import {
  compactAutocodePromptContextSection,
  foldRepeatedAutocodePromptLines,
} from './prompt-context.js';

export interface AutocodeSubtaskPromptInfo {
  id: string;
  description: string;
  phaseName?: string;
  service?: string;
  filesToCreate?: string[];
  filesToModify?: string[];
  patternsFrom?: string[];
  verification?: AutocodeSubtaskVerification;
  status?: string;
}

export interface AutocodeSubtaskVerification {
  type?: 'command' | 'api' | 'browser' | 'e2e' | 'manual';
  command?: string;
  expected?: string;
  method?: string;
  url?: string;
  body?: Record<string, unknown>;
  expected_status?: number;
  checks?: string[];
  steps?: string[];
  instructions?: string;
}

export interface AutocodeSubtaskContext {
  patterns: Record<string, string>;
  filesToModify: Record<string, string>;
  specExcerpt?: string | null;
}

export interface AutocodePlannerPromptBuildInput {
  specDir: string;
  projectDir: string;
  basePlannerPrompt: string;
  projectInstructions?: string | null;
  planningRetryContext?: string;
}

export interface AutocodeSubtaskPromptBuildInput {
  specDir: string;
  projectDir: string;
  subtask: AutocodeSubtaskPromptInfo;
  phase?: { id?: string; name?: string };
  attemptCount?: number;
  recoveryHints?: string[];
  projectInstructions?: string | null;
  context?: AutocodeSubtaskContext | null;
}

const AUTOCODE_SUBTASK_DESCRIPTION_MAX_CHARS = 1200;
const AUTOCODE_SUBTASK_RECOVERY_HINT_LIMIT = 3;
const AUTOCODE_SUBTASK_RECOVERY_HINT_MAX_CHARS = 260;
const AUTOCODE_SUBTASK_FILE_LIST_LIMIT = 24;
const AUTOCODE_SUBTASK_FILE_PATH_MAX_CHARS = 180;
export const AUTOCODE_PROJECT_INSTRUCTIONS_MAX_CHARS = 6_000;
export const AUTOCODE_PLANNING_RETRY_CONTEXT_MAX_CHARS = 4_000;
export const AUTOCODE_SUBTASK_CONTEXT_TOTAL_MAX_CHARS = 12_000;
export const AUTOCODE_SUBTASK_CONTEXT_FILE_MAX_CHARS = 2_400;
export const AUTOCODE_SUBTASK_CONTEXT_FILE_LIMIT = 6;
const AUTOCODE_SUBTASK_TEXT_TRUNCATION_HEAD_RATIO = 0.65;

export function generateAutocodeWorktreeIsolationWarning(
  projectDir: string,
  parentProjectPath: string,
): string {
  return (
    `## Isolated Worktree\n\n` +
    `Work only in this isolated copy of the project.\n\n` +
    `**Worktree:** \`${projectDir}\`\n` +
    `**Parent project to avoid:** \`${parentProjectPath}\`\n\n` +
    `Rules:\n` +
    `1. Do not \`cd ${parentProjectPath}\` or use paths under it.\n` +
    `2. Use relative paths from the worktree.\n` +
    `3. Commit and edit only inside the worktree.\n\n` +
    `Correct usage:\n` +
    `\`\`\`bash\n` +
    `# Correct\n` +
    `./prod/src/file.ts\n` +
    `./apps/desktop/src/component.tsx\n\n` +
    `# Wrong\n` +
    `cd ${parentProjectPath}\n` +
    `${parentProjectPath}/prod/src/file.ts\n` +
    `\`\`\`\n\n` +
    `Convert parent-project absolute paths in spec/context files to worktree-relative paths.\n\n` +
    `---\n\n`
  );
}

export function getAutocodeRelativeSpecPath(specDir: string, projectDir: string): string {
  const resolvedSpec = resolve(specDir);
  const resolvedProject = resolve(projectDir);

  if (resolvedSpec.startsWith(resolvedProject)) {
    const relative = resolvedSpec.slice(resolvedProject.length + 1);
    return `./${relative}`;
  }

  const parts = resolvedSpec.split(/[/\\]/);
  return `./autocode/specs/${parts[parts.length - 1]}`;
}

export function generateAutocodeEnvironmentContext(projectDir: string, specDir: string): string {
  const relativeSpec = getAutocodeRelativeSpecPath(specDir, projectDir);
  const [isWorktree, parentProjectPath] = detectAutocodeWorktreeIsolation(projectDir);
  const sections: string[] = [];

  if (isWorktree && parentProjectPath) {
    sections.push(generateAutocodeWorktreeIsolationWarning(projectDir, parentProjectPath));
  }

  sections.push(
    `## Environment\n\n` +
    `**Working Directory:** \`${projectDir}\`\n` +
    `**Spec Location:** \`${relativeSpec}/\`\n` +
    `${isWorktree ? '**Isolation Mode:** WORKTREE (changes are isolated from main project)\n' : ''}` +
    `\n` +
    `Use paths relative to the current working directory. Run \`pwd\` if you changed directories before git or file operations.\n\n` +
    `**Important Files:**\n` +
    `- Spec: \`${relativeSpec}/spec.md\`\n` +
    `- Plan: \`${relativeSpec}/implementation_plan.md\`\n` +
    `- Progress: \`${relativeSpec}/build-progress.txt\`\n` +
    `- Context: \`${relativeSpec}/${AUTOCODE_TASK_ARTIFACTS.context}\`\n\n` +
    `---\n\n`,
  );

  return sections.join('');
}

export function buildAutocodePlannerPrompt(input: AutocodePlannerPromptBuildInput): string {
  const relativeSpec = getAutocodeRelativeSpecPath(input.specDir, input.projectDir);
  const sections: string[] = [];

  sections.push(generateAutocodeEnvironmentContext(input.projectDir, input.specDir));
  sections.push(
    `## SPEC LOCATION\n\n` +
    `Your spec file is located at: \`${relativeSpec}/spec.md\`\n\n` +
    `Store all build artifacts in this spec directory:\n` +
    `- \`${relativeSpec}/implementation_plan.md\` - Subtask-based implementation plan\n` +
    `- \`${relativeSpec}/build-progress.txt\` - Progress notes\n` +
    `- \`${relativeSpec}/init.sh\` - Environment setup script\n\n` +
    `The project root is your current working directory. Implement code in the project root,\n` +
    `not in the spec directory.\n\n` +
    `---\n\n`,
  );

  if (input.projectInstructions) {
    sections.push(
      `## PROJECT INSTRUCTIONS\n\n` +
      `${limitAutocodePromptBlockText(
        input.projectInstructions,
        AUTOCODE_PROJECT_INSTRUCTIONS_MAX_CHARS,
        '\n...[project instructions truncated; read the source instructions only if needed]',
      )}\n\n` +
      `---\n\n`,
    );
  }

  if (input.planningRetryContext) {
    sections.push(`${limitAutocodePromptBlockText(
      input.planningRetryContext,
      AUTOCODE_PLANNING_RETRY_CONTEXT_MAX_CHARS,
      '\n...[planning retry context truncated; read exact retry artifacts only if needed]',
    )}\n\n---\n\n`);
  }

  sections.push(input.basePlannerPrompt);
  return sections.join('');
}

export function buildAutocodeSubtaskPrompt(input: AutocodeSubtaskPromptBuildInput): string {
  const {
    specDir,
    projectDir,
    subtask,
    phase,
    attemptCount = 0,
    recoveryHints,
    projectInstructions,
    context,
  } = input;
  const sections: string[] = [];

  sections.push(generateAutocodeEnvironmentContext(projectDir, specDir));
  sections.push(
    `# Subtask Implementation Task\n\n` +
    `**Subtask ID:** \`${subtask.id}\`\n` +
    `**Phase:** ${phase?.name ?? subtask.phaseName ?? 'Implementation'}\n` +
    `**Service:** ${subtask.service ?? 'all'}\n\n` +
    `## Description\n\n` +
    `${limitAutocodeSubtaskPromptText(subtask.description, AUTOCODE_SUBTASK_DESCRIPTION_MAX_CHARS)}\n`,
  );

  if (attemptCount > 0) {
    sections.push(
      `\n## RETRY ATTEMPT (${attemptCount + 1})\n\n` +
      `This subtask has been attempted ${attemptCount} time(s) before without success.\n` +
      `Use a different approach than previous attempts.\n`,
    );
    if (recoveryHints && recoveryHints.length > 0) {
      sections.push('**Previous attempt insights:**');
      for (const hint of recoveryHints.slice(-AUTOCODE_SUBTASK_RECOVERY_HINT_LIMIT)) {
        sections.push(`- ${limitAutocodeSubtaskPromptText(hint, AUTOCODE_SUBTASK_RECOVERY_HINT_MAX_CHARS)}`);
      }
      const omitted = recoveryHints.length - AUTOCODE_SUBTASK_RECOVERY_HINT_LIMIT;
      if (omitted > 0) {
        sections.push(`- ... ${omitted} earlier hint(s) omitted`);
      }
      sections.push('');
    }
  }

  sections.push('## Files\n');

  if (subtask.filesToModify && subtask.filesToModify.length > 0) {
    sections.push('**Files to Modify:**');
    appendAutocodeSubtaskFileList(sections, subtask.filesToModify);
    sections.push('');
  }

  if (subtask.filesToCreate && subtask.filesToCreate.length > 0) {
    sections.push('**Files to Create:**');
    appendAutocodeSubtaskFileList(sections, subtask.filesToCreate);
    sections.push('');
  }

  if (subtask.patternsFrom && subtask.patternsFrom.length > 0) {
    sections.push('**Pattern Files (study these first):**');
    appendAutocodeSubtaskFileList(sections, subtask.patternsFrom);
    sections.push('');
  }

  sections.push('## Verification\n');
  appendAutocodeVerificationSection(sections, subtask.verification);
  appendAutocodeSubtaskInstructions(sections, subtask);

  if (projectInstructions) {
    sections.push(
      `\n## PROJECT INSTRUCTIONS\n\n` +
      `${limitAutocodePromptBlockText(
        projectInstructions,
        AUTOCODE_PROJECT_INSTRUCTIONS_MAX_CHARS,
        '\n...[project instructions truncated; read the source instructions only if needed]',
      )}\n`,
    );
  }

  const contextText = context ? formatAutocodeSubtaskContextForPrompt(context) : '';
  if (contextText) {
    sections.push(`\n${contextText}`);
  }

  return sections.join('\n');
}

function appendAutocodeSubtaskFileList(sections: string[], files: readonly string[]): void {
  for (const file of files.slice(0, AUTOCODE_SUBTASK_FILE_LIST_LIMIT)) {
    sections.push(`- \`${limitAutocodeSubtaskPromptText(file, AUTOCODE_SUBTASK_FILE_PATH_MAX_CHARS)}\``);
  }
  const omitted = files.length - AUTOCODE_SUBTASK_FILE_LIST_LIMIT;
  if (omitted > 0) {
    sections.push(`- ... ${omitted} more`);
  }
}

export function formatAutocodeSubtaskContextForPrompt(context: AutocodeSubtaskContext): string {
  const sections: string[] = [];
  const budget = { remaining: AUTOCODE_SUBTASK_CONTEXT_TOTAL_MAX_CHARS };

  appendAutocodeSubtaskContextGroup(
    sections,
    '## Reference Files (Patterns to Follow)',
    Object.entries(context.patterns),
    budget,
  );
  appendAutocodeSubtaskContextGroup(
    sections,
    '## Current File Contents (To Modify)',
    Object.entries(context.filesToModify),
    budget,
  );

  return sections.join('\n');
}

function appendAutocodeSubtaskContextGroup(
  sections: string[],
  title: string,
  entries: Array<[string, string]>,
  budget: { remaining: number },
): void {
  if (entries.length === 0 || budget.remaining <= 0) {
    return;
  }

  const visibleEntries = entries.slice(0, AUTOCODE_SUBTASK_CONTEXT_FILE_LIMIT);
  let omitted = entries.length - visibleEntries.length;
  const beforeCount = sections.length;
  appendAutocodeSubtaskContextChunk(sections, `${title}\n`, budget);

  for (const [path, content] of visibleEntries) {
    const safePath = limitAutocodeSubtaskPromptText(path, AUTOCODE_SUBTASK_FILE_PATH_MAX_CHARS);
    const header = `### \`${safePath}\`\n\`\`\`\n`;
    const footer = '\n```\n';
    const contentBudget = Math.min(
      AUTOCODE_SUBTASK_CONTEXT_FILE_MAX_CHARS,
      Math.max(0, budget.remaining - header.length - footer.length - 180),
    );
    if (contentBudget < 240) {
      omitted += 1;
      continue;
    }

    const compactContent = compactAutocodeSubtaskContextFileContent(content, contentBudget);
    const block = `${header}${compactContent}${footer}`;
    if (!appendAutocodeSubtaskContextChunk(sections, block, budget)) {
      omitted += 1;
    }
  }

  if (omitted > 0) {
    appendAutocodeSubtaskContextChunk(
      sections,
      `> ${omitted} context file(s) omitted to stay within the subtask prompt budget. Read exact files only if needed.\n`,
      budget,
    );
  }

  if (sections.length === beforeCount + 1 && omitted === entries.length) {
    sections.pop();
  }
}

function appendAutocodeSubtaskContextChunk(
  sections: string[],
  chunk: string,
  budget: { remaining: number },
): boolean {
  const normalized = chunk.trimEnd();
  if (!normalized || normalized.length > budget.remaining) {
    return false;
  }
  sections.push(normalized);
  budget.remaining -= normalized.length + 1;
  return true;
}

function compactAutocodeSubtaskContextFileContent(content: string, maxChars: number): string {
  const normalized = String(content ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const compact = foldRepeatedAutocodePromptLines(normalized);
  if (compact.length <= maxChars) {
    return compact;
  }

  const marker = `\n...[file content truncated, ${normalized.length} chars total]...\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const headLength = Math.floor(budget * 0.55);
  const tailLength = budget - headLength;
  return `${compact.slice(0, headLength).trimEnd()}${marker}${compact.slice(compact.length - tailLength).trimStart()}`;
}

function limitAutocodeSubtaskPromptText(value: string, maxChars: number): string {
  const normalized = foldRepeatedAutocodePromptLines(
    value
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n'),
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }

  const marker = `... [subtask prompt middle truncated, ${normalized.length} chars total] ...`;
  if (marker.length >= maxChars - 2) {
    return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  const budget = maxChars - marker.length;
  const headLength = Math.ceil(budget * AUTOCODE_SUBTASK_TEXT_TRUNCATION_HEAD_RATIO);
  const tailLength = Math.max(0, budget - headLength);
  return [
    normalized.slice(0, headLength).trimEnd(),
    marker,
    tailLength > 0 ? normalized.slice(-tailLength).trimStart() : '',
  ].join('');
}

function limitAutocodePromptBlockText(value: string, maxChars: number, suffix: string): string {
  return compactAutocodePromptContextSection(value, maxChars, suffix);
}

export function validateAutocodeProjectRelativePath(filePath: string, projectRoot: string): string | null {
  const resolved = resolve(filePath);
  const root = resolve(projectRoot);
  if (!resolved.startsWith(root)) {
    return null;
  }
  return resolved;
}

export function calculateAutocodeStringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  if (aLower === bLower) return 0.99;
  if (bLower.includes(aLower)) return 0.8;
  if (aLower.includes(bLower)) return 0.7;

  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  const distance = calculateAutocodeLevenshteinDistance(aLower, bLower);
  return 1 - distance / maxLen;
}

export function calculateAutocodeLevenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = new Array<number>((m + 1) * (n + 1)).fill(0);

  for (let i = 0; i <= m; i++) dp[i * (n + 1)] = i;
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i * (n + 1) + j] = dp[(i - 1) * (n + 1) + (j - 1)];
      } else {
        dp[i * (n + 1) + j] = 1 + Math.min(
          dp[(i - 1) * (n + 1) + j],
          dp[i * (n + 1) + (j - 1)],
          dp[(i - 1) * (n + 1) + (j - 1)],
        );
      }
    }
  }

  return dp[m * (n + 1) + n];
}

function appendAutocodeVerificationSection(
  sections: string[],
  verification: AutocodeSubtaskVerification | undefined,
): void {
  if (verification?.type === 'command') {
    sections.push(
      `Run this command to verify:\n` +
      `\`\`\`bash\n${verification.command ?? 'echo "No command specified"'}\n\`\`\`\n` +
      `Expected: ${verification.expected ?? 'Success'}\n`,
    );
    return;
  }

  if (verification?.type === 'api') {
    const method = verification.method ?? 'GET';
    const url = verification.url ?? 'http://localhost';
    const body = verification.body;
    sections.push(
      `Test the API endpoint:\n` +
      `\`\`\`bash\n` +
      `curl -X ${method} ${url} -H "Content-Type: application/json"` +
      `${body ? ` -d '${JSON.stringify(body)}'` : ''}\n` +
      `\`\`\`\n` +
      `Expected status: ${verification.expected_status ?? 200}\n`,
    );
    return;
  }

  if (verification?.type === 'browser') {
    const url = verification.url ?? 'http://localhost:3000';
    const checks = verification.checks ?? [];
    sections.push(`Open in browser: ${url}\n\nVerify:`);
    for (const check of checks) {
      sections.push(`- [ ] ${check}`);
    }
    sections.push('');
    return;
  }

  if (verification?.type === 'e2e') {
    const steps = verification.steps ?? [];
    sections.push('End-to-end verification steps:');
    steps.forEach((step, index) => {
      sections.push(`${index + 1}. ${step}`);
    });
    sections.push('');
    return;
  }

  sections.push(`**Manual Verification:**\n${verification?.instructions ?? 'Manual verification required'}\n`);
}

function appendAutocodeSubtaskInstructions(
  sections: string[],
  subtask: AutocodeSubtaskPromptInfo,
): void {
  sections.push(
    `## Instructions\n\n` +
    `1. **Read the pattern files** to understand code style and conventions\n` +
    `2. **Read the files to modify** (if any) to understand current implementation\n` +
    `3. **Identify the local implementation contract**: inputs/outputs, lifecycle, side effects, errors, config/schema/API boundaries, and caller/callee expectations\n` +
    `4. **Implement the subtask** following local patterns without placeholder code, no-op handlers, broad type escapes, or unrelated abstractions\n` +
    `5. **Run verification** and fix any issues. For behavior changes, add or update the closest regression test when an adjacent test pattern exists. For user-facing apps, browser pages, games, interactive tools, launchers, or CLI deliverables, include an actual launch/open/use-path smoke check; static syntax, unit, lint, typecheck, or file-existence checks alone are not enough\n` +
    `6. **Do not commit or push** unless this task explicitly requires it\n` +
    `7. **Report completion** - do not edit tasks.md or implementation_plan.md. Return a structured completion_summary for the runtime to record. Use this compact Markdown review matrix exactly:\n` +
    `   \`| Item | Details |\n| --- | --- |\n| What changed | ... |\n| Verification | ... |\n| Review notes | ... |\`\n` +
    `   Include touched files/contracts in What changed or Review notes. Keep each cell concise, concrete, and suitable for quick manual audit.\n\n` +
    `## Quality Checklist\n\n` +
    `Before marking complete, verify:\n` +
    `- [ ] Local implementation contract and affected call sites are understood\n` +
    `- [ ] Follows patterns from reference files\n` +
    `- [ ] No console.log/print debugging statements, placeholders, TODO implementations, no-op handlers, fake data, or broad type escapes\n` +
    `- [ ] Error handling in place\n` +
    `- [ ] Adjacent tests or regression coverage updated when the change affects behavior\n` +
    `- [ ] Verification passes\n` +
    `- [ ] User-facing or runnable deliverables were actually launched/opened/exercised and had no startup, console, resource-load, blank-screen, crash/hang, or non-zero-exit failures\n` +
    `- [ ] Completion summary names changed files/contracts, verification, and residual risks or edge cases\n\n` +
    `## Boundaries\n\n` +
    `- Focus on this subtask; do not modify unrelated code\n` +
    `- Do not edit tasks.md or implementation_plan.md; planning owns static definitions and the runtime owns execution state\n` +
    `- If verification fails because of your changes, fix it before committing\n` +
    `- If you encounter a blocker, document it in build-progress.txt\n`,
  );
}
