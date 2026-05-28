export interface WorkspaceAdapter {
  getWorkspaceRoot(): Promise<string | null>;
  resolveProjectPath(...segments: string[]): Promise<string>;
  watchProjectData(onChange: () => void): Promise<() => void>;
}
