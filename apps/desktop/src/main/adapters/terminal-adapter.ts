import type { TerminalAdapter } from '@autocode/core';

export function createDesktopTerminalAdapter(impl: {
  runCommand(options: { name: string; command: string; cwd?: string }): Promise<void>;
  reveal?(name: string): Promise<void>;
  dispose?(name: string): Promise<void>;
}): TerminalAdapter {
  return {
    async runCommand(options) {
      await impl.runCommand(options);
    },
    async reveal(name: string) {
      await impl.reveal?.(name);
    },
    async dispose(name: string) {
      await impl.dispose?.(name);
    },
  };
}
