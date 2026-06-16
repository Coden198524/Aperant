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

import {
  buildAutocodeCompactProjectPromptProfileSection,
  buildAutocodeProjectPromptProfileSection,
  generateAutocodeProjectPromptOverrides,
} from '@autocode/core/runtime/project-prompt-profile';
import {
  getAutocodeProjectDataDir,
  getAutocodeProjectPromptProfilePath,
  getAutocodeProjectPromptProfileRelativePath,
  getAutocodeProjectPromptsDir,
  getAutocodeProjectPromptsRelativeDir,
} from '@autocode/core/project/data-paths';
import { shouldSkipAutocodeWorkspaceDir } from '@autocode/core/workspace/ignore-rules';
import { FrameworkDetector } from '../project/framework-detector';
import { StackDetector } from '../project/stack-detector';

export const PROJECT_PROMPT_PROFILE_VERSION = 15;
export const PROJECT_PROMPT_PROFILE_PATH = getAutocodeProjectPromptProfileRelativePath();
export const PROJECT_PROMPTS_PATH = getAutocodeProjectPromptsRelativeDir();

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
  conventions: {
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
  instructionFiles: string[];
  configFiles: string[];
  sourceRootCounts: Map<string, number>;
  testRootCounts: Map<string, number>;
}

interface PackageManifestInfo {
  dir: string;
  relativeDir: string;
  packageManager: string;
  scripts: Record<string, string>;
}

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

const INSTRUCTION_FILE_NAMES = new Set([
  'agents.md',
  'claude.md',
  'contributing.md',
  'architecture.md',
  'styleguide.md',
  'coding-standards.md',
  'development.md',
]);

const CONFIG_FILE_NAMES = new Set([
  '.editorconfig',
  '.eslintrc',
  '.eslintrc.cjs',
  '.eslintrc.js',
  '.eslintrc.json',
  '.prettierrc',
  '.prettierrc.json',
  'biome.json',
  'biome.jsonc',
  'bun.lock',
  'bun.lockb',
  'deno.json',
  'eslint.config.cjs',
  'eslint.config.js',
  'eslint.config.mjs',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'requirements.txt',
  'tsconfig.json',
  'yarn.lock',
]);

const CONFIG_FILE_PATTERNS = [
  /^electron\.vite\.config\./,
  /^jest\.config\./,
  /^playwright\.config\./,
  /^postcss\.config\./,
  /^tailwind\.config\./,
  /^tsconfig\..*\.json$/,
  /^vite\.config\./,
  /^vitest\.config\./,
];

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

function isInstructionFile(relPath: string): boolean {
  const lowerRelPath = relPath.toLowerCase();
  const fileName = basename(lowerRelPath);
  if (INSTRUCTION_FILE_NAMES.has(fileName)) return true;
  return lowerRelPath === '.github/copilot-instructions.md'
    || lowerRelPath.startsWith('.cursor/rules/')
    || lowerRelPath.startsWith('docs/architecture')
    || lowerRelPath.startsWith('docs/development')
    || lowerRelPath.startsWith('docs/contributing');
}

function isConfigFile(relPath: string): boolean {
  const lowerRelPath = relPath.toLowerCase();
  const fileName = basename(lowerRelPath);
  return CONFIG_FILE_NAMES.has(fileName)
    || CONFIG_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

function addCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function getRankedKeys(map: Map<string, number>, maxItems: number): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key)
    .slice(0, maxItems);
}

function inferSourceRoot(relPath: string): string {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length <= 1) return dirname(relPath) || '.';

  const first = parts[0];
  if ((first === 'apps' || first === 'packages' || first === 'libs') && parts.length >= 3) {
    const srcIndex = parts.indexOf('src');
    if (srcIndex >= 2) {
      return parts.slice(0, srcIndex + 1).join('/');
    }
    return parts.slice(0, 2).join('/');
  }

  const srcIndex = parts.indexOf('src');
  if (srcIndex >= 0) {
    if (srcIndex === 0 && parts[1] && ['main', 'preload', 'renderer', 'shared'].includes(parts[1])) {
      return parts.slice(0, 2).join('/');
    }
    return parts.slice(0, srcIndex + 1).join('/');
  }

  return first;
}

function inferTestRoot(relPath: string): string | null {
  const parts = relPath.split('/').filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const index = lowerParts.findIndex((part) => (
    part === '__tests__' ||
    part === 'tests' ||
    part === 'test' ||
    part === 'e2e' ||
    part === '__test__'
  ));
  if (index >= 0) {
    return parts.slice(0, index + 1).join('/');
  }
  if (/\.(test|spec|e2e)\.[^.]+$/i.test(relPath)) {
    return dirname(relPath) || '.';
  }
  return null;
}

function scanProject(projectPath: string): ScanStats {
  const stats: ScanStats = {
    totalFileCount: 0,
    sourceFileCount: 0,
    testFileCount: 0,
    packageJsonPaths: [],
    instructionFiles: [],
    configFiles: [],
    sourceRootCounts: new Map(),
    testRootCounts: new Map(),
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
        if (shouldSkipAutocodeWorkspaceDir(entry.name)) continue;
        visit(join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const filePath = join(dir, entry.name);
      const relPath = toPosixPath(relative(projectPath, filePath));
      const lowerRelPath = relPath.toLowerCase();
      stats.totalFileCount += 1;

      if (isInstructionFile(relPath)) {
        stats.instructionFiles.push(relPath);
      }
      if (isConfigFile(relPath)) {
        stats.configFiles.push(relPath);
      }

      if (entry.name === 'package.json') {
        stats.packageJsonPaths.push(filePath);
      }

      const ext = extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext)) {
        stats.sourceFileCount += 1;
        addCount(stats.sourceRootCounts, inferSourceRoot(relPath));
        if (
          lowerRelPath.includes('/__tests__/') ||
          lowerRelPath.includes('/tests/') ||
          lowerRelPath.includes('/test/') ||
          lowerRelPath.includes('.test.') ||
          lowerRelPath.includes('.spec.') ||
          lowerRelPath.includes('.e2e.')
        ) {
          stats.testFileCount += 1;
          const testRoot = inferTestRoot(relPath);
          if (testRoot) {
            addCount(stats.testRootCounts, testRoot);
          }
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
      contextGuidance: 'Use the project documentation reference first, then inspect only the files and patterns needed for the task.',
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

function hasConfig(stats: ScanStats, fileNameOrPattern: string | RegExp): boolean {
  return stats.configFiles.some((filePath) => {
    const fileName = basename(filePath).toLowerCase();
    if (typeof fileNameOrPattern === 'string') {
      return fileName === fileNameOrPattern.toLowerCase();
    }
    return fileNameOrPattern.test(fileName);
  });
}

function normalizeFrameworks(frameworks: string[]): Set<string> {
  return new Set(frameworks.map((framework) => framework.toLowerCase()));
}

function collectFrameworkConventions(frameworks: string[], stats: ScanStats): string[] {
  const frameworkSet = normalizeFrameworks(frameworks);
  const conventions: string[] = [];

  if (frameworkSet.has('electron')) {
    conventions.push('Respect the Electron split: main process owns OS/files/services, preload exposes typed bridges, renderer stays UI-focused, and shared types/constants define IPC contracts.');
  }
  if (frameworkSet.has('react')) {
    conventions.push('Follow React conventions: PascalCase components, `useX` hooks, colocated UI tests where present, and existing state/store patterns before adding new abstractions.');
  }
  if (frameworkSet.has('vite')) {
    conventions.push('Use Vite/Vitest-native workflows and path aliases from existing config instead of adding parallel build tooling.');
  }
  if (frameworkSet.has('nextjs') || frameworkSet.has('next.js')) {
    conventions.push('Follow the existing Next.js route/data-fetching model and keep server/client boundaries explicit.');
  }
  if (frameworkSet.has('express') || frameworkSet.has('nestjs')) {
    conventions.push('Follow the existing API layering: routes/controllers should stay thin and service/domain modules should own business logic.');
  }
  if (frameworkSet.has('fastapi') || frameworkSet.has('django') || frameworkSet.has('flask')) {
    conventions.push('Follow the existing Python web layering and keep request schemas, handlers, and persistence concerns separated.');
  }
  if (frameworkSet.has('vitest') || frameworkSet.has('jest') || stats.testFileCount > 0) {
    conventions.push('Match the existing test style and place regression tests near the closest current test root.');
  }
  if (frameworkSet.has('playwright')) {
    conventions.push('Use Playwright for browser/Electron flows that need real UI behavior, keeping specs focused on user-visible outcomes.');
  }

  return conventions;
}

function collectCodingRules(stack: ReturnType<StackDetector['detectAll']>, frameworks: string[], stats: ScanStats): string[] {
  const rules: string[] = [];
  const languageSet = new Set(stack.languages.map((language) => language.toLowerCase()));
  const frameworkSet = normalizeFrameworks(frameworks);

  if (languageSet.has('typescript') || hasConfig(stats, /^tsconfig.*\.json$/)) {
    rules.push('Prefer TypeScript for source changes and keep types aligned with existing path aliases and shared contracts.');
  }
  if (hasConfig(stats, 'biome.json') || hasConfig(stats, 'biome.jsonc')) {
    rules.push('Follow Biome formatting/linting rules; prefer existing import ordering, quotes, and indentation over local style inventions.');
  } else if (hasConfig(stats, /^eslint\.config\./) || hasConfig(stats, '.eslintrc') || hasConfig(stats, '.eslintrc.json')) {
    rules.push('Follow ESLint rules and existing lint patterns; avoid introducing rule suppressions unless narrowly justified.');
  }
  if (hasConfig(stats, '.editorconfig')) {
    rules.push('Respect `.editorconfig` whitespace, line ending, and indentation settings.');
  }
  if (hasConfig(stats, '.prettierrc') || hasConfig(stats, '.prettierrc.json')) {
    rules.push('Preserve Prettier-compatible formatting and avoid hand-formatted exceptions.');
  }
  if (frameworkSet.has('tailwind')) {
    rules.push('Reuse existing Tailwind tokens/utilities and component primitives instead of inventing one-off visual styles.');
  }
  if (stats.instructionFiles.length > 0) {
    rules.push(`Treat project instruction files as authoritative when they apply: ${uniqueSorted(stats.instructionFiles).slice(0, 5).join(', ')}.`);
  }

  return rules;
}

function collectArchitectureHints(projectPath: string, frameworks: string[], stats: ScanStats, packageManifests: PackageManifestInfo[]): string[] {
  const frameworkSet = normalizeFrameworks(frameworks);
  const sourceRoots = getRankedKeys(stats.sourceRootCounts, 6);
  const hints: string[] = [];

  if (packageManifests.length > 1 || existsSync(join(projectPath, 'pnpm-workspace.yaml'))) {
    hints.push('Treat this as a workspace/monorepo: keep changes inside the owning package unless the task explicitly crosses package boundaries.');
  }
  if (
    frameworkSet.has('electron') &&
    sourceRoots.some((root) => root.endsWith('src/main')) &&
    sourceRoots.some((root) => root.endsWith('src/renderer'))
  ) {
    hints.push('For desktop features, trace flow through renderer UI, preload bridge/shared IPC types, then main-process service/handler code.');
  }
  if (sourceRoots.length > 0) {
    hints.push(`Start discovery from the closest source root: ${sourceRoots.slice(0, 5).join(', ')}.`);
  }
  if (stats.testRootCounts.size > 0) {
    hints.push(`Use nearby test roots for regression coverage: ${getRankedKeys(stats.testRootCounts, 4).join(', ')}.`);
  }

  return hints;
}

function collectWorkflowHints(commands: ProjectPromptProfile['commands'], stats: ScanStats): string[] {
  const hints: string[] = [];
  if (commands.typecheck.length > 0) {
    hints.push(`Prefer targeted type checking before broad packaging: ${commands.typecheck[0]}.`);
  }
  if (commands.lint.length > 0) {
    hints.push(`Run the project lint command when style/import behavior changes: ${commands.lint[0]}.`);
  }
  if (commands.test.length > 0) {
    hints.push(`Use the nearest relevant test first, then broaden only when risk warrants it; default test command: ${commands.test[0]}.`);
  }
  if (commands.build.length > 0) {
    hints.push(`Use build/package validation for cross-module or release-facing changes: ${commands.build[0]}.`);
  }
  if (stats.instructionFiles.length > 0) {
    hints.push('Read applicable rule or architecture files before changing public APIs, module boundaries, or framework wiring.');
  }
  return hints;
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
  const normalizedCommands = {
    build: uniqueSorted(commands.build),
    test: uniqueSorted(commands.test),
    lint: uniqueSorted(commands.lint),
    typecheck: uniqueSorted(commands.typecheck),
  };
  const sourceRoots = getRankedKeys(stats.sourceRootCounts, 8);
  const testRoots = getRankedKeys(stats.testRootCounts, 6);

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
    conventions: {
      instructionFiles: uniqueSorted(stats.instructionFiles).slice(0, 8),
      configFiles: uniqueSorted(stats.configFiles).slice(0, 12),
      sourceRoots,
      testRoots,
      frameworkConventions: collectFrameworkConventions(frameworks, stats),
      codingRules: collectCodingRules(stack, frameworks, stats),
      architectureHints: collectArchitectureHints(resolvedProjectPath, frameworks, stats, packageManifests),
      workflowHints: collectWorkflowHints(normalizedCommands, stats),
    },
    workflow,
    commands: normalizedCommands,
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
    return '- For genuinely complex tasks, preserve necessary work items in tasks.md instead of merging unrelated areas.';
  }

  return [
    '- For genuinely complex tasks, especially migrations, removals, replacements, refactors, or cross-system changes, do not compress tasks.md into the normal phase/task target.',
    '- Split complex tasks by dependency boundary such as runtime behavior, UI/editor surfaces, build/tooling, CI/release, data/assets, compatibility, migration tooling, and validation/rollback when those areas are relevant.',
    '- Keep tasks.md concise with checklist Markdown when preserving necessary work would otherwise make the task list hard to review.',
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

function buildSpecQuickPrompt(profile: ProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'spec_quick')}

## ROLE

Create only the compact Standard light plan and upstream task list needed for the current task.

## OUTPUTS

Use the Write tool to create \`spec.md\` in the spec directory.
Use the Write tool to create \`tasks.md\` in the spec directory.
Do not write \`implementation_plan.md\`; the runtime derives it as work packages.

Do not modify project source code in this phase.

${buildToolCallJsonGuidance()}

## PROCESS

1. Read the task and the project documentation reference from the kickoff message.
2. Inspect only the files needed to identify the change.
3. Write a compact Standard \`spec.md\` with overview, scope, files, change details, and success criteria.
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
  - _Evidence: spec.md requirement 1.1; path/to/file existing pattern_
  - _Verification: smallest relevant verification command_
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

Convert the existing spec into a concrete upstream task list. The runtime derives implementation_plan.md work packages from tasks.md.

## REQUIRED OUTPUT

Use the Write tool to create \`tasks.md\` in the spec directory. Do not return the full task list as final text. Do not write \`implementation_plan.md\`.

${buildToolCallJsonGuidance()}

## PROCESS

1. Use kickoff context from prior phases first; it may already include \`spec.md\`, \`requirements.md\`, and \`context.md\` summaries.
2. Read \`spec.md\`, \`requirements.md\`, or \`context.md\` only if the kickoff context is missing the detail needed for tasks.md; use Read \`limit\` for large files.
3. Inspect only directly relevant project files when the spec does not identify enough detail.
4. Ground requirements, design choices, task scope, and verification commands in source files, project docs, existing patterns, or verified official/industry references. Put gaps in assumptions or validation tasks.
5. Create one phase and 1-${profile.workflow.maxRecommendedSubtasks} subtasks for small changes. Split into more phases only for real dependencies.

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
- Each task needs an id, title, concise description bullets, pending checkbox, precise file metadata, exactly one dependency line, one \`_Evidence: ..._\` line, and verification.
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

function buildCoderPrompt(profile: ProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'coder')}

## ROLE

Implement the next pending subtask in \`implementation_plan.md\`.

${buildToolCallJsonGuidance()}

## PROCESS

1. Read the spec, implementation plan, and the current pending subtask.
2. Read the files listed on the subtask first. Search only when those files are insufficient.
3. Identify the local implementation contract before editing: inputs/outputs, lifecycle, side effects, errors, public APIs/schemas/config, and caller/callee expectations.
4. Implement the subtask using existing project conventions.
5. Run the smallest relevant verification command that is available.
6. Update the subtask checkbox in \`implementation_plan.md\` to \`[x]\` and add \`_Completion: ..._\` for human review. Include what changed, touched files/contracts, verification, and review notes/risks. Use \`[-]\` for blocked or \`[!]\` for failed only when you cannot proceed.

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
- Preserve public APIs, schemas, IPC/protocol contracts, config/env semantics, migrations, and data formats unless the subtask explicitly requires a contract change; update all affected call sites and tests when a contract changes.
- Do not leave placeholder code, TODO implementations, no-op handlers, fake data, disabled validation, dead branches, broad type escapes, swallowed errors, or unrelated abstractions.
- For bug fixes or behavior changes, add or update the closest regression test when an adjacent test pattern exists; if no practical test is available, state the exact verification limitation.
- Preserve user changes unrelated to the subtask.
- All new file names and paths must use ASCII characters.
- Before editing an existing file, read the current narrow context and patch only against exact current lines; if an edit misses, reread only the surrounding lines once before retrying.
- Treat legacy or non-UTF-8 files as encoding-sensitive: do not use apply_patch or UTF-8 rewrites on them. Use an encoding-preserving script/tool and keep the original file encoding.
- In legacy Windows game projects, assume files with Chinese comments or mojibake may be non-UTF-8; verify or preserve encoding before editing.
- On Node 24+, do not mix \`require(...)\` with top-level \`await\` in \`node -e\`, stdin, or eval scripts. Use an async IIFE around CommonJS code, or use ESM \`import\` with \`node --input-type=module\`.
- Avoid brittle smoke assertions against initial or transient task status; retries and resume can advance state. Verify final behavior or durable files unless the subtask explicitly changes state-machine code.
`;
}

function buildQaReviewerPrompt(profile: ProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'qa_reviewer')}

## ROLE

Validate the implementation against \`spec.md\` and \`implementation_plan.md\`.

## REQUIRED OUTPUT

Write \`qa_report.md\` in the spec directory with one of these exact status lines:
- \`Status: PASSED\`
- \`Status: FAILED\`

${buildToolCallJsonGuidance()}

## PROCESS

1. Read \`implementation_plan.md\` first and check that all subtasks are completed.
2. Read only the relevant parts of \`spec.md\` if the plan does not already contain enough acceptance detail.
3. Inspect changed files once; use line limits or targeted searches for large files.
4. Compare completion notes against actual changed files and changed contracts.
5. Run the smallest relevant verification command available.
6. Report only actionable failures that block the requested task.

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
- Verify changed contracts: public APIs, schemas, IPC/protocols, config/env behavior, data formats, persistence, side effects, and error behavior are preserved or intentionally updated.
- Build an acceptance matrix that maps each changed behavior to its requirement/evidence, changed file, verification result, and residual risk.
- \`qa_report.md\` must include: Scope Reviewed, Changed Files And Contracts, Acceptance Matrix, Verification, Findings, and Residual Risks.
- If failed, every finding needs title, severity, location, evidence, impacted requirement/contract, required fix, and re-verification.
- If no automated command exists, document the manual verification performed or the reason it was skipped.
- Match review depth to the project profile and task risk instead of applying heavyweight domain-specific requirements by default.
`;
}

function buildQaFixerPrompt(profile: ProjectPromptProfile): string {
  return `${buildGeneratedHeader(profile, 'qa_fixer')}

## ROLE

Fix the concrete issues in \`qa_report.md\` and prepare the task for re-review.

${buildToolCallJsonGuidance()}

## PROCESS

1. Read \`qa_report.md\`, \`spec.md\`, and \`implementation_plan.md\`.
2. For each issue, identify the impacted requirement, contract, and caller/callee expectations before editing.
3. Fix only the reported blocking issues.
4. Update callers, tests, schemas, configs, or docs when a fix intentionally changes a contract.
5. Run the smallest relevant verification command available.
6. Update the plan or QA notes only as needed to show fixes were applied.

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
- Preserve public APIs, schemas, IPC/protocols, config/env behavior, data formats, persistence, side effects, and error behavior unless QA explicitly requires a contract change.
- Do not use placeholder code, TODO implementations, no-op handlers, fake data, disabled validation, broad type escapes, swallowed errors, or unrelated abstractions.
- Keep the fix scoped and easy for the next QA pass to verify.
- All new file names and paths must use ASCII characters.
`;
}

export function generateProjectPromptOverrides(profile: ProjectPromptProfile): Record<string, string> {
  return generateAutocodeProjectPromptOverrides(profile);
}

export function loadProjectPromptProfile(projectPath: string): ProjectPromptProfile | null {
  const profilePath = getAutocodeProjectPromptProfilePath(projectPath);
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
  const autoClaudeDir = getAutocodeProjectDataDir(projectPath);
  mkdirSync(autoClaudeDir, { recursive: true });

  const existingProfile = options.overwrite ? null : loadProjectPromptProfile(projectPath);
  const profile = existingProfile ?? generateProjectPromptProfile(projectPath);
  const profilePath = getAutocodeProjectPromptProfilePath(projectPath);
  const shouldRefreshGeneratedPrompts = options.overwrite || existingProfile === null;

  if (options.overwrite || !existingProfile || !existsSync(profilePath)) {
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf-8');
  }

  const promptOverrides = generateProjectPromptOverrides(profile);
  const promptsDir = getAutocodeProjectPromptsDir(projectPath);
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

  const promptPath = join(getAutocodeProjectPromptsDir(projectPath), `${promptName}.md`);
  try {
    if (!existsSync(promptPath)) return null;
    const content = readFileSync(promptPath, 'utf-8').trim();
    return content ? { content, path: promptPath } : null;
  } catch {
    return null;
  }
}

export function buildProjectPromptProfileSection(profile: ProjectPromptProfile): string {
  return buildAutocodeProjectPromptProfileSection(profile);
}

export function buildCompactProjectPromptProfileSection(profile: ProjectPromptProfile): string {
  return buildAutocodeCompactProjectPromptProfileSection(profile);
}
