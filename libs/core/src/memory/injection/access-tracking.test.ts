import { describe, expect, it, vi } from 'vitest';

import type { Memory } from '../types.js';
import { recordSelectedMemoryAccess } from './access-tracking.js';

function makeMemory(id: string): Memory {
  return {
    id,
    type: 'requirement',
    content: `Memory ${id}`,
    confidence: 0.9,
    tags: [],
    relatedFiles: [],
    relatedModules: [],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 0,
    scope: 'module',
    source: 'agent_explicit',
    sessionId: 'session-1',
    provenanceSessionIds: [],
    projectId: 'project-1',
  };
}

describe('recordSelectedMemoryAccess', () => {
  it('trims and deduplicates memory ids before recording access', async () => {
    const memoryService = {
      updateAccessCount: vi.fn().mockResolvedValue(undefined),
    };

    await recordSelectedMemoryAccess(memoryService, [
      makeMemory(' first '),
      makeMemory('first'),
      makeMemory('second'),
      makeMemory('   '),
    ]);

    expect(memoryService.updateAccessCount).toHaveBeenCalledTimes(2);
    expect(memoryService.updateAccessCount).toHaveBeenNthCalledWith(1, 'first');
    expect(memoryService.updateAccessCount).toHaveBeenNthCalledWith(
      2,
      'second',
    );
  });

  it('does not let access tracking failures block prompt construction', async () => {
    const memoryService = {
      updateAccessCount: vi
        .fn()
        .mockRejectedValueOnce(new Error('db busy'))
        .mockResolvedValueOnce(undefined),
    };

    await expect(
      recordSelectedMemoryAccess(memoryService, [
        makeMemory('fails'),
        makeMemory('succeeds'),
      ]),
    ).resolves.toBeUndefined();

    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('fails');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('succeeds');
  });
});
