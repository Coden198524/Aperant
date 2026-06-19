import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DIRECT_CHANGE_REQUEST_LIMIT } from '../runtime/agent-messages.js';
import {
  AUTOCODE_CLI_TASK_DESCRIPTION_MAX_CHARS,
  createAutocodeTaskRunPlan,
  resolveAutocodeTaskRunnerDependency,
} from './cli-runner.js';
import { loadAutocodeImplementationPlanSync } from './plan-store.js';
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

  it('does not inject revision-state wording for new planning tasks without review input', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-new-plan',
      title: 'Create a new playable game',
      description: 'Create a new browser game from the current project files.',
      metadata: { developmentMode: 'standard' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-new-plan',
      cli: 'codex',
      phase: 'planning',
    });

    expect(plan.prompt).toContain('not a RequestChanges iteration');
    expect(plan.prompt).toContain('ordinary pending tasks');
    expect(plan.prompt).not.toContain('needs_revision');
    expect(plan.prompt).not.toContain('preserve prior change-request history');
  });

  it('injects revision-state wording only when planning has human review input', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-review-plan',
      title: 'Revise a reviewed task',
      description: 'Address the latest human plan review.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '001-review-plan' });
    writeFileSync(join(specDir, 'HUMAN_INPUT.md'), 'RequestChanges: split the runtime task.\n', 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-review-plan',
      cli: 'codex',
      phase: 'planning',
    });

    expect(plan.prompt).toContain('same-task RequestChanges iteration');
    expect(plan.prompt).toContain('needs_revision');
  });

  it('writes zh-CN prompts as readable Chinese and includes Codex rules preflight', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-zh-prompt',
      title: '复现Lumen全局光照',
      description: '当前截图看不出全局光照的效果，继续复现全局光照。',
      metadata: { developmentMode: 'standard' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-zh-prompt',
      cli: 'codex',
      phase: 'planning',
      language: 'zh-CN',
    });
    const prompt = readFileSync(plan.promptFilePath, 'utf8');
    const runner = readFileSync(plan.runnerFilePath, 'utf8');

    expect(prompt).toContain('# Autocode 任务运行');
    expect(prompt).toContain('Task title: 复现Lumen全局光照');
    expect(prompt).toContain('## 语言');
    expect(prompt).toContain('## 目标');
    expect(prompt).toContain('## 必须生成的内容');
    expect(prompt).toContain('简体中文');
    for (const damagedText of ['浠诲姟', '璇', '鐩爣', '蹇呴', '绠€', '鍒涘缓', '瑙勫垝']) {
      expect(prompt).not.toContain(damagedText);
    }

    expect(runner).toContain('sanitizeCodexRulesFiles();');
    expect(runner).toContain('function stripUtf8BomFromFile(filePath)');
    expect(runner).toContain('Removed UTF-8 BOM from Codex rules file');
    expect(runner).toContain('Codex rules file starts with a UTF-8 BOM');
    expect(runner).toContain("return isCodexCommand(command) && Array.isArray(args) && args.includes('--json');");
  });

  it('resolves packaged work package helpers from Electron resources', () => {
    const resourcesPath = join(projectRoot, 'resources');
    const coreTasksDir = join(resourcesPath, 'node_modules', '@autocode', 'core', 'dist', 'tasks');
    mkdirSync(coreTasksDir, { recursive: true });
    writeFileSync(join(coreTasksDir, 'work-packages.js'), 'export {};\n', 'utf8');
    writeFileSync(join(coreTasksDir, 'plan-quality.js'), 'export {};\n', 'utf8');

    const missingWorkspaceResolver = () => {
      throw new Error('workspace package not available');
    };

    expect(resolveAutocodeTaskRunnerDependency('@autocode/core/tasks/work-packages', {
      resolveModule: missingWorkspaceResolver,
      resourcesPath,
    })).toBe(join(coreTasksDir, 'work-packages.js'));
    expect(resolveAutocodeTaskRunnerDependency('./plan-quality.js', {
      resolveModule: missingWorkspaceResolver,
      resourcesPath,
    })).toBe(join(coreTasksDir, 'plan-quality.js'));
  });

  it('validates Standard artifacts before deriving runtime work packages', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-order',
      title: 'Replan safely',
      description: 'Do not replace runtime plan before Standard validation passes.',
      metadata: { developmentMode: 'standard' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-order',
      cli: 'codex',
      phase: 'planning',
    });
    const runner = readFileSync(plan.runnerFilePath, 'utf8');
    const qualityIndex = runner.indexOf('const qualityError = await validateStandardPlanArtifactQuality();');
    const deriveIndex = runner.indexOf('const derivedPlanError = await deriveRuntimePlanFromStandardTasksIfNeeded();');

    expect(qualityIndex).toBeGreaterThanOrEqual(0);
    expect(deriveIndex).toBeGreaterThan(qualityIndex);
    expect(runner).toContain('includeCompletedTasks: false');
    expect(runner).toContain('repairStandardPlanEvidenceScaffolding();');
    expect(runner).toContain('hasOnlyStandardPlanRecoverableQualityErrors(planQuality, errors)');
    expect(runner).toContain('spec.md must include a non-empty ## Evidence section');
    expect(runner).toContain('validationRetryCount >= maxValidationRetries');
  });

  it('repairs missing Standard spec evidence before deriving runtime work packages', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-evidence-repair',
      title: 'Repair planning evidence',
      description: 'Continue planning when the CLI omitted spec evidence scaffolding.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '001-standard-evidence-repair',
    });

    const requirementsMarkdown = [
      '# Requirements',
      '',
      '## Requirements',
      '- R1: Planning validation keeps a traceable Standard task list.',
      '',
      '## Evidence Sources',
      '- User task description captured by Autocode.',
      '',
    ].join('\n');
    const specMarkdown = [
      '# Specification: Repair planning evidence',
      '',
      '## Overview',
      'Keep Standard planning validation moving when generated specs omit evidence scaffolding.',
      '',
      '## Workflow Type',
      '',
      '**Type**: simple',
      '',
      '**Rationale**: The change is local to planning artifact validation.',
      '',
      '## Task Scope',
      '',
      '### This Task Will:',
      '- [ ] Repair missing evidence scaffolding before validation.',
      '',
      '### Out of Scope:',
      '- Runtime coding changes.',
      '',
      '## Files to Modify',
      '- `src/evidence.ts` - evidence repair path',
      '',
      '## Change Details',
      'Add Standard evidence scaffolding before artifact validation.',
      '',
      '## Requirements',
      '1. Standard planning validation continues after Evidence scaffolding is repaired.',
      '   - Acceptance: runtime work packages are derived from tasks.md.',
      '',
      '## Success Criteria',
      '- [ ] implementation_plan.md is created from tasks.md.',
      '',
    ].join('\n');
    const tasksMarkdown = [
      '# Tasks',
      '',
      'Feature: Repair planning evidence',
      'Workflow: simple',
      'Status: pending',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Update evidence repair path',
      '    - Update `src/evidence.ts` to add Standard evidence scaffolding before validation.',
      '    - _Files to modify: src/evidence.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1_',
      '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
      '    - _Done when: validation repairs missing evidence and derives the runtime plan_',
      '    - _Verification: npm test -- evidence.test.ts_',
      '',
    ].join('\n');
    const fakeCliPath = join(projectRoot, 'write-standard-artifacts.cjs');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const specDir = process.argv[2];',
      'mkdirSync(specDir, { recursive: true });',
      `writeFileSync(join(specDir, 'requirements.md'), ${JSON.stringify(requirementsMarkdown)}, 'utf8');`,
      `writeFileSync(join(specDir, 'spec.md'), ${JSON.stringify(specMarkdown)}, 'utf8');`,
      `writeFileSync(join(specDir, 'tasks.md'), ${JSON.stringify(tasksMarkdown)}, 'utf8');`,
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-evidence-repair',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}" "${specDir.replace(/\\/g, '/')}"`,
      phase: 'planning',
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    });

    const repairedSpec = readFileSync(join(specDir, 'spec.md'), 'utf8');
    expect(repairedSpec).toContain('## Evidence');
    expect(repairedSpec).toContain('requirements.md captures the user request');
    const implementationPlan = loadAutocodeImplementationPlanSync(specDir);
    expect(implementationPlan?.phases?.[0]?.subtasks?.[0]?.title).toContain('Update evidence repair path');
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
    expect(runner).toContain('const CLI_MEMORY_LOCAL_CONTENT_MAX_CHARS = 600;');
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
    expect(runner).toContain('function compactCliExplicitMemoryNotes(explicitNotes)');
    expect(runner).toContain('stripCliLowValueMemoryText(note && note.content)');
    expect(runner).toContain('function normalizeCliMemoryNoteKey(value)');
    expect(runner).toContain('function appendPlainCliMessageText(previous, next)');
    expect(runner).toContain('state.lastCodexMessageText = appendPlainCliMessageText');
    expect(runner).toContain('function compactCliLocalSessionMemoryContent(insight)');
    expect(runner).toContain('function buildCliLocalSessionMemoryParts(insight)');
    expect(runner).toContain('foldRepeatedRunnerPromptLines(cleanLogText(part))');
    expect(runner).toContain('successPattern.keyDecisions.slice(0, 3)');
    expect(runner).toContain('failurePattern.rootCause');
    expect(runner).toContain('limitLogText(parts.join');
    expect(runner).toContain('if (included === 0)');
    expect(runner).toContain('limitCliMemoryContext(lines.join');
    expect(runner).toContain('const compactSummary = limitCliMemoryStorageText(summary);');
    expect(runner).toContain('compactCliMemoryStorageFiles(getWorkItemFiles(subtask || {}))');
    expect(runner).not.toContain('limitLogText(memory.content, CLI_MEMORY_ITEM_MAX_CHARS)');
    expect(runner).not.toContain('limitLogText(memory.content, 900)');
    expect(runner).not.toContain('dedupeCliMemories(memories).slice(0, 8)');
    expect(runner).not.toContain('content: Array.isArray(insight.insights)');
  });

  it('injects compact local session memories from reusable learned patterns', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '005-local-memory',
      title: 'Recall local learned decisions',
      description: 'Use previous local session outcomes without generic token metrics.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '005-local-memory' });
    const memoryDir = join(specDir, 'memory', 'session_insights');
    mkdirSync(memoryDir, { recursive: true });
    const repeatedDecision = 'AUTH_DECISION_REPEAT: same renderer ordering note without new evidence.';
    writeFileSync(join(memoryDir, 'session_previous.json'), JSON.stringify({
      sessionId: 'previous-session',
      timestamp: '2026-06-14T00:00:00.000Z',
      outcome: 'completed',
      insights: [
        'Efficient token usage - concise and focused implementation',
        'Completed quickly with few steps - good planning',
      ],
      keyFiles: ['src/auth/session.ts'],
      successPatterns: [{
        description: 'Auth retry state',
        approach: 'Approach: session store.',
        whyItWorked: 'Renderer refreshes stayed consistent.',
        keyDecisions: [
          [
            'We decided to refresh the AuthStore before renderer event fan-out.',
            ...Array.from({ length: 12 }, () => repeatedDecision),
            'Use the session store as the durable retry boundary.',
          ].join('\n'),
        ],
        effectiveTools: ['Edit', 'Bash'],
        confidence: 0.8,
      }],
    }), 'utf8');
    writeFileSync(join(memoryDir, 'session_duplicate.json'), JSON.stringify({
      sessionId: 'duplicate-session',
      timestamp: '2026-06-14T00:01:00.000Z',
      outcome: 'completed',
      keyFiles: ['src/auth/session.ts'],
      successPatterns: [{
        description: 'Auth retry state',
        approach: 'Approach: session store.',
        whyItWorked: 'Renderer refreshes stayed consistent.',
        keyDecisions: [
          [
            'We decided to refresh the AuthStore before renderer event fan-out.',
            ...Array.from({ length: 12 }, () => repeatedDecision),
            'Use the session store as the durable retry boundary.',
          ].join('\n'),
        ],
        effectiveTools: ['Edit', 'Bash'],
        confidence: 0.8,
      }],
    }), 'utf8');

    const fakeCliPath = join(projectRoot, 'fake-cli.cjs');
    const capturedPromptPath = join(projectRoot, 'captured-prompt.txt');
    writeFileSync(fakeCliPath, [
      "const { writeFileSync } = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => { writeFileSync(process.argv[2], input, 'utf8'); });",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '005-local-memory',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}" "${capturedPromptPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'true' },
      stdio: 'pipe',
      timeout: 15_000,
    });

    const capturedPrompt = readFileSync(capturedPromptPath, 'utf8');
    expect(capturedPrompt).toContain('## Project Memory');
    expect(capturedPrompt).toContain('We decided to refresh the AuthStore before renderer event fan-out.');
    expect((capturedPrompt.match(/We decided to refresh the AuthStore/g) ?? [])).toHaveLength(1);
    expect(capturedPrompt).toContain('AUTH_DECISION_REPEAT');
    expect(capturedPrompt).toContain('repeated line(s) omitted');
    expect((capturedPrompt.match(/AUTH_DECISION_REPEAT/g) ?? [])).toHaveLength(1);
    expect(capturedPrompt).toContain('Files: src/auth/session.ts.');
    expect(capturedPrompt).not.toContain('Efficient token usage');
    expect(capturedPrompt).not.toContain('Completed quickly with few steps');
  });

  it('stores filtered explicit Memory Notes from plain CLI output', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '006-cli-memory-notes',
      title: 'Store plain CLI memory notes',
      description: 'Persist explicit Memory Notes from non-JSON CLI output without noise.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '006-cli-memory-notes' });
    const fakeCliPath = join(projectRoot, 'memory-cli.cjs');
    writeFileSync(fakeCliPath, [
      "process.stdout.write([",
      "  'Implementation complete.',",
      "  '## Memory Notes',",
      "  '- [decision] Keep focused validation before broader checks.',",
      "  '- [module_insight] keep   focused validation before broader checks.',",
      "  '- [module_insight] High token usage per step - may need more focused approach',",
      "].join('\\n'));",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '006-cli-memory-notes',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'true' },
      stdio: 'pipe',
      timeout: 15_000,
    });

    const memoryDir = join(specDir, 'memory', 'session_insights');
    const memoryFiles = readdirSync(memoryDir).filter((name) => /^session_.+\.json$/i.test(name));
    expect(memoryFiles).toHaveLength(1);
    const memory = JSON.parse(readFileSync(join(memoryDir, memoryFiles[0]), 'utf8')) as {
      insights?: string[];
    };

    expect(memory.insights).toContain('Keep focused validation before broader checks.');
    expect(
      memory.insights?.filter((insight) => /focused validation/i.test(insight)),
    ).toHaveLength(1);
    expect(memory.insights?.some((insight) => insight.includes('High token usage'))).toBe(false);
  });

  it('uses Codex /goal for direct-mode Codex CLI prompts', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '007-codex-goal',
      title: 'Wrap direct Codex prompt',
      description: 'Add a Direct mode Codex goal regression test.',
      metadata: { developmentMode: 'direct' },
    });

    const capturedPromptPath = join(projectRoot, 'captured-codex-goal.txt');
    installFakeCodexCommand(projectRoot);

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '007-codex-goal',
      cli: 'custom',
      customCommand: `codex "${capturedPromptPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GRAPHITI_ENABLED: 'false',
        PATH: `${projectRoot}${delimiter}${process.env.PATH ?? ''}`,
      },
      stdio: 'pipe',
      timeout: 15_000,
    });

    const capturedPrompt = readFileSync(capturedPromptPath, 'utf8');
    const firstLine = capturedPrompt.split(/\r?\n/, 1)[0];
    expect(firstLine).toMatch(/^\/goal\s+/);
    expect(firstLine).toContain('Add a Direct mode Codex goal regression test.');
    expect(capturedPrompt).toContain('# Autocode Task Run');
    expect(capturedPrompt).toContain('## Required Workflow');
  });

  it('counts repeated Codex JSON usage snapshots as one implicit model turn', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-codex-usage',
      title: 'Track Codex usage',
      description: 'Avoid counting every usage snapshot as a separate model turn.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-codex-usage' });

    writeFakeCodexJsonCommand(projectRoot, [
      { type: 'usage', session_id: 'codex-session', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
      { type: 'usage_update', session_id: 'codex-session', usage: { input_tokens: 180, output_tokens: 40, total_tokens: 220 } },
    ]);

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-codex-usage',
      cli: 'custom',
      customCommand: 'codex --json',
      phase: 'direct',
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GRAPHITI_ENABLED: 'false',
        PATH: `${projectRoot}${delimiter}${process.env.PATH ?? ''}`,
      },
      stdio: 'pipe',
      timeout: 15_000,
    });

    const implementationPlan = loadAutocodeImplementationPlanSync(
      join(specDir, 'implementation_plan.md'),
    );

    expect(implementationPlan?.tokenUsage).toEqual({
      promptTokens: 180,
      completionTokens: 40,
      totalTokens: 220,
      stepsExecuted: 1,
      sessionId: 'codex-session',
    });
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

function installFakeCodexCommand(projectRoot: string): void {
  writeFileSync(join(projectRoot, 'codex-shim.cjs'), [
    "const { readFileSync, writeFileSync } = require('node:fs');",
    "const outputPath = process.argv[2];",
    "const input = readFileSync(0, 'utf8');",
    "writeFileSync(outputPath, input, 'utf8');",
    "process.stdout.write('fake codex completed\\n');",
  ].join('\n'), 'utf8');

  if (process.platform === 'win32') {
    writeFileSync(
      join(projectRoot, 'codex.cmd'),
      '@echo off\r\nnode "%~dp0codex-shim.cjs" %*\r\n',
      'utf8',
    );
    return;
  }

  const unixShimPath = join(projectRoot, 'codex');
  writeFileSync(unixShimPath, [
    '#!/usr/bin/env node',
    "require('./codex-shim.cjs');",
  ].join('\n'), 'utf8');
  chmodSync(unixShimPath, 0o755);
}

function writeFakeCodexJsonCommand(projectRoot: string, events: unknown[]): void {
  writeFileSync(join(projectRoot, 'codex-json-shim.cjs'), [
    'const events = ' + JSON.stringify(events) + ';',
    "for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');",
  ].join('\n'), 'utf8');

  if (process.platform === 'win32') {
    writeFileSync(
      join(projectRoot, 'codex.cmd'),
      '@echo off\r\nnode "%~dp0codex-json-shim.cjs" %*\r\n',
      'utf8',
    );
    return;
  }

  const unixShimPath = join(projectRoot, 'codex');
  writeFileSync(unixShimPath, [
    '#!/usr/bin/env node',
    "require('./codex-json-shim.cjs');",
  ].join('\n'), 'utf8');
  chmodSync(unixShimPath, 0o755);
}
