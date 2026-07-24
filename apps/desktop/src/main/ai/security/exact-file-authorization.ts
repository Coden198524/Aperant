import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PathContainmentResult } from './path-containment';
import { canonicalPathsEqual } from './canonical-path';

interface ExactFileResolution extends PathContainmentResult {
  stat: fs.BigIntStats;
}

function resolveExactFilePath(
  filePath: string,
  allowedExactFilePaths: readonly string[],
): ExactFileResolution {
  if (!filePath || !path.isAbsolute(filePath) || allowedExactFilePaths.length === 0) {
    throw new Error(
      `Path '${filePath}' is outside the project directory and is not an explicitly allowed file`,
    );
  }

  let resolvedPath: string;
  let stat: fs.BigIntStats;
  try {
    resolvedPath = fs.realpathSync(filePath);
    // Use lstat on the canonical pathname. If that pathname is exchanged for
    // a symlink/reparse point after realpath, lstat observes the replacement
    // itself instead of silently following it to a different file.
    stat = fs.lstatSync(resolvedPath, { bigint: true });
  } catch {
    throw new Error(
      `Explicitly allowed file '${filePath}' could not be resolved as an existing regular file`,
    );
  }

  if (!stat.isFile()) {
    throw new Error(
      `Explicitly allowed path '${filePath}' is no longer a regular file`,
    );
  }

  const isExactMatch = allowedExactFilePaths.some((allowedPath) => (
    path.isAbsolute(allowedPath) && canonicalPathsEqual(allowedPath, resolvedPath)
  ));
  if (!isExactMatch) {
    throw new Error(
      `Path '${filePath}' is outside the project directory and is not an explicitly allowed file`,
    );
  }

  return {
    contained: true,
    resolvedPath,
    stat,
  };
}

/**
 * Authorize an existing regular file by canonical path equality.
 *
 * The allowed paths are trusted canonical snapshots captured when the caller
 * accepted the file reference. They are deliberately not resolved again here:
 * if an accepted path is later replaced by a directory or symlink, the new
 * filesystem object must not inherit the old authorization.
 */
export function assertExactFilePathAllowed(
  filePath: string,
  allowedExactFilePaths: readonly string[],
): PathContainmentResult {
  const { contained, resolvedPath } = resolveExactFilePath(
    filePath,
    allowedExactFilePaths,
  );
  return {
    contained,
    resolvedPath,
  };
}

/**
 * Re-authorize an exact file after it has been opened and bind the pathname
 * check to the actual OS file handle.
 *
 * Node exposes the Windows volume serial/file ID pair as `dev`/`ino`, just as
 * it exposes the device/inode pair on POSIX. BigInt stats avoid precision loss
 * for large Windows file IDs. Comparing those values closes the race where a
 * pathname is exchanged for a symlink/reparse point between authorization and
 * open.
 */
export function assertOpenedExactFilePathAllowed(
  filePath: string,
  allowedExactFilePaths: readonly string[],
  fd: number,
): PathContainmentResult {
  const authorization = resolveExactFilePath(filePath, allowedExactFilePaths);
  const openedStat = fs.fstatSync(fd, { bigint: true });

  if (
    !openedStat.isFile() ||
    openedStat.dev !== authorization.stat.dev ||
    openedStat.ino !== authorization.stat.ino
  ) {
    throw new Error(
      `Explicitly allowed file '${filePath}' changed between authorization and opening`,
    );
  }

  return {
    contained: true,
    resolvedPath: authorization.resolvedPath,
  };
}
