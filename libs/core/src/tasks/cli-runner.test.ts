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

function createDirectCustomLatestContinuation(scriptPath: string, displayName = 'Custom CLI') {
  const normalizedScriptPath = scriptPath.replace(/\\/g, '/');
  return {
    displayName,
    type: 'exec-resume-session' as const,
    commandNames: ['node'],
    execCommand: normalizedScriptPath,
    resumeArgs: [normalizedScriptPath, 'resume'],
    promptStdinArg: '-',
    sessionIdSource: 'latest' as const,
  };
}

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

  it('keeps Direct CLI project documentation reference compact', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-direct-docs-budget',
      title: 'Use compact Direct docs',
      description: 'Direct CLI should avoid injecting the full project documentation pack.',
      metadata: { developmentMode: 'direct' },
    });
    const docsDir = join(projectRoot, dataDirName, 'project-docs');
    mkdirSync(docsDir, { recursive: true });
    const lineBreak = String.fromCharCode(10);
    const longDoc = (label: string) => [
      `# ${label}`,
      `## ${label} Reference`,
      ...Array.from({ length: 18 }, (_, index) => (
        `- ${label}_REFERENCE_BODY_${index}: ${'detail '.repeat(28)}`
      )),
    ].join(lineBreak);
    writeFileSync(join(docsDir, 'index.md'), longDoc('INDEX_DOC'), 'utf8');
    writeFileSync(join(docsDir, 'architecture.md'), longDoc('ARCHITECTURE_DOC'), 'utf8');
    writeFileSync(join(docsDir, 'technical.md'), [
      '# Technical',
      'TECHNICAL_REFERENCE_BODY_SHOULD_BE_EXCLUDED',
      ...Array.from({ length: 12 }, (_, index) => `- technical detail ${index} ${'x '.repeat(30)}`),
    ].join(lineBreak), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-direct-docs-budget',
      cli: 'codex',
      phase: 'direct',
    });

    expect(plan.prompt).toContain('INDEX_DOC_REFERENCE_BODY_0');
    expect(plan.prompt).toContain('ARCHITECTURE_DOC_REFERENCE_BODY_0');
    expect(plan.prompt).not.toContain('TECHNICAL_REFERENCE_BODY_SHOULD_BE_EXCLUDED');
  });

  it('uses configured Direct CLI task-run strategy for custom routes', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-direct-custom-task-run-strategy',
      title: 'Run future CLI through route strategy',
      description: 'Direct CLI should not require hardcoded command args for future providers.',
      metadata: { developmentMode: 'direct' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-direct-custom-task-run-strategy',
      cli: 'custom',
      customCommand: 'future-code --profile team',
      model: 'future-large',
      bypassPermissions: true,
      directCliPermissionBypassArgs: ['--future-allow'],
      directCliTaskRunStrategy: {
        args: ['run', '--json'],
        modelFlag: '--model',
        promptStdinArg: '--stdin',
      },
      phase: 'direct',
    });

    expect(plan.command).toBe('future-code');
    expect(plan.args).toEqual([
      '--profile',
      'team',
      'run',
      '--json',
      '--model',
      'future-large',
      '--future-allow',
      '--stdin',
    ]);
  });
  it('generates a shell-free Windows spawn wrapper for Direct CLI runs', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-direct-windows-spawn-wrapper',
      title: 'Run Direct CLI without shell args warning',
      description: 'Direct CLI should avoid shell:true plus args on Windows while preserving cmd shims.',
      metadata: { developmentMode: 'direct' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-direct-windows-spawn-wrapper',
      cli: 'future-code',
      phase: 'direct',
    });
    const runner = readFileSync(plan.runnerFilePath, 'utf8');

    expect(runner).toContain('function spawnCli(commandValue, argValues, options)');
    expect(runner).toContain('function resolveWindowsCliCommand(commandText)');
    expect(runner).toContain('windowsVerbatimArguments: true');
    expect(runner).toContain("shell: false");
    expect(runner).not.toContain("shell: process.platform === 'win32'");
    expect(runner).toContain('const child = spawnCli(invocation.command, invocation.args, {');
    expect(runner).toContain('const child = spawnCli(command, args, {');
  });

  it('prefers Windows .cmd shims over extensionless npm shims for Direct CLI runs', () => {
    if (process.platform !== 'win32') {
      return;
    }

    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-direct-windows-cmd-shim',
      title: 'Run Codex through npm cmd shim',
      description: 'Direct Codex should use codex.cmd when npm also leaves an extensionless codex shim.',
      metadata: { developmentMode: 'direct' },
    });

    writeFakeCodexJsonCommand(projectRoot, [
      { type: 'agent_message', session_id: 'codex-cmd-shim', message: 'Validation: cmd shim selected and passed.' },
      { type: 'turn_completed', session_id: 'codex-cmd-shim' },
    ]);
    writeFileSync(join(projectRoot, 'codex'), 'extensionless shim should not be spawned on Windows\n', 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-direct-windows-cmd-shim',
      cli: 'codex',
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GRAPHITI_ENABLED: 'false',
        PATH: `${projectRoot}${delimiter}${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(stdout).toContain('DIRECT_COMPLETED');
    expect(readFileSync(join(getAutocodeSpecDir({ projectRoot, dataDirName, specId: '001-direct-windows-cmd-shim' }), 'direct_summary.md'), 'utf8'))
      .toContain('cmd shim selected');
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
    expect(plan.prompt).toContain('canonical requirements artifact');
    expect(plan.prompt).toContain('Do not keep the only concrete Requirement Index inside tasks.md');
    expect(plan.prompt).toContain('reader-first');
    expect(plan.prompt).toContain('Conclusion Snapshot');
    expect(plan.prompt).toContain('Main Flow');
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
      metadata: { developmentMode: 'direct' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-zh-prompt',
      cli: 'codex',
      phase: 'direct',
      language: 'zh-CN',
    });
    const prompt = readFileSync(plan.promptFilePath, 'utf8');
    const runner = readFileSync(plan.runnerFilePath, 'utf8');

    expect(prompt).toContain('# Autocode 任务运行');
    expect(prompt).toContain('Task title: 复现Lumen全局光照');
    expect(prompt).toContain('## 语言');
    expect(prompt).toContain('## 目标');
    expect(prompt).toContain('## 任务描述');
    expect(prompt).toContain('## 必须遵循的流程');
    expect(prompt).toContain('简体中文');
    for (const damagedText of ['浠诲姟', '璇', '鐩爣', '蹇呴', '绠€', '鍒涘缓', '瑙勫垝']) {
      expect(prompt).not.toContain(damagedText);
    }

    expect(runner).toContain('runCliPreflightActions();');
    expect(runner).toContain('const cliPreflightActions = [{');
    expect(runner).toContain('"type":"strip-utf8-bom-from-rules"');
    expect(runner).toContain('function stripUtf8BomFromCliRuleFile(filePath, action)');
    expect(runner).toContain("Removed UTF-8 BOM from ' + label + ' file");
    expect(runner).toContain("label + ' file starts with a UTF-8 BOM");
    expect(runner).toContain('const cliJsonEventParsers = [{');
    expect(runner).toContain('"type":"codex-json"');
    expect(runner).toContain('function resolveCliJsonEventParser(command, args)');
    expect(runner).toContain('function handleGenericCliJsonToolEvent(payload, payloadType, state, handleUsage)');
    expect(runner).not.toContain("case 'codex-json'");
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
    expect(runner).toContain('requirements.md must include concrete User Requirements and Acceptance Criteria');
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
      '## User Requirements',
      '- R1: Planning validation keeps a traceable Standard task list.',
      '',
      '## Acceptance Criteria',
      '- AC1: Runtime work packages are derived from tasks.md after validation passes.',
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

  it('uses recent CLI error output as the final failure message on nonzero exit', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-cli-network-failure',
      title: 'Handle CLI transport failure',
      description: 'Surface the real CLI transport failure instead of a completed message.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '001-cli-network-failure',
    });
    const fakeCliPath = join(projectRoot, 'fail-cli-transport.cjs');
    writeFileSync(fakeCliPath, [
      "process.stderr.write('2026-06-23T01:04:17.346464Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: tls handshake eof, url: wss://chatgpt.com/backend-api/codex/responses\\n');",
      "process.stderr.write('stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)\\n');",
      'process.exit(1);',
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-cli-network-failure',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'planning',
    });

    let failed = false;
    try {
      execFileSync(process.execPath, [plan.runnerFilePath], {
        cwd: projectRoot,
        env: { ...process.env, GRAPHITI_ENABLED: 'false' },
        stdio: 'pipe',
        timeout: 15_000,
      });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status: string;
      message: string;
    };
    expect(result.status).toBe('error');
    expect(result.message).toContain('stream disconnected');
    expect(result.message).toContain('tls handshake eof');
    expect(result.message).not.toContain('Autocode CLI run completed');
    expect(result.message).not.toContain('Autocode CLI 运行完成');
    const logs = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');
    expect(logs).toContain('"status":"failed"');
    expect(logs).toContain('stream disconnected');
  });

  it('marks Codex usage limit failures as rate limited instead of generic CLI errors', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-codex-rate-limit',
      title: 'Handle Codex limit',
      description: 'Do not report OpenAI account limits as Claude failures.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '001-codex-rate-limit',
    });
    const limitMessage = "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Jul 25th, 2026 12:57 AM.";
    const fakeCliPath = join(projectRoot, 'fail-codex-rate-limit.cjs');
    writeFileSync(fakeCliPath, [
      `process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'error', message: limitMessage }) + '\n')});`,
      `process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'turn.failed', error: { message: limitMessage } }) + '\n')});`,
      'process.exit(1);',
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-codex-rate-limit',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    let failed = false;
    try {
      execFileSync(process.execPath, [plan.runnerFilePath], {
        cwd: projectRoot,
        env: { ...process.env, GRAPHITI_ENABLED: 'false' },
        stdio: 'pipe',
        timeout: 15_000,
      });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status: string;
      message: string;
    };
    expect(result.status).toBe('rate_limited');
    expect(result.message).toContain('Autocode CLI rate limited');
    expect(result.message).toContain('usage limit');
    expect(result.message).toContain('Codex');
    expect(result.message).not.toContain('Autocode CLI failed:');
  });

  it('localizes repaired Standard evidence scaffolding for zh-CN tasks', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-evidence-zh',
      title: '修复规划证据',
      description: '当 CLI 遗漏证据脚手架时继续规划。',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '001-standard-evidence-zh' });
    const requirementsMarkdown = [
      '# Requirements: 修复规划证据',
      '',
      '## User Requirements',
      '- R1: 标准规划校验应补齐证据脚手架。',
      '',
      '## Acceptance Criteria',
      '- AC1: 补齐 Evidence 后可以继续生成 implementation_plan.md。',
      '',
    ].join('\n');
    const specMarkdown = [
      '# Specification: 修复规划证据',
      '',
      '## Overview',
      '当生成的规格缺少 Evidence 时，标准规划校验应继续推进。',
      '',
      '## Requirements',
      '1. 标准规划校验在补齐 Evidence 后继续。',
      '',
      '## Success Criteria',
      '- [ ] 从 tasks.md 生成 implementation_plan.md。',
      '',
    ].join('\n');
    const tasksMarkdown = [
      '# Tasks',
      '',
      'Feature: 修复规划证据',
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
    const fakeCliPath = join(projectRoot, 'write-standard-artifacts-zh.cjs');
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
      taskId: '001-standard-evidence-zh',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}" "${specDir.replace(/\\/g, '/')}"`,
      phase: 'planning',
      language: 'zh-CN',
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    });

    const repairedSpec = readFileSync(join(specDir, 'spec.md'), 'utf8');
    expect(repairedSpec).toContain('## Evidence');
    expect(repairedSpec).toContain('requirements.md 记录了本任务的用户请求和规划约束。');
    expect(repairedSpec).toContain('tasks.md 将实现工作映射回生成的 Standard 需求。');
    expect(repairedSpec).not.toContain('requirements.md captures the user request');
    const repairedRequirements = readFileSync(join(specDir, 'requirements.md'), 'utf8');
    expect(repairedRequirements).toContain('## Evidence Sources');
    expect(repairedRequirements).toContain('Autocode 捕获的用户任务描述。');
    expect(repairedRequirements).toContain('spec.md 中的规划范围和成功标准。');
    expect(repairedRequirements).not.toContain('User task description captured by Autocode');
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
    expect(runner).toContain('state.lastCliMessageText = appendPlainCliMessageText');
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
      "process.stdin.on('end', () => { writeFileSync(process.argv[2], input, 'utf8'); process.stdout.write('Validation: prompt capture passed.\\n'); });",
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
      "  'Validation: memory notes extraction passed.',",
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

  it('does not add Codex /goal to direct-mode Codex CLI prompts by default', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '007-codex-direct',
      title: 'Send direct Codex prompt',
      description: 'Add a Direct mode Codex prompt regression test.',
      metadata: { developmentMode: 'direct' },
    });

    const capturedPromptPath = join(projectRoot, 'captured-codex-direct.txt');
    installFakeCodexCommand(projectRoot);

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '007-codex-direct',
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
    expect(firstLine).not.toMatch(/^\/goal\b/i);
    expect(firstLine).toBe('# Autocode Task Run');
    expect(capturedPrompt).toContain('Add a Direct mode Codex prompt regression test.');
    expect(capturedPrompt).toContain('# Autocode Task Run');
    expect(capturedPrompt).toContain('## Required Workflow');
  });

  it('warns before failing silent coding workers', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-worker-inactivity',
      title: 'Keep silent worker alive',
      description: 'Do not fail long-running model thinking after the first idle warning.',
      metadata: { developmentMode: 'standard' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-worker-inactivity',
      cli: 'codex',
      phase: 'coding',
    });
    const runner = readFileSync(plan.runnerFilePath, 'utf8');

    expect(runner).toContain('const CODING_WORKER_INACTIVITY_WARNING_MS = readNonNegativeInteger(');
    expect(runner).toContain('10 * 60 * 1000');
    expect(runner).toContain('45 * 60 * 1000');
    expect(runner).toContain('still waiting before timeout');
    expect(runner).toContain('AUTOCODE_WORKER_INACTIVITY_TIMEOUT_MS');
    expect(runner).not.toContain('const CODING_WORKER_INACTIVITY_TIMEOUT_MS = readPositiveInteger');
  });

  it('finalizes coding workers after a final summary when the CLI does not exit', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '009-worker-final-summary',
      title: 'Finalize completed worker',
      description: 'Treat a final work package summary as completion when the CLI process hangs.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '009-worker-final-summary',
    });
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Finalize completed worker',
      'Status: coding',
      'Execution Phase: coding',
      '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","subtaskMetadata":{"wp-1":{"work_package":true,"depends_on":[]}}} -->',
      '',
      '- [ ] 1. Implementation',
      '  - [ ] wp-1 Add start control',
      '',
    ].join('\n'), 'utf8');
    const fakeCliPath = join(projectRoot, 'coding-final-summary-hang.cjs');
    writeFileSync(fakeCliPath, [
      "process.chdir(require('node:os').tmpdir());",
      "process.stdin.resume();",
      "setTimeout(() => {",
      "  process.stdout.write('| 变更 | 验证 | 评审备注 |\\n');",
      "  process.stdout.write('| --- | --- | --- |\\n');",
      "  process.stdout.write('| Added Start game control | 通过：npm run build | 未改 implementation_plan.md |\\n');",
      "}, 10);",
      "setTimeout(() => process.exit(0), 4000);",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '009-worker-final-summary',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'coding',
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AUTOCODE_WORKER_COMPLETION_GRACE_MS: '50',
        AUTOCODE_WORKER_INACTIVITY_TIMEOUT_MS: '10000',
        GRAPHITI_ENABLED: 'false',
      },
      stdio: 'pipe',
      timeout: 15_000,
    });

    const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
    expect(rawPlan).toContain('- [x] wp-1 Add start control');
    const logs = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');
    expect(logs).toContain('finished model output but the CLI process did not exit; finalizing the work item.');
  });

  it('retries failed and blocked coding work packages on continue', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-coding-retry',
      title: 'Retry coding work packages',
      description: 'Continue a task with previously failed and blocked work packages.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-coding-retry' });
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Retry coding work packages',
      'Status: coding',
      'Execution Phase: coding',
      '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","subtaskMetadata":{"wp-1":{"work_package":true,"depends_on":[],"completed_at":"2026-06-20T00:00:00.000Z"},"wp-2":{"work_package":true,"depends_on":["wp-1"],"completed_at":"2026-06-20T00:00:00.000Z"}}} -->',
      '',
      '- [ ] 1. Implementation',
      '  - [!] wp-1 Retry failed prerequisite',
      '    - _Started: 2026-06-20T00:00:00.000Z_',
      '    - _Completed: 2026-06-20T00:00:00.000Z_',
      '  - [-] wp-2 Retry blocked dependent',
      '    - _Depends on: wp-1_',
      '    - _Started: 2026-06-20T00:00:00.000Z_',
      '    - _Completed: 2026-06-20T00:00:00.000Z_',
      '',
    ].join('\n'), 'utf8');
    const fakeCliPath = join(projectRoot, 'coding-success.cjs');
    const capturedPromptPath = join(projectRoot, 'coding-prompts.txt');
    writeFileSync(fakeCliPath, [
      "const { appendFileSync } = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => { appendFileSync(process.argv[2], input + '\\n---PROMPT---\\n', 'utf8'); });",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-coding-retry',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}" "${capturedPromptPath.replace(/\\/g, '/')}"`,
      phase: 'coding',
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    });

    const capturedPrompts = readFileSync(capturedPromptPath, 'utf8');
    expect(capturedPrompts).toContain('Work Package ID: wp-1');
    expect(capturedPrompts).toContain('Work Package ID: wp-2');
    const implementationPlan = loadAutocodeImplementationPlanSync(specDir);
    expect(implementationPlan?.phases?.[0]?.subtasks.map((subtask) => subtask.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('does not write completed_at for failed coding work packages', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-coding-failure',
      title: 'Fail one coding work package',
      description: 'Keep failed work package state retryable and incomplete.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-coding-failure' });
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Fail one coding work package',
      'Status: coding',
      'Execution Phase: coding',
      '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","subtaskMetadata":{"wp-1":{"work_package":true,"depends_on":[]}}} -->',
      '',
      '- [ ] 1. Implementation',
      '  - [ ] wp-1 Failing package',
      '',
    ].join('\n'), 'utf8');
    const fakeCliPath = join(projectRoot, 'coding-failure.cjs');
    writeFileSync(fakeCliPath, [
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', () => {});",
      "process.stdin.on('end', () => process.exit(1));",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-coding-failure',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'coding',
    });

    expect(() => execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    })).toThrow();

    const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
    expect(rawPlan).toContain('- [!] wp-1 Failing package');
    expect(rawPlan).not.toContain('_Completed:');
    const implementationPlan = loadAutocodeImplementationPlanSync(specDir);
    const subtask = implementationPlan?.phases?.[0]?.subtasks?.[0];
    expect(subtask?.status).toBe('failed');
    expect(subtask?.completed_at).toBeUndefined();
    expect(subtask?.notes).toContain('CLI work item run failed');
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
      { type: 'agent_message', session_id: 'codex-session', message: 'Validation: npm test passed.' },
    ]);

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-codex-usage',
      cli: 'custom',
      customCommand: 'codex --json',
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GRAPHITI_ENABLED: 'false',
        PATH: `${projectRoot}${delimiter}${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const implementationPlan = loadAutocodeImplementationPlanSync(
      join(specDir, 'implementation_plan.md'),
    );
    const directSession = JSON.parse(readFileSync(join(specDir, 'direct_session.json'), 'utf8')) as {
      sessionId?: string;
      iteration?: number;
      latestSummary?: string;
      lastOutcome?: string;
    };

    expect(implementationPlan?.tokenUsage).toEqual({
      promptTokens: 180,
      completionTokens: 40,
      totalTokens: 220,
      stepsExecuted: 1,
      sessionId: 'codex-session',
    });
    const directExecution = implementationPlan?.direct_execution as {
      outcome?: string;
      ai_coding_quality?: { mode?: string; validation?: { status?: string }; stepsExecuted?: number };
    } | undefined;
    expect(directExecution?.outcome).toBe('completed');
    expect(directExecution?.ai_coding_quality?.mode).toBe('direct');
    expect(directExecution?.ai_coding_quality?.validation?.status).toBe('reported_passed');
    expect(directExecution?.ai_coding_quality?.stepsExecuted).toBe(1);
    const directSubtask = implementationPlan?.phases?.[0]?.subtasks?.[0];
    expect(directSubtask?.id).toBe('direct-implementation');
    expect(directSubtask?.status).toBe('completed');
    expect(directSubtask?.completion_summary).toContain('Autocode CLI run completed');
    expect(directSession.sessionId).toBe('codex-session');
    expect(directSession.iteration).toBe(1);
    expect(directSession.latestSummary).toContain('Validation: npm test passed');
    expect(directSession.lastOutcome).toBe('success');
    expect(readFileSync(join(specDir, 'direct_summary.md'), 'utf8')).toContain('Validation: npm test passed');
    expect(stdout).toContain('__TASK_EVENT__:');
    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    expect(stdout).toContain('"quality":{"mode":"direct"');
  });

  it('records changed files from Direct CLI git baseline', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-changed-files',
      title: 'Record Direct changed files',
      description: 'Direct CLI should report files changed by the run.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-changed-files' });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    const fakeCliPath = join(projectRoot, 'write-direct-file.cjs');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const projectRoot = process.cwd();',
      "mkdirSync(join(projectRoot, 'src'), { recursive: true });",
      "writeFileSync(join(projectRoot, 'src', 'direct-output.ts'), 'export const directOutput = true;\\n', 'utf8');",
      "process.stdout.write('Implemented Direct CLI file write.\\nValidation: npm test passed.\\n');",
    ].join(String.fromCharCode(10)), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-changed-files',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const implementationPlan = loadAutocodeImplementationPlanSync(specDir);
    const directExecution = implementationPlan?.direct_execution as {
      ai_coding_quality?: { changedFiles?: string[]; filesChanged?: number; validation?: { status?: string } };
    } | undefined;
    expect(directExecution?.ai_coding_quality?.changedFiles).toEqual(['src/direct-output.ts']);
    expect(directExecution?.ai_coding_quality?.filesChanged).toBe(1);
    expect(directExecution?.ai_coding_quality?.validation?.status).toBe('reported_passed');
    const directSubtask = implementationPlan?.phases?.[0]?.subtasks?.[0];
    expect(directSubtask?.id).toBe('direct-implementation');
    expect(directSubtask?.status).toBe('completed');
    expect(directSubtask?.completion_summary).toContain('Autocode CLI run completed');
    const directSession = JSON.parse(readFileSync(join(specDir, 'direct_session.json'), 'utf8')) as {
      changedFiles?: string[];
    };
    expect(directSession.changedFiles).toEqual(['src/direct-output.ts']);
    expect(stdout).toContain('"filesChanged":1');
    expect(stdout).toContain('"changedFiles":["src/direct-output.ts"]');
  });
  it('retries Direct CLI quality gate failures before reporting completion', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-retry',
      title: 'Retry failed Direct validation',
      description: 'Direct CLI should retry quality gate failures with corrective feedback.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-retry' });
    const fakeCliPath = join(projectRoot, 'direct-retry-cli.cjs');
    const attemptPath = join(projectRoot, 'direct-retry-attempt.txt');
    const promptPath = join(projectRoot, 'direct-retry-prompt.txt');
    const escapedSpecDir = specDir.replace(/\\/g, '\\\\');
    const escapedAttemptPath = attemptPath.replace(/\\/g, '\\\\');
    const escapedPromptPath = promptPath.replace(/\\/g, '\\\\');
    writeFileSync(fakeCliPath, [
      "const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const promptPath = '${escapedPromptPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  writeFileSync(promptPath, stdin, 'utf8');",
      "  mkdirSync(specDir, { recursive: true });",
      "  if (attempt === 1) {",
      "    writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 1 summary. Validation: npm test failed.\\n', 'utf8');",
      "    process.stdout.write('Implemented the first idea.\\nValidation: npm test failed.\\n');",
      "    return;",
      "  }",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 2 summary. Validation: npm test passed.\\n', 'utf8');",
      "  process.stdout.write('Reworked the fix after checking the diff.\\nValidation: npm test passed.\\n');",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-retry',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      directCliContinuationStrategy: createDirectCustomLatestContinuation(fakeCliPath),
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(readFileSync(attemptPath, 'utf8')).toBe('2');
    const retryPrompt = readFileSync(promptPath, 'utf8');
    expect(retryPrompt).toContain('Direct Validation Retry (2/3)');
    expect(retryPrompt).toContain('Validation: reported_failed');
    expect(stdout).toContain('Direct CLI output failed validation/quality gate');
    expect(stdout).toContain('Retrying attempt 2/3');
    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    expect(stdout).not.toContain('"type":"CODING_FAILED"');
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      exitCode?: number;
      attemptCount?: number;
      quality?: { validation?: { status?: string; reason?: string } };
    };
    expect(result.status).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(result.attemptCount).toBe(2);
    expect(result.quality?.validation?.status).toBe('reported_passed');
    expect(result.quality?.validation?.reason).toContain('npm test passed');
    expect(readFileSync(join(specDir, 'direct_summary.md'), 'utf8')).toContain('Attempt 2 summary');
    expect(readFileSync(join(specDir, 'direct_summary.md'), 'utf8')).not.toContain('Attempt 1 summary');
  });

  it('fails Direct CLI retry when no continuation strategy can keep the same session', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-retry-missing-session',
      title: 'Fail Direct retry without session continuation',
      description: 'Direct CLI should not retry in a fresh model session when no continuation strategy is configured.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-retry-missing-session' });
    const fakeCliPath = join(projectRoot, 'direct-retry-missing-session-cli.cjs');
    const attemptPath = join(projectRoot, 'direct-retry-missing-session-attempt.txt');
    const escapedSpecDir = specDir.replace(/\\/g, '\\\\');
    const escapedAttemptPath = attemptPath.replace(/\\/g, '\\\\');
    writeFileSync(fakeCliPath, [
      "const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  mkdirSync(specDir, { recursive: true });",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt ' + attempt + ' summary. Validation: npm test failed.\\n', 'utf8');",
      "  process.stdout.write('Attempt ' + attempt + ' finished. Validation: npm test failed.\\n');",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-retry-missing-session',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    let failed = false;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
        cwd: projectRoot,
        env: { ...process.env, GRAPHITI_ENABLED: 'false' },
        encoding: 'utf8',
        timeout: 15_000,
      });
    } catch (error) {
      failed = true;
      stdout = String((error as { stdout?: string | Buffer }).stdout ?? '');
    }

    expect(failed).toBe(true);
    expect(readFileSync(attemptPath, 'utf8')).toBe('1');
    expect(stdout).toContain('Direct CLI retry requires a configured continuation strategy');
    expect(stdout).toContain('"type":"CODING_FAILED"');
    expect(stdout).not.toContain('"type":"DIRECT_COMPLETED"');
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      exitCode?: number;
      attemptCount?: number;
      message?: string;
    };
    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(1);
    expect(result.attemptCount).toBe(1);
    expect(result.message).toContain('same model session');
  });

  it('retries Direct CLI transient non-zero failures before reporting failure', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-transient-exit-retry',
      title: 'Retry transient Direct CLI exit',
      description: 'Direct CLI should retry transient provider exits with corrective feedback.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-transient-exit-retry' });
    const fakeCliPath = join(projectRoot, 'direct-transient-exit-cli.cjs');
    const attemptPath = join(projectRoot, 'direct-transient-exit-attempt.txt');
    const promptPath = join(projectRoot, 'direct-transient-exit-prompts.txt');
    const escapedSpecDir = specDir.replace(/\\/g, '\\\\');
    const escapedAttemptPath = attemptPath.replace(/\\/g, '\\\\');
    const escapedPromptPath = promptPath.replace(/\\/g, '\\\\');
    writeFileSync(fakeCliPath, [
      "const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const promptPath = '${escapedPromptPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  appendFileSync(promptPath, '\\n---PROMPT ' + attempt + '---\\n' + stdin, 'utf8');",
      "  mkdirSync(specDir, { recursive: true });",
      "  if (attempt === 1) {",
      "    process.stderr.write('ERROR stream disconnected before completion\\n');",
      "    process.exit(1);",
      "    return;",
      "  }",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 2 summary. Validation: npm test passed.\\n', 'utf8');",
      "  process.stdout.write('Recovered after transient provider failure.\\nValidation: npm test passed.\\n');",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-transient-exit-retry',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      directCliContinuationStrategy: createDirectCustomLatestContinuation(fakeCliPath),
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(readFileSync(attemptPath, 'utf8')).toBe('2');
    const retryPrompts = readFileSync(promptPath, 'utf8');
    expect(retryPrompts).toContain('Direct Validation Retry (2/3)');
    expect(retryPrompts).toContain('exited before completion or returned an error');
    expect(retryPrompts).toContain('stream disconnected before completion');
    expect(stdout).toContain('Direct CLI attempt failed before completion');
    expect(stdout).toContain('Retrying attempt 2/3');
    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    expect(stdout).not.toContain('"type":"CODING_FAILED"');
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      exitCode?: number;
      attemptCount?: number;
      quality?: { validation?: { status?: string; reason?: string } };
    };
    expect(result.status).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(result.attemptCount).toBe(2);
    expect(result.quality?.validation?.status).toBe('reported_passed');
    expect(readFileSync(join(specDir, 'direct_summary.md'), 'utf8')).toContain('Attempt 2 summary');
  });
  it('adds a repeated failure guard to Direct CLI retry prompts after the same quality failure repeats', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-repeated-failure',
      title: 'Avoid repeated Direct CLI retry idea',
      description: 'Direct CLI should change strategy when the same validation failure repeats.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-repeated-failure' });
    const fakeCliPath = join(projectRoot, 'direct-repeated-failure-cli.cjs');
    const attemptPath = join(projectRoot, 'direct-repeated-failure-attempt.txt');
    const promptPath = join(projectRoot, 'direct-repeated-failure-prompts.txt');
    const escapedSpecDir = specDir.replace(/\\/g, '\\\\');
    const escapedAttemptPath = attemptPath.replace(/\\/g, '\\\\');
    const escapedPromptPath = promptPath.replace(/\\/g, '\\\\');
    writeFileSync(fakeCliPath, [
      "const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const promptPath = '${escapedPromptPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  appendFileSync(promptPath, '\\n---PROMPT ' + attempt + '---\\n' + stdin, 'utf8');",
      "  mkdirSync(specDir, { recursive: true });",
      "  if (attempt < 3) {",
      "    writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt ' + attempt + ' summary. Validation: npm test failed with SAME_ASSERTION.\\n', 'utf8');",
      "    process.stdout.write('Attempt ' + attempt + ' followed the same idea.\\nValidation: npm test failed with SAME_ASSERTION.\\n');",
      "    return;",
      "  }",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 3 summary. Validation: npm test passed.\\n', 'utf8');",
      "  process.stdout.write('Attempt 3 changed strategy.\\nValidation: npm test passed.\\n');",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-repeated-failure',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      directCliContinuationStrategy: createDirectCustomLatestContinuation(fakeCliPath),
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(readFileSync(attemptPath, 'utf8')).toBe('3');
    const retryPrompts = readFileSync(promptPath, 'utf8');
    expect(retryPrompts).toContain('---PROMPT 3---');
    expect(retryPrompts).toContain('Repeated failure guard: this failure matches an earlier Direct CLI attempt');
    expect(retryPrompts).toContain('choose a different strategy');
    expect(stdout).toContain('Retrying attempt 3/3');
    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      attemptCount?: number;
      status?: string;
      quality?: { validation?: { status?: string } };
    };
    expect(result.status).toBe('success');
    expect(result.attemptCount).toBe(3);
    expect(result.quality?.validation?.status).toBe('reported_passed');
  });
  it('fails Direct CLI after exhausting validation retry attempts', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-retry-exhausted',
      title: 'Fail exhausted Direct validation retries',
      description: 'Direct CLI should fail after three validation attempts instead of looping or reporting completion.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-retry-exhausted' });
    const fakeCliPath = join(projectRoot, 'direct-validation-retry-exhausted-cli.cjs');
    const attemptPath = join(projectRoot, 'direct-validation-retry-exhausted-attempt.txt');
    const promptPath = join(projectRoot, 'direct-validation-retry-exhausted-prompts.txt');
    const escapedSpecDir = specDir.replace(/\\/g, '\\\\');
    const escapedAttemptPath = attemptPath.replace(/\\/g, '\\\\');
    const escapedPromptPath = promptPath.replace(/\\/g, '\\\\');
    writeFileSync(fakeCliPath, [
      "const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const promptPath = '${escapedPromptPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  appendFileSync(promptPath, '\\n---PROMPT ' + attempt + '---\\n' + stdin, 'utf8');",
      "  mkdirSync(specDir, { recursive: true });",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt ' + attempt + ' summary. Validation: npm test failed with SAME_ASSERTION.\\n', 'utf8');",
      "  process.stdout.write('Attempt ' + attempt + ' kept failing.\\nValidation: npm test failed with SAME_ASSERTION.\\n');",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-retry-exhausted',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      directCliContinuationStrategy: createDirectCustomLatestContinuation(fakeCliPath),
      phase: 'direct',
    });

    let failed = false;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
        cwd: projectRoot,
        env: { ...process.env, GRAPHITI_ENABLED: 'false' },
        encoding: 'utf8',
        timeout: 15_000,
      });
    } catch (error) {
      failed = true;
      stdout = String((error as { stdout?: string | Buffer }).stdout ?? '');
    }

    expect(failed).toBe(true);
    expect(readFileSync(attemptPath, 'utf8')).toBe('3');
    const retryPrompts = readFileSync(promptPath, 'utf8');
    expect(retryPrompts).toContain('Direct Validation Retry (2/3)');
    expect(retryPrompts).toContain('Direct Validation Retry (3/3)');
    expect(retryPrompts).toContain('Repeated failure guard: this failure matches an earlier Direct CLI attempt');
    expect(stdout).toContain('Retrying attempt 3/3');
    expect(stdout).not.toContain('Retrying attempt 4/3');
    expect(stdout).toContain('"type":"CODING_FAILED"');
    expect(stdout).not.toContain('"type":"DIRECT_COMPLETED"');
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      exitCode?: number;
      attemptCount?: number;
      message?: string;
      quality?: { validation?: { status?: string; reason?: string } };
    };
    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(1);
    expect(result.attemptCount).toBe(3);
    expect(result.message).toContain('Direct validation reported_failed');
    expect(result.quality?.validation?.status).toBe('reported_failed');
    expect(result.quality?.validation?.reason).toContain('SAME_ASSERTION');
    const directSession = JSON.parse(readFileSync(join(specDir, 'direct_session.json'), 'utf8')) as {
      lastOutcome?: string;
      latestSummary?: string;
    };
    expect(directSession.lastOutcome).toBe('error');
    expect(directSession.latestSummary).toContain('SAME_ASSERTION');
  });

  it('allows documentation Direct CLI runs without validation evidence', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-doc-validation-optional',
      title: 'Write Direct documentation summary',
      description: 'Direct CLI documentation work should not require code validation evidence.',
      metadata: { developmentMode: 'direct', category: 'documentation' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-doc-validation-optional' });
    const fakeCliPath = join(projectRoot, 'direct-doc-validation-optional-cli.cjs');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const specDir = '${specDir.replace(/\\/g, '\\\\')}';`,
      "mkdirSync(specDir, { recursive: true });",
      "writeFileSync(join(specDir, 'direct_summary.md'), 'Documentation summary completed.\\n', 'utf8');",
      "process.stdout.write('Documentation summary completed.\\n');",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-doc-validation-optional',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      attemptCount?: number;
      quality?: { validation?: { status?: string } };
    };
    expect(result.status).toBe('success');
    expect(result.attemptCount).toBe(1);
    expect(result.quality?.validation?.status).toBe('not_run');
  });

  it('allows analysis Direct CLI runs without validation evidence based on task text', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-analysis-validation-optional',
      title: 'Analyze Direct pause reason',
      description: 'Analyze Direct task validation errors and explain why npm test failed.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-analysis-validation-optional' });
    const fakeCliPath = join(projectRoot, 'direct-analysis-validation-optional-cli.cjs');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const specDir = '${specDir.replace(/\\/g, '\\\\')}';`,
      "mkdirSync(specDir, { recursive: true });",
      "writeFileSync(join(specDir, 'direct_summary.md'), 'Analysis completed. Root cause: stale runtime state before selecting runnable work.\\n', 'utf8');",
      "process.stdout.write('Analysis completed. Root cause: stale runtime state before selecting runnable work.\\n');",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-analysis-validation-optional',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      attemptCount?: number;
      quality?: { validation?: { status?: string } };
    };
    expect(result.status).toBe('success');
    expect(result.attemptCount).toBe(1);
    expect(result.quality?.validation?.status).toBe('not_run');
  });
  it('accepts Direct CLI validation success reported only in Chinese', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-zh',
      title: 'Require Chinese Direct validation evidence',
      description: 'Direct CLI should recognize Chinese validation success evidence.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-zh' });
    const fakeCliPath = join(projectRoot, 'direct-validation-zh-cli.cjs');
    const escapedSpecDir = specDir.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const validationLine = '\u9a8c\u8bc1\u901a\u8fc7\uff0c\u65e0\u9519\u8bef\u3002';
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const specDir = '${escapedSpecDir}';`,
      `const validationLine = '${validationLine}';`,
      "mkdirSync(specDir, { recursive: true });",
      "writeFileSync(join(specDir, 'direct_summary.md'), validationLine + '\\n', 'utf8');",
      "process.stdout.write(validationLine + '\\n');",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-zh',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    expect(stdout).not.toContain('"type":"CODING_FAILED"');
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      attemptCount?: number;
      quality?: { validation?: { status?: string; reason?: string } };
    };
    expect(result.status).toBe('success');
    expect(result.attemptCount).toBe(1);
    expect(result.quality?.validation?.status).toBe('reported_passed');
    expect(result.quality?.validation?.reason).toContain(validationLine);
  });
  it('accepts Direct CLI render confirmation without retry continuation', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-render-confirmation',
      title: 'Accept render-confirmed Direct validation',
      description: 'Direct CLI should not retry a completed run when validation confirms the page loads.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-render-confirmation' });
    const fakeCliPath = join(projectRoot, 'direct-render-confirmation-cli.cjs');
    const escapedSpecDir = specDir.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const validationLine = '\u9a8c\u8bc1\u5df2\u8fd0\u884c `node --check game.js`\uff0c\u5e76\u7528 Chrome \u65e0\u5934\u6a21\u5f0f\u751f\u6210\u6e32\u67d3\u622a\u56fe\u786e\u8ba4\u9875\u9762\u53ef\u52a0\u8f7d\u3002';
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const specDir = '${escapedSpecDir}';`,
      `const validationLine = '${validationLine}';`,
      "mkdirSync(specDir, { recursive: true });",
      "writeFileSync(join(specDir, 'direct_summary.md'), validationLine + '\\n', 'utf8');",
      "process.stdout.write(validationLine + '\\n');",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-render-confirmation',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    expect(stdout).not.toContain('Direct CLI retry requires a usable continuation strategy');
    expect(stdout).not.toContain('"type":"CODING_FAILED"');
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      exitCode?: number;
      attemptCount?: number;
      quality?: { validation?: { status?: string; reason?: string } };
    };
    expect(result.status).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(result.attemptCount).toBe(1);
    expect(result.quality?.validation?.status).toBe('reported_passed');
  });
  it('accepts Direct CLI validation success phrased as zero failures', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-zero-failures',
      title: 'Accept zero-failure Direct validation',
      description: 'Direct CLI should treat zero failures and no errors as successful validation evidence.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-zero-failures' });
    const fakeCliPath = join(projectRoot, 'direct-validation-zero-failures-cli.cjs');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const specDir = '${specDir.replace(/\\/g, '\\\\')}';`,
      "mkdirSync(specDir, { recursive: true });",
      "writeFileSync(join(specDir, 'direct_summary.md'), 'Validation: npm test completed with 0 failed tests and no errors.\\n', 'utf8');",
      "process.stdout.write('Validation: npm test completed with 0 failed tests and no errors.\\n');",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-zero-failures',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    expect(stdout).not.toContain('Direct CLI output failed validation/quality gate');
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      attemptCount?: number;
      quality?: { validation?: { status?: string; reason?: string } };
    };
    expect(result.status).toBe('success');
    expect(result.attemptCount).toBe(1);
    expect(result.quality?.validation?.status).toBe('reported_passed');
    expect(result.quality?.validation?.reason).toContain('0 failed tests');
  });
  it('retries Direct CLI implementation runs with ambiguous validation evidence', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-ambiguous',
      title: 'Require conclusive Direct validation evidence',
      description: 'Direct CLI should retry implementation runs that only mention validation without a result.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-ambiguous' });
    const fakeCliPath = join(projectRoot, 'direct-validation-ambiguous-cli.cjs');
    const attemptPath = join(projectRoot, 'direct-validation-ambiguous-attempt.txt');
    const promptPath = join(projectRoot, 'direct-validation-ambiguous-prompt.txt');
    const escapedSpecDir = specDir.replace(/\\/g, '\\\\');
    const escapedAttemptPath = attemptPath.replace(/\\/g, '\\\\');
    const escapedPromptPath = promptPath.replace(/\\/g, '\\\\');
    writeFileSync(fakeCliPath, [
      "const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const promptPath = '${escapedPromptPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  writeFileSync(promptPath, stdin, 'utf8');",
      "  mkdirSync(specDir, { recursive: true });",
      "  if (attempt === 1) {",
      "    writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 1 summary. Validation: npm test.\\n', 'utf8');",
      "    process.stdout.write('Implemented the first idea.\\nValidation: npm test.\\n');",
      "    return;",
      "  }",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 2 summary. Validation: npm test passed.\\n', 'utf8');",
      "  process.stdout.write('Added conclusive verification evidence.\\nValidation: npm test passed.\\n');",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-ambiguous',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      directCliContinuationStrategy: createDirectCustomLatestContinuation(fakeCliPath),
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(readFileSync(attemptPath, 'utf8')).toBe('2');
    const retryPrompt = readFileSync(promptPath, 'utf8');
    expect(retryPrompt).toContain('Direct Validation Retry (2/3)');
    expect(retryPrompt).toContain('Validation: reported');
    expect(stdout).toContain('Direct CLI output failed validation/quality gate');
    expect(stdout).toContain('Direct validation reported');
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      attemptCount?: number;
      quality?: { validation?: { status?: string } };
    };
    expect(result.status).toBe('success');
    expect(result.attemptCount).toBe(2);
    expect(result.quality?.validation?.status).toBe('reported_passed');
  });
  it('retries Direct CLI implementation runs that report no validation evidence', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-required',
      title: 'Require Direct validation evidence',
      description: 'Direct CLI should retry implementation runs that do not report validation.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-required' });
    const fakeCliPath = join(projectRoot, 'direct-validation-required-cli.cjs');
    const attemptPath = join(projectRoot, 'direct-validation-required-attempt.txt');
    const promptPath = join(projectRoot, 'direct-validation-required-prompt.txt');
    const escapedSpecDir = specDir.replace(/\\/g, '\\\\');
    const escapedAttemptPath = attemptPath.replace(/\\/g, '\\\\');
    const escapedPromptPath = promptPath.replace(/\\/g, '\\\\');
    writeFileSync(fakeCliPath, [
      "const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const promptPath = '${escapedPromptPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  writeFileSync(promptPath, stdin, 'utf8');",
      "  mkdirSync(specDir, { recursive: true });",
      "  if (attempt === 1) {",
      "    writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 1 summary.\\n', 'utf8');",
      "    process.stdout.write('Implemented the first idea.\\n');",
      "    return;",
      "  }",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 2 summary. Validation: npm test passed.\\n', 'utf8');",
      "  process.stdout.write('Added missing verification evidence.\\nValidation: npm test passed.\\n');",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-required',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      directCliContinuationStrategy: createDirectCustomLatestContinuation(fakeCliPath),
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(readFileSync(attemptPath, 'utf8')).toBe('2');
    const retryPrompt = readFileSync(promptPath, 'utf8');
    expect(retryPrompt).toContain('Direct Validation Retry (2/3)');
    expect(retryPrompt).toContain('Validation: not_run');
    expect(stdout).toContain('Direct CLI output failed validation/quality gate');
    expect(stdout).toContain('Direct validation not_run');
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      attemptCount?: number;
      quality?: { validation?: { status?: string } };
    };
    expect(result.status).toBe('success');
    expect(result.attemptCount).toBe(2);
    expect(result.quality?.validation?.status).toBe('reported_passed');
  });
  it('uses configured custom Direct CLI continuation strategy when retrying quality failures', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-retry-custom-session',
      title: 'Retry Direct validation in configured custom CLI session',
      description: 'Direct CLI should use route-provided continuation strategy for custom runners.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-retry-custom-session' });
    const fakeCliPath = join(projectRoot, 'custom-session-retry-cli.cjs');
    const attemptPath = join(projectRoot, 'custom-session-retry-attempt.txt');
    const argvPath = join(projectRoot, 'custom-session-retry-argv.jsonl');
    const escapedSpecDir = specDir.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedAttemptPath = attemptPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedArgvPath = argvPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const normalizedFakeCliPath = fakeCliPath.split(String.fromCharCode(92)).join('/');
    writeFileSync(fakeCliPath, [
      "const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const argvPath = '${escapedArgvPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      'const argv = process.argv.slice(2);',
      "appendFileSync(argvPath, JSON.stringify(argv) + '\\n', 'utf8');",
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  mkdirSync(specDir, { recursive: true });",
      "  if (attempt === 1) {",
      "    writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 1 summary. Validation: npm test failed.\\n', 'utf8');",
      "    process.stdout.write('Custom attempt 1 finished. Validation: npm test failed.\\n');",
      "    return;",
      "  }",
      "  if (argv[0] !== 'resume' || argv[1] !== 'latest' || argv[2] !== '-') {",
      "    process.stderr.write('Expected custom resume args, got ' + JSON.stringify(argv) + '\\n');",
      "    process.exit(2);",
      "    return;",
      "  }",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 2 summary. Validation: npm test passed.\\n', 'utf8');",
      "  process.stdout.write('Custom attempt 2 resumed and fixed it. Validation: npm test passed.\\n');",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-retry-custom-session',
      cli: 'custom',
      customCommand: `node "${normalizedFakeCliPath}"`,
      directCliContinuationStrategy: {
        displayName: 'Future CLI',
        type: 'exec-resume-session',
        commandNames: ['node'],
        execCommand: normalizedFakeCliPath,
        resumeArgs: [normalizedFakeCliPath, 'resume'],
        promptStdinArg: '-',
        sessionIdSource: 'latest',
      },
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const argvLines = readFileSync(argvPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    expect(argvLines[0]).toEqual([]);
    expect(argvLines[1]).toEqual(['resume', 'latest', '-']);
    expect(readFileSync(attemptPath, 'utf8')).toBe('2');
    expect(readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8')).toContain('Resuming Future CLI Direct session for retry: latest');
    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
  });
  it('uses configured JSON parser and argument template to resume future Direct CLI sessions', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-retry-custom-json-session',
      title: 'Retry Direct validation in configured JSON session',
      description: 'Direct CLI should use configured JSON event fields for future providers.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-retry-custom-json-session' });
    const fakeCliPath = join(projectRoot, 'future-json-session-retry-cli.cjs');
    const attemptPath = join(projectRoot, 'future-json-session-retry-attempt.txt');
    const argvPath = join(projectRoot, 'future-json-session-retry-argv.jsonl');
    const escapedSpecDir = specDir.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedAttemptPath = attemptPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedArgvPath = argvPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const normalizedFakeCliPath = fakeCliPath.split(String.fromCharCode(92)).join('/');
    writeFileSync(fakeCliPath, [
      "const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const argvPath = '${escapedArgvPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      'const argv = process.argv.slice(2);',
      "appendFileSync(argvPath, JSON.stringify(argv) + '\\n', 'utf8');",
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  mkdirSync(specDir, { recursive: true });",
      "  if (attempt === 1) {",
      "    writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 1 summary. Validation: npm test failed.\\n', 'utf8');",
      "    process.stdout.write(JSON.stringify({ kind: 'session', conversation_id: 'future-session', message: 'Attempt 1 done. Validation: npm test failed.' }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ kind: 'done' }) + '\\n');",
      "    return;",
      "  }",
      "  const expected = ['resume', '--session', 'future-session', '--model', 'future-large', '-'];",
      "  if (JSON.stringify(argv) !== JSON.stringify(expected)) {",
      "    process.stderr.write('Expected future session resume args, got ' + JSON.stringify(argv) + '\\n');",
      "    process.exit(2);",
      "    return;",
      "  }",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 2 summary. Validation: npm test passed.\\n', 'utf8');",
      "  process.stdout.write(JSON.stringify({ kind: 'message', message: 'Attempt 2 fixed it. Validation: npm test passed.' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ kind: 'done' }) + '\\n');",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-retry-custom-json-session',
      cli: 'custom',
      customCommand: `node "${normalizedFakeCliPath}"`,
      model: 'future-large',
      directCliRuntimeRouteId: 'future-direct-cli',
      directCliRuntimeRouteDisplayName: 'Future CLI',
      directCliJsonEventParser: {
        type: 'future-json',
        displayName: 'Future JSON',
        commandNames: ['node'],
        sessionIdFields: ['conversation_id'],
        messageFields: ['message'],
        eventTypeFields: ['kind'],
        completionEventTypes: ['done'],
      },
      directCliContinuationStrategy: {
        displayName: 'Future JSON CLI',
        type: 'argument-template',
        commandNames: ['node'],
        requiresJsonMode: true,
        jsonEventParser: 'future-json',
        argsTemplate: ['{passthroughArgs}', 'resume', '--session', '{sessionId}', '--model', '{modelId}', '{promptStdinArg}'],
        promptStdinArg: '-',
        sessionIdSource: 'json-event-session',
      },
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const argvLines = readFileSync(argvPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    expect(argvLines[0]).toEqual([]);
    expect(argvLines[1]).toEqual(['resume', '--session', 'future-session', '--model', 'future-large', '-']);
    expect(readFileSync(attemptPath, 'utf8')).toBe('2');
    expect(readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8')).toContain('Continuing Future JSON CLI Direct session for retry: future-session.');
    expect(stdout).toContain('Attempt 2 fixed it. Validation: npm test passed.');
    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    const directSession = JSON.parse(readFileSync(join(specDir, 'direct_session.json'), 'utf8')) as {
      sessionId?: string;
      provider?: string;
      providerDisplayName?: string;
      modelId?: string;
      lastOutcome?: string;
    };
    expect(directSession.sessionId).toBe('future-session');
    expect(directSession.provider).toBe('future-direct-cli');
    expect(directSession.providerDisplayName).toBe('Future CLI');
    expect(directSession.modelId).toBe('future-large');
    expect(directSession.lastOutcome).toBe('success');
  });
  it('handles configured JSON tool events for future Direct CLIs without parser branches', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-custom-json-tool-events',
      title: 'Handle future JSON tool events',
      description: 'Direct CLI should parse configured future provider tool events without source-code branches.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-custom-json-tool-events' });
    const fakeCliPath = join(projectRoot, 'future-json-tool-events-cli.cjs');
    const escapedSpecDir = specDir.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const normalizedFakeCliPath = fakeCliPath.split(String.fromCharCode(92)).join('/');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const specDir = '${escapedSpecDir}';`,
      "mkdirSync(specDir, { recursive: true });",
      "writeFileSync(join(specDir, 'direct_summary.md'), 'Future tool events completed. Validation: npm test passed.\\n', 'utf8');",
      "process.stdout.write(JSON.stringify({ kind: 'tool_start', conversation_id: 'future-tool-session', tool: 'Inspect', input: 'src/app.ts', call: 'call-1' }) + '\\n');",
      "process.stdout.write(JSON.stringify({ kind: 'tool_finish', conversation_id: 'future-tool-session', tool: 'Inspect', result: 'ok', ok: true, call: 'call-1' }) + '\\n');",
      "process.stdout.write(JSON.stringify({ kind: 'message', conversation_id: 'future-tool-session', message: 'Future tool events completed. Validation: npm test passed.' }) + '\\n');",
      "process.stdout.write(JSON.stringify({ kind: 'done', conversation_id: 'future-tool-session' }) + '\\n');",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-custom-json-tool-events',
      cli: 'custom',
      customCommand: `node "${normalizedFakeCliPath}"`,
      model: 'future-large',
      directCliRuntimeRouteId: 'future-tool-direct-cli',
      directCliRuntimeRouteDisplayName: 'Future Tool CLI',
      directCliJsonEventParser: {
        type: 'future-tool-json',
        displayName: 'Future Tool JSON',
        commandNames: ['node'],
        eventTypeFields: ['kind'],
        sessionIdFields: ['conversation_id'],
        messageFields: ['message'],
        completionEventTypes: ['done'],
        toolStartEventTypes: ['tool_start'],
        toolEndEventTypes: ['tool_finish'],
        toolNameFields: ['tool'],
        toolInputFields: ['input'],
        toolOutputFields: ['result'],
        toolCallIdFields: ['call'],
        toolSuccessFields: ['ok'],
      },
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(stdout).toContain('Future tool events completed. Validation: npm test passed.');
    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    const logs = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');
    expect(logs).toContain('Tool started: Inspect');
    expect(logs).toContain('Tool output: Inspect');
    expect(logs).toContain('"tool_call_id":"call-1"');
    const directSession = JSON.parse(readFileSync(join(specDir, 'direct_session.json'), 'utf8')) as {
      sessionId?: string;
      provider?: string;
      providerDisplayName?: string;
      modelId?: string;
      lastOutcome?: string;
    };
    expect(directSession.sessionId).toBe('future-tool-session');
    expect(directSession.provider).toBe('future-tool-direct-cli');
    expect(directSession.providerDisplayName).toBe('Future Tool CLI');
    expect(directSession.modelId).toBe('future-large');
    expect(directSession.lastOutcome).toBe('success');
  });
  it('finalizes configured JSON Direct CLI attempts after completion events when the process stays open', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-custom-json-completion-hang',
      title: 'Finalize custom JSON Direct completion',
      description: 'Direct CLI should trust configured JSON completion events for future providers.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-custom-json-completion-hang' });
    const fakeCliPath = join(projectRoot, 'future-json-completion-hang-cli.cjs');
    const escapedProjectRoot = projectRoot.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedSpecDir = specDir.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const normalizedFakeCliPath = fakeCliPath.split(String.fromCharCode(92)).join('/');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const projectRoot = '${escapedProjectRoot}';`,
      `const specDir = '${escapedSpecDir}';`,
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  mkdirSync(specDir, { recursive: true });",
      "  writeFileSync(join(projectRoot, 'future-output.txt'), 'done', 'utf8');",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Implemented future JSON CLI completion. Validation: npm test passed.\\n', 'utf8');",
      "  process.stdout.write(JSON.stringify({ kind: 'message', conversation_id: 'future-hang-session', message: 'Implemented future JSON CLI completion. Validation: npm test passed.' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ kind: 'done' }) + '\\n');",
      "  setInterval(() => {}, 1000);",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-custom-json-completion-hang',
      cli: 'custom',
      customCommand: `node "${normalizedFakeCliPath}"`,
      model: 'future-large',
      directCliRuntimeRouteId: 'future-direct-cli',
      directCliRuntimeRouteDisplayName: 'Future CLI',
      directCliJsonEventParser: {
        type: 'future-json',
        displayName: 'Future JSON',
        commandNames: ['node'],
        sessionIdFields: ['conversation_id'],
        messageFields: ['message'],
        eventTypeFields: ['kind'],
        completionEventTypes: ['done'],
      },
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AUTOCODE_DIRECT_COMPLETION_GRACE_MS: '50',
        GRAPHITI_ENABLED: 'false',
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(stdout).toContain('Implemented future JSON CLI completion. Validation: npm test passed.');
    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    expect(readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8')).toContain(
      'Future JSON Direct CLI emitted completion event but the process did not exit; finalizing the Direct attempt.',
    );
    expect(readFileSync(join(projectRoot, 'future-output.txt'), 'utf8')).toBe('done');
    const directSession = JSON.parse(readFileSync(join(specDir, 'direct_session.json'), 'utf8')) as {
      sessionId?: string;
      provider?: string;
      providerDisplayName?: string;
      modelId?: string;
      lastOutcome?: string;
    };
    expect(directSession.sessionId).toBe('future-hang-session');
    expect(directSession.provider).toBe('future-direct-cli');
    expect(directSession.providerDisplayName).toBe('Future CLI');
    expect(directSession.modelId).toBe('future-large');
    expect(directSession.lastOutcome).toBe('success');
  });

  it('fails silent Direct CLI attempts with an inactivity timeout instead of hanging', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-inactivity-timeout',
      title: 'Fail silent Direct CLI',
      description: 'Direct CLI should not hang forever when a provider process emits no output.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-inactivity-timeout' });
    const fakeCliPath = join(projectRoot, 'direct-silent-hang.cjs');
    writeFileSync(fakeCliPath, [
      'process.stdin.resume();',
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-inactivity-timeout',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    let error: unknown;
    try {
      execFileSync(process.execPath, [plan.runnerFilePath], {
        cwd: projectRoot,
        env: {
          ...process.env,
          AUTOCODE_DIRECT_INACTIVITY_WARNING_MS: '20',
          AUTOCODE_DIRECT_INACTIVITY_TIMEOUT_MS: '80',
          GRAPHITI_ENABLED: 'false',
        },
        encoding: 'utf8',
        timeout: 5_000,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeTruthy();
    const logs = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');
    expect(logs).toContain('Direct attempt produced no output');
    expect(logs).toContain('still waiting before timeout');
    expect(logs).toContain('marking it failed');
    const runResult = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      message?: string;
      exitCode?: number;
    };
    expect(runResult.status).toBe('error');
    expect(runResult.exitCode).toBe(1);
    expect(runResult.message).toContain('Direct attempt produced no output');
  });
  it('resumes the same Codex exec session when retrying Direct quality failures', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-retry-codex-session',
      title: 'Retry Direct validation in same Codex session',
      description: 'Direct CLI should resume the original Codex exec session for retry attempts.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-retry-codex-session' });
    const shimPath = join(projectRoot, 'codex-session-retry-shim.cjs');
    const attemptPath = join(projectRoot, 'codex-session-retry-attempt.txt');
    const argvPath = join(projectRoot, 'codex-session-retry-argv.jsonl');
    const escapedSpecDir = specDir.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedAttemptPath = attemptPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedArgvPath = argvPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    writeFileSync(shimPath, [
      "const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const argvPath = '${escapedArgvPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      'const argv = process.argv.slice(2);',
      "appendFileSync(argvPath, JSON.stringify(argv) + '\\n', 'utf8');",
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  mkdirSync(specDir, { recursive: true });",
      "  if (attempt === 1) {",
      "    writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 1 summary. Validation: npm test failed.\\n', 'utf8');",
      "    process.stdout.write(JSON.stringify({ type: 'session_configured', session_id: 'codex-session-retry' }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ type: 'agent_message', message: 'Attempt 1 done. Validation: npm test failed.' }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ type: 'turn_completed' }) + '\\n');",
      "    return;",
      "  }",
      "  const resumed = argv[0] === 'exec' && argv[1] === 'resume' && argv.includes('codex-session-retry');",
      "  if (!resumed) {",
      "    process.stderr.write('Expected Codex exec resume args, got ' + JSON.stringify(argv) + '\\n');",
      "    process.exit(2);",
      "    return;",
      "  }",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Attempt 2 summary. Validation: npm test passed.\\n', 'utf8');",
      "  process.stdout.write(JSON.stringify({ type: 'usage', session_id: 'codex-session-retry', usage: { input_tokens: 200, output_tokens: 50, total_tokens: 250 } }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'agent_message', message: 'Attempt 2 fixed it. Validation: npm test passed.' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'turn_completed' }) + '\\n');",
      "});",
    ].join('\n'), 'utf8');

    if (process.platform === 'win32') {
      writeFileSync(
        join(projectRoot, 'codex.cmd'),
        '@echo off\r\nnode "%~dp0codex-session-retry-shim.cjs" %*\r\n',
        'utf8',
      );
    } else {
      const unixShimPath = join(projectRoot, 'codex');
      writeFileSync(unixShimPath, [
        '#!/usr/bin/env node',
        "require('./codex-session-retry-shim.cjs');",
      ].join('\n'), 'utf8');
      chmodSync(unixShimPath, 0o755);
    }

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-retry-codex-session',
      cli: 'codex',
      model: 'gpt-test',
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GRAPHITI_ENABLED: 'false',
        PATH: `${projectRoot}${delimiter}${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const argvLines = readFileSync(argvPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    expect(argvLines[0]).toEqual(['exec', '--json', '-m', 'gpt-test', '-']);
    expect(argvLines[1]).toEqual(['exec', 'resume', '--json', '-m', 'gpt-test', 'codex-session-retry', '-']);
    expect(readFileSync(attemptPath, 'utf8')).toBe('2');
    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    const directSession = JSON.parse(readFileSync(join(specDir, 'direct_session.json'), 'utf8')) as {
      sessionId?: string;
      lastOutcome?: string;
    };
    expect(directSession.sessionId).toBe('codex-session-retry');
    expect(directSession.lastOutcome).toBe('success');
  });
  it('continues Claude Code sessions with --continue when retrying Direct quality failures', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-retry-claude-session',
      title: 'Retry Direct validation in same Claude Code session',
      description: 'Direct CLI should continue the Claude Code session for retry attempts.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-retry-claude-session' });
    const shimPath = join(projectRoot, 'claude-session-retry-shim.cjs');
    const attemptPath = join(projectRoot, 'claude-session-retry-attempt.txt');
    const argvPath = join(projectRoot, 'claude-session-retry-argv.jsonl');
    const escapedSpecDir = specDir.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedAttemptPath = attemptPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedArgvPath = argvPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    writeFileSync(shimPath, [
      "const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const argvPath = '${escapedArgvPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      'const argv = process.argv.slice(2);',
      "appendFileSync(argvPath, JSON.stringify(argv) + '\\n', 'utf8');",
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  mkdirSync(specDir, { recursive: true });",
      "  if (attempt === 1) {",
      "    writeFileSync(join(specDir, 'direct_summary.md'), 'Claude attempt 1 summary. Validation: npm test failed.\\n', 'utf8');",
      "    process.stdout.write('Claude attempt 1 output. Validation: npm test failed.\\n');",
      "    return;",
      "  }",
      "  if (!argv.includes('--continue')) {",
      "    process.stderr.write('Expected Claude Code --continue args, got ' + JSON.stringify(argv) + '\\n');",
      "    process.exit(2);",
      "    return;",
      "  }",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Claude attempt 2 summary. Validation: npm test passed.\\n', 'utf8');",
      "  process.stdout.write('Claude continued and fixed it. Validation: npm test passed.\\n');",
      "});",
    ].join('\n'), 'utf8');

    if (process.platform === 'win32') {
      writeFileSync(
        join(projectRoot, 'claude.cmd'),
        '@echo off\r\nnode "%~dp0claude-session-retry-shim.cjs" %*\r\n',
        'utf8',
      );
    } else {
      const unixShimPath = join(projectRoot, 'claude');
      writeFileSync(unixShimPath, [
        '#!/usr/bin/env node',
        "require('./claude-session-retry-shim.cjs');",
      ].join('\n'), 'utf8');
      chmodSync(unixShimPath, 0o755);
    }

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-retry-claude-session',
      cli: 'claude-code',
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GRAPHITI_ENABLED: 'false',
        PATH: `${projectRoot}${delimiter}${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const argvLines = readFileSync(argvPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    expect(argvLines[0]).toEqual([]);
    expect(argvLines[1]).toContain('--continue');
    expect(readFileSync(attemptPath, 'utf8')).toBe('2');
    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
  });

  it('carries Direct retry transcript for DeepSeek CLI attempts', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-retry-deepseek-session',
      title: 'Retry Direct validation with DeepSeek context',
      description: 'Direct CLI should preserve retry context for DeepSeek attempts.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-retry-deepseek-session' });
    const shimPath = join(projectRoot, 'deepseek-session-retry-shim.cjs');
    const attemptPath = join(projectRoot, 'deepseek-session-retry-attempt.txt');
    const argvPath = join(projectRoot, 'deepseek-session-retry-argv.jsonl');
    const promptPath = join(projectRoot, 'deepseek-session-retry-prompt.txt');
    const escapedSpecDir = specDir.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedAttemptPath = attemptPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedArgvPath = argvPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedPromptPath = promptPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    writeFileSync(shimPath, [
      "const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const argvPath = '${escapedArgvPath}';`,
      `const promptPath = '${escapedPromptPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      'const argv = process.argv.slice(2);',
      "appendFileSync(argvPath, JSON.stringify(argv) + '\\n', 'utf8');",
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  writeFileSync(promptPath, stdin, 'utf8');",
      "  mkdirSync(specDir, { recursive: true });",
      "  if (attempt === 1) {",
      "    writeFileSync(join(specDir, 'direct_summary.md'), 'DeepSeek attempt 1 summary. Validation: npm test failed.\\n', 'utf8');",
      "    process.stdout.write('DeepSeek attempt 1 output. Validation: npm test failed.\\n');",
      "    return;",
      "  }",
      "  if (argv[0] === 'exec' || argv.includes('resume') || argv.includes('--continue')) {",
      "    process.stderr.write('DeepSeek retry should use prompt context, got ' + JSON.stringify(argv) + '\\n');",
      "    process.exit(2);",
      "    return;",
      "  }",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'DeepSeek attempt 2 summary. Validation: npm test passed.\\n', 'utf8');",
      "  process.stdout.write('DeepSeek used retry context and fixed it. Validation: npm test passed.\\n');",
      "});",
    ].join('\n'), 'utf8');

    if (process.platform === 'win32') {
      writeFileSync(
        join(projectRoot, 'deepseek.cmd'),
        '@echo off\r\nnode "%~dp0deepseek-session-retry-shim.cjs" %*\r\n',
        'utf8',
      );
    } else {
      const unixShimPath = join(projectRoot, 'deepseek');
      writeFileSync(unixShimPath, [
        '#!/usr/bin/env node',
        "require('./deepseek-session-retry-shim.cjs');",
      ].join('\n'), 'utf8');
      chmodSync(unixShimPath, 0o755);
    }

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-retry-deepseek-session',
      cli: 'deepseek',
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GRAPHITI_ENABLED: 'false',
        PATH: `${projectRoot}${delimiter}${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const argvLines = readFileSync(argvPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    expect(argvLines[0]).toEqual([]);
    expect(argvLines[1]).toEqual([]);
    const retryPrompt = readFileSync(promptPath, 'utf8');
    expect(retryPrompt).toContain('Previous attempt transcript');
    expect(retryPrompt).toContain('DeepSeek attempt 1 output');
    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    const directSession = JSON.parse(readFileSync(join(specDir, 'direct_session.json'), 'utf8')) as {
      provider?: string;
      lastOutcome?: string;
    };
    expect(directSession.provider).toBe('deepseek-cli');
    expect(directSession.lastOutcome).toBe('success');
  });
  it('continues configured future Direct CLIs with argument templates', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-retry-future-template-session',
      title: 'Retry Direct validation in configured future session',
      description: 'Direct CLI should resume configured future providers without provider-specific branches.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-retry-future-template-session' });
    const shimPath = join(projectRoot, 'future-code-session-retry-shim.cjs');
    const attemptPath = join(projectRoot, 'future-code-session-retry-attempt.txt');
    const argvPath = join(projectRoot, 'future-code-session-retry-argv.jsonl');
    const escapedSpecDir = specDir.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedAttemptPath = attemptPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    const escapedArgvPath = argvPath.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
    writeFileSync(shimPath, [
      "const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const attemptPath = '${escapedAttemptPath}';`,
      `const argvPath = '${escapedArgvPath}';`,
      `const specDir = '${escapedSpecDir}';`,
      'const argv = process.argv.slice(2);',
      "appendFileSync(argvPath, JSON.stringify(argv) + '\\n', 'utf8');",
      "const previous = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;",
      'const attempt = previous + 1;',
      "writeFileSync(attemptPath, String(attempt), 'utf8');",
      "let stdin = '';",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  mkdirSync(specDir, { recursive: true });",
      "  if (attempt === 1) {",
      "    writeFileSync(join(specDir, 'direct_summary.md'), 'Future attempt 1 summary. Validation: npm test failed.\\n', 'utf8');",
      "    process.stdout.write(JSON.stringify({ kind: 'configured', conversation_id: 'future-session-123' }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ kind: 'message', message: 'Future attempt 1 output. Validation: npm test failed.' }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ kind: 'done' }) + '\\n');",
      "    return;",
      "  }",
      "  const expected = ['resume', '--session', 'future-session-123', '--model', 'future-large', '--stdin'];",
      "  if (JSON.stringify(argv) !== JSON.stringify(expected)) {",
      "    process.stderr.write('Expected Future template resume args, got ' + JSON.stringify(argv) + '\\n');",
      "    process.exit(2);",
      "    return;",
      "  }",
      "  writeFileSync(join(specDir, 'direct_summary.md'), 'Future attempt 2 summary. Validation: npm test passed.\\n', 'utf8');",
      "  process.stdout.write(JSON.stringify({ kind: 'configured', conversation_id: 'future-session-123' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ kind: 'message', message: 'Future attempt 2 fixed it. Validation: npm test passed.' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ kind: 'done' }) + '\\n');",
      "});",
    ].join('\n'), 'utf8');

    if (process.platform === 'win32') {
      writeFileSync(
        join(projectRoot, 'future-code.cmd'),
        '@echo off\r\nnode "%~dp0future-code-session-retry-shim.cjs" %*\r\n',
        'utf8',
      );
    } else {
      const unixShimPath = join(projectRoot, 'future-code');
      writeFileSync(unixShimPath, [
        '#!/usr/bin/env node',
        "require('./future-code-session-retry-shim.cjs');",
      ].join('\n'), 'utf8');
      chmodSync(unixShimPath, 0o755);
    }

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-retry-future-template-session',
      cli: 'future-code',
      model: 'future-large',
      phase: 'direct',
      directCliRuntimeRouteId: 'future-code-direct-cli',
      directCliRuntimeRouteDisplayName: 'Future Code',
      directCliTaskRunStrategy: {
        args: ['run', '--json'],
        modelFlag: '--model',
        promptStdinArg: '--stdin',
      },
      directCliJsonEventParser: {
        type: 'future-json',
        displayName: 'Future Code',
        commandNames: ['future-code'],
        requiredArgs: ['--json'],
        eventTypeFields: ['kind'],
        sessionIdFields: ['conversation_id'],
        messageFields: ['message'],
        completionEventTypes: ['done'],
      },
      directCliContinuationStrategy: {
        displayName: 'Future Code',
        type: 'argument-template',
        commandNames: ['future-code'],
        requiresJsonMode: true,
        jsonEventParser: 'future-json',
        sessionIdSource: 'json-event-session',
        argsTemplate: ['resume', '--session', '{sessionId}', '--model', '{modelId}', '{promptStdinArg}'],
        promptStdinArg: '--stdin',
      },
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GRAPHITI_ENABLED: 'false',
        PATH: `${projectRoot}${delimiter}${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const argvLines = readFileSync(argvPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    expect(argvLines[0]).toEqual(['run', '--json', '--model', 'future-large', '--stdin']);
    expect(argvLines[1]).toEqual(['resume', '--session', 'future-session-123', '--model', 'future-large', '--stdin']);
    expect(readFileSync(attemptPath, 'utf8')).toBe('2');
    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    const runResult = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      attemptCount?: number;
      quality?: { durationMs?: number };
    };
    expect(runResult.attemptCount).toBe(2);
    expect(runResult.quality?.durationMs).toBeGreaterThanOrEqual(0);
    const directPlan = loadAutocodeImplementationPlanSync(specDir);
    const directSubtasks = directPlan?.phases?.flatMap((phase) => phase.subtasks ?? phase.chunks ?? []) ?? [];
    const completedDirectSubtask = directSubtasks.find((subtask) => subtask.id === 'direct-implementation');
    expect(completedDirectSubtask?.duration_ms).toBe(runResult.quality?.durationMs);
    expect(readFileSync(join(specDir, 'implementation_plan.md'), 'utf8')).toContain('"duration_ms":');
    const directSession = JSON.parse(readFileSync(join(specDir, 'direct_session.json'), 'utf8')) as {
      sessionId?: string;
      provider?: string;
      providerDisplayName?: string;
      modelId?: string;
      lastOutcome?: string;
    };
    expect(directSession.sessionId).toBe('future-session-123');
    expect(directSession.provider).toBe('future-code-direct-cli');
    expect(directSession.providerDisplayName).toBe('Future Code');
    expect(directSession.modelId).toBe('future-large');
    expect(directSession.lastOutcome).toBe('success');
  });
  it('binds Direct CLI completion to the latest active change request when metadata lacks current subtask', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-change-request-current-fallback',
      title: 'Bind Direct change request fallback',
      description: 'Direct CLI should not complete stale Direct request-change nodes.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-change-request-current-fallback' });
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Bind Direct change request fallback',
      'Workflow: direct',
      'Status: coding',
      'Execution Phase: coding',
      '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"running","summary_file":"direct_summary.md"}} -->',
      '',
      '- [/] direct. Direct execution',
      '  - [ ] direct-cr-old Direct Request Changes',
      '    - Older pending Direct iteration that should not steal completion.',
      '  - [/] direct-cr-new Direct Request Changes',
      '    - Active Direct iteration that should receive completion.',
      '',
    ].join(String.fromCharCode(10)), 'utf8');
    const fakeCliPath = join(projectRoot, 'direct-cr-current-fallback.cjs');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `const specDir = '${specDir.replace(/\\/g, '\\\\')}';`,
      "mkdirSync(specDir, { recursive: true });",
      "writeFileSync(join(specDir, 'direct_summary.md'), 'Direct change request fallback completed. Validation: npm test passed.\\n', 'utf8');",
      "process.stdout.write('Direct change request fallback completed.\\nValidation: npm test passed.\\n');",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-change-request-current-fallback',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'direct',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(stdout).toContain('"type":"DIRECT_COMPLETED"');
    const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
    expect(rawPlan).toContain('"current_subtask_id":"direct-cr-new"');
    expect(rawPlan).toContain('  - [ ] direct-cr-old Direct Request Changes');
    expect(rawPlan).toContain('  - [x] direct-cr-new Direct Request Changes');
    const implementationPlan = loadAutocodeImplementationPlanSync(specDir);
    const subtasks = implementationPlan?.phases?.[0]?.subtasks ?? [];
    expect(subtasks.find((subtask) => subtask.id === 'direct-cr-old')?.status).toBe('pending');
    expect(subtasks.find((subtask) => subtask.id === 'direct-cr-new')?.status).toBe('completed');
  });
  it('fails Direct CLI completion when final validation evidence reports failure', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-direct-validation-failure',
      title: 'Gate failed Direct validation',
      description: 'Direct CLI should not report completion when validation failed.',
      metadata: { developmentMode: 'direct' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '008-direct-validation-failure' });
    writeFileSync(join(specDir, 'direct_summary.md'), 'STALE DIRECT SUMMARY FROM PREVIOUS ITERATION', 'utf8');
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Gate failed Direct validation',
      'Workflow: direct',
      'Status: coding',
      'Execution Phase: coding',
      '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"running","current_subtask_id":"direct-cr-20260701074920826","change_request_id":"cr-20260701074920826","summary_file":"direct_summary.md"}} -->',
      '',
      '- [/] direct. Direct execution',
      '  - [/] direct-cr-20260701074920826 Direct Request Changes',
      '    - Continue the same Direct model session.',
      '',
    ].join(String.fromCharCode(10)), 'utf8');
    writeFakeCodexJsonCommand(projectRoot, [
      {
        type: 'agent_message',
        message: [
          'Implemented the requested change.',
          'Validation: npm test failed with assertion error in direct workflow.',
        ].join(String.fromCharCode(10)),
      },
      { type: 'turn_completed' },
    ]);

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '008-direct-validation-failure',
      cli: 'custom',
      customCommand: 'codex --json',
      phase: 'direct',
    });

    let failed = false;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
        cwd: projectRoot,
        env: {
          ...process.env,
          GRAPHITI_ENABLED: 'false',
          PATH: `${projectRoot}${delimiter}${process.env.PATH ?? ''}`,
        },
        encoding: 'utf8',
        timeout: 15_000,
      });
    } catch (error) {
      failed = true;
      stdout = String((error as { stdout?: string | Buffer }).stdout ?? '');
    }

    expect(failed).toBe(true);
    expect(stdout).toContain('"type":"CODING_FAILED"');
    expect(stdout).not.toContain('"type":"DIRECT_COMPLETED"');
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      exitCode?: number;
      status?: string;
      message?: string;
      quality?: { validation?: { status?: string; reason?: string } };
    };
    expect(result.exitCode).toBe(1);
    expect(result.status).toBe('error');
    expect(result.message).toContain('Direct validation reported_failed');
    expect(result.quality?.validation?.status).toBe('reported_failed');
    expect(result.quality?.validation?.reason).toContain('npm test failed');
    const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
    expect(rawPlan).toContain('"change_request_id":"cr-20260701074920826"');
    expect(rawPlan).toContain('"outcome":"error"');
    expect(rawPlan).not.toContain('"completed_at"');
    expect(rawPlan).toContain('"ai_coding_quality"');
    expect(rawPlan).toContain('- [!] direct. Direct execution');
    expect(rawPlan).toContain('  - [!] direct-cr-20260701074920826 Direct Request Changes');
    const failedPlan = loadAutocodeImplementationPlanSync(specDir);
    expect(failedPlan?.phases?.[0]?.subtasks?.[0]?.status).toBe('failed');
    expect(failedPlan?.phases?.[0]?.subtasks?.[0]?.notes).toContain('Direct validation reported');
    expect(failedPlan?.phases?.[0]?.subtasks?.[0]?.notes).toContain('npm test failed');
    expect(readFileSync(join(specDir, 'direct_summary.md'), 'utf8')).not.toContain('STALE DIRECT SUMMARY');
    const directSession = JSON.parse(readFileSync(join(specDir, 'direct_session.json'), 'utf8')) as {
      lastOutcome?: string;
      latestSummary?: string;
    };
    expect(directSession.lastOutcome).toBe('error');
    expect(directSession.latestSummary).toContain('Direct validation reported_failed');
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
    "process.stdout.write('fake codex completed\\nValidation: prompt capture passed.\\n');",
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
