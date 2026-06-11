import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';

import type { WebProject } from '../shared/api.js';

interface ProjectStoreFile {
  version: 1;
  projects: WebProject[];
}

export class WebProjectStore {
  constructor(
    private readonly dataDir: string,
    private readonly storeFile = 'projects.json',
  ) {}

  getDataDir(): string {
    return this.dataDir;
  }

  private get storePath(): string {
    return resolve(this.dataDir, this.storeFile);
  }

  async listProjects(): Promise<WebProject[]> {
    return (await this.readStore()).projects;
  }

  async upsertProject(projectPath: string): Promise<WebProject> {
    const normalizedPath = resolve(projectPath);
    const store = await this.readStore();
    const id = createProjectId(normalizedPath);
    const existing = store.projects.find((project) => project.id === id);
    const now = new Date().toISOString();

    if (existing) {
      existing.name = basename(normalizedPath);
      existing.path = normalizedPath;
      existing.updatedAt = now;
      await this.writeStore(store);
      return existing;
    }

    const project: WebProject = {
      id,
      name: basename(normalizedPath),
      path: normalizedPath,
      addedAt: now,
      updatedAt: now,
    };
    store.projects.unshift(project);
    await this.writeStore(store);
    return project;
  }

  async getProject(projectId: string): Promise<WebProject | null> {
    const store = await this.readStore();
    return store.projects.find((project) => project.id === projectId) ?? null;
  }

  async removeProject(projectId: string): Promise<boolean> {
    const store = await this.readStore();
    const nextProjects = store.projects.filter((project) => project.id !== projectId);
    if (nextProjects.length === store.projects.length) return false;

    await this.writeStore({
      ...store,
      projects: nextProjects,
    });
    return true;
  }

  async updateProject(project: WebProject): Promise<WebProject> {
    const store = await this.readStore();
    const index = store.projects.findIndex((candidate) => candidate.id === project.id);
    const nextProject = {
      ...project,
      updatedAt: new Date().toISOString(),
    };

    if (index >= 0) {
      store.projects[index] = nextProject;
    } else {
      store.projects.unshift(nextProject);
    }

    await this.writeStore(store);
    return nextProject;
  }

  private async readStore(): Promise<ProjectStoreFile> {
    try {
      const raw = JSON.parse(await readFile(this.storePath, 'utf-8')) as ProjectStoreFile;
      if (raw.version === 1 && Array.isArray(raw.projects)) {
        return raw;
      }
    } catch {
      // Fall through to a fresh store when the file does not exist or is malformed.
    }

    return {
      version: 1,
      projects: [],
    };
  }

  private async writeStore(store: ProjectStoreFile): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  }
}

export function getDefaultWebDataDir(): string {
  if (process.env.AUTOCODE_WEB_DATA_DIR) {
    return resolve(process.env.AUTOCODE_WEB_DATA_DIR);
  }

  const baseDir = process.env.LOCALAPPDATA
    ?? process.env.APPDATA
    ?? homedir();
  return resolve(baseDir, 'Autocode', 'web-platform');
}

function createProjectId(projectPath: string): string {
  const normalized = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}
