import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskLogWriter } from './task-log-writer';
import type { TaskLogs } from '../../../shared/types';

const tempDirs: string[] = [];

function createWriterFixture(
  specId = 'spec-001',
  options?: { liveTextFlushMs?: number; liveTextMaxChars?: number },
): { specDir: string; writer: TaskLogWriter } {
  const specDir = mkdtempSync(join(tmpdir(), 'task-log-writer-'));
  tempDirs.push(specDir);
  return { specDir, writer: new TaskLogWriter(specDir, specId, options) };
}

function createWriter(specId = 'spec-001'): TaskLogWriter {
  return createWriterFixture(specId).writer;
}

function readTaskLogs(specDir: string): TaskLogs {
  return JSON.parse(readFileSync(join(specDir, 'task_logs.json'), 'utf-8')) as TaskLogs;
}

afterEach(() => {
  vi.useRealTimers();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('TaskLogWriter', () => {
  it('writes text entries for different subtasks when each step flushes output', () => {
    const writer = createWriter();
    writer.startPhase('coding', 'Starting implementation');

    writer.setSubtask('subtask-1');
    writer.processEvent(
      { type: 'text-delta', text: 'alpha changes' },
      'coding',
    );
    writer.processEvent(
      {
        type: 'step-finish',
        stepNumber: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      'coding',
    );

    writer.setSubtask('subtask-2');
    writer.processEvent(
      { type: 'text-delta', text: 'beta changes' },
      'coding',
    );
    writer.processEvent(
      {
        type: 'step-finish',
        stepNumber: 2,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      'coding',
    );

    const textEntries = writer.getData().phases.coding.entries.filter((entry) => entry.type === 'text');

    expect(textEntries).toHaveLength(2);
    expect(textEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: 'alpha changes',
          subtask_id: 'subtask-1',
        }),
        expect.objectContaining({
          content: 'beta changes',
          subtask_id: 'subtask-2',
        }),
      ]),
    );
  });

  it('flushes streaming text to disk before the step finishes', async () => {
    vi.useFakeTimers();

    const { specDir, writer } = createWriterFixture('spec-001', {
      liveTextFlushMs: 250,
      liveTextMaxChars: 1000,
    });
    writer.startPhase('coding', 'Starting implementation');

    writer.setSubtask('subtask-1');
    writer.processEvent(
      { type: 'text-delta', text: 'streaming output that should appear while the step is still running' },
      'coding',
    );

    let logs = readTaskLogs(specDir);
    expect(logs.phases.coding.entries.filter((entry) => entry.type === 'text')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(250);

    logs = readTaskLogs(specDir);
    expect(logs.phases.coding.entries.filter((entry) => entry.type === 'text')).toEqual([
      expect.objectContaining({
        content: 'streaming output that should appear while the step is still running',
        subtask_id: 'subtask-1',
      }),
    ]);
  });

  it('flushes pending text before switching subtasks', () => {
    const writer = createWriter();
    writer.startPhase('coding', 'Starting implementation');

    writer.setSubtask('subtask-1');
    writer.processEvent(
      { type: 'text-delta', text: 'alpha changes' },
      'coding',
    );
    writer.setSubtask('subtask-2');

    const textEntries = writer.getData().phases.coding.entries.filter((entry) => entry.type === 'text');

    expect(textEntries).toEqual([
      expect.objectContaining({
        content: 'alpha changes',
        subtask_id: 'subtask-1',
      }),
    ]);
  });

  it('marks a pending phase active when writing lifecycle text', () => {
    const writer = createWriter();

    writer.logText('Starting agent session', 'planning', 'info');

    expect(writer.getData().phases.planning.status).toBe('active');
    expect(writer.getData().phases.planning.started_at).not.toBeNull();
    expect(writer.getData().phases.planning.entries).toEqual([
      expect.objectContaining({
        type: 'info',
        content: 'Starting agent session',
      }),
    ]);
  });

  it('always writes parseable JSON for multiline localized text and tool details', () => {
    const { specDir, writer } = createWriterFixture();
    const content = '阶段开始："编码"\n包含中文、引号、反斜杠 \\\\ 和控制字符 \u0000\u0007';

    writer.startPhase('coding', content);
    writer.processEvent(
      { type: 'text-delta', text: '| 项目 | 详情 |\n|---|---|\n| 内容 | 中文 "quoted" |' },
      'coding',
    );
    writer.processEvent(
      {
        type: 'tool-result',
        toolCallId: 'tool-1',
        toolName: 'Bash',
        result: '输出第一行\n输出第二行 "quoted"',
        isError: false,
        durationMs: 1,
      },
      'coding',
    );
    writer.endPhase('coding', true, '完成："编码"');

    const raw = readFileSync(join(specDir, 'task_logs.json'), 'utf-8');
    const logs = JSON.parse(raw) as TaskLogs;

    expect(logs.phases.coding.entries.length).toBeGreaterThan(0);
    expect(raw).toContain('阶段开始');
    expect(raw).not.toContain('\u0000');
  });

  it('flushes pending text for the active subtask when a phase ends', () => {
    const writer = createWriter();
    writer.startPhase('coding', 'Starting implementation');

    writer.setSubtask('subtask-1');
    writer.processEvent(
      { type: 'text-delta', text: 'first context output' },
      'coding',
    );

    writer.endPhase('coding', true, 'Completed coding');

    const textEntries = writer.getData().phases.coding.entries.filter((entry) => entry.type === 'text');

    expect(textEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'first context output', subtask_id: 'subtask-1' }),
      ]),
    );
  });
});
