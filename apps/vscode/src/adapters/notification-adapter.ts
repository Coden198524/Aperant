import * as vscode from 'vscode';
import type { NotificationAdapter } from '@autocode/core';

export function createNotificationAdapter(): NotificationAdapter {
  return {
    async info(message: string) {
      await vscode.window.showInformationMessage(message);
    },
    async warn(message: string) {
      await vscode.window.showWarningMessage(message);
    },
    async error(message: string) {
      await vscode.window.showErrorMessage(message);
    },
  };
}
