import { describe, expect, it } from 'vitest';

import { OpenSpecLockManager } from './openspec-lock-manager';

describe('OpenSpecLockManager', () => {
  it('serializes Actions for the same change', async () => {
    const locks = new OpenSpecLockManager();
    const releaseFirst = await locks.acquireForAction({
      rootKey: '/repo',
      changeName: 'change-a',
      action: 'apply',
      owner: 'run-a',
    });
    let secondAcquired = false;
    const second = locks.acquireForAction({
      rootKey: '/repo',
      changeName: 'change-a',
      action: 'update',
      owner: 'run-b',
    }).then((release) => {
      secondAcquired = true;
      return release;
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });

  it('allows different changes concurrently and makes archive wait for every root reader', async () => {
    const locks = new OpenSpecLockManager();
    const releaseA = await locks.acquireForAction({
      rootKey: '/repo',
      changeName: 'change-a',
      action: 'apply',
      owner: 'run-a',
    });
    const releaseB = await locks.acquireForAction({
      rootKey: '/repo',
      changeName: 'change-b',
      action: 'apply',
      owner: 'run-b',
    });
    expect(locks.getOwner('root:/repo')).toBe('run-a,run-b');

    let archiveAcquired = false;
    const archive = locks.acquireForAction({
      rootKey: '/repo',
      changeName: 'change-a',
      action: 'archive',
      owner: 'archive-a',
    }).then((release) => {
      archiveAcquired = true;
      return release;
    });
    await Promise.resolve();
    expect(archiveAcquired).toBe(false);

    releaseA();
    await Promise.resolve();
    expect(archiveAcquired).toBe(false);
    releaseB();

    const releaseArchive = await archive;
    expect(locks.getOwner('root:/repo')).toBe('archive-a');
    releaseArchive();
    expect(locks.getOwner('root:/repo')).toBeNull();
  });

  it('runs Update under an exclusive root lock for complete change capture', async () => {
    const locks = new OpenSpecLockManager();
    const releaseApply = await locks.acquireForAction({
      rootKey: '/repo',
      changeName: 'change-a',
      action: 'apply',
      owner: 'apply-a',
    });
    let updateAcquired = false;
    const pendingUpdate = locks.acquireForAction({
      rootKey: '/repo',
      changeName: 'change-b',
      action: 'update',
      owner: 'update-b',
    }).then((release) => {
      updateAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(updateAcquired).toBe(false);
    releaseApply();

    const releaseUpdate = await pendingUpdate;
    expect(updateAcquired).toBe(true);
    expect(locks.getOwner('root:/repo')).toBe('update-b');
    releaseUpdate();
  });

  it('does not let new root readers jump ahead of a queued destructive Action', async () => {
    const locks = new OpenSpecLockManager();
    const releaseA = await locks.acquireForAction({
      rootKey: '/repo',
      changeName: 'change-a',
      action: 'apply',
      owner: 'run-a',
    });
    const order: string[] = [];
    const archive = locks.acquireForAction({
      rootKey: '/repo',
      changeName: 'change-a',
      action: 'archive',
      owner: 'archive',
    }).then((release) => {
      order.push('archive');
      return release;
    });
    const applyB = locks.acquireForAction({
      rootKey: '/repo',
      changeName: 'change-b',
      action: 'apply',
      owner: 'run-b',
    }).then((release) => {
      order.push('apply-b');
      return release;
    });

    releaseA();
    const releaseArchive = await archive;
    expect(order).toEqual(['archive']);
    releaseArchive();
    const releaseB = await applyB;
    expect(order).toEqual(['archive', 'apply-b']);
    releaseB();
  });

  it('cancels queued acquisition', async () => {
    const locks = new OpenSpecLockManager();
    const release = await locks.acquireForAction({
      rootKey: '/repo',
      changeName: 'change-a',
      action: 'apply',
      owner: 'run-a',
    });
    const controller = new AbortController();
    const pending = locks.acquireForAction({
      rootKey: '/repo',
      changeName: 'change-a',
      action: 'apply',
      owner: 'run-b',
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    release();
  });
});
