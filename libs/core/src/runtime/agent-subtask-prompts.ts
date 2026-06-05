import { resolve } from 'node:path';
import { detectAutocodeWorktreeIsolation } from '../tasks/worktree-paths.js';

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
    `- Context: \`${relativeSpec}/context.json\`\n\n` +
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
      `${input.projectInstructions}\n\n` +
      `---\n\n`,
    );
  }

  if (input.planningRetryContext) {
    sections.push(`${input.planningRetryContext}\n\n---\n\n`);
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
    `${subtask.description}\n`,
  );

  if (attemptCount > 0) {
    sections.push(
      `\n## RETRY ATTEMPT (${attemptCount + 1})\n\n` +
      `This subtask has been attempted ${attemptCount} time(s) before without success.\n` +
      `Use a different approach than previous attempts.\n`,
    );
    if (recoveryHints && recoveryHints.length > 0) {
      sections.push('**Previous attempt insights:**');
      for (const hint of recoveryHints) {
        sections.push(`- ${hint}`);
      }
      sections.push('');
    }
  }

  sections.push('## Files\n');

  if (subtask.filesToModify && subtask.filesToModify.length > 0) {
    sections.push('**Files to Modify:**');
    for (const file of subtask.filesToModify) {
      sections.push(`- \`${file}\``);
    }
    sections.push('');
  }

  if (subtask.filesToCreate && subtask.filesToCreate.length > 0) {
    sections.push('**Files to Create:**');
    for (const file of subtask.filesToCreate) {
      sections.push(`- \`${file}\``);
    }
    sections.push('');
  }

  if (subtask.patternsFrom && subtask.patternsFrom.length > 0) {
    sections.push('**Pattern Files (study these first):**');
    for (const file of subtask.patternsFrom) {
      sections.push(`- \`${file}\``);
    }
    sections.push('');
  }

  sections.push('## Verification\n');
  appendAutocodeVerificationSection(sections, subtask.verification);
  appendAutocodeSubtaskInstructions(sections, subtask);

  if (projectInstructions) {
    sections.push(
      `\n## PROJECT INSTRUCTIONS\n\n` +
      `${projectInstructions}\n`,
    );
  }

  const contextText = context ? formatAutocodeSubtaskContextForPrompt(context) : '';
  if (contextText) {
    sections.push(`\n${contextText}`);
  }

  return sections.join('\n');
}

export function formatAutocodeSubtaskContextForPrompt(context: AutocodeSubtaskContext): string {
  const sections: string[] = [];

  if (Object.keys(context.patterns).length > 0) {
    sections.push('## Reference Files (Patterns to Follow)\n');
    for (const [path, content] of Object.entries(context.patterns)) {
      sections.push(`### \`${path}\`\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  if (Object.keys(context.filesToModify).length > 0) {
    sections.push('## Current File Contents (To Modify)\n');
    for (const [path, content] of Object.entries(context.filesToModify)) {
      sections.push(`### \`${path}\`\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  return sections.join('\n');
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
    steps.forEach((step, index) => sections.push(`${index + 1}. ${step}`));
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
    `3. **Implement the subtask** following local patterns\n` +
    `4. **Run verification** and fix any issues\n` +
    `5. **Commit your changes:**\n` +
    `   \`\`\`bash\n` +
    `   git add .\n` +
    `   git commit -m "autocode: ${subtask.id} - ${subtask.description.slice(0, 50)}"\n` +
    `   \`\`\`\n` +
    `6. **Update the plan** - set this subtask's status to "completed" in implementation_plan.md and add a structured completion_summary for human review. Use this compact Markdown review matrix exactly:\n` +
    `   \`| Item | Details |\n| --- | --- |\n| What changed | ... |\n| Verification | ... |\n| Review notes | ... |\`\n` +
    `   Keep each cell concise, concrete, and suitable for quick manual audit.\n\n` +
    `## Quality Checklist\n\n` +
    `Before marking complete, verify:\n` +
    `- [ ] Follows patterns from reference files\n` +
    `- [ ] No console.log/print debugging statements\n` +
    `- [ ] Error handling in place\n` +
    `- [ ] Verification passes\n` +
    `- [ ] Clean commit with descriptive message\n\n` +
    `## Boundaries\n\n` +
    `- Focus on this subtask; do not modify unrelated code\n` +
    `- If verification fails because of your changes, fix it before committing\n` +
    `- If you encounter a blocker, document it in build-progress.txt\n`,
  );
}
