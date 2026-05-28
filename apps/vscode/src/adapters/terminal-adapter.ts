import * as vscode from 'vscode';
import type { TerminalAdapter } from '@autocode/core';

const runningTerminals = new Map<string, vscode.Terminal>();

export function createTerminalAdapter(): TerminalAdapter {
  return {
    async runCommand({ name, command, cwd }) {
      const existing = runningTerminals.get(name);
      if (existing) {
        existing.show();
        existing.sendText(command, true);
        return;
      }

      const terminal = vscode.window.createTerminal({ name, cwd });
      runningTerminals.set(name, terminal);
      terminal.show();
      terminal.sendText(command, true);
    },
    async reveal(name: string) {
      runningTerminals.get(name)?.show();
    },
    async dispose(name: string) {
      const terminal = runningTerminals.get(name);
      if (!terminal) {
        return;
      }
      terminal.dispose();
      runningTerminals.delete(name);
    },
  };
}

export function bindTerminalLifecycle(onClosed: (name: string) => void): vscode.Disposable {
  return vscode.window.onDidCloseTerminal((terminal) => {
    if (!terminal.name.startsWith('Autocode: ')) {
      return;
    }
    runningTerminals.delete(terminal.name);
    onClosed(terminal.name);
  });
}
