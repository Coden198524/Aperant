import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS,
  MAX_INSIGHTS_DOCUMENT_REFERENCES,
  MAX_INSIGHTS_REFERENCE_PATH_LENGTH,
} from '../../shared/constants';
import type { InsightsDocumentReference } from '../../shared/types';
import {
  canonicalPathsEqual,
  isCanonicalPathWithinRoot,
} from '../ai/security/canonical-path';
import type { InsightsDocumentCapabilityManager } from './document-capabilities';
import type { ValidateDocumentCapabilityInput } from './document-capabilities';

export interface InsightsDocumentAuthorizationContext {
  projectId: string;
  senderId: number;
  capabilities: InsightsDocumentCapabilityManager;
}

function referenceRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeReferenceId(value: unknown, index: number): string {
  if (typeof value === 'string' && /^[\p{L}\p{N}_.-]{1,128}$/u.test(value)) {
    return value;
  }
  return `document-reference-${index + 1}`;
}

function displayFilename(filePath: string): string {
  const sanitized = Array.from(path.basename(filePath))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join('')
    .slice(0, 180)
    .trim();
  return sanitized || 'file';
}

function isWithinProject(filePath: string, projectPath: string): boolean {
  return isCanonicalPathWithinRoot(filePath, projectPath);
}

function resolveRegularFile(rawPath: string, projectPath: string): {
  path: string;
  size: number;
} | null {
  try {
    const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(projectPath, rawPath);
    const realPath = fs.realpathSync(absolutePath);
    const stat = fs.statSync(realPath);
    return stat.isFile() ? { path: realPath, size: stat.size } : null;
  } catch {
    return null;
  }
}

/**
 * Treat renderer IPC payloads as untrusted. Resolve each path on the main
 * process, require an existing regular file, and derive display metadata from disk.
 */
export function normalizeInsightsDocumentReferences(
  value: unknown,
  projectPath: string,
  authorizationContext?: InsightsDocumentAuthorizationContext,
  maxReferences = MAX_INSIGHTS_DOCUMENT_REFERENCES,
  maxPathCharacters = MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS,
): InsightsDocumentReference[] {
  if (!Array.isArray(value)) return [];

  let canonicalProjectPath: string;
  try {
    canonicalProjectPath = fs.realpathSync(projectPath);
  } catch {
    return [];
  }

  const normalized: InsightsDocumentReference[] = [];
  const seenPaths = new Set<string>();
  const capabilitiesToConsume: ValidateDocumentCapabilityInput[] = [];
  let hadInvalidReference = false;
  let totalResolvedPathCharacters = 0;

  const safeLimit = Number.isFinite(maxReferences)
    ? Math.max(0, Math.floor(maxReferences))
    : MAX_INSIGHTS_DOCUMENT_REFERENCES;
  const safePathCharacterLimit = Number.isFinite(maxPathCharacters)
    ? Math.max(0, Math.floor(maxPathCharacters))
    : MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS;
  const candidateLimit = Math.min(value.length, safeLimit * 4);
  for (let index = 0; index < candidateLimit && normalized.length < safeLimit; index += 1) {
    const candidate = referenceRecord(value[index]);
    const rawPath = typeof candidate?.path === 'string' ? candidate.path.trim() : '';
    if (!rawPath || rawPath.length > MAX_INSIGHTS_REFERENCE_PATH_LENGTH || rawPath.includes('\0')) {
      hadInvalidReference = true;
      continue;
    }

    const initiallyResolved = resolveRegularFile(rawPath, canonicalProjectPath);
    if (!initiallyResolved) {
      hadInvalidReference = true;
      continue;
    }

    let resolved = initiallyResolved;
    if (!isWithinProject(initiallyResolved.path, canonicalProjectPath)) {
      const authorizationToken = typeof candidate?.authorizationToken === 'string'
        ? candidate.authorizationToken
        : '';
      const capabilityInput = authorizationContext ? {
        authorizationToken,
        projectId: authorizationContext.projectId,
        senderId: authorizationContext.senderId,
        path: initiallyResolved.path,
      } : null;
      if (!authorizationContext || !capabilityInput || !authorizationContext.capabilities.validate(capabilityInput)) {
        hadInvalidReference = true;
        continue;
      }

      // Re-resolve and re-stat after capability validation. A replaced path,
      // directory, or changed symlink must not inherit the prior authorization.
      const revalidated = resolveRegularFile(rawPath, canonicalProjectPath);
      if (
        !revalidated ||
        !canonicalPathsEqual(revalidated.path, initiallyResolved.path)
      ) {
        hadInvalidReference = true;
        continue;
      }
      resolved = revalidated;
      capabilitiesToConsume.push(capabilityInput);
    }

    const key = resolved.path;
    if (seenPaths.has(key)) {
      hadInvalidReference = true;
      continue;
    }
    totalResolvedPathCharacters += resolved.path.length;
    if (totalResolvedPathCharacters > safePathCharacterLimit) {
      hadInvalidReference = true;
      break;
    }
    seenPaths.add(key);
    normalized.push({
      id: normalizeReferenceId(candidate?.id, index),
      filename: displayFilename(resolved.path),
      path: resolved.path,
      size: resolved.size,
    });
  }

  if (totalResolvedPathCharacters > safePathCharacterLimit) {
    return [];
  }

  if (
    !hadInvalidReference &&
    authorizationContext &&
    !authorizationContext.capabilities.validateAllAndConsume(capabilitiesToConsume)
  ) {
    return [];
  }

  return normalized;
}
