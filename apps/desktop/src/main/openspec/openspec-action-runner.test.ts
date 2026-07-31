import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type {
  OpenSpecAction,
  OpenSpecBoardSnapshot,
  Project,
  RunOpenSpecActionInput,
  Task,
} from '../../shared/types';
import { OPEN_SPEC_ACTIONS, OPEN_SPEC_VERSION } from '../../shared/types';
import {
  OpenSpecActionRunner,
  __openSpecActionRunnerTestUtils,
} from './openspec-action-runner';
import { OpenSpecLockManager } from './openspec-lock-manager';

function task(store = false, schemaName = 'spec-driven'): Task {
  return {
    id: 'spec-task',
    specId: 'spec-task',
    projectId: 'project-a',
    title: 'Spec task',
    description: 'Create an audit log capability.',
    status: 'backlog',
    subtasks: [],
    logs: [],
    metadata: {
      developmentMode: 'spec',
      openSpec: {
        formatVersion: 1,
        rootKind: store ? 'store' : 'project',
        ...(store ? { storeId: 'shared-specs' } : {}),
        schemaName,
      },
    },
    createdAt: new Date('2026-07-28T00:00:00.000Z'),
    updatedAt: new Date('2026-07-28T00:00:00.000Z'),
  };
}

function validInput(action: OpenSpecAction): RunOpenSpecActionInput {
  return {
    taskId: 'spec-task',
    projectId: 'project-a',
    action,
    changeName: action === 'new' || action === 'propose' ? 'change-a' : undefined,
    ...(action === 'archive' ? { confirmed: true } : {}),
    ...(action === 'bulk-archive'
      ? {
          selectedChanges: ['change-a', 'change-b'],
          confirmed: true,
        }
      : {}),
  };
}

function boardSnapshot(
  overrides: Partial<OpenSpecBoardSnapshot> = {},
): OpenSpecBoardSnapshot {
  return {
    taskId: 'spec-task',
    openSpecVersion: OPEN_SPEC_VERSION,
    rootKind: 'project',
    rootLabel: 'project-a',
    initialized: true,
    changeName: 'change-a',
    schema: { name: 'spec-driven' },
    artifacts: [{
      id: 'proposal',
      outputPath: 'openspec/changes/change-a/proposal.md',
      status: 'ready',
      missingDeps: [],
      existingOutputPaths: [],
      dependencies: [],
      unlocks: ['design'],
      inProgress: false,
      blocksApply: true,
    }],
    applyRequires: ['tasks'],
    activeRun: null,
    validation: null,
    nextSteps: [],
    availableActions: ['continue'],
    archived: false,
    revision: 1,
    ...overrides,
  };
}

describe('OpenSpecActionRunner input contract', () => {
  it('accepts every one-to-one official Action and rejects unknown Actions', () => {
    expect(OPEN_SPEC_ACTIONS).toHaveLength(12);
    for (const action of OPEN_SPEC_ACTIONS) {
      expect(() => __openSpecActionRunnerTestUtils.validateRunInput(validInput(action)))
        .not.toThrow();
    }
    expect(() => __openSpecActionRunnerTestUtils.validateRunInput({
      taskId: 'spec-task',
      action: 'standard-plan' as OpenSpecAction,
    })).toThrow(/Unsupported OpenSpec Action/);
  });

  it('validates destructive confirmation and complete Bulk Archive selection', () => {
    expect(() => __openSpecActionRunnerTestUtils.validateRunInput({
      taskId: 'spec-task',
      action: 'archive',
    })).toThrow(/explicit confirmation/);
    expect(() => __openSpecActionRunnerTestUtils.validateRunInput({
      taskId: 'spec-task',
      action: 'bulk-archive',
      confirmed: true,
      selectedChanges: ['only-one'],
    })).toThrow(/at least two/);
    expect(() => __openSpecActionRunnerTestUtils.validateRunInput({
      taskId: 'spec-task',
      action: 'bulk-archive',
      confirmed: true,
      selectedChanges: ['duplicate', 'duplicate'],
    })).toThrow(/unique kebab-case/);
    expect(() => __openSpecActionRunnerTestUtils.validateRunInput({
      taskId: 'spec-task',
      action: 'bulk-archive',
      confirmed: true,
      selectedChanges: ['valid-change', '../escape'],
    })).toThrow(/unique kebab-case/);
  });

  it('blocks Apply at the centralized Runner gate until the planning review is acknowledged', async () => {
    const pendingReview = {
      runId: randomUUID(),
      state: 'ready' as const,
      createdAt: '2026-07-31T01:00:00.000Z',
      completedAt: '2026-07-31T01:01:00.000Z',
      changeCount: 2,
    };
    const planningReviews = {
      readPending: vi.fn().mockReturnValue(pendingReview),
    };
    const runner = new OpenSpecActionRunner(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      {} as never,
      planningReviews as never,
    );
    const currentTask = task();
    const currentProject = {
      id: 'project-a',
      path: 'C:\\project',
    } as Project;

    await expect(runner.runAction(currentTask, currentProject, {
      taskId: currentTask.id,
      projectId: currentProject.id,
      action: 'apply',
      changeName: 'change-a',
    })).rejects.toThrow(
      `planning review "${pendingReview.runId}" has been reviewed and acknowledged`,
    );
    expect(planningReviews.readPending).toHaveBeenCalledWith(
      currentTask,
      currentProject,
    );

    expect(() =>
      __openSpecActionRunnerTestUtils.assertPlanningReviewAcknowledged(
        'update',
        pendingReview,
      )
    ).not.toThrow();
    expect(() =>
      __openSpecActionRunnerTestUtils.assertPlanningReviewAcknowledged(
        'apply',
        null,
      )
    ).not.toThrow();
  });

  it('carries an interrupted Update baseline into the resumed run and drops it for other Actions', async () => {
    const currentTask = task();
    const currentProject = {
      id: 'project-a',
      path: 'C:\\project',
    } as Project;
    const interruptedRunId = randomUUID();
    const runtimeStore = {
      initialize: vi.fn(),
      read: vi.fn().mockReturnValue({
        state: 'interrupted',
        activeRunId: interruptedRunId,
        workflowStage: 'planning',
        selectedChangeName: 'change-a',
      }),
      update: vi.fn(),
      setRecoveryInput: vi.fn(),
      appendActionEvent: vi.fn(),
    };
    const planningReviews = {
      readPending: vi.fn().mockReturnValue(null),
      begin: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      discard: vi.fn(),
    };
    const runner = new OpenSpecActionRunner(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runtimeStore as never,
      {} as never,
      vi.fn(),
      vi.fn(),
      vi.fn().mockResolvedValue(boardSnapshot()),
      {} as never,
      planningReviews as never,
    );

    await runner.runAction(currentTask, currentProject, {
      taskId: currentTask.id,
      projectId: currentProject.id,
      action: 'apply',
      changeName: 'change-a',
    }, { resumeRunId: interruptedRunId });
    await new Promise((resolve) => setImmediate(resolve));

    expect(planningReviews.discard).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      interruptedRunId,
    );

    const internalRunner = runner as unknown as {
      activeRuns: Map<string, { resumedFromRunId?: string }>;
    };
    internalRunner.activeRuns.clear();
    planningReviews.discard.mockClear();

    await runner.runAction(currentTask, currentProject, {
      taskId: currentTask.id,
      projectId: currentProject.id,
      action: 'update',
      changeName: 'change-a',
      arguments: 'refine the plan',
    }, { resumeRunId: interruptedRunId });
    await new Promise((resolve) => setImmediate(resolve));

    expect(planningReviews.discard).not.toHaveBeenCalledWith(
      currentTask,
      currentProject,
      interruptedRunId,
    );
  });

  it('passes official Action arguments without translating or adding Standard workflow text', () => {
    const currentTask = task();
    expect(__openSpecActionRunnerTestUtils.buildOfficialActionArgument(
      {
        taskId: currentTask.id,
        action: 'apply',
        arguments: 'implement the next unchecked tasks',
      },
      currentTask,
      'change-a',
    )).toBe('change-a implement the next unchecked tasks');
    expect(__openSpecActionRunnerTestUtils.buildOfficialActionArgument(
      {
        taskId: currentTask.id,
        action: 'new',
        changeName: 'new-change',
        arguments: 'create audit logs',
      },
      currentTask,
      'old-change',
    )).toBe('new-change create audit logs');
    expect(__openSpecActionRunnerTestUtils.buildOfficialActionArgument(
      {
        taskId: currentTask.id,
        action: 'bulk-archive',
        selectedChanges: ['change-a', 'change-b'],
        confirmed: true,
      },
      currentTask,
      'change-a',
    )).toBe('change-a change-b');
    expect(__openSpecActionRunnerTestUtils.buildOfficialActionArgument(
      {
        taskId: currentTask.id,
        action: 'onboard',
      },
      currentTask,
      'change-a',
    )).toBe(currentTask.description);
  });

  it('passes a selected non-default Schema only through New/Propose Action arguments', () => {
    const adrTask = task(false, 'spec-driven-with-adr');
    expect(__openSpecActionRunnerTestUtils.buildOfficialActionArgument(
      {
        taskId: adrTask.id,
        action: 'new',
        changeName: 'adr-change',
        arguments: 'record the durable architecture decision',
      },
      adrTask,
      null,
    )).toBe(
      'adr-change record the durable architecture decision --schema spec-driven-with-adr',
    );
    expect(__openSpecActionRunnerTestUtils.buildOfficialActionArgument(
      {
        taskId: adrTask.id,
        action: 'propose',
      },
      adrTask,
      null,
    )).toBe(
      `${adrTask.description} --schema spec-driven-with-adr`,
    );
    expect(__openSpecActionRunnerTestUtils.buildOfficialActionArgument(
      {
        taskId: adrTask.id,
        action: 'continue',
      },
      adrTask,
      'adr-change',
    )).toBe('adr-change');
  });

  it('rejects an unsafe task Schema before placing it in official Action arguments', () => {
    expect(() => __openSpecActionRunnerTestUtils.buildOfficialActionArgument(
      {
        taskId: 'spec-task',
        action: 'new',
        changeName: 'safe-change',
      },
      task(false, 'spec-driven --store untrusted'),
      null,
    )).toThrow(/invalid OpenSpec schema name/);
  });

  it('binds Store mode through a registered ID without exposing an arbitrary path', () => {
    const message = __openSpecActionRunnerTestUtils.buildOfficialActionArgument(
      {
        taskId: 'spec-task',
        action: 'continue',
      },
      task(true),
      'change-a',
    );
    expect(message).toBe('Use the registered OpenSpec Store "shared-specs".\n\nchange-a');
    expect(message).not.toMatch(/[A-Z]:\\|\/tmp\//);
  });

  it('limits planning Actions to openspec and implementation Actions to official edit roots', () => {
    const projectRoot = {
      cwd: 'C:\\workspace',
      workspaceRoot: 'C:\\workspace',
      rootKind: 'project' as const,
      rootLabel: 'workspace',
      worktree: false,
    };
    const planning = __openSpecActionRunnerTestUtils.buildActionPathPolicy(
      'update',
      projectRoot,
      projectRoot.workspaceRoot,
      new Set([projectRoot.workspaceRoot]),
    );
    expect(planning).toEqual({
      allowedWritePaths: [join(projectRoot.workspaceRoot, 'openspec')],
      runtimeRoot: projectRoot.workspaceRoot,
    });

    const apply = __openSpecActionRunnerTestUtils.buildActionPathPolicy(
      'apply',
      projectRoot,
      projectRoot.workspaceRoot,
      new Set([projectRoot.workspaceRoot]),
    );
    expect(apply.allowedWritePaths).toEqual([
      join(projectRoot.workspaceRoot, 'openspec'),
      projectRoot.workspaceRoot,
    ]);
  });

  it('grants trusted ADR artifact Actions only the workspace-level adr directory', () => {
    const projectRoot = {
      cwd: 'C:\\workspace',
      workspaceRoot: 'C:\\workspace',
      rootKind: 'project' as const,
      rootLabel: 'workspace',
      worktree: false,
    };
    const trusted = __openSpecActionRunnerTestUtils.buildActionPathPolicy(
      'propose',
      projectRoot,
      projectRoot.workspaceRoot,
      new Set(),
      true,
    );
    expect(trusted.allowedWritePaths).toEqual([
      join(projectRoot.workspaceRoot, 'openspec'),
      join(projectRoot.workspaceRoot, 'adr'),
    ]);

    const shadowed = __openSpecActionRunnerTestUtils.buildActionPathPolicy(
      'propose',
      projectRoot,
      projectRoot.workspaceRoot,
      new Set(),
      false,
    );
    expect(shadowed.allowedWritePaths).toEqual([
      join(projectRoot.workspaceRoot, 'openspec'),
    ]);

    const apply = __openSpecActionRunnerTestUtils.buildActionPathPolicy(
      'apply',
      projectRoot,
      projectRoot.workspaceRoot,
      new Set([projectRoot.workspaceRoot]),
      true,
    );
    expect(apply.allowedWritePaths).not.toContain(join(projectRoot.workspaceRoot, 'adr'));
  });

  it('anchors trusted ADR writes to the task worktree instead of the main checkout', () => {
    const worktreeRoot = {
      cwd: 'C:\\workspace\\.autocode\\worktrees\\tasks\\spec-task',
      workspaceRoot: 'C:\\workspace\\.autocode\\worktrees\\tasks\\spec-task',
      rootKind: 'project' as const,
      rootLabel: 'spec-task',
      worktree: true,
    };
    const policy = __openSpecActionRunnerTestUtils.buildActionPathPolicy(
      'continue',
      worktreeRoot,
      worktreeRoot.workspaceRoot,
      new Set(),
      true,
    );
    expect(policy.allowedWritePaths).toEqual([
      join(worktreeRoot.workspaceRoot, 'openspec'),
      join(worktreeRoot.workspaceRoot, 'adr'),
    ]);
    expect(policy.allowedWritePaths).not.toContain(join('C:\\workspace', 'adr'));
  });

  it('keeps pinned runtime reads separate from project and OpenSpec write roots', () => {
    const executablePath = join('C:\\app', 'Aperant.exe');
    expect(__openSpecActionRunnerTestUtils.buildTrustedRuntimeReadPaths(
      'C:\\runtime\\shim',
      'C:\\app\\resources\\openspec\\1.6.0\\runtime\\node_modules\\@fission-ai\\openspec',
      'C:\\app\\resources\\openspec\\1.6.0\\runtime\\node_modules',
      executablePath,
    )).toEqual([
      'C:\\runtime\\shim',
      'C:\\app\\resources\\openspec\\1.6.0\\runtime\\node_modules\\@fission-ai\\openspec',
      'C:\\app\\resources\\openspec\\1.6.0\\runtime\\node_modules',
      dirname(executablePath),
    ]);
  });

  it('runs Store Actions at the official Store root without granting the task workspace', () => {
    const storeRoot = {
      cwd: 'C:\\workspace',
      workspaceRoot: 'C:\\workspace',
      rootKind: 'store' as const,
      storeId: 'shared-specs',
      rootLabel: 'Store: shared-specs',
      worktree: false,
    };
    const policy = __openSpecActionRunnerTestUtils.buildActionPathPolicy(
      'apply',
      storeRoot,
      'D:\\registered-store',
      new Set(['D:\\registered-store']),
    );
    expect(policy).toEqual({
      allowedWritePaths: [
        join('D:\\registered-store', 'openspec'),
        'D:\\registered-store',
      ],
      runtimeRoot: 'D:\\registered-store',
    });
    expect(policy.allowedWritePaths).not.toContain(storeRoot.workspaceRoot);
    expect(() => __openSpecActionRunnerTestUtils.buildActionPathPolicy(
      'new',
      storeRoot,
      null,
      new Set(),
    )).toThrow(/planning root/);
  });

  it('keeps Store planning under the Store but writes trusted ADRs to the code workspace', () => {
    const storeRoot = {
      cwd: 'C:\\workspace',
      workspaceRoot: 'C:\\workspace',
      rootKind: 'store' as const,
      storeId: 'shared-specs',
      rootLabel: 'Store: shared-specs',
      worktree: false,
    };
    const planningRoot = 'D:\\registered-store';
    const policy = __openSpecActionRunnerTestUtils.buildActionPathPolicy(
      'ff',
      storeRoot,
      planningRoot,
      new Set(),
      true,
    );
    expect(policy).toEqual({
      allowedWritePaths: [
        join(planningRoot, 'openspec'),
        join(storeRoot.workspaceRoot, 'adr'),
      ],
      runtimeRoot: planningRoot,
    });
    expect(policy.allowedWritePaths).not.toContain(join(planningRoot, 'adr'));
  });
});

describe('OpenSpecActionRunner trusted ADR Schema source', () => {
  it('trusts only the package Schema at the pinned package path', () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-package-'));
    const expectedSchemaRoot = join(
      packageRoot,
      'schemas',
      'spec-driven-with-adr',
    );
    const shadowRoot = join(packageRoot, 'project-shadow');
    mkdirSync(expectedSchemaRoot, { recursive: true });
    mkdirSync(shadowRoot, { recursive: true });
    try {
      expect(__openSpecActionRunnerTestUtils.isTrustedAdrSchemaResolution(
        {
          name: 'spec-driven-with-adr',
          source: 'package',
          path: expectedSchemaRoot,
          shadows: [],
        },
        packageRoot,
      )).toBe(true);
      for (const source of ['project', 'user']) {
        expect(__openSpecActionRunnerTestUtils.isTrustedAdrSchemaResolution(
          {
            name: 'spec-driven-with-adr',
            source,
            path: expectedSchemaRoot,
          },
          packageRoot,
        )).toBe(false);
      }
      expect(__openSpecActionRunnerTestUtils.isTrustedAdrSchemaResolution(
        {
          name: 'spec-driven-with-adr',
          source: 'package',
          path: shadowRoot,
        },
        packageRoot,
      )).toBe(false);
      expect(__openSpecActionRunnerTestUtils.isTrustedAdrSchemaResolution(
        {
          name: 'spec-driven',
          source: 'package',
          path: expectedSchemaRoot,
        },
        packageRoot,
      )).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('checks the Store planning root and denies a Store-local Schema shadow', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-schema-shadow-'));
    const packageRoot = join(testRoot, 'package');
    const planningRoot = join(testRoot, 'registered-store');
    const packageSchemaRoot = join(
      packageRoot,
      'schemas',
      'spec-driven-with-adr',
    );
    const shadowSchemaRoot = join(
      planningRoot,
      'openspec',
      'schemas',
      'spec-driven-with-adr',
    );
    mkdirSync(packageSchemaRoot, { recursive: true });
    mkdirSync(shadowSchemaRoot, { recursive: true });
    try {
      const schemaWhich = vi.fn().mockResolvedValue({
        name: 'spec-driven-with-adr',
        source: 'project',
        path: shadowSchemaRoot,
        shadows: [{ source: 'package', path: packageSchemaRoot }],
      });
      await expect(
        __openSpecActionRunnerTestUtils.hasTrustedAdrSchemaWriteAccess(
          { schemaWhich } as never,
          planningRoot,
          'spec-driven-with-adr',
          'propose',
          packageRoot,
        ),
      ).resolves.toBe(false);
      expect(schemaWhich).toHaveBeenCalledWith(
        { cwd: planningRoot },
        'spec-driven-with-adr',
        undefined,
      );

      schemaWhich.mockResolvedValue({
        name: 'spec-driven-with-adr',
        source: 'package',
        path: packageSchemaRoot,
        shadows: [],
      });
      await expect(
        __openSpecActionRunnerTestUtils.hasTrustedAdrSchemaWriteAccess(
          { schemaWhich } as never,
          planningRoot,
          'spec-driven-with-adr',
          'propose',
          packageRoot,
        ),
      ).resolves.toBe(true);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });
});

describe('OpenSpecActionRunner console formatting', () => {
  it.each(['Read', 'Glob', 'Bash'])(
    'omits the generic successful %s completion line',
    (toolName) => {
      expect(__openSpecActionRunnerTestUtils.formatOpenSpecConsoleChunk({
        type: 'tool_end',
        content: `[${toolName}] Done`,
        tool: { name: toolName, success: true },
      }, true)).toBe('');
    },
  );

  it('keeps text deltas contiguous, separates tool starts, and omits generic Done events', () => {
    const format = __openSpecActionRunnerTestUtils.formatOpenSpecConsoleChunk;
    let outputEndsWithNewline = true;
    const chunks = [
      { type: 'text' as const, content: 'Starting ' },
      { type: 'text' as const, content: 'Action' },
      { type: 'tool_start' as const, content: '[Bash] openspec new change-a' },
      {
        type: 'tool_end' as const,
        content: '[Bash] Done',
        tool: { name: 'Bash', success: true },
      },
      { type: 'text' as const, content: 'Finished.' },
    ];
    const output = chunks.map((chunk) => {
      const formatted = format(chunk, outputEndsWithNewline);
      if (formatted) outputEndsWithNewline = formatted.endsWith('\n');
      return formatted;
    }).join('');

    expect(output).toBe(
      'Starting Action\n[Bash] openspec new change-a\nFinished.',
    );
  });

  it('keeps failed tool completions and meaningful completion summaries', () => {
    const format = __openSpecActionRunnerTestUtils.formatOpenSpecConsoleChunk;
    expect(format({
      type: 'tool_end',
      content: '[Read] Error',
      tool: { name: 'Read', success: false },
    }, true)).toBe('[Read] Error\n');
    expect(format({
      type: 'tool_end',
      content: '[Bash] Completed with test summary',
      tool: { name: 'Bash', success: true },
    }, true)).toBe('[Bash] Completed with test summary\n');
    expect(format({
      type: 'tool_end',
      content: '[Read] Done',
      tool: { name: 'Read' },
    }, true)).toBe('[Read] Done\n');
    expect(format({
      type: 'text',
      content: '[Read] Done',
    }, true)).toBe('[Read] Done');
  });

  it('normalizes carriage returns in multiline error output', () => {
    expect(__openSpecActionRunnerTestUtils.formatOpenSpecConsoleChunk(
      {
        type: 'error',
        content: 'first line\r\nsecond line\rthird line',
      },
      true,
    )).toBe('first line\nsecond line\nthird line\n');
  });
});

describe('OpenSpecActionRunner automatic Continue directives', () => {
  const detect = __openSpecActionRunnerTestUtils.detectOpenSpecContinueDirective;

  it.each([
    '为避免覆盖现有内容，本次操作已安全停止，且未创建或修改任何 artifact。请运行 `/opsx:continue` 继续处理该变更。',
    'Run `/opsx:continue` to proceed with the change.',
    '无需人工输入，系统将自动运行 `/opsx:continue`。',
    '### Resolution\n\nPlease run:\n\n```bash\n/opsx:continue\n```',
    '/opsx:continue',
  ])('detects an explicit Continue instruction: %s', (message) => {
    expect(detect(message)).toBe(true);
  });

  it.each([
    '不要运行 `/opsx:continue`，等待状态恢复。',
    'No need to run `/opsx:continue` for this change.',
    'For example, run `/opsx:continue` when demonstrating the workflow.',
    '教程示例：例如运行 `/opsx:continue` 可以创建下一个文档。',
    'The command `/opsx:continue` is documented by OpenSpec.',
    '',
  ])('does not treat a negation or mention as an instruction: %s', (message) => {
    expect(detect(message)).toBe(false);
  });

  it('uses only the final assistant message from a completed session', () => {
    expect(__openSpecActionRunnerTestUtils.getFinalAssistantText({
      messages: [
        { role: 'user', content: 'Create the next artifact.' },
        { role: 'assistant', content: 'An earlier note mentioned /opsx:continue.' },
        { role: 'assistant', content: 'No follow-up Action is required.' },
      ],
    })).toBe('No follow-up Action is required.');
  });

  it('falls back to bounded streamed assistant text when SessionResult has no message', () => {
    let streamed = '';
    for (const delta of [
      '为避免覆盖现有内容，本次操作已安全停止。请运行 `/opsx:',
      'continue` 继续处理该变更。',
    ]) {
      streamed = __openSpecActionRunnerTestUtils.appendAssistantTextTail(
        streamed,
        delta,
      );
    }
    const finalText = __openSpecActionRunnerTestUtils.resolveFinalAssistantText(
      streamed,
      { messages: [] },
    );
    expect(finalText).toBe(streamed);
    expect(detect(finalText)).toBe(true);
    expect(__openSpecActionRunnerTestUtils.resolveFinalAssistantText(
      streamed,
      {
        messages: [{
          role: 'assistant',
          content: 'The final result supersedes streamed narration.',
        }],
      },
    )).toBe('The final result supersedes streamed narration.');
  });

  it('resolves the model-chosen existing change only after official-list validation', () => {
    const finalText = [
      '变更 `build-browser-match-three-game` 已存在，因此未创建新变更。',
      '',
      '- **现有变更位置**：`E:\\Work\\Test\\aitest\\openspec\\changes\\build-browser-match-three-game`',
      '',
      '请运行 `/opsx:continue` 继续处理该变更。',
    ].join('\n');
    expect(
      __openSpecActionRunnerTestUtils.extractOpenSpecNewChangeName(
        'openspec new change "build-browser-match-three-game"',
      ),
    ).toBe('build-browser-match-three-game');
    expect(
      __openSpecActionRunnerTestUtils.extractContinueChangeNameFromText(
        finalText,
      ),
    ).toBe('build-browser-match-three-game');
    expect(
      __openSpecActionRunnerTestUtils.resolveOfficialContinueChangeName({
        observedChangeName: 'build-browser-match-three-game',
        finalAssistantText: finalText,
        activeChangeNames: [
          'define-browser-match-three-product-scope',
          'build-browser-match-three-game',
        ],
      }),
    ).toBe('build-browser-match-three-game');
    expect(
      __openSpecActionRunnerTestUtils.resolveOfficialContinueChangeName({
        observedChangeName: 'untrusted-change',
        finalAssistantText: '请运行 `/opsx:continue`。',
        activeChangeNames: ['official-change'],
      }),
    ).toBeNull();
  });
});

describe('OpenSpecActionRunner automatic Continue decisions', () => {
  const resolveDecision =
    __openSpecActionRunnerTestUtils.resolveAutomaticContinueDecision;
  const directive =
    '为避免覆盖现有内容，本次操作已安全停止。请运行 `/opsx:continue` 继续处理。';

  function decide(overrides: Record<string, unknown> = {}) {
    return resolveDecision({
      action: 'new',
      sessionOutcome: 'completed',
      cancelled: false,
      finalAssistantText: directive,
      automaticContinueDepth: 0,
      snapshot: boardSnapshot(),
      ...overrides,
    });
  }

  it('starts Continue only from a completed safe source Action and official ready status', () => {
    expect(decide()).toEqual({
      kind: 'start',
      changeName: 'change-a',
    });
    expect(decide({ action: 'apply' })).toEqual({
      kind: 'stop',
      reason: 'source_action',
    });
    expect(decide({ action: 'update' })).toEqual({
      kind: 'stop',
      reason: 'source_action',
    });
    expect(decide({ sessionOutcome: 'max_steps' })).toEqual({
      kind: 'stop',
      reason: 'session_outcome',
    });
    expect(decide({ sessionOutcome: 'context_window' })).toEqual({
      kind: 'stop',
      reason: 'session_outcome',
    });
    expect(decide({ sessionOutcome: 'error' })).toEqual({
      kind: 'stop',
      reason: 'session_outcome',
    });
    expect(decide({ cancelled: true })).toEqual({
      kind: 'stop',
      reason: 'cancelled',
    });
    expect(decide({ lastError: 'provider failed' })).toEqual({
      kind: 'stop',
      reason: 'agent_error',
    });
  });

  it('does not continue when the official post-run status disallows it', () => {
    expect(decide({
      snapshot: boardSnapshot({ availableActions: [] }),
    })).toEqual({
      kind: 'stop',
      reason: 'unavailable',
    });
    expect(decide({
      snapshot: boardSnapshot({
        artifacts: [{
          ...boardSnapshot().artifacts[0],
          status: 'done',
        }],
      }),
    })).toEqual({
      kind: 'stop',
      reason: 'unavailable',
    });
    expect(decide({
      snapshot: boardSnapshot({ archived: true }),
    })).toEqual({
      kind: 'stop',
      reason: 'unavailable',
    });
  });

  it('stops a no-progress Continue loop and enforces the hard chain limit', () => {
    const unchanged = boardSnapshot();
    expect(decide({
      action: 'continue',
      startStatusFingerprint:
        __openSpecActionRunnerTestUtils.openSpecStatusFingerprint(unchanged),
      snapshot: unchanged,
    })).toEqual({
      kind: 'stop',
      reason: 'stalled',
    });

    const advanced = boardSnapshot({
      artifacts: [
        {
          ...unchanged.artifacts[0],
          status: 'done',
          existingOutputPaths: ['openspec/changes/change-a/proposal.md'],
        },
        {
          ...unchanged.artifacts[0],
          id: 'design',
          outputPath: 'openspec/changes/change-a/design.md',
          status: 'ready',
          unlocks: ['tasks'],
        },
      ],
      revision: 2,
    });
    expect(decide({
      action: 'continue',
      startStatusFingerprint:
        __openSpecActionRunnerTestUtils.openSpecStatusFingerprint(unchanged),
      snapshot: advanced,
    })).toEqual({
      kind: 'start',
      changeName: 'change-a',
    });

    expect(decide({
      automaticContinueDepth:
        __openSpecActionRunnerTestUtils.MAX_AUTOMATIC_CONTINUE_DEPTH,
    })).toEqual({
      kind: 'stop',
      reason: 'limit',
    });
  });
});

describe('OpenSpecActionRunner automatic Verify decisions', () => {
  const resolveDecision =
    __openSpecActionRunnerTestUtils.resolveAutomaticVerifyDecision;

  function decide(overrides: Record<string, unknown> = {}) {
    return resolveDecision({
      action: 'apply',
      actionOutcome: 'succeeded',
      sessionOutcome: 'completed',
      cancelled: false,
      snapshot: boardSnapshot({
        taskProgress: { completed: 3, total: 3 },
        availableActions: ['verify', 'archive'],
      }),
      ...overrides,
    });
  }

  it('starts Verify after a successful Apply completes every official task', () => {
    expect(decide()).toEqual({
      kind: 'start',
      changeName: 'change-a',
    });
  });

  it('does not verify incomplete or empty implementation checklists', () => {
    for (const taskProgress of [
      undefined,
      { completed: 0, total: 0 },
      { completed: 2, total: 3 },
    ]) {
      expect(decide({
        snapshot: boardSnapshot({
          taskProgress,
          availableActions: ['verify'],
        }),
      })).toEqual({
        kind: 'stop',
        reason: 'incomplete',
      });
    }
  });

  it('does not verify an unsuccessful, interrupted, or non-Apply session', () => {
    expect(decide({ action: 'verify' })).toEqual({
      kind: 'stop',
      reason: 'source_action',
    });
    expect(decide({ actionOutcome: 'failed' })).toEqual({
      kind: 'stop',
      reason: 'action_outcome',
    });
    expect(decide({ actionOutcome: 'cancelled' })).toEqual({
      kind: 'stop',
      reason: 'action_outcome',
    });
    expect(decide({ sessionOutcome: 'max_steps' })).toEqual({
      kind: 'stop',
      reason: 'session_outcome',
    });
    expect(decide({ sessionOutcome: 'context_window' })).toEqual({
      kind: 'stop',
      reason: 'session_outcome',
    });
    expect(decide({ cancelled: true })).toEqual({
      kind: 'stop',
      reason: 'cancelled',
    });
    expect(decide({ lastError: 'provider failed' })).toEqual({
      kind: 'stop',
      reason: 'agent_error',
    });
  });

  it('requires an active supported change with official Verify available', () => {
    for (const snapshotOverride of [
      { initialized: false },
      { archived: true },
      { changeName: null },
      { availableActions: ['archive'] as OpenSpecAction[] },
    ]) {
      expect(decide({
        snapshot: boardSnapshot({
          taskProgress: { completed: 3, total: 3 },
          availableActions: ['verify'],
          ...snapshotOverride,
        }),
      })).toEqual({
        kind: 'stop',
        reason: 'unavailable',
      });
    }
  });

  it('allows read-only Verify when the upstream status contains unsupported fields', () => {
    expect(decide({
      snapshot: boardSnapshot({
        taskProgress: { completed: 3, total: 3 },
        availableActions: ['verify'],
        unsupportedStatus: true,
      }),
    })).toEqual({
      kind: 'start',
      changeName: 'change-a',
    });
  });
});

describe('OpenSpecActionRunner task lifecycle', () => {
  const resolveLifecycle =
    __openSpecActionRunnerTestUtils.resolveFinishedTaskLifecycle;
  const startedStage =
    __openSpecActionRunnerTestUtils.workflowStageForStartedAction;

  it('moves Apply into implementation and every planning mutation back into planning', () => {
    expect(startedStage('apply', 'planning')).toBe('implementation');
    for (const action of ['new', 'propose', 'continue', 'ff', 'update', 'sync'] as const) {
      expect(startedStage(action, 'verified')).toBe('planning');
    }
    expect(startedStage('verify', 'implementation')).toBe('implementation');
    expect(startedStage('archive', 'verified')).toBe('verified');
  });

  it('closes verified, planning, failed, cancelled, and archived runs into stable task states', () => {
    const completed = boardSnapshot({
      taskProgress: { completed: 3, total: 3 },
      availableActions: ['verify', 'archive'],
    });
    const base = {
      snapshot: completed,
      automaticContinueStarting: false,
      archivedSelectedChange: false,
    };

    expect(resolveLifecycle({
      ...base,
      action: 'verify',
      outcome: 'succeeded',
      currentStage: 'implementation',
    })).toEqual({
      taskStatus: 'human_review',
      reviewReason: 'completed',
      workflowStage: 'verified',
      executionPhase: 'complete',
    });
    expect(resolveLifecycle({
      ...base,
      action: 'apply',
      outcome: 'succeeded',
      currentStage: 'implementation',
    })).toEqual({
      taskStatus: 'human_review',
      reviewReason: 'completed',
      workflowStage: 'implementation',
      executionPhase: 'complete',
    });
    expect(resolveLifecycle({
      ...base,
      snapshot: boardSnapshot({
        taskProgress: { completed: 2, total: 3 },
      }),
      action: 'apply',
      outcome: 'succeeded',
      currentStage: 'implementation',
    })).toEqual({
      taskStatus: 'human_review',
      reviewReason: 'stopped',
      workflowStage: 'implementation',
      executionPhase: 'stopped',
    });
    expect(resolveLifecycle({
      ...base,
      action: 'update',
      outcome: 'succeeded',
      currentStage: 'planning',
    })).toEqual({
      taskStatus: 'human_review',
      reviewReason: 'plan_review',
      workflowStage: 'planning',
      executionPhase: 'planning',
    });
    expect(resolveLifecycle({
      ...base,
      action: 'apply',
      outcome: 'failed',
      currentStage: 'implementation',
    })).toMatchObject({
      taskStatus: 'error',
      reviewReason: 'errors',
      workflowStage: 'implementation',
    });
    expect(resolveLifecycle({
      ...base,
      action: 'apply',
      outcome: 'cancelled',
      currentStage: 'implementation',
    })).toMatchObject({
      taskStatus: 'human_review',
      reviewReason: 'stopped',
      workflowStage: 'implementation',
    });
    expect(resolveLifecycle({
      ...base,
      action: 'archive',
      outcome: 'succeeded',
      currentStage: 'verified',
      archivedSelectedChange: true,
    })).toEqual({
      taskStatus: 'done',
      reviewReason: null,
      workflowStage: 'archived',
      executionPhase: 'complete',
    });
    expect(resolveLifecycle({
      ...base,
      action: 'explore',
      outcome: 'succeeded',
      currentStage: 'planning',
    })).toEqual({
      taskStatus: 'human_review',
      reviewReason: 'stopped',
      workflowStage: 'planning',
      executionPhase: 'stopped',
    });
  });

  it('keeps an automatic Continue chain in progress without entering plan review', () => {
    expect(resolveLifecycle({
      action: 'continue',
      outcome: 'succeeded',
      currentStage: 'planning',
      snapshot: boardSnapshot(),
      automaticContinueStarting: true,
      archivedSelectedChange: false,
    })).toEqual({
      taskStatus: 'in_progress',
      reviewReason: null,
      workflowStage: 'planning',
      executionPhase: 'planning',
    });
  });

  it('keeps Apply in progress while automatic Verify starts', () => {
    expect(resolveLifecycle({
      action: 'apply',
      outcome: 'succeeded',
      currentStage: 'implementation',
      snapshot: boardSnapshot({
        taskProgress: { completed: 3, total: 3 },
        availableActions: ['verify'],
      }),
      automaticContinueStarting: false,
      automaticVerifyStarting: true,
      archivedSelectedChange: false,
    })).toEqual({
      taskStatus: 'in_progress',
      reviewReason: null,
      workflowStage: 'implementation',
      executionPhase: 'verify',
    });
  });

  it('persists and publishes the verified review state from the reconciled checklist', async () => {
    const currentTask = task();
    const currentProject = {
      id: 'project-a',
      path: 'C:\\project',
    } as Project;
    let runtime: Record<string, unknown> = {
      selectedChangeName: 'change-a',
      lastSuccessfulAction: 'apply',
      workflowStage: 'implementation',
    };
    const runtimeStore = {
      read: vi.fn(() => runtime),
      update: vi.fn((
        _task: Task,
        _project: Project,
        patch: Record<string, unknown>,
      ) => {
        runtime = { ...runtime, ...patch };
        return runtime;
      }),
      appendActionEvent: vi.fn(),
    };
    const publishTaskStatus = vi.fn();
    const onReconcile = vi.fn().mockResolvedValue(boardSnapshot({
      taskProgress: { completed: 4, total: 4 },
      availableActions: ['verify', 'archive'],
    }));
    const runner = new OpenSpecActionRunner(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runtimeStore as never,
      {} as never,
      vi.fn(),
      publishTaskStatus,
      onReconcile,
    );
    const runAction = vi.spyOn(runner, 'runAction');
    const internalRunner = runner as unknown as {
      activeRuns: Map<string, unknown>;
      finish: (
        active: unknown,
        outcome: 'succeeded' | 'failed' | 'cancelled',
      ) => Promise<void>;
    };
    const active = {
      task: currentTask,
      project: currentProject,
      summary: {
        runId: randomUUID(),
        action: 'verify',
        state: 'running',
        startedAt: new Date().toISOString(),
      },
      controller: new AbortController(),
      sequence: 1,
      outputEndsWithNewline: true,
      interactionCount: 0,
      cancelled: false,
      finished: false,
      automaticContinueDepth: 0,
      sessionOutcome: 'completed',
      finalAssistantText: 'Verification complete.',
    };
    internalRunner.activeRuns.set('project-a::spec-task', active);

    await internalRunner.finish(active, 'succeeded');

    expect(runtime).toMatchObject({
      taskStatus: 'human_review',
      reviewReason: 'completed',
      workflowStage: 'verified',
      executionPhase: 'complete',
      lastSuccessfulAction: 'verify',
    });
    expect(publishTaskStatus).toHaveBeenLastCalledWith(
      currentTask,
      currentProject,
      'human_review',
      'completed',
    );
    expect(onReconcile).toHaveBeenCalledTimes(2);
    expect(runAction).not.toHaveBeenCalled();
  });
});

describe('OpenSpecActionRunner automatic Verify orchestration', () => {
  it('records and releases Apply before starting a distinct Verify run without human review', async () => {
    const currentTask = task();
    const currentProject = {
      id: 'project-a',
      path: 'C:\\project',
    } as Project;
    const releaseLocks = vi.fn();
    const runtimeStore = {
      read: vi.fn().mockReturnValue({
        selectedChangeName: 'change-a',
        lastSuccessfulAction: null,
        workflowStage: 'implementation',
      }),
      update: vi.fn(),
      appendActionEvent: vi.fn(),
    };
    const publishTaskStatus = vi.fn();
    const completedSnapshot = boardSnapshot({
      taskProgress: { completed: 4, total: 4 },
      availableActions: ['verify', 'archive'],
    });
    let internalRunner: {
      activeRuns: Map<string, unknown>;
      finish: (
        active: unknown,
        outcome: 'succeeded' | 'failed' | 'cancelled',
      ) => Promise<void>;
    };
    const onReconcile = vi.fn(async () => {
      expect(releaseLocks).toHaveBeenCalledOnce();
      expect(internalRunner.activeRuns.has('project-a::spec-task')).toBe(true);
      return completedSnapshot;
    });
    const runner = new OpenSpecActionRunner(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runtimeStore as never,
      {} as never,
      vi.fn(),
      publishTaskStatus,
      onReconcile,
    );
    internalRunner = runner as unknown as typeof internalRunner;
    const runAction = vi.spyOn(runner, 'runAction').mockImplementation(
      async () => {
        expect(releaseLocks).toHaveBeenCalledOnce();
        expect(runtimeStore.appendActionEvent).toHaveBeenCalledOnce();
        expect(internalRunner.activeRuns.has('project-a::spec-task')).toBe(false);
        return { runId: 'automatic-verify-run' };
      },
    );
    const active = {
      task: currentTask,
      project: currentProject,
      summary: {
        runId: 'initial-apply-run',
        action: 'apply',
        state: 'running',
        startedAt: new Date(Date.now() - 2_000).toISOString(),
      },
      controller: new AbortController(),
      releaseLocks,
      sequence: 2,
      outputEndsWithNewline: true,
      interactionCount: 0,
      cancelled: false,
      finished: false,
      automaticContinueDepth: 0,
      sessionOutcome: 'completed',
      finalAssistantText: 'Implementation complete.',
    };
    internalRunner.activeRuns.set('project-a::spec-task', active);

    await internalRunner.finish(active, 'succeeded');

    expect(onReconcile).toHaveBeenCalledOnce();
    expect(runAction).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      {
        taskId: currentTask.id,
        projectId: currentProject.id,
        action: 'verify',
        changeName: 'change-a',
      },
    );
    expect(runtimeStore.appendActionEvent).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      expect.objectContaining({
        runId: 'initial-apply-run',
        action: 'apply',
        state: 'succeeded',
        durationMs: expect.any(Number),
      }),
    );
    expect(runtimeStore.update).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      expect.objectContaining({
        taskStatus: 'in_progress',
        reviewReason: null,
        workflowStage: 'implementation',
        executionPhase: 'verify',
      }),
    );
    expect(publishTaskStatus).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      'in_progress',
      undefined,
    );
    expect(publishTaskStatus).not.toHaveBeenCalledWith(
      currentTask,
      currentProject,
      'human_review',
      expect.anything(),
    );
  });

  it('reports an automatic Verify startup failure as a task error', async () => {
    const currentTask = task();
    const currentProject = {
      id: 'project-a',
      path: 'C:\\project',
    } as Project;
    const publish = vi.fn();
    const publishTaskStatus = vi.fn();
    const runtimeStore = {
      read: vi.fn().mockReturnValue({
        selectedChangeName: 'change-a',
        lastSuccessfulAction: null,
        workflowStage: 'implementation',
      }),
      update: vi.fn(),
      appendActionEvent: vi.fn(),
    };
    const runner = new OpenSpecActionRunner(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runtimeStore as never,
      {} as never,
      publish,
      publishTaskStatus,
      vi.fn().mockResolvedValue(boardSnapshot({
        taskProgress: { completed: 3, total: 3 },
        availableActions: ['verify'],
      })),
    );
    vi.spyOn(runner, 'runAction').mockRejectedValue(
      new Error('Verify startup gate failed'),
    );
    const internalRunner = runner as unknown as {
      activeRuns: Map<string, unknown>;
      finish: (
        active: unknown,
        outcome: 'succeeded' | 'failed' | 'cancelled',
      ) => Promise<void>;
    };
    const active = {
      task: currentTask,
      project: currentProject,
      summary: {
        runId: 'initial-apply-run',
        action: 'apply',
        state: 'running',
        startedAt: new Date().toISOString(),
      },
      controller: new AbortController(),
      releaseLocks: vi.fn(),
      sequence: 1,
      outputEndsWithNewline: true,
      interactionCount: 0,
      cancelled: false,
      finished: false,
      automaticContinueDepth: 0,
      sessionOutcome: 'completed',
      finalAssistantText: 'Implementation complete.',
    };
    internalRunner.activeRuns.set('project-a::spec-task', active);

    await expect(internalRunner.finish(active, 'succeeded')).resolves.toBeUndefined();

    expect(runtimeStore.update).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      expect.objectContaining({
        taskStatus: 'error',
        reviewReason: 'errors',
        executionPhase: 'failed',
        lastError: 'Verify startup gate failed',
      }),
    );
    expect(publishTaskStatus).toHaveBeenLastCalledWith(
      currentTask,
      currentProject,
      'error',
      'errors',
    );
    expect(publish).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      expect.objectContaining({
        type: 'error',
        code: 'automatic_verify_failed',
        message: expect.stringContaining('Verify startup gate failed'),
      }),
    );
  });
});

describe('OpenSpecActionRunner planning review finalization', () => {
  it('releases the Action lock and publishes a terminal state when review persistence fails', async () => {
    const currentTask = task();
    const currentProject = {
      id: 'project-a',
      path: 'C:\\project',
    } as Project;
    let runtime: Record<string, unknown> = {
      selectedChangeName: 'change-a',
      lastSuccessfulAction: null,
      workflowStage: 'planning',
    };
    const runtimeStore = {
      read: vi.fn(() => runtime),
      update: vi.fn((
        _task: Task,
        _project: Project,
        patch: Record<string, unknown>,
      ) => {
        runtime = { ...runtime, ...patch };
        return runtime;
      }),
      appendActionEvent: vi.fn(),
    };
    const publish = vi.fn();
    const publishTaskStatus = vi.fn();
    const onReconcile = vi.fn().mockResolvedValue(boardSnapshot({
      artifacts: boardSnapshot().artifacts.map((artifact) => ({
        ...artifact,
        status: 'done',
      })),
      availableActions: ['apply', 'update'],
    }));
    const planningReviews = {
      complete: vi.fn(() => {
        throw new Error('review disk failed');
      }),
      fail: vi.fn(() => {
        throw new Error('review summary failed');
      }),
      discard: vi.fn(),
    };
    const runner = new OpenSpecActionRunner(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runtimeStore as never,
      {} as never,
      publish,
      publishTaskStatus,
      onReconcile,
      {} as never,
      planningReviews as never,
    );
    const releaseLocks = vi.fn();
    const active = {
      task: currentTask,
      project: currentProject,
      summary: {
        runId: randomUUID(),
        action: 'update',
        state: 'running',
        startedAt: new Date().toISOString(),
      },
      controller: new AbortController(),
      releaseLocks,
      sequence: 0,
      outputEndsWithNewline: true,
      interactionCount: 0,
      cancelled: false,
      finished: false,
      automaticContinueDepth: 0,
      sessionOutcome: 'completed',
      finalAssistantText: 'Planning update complete.',
      planningReviewWritePaths: ['C:\\project\\openspec'],
    };
    const internalRunner = runner as unknown as {
      finish: (
        activeRun: unknown,
        outcome: 'succeeded' | 'failed' | 'cancelled',
      ) => Promise<void>;
    };

    await internalRunner.finish(active, 'succeeded');

    expect(releaseLocks).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      expect.objectContaining({
        type: 'error',
        code: 'planning_review_persistence_failed',
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      expect.objectContaining({
        type: 'run-state',
        run: expect.objectContaining({
          action: 'update',
          state: 'succeeded',
        }),
      }),
    );
  });

  it('never starts Apply automatically after a successful Update', async () => {
    const currentTask = task();
    const currentProject = {
      id: 'project-a',
      path: 'C:\\project',
    } as Project;
    const updateRunId = randomUUID();
    const runtimeStore = {
      read: vi.fn().mockReturnValue({
        selectedChangeName: 'change-a',
        lastSuccessfulAction: null,
        workflowStage: 'planning',
      }),
      update: vi.fn(),
      appendActionEvent: vi.fn(),
    };
    const planningReviews = {
      complete: vi.fn().mockReturnValue({
        runId: updateRunId,
        state: 'ready',
        createdAt: '2026-07-31T01:00:00.000Z',
        completedAt: '2026-07-31T01:01:00.000Z',
        changes: [],
      }),
      fail: vi.fn(),
      discard: vi.fn(),
    };
    const runner = new OpenSpecActionRunner(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runtimeStore as never,
      {} as never,
      vi.fn(),
      vi.fn(),
      vi.fn().mockResolvedValue(boardSnapshot({
        availableActions: ['apply', 'update'],
        taskProgress: { completed: 0, total: 2 },
      })),
      {} as never,
      planningReviews as never,
    );
    const runAction = vi.spyOn(runner, 'runAction')
      .mockResolvedValue({ runId: randomUUID() });
    const active = {
      task: currentTask,
      project: currentProject,
      summary: {
        runId: updateRunId,
        action: 'update',
        state: 'running',
        startedAt: new Date().toISOString(),
      },
      controller: new AbortController(),
      releaseLocks: vi.fn(),
      sequence: 0,
      outputEndsWithNewline: true,
      interactionCount: 0,
      cancelled: false,
      finished: false,
      automaticContinueDepth: 0,
      sessionOutcome: 'completed',
      finalAssistantText: 'Planning is complete. Please run `/opsx:continue`.',
      planningReviewWritePaths: ['C:\\project\\openspec'],
    };
    const internalRunner = runner as unknown as {
      finish: (
        activeRun: unknown,
        outcome: 'succeeded' | 'failed' | 'cancelled',
      ) => Promise<void>;
    };

    await internalRunner.finish(active, 'succeeded');

    expect(planningReviews.complete).toHaveBeenCalledOnce();
    expect(runAction).not.toHaveBeenCalled();
  });
});

describe('OpenSpecActionRunner automatic Continue orchestration', () => {
  it('finishes history, releases the lock, reconciles, then starts a distinct Continue run', async () => {
    const currentTask = task();
    const currentProject = {
      id: 'project-a',
      path: 'C:\\project',
    } as Project;
    const releaseLocks = vi.fn();
    const runtimeStore = {
      read: vi.fn().mockReturnValue({
        selectedChangeName: 'define-browser-match-three-product-scope',
        lastSuccessfulAction: null,
        workflowStage: 'planning',
      }),
      update: vi.fn(),
      appendActionEvent: vi.fn(),
    };
    const targetChangeName = 'build-browser-match-three-game';
    const targetSnapshot = boardSnapshot({
      changeName: targetChangeName,
    });
    const publish = vi.fn();
    const publishTaskStatus = vi.fn();
    let internalRunner: {
      activeRuns: Map<string, unknown>;
      finish: (
        active: unknown,
        outcome: 'succeeded' | 'failed' | 'cancelled',
        error?: string,
      ) => Promise<void>;
    };
    const onReconcile = vi.fn(async (
      _task: Task,
      _project: Project,
      options?: { selectedChangeName?: string },
    ) => {
      expect(releaseLocks).toHaveBeenCalledOnce();
      expect(internalRunner.activeRuns.has('project-a::spec-task')).toBe(true);
      expect(options).toEqual({
        selectedChangeName: targetChangeName,
      });
      return targetSnapshot;
    });
    const runner = new OpenSpecActionRunner(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runtimeStore as never,
      {
        listChanges: vi.fn().mockResolvedValue([
          {
            name: 'define-browser-match-three-product-scope',
            archived: false,
          },
          {
            name: targetChangeName,
            archived: false,
          },
        ]),
      } as never,
      publish,
      publishTaskStatus,
      onReconcile,
    );
    internalRunner = runner as unknown as typeof internalRunner;
    const runAction = vi.spyOn(runner, 'runAction').mockImplementation(
      async () => {
        expect(releaseLocks).toHaveBeenCalledOnce();
        expect(runtimeStore.appendActionEvent).toHaveBeenCalledOnce();
        expect(internalRunner.activeRuns.has('project-a::spec-task')).toBe(false);
        return { runId: 'automatic-continue-run' };
      },
    );
    const active = {
      task: currentTask,
      project: currentProject,
      summary: {
        runId: 'initial-new-run',
        action: 'new',
        state: 'running',
        startedAt: new Date().toISOString(),
      },
      controller: new AbortController(),
      releaseLocks,
      sequence: 2,
      outputEndsWithNewline: true,
      interactionCount: 0,
      cancelled: false,
      finished: false,
      automaticContinueDepth: 0,
      observedChangeName: targetChangeName,
      sessionOutcome: 'completed',
      finalAssistantText: [
        `变更 \`${targetChangeName}\` 已存在，因此未创建新变更。`,
        `现有变更位置：\`E:\\Work\\Test\\aitest\\openspec\\changes\\${targetChangeName}\``,
        '为避免覆盖现有内容，本次操作已安全停止。',
        '请运行 `/opsx:continue` 继续处理该变更。',
      ].join('\n'),
    };
    internalRunner.activeRuns.set('project-a::spec-task', active);

    await internalRunner.finish(active, 'succeeded');

    expect(onReconcile).toHaveBeenCalledOnce();
    expect(runAction).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      {
        taskId: currentTask.id,
        projectId: currentProject.id,
        action: 'continue',
        changeName: targetChangeName,
      },
      {
        automaticContinueDepth: 1,
      },
    );
    expect(runtimeStore.appendActionEvent).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      expect.objectContaining({
        runId: 'initial-new-run',
        action: 'new',
        state: 'succeeded',
      }),
    );
    expect(publishTaskStatus).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      'in_progress',
      undefined,
    );
    expect(publishTaskStatus).not.toHaveBeenCalledWith(
      currentTask,
      currentProject,
      'human_review',
      expect.anything(),
    );
  });

  it('reports an automatic Continue startup failure without rejecting finish', async () => {
    const currentTask = task();
    const currentProject = {
      id: 'project-a',
      path: 'C:\\project',
    } as Project;
    const publish = vi.fn();
    const runner = new OpenSpecActionRunner(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        read: vi.fn().mockReturnValue({
          selectedChangeName: 'change-a',
          lastSuccessfulAction: null,
        }),
        update: vi.fn(),
        appendActionEvent: vi.fn(),
      } as never,
      {} as never,
      publish,
      vi.fn(),
      vi.fn().mockResolvedValue(boardSnapshot()),
    );
    vi.spyOn(runner, 'runAction').mockRejectedValue(new Error('startup gate failed'));
    const internalRunner = runner as unknown as {
      activeRuns: Map<string, unknown>;
      finish: (
        active: unknown,
        outcome: 'succeeded' | 'failed' | 'cancelled',
      ) => Promise<void>;
    };
    const active = {
      task: currentTask,
      project: currentProject,
      summary: {
        runId: 'initial-new-run',
        action: 'new',
        state: 'running',
        startedAt: new Date().toISOString(),
      },
      controller: new AbortController(),
      releaseLocks: vi.fn(),
      sequence: 1,
      outputEndsWithNewline: true,
      interactionCount: 0,
      cancelled: false,
      finished: false,
      automaticContinueDepth: 0,
      sessionOutcome: 'completed',
      finalAssistantText: 'Please run `/opsx:continue` to continue.',
    };
    internalRunner.activeRuns.set('project-a::spec-task', active);

    await expect(internalRunner.finish(active, 'succeeded')).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      expect.objectContaining({
        type: 'error',
        code: 'automatic_continue_failed',
        message: expect.stringContaining('startup gate failed'),
      }),
    );
  });
});

describe('OpenSpecActionRunner root identity', () => {
  it('serializes the same registered Store across different project workspaces', async () => {
    const officialStoreRoot = 'D:\\OpenSpec\\shared-specs';
    const cli = {
      context: vi.fn().mockResolvedValue({
        root: {
          path: officialStoreRoot,
          source: 'store',
          store_id: 'shared-specs',
        },
      }),
    };
    const roots = {
      validateOfficialPlanningRoot: vi.fn(
        (_root: unknown, path: string) => path,
      ),
    };
    const baseRoot = {
      rootKind: 'store' as const,
      storeId: 'shared-specs',
      rootLabel: 'Store: shared-specs',
      worktree: false,
    };
    const firstIdentity = await __openSpecActionRunnerTestUtils.resolveActionRootIdentity(
      {
        ...baseRoot,
        cwd: 'C:\\projects\\one',
        workspaceRoot: 'C:\\projects\\one',
      },
      cli as never,
      roots as never,
    );
    const secondIdentity = await __openSpecActionRunnerTestUtils.resolveActionRootIdentity(
      {
        ...baseRoot,
        cwd: 'C:\\projects\\two',
        workspaceRoot: 'C:\\projects\\two',
      },
      cli as never,
      roots as never,
    );

    expect(firstIdentity).toEqual({
      lockRootKey: officialStoreRoot,
      planningRoot: officialStoreRoot,
    });
    expect(secondIdentity).toEqual(firstIdentity);

    const locks = new OpenSpecLockManager();
    const releaseFirst = await locks.acquireForAction({
      rootKey: firstIdentity.lockRootKey,
      changeName: 'shared-change',
      action: 'apply',
      owner: 'project-one-run',
    });
    let secondAcquired = false;
    const second = locks.acquireForAction({
      rootKey: secondIdentity.lockRootKey,
      changeName: 'shared-change',
      action: 'update',
      owner: 'project-two-run',
    }).then((release) => {
      secondAcquired = true;
      return release;
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });

  it('keeps worktree and main-workspace changes with the same name isolated', async () => {
    const cli = { context: vi.fn() };
    const roots = { validateOfficialPlanningRoot: vi.fn() };
    const mainIdentity = await __openSpecActionRunnerTestUtils.resolveActionRootIdentity(
      {
        cwd: 'C:\\project',
        workspaceRoot: 'C:\\project',
        rootKind: 'project',
        rootLabel: 'project',
        worktree: false,
      },
      cli as never,
      roots as never,
    );
    const worktreeIdentity = await __openSpecActionRunnerTestUtils.resolveActionRootIdentity(
      {
        cwd: 'C:\\project\\.autocode\\worktrees\\spec-task',
        workspaceRoot: 'C:\\project\\.autocode\\worktrees\\spec-task',
        rootKind: 'project',
        rootLabel: 'spec-task',
        worktree: true,
      },
      cli as never,
      roots as never,
    );

    expect(mainIdentity.lockRootKey).not.toBe(worktreeIdentity.lockRootKey);
    expect(cli.context).not.toHaveBeenCalled();

    const locks = new OpenSpecLockManager();
    const releaseMain = await locks.acquireForAction({
      rootKey: mainIdentity.lockRootKey,
      changeName: 'same-change',
      action: 'apply',
      owner: 'main-run',
    });
    const releaseWorktree = await locks.acquireForAction({
      rootKey: worktreeIdentity.lockRootKey,
      changeName: 'same-change',
      action: 'apply',
      owner: 'worktree-run',
    });
    expect(locks.getOwner(`root:${mainIdentity.lockRootKey}`)).toBe('main-run');
    expect(locks.getOwner(`root:${worktreeIdentity.lockRootKey}`)).toBe('worktree-run');
    releaseWorktree();
    releaseMain();
  });

  it('fails closed when a registered Store has no official context root', async () => {
    const cli = {
      context: vi.fn().mockResolvedValue({ root: null }),
    };
    await expect(__openSpecActionRunnerTestUtils.resolveActionRootIdentity(
      {
        cwd: 'C:\\project',
        workspaceRoot: 'C:\\project',
        rootKind: 'store',
        storeId: 'shared-specs',
        rootLabel: 'Store: shared-specs',
        worktree: false,
      },
      cli as never,
      { validateOfficialPlanningRoot: vi.fn() } as never,
    )).rejects.toThrow(/did not resolve an official planning root/);
  });
});

describe('OpenSpecActionRunner interrupted recovery', () => {
  it('restarts the same saved Action and re-requires destructive confirmation', async () => {
    const runId = randomUUID();
    const runtimeStore = {
      read: vi.fn().mockReturnValue({
        state: 'interrupted',
        activeRunId: runId,
        recoveryInput: {
          action: 'archive',
          changeName: 'change-a',
          arguments: 'archive this change',
        },
      }),
    };
    const runner = new OpenSpecActionRunner(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runtimeStore as never,
      {} as never,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    const runAction = vi.spyOn(runner, 'runAction').mockResolvedValue({
      runId: randomUUID(),
    });
    const currentTask = task();
    const currentProject = {
      id: 'project-a',
      path: 'C:\\project',
    } as Project;

    await expect(runner.resumeAction(currentTask, currentProject, {
      taskId: currentTask.id,
      projectId: currentProject.id,
      runId,
    })).rejects.toThrow(/explicit confirmation to resume/);
    expect(runAction).not.toHaveBeenCalled();

    await runner.resumeAction(currentTask, currentProject, {
      taskId: currentTask.id,
      projectId: currentProject.id,
      runId,
      confirmed: true,
    });
    expect(runAction).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      {
        taskId: currentTask.id,
        projectId: currentProject.id,
        action: 'archive',
        changeName: 'change-a',
        arguments: 'archive this change',
        confirmed: true,
      },
      { resumeRunId: runId },
    );
  });
});
