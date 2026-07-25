import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DIRECT_CHANGE_REQUEST_LIMIT } from '../runtime/agent-messages.js';
import { createAutocodeProjectDocumentationTask } from '../project/project-docs.js';
import {
  AUTOCODE_CLI_TASK_DESCRIPTION_MAX_CHARS,
  createAutocodeTaskRunPlan as createAutocodeTaskRunPlanBase,
  resolveAutocodeTaskRunnerDependency,
} from './cli-runner.js';
import { getAutocodeDesignPackageFingerprint } from './design-quality.js';
import { loadAutocodeImplementationPlanSync } from './plan-store.js';
import { createAutocodeTask, getAutocodeSpecDir } from './spec-store.js';
import { buildStandardDesignV5Fixture } from './standard-design-v5.test-fixture.js';
import {
  buildAutocodeRuntimeImplementationPlanFromTasksMarkdown,
  stringifyAutocodeImplementationPlanMarkdown,
} from './work-packages.js';

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


const VALID_STANDARD_DESIGN_PACKAGE = buildStandardDesignV5Fixture();
const VALID_STANDARD_DESIGN = VALID_STANDARD_DESIGN_PACKAGE.designMarkdown;
const VALID_STANDARD_REQUIREMENT_MODEL = VALID_STANDARD_DESIGN_PACKAGE.requirementModelMarkdown;
const VALID_STANDARD_DOMAIN_MODEL = VALID_STANDARD_DESIGN_PACKAGE.domainModelMarkdown;
const VALID_STANDARD_DESIGN_MODEL = VALID_STANDARD_DESIGN_PACKAGE.designModelMarkdown;
const VALID_STANDARD_IMPLEMENTATION_MODEL = VALID_STANDARD_DESIGN_PACKAGE.implementationModelMarkdown;

const VALID_STANDARD_DESIGN_REVIEW = [
  'Status: PASSED',
  '',
  'The design is evidence-backed, feasible, and within its local budget.',
  '',
].join('\n');

const HEADING_BUDGET_STANDARD_DESIGN = VALID_STANDARD_DESIGN.replace(
  [
    '- Expected modules changed: 2',
    '- New modules allowed: 0',
    '- New public contracts allowed: 0',
    '- New dependencies allowed: 0',
    '- New architectural patterns: none',
  ].join('\n'),
  [
    '### DES-004 Design budget',
    '#### Expected modules changed',
    '2 modules.',
    '#### New modules allowed',
    '0 modules.',
    '#### New public contracts allowed',
    '0 contracts.',
    '#### New dependencies allowed',
    '0 dependencies.',
    '#### New architectural patterns',
    'None.',
  ].join('\n'),
);

function createLocalizedMalformedStandardDesign(): string {
  return VALID_STANDARD_DESIGN
    .replace('# Design: Standard planning fixture', '# C++ \u4fc4\u7f57\u65af\u65b9\u5757\u6e38\u620f\u8bbe\u8ba1')
    .replace(/-001\b/g, '-1')
    .replace('- Analysis direction: forward-design', '- Analysis direction: forward-design - \u6b63\u5411\u8bbe\u8ba1')
    .replace('- Primary source of truth: mixed', '- Primary source of truth: \u6df7\u5408')
    .replace('- Requirement evidence: requirement - requirements.md R-1 defines the command result', '- Requirement evidence: requirements.md R-1')
    .replace('- Project evidence: observed - src/existing.ts#handleCommand owns the current behavior', '- Project evidence: src/existing.ts#handleCommand')
    .replace('- Design inferences: none - the requirement and source establish the local boundary', '- Design inferences: \u65e0')
    .replace('- Unresolved evidence: none', '- Unresolved evidence: \u5f85\u786e\u8ba4')
    .replace('- Delivery context: existing-system', '- Delivery context: \u73b0\u6709\u7cfb\u7edf')
    .replace('- System shape: local-utility', '- System shape: \u672c\u5730\u5de5\u5177')
    .replace('- Project paradigm: mixed', '- Project paradigm: \u6df7\u5408')
    .replace('- Object-model applicability: low', '- Object-model applicability: \u4f4e')
    .replace('- Cohesion decision:', '- \u5185\u805a\u51b3\u7b56:')
    .replace('- Coupling and dependency decision:', '- \u8026\u5408\u4e0e\u4f9d\u8d56\u51b3\u7b56:')
    .replace('- Encapsulation decision:', '- \u5c01\u88c5\u51b3\u7b56:')
    .replace('- SOLID trade-offs:', '- SOLID \u6743\u8861:')
    .replace('- Underdesign checks:', '- \u8bbe\u8ba1\u4e0d\u8db3\u68c0\u67e5:');
}

function withStandardDesignMetadata(tasksMarkdown: string): string {
  if (/^\s*-\s+_Design:/im.test(tasksMarkdown)) {
    return tasksMarkdown;
  }
  return tasksMarkdown.replace(
    /^(\s*)-\s+_Requirements:[^\r\n]*_\s*$/gm,
    (line, indent: string) =>
      `${line}\n${indent}- _Design: ADR-001, RM-001, FUN-001, SSD-001, DOM-001, SYS-001, DES-001, STATE-001, FLOW-001, LANG-001, IMP-001_`,
  );
}

function writeValidStandardDesignArtifacts(specDir: string): void {
  writeFileSync(join(specDir, 'design.md'), VALID_STANDARD_DESIGN, 'utf8');
  writeFileSync(join(specDir, 'requirement_model.md'), VALID_STANDARD_REQUIREMENT_MODEL, 'utf8');
  writeFileSync(join(specDir, 'domain_model.md'), VALID_STANDARD_DOMAIN_MODEL, 'utf8');
  writeFileSync(join(specDir, 'design_model.md'), VALID_STANDARD_DESIGN_MODEL, 'utf8');
  writeFileSync(join(specDir, 'implementation_model.md'), VALID_STANDARD_IMPLEMENTATION_MODEL, 'utf8');
  writeFileSync(join(specDir, 'design_review.md'), VALID_STANDARD_DESIGN_REVIEW, 'utf8');
}

function writeNonImplementationPlanningCli(input: {
  cliPath: string;
  specDir: string;
  callsPath: string;
  requirements?: string;
  spec?: string;
  tasks: string;
}): void {
  writeFileSync(input.cliPath, [
    "const { appendFileSync, writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    `const specDir = ${JSON.stringify(input.specDir)};`,
    `const callsPath = ${JSON.stringify(input.callsPath)};`,
    `const output = ${JSON.stringify({ requirements: input.requirements, spec: input.spec, tasks: input.tasks })};`,
    "let prompt = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { prompt += chunk; });",
    "process.stdin.on('end', () => {",
    "  const stage = prompt.includes('## STANDARD REQUIREMENTS STAGE ONLY') ? 'requirements' : prompt.includes('# Standard Observable Specification Stage') ? 'spec' : prompt.includes('# Standard Task Planning Stage') ? 'tasks' : 'unknown';",
    "  appendFileSync(callsPath, JSON.stringify({ stage, prompt }) + '\\n', 'utf8');",
    "  const file = stage === 'requirements' ? 'requirements.md' : stage === 'spec' ? 'spec.md' : stage === 'tasks' ? 'tasks.md' : '';",
    "  if (!file || typeof output[stage] !== 'string') { process.exitCode = 2; return; }",
    "  writeFileSync(join(specDir, file), output[stage], 'utf8');",
    '});',
  ].join('\n'), 'utf8');
}

function createAutocodeTaskRunPlan(
  input: Parameters<typeof createAutocodeTaskRunPlanBase>[0],
): ReturnType<typeof createAutocodeTaskRunPlanBase> {
  if (input.phase === 'coding') {
    const specDir = getAutocodeSpecDir({
      projectRoot: input.projectRoot,
      dataDirName: input.dataDirName,
      specId: input.taskId,
    });
    const planPath = join(specDir, 'implementation_plan.md');
    if (existsSync(planPath)) {
      const fixture = buildStandardDesignV5Fixture();
      const artifactEntries = [
        ['design.md', fixture.designMarkdown],
        ['requirement_model.md', fixture.requirementModelMarkdown],
        ['domain_model.md', fixture.domainModelMarkdown],
        ['design_model.md', fixture.designModelMarkdown],
        ['implementation_model.md', fixture.implementationModelMarkdown],
        ['design_review.md', VALID_STANDARD_DESIGN_REVIEW],
      ] as const;
      for (const [fileName, markdown] of artifactEntries) {
        const artifactPath = join(specDir, fileName);
        if (!existsSync(artifactPath)) {
          writeFileSync(artifactPath, markdown, 'utf8');
        }
      }
      const designPackage = {
        designMarkdown: readFileSync(join(specDir, 'design.md'), 'utf8'),
        requirementModelMarkdown: readFileSync(join(specDir, 'requirement_model.md'), 'utf8'),
        domainModelMarkdown: readFileSync(join(specDir, 'domain_model.md'), 'utf8'),
        designModelMarkdown: readFileSync(join(specDir, 'design_model.md'), 'utf8'),
        implementationModelMarkdown: readFileSync(join(specDir, 'implementation_model.md'), 'utf8'),
      };
      const planMarkdown = readFileSync(planPath, 'utf8');
      const metadataPattern = /<!--\s*autocode-plan-meta:\s*(\{[^\r\n]*\})\s*-->/;
      const metadataMatch = metadataPattern.exec(planMarkdown);
      const metadata = metadataMatch
        ? JSON.parse(metadataMatch[1]) as Record<string, unknown>
        : {};
      const sourceTask = metadata.source_task &&
        typeof metadata.source_task === 'object' &&
        !Array.isArray(metadata.source_task)
        ? metadata.source_task as Record<string, unknown>
        : {};
      metadata.source_task = {
        ...sourceTask,
        design_contract: {
          version: 5,
          path: 'design.md',
          paths: [
            'design.md',
            'requirement_model.md',
            'domain_model.md',
            'design_model.md',
            'implementation_model.md',
          ],
          fingerprint: getAutocodeDesignPackageFingerprint(designPackage),
        },
      };
      const metadataLine = `<!-- autocode-plan-meta: ${JSON.stringify(metadata)} -->`;
      writeFileSync(
        planPath,
        metadataMatch
          ? planMarkdown.replace(metadataPattern, metadataLine)
          : planMarkdown.replace(/(Execution Phase:[^\r\n]*\r?\n)/, `$1${metadataLine}\n`),
        'utf8',
      );
    }
  }
  return createAutocodeTaskRunPlanBase(input);
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

  it('passes the normalized task phase thinking level to Codex', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-codex-phase-thinking',
      title: 'Use task phase thinking',
      description: 'Task phase settings must override stale global Codex reasoning values.',
      metadata: {
        developmentMode: 'standard',
        isAutoProfile: true,
        phaseThinking: {
          spec: 'medium',
          planning: 'medium',
          coding: 'low',
          qa: 'low',
        },
      },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-codex-phase-thinking',
      cli: 'codex',
      model: 'gpt-test',
      phase: 'planning',
    });

    expect(plan.args).toEqual([
      'exec',
      '--json',
      '-m',
      'gpt-test',
      '-c',
      'model_reasoning_effort=medium',
      '-',
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

  it('uses runner lock fallback when project lock storage is unavailable', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-runner-lock-fallback',
      title: 'Use temp lock fallback',
      description: 'Runner should not fail when project .locks cannot be created.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '001-runner-lock-fallback',
    });
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Use temp lock fallback',
      'Status: coding',
      'Execution Phase: coding',
      '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","subtaskMetadata":{"wp-1":{"work_package":true,"depends_on":[]}}} -->',
      '',
      '- [ ] 1. Implementation',
      '  - [ ] wp-1 Complete with fallback lock',
      '',
    ].join('\n'), 'utf8');
    const fakeCliPath = join(projectRoot, 'coding-lock-fallback.cjs');
    writeFileSync(fakeCliPath, [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write('| Change | Verification | Review |\\n|---|---|---|\\n| Completed fallback path | passed | ok |\\n');",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-runner-lock-fallback',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'coding',
    });
    const runner = readFileSync(plan.runnerFilePath, 'utf8');

    expect(runner).toContain("const { tmpdir, homedir } = require('node:os');");
    expect(runner).toContain('function maybeFallbackFileWriteLockAttempt');
    expect(runner).toContain("join(tmpdir(), 'autocode-runtime-file-write-locks'");
    expect(runner).toContain("['EACCES', 'ENAMETOOLONG', 'ENOENT', 'ENOTDIR', 'EPERM', 'EROFS']");

    rmSync(join(projectRoot, dataDirName, '.locks'), { recursive: true, force: true });
    writeFileSync(join(projectRoot, dataDirName, '.locks'), 'not a directory', 'utf8');
    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(readFileSync(join(specDir, 'implementation_plan.md'), 'utf8'))
      .toContain('- [x] wp-1 Complete with fallback lock');
    expect(existsSync(getRuntimeFileWriteLockFallbackRoot(projectRoot, dataDirName))).toBe(true);
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
  it('does not mention Direct summary artifacts in Standard coding prompts', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-coding-summary',
      title: 'Run standard work package',
      description: 'Standard mode should report completion without Direct artifacts.',
      metadata: { developmentMode: 'standard' },
    });

    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '001-standard-coding-summary' });
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Standard prompt summary',
      'Status: coding',
      'Execution Phase: coding',
      '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","subtaskMetadata":{"wp-1":{"work_package":true,"depends_on":[]}}} -->',
      '',
      '- [ ] 1. Implementation',
      '  - [ ] wp-1 Complete standard work',
      '',
    ].join('\n'), 'utf8');

    const standardPlan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-coding-summary',
      cli: 'codex',
      phase: 'coding',
    });
    const zhStandardPlan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-coding-summary',
      cli: 'codex',
      phase: 'coding',
      language: 'zh-CN',
    });

    expect(standardPlan.prompt).not.toContain('direct_summary.md');
    expect(zhStandardPlan.prompt).not.toContain('direct_summary.md');
    expect(readFileSync(zhStandardPlan.promptFilePath, 'utf8')).not.toContain('direct_summary.md');

    const fakeCliPath = join(projectRoot, 'standard-summary-runner.cjs');
    writeFileSync(fakeCliPath, [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write('| Change | Verification | Review |\\n|---|---|---|\\n| Standard work completed | passed | ok |\\n');",
      "});",
    ].join('\n'), 'utf8');
    const runPlan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-coding-summary',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'coding',
    });
    execFileSync(process.execPath, [runPlan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    });
    expect(existsSync(join(specDir, 'direct_summary.md'))).toBe(false);

    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-direct-summary',
      title: 'Run direct task',
      description: 'Direct mode should keep using the Direct summary artifact.',
      metadata: { developmentMode: 'direct' },
    });

    const directPlan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-direct-summary',
      cli: 'codex',
      phase: 'direct',
    });

    expect(directPlan.prompt).toContain('direct_summary.md');
  });

  it('allows seeded project documentation plans to enter coding without a design contract', () => {
    const documentationTask = createAutocodeProjectDocumentationTask({
      projectRoot,
      dataDirName,
      specId: '001-project-docs',
      documentType: 'full',
      now: '2026-07-23T05:32:46.174Z',
    });
    const fakeCliPath = join(projectRoot, 'project-docs-runner.cjs');
    writeFileSync(fakeCliPath, [
      'process.stdin.resume();',
      'process.stdin.on(\'end\', () => {',
      '  process.stdout.write(\'Documentation generated. Verification passed.\');',
      '});',
    ].join('\n'), 'utf8');

    const runPlan = createAutocodeTaskRunPlanBase({
      projectRoot,
      dataDirName,
      taskId: documentationTask.task.id,
      cli: 'custom',
      customCommand: `node ${fakeCliPath.replaceAll(String.fromCharCode(92), '/')}`,
      phase: 'coding',
    });
    const planText = readFileSync(
      join(documentationTask.task.specsPath, 'implementation_plan.md'),
      'utf8',
    );
    expect(planText).not.toContain('design_contract');

    execFileSync(process.execPath, [runPlan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    });

    const logs = readFileSync(
      join(documentationTask.task.specsPath, 'task_logs.jsonl'),
      'utf8',
    );
    expect(logs).not.toContain('has no Design-Contract: 5 package fingerprint');
    expect(logs).toContain('Work item 1.1 completed.');
  });

  it('allows analysis workflows to enter coding without a design contract', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-analysis-task',
      title: 'Analyze runtime logs',
      description: 'Analyze runtime logs and generate a findings report.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '001-analysis-task' });
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Analyze runtime logs',
      'Workflow: investigation',
      'Status: coding',
      'Execution Phase: coding',
      `<!-- autocode-plan-meta: ${JSON.stringify({ source_task: { kind: 'analysis-task' } })} -->`,
      '',
      '- [ ] 1. Analysis',
      '  - [ ] 1.1 Analyze logs and write the findings report',
      '',
    ].join('\n'), 'utf8');
    const fakeCliPath = join(projectRoot, 'analysis-runner.cjs');
    writeFileSync(fakeCliPath, [
      'process.stdin.resume();',
      'process.stdin.on(\'end\', () => {',
      '  process.stdout.write(\'Analysis completed. Report generated.\');',
      '});',
    ].join('\n'), 'utf8');

    const runPlan = createAutocodeTaskRunPlanBase({
      projectRoot,
      dataDirName,
      taskId: '001-analysis-task',
      cli: 'custom',
      customCommand: `node ${fakeCliPath.replaceAll(String.fromCharCode(92), '/')}`,
      phase: 'coding',
    });
    execFileSync(process.execPath, [runPlan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    });
    const logs = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');
    expect(logs).not.toContain('has no Design-Contract: 5 package fingerprint');
    expect(logs).toContain('Work item 1.1 completed.');
  });

  it('still blocks analysis-labelled coding plans that request implementation', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-analysis-fix-task',
      title: 'Analyze and fix runtime logs',
      description: 'Analyze the failure, then fix worker.ts and update tests.',
      metadata: { developmentMode: 'standard', taskType: 'analysis' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '001-analysis-fix-task' });
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Analyze and fix runtime logs',
      'Workflow: analysis',
      'Status: coding',
      'Execution Phase: coding',
      '<!-- autocode-plan-meta: ' + JSON.stringify({ source_task: { kind: 'implementation-task' } }) + ' -->',
      '',
      '- [ ] 1. Implementation',
      '  - [ ] 1.1 Fix worker.ts and update tests',
      '',
    ].join('\n'), 'utf8');
    const fakeCliPath = join(projectRoot, 'analysis-fix-runner.cjs');
    writeFileSync(fakeCliPath, 'process.stdout.write(\'should not run\');\n', 'utf8');

    const runPlan = createAutocodeTaskRunPlanBase({
      projectRoot,
      dataDirName,
      taskId: '001-analysis-fix-task',
      cli: 'custom',
      customCommand: 'node ' + fakeCliPath.replaceAll(String.fromCharCode(92), '/'),
      phase: 'coding',
    });

    expect(() => execFileSync(process.execPath, [runPlan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    })).toThrow();
    const logs = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');
    expect(logs).toContain('has no Design-Contract: 5 package fingerprint');
  });

  it('uses the staged artifact ownership contract for new planning tasks', () => {
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

    expect(plan.prompt).toContain('requirements.md owns full R*/AC*/C*/A*/Q*/E* facts');
    expect(plan.prompt).toContain('spec.md owns observable SCN-* behavior');
    expect(plan.prompt).toContain('tasks.md owns static task definitions with [ ] checkboxes only');
    expect(plan.prompt).toContain('implementation_plan.md is a runtime-owned ledger');
    expect(plan.prompt).toContain('Write only the artifact named by the active owner stage');
    expect(plan.prompt).not.toContain('## Human Input');
    expect(plan.prompt).not.toContain('needs_revision');
  });

  it('skips Design-Contract 5 owner stages for new analysis planning workflows', () => {
    const taskId = '001-analysis-planning';
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: taskId,
      title: 'Analyze runtime failures',
      description: 'Analyze runtime logs and generate a reader-first findings report.',
      metadata: { developmentMode: 'standard', taskType: 'analysis' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: taskId });
    const requirementsMarkdown = [
      '# Requirements',
      '',
      'Requirements-Contract: 1',
      '',
      '## Workflow Type',
      'investigation',
      '',
      '## User Requirements',
      '- R1: Explain the observed runtime failure using traceable evidence.',
      '',
      '## Acceptance Criteria',
      '- AC1: The report states the cause, evidence, and limitations.',
      '',
      '## Evidence Sources',
      '- E1: User-provided runtime logs and repository documentation.',
      '',
    ].join('\n');
    const specMarkdown = [
      '# Specification: Analyze runtime failures',
      '',
      'Specification-Contract: 1',
      '',
      '### SCN-001 Produce traceable findings',
      'Covers: R1, AC1',
      'Evidence: E1',
      '- Given: runtime logs and repository documentation are available.',
      '- When: the evidence is analyzed.',
      '- Then: the report explains the cause, evidence, and limitations.',
      '',
    ].join('\n');
    const tasksMarkdown = [
      '# Tasks',
      '',
      'Tasks-Contract: 1',
      '',
      'Feature: Analyze runtime failures',
      'Workflow: investigation',
      '',
      '- [ ] 1. Analysis report',
      '  - [ ] 1.1 Analyze evidence and write the findings report',
      '    - Correlate the logs with repository documentation and record supported conclusions.',
      '    - _Files to create: docs/runtime-findings.md_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1, SCN-001_',
      '    - _Evidence: E1; requirements.md E1; spec.md SCN-001_',
      '    - _Done when: docs/runtime-findings.md states the cause, evidence, and limitations_',
      '    - _Verification: Get-Content docs/runtime-findings.md and inspect its conclusion and evidence_',
      '',
    ].join('\n');
    const callsPath = join(projectRoot, 'analysis-planning-calls.jsonl');
    const fakeCliPath = join(projectRoot, 'analysis-planner.cjs');
    writeNonImplementationPlanningCli({
      cliPath: fakeCliPath,
      specDir,
      callsPath,
      requirements: requirementsMarkdown,
      spec: specMarkdown,
      tasks: tasksMarkdown,
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId,
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'planning',
    });
    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 20_000,
    });

    const calls = readFileSync(callsPath, 'utf8').trim().split(/\r?\n/).map((line) => (
      JSON.parse(line) as { stage: string; prompt: string }
    ));
    expect(calls.map((call) => call.stage)).toEqual(['requirements', 'spec', 'tasks']);
    expect(calls.every((call) => !call.prompt.includes('Design-Contract: 5'))).toBe(true);
    for (const fileName of [
      'requirement_model.md',
      'domain_model.md',
      'design.md',
      'design_model.md',
      'implementation_model.md',
      'design_review.md',
    ]) {
      expect(existsSync(join(specDir, fileName))).toBe(false);
    }
    const runtimePlan = loadAutocodeImplementationPlanSync(specDir);
    expect(runtimePlan?.source_task).not.toHaveProperty('design_contract');
    expect(runtimePlan?.phases?.[0]?.subtasks?.[0]?.title).toContain('Analyze evidence');
    expect(stdout).toContain('PLANNING_COMPLETE');
  });

  it('keeps a new review-and-findings workflow exempt without a prior design contract', () => {
    const taskId = '001-review-findings-planning';
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: taskId,
      title: 'Review the current architecture',
      description: 'Review the current architecture and write findings for maintainers.',
      metadata: { developmentMode: 'standard' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId,
      cli: 'codex',
      phase: 'planning',
    });

    expect(plan.prompt).toContain('This is a non-implementation workflow.');
    expect(readFileSync(plan.runnerFilePath, 'utf8'))
      .toContain('const requiresStandardDesignContract = false;');
  });

  it('resumes force planning for documentation at tasks without rewriting stale design files', () => {
    const taskId = '001-documentation-planning-resume';
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: taskId,
      title: 'Refresh project handbook',
      description: 'Refresh the approved project handbook from existing sources.',
      metadata: { developmentMode: 'standard' },
      requirements: { workflow_type: 'documentation' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: taskId });
    const requirementsMarkdown = [
      '# Requirements',
      '',
      'Requirements-Contract: 1',
      '',
      '## Workflow Type',
      'documentation',
      '',
      '## User Requirements',
      '- R1: Produce an evidence-backed project handbook for maintainers.',
      '',
      '## Acceptance Criteria',
      '- AC1: The handbook presents the main workflow before supporting detail.',
      '',
      '## Evidence Sources',
      '- E1: Existing repository source and project documentation.',
      '',
    ].join('\n');
    const specMarkdown = [
      '# Specification: Refresh project handbook',
      '',
      'Specification-Contract: 1',
      '',
      '### SCN-001 Read the project handbook',
      'Covers: R1, AC1',
      'Evidence: E1',
      '- Given: a maintainer opens the generated handbook.',
      '- When: the maintainer follows the main workflow.',
      '- Then: evidence and limitations remain traceable.',
      '',
    ].join('\n');
    const tasksMarkdown = [
      '# Tasks',
      '',
      'Tasks-Contract: 1',
      '',
      'Feature: Refresh project handbook',
      'Workflow: documentation',
      '',
      '- [ ] 1. Project handbook',
      '  - [ ] 1.1 Generate the reader-first project handbook',
      '    - Summarize the main workflow, supporting evidence, and known limitations.',
      '    - _Files to create: docs/project-handbook.md_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1, SCN-001_',
      '    - _Evidence: E1; requirements.md E1; spec.md SCN-001_',
      '    - _Done when: docs/project-handbook.md leads with the main workflow and cites evidence_',
      '    - _Verification: Get-Content docs/project-handbook.md and inspect its workflow and evidence headings_',
      '',
    ].join('\n');
    writeFileSync(join(specDir, 'requirements.md'), requirementsMarkdown, 'utf8');
    writeFileSync(join(specDir, 'spec.md'), specMarkdown, 'utf8');
    const staleDesignArtifacts = [
      ['requirement_model.md', '# stale requirement model\ninvalid old model\n'],
      ['domain_model.md', '# stale domain model\ninvalid old model\n'],
      ['design.md', '# stale design\nDesign-Contract: 4\n'],
      ['design_model.md', '# stale design model\ninvalid old model\n'],
      ['implementation_model.md', '# stale implementation model\ninvalid old model\n'],
      ['design_review.md', 'Status: REVISE\nstale review\n'],
    ] as const;
    for (const [fileName, content] of staleDesignArtifacts) {
      writeFileSync(join(specDir, fileName), content, 'utf8');
    }
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Implement the stale application workflow',
      'Workflow: feature',
      'Status: pending',
      'Execution Phase: planning',
      `<!-- autocode-plan-meta: ${JSON.stringify({
        source_task: {
          design_contract: {
            version: 5,
            path: 'design.md',
            paths: [
              'design.md',
              'requirement_model.md',
              'domain_model.md',
              'design_model.md',
              'implementation_model.md',
            ],
            fingerprint: 'stale-design-package',
          },
        },
      })} -->`,
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(specDir, 'planning-transaction.json'), JSON.stringify({
      version: 1,
      id: 'documentation-resume-transaction',
      phase: 'planning',
      status: 'repair_required',
      stage: 'implementation_model_validated',
      checkpoint: 'implementation_model_validated',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:01:00.000Z',
      baselineArtifactHashes: {},
      artifactHashes: {},
    }, null, 2), 'utf8');
    const callsPath = join(projectRoot, 'documentation-resume-calls.jsonl');
    const fakeCliPath = join(projectRoot, 'documentation-resume-planner.cjs');
    writeNonImplementationPlanningCli({
      cliPath: fakeCliPath,
      specDir,
      callsPath,
      tasks: tasksMarkdown,
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId,
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'planning',
      forcePlanning: true,
    });
    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 20_000,
    });

    const calls = readFileSync(callsPath, 'utf8').trim().split(/\r?\n/).map((line) => (
      JSON.parse(line) as { stage: string; prompt: string }
    ));
    expect(calls.map((call) => call.stage)).toEqual(['tasks']);
    expect(calls[0].prompt).toContain('It does not use a Design-Contract package.');
    expect(calls[0].prompt).not.toContain('Design-Contract: 5');
    for (const [fileName, content] of staleDesignArtifacts) {
      expect(readFileSync(join(specDir, fileName), 'utf8')).toBe(content);
    }
    expect(loadAutocodeImplementationPlanSync(specDir)?.source_task)
      .not.toHaveProperty('design_contract');
    expect(JSON.parse(readFileSync(join(specDir, 'planning-transaction.json'), 'utf8')))
      .toMatchObject({
        id: 'documentation-resume-transaction',
        ownerStages: ['tasks'],
        status: 'completed',
        checkpoint: 'committed',
      });
  });

  it('keeps Design-Contract 5 when an analysis-labelled task explicitly requests implementation', () => {
    const taskId = '001-analysis-implementation-planning';
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: taskId,
      title: 'Analyze and fix the runtime worker',
      description: 'Analyze the failure, then fix worker.ts and update its tests.',
      metadata: { developmentMode: 'standard', taskType: 'analysis' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: taskId });
    writeFileSync(join(specDir, 'requirements.md'), [
      '# Requirements',
      '',
      'Requirements-Contract: 1',
      '',
      '## User Requirements',
      '- R1: Repair the runtime worker failure.',
      '',
      '## Acceptance Criteria',
      '- AC1: Updated tests prove the worker handles the failure.',
      '',
      '## Evidence Sources',
      '- E1: Runtime failure log and src/worker.ts.',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(specDir, 'spec.md'), [
      '# Specification: Repair the runtime worker',
      '',
      'Specification-Contract: 1',
      '',
      '### SCN-001 Handle the failing worker input',
      'Covers: R1, AC1',
      'Evidence: E1',
      '- Given: the failing worker input is received.',
      '- When: the worker processes the input.',
      '- Then: the worker completes without the observed failure.',
      '',
    ].join('\n'), 'utf8');
    const capturedPromptPath = join(projectRoot, 'analysis-implementation-owner-prompt.txt');
    const fakeCliPath = join(projectRoot, 'capture-analysis-implementation-owner.cjs');
    writeFileSync(fakeCliPath, [
      "const { writeFileSync } = require('node:fs');",
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      `  writeFileSync(${JSON.stringify(capturedPromptPath)}, prompt, 'utf8');`,
      '  process.exitCode = 9;',
      '});',
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId,
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'planning',
      forcePlanning: true,
    });
    expect(plan.prompt).toContain('requirement_model.md owns RM/FUN/SSD');
    expect(plan.prompt).not.toContain('This is a non-implementation workflow.');
    expect(() => execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    })).toThrow();

    const capturedPrompt = readFileSync(capturedPromptPath, 'utf8');
    expect(capturedPrompt).toContain('# Standard Requirement Model Stage');
    expect(capturedPrompt).toContain('Design-Contract: 5');
    expect(JSON.parse(readFileSync(join(specDir, 'planning-transaction.json'), 'utf8')))
      .toMatchObject({
        ownerStages: [
          'requirement_model',
          'domain_model',
          'design',
          'design_model',
          'implementation_model',
          'design_review',
          'tasks',
        ],
      });
  });

  it('includes review input while retaining the staged artifact ownership contract', () => {
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

    expect(plan.prompt).toContain('## Human Input');
    expect(plan.prompt).toContain('RequestChanges: split the runtime task.');
    expect(plan.prompt).toContain('For Request Changes, use the latest impacts/flowDocuments');
    expect(plan.prompt).toContain('preserve unaffected stable IDs, completed task definitions, and dependency relationships');
    expect(plan.prompt).not.toContain('needs_revision');
  });

  it('starts tasks-only Request Changes at the planner and isolates old transactions', () => {
    const taskId = '001-tasks-only-owner-plan';
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: taskId,
      title: 'Revise only task definitions',
      description: 'Keep upstream Standard artifacts unchanged.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: taskId });
    writeFileSync(join(specDir, 'requirements.md'), [
      '# Requirements',
      '',
      'Requirements-Contract: 1',
      '',
      '## User Requirements',
      '- R1: Preserve approved upstream planning artifacts.',
      '',
      '## Acceptance Criteria',
      '- AC1: A tasks-only change starts at the tasks owner.',
      '',
      '## Evidence Sources',
      '- E1: change_requests.jsonl records the approved tasks-only scope.',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(specDir, 'spec.md'), [
      '# Specification: Tasks-only owner plan',
      '',
      'Specification-Contract: 1',
      '',
      '## SCN-001 Revise task definitions',
      'Covers: R1, AC1',
      'Evidence: E1',
      '',
      '- Given: upstream planning artifacts are approved.',
      '- When: a tasks-only change is requested.',
      '- Then: planning starts at the tasks owner.',
      '- Errors/edges: invalid upstream artifacts expand repair to their owning stage.',
      '',
    ].join('\n'), 'utf8');
    writeValidStandardDesignArtifacts(specDir);
    writeFileSync(join(specDir, 'change_requests.jsonl'), JSON.stringify({
      id: 'CR-NEW',
      createdAt: '2026-07-15T01:00:00.000Z',
      scope: 'planning',
      impacts: ['tasks', 'validation'],
      iteration: {
        mode: 'standard-planning',
        flowDocuments: ['HUMAN_INPUT.md', 'change_requests.jsonl', 'tasks.md'],
      },
    }) + '\n', 'utf8');
    writeFileSync(join(specDir, 'planning-transaction.json'), JSON.stringify({
      version: 1,
      id: 'old-transaction',
      phase: 'planning',
      status: 'repair_required',
      stage: 'plan_validated',
      checkpoint: 'plan_validated',
      changeRequestId: 'CR-OLD',
      createdAt: '2026-07-14T01:00:00.000Z',
      updatedAt: '2026-07-14T01:00:00.000Z',
      baselineArtifactHashes: {},
      artifactHashes: {},
    }, null, 2), 'utf8');

    const capturedPromptPath = join(projectRoot, 'tasks-only-owner-prompt.txt');
    const fakeCliPath = join(projectRoot, 'capture-tasks-owner.cjs');
    writeFileSync(fakeCliPath, [
      'const { writeFileSync } = require(\'node:fs\');',
      'let input = \'\';',
      'process.stdin.setEncoding(\'utf8\');',
      'process.stdin.on(\'data\', chunk => { input += chunk; });',
      'process.stdin.on(\'end\', () => { writeFileSync(' +
        JSON.stringify(capturedPromptPath) +
        ', input, \'utf8\'); process.exitCode = 9; });',
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId,
      cli: 'custom',
      customCommand: 'node ' + fakeCliPath.replaceAll(String.fromCharCode(92), '/'),
      phase: 'planning',
      forcePlanning: true,
    });

    expect(() => execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    })).toThrow();

    const capturedPrompt = readFileSync(capturedPromptPath, 'utf8');
    expect(capturedPrompt).toContain('# Standard Task Planning Stage');
    expect(capturedPrompt).not.toContain('## STANDARD REQUIREMENTS STAGE ONLY');
    // Candidate 1: validateAutocodeTaskDesignReferences requires every FUN/STATE/LANG
    // to be covered by a task and every implementation task to cite SYS/FUN/LANG, so
    // the tasks planning prompt must list them as referenceable and require coverage.
    expect(capturedPrompt).toContain(
      'FUN in requirement_model.md',
    );
    expect(capturedPrompt).toContain(
      'across all tasks cover every SYS-*, FUN-*, STATE-*, LANG-*, required IMP-*, selected PAT-*, and REV-* unit.',
    );
    const transaction = JSON.parse(
      readFileSync(join(specDir, 'planning-transaction.json'), 'utf8'),
    ) as {
      id?: string;
      changeRequestId?: string;
      ownerStages?: string[];
      resumedAt?: string;
    };
    expect(transaction).toMatchObject({
      changeRequestId: 'CR-NEW',
      ownerStages: ['tasks'],
    });
    expect(transaction.id).not.toBe('old-transaction');
    expect(transaction.resumedAt).toBeUndefined();
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
    expect(runner).toContain('const shouldPreserveCompletedState = shouldPreserveCompletedTasksInStandardPlanning();');
    expect(runner).toContain('includeCompletedTasks: shouldPreserveCompletedState');
    expect(runner).toContain('preserveCompletedStateFromPreviousPlanMarkdown: previousImplementationPlanMarkdown');
    expect(runner).not.toContain('repairStandardPlanEvidenceScaffolding();');
    expect(runner).toContain('hasOnlyStandardPlanRecoverableQualityErrors(planQuality, errors)');
    expect(runner).toContain('function isStandardPlanRecoverableQualityError(planQuality, error)');
    expect(runner).toContain('isAutocodePlanRecoverableQualityError');
    expect(runner).toContain('function isStandardPlanArchitectureGuidanceError(planQuality, error)');
    expect(runner).toContain('isAutocodePlanArchitectureGuidanceError');
    expect(runner).toContain('complex task\\(s\\) missing _Architecture: \\.\\.\\._ guidance');
    expect(runner).toContain('spec.md must declare Specification-Contract: 1');
    expect(runner).toContain('requirements.md must include concrete User Requirements and Acceptance Criteria');
    expect(runner).toContain('validationRetryCount >= maxValidationRetries');
    expect(runner).toContain('const STANDARD_PLANNING_STAGE_RETRY_MAX_CHARS = 16000;');
    expect(runner).toContain('const STANDARD_DESIGN_STAGE_MAX_RETRIES = 3;');
    // Planning must report stage-based progress so the UI advances through its owner stages
    // instead of freezing at a single percentage.
    expect(runner).toContain('function emitStandardPlanningStageProgress(stage)');
    expect(runner).toContain('emitStandardPlanningStageProgress(stage);');
    // Requirements stage must ground quantitative facts with concrete values and flag hard
    // implementation/testability gates so downstream models and the human gate can act early.
    expect(runner).toContain('so downstream models and tests have ground truth instead of placeholders');
    expect(runner).toContain('[BLOCKS-IMPLEMENTATION]');
    // Fail fast: planning stops for user input right after requirements when blocking open
    // questions exist, instead of building the five design models on an unresolvable base.
    expect(runner).toContain('detectStandardRequirementsBlockingGate');
    expect(runner).toContain("completedStage === 'requirements'");
    expect(runner).toContain('has implementation-blocking open questions');
    // The independent review must bias toward PASSED so minor issues don't trigger costly
    // revision rounds and re-planning popups.
    expect(runner).toContain('Bias toward Status: PASSED');
    expect(runner).toContain('Do not REVISE for style, wording, verbosity');
    expect(runner).toContain('Use unresolved - only as the leading provenance of an Evidence clause');
    // A REVISE must feed the reviewer's actual findings into the revision stage so it fixes
    // the cited defects instead of blindly regenerating the same design.
    expect(runner).toContain('The independent design review returned Status: REVISE. Resolve every blocking finding below');
    expect(runner).toContain('selectStandardDesignRevisionOwnerStages(revisionEvidence)');
    expect(runner).toContain('scheduleStandardPlanningFocusedRepair');
    expect(runner).toContain('Focused repair passed deterministic validation; reusing unaffected owner artifacts');
    expect(runner).toContain('continuing with deterministic validation without another model call');
    // Transient provider network drops during spec/design must be retried, not hard-failed.
    expect(runner).toContain('function isTransientCliNetworkFailure(message)');
    expect(runner).toContain('const STANDARD_TRANSIENT_NETWORK_MAX_RETRIES = 3;');
    expect(runner).toContain('Autocode CLI hit a transient network error');
    // Speedup: the requirement_model stage co-generates a first-pass domain_model, and the
    // advance loop skips a generation stage's CLI call when its artifact already validates.
    expect(runner).toContain('so the separate domain-modeling round-trip can be skipped when the domain model already validates');
    expect(runner).toContain('so the separate implementation-mapping round-trip can be skipped when that model already validates');
    expect(runner).toContain('and already validates; skipping its generation call');
    // Both co-generation pairs are declared, and the skip is gated on a freshly written
    // artifact (mtime at/after the attempt start) so a stale-but-valid file from an
    // interrupted run is never skipped.
    // B: each design stage sends a trimmed per-stage contract, and retries fall back to the
    // full contract so a failing stage still sees every rule.
    expect(runner).toContain('function selectStandardDesignContractPrompt(stage, validationError)');
    expect(runner).toContain('const standardDesignStageContractPrompt =');
    expect(runner).toContain('selectStandardDesignContractPrompt(stage, validationError),');
    // D: the spec stage self-checks R*/AC* coverage before finalizing, so an uncovered id is
    // fixed in the same turn instead of costing another round-trip.
    expect(runner).toContain('Before finalizing, self-check coverage: enumerate every R* and AC* id');
    // Design quality: architecture candidates must differ substantively, patterns are decided per
    // variation, responsibilities are assigned with GRASP, and the review scores a rubric that
    // mechanically decides PASSED vs REVISE.
    expect(runner).toContain('Make the candidates substantively different');
    expect(runner).toContain('<variation | direct mechanism | candidate pattern(s) | chosen mechanism | rejection reason>');
    expect(runner).toContain('Assign every responsibility with GRASP and name the principle used');
    expect(runner).toContain('## Design Scorecard');
    expect(runner).toContain('Derive Status mechanically from the scorecard');
    expect(runner).toContain('const standardDesignCoGeneratedStage = {');
    expect(runner).toContain("requirement_model: 'domain_model',");
    expect(runner).toContain("design_model: 'implementation_model',");
    expect(runner).toContain('statSync(coGeneratedPath).mtimeMs >= currentAttemptStartedAt');
    expect(runner).toContain('const STANDARD_DESIGN_UPSTREAM_REPAIR_MAX_REVISIONS = standardDesignGenerationStageOrder.length;');
    expect(runner).toContain('found an upstream owner error; repair');
    expect(runner).toContain("' reruns only ' + repairStages.join(' -> ')");
    // Planning must stop promptly when the independent review needs user input,
    // instead of consuming its revision rounds and rolling back.
    expect(runner).toContain('detectStandardDesignReviewHumanInputGate');
    expect(runner).toContain('detectAutocodeDesignReviewHumanInputGate');
    expect(runner).toContain('Standard planning paused: independent design review needs user input');
    expect(runner).toContain('repairStageIndex < completedStageIndex');
    // The paused-for-input event carries the reviewer's structured decision options so the
    // desktop UI can present a recommended default choice per open question.
    expect(runner).toContain('decisions: humanInputDecisions');
    // The design_review stage prompt must ask the reviewer to emit those options.
    expect(runner).toContain('## Human Decision Options');
    expect(runner).toContain('### HQ-001 <short question>');
    expect(runner).toContain('Option A (recommended):');
    expect(runner).toContain('[/\\brequirement_model\\.md\\b/i');
    expect(runner).toContain('[/\\bdesign\\.md\\b/i');
    expect(runner).toContain("if (/Source Reconstruction/i.test(text)) return 'design_model';");
    expect(runner).toContain('buildAutocodeDesignQualityRetryPrompt(errors)');
    expect(runner).toContain('standardDesignMachineContractPrompt');
    expect(runner).toContain('- DOM Concept kind: entity|value-object|aggregate|domain-service|policy|event|role|resource|technical|other');
    expect(runner).toContain('- Element: module|class|component|function|store|process|data-structure|other - <localized concrete element or symbol>');
    expect(runner).toContain('Declare Design-Contract: 5');
    expect(runner).toContain('await validateRunnerRuntimeDesignContract()');
    expect(runner).toContain('validateAutocodeDesignPackageIdentity');
    expect(runner).toContain('does not bind the exact five-file Design-Contract: 5 package');
    expect(runner).toContain('ADR|RM|FUN|SSD|DOM|SYS|DES|STATE|FLOW|CONTRACT|PAT|REV|LANG|IMP');
    expect(runner).toContain('map the target symbol to IMP-*');
    expect(runner).toContain('its SYS-* owner/interface');
    expect(runner).toContain('Preserve the approved object, component, data-oriented, functional, procedural, or mixed paradigm');
    expect(runner).toContain('source contradicts REV-*');
    expect(runner).toContain('material ownership/design change is required');
  });

  it('keeps every Standard planning stage in the configured Chinese output language', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-chinese-stages',
      title: '保持设计评审语言一致',
      description: '设计、评审和任务规划均使用中文。',
      metadata: { developmentMode: 'standard' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-chinese-stages',
      cli: 'codex',
      phase: 'planning',
      language: 'zh-CN',
    });
    const runner = readFileSync(plan.runnerFilePath, 'utf8');

    expect(runner).toContain('design_review.md 的首行仍必须精确使用 Status: PASSED 或 Status: REVISE');
    expect(runner).toContain('后续评审正文必须使用简体中文');
    expect(runner).toContain('不要把英文字段名直译后堆砌名词短语');
    expect(runner).toContain('## OUTPUT LANGUAGE REQUIREMENT');
    expect(runner).toContain('do not write _Depends on_: or _Design_:');
    expect(runner).toContain('do not use a free-form _File intent_: sentence');
  });

  it('retries Standard scheduling metadata validation after artifact retries are exhausted', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-scheduling-retry',
      title: 'Retry derived scheduling metadata repair',
      description: 'Planning should repair tasks.md when derived work packages lack scheduling metadata.',
      metadata: { developmentMode: 'standard' },
    });

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-scheduling-retry',
      cli: 'codex',
      phase: 'planning',
    });
    const runner = readFileSync(plan.runnerFilePath, 'utf8');

    expect(runner).toContain('const maxSchedulingMetadataRetries = phase === \'spec\' || phase === \'planning\' ? 1 : 0;');
    expect(runner).toContain('let schedulingMetadataRetryCount = 0;');
    expect(runner).toContain('const canUseSchedulingRetry = schedulingMetadataError && schedulingMetadataRetryCount < maxSchedulingMetadataRetries;');
    expect(runner).toContain('function isPlanningSchedulingMetadataValidationError(value)');
    expect(runner).toContain('implementation_plan\\.md missing scheduling metadata');
    expect(runner).toContain('The derived implementation_plan.md is missing runtime scheduling metadata. Repair tasks.md');
    expect(runner).toContain('make every executable tasks.md item carry metadata that can be copied into derived runtime work packages');
    expect(runner).toContain('function canFinalizeStandardPlanningFromPersistedTasks()');
    expect(runner).toContain('if (standardPlanningStage !== \'tasks\')');
    expect(runner).toContain('tasks.md has not been regenerated; resuming the tasks owner');
  });
  it('keeps Standard spec evidence as ID references without adding duplicate evidence prose', () => {
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
      'Requirements-Contract: 1',
      '',
      '## User Requirements',
      '- R1: Planning validation keeps a traceable Standard task list.',
      '',
      '## Acceptance Criteria',
      '- AC1: Runtime work packages are derived from tasks.md after validation passes.',
      '',
      '## Evidence Sources',
      '- E1: User task description captured by Autocode.',
      '',
    ].join('\n');
    const specMarkdown = [
      '# Specification: Repair planning evidence',
      '',
      'Specification-Contract: 1',
      '',
      '## Scope',
      'Describe observable runtime-plan derivation without repeating requirement or evidence prose.',
      '',
      '## SCN-001 Derive the runtime ledger',
      'Covers: R1, AC1',
      'Evidence: E1',
      '- Given validated static task definitions',
      '- When Standard planning is committed',
      '- Then implementation_plan.md exposes one pending runtime work package.',
      '',
    ].join('\n');
    const tasksMarkdown = [
      '# Tasks',
      '',
      'Tasks-Contract: 1',
      '',
      'Feature: Repair planning evidence',
      'Workflow: simple',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Update evidence repair path',
      '    - Update `src/evidence.ts` to add Standard evidence scaffolding before validation.',
      '    - _Files to modify: src/evidence.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1, SCN-001_',
      '    - _Evidence: E1; requirements.md E1; src/evidence.ts_',
      '    - _Done when: validation repairs missing evidence and derives the runtime plan_',
      '    - _Verification: npm test -- evidence.test.ts_',
      '',
    ].join('\n');
    const tasksWithDesignMarkdown = withStandardDesignMetadata(tasksMarkdown);
    writeValidStandardDesignArtifacts(specDir);
    const fakeCliPath = join(projectRoot, 'write-standard-artifacts.cjs');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const specDir = process.argv[2];',
      'mkdirSync(specDir, { recursive: true });',
      `writeFileSync(join(specDir, 'requirements.md'), ${JSON.stringify(requirementsMarkdown)}, 'utf8');`,
      `writeFileSync(join(specDir, 'spec.md'), ${JSON.stringify(specMarkdown)}, 'utf8');`,
      `writeFileSync(join(specDir, 'design_review.md'), ${JSON.stringify(VALID_STANDARD_DESIGN_REVIEW)}, 'utf8');`,
      `writeFileSync(join(specDir, 'tasks.md'), ${JSON.stringify(tasksWithDesignMarkdown)}, 'utf8');`,
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-evidence-repair',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}" "${specDir.replace(/\\/g, '/')}"`,
      phase: 'planning',
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const persistedSpec = readFileSync(join(specDir, 'spec.md'), 'utf8');
    expect(persistedSpec).toBe(specMarkdown);
    expect(persistedSpec).toContain('Evidence: E1');
    expect(persistedSpec).not.toContain('## Evidence');
    const implementationPlan = loadAutocodeImplementationPlanSync(specDir);
    expect(implementationPlan?.phases?.[0]?.subtasks?.[0]?.title).toContain('Update evidence repair path');
    const planningEvent = stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('__TASK_EVENT__:'))
      .map((line) => JSON.parse(line.slice('__TASK_EVENT__:'.length)) as Record<string, unknown>)
      .find((event) => event.type === 'PLANNING_COMPLETE');
    expect(planningEvent).toMatchObject({
      type: 'PLANNING_COMPLETE',
      hasSubtasks: true,
      subtaskCount: 1,
      incompleteSubtaskCount: 1,
      continueAfterPlanning: false,
      requireReviewBeforeCoding: true,
    });
  });

  it('runs independent Standard owner stages and repairs a localized malformed design', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-independent-planning-sessions',
      title: 'Run independent design-first planning sessions',
      description: 'Separate Standard requirements, specification, design, critique, and task generation contexts.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '001-standard-independent-planning-sessions',
    });
    const specMarkdown = [
      '# Specification: Independent planning sessions',
      '',
      'Specification-Contract: 1',
      '',
      '## SCN-001 Complete isolated planning stages',
      'Covers: R1, AC1',
      'Evidence: E1',
      '- Given a new Standard planning run',
      '- When each artifact owner finishes',
      '- Then planning reaches human review without sharing a CLI session.',
      '',
    ].join('\n');
    const requirementsMarkdown = [
      '# Requirements',
      '',
      'Requirements-Contract: 1',
      '',
      '## User Requirements',
      '- R1: Standard planning separates requirements, specification, design, critique, and task generation.',
      '',
      '## Acceptance Criteria',
      '- AC1: Five stage-specific artifact owners complete before human review.',
      '',
      '## Evidence Sources',
      '- E1: Generated planning-session audit and src/planning-sessions.ts.',
      '',
    ].join('\n');
    const tasksMarkdown = withStandardDesignMetadata([
      '# Tasks',
      '',
      'Tasks-Contract: 1',
      '',
      'Feature: Independent planning sessions',
      'Workflow: feature',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Preserve independent planning sessions',
      '    - Keep each Standard planning role in a fresh CLI invocation.',
      '    - _Files to modify: src/planning-sessions.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1, SCN-001_',
      '    - _Evidence: E1; requirements.md E1; src/planning-sessions.ts_',
      '    - _Done when: all five owner stages complete before review_',
      '    - _Verification: Start the CLI planner, exercise all four stage sessions, and check console errors, resource loading, blank screen, startup, and exit status._',
      '',
    ].join('\n'));
    const callsPath = join(projectRoot, 'planning-session-calls.jsonl');
    const fakeCliPath = join(projectRoot, 'stage-aware-standard-planner.cjs');
    const malformedDesign = createLocalizedMalformedStandardDesign();
    writeFileSync(join(specDir, 'design_review.md'), 'Status: PASSED\n\nStale review from the previous design.\n', 'utf8');
    writeFileSync(fakeCliPath, [
      `const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');`,
      `const { join } = require('node:path');`,
      `const specDir = process.argv[2];`,
      `const callsPath = process.argv[3];`,
      `let prompt = '';`,
      `process.stdin.setEncoding('utf8');`,
      `process.stdin.on('data', (chunk) => { prompt += chunk; });`,
      `process.stdin.on('end', () => {`,
      `  const stage = prompt.includes('## STANDARD REQUIREMENTS STAGE ONLY') ? 'requirements'`,
      `    : prompt.includes('# Standard Observable Specification Stage') ? 'spec'`,
      `      : prompt.includes('# Standard Requirement Model Stage') ? 'requirement_model'`,
      `        : prompt.includes('# Standard Domain Model Stage') ? 'domain_model'`,
      `          : prompt.includes('# Standard Architecture Decision Stage') ? 'design'`,
      `            : prompt.includes('# Standard Design Model Stage') ? 'design_model'`,
      `              : prompt.includes('# Standard Implementation Model Stage') ? 'implementation_model'`,
      `                : prompt.includes('# Independent Standard Design Review') ? 'design_review'`,
      `                  : prompt.includes('# Standard Task Planning Stage') ? 'tasks' : 'unknown';`,
      `  const designAttempt = stage === 'design' ? (existsSync(join(specDir, 'design.md')) ? 2 : 1) : 0;`,
      `  mkdirSync(specDir, { recursive: true });`,
      `  appendFileSync(callsPath, JSON.stringify({ stage, pid: process.pid, designAttempt, hadReview: stage === 'design_review' && existsSync(join(specDir, 'design_review.md')), hasBudgetContract: prompt.includes('- Expected modules changed: <non-negative integer>') && prompt.includes('do not use headings for these fields'), hasRetryHeader: prompt.includes('The Standard design artifacts failed deterministic validation.'), hasShortIdError: prompt.includes('heading ADR-1 is invalid'), hasLateEvidenceError: prompt.includes('Unresolved evidence must be exactly'), hasPrinciplesContract: prompt.includes('- Applicable Design Principles: Single-responsibility decision;') }) + '\\n', 'utf8');`,
      `  if (stage === 'requirements') {`,
      `    writeFileSync(join(specDir, 'requirements.md'), ${JSON.stringify(requirementsMarkdown)}, 'utf8');`,
      `  } else if (stage === 'spec') {`,
      `    writeFileSync(join(specDir, 'spec.md'), ${JSON.stringify(specMarkdown)}, 'utf8');`,
      `  } else if (stage === 'requirement_model') {`,
      `    writeFileSync(join(specDir, 'requirement_model.md'), ${JSON.stringify(VALID_STANDARD_REQUIREMENT_MODEL)}, 'utf8');`,
      `  } else if (stage === 'domain_model') {`,
      `    writeFileSync(join(specDir, 'domain_model.md'), ${JSON.stringify(VALID_STANDARD_DOMAIN_MODEL)}, 'utf8');`,
      `  } else if (stage === 'design') {`,
      `    writeFileSync(join(specDir, 'design.md'), designAttempt === 1 ? ${JSON.stringify(malformedDesign)} : ${JSON.stringify(VALID_STANDARD_DESIGN)}, 'utf8');`,
      `  } else if (stage === 'design_model') {`,
      `    writeFileSync(join(specDir, 'design_model.md'), ${JSON.stringify(VALID_STANDARD_DESIGN_MODEL)}, 'utf8');`,
      `  } else if (stage === 'implementation_model') {`,
      `    writeFileSync(join(specDir, 'implementation_model.md'), ${JSON.stringify(VALID_STANDARD_IMPLEMENTATION_MODEL)}, 'utf8');`,
      `  } else if (stage === 'design_review') {`,
      `    writeFileSync(join(specDir, 'design_review.md'), ${JSON.stringify(VALID_STANDARD_DESIGN_REVIEW)}, 'utf8');`,
      `  } else if (stage === 'tasks') {`,
      `    writeFileSync(join(specDir, 'tasks.md'), ${JSON.stringify(tasksMarkdown)}, 'utf8');`,
      `  } else {`,
      `    process.exitCode = 2;`,
      `  }`,
      `  process.stdout.write(stage + ' complete\\n');`,
      `});`,
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-independent-planning-sessions',
      cli: 'custom',
      customCommand: `node ${fakeCliPath.replace(/\\/g, '/')} ${specDir.replace(/\\/g, '/')} ${callsPath.replace(/\\/g, '/')}`,
      phase: 'spec',
    });

    let stdout = '';
    let executionFailure = '';
    try {
      stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
        cwd: projectRoot,
        env: { ...process.env, GRAPHITI_ENABLED: 'false' },
        encoding: 'utf8',
        timeout: 15_000,
      });
    } catch (error) {
      const outputError = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      const outputText = (value?: Buffer | string): string =>
        typeof value === 'string' ? value : value?.toString('utf8') ?? '';
      executionFailure = [
        outputError.message,
        outputText(outputError.stdout),
        outputText(outputError.stderr),
        existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '',
        existsSync(join(specDir, 'task_logs.jsonl'))
          ? readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8')
          : '',
      ].filter(Boolean).join('\n');
    }
    const calls = readFileSync(callsPath, 'utf8').trim().split(/\r?\n/).map((line) => (
      JSON.parse(line) as {
        stage: string;
        pid: number;
        designAttempt: number;
        hadReview: boolean;
        hasBudgetContract: boolean;
        hasRetryHeader: boolean;
        hasShortIdError: boolean;
        hasLateEvidenceError: boolean;
        hasPrinciplesContract: boolean;
      }
    ));
    const retryCall = calls.find((call) => call.stage === 'design' && call.designAttempt === 2);

    expect(executionFailure).toBe('');
    expect(calls.map((call) => call.stage)).toEqual([
      'requirements',
      'spec',
      'requirement_model',
      'domain_model',
      'design',
      'design',
      'design_model',
      'implementation_model',
      'design_review',
      'tasks',
    ]);
    expect(new Set(calls.map((call) => call.pid)).size).toBe(10);
    expect(calls.find((call) => call.stage === 'design_review')?.hadReview).toBe(false);
    expect(calls.find((call) => call.stage === 'design')?.hasBudgetContract).toBe(true);
    expect(retryCall).toMatchObject({
      hasRetryHeader: true,
      hasPrinciplesContract: true,
    });
    expect(stdout).toContain('PLANNING_COMPLETE');
    expect(stdout).toContain('requireReviewBeforeCoding');
    expect(loadAutocodeImplementationPlanSync(specDir)?.phases?.[0]?.subtasks).toHaveLength(1);
  });

  it('repairs only the directly invalid design owner and reuses valid downstream models', () => {
    const taskId = '001-standard-focused-design-repair';
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: taskId,
      title: 'Focus deterministic design repair',
      description: 'Repair one invalid design artifact without regenerating valid downstream models.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: taskId });
    const requirementsMarkdown = [
      '# Requirements',
      '',
      'Requirements-Contract: 1',
      '',
      '## User Requirements',
      '- R1: Repair only the design artifact that owns a deterministic validation error.',
      '',
      '## Acceptance Criteria',
      '- AC1: Valid downstream model artifacts are reused after focused validation passes.',
      '',
      '## Evidence Sources',
      '- E1: planning-transaction.json and the focused owner call log.',
      '',
    ].join('\n');
    const specMarkdown = [
      '# Specification: Focus deterministic design repair',
      '',
      'Specification-Contract: 1',
      '',
      '## SCN-001 Reuse valid downstream models',
      'Covers: R1, AC1',
      'Evidence: E1',
      '- Given a complete design package with one invalid design.md traceability field',
      '- When implementation_model validation reports the upstream owner error',
      '- Then only design.md is repaired before deterministic validation resumes.',
      '',
    ].join('\n');
    const tasksMarkdown = withStandardDesignMetadata([
      '# Tasks',
      '',
      'Tasks-Contract: 1',
      '',
      'Feature: Focus deterministic design repair',
      'Workflow: feature',
      '',
      '- [ ] 1. Focused repair',
      '',
      '  - [ ] 1.1 Reuse downstream models',
      '    - Preserve valid model artifacts after repairing design.md.',
      '    - _Files to modify: src/focused-repair.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1, SCN-001_',
      '    - _Evidence: E1; requirements.md E1; src/focused-repair.ts existing repair boundary_',
      '    - _Done when: design_model.md and implementation_model.md are not regenerated_',
      '    - _Verification: npm test -- focused-repair.test.ts_',
      '',
    ].join('\n'));
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'requirements.md'), requirementsMarkdown, 'utf8');
    writeFileSync(join(specDir, 'spec.md'), specMarkdown, 'utf8');
    writeValidStandardDesignArtifacts(specDir);
    writeFileSync(
      join(specDir, 'design.md'),
      VALID_STANDARD_DESIGN.replace(' -> LANG-001 -> IMP-001', ''),
      'utf8',
    );
    writeFileSync(join(specDir, 'planning-transaction.json'), JSON.stringify({
      version: 1,
      id: 'focused-design-repair-transaction',
      phase: 'planning',
      status: 'repair_required',
      stage: 'design_model_validated',
      checkpoint: 'design_model_validated',
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
      baselineArtifactHashes: {},
      artifactHashes: {},
    }, null, 2), 'utf8');

    const callsPath = join(projectRoot, 'focused-design-repair-calls.jsonl');
    const fakeCliPath = join(projectRoot, 'focused-design-repair-cli.cjs');
    writeFileSync(fakeCliPath, [
      `const { appendFileSync, writeFileSync } = require('node:fs');`,
      `const { join } = require('node:path');`,
      `const specDir = process.argv[2];`,
      `const callsPath = process.argv[3];`,
      `let prompt = '';`,
      `process.stdin.setEncoding('utf8');`,
      `process.stdin.on('data', (chunk) => { prompt += chunk; });`,
      `process.stdin.on('end', () => {`,
      `  const stage = prompt.includes('# Standard Architecture Decision Stage') ? 'design'`,
      `    : prompt.includes('# Standard Design Model Stage') ? 'design_model'`,
      `      : prompt.includes('# Standard Implementation Model Stage') ? 'implementation_model'`,
      `        : prompt.includes('# Independent Standard Design Review') ? 'design_review'`,
      `          : prompt.includes('# Standard Task Planning Stage') ? 'tasks' : 'unknown';`,
      `  appendFileSync(callsPath, JSON.stringify({ stage, focused: prompt.includes('Previous stage validation') }) + '\\n', 'utf8');`,
      `  if (stage === 'design') {`,
      `    writeFileSync(join(specDir, 'design.md'), ${JSON.stringify(VALID_STANDARD_DESIGN)}, 'utf8');`,
      `  } else if (stage === 'design_model') {`,
      `    writeFileSync(join(specDir, 'design_model.md'), ${JSON.stringify(VALID_STANDARD_DESIGN_MODEL)}, 'utf8');`,
      `  } else if (stage === 'implementation_model') {`,
      `    writeFileSync(join(specDir, 'implementation_model.md'), ${JSON.stringify(VALID_STANDARD_IMPLEMENTATION_MODEL)}, 'utf8');`,
      `  } else if (stage === 'design_review') {`,
      `    writeFileSync(join(specDir, 'design_review.md'), ${JSON.stringify(VALID_STANDARD_DESIGN_REVIEW)}, 'utf8');`,
      `  } else if (stage === 'tasks') {`,
      `    writeFileSync(join(specDir, 'tasks.md'), ${JSON.stringify(tasksMarkdown)}, 'utf8');`,
      `  } else {`,
      `    process.exitCode = 2;`,
      `  }`,
      `});`,
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId,
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}" "${specDir.replace(/\\/g, '/')}" "${callsPath.replace(/\\/g, '/')}"`,
      phase: 'planning',
    });
    let stdout = '';
    let executionFailure = '';
    try {
      stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
        cwd: projectRoot,
        env: { ...process.env, GRAPHITI_ENABLED: 'false' },
        encoding: 'utf8',
        timeout: 20_000,
      });
    } catch (error) {
      const outputError = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      const outputText = (value?: Buffer | string): string =>
        typeof value === 'string' ? value : value?.toString('utf8') ?? '';
      executionFailure = [
        outputError.message,
        outputText(outputError.stdout),
        outputText(outputError.stderr),
        existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '',
        existsSync(join(specDir, 'task_logs.jsonl'))
          ? readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8')
          : '',
      ].filter(Boolean).join('\n');
    }
    expect(executionFailure).toBe('');
    const calls = readFileSync(callsPath, 'utf8').trim().split(/\r?\n/).map((line) => (
      JSON.parse(line) as { stage: string; focused: boolean }
    ));
    const taskLog = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');

    expect(calls.map((call) => call.stage)).toEqual([
      'implementation_model',
      'design',
      'design_review',
      'tasks',
    ]);
    expect(calls.filter((call) => call.stage === 'implementation_model')).toHaveLength(1);
    expect(calls.find((call) => call.stage === 'design')?.focused).toBe(true);
    expect(taskLog).toContain('reruns only design');
    expect(taskLog).toContain('reusing unaffected owner artifacts');
    expect(stdout).toContain('PLANNING_COMPLETE');

    const completedTransaction = JSON.parse(
      readFileSync(join(specDir, 'planning-transaction.json'), 'utf8'),
    ) as Record<string, unknown>;
    writeFileSync(join(specDir, 'planning-transaction.json'), JSON.stringify({
      ...completedTransaction,
      status: 'repair_required',
      stage: 'focused_design_repair',
      checkpoint: 'design_validated',
      focusedRepair: {
        targetStage: 'implementation_model',
        kind: 'upstream',
        ownerStages: ['design'],
        continuationStages: ['design_review', 'tasks'],
        validationError: 'design.md Traceability must include IMP-001.',
      },
    }, null, 2), 'utf8');
    writeFileSync(callsPath, '', 'utf8');

    const resumedPlan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId,
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}" "${specDir.replace(/\\/g, '/')}" "${callsPath.replace(/\\/g, '/')}"`,
      phase: 'planning',
    });
    const resumedStdout = execFileSync(process.execPath, [resumedPlan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    const resumedCalls = readFileSync(callsPath, 'utf8').trim().split(/\r?\n/).map((line) => (
      JSON.parse(line) as { stage: string }
    ));
    const resumedTaskLog = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');

    expect(resumedCalls.map((call) => call.stage)).toEqual(['design_review', 'tasks']);
    expect(resumedTaskLog).toContain(
      'is already valid; continuing with deterministic validation without another model call',
    );
    expect(resumedStdout).toContain('PLANNING_COMPLETE');
  });

  it('preserves validated requirements and resumes the spec owner after spec failure', () => {
    const taskId = '001-standard-spec-resume';
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: taskId,
      title: 'Resume the specification owner',
      description: 'Keep validated requirements when specification validation fails.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: taskId });
    const requirementsMarkdown = [
      '# Requirements',
      '',
      'Requirements-Contract: 1',
      '',
      '## User Requirements',
      '- R1: Preserve validated requirements across a specification failure.',
      '',
      '## Acceptance Criteria',
      '- AC1: Resume at the specification owner without regenerating R1.',
      '',
      '## Evidence Sources',
      '- E1: Persisted planning transaction behavior.',
      '',
    ].join('\n');
    const callsPath = join(projectRoot, 'spec-failure-owner-calls.jsonl');
    const failedCliPath = join(projectRoot, 'spec-failure-owner.cjs');
    writeFileSync(failedCliPath, [
      `const { appendFileSync, writeFileSync } = require('node:fs');`,
      `const { join } = require('node:path');`,
      `const specDir = process.argv[2];`,
      `const callsPath = process.argv[3];`,
      `let prompt = '';`,
      `process.stdin.setEncoding('utf8');`,
      `process.stdin.on('data', chunk => { prompt += chunk; });`,
      `process.stdin.on('end', () => {`,
      `  const stage = prompt.includes('## STANDARD REQUIREMENTS STAGE ONLY') ? 'requirements'`,
      `    : prompt.includes('# Standard Observable Specification Stage') ? 'spec' : 'unknown';`,
      `  appendFileSync(callsPath, stage + '\\n', 'utf8');`,
      `  if (stage === 'requirements') {`,
      `    writeFileSync(join(specDir, 'requirements.md'), ${JSON.stringify(requirementsMarkdown)}, 'utf8');`,
      `  } else if (stage === 'spec') {`,
      `    writeFileSync(join(specDir, 'spec.md'), '# Manual Standard planning seed\\n', 'utf8');`,
      `  } else {`,
      `    process.exitCode = 2;`,
      `  }`,
      `});`,
    ].join('\n'), 'utf8');

    const failedPlan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId,
      cli: 'custom',
      customCommand: `node ${failedCliPath.replace(/\\/g, '/')} ${specDir.replace(/\\/g, '/')} ${callsPath.replace(/\\/g, '/')}`,
      phase: 'spec',
    });
    expect(() => execFileSync(process.execPath, [failedPlan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 20_000,
    })).toThrow();

    const failedCalls = readFileSync(callsPath, 'utf8').trim().split(/\r?\n/);
    const failedTransaction = JSON.parse(
      readFileSync(join(specDir, 'planning-transaction.json'), 'utf8'),
    ) as Record<string, unknown> & { status?: string; checkpoint?: string };
    expect(failedCalls[0]).toBe('requirements');
    expect(failedCalls.slice(1).every((stage) => stage === 'spec')).toBe(true);
    expect(readFileSync(join(specDir, 'requirements.md'), 'utf8')).toBe(requirementsMarkdown);
    expect(existsSync(join(specDir, 'spec.md'))).toBe(false);
    expect(failedTransaction).toMatchObject({
      status: 'repair_required',
      checkpoint: 'requirements_validated',
    });

    const resumedPromptPath = join(projectRoot, 'resumed-spec-owner-prompt.txt');
    const resumedCliPath = join(projectRoot, 'capture-resumed-spec-owner.cjs');
    writeFileSync(resumedCliPath, [
      `const { writeFileSync } = require('node:fs');`,
      `let prompt = '';`,
      `process.stdin.setEncoding('utf8');`,
      `process.stdin.on('data', chunk => { prompt += chunk; });`,
      `process.stdin.on('end', () => {`,
      `  writeFileSync(${JSON.stringify(resumedPromptPath)}, prompt, 'utf8');`,
      `  process.exitCode = 9;`,
      `});`,
    ].join('\n'), 'utf8');
    const resumedPlan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId,
      cli: 'custom',
      customCommand: `node ${resumedCliPath.replace(/\\/g, '/')}`,
      phase: 'planning',
    });
    expect(() => execFileSync(process.execPath, [resumedPlan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    })).toThrow();

    const resumedPrompt = readFileSync(resumedPromptPath, 'utf8');
    expect(resumedPrompt).toContain('# Standard Observable Specification Stage');
    expect(resumedPrompt).not.toContain('## STANDARD REQUIREMENTS STAGE ONLY');
    expect(readFileSync(join(specDir, 'requirements.md'), 'utf8')).toBe(requirementsMarkdown);
  });

  it('preserves validated sources and resumes the design stage after invalid budget formatting', () => {
    const taskId = '001-standard-design-budget-resume';
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: taskId,
      title: 'Resume invalid design budget planning',
      description: 'Keep validated requirements and resume the failed design stage.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: taskId });
    const specMarkdown = [
      '# Specification: Resume invalid design budget planning',
      '',
      'Specification-Contract: 1',
      '',
      '## SCN-001 Resume design validation',
      'Covers: R1, AC1',
      'Evidence: E1',
      '- Given validated requirements and specification artifacts',
      '- When deterministic design validation fails',
      '- Then the next run resumes without replacing those artifacts.',
      '',
    ].join('\n');
    const requirementsMarkdown = [
      '# Requirements',
      '',
      'Requirements-Contract: 1',
      '',
      '## User Requirements',
      '- R1: Continue planning from the failed design stage.',
      '',
      '## Acceptance Criteria',
      '- AC1: Validated source artifacts survive a design-format failure.',
      '',
      '## Evidence Sources',
      '- E1: Persisted planning transaction and src/design-resume.ts.',
      '',
    ].join('\n');
    const tasksMarkdown = withStandardDesignMetadata([
      '# Tasks',
      '',
      'Tasks-Contract: 1',
      '',
      'Feature: Resume invalid design budget planning',
      'Workflow: feature',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Preserve stage-aware planning recovery',
      '    - Continue from the last validated planning boundary.',
      '    - _Files to modify: src/design-resume.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1, SCN-001_',
      '    - _Evidence: E1; requirements.md E1; src/design-resume.ts_',
      '    - _Done when: the design stage resumes without regenerating validated sources_',
      '    - _Verification: npm test -- design-resume.test.ts_',
      '',
    ].join('\n'));
    const failedCallsPath = join(projectRoot, 'failed-design-budget-calls.jsonl');
    const failedCliPath = join(projectRoot, 'failed-design-budget-planner.cjs');
    writeFileSync(failedCliPath, [
      `const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');`,
      `const { join } = require('node:path');`,
      `const specDir = process.argv[2];`,
      `const callsPath = process.argv[3];`,
      `let prompt = '';`,
      `process.stdin.setEncoding('utf8');`,
      `process.stdin.on('data', (chunk) => { prompt += chunk; });`,
      `process.stdin.on('end', () => {`,
      `  const stage = prompt.includes('## STANDARD REQUIREMENTS STAGE ONLY') ? 'requirements'`,
      `    : prompt.includes('# Standard Observable Specification Stage') ? 'spec'`,
      `      : prompt.includes('# Standard Requirement Model Stage') ? 'requirement_model'`,
      `        : prompt.includes('# Standard Domain Model Stage') ? 'domain_model'`,
      `          : prompt.includes('# Standard Architecture Decision Stage') ? 'design' : 'unknown';`,
      `  appendFileSync(callsPath, JSON.stringify({ stage, hasValidation: prompt.includes('Previous stage validation'), hasBudgetContract: prompt.includes('- Expected modules changed: <non-negative integer>') && prompt.includes('do not use headings for these fields') }) + '\\n', 'utf8');`,
      `  mkdirSync(specDir, { recursive: true });`,
      `  if (stage === 'requirements') {`,
      `    writeFileSync(join(specDir, 'requirements.md'), ${JSON.stringify(requirementsMarkdown)}, 'utf8');`,
      `  } else if (stage === 'spec') {`,
      `    writeFileSync(join(specDir, 'spec.md'), ${JSON.stringify(specMarkdown)}, 'utf8');`,
      `  } else if (stage === 'requirement_model') {`,
      `    writeFileSync(join(specDir, 'requirement_model.md'), ${JSON.stringify(VALID_STANDARD_REQUIREMENT_MODEL)}, 'utf8');`,
      `  } else if (stage === 'domain_model') {`,
      `    writeFileSync(join(specDir, 'domain_model.md'), ${JSON.stringify(VALID_STANDARD_DOMAIN_MODEL)}, 'utf8');`,
      `  } else if (stage === 'design') {`,
      `    writeFileSync(join(specDir, 'design.md'), ${JSON.stringify(HEADING_BUDGET_STANDARD_DESIGN)}, 'utf8');`,
      `  } else {`,
      `    process.exitCode = 2;`,
      `  }`,
      `});`,
    ].join('\n'), 'utf8');

    const failedPlan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId,
      cli: 'custom',
      customCommand: `node "${failedCliPath.replace(/\\/g, '/')}" "${specDir.replace(/\\/g, '/')}" "${failedCallsPath.replace(/\\/g, '/')}"`,
      phase: 'spec',
    });
    expect(() => execFileSync(process.execPath, [failedPlan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 20_000,
    })).toThrow();

    const failedCalls = readFileSync(failedCallsPath, 'utf8').trim().split(/\r?\n/).map((line) => (
      JSON.parse(line) as { stage: string; hasValidation: boolean; hasBudgetContract: boolean }
    ));
    const designCalls = failedCalls.filter((call) => call.stage === 'design');
    const failedDesignBackups = readdirSync(specDir).filter((file) => file.startsWith('design.md.failed-'));
    const failedTransaction = JSON.parse(
      readFileSync(join(specDir, 'planning-transaction.json'), 'utf8'),
    ) as { status?: string; checkpoint?: string };

    expect(failedCalls.map((call) => call.stage)).toEqual([
      'requirements',
      'spec',
      'requirement_model',
      'domain_model',
      'design',
      'design',
      'design',
      'design',
    ]);
    expect(designCalls.slice(1).every((call) => call.hasValidation && call.hasBudgetContract)).toBe(true);
    expect(readFileSync(join(specDir, 'spec.md'), 'utf8')).toBe(specMarkdown);
    expect(readFileSync(join(specDir, 'requirements.md'), 'utf8')).toBe(requirementsMarkdown);
    expect(existsSync(join(specDir, 'design.md'))).toBe(false);
    expect(failedDesignBackups).toHaveLength(1);
    expect(readFileSync(join(specDir, failedDesignBackups[0]), 'utf8')).toContain('#### Expected modules changed');
    expect(failedTransaction).toMatchObject({
      status: 'repair_required',
      checkpoint: 'domain_model_validated',
    });

    // Reproduce a transaction written by the older rollback behavior: the checkpoint
    // says design, but source artifacts have fallen back to their manual seed.
    writeFileSync(join(specDir, 'planning-transaction.json'), JSON.stringify({
      ...failedTransaction,
      stage: 'design_written',
      checkpoint: 'design_written',
    }, null, 2), 'utf8');
    writeFileSync(join(specDir, 'spec.md'), '# Manual Standard planning seed\n', 'utf8');
    writeFileSync(join(specDir, 'requirements.md'), [
      '# Requirements',
      '## User Requirements',
      '- None',
      '## Acceptance Criteria',
      '- None',
      '## Evidence Sources',
      '- User request',
    ].join('\n'), 'utf8');

    const resumedCallsPath = join(projectRoot, 'resumed-design-budget-calls.jsonl');
    const resumedCliPath = join(projectRoot, 'resumed-design-budget-planner.cjs');
    writeFileSync(resumedCliPath, [
      `const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');`,
      `const { join } = require('node:path');`,
      `const specDir = process.argv[2];`,
      `const callsPath = process.argv[3];`,
      `let prompt = '';`,
      `process.stdin.setEncoding('utf8');`,
      `process.stdin.on('data', (chunk) => { prompt += chunk; });`,
      `process.stdin.on('end', () => {`,
      `  const stage = prompt.includes('## STANDARD REQUIREMENTS STAGE ONLY') ? 'requirements'`,
      `    : prompt.includes('# Standard Observable Specification Stage') ? 'spec'`,
      `      : prompt.includes('# Standard Requirement Model Stage') ? 'requirement_model'`,
      `        : prompt.includes('# Standard Domain Model Stage') ? 'domain_model'`,
      `          : prompt.includes('# Standard Architecture Decision Stage') ? 'design'`,
      `            : prompt.includes('# Standard Design Model Stage') ? 'design_model'`,
      `              : prompt.includes('# Standard Implementation Model Stage') ? 'implementation_model'`,
      `                : prompt.includes('# Independent Standard Design Review') ? 'design_review'`,
      `                  : prompt.includes('# Standard Task Planning Stage') ? 'tasks' : 'unknown';`,
      `  const transaction = JSON.parse(readFileSync(join(specDir, 'planning-transaction.json'), 'utf8'));`,
      `  appendFileSync(callsPath, JSON.stringify({ stage, resumedAt: transaction.resumedAt, transactionPhase: transaction.phase, checkpoint: transaction.checkpoint }) + '\\n', 'utf8');`,
      `  mkdirSync(specDir, { recursive: true });`,
      `  if (stage === 'requirements') {`,
      `    writeFileSync(join(specDir, 'requirements.md'), ${JSON.stringify(requirementsMarkdown)}, 'utf8');`,
      `  } else if (stage === 'spec') {`,
      `    writeFileSync(join(specDir, 'spec.md'), ${JSON.stringify(specMarkdown)}, 'utf8');`,
      `  } else if (stage === 'requirement_model') {`,
      `    writeFileSync(join(specDir, 'requirement_model.md'), ${JSON.stringify(VALID_STANDARD_REQUIREMENT_MODEL)}, 'utf8');`,
      `  } else if (stage === 'domain_model') {`,
      `    writeFileSync(join(specDir, 'domain_model.md'), ${JSON.stringify(VALID_STANDARD_DOMAIN_MODEL)}, 'utf8');`,
      `  } else if (stage === 'design') {`,
      `    writeFileSync(join(specDir, 'design.md'), ${JSON.stringify(VALID_STANDARD_DESIGN)}, 'utf8');`,
      `  } else if (stage === 'design_model') {`,
      `    writeFileSync(join(specDir, 'design_model.md'), ${JSON.stringify(VALID_STANDARD_DESIGN_MODEL)}, 'utf8');`,
      `  } else if (stage === 'implementation_model') {`,
      `    writeFileSync(join(specDir, 'implementation_model.md'), ${JSON.stringify(VALID_STANDARD_IMPLEMENTATION_MODEL)}, 'utf8');`,
      `  } else if (stage === 'design_review') {`,
      `    writeFileSync(join(specDir, 'design_review.md'), ${JSON.stringify(VALID_STANDARD_DESIGN_REVIEW)}, 'utf8');`,
      `  } else if (stage === 'tasks') {`,
      `    writeFileSync(join(specDir, 'tasks.md'), ${JSON.stringify(tasksMarkdown)}, 'utf8');`,
      `  } else {`,
      `    process.exitCode = 2;`,
      `  }`,
      `});`,
    ].join('\n'), 'utf8');
    const resumedPlan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId,
      cli: 'custom',
      customCommand: `node "${resumedCliPath.replace(/\\/g, '/')}" "${specDir.replace(/\\/g, '/')}" "${resumedCallsPath.replace(/\\/g, '/')}"`,
      phase: 'planning',
    });
    let resumedOutput = '';
    let resumedFailure = '';
    try {
      resumedOutput = execFileSync(process.execPath, [resumedPlan.runnerFilePath], {
        cwd: projectRoot,
        env: { ...process.env, GRAPHITI_ENABLED: 'false' },
        encoding: 'utf8',
        timeout: 20_000,
      });
    } catch (error) {
      const outputError = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
      resumedFailure = [
        outputError.message,
        outputError.stdout?.toString('utf8'),
        outputError.stderr?.toString('utf8'),
      ].filter(Boolean).join('\n');
    }
    const resumedCalls = readFileSync(resumedCallsPath, 'utf8').trim().split(/\r?\n/).map((line) => (
      JSON.parse(line) as { stage: string; resumedAt?: string; transactionPhase?: string; checkpoint?: string }
    ));
    const resumedLog = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');

    expect(resumedCalls[0]).toMatchObject({
      resumedAt: expect.any(String),
      transactionPhase: 'planning',
      checkpoint: 'design_written',
    });
    expect(resumedLog).toContain('Resuming interrupted Standard planning');
    expect(resumedLog).toContain('checkpoint is ahead of valid artifacts; resuming from requirements');
    expect(resumedCalls.map((call) => call.stage)).toEqual([
      'requirements',
      'spec',
      'requirement_model',
      'domain_model',
      'design',
      'design_model',
      'implementation_model',
      'design_review',
      'tasks',
    ]);
    expect(resumedFailure).toBe('');
    expect(readFileSync(join(specDir, 'spec.md'), 'utf8')).toBe(specMarkdown);
    expect(resumedOutput).toContain('PLANNING_COMPLETE');
    expect(JSON.parse(readFileSync(join(specDir, 'planning-transaction.json'), 'utf8')))
      .toMatchObject({ status: 'completed', checkpoint: 'committed' });
  });

  it('requires manual review after force planning when every work package is already complete', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-force-planning-all-complete',
      title: 'Review completed iteration planning',
      description: 'Force planning must stop for review even when no coding remains.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '001-standard-force-planning-all-complete',
    });
    const requirementsMarkdown = [
      '# Requirements',
      '',
      'Requirements-Contract: 1',
      '',
      '## User Requirements',
      '- R1: Completed iteration planning requires manual review.',
      '',
      '## Acceptance Criteria',
      '- AC1: Planning emits a review event before any completion transition.',
      '',
      '## Evidence Sources',
      '- E1: The existing completed runtime work package.',
      '',
    ].join('\n');
    const specMarkdown = [
      '# Specification: Review completed iteration planning',
      '',
      'Specification-Contract: 1',
      '',
      '## SCN-001 Review a completed iteration',
      'Covers: R1, AC1',
      'Evidence: E1',
      '',
      '- Given: every runtime work package is complete.',
      '- When: force planning finishes.',
      '- Then: planning stops for manual review without scheduling coding.',
      '- Errors/edges: completed runtime history remains completed.',
      '',
    ].join('\n');
    const tasksMarkdown = [
      '# Tasks',
      '',
      'Tasks-Contract: 1',
      '',
      'Feature: Review completed iteration planning',
      'Workflow: feature',
      'Status: pending',
      '',
      '- [ ] 1. Existing implementation',
      '',
      '  - [ ] 1.1 Preserve completed implementation',
      '    - Keep the completed implementation unchanged during review-only planning.',
      '    - _Files to modify: src/completed.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1, SCN-001_',
      '    - _Evidence: E1; requirements.md E1; existing runtime plan_',
      '    - _Architecture: Boundary: planning state; strategy: preserve completed history; source/reference: spec.md R1_',
      '    - _Done when: the completed work package remains completed_',
      '    - _Verification: npm test -- completed.test.ts_',
      '',
    ].join('\n');
    const tasksWithDesignMarkdown = withStandardDesignMetadata(tasksMarkdown);
    writeValidStandardDesignArtifacts(specDir);
    writeFileSync(join(specDir, 'requirements.md'), requirementsMarkdown, 'utf8');
    writeFileSync(join(specDir, 'spec.md'), specMarkdown, 'utf8');
    writeFileSync(join(specDir, 'tasks.md'), tasksWithDesignMarkdown, 'utf8');
    const completedRuntimePlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown(
      tasksWithDesignMarkdown,
      {
        now: '2026-07-12T00:00:00.000Z',
        sourcePath: 'tasks.md',
        requireTaskEvidence: true,
        includeCompletedTasks: true,
        designMarkdown: VALID_STANDARD_DESIGN,
        requirementModelMarkdown: VALID_STANDARD_REQUIREMENT_MODEL,
        domainModelMarkdown: VALID_STANDARD_DOMAIN_MODEL,
        designModelMarkdown: VALID_STANDARD_DESIGN_MODEL,
        implementationModelMarkdown: VALID_STANDARD_IMPLEMENTATION_MODEL,
        designPath: 'design.md',
      },
    );
    for (const phase of completedRuntimePlan.phases) {
      for (const subtask of phase.subtasks ?? []) {
        subtask.status = 'completed';
        subtask.completed_at = '2026-07-12T00:05:00.000Z';
      }
    }
    writeFileSync(
      join(specDir, 'implementation_plan.md'),
      stringifyAutocodeImplementationPlanMarkdown(completedRuntimePlan),
      'utf8',
    );

    const fakeCliPath = join(projectRoot, 'successful-review-only-planner.cjs');
    writeFileSync(fakeCliPath, [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(join(specDir, 'design_review.md'))}, ${JSON.stringify(VALID_STANDARD_DESIGN_REVIEW)}, 'utf8');`,
      "process.stdout.write('planning complete\\n');",
    ].join('\n'), 'utf8');
    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-force-planning-all-complete',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'planning',
      forcePlanning: true,
    });
    expect(plan.prompt).toContain('requirement_model.md owns RM/FUN/SSD');
    expect(plan.prompt).not.toContain('This is a non-implementation workflow.');

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    const events = stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('__TASK_EVENT__:'))
      .map((line) => JSON.parse(line.slice('__TASK_EVENT__:'.length)) as Record<string, unknown>);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'PLANNING_COMPLETE',
      incompleteSubtaskCount: 0,
      continueAfterPlanning: false,
      requireReviewBeforeCoding: true,
    }));
    expect(events.some((event) => event.type === 'QA_PASSED')).toBe(false);
  });

  it('restores previous Standard tasks.md when runner planning validation fails', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-planning-rollback',
      title: 'Rollback failed planning artifacts',
      description: 'Request Changes should not leave a partial tasks.md when planning validation fails.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '001-standard-planning-rollback',
    });

    const originalTasksMarkdown = [
      '# Tasks',
      '',
      'Feature: Rollback failed planning artifacts',
      'Workflow: feature',
      'Status: pending',
      '',
      '- [ ] 1. Completed baseline',
      '',
      '  - [x] 1.1 Preserve completed baseline work',
      '    - Preserve the previously completed Standard task list when replanning fails.',
      '    - _Files to modify: src/baseline.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
      '    - _Done when: completed baseline work remains visible after failed planning_',
      '    - _Verification: npm test -- baseline.test.ts_',
      '',
    ].join('\n');
    const originalRuntimePlan = stringifyAutocodeImplementationPlanMarkdown(
      buildAutocodeRuntimeImplementationPlanFromTasksMarkdown(originalTasksMarkdown, {
        now: '2026-07-09T00:00:00.000Z',
        sourcePath: 'tasks.md',
        requireTaskEvidence: true,
        includeCompletedTasks: true,
      }),
    );
    const requirementsMarkdown = [
      '# Requirements',
      '',
      '## User Requirements',
      '- R1: Failed Request Changes planning restores the previous Standard task list.',
      '',
      '## Acceptance Criteria',
      '- AC1: tasks.md equals the pre-run content after validation fails.',
      '',
      '## Evidence Sources',
      '- spec.md Requirements R1.',
      '',
    ].join('\n');
    const specMarkdown = [
      '# Specification: Rollback failed planning artifacts',
      '',
      '## Requirements',
      '1. Failed planning restores previous Standard artifacts.',
      '   - Evidence: requirements.md R1.',
      '',
      '## Evidence',
      '- requirements.md records the rollback requirement.',
      '',
    ].join('\n');
    const invalidTasksMarkdown = [
      '# Tasks',
      '',
      '- [ ] 1. Partial rewrite',
      '  - [ ] 1.1 Missing required metadata',
      '    - This half-written task list should not survive failed validation.',
      '',
    ].join('\n');

    writeFileSync(join(specDir, 'requirements.md'), requirementsMarkdown, 'utf8');
    writeFileSync(join(specDir, 'spec.md'), specMarkdown, 'utf8');
    writeFileSync(join(specDir, 'tasks.md'), originalTasksMarkdown, 'utf8');
    writeFileSync(join(specDir, 'implementation_plan.md'), originalRuntimePlan, 'utf8');
    writeFileSync(join(specDir, 'HUMAN_INPUT.md'), 'Please make a focused Request Changes update.\n', 'utf8');

    const fakeCliPath = join(projectRoot, 'write-invalid-standard-artifacts.cjs');
    writeFileSync(fakeCliPath, [
      "const { writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const specDir = process.argv[2];',
      `writeFileSync(join(specDir, 'tasks.md'), ${JSON.stringify(invalidTasksMarkdown)}, 'utf8');`,
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-planning-rollback',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}" "${specDir.replace(/\\/g, '/')}"`,
      phase: 'planning',
      forcePlanning: true,
    });

    let failed = false;
    let failureOutput = '';
    try {
      execFileSync(process.execPath, [plan.runnerFilePath], {
        cwd: projectRoot,
        env: { ...process.env, GRAPHITI_ENABLED: 'false' },
        stdio: 'pipe',
        timeout: 15_000,
      });
    } catch (error) {
      failed = true;
      const outputError = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
      failureOutput = [
        outputError.message,
        outputError.stdout?.toString('utf8'),
        outputError.stderr?.toString('utf8'),
      ].filter(Boolean).join('\n');
    }

    const failedTaskBackups = readdirSync(specDir).filter((file) => file.startsWith('tasks.md.failed-'));
    expect(failed, failureOutput).toBe(true);
    expect(readFileSync(join(specDir, 'tasks.md'), 'utf8')).toBe(originalTasksMarkdown);
    const restoredLedgerMarkdown = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
    const restoredRuntimeTask = loadAutocodeImplementationPlanSync(specDir)
      ?.phases?.flatMap((phase) => phase.subtasks ?? [])[0];
    expect(restoredLedgerMarkdown).not.toContain('Preserve completed baseline work');
    expect(restoredRuntimeTask).toMatchObject({
      status: 'completed',
      upstream_task_ids: ['1.1'],
      definition_fingerprint: expect.any(String),
    });
    expect(failedTaskBackups).toHaveLength(1);
    expect(readFileSync(join(specDir, failedTaskBackups[0]), 'utf8')).toContain('Missing required metadata');
  });
  it('resumes validated Standard planning artifacts without starting another CLI session', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-planning-resume',
      title: 'Resume validated planning artifacts',
      description: 'Continue interrupted Standard planning from validated tasks.md.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '001-standard-planning-resume',
    });
    const specMarkdown = [
      '# Specification: Resume validated planning artifacts',
      '',
      '## Requirements',
      '- R1: Continue from the validated Standard task source after interruption.',
      '  - Evidence: requirements.md R1 and the user Request Changes instruction.',
      '',
      '## Evidence',
      '- The user request and requirements.md define the recovery behavior.',
      '',
    ].join('\n');
    const requirementsMarkdown = [
      '# Requirements',
      '',
      '## User Requirements',
      '- R1: Resume interrupted planning without invoking a second planner when tasks.md is valid.',
      '',
      '## Acceptance Criteria',
      '- AC1: A runtime work package is derived from the persisted tasks.md source.',
      '',
      '## Evidence Sources',
      '- spec.md Requirements R1 and the persisted planning transaction.',
      '',
    ].join('\n');
    const tasksMarkdown = [
      '# Tasks',
      '',
      'Feature: Resume validated planning artifacts',
      'Workflow: feature',
      'Status: pending',
      '',
      '- [ ] 1. Planning recovery',
      '',
      '  - [ ] 1.1 Derive the persisted parser work package',
      '    - Update the configuration parser contract from the validated planning source.',
      '    - _Files to modify: src/parser.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
      '    - _Done when: the parser work package is present in implementation_plan.md_',
      '    - _Verification: npm test -- parser.test.ts_',
      '',
    ].join('\n');
    const tasksWithDesignMarkdown = withStandardDesignMetadata(tasksMarkdown);
    writeValidStandardDesignArtifacts(specDir);
    writeFileSync(join(specDir, 'spec.md'), specMarkdown, 'utf8');
    writeFileSync(join(specDir, 'requirements.md'), requirementsMarkdown, 'utf8');
    writeFileSync(join(specDir, 'tasks.md'), tasksWithDesignMarkdown, 'utf8');
    writeFileSync(join(specDir, 'planning-transaction.json'), JSON.stringify({
      version: 1,
      id: 'resume-transaction',
      phase: 'planning',
      status: 'active',
      stage: 'tasks_validated',
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
      artifactHashes: {},
    }, null, 2), 'utf8');

    const markerPath = join(projectRoot, 'planner-started.txt');
    const fakeCliPath = join(projectRoot, 'unexpected-planner.cjs');
    writeFileSync(fakeCliPath, [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(markerPath)}, 'started', 'utf8');`,
      'process.exit(9);',
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-planning-resume',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'planning',
      forcePlanning: true,
    });

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    }).toString('utf8');

    const transaction = JSON.parse(
      readFileSync(join(specDir, 'planning-transaction.json'), 'utf8'),
    ) as { status?: string; stage?: string; checkpoint?: string };
    expect(existsSync(markerPath)).toBe(false);
    expect(stdout).toContain('"progress":100');
    expect(readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8'))
      .toContain('Recovered interrupted Standard planning');
    const resumedLedgerMarkdown = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
    const resumedRuntimeTask = loadAutocodeImplementationPlanSync(specDir)
      ?.phases?.flatMap((phase) => phase.subtasks ?? [])[0];
    expect(readFileSync(join(specDir, 'tasks.md'), 'utf8'))
      .toContain('Derive the persisted parser work package');
    expect(resumedLedgerMarkdown).not.toContain('Derive the persisted parser work package');
    expect(resumedRuntimeTask).toMatchObject({
      title: 'Derive the persisted parser work package',
      upstream_task_ids: ['1.1'],
      definition_fingerprint: expect.any(String),
    });
    expect(transaction).toMatchObject({
      status: 'completed',
      stage: 'committed',
      checkpoint: 'committed',
    });
  });
  it('accepts legacy completed work packages without new scheduling metadata during iteration', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-legacy-history',
      title: 'Preserve legacy planning history',
      description: 'Keep completed legacy packages while planning one new change.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '001-standard-legacy-history',
    });
    writeFileSync(join(specDir, 'spec.md'), [
      '# Specification: Preserve legacy planning history',
      '',
      '## Requirements',
      '- R1: Preserve completed work and add the requested parser change.',
      '  - Evidence: requirements.md R1 and the Request Changes input.',
      '',
      '## Evidence',
      '- The existing implementation plan records completed historical work.',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(specDir, 'requirements.md'), [
      '# Requirements',
      '',
      '## User Requirements',
      '- R1: Existing completed work remains visible after iteration planning.',
      '',
      '## Acceptance Criteria',
      '- AC1: The new parser package remains executable while legacy history stays completed.',
      '',
      '## Evidence Sources',
      '- spec.md Requirements R1 and the previous implementation plan.',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(specDir, 'tasks.md'), withStandardDesignMetadata([
      '# Tasks',
      '',
      'Feature: Preserve legacy planning history',
      'Workflow: feature',
      'Status: pending',
      '',
      '- [ ] 2. Iteration',
      '',
      '  - [ ] 2.1 Update parser behavior',
      '    - Add the focused parser behavior requested by the iteration.',
      '    - _Files to modify: src/parser.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
      '    - _Done when: the parser behavior has a runnable work package_',
      '    - _Verification: npm test -- parser.test.ts_',
      '',
    ].join('\n')), 'utf8');
    writeValidStandardDesignArtifacts(specDir);
    writeFileSync(join(specDir, 'implementation_plan.md'),
      stringifyAutocodeImplementationPlanMarkdown({
        feature: 'Legacy completed plan',
        phases: [
          {
            id: 'legacy',
            name: 'Legacy history',
            subtasks: [
              {
                id: 'legacy-1',
                title: 'Legacy completed package',
                description: 'Completed before scheduling metadata was introduced.',
                status: 'completed',
              },
            ],
          },
        ],
      }),
      'utf8',
    );

    const fakeCliPath = join(projectRoot, 'successful-planner.cjs');
    writeFileSync(fakeCliPath, [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(join(specDir, 'design_review.md'))}, ${JSON.stringify(VALID_STANDARD_DESIGN_REVIEW)}, 'utf8');`,
      "process.stdout.write('planning complete\\n');",
    ].join('\n'), 'utf8');
    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-legacy-history',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'planning',
      forcePlanning: true,
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15_000,
    });

    const implementationPlan = loadAutocodeImplementationPlanSync(specDir)!;
    const subtasks = implementationPlan.phases
      ?.flatMap((phase) => phase.subtasks ?? []) ?? [];
    expect(subtasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'legacy-1',
        status: 'completed',
        history_only: true,
        depends_on: [],
      }),
      expect.objectContaining({
        upstream_task_ids: ['2.1'],
        status: 'pending',
      }),
    ]));
  });
  it('preserves completed Standard work packages during force planning iteration', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-force-planning-completed',
      title: 'Replan completed work safely',
      description: 'Request Changes should preserve already completed Standard work while adding focused pending work.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '001-standard-force-planning-completed',
    });

    const requirementsMarkdown = [
      '# Requirements',
      '',
      '## User Requirements',
      '- R1: Existing completed Standard work remains represented as completed during iteration planning.',
      '- R2: New change-request work remains pending for the coding pass.',
      '',
      '## Acceptance Criteria',
      '- AC1: Runtime work packages include the completed upstream task.',
      '- AC2: Runtime work packages include the pending upstream task.',
      '',
      '## Evidence Sources',
      '- spec.md Requirements R1 and R2.',
      '- HUMAN_INPUT.md latest change request.',
      '',
    ].join('\n');
    const specMarkdown = [
      '# Specification: Replan completed work safely',
      '',
      '## Overview',
      'Preserve completed Standard work while planning a same-task change request.',
      '',
      '## Requirements',
      '1. Completed work remains completed after iteration planning.',
      '   - Evidence: requirements.md R1.',
      '2. New change-request work is pending for coding.',
      '   - Evidence: requirements.md R2.',
      '',
      '## Evidence',
      '- requirements.md records the preserved completed and pending work requirements.',
      '- HUMAN_INPUT.md records the same-task change request.',
      '',
    ].join('\n');
    const tasksMarkdown = [
      '# Tasks',
      '',
      'Feature: Replan completed work safely',
      'Workflow: feature',
      'Status: pending',
      '',
      '- [ ] 1. Completed baseline',
      '',
      '  - [x] 1.1 Preserve completed baseline work',
      '    - Preserve the existing completed implementation result without scheduling it for another coding pass.',
      '    - _Files to modify: src/baseline.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
      '    - _Done when: completed baseline work remains represented as completed_',
      '    - _Verification: npm test -- baseline.test.ts_',
      '',
      '- [ ] 2. Change request follow-up',
      '',
      '  - [ ] 2.1 Apply focused change request',
      '    - Apply only the new focused change requested by the reviewer.',
      '    - _Files to modify: src/follow-up.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R2, AC2_',
      '    - _Evidence: HUMAN_INPUT.md latest change request; spec.md Requirements R2; requirements.md Evidence Sources_',
      '    - _Done when: the focused change request is ready for coding_',
      '    - _Verification: npm test -- follow-up.test.ts_',
      '',
    ].join('\n');
    const tasksWithDesignMarkdown = withStandardDesignMetadata(tasksMarkdown);
    writeValidStandardDesignArtifacts(specDir);
    writeFileSync(join(specDir, 'HUMAN_INPUT.md'), 'Please add the focused follow-up while preserving completed work.\n', 'utf8');

    const fakeCliPath = join(projectRoot, 'write-standard-force-planning-artifacts.cjs');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const specDir = process.argv[2];',
      'mkdirSync(specDir, { recursive: true });',
      `writeFileSync(join(specDir, 'requirements.md'), ${JSON.stringify(requirementsMarkdown)}, 'utf8');`,
      `writeFileSync(join(specDir, 'spec.md'), ${JSON.stringify(specMarkdown)}, 'utf8');`,
      `writeFileSync(join(specDir, 'design_review.md'), ${JSON.stringify(VALID_STANDARD_DESIGN_REVIEW)}, 'utf8');`,
      `writeFileSync(join(specDir, 'tasks.md'), ${JSON.stringify(tasksWithDesignMarkdown)}, 'utf8');`,
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-force-planning-completed',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}" "${specDir.replace(/\\/g, '/')}"`,
      phase: 'planning',
      forcePlanning: true,
    });

    expect(readFileSync(plan.runnerFilePath, 'utf8')).toContain('const forcePlanning = true;');

    const stdout = execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    }).toString('utf8');

    const planningEvent = stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('__TASK_EVENT__:'))
      .map((line) => JSON.parse(line.slice('__TASK_EVENT__:'.length)) as Record<string, unknown>)
      .find((event) => event.type === 'PLANNING_COMPLETE');
    expect(planningEvent).toMatchObject({
      type: 'PLANNING_COMPLETE',
      continueAfterPlanning: false,
      requireReviewBeforeCoding: true,
    });

    const implementationPlan = loadAutocodeImplementationPlanSync(specDir);
    const subtasks = implementationPlan?.phases?.flatMap((phase) => phase.subtasks ?? []) ?? [];
    expect(subtasks.some((subtask) =>
      subtask.status === 'completed' && subtask.upstream_task_ids?.includes('1.1')
    )).toBe(true);
    expect(subtasks.some((subtask) =>
      subtask.status === 'pending' && subtask.upstream_task_ids?.includes('2.1')
    )).toBe(true);
  });
  it('preserves completed Standard work packages when iteration planning rewrites upstream tasks as pending', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-standard-force-planning-rewritten-pending',
      title: 'Replan rewritten completed work safely',
      description: 'Request Changes should preserve runtime completion state even if the planner emits old tasks as pending.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '001-standard-force-planning-rewritten-pending',
    });

    const previousCompletedTasksMarkdown = [
      '# Tasks',
      '',
      'Feature: Replan rewritten completed work safely',
      'Workflow: feature',
      'Status: pending',
      '',
      '- [ ] 1. Completed baseline',
      '',
      '  - [x] 1.1 Preserve completed baseline work',
      '    - Preserve the existing completed implementation result without scheduling it for another coding pass.',
      '    - _Files to modify: src/baseline.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
      '    - _Done when: completed baseline work remains represented as completed_',
      '    - _Verification: npm test -- baseline.test.ts_',
      '',
    ].join('\n');
    const previousTasksWithDesignMarkdown = withStandardDesignMetadata(previousCompletedTasksMarkdown);
    writeValidStandardDesignArtifacts(specDir);
    const previousRuntimePlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown(
      previousTasksWithDesignMarkdown,
      {
        now: '2026-06-18T00:00:00.000Z',
        sourcePath: 'tasks.md',
        requireTaskEvidence: true,
        includeCompletedTasks: true,
        designMarkdown: VALID_STANDARD_DESIGN,
        requirementModelMarkdown: VALID_STANDARD_REQUIREMENT_MODEL,
        domainModelMarkdown: VALID_STANDARD_DOMAIN_MODEL,
        designModelMarkdown: VALID_STANDARD_DESIGN_MODEL,
        implementationModelMarkdown: VALID_STANDARD_IMPLEMENTATION_MODEL,
        designPath: 'design.md',
      },
    );
    const previousSubtask = previousRuntimePlan.phases[0].subtasks?.[0];
    if (previousSubtask) {
      previousSubtask.completed_at = '2026-06-18T00:10:00.000Z';
      previousSubtask.completion_summary = 'Already completed before Request Changes.';
    }
    writeFileSync(
      join(specDir, 'implementation_plan.md'),
      stringifyAutocodeImplementationPlanMarkdown(previousRuntimePlan),
      'utf8',
    );

    const requirementsMarkdown = [
      '# Requirements',
      '',
      '## User Requirements',
      '- R1: Existing completed Standard work remains completed during iteration planning.',
      '- R2: New change-request work remains pending for the coding pass.',
      '',
      '## Acceptance Criteria',
      '- AC1: Runtime work packages preserve the completed upstream task status from the previous runtime plan.',
      '- AC2: Runtime work packages include the pending upstream task.',
      '',
      '## Evidence Sources',
      '- spec.md Requirements R1 and R2.',
      '- HUMAN_INPUT.md latest change request.',
      '',
    ].join('\n');
    const specMarkdown = [
      '# Specification: Replan rewritten completed work safely',
      '',
      '## Overview',
      'Preserve completed Standard runtime state while planning a same-task change request.',
      '',
      '## Requirements',
      '1. Completed runtime work remains completed after iteration planning.',
      '   - Evidence: requirements.md R1.',
      '2. New change-request work is pending for coding.',
      '   - Evidence: requirements.md R2.',
      '',
      '## Evidence',
      '- requirements.md records the preserved completed and pending work requirements.',
      '- HUMAN_INPUT.md records the same-task change request.',
      '',
    ].join('\n');
    const rewrittenPendingTasksMarkdown = [
      '# Tasks',
      '',
      'Feature: Replan rewritten completed work safely',
      'Workflow: feature',
      'Status: pending',
      '',
      '- [ ] 1. Completed baseline',
      '',
      '  - [ ] 1.1 Preserve completed baseline work',
      '    - Preserve the existing completed implementation result without scheduling it for another coding pass.',
      '    - _Files to modify: src/baseline.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
      '    - _Done when: completed baseline work remains represented as completed_',
      '    - _Verification: npm test -- baseline.test.ts_',
      '',
      '- [ ] 2. Change request follow-up',
      '',
      '  - [ ] 2.1 Apply focused change request',
      '    - Apply only the new focused change requested by the reviewer.',
      '    - _Files to modify: src/follow-up.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R2, AC2_',
      '    - _Evidence: HUMAN_INPUT.md latest change request; spec.md Requirements R2; requirements.md Evidence Sources_',
      '    - _Done when: the focused change request is ready for coding_',
      '    - _Verification: npm test -- follow-up.test.ts_',
      '',
    ].join('\n');
    const rewrittenTasksWithDesignMarkdown = withStandardDesignMetadata(rewrittenPendingTasksMarkdown);
    writeFileSync(join(specDir, 'HUMAN_INPUT.md'), 'Please add the focused follow-up while preserving completed work.\n', 'utf8');

    const fakeCliPath = join(projectRoot, 'write-standard-force-planning-rewritten-pending-artifacts.cjs');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const specDir = process.argv[2];',
      'mkdirSync(specDir, { recursive: true });',
      `writeFileSync(join(specDir, 'requirements.md'), ${JSON.stringify(requirementsMarkdown)}, 'utf8');`,
      `writeFileSync(join(specDir, 'spec.md'), ${JSON.stringify(specMarkdown)}, 'utf8');`,
      `writeFileSync(join(specDir, 'design_review.md'), ${JSON.stringify(VALID_STANDARD_DESIGN_REVIEW)}, 'utf8');`,
      `writeFileSync(join(specDir, 'tasks.md'), ${JSON.stringify(rewrittenTasksWithDesignMarkdown)}, 'utf8');`,
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-standard-force-planning-rewritten-pending',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}" "${specDir.replace(/\\/g, '/')}"`,
      phase: 'planning',
      forcePlanning: true,
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: { ...process.env, GRAPHITI_ENABLED: 'false' },
      stdio: 'pipe',
      timeout: 15_000,
    });

    const implementationPlan = loadAutocodeImplementationPlanSync(specDir);
    const subtasks = implementationPlan?.phases?.flatMap((phase) => phase.subtasks ?? []) ?? [];
    const preservedSubtask = subtasks.find((subtask) => subtask.upstream_task_ids?.includes('1.1'));
    expect(preservedSubtask?.status).toBe('completed');
    expect(preservedSubtask?.completed_at).toBe('2026-06-18T00:10:00.000Z');
    expect(preservedSubtask?.completion_summary).toBe('Already completed before Request Changes.');
    expect(subtasks.some((subtask) =>
      subtask.status === 'pending' && subtask.upstream_task_ids?.includes('2.1')
    )).toBe(true);
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

  it('marks Standard coding model capacity failures as rate limited', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '001-codex-capacity-standard',
      title: 'Handle Codex capacity in Standard coding',
      description: 'Do not report transient model capacity as a work item implementation failure.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '001-codex-capacity-standard',
    });
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Handle Codex capacity in Standard coding',
      'Status: coding',
      'Execution Phase: coding',
      '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","subtaskMetadata":{"1.44":{"work_package":true,"depends_on":[]}}} -->',
      '',
      '- [ ] 1. Implementation',
      '  - [ ] 1.44 Update E2E tests',
      '',
    ].join('\n'), 'utf8');

    const capacityMessage = 'Selected model is at capacity. Please try a different model.';
    const fakeCliPath = join(projectRoot, 'fail-codex-capacity-standard.cjs');
    writeFileSync(fakeCliPath, [
      `process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'error', message: capacityMessage }) + '\n')});`,
      `process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'turn.failed', error: { message: capacityMessage } }) + '\n')});`,
      'process.exit(1);',
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '001-codex-capacity-standard',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'coding',
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
    expect(result.message).toContain('Selected model is at capacity');
    expect(result.message).not.toContain('Autocode CLI failed:');
  });
  it('keeps zh-CN Standard evidence in the owning artifacts without scaffolding writes', () => {
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
    const tasksWithDesignMarkdown = withStandardDesignMetadata(tasksMarkdown);
    const contractRequirementsMarkdown = [
      '# Requirements: zh-CN evidence ownership',
      '',
      'Requirements-Contract: 1',
      '',
      '## User Requirements',
      '- R1: Standard planning keeps evidence in the requirements registry.',
      '',
      '## Acceptance Criteria',
      '- AC1: The runtime ledger is derived after contract validation.',
      '',
      '## Evidence Sources',
      '- E1: User request captured by Autocode.',
      '',
    ].join('\n');
    const contractSpecMarkdown = [
      '# Specification: zh-CN evidence ownership',
      '',
      'Specification-Contract: 1',
      '',
      '## SCN-001 Derive the runtime ledger',
      'Covers: R1, AC1',
      'Evidence: E1',
      '- Given valid Standard planning artifacts',
      '- When planning is committed',
      '- Then implementation_plan.md contains the derived work package.',
      '',
    ].join('\n');
    const contractTasksMarkdown = tasksWithDesignMarkdown
      .replace('# Tasks\n\n', '# Tasks\n\nTasks-Contract: 1\n\n')
      .replace('Status: pending\n\n', '')
      .replace('_Requirements: R1_', '_Requirements: R1, AC1, SCN-001_')
      .replace(
        '_Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
        '_Evidence: E1; requirements.md E1; src/evidence.ts_',
      );
    writeValidStandardDesignArtifacts(specDir);
    const fakeCliPath = join(projectRoot, 'write-standard-artifacts-zh.cjs');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const specDir = process.argv[2];',
      'mkdirSync(specDir, { recursive: true });',
      `writeFileSync(join(specDir, 'requirements.md'), ${JSON.stringify(contractRequirementsMarkdown)}, 'utf8');`,
      `writeFileSync(join(specDir, 'spec.md'), ${JSON.stringify(contractSpecMarkdown)}, 'utf8');`,
      `writeFileSync(join(specDir, 'design_review.md'), ${JSON.stringify('Status: PASSED\n\n\u8bbe\u8ba1\u8bc4\u5ba1\u5df2\u9a8c\u8bc1\u8bc1\u636e\u3001\u804c\u8d23\u8fb9\u754c\u548c\u5b9e\u65bd\u6620\u5c04\u3002\n')}, 'utf8');`,
      `writeFileSync(join(specDir, 'tasks.md'), ${JSON.stringify(contractTasksMarkdown)}, 'utf8');`,
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

    const persistedSpec = readFileSync(join(specDir, 'spec.md'), 'utf8');
    expect(persistedSpec).toBe(contractSpecMarkdown);
    expect(persistedSpec).toContain('Evidence: E1');
    expect(persistedSpec).not.toContain('## Evidence');
    const persistedRequirements = readFileSync(join(specDir, 'requirements.md'), 'utf8');
    expect(persistedRequirements).toBe(contractRequirementsMarkdown);
    expect(persistedRequirements).toContain('## Evidence Sources');
    expect(persistedRequirements).toContain('- E1:');
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
      "  process.stdout.write('| Item | Result |\\n');",
      "  process.stdout.write('| --- | --- |\\n');",
      "  process.stdout.write('| Change | Added Start game control |\\n');",
      "  process.stdout.write('| Verification | npm run build passed |\\n');",
      "  process.stdout.write('| Review notes | Ready for review |\\n');",
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
    const implementationPlan = loadAutocodeImplementationPlanSync(specDir);
    expect(implementationPlan?.phases?.[0]?.subtasks?.[0]?.completion_summary)
      .toContain('| Item | Result |');
    const logs = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');
    expect(logs).toContain('finished model output but the CLI process did not exit; finalizing the work item.');
  });

  it('fills worker slots with later-depth work when earlier-depth items only wait on file conflicts', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '009-worker-depth-priority',
      title: 'Keep workers busy around shallow file conflicts',
      description: 'Skip only earlier ready work packages blocked by active file locks, then launch deeper non-conflicting work.',
      metadata: {
        developmentMode: 'standard',
        runtimeConcurrency: { mode: 'concurrent', workers: 2 },
      },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '009-worker-depth-priority',
    });
    const planMeta = {
      planStatus: 'coding',
      xstateState: 'coding',
      subtaskMetadata: {
        'wp-0': { work_package: true, depends_on: [], files_to_modify: ['package.json'] },
        'wp-mid': { work_package: true, depends_on: ['wp-0'], files_to_modify: ['src/render.js'] },
        'wp-1': { work_package: true, depends_on: ['wp-0'], files_to_modify: ['src/game.js'] },
        'wp-2': { work_package: true, depends_on: ['wp-0'], files_to_modify: ['`src/game.js`'] },
        'wp-3': { work_package: true, depends_on: ['wp-mid'], files_to_modify: ['src/render.js'] },
      },
    };
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Prioritize shallow ready work packages',
      'Status: coding',
      'Execution Phase: coding',
      `<!-- autocode-plan-meta: ${JSON.stringify(planMeta)} -->`,
      '',
      '- [x] wp-0 Completed foundation',
      '- [x] wp-mid Completed intermediate package',
      '- [ ] wp-1 Hold shared game file',
      '- [ ] wp-2 Waiting same-depth game file package',
      '- [ ] wp-3 Deeper render package',
      '',
    ].join('\n'), 'utf8');

    const fakeCliPath = join(projectRoot, 'coding-depth-priority.cjs');
    const orderPath = join(projectRoot, 'coding-order.txt');
    writeFileSync(fakeCliPath, [
      "const { appendFileSync } = require('node:fs');",
      'const orderPath = process.argv[2];',
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const match = /Work Package ID:\\s*(\\S+)/.exec(input);",
      "  const id = match ? match[1] : 'unknown';",
      "  appendFileSync(orderPath, `start:${id}\\n`, 'utf8');",
      "  const delay = id === 'wp-1' ? 250 : 0;",
      "  setTimeout(() => {",
      "    appendFileSync(orderPath, `end:${id}\\n`, 'utf8');",
      "    process.stdout.write('| Change | Verification | Review |\\n|---|---|---|\\n| Done ' + id + ' | passed | ok |\\n');",
      "  }, delay);",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '009-worker-depth-priority',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}" "${orderPath.replace(/\\/g, '/')}"`,
      phase: 'coding',
    });

    try {
      execFileSync(process.execPath, [plan.runnerFilePath], {
        cwd: projectRoot,
        env: { ...process.env, GRAPHITI_ENABLED: 'false' },
        stdio: 'pipe',
        timeout: 15_000,
      });
    } catch (error) {
      const failure = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
      throw new Error([
        failure.message,
        failure.stdout?.toString('utf8'),
        failure.stderr?.toString('utf8'),
        existsSync(join(specDir, 'task_logs.jsonl'))
          ? readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8')
          : '',
        readFileSync(join(specDir, 'implementation_plan.md'), 'utf8'),
      ].filter(Boolean).join('\n'));
    }

    const order = readFileSync(orderPath, 'utf8').trim().split(/\r?\n/);
    expect(order).toContain('start:wp-1');
    expect(order).toContain('end:wp-1');
    expect(order).toContain('start:wp-2');
    expect(order).toContain('start:wp-3');
    expect(order.indexOf('start:wp-3')).toBeLessThan(order.indexOf('end:wp-1'));

    const logs = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');
    expect(logs).toContain('Coding work item wp-2 is ready but waiting for active work item wp-1 on src/game.js.');
  });

  it('commits Standard work package source changes locally after completion', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '009-worker-git-commit',
      title: 'Commit completed work package changes',
      description: 'Completed Standard work packages should create local git commits without pushing.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '009-worker-git-commit',
    });
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'keep.ts'), 'export const value = 1;\n', 'utf8');
    writeFileSync(join(projectRoot, 'src', 'remove-me.ts'), 'export const removeMe = true;\n', 'utf8');
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'autocode@example.invalid'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Autocode Test'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['add', 'src/keep.ts', 'src/remove-me.ts'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: projectRoot, stdio: 'ignore' });

    const planMeta = {
      planStatus: 'coding',
      xstateState: 'coding',
      subtaskMetadata: {
        'wp-1': {
          work_package: true,
          depends_on: [],
          duration_ms: 1_000,
          started_at: '2026-01-01T00:00:00.000Z',
          files_to_create: ['src/created.ts'],
          files_to_modify: ['src/keep.ts', 'src/remove-me.ts'],
        },
      },
    };
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Commit completed work package changes',
      'Status: coding',
      'Execution Phase: coding',
      `<!-- autocode-plan-meta: ${JSON.stringify(planMeta)} -->`,
      '',
      '- [ ] 1. Implementation',
      '  - [ ] wp-1 Update source files and commit locally',
      '',
    ].join('\n'), 'utf8');

    const fakeCliPath = join(projectRoot, 'coding-git-commit.cjs');
    const activePlanPath = join(projectRoot, 'coding-git-commit-active-plan.md');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, rmSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const root = process.cwd();',
      `require('node:fs').writeFileSync(process.env.AUTOCODE_TEST_ACTIVE_PLAN_PATH, require('node:fs').readFileSync(process.env.AUTOCODE_TEST_SPEC_DIR + '/implementation_plan.md', 'utf8'), 'utf8');`,
      "mkdirSync(join(root, 'src'), { recursive: true });",
      "writeFileSync(join(root, 'src', 'keep.ts'), 'export const value = 2;\\n', 'utf8');",
      "writeFileSync(join(root, 'src', 'created.ts'), 'export const created = true;\\n', 'utf8');",
      "rmSync(join(root, 'src', 'remove-me.ts'), { force: true });",
      "process.stdout.write('| Change | Verification | Review |\\n|---|---|---|\\n| Source changes | passed | ready |\\n');",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '009-worker-git-commit',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}"`,
      phase: 'coding',
    });

    execFileSync(process.execPath, [plan.runnerFilePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GRAPHITI_ENABLED: 'false',
        AUTOCODE_TEST_SPEC_DIR: specDir,
        AUTOCODE_TEST_ACTIVE_PLAN_PATH: activePlanPath,
      },
      stdio: 'pipe',
      timeout: 15_000,
    });

    const activePlan = readFileSync(activePlanPath, 'utf8');
    const activeMetadataPrefix = '<!-- autocode-plan-meta: ';
    const activeMetadataLine = activePlan.split(String.fromCharCode(10))
      .find(line => line.startsWith(activeMetadataPrefix));
    const activeMetadataJson = activeMetadataLine
      ? activeMetadataLine.slice(activeMetadataPrefix.length, activeMetadataLine.lastIndexOf('-->')).trim()
      : '{}';
    const activeMetadata = JSON.parse(activeMetadataJson) as {
      subtaskMetadata?: Record<string, { active_started_at?: string; duration_ms?: number }>;
    };
    expect(activeMetadata.subtaskMetadata?.['wp-1']?.active_started_at).toEqual(expect.any(String));
    expect(activeMetadata.subtaskMetadata?.['wp-1']?.duration_ms).toBe(1_000);

    const subject = execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    expect(subject).toBe('chore(autocode): complete work item wp-1');

    const nameStatus = execFileSync('git', ['show', '--name-status', '--format=', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).replace(/\\/g, '/');
    expect(nameStatus).toContain('A\tsrc/created.ts');
    expect(nameStatus).toContain('M\tsrc/keep.ts');
    expect(nameStatus).toContain('D\tsrc/remove-me.ts');

    const sourceStatus = execFileSync('git', ['status', '--short', '--', 'src/created.ts', 'src/keep.ts', 'src/remove-me.ts'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    expect(sourceStatus).toBe('');

    const logs = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');
    expect(logs).toContain('Committed local changes for work item wp-1');
    const implementationPlan = loadAutocodeImplementationPlanSync(specDir);
    const completedSubtask = implementationPlan?.phases?.[0]?.subtasks?.[0];
    expect(completedSubtask?.status).toBe('completed');
    expect(completedSubtask?.duration_ms).toBeGreaterThan(1_000);
    expect(completedSubtask?.started_at).toBe('2026-01-01T00:00:00.000Z');
    expect(completedSubtask?.active_started_at).toBeUndefined();
    expect(completedSubtask?.completion_summary).toContain('| Change | Verification | Review |');
    expect(completedSubtask?.changed_files).toEqual([
      'src/created.ts',
      'src/keep.ts',
      'src/remove-me.ts',
    ]);
  });
  it('does not log completed coding work when plan completion status cannot be persisted', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '009-worker-status-persist-failure',
      title: 'Report plan status write failures',
      description: 'Do not report a work package as completed until implementation_plan.md is updated.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '009-worker-status-persist-failure',
    });
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Report plan status write failures',
      'Status: coding',
      'Execution Phase: coding',
      '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","subtaskMetadata":{"wp-1":{"work_package":true,"depends_on":[]}}} -->',
      '',
      '- [ ] 1. Implementation',
      '  - [ ] wp-1 Persist status after success',
      '',
    ].join('\n'), 'utf8');

    const fakeCliPath = join(projectRoot, 'coding-status-lock.cjs');
    writeFileSync(fakeCliPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { createHash, randomUUID } = require('node:crypto');",
      "const { join, resolve } = require('node:path');",
      'const specDir = process.argv[2];',
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const planPath = join(specDir, 'implementation_plan.md');",
      "  const normalized = resolve(planPath).replace(/\\\\/g, '/').replace(/\\/+$/g, '').trim().toLowerCase();",
      "  const lockRoot = join(process.cwd(), '.autocode', '.locks', 'runtime-file-writes');",
      "  const lockDir = join(lockRoot, createHash('sha256').update(normalized).digest('hex').slice(0, 32) + '.lock');",
      "  mkdirSync(lockRoot, { recursive: true });",
      "  mkdirSync(lockDir);",
      "  writeFileSync(join(lockDir, 'metadata.json'), JSON.stringify({",
      "    filePath: normalized,",
      "    ownerId: 'test-held-plan-lock',",
      "    token: randomUUID(),",
      "    acquiredAt: new Date().toISOString(),",
      "    processId: process.pid + 1000000,",
      "  }, null, 2), 'utf8');",
      "  process.stdout.write('| Change | Verification | Review |\\n|---|---|---|\\n| Added behavior | passed | ready |\\n');",
      "});",
    ].join('\n'), 'utf8');

    const plan = createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName,
      taskId: '009-worker-status-persist-failure',
      cli: 'custom',
      customCommand: `node "${fakeCliPath.replace(/\\/g, '/')}" "${specDir.replace(/\\/g, '/')}"`,
      phase: 'coding',
    });

    let failed = false;
    let stdout = '';
    let stderr = '';
    try {
      execFileSync(process.execPath, [plan.runnerFilePath], {
        cwd: projectRoot,
        env: {
          ...process.env,
          AUTOCODE_FILE_WRITE_LOCK_RETRY_MS: '1',
          AUTOCODE_FILE_WRITE_LOCK_TIMEOUT_MS: '25',
          GRAPHITI_ENABLED: 'false',
        },
        stdio: 'pipe',
        timeout: 15_000,
      });
    } catch (error) {
      failed = true;
      stdout = String((error as { stdout?: string | Buffer }).stdout ?? '');
      stderr = String((error as { stderr?: string | Buffer }).stderr ?? '');
    }

    expect(failed).toBe(true);
    const lockDir = getRuntimeFileWriteLockDir(projectRoot, dataDirName, join(specDir, 'implementation_plan.md'));
    expect(existsSync(lockDir), ['stdout:', stdout, 'stderr:', stderr].join('\\n')).toBe(true);
    expect(readFileSync(join(lockDir, 'metadata.json'), 'utf8')).toContain('test-held-plan-lock');
    const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
    expect(rawPlan).toContain('- [/] wp-1 Persist status after success');
    expect(rawPlan).not.toContain('- [x] wp-1 Persist status after success');
    const logs = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');
    expect(logs).toContain('finished, but Autocode could not mark it completed');
    expect(logs).toContain('Failed to persist completed status for work item wp-1');
    expect(logs).not.toContain('Work item wp-1 completed.');
    const result = JSON.parse(readFileSync(join(specDir, 'autocode-run-result.json'), 'utf8')) as {
      status?: string;
      message?: string;
    };
    expect(result.status).toBe('error');
    expect(result.message).toContain('Failed to persist completed status for work item wp-1');
  });
  it('recovers completed coding work items from task logs before retrying stale in-progress items', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '009-coding-log-recovery',
      title: 'Recover stale coding status',
      description: 'Use durable task logs to repair a stale in-progress work package before continuing.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({ projectRoot, dataDirName, specId: '009-coding-log-recovery' });
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Recover stale coding status',
      'Status: coding',
      'Execution Phase: coding',
      '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","subtaskMetadata":{"wp-1":{"work_package":true,"depends_on":[],"started_at":"2026-06-20T00:00:00.000Z"},"wp-2":{"work_package":true,"depends_on":["wp-1"]}}} -->',
      '',
      '- [ ] 1. Implementation',
      '  - [/] wp-1 Already logged completion',
      '    - _Started: 2026-06-20T00:00:00.000Z_',
      '  - [ ] wp-2 Continue after recovered package',
      '    - _Depends on: wp-1_',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(specDir, 'task_logs.jsonl'), [
      JSON.stringify({
        record_type: 'entry',
        entry: {
          timestamp: '2026-06-20T00:01:00.000Z',
          type: 'success',
          content: 'Work item wp-1 completed.',
          phase: 'coding',
          subtask_id: 'wp-1',
        },
      }),
      '',
    ].join('\n'), 'utf8');

    const fakeCliPath = join(projectRoot, 'coding-log-recovery.cjs');
    const capturedPromptPath = join(projectRoot, 'coding-log-recovery-prompts.txt');
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
      taskId: '009-coding-log-recovery',
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
    expect(capturedPrompts).not.toContain('Work Package ID: wp-1');
    expect(capturedPrompts).toContain('Work Package ID: wp-2');
    const implementationPlan = loadAutocodeImplementationPlanSync(specDir);
    expect(implementationPlan?.phases?.[0]?.subtasks?.map((subtask) => subtask.status)).toEqual([
      'completed',
      'completed',
    ]);
    const logs = readFileSync(join(specDir, 'task_logs.jsonl'), 'utf8');
    expect(logs).toContain('Recovered work item wp-1 completed status from task log.');
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
    expect(implementationPlan?.phases?.[0]?.subtasks?.map((subtask) => subtask.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('injects only referenced SYS and REV design sections into coding worker prompts', () => {
    createAutocodeTask({
      projectRoot,
      dataDirName,
      specId: '008-coding-design-excerpt',
      title: 'Bind coding to focused design',
      description: 'Provide only the current work package design contract to its coding worker.',
      metadata: { developmentMode: 'standard' },
    });
    const specDir = getAutocodeSpecDir({
      projectRoot,
      dataDirName,
      specId: '008-coding-design-excerpt',
    });
    writeValidStandardDesignArtifacts(specDir);
    writeFileSync(
      join(specDir, 'design_model.md'),
      VALID_STANDARD_DESIGN_MODEL
        .replace('### SYS-001 Task service boundary', '### SYS-001 Included system owner')
        .replace(
          '## Domain To Software Mapping',
          [
            '### SYS-999 Unrelated system owner',
            '- Owns: unrelated behavior',
            '',
            '## Domain To Software Mapping',
          ].join('\n'),
        )
        .replace(
          '## Class Diagram',
          [
            '### REV-001 Included source reconstruction',
            '- Runtime path: ExistingApi#run -> ExistingStore#apply',
            '',
            '## Class Diagram',
          ].join('\n'),
        ),
      'utf8',
    );
    writeFileSync(
      join(specDir, 'implementation_model.md'),
      VALID_STANDARD_IMPLEMENTATION_MODEL.replace(
        '### IMP-001 Realize task submission',
        '### IMP-001 Included implementation',
      ),
      'utf8',
    );
    writeFileSync(join(specDir, 'implementation_plan.md'), [
      '# Implementation Plan',
      'Feature: Bind coding to focused design',
      'Status: coding',
      'Execution Phase: coding',
      '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","subtaskMetadata":{"wp-1":{"work_package":true,"depends_on":[],"design_refs":["SYS-001","REV-001","IMP-001"]}}} -->',
      '',
      '- [ ] 1. Implementation',
      '  - [ ] wp-1 Implement the mapped behavior',
      '    - _Design: SYS-001, REV-001, IMP-001_',
      '',
    ].join('\n'), 'utf8');

    const fakeCliPath = join(projectRoot, 'coding-design-excerpt.cjs');
    const capturedPromptPath = join(projectRoot, 'coding-design-excerpt-prompt.txt');
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
      taskId: '008-coding-design-excerpt',
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

    const capturedPrompt = readFileSync(capturedPromptPath, 'utf8');
    expect(capturedPrompt).toContain('### SYS-001 Included system owner');
    expect(capturedPrompt).toContain('### REV-001 Included source reconstruction');
    expect(capturedPrompt).toContain('### IMP-001 Included implementation');
    expect(capturedPrompt).not.toContain('SYS-999 Unrelated system owner');
    expect(capturedPrompt).toContain('map the target symbol to IMP-*');
    expect(capturedPrompt).toContain('source contradicts REV-*');
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
    expect(subtask?.duration_ms).toBeGreaterThan(0);
    expect(subtask?.active_started_at).toBeUndefined();
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
      "  process.stdout.write(JSON.stringify({ kind: 'turn.completed' }) + '\\n');",
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
        completionEventTypes: ['turn_completed'],
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
    expect(argvLines[0]).toEqual(['exec', '--json', '-m', 'gpt-test', '-c', 'model_reasoning_effort=medium', '-']);
    expect(argvLines[1]).toEqual(['exec', 'resume', '--json', '-m', 'gpt-test', '-c', 'model_reasoning_effort=medium', 'codex-session-retry', '-']);
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

function getRuntimeFileWriteLockDir(projectRoot: string, dataDirName: string, filePath: string): string {
  const normalized = resolve(filePath).replace(/\\/g, '/').replace(/\/+$/g, '').trim().toLowerCase();
  return join(
    projectRoot,
    dataDirName,
    '.locks',
    'runtime-file-writes',
    `${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}.lock`,
  );
}

function getRuntimeFileWriteLockFallbackRoot(projectRoot: string, dataDirName: string): string {
  const normalizedRoot = resolve(projectRoot).replace(/\\/g, '/').replace(/\/+$/g, '').trim().toLowerCase();
  const scopeKey = createHash('sha256')
    .update(normalizedRoot + '\0' + dataDirName)
    .digest('hex')
    .slice(0, 32);
  return join(tmpdir(), 'autocode-runtime-file-write-locks', scopeKey, 'runtime-file-writes');
}

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
