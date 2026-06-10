import * as path from 'node:path';

export function ensureAutocodeAbsolutePath(inputPath: string): string {
  if (!inputPath || inputPath.trim() === '') {
    throw new Error('Path cannot be empty');
  }

  return path.isAbsolute(inputPath) ? inputPath : path.resolve(inputPath);
}
