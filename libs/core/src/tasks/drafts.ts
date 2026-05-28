import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type TaskDraftStatus = 'draft';

export interface TaskDraft {
  id: string;
  title: string;
  description: string;
  status: TaskDraftStatus;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskDraftInput {
  projectRoot: string;
  title: string;
  description?: string;
  storageDir?: string;
}

export interface TaskDraftStoreOptions {
  storageDir?: string;
}

interface TaskDraftFile {
  version: 1;
  drafts: TaskDraft[];
}

const TASK_DRAFT_FILE_VERSION = 1;

export function listTaskDrafts(projectRoot: string, options: TaskDraftStoreOptions = {}): TaskDraft[] {
  return readDraftFile(projectRoot, options).drafts
    .filter((draft) => draft.projectRoot === projectRoot)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createTaskDraft(input: CreateTaskDraftInput): TaskDraft {
  const title = input.title.trim();
  if (!title) {
    throw new Error('Task draft title is required.');
  }

  const now = new Date().toISOString();
  const draft: TaskDraft = {
    id: randomUUID(),
    title,
    description: input.description?.trim() ?? '',
    status: 'draft',
    projectRoot: input.projectRoot,
    createdAt: now,
    updatedAt: now,
  };

  const file = readDraftFile(input.projectRoot, { storageDir: input.storageDir });
  file.drafts = [draft, ...file.drafts.filter((existing) => existing.id !== draft.id)];
  writeDraftFile(input.projectRoot, file, { storageDir: input.storageDir });
  return draft;
}

export function getTaskDraftsFilePath(projectRoot: string, options: TaskDraftStoreOptions = {}): string {
  return join(resolveTaskStorageDir(projectRoot, options), 'drafts.json');
}

function readDraftFile(projectRoot: string, options: TaskDraftStoreOptions): TaskDraftFile {
  const filePath = getTaskDraftsFilePath(projectRoot, options);
  if (!existsSync(filePath)) {
    return { version: TASK_DRAFT_FILE_VERSION, drafts: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<TaskDraftFile>;
    return {
      version: TASK_DRAFT_FILE_VERSION,
      drafts: Array.isArray(parsed.drafts) ? parsed.drafts.filter(isTaskDraft) : [],
    };
  } catch {
    return { version: TASK_DRAFT_FILE_VERSION, drafts: [] };
  }
}

function writeDraftFile(projectRoot: string, file: TaskDraftFile, options: TaskDraftStoreOptions): void {
  const storageDir = resolveTaskStorageDir(projectRoot, options);
  const filePath = getTaskDraftsFilePath(projectRoot, options);
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

function resolveTaskStorageDir(projectRoot: string, options: TaskDraftStoreOptions): string {
  if (!options.storageDir) {
    throw new Error('Task draft storageDir is required.');
  }
  return options.storageDir;
}

function isTaskDraft(value: unknown): value is TaskDraft {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const draft = value as Partial<TaskDraft>;
  return (
    typeof draft.id === 'string' &&
    typeof draft.title === 'string' &&
    typeof draft.description === 'string' &&
    draft.status === 'draft' &&
    typeof draft.projectRoot === 'string' &&
    typeof draft.createdAt === 'string' &&
    typeof draft.updatedAt === 'string'
  );
}
