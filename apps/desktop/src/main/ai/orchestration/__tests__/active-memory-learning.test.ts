import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACTIVE_MEMORY_CODE_PATTERN_FILE_MAX_BYTES,
  extractAndStoreKnowledge,
  readCodePatternFileSample,
} from '../active-memory-learning';
import type { SessionResult } from '../../session/types';

describe('active memory learning storage', () => {
  let projectDir: string;
  let specDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'active-memory-project-'));
    specDir = await mkdtemp(join(tmpdir(), 'active-memory-spec-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(specDir, { recursive: true, force: true });
  });

  it('stores compact markdown memory entries instead of JSON pattern blobs', async () => {
    const stored: Array<{ type?: string; content?: string }> = [];
    const sessionResult: SessionResult = {
      outcome: 'completed',
      stepsExecuted: 3,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      messages: [{
        role: 'assistant',
        content: `We decided to reuse the central settings writer ${'because '.repeat(120)}MEMORY_DECISION_TAIL_OK.`,
      }],
      durationMs: 1,
      toolCallCount: 1,
    };

    await extractAndStoreKnowledge({
      sessionResult,
      subtask: {
        id: '1.1',
        description: `Update settings flow ${'detail '.repeat(120)}DESCRIPTION_TAIL_OK`,
      },
      projectDir,
      specDir,
      projectId: 'project-1',
      memoryService: {
        store: async (entry) => {
          stored.push(entry);
          return `memory-${stored.length}`;
        },
      },
    });

    const patternMemory = stored.find((entry) => entry.type === 'pattern');
    expect(patternMemory?.content).toContain('Success pattern:');
    expect(patternMemory?.content?.trim().startsWith('{')).toBe(false);
    expect(patternMemory?.content).not.toContain('Efficient implementation with minimal token usage');
    expect(patternMemory?.content).not.toContain('Completed in few steps without excessive retries');
    expect(patternMemory?.content).toContain('MEMORY_DECISION_TAIL_OK');
    expect(patternMemory?.content).toContain('DESCRIPTION_TAIL_OK');
    expect(patternMemory?.content?.length).toBeLessThanOrEqual(900);
    expect(stored.some((entry) => entry.type === 'module_insight')).toBe(false);
  });

  it('samples large code files before active memory pattern extraction', async () => {
    const fileName = 'large.ts';
    const head = 'const [count, setCount] = useState(0);\n';
    const middle = 'MIDDLE_SENTINEL_SHOULD_NOT_BE_SAMPLED';
    const tail = '\nreturn { success: true, data: count };\nTAIL_SENTINEL_SHOULD_BE_SAMPLED';
    const content = [
      head,
      'h'.repeat(2048),
      'm'.repeat(ACTIVE_MEMORY_CODE_PATTERN_FILE_MAX_BYTES),
      middle,
      'n'.repeat(ACTIVE_MEMORY_CODE_PATTERN_FILE_MAX_BYTES),
      tail,
    ].join('');

    await writeFile(join(projectDir, fileName), content, 'utf-8');

    const sample = await readCodePatternFileSample(projectDir, fileName);

    expect(sample.length).toBeLessThan(content.length);
    expect(sample).toContain('active memory file sample truncated');
    expect(sample).toContain(head.trim());
    expect(sample).toContain('TAIL_SENTINEL_SHOULD_BE_SAMPLED');
    expect(sample).not.toContain(middle);
  });
});
