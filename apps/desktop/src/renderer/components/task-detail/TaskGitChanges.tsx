import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GitBranch,
  GitCommit,
  FileText,
  FilePlus,
  FileX,
  FileDiff,
  Loader2,
  AlertCircle,
  RefreshCw,
  ChevronRight
} from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import type { Task } from '../../../shared/types';

interface TaskGitChangesProps {
  task: Task;
}

interface GitFile {
  path: string;
  status: 'M' | 'A' | 'D';
  additions: number;
  deletions: number;
}

interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  timestamp: number;
}

// Get icon and color for file status
function getFileStatusIcon(status: string) {
  switch (status) {
    case 'A':
      return <FilePlus className="h-4 w-4 text-green-500" />;
    case 'D':
      return <FileX className="h-4 w-4 text-red-500" />;
    case 'M':
    default:
      return <FileDiff className="h-4 w-4 text-amber-500" />;
  }
}

function getFileStatusLabel(status: string, t: (key: string) => string) {
  switch (status) {
    case 'A':
      return t('tasks:gitChanges.added');
    case 'D':
      return t('tasks:gitChanges.deleted');
    case 'M':
    default:
      return t('tasks:gitChanges.modified');
  }
}

export function TaskGitChanges({ task }: TaskGitChangesProps) {
  const { t } = useTranslation(['tasks']);

  // State for files
  const [files, setFiles] = useState<GitFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  // State for commits
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [isLoadingCommits, setIsLoadingCommits] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);

  // State for diff
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // Load changed files
  const loadFiles = useCallback(async () => {
    setIsLoadingFiles(true);
    setFilesError(null);

    try {
      const result = await window.electronAPI.getWorktreeChangedFiles(task.id, task.projectId);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to load changed files');
      }
      setFiles(result.data);
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingFiles(false);
    }
  }, [task.id, task.projectId]);

  // Load commit history
  const loadCommits = useCallback(async () => {
    setIsLoadingCommits(true);
    setCommitsError(null);

    try {
      const result = await window.electronAPI.getWorktreeCommits(task.id, task.projectId);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to load commits');
      }
      setCommits(result.data);
      // Auto-select first commit if available
      if (result.data.length > 0 && !selectedCommit) {
        setSelectedCommit(result.data[0].hash);
      }
    } catch (err) {
      setCommitsError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingCommits(false);
    }
  }, [task.id, task.projectId, selectedCommit]);

  // Load diff for selected file
  const loadDiff = useCallback(async (filePath: string) => {
    setSelectedFile(filePath);
    setIsLoadingDiff(true);
    setDiffError(null);
    setDiff(null);

    try {
      const result = await window.electronAPI.getWorktreeFileDiff(task.id, filePath, task.projectId);
      if (!result.success || result.data === undefined) {
        throw new Error(result.error || 'Failed to load diff');
      }
      setDiff(result.data);
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingDiff(false);
    }
  }, [task.id, task.projectId]);

  // Load data on mount
  useEffect(() => {
    loadFiles();
    loadCommits();
  }, [loadFiles, loadCommits]);

  // Auto-select first file when files are loaded
  useEffect(() => {
    if (files.length > 0 && selectedFile === null) {
      loadDiff(files[0].path);
    }
  }, [files, selectedFile, loadDiff]);

  // Refresh all data
  const handleRefresh = () => {
    loadFiles();
    loadCommits();
    if (selectedFile) {
      loadDiff(selectedFile);
    }
  };

  // Render diff content
  const renderDiff = () => {
    if (!selectedFile) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <FileDiff className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{t('tasks:gitChanges.selectFile')}</p>
          </div>
        </div>
      );
    }

    if (isLoadingDiff) {
      return (
        <div className="h-full flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (diffError) {
      return (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <AlertCircle className="h-8 w-8 mx-auto mb-2 text-destructive" />
            <p className="text-sm text-destructive mb-2">{t('tasks:gitChanges.errorLoading')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => selectedFile && loadDiff(selectedFile)}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              {t('tasks:files.retry')}
            </Button>
          </div>
        </div>
      );
    }

    if (diff === null || diff === '') {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <p className="text-sm">{t('tasks:gitChanges.noChanges')}</p>
        </div>
      );
    }

    // Parse and render diff with syntax highlighting
    const lines = diff.split('\n');
    return (
      <div className="p-4">
        <pre className="text-xs font-mono">
          {lines.map((line, idx) => {
            let className = 'text-foreground';
            if (line.startsWith('+') && !line.startsWith('+++')) {
              className = 'text-green-600 dark:text-green-400 bg-green-500/10';
            } else if (line.startsWith('-') && !line.startsWith('---')) {
              className = 'text-red-600 dark:text-red-400 bg-red-500/10';
            } else if (line.startsWith('@@')) {
              className = 'text-blue-600 dark:text-blue-400 font-semibold';
            } else if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) {
              className = 'text-muted-foreground';
            }

            return (
              <div key={idx} className={cn('px-2 py-0.5', className)}>
                {line || ' '}
              </div>
            );
          })}
        </pre>
      </div>
    );
  };

  return (
    <div className="h-full flex">
      {/* Left sidebar - Files and Commits */}
      <div className="w-80 border-r border-border flex flex-col">
        {/* Files section - 30% height */}
        <div className="h-[30%] border-b border-border flex flex-col">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between bg-muted/30">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('tasks:gitChanges.files')}
              </span>
              {files.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {files.length}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleRefresh}
              disabled={isLoadingFiles}
            >
              <RefreshCw className={cn("h-3 w-3", isLoadingFiles && "animate-spin")} />
            </Button>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {isLoadingFiles ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : filesError ? (
                <div className="text-center py-4">
                  <AlertCircle className="h-5 w-5 mx-auto mb-2 text-destructive" />
                  <p className="text-xs text-destructive">{filesError}</p>
                </div>
              ) : files.length === 0 ? (
                <div className="text-center py-8">
                  <FileText className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground">{t('tasks:gitChanges.noChanges')}</p>
                </div>
              ) : (
                files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => loadDiff(file.path)}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors',
                      'hover:bg-secondary/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                      selectedFile === file.path && 'bg-secondary'
                    )}
                  >
                    {getFileStatusIcon(file.status)}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">
                        {file.path.split('/').pop()}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {file.path}
                      </div>
                    </div>
                    {selectedFile === file.path && (
                      <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    )}
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Commits section - 70% height */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between bg-muted/30">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('tasks:gitChanges.commits')}
              </span>
              {commits.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {commits.length}
                </Badge>
              )}
            </div>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-2">
              {isLoadingCommits ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : commitsError ? (
                <div className="text-center py-4">
                  <AlertCircle className="h-5 w-5 mx-auto mb-2 text-destructive" />
                  <p className="text-xs text-destructive">{commitsError}</p>
                </div>
              ) : commits.length === 0 ? (
                <div className="text-center py-8">
                  <GitCommit className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground">{t('tasks:gitChanges.noCommits')}</p>
                </div>
              ) : (
                commits.map((commit, idx) => (
                  <div
                    key={commit.hash}
                    className={cn(
                      'relative px-3 py-2 rounded-md border transition-colors',
                      selectedCommit === commit.hash
                        ? 'bg-secondary border-primary'
                        : 'bg-card border-border hover:bg-secondary/50'
                    )}
                  >
                    {/* Git graph line */}
                    {idx < commits.length - 1 && (
                      <div className="absolute left-[13px] top-[32px] bottom-[-8px] w-[2px] bg-border" />
                    )}

                    <div className="flex items-start gap-2">
                      <GitCommit className="h-4 w-4 text-primary shrink-0 mt-0.5 relative z-10 bg-card" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-foreground mb-1 line-clamp-2">
                          {commit.message}
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          <code className="font-mono">{commit.shortHash}</code>
                          <span>•</span>
                          <span className="truncate">{commit.author}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {commit.date}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Right side - Diff viewer */}
      <div className="flex-1 min-w-0 flex flex-col">
        {selectedFile && (
          <div className="px-4 py-2 border-b border-border flex items-center gap-2 shrink-0 bg-muted/30">
            {files.find(f => f.path === selectedFile) && getFileStatusIcon(files.find(f => f.path === selectedFile)!.status)}
            <span className="text-sm font-medium flex-1 truncate">{selectedFile}</span>
            {files.find(f => f.path === selectedFile) && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="text-green-600 dark:text-green-400">
                  +{files.find(f => f.path === selectedFile)!.additions}
                </span>
                <span className="text-red-600 dark:text-red-400">
                  -{files.find(f => f.path === selectedFile)!.deletions}
                </span>
              </div>
            )}
          </div>
        )}
        <ScrollArea className="flex-1">
          {renderDiff()}
        </ScrollArea>
      </div>
    </div>
  );
}
