import { describe, expect, it } from 'vitest';
import { AutocodeRuntimeWorkspaceClaimManager } from './workspace-claims.js';

describe('AutocodeRuntimeWorkspaceClaimManager', () => {
  it('does not release matching task ids from other projects', () => {
    const manager = new AutocodeRuntimeWorkspaceClaimManager();

    const first = manager.tryClaim({
      taskId: '001-project-docs',
      projectId: 'project-a',
      projectRoot: '/repo/a',
      workspaceRoot: '/repo/a',
      fileIntents: ['docs/a.md'],
    });
    const second = manager.tryClaim({
      taskId: '001-project-docs',
      projectId: 'project-b',
      projectRoot: '/repo/b',
      workspaceRoot: '/repo/b',
      fileIntents: ['docs/b.md'],
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(manager.listClaims()).toHaveLength(2);

    manager.releaseByTask('001-project-docs', 'project-a');

    expect(manager.listClaims()).toMatchObject([
      { taskId: '001-project-docs', projectId: 'project-b' },
    ]);
  });
});
