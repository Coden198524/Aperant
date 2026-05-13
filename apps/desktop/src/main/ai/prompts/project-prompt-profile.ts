/**
 * Project Prompt Profile
 * ======================
 *
 * Builds a lightweight, project-specific prompt profile during project
 * initialization. The bundled prompts remain the canonical templates; this
 * profile adapts them to the current project's size, stack, and validation
 * commands so small projects are not forced through heavyweight defaults.
 */

import {
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  sep,
} from 'node:path';

import { FrameworkDetector } from '../project/framework-detector';
import { StackDetector } from '../project/stack-detector';

export const PROJECT_PROMPT_PROFILE_VERSION = 10;
export const PROJECT_PROMPT_PROFILE_PATH = join('.autocode', 'prompt_profile.json');
export const PROJECT_PROMPTS_PATH = join('.autocode', 'prompts');

type ProjectSize = 'small' | 'medium' | 'large';
type PromptIntensity = 'lightweight' | 'standard' | 'thorough';
type ProjectDomain = 'general' | 'web' | 'desktop' | 'api' | 'library';

export interface ProjectPromptProfile {
  version: number;
  generatedAt: string;
  project: {
    name: string;
    size: ProjectSize;
    domain: ProjectDomain;
    sourceFileCount: number;
    totalFileCount: number;
    packageCount: number;
    languages: string[];
    frameworks: string[];
    packageManagers: string[];
    databases: string[];
    infrastructure: string[];
  };
  workflow: {
    promptIntensity: PromptIntensity;
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

interface ScanStats {
  totalFileCount: number;
  sourceFileCount: number;
  testFileCount: number;
  packageJsonPaths: string[];
}

interface PackageManifestInfo {
  dir: string;
  relativeDir: string;
  packageManager: string;
  scripts: Record<string, string>;
}

const EXCLUDED_DIRECTORIES = new Set([
  '.autocode',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
]);

const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.dart',
  '.ex',
  '.exs',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
  '.svelte',
]);

const PROJECT_PROMPT_NAMES = [
  'spec_quick',
  'planner',
  'coder',
  'qa_reviewer',
  'qa_fixer',
] as const;

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join('/');
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function scanProject(projectPath: string): ScanStats {
  const stats: ScanStats = {
    totalFileCount: 0,
    sourceFileCount: 0,
    testFileCount: 0,
    packageJsonPaths: [],
  };

  const maxDepth = 6;
  const maxFiles = 5000;

  function visit(dir: string, depth: number): void {
    if (depth > maxDepth || stats.totalFileCount >= maxFiles) return;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (stats.totalFileCount >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        visit(join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const filePath = join(dir, entry.name);
      const relPath = toPosixPath(relative(projectPath, filePath));
      const lowerRelPath = relPath.toLowerCase();
      stats.totalFileCount += 1;

      if (entry.name === 'package.json') {
        stats.packageJsonPaths.push(filePath);
      }

      const ext = extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext)) {
        stats.sourceFileCount += 1;
        if (
          lowerRelPath.includes('/__tests__/') ||
          lowerRelPath.includes('/tests/') ||
          lowerRelPath.includes('/test/') ||
          lowerRelPath.includes('.test.') ||
          lowerRelPath.includes('.spec.') ||
          lowerRelPath.includes('.e2e.')
        ) {
          stats.testFileCount += 1;
        }
      }
    }
  }

  visit(projectPath, 0);
  return stats;
}

function detectPackageManager(projectPath: string, manifestDir: string, detectedManagers: string[]): string {
  if (existsSync(join(manifestDir, 'pnpm-lock.yaml')) || existsSync(join(projectPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(manifestDir, 'yarn.lock')) || existsSync(join(projectPath, 'yarn.lock'))) {
    return 'yarn';
  }
  if (
    existsSync(join(manifestDir, 'bun.lock')) ||
    existsSync(join(manifestDir, 'bun.lockb')) ||
    existsSync(join(projectPath, 'bun.lock')) ||
    existsSync(join(projectPath, 'bun.lockb'))
  ) {
    return 'bun';
  }
  if (existsSync(join(manifestDir, 'package-lock.json')) || existsSync(join(projectPath, 'package-lock.json'))) {
    return 'npm';
  }
  return detectedManagers.find((manager) => ['pnpm', 'yarn', 'bun', 'npm'].includes(manager)) ?? 'npm';
}

function readPackageManifests(projectPath: string, packageJsonPaths: string[], detectedManagers: string[]): PackageManifestInfo[] {
  return packageJsonPaths
    .map((packageJsonPath) => {
      const raw = safeReadJson(packageJsonPath);
      if (!raw) return null;
      const manifestDir = dirname(packageJsonPath);
      const relativeDir = toPosixPath(relative(projectPath, manifestDir)) || '.';
      return {
        dir: manifestDir,
        relativeDir,
        packageManager: detectPackageManager(projectPath, manifestDir, detectedManagers),
        scripts: raw.scripts && typeof raw.scripts === 'object'
          ? raw.scripts as Record<string, string>
          : {},
      } satisfies PackageManifestInfo;
    })
    .filter((manifest): manifest is PackageManifestInfo => manifest !== null);
}

function buildScriptCommand(manifest: PackageManifestInfo, scriptName: string): string {
  const prefix = manifest.relativeDir === '.' ? '' : `cd ${manifest.relativeDir} && `;
  switch (manifest.packageManager) {
    case 'pnpm':
      return `${prefix}pnpm run ${scriptName}`;
    case 'yarn':
      return `${prefix}yarn ${scriptName}`;
    case 'bun':
      return `${prefix}bun run ${scriptName}`;
    default:
      return `${prefix}npm run ${scriptName}`;
  }
}

function collectScriptCommands(
  manifests: PackageManifestInfo[],
  scriptNames: string[],
): string[] {
  const commands: string[] = [];
  for (const manifest of manifests) {
    for (const scriptName of scriptNames) {
      if (scriptName in manifest.scripts) {
        commands.push(buildScriptCommand(manifest, scriptName));
      }
    }
  }
  return uniqueSorted(commands).slice(0, 6);
}

function inferProjectSize(stats: ScanStats): ProjectSize {
  if (stats.sourceFileCount <= 40 && stats.packageJsonPaths.length <= 2) {
    return 'small';
  }
  if (stats.sourceFileCount <= 250 && stats.totalFileCount <= 1500) {
    return 'medium';
  }
  return 'large';
}

function inferProjectDomain(frameworks: string[], stats: ScanStats): ProjectDomain {
  const frameworkSet = new Set(frameworks);
  if (frameworkSet.has('electron') || frameworkSet.has('tauri')) return 'desktop';
  if (
    frameworkSet.has('express') ||
    frameworkSet.has('fastapi') ||
    frameworkSet.has('django') ||
    frameworkSet.has('flask') ||
    frameworkSet.has('nestjs')
  ) {
    return 'api';
  }
  if (
    frameworkSet.has('react') ||
    frameworkSet.has('vue') ||
    frameworkSet.has('svelte') ||
    frameworkSet.has('nextjs') ||
    frameworkSet.has('nuxt') ||
    frameworkSet.has('astro')
  ) {
    return 'web';
  }
  if (stats.sourceFileCount <= 30) return 'library';
  return 'general';
}

function inferWorkflow(
  size: ProjectSize,
): ProjectPromptProfile['workflow'] {
  if (size === 'small') {
    return {
      promptIntensity: 'lightweight',
      specStyle: 'quick',
      planningGuidance: 'Use one implementation phase and 1-3 subtasks unless the request clearly spans separate modules.',
      contextGuidance: 'Prefer targeted file reads. Do not perform broad discovery when the task already points to the affected files.',
      validationGuidance: 'Run the smallest relevant build, typecheck, lint, or test command available. Manual verification is acceptable for simple UI/text changes.',
      maxRecommendedSubtasks: 3,
    };
  }
  if (size === 'medium') {
    return {
      promptIntensity: 'standard',
      specStyle: 'standard',
      planningGuidance: 'Use enough phases to separate dependencies, but avoid research/self-critique unless risk or unfamiliar technology requires it.',
      contextGuidance: 'Use the project index first, then inspect only the files and patterns needed for the task.',
      validationGuidance: 'Run targeted tests plus one broader confidence check when available.',
      maxRecommendedSubtasks: 8,
    };
  }
  return {
    promptIntensity: 'thorough',
    specStyle: 'full',
    planningGuidance: 'Use explicit phases for cross-service dependencies, migrations, integration points, and rollout/rollback work.',
    contextGuidance: 'Perform deeper discovery and pattern analysis before planning or coding.',
    validationGuidance: 'Run layered validation: unit or targeted tests, integration checks, and build/typecheck/lint where available.',
    maxRecommendedSubtasks: 15,
  };
}

function appendNonNodeCommands(
  projectPath: string,
  commands: ProjectPromptProfile['commands'],
  frameworks: string[],
): void {
  if (existsSync(join(projectPath, 'Cargo.toml'))) {
    commands.build.push('cargo build');
    commands.test.push('cargo test');
  }
  if (existsSync(join(projectPath, 'go.mod'))) {
    commands.build.push('go build ./...');
    commands.test.push('go test ./...');
  }
  if (
    existsSync(join(projectPath, 'pyproject.toml')) ||
    existsSync(join(projectPath, 'requirements.txt'))
  ) {
    if (frameworks.includes('pytest')) commands.test.push('pytest');
    if (frameworks.includes('ruff')) commands.lint.push('ruff check .');
    if (frameworks.includes('mypy')) commands.typecheck.push('mypy .');
  }
}

export function generateProjectPromptProfile(projectPath: string): ProjectPromptProfile {
  const resolvedProjectPath = statSync(projectPath).isDirectory() ? projectPath : dirname(projectPath);
  const stack = new StackDetector(resolvedProjectPath).detectAll();
  const frameworks = uniqueSorted([
    ...stack.frameworks,
    ...new FrameworkDetector(resolvedProjectPath).detectAll(),
  ]);
  const stats = scanProject(resolvedProjectPath);
  const packageManifests = readPackageManifests(
    resolvedProjectPath,
    stats.packageJsonPaths,
    stack.packageManagers,
  );
  const size = inferProjectSize(stats);
  const workflow = inferWorkflow(size);
  const commands: ProjectPromptProfile['commands'] = {
    build: collectScriptCommands(packageManifests, ['build', 'compile', 'package']),
    test: collectScriptCommands(packageManifests, ['test', 'test:unit', 'test:integration', 'test:e2e']),
    lint: collectScriptCommands(packageManifests, ['lint', 'check', 'biome', 'eslint']),
    typecheck: collectScriptCommands(packageManifests, ['typecheck', 'tsc']),
  };
  appendNonNodeCommands(resolvedProjectPath, commands, frameworks);

  return {
    version: PROJECT_PROMPT_PROFILE_VERSION,
    generatedAt: new Date().toISOString(),
    project: {
      name: basename(resolvedProjectPath),
      size,
      domain: inferProjectDomain(frameworks, stats),
      sourceFileCount: stats.sourceFileCount,
      totalFileCount: stats.totalFileCount,
      packageCount: packageManifests.length,
      languages: uniqueSorted(stack.languages),
      frameworks,
      packageManagers: uniqueSorted(stack.packageManagers),
      databases: uniqueSorted(stack.databases),
      infrastructure: uniqueSorted(stack.infrastructure),
    },
    workflow,
    commands: {
      build: uniqueSorted(commands.build),
      test: uniqueSorted(commands.test),
      lint: uniqueSorted(commands.lint),
      typecheck: uniqueSorted(commands.typecheck),
    },
    promptOverrides: {
      generated: [...PROJECT_PROMPT_NAMES],
      directory: PROJECT_PROMPTS_PATH,
    },
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

function getSpecLengthGuidance(profile: ProjectPromptProfile): string {
  switch (profile.workflow.specStyle) {
    case 'quick':
      return 'Keep `spec.md` concise: normally 20-60 lines.';
    case 'standard':
      return 'Keep `spec.md` focused but complete: normally 40-80 lines.';
    default:
      return 'Write enough `spec.md` detail to cover cross-module behavior, dependencies, validation, and risk, but avoid copied context or exhaustive checklists.';
  }
}

function getComplexPlanningGuidance(profile: ProjectPromptProfile): string {
  if (profile.workflow.specStyle !== 'full' && profile.workflow.promptIntensity !== 'thorough') {
    return '- For genuinely complex tasks, preserve necessary work items and use split plan files instead of merging unrelated areas.';
  }

  return [
    '- For genuinely complex tasks, especially migrations, removals, replacements, refactors, or cross-system changes, do not compress the plan into the normal phase/subtask target.',
    '- Split complex plans by dependency boundary such as runtime behavior, UI/editor surfaces, build/tooling, CI/release, data/assets, compatibility, migration tooling, and validation/rollback when those areas are relevant.',
    '- Use `split_plan: true` with phase files when preserving the necessary work would make one `implementation_plan.json` dense or hard to review.',
  ].join('\n');
}

function buildGeneratedHeader(profile: ProjectPromptProfile, promptName: string): string {
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

function buildSpecQuickPrompt(profile: ProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'spec_quick')}

## ROLE

You are the Spec Agent for this project. Create only the spec and plan needed for the current task.

## OUTPUTS

Use the Write tool to create \`spec.md\` in the spec directory.
Use the Write tool to create \`implementation_plan.json\` in the spec directory.

Do not modify project source code in this phase.

${buildToolCallJsonGuidance()}

## PROCESS

1. Read the task and the project index from the kickoff message.
2. Inspect only the files needed to identify the change.
3. Write a short \`spec.md\` with overview, scope, files, change details, and success criteria.
4. Write \`implementation_plan.json\` with one phase and 1-${profile.workflow.maxRecommendedSubtasks} subtasks unless the task truly needs more.

## PLAN SIZE LIMITS

- Use exactly 1 phase for simple tasks unless there is a real dependency split.
- Use 1-${profile.workflow.maxRecommendedSubtasks} subtasks for simple tasks; if the task is no longer simple, keep all necessary subtasks and make each one concise.
- Keep each \`title\` under 120 characters and each \`description\` under 500 characters.
- Do not include top-level \`summary\`, \`verification_strategy\`, \`qa_acceptance\`, research notes, copied source, or long analysis.

## DESIGN PATTERN GUIDANCE

- Reuse the existing local design pattern if the touched files clearly use one.
- Do not introduce a new named design pattern for a simple task unless it is already present nearby and necessary.
- In \`spec.md\` notes or the subtask \`description\`, record "follow existing [pattern]" or "no new design pattern required" when relevant.

## IMPLEMENTATION PLAN SHAPE

\`\`\`json
{
  "feature": "Task name",
  "workflow_type": "simple",
  "phases": [
    {
      "id": "1",
      "phase": 1,
      "name": "Implementation",
      "depends_on": [],
      "subtasks": [
        {
          "id": "1-1",
          "title": "Short action summary",
          "description": "Concrete implementation notes",
          "status": "pending",
          "files_to_create": [],
          "files_to_modify": ["path/to/file"],
          "verification": {
            "type": "command",
            "run": "smallest relevant verification command"
          }
        }
      ]
    }
  ]
}
\`\`\`

## PROJECT COMMANDS

Build:
${formatCommands(profile.commands.build)}

Test:
${formatCommands(profile.commands.test)}

Lint:
${formatCommands(profile.commands.lint)}

Typecheck:
${formatCommands(profile.commands.typecheck)}

## RULES

- ${getSpecLengthGuidance(profile)}
- Do not do research unless the task explicitly introduces unfamiliar external technology.
- Use existing project conventions and commands from the profile when possible.
- All file names and paths must use ASCII characters.
`;
}

function buildPlannerPrompt(profile: ProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'planner')}

## ROLE

You are the Planner Agent for this project. Convert the existing spec into a concrete implementation plan.

## REQUIRED OUTPUT

Use the Write tool to create the implementation plan files in the spec directory. For complex plans, write one small phase file per phase first, then write a compact \`implementation_plan.json\` index that references those phase files. Do not return a giant plan JSON as final text.

${buildToolCallJsonGuidance()}

## PROCESS

1. Use kickoff context from prior phases first; it may already include \`spec.md\`, \`requirements.json\`, and \`context.json\` summaries.
2. Read \`spec.md\`, \`requirements.json\`, or \`context.json\` only if the kickoff context is missing the detail needed for the plan; use Read \`limit\` for large files.
3. Inspect only directly relevant project files when the spec does not identify enough detail.
4. Create one phase and 1-${profile.workflow.maxRecommendedSubtasks} subtasks for small changes. Split into more phases only for real dependencies.

## PLAN SIZE LIMITS

- Normal tasks should target 4 phases or fewer and about 24 subtasks or fewer.
- If the task is genuinely complex, do not omit necessary subtasks just to hit the normal target. Preserve all required work items and make each subtask description shorter instead.
- The 1-${profile.workflow.maxRecommendedSubtasks} subtask guidance applies to small changes only, not complex migrations or broad rewrites.
${getComplexPlanningGuidance(profile)}
- Keep each \`title\` under 120 characters and each \`description\` under 700 characters.
- Do not include top-level \`summary\`, \`verification_strategy\`, \`qa_acceptance\`, research notes, copied source, or long analysis.
- Put verification on each subtask using the smallest relevant command or manual check.
- For large plans, split during generation: write \`implementation_plan.phase-1.json\`, \`implementation_plan.phase-2.json\`, etc., then write a compact \`implementation_plan.json\` index with \`split_plan: true\`, \`plan_files\`, and phases that use \`subtasks_file\`.

## DESIGN PATTERN DECISION

- Identify design patterns already used in the relevant files, such as repository, adapter, strategy, factory, observer, command, dependency injection, middleware, or composition.
- Prefer reusing the existing project pattern over introducing a new one.
- Introduce a named design pattern only when it reduces concrete complexity, and keep it scoped to the affected module.
- If no formal pattern is needed, say so in the relevant subtask description or notes.

## PLAN REQUIREMENTS

- Use \`phases[].subtasks[]\`.
- Each subtask needs \`id\`, \`title\`, \`description\`, \`status: "pending"\`, file lists, and verification.
- When a design pattern matters, include the decision in subtask \`description\`, \`notes\`, or \`patterns_from\`.
- Prefer targeted verification commands:
${formatCommands([
  ...profile.commands.typecheck,
  ...profile.commands.lint,
  ...profile.commands.test,
  ...profile.commands.build,
])}
- Do not add research, rollout, or broad QA subtasks unless the task risk warrants them.
`;
}

function buildCoderPrompt(profile: ProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'coder')}

## ROLE

You are the Coding Agent. Implement the next pending subtask in \`implementation_plan.json\`.

${buildToolCallJsonGuidance()}

## PROCESS

1. Read the spec, implementation plan, and the current pending subtask.
2. Read the files listed on the subtask first. Search only when those files are insufficient.
3. Implement the subtask using existing project conventions.
4. Run the smallest relevant verification command that is available.
5. Update the subtask status in \`implementation_plan.json\` to \`completed\` and add a structured \`completion_summary\` for human review. Use this compact Markdown review matrix exactly: \`| Item | Details |\`, \`| --- | --- |\`, \`| What changed | ... |\`, \`| Verification | ... |\`, \`| Review notes | ... |\`. Keep each cell concise and concrete. Use \`blocked\` or \`failed\` only when you cannot proceed.

## PROJECT COMMANDS

Build:
${formatCommands(profile.commands.build)}

Test:
${formatCommands(profile.commands.test)}

Lint:
${formatCommands(profile.commands.lint)}

Typecheck:
${formatCommands(profile.commands.typecheck)}

## RULES

- Work on one subtask at a time.
- Keep changes scoped to the subtask.
- Do not perform broad rewrites for small tasks.
- Follow the design pattern decision in the plan or the nearest existing code; do not add unplanned named patterns unless clearly necessary.
- Preserve user changes unrelated to the subtask.
- All new file names and paths must use ASCII characters.
`;
}

function buildQaReviewerPrompt(profile: ProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'qa_reviewer')}

## ROLE

You are the QA Reviewer. Validate the implementation against \`spec.md\` and \`implementation_plan.json\`.

## REQUIRED OUTPUT

Write \`qa_report.md\` in the spec directory with one of these exact status lines:
- \`Status: PASSED\`
- \`Status: FAILED\`

${buildToolCallJsonGuidance()}

## PROCESS

1. Read \`implementation_plan.json\` first and check that all subtasks are completed.
2. Read only the relevant parts of \`spec.md\` if the plan does not already contain enough acceptance detail.
3. Inspect changed files once; use line limits or targeted searches for large files.
4. Run the smallest relevant verification command available.
5. Report only actionable failures that block the requested task.

## PROJECT COMMANDS

Build:
${formatCommands(profile.commands.build)}

Test:
${formatCommands(profile.commands.test)}

Lint:
${formatCommands(profile.commands.lint)}

Typecheck:
${formatCommands(profile.commands.typecheck)}

## REVIEW STANDARD

- For small project changes, do not block on missing heavyweight artifacts that were not required by the spec.
- Verify design pattern fit: the implementation should follow the plan or nearest existing pattern without unnecessary abstractions or inconsistent pattern mixing.
- If no automated command exists, document the manual verification performed or the reason it was skipped.
- Match review depth to the project profile and task risk instead of applying heavyweight domain-specific requirements by default.
`;
}

function buildQaFixerPrompt(profile: ProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'qa_fixer')}

## ROLE

You are the QA Fixer. Fix the concrete issues in \`qa_report.md\` and prepare the task for re-review.

${buildToolCallJsonGuidance()}

## PROCESS

1. Read \`qa_report.md\`, \`spec.md\`, and \`implementation_plan.json\`.
2. Fix only the reported blocking issues.
3. Run the smallest relevant verification command available.
4. Update the plan or QA notes only as needed to show fixes were applied.

## PROJECT COMMANDS

Build:
${formatCommands(profile.commands.build)}

Test:
${formatCommands(profile.commands.test)}

Lint:
${formatCommands(profile.commands.lint)}

Typecheck:
${formatCommands(profile.commands.typecheck)}

## RULES

- Do not redesign or refactor unrelated code while fixing QA findings.
- Fix design pattern issues narrowly by aligning the affected code with the planned or existing pattern.
- Keep the fix scoped and easy for the next QA pass to verify.
- All new file names and paths must use ASCII characters.
`;
}

export function generateProjectPromptOverrides(profile: ProjectPromptProfile): Record<string, string> {
  return {
    spec_quick: buildSpecQuickPrompt(profile),
    planner: buildPlannerPrompt(profile),
    coder: buildCoderPrompt(profile),
    qa_reviewer: buildQaReviewerPrompt(profile),
    qa_fixer: buildQaFixerPrompt(profile),
  };
}

export function loadProjectPromptProfile(projectPath: string): ProjectPromptProfile | null {
  const profilePath = join(projectPath, PROJECT_PROMPT_PROFILE_PATH);
  const raw = safeReadJson(profilePath);
  if (!raw || raw.version !== PROJECT_PROMPT_PROFILE_VERSION || !raw.project || !raw.workflow) {
    return null;
  }
  return raw as unknown as ProjectPromptProfile;
}

export function initializeProjectPromptProfile(
  projectPath: string,
  options: { overwrite?: boolean } = {},
): ProjectPromptProfile {
  const autoClaudeDir = join(projectPath, '.autocode');
  mkdirSync(autoClaudeDir, { recursive: true });

  const existingProfile = options.overwrite ? null : loadProjectPromptProfile(projectPath);
  const profile = existingProfile ?? generateProjectPromptProfile(projectPath);
  const profilePath = join(projectPath, PROJECT_PROMPT_PROFILE_PATH);
  const shouldRefreshGeneratedPrompts = options.overwrite || existingProfile === null;

  if (options.overwrite || !existingProfile || !existsSync(profilePath)) {
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf-8');
  }

  const promptOverrides = generateProjectPromptOverrides(profile);
  const promptsDir = join(projectPath, PROJECT_PROMPTS_PATH);
  mkdirSync(promptsDir, { recursive: true });

  if (options.overwrite) {
    const managedPromptNames = new Set(Object.keys(promptOverrides));
    for (const promptName of PROJECT_PROMPT_NAMES) {
      if (managedPromptNames.has(promptName)) continue;
      const promptPath = join(promptsDir, `${promptName}.md`);
      if (existsSync(promptPath) && isGeneratedProjectPrompt(promptPath)) {
        unlinkSync(promptPath);
      }
    }
  }

  for (const [promptName, content] of Object.entries(promptOverrides)) {
    const promptPath = join(promptsDir, `${promptName}.md`);
    if (
      options.overwrite ||
      !existsSync(promptPath) ||
      (shouldRefreshGeneratedPrompts && isGeneratedProjectPrompt(promptPath))
    ) {
      writeFileSync(promptPath, content.trimEnd() + '\n', 'utf-8');
    }
  }

  return profile;
}

function isGeneratedProjectPrompt(promptPath: string): boolean {
  try {
    return readFileSync(promptPath, 'utf-8').includes('## PROJECT-SPECIFIC PROMPT (GENERATED)');
  } catch {
    return false;
  }
}

export function loadProjectPromptOverride(
  projectPath: string,
  promptName: string,
): { content: string; path: string } | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(promptName)) {
    return null;
  }

  const promptPath = join(projectPath, PROJECT_PROMPTS_PATH, `${promptName}.md`);
  try {
    if (!existsSync(promptPath)) return null;
    const content = readFileSync(promptPath, 'utf-8').trim();
    return content ? { content, path: promptPath } : null;
  } catch {
    return null;
  }
}

export function buildProjectPromptProfileSection(profile: ProjectPromptProfile): string {
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
- Prompt intensity: ${profile.workflow.promptIntensity}
- Spec style: ${profile.workflow.specStyle}
- Context rule: ${profile.workflow.contextGuidance}
- Planning rule: ${profile.workflow.planningGuidance}
- Validation rule: ${profile.workflow.validationGuidance}
${domainOverride}

Preferred project commands:
${commandLines.length > 0 ? commandLines.slice(0, 8).join('\n') : '- None detected; choose the smallest reliable project-specific verification.'}

When a bundled template asks for heavier process than this project profile requires, follow the project profile unless the current task is high-risk or cross-cutting.

---`;
}
