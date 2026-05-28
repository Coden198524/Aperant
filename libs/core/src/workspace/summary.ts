import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { shouldSkipAutocodeWorkspaceDir } from './ignore-rules.js';

export interface WorkspaceSummary {
  rootPath: string;
  name: string;
  packageName?: string;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  detectedFrameworks: string[];
  detectedLanguages: string[];
  scripts: string[];
  hasGit: boolean;
  totalFilesSampled: number;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript React',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript React',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.c': 'C',
  '.rb': 'Ruby',
  '.php': 'PHP',
};

const FRAMEWORK_DEPS: Record<string, string> = {
  '@angular/core': 'Angular',
  '@nestjs/core': 'NestJS',
  '@vitejs/plugin-react': 'React + Vite',
  electron: 'Electron',
  express: 'Express',
  fastify: 'Fastify',
  hono: 'Hono',
  next: 'Next.js',
  react: 'React',
  svelte: 'Svelte',
  vue: 'Vue',
};

export function summarizeWorkspace(rootPath: string): WorkspaceSummary {
  const packageJson = readPackageJson(rootPath);
  const dependencyNames = new Set([
    ...Object.keys(packageJson?.dependencies ?? {}),
    ...Object.keys(packageJson?.devDependencies ?? {}),
    ...Object.keys(packageJson?.peerDependencies ?? {}),
  ]);
  const detectedLanguages = detectLanguages(rootPath);

  return {
    rootPath,
    name: packageJson?.name ?? basename(rootPath),
    packageName: packageJson?.name,
    packageManager: detectPackageManager(rootPath),
    detectedFrameworks: detectFrameworks(rootPath, dependencyNames),
    detectedLanguages: detectedLanguages.languages,
    scripts: Object.keys(packageJson?.scripts ?? {}).sort(),
    hasGit: existsSync(join(rootPath, '.git')),
    totalFilesSampled: detectedLanguages.totalFilesSampled,
  };
}

function readPackageJson(rootPath: string): {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
} | null {
  const packageJsonPath = join(rootPath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function detectPackageManager(rootPath: string): WorkspaceSummary['packageManager'] {
  if (existsSync(join(rootPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(rootPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(rootPath, 'bun.lockb')) || existsSync(join(rootPath, 'bun.lock'))) return 'bun';
  if (existsSync(join(rootPath, 'package-lock.json'))) return 'npm';
  return undefined;
}

function detectFrameworks(rootPath: string, dependencyNames: Set<string>): string[] {
  const frameworks = new Set<string>();

  for (const [dependency, framework] of Object.entries(FRAMEWORK_DEPS)) {
    if (dependencyNames.has(dependency)) {
      frameworks.add(framework);
    }
  }

  if (existsSync(join(rootPath, 'pyproject.toml'))) frameworks.add('Python');
  if (existsSync(join(rootPath, 'Cargo.toml'))) frameworks.add('Rust');
  if (existsSync(join(rootPath, 'go.mod'))) frameworks.add('Go');
  if (existsSync(join(rootPath, 'composer.json'))) frameworks.add('PHP');
  if (existsSync(join(rootPath, 'Gemfile'))) frameworks.add('Ruby');

  return [...frameworks].sort();
}

function detectLanguages(rootPath: string): { languages: string[]; totalFilesSampled: number } {
  const counts = new Map<string, number>();
  let totalFilesSampled = 0;
  const maxFiles = 500;

  const visit = (dir: string, depth: number): void => {
    if (depth > 4 || totalFilesSampled >= maxFiles) {
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (totalFilesSampled >= maxFiles) {
        return;
      }

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (!shouldSkipAutocodeWorkspaceDir(entry)) {
          visit(fullPath, depth + 1);
        }
        continue;
      }

      if (!stat.isFile()) {
        continue;
      }

      totalFilesSampled += 1;
      const language = languageForFile(entry);
      if (language) {
        counts.set(language, (counts.get(language) ?? 0) + 1);
      }
    }
  };

  visit(rootPath, 0);

  return {
    languages: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([language]) => language),
    totalFilesSampled,
  };
}

function languageForFile(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  const extension = Object.keys(LANGUAGE_BY_EXTENSION).find((candidate) => lower.endsWith(candidate));
  return extension ? LANGUAGE_BY_EXTENSION[extension] : undefined;
}
