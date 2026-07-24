import * as path from 'node:path';

/**
 * Compare paths that have already been resolved to canonical absolute paths.
 *
 * Do not case-fold Windows paths here. NTFS directories and remote shares can
 * be case-sensitive, so differently-cased canonical names may identify
 * different files even when process.platform is "win32".
 */
export function canonicalPathsEqual(left: string, right: string): boolean {
  return left === right;
}

/**
 * Check strict containment for canonical absolute paths.
 *
 * `path.relative()` follows the platform's usual case-insensitive Windows
 * semantics, which is unsafe for case-sensitive Windows directories/shares.
 * Canonical paths use the platform separator, so an exact prefix boundary is
 * both sufficient and intentionally case-sensitive.
 */
export function isCanonicalPathWithinRoot(
  candidatePath: string,
  rootPath: string,
  separator = path.sep,
): boolean {
  if (canonicalPathsEqual(candidatePath, rootPath)) {
    return true;
  }

  const rootPrefix = rootPath.endsWith(separator)
    ? rootPath
    : `${rootPath}${separator}`;
  return candidatePath.startsWith(rootPrefix);
}
