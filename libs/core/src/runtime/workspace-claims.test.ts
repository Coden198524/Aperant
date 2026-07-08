import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  acquireAutocodeRuntimeFileWriteLock,
  acquireAutocodeRuntimeFileWriteLockSync,
  AutocodeRuntimeWorkspaceClaimManager,
  releaseAutocodeRuntimeFileWriteLock,
} from './workspace-claims.js';

describe('AutocodeRuntimeWorkspaceClaimManager', () => {
  it('does not release matching task ids from other projects', () => {
    const manager = new AutocodeRuntimeWorkspaceClaimManager();

    const first = manager.tryClaim({
      taskId: '001-project-docs',
      projectId: 'project-a',
      projectRoot: '/repo/a',
      workspaceRoot: '/repo/a',
      fileIntents: ['docs/a.md'],
    });
    const second = manager.tryClaim({
      taskId: '001-project-docs',
      projectId: 'project-b',
      projectRoot: '/repo/b',
      workspaceRoot: '/repo/b',
      fileIntents: ['docs/b.md'],
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(manager.listClaims()).toHaveLength(2);

    manager.releaseByTask('001-project-docs', 'project-a');

    expect(manager.listClaims()).toMatchObject([
      { taskId: '001-project-docs', projectId: 'project-b' },
    ]);
  });
});

describe('Autocode runtime file write locks', () => {
  it('waits for a same-process async lock held by a different owner', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-file-lock-'));
    const filePath = join(projectRoot, 'implementation_plan.md');
    const firstLock = await acquireAutocodeRuntimeFileWriteLock({
      projectRoot,
      filePath,
      ownerId: 'first-owner',
      timeoutMs: 100,
      retryMs: 1,
    });

    try {
      const waitingLockPromise = acquireAutocodeRuntimeFileWriteLock({
        projectRoot,
        filePath,
        ownerId: 'second-owner',
        timeoutMs: 100,
        retryMs: 1,
      });

      await new Promise((resolve) => setTimeout(resolve, 5));
      releaseAutocodeRuntimeFileWriteLock(firstLock);

      const secondLock = await waitingLockPromise;
      try {
        expect(secondLock.ownerId).toBe('second-owner');
      } finally {
        releaseAutocodeRuntimeFileWriteLock(secondLock);
      }
    } finally {
      releaseAutocodeRuntimeFileWriteLock(firstLock);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('falls back to a temp lock root when project lock storage is not writable', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-file-lock-fallback-'));
    const dataDirName = '.autocode';
    writeFileSync(join(projectRoot, dataDirName), 'not a directory');
    const filePath = join(projectRoot, dataDirName, 'specs', '001-task', 'implementation_plan.md');
    let lock: ReturnType<typeof acquireAutocodeRuntimeFileWriteLockSync> | null = null;

    try {
      lock = acquireAutocodeRuntimeFileWriteLockSync({
        projectRoot,
        dataDirName,
        filePath,
        ownerId: 'fallback-owner',
        timeoutMs: 20,
        retryMs: 1,
      });

      expect(lock.lockDir).toContain(join(tmpdir(), 'autocode-runtime-file-write-locks'));
      expect(existsSync(join(lock.lockDir, 'metadata.json'))).toBe(true);
    } finally {
      if (lock) {
        const fallbackScopeDir = dirname(lock.lockDir);
        releaseAutocodeRuntimeFileWriteLock(lock);
        rmSync(fallbackScopeDir, { recursive: true, force: true });
      }
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
  it('rejects a same-owner async nested write lock immediately', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-file-lock-'));
    const filePath = join(projectRoot, 'implementation_plan.md');
    const firstLock = await acquireAutocodeRuntimeFileWriteLock({
      projectRoot,
      filePath,
      ownerId: 'same-owner',
      timeoutMs: 100,
      retryMs: 1,
    });

    try {
      const startedAt = Date.now();
      await expect(
        acquireAutocodeRuntimeFileWriteLock({
          projectRoot,
          filePath,
          ownerId: 'same-owner',
          timeoutMs: 100,
          retryMs: 10,
        }),
      ).rejects.toThrow(/already held by this process/);
      expect(Date.now() - startedAt).toBeLessThan(50);
    } finally {
      releaseAutocodeRuntimeFileWriteLock(firstLock);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
