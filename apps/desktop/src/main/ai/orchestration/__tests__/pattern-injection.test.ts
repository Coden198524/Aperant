import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Memory, MemoryService } from '@autocode/core';

import {
  PATTERN_INJECTION_PATTERN_FILES_MAX,
  PATTERN_INJECTION_PATTERNS_MAX,
  enhanceCoderPrompt,
} from '../pattern-injection';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'memory-1',
    type: 'pattern',
    content: 'Trusted success pattern should remain.',
    confidence: 0.9,
    tags: ['subtask:1.1'],
    relatedFiles: [],
    relatedModules: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastAccessedAt: '2026-01-01T00:00:00.000Z',
    accessCount: 0,
    scope: 'module',
    source: 'agent_explicit',
    sessionId: 'session-1',
    provenanceSessionIds: [],
    projectId: 'project-1',
    ...overrides,
  };
}

describe('pattern injection memory success cases', () => {
  it('filters low-quality success case memories before prompt injection', async () => {
    const memoryService = {
      search: vi.fn().mockResolvedValue([
        makeMemory({ id: 'good', content: 'Trusted success pattern should remain.' }),
        makeMemory({
          id: 'noisy',
          content: [
            'npm run typecheck passed.',
            'Mock the OAuth clock before testing refresh retries.',
            'No issues found.',
            'Completed at: 2026-06-15T00:00:00.000Z',
          ].join('\n'),
          tags: ['subtask:1.9'],
        }),
        makeMemory({ id: 'low', content: 'Low confidence pattern should be hidden.', confidence: 0.2 }),
        makeMemory({ id: 'review', content: 'Pending review pattern should be hidden.', needsReview: true }),
        makeMemory({
          id: 'stale',
          content: 'Stale pattern should be hidden.',
          staleAt: '2000-01-01T00:00:00.000Z',
        }),
        makeMemory({
          id: 'verified',
          content: 'Verified low confidence pattern should remain.',
          confidence: 0.2,
          userVerified: true,
        }),
      ]),
      updateAccessCount: vi.fn().mockResolvedValue(undefined),
    } as unknown as MemoryService;

    const result = await enhanceCoderPrompt('Base prompt\n\n## STEP 6: IMPLEMENT THE SUBTASK', {
      subtask: {
        id: '1.2',
        description: 'Update auth flow',
        patternFiles: [],
      },
      projectDir: 'E:/project',
      specDir: 'E:/spec',
      memoryService,
    });

    expect(memoryService.search).toHaveBeenCalledWith(expect.objectContaining({
      excludeDeprecated: true,
      limit: 8,
      promptContextOnly: true,
      recordAccess: false,
      types: ['pattern'],
    }));
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('good');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('noisy');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('verified');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('low');
    expect(result.enhancedPrompt).toContain('Trusted success pattern should remain.');
    expect(result.enhancedPrompt).toContain('Mock the OAuth clock before testing refresh retries.');
    expect(result.enhancedPrompt).toContain('Verified low confidence pattern should remain.');
    expect(result.enhancedPrompt).not.toContain('npm run typecheck passed');
    expect(result.enhancedPrompt).not.toContain('No issues found');
    expect(result.enhancedPrompt).not.toContain('Completed at:');
    expect(result.enhancedPrompt).not.toContain('Low confidence pattern should be hidden.');
    expect(result.enhancedPrompt).not.toContain('Pending review pattern should be hidden.');
    expect(result.enhancedPrompt).not.toContain('Stale pattern should be hidden.');
    expect(result.successCases).toHaveLength(3);
  });

  it('skips memory tool echo responses instead of falling back to the current subtask', async () => {
    const memoryService = {
      search: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'echo',
          content: 'Memory search unavailable; inspect focused files next.',
          tags: ['subtask:echo'],
        }),
        makeMemory({
          id: 'useful',
          content: 'Cache refresh tests should freeze the retry clock.',
          tags: ['subtask:useful'],
        }),
      ]),
      updateAccessCount: vi.fn().mockResolvedValue(undefined),
    } as unknown as MemoryService;

    const result = await enhanceCoderPrompt('Base prompt\n\n## STEP 6: IMPLEMENT THE SUBTASK', {
      subtask: {
        id: '2.0',
        description: 'Retry checkout flow',
        patternFiles: [],
      },
      projectDir: 'E:/project',
      specDir: 'E:/spec',
      memoryService,
    });

    expect(result.successCases).toHaveLength(1);
    expect(result.successCases[0].subtaskId).toBe('useful');
    expect(result.enhancedPrompt).toContain('Cache refresh tests should freeze the retry clock.');
    expect(result.enhancedPrompt).not.toContain('Memory search unavailable');
    expect(result.enhancedPrompt).not.toContain('Retry checkout flow');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('echo');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('useful');
  });

  it('compacts long success case memories before injecting them into the prompt', async () => {
    const longContent = [
      'Use a shared settings writer for app and workspace updates.',
      'This detail should be useful. '.repeat(80),
      'SUCCESS_CASE_TAIL_OK',
    ].join('\n');
    const memoryService = {
      search: vi.fn().mockResolvedValue([
        makeMemory({ id: 'long', content: longContent }),
      ]),
    } as unknown as MemoryService;

    const result = await enhanceCoderPrompt('Base prompt\n\n## STEP 6: IMPLEMENT THE SUBTASK', {
      subtask: {
        id: '2.1',
        description: 'Centralize settings updates',
        patternFiles: [],
      },
      projectDir: 'E:/project',
      specDir: 'E:/spec',
      memoryService,
    });

    expect(result.successCases).toHaveLength(1);
    expect(result.successCases[0].description).toBe('Use a shared settings writer for app and workspace updates.');
    expect(result.successCases[0].implementation.length).toBeLessThanOrEqual(420);
    expect(result.successCases[0].implementation).toContain('SUCCESS_CASE_TAIL_OK');
    expect(result.enhancedPrompt).toContain('Use a shared settings writer for app and workspace updates.');
    expect(result.enhancedPrompt).toContain('truncated');
    expect(result.enhancedPrompt).toContain('SUCCESS_CASE_TAIL_OK');
  });

  it('samples pattern files and injected patterns from the head and tail', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'pattern-injection-project-'));
    try {
      const patternFiles = Array.from({ length: PATTERN_INJECTION_PATTERN_FILES_MAX + 2 }, (_, index) => `pattern-${index + 1}.ts`);
      for (let index = 0; index < patternFiles.length; index++) {
        await writeFile(
          join(projectDir, patternFiles[index]),
          [
            `import { value${index + 1} } from './dep-${index + 1}';`,
            `interface Pattern${index + 1} {`,
            `  marker: 'PATTERN_FILE_${index + 1}';`,
            '  enabled: boolean;',
            '  description: string;',
            '}',
            `export function pattern${index + 1}() {`,
            `  return { success: true, data: 'PATTERN_FILE_${index + 1}' };`,
            '}',
          ].join('\n'),
          'utf-8',
        );
      }

      const result = await enhanceCoderPrompt('Base prompt\n\n## STEP 6: IMPLEMENT THE SUBTASK', {
        subtask: {
          id: '3.1',
          description: 'Follow local pattern files',
          patternFiles,
        },
        projectDir,
        specDir: 'E:/spec',
      });

      expect(result.patterns.length).toBeLessThanOrEqual(PATTERN_INJECTION_PATTERNS_MAX);
      expect(result.enhancedPrompt).toContain('PATTERN_FILE_1');
      expect(result.enhancedPrompt).toContain(`PATTERN_FILE_${patternFiles.length}`);
      expect(result.enhancedPrompt).not.toContain(`PATTERN_FILE_${PATTERN_INJECTION_PATTERN_FILES_MAX}`);
      expect(result.enhancedPrompt).not.toContain(`PATTERN_FILE_${PATTERN_INJECTION_PATTERN_FILES_MAX + 1}`);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
