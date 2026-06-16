import { describe, expect, it } from 'vitest';
import {
  type AutocodeRuntimeTask,
  estimateAutocodeRuntimeTaskEffort,
  groupAutocodeRuntimeTasksIntoWorkPackages,
} from './work-packages.js';

function makeTask(overrides: Partial<AutocodeRuntimeTask> & { id: string }): AutocodeRuntimeTask {
  return {
    id: overrides.id,
    title: `Task ${overrides.id}`,
    description: `Implement task ${overrides.id}.`,
    status: 'pending',
    phaseId: '1',
    phaseName: 'Implementation',
    filesToCreate: [],
    filesToModify: [],
    patternFiles: [],
    dependsOn: [],
    requirements: [],
    verification: '',
    ...overrides,
  };
}

function packageEffort(tasks: AutocodeRuntimeTask[]): number {
  return tasks.reduce((sum, task) => sum + estimateAutocodeRuntimeTaskEffort(task), 0);
}

describe('runtime work package balancing', () => {
  it('splits a linear dependency chain by estimated effort instead of raw task count', () => {
    const tasks = [
      makeTask({
        id: '1.1',
        title: 'Refactor authentication architecture',
        description: 'Refactor shared authentication architecture and permission persistence contracts.',
        filesToModify: [
          'src/auth/service.ts',
          'src/auth/session.ts',
          'src/auth/permissions.ts',
          'src/auth/storage.ts',
          'src/auth/index.ts',
          'src/shared/auth.ts',
        ],
      }),
      makeTask({ id: '1.2', title: 'Rename login label', dependsOn: ['1.1'] }),
      makeTask({ id: '1.3', title: 'Update docs copy', dependsOn: ['1.2'] }),
      makeTask({ id: '1.4', title: 'Adjust empty state text', dependsOn: ['1.3'] }),
      makeTask({ id: '1.5', title: 'Refresh README note', dependsOn: ['1.4'] }),
    ];

    const packages = groupAutocodeRuntimeTasksIntoWorkPackages(tasks);
    const efforts = packages.map((workPackage) => packageEffort(workPackage.tasks));

    expect(packages).toHaveLength(2);
    expect(packages[0].tasks.map((task) => task.id)).toEqual(['1.1']);
    expect(packages[1].tasks.map((task) => task.id)).toEqual(['1.2', '1.3', '1.4', '1.5']);
    expect(packages[1].dependsOn).toEqual(['wp-1']);
    expect(Math.max(...efforts)).toBeLessThan(packageEffort(tasks));
  });

  it('packs independent light tasks together while keeping heavy tasks balanced', () => {
    const tasks = [
      makeTask({
        id: '1.1',
        title: 'Refactor billing persistence architecture',
        description: 'Refactor billing persistence architecture and shared schema migration contracts.',
        filesToModify: [
          'src/billing/store.ts',
          'src/billing/schema.ts',
          'src/billing/migration.ts',
          'src/billing/service.ts',
          'src/shared/billing.ts',
          'src/config/billing.ts',
        ],
      }),
      makeTask({ id: '1.2', title: 'Update settings label' }),
      makeTask({ id: '1.3', title: 'Refresh help docs' }),
      makeTask({ id: '1.4', title: 'Rename empty state copy' }),
      makeTask({ id: '1.5', title: 'Adjust button text' }),
      makeTask({
        id: '1.6',
        title: 'Refactor invoice workflow orchestration',
        description: 'Refactor invoice workflow orchestration and validation pipeline behavior.',
        filesToModify: [
          'src/invoices/workflow.ts',
          'src/invoices/validation.ts',
          'src/invoices/service.ts',
          'src/invoices/events.ts',
          'src/shared/invoices.ts',
          'src/config/invoices.ts',
        ],
      }),
    ];

    const packages = groupAutocodeRuntimeTasksIntoWorkPackages(tasks);
    const efforts = packages.map((workPackage) => packageEffort(workPackage.tasks));

    expect(packages).toHaveLength(2);
    expect(packages.map((workPackage) => workPackage.tasks.length).sort((left, right) => left - right)).toEqual([
      2,
      4,
    ]);
    expect(packages.every((workPackage) => workPackage.tasks.length <= 5)).toBe(true);
    expect(Math.max(...efforts) - Math.min(...efforts)).toBeLessThanOrEqual(1);
  });
});
