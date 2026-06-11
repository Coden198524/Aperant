import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';

import {
  FrameworkDetector,
  StackDetector,
  generateAutocodeProjectPromptOverrides,
  getAutocodeProjectDataDir,
  getAutocodeProjectPromptProfilePath,
  getAutocodeProjectPromptsDir,
  getAutocodeProjectPromptsRelativeDir,
  shouldSkipAutocodeWorkspaceDir,
  type AutocodeProjectDomain,
  type AutocodeProjectPromptProfile,
  type AutocodeProjectSize,
  type AutocodePromptIntensity,
  type TechnologyStack,
} from '@autocode/core';

const PROJECT_PROMPT_PROFILE_VERSION = 12;
const PROJECT_PROMPT_NAMES = [
  'spec_quick',
  'planner',
  'coder',
  'qa_reviewer',
  'qa_fixer',
] as const;

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

const NODE_FRAMEWORK_DEPS: Record<string, string> = {
  next: 'nextjs',
  nuxt: 'nuxt',
  react: 'react',
  vue: 'vue',
  '@angular/core': 'angular',
  svelte: 'svelte',
  '@sveltejs/kit': 'svelte',
  astro: 'astro',
  '@remix-run/react': 'remix',
  gatsby: 'gatsby',
  express: 'express',
  '@nestjs/core': 'nestjs',
  fastify: 'fastify',
  koa: 'koa',
  electron: 'electron',
  '@tauri-apps/api': 'tauri',
  vite: 'vite',
  webpack: 'webpack',
  rollup: 'rollup',
  esbuild: 'esbuild',
  turbo: 'turbo',
  nx: 'nx',
  jest: 'jest',
  vitest: 'vitest',
  '@playwright/test': 'playwright',
  cypress: 'cypress',
  eslint: 'eslint',
  prettier: 'prettier',
  '@biomejs/biome': 'biome',
  prisma: 'prisma',
  'drizzle-orm': 'drizzle',
  typeorm: 'typeorm',
};

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
  dependencies: Record<string, string>;
}

export interface InitializeWebProjectPromptProfileResult {
  profile: AutocodeProjectPromptProfile;
  profilePath: string;
  promptsDir: string;
}

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join('/');
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
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

async function safeReadJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isInstructionFile(relPath: string): boolean {
  const lowerRelPath = relPath.toLowerCase();
  const fileName = basename(lowerRelPath);
  return INSTRUCTION_FILE_NAMES.has(fileName)
    || lowerRelPath === '.github/copilot-instructions.md'
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

function inferSourceRoot(relPath: string): string {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length <= 1) return dirname(relPath) || '.';

  const first = parts[0];
  if ((first === 'apps' || first === 'packages' || first === 'libs') && parts.length >= 3) {
    const srcIndex = parts.indexOf('src');
    if (srcIndex >= 2) return parts.slice(0, srcIndex + 1).join('/');
    return parts.slice(0, 2).join('/');
  }

  const srcIndex = parts.indexOf('src');
  if (srcIndex >= 0) return parts.slice(0, srcIndex + 1).join('/');
  return first;
}

function inferTestRoot(relPath: string): string | null {
  const parts = relPath.split('/').filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const index = lowerParts.findIndex((part) => (
    part === '__tests__'
    || part === 'tests'
    || part === 'test'
    || part === 'e2e'
    || part === '__test__'
  ));
  if (index >= 0) return parts.slice(0, index + 1).join('/');
  if (/\.(test|spec|e2e)\.[^.]+$/i.test(relPath)) return dirname(relPath) || '.';
  return null;
}

async function scanProject(projectPath: string): Promise<ScanStats> {
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

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || stats.totalFileCount >= maxFiles) return;

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (stats.totalFileCount >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (shouldSkipAutocodeWorkspaceDir(entry.name)) continue;
        await visit(join(dir, entry.name), depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      const filePath = join(dir, entry.name);
      const relPath = toPosixPath(relative(projectPath, filePath));
      const lowerRelPath = relPath.toLowerCase();
      stats.totalFileCount += 1;

      if (isInstructionFile(relPath)) stats.instructionFiles.push(relPath);
      if (isConfigFile(relPath)) stats.configFiles.push(relPath);
      if (entry.name === 'package.json') stats.packageJsonPaths.push(filePath);

      const ext = extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      stats.sourceFileCount += 1;
      addCount(stats.sourceRootCounts, inferSourceRoot(relPath));
      if (
        lowerRelPath.includes('/__tests__/')
        || lowerRelPath.includes('/tests/')
        || lowerRelPath.includes('/test/')
        || lowerRelPath.includes('.test.')
        || lowerRelPath.includes('.spec.')
        || lowerRelPath.includes('.e2e.')
      ) {
        stats.testFileCount += 1;
        const testRoot = inferTestRoot(relPath);
        if (testRoot) addCount(stats.testRootCounts, testRoot);
      }
    }
  }

  await visit(projectPath, 0);
  return stats;
}

function detectPackageManager(projectPath: string, manifestDir: string, detectedManagers: string[]): string {
  if (existsSync(join(manifestDir, 'pnpm-lock.yaml')) || existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(manifestDir, 'yarn.lock')) || existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
  if (
    existsSync(join(manifestDir, 'bun.lock'))
    || existsSync(join(manifestDir, 'bun.lockb'))
    || existsSync(join(projectPath, 'bun.lock'))
    || existsSync(join(projectPath, 'bun.lockb'))
  ) {
    return 'bun';
  }
  if (existsSync(join(manifestDir, 'package-lock.json')) || existsSync(join(projectPath, 'package-lock.json'))) return 'npm';
  return detectedManagers.find((manager) => ['pnpm', 'yarn', 'bun', 'npm'].includes(manager)) ?? 'npm';
}

async function readPackageManifests(
  projectPath: string,
  packageJsonPaths: string[],
  detectedManagers: string[],
): Promise<PackageManifestInfo[]> {
  const manifests: PackageManifestInfo[] = [];

  for (const packageJsonPath of packageJsonPaths) {
    const raw = await safeReadJson(packageJsonPath);
    if (!raw) continue;

    const dependencies = {
      ...(raw.dependencies as Record<string, string> ?? {}),
      ...(raw.devDependencies as Record<string, string> ?? {}),
      ...((raw.peerDependencies as Record<string, string>) ?? {}),
    };
    const manifestDir = dirname(packageJsonPath);
    manifests.push({
      dir: manifestDir,
      relativeDir: toPosixPath(relative(projectPath, manifestDir)) || '.',
      packageManager: detectPackageManager(projectPath, manifestDir, detectedManagers),
      scripts: raw.scripts && typeof raw.scripts === 'object'
        ? raw.scripts as Record<string, string>
        : {},
      dependencies,
    });
  }

  return manifests;
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

function collectScriptCommands(manifests: PackageManifestInfo[], scriptNames: string[]): string[] {
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

function collectFrameworksFromManifests(manifests: PackageManifestInfo[]): string[] {
  const frameworks: string[] = [];
  for (const manifest of manifests) {
    for (const [dependency, framework] of Object.entries(NODE_FRAMEWORK_DEPS)) {
      if (dependency in manifest.dependencies) frameworks.push(framework);
    }
  }
  return uniqueSorted(frameworks);
}

function inferProjectSize(stats: ScanStats): AutocodeProjectSize {
  if (stats.sourceFileCount <= 40 && stats.packageJsonPaths.length <= 2) return 'small';
  if (stats.sourceFileCount <= 250 && stats.totalFileCount <= 1500) return 'medium';
  return 'large';
}

function inferProjectDomain(frameworks: string[], stats: ScanStats): AutocodeProjectDomain {
  const frameworkSet = new Set(frameworks);
  if (frameworkSet.has('electron') || frameworkSet.has('tauri')) return 'desktop';
  if (
    frameworkSet.has('express')
    || frameworkSet.has('fastapi')
    || frameworkSet.has('django')
    || frameworkSet.has('flask')
    || frameworkSet.has('nestjs')
    || frameworkSet.has('fastify')
  ) {
    return 'api';
  }
  if (
    frameworkSet.has('react')
    || frameworkSet.has('vue')
    || frameworkSet.has('svelte')
    || frameworkSet.has('nextjs')
    || frameworkSet.has('nuxt')
    || frameworkSet.has('astro')
  ) {
    return 'web';
  }
  if (stats.sourceFileCount <= 30) return 'library';
  return 'general';
}

function inferWorkflow(size: AutocodeProjectSize): AutocodeProjectPromptProfile['workflow'] {
  const promptIntensityBySize: Record<AutocodeProjectSize, AutocodePromptIntensity> = {
    small: 'lightweight',
    medium: 'standard',
    large: 'thorough',
  };

  if (size === 'small') {
    return {
      promptIntensity: promptIntensityBySize[size],
      specStyle: 'quick',
      planningGuidance: 'Use one implementation phase and 1-3 subtasks unless the request clearly spans separate modules.',
      contextGuidance: 'Prefer targeted file reads. Do not perform broad discovery when the task already points to the affected files.',
      validationGuidance: 'Run the smallest relevant build, typecheck, lint, or test command available. Manual verification is acceptable for simple UI/text changes.',
      maxRecommendedSubtasks: 3,
    };
  }

  if (size === 'medium') {
    return {
      promptIntensity: promptIntensityBySize[size],
      specStyle: 'standard',
      planningGuidance: 'Use enough phases to separate dependencies, but avoid research/self-critique unless risk or unfamiliar technology requires it.',
      contextGuidance: 'Use the project index first, then inspect only the files and patterns needed for the task.',
      validationGuidance: 'Run targeted tests plus one broader confidence check when available.',
      maxRecommendedSubtasks: 8,
    };
  }

  return {
    promptIntensity: promptIntensityBySize[size],
    specStyle: 'full',
    planningGuidance: 'Use explicit phases for cross-service dependencies, migrations, integration points, and rollout/rollback work.',
    contextGuidance: 'Perform deeper discovery and pattern analysis before planning or coding.',
    validationGuidance: 'Run layered validation: unit or targeted tests, integration checks, and build/typecheck/lint where available.',
    maxRecommendedSubtasks: 15,
  };
}

function hasConfig(stats: ScanStats, fileNameOrPattern: string | RegExp): boolean {
  return stats.configFiles.some((filePath) => {
    const fileName = basename(filePath).toLowerCase();
    if (typeof fileNameOrPattern === 'string') return fileName === fileNameOrPattern.toLowerCase();
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
    conventions.push('Follow React conventions: PascalCase components, `useX` hooks, colocated UI tests where present, and existing state/store patterns before adding abstractions.');
  }
  if (frameworkSet.has('vite')) {
    conventions.push('Use Vite/Vitest-native workflows and existing path aliases instead of adding parallel build tooling.');
  }
  if (frameworkSet.has('express') || frameworkSet.has('nestjs') || frameworkSet.has('fastify')) {
    conventions.push('Keep API routes thin and let service/domain modules own business logic, validation, and persistence decisions.');
  }
  if (frameworkSet.has('vitest') || frameworkSet.has('jest') || stats.testFileCount > 0) {
    conventions.push('Match the existing test style and place regression tests near the closest current test root.');
  }
  if (frameworkSet.has('playwright')) {
    conventions.push('Use Playwright for browser/Electron flows that need real UI behavior, keeping specs focused on user-visible outcomes.');
  }

  return conventions;
}

function collectCodingRules(stack: TechnologyStack, frameworks: string[], stats: ScanStats): string[] {
  const rules: string[] = [];
  const languageSet = new Set(stack.languages.map((language) => language.toLowerCase()));
  const frameworkSet = normalizeFrameworks(frameworks);

  if (languageSet.has('typescript') || hasConfig(stats, /^tsconfig.*\.json$/)) {
    rules.push('Prefer TypeScript for source changes and keep types aligned with existing path aliases and shared contracts.');
  }
  if (hasConfig(stats, 'biome.json') || hasConfig(stats, 'biome.jsonc')) {
    rules.push('Follow Biome formatting/linting rules; prefer existing import ordering, quotes, and indentation over local style inventions.');
  } else if (hasConfig(stats, /^eslint\.config\./) || hasConfig(stats, '.eslintrc') || hasConfig(stats, '.eslintrc.json')) {
    rules.push('Follow ESLint rules and existing lint patterns; avoid suppressions unless narrowly justified.');
  }
  if (hasConfig(stats, '.editorconfig')) rules.push('Respect `.editorconfig` whitespace, line ending, and indentation settings.');
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

function collectArchitectureHints(projectPath: string, stats: ScanStats): string[] {
  const hints: string[] = [];
  const roots = getRankedKeys(stats.sourceRootCounts, 6);

  if (existsSync(join(projectPath, 'apps')) || existsSync(join(projectPath, 'packages')) || existsSync(join(projectPath, 'libs'))) {
    hints.push('Respect workspace package boundaries and prefer shared/core modules for cross-platform logic.');
  }
  if (roots.some((root) => root.includes('src/main')) && roots.some((root) => root.includes('src/renderer'))) {
    hints.push('Keep process-specific code in its current boundary; do not import UI modules into service/runtime layers.');
  }
  if (stats.packageJsonPaths.length > 1) {
    hints.push('When a change touches one package, run the nearest package command first before broader workspace checks.');
  }

  return hints;
}

function collectWorkflowHints(commands: AutocodeProjectPromptProfile['commands'], stats: ScanStats): string[] {
  const hints: string[] = [];
  if (commands.typecheck.length > 0) hints.push('Prefer typecheck before broad test runs when the change is TypeScript-heavy.');
  if (commands.lint.length > 0) hints.push('Use lint for style and import-boundary regressions before final handoff.');
  if (commands.test.length === 0) hints.push('No test command was detected; use the smallest build/typecheck/manual verification path available.');
  if (stats.sourceFileCount > 250) hints.push('For large projects, avoid whole-repo reading; use targeted search and project index summaries first.');
  return hints;
}

function normalizeCommands(commands: AutocodeProjectPromptProfile['commands']): AutocodeProjectPromptProfile['commands'] {
  return {
    build: uniqueSorted(commands.build).slice(0, 6),
    test: uniqueSorted(commands.test).slice(0, 6),
    lint: uniqueSorted(commands.lint).slice(0, 6),
    typecheck: uniqueSorted(commands.typecheck).slice(0, 6),
  };
}

function appendNonNodeCommands(
  projectPath: string,
  commands: AutocodeProjectPromptProfile['commands'],
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
  if (existsSync(join(projectPath, 'pyproject.toml')) || existsSync(join(projectPath, 'requirements.txt'))) {
    if (frameworks.includes('pytest')) commands.test.push('pytest');
    if (frameworks.includes('ruff')) commands.lint.push('ruff check .');
    if (frameworks.includes('mypy')) commands.typecheck.push('mypy .');
  }
}

async function loadProjectPromptProfile(projectPath: string): Promise<AutocodeProjectPromptProfile | null> {
  const raw = await safeReadJson(getAutocodeProjectPromptProfilePath(projectPath));
  if (!raw || raw.version !== PROJECT_PROMPT_PROFILE_VERSION || !raw.project || !raw.workflow) return null;
  return raw as unknown as AutocodeProjectPromptProfile;
}

export async function generateWebProjectPromptProfile(projectPath: string): Promise<AutocodeProjectPromptProfile> {
  const stats = await scanProject(projectPath);
  const stack = new StackDetector(projectPath).detectAll();
  const packageManifests = await readPackageManifests(projectPath, stats.packageJsonPaths, stack.packageManagers);
  const frameworks = uniqueSorted([
    ...new FrameworkDetector(projectPath).detectAll(),
    ...collectFrameworksFromManifests(packageManifests),
  ]);
  const size = inferProjectSize(stats);
  const workflow = inferWorkflow(size);
  const commands = normalizeCommands({
    build: collectScriptCommands(packageManifests, ['build', 'compile']),
    test: collectScriptCommands(packageManifests, ['test', 'test:unit', 'test:integration']),
    lint: collectScriptCommands(packageManifests, ['lint', 'check']),
    typecheck: collectScriptCommands(packageManifests, ['typecheck', 'type-check', 'tsc']),
  });
  appendNonNodeCommands(projectPath, commands, frameworks);
  const normalizedCommands = normalizeCommands(commands);

  return {
    version: PROJECT_PROMPT_PROFILE_VERSION,
    generatedAt: new Date().toISOString(),
    project: {
      name: basename(projectPath),
      size,
      domain: inferProjectDomain(frameworks, stats),
      sourceFileCount: stats.sourceFileCount,
      totalFileCount: stats.totalFileCount,
      packageCount: stats.packageJsonPaths.length,
      languages: uniqueSorted(stack.languages),
      frameworks,
      packageManagers: uniqueSorted(stack.packageManagers),
      databases: uniqueSorted(stack.databases),
      infrastructure: uniqueSorted([...stack.infrastructure, ...stack.cloudProviders]),
    },
    conventions: {
      instructionFiles: uniqueSorted(stats.instructionFiles).slice(0, 8),
      configFiles: uniqueSorted(stats.configFiles).slice(0, 12),
      sourceRoots: getRankedKeys(stats.sourceRootCounts, 8),
      testRoots: getRankedKeys(stats.testRootCounts, 6),
      frameworkConventions: collectFrameworkConventions(frameworks, stats),
      codingRules: collectCodingRules(stack, frameworks, stats),
      architectureHints: collectArchitectureHints(projectPath, stats),
      workflowHints: collectWorkflowHints(normalizedCommands, stats),
    },
    workflow,
    commands: normalizedCommands,
    promptOverrides: {
      generated: [...PROJECT_PROMPT_NAMES],
      directory: getAutocodeProjectPromptsRelativeDir(),
    },
  };
}

async function isGeneratedPrompt(promptPath: string): Promise<boolean> {
  try {
    return (await readFile(promptPath, 'utf-8')).includes('## PROJECT-SPECIFIC PROMPT (GENERATED)');
  } catch {
    return false;
  }
}

export async function initializeWebProjectPromptProfile(
  projectPath: string,
  options: { overwrite?: boolean } = {},
): Promise<InitializeWebProjectPromptProfileResult> {
  await mkdir(getAutocodeProjectDataDir(projectPath), { recursive: true });

  const existingProfile = options.overwrite ? null : await loadProjectPromptProfile(projectPath);
  const profile = existingProfile ?? await generateWebProjectPromptProfile(projectPath);
  const profilePath = getAutocodeProjectPromptProfilePath(projectPath);

  if (options.overwrite || !existingProfile || !existsSync(profilePath)) {
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf-8');
  }

  const promptOverrides = generateAutocodeProjectPromptOverrides(profile);
  const promptsDir = getAutocodeProjectPromptsDir(projectPath);
  await mkdir(promptsDir, { recursive: true });

  if (options.overwrite) {
    const managedPromptNames = new Set(Object.keys(promptOverrides));
    for (const promptName of PROJECT_PROMPT_NAMES) {
      if (managedPromptNames.has(promptName)) continue;
      const promptPath = join(promptsDir, `${promptName}.md`);
      if (existsSync(promptPath) && await isGeneratedPrompt(promptPath)) {
        await unlink(promptPath);
      }
    }
  }

  for (const [promptName, content] of Object.entries(promptOverrides)) {
    const promptPath = join(promptsDir, `${promptName}.md`);
    if (options.overwrite || !existsSync(promptPath) || await isGeneratedPrompt(promptPath)) {
      await writeFile(promptPath, `${content.trimEnd()}\n`, 'utf-8');
    }
  }

  return {
    profile,
    profilePath,
    promptsDir,
  };
}

export async function assertProjectDirectory(projectPath: string): Promise<void> {
  const projectStat = await stat(projectPath);
  if (!projectStat.isDirectory()) {
    throw new Error('Project path must be a directory.');
  }
}
