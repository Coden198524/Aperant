export interface GitAdapter {
  getCurrentBranch(cwd: string): Promise<string | null>;
}
