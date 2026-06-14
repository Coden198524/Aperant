import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MAX_FILE_CHARS,
  MAX_INPUT_CHARS,
  MAX_PHASE_SUMMARIES_CONTEXT_CHARS,
  compactPhaseFileContent,
  compactPhaseOutputForSummarization,
  formatPhaseSummaries,
  gatherPhaseOutputs,
} from './conversation-compactor';

describe('conversation compactor prompt budgets', () => {
  it('keeps head and tail when compacting large phase files', () => {
    const content = [
      'FILE_HEAD: architecture boundary decision.',
      'large file detail '.repeat(20_000),
      'FILE_TAIL: verification command and remaining risk.',
    ].join('\n');

    const compact = compactPhaseFileContent(content, MAX_FILE_CHARS);

    expect(compact.length).toBeLessThanOrEqual(MAX_FILE_CHARS);
    expect(compact).toContain('FILE_HEAD: architecture boundary decision.');
    expect(compact).toContain('FILE_TAIL: verification command and remaining risk.');
    expect(compact).toContain('file middle omitted');
  });

  it('gathers phase outputs with compact file excerpts', () => {
    const specDir = mkdtempSync(join(tmpdir(), 'autocode-phase-output-'));
    try {
      writeFileSync(join(specDir, 'context.md'), [
        'CONTEXT_HEAD: source evidence.',
        'context body '.repeat(20_000),
        'CONTEXT_TAIL: open question for implementation.',
      ].join('\n'), 'utf8');

      const output = gatherPhaseOutputs(specDir, 'discovery');

      expect(output).toContain('**context.md**');
      expect(output).toContain('CONTEXT_HEAD: source evidence.');
      expect(output).toContain('CONTEXT_TAIL: open question for implementation.');
      expect(output).toContain('file middle omitted');
    } finally {
      rmSync(specDir, { recursive: true, force: true });
    }
  });

  it('keeps head and tail when compacting summarizer input', () => {
    const output = [
      'SUMMARY_INPUT_HEAD: completed discovery and requirements.',
      'phase output body '.repeat(30_000),
      'SUMMARY_INPUT_TAIL: remaining implementation risk.',
    ].join('\n');

    const compact = compactPhaseOutputForSummarization(output, MAX_INPUT_CHARS);

    expect(compact.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
    expect(compact).toContain('SUMMARY_INPUT_HEAD: completed discovery and requirements.');
    expect(compact).toContain('SUMMARY_INPUT_TAIL: remaining implementation risk.');
    expect(compact).toContain('output middle omitted for summarization');
  });

  it('bounds previous phase summaries and prefers recent phase context', () => {
    const summaries = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `phase_${index}`,
        [
          `PHASE_${index}_HEAD`,
          `phase ${index} details `.repeat(2_000),
          `PHASE_${index}_TAIL`,
        ].join('\n'),
      ]),
    );

    const context = formatPhaseSummaries(summaries);

    expect(context.length).toBeLessThanOrEqual(MAX_PHASE_SUMMARIES_CONTEXT_CHARS);
    expect(context).toContain('Context from Previous Phases');
    expect(context).toContain('older phase summary/summaries omitted');
    expect(context).toContain('PHASE_9_HEAD');
    expect(context).toContain('PHASE_9_TAIL');
    expect(context).not.toContain('PHASE_0_HEAD');
  });
});
