import { describe, expect, it } from 'vitest';

import type {
  OpenSpecAction,
  OpenSpecArtifactSnapshot,
  OpenSpecBoardSnapshot,
  OpenSpecRunState,
} from '../types';
import { resolveOpenSpecWorkflowAction } from './openspec-workflow-action';

function artifact(status: OpenSpecArtifactSnapshot['status']): OpenSpecArtifactSnapshot {
  return {
    id: `${status}-artifact`,
    outputPath: `${status}.md`,
    status,
    missingDeps: [],
    existingOutputPaths: [],
    dependencies: [],
    unlocks: [],
    inProgress: false,
    blocksApply: false,
  };
}

function snapshot(overrides: Partial<OpenSpecBoardSnapshot> = {}): OpenSpecBoardSnapshot {
  return {
    taskId: 'task-a',
    openSpecVersion: '1.6.0',
    rootKind: 'project',
    rootLabel: 'project',
    initialized: true,
    changeName: 'change-a',
    schema: { name: 'spec-driven' },
    artifacts: [],
    applyRequires: [],
    activeRun: null,
    validation: null,
    nextSteps: [],
    availableActions: ['explore', 'apply', 'verify'],
    archived: false,
    revision: 1,
    ...overrides,
  };
}

function activeRun(state: OpenSpecRunState) {
  return {
    runId: 'active-run',
    action: 'continue' as const,
    state,
    startedAt: '2026-07-31T00:00:00.000Z',
  };
}

describe('resolveOpenSpecWorkflowAction', () => {
  it.each([
    'queued',
    'preparing',
    'running',
    'awaiting_user',
    'cancelling',
    'interrupted',
  ] satisfies OpenSpecRunState[])('waits while an active run is %s', (state) => {
    expect(resolveOpenSpecWorkflowAction(snapshot({
      activeRun: activeRun(state),
      artifacts: [artifact('ready')],
      availableActions: ['continue'],
    }))).toBeNull();
  });

  it('uses the preferred start action before falling back safely', () => {
    const uninitialized = snapshot({
      initialized: false,
      changeName: null,
      availableActions: ['new', 'propose', 'explore'],
    });

    expect(resolveOpenSpecWorkflowAction(uninitialized, {
      preferredStartAction: 'propose',
    })).toBe('propose');
    expect(resolveOpenSpecWorkflowAction({
      ...uninitialized,
      availableActions: ['new', 'explore'],
    }, {
      preferredStartAction: 'propose',
    })).toBe('new');
  });

  it('waits for change selection when initialized changes already exist', () => {
    const unselected = snapshot({
      changeName: null,
      availableActions: ['new', 'propose', 'explore'],
    });

    expect(resolveOpenSpecWorkflowAction(unselected, {
      hasChanges: true,
    })).toBeNull();
    expect(resolveOpenSpecWorkflowAction(unselected, {
      hasChanges: false,
      preferredStartAction: 'propose',
    })).toBe('propose');
  });

  it('does not restart an archived change', () => {
    expect(resolveOpenSpecWorkflowAction(snapshot({
      initialized: false,
      changeName: null,
      archived: true,
      availableActions: ['new', 'apply', 'verify'],
    }))).toBeNull();
  });

  it('only permits read-only diagnostics for unsupported status', () => {
    const unsupported = snapshot({
      initialized: false,
      changeName: null,
      unsupportedStatus: true,
      artifacts: [artifact('ready')],
      availableActions: ['continue', 'apply', 'verify', 'explore'],
    });

    expect(resolveOpenSpecWorkflowAction(unsupported)).toBe('verify');
    expect(resolveOpenSpecWorkflowAction({
      ...unsupported,
      availableActions: ['apply', 'explore'],
    })).toBe('explore');
    expect(resolveOpenSpecWorkflowAction({
      ...unsupported,
      availableActions: ['continue', 'apply'],
    })).toBeNull();
  });

  it('continues ready planning before considering other actions', () => {
    expect(resolveOpenSpecWorkflowAction(snapshot({
      artifacts: [artifact('done'), artifact('ready')],
      availableActions: ['continue', 'ff', 'apply', 'verify'],
    }))).toBe('continue');
  });

  it('fast-forwards incomplete planning when continue is unavailable', () => {
    expect(resolveOpenSpecWorkflowAction(snapshot({
      artifacts: [artifact('blocked')],
      availableActions: ['ff', 'apply', 'verify'],
    }))).toBe('ff');
  });

  it('verifies completed implementation only once', () => {
    const completed = snapshot({
      artifacts: [artifact('done')],
      taskProgress: { completed: 3, total: 3 },
      availableActions: ['apply', 'verify', 'archive'],
    });

    expect(resolveOpenSpecWorkflowAction(completed)).toBe('verify');
    expect(resolveOpenSpecWorkflowAction(completed, {
      lastSuccessfulAction: 'verify',
    })).toBeNull();
  });

  it('applies work before falling back to verify or explore', () => {
    const actions: OpenSpecAction[] = ['apply', 'verify', 'explore'];
    const implementation = snapshot({
      artifacts: [artifact('done')],
      taskProgress: { completed: 1, total: 3 },
      availableActions: actions,
    });

    expect(resolveOpenSpecWorkflowAction(implementation)).toBe('apply');
    expect(resolveOpenSpecWorkflowAction({
      ...implementation,
      availableActions: ['verify', 'explore'],
    })).toBe('verify');
    expect(resolveOpenSpecWorkflowAction({
      ...implementation,
      availableActions: ['explore'],
    })).toBe('explore');
  });

  it('never automatically archives changes', () => {
    expect(resolveOpenSpecWorkflowAction(snapshot({
      artifacts: [artifact('done')],
      availableActions: ['archive', 'bulk-archive'],
    }))).toBeNull();
  });
});
