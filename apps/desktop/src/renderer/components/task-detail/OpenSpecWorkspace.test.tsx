// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  OpenSpecActionRunSummary,
  OpenSpecBoardSnapshot,
  OpenSpecPlanningReview,
  OpenSpecPlanningReviewSummary,
  Task,
} from '../../../shared/types';
import { OpenSpecWorkspace } from './OpenSpecWorkspace';
import {
  type OpenSpecConsoleLine,
  useOpenSpecWorkspace,
} from './hooks/useOpenSpecWorkspace';

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => {
    const translations: Record<string, string> = {
      'openSpec.actions.archive': 'Archive',
      'openSpec.artifact.openAria': 'Open {{id}} artifact',
      'openSpec.artifact.requiredBeforeImplementation': 'Required before implementation',
      'openSpec.artifact.status.inProgress': 'In progress',
      'openSpec.artifact.status.complete': 'Complete',
      'openSpec.artifact.status.ready': 'Ready',
      'openSpec.artifact.status.waiting': 'Waiting',
      'openSpec.artifact.status.unsupported': 'Unsupported',
      'openSpec.automatic.continuePlanning.label': 'Continue planning',
      'openSpec.automatic.startImplementation.label': 'Start implementation',
      'openSpec.automatic.inspectUnsupported.label': 'Inspect workflow',
      'openSpec.automatic.inspectWorkflow.label': 'Inspect workflow',
      'openSpec.automatic.retry.label': 'Retry workflow',
      'openSpec.automatic.archiveVerified.label': 'Archive verified change',
      'openSpec.automatic.followUpIteration.label': 'Create follow-up iteration',
      'openSpec.automatic.followUpIteration.defaultGuidance':
        'Create a follow-up after {{change}}: {{description}}',
      'openSpec.planIteration.refine': 'Refine plan',
      'openSpec.planIteration.afterVerify': 'Continue iterating',
      'openSpec.planIteration.dialog.titleRefine': 'Refine the current plan',
      'openSpec.planIteration.dialog.titleContinue': 'Plan the next iteration',
      'openSpec.planIteration.dialog.descriptionRefine':
        'AI updates planning artifacts without starting implementation.',
      'openSpec.planIteration.dialog.descriptionContinue':
        'AI returns to planning without starting implementation.',
      'openSpec.planIteration.dialog.label': 'Iteration requirements',
      'openSpec.planIteration.dialog.placeholder': 'Describe the requested changes…',
      'openSpec.planIteration.dialog.submit': 'Start planning iteration',
      'openSpec.planIteration.review.title': 'Planning changes',
      'openSpec.planIteration.review.description':
        '{{count}} planning documents changed.',
      'openSpec.planIteration.review.loading': 'Collecting planning changes…',
      'openSpec.planIteration.review.noChanges': 'No planning documents changed.',
      'openSpec.planIteration.review.loadFailed': 'Planning changes failed to load.',
      'openSpec.planIteration.review.captureFailed':
        'Planning changes could not be captured.',
      'openSpec.planIteration.review.retryLoad': 'Reload change list',
      'openSpec.planIteration.review.retry': 'Retry change capture',
      'openSpec.planIteration.review.retrying': 'Retrying change capture…',
      'openSpec.planIteration.review.acknowledge': 'I reviewed all changes',
      'openSpec.planIteration.review.acknowledging': 'Saving review…',
      'openSpec.planIteration.review.openDiff': 'View changes to {{path}}',
      'openSpec.planIteration.review.diffTitle': 'Planning file changes',
      'openSpec.planIteration.review.diffDescription': '{{kind}} · {{path}}',
      'openSpec.planIteration.review.kind.created': 'Created',
      'openSpec.planIteration.review.kind.modified': 'Modified',
      'openSpec.planIteration.review.kind.deleted': 'Deleted',
      'openSpec.phase.planning': 'Planning',
      'openSpec.phase.implementation': 'Implementation',
      'openSpec.phase.verification': 'Verification',
      'openSpec.phase.archive': 'Archive',
      'openSpec.timing.title': 'Cumulative AI time',
      'openSpec.timing.scope': 'This task',
      'openSpec.timing.active': 'Timing in progress',
      'openSpec.header.selectChangeAria': 'Select OpenSpec change',
      'openSpec.board.progress': '{{completed}} of {{total}} stages complete',
      'openSpec.board.archivedNext':
        'The selected change is archived. Select an active change, or create a new change or proposal.',
      'openSpec.board.initializeNext':
        'Initialize OpenSpec to create the workflow.',
      'openSpec.board.selectChangeNext':
        'Select an active change, or create a new change or proposal.',
      'openSpec.guidance.add': 'Add optional guidance for the next run',
      'openSpec.guidance.aria': 'AI workflow guidance',
      'openSpec.preview.externalLinkBlocked':
        'External link blocked in OpenSpec preview: {{href}}',
      'openSpec.preview.remoteImageBlocked': 'Remote image blocked{{alt}}',
      'openSpec.preview.tabs.source': 'Source',
      'openSpec.preview.tabs.diff': 'Diff',
      'openSpec.preview.tabs.context': 'Context',
      'openSpec.preview.dependencies': 'Dependencies',
      'openSpec.activity.title': 'AI activity',
      'openSpec.console.earlierOutputTruncated': 'Earlier output truncated',
      'openSpec.history.title': 'History',
      'openSpec.toolbar.moreAria': 'More OpenSpec options',
      'openSpec.notice.affectedAreaSelection':
        'The official status requires affected-area selection.',
      'openSpec.notice.selectionExpired':
        'The selected OpenSpec change no longer exists.',
      'openSpec.dialogs.confirm.title': 'Confirm {{action}}',
      'openSpec.dialogs.confirm.run': 'Run official {{action}}',
      'common:buttons.close': 'Close',
    };
    return {
      t: (key: string, options?: Record<string, unknown>) => {
        const normalizedKey = key.replace(/^tasks:/, '');
        let value = translations[normalizedKey] ?? key;
        for (const [name, replacement] of Object.entries(options ?? {})) {
          value = value.replace(`{{${name}}}`, String(replacement));
        }
        return value;
      },
      i18n: {
        language: 'en',
      },
    };
  },
}));

vi.mock('./hooks/useOpenSpecWorkspace', () => ({
  useOpenSpecWorkspace: vi.fn(),
}));

function task(): Task {
  return {
    id: 'task-a',
    specId: 'task-a',
    projectId: 'project-a',
    title: 'OpenSpec task',
    description: 'Implement a custom workflow.',
    status: 'in_progress',
    subtasks: [],
    logs: [],
    metadata: {
      developmentMode: 'spec',
      openSpec: {
        formatVersion: 1,
        rootKind: 'store',
        storeId: 'shared-specs',
        schemaName: 'custom-schema',
        changeName: 'change-a',
      },
    },
    createdAt: new Date('2026-07-28T00:00:00.000Z'),
    updatedAt: new Date('2026-07-28T00:00:00.000Z'),
  };
}

function snapshot(
  overrides: Partial<OpenSpecBoardSnapshot> = {},
): OpenSpecBoardSnapshot {
  return {
    taskId: 'task-a',
    openSpecVersion: '1.6.0',
    rootKind: 'store',
    rootLabel: 'Store: shared-specs',
    initialized: true,
    changeName: 'change-a',
    schema: {
      name: 'custom-schema',
      description: 'A dynamic custom Schema.',
    },
    artifacts: [
      {
        id: 'brief',
        description: 'Change brief',
        outputPath: 'brief.md',
        status: 'done',
        missingDeps: [],
        existingOutputPaths: ['brief.md'],
        dependencies: [],
        unlocks: ['review'],
        instruction: 'Write the brief.',
        template: '# Brief',
        inProgress: false,
        blocksApply: false,
      },
      {
        id: 'review',
        description: 'Architecture review',
        outputPath: 'review.md',
        status: 'ready',
        missingDeps: [],
        existingOutputPaths: [],
        dependencies: ['brief'],
        unlocks: ['delivery'],
        instruction: 'Review the architecture.',
        inProgress: false,
        blocksApply: true,
      },
      {
        id: 'delivery',
        outputPath: 'delivery.md',
        status: 'blocked',
        missingDeps: ['review'],
        existingOutputPaths: [],
        dependencies: ['review'],
        unlocks: [],
        inProgress: false,
        blocksApply: true,
      },
      {
        id: 'future',
        outputPath: 'future.md',
        status: 'unknown',
        missingDeps: [],
        existingOutputPaths: [],
        dependencies: [],
        unlocks: [],
        inProgress: false,
        blocksApply: false,
      },
    ],
    applyRequires: ['review', 'delivery'],
    actionContext: {
      planningHome: {
        kind: 'store',
        root: 'D:\\registered-store',
        changesDir: 'D:\\registered-store\\openspec\\changes',
        defaultSchema: 'custom-schema',
      },
      mode: 'repo-local',
      sourceOfTruth: 'store',
      linkedContext: ['docs/architecture.md'],
      allowedEditRoots: ['D:\\registered-store'],
      requiresAffectedAreaSelection: false,
      constraints: ['Only the registered Store root may be edited.'],
    },
    activeRun: null,
    validation: null,
    nextSteps: ['Create review'],
    availableActions: [
      'explore',
      'continue',
      'update',
      'verify',
      'archive',
      'bulk-archive',
    ],
    unsupportedStatus: false,
    archived: false,
    revision: 7,
    ...overrides,
  };
}

function workspaceMock(currentSnapshot = snapshot()) {
  const selectedArtifact = currentSnapshot.artifacts[0] ?? null;
  return {
    snapshot: currentSnapshot,
    changes: [
      {
        name: 'change-a',
        completedTasks: 1,
        totalTasks: 2,
        status: 'active',
      },
      {
        name: 'change-b',
        completedTasks: 2,
        totalTasks: 2,
        status: 'complete',
      },
      {
        name: '2026-07-28-old-change',
        completedTasks: 1,
        totalTasks: 1,
        status: 'archived',
        archived: true,
      },
    ],
    changesLoaded: true,
    selectedChangeStale: false,
    selectedChangeReady: true,
    selectedArtifact,
    selectedArtifactId: selectedArtifact?.id ?? null,
    selectedRelativePath: selectedArtifact?.existingOutputPaths[0] ?? null,
    artifactContent: selectedArtifact ? {
      artifactId: selectedArtifact.id,
      relativePath: 'brief.md',
      content: [
        '# Safe brief',
        '',
        '[Blocked link](https://example.invalid)',
        '',
        '<script>window.hacked = true</script>',
        '',
        '![Remote](https://example.invalid/image.png)',
      ].join('\n'),
      modifiedAt: '2026-07-28T00:00:00.000Z',
    } : null,
    artifactDiff: selectedArtifact ? {
      artifactId: selectedArtifact.id,
      relativePath: 'brief.md',
      patch: 'diff --git a/brief.md b/brief.md\n+# Safe brief',
      base: 'git' as const,
    } : null,
    interaction: null,
    consoleLines: [] as OpenSpecConsoleLine[],
    runHistory: [{
      runId: 'run-archive',
      action: 'archive' as const,
      state: 'succeeded' as const,
      startedAt: '2026-07-28T00:00:00.000Z',
    }] as OpenSpecActionRunSummary[],
    planningReviewSummary: null as OpenSpecPlanningReviewSummary | null,
    planningReview: null as OpenSpecPlanningReview | null,
    planningReviewLoading: false,
    planningReviewLoadError: null,
    validation: null,
    loading: false,
    artifactLoading: false,
    actionPending: null,
    error: null,
    setError: vi.fn(),
    setSelectedArtifactId: vi.fn(),
    setSelectedRelativePath: vi.fn(),
    refresh: vi.fn().mockResolvedValue(currentSnapshot),
    refreshHistory: vi.fn(),
    runAction: vi.fn().mockResolvedValue({ runId: 'run-new' }),
    cancelAction: vi.fn(),
    resumeAction: vi.fn(),
    loadRunLog: vi.fn(),
    answerInteraction: vi.fn(),
    runValidation: vi.fn().mockResolvedValue({
      valid: true,
      checkedAt: '2026-07-28T00:00:00.000Z',
      issues: [],
    }),
    selectChange: vi.fn(),
    acknowledgePlanningReview: vi.fn().mockResolvedValue(null),
    retryPlanningReview: vi.fn(),
    reloadPlanningReview: vi.fn(),
  };
}

describe('OpenSpecWorkspace', () => {
  beforeEach(() => {
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      workspaceMock() as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );
  });

  it('renders a compact workflow navigator, one automatic action, and safe previews', async () => {
    const current = workspaceMock();
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );
    const { container } = render(<OpenSpecWorkspace task={task()} />);

    expect(screen.getByTestId('openspec-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('openspec-workflow-stages'))
      .toHaveTextContent('brief');
    expect(screen.getByTestId('openspec-workflow-stages'))
      .toHaveTextContent('review');
    expect(screen.getByTestId('openspec-workflow-stages'))
      .toHaveTextContent('delivery');
    expect(screen.getByTestId('openspec-workflow-stages'))
      .toHaveTextContent('future');
    expect(screen.getByRole('button', { name: 'Open brief artifact' }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Select OpenSpec change')).toBeInTheDocument();
    expect(screen.getByTestId('openspec-auto-action'))
      .toHaveTextContent('Continue planning');
    expect(screen.queryByTestId('openspec-action-continue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('openspec-action-apply')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('openspec-auto-action'));
    await waitFor(() => expect(current.runAction).toHaveBeenCalledWith(
      'continue',
      { arguments: undefined },
    ));

    fireEvent.click(screen.getByRole('button', {
      name: 'Add optional guidance for the next run',
    }));
    expect(screen.getByLabelText('AI workflow guidance')).toBeInTheDocument();

    expect(screen.getByTestId('openspec-preview-rendered'))
      .toHaveTextContent('Safe brief');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href="https://example.invalid"]')).toBeNull();
    expect(screen.getByText('Blocked link')).toHaveAttribute(
      'title',
      'External link blocked in OpenSpec preview: https://example.invalid',
    );
    expect(screen.getByText('Remote image blocked: Remote')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Source' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByTestId('openspec-preview-source'))
      .toHaveTextContent('<script>window.hacked = true</script>');

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Diff' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByTestId('openspec-preview-diff'))
      .toHaveTextContent('diff --git a/brief.md b/brief.md');

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Context' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByTestId('openspec-preview-dependencies'))
      .toHaveTextContent('review');
    expect(screen.getByTestId('openspec-action-context'))
      .toHaveTextContent('D:\\registered-store');
    expect(screen.getByTestId('openspec-action-context'))
      .toHaveTextContent('docs/architecture.md');
    expect(screen.getByTestId('openspec-action-context'))
      .toHaveTextContent('Only the registered Store root may be edited.');
  });

  it('hides artifacts and Actions when the selected change directory no longer exists', () => {
    const staleSnapshot = snapshot({
      changeName: 'build-browser-match-3-game',
    });
    const current = workspaceMock(staleSnapshot);
    current.changes = [{
      name: 'build-browser-match-three-game',
      completedTasks: 0,
      totalTasks: 4,
      status: 'active',
    }];
    current.selectedChangeStale = true;
    current.selectedChangeReady = false;
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );

    render(<OpenSpecWorkspace task={task()} />);

    expect(screen.getByTestId('openspec-stale-change-notice'))
      .toHaveTextContent('The selected OpenSpec change no longer exists.');
    expect(screen.queryByTestId('openspec-artifact-brief')).not.toBeInTheDocument();
    expect(screen.getByTestId('openspec-auto-action')).toBeDisabled();
    expect(current.setSelectedArtifactId).not.toHaveBeenCalled();
  });

  it.each([
    ['proposal', 'proposal.md', 'border-blue-500/60'],
    ['specs', 'specs/**/*.md', 'border-violet-500/60'],
    ['design', 'design.md', 'border-cyan-500/60'],
    ['tasks', 'tasks.md', 'border-emerald-500/60'],
  ] as const)(
    'uses artifact-aware Markdown hierarchy for %s',
    (artifactId, outputPath, headingClass) => {
      const relativePath = outputPath.replace('**/*.md', 'feature/spec.md');
      const artifactSnapshot = snapshot({
        artifacts: [{
          id: artifactId,
          description: `${artifactId} document`,
          outputPath,
          status: 'done',
          missingDeps: [],
          existingOutputPaths: [relativePath],
          dependencies: [],
          unlocks: [],
          inProgress: false,
          blocksApply: false,
        }],
      });
      const current = workspaceMock(artifactSnapshot);
      current.artifactContent = {
        artifactId,
        relativePath,
        content: [
          `# ${artifactId}`,
          '',
          '## Overview',
          '',
          '> Important context',
          '',
          '| Field | Value |',
          '| --- | --- |',
          '| State | Ready |',
        ].join('\n'),
        modifiedAt: '2026-07-31T00:00:00.000Z',
      };
      vi.mocked(useOpenSpecWorkspace).mockReturnValue(
        current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
      );

      render(<OpenSpecWorkspace task={task()} />);

      const preview = screen.getByTestId('openspec-preview-rendered');
      expect(preview).toHaveAttribute('data-artifact-kind', artifactId);
      expect(screen.getByRole('heading', { level: 1 }))
        .toHaveClass(headingClass);
      expect(preview.querySelector('blockquote')).toHaveClass('rounded-r-lg');
      expect(preview.querySelector('table')?.parentElement)
        .toHaveClass('rounded-lg');
    },
  );

  it('renders completed tasks with a green, persistent completion treatment', () => {
    const tasksSnapshot = snapshot({
      artifacts: [{
        id: 'tasks',
        description: 'Implementation tasks',
        outputPath: 'tasks.md',
        status: 'done',
        missingDeps: [],
        existingOutputPaths: ['tasks.md'],
        dependencies: [],
        unlocks: [],
        inProgress: false,
        blocksApply: false,
      }],
    });
    const current = workspaceMock(tasksSnapshot);
    current.artifactContent = {
      artifactId: 'tasks',
      relativePath: 'tasks.md',
      content: [
        '# Tasks',
        '',
        '- [x] Completed workflow task',
        '- [ ] Pending workflow task',
      ].join('\n'),
      modifiedAt: '2026-07-31T00:00:00.000Z',
    };
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );

    render(<OpenSpecWorkspace task={task()} />);

    const completed = screen.getByRole('checkbox', { checked: true });
    expect(completed).toBeDisabled();
    expect(completed).toHaveClass('accent-emerald-600');
    expect(completed.closest('li'))
      .toHaveClass('has-[input:checked]:bg-emerald-500/10');
    expect(screen.getByText('Completed workflow task')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { checked: false })).toBeDisabled();
  });

  it('shows all four planning documents as active while Update is revising them', () => {
    const artifactIds = ['proposal', 'specs', 'design', 'tasks'] as const;
    const currentSnapshot = snapshot({
      schema: {
        name: 'spec-driven',
        description: 'Default four-stage planning workflow.',
      },
      artifacts: artifactIds.map((id) => ({
        id,
        outputPath: id === 'specs' ? 'specs/**/*.md' : `${id}.md`,
        status: 'ready' as const,
        missingDeps: [],
        existingOutputPaths: [id === 'specs' ? 'specs/example/spec.md' : `${id}.md`],
        dependencies: [],
        unlocks: [],
        inProgress: true,
        blocksApply: id === 'tasks',
      })),
      activeRun: {
        runId: 'run-update',
        action: 'update',
        state: 'running',
        startedAt: '2026-07-31T12:00:00.000Z',
      },
      applyRequires: ['tasks'],
      availableActions: ['update', 'apply', 'verify', 'archive'],
    });
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      workspaceMock(currentSnapshot) as unknown as ReturnType<
        typeof useOpenSpecWorkspace
      >,
    );

    render(<OpenSpecWorkspace task={task()} />);

    for (const id of artifactIds) {
      expect(screen.getByTestId(`openspec-artifact-${id}`))
        .toHaveTextContent('In progress');
      expect(screen.getByTestId(`openspec-artifact-${id}`))
        .not.toHaveTextContent('Complete');
    }
    expect(screen.getByTestId('openspec-workflow-stages'))
      .toHaveTextContent('0 of 4 stages complete');
  });

  it('shows persisted cumulative time for every Spec workflow stage', () => {
    const current = workspaceMock();
    current.runHistory = [
      {
        runId: 'run-plan',
        action: 'continue',
        state: 'succeeded',
        startedAt: '2026-07-31T00:00:00.000Z',
        durationMs: 65_000,
      },
      {
        runId: 'run-apply',
        action: 'apply',
        state: 'failed',
        startedAt: '2026-07-31T00:02:00.000Z',
        durationMs: 5_000,
      },
      {
        runId: 'run-verify',
        action: 'verify',
        state: 'succeeded',
        startedAt: '2026-07-31T00:03:00.000Z',
        durationMs: 2_000,
      },
    ];
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );

    render(<OpenSpecWorkspace task={task()} />);

    expect(screen.getByTestId('openspec-stage-timings'))
      .toHaveTextContent('Cumulative AI time');
    expect(screen.getByTestId('openspec-stage-timing-planning'))
      .toHaveTextContent('Planning01:05');
    expect(screen.getByTestId('openspec-stage-timing-implementation'))
      .toHaveTextContent('Implementation00:05');
    expect(screen.getByTestId('openspec-stage-timing-verification'))
      .toHaveTextContent('Verification00:02');
    expect(screen.getByTestId('openspec-stage-timing-archive'))
      .toHaveTextContent('Archive—');
  });

  it('renders the ADR Schema graph and exposes the change-local ADR artifact', () => {
    const adrSnapshot = snapshot({
      schema: {
        name: 'spec-driven-with-adr',
        description: 'Spec-driven workflow with durable ADR review.',
      },
      artifacts: [
        {
          id: 'proposal',
          outputPath: 'proposal.md',
          status: 'done',
          missingDeps: [],
          existingOutputPaths: ['proposal.md'],
          dependencies: [],
          unlocks: ['specs', 'design'],
          inProgress: false,
          blocksApply: false,
        },
        {
          id: 'specs',
          outputPath: 'specs/**/*.md',
          status: 'ready',
          missingDeps: [],
          existingOutputPaths: [],
          dependencies: ['proposal'],
          unlocks: ['tasks'],
          inProgress: false,
          blocksApply: false,
        },
        {
          id: 'design',
          outputPath: 'design.md',
          status: 'ready',
          missingDeps: [],
          existingOutputPaths: [],
          dependencies: ['proposal'],
          unlocks: ['adr'],
          inProgress: false,
          blocksApply: false,
        },
        {
          id: 'adr',
          description: 'Change-local ADR review manifest',
          outputPath: 'adr.md',
          status: 'blocked',
          missingDeps: ['design'],
          existingOutputPaths: [],
          dependencies: ['design'],
          unlocks: ['tasks'],
          inProgress: false,
          blocksApply: false,
        },
        {
          id: 'tasks',
          outputPath: 'tasks.md',
          status: 'blocked',
          missingDeps: ['specs', 'adr'],
          existingOutputPaths: [],
          dependencies: ['specs', 'adr'],
          unlocks: [],
          inProgress: false,
          blocksApply: true,
        },
      ],
      applyRequires: ['tasks'],
      nextSteps: ['Create specs', 'Create design'],
    });
    const current = workspaceMock(adrSnapshot);
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );

    render(<OpenSpecWorkspace task={task()} />);

    expect(screen.getByTestId('openspec-workflow-stages'))
      .toHaveTextContent('spec-driven-with-adr');
    expect(screen.getByTestId('openspec-artifact-adr'))
      .toHaveTextContent('Change-local ADR review manifest');
    expect(screen.getByTestId('openspec-artifact-adr'))
      .toHaveTextContent('Waiting');
    fireEvent.click(screen.getByRole('button', { name: 'Open adr artifact' }));
    expect(current.setSelectedArtifactId).toHaveBeenCalledWith('adr');
  });

  it('requires confirmation and official validation before Archive', async () => {
    const current = workspaceMock();
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );
    render(<OpenSpecWorkspace task={task()} />);

    fireEvent.pointerDown(screen.getByRole('button', {
      name: 'More OpenSpec options',
    }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByTestId('openspec-action-archive'));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'Confirm Archive',
    );
    expect(current.runValidation).toHaveBeenCalledOnce();
    expect(current.runAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', {
      name: 'Run official Archive',
    }));
    await waitFor(() => expect(current.runAction).toHaveBeenCalledWith(
      'archive',
      {
        arguments: undefined,
        selectedChanges: undefined,
        confirmed: true,
      },
    ));
  });

  it('keeps planning iteration separate from explicit implementation', async () => {
    const planningComplete = snapshot({
      artifacts: snapshot().artifacts.map((artifact) => ({
        ...artifact,
        status: 'done' as const,
      })),
      applyRequires: ['review', 'delivery'],
      taskProgress: { completed: 0, total: 3 },
      availableActions: ['update', 'sync', 'apply', 'verify', 'archive'],
    });
    const current = workspaceMock(planningComplete);
    current.runHistory = [];
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );
    const { rerender } = render(<OpenSpecWorkspace task={task()} />);

    expect(screen.getByTestId('openspec-refine-plan')).toHaveTextContent('Refine plan');
    expect(screen.getByTestId('openspec-auto-action')).toHaveTextContent(
      'Start implementation',
    );

    fireEvent.click(screen.getByTestId('openspec-refine-plan'));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Refine the current plan',
    );
    expect(current.runAction).not.toHaveBeenCalled();
    expect(screen.getByTestId('openspec-submit-plan-iteration')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Iteration requirements'), {
      target: {
        value: 'Add offline support and update the acceptance scenarios.',
      },
    });
    fireEvent.click(screen.getByTestId('openspec-submit-plan-iteration'));
    await waitFor(() => expect(current.runAction).toHaveBeenCalledWith(
      'update',
      {
        arguments:
          'Add offline support and update the acceptance scenarios.',
      },
    ));

    current.planningReviewSummary = {
      runId: 'run-new',
      state: 'ready',
      createdAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:05.000Z',
      changeCount: 3,
    };
    current.planningReview = {
      runId: 'run-new',
      state: 'ready',
      createdAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:05.000Z',
      changes: [
        {
          relativePath: 'adr/0001-offline.md',
          kind: 'created',
          patch: '--- a/adr/0001-offline.md\n+++ b/adr/0001-offline.md\n+# Offline\n+- [ ] Add offline support',
        },
        {
          relativePath: 'openspec/changes/change-a/design.md',
          kind: 'deleted',
          patch: '--- a/openspec/changes/change-a/design.md\n+++ b/openspec/changes/change-a/design.md\n-Old design',
        },
        {
          relativePath: 'openspec/changes/change-a/proposal.md',
          kind: 'modified',
          patch: '--- a/openspec/changes/change-a/proposal.md\n+++ b/openspec/changes/change-a/proposal.md\n-Old scope\n+New offline scope',
        },
      ],
    };
    rerender(<OpenSpecWorkspace task={task()} />);

    expect(await screen.findByText('Planning changes')).toBeInTheDocument();
    const review = await screen.findByTestId('openspec-planning-review');
    expect(review).toHaveTextContent('Created');
    expect(review).toHaveTextContent('Modified');
    expect(review).toHaveTextContent('Deleted');
    expect(review).toHaveTextContent('adr/0001-offline.md');
    expect(review).toHaveTextContent('openspec/changes/change-a/design.md');
    expect(review).toHaveTextContent('openspec/changes/change-a/proposal.md');
    const createdFile = screen.getByRole('button', {
      name: 'View changes to adr/0001-offline.md',
    });
    const deletedFile = screen.getByRole('button', {
      name: 'View changes to openspec/changes/change-a/design.md',
    });
    const modifiedFile = screen.getByRole('button', {
      name: 'View changes to openspec/changes/change-a/proposal.md',
    });
    expect(createdFile).toHaveClass('border-emerald-500/35');
    expect(modifiedFile).toHaveClass('border-sky-500/35');
    expect(deletedFile).toHaveClass('border-rose-500/35');

    fireEvent.click(modifiedFile);
    const diffDialog = await screen.findByTestId(
      'openspec-planning-review-diff-dialog',
    );
    expect(diffDialog).toHaveAttribute('data-change-kind', 'modified');
    expect(diffDialog).toHaveTextContent(
      'openspec/changes/change-a/proposal.md',
    );
    expect(screen.getByTestId('openspec-planning-review-diff'))
      .toHaveTextContent('-Old scope');
    expect(screen.getByText('-Old scope')).toHaveClass('text-rose-300');
    expect(screen.getByText('+New offline scope'))
      .toHaveClass('text-emerald-300');
    fireEvent.click(screen.getByTestId('openspec-planning-review-diff-close'));
    expect(screen.queryByTestId('openspec-planning-review-diff-dialog'))
      .not.toBeInTheDocument();

    expect(current.runAction.mock.calls.map(([action]) => action))
      .toEqual(['update']);

    fireEvent.keyDown(screen.getByRole('dialog'), {
      key: 'Escape',
      code: 'Escape',
    });
    expect(current.acknowledgePlanningReview).not.toHaveBeenCalled();
    expect(screen.getByTestId('openspec-planning-review')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {
      name: 'I reviewed all changes',
    }));
    await waitFor(() =>
      expect(current.acknowledgePlanningReview).toHaveBeenCalledOnce());
  });

  it('promotes confirmed Archive after successful Verify', async () => {
    const verified = snapshot({
      artifacts: snapshot().artifacts.map((artifact) => ({
        ...artifact,
        status: 'done' as const,
      })),
      taskProgress: { completed: 3, total: 3 },
      workflowStage: 'verified',
      availableActions: ['update', 'verify', 'archive'],
    });
    const current = workspaceMock(verified);
    current.runHistory = [{
      runId: 'run-verify',
      action: 'verify',
      state: 'succeeded',
      startedAt: '2026-07-28T00:00:00.000Z',
    }];
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );
    render(<OpenSpecWorkspace task={task()} />);

    expect(screen.getByTestId('openspec-auto-action'))
      .toHaveTextContent('Archive verified change');
    expect(screen.getByTestId('openspec-refine-plan'))
      .toHaveTextContent('Continue iterating');

    fireEvent.click(screen.getByTestId('openspec-auto-action'));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'Confirm Archive',
    );
    expect(current.runAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', {
      name: 'Run official Archive',
    }));
    await waitFor(() => expect(current.runAction).toHaveBeenCalledWith(
      'archive',
      {
        arguments: undefined,
        selectedChanges: undefined,
        confirmed: true,
      },
    ));
  });

  it('asks for requirements before continuing a verified change', async () => {
    const verified = snapshot({
      artifacts: snapshot().artifacts.map((artifact) => ({
        ...artifact,
        status: 'done' as const,
      })),
      taskProgress: { completed: 3, total: 3 },
      workflowStage: 'verified',
      availableActions: ['update', 'verify', 'archive'],
    });
    const current = workspaceMock(verified);
    current.runHistory = [{
      runId: 'run-verify',
      action: 'verify',
      state: 'succeeded',
      startedAt: '2026-07-28T00:00:00.000Z',
    }];
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );
    const { rerender } = render(<OpenSpecWorkspace task={task()} />);

    fireEvent.click(screen.getByTestId('openspec-refine-plan'));

    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Plan the next iteration',
    );
    expect(current.runAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Iteration requirements'), {
      target: {
        value: 'Add controller support to the verified change.',
      },
    });
    fireEvent.click(screen.getByTestId('openspec-submit-plan-iteration'));

    await waitFor(() => expect(current.runAction).toHaveBeenCalledWith(
      'update',
      {
        arguments: 'Add controller support to the verified change.',
      },
    ));

    current.planningReviewSummary = {
      runId: 'run-new',
      state: 'ready',
      createdAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:05.000Z',
      changeCount: 1,
    };
    current.planningReview = {
      runId: 'run-new',
      state: 'ready',
      createdAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:05.000Z',
      changes: [{
        relativePath: 'openspec/changes/change-a/proposal.md',
        kind: 'modified',
        patch: '-Controller support is not planned.\n+Controller support is planned.',
      }],
    };
    rerender(<OpenSpecWorkspace task={task()} />);

    const review = await screen.findByTestId('openspec-planning-review');
    expect(review).toHaveTextContent('proposal.md');
    fireEvent.click(screen.getByRole('button', {
      name: 'View changes to openspec/changes/change-a/proposal.md',
    }));
    expect(await screen.findByTestId('openspec-planning-review-diff'))
      .toHaveTextContent('-Controller support is not planned.');
    expect(screen.getByTestId('openspec-planning-review-diff'))
      .toHaveTextContent('+Controller support is planned.');
    expect(current.runAction.mock.calls.map(([action]) => action))
      .toEqual(['update']);
  });

  it('creates a new incremental Change from an archived workflow', async () => {
    const archived = snapshot({
      artifacts: [],
      applyRequires: [],
      taskProgress: undefined,
      archived: true,
      availableActions: ['new', 'propose', 'explore'],
      nextSteps: ['Run /opsx:new to continue from the archived baseline.'],
    });
    const current = workspaceMock(archived);
    current.runHistory = [{
      runId: 'run-archive',
      action: 'archive',
      state: 'succeeded',
      startedAt: '2026-07-28T00:00:00.000Z',
    }];
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );
    render(<OpenSpecWorkspace task={task()} />);

    expect(screen.queryByTestId('openspec-refine-plan')).not.toBeInTheDocument();
    expect(screen.getByText(
      'The selected change is archived. Select an active change, or create a new change or proposal.',
    )).toBeInTheDocument();
    expect(screen.queryByText(
      'Run /opsx:new to continue from the archived baseline.',
    )).not.toBeInTheDocument();
    expect(screen.getByTestId('openspec-auto-action'))
      .toHaveTextContent('Create follow-up iteration');

    fireEvent.click(screen.getByTestId('openspec-auto-action'));
    await waitFor(() => expect(current.runAction).toHaveBeenCalledWith(
      'new',
      {
        arguments:
          'Create a follow-up after change-a: Implement a custom workflow.',
      },
    ));
  });

  it('localizes the system next step when no active change is selected', () => {
    const noSelection = snapshot({
      changeName: null,
      artifacts: [],
      applyRequires: [],
      availableActions: ['new', 'propose', 'explore'],
      nextSteps: ['Select an existing change or run New/Propose.'],
    });
    const current = workspaceMock(noSelection);
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );

    render(<OpenSpecWorkspace task={task()} />);

    expect(screen.getAllByText(
      'Select an active change, or create a new change or proposal.',
    )).toHaveLength(2);
    expect(screen.queryByText(
      'Select an existing change or run New/Propose.',
    )).not.toBeInTheDocument();
  });

  it('turns a transient provider failure into a status-aware retry action', async () => {
    const current = workspaceMock();
    current.runHistory = [{
      runId: 'run-overloaded',
      action: 'continue',
      state: 'failed',
      startedAt: '2026-07-30T00:00:00.000Z',
      error:
        'Provider temporarily unavailable: ' +
        '{"type":"service_unavailable_error","code":"server_is_overloaded"}',
    }];
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );
    render(<OpenSpecWorkspace task={task()} />);

    expect(screen.getByTestId('openspec-auto-action'))
      .toHaveTextContent('Retry workflow');
    fireEvent.click(screen.getByTestId('openspec-auto-action'));
    await waitFor(() => expect(current.runAction).toHaveBeenCalledWith(
      'continue',
      { arguments: undefined },
    ));
  });

  it('fails closed for affected-area selection without exposing command buttons', async () => {
    const baseActionContext = snapshot().actionContext;
    if (!baseActionContext) {
      throw new Error('Test snapshot is missing Action context.');
    }
    const currentSnapshot = snapshot({
      actionContext: {
        ...baseActionContext,
        requiresAffectedAreaSelection: true,
      },
      availableActions: ['explore', 'archive'],
    });
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      workspaceMock(currentSnapshot) as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );
    render(<OpenSpecWorkspace task={task()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'requires affected-area selection',
    );
    expect(screen.queryByTestId('openspec-action-apply')).not.toBeInTheDocument();
    expect(screen.getByTestId('openspec-auto-action')).toHaveTextContent(
      'Inspect workflow',
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'History' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByTestId('openspec-history')).toHaveTextContent('Archive');
    expect(screen.getByTestId('openspec-history'))
      .toHaveTextContent('2026-07-28-old-change');
  });

  it('uses readable semantic colors for console output', () => {
    const current = workspaceMock();
    current.consoleLines = [
      {
        runId: 'run-a',
        sequence: 1,
        text: [
          '[Bash] openspec status --change change-a --json',
          '[Read] openspec/changes/change-a/proposal.md',
          '[Edit] openspec/changes/change-a/design.md',
          'Reading official workflow context.',
          '[Provider] Temporarily unavailable. Retrying automatically in 2s (1/5).',
          'Error: provider temporarily unavailable',
          '[Bash] Done',
          '错误：模型调用失败',
          '[Provider] 服务暂时不可用，2 秒后重试',
          '[Bash] 已完成',
          '成功：工作流已完成',
        ].join('\n'),
      },
    ];
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );

    render(<OpenSpecWorkspace task={task()} />);

    expect(screen.getByText('[Bash] openspec status --change change-a --json'))
      .toHaveClass('text-violet-200', 'font-mono');
    expect(screen.getByText('[Read] openspec/changes/change-a/proposal.md'))
      .toHaveClass('text-sky-200', 'font-mono');
    expect(screen.getByText('[Edit] openspec/changes/change-a/design.md'))
      .toHaveClass('text-fuchsia-200', 'font-mono');
    expect(screen.getByText('Reading official workflow context.'))
      .toHaveClass('text-slate-200');
    expect(screen.getByText('[Bash] openspec status --change change-a --json'))
      .toHaveAttribute('data-console-kind', 'tool-command');
    expect(screen.getByText('Reading official workflow context.'))
      .toHaveAttribute('data-console-kind', 'log-content');
    expect(screen.getByText(
      '[Provider] Temporarily unavailable. Retrying automatically in 2s (1/5).',
    )).toHaveClass('text-amber-200');
    expect(screen.getByText('Error: provider temporarily unavailable'))
      .toHaveClass('text-rose-300');
    expect(screen.getByText('[Bash] Done'))
      .toHaveClass('text-emerald-300');
    expect(screen.getByText('错误：模型调用失败'))
      .toHaveClass('text-rose-300');
    expect(screen.getByText('[Provider] 服务暂时不可用，2 秒后重试'))
      .toHaveClass('text-amber-200');
    expect(screen.getByText('[Bash] 已完成'))
      .toHaveClass('text-emerald-300');
    expect(screen.getByText('成功：工作流已完成'))
      .toHaveClass('text-emerald-300');
  });

  it('renders accumulated AI activity as safe Markdown previews per Action run', () => {
    const current = workspaceMock();
    current.consoleLines = [
      {
        runId: 'run-a',
        sequence: 1,
        text: '### SUG',
      },
      {
        runId: 'run-a',
        sequence: 2,
        text: [
          'GESTION',
          '',
          '#### 1. Repository hygiene',
          '',
          '1. Keep generated files ignored.',
          '2. Preview the model response.',
          '',
          'Run `git status --short` before committing.',
          '',
          '```text',
          'node_modules/',
          'test-results/',
          '```',
          '',
          '| Item | Details |',
          '| --- | --- |',
          '| What changed | Markdown preview |',
          '',
          '[Bash] openspec status --change change-a --json',
          '',
          '[Blocked activity link](https://example.invalid/activity)',
          '',
          '![Remote activity](https://example.invalid/activity.png)',
          '',
          '<script>window.activityHacked = true</script>',
        ].join('\n'),
      },
      {
        runId: 'run-b',
        sequence: -1,
        text: '## Follow-up\n\nSecond Action remains separate.',
        truncated: true,
      },
    ];
    vi.mocked(useOpenSpecWorkspace).mockReturnValue(
      current as unknown as ReturnType<typeof useOpenSpecWorkspace>,
    );

    const { container } = render(<OpenSpecWorkspace task={task()} />);
    const activity = screen.getByTestId('openspec-action-console');
    const runs = screen.getAllByTestId('openspec-activity-run');

    expect(screen.getByRole('heading', { level: 3, name: 'SUGGESTION' }))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 4, name: '1. Repository hygiene' }))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Follow-up' }))
      .toBeInTheDocument();
    expect(container.querySelector('ol')).toBeInTheDocument();
    expect(container.querySelector('table')).toBeInTheDocument();
    expect(screen.getByText('git status --short').tagName).toBe('CODE');
    expect(container.querySelector('pre code')).toHaveTextContent(
      'node_modules/ test-results/',
    );
    expect(screen.getByText('[Bash] openspec status --change change-a --json'))
      .toBeInTheDocument();

    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveAttribute('data-run-id', 'run-a');
    expect(runs[1]).toHaveAttribute('data-run-id', 'run-b');
    expect(runs[1]).toHaveTextContent('Earlier output truncated');
    expect(activity.textContent?.indexOf('SUGGESTION'))
      .toBeLessThan(activity.textContent?.indexOf('Follow-up') ?? -1);

    expect(activity).not.toHaveTextContent('### SUGGESTION');
    expect(activity).not.toHaveTextContent('```text');
    expect(activity).not.toHaveTextContent('| Item | Details |');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href="https://example.invalid/activity"]'))
      .toBeNull();
    expect(container.querySelector('img[src="https://example.invalid/activity.png"]'))
      .toBeNull();
    expect(screen.getByText('Blocked activity link')).toHaveAttribute(
      'title',
      'External link blocked in OpenSpec preview: https://example.invalid/activity',
    );
    expect(screen.getByText('Remote image blocked: Remote activity'))
      .toBeInTheDocument();
  });
});
