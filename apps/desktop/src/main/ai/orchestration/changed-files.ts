import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isAutocodeProjectDataPath } from '@autocode/core/workspace/ignore-rules';
import type { GeneratedFile } from './self-critique';

const execFileAsync = promisify(execFile);

const MAX_CRITIQUE_FILES = 30;
const MAX_CRITIQUE_FILE_BYTES = 256 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.mjs',
  '.md',
  '.php',
  '.py',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);

export interface ChangedFileSnapshot {
  files: Set<string>;
}

export async function collectGitChangedFileSnapshot(projectDir: string): Promise<ChangedFileSnapshot> {
  return {
    files: new Set(await collectGitChangedFiles(projectDir)),
  };
}

export async function collectFilesChangedSinceBaseline(
  projectDir: string,
  baseline: ChangedFileSnapshot,
  candidatePaths: string[] = [],
): Promise<string[]> {
  const current = new Set(await collectGitChangedFiles(projectDir));
  const changedAfterBaseline = [...current].filter((filePath) => !baseline.files.has(filePath));
  return uniqueNormalizedPaths(projectDir, [...changedAfterBaseline, ...candidatePaths]);
}

export async function loadGeneratedFilesForCritique(
  projectDir: string,
  filePaths: string[],
): Promise<GeneratedFile[]> {
  const normalizedPaths = uniqueNormalizedPaths(projectDir, filePaths)
    .filter(isLikelySourceTextPath)
    .slice(0, MAX_CRITIQUE_FILES);
  const files: GeneratedFile[] = [];

  for (const filePath of normalizedPaths) {
    const absolutePath = resolve(projectDir, filePath);
    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile() || fileStat.size > MAX_CRITIQUE_FILE_BYTES) {
        continue;
      }

      files.push({
        path: filePath,
        content: await readFile(absolutePath, 'utf-8'),
        isNew: !(await isTrackedGitFile(projectDir, filePath)),
      });
    } catch {
      // The file may have been deleted or be binary/unreadable; skip it for critique.
    }
  }

  return files;
}

async function collectGitChangedFiles(projectDir: string): Promise<string[]> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectDir,
      timeout: 3000,
    });
  } catch {
    return [];
  }

  const outputs = await Promise.all([
    runGitListCommand(projectDir, ['diff', '--name-only', '--diff-filter=ACMRT', '--']),
    runGitListCommand(projectDir, ['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '--']),
    runGitListCommand(projectDir, ['ls-files', '--others', '--exclude-standard']),
  ]);

  return uniqueNormalizedPaths(projectDir, outputs.flatMap((output) => output.split(/\r?\n/)));
}

async function runGitListCommand(projectDir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: projectDir,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

async function isTrackedGitFile(projectDir: string, filePath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', filePath], {
      cwd: projectDir,
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

function uniqueNormalizedPaths(projectDir: string, paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawPath of paths) {
    const normalized = normalizeProjectRelativePath(projectDir, rawPath);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizeProjectRelativePath(projectDir: string, filePath: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return null;
  }

  const projectRoot = resolve(projectDir);
  const resolvedPath = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(projectRoot, trimmed);
  const relativePath = relative(projectRoot, resolvedPath).replace(/\\/g, '/');

  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) {
    return null;
  }
  if (relativePath.includes('/../') || isAutocodeProjectDataPath(relativePath)) {
    return null;
  }

  return relativePath;
}

function isLikelySourceTextPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const dotIndex = lower.lastIndexOf('.');
  if (dotIndex < 0) {
    return false;
  }
  return TEXT_EXTENSIONS.has(lower.slice(dotIndex));
}
