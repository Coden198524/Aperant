import type { Memory, MemoryService } from '../types.js';

export async function recordSelectedMemoryAccess(
  memoryService: Pick<MemoryService, 'updateAccessCount'>,
  memories: readonly Memory[],
): Promise<void> {
  const ids = uniqueMemoryIds(memories);
  await Promise.all(
    ids.map(async (id) => {
      try {
        await memoryService.updateAccessCount(id);
      } catch {
        // Access feedback should never block prompt construction.
      }
    }),
  );
}

function uniqueMemoryIds(memories: readonly Memory[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const memory of memories) {
    const id = memory.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
