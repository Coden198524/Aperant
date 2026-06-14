import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildTaskContext,
  SERVICE_CONTEXT_MAX_CHARS,
} from './builder';

describe('context builder', () => {
  it('skips service paths that resolve outside the project root', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'autocode-context-path-scope-'));
    const projectDir = join(rootDir, 'project');
    const outsideDir = join(rootDir, 'outside');

    try {
      const dataDir = join(projectDir, '.autocode');
      const safeDir = join(projectDir, 'src');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(safeDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(
        join(dataDir, 'project_index.json'),
        JSON.stringify({
          services: {
            safe: {
              type: 'backend',
              path: 'src',
            },
            outside: {
              type: 'backend',
              path: '../outside',
            },
          },
        }),
        'utf8',
      );
      writeFileSync(
        join(safeDir, 'memory-safe.ts'),
        'export const memorySafe = "memory safe implementation";\n',
        'utf8',
      );
      writeFileSync(
        join(outsideDir, 'memory-outside.ts'),
        'export const memoryOutside = "memory outside implementation";\n',
        'utf8',
      );

      const context = await buildTaskContext({
        taskDescription: 'Update memory implementation',
        projectDir,
        services: ['safe', 'outside'],
        keywords: ['memory'],
        includeGraphHints: false,
      });

      const contextFiles = [
        ...context.filesToModify,
        ...context.filesToReference,
      ].map((file) => file.path.replace(/\\/g, '/'));
      expect(context.scopedServices).toEqual(['safe']);
      expect(contextFiles).toContain('src/memory-safe.ts');
      expect(contextFiles).not.toContain('../outside/memory-outside.ts');
      expect(context.serviceContexts.outside).toBeUndefined();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('loads the project index to scope context searches to relevant services', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'autocode-context-index-'));

    try {
      const dataDir = join(projectDir, '.autocode');
      const rendererDir = join(projectDir, 'apps', 'renderer');
      const serverDir = join(projectDir, 'apps', 'server');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(rendererDir, { recursive: true });
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(
        join(dataDir, 'project_index.json'),
        JSON.stringify({
          services: {
            renderer: {
              type: 'frontend',
              path: 'apps/renderer',
              framework: 'react',
            },
            server: {
              type: 'backend',
              path: 'apps/server',
              framework: 'express',
            },
          },
        }),
        'utf8',
      );
      writeFileSync(
        join(rendererDir, 'MemoryPanel.tsx'),
        'export function MemoryPanel() { return "memory renderer UI"; }\n',
        'utf8',
      );
      writeFileSync(
        join(serverDir, 'memory-route.ts'),
        'export function memoryRoute() { return "memory server route"; }\n',
        'utf8',
      );

      const context = await buildTaskContext({
        taskDescription: 'Update the renderer UI component for memory context.',
        projectDir,
        keywords: ['memory'],
        includeGraphHints: false,
      });

      const contextFiles = [
        ...context.filesToModify,
        ...context.filesToReference,
      ].map((file) => file.path);
      expect(context.scopedServices).toEqual(['renderer']);
      expect(contextFiles).toContain('apps\\renderer\\MemoryPanel.tsx');
      expect(contextFiles).not.toContain('apps\\server\\memory-route.ts');
      expect(context.serviceContexts.renderer).toEqual(expect.objectContaining({
        source: 'generated',
        framework: 'react',
        type: 'frontend',
      }));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps service context compact while preserving the tail of long context files', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'autocode-context-builder-'));

    try {
      writeFileSync(
        join(projectDir, 'SERVICE_CONTEXT.md'),
        [
          '# Main Service',
          '',
          'Service context head explains architecture ownership.',
          '',
          ...Array.from(
            { length: 180 },
            (_, index) => `Verbose context detail ${index}: ${'routing ipc memory '.repeat(4)}`,
          ),
          '',
          'FINAL_SERVICE_CONTEXT_TAIL explains the latest operational constraint.',
        ].join('\n'),
        'utf8',
      );

      const context = await buildTaskContext({
        taskDescription: 'Improve memory-aware coding context.',
        projectDir,
        services: ['main'],
        keywords: ['memory'],
        includeGraphHints: false,
      });

      const serviceContext = context.serviceContexts.main;
      expect(serviceContext.source).toBe('SERVICE_CONTEXT.md');
      expect(serviceContext.content).toContain('Service context head explains architecture ownership');
      expect(serviceContext.content).toContain('service context middle omitted');
      expect(serviceContext.content).toContain('FINAL_SERVICE_CONTEXT_TAIL');
      expect(String(serviceContext.content).length).toBeLessThanOrEqual(SERVICE_CONTEXT_MAX_CHARS);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
