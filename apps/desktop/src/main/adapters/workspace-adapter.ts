import type { WorkspaceAdapter } from '@autocode/core';

export function createDesktopWorkspaceAdapter(getWorkspaceRoot: () => string | null): WorkspaceAdapter {
  return {
    async getWorkspaceRoot() {
      return getWorkspaceRoot();
    },
    async resolveProjectPath(...segments: string[]) {
      const root = getWorkspaceRoot();
      if (!root) {
        throw new Error('No active project root available.');
      }
      return [root, ...segments].join('/');
    },
    async watchProjectData() {
      return () => {};
    },
  };
}
