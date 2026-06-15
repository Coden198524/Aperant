import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PRE_IMPLEMENTATION_CHECKLIST_TEXT_MAX_CHARS,
  PRE_IMPLEMENTATION_GOTCHA_ITEMS_MAX,
  formatCompactChecklistForPrompt,
  generatePreImplementationChecklist,
  type PreImplementationChecklist,
} from '../pre-implementation-checklist';
import type { Memory, MemoryService } from '@autocode/core';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'memory-1',
    type: 'gotcha',
    content: 'Trusted historical failure should remain.',
    confidence: 0.9,
    tags: [],
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

describe('pre-implementation checklist formatting', () => {
  it('keeps prompt guidance compact and focused on high-risk items', () => {
    const checklist: PreImplementationChecklist = {
      subtaskId: '1.1',
      riskLevel: 'high',
      generatedAt: '2026-06-05T00:00:00.000Z',
      filesToReview: ['src/api.ts', 'src/api.test.ts', 'src/schema.ts', 'src/extra.ts'],
      items: [
        {
          category: 'security',
          priority: 'critical',
          issue: 'Missing input validation',
          prevention: 'Validate all user input at the IPC boundary.',
          likelihood: 0.8,
        },
        {
          category: 'file_type',
          priority: 'high',
          issue: 'Type errors',
          prevention: 'Run the project typecheck after edits.',
          likelihood: 0.7,
        },
        {
          category: 'performance',
          priority: 'medium',
          issue: 'Extra re-render',
          prevention: 'Memoize expensive selectors.',
          likelihood: 0.4,
        },
      ],
    };

    const prompt = formatCompactChecklistForPrompt(checklist);

    expect(prompt).toContain('Missing input validation');
    expect(prompt).toContain('Type errors');
    expect(prompt).not.toContain('Extra re-render');
    expect(prompt).toContain('src/api.ts, src/api.test.ts, src/schema.ts');
    expect(prompt).not.toContain('src/extra.ts');
    expect(prompt.length).toBeLessThan(500);
  });

  it('filters low-quality historical memories before creating prompt checklist items', async () => {
    const memoryService = {
      search: vi.fn().mockResolvedValue([
        makeMemory({ id: 'good', content: 'Trusted historical failure should remain.' }),
        makeMemory({ id: 'low', content: 'Low confidence failure should be hidden.', confidence: 0.2 }),
        makeMemory({ id: 'review', content: 'Pending review failure should be hidden.', needsReview: true }),
        makeMemory({
          id: 'stale',
          content: 'Stale failure should be hidden.',
          staleAt: '2000-01-01T00:00:00.000Z',
        }),
        makeMemory({
          id: 'verified',
          content: 'Verified low confidence failure should remain.',
          confidence: 0.2,
          userVerified: true,
        }),
      ]),
      updateAccessCount: vi.fn().mockResolvedValue(undefined),
    } as unknown as MemoryService;

    const checklist = await generatePreImplementationChecklist({
      subtask: {
        id: '1.1',
        description: 'Update auth flow',
        filesToModify: [],
        filesToCreate: [],
      },
      specDir: 'E:/spec',
      projectDir: 'E:/project',
      memoryService,
    });

    const issues = checklist.items.map((item) => item.issue).join('\n');
    expect(memoryService.search).toHaveBeenCalledWith(expect.objectContaining({
      excludeDeprecated: true,
      limit: 10,
      promptContextOnly: true,
    }));
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('good');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('verified');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('low');
    expect(issues).toContain('Trusted historical failure should remain.');
    expect(issues).toContain('Verified low confidence failure should remain.');
    expect(issues).not.toContain('Low confidence failure should be hidden.');
    expect(issues).not.toContain('Pending review failure should be hidden.');
    expect(issues).not.toContain('Stale failure should be hidden.');
  });

  it('keeps long historical memory content compact in prompt checklist output', async () => {
    const memoryService = {
      search: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'long',
          content: [
            'Remember to validate the workspace settings write path.',
            'Verbose incident detail '.repeat(90),
            'MEMORY_TAIL_OK',
          ].join('\n'),
        }),
      ]),
    } as unknown as MemoryService;

    const checklist = await generatePreImplementationChecklist({
      subtask: {
        id: '1.2',
        description: 'Update settings persistence',
        filesToModify: [],
        filesToCreate: [],
      },
      specDir: 'E:/spec',
      projectDir: 'E:/project',
      memoryService,
    });

    const prompt = formatCompactChecklistForPrompt(checklist);
    const historicalItem = checklist.items.find((item) => item.category === 'historical_failure');

    expect(historicalItem?.issue.length).toBeLessThanOrEqual(PRE_IMPLEMENTATION_CHECKLIST_TEXT_MAX_CHARS);
    expect(historicalItem?.issue).toContain('MEMORY_TAIL_OK');
    expect(prompt).toContain('Remember to validate the workspace settings write path.');
    expect(prompt).toContain('checklist middle omitted');
    expect(prompt).toContain('MEMORY_TAIL_OK');
    expect(prompt.length).toBeLessThan(700);
  });

  it('caps project gotchas items and text during checklist generation', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'pre-implementation-spec-'));
    try {
      const memoryDir = join(specDir, 'memory');
      await mkdir(memoryDir, { recursive: true });
      const gotchas = Array.from({ length: PRE_IMPLEMENTATION_GOTCHA_ITEMS_MAX + 4 }, (_, index) =>
        `- Gotcha ${index + 1}: ${'detail '.repeat(80)}TAIL_${index + 1}`
      ).join('\n');
      await writeFile(join(memoryDir, 'gotchas.md'), gotchas, 'utf-8');

      const checklist = await generatePreImplementationChecklist({
        subtask: {
          id: '1.3',
          description: 'Small implementation',
          filesToModify: [],
          filesToCreate: [],
        },
        specDir,
        projectDir: 'E:/project',
      });

      const gotchaItems = checklist.items.filter((item) => item.category === 'gotcha');
      const gotchaText = gotchaItems.map((item) => item.issue).join('\n');

      expect(gotchaItems).toHaveLength(PRE_IMPLEMENTATION_GOTCHA_ITEMS_MAX);
      expect(gotchaItems.every((item) => item.issue.length <= PRE_IMPLEMENTATION_CHECKLIST_TEXT_MAX_CHARS)).toBe(true);
      expect(gotchaText).toContain('Gotcha 1');
      expect(gotchaText).not.toContain(`Gotcha ${PRE_IMPLEMENTATION_GOTCHA_ITEMS_MAX + 1}`);
      expect(gotchaText).toContain('TAIL_1');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });
});
