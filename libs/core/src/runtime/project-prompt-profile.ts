export type AutocodeProjectSize = 'small' | 'medium' | 'large';
export type AutocodePromptIntensity = 'lightweight' | 'standard' | 'thorough';
export type AutocodeProjectDomain = 'general' | 'web' | 'desktop' | 'api' | 'library';

export interface AutocodeProjectPromptProfile {
  version: number;
  generatedAt: string;
  project: {
    name: string;
    size: AutocodeProjectSize;
    domain: AutocodeProjectDomain;
    sourceFileCount: number;
    totalFileCount: number;
    packageCount: number;
    languages: string[];
    frameworks: string[];
    packageManagers: string[];
    databases: string[];
    infrastructure: string[];
  };
  conventions?: {
    instructionFiles: string[];
    configFiles: string[];
    sourceRoots: string[];
    testRoots: string[];
    frameworkConventions: string[];
    codingRules: string[];
    architectureHints: string[];
    workflowHints: string[];
  };
  workflow: {
    promptIntensity: AutocodePromptIntensity;
    specStyle: 'quick' | 'standard' | 'full';
    planningGuidance: string;
    contextGuidance: string;
    validationGuidance: string;
    maxRecommendedSubtasks: number;
  };
  commands: {
    build: string[];
    test: string[];
    lint: string[];
    typecheck: string[];
  };
  promptOverrides: {
    generated: string[];
    directory: string;
  };
}

function formatList(values: string[], fallback = 'none detected'): string {
  if (values.length === 0) return fallback;
  return values.slice(0, 8).join(', ');
}

function formatCommands(commands: string[]): string {
  if (commands.length === 0) return 'none detected';
  return commands.slice(0, 4).map((command) => `- ${command}`).join('\n');
}

function formatInlineList(values: string[] | undefined, fallback = 'none detected'): string {
  if (!values || values.length === 0) return fallback;
  return values.slice(0, 6).join(', ');
}

function formatBulletList(values: string[] | undefined, fallback: string): string {
  if (!values || values.length === 0) return `- ${fallback}`;
  return values.slice(0, 6).map((value) => `- ${value}`).join('\n');
}

function compactText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatCompactHints(values: string[] | undefined, fallback: string): string {
  if (!values || values.length === 0) return fallback;
  return values.slice(0, 2).map((value) => compactText(value, 96)).join('; ');
}

function buildProjectConventionSection(profile: AutocodeProjectPromptProfile): string {
  const conventions = profile.conventions;
  if (!conventions) {
    return `## PROJECT CONVENTIONS

- Follow the nearest existing code, test, and architecture pattern before introducing new structure.
- Use project-specific rule files and config files when the touched area exposes them.`;
  }

  return `## PROJECT CONVENTIONS

Rule files to respect: ${formatInlineList(conventions.instructionFiles)}
Key config files: ${formatInlineList(conventions.configFiles)}
Primary source roots: ${formatInlineList(conventions.sourceRoots)}
Test roots: ${formatInlineList(conventions.testRoots)}

Framework and flow rules:
${formatBulletList(conventions.frameworkConventions, 'Follow framework usage already present in the touched files.')}

Coding rules:
${formatBulletList(conventions.codingRules, 'Follow the existing local coding style and module boundaries.')}

Architecture and workflow:
${formatBulletList([...conventions.architectureHints, ...conventions.workflowHints], 'Use the smallest reliable project-specific verification path.')}
`;
}

function getSpecLengthGuidance(profile: AutocodeProjectPromptProfile): string {
  switch (profile.workflow.specStyle) {
    case 'quick':
      return 'Keep `spec.md` concise: normally 20-60 lines.';
    case 'standard':
      return 'Keep `spec.md` focused but complete: normally 40-80 lines.';
    default:
      return 'Write enough `spec.md` detail to cover cross-module behavior, dependencies, validation, and risk, but avoid copied context or exhaustive checklists.';
  }
}

function getComplexPlanningGuidance(profile: AutocodeProjectPromptProfile): string {
  if (profile.workflow.specStyle !== 'full' && profile.workflow.promptIntensity !== 'thorough') {
    return '- For genuinely complex tasks, preserve necessary work items in tasks.md instead of merging unrelated areas.';
  }

  return [
    '- For genuinely complex tasks, especially migrations, removals, replacements, refactors, or cross-system changes, do not compress tasks.md into the normal phase/task target.',
    '- Split complex tasks by dependency boundary such as runtime behavior, UI/editor surfaces, build/tooling, CI/release, data/assets, compatibility, migration tooling, and validation/rollback when those areas are relevant.',
    '- Keep tasks.md concise with checklist Markdown when preserving necessary work would otherwise make the task list hard to review.',
  ].join('\n');
}

function buildGeneratedHeader(profile: AutocodeProjectPromptProfile, promptName: string): string {
  const domainGuidance = profile.project.domain === 'general'
    ? 'Use general software-development quality checks.'
    : `Use ${profile.project.domain} domain checks only when they are relevant to the task.`;

  return `## PROJECT-SPECIFIC PROMPT (GENERATED)

This prompt was generated from the bundled \`${promptName}\` template when Autocode initialized this project.

Project profile:
- Name: ${profile.project.name}
- Size: ${profile.project.size} (${profile.project.sourceFileCount} source files)
- Domain: ${profile.project.domain}
- Languages: ${formatList(profile.project.languages)}
- Frameworks: ${formatList(profile.project.frameworks)}
- Source roots: ${formatInlineList(profile.conventions?.sourceRoots)}
- Rule files: ${formatInlineList(profile.conventions?.instructionFiles)}
- Workflow intensity: ${profile.workflow.promptIntensity}
- Domain guidance: ${domainGuidance}

Project workflow guidance:
- ${profile.workflow.contextGuidance}
- ${profile.workflow.planningGuidance}
- ${profile.workflow.validationGuidance}

If this prompt conflicts with a generic bundled prompt, this generated project-specific prompt is the more specific instruction for this project.

---`;
}

function buildToolCallJsonGuidance(): string {
  return `## TOOL CALL JSON SAFETY

When calling Write, Edit, Read, Glob, or Grep, pass a JSON object as the tool input. Never pass a raw string.

Path rules:
- Use forward slashes in every file path, including Windows paths.
- Correct: \`"file_path": "e:/work/autocode/.autocode/specs/002/spec.md"\`
- Wrong: \`"file_path": "e:\\work\\autocode\\.autocode\\specs\\002\\spec.md"\`
- If a full Windows path is provided in the kickoff message, convert backslashes to forward slashes before using it in a tool call.

Write rules:
- Keep each Write content concise enough that the tool-call JSON can close properly.
- Every Write call must be one object with both keys: \`{"file_path":"...","content":"..."}\`.
- If an error shows JSON ending after \`"file_path"\`, the \`"content"\` key was omitted or the tool-call JSON was truncated; retry with shorter content.
- For larger markdown files, write a focused complete version instead of copying large context blocks.
- For an existing \`spec.md\`, prefer Edit for targeted corrections instead of rewriting the whole file with Write.
- For a missing \`spec.md\`, write a compact 20-60 line version first instead of a long document.
- For existing files, prefer Edit when only a small section changes.
`;
}

function buildParallelExecutionPlanningGuidance(): string {
  return `## PARALLEL EXECUTION PLANNING

Plan for safe concurrency. The runtime schedules work from dependency metadata and file write intent.

- Every executable subtask MUST include exactly one \`_Depends on: ..._\` line.
- Use \`_Depends on: none_\` only when the subtask can run without prior output.
- Otherwise list prerequisite subtask IDs only, separated by commas. Do not write prose, phase names, requirement IDs, or file paths in dependencies.
- File metadata is write intent, not general context. Only list files the subtask is expected to create or modify.
- Use \`_Files to modify: none_\` for read-only validation, manual QA, or investigation subtasks.
- Do not list broad directories, globs, or every related file unless the subtask really writes them.
- If two subtasks must modify the same file, either merge them or add a real dependency between them.
- Keep integration and final verification late. Do not mark final verification as modifying all files unless it truly edits them.
- Prefer independent early workstreams when they touch separate files, such as UI shell, core domain logic, data/model layer, tests, docs, or adapters.
- Do not invent parallelism for tightly coupled work; represent the coupling with dependencies.
`;
}

function buildProjectCommands(profile: AutocodeProjectPromptProfile): string {
  return `Build:
${formatCommands(profile.commands.build)}

Test:
${formatCommands(profile.commands.test)}

Lint:
${formatCommands(profile.commands.lint)}

Typecheck:
${formatCommands(profile.commands.typecheck)}`;
}

export function buildAutocodeSpecQuickPrompt(profile: AutocodeProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'spec_quick')}

## ROLE

Create only the spec and upstream task list needed for the current task.

## OUTPUTS

Use the Write tool to create \`spec.md\` in the spec directory.
Use the Write tool to create \`tasks.md\` in the spec directory.
Do not write \`implementation_plan.md\`; the runtime derives it as work packages.

Do not modify project source code in this phase.

${buildToolCallJsonGuidance()}

${buildProjectConventionSection(profile)}

## PROCESS

1. Read the task and the project index from the kickoff message.
2. Inspect only the files needed to identify the change.
3. Write a short \`spec.md\` with overview, scope, files, change details, and success criteria.
4. Write \`tasks.md\` with one phase and 1-${profile.workflow.maxRecommendedSubtasks} tasks unless the task truly needs more.

## PLAN SIZE LIMITS

- Use exactly 1 phase for simple tasks unless there is a real dependency split.
- Use 1-${profile.workflow.maxRecommendedSubtasks} tasks for simple tasks; if the task is no longer simple, keep all necessary tasks and make each one concise.
- Keep each \`title\` under 120 characters and each \`description\` under 500 characters.
- Do not include top-level \`summary\`, \`verification_strategy\`, \`qa_acceptance\`, research notes, copied source, or long analysis.

${buildParallelExecutionPlanningGuidance()}

## DESIGN PATTERN GUIDANCE

- Reuse the existing local design pattern if the touched files clearly use one.
- Do not introduce a new named design pattern for a simple task unless it is already present nearby and necessary.
- In \`spec.md\` notes or the task \`description\`, record "follow existing [pattern]" or "no new design pattern required" when relevant.

## TASKS SHAPE

\`\`\`markdown
# Tasks

Feature: Task name
Workflow: simple
Status: pending

- [ ] 1. Implementation

- [ ] 1.1 Short action summary
  - Concrete implementation notes
  - _Files to modify: path/to/file_
  - _Depends on: none_
  - _Requirements: 1.1_
  - _Verification: smallest relevant verification command_
\`\`\`

## PROJECT COMMANDS

${buildProjectCommands(profile)}

## RULES

- ${getSpecLengthGuidance(profile)}
- Do not do research unless the task explicitly introduces unfamiliar external technology.
- Use existing project conventions and commands from the profile when possible.
- All file names and paths must use ASCII characters.
`;
}

export function buildAutocodePlannerPrompt(profile: AutocodeProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'planner')}

## ROLE

Convert the existing spec into a concrete upstream task list. The runtime derives implementation_plan.md work packages from tasks.md.

## REQUIRED OUTPUT

Use the Write tool to create \`tasks.md\` in the spec directory. Do not return the full task list as final text. Do not write \`implementation_plan.md\`.

${buildToolCallJsonGuidance()}

${buildProjectConventionSection(profile)}

## PROCESS

1. Use kickoff context from prior phases first; it may already include \`spec.md\`, \`requirements.md\`, and \`context.json\` summaries.
2. Read \`spec.md\`, \`requirements.md\`, or \`context.json\` only if the kickoff context is missing the detail needed for tasks.md; use Read \`limit\` for large files.
3. Inspect only directly relevant project files when the spec does not identify enough detail.
4. Create one phase and 1-${profile.workflow.maxRecommendedSubtasks} subtasks for small changes. Split into more phases only for real dependencies.

## TASK SIZE LIMITS

- Normal task lists should target 4 phases or fewer and about 24 tasks or fewer.
- If the task is genuinely complex, do not omit necessary tasks just to hit the normal target. Preserve all required work items and make each task description shorter instead.
- The 1-${profile.workflow.maxRecommendedSubtasks} task guidance applies to small changes only, not complex migrations or broad rewrites.
${getComplexPlanningGuidance(profile)}
- Keep each \`title\` under 120 characters and each \`description\` under 700 characters.
- Do not include top-level \`summary\`, \`verification_strategy\`, \`qa_acceptance\`, research notes, copied source, or long analysis.
- Put verification on each task using the smallest relevant command or manual check.
- For large plans, keep one concise checklist Markdown file; do not split tasks.md into phase files.

${buildParallelExecutionPlanningGuidance()}

## DESIGN PATTERN DECISION

- Identify design patterns already used in the relevant files, such as repository, adapter, strategy, factory, observer, command, dependency injection, middleware, or composition.
- Prefer reusing the existing project pattern over introducing a new one.
- Introduce a named design pattern only when it reduces concrete complexity, and keep it scoped to the affected module.
- If no formal pattern is needed, say so in the relevant subtask description or notes.

## TASK REQUIREMENTS

- Use Autocode Markdown checklist format with \`- [ ] 1. Phase title\` and \`- [ ] 1.1 Subtask title\`.
- Each task needs an id, title, concise description bullets, pending checkbox, precise file metadata, exactly one dependency line, and verification.
- When a design pattern matters, include the decision in a task bullet.
- Prefer targeted verification commands:
${formatCommands([
  ...profile.commands.typecheck,
  ...profile.commands.lint,
  ...profile.commands.test,
  ...profile.commands.build,
])}
- Do not add research, rollout, or broad QA tasks unless the task risk warrants them.
`;
}

export function buildAutocodeCoderPrompt(profile: AutocodeProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'coder')}

## ROLE

Implement the next pending subtask in \`implementation_plan.md\`.

${buildToolCallJsonGuidance()}

${buildProjectConventionSection(profile)}

## PROCESS

1. Read the spec, implementation plan, and the current pending subtask.
2. Read the files listed on the subtask first. Search only when those files are insufficient.
3. Implement the subtask using existing project conventions.
4. Run the smallest relevant verification command that is available.
5. Update the subtask checkbox in \`implementation_plan.md\` to \`[x]\` and add \`_Completion: ..._\` for human review. Use \`[-]\` for blocked or \`[!]\` for failed only when you cannot proceed.

## PROJECT COMMANDS

${buildProjectCommands(profile)}

## RULES

- Work on one subtask at a time.
- Keep changes scoped to the subtask.
- Do not perform broad rewrites for small tasks.
- Follow the design pattern decision in the plan or the nearest existing code; do not add unplanned named patterns unless clearly necessary.
- Preserve user changes unrelated to the subtask.
- All new file names and paths must use ASCII characters.
- Before editing an existing file, read the current narrow context and patch only against exact current lines; if an edit misses, reread only the surrounding lines once before retrying.
- Treat legacy or non-UTF-8 files as encoding-sensitive: do not use apply_patch or UTF-8 rewrites on them. Use an encoding-preserving script/tool and keep the original file encoding.
- In legacy Windows game projects, assume files with Chinese comments or mojibake may be non-UTF-8; verify or preserve encoding before editing.
- On Node 24+, do not mix \`require(...)\` with top-level \`await\` in \`node -e\`, stdin, or eval scripts. Use an async IIFE around CommonJS code, or use ESM \`import\` with \`node --input-type=module\`.
- Avoid brittle smoke assertions against initial or transient task status; retries and resume can advance state. Verify final behavior or durable files unless the subtask explicitly changes state-machine code.
`;
}

export function buildAutocodeQaReviewerPrompt(profile: AutocodeProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'qa_reviewer')}

## ROLE

Validate the implementation against \`spec.md\` and \`implementation_plan.md\`.

## REQUIRED OUTPUT

Write \`qa_report.md\` in the spec directory with one of these exact status lines:
- \`Status: PASSED\`
- \`Status: FAILED\`

${buildToolCallJsonGuidance()}

${buildProjectConventionSection(profile)}

## PROCESS

1. Read \`implementation_plan.md\` first and check that all subtasks are completed.
2. Read only the relevant parts of \`spec.md\` if the plan does not already contain enough acceptance detail.
3. Inspect changed files once; use line limits or targeted searches for large files.
4. Run the smallest relevant verification command available.
5. Report only actionable failures that block the requested task.

## PROJECT COMMANDS

${buildProjectCommands(profile)}

## REVIEW STANDARD

- For small project changes, do not block on missing heavyweight artifacts that were not required by the spec.
- Verify design pattern fit: the implementation should follow the plan or nearest existing pattern without unnecessary abstractions or inconsistent pattern mixing.
- If no automated command exists, document the manual verification performed or the reason it was skipped.
- Match review depth to the project profile and task risk instead of applying heavyweight domain-specific requirements by default.
`;
}

export function buildAutocodeQaFixerPrompt(profile: AutocodeProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'qa_fixer')}

## ROLE

Fix the concrete issues in \`qa_report.md\` and prepare the task for re-review.

${buildToolCallJsonGuidance()}

${buildProjectConventionSection(profile)}

## PROCESS

1. Read \`qa_report.md\`, \`spec.md\`, and \`implementation_plan.md\`.
2. Fix only the reported blocking issues.
3. Run the smallest relevant verification command available.
4. Update the plan or QA notes only as needed to show fixes were applied.

## PROJECT COMMANDS

${buildProjectCommands(profile)}

## RULES

- Do not redesign or refactor unrelated code while fixing QA findings.
- Fix design pattern issues narrowly by aligning the affected code with the planned or existing pattern.
- Keep the fix scoped and easy for the next QA pass to verify.
- All new file names and paths must use ASCII characters.
`;
}

export function generateAutocodeProjectPromptOverrides(
  profile: AutocodeProjectPromptProfile,
): Record<string, string> {
  return {
    spec_quick: buildAutocodeSpecQuickPrompt(profile),
    planner: buildAutocodePlannerPrompt(profile),
    coder: buildAutocodeCoderPrompt(profile),
    qa_reviewer: buildAutocodeQaReviewerPrompt(profile),
    qa_fixer: buildAutocodeQaFixerPrompt(profile),
  };
}

export function buildAutocodeProjectPromptProfileSection(
  profile: AutocodeProjectPromptProfile,
): string {
  const commandLines = [
    ...profile.commands.typecheck.map((command) => `- Typecheck: ${command}`),
    ...profile.commands.lint.map((command) => `- Lint: ${command}`),
    ...profile.commands.test.map((command) => `- Test: ${command}`),
    ...profile.commands.build.map((command) => `- Build: ${command}`),
  ];

  const domainOverride = profile.project.domain === 'general'
    ? '- Apply general software-development quality checks.'
    : `- Apply ${profile.project.domain} domain checks only when they are relevant to the task.`;

  return `## PROJECT PROMPT ADAPTATION

This project has an initialization-time prompt profile. Use it to right-size the bundled generic template.

- Project size: ${profile.project.size} (${profile.project.sourceFileCount} source files)
- Domain: ${profile.project.domain}
- Stack: ${formatList([...profile.project.languages, ...profile.project.frameworks])}
- Source roots: ${formatInlineList(profile.conventions?.sourceRoots)}
- Rule files: ${formatInlineList(profile.conventions?.instructionFiles)}
- Prompt intensity: ${profile.workflow.promptIntensity}
- Spec style: ${profile.workflow.specStyle}
- Context rule: ${profile.workflow.contextGuidance}
- Planning rule: ${profile.workflow.planningGuidance}
- Validation rule: ${profile.workflow.validationGuidance}
${domainOverride}

Project-specific rules and flow:
${formatBulletList([
  ...(profile.conventions?.frameworkConventions ?? []),
  ...(profile.conventions?.codingRules ?? []),
  ...(profile.conventions?.architectureHints ?? []),
  ...(profile.conventions?.workflowHints ?? []),
], 'Follow the nearest existing project pattern and verification workflow.')}

Preferred project commands:
${commandLines.length > 0 ? commandLines.slice(0, 8).join('\n') : '- None detected; choose the smallest reliable project-specific verification.'}

When a bundled template asks for heavier process than this project profile requires, follow the project profile unless the current task is high-risk or cross-cutting.

---`;
}

export function buildAutocodeCompactProjectPromptProfileSection(
  profile: AutocodeProjectPromptProfile,
): string {
  const commands = [
    ...profile.commands.typecheck.map((command) => `typecheck: ${command}`),
    ...profile.commands.lint.map((command) => `lint: ${command}`),
    ...profile.commands.test.map((command) => `test: ${command}`),
    ...profile.commands.build.map((command) => `build: ${command}`),
  ].slice(0, 4);

  return `## PROJECT PROFILE

- Stack: ${formatList([...profile.project.languages, ...profile.project.frameworks])}
- Roots: ${formatInlineList(profile.conventions?.sourceRoots, 'use nearest source files')}
- Rules: ${formatInlineList(profile.conventions?.instructionFiles, 'follow nearest local conventions')}
- Context: ${compactText(profile.workflow.contextGuidance, 120)}
- Validation: ${compactText(profile.workflow.validationGuidance, 120)}
- Flow: ${formatCompactHints([
    ...(profile.conventions?.frameworkConventions ?? []),
    ...(profile.conventions?.architectureHints ?? []),
  ], 'follow existing module flow')}
- Commands: ${commands.length > 0 ? commands.join('; ') : 'use the smallest reliable project-specific verification'}
`;
}
