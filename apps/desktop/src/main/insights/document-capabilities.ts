import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  MAX_INSIGHTS_DOCUMENT_AUTHORIZATION_TOKEN_LENGTH,
  MAX_INSIGHTS_REFERENCE_PATH_LENGTH,
} from '../../shared/constants';
import type { InsightsDocumentAuthorization } from '../../shared/types';
import { canonicalPathsEqual } from '../ai/security/canonical-path';

const DEFAULT_CAPABILITY_TTL_MS = 30 * 60 * 1000;
const MAX_ACTIVE_CAPABILITIES = 512;

interface CapabilityRecord {
  projectId: string;
  senderId: number;
  path: string;
  expiresAt: number;
}

interface CapabilityManagerOptions {
  ttlMs?: number;
  now?: () => number;
  tokenFactory?: () => string;
}

export interface ValidateDocumentCapabilityInput {
  authorizationToken: string;
  projectId: string;
  senderId: number;
  path: string;
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

function resolveRegularFile(rawPath: string): { path: string; size: number } {
  if (
    !rawPath ||
    rawPath.length > MAX_INSIGHTS_REFERENCE_PATH_LENGTH ||
    rawPath.includes('\0') ||
    !path.isAbsolute(rawPath)
  ) {
    throw new Error('The selected local file path is invalid.');
  }

  try {
    const realPath = fs.realpathSync(rawPath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      throw new Error('not a regular file');
    }
    return { path: realPath, size: stat.size };
  } catch {
    throw new Error('The selected local file is unavailable or is not a regular file.');
  }
}

/**
 * In-memory, sender-bound capabilities proving that a user selected a native file.
 * Tokens are short-lived, single-use, and never written to session storage.
 */
export class InsightsDocumentCapabilityManager {
  private readonly capabilities = new Map<string, CapabilityRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly tokenFactory: () => string;

  constructor(options: CapabilityManagerOptions = {}) {
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS);
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'));
  }

  issue(projectId: string, senderId: number, rawPath: string): InsightsDocumentAuthorization {
    if (!projectId || !Number.isSafeInteger(senderId) || senderId < 0) {
      throw new Error('Invalid document authorization context.');
    }

    const resolved = resolveRegularFile(rawPath);
    this.removeExpired();
    while (this.capabilities.size >= MAX_ACTIVE_CAPABILITIES) {
      const oldestToken = this.capabilities.keys().next().value;
      if (typeof oldestToken !== 'string') break;
      this.capabilities.delete(oldestToken);
    }

    let authorizationToken = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = this.tokenFactory();
      if (
        candidate &&
        candidate.length <= MAX_INSIGHTS_DOCUMENT_AUTHORIZATION_TOKEN_LENGTH &&
        !this.capabilities.has(candidate)
      ) {
        authorizationToken = candidate;
        break;
      }
    }
    if (!authorizationToken) {
      throw new Error('Could not create document authorization.');
    }

    this.capabilities.set(authorizationToken, {
      projectId,
      senderId,
      path: resolved.path,
      expiresAt: this.now() + this.ttlMs,
    });

    return {
      filename: displayFilename(resolved.path),
      path: resolved.path,
      size: resolved.size,
      authorizationToken,
    };
  }

  validateAndConsume(input: ValidateDocumentCapabilityInput): boolean {
    return this.validateAllAndConsume([input]);
  }

  validate(input: ValidateDocumentCapabilityInput): boolean {
    return this.isValid(input, this.now());
  }

  validateAllAndConsume(inputs: readonly ValidateDocumentCapabilityInput[]): boolean {
    if (inputs.length === 0) return true;
    const tokens = new Set(inputs.map((input) => input.authorizationToken));
    if (tokens.size !== inputs.length) return false;

    const now = this.now();
    if (!inputs.every((input) => this.isValid(input, now))) return false;
    for (const input of inputs) {
      this.capabilities.delete(input.authorizationToken);
    }
    return true;
  }

  private isValid(input: ValidateDocumentCapabilityInput, now: number): boolean {
    if (
      !input.authorizationToken ||
      input.authorizationToken.length > MAX_INSIGHTS_DOCUMENT_AUTHORIZATION_TOKEN_LENGTH
    ) {
      return false;
    }

    const capability = this.capabilities.get(input.authorizationToken);
    if (!capability) return false;
    if (capability.expiresAt <= now) {
      this.capabilities.delete(input.authorizationToken);
      return false;
    }
    if (
      capability.projectId !== input.projectId ||
      capability.senderId !== input.senderId ||
      !canonicalPathsEqual(capability.path, input.path)
    ) {
      return false;
    }

    return true;
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [token, capability] of this.capabilities) {
      if (capability.expiresAt <= now) this.capabilities.delete(token);
    }
  }
}

export const insightsDocumentCapabilities = new InsightsDocumentCapabilityManager();
