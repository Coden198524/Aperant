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

export const PROJECT_PROMPT_PROFILE_VERSION = 29;
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
  'planner',
  'coder',
  'qa_reviewer',
  'qa_fixer',
] as const;
const REMOVED_PROJECT_PROMPT_NAMES = ['spec_quick'] as const;

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
      specStyle: 'standard',
      planningGuidance: 'Use a simple implementation flow unless the request clearly spans separate modules or dependency boundaries.',
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

  for (const promptName of REMOVED_PROJECT_PROMPT_NAMES) {
    const promptPath = join(promptsDir, `${promptName}.md`);
    if (existsSync(promptPath) && isGeneratedProjectPrompt(promptPath)) {
      unlinkSync(promptPath);
    }
  }

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
