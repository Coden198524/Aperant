import { describe, expect, it } from 'vitest';

import { MIN_PACKED_MEMORY_CONFIDENCE, packContext } from './context-packer.js';
import type { Memory } from '../types.js';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-001',
    type: 'gotcha',
    content: 'Always preserve packaged Electron resource paths before moving files.',
    confidence: 0.9,
    tags: ['electron'],
    relatedFiles: ['src/main/resources.ts'],
    relatedModules: ['desktop'],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 1,
    scope: 'global',
    source: 'agent_explicit',
    sessionId: 'session-001',
    provenanceSessionIds: [],
    projectId: 'project-001',
    ...overrides,
  };
}

describe('packContext memory quality gate', () => {
  it('filters untrusted memories before packing context', () => {
    const result = packContext([
      makeMemory({ id: 'good', content: 'Trusted packaged path pattern.' }),
      makeMemory({ id: 'deprecated', content: 'Deprecated memory should not appear.', deprecated: true }),
      makeMemory({ id: 'review', content: 'Pending review memory should not appear.', needsReview: true }),
      makeMemory({
        id: 'stale',
        content: 'Stale memory should not appear.',
        staleAt: '2000-01-01T00:00:00.000Z',
      }),
      makeMemory({
        id: 'low-confidence',
        content: 'Low confidence memory should not appear.',
        confidence: MIN_PACKED_MEMORY_CONFIDENCE - 0.01,
      }),
    ], 'implement');

    expect(result).toContain('Trusted packaged path pattern.');
    expect(result).not.toContain('Deprecated memory should not appear.');
    expect(result).not.toContain('Pending review memory should not appear.');
    expect(result).not.toContain('Stale memory should not appear.');
    expect(result).not.toContain('Low confidence memory should not appear.');
  });

  it('keeps pinned or user-verified memories even when they need review or are low confidence', () => {
    const result = packContext([
      makeMemory({
        id: 'verified',
        content: 'Verified review memory can guide future work.',
        confidence: 0.2,
        needsReview: true,
        userVerified: true,
      }),
      makeMemory({
        id: 'pinned',
        content: 'Pinned stale memory can guide future work.',
        confidence: 0.2,
        staleAt: '2000-01-01T00:00:00.000Z',
        pinned: true,
      }),
    ], 'implement');

    expect(result).toContain('Verified review memory can guide future work.');
    expect(result).toContain('Pinned stale memory can guide future work.');
  });

  it('skips oversized memories and still packs later concise memories', () => {
    const result = packContext([
      makeMemory({
        id: 'oversized',
        content: 'Oversized memory should not block smaller relevant memory. '.repeat(80),
        relatedFiles: ['src/very/deep/path/that/also/adds/metadata/to/the/formatted/memory.ts'],
        citationText: 'large citation '.repeat(40),
      }),
      makeMemory({
        id: 'concise',
        content: 'Concise retry gotcha fits the tight budget.',
      }),
    ], 'implement', {
      totalBudget: 45,
      allocation: { gotcha: 1 },
    });

    expect(result).toContain('Concise retry gotcha fits the tight budget.');
    expect(result).not.toContain('Oversized memory should not block');
  });

  it('preserves tail lessons when packing long memory content', () => {
    const result = packContext([
      makeMemory({
        id: 'tail-lesson',
        content: `Start with the failing settings save path. ${'verbose diagnostic detail '.repeat(80)} FINAL_MEMORY_LESSON_TAIL_OK`,
        relatedFiles: [`src/${'nested/'.repeat(20)}settings-store.ts`],
        citationText: `Investigation began with noisy logs. ${'more citation detail '.repeat(20)} FINAL_CITATION_TAIL_OK`,
      }),
    ], 'implement');

    expect(result).toContain('Start with the failing settings save path');
    expect(result).toContain('memory middle omitted');
    expect(result).toContain('FINAL_MEMORY_LESSON_TAIL_OK');
    expect(result).toContain('settings-store.ts');
    expect(result).toContain('FINAL_CITATION_TAIL_OK');
  });

  it('deduplicates repeated memory content across memory types', () => {
    const repeated = 'Check settings save failures against userData settings path permissions first.';
    const result = packContext([
      makeMemory({ id: 'gotcha-duplicate', type: 'gotcha', content: repeated }),
      makeMemory({ id: 'error-pattern-duplicate', type: 'error_pattern', content: repeated }),
    ], 'implement');

    expect(result).toContain('Gotcha');
    expect(result).not.toContain('Error Pattern');
    expect((result.match(/settings save failures/g) ?? []).length).toBe(1);
  });

  it('deduplicates similar Chinese memory content without relying on whitespace tokenization', () => {
    const result = packContext([
      makeMemory({
        id: 'zh-gotcha',
        type: 'gotcha',
        content: '设置页面保存失败时，先检查 userData/settings.json 权限和写入路径。',
      }),
      makeMemory({
        id: 'zh-error',
        type: 'error_pattern',
        content: '设置页面保存失败时先检查 userData/settings.json 权限和写入路径',
      }),
    ], 'implement');

    expect(result).toContain('设置页面保存失败时');
    expect(result).toContain('Gotcha');
    expect(result).not.toContain('Error Pattern');
    expect((result.match(/设置页面保存失败时/g) ?? []).length).toBe(1);
  });
});
