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
});
