import { describe, expect, it } from 'vitest';
import {
  AUTOCODE_SUBAGENT_CONTEXT_MAX_CHARS,
  AUTOCODE_SUBAGENT_TEXT_OUTPUT_MAX_CHARS,
  buildAutocodeSubagentUserMessage,
  compactAutocodeSubagentContextText,
  compactAutocodeSubagentOutputText,
  formatAutocodeSubagentToolResult,
} from './subagent-plan.js';

describe('subagent prompt and result compaction', () => {
  it('keeps short subagent context unchanged', () => {
    const message = buildAutocodeSubagentUserMessage({
      task: 'Review auth flow',
      context: 'Use context.md and keep settings JSON unchanged.',
    });

    expect(message).toBe('Your task: Review auth flow\n\nContext:\nUse context.md and keep settings JSON unchanged.');
  });

  it('compacts long subagent context while preserving head and tail constraints', () => {
    const context = [
      'HEAD: task goal and authoritative inputs.',
      ...Array.from({ length: 700 }, (_, index) => `Noise context line ${index}: ${'verbose detail '.repeat(8)}`),
      'TAIL: preserve app-owned configuration tables as JSON.',
    ].join('\n');

    const compacted = compactAutocodeSubagentContextText(context);

    expect(compacted.length).toBeLessThanOrEqual(AUTOCODE_SUBAGENT_CONTEXT_MAX_CHARS);
    expect(compacted).toContain('HEAD: task goal and authoritative inputs.');
    expect(compacted).toContain('TAIL: preserve app-owned configuration tables as JSON.');
    expect(compacted).toContain('subagent context middle omitted');
    expect(compacted).not.toContain('Noise context line 350');
  });

  it('folds repeated subagent context lines before parent prompt injection', () => {
    const repeatedLine = 'SUBAGENT_CONTEXT_REPEAT: same evidence copied without new signal.';
    const context = [
      'SUBAGENT_CONTEXT_HEAD',
      ...Array.from({ length: 120 }, () => repeatedLine),
      'SUBAGENT_CONTEXT_TAIL',
    ].join('\n');

    const compacted = compactAutocodeSubagentContextText(context);

    expect(compacted.length).toBeLessThan(context.length / 4);
    expect(compacted).toContain('SUBAGENT_CONTEXT_HEAD');
    expect(compacted).toContain('SUBAGENT_CONTEXT_TAIL');
    expect(compacted).toContain('119 repeated line(s) omitted for prompt budget');
    expect((compacted.match(/SUBAGENT_CONTEXT_REPEAT/g) ?? [])).toHaveLength(1);
  });

  it('compacts long subagent text output before returning it to the parent context', () => {
    const output = [
      'HEAD OUTPUT: verified source-backed findings.',
      ...Array.from({ length: 700 }, (_, index) => `Verbose result line ${index}: ${'implementation notes '.repeat(8)}`),
      'TAIL OUTPUT: final risk and verification summary.',
    ].join('\n');

    const compacted = compactAutocodeSubagentOutputText(output);
    const result = formatAutocodeSubagentToolResult({
      agentType: 'qa_reviewer',
      text: output,
    });

    expect(compacted.length).toBeLessThanOrEqual(AUTOCODE_SUBAGENT_TEXT_OUTPUT_MAX_CHARS);
    expect(result).toContain('HEAD OUTPUT: verified source-backed findings.');
    expect(result).toContain('TAIL OUTPUT: final risk and verification summary.');
    expect(result).toContain('subagent output middle omitted');
    expect(result).not.toContain('Verbose result line 350');
  });

  it('folds repeated subagent output lines before returning to the parent context', () => {
    const repeatedLine = 'SUBAGENT_OUTPUT_REPEAT: same review note copied without new signal.';
    const output = [
      'SUBAGENT_OUTPUT_HEAD',
      ...Array.from({ length: 120 }, () => repeatedLine),
      'SUBAGENT_OUTPUT_TAIL',
    ].join('\n');

    const compacted = compactAutocodeSubagentOutputText(output);
    const result = formatAutocodeSubagentToolResult({
      agentType: 'qa_reviewer',
      text: output,
    });

    expect(compacted.length).toBeLessThan(output.length / 4);
    expect(result).toContain('SUBAGENT_OUTPUT_HEAD');
    expect(result).toContain('SUBAGENT_OUTPUT_TAIL');
    expect(result).toContain('119 repeated line(s) omitted for prompt budget');
    expect((result.match(/SUBAGENT_OUTPUT_REPEAT/g) ?? [])).toHaveLength(1);
  });
});
