import { foldRepeatedAutocodePromptLines } from './prompt-context.js';

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
    specStyle: 'standard' | 'full';
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
  const compact = uniqueProfileValues(values).slice(0, 8);
  if (compact.length === 0) return fallback;
  return compact.join(', ');
}

function formatCommands(commands: string[]): string {
  const compact = uniqueProfileValues(commands).slice(0, 4);
  if (compact.length === 0) return 'none detected';
  return compact.map((command) => `- ${command}`).join('\n');
}

function formatInlineList(values: string[] | undefined, fallback = 'none detected'): string {
  const compact = uniqueProfileValues(values).slice(0, 6);
  if (compact.length === 0) return fallback;
  return compact.join(', ');
}

function formatBulletList(values: string[] | undefined, fallback: string): string {
  const compact = uniqueProfileValues(values).slice(0, 6);
  if (compact.length === 0) return `- ${fallback}`;
  return compact.map((value) => `- ${compactText(value, 160)}`).join('\n');
}

function compactText(value: string, maxLength: number): string {
  const compact = normalizeProfilePromptText(value);
  if (compact.length <= maxLength) return compact;
  if (maxLength <= 3) return compact.slice(0, maxLength);
  return `${compact.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatCompactHints(values: string[] | undefined, fallback: string): string {
  const compact = uniqueProfileValues(values).slice(0, 2);
  if (compact.length === 0) return fallback;
  return compact.map((value) => compactText(value, 96)).join('; ');
}

function uniqueProfileValues(values: string[] | undefined): string[] {
  const compact: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalizeProfilePromptText(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    compact.push(normalized);
  }
  return compact;
}

function normalizeProfilePromptText(value: string): string {
  return foldRepeatedAutocodePromptLines(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
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

function getComplexPlanningGuidance(profile: AutocodeProjectPromptProfile): string {
  if (profile.workflow.specStyle !== 'full' && profile.workflow.promptIntensity !== 'thorough') {
    return '- For genuinely complex tasks, preserve necessary work items in tasks.md instead of merging unrelated areas.';
  }

  return [
    '- For genuinely complex tasks, especially migrations, removals, replacements, refactors, or cross-system changes, preserve the full task breakdown in tasks.md.',
    '- Split complex tasks by dependency boundary such as runtime behavior, UI/editor surfaces, build/tooling, CI/release, data/assets, compatibility, migration tooling, and validation/rollback when those areas are relevant.',
    '- Keep tasks.md concise with checklist Markdown when preserving necessary work would otherwise make the task list hard to review.',
  ].join('\n');
}

function getSpecStyleLabel(profile: AutocodeProjectPromptProfile): string {
  switch (profile.workflow.specStyle) {
    case 'standard':
      return 'Standard';
    default:
      return 'full Standard';
  }
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
- If two subtasks modify the same file, keep them as separate leaf tasks and use \`_Depends on: none_\` when neither consumes the other's output; the runtime file-conflict scheduler will queue overlapping writes safely.
- Keep integration and final verification late. Do not mark final verification as modifying all files unless it truly edits them.
- Prefer independent early workstreams when they touch separate files, such as UI shell, core domain logic, data/model layer, tests, docs, or adapters.
- Shared files are not a reason to make broad tasks or artificial dependency chains; add dependencies only for real data, contract, or verification order.
- Do not invent parallelism for tightly coupled work; represent the coupling with dependencies.
`;
}

function buildFocusedTaskDecompositionGuidance(): string {
  return `## Focused Task Decomposition

Write tasks the way focused task plans should read: small behavior slices, clear evidence, and one practical verification path.

- Treat each requirement, scenario, acceptance criterion, public contract, user-visible behavior, migration step, error path, and verification scenario as a candidate leaf task.
- A leaf task normally covers one independently reviewable behavior or contract plus one focused verification path.
- Split tasks that combine gameplay rules, UI surfaces, IPC/API contracts, persistence, build/tooling, and tests.
- If a task has more than three behaviors, more than three requirement/acceptance references, or more than four write-intent files, split it and connect the pieces with real dependencies.
- For games or interactive tools, split rules, player actions, rendering, input mapping, scoring/progression, persistence, responsive controls, and end-to-end validation.
- Runnable apps, browser pages, games, launchers, tools, and CLIs need startup/open/use-path evidence plus a health check. Static checks alone are not enough.
- Prefer more short leaf tasks over fewer broad tasks with long prose.
`;
}

function buildRuntimeReadinessPromptRules(): string {
  return [
    '- For user-facing apps, browser pages, games, interactive tools, launchers, or CLI deliverables, verification must include actual launch/open/use-path smoke evidence.',
    '- Static syntax, unit, lint, typecheck, build, or file-existence checks alone are not enough to approve a runnable deliverable.',
    '- Completion and QA evidence must state the startup/open result plus console/resource-load/blank-screen/rendering/primary-path/exit-code health result.',
    '- Treat browser console errors, CORS/resource-load failures, blank screens, crash/hang, startup failures, and CLI non-zero exits as blocking runtime-readiness failures.',
  ].join('\n');
}

function buildArchitectureGroundingGuidance(): string {
  return `## Architecture Grounding

Plan from the project's real boundaries, not a generic delivery template.

- First identify the affected boundary: UI/view, state/store, IPC/API, service/domain, persistence, worker/background process, build/tooling, tests, or docs.
- Simple single-boundary tasks can stay direct: follow the nearest existing boundary and avoid forced pattern names.
- Complex tasks need visible architecture guidance: cross-module work, public contracts, persistence, workers/processes, migrations, refactors, concurrency, security, runtime deliverables, or broad UI/state changes.
- For complex tasks, add a compact \`## Architecture And Design Pattern References\` section with 4-8 useful bullets. Each bullet should name the boundary, strategy, source/docs/Project Memory or \`General guidance\`, and the task IDs or implementation boundary it applies to.
- Use Memory Context or Project Memory when it matches the current source/docs. Current project evidence wins over memory.
- Complex executable tasks should include one short \`_Architecture: boundary; strategy; source/reference_\` line.
- Use exactly one architecture metadata line per task and keep the key in English: \`_Architecture: ..._\`.
- If the boundary or pattern is unclear, add one targeted discovery/validation task instead of guessing.
`;
}

function buildDocumentationAnalysisPlanningGuidance(): string {
  return `## Documentation And Analysis Deliverables

For analysis, investigation, report, or documentation-only tasks, make the final Markdown reader-first.

- Answer the user's concrete question before long source evidence.
- Plan an early \`Conclusion Snapshot\` or localized equivalent.
- Plan an early \`Main Flow\` with a Mermaid diagram or numbered flow when it helps.
- Organize the body by user scenario, operational path, current behavior, visible result, limitation, and next action.
- Keep source evidence as short inline citations and move large evidence tables or verification templates to an appendix.
- Do not make inputs/outputs/side effects/lifecycle/errors the top-level document structure unless the user asked for that format.
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

export function buildAutocodePlannerPrompt(profile: AutocodeProjectPromptProfile): string {
  return [
    buildGeneratedHeader(profile, 'planner'),
    '',
    '## Role',
    '',
    'Create or repair the static definition catalog in `tasks.md`. The runtime derives `implementation_plan.md`; do not write it.',
    '',
    '## Output',
    '',
    'Write only `tasks.md` in the spec directory. Read approved `requirements.md`, `spec.md`, all five design-package files (`requirement_model.md`, `domain_model.md`, `design.md`, `design_model.md`, and `implementation_model.md`), and `design_review.md`; do not edit them.',
    '',
    buildToolCallJsonGuidance(),
    '',
    buildProjectConventionSection(profile),
    '',
    '## Process',
    '',
    '1. Read the approved requirement, scenario, and design IDs before defining work.',
    '2. Inspect only directly relevant project files when spec evidence is insufficient.',
    '3. Create concise checklist tasks from real dependency and project boundaries.',
    '4. Leave unknowns as assumptions, blocked items, or validation tasks; do not guess.',
    '',
    '## Request Changes',
    '',
    '- Apply only when valid `HUMAN_INPUT.md` or non-empty `change_requests.jsonl` exists.',
    '- Treat the latest entry as the same-task contract, not a new task.',
    '- Edit only still-pending definitions in place. Keep completed historical definitions unchanged and add revised work under a new task ID.',
    '- Never prefix task titles with revision, obsolete, retry, or history markers.',
    '',
    '## Task Rules',
    '',
    '- Cover every applicable R*, AC*, SCN-*, SYS-*, required IMP-*, and selected PAT-* ID.',
    '- Resolve design IDs from their canonical package owner; never assume every ID is defined in `design.md`.',
    '- Split only when it improves execution safety or reviewability.',
    '- Keep each executable task small enough for one focused coding session.',
    '- Every executable task needs precise file metadata, exactly one dependency line, `_Requirements: ..._`, `_Design: ..._`, one `_Evidence: E*; ..._`, `_Done when: ..._`, and `_Verification: ..._`.',
    '- Shared files are not dependency evidence; the runtime file-conflict scheduler queues overlapping writes.',
    '- Add architecture metadata only for cross-boundary, migration, schema/compatibility, or high-risk work.',
    '- Do not add research, rollout, cleanup, or broad QA tasks unless task risk requires them.',
    '- Omit copied source, long rationale, top-level `summary`, `verification_strategy`, and `qa_acceptance`.',
    buildRuntimeReadinessPromptRules(),
    '',
    '## Checklist Shape',
    '',
    '```markdown',
    '# Tasks',
    '',
    'Tasks-Contract: 1',
    '',
    '- [ ] 1. Phase title',
    '  - Purpose',
    '',
    '- [ ] 1.1 Action title',
    '  - Implementation guidance',
    '  - _Files to modify: path/to/file_',
    '  - _Depends on: none_',
    '  - _Requirements: R1, AC1, SCN-001_',
    '  - _Design: SYS-001, DES-001, FLOW-001, IMP-001_',
    '  - _Evidence: E1; source pattern_',
    '  - _Done when: behavior works and verification passes_',
    '  - _Verification: targeted command or manual runtime check_',
    '```',
    '',
    'All phase and task checkboxes are [ ]; tasks.md never stores execution state.',
    '',
    '## Project Commands',
    '',
    buildProjectCommands(profile),
    '',
    'Final response: task count, phase count, and blocking assumptions only.',
  ].join('\n');
}
export function buildAutocodeCoderPrompt(profile: AutocodeProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'coder')}

## Role

Implement the current work package from the kickoff context. Keep the change narrow and review-ready.

${buildToolCallJsonGuidance()}

${buildProjectConventionSection(profile)}

## Process

1. Use the kickoff work-package details first. If they are absent, join the pending ledger entry's source task IDs with \`tasks.md\`; do not expect static task details in \`implementation_plan.md\`.
2. Read the task's evidence/files and referenced IDs from their owning five-file design-package artifacts first; search only when those sources are insufficient.
3. Identify the local contract before editing: inputs, outputs, lifecycle, side effects, errors, public APIs/schemas/config, persistence/data shape, and caller/callee expectations.
4. Implement with existing project conventions.
5. Run the smallest reliable verification.
6. Report changed files, verification, completion evidence, blockers, and residual risk. The runtime records status, timing, retries, failures, summaries, and commits.

## Project Commands

${buildProjectCommands(profile)}

## Guardrails

- Work on one subtask at a time.
- Keep changes scoped to the subtask.
- Do not edit \`tasks.md\` or \`implementation_plan.md\`; they are owned by planning and the runtime respectively.
- Follow the design pattern decision in the plan or the nearest existing code; do not add unplanned named patterns unless clearly necessary.
- Preserve public APIs, schemas, IPC/protocol contracts, config/env semantics, migrations, data formats, persistence, side effects, and error behavior unless the subtask requires a contract change.
- If a contract changes, update affected callers, tests, fixtures, docs, and validation in the same pass.
- Do not leave placeholder code, TODO implementations, no-op handlers, fake data, disabled validation, dead branches, broad type escapes, swallowed errors, or unrelated abstractions.
- Add or update the closest regression test for bug fixes or behavior changes when a nearby pattern exists. If no practical test is available, state the exact limitation.
- Preserve user changes unrelated to the subtask.
- All new file names and paths must use ASCII characters.
- Before editing an existing file, read the current narrow context and patch only against exact current lines; if an edit misses, reread only the surrounding lines once before retrying.
- Treat legacy or non-UTF-8 files as encoding-sensitive: do not use apply_patch or UTF-8 rewrites on them. Use an encoding-preserving script/tool and keep the original file encoding.
- In legacy Windows game projects, assume files with Chinese comments or mojibake may be non-UTF-8; verify or preserve encoding before editing.
- On Node 24+, do not mix \`require(...)\` with top-level \`await\` in \`node -e\`, stdin, or eval scripts. Use an async IIFE around CommonJS code, or use ESM \`import\` with \`node --input-type=module\`.
- Avoid brittle smoke assertions against initial or transient task status; retries and resume can advance state. Verify final behavior or durable files unless the subtask explicitly changes state-machine code.
${buildRuntimeReadinessPromptRules()}
- For user-facing or runnable work, do not mark the subtask complete until the launch/open/browser/CLI smoke path passes. Name that check in the completion summary.
`;
}

export function buildAutocodeQaReviewerPrompt(profile: AutocodeProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'qa_reviewer')}

## Role

Decide whether the implementation is ready for human review. Report blocking issues with evidence; do not fix code.

## Required Output

Write \`qa_report.md\` in the spec directory with one of these exact status lines:
- \`Status: PASSED\`
- \`Status: FAILED\`

${buildToolCallJsonGuidance()}

${buildProjectConventionSection(profile)}

## Process

1. Read \`implementation_plan.md\` first and check that all subtasks are completed.
2. Read only the relevant parts of \`spec.md\` if the plan does not already contain enough acceptance detail.
3. Inspect changed files once; use line limits or targeted searches for large files.
4. For each changed behavior, map requirement/evidence -> changed file/contract -> verification result -> residual risk.
5. Run the smallest relevant verification command available.
6. Report only actionable failures that block the requested task.

## Project Commands

${buildProjectCommands(profile)}

## Review Standard

- For small project changes, do not block on missing heavyweight artifacts that were not required by the spec.
- Verify that implementation follows the plan or nearest existing pattern without unnecessary abstractions.
- Verify changed contracts: public APIs, schemas, IPC/protocols, config/env behavior, data formats, persistence, side effects, and error behavior.
- Build a compact acceptance matrix for changed behaviors.
- \`qa_report.md\` must include: Scope Reviewed, Changed Files And Contracts, Acceptance Matrix, Verification, Findings, and Residual Risks.
- If failed, every finding needs title, severity, location, evidence, impacted requirement/contract, required fix, and re-verification.
- If no automated command exists, document the manual verification performed or the reason it was skipped.
- Match review depth to the project profile and task risk instead of applying heavyweight domain-specific requirements by default.
${buildRuntimeReadinessPromptRules()}
- For user-facing or runnable deliverables, reject \`Status: PASSED\` when runtime readiness is missing, skipped, impossible, or failed.
`;
}

export function buildAutocodeQaFixerPrompt(profile: AutocodeProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'qa_fixer')}

## Role

Fix the concrete issues in \`qa_report.md\` and prepare the task for re-review.

${buildToolCallJsonGuidance()}

${buildProjectConventionSection(profile)}

## Process

1. Read \`qa_report.md\`, \`spec.md\`, and \`implementation_plan.md\`.
2. For each issue, identify the impacted requirement, contract, and caller/callee expectations before editing.
3. Fix only the reported blocking issues.
4. Update callers, tests, schemas, configs, or docs when a fix intentionally changes a contract.
5. Run the smallest relevant verification command available.
6. Report the fixes and verification evidence for the runtime and next QA pass to record.

## Project Commands

${buildProjectCommands(profile)}

## Rules

- Do not redesign or refactor unrelated code while fixing QA findings.
- Do not edit \`tasks.md\`, \`implementation_plan.md\`, or the QA verdict; the planner, runtime, and reviewer own those artifacts.
- Fix design pattern issues narrowly by aligning the affected code with the planned or existing pattern.
- Preserve public APIs, schemas, IPC/protocols, config/env behavior, data formats, persistence, side effects, and error behavior unless QA explicitly requires a contract change.
- Do not use placeholder code, TODO implementations, no-op handlers, fake data, disabled validation, broad type escapes, swallowed errors, or unrelated abstractions.
- Keep the fix scoped and easy for the next QA pass to verify.
- All new file names and paths must use ASCII characters.
${buildRuntimeReadinessPromptRules()}
- When QA found startup, open, playability, or CLI execution failures, rerun the exact runtime-readiness smoke path after the fix.
`;
}

export function generateAutocodeProjectPromptOverrides(
  profile: AutocodeProjectPromptProfile,
): Record<string, string> {
  return {
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
- Spec style: ${getSpecStyleLabel(profile)}
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
  const commands = uniqueProfileValues([
    ...profile.commands.typecheck.map((command) => `typecheck: ${command}`),
    ...profile.commands.lint.map((command) => `lint: ${command}`),
    ...profile.commands.test.map((command) => `test: ${command}`),
    ...profile.commands.build.map((command) => `build: ${command}`),
  ]).slice(0, 4);

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
