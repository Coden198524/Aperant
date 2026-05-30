import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { getAutocodeProjectLocksDir } from '../project/data-paths.js';

export type AutocodeRuntimeWorkspaceMode = 'direct' | 'worktree';
export type AutocodeRuntimeWorkspaceConflictReason =
  | 'same_workspace'
  | 'unknown_direct_files'
  | 'overlapping_files';

export interface AutocodeRuntimeFileIntent {
  path: string;
  intent?: 'read' | 'write' | 'create' | 'modify';
}

export type AutocodeRuntimeFileIntentInput = string | AutocodeRuntimeFileIntent;

export interface AutocodeRuntimeWorkspaceClaimInput {
  taskId: string;
  projectId?: string;
  projectRoot: string;
  workspaceRoot: string;
  mode?: AutocodeRuntimeWorkspaceMode;
  fileIntents?: AutocodeRuntimeFileIntentInput[];
  label?: string;
  now?: string | Date;
}

export interface AutocodeRuntimeWorkspaceClaim {
  id: string;
  taskId: string;
  projectId?: string;
  projectRoot: string;
  workspaceRoot: string;
  mode: AutocodeRuntimeWorkspaceMode;
  fileIntents: string[];
  hasUnknownFileIntent: boolean;
  label?: string;
  createdAt: string;
}

export interface AutocodeRuntimeWorkspaceConflict {
  reason: AutocodeRuntimeWorkspaceConflictReason;
  activeClaim: AutocodeRuntimeWorkspaceClaim;
  requestedClaim: AutocodeRuntimeWorkspaceClaim;
  overlappingFiles: string[];
}

export type AutocodeRuntimeWorkspaceClaimResult =
  | { ok: true; claim: AutocodeRuntimeWorkspaceClaim }
  | { ok: false; conflict: AutocodeRuntimeWorkspaceConflict };

export interface AutocodeRuntimeFileWriteLockInput {
  projectRoot: string;
  filePath: string;
  dataDirName?: string;
  ownerId?: string;
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
  now?: Date | string;
}

export interface AutocodeRuntimeFileWriteLock {
  lockDir: string;
  filePath: string;
  projectRoot: string;
  token: string;
  ownerId: string;
  acquiredAt: string;
}

export interface AutocodeRuntimeFileWriteLockMetadata {
  filePath: string;
  ownerId: string;
  token: string;
  acquiredAt: string;
  processId?: number;
}

export interface AutocodeRuntimeFileWriteLockScope {
  projectRoot: string;
  dataDirName?: string;
}

export const AUTOCODE_RUNTIME_FILE_WRITE_LOCKS_DIR_NAME = 'runtime-file-writes';
export const AUTOCODE_RUNTIME_FILE_WRITE_LOCK_TIMEOUT_MS = 120_000;
export const AUTOCODE_RUNTIME_FILE_WRITE_LOCK_RETRY_MS = 100;
export const AUTOCODE_RUNTIME_FILE_WRITE_LOCK_STALE_MS = 10 * 60_000;

const activeAutocodeRuntimeFileWriteLockDirs = new Set<string>();

export class AutocodeRuntimeWorkspaceClaimManager {
  private claims = new Map<string, AutocodeRuntimeWorkspaceClaim>();

  tryClaim(input: AutocodeRuntimeWorkspaceClaimInput): AutocodeRuntimeWorkspaceClaimResult {
    const requestedClaim = createAutocodeRuntimeWorkspaceClaim(input);
    this.releaseByTask(requestedClaim.taskId);

    const conflict = this.findConflict(requestedClaim);
    if (conflict) {
      return { ok: false, conflict };
    }

    this.claims.set(requestedClaim.id, requestedClaim);
    return { ok: true, claim: requestedClaim };
  }

  hasConflict(input: AutocodeRuntimeWorkspaceClaimInput): AutocodeRuntimeWorkspaceConflict | null {
    const requestedClaim = createAutocodeRuntimeWorkspaceClaim(input);
    return this.findConflict(requestedClaim);
  }

  release(claimId: string | null | undefined): boolean {
    if (!claimId) {
      return false;
    }
    return this.claims.delete(claimId);
  }

  releaseByTask(taskId: string | null | undefined): number {
    if (!taskId) {
      return 0;
    }

    let released = 0;
    for (const claim of this.claims.values()) {
      if (claim.taskId === taskId) {
        this.claims.delete(claim.id);
        released++;
      }
    }
    return released;
  }

  listClaims(): AutocodeRuntimeWorkspaceClaim[] {
    return [...this.claims.values()].map((claim) => ({ ...claim, fileIntents: [...claim.fileIntents] }));
  }

  clear(): void {
    this.claims.clear();
  }

  private findConflict(requestedClaim: AutocodeRuntimeWorkspaceClaim): AutocodeRuntimeWorkspaceConflict | null {
    for (const activeClaim of this.claims.values()) {
      const conflict = getAutocodeRuntimeWorkspaceConflict(activeClaim, requestedClaim);
      if (conflict) {
        return conflict;
      }
    }
    return null;
  }
}

export const autocodeRuntimeWorkspaceClaims = new AutocodeRuntimeWorkspaceClaimManager();

export function createAutocodeRuntimeWorkspaceClaim(
  input: AutocodeRuntimeWorkspaceClaimInput,
): AutocodeRuntimeWorkspaceClaim {
  const projectRoot = normalizeAutocodeRuntimePath(input.projectRoot);
  const workspaceRoot = normalizeAutocodeRuntimePath(input.workspaceRoot || input.projectRoot);
  const fileIntents = normalizeAutocodeRuntimeFileIntents(input.fileIntents, workspaceRoot);
  const createdAt = toAutocodeRuntimeIsoDate(input.now);
  const mode = input.mode ?? (workspaceRoot === projectRoot ? 'direct' : 'worktree');

  return {
    id: [
      'claim',
      normalizeAutocodeRuntimeClaimIdPart(input.taskId),
      normalizeAutocodeRuntimeClaimIdPart(createdAt),
      Math.random().toString(36).slice(2, 8),
    ].join('-'),
    taskId: input.taskId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    projectRoot,
    workspaceRoot,
    mode,
    fileIntents,
    hasUnknownFileIntent: fileIntents.length === 0,
    ...(input.label ? { label: input.label } : {}),
    createdAt,
  };
}

export function getAutocodeRuntimeWorkspaceConflict(
  activeClaim: AutocodeRuntimeWorkspaceClaim,
  requestedClaim: AutocodeRuntimeWorkspaceClaim,
): AutocodeRuntimeWorkspaceConflict | null {
  if (activeClaim.taskId === requestedClaim.taskId) {
    return null;
  }

  if (activeClaim.projectRoot !== requestedClaim.projectRoot) {
    return null;
  }

  if (activeClaim.mode === 'worktree' || requestedClaim.mode === 'worktree') {
    return activeClaim.workspaceRoot === requestedClaim.workspaceRoot
      ? buildConflict('same_workspace', activeClaim, requestedClaim, [activeClaim.workspaceRoot])
      : null;
  }

  if (activeClaim.hasUnknownFileIntent || requestedClaim.hasUnknownFileIntent) {
    return buildConflict('unknown_direct_files', activeClaim, requestedClaim, []);
  }

  const overlappingFiles = getOverlappingAutocodeRuntimePaths(activeClaim.fileIntents, requestedClaim.fileIntents);
  if (overlappingFiles.length > 0) {
    return buildConflict('overlapping_files', activeClaim, requestedClaim, overlappingFiles);
  }

  return null;
}

export function normalizeAutocodeRuntimePath(value: string): string {
  const trimmed = value.trim();
  const resolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(trimmed);
  return trimTrailingSlash(resolved.replace(/\\/g, '/')).toLowerCase();
}

export function normalizeAutocodeRuntimeFileIntent(
  input: AutocodeRuntimeFileIntentInput,
  workspaceRoot: string,
): string | null {
  const rawPath = typeof input === 'string' ? input : input.path;
  const trimmed = normalizeAutocodeRuntimeFileIntentPathValue(rawPath);
  if (!trimmed) {
    return null;
  }

  return normalizeAutocodeRuntimePath(isAbsolute(trimmed) ? trimmed : resolve(workspaceRoot, trimmed));
}

function normalizeAutocodeRuntimeFileIntentPathValue(value: string | null | undefined): string {
  const trimmed = value?.trim().replace(/\\/g, '/') ?? '';
  if (!trimmed) {
    return '';
  }

  const wildcardIndex = trimmed.search(/[*?[{]/);
  if (wildcardIndex < 0) {
    return trimmed;
  }

  const stablePrefix = trimmed.slice(0, wildcardIndex).replace(/\/+$/, '');
  if (!stablePrefix || stablePrefix === '.') {
    return '.';
  }

  return stablePrefix;
}

export function normalizeAutocodeRuntimeFileIntents(
  inputs: AutocodeRuntimeFileIntentInput[] | null | undefined,
  workspaceRoot: string,
): string[] {
  const normalized = new Set<string>();
  for (const input of inputs ?? []) {
    const path = normalizeAutocodeRuntimeFileIntent(input, workspaceRoot);
    if (path) {
      normalized.add(path);
    }
  }
  return [...normalized].sort();
}

export function collectAutocodeRuntimeFileIntentsFromPlan(plan: unknown): string[] {
  const fileIntents = new Set<string>();
  for (const workItem of collectPlanWorkItems(plan)) {
    collectStringArrayField(workItem, ['files_to_create', 'filesToCreate', 'new_files'], fileIntents);
    collectStringArrayField(workItem, ['files_to_modify', 'filesToModify', 'file_paths', 'files_modified'], fileIntents);
    collectStringArrayField(workItem, ['pattern_files', 'patternFiles'], fileIntents);
  }
  return [...fileIntents].sort();
}

export async function acquireAutocodeRuntimeFileWriteLock(
  input: AutocodeRuntimeFileWriteLockInput,
): Promise<AutocodeRuntimeFileWriteLock> {
  const attempt = createAutocodeRuntimeFileWriteLockAttempt(input);
  const deadline = Date.now() + attempt.timeoutMs;

  mkdirSync(getAutocodeRuntimeFileWriteLocksDir(attempt.projectRoot, input.dataDirName), { recursive: true });

  while (true) {
    try {
      mkdirSync(attempt.lockDir);
      writeAutocodeRuntimeFileWriteLockMetadata(attempt);
      activeAutocodeRuntimeFileWriteLockDirs.add(attempt.lockDir);
      return {
        lockDir: attempt.lockDir,
        filePath: attempt.filePath,
        projectRoot: attempt.projectRoot,
        token: attempt.token,
        ownerId: attempt.ownerId,
        acquiredAt: attempt.acquiredAt,
      };
    } catch (error) {
      if (!isNodeFileExistsError(error)) {
        throw error;
      }

      if (isAutocodeRuntimeFileWriteLockHeldByThisProcess(attempt.lockDir)) {
        throw new Error(formatAutocodeRuntimeFileWriteLockReentrant(attempt.filePath));
      }

      if (isAutocodeRuntimeFileWriteLockStale(attempt.lockDir, attempt.staleMs)) {
        releaseAutocodeRuntimeFileWriteLockDir(attempt.lockDir);
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(formatAutocodeRuntimeFileWriteLockTimeout(attempt.filePath, attempt.lockDir));
      }

      await waitForAutocodeRuntimeFileWriteLock(attempt.retryMs);
    }
  }
}

export function acquireAutocodeRuntimeFileWriteLockSync(
  input: AutocodeRuntimeFileWriteLockInput,
): AutocodeRuntimeFileWriteLock {
  const attempt = createAutocodeRuntimeFileWriteLockAttempt(input);
  const deadline = Date.now() + attempt.timeoutMs;

  mkdirSync(getAutocodeRuntimeFileWriteLocksDir(attempt.projectRoot, input.dataDirName), { recursive: true });

  while (true) {
    try {
      mkdirSync(attempt.lockDir);
      writeAutocodeRuntimeFileWriteLockMetadata(attempt);
      activeAutocodeRuntimeFileWriteLockDirs.add(attempt.lockDir);
      return {
        lockDir: attempt.lockDir,
        filePath: attempt.filePath,
        projectRoot: attempt.projectRoot,
        token: attempt.token,
        ownerId: attempt.ownerId,
        acquiredAt: attempt.acquiredAt,
      };
    } catch (error) {
      if (!isNodeFileExistsError(error)) {
        throw error;
      }

      if (isAutocodeRuntimeFileWriteLockHeldByThisProcess(attempt.lockDir)) {
        throw new Error(formatAutocodeRuntimeFileWriteLockReentrant(attempt.filePath));
      }

      if (isAutocodeRuntimeFileWriteLockStale(attempt.lockDir, attempt.staleMs)) {
        releaseAutocodeRuntimeFileWriteLockDir(attempt.lockDir);
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(formatAutocodeRuntimeFileWriteLockTimeout(attempt.filePath, attempt.lockDir));
      }

      waitForAutocodeRuntimeFileWriteLockSync(attempt.retryMs);
    }
  }
}

export async function withAutocodeRuntimeFileWriteLock<T>(
  input: AutocodeRuntimeFileWriteLockInput,
  callback: (lock: AutocodeRuntimeFileWriteLock) => Promise<T> | T,
): Promise<T> {
  const lock = await acquireAutocodeRuntimeFileWriteLock(input);
  try {
    return await callback(lock);
  } finally {
    releaseAutocodeRuntimeFileWriteLock(lock);
  }
}

export function withAutocodeRuntimeFileWriteLockSync<T>(
  input: AutocodeRuntimeFileWriteLockInput,
  callback: (lock: AutocodeRuntimeFileWriteLock) => T,
): T {
  const lock = acquireAutocodeRuntimeFileWriteLockSync(input);
  try {
    return callback(lock);
  } finally {
    releaseAutocodeRuntimeFileWriteLock(lock);
  }
}

export function releaseAutocodeRuntimeFileWriteLock(lock: AutocodeRuntimeFileWriteLock): boolean {
  try {
    const metadata = readAutocodeRuntimeFileWriteLockMetadata(lock.lockDir);
    if (metadata?.token && metadata.token !== lock.token) {
      return false;
    }
    releaseAutocodeRuntimeFileWriteLockDir(lock.lockDir);
    return true;
  } catch {
    return false;
  } finally {
    activeAutocodeRuntimeFileWriteLockDirs.delete(lock.lockDir);
  }
}

export function getAutocodeRuntimeFileWriteLocksDir(projectRoot: string, dataDirName?: string): string {
  return join(
    getAutocodeProjectLocksDir(projectRoot, dataDirName),
    AUTOCODE_RUNTIME_FILE_WRITE_LOCKS_DIR_NAME,
  );
}

export function getAutocodeRuntimeFileWriteLockDir(
  projectRoot: string,
  filePath: string,
  dataDirName?: string,
): string {
  const key = createHash('sha256').update(normalizeAutocodeRuntimePath(filePath)).digest('hex').slice(0, 32);
  return join(getAutocodeRuntimeFileWriteLocksDir(projectRoot, dataDirName), `${key}.lock`);
}

export function inferAutocodeRuntimeFileWriteLockScopeFromSpecDir(
  specDir: string,
): AutocodeRuntimeFileWriteLockScope {
  const resolvedSpecDir = resolve(specDir);
  const specsDir = dirname(resolvedSpecDir);

  if (basename(specsDir).toLowerCase() === 'specs') {
    const dataDir = dirname(specsDir);
    return {
      projectRoot: dirname(dataDir),
      dataDirName: basename(dataDir),
    };
  }

  return {
    projectRoot: resolvedSpecDir,
    dataDirName: '.autocode',
  };
}

function createAutocodeRuntimeFileWriteLockAttempt(input: AutocodeRuntimeFileWriteLockInput): {
  projectRoot: string;
  filePath: string;
  ownerId: string;
  token: string;
  acquiredAt: string;
  lockDir: string;
  metadataPath: string;
  timeoutMs: number;
  retryMs: number;
  staleMs: number;
} {
  const projectRoot = normalizeAutocodeRuntimePath(input.projectRoot);
  const filePath = normalizeAutocodeRuntimeFileIntent(input.filePath, projectRoot)
    ?? normalizeAutocodeRuntimePath(input.filePath);
  const lockDir = getAutocodeRuntimeFileWriteLockDir(projectRoot, filePath, input.dataDirName);

  return {
    projectRoot,
    filePath,
    ownerId: input.ownerId?.trim() || 'unknown',
    token: randomUUID(),
    acquiredAt: toAutocodeRuntimeIsoDate(input.now),
    lockDir,
    metadataPath: getAutocodeRuntimeFileWriteLockMetadataPath(lockDir),
    timeoutMs: Math.max(0, input.timeoutMs ?? AUTOCODE_RUNTIME_FILE_WRITE_LOCK_TIMEOUT_MS),
    retryMs: Math.max(1, input.retryMs ?? AUTOCODE_RUNTIME_FILE_WRITE_LOCK_RETRY_MS),
    staleMs: Math.max(0, input.staleMs ?? AUTOCODE_RUNTIME_FILE_WRITE_LOCK_STALE_MS),
  };
}

function collectPlanWorkItems(plan: unknown): Record<string, unknown>[] {
  if (!plan || typeof plan !== 'object') {
    return [];
  }

  const phases = (plan as { phases?: unknown }).phases;
  if (!Array.isArray(phases)) {
    return [];
  }

  return phases.flatMap((phase) => {
    if (!phase || typeof phase !== 'object') {
      return [];
    }
    const subtasks = (phase as { subtasks?: unknown; chunks?: unknown }).subtasks
      ?? (phase as { chunks?: unknown }).chunks;
    return Array.isArray(subtasks)
      ? subtasks.filter((subtask): subtask is Record<string, unknown> => !!subtask && typeof subtask === 'object')
      : [];
  });
}

function collectStringArrayField(
  record: Record<string, unknown>,
  keys: string[],
  target: Set<string>,
): void {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) {
        target.add(item.trim());
      }
    }
  }
}

function buildConflict(
  reason: AutocodeRuntimeWorkspaceConflictReason,
  activeClaim: AutocodeRuntimeWorkspaceClaim,
  requestedClaim: AutocodeRuntimeWorkspaceClaim,
  overlappingFiles: string[],
): AutocodeRuntimeWorkspaceConflict {
  return {
    reason,
    activeClaim,
    requestedClaim,
    overlappingFiles,
  };
}

function getOverlappingAutocodeRuntimePaths(left: string[], right: string[]): string[] {
  const overlapping = new Set<string>();
  for (const leftPath of left) {
    for (const rightPath of right) {
      if (doAutocodeRuntimePathsOverlap(leftPath, rightPath)) {
        overlapping.add(leftPath.length >= rightPath.length ? leftPath : rightPath);
      }
    }
  }
  return [...overlapping].sort();
}

function doAutocodeRuntimePathsOverlap(leftPath: string, rightPath: string): boolean {
  return (
    leftPath === rightPath ||
    leftPath.startsWith(`${rightPath}/`) ||
    rightPath.startsWith(`${leftPath}/`)
  );
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function toAutocodeRuntimeIsoDate(value: string | Date | null | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return new Date().toISOString();
}

function normalizeAutocodeRuntimeClaimIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'runtime';
}

function getAutocodeRuntimeFileWriteLockMetadataPath(lockDir: string): string {
  return join(lockDir, 'metadata.json');
}

function writeAutocodeRuntimeFileWriteLockMetadata(input: {
  lockDir: string;
  metadataPath: string;
  filePath: string;
  ownerId: string;
  token: string;
  acquiredAt: string;
}): void {
  try {
    writeFileSync(
      input.metadataPath,
      JSON.stringify(
        {
          filePath: input.filePath,
          ownerId: input.ownerId,
          token: input.token,
          acquiredAt: input.acquiredAt,
          processId: process.pid,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (error) {
    releaseAutocodeRuntimeFileWriteLockDir(input.lockDir);
    throw error;
  }
}

function readAutocodeRuntimeFileWriteLockMetadata(
  lockDir: string,
): AutocodeRuntimeFileWriteLockMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(getAutocodeRuntimeFileWriteLockMetadataPath(lockDir), 'utf8')) as Partial<AutocodeRuntimeFileWriteLockMetadata>;
    if (
      typeof parsed.filePath === 'string' &&
      typeof parsed.ownerId === 'string' &&
      typeof parsed.token === 'string' &&
      typeof parsed.acquiredAt === 'string'
    ) {
      return {
        filePath: parsed.filePath,
        ownerId: parsed.ownerId,
        token: parsed.token,
        acquiredAt: parsed.acquiredAt,
        ...(typeof parsed.processId === 'number' ? { processId: parsed.processId } : {}),
      };
    }
  } catch {
    // Missing or corrupt metadata is treated as an anonymous active lock.
  }
  return null;
}

function isAutocodeRuntimeFileWriteLockStale(lockDir: string, staleMs: number): boolean {
  if (staleMs <= 0 || !existsSync(lockDir)) {
    return false;
  }
  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function releaseAutocodeRuntimeFileWriteLockDir(lockDir: string): void {
  rmSync(lockDir, { recursive: true, force: true });
}

function formatAutocodeRuntimeFileWriteLockTimeout(filePath: string, lockDir: string): string {
  const metadata = readAutocodeRuntimeFileWriteLockMetadata(lockDir);
  const owner = metadata?.ownerId ? ` held by ${metadata.ownerId}` : '';
  return `Timed out waiting for write lock on ${filePath}${owner}.`;
}

function formatAutocodeRuntimeFileWriteLockReentrant(filePath: string): string {
  return `Write lock on ${filePath} is already held by this process. Avoid nested writes to the same file.`;
}

function isAutocodeRuntimeFileWriteLockHeldByThisProcess(lockDir: string): boolean {
  if (activeAutocodeRuntimeFileWriteLockDirs.has(lockDir)) {
    return true;
  }
  const metadata = readAutocodeRuntimeFileWriteLockMetadata(lockDir);
  return metadata?.processId === process.pid;
}

function isNodeFileExistsError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function waitForAutocodeRuntimeFileWriteLock(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function waitForAutocodeRuntimeFileWriteLockSync(delayMs: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, delayMs);
}
