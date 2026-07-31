import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Project, Task } from '../../shared/types';
import {
  OpenSpecPlanningReviewStore,
  __openSpecPlanningReviewStoreTestUtils,
} from './openspec-planning-review-store';
import { OpenSpecRuntimeStore } from './openspec-runtime-store';

function task(): Task {
  return {
    id: 'spec-task',
    specId: '001-spec-task',
    projectId: 'project-a',
    title: 'Spec task',
    description: 'Plan with OpenSpec.',
    status: 'human_review',
    reviewReason: 'plan_review',
    subtasks: [],
    logs: [],
    metadata: {
      developmentMode: 'spec',
      openSpec: {
        formatVersion: 1,
        rootKind: 'project',
        changeName: 'change-a',
        schemaName: 'spec-driven-with-adr',
      },
    },
    createdAt: new Date('2026-07-31T00:00:00.000Z'),
    updatedAt: new Date('2026-07-31T00:00:00.000Z'),
  };
}

function project(root: string): Project {
  return {
    id: 'project-a',
    name: 'Project A',
    path: root,
    autoBuildPath: '.autocode',
  } as Project;
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe('OpenSpecPlanningReviewStore', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists every created, modified, and deleted OpenSpec or ADR file', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-review-'));
    temporaryRoots.push(root);
    const currentTask = task();
    const currentProject = project(root);
    const openSpecRoot = join(root, 'openspec');
    const adrRoot = join(root, 'adr');
    write(join(openSpecRoot, 'config.yaml'), 'schema: spec-driven-with-adr\r\n');
    write(
      join(openSpecRoot, 'changes', 'change-a', 'proposal.md'),
      '# Proposal\n\nOld scope\n',
    );
    write(
      join(openSpecRoot, 'changes', 'change-a', 'design.md'),
      '# Design\n\nOld design\n',
    );
    write(join(adrRoot, '0001-existing.md'), '# Existing\n\nOld decision\n');

    const runId = randomUUID();
    const store = new OpenSpecPlanningReviewStore(new OpenSpecRuntimeStore());
    store.begin(
      currentTask,
      currentProject,
      runId,
      [openSpecRoot, adrRoot],
    );

    write(join(openSpecRoot, 'config.yaml'), 'schema: spec-driven-with-adr\n');
    write(
      join(openSpecRoot, 'changes', 'change-a', 'proposal.md'),
      '# Proposal\n\nNew scope\n',
    );
    rmSync(join(openSpecRoot, 'changes', 'change-a', 'design.md'));
    write(
      join(openSpecRoot, 'changes', 'change-a', 'tasks.md'),
      '# Tasks\n\n- [ ] Implement offline mode\n',
    );
    write(join(adrRoot, '0001-existing.md'), '# Existing\n\nNew decision\n');
    write(join(adrRoot, '0002-offline.md'), '# Offline mode\n');

    const review = store.complete(
      currentTask,
      currentProject,
      runId,
      [openSpecRoot, adrRoot],
    );

    expect(review.state).toBe('ready');
    expect(review.changes.map(({ relativePath, kind }) => ({
      relativePath,
      kind,
    }))).toEqual([
      { relativePath: 'adr/0001-existing.md', kind: 'modified' },
      { relativePath: 'adr/0002-offline.md', kind: 'created' },
      {
        relativePath: 'openspec/changes/change-a/design.md',
        kind: 'deleted',
      },
      {
        relativePath: 'openspec/changes/change-a/proposal.md',
        kind: 'modified',
      },
      {
        relativePath: 'openspec/changes/change-a/tasks.md',
        kind: 'created',
      },
    ]);
    expect(review.changes[0]?.patch).toContain('-Old decision');
    expect(review.changes[0]?.patch).toContain('+New decision');
    expect(review.changes[2]?.patch).toContain('-Old design');
    expect(review.changes[4]?.patch).toContain('+- [ ] Implement offline mode');
    expect(review.changes.some((change) =>
      change.relativePath === 'openspec/config.yaml')).toBe(false);

    const restoredStore = new OpenSpecPlanningReviewStore(
      new OpenSpecRuntimeStore(),
    );
    expect(restoredStore.read(currentTask, currentProject, runId)).toEqual(review);
    expect(restoredStore.readPending(currentTask, currentProject)).toMatchObject({
      runId,
      state: 'ready',
      changeCount: 5,
    });
    expect(
      restoredStore.acknowledge(currentTask, currentProject, runId),
    ).toBeNull();
    expect(restoredStore.readPending(currentTask, currentProject)).toBeNull();
  });

  it('persists a capture error and retries from the original baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-review-error-'));
    temporaryRoots.push(root);
    const currentTask = task();
    const currentProject = project(root);
    const openSpecRoot = join(root, 'openspec');
    const proposal = join(openSpecRoot, 'changes', 'change-a', 'proposal.md');
    write(proposal, '# Proposal\n\nOld scope\n');

    const runId = randomUUID();
    const store = new OpenSpecPlanningReviewStore(new OpenSpecRuntimeStore());
    store.begin(currentTask, currentProject, runId, [openSpecRoot]);
    write(proposal, Buffer.from([0xff, 0xfe, 0xfd]));

    const failed = store.complete(
      currentTask,
      currentProject,
      runId,
      [openSpecRoot],
    );
    expect(failed).toMatchObject({
      runId,
      state: 'error',
      changes: [],
    });
    expect(failed.error).toContain('UTF-8');
    expect(store.readPending(currentTask, currentProject)).toMatchObject({
      runId,
      state: 'error',
    });

    write(proposal, '# Proposal\n\nRecovered scope\n');
    const retried = store.retry(
      currentTask,
      currentProject,
      runId,
      [openSpecRoot],
    );
    expect(retried.state).toBe('ready');
    expect(retried.changes).toHaveLength(1);
    expect(retried.changes[0]?.patch).toContain('-Old scope');
    expect(retried.changes[0]?.patch).toContain('+Recovered scope');
  });

  it('recovers a missing or damaged summary from the terminal review record', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-review-index-'));
    temporaryRoots.push(root);
    const currentTask = task();
    const currentProject = project(root);
    const openSpecRoot = join(root, 'openspec');
    const proposal = join(openSpecRoot, 'changes', 'change-a', 'proposal.md');
    write(proposal, '# Proposal\n\nOld scope\n');

    const runId = randomUUID();
    const runtimeStore = new OpenSpecRuntimeStore();
    const store = new OpenSpecPlanningReviewStore(runtimeStore);
    store.begin(currentTask, currentProject, runId, [openSpecRoot]);
    write(proposal, '# Proposal\n\nNew scope\n');
    store.complete(currentTask, currentProject, runId, [openSpecRoot]);

    const reviewDirectory = join(
      runtimeStore.getSpecDir(currentTask, currentProject),
      'openspec-planning-reviews',
    );
    const summaryPath = join(reviewDirectory, `${runId}.summary.json`);
    rmSync(summaryPath);

    expect(store.readPending(currentTask, currentProject)).toMatchObject({
      runId,
      state: 'ready',
      changeCount: 1,
    });

    writeFileSync(summaryPath, '{invalid json');
    expect(store.readPending(currentTask, currentProject)).toMatchObject({
      runId,
      state: 'ready',
      changeCount: 1,
    });
  });

  it('fails closed when a damaged planning review index cannot be recovered', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'aperant-openspec-review-index-damaged-'),
    );
    temporaryRoots.push(root);
    const currentTask = task();
    const currentProject = project(root);
    const openSpecRoot = join(root, 'openspec');
    const proposal = join(openSpecRoot, 'changes', 'change-a', 'proposal.md');
    write(proposal, '# Proposal\n\nOld scope\n');

    const runId = randomUUID();
    const runtimeStore = new OpenSpecRuntimeStore();
    const store = new OpenSpecPlanningReviewStore(runtimeStore);
    store.begin(currentTask, currentProject, runId, [openSpecRoot]);
    write(proposal, '# Proposal\n\nNew scope\n');
    store.complete(currentTask, currentProject, runId, [openSpecRoot]);

    const reviewDirectory = join(
      runtimeStore.getSpecDir(currentTask, currentProject),
      'openspec-planning-reviews',
    );
    writeFileSync(join(reviewDirectory, `${runId}.json`), '{invalid json');
    writeFileSync(
      join(reviewDirectory, `${runId}.summary.json`),
      '{invalid json',
    );

    expect(() => store.readPending(currentTask, currentProject)).toThrow(
      'could not be recovered',
    );
  });

  it('blocks a persisted root from being changed before completion', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-review-root-'));
    temporaryRoots.push(root);
    const outside = mkdtempSync(join(tmpdir(), 'aperant-openspec-review-outside-'));
    temporaryRoots.push(outside);
    const currentTask = task();
    const currentProject = project(root);
    const openSpecRoot = join(root, 'openspec');
    write(join(openSpecRoot, 'config.yaml'), 'schema: spec-driven\n');

    const runId = randomUUID();
    const runtimeStore = new OpenSpecRuntimeStore();
    const store = new OpenSpecPlanningReviewStore(runtimeStore);
    store.begin(currentTask, currentProject, runId, [openSpecRoot]);
    const recordPath = join(
      runtimeStore.getSpecDir(currentTask, currentProject),
      'openspec-planning-reviews',
      `${runId}.json`,
    );
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      roots: Array<{ label: string; path: string }>;
    };
    record.roots[0].path = outside;
    writeFileSync(recordPath, `${JSON.stringify(record)}\n`);

    expect(() => store.complete(
      currentTask,
      currentProject,
      runId,
      [openSpecRoot],
    )).toThrow('planning roots changed');
  });

  it('inherits the original baseline when an interrupted Update is resumed', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-review-resume-'));
    temporaryRoots.push(root);
    const currentTask = task();
    const currentProject = project(root);
    const openSpecRoot = join(root, 'openspec');
    const proposal = join(openSpecRoot, 'changes', 'change-a', 'proposal.md');
    const design = join(openSpecRoot, 'changes', 'change-a', 'design.md');
    write(proposal, '# Proposal\n\nOriginal scope\n');
    write(design, '# Design\n\nOriginal design\n');

    const interruptedRunId = randomUUID();
    const runtimeStore = new OpenSpecRuntimeStore();
    const store = new OpenSpecPlanningReviewStore(runtimeStore);
    store.begin(currentTask, currentProject, interruptedRunId, [openSpecRoot]);

    // The interrupted Update already rewrote the proposal before Aperant exited.
    write(proposal, '# Proposal\n\nHalf-written scope\n');

    const resumedRunId = randomUUID();
    const resumedStore = new OpenSpecPlanningReviewStore(
      new OpenSpecRuntimeStore(),
    );
    resumedStore.begin(
      currentTask,
      currentProject,
      resumedRunId,
      [openSpecRoot],
      { inheritBaselineFromRunId: interruptedRunId },
    );
    write(design, '# Design\n\nRecovered design\n');

    const review = resumedStore.complete(
      currentTask,
      currentProject,
      resumedRunId,
      [openSpecRoot],
    );

    expect(review.changes.map(({ relativePath, kind }) => ({
      relativePath,
      kind,
    }))).toEqual([
      { relativePath: 'openspec/changes/change-a/design.md', kind: 'modified' },
      {
        relativePath: 'openspec/changes/change-a/proposal.md',
        kind: 'modified',
      },
    ]);
    expect(review.changes[1]?.patch).toContain('-Original scope');
    expect(review.changes[1]?.patch).toContain('+Half-written scope');

    const reviewDirectory = join(
      runtimeStore.getSpecDir(currentTask, currentProject),
      'openspec-planning-reviews',
    );
    expect(
      existsSync(join(reviewDirectory, `${interruptedRunId}.json`)),
    ).toBe(false);
  });

  it('recaptures the baseline when the resumed Update exposes different roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-review-reroot-'));
    temporaryRoots.push(root);
    const currentTask = task();
    const currentProject = project(root);
    const openSpecRoot = join(root, 'openspec');
    const adrRoot = join(root, 'adr');
    const proposal = join(openSpecRoot, 'changes', 'change-a', 'proposal.md');
    write(proposal, '# Proposal\n\nOriginal scope\n');
    write(join(adrRoot, '0001-existing.md'), '# Existing\n');

    const interruptedRunId = randomUUID();
    const store = new OpenSpecPlanningReviewStore(new OpenSpecRuntimeStore());
    store.begin(currentTask, currentProject, interruptedRunId, [openSpecRoot]);
    write(proposal, '# Proposal\n\nHalf-written scope\n');

    const resumedRunId = randomUUID();
    store.begin(
      currentTask,
      currentProject,
      resumedRunId,
      [openSpecRoot, adrRoot],
      { inheritBaselineFromRunId: interruptedRunId },
    );
    write(proposal, '# Proposal\n\nRecovered scope\n');

    const review = store.complete(
      currentTask,
      currentProject,
      resumedRunId,
      [openSpecRoot, adrRoot],
    );

    expect(review.changes).toHaveLength(1);
    expect(review.changes[0]?.patch).toContain('-Half-written scope');
    expect(review.changes[0]?.patch).toContain('+Recovered scope');
  });

  it('ignores an unusable inherited baseline instead of failing the Update', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-review-inherit-'));
    temporaryRoots.push(root);
    const currentTask = task();
    const currentProject = project(root);
    const openSpecRoot = join(root, 'openspec');
    const proposal = join(openSpecRoot, 'changes', 'change-a', 'proposal.md');
    write(proposal, '# Proposal\n\nOriginal scope\n');

    const runtimeStore = new OpenSpecRuntimeStore();
    const store = new OpenSpecPlanningReviewStore(runtimeStore);
    const interruptedRunId = randomUUID();
    store.begin(currentTask, currentProject, interruptedRunId, [openSpecRoot]);
    writeFileSync(
      join(
        runtimeStore.getSpecDir(currentTask, currentProject),
        'openspec-planning-reviews',
        `${interruptedRunId}.json`,
      ),
      '{invalid json',
    );

    const resumedRunId = randomUUID();
    expect(() => store.begin(
      currentTask,
      currentProject,
      resumedRunId,
      [openSpecRoot],
      { inheritBaselineFromRunId: 'not-a-run-id' },
    )).not.toThrow();

    const secondRunId = randomUUID();
    store.begin(
      currentTask,
      currentProject,
      secondRunId,
      [openSpecRoot],
      { inheritBaselineFromRunId: interruptedRunId },
    );
    write(proposal, '# Proposal\n\nRecovered scope\n');

    const review = store.complete(
      currentTask,
      currentProject,
      secondRunId,
      [openSpecRoot],
    );
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0]?.patch).toContain('-Original scope');
  });
});

describe('OpenSpec planning review patches', () => {
  it('normalizes line endings before deciding whether content changed', () => {
    expect(__openSpecPlanningReviewStoreTestUtils.buildPlanningChanges(
      [{ relativePath: 'openspec/config.yaml', content: 'schema: custom\r\n' }],
      [{ relativePath: 'openspec/config.yaml', content: 'schema: custom\n' }],
    )).toEqual([]);
  });
});
