/**
 * StepMemoryState Tests
 *
 * Tests recording, windowing, injection tracking, and reset.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StepMemoryState } from '../../injection/step-memory-state';

describe('StepMemoryState', () => {
  let state: StepMemoryState;

  beforeEach(() => {
    state = new StepMemoryState();
  });

  describe('recordToolCall()', () => {
    it('records a tool call and makes it retrievable', () => {
      state.recordToolCall('Read', { file_path: '/src/auth.ts' });
      const ctx = state.getRecentContext(5);
      expect(ctx.toolCalls).toHaveLength(1);
      expect(ctx.toolCalls[0].toolName).toBe('Read');
    });

    it('maintains rolling window of last 20 calls', () => {
      for (let i = 0; i < 25; i++) {
        state.recordToolCall('Bash', { command: `cmd-${i}` });
      }
      // getRecentContext(5) returns last 5, but internal buffer should be capped at 20
      const ctx = state.getRecentContext(20);
      expect(ctx.toolCalls).toHaveLength(20);
      // Last recorded should be cmd-24
      expect(ctx.toolCalls[ctx.toolCalls.length - 1].args.command).toBe('cmd-24');
    });

    it('drops oldest entry when buffer exceeds 20', () => {
      for (let i = 0; i < 21; i++) {
        state.recordToolCall('Read', { file_path: `/file-${i}.ts` });
      }
      const ctx = state.getRecentContext(20);
      // file-0 should have been dropped
      const paths = ctx.toolCalls.map((c) => c.args.file_path);
      expect(paths).not.toContain('/file-0.ts');
      expect(paths).toContain('/file-20.ts');
    });

    it('stores only compact memory-relevant tool arguments', () => {
      const longCommand = `npm test ${'--workspace apps/desktop '.repeat(30)}FINAL_COMMAND_TAIL`;
      state.recordToolCall('Write', {
        file_path: '/src/generated.ts',
        content: 'x'.repeat(5_000),
        old_string: 'old'.repeat(1_000),
        new_string: 'new'.repeat(1_000),
        command: longCommand,
        unexpected_payload: 'should not be retained',
      });

      const args = state.getRecentContext(1).toolCalls[0].args;
      expect(args.file_path).toBe('/src/generated.ts');
      expect(args).not.toHaveProperty('content');
      expect(args).not.toHaveProperty('old_string');
      expect(args).not.toHaveProperty('new_string');
      expect(args).not.toHaveProperty('unexpected_payload');
      expect(String(args.command)).toHaveLength(240);
      expect(String(args.command)).toContain('middle omitted');
      expect(String(args.command)).toContain('FINAL_COMMAND_TAIL');
    });
  });

  describe('getRecentContext()', () => {
    it('defaults to window size of 5', () => {
      for (let i = 0; i < 10; i++) {
        state.recordToolCall('Read', { file_path: `/file-${i}.ts` });
      }
      const ctx = state.getRecentContext();
      expect(ctx.toolCalls).toHaveLength(5);
    });

    it('respects custom window size', () => {
      for (let i = 0; i < 10; i++) {
        state.recordToolCall('Read', { file_path: `/file-${i}.ts` });
      }
      const ctx = state.getRecentContext(3);
      expect(ctx.toolCalls).toHaveLength(3);
    });

    it('deduplicates repeated tool calls while keeping the newest unique context', () => {
      state.recordToolCall('Read', { file_path: '/src/auth.ts' });
      state.recordToolCall('Read', { file_path: '/src/auth.ts' });
      state.recordToolCall('Grep', { pattern: 'refreshToken' });
      state.recordToolCall('Grep', { pattern: 'refreshToken' });
      state.recordToolCall('Edit', { file_path: '/src/auth.ts' });

      const ctx = state.getRecentContext(5);

      expect(ctx.toolCalls).toEqual([
        { toolName: 'Read', args: { file_path: '/src/auth.ts' } },
        { toolName: 'Grep', args: { pattern: 'refreshToken' } },
        { toolName: 'Edit', args: { file_path: '/src/auth.ts' } },
      ]);
    });

    it('uses normalized compact args for dedupe signatures', () => {
      state.recordToolCall('Read', {
        file_path: '/src/auth.ts',
        content: 'first ignored payload',
      });
      state.recordToolCall('Read', {
        content: 'second ignored payload',
        file_path: '/src/auth.ts',
      });

      const ctx = state.getRecentContext(5);

      expect(ctx.toolCalls).toHaveLength(1);
      expect(ctx.toolCalls[0].args).toEqual({ file_path: '/src/auth.ts' });
    });

    it('normalizes equivalent file paths before recent-context dedupe', () => {
      state.recordToolCall('Read', { file_path: ' src\\auth\\token.ts ' });
      state.recordToolCall('Read', { file_path: 'src/auth//token.ts' });

      const ctx = state.getRecentContext(5);

      expect(ctx.toolCalls).toEqual([
        { toolName: 'Read', args: { file_path: 'src/auth/token.ts' } },
      ]);
    });

    it('trims search patterns before recent-context dedupe', () => {
      state.recordToolCall('Grep', { pattern: ' useCallback ' });
      state.recordToolCall('Grep', { pattern: 'useCallback' });
      state.recordToolCall('Glob', { glob: ' auth-refresh ' });
      state.recordToolCall('Glob', { glob: 'auth-refresh' });

      const ctx = state.getRecentContext(5);

      expect(ctx.toolCalls).toEqual([
        { toolName: 'Grep', args: { pattern: 'useCallback' } },
        { toolName: 'Glob', args: { glob: 'auth-refresh' } },
      ]);
    });

    it('returns fewer entries if fewer have been recorded', () => {
      state.recordToolCall('Read', { file_path: '/a.ts' });
      state.recordToolCall('Read', { file_path: '/b.ts' });
      const ctx = state.getRecentContext(5);
      expect(ctx.toolCalls).toHaveLength(2);
    });

    it('returns the injectedMemoryIds set', () => {
      state.markInjected(['id-a', 'id-b']);
      const ctx = state.getRecentContext();
      expect(ctx.injectedMemoryIds.has('id-a')).toBe(true);
      expect(ctx.injectedMemoryIds.has('id-b')).toBe(true);
    });

    it('returns injectedMemoryIds as a snapshot', () => {
      state.markInjected(['id-a']);
      const ctx = state.getRecentContext();
      ctx.injectedMemoryIds.add('external-mutation');

      expect(state.getRecentContext().injectedMemoryIds.has('external-mutation')).toBe(false);
    });
  });

  describe('markInjected()', () => {
    it('tracks injected memory IDs', () => {
      state.markInjected(['mem-1', 'mem-2']);
      const ctx = state.getRecentContext();
      expect(ctx.injectedMemoryIds.size).toBe(2);
    });

    it('accumulates IDs across multiple calls', () => {
      state.markInjected(['mem-1']);
      state.markInjected(['mem-2', 'mem-3']);
      const ctx = state.getRecentContext();
      expect(ctx.injectedMemoryIds.size).toBe(3);
    });

    it('deduplicates IDs', () => {
      state.markInjected(['mem-1', 'mem-1', 'mem-2']);
      const ctx = state.getRecentContext();
      expect(ctx.injectedMemoryIds.size).toBe(2);
    });

    it('trims, filters blank IDs, and bounds the injected ID set', () => {
      state.markInjected([
        ' ',
        ' mem-existing ',
        ...Array.from({ length: 130 }, (_, index) => `mem-${index}`),
      ]);
      const ctx = state.getRecentContext();

      expect(ctx.injectedMemoryIds.size).toBe(128);
      expect(ctx.injectedMemoryIds.has('mem-existing')).toBe(false);
      expect(ctx.injectedMemoryIds.has('mem-0')).toBe(false);
      expect(ctx.injectedMemoryIds.has('mem-2')).toBe(true);
      expect(ctx.injectedMemoryIds.has('mem-129')).toBe(true);
      expect(ctx.injectedMemoryIds.has('')).toBe(false);
    });
  });

  describe('reset()', () => {
    it('clears all tool calls', () => {
      state.recordToolCall('Read', { file_path: '/a.ts' });
      state.reset();
      const ctx = state.getRecentContext();
      expect(ctx.toolCalls).toHaveLength(0);
    });

    it('clears all injected IDs', () => {
      state.markInjected(['mem-1', 'mem-2']);
      state.reset();
      const ctx = state.getRecentContext();
      expect(ctx.injectedMemoryIds.size).toBe(0);
    });

    it('allows fresh recording after reset', () => {
      state.recordToolCall('Read', { file_path: '/a.ts' });
      state.reset();
      state.recordToolCall('Write', { file_path: '/b.ts' });
      const ctx = state.getRecentContext();
      expect(ctx.toolCalls).toHaveLength(1);
      expect(ctx.toolCalls[0].toolName).toBe('Write');
    });
  });
});
