import { describe, expect, it } from 'vitest';

import type {
  OpenSpecArtifactSnapshot,
  OpenSpecBoardSnapshot,
} from '../../../shared/types';
import {
  isOpenSpecActionDisabled,
  openSpecArtifactColumn,
  resolveOpenSpecAutomaticAction,
} from './openSpec-workspace-view-model';

function artifact(status: OpenSpecArtifactSnapshot['status']): OpenSpecArtifactSnapshot {
  return {
    id: 'custom-artifact',
    outputPath: 'custom.md',
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
    schema: { name: 'custom-schema' },
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

describe('OpenSpec workspace view model', () => {
  it('does not mislabel an unknown upstream status as blocked', () => {
    expect(openSpecArtifactColumn(artifact('blocked'))).toBe('blocked');
    expect(openSpecArtifactColumn(artifact('ready'))).toBe('ready');
    expect(openSpecArtifactColumn(artifact('done'))).toBe('done');
    expect(openSpecArtifactColumn(artifact('unknown'))).toBe('unsupported');
  });

  it('fails closed for mutating Actions while retaining read-only diagnostics', () => {
    const unsupported = snapshot({ unsupportedStatus: true });
    expect(isOpenSpecActionDisabled({
      snapshot: unsupported,
      action: 'apply',
      actionRunning: false,
      pending: false,
    })).toBe(true);
    expect(isOpenSpecActionDisabled({
      snapshot: unsupported,
      action: 'explore',
      actionRunning: false,
      pending: false,
    })).toBe(false);
    expect(isOpenSpecActionDisabled({
      snapshot: unsupported,
      action: 'verify',
      actionRunning: false,
      pending: false,
    })).toBe(false);
  });

  it('automatically advances planning, implementation, and verification', () => {
    const planning = snapshot({
      artifacts: [artifact('done'), artifact('ready')],
      availableActions: ['continue', 'apply', 'verify'],
    });
    expect(resolveOpenSpecAutomaticAction(planning)?.action).toBe('continue');

    const implementation = snapshot({
      artifacts: [artifact('done')],
      taskProgress: { completed: 1, total: 3 },
      availableActions: ['apply', 'verify'],
    });
    expect(resolveOpenSpecAutomaticAction(implementation)).toMatchObject({
      action: 'apply',
      labelKey: 'tasks:openSpec.automatic.continueImplementation.label',
    });

    const verification = snapshot({
      artifacts: [artifact('done')],
      taskProgress: { completed: 3, total: 3 },
      availableActions: ['apply', 'verify', 'archive'],
    });
    expect(resolveOpenSpecAutomaticAction(verification)?.action).toBe('verify');
    expect(resolveOpenSpecAutomaticAction({
      ...verification,
      workflowStage: 'verified',
    })?.action).toBe('archive');
    expect(resolveOpenSpecAutomaticAction(verification, {
      lastRun: {
        runId: 'verify-run',
        action: 'verify',
        state: 'succeeded',
        startedAt: '2026-07-28T00:00:00.000Z',
      },
    })).toMatchObject({
      action: 'archive',
      labelKey: 'tasks:openSpec.automatic.archiveVerified.label',
    });
  });

  it('offers an explicit incremental Change after Archive', () => {
    expect(resolveOpenSpecAutomaticAction(snapshot({
      changeName: 'change-a',
      archived: true,
      availableActions: ['new', 'propose', 'explore'],
    }))).toMatchObject({
      action: 'new',
      labelKey: 'tasks:openSpec.automatic.followUpIteration.label',
    });
  });

  it('starts an empty workflow but waits for change selection when changes exist', () => {
    const empty = snapshot({
      initialized: false,
      changeName: null,
      availableActions: ['new', 'propose', 'explore'],
    });
    expect(resolveOpenSpecAutomaticAction(empty, {
      preferredStartAction: 'propose',
    })?.action).toBe('propose');

    const unselected = snapshot({
      changeName: null,
      availableActions: ['new', 'propose', 'explore'],
    });
    expect(resolveOpenSpecAutomaticAction(unselected, {
      hasChanges: true,
    })).toBeNull();
  });

  it('uses read-only inspection for unsupported upstream statuses', () => {
    const unsupported = snapshot({
      unsupportedStatus: true,
      availableActions: ['explore', 'apply', 'verify'],
    });
    expect(resolveOpenSpecAutomaticAction(unsupported)).toMatchObject({
      action: 'verify',
      labelKey: 'tasks:openSpec.automatic.inspectUnsupported.label',
    });
  });

  it('offers a status-aware workflow retry after provider overload', () => {
    const planning = snapshot({
      artifacts: [artifact('done'), artifact('ready')],
      availableActions: ['continue', 'apply', 'verify'],
    });

    expect(resolveOpenSpecAutomaticAction(planning, {
      lastRun: {
        runId: 'overloaded-run',
        action: 'continue',
        state: 'failed',
        startedAt: '2026-07-30T00:00:00.000Z',
        error:
          'Provider temporarily unavailable: error ' +
          '{"type":"service_unavailable_error","code":"server_is_overloaded"}',
      },
    })).toMatchObject({
      action: 'continue',
      labelKey: 'tasks:openSpec.automatic.retry.label',
      retry: true,
    });
  });
});
