import { describe, expect, it } from 'vitest';
import {
  AUTOCODE_PROMPT_HUMAN_INPUT_MAX_CHARS,
  injectAutocodePromptContext,
} from './prompt-context.js';

function baseContext(overrides: Partial<Parameters<typeof injectAutocodePromptContext>[1]> = {}) {
  return {
    specDir: 'E:/Work/App/.autocode/specs/001-task',
    projectDir: 'E:/Work/App',
    ...overrides,
  };
}

describe('prompt context injection', () => {
  it('keeps short human input and project instructions unchanged', () => {
    const prompt = injectAutocodePromptContext(
      'Run the planner.',
      baseContext({
        humanInput: 'Use Chinese UI labels.',
        projectInstructions: 'Keep app-owned configuration tables as JSON.',
        autoPushToRemote: false,
      }),
      { domain: 'none' },
    );

    expect(prompt).toContain('Use Chinese UI labels.');
    expect(prompt).toContain('Keep app-owned configuration tables as JSON.');
    expect(prompt).toContain('Run the planner.');
  });

  it('compacts long human input while preserving head and tail constraints', () => {
    const humanInput = [
      'HEAD: fix the settings save failure first.',
      ...Array.from({ length: 700 }, (_, index) => `Verbose user log line ${index}: ${'diagnostic detail '.repeat(8)}`),
      'TAIL: do not convert configuration tables from JSON to Markdown.',
    ].join('\n');

    const prompt = injectAutocodePromptContext(
      'Continue implementation.',
      baseContext({ humanInput }),
      { domain: 'none' },
    );

    expect(prompt.length).toBeLessThan(humanInput.length);
    expect(prompt).toContain('HEAD: fix the settings save failure first.');
    expect(prompt).toContain('TAIL: do not convert configuration tables from JSON to Markdown.');
    expect(prompt).toContain('human input middle omitted');
    expect(prompt).not.toContain('Verbose user log line 350');
    expect(prompt.indexOf('## HUMAN INPUT')).toBeLessThan(prompt.indexOf('Continue implementation.'));
  });

  it('folds repeated long lines before compacting prompt context sections', () => {
    const repeatedLine = 'REPEATED_LOG_LINE: worker emitted the same reconnect warning with no new state.';
    const humanInput = [
      'HEAD: keep the newest reconnect instruction visible.',
      ...Array.from({ length: 420 }, () => repeatedLine),
      'TAIL: continue feature optimization before release verification.',
    ].join('\n');

    const prompt = injectAutocodePromptContext(
      'Continue implementation.',
      baseContext({ humanInput }),
      { domain: 'none' },
    );

    expect(prompt).toContain('HEAD: keep the newest reconnect instruction visible.');
    expect(prompt).toContain('TAIL: continue feature optimization before release verification.');
    expect(prompt).toContain('419 repeated line(s) omitted for prompt budget');
    expect((prompt.match(/REPEATED_LOG_LINE/g) ?? [])).toHaveLength(1);
    expect(prompt.length).toBeLessThan(humanInput.length / 5);
  });

  it('bounds project instructions and recovery context before adding the template', () => {
    const recoveryContext = [
      'RECOVERY HEAD: previous run failed after typecheck.',
      ...Array.from({ length: 500 }, (_, index) => `Recovery trace line ${index}: ${'stack frame '.repeat(8)}`),
      'RECOVERY TAIL: rerun targeted tests only.',
    ].join('\n');
    const projectInstructions = [
      'PROJECT HEAD: follow repository module boundaries.',
      ...Array.from({ length: 800 }, (_, index) => `Instruction detail ${index}: ${'policy note '.repeat(8)}`),
      'PROJECT TAIL: preserve user changes in dirty worktrees.',
    ].join('\n');

    const prompt = injectAutocodePromptContext(
      'Implement safely.',
      baseContext({ recoveryContext, projectInstructions }),
      { domain: 'none' },
    );

    expect(prompt).toContain('RECOVERY HEAD: previous run failed after typecheck.');
    expect(prompt).toContain('RECOVERY TAIL: rerun targeted tests only.');
    expect(prompt).toContain('PROJECT HEAD: follow repository module boundaries.');
    expect(prompt).toContain('PROJECT TAIL: preserve user changes in dirty worktrees.');
    expect(prompt).toContain('recovery context middle omitted');
    expect(prompt).toContain('project instructions middle omitted');
    expect(prompt).not.toContain('Recovery trace line 250');
    expect(prompt).not.toContain('Instruction detail 400');
    expect(prompt.length).toBeLessThan(
      AUTOCODE_PROMPT_HUMAN_INPUT_MAX_CHARS + recoveryContext.length + projectInstructions.length,
    );
  });
});
