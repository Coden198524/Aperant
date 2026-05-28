export interface TerminalAdapter {
  runCommand(options: {
    name: string;
    command: string;
    cwd?: string;
  }): Promise<void>;
  reveal?(name: string): Promise<void>;
  dispose?(name: string): Promise<void>;
}
