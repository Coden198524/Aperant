export interface ContextProps {
  projectId: string;
  projectPath?: string;
  projectDataDir?: string;
  onProjectDocsClick?: () => void;
  canCreateProjectDocs?: boolean;
}
