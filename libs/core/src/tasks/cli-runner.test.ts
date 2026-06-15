import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DIRECT_CHANGE_REQUEST_LIMIT } from '../runtime/agent-messages.js';
import {
  AUTOCODE_CLI_TASK_DESCRIPTION_MAX_CHARS,
  createAutocodeTaskRunPlan,
} from './cli-runner.js';
import { createAutocodeTask, getAutocodeSpecDir } from './spec-store.js';

describe('Autocode CLI runner prompt', () => {
  let projectRoot: string;
  const dataDirName = '.autocode';

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'autocode-cli-runner-'));
    mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('compacts human feedback and change-request audit entries in generated run prompts', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-task',
      title: 'Optimize prompt context',
      description: 'Keep review context useful without injecting entire feedback logs.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '001-task' });

    writeFileSync(
      join(specDir, 'HUMAN_INPUT.md'),
      [
        'Important latest human feedback.',
        'x'.repeat(DIRECT_CHANGE_REQUEST_LIMIT * 2),
        'HUMAN_INPUT_TAIL_SHOULD_BE_PRESERVED',
      ].join('\n'),
      'utf8',
    );

    const changeRequests = Array.from({ length: 4 }, (_, index) => JSON.stringify({
      id: `CR-${index + 1}`,
      createdAt: `2026-06-14T0${index}:00:00.000Z`,
      scope: 'implementation',
      impacts: index === 3 ? ['requirements', 'validation'] : ['implementation'],
      feedback: index === 0
        ? 'OLD_CHANGE_REQUEST_SHOULD_NOT_APPEAR'
        : index === 3
          ? `LATEST_CHANGE_REQUEST ${'latest details '.repeat(50)}`
          : `Recent change request ${index}`,
      iteration: {
        mode: 'standard-implementation',
        flowDocuments: ['HUMAN_INPUT.md', 'change_requests.jsonl', 'tasks.md'],
        requiredActions: ['Keep as same task iteration.', 'Run targeted validation.'],
        validation: ['Run focused tests.'],
        commitPolicy: 'Use normal task commit flow after validation.',
      },
    })).join('\n');
    writeFileSync(join(specDir, 'change_requests.jsonl'), `${changeRequests}\n`, 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-task',
      cli: 'codex',
      phase: 'direct',
      language: 'zh-CN',
    });

    expect(plan.prompt).toContain('Important latest human feedback.');
    expect(plan.prompt).toContain('HUMAN_INPUT.md truncated');
    expect(plan.prompt).toContain('HUMAN_INPUT_TAIL_SHOULD_BE_PRESERVED');
    expect(plan.prompt).toContain('## 变更请求摘要');
    expect(plan.prompt).toContain('Showing latest 3 of 4 change request entries.');
    expect(plan.prompt).toContain('Latest change request: CR-4');
    expect(plan.prompt).toContain('LATEST_CHANGE_REQUEST');
    expect(plan.prompt).not.toContain('OLD_CHANGE_REQUEST_SHOULD_NOT_APPEAR');
    expect(readFileSync(plan.promptFilePath, 'utf8')).toBe(`${plan.prompt}\n`);
  });

  it('folds repeated human feedback lines before generating run prompts', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '002-human-repeat',
      title: 'Fold repeated human input',
      description: 'Keep latest human feedback concise before invoking the CLI.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '002-human-repeat' });
    const repeatedLine = 'REPEATED_CLI_HUMAN_FEEDBACK: renderer emitted the same warning without new evidence.';
    const humanInput = [
      'Human feedback head: preserve the newest product constraint.',
      ...Array.from({ length: 160 }, () => repeatedLine),
      'Human feedback tail: do not run release packaging checks.',
    ].join('\n');

    writeFileSync(join(specDir, 'HUMAN_INPUT.md'), humanInput, 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '002-human-repeat',
      cli: 'codex',
      phase: 'direct',
    });

    expect(plan.prompt).toContain('Human feedback head: preserve the newest product constraint.');
    expect(plan.prompt).toContain('159 repeated line(s) omitted for prompt budget');
    expect(plan.prompt).toContain('Human feedback tail: do not run release packaging checks.');
    expect((plan.prompt.match(/REPEATED_CLI_HUMAN_FEEDBACK/g) ?? [])).toHaveLength(1);
    expect(readFileSync(plan.promptFilePath, 'utf8')).toBe(`${plan.prompt}\n`);
  });

  it('compacts oversized task descriptions in prompts and runner scripts', () => {
    const longDescription = [
      'Opening CLI task rule: preserve structured configuration as JSON.',
      ...Array.from(
        { length: 260 },
        (_, index) => `Large copied task context ${index}: ${'diagnostic noise '.repeat(8)}`,
      ),
      'Closing CLI task rule: keep model-only prose references in Markdown.',
    ].join('\n');

    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '002-task',
      title: 'Compact task description',
      description: longDescription,
      metadata: { developmentMode: 'direct' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '002-task',
      cli: 'codex',
      phase: 'direct',
    });
    const runner = readFileSync(plan.runnerFilePath, 'utf8');

    expect(plan.prompt).toContain('Opening CLI task rule: preserve structured configuration as JSON.');
    expect(plan.prompt).toContain('task description middle omitted for prompt budget');
    expect(plan.prompt).toContain('Closing CLI task rule: keep model-only prose references in Markdown.');
    expect(plan.prompt).not.toContain('Large copied task context 160');
    expect(plan.prompt.length).toBeLessThan(AUTOCODE_CLI_TASK_DESCRIPTION_MAX_CHARS + 4_000);
    expect(runner).toContain('Opening CLI task rule: preserve structured configuration as JSON.');
    expect(runner).toContain('task description middle omitted for prompt budget');
    expect(runner).toContain('Closing CLI task rule: keep model-only prose references in Markdown.');
    expect(runner).not.toContain('Large copied task context 160');
    expect(readFileSync(plan.promptFilePath, 'utf8')).toBe(`${plan.prompt}\n`);
  });

  it('folds repeated task description lines before writing prompts and runner scripts', () => {
    const repeatedLine = 'REPEATED_CLI_TASK_DESCRIPTION: same diagnostic pasted without new requirements.';
    const repeatedDescription = [
      'Opening CLI task description: optimize model context before validation.',
      ...Array.from({ length: 160 }, () => repeatedLine),
      'Closing CLI task description: keep functional work ahead of release checks.',
    ].join('\n');

    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '003-task-repeat',
      title: 'Fold repeated task description',
      description: repeatedDescription,
      metadata: { developmentMode: 'direct' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '003-task-repeat',
      cli: 'codex',
      phase: 'direct',
    });
    const runner = readFileSync(plan.runnerFilePath, 'utf8');

    expect(plan.prompt).toContain('Opening CLI task description: optimize model context before validation.');
    expect(plan.prompt).toContain('159 repeated line(s) omitted for prompt budget');
    expect(plan.prompt).toContain('Closing CLI task description: keep functional work ahead of release checks.');
    expect(plan.prompt).not.toContain('task description middle omitted for prompt budget');
    expect((plan.prompt.match(/REPEATED_CLI_TASK_DESCRIPTION/g) ?? [])).toHaveLength(1);
    expect(runner).toContain('159 repeated line(s) omitted for prompt budget');
    expect((runner.match(/REPEATED_CLI_TASK_DESCRIPTION/g) ?? [])).toHaveLength(1);
    expect(readFileSync(plan.promptFilePath, 'utf8')).toBe(`${plan.prompt}\n`);
  });

  it('generates a runner script with bounded memory context injection', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '004-task',
      title: 'Bound memory context',
      description: 'Keep memory useful while avoiding repeated large prompt injections.',
      metadata: { developmentMode: 'direct' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '004-task',
      cli: 'codex',
      phase: 'direct',
    });
    const runner = readFileSync(plan.runnerFilePath, 'utf8');

    expect(runner).toContain('const CLI_MEMORY_CONTEXT_MAX_CHARS = 1800;');
    expect(runner).toContain('const CLI_MEMORY_ITEM_MAX_CHARS = 260;');
    expect(runner).toContain('const CLI_MEMORY_RELATED_FILES_MAX = 3;');
    expect(runner).toContain('const CLI_MEMORY_STORAGE_CONTENT_MAX_CHARS = 1200;');
    expect(runner).toContain('const CLI_MEMORY_STORAGE_FIELD_MAX_CHARS = 500;');
    expect(runner).toContain('const CLI_MEMORY_STORAGE_FILE_REF_LIMIT = 12;');
    expect(runner).toContain('const RUNNER_REPEATED_LINE_MIN_CHARS = 24;');
    expect(runner).toContain('function foldRepeatedRunnerPromptLines(value)');
    expect(runner).toContain('repeated line(s) omitted for prompt budget');
    expect(runner).toContain('const text = foldRepeatedRunnerPromptLines(cleanLogText(value));');
    expect(runner).toContain('formatCliMemoryPromptLine(memory)');
    expect(runner).toContain('const CLI_LOW_VALUE_WHOLE_MEMORY_LINE_PATTERNS = [');
    expect(runner).toContain('const CLI_LOW_VALUE_MEMORY_LINE_PATTERNS = [');
    expect(runner).toContain('Memory (?:recorded|skipped|noted locally|not persisted|search unavailable|system not available)');
    expect(runner).toContain('isCliLowValueWholeMemoryLine(trimmed)');
    expect(runner).toContain('function stripCliLowValueMemoryText(content)');
    expect(runner).toContain('const memoryContent = stripCliLowValueMemoryText(memory.content);');
    expect(runner).toContain('if (included === 0)');
    expect(runner).toContain('limitCliMemoryContext(lines.join');
    expect(runner).toContain('const compactSummary = limitCliMemoryStorageText(summary);');
    expect(runner).toContain('compactCliMemoryStorageFiles(getWorkItemFiles(subtask || {}))');
    expect(runner).not.toContain('limitLogText(memory.content, CLI_MEMORY_ITEM_MAX_CHARS)');
    expect(runner).not.toContain('limitLogText(memory.content, 900)');
    expect(runner).not.toContain('dedupeCliMemories(memories).slice(0, 8)');
  });

  it('generates bounded artifact validation retry prompts', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '005-task',
      title: 'Bound validation retry prompt',
      description: 'Avoid reinjecting the full original prompt when artifact validation asks for a retry.',
      metadata: { developmentMode: 'standard' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '005-task',
      cli: 'codex',
      phase: 'planning',
    });
    const runner = readFileSync(plan.runnerFilePath, 'utf8');

    expect(runner).toContain('const VALIDATION_RETRY_BASE_PROMPT_MAX_CHARS = 6000;');
    expect(runner).toContain('const VALIDATION_RETRY_ERROR_MAX_CHARS = 1200;');
    expect(runner).toContain('function compactArtifactValidationRetryBasePrompt(value)');
    expect(runner).toContain('original prompt middle omitted for validation retry budget');
    expect(runner).toContain('const compactValidationError = compactArtifactValidationError(validationError);');
    expect(runner).toContain('compactArtifactValidationRetryBasePrompt(prompt)');
    expect(runner).toContain('const text = foldRepeatedRunnerPromptLines(');
    expect((runner.match(/foldRepeatedRunnerPromptLines/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(runner).not.toContain(
      `The previous CLI attempt exited successfully, but artifact validation failed: \${validationError}`,
    );
  });
});
