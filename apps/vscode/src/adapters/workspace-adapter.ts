import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WorkspaceAdapter } from '@autocode/core';
import {
  AUTOCODE_PROJECT_DATA_DIR_NAME,
  isAutocodeTaskArtifactFileName,
} from '@autocode/core/tasks/artifacts';

const DEFAULT_PROJECT_DATA_DIR = AUTOCODE_PROJECT_DATA_DIR_NAME;

export function createWorkspaceAdapter(): WorkspaceAdapter {
  return {
    async getWorkspaceRoot() {
      const configuredPath = vscode.workspace
        .getConfiguration('autocode')
        .get<string>('projectPath', '')
        ?.trim();
      return configuredPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
    },

    async resolveProjectPath(...segments: string[]) {
      const root = await this.getWorkspaceRoot();
      if (!root) {
        throw new Error('Open a workspace folder before using Autocode.');
      }
      return path.join(root, ...segments);
    },

    async watchProjectData(onChange: () => void) {
      const dataDirName = getConfiguredDataDirName().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
      const watcher = vscode.workspace.createFileSystemWatcher(`**/${dataDirName}/specs/**`);
      let refreshTimer: NodeJS.Timeout | undefined;
      const scheduleRefresh = (uri: vscode.Uri): void => {
        if (!isTaskArtifactPath(uri.fsPath)) {
          return;
        }
        if (refreshTimer) {
          clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(() => {
          onChange();
          refreshTimer = undefined;
        }, 250);
      };

      const subscriptions = [
        watcher.onDidCreate(scheduleRefresh),
        watcher.onDidChange(scheduleRefresh),
        watcher.onDidDelete(scheduleRefresh),
      ];

      return () => {
        if (refreshTimer) {
          clearTimeout(refreshTimer);
        }
        subscriptions.forEach((subscription) => subscription.dispose());
        watcher.dispose();
      };
    },
  };
}

export function getConfiguredDataDirName(): string {
  return vscode.workspace
    .getConfiguration('autocode')
    .get<string>('projectDataDir', DEFAULT_PROJECT_DATA_DIR)
    ?.trim() || DEFAULT_PROJECT_DATA_DIR;
}

function isTaskArtifactPath(filePath: string): boolean {
  return isAutocodeTaskArtifactFileName(path.basename(filePath));
}
